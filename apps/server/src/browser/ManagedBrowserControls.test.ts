// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
/**
 * The shared browser controls service: what the settings screens and the viewer ask of the owner.
 *
 * Authority is the thing under test. The service answers a person from their own session: an
 * administrator sees and does everything on this server, a viewer grant only what it names, and a
 * session with neither gets an empty answer rather than a list of what exists. The browser behind it is a
 * recorder, so what reached it is exactly what was authorized.
 */
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  AuthSessionId,
  EnvironmentId,
  ManagedBrowserControlError,
  ManagedBrowserGrantId,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  type ManagedBrowserGrantCreateInput,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import * as ManagedBrowserAccess from "./ManagedBrowserAccess.ts";
import * as ManagedBrowserControls from "./ManagedBrowserControls.ts";
import * as ManagedBrowserDesktop from "./ManagedBrowserDesktop.ts";
import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRemoteClient from "./ManagedBrowserRemoteClient.ts";
import * as ManagedBrowserUpdate from "./ManagedBrowserUpdate.ts";

const owner = EnvironmentId.make("env-owner");
const peer = EnvironmentId.make("env-peer");
const instanceA = ManagedBrowserInstanceId.make("instance-a");
const profileA = ManagedBrowserProfileId.make("profile-a");
const instanceB = ManagedBrowserInstanceId.make("instance-b");
const profileB = ManagedBrowserProfileId.make("profile-b");
const admin = { sessionId: "session-admin", administrator: true };
const person = { sessionId: "session-person", administrator: false };
const stranger = { sessionId: "session-stranger", administrator: false };

const tab = (
  overrides: Partial<ManagedBrowserPreviewAdapter.ManagedBrowserDirectoryTab> = {},
): ManagedBrowserPreviewAdapter.ManagedBrowserDirectoryTab => ({
  binding: { ownerEnvironmentId: owner, instanceId: instanceA, profileId: profileA },
  engineTabId: "tab-a",
  incarnation: "boot-1",
  hostThreadId: "thread-a",
  hostTabId: "preview-a",
  title: "Orders",
  url: "https://example.com/orders",
  shared: true,
  participants: 2,
  phase: "agent",
  holder: null,
  ...overrides,
});

const secrets = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  (() => {
    const map = new Map<string, Uint8Array>();
    return ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.succeed(Option.fromNullishOr(map.get(name))),
      set: (name, value) => Effect.sync(() => void map.set(name, value)),
      create: (name, value) => Effect.sync(() => void map.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const made = map.get(name) ?? new Uint8Array(NodeCrypto.randomBytes(bytes));
          map.set(name, made);
          return made;
        }),
      remove: (name) => Effect.sync(() => void map.delete(name)),
    });
  })(),
);

interface Recorder {
  readonly requests: Array<PreviewAutomationRequest>;
  readonly sharing: Array<{ threadId: string; tabId: string; shared: boolean }>;
  /** Each take or release asked of the browser, in order, with the session that asked. */
  readonly controls: Array<{ tabId: string; sessionId: string; action: "take" | "release" }>;
  /** Profiles the controls asked the browser to bring tabs back for; a failure to do so is `restoreFails`. */
  readonly restored: Array<string>;
  restoreFails?: boolean;
  tabs: ReadonlyArray<ManagedBrowserPreviewAdapter.ManagedBrowserDirectoryTab>;
}

const recorder = (
  tabs: Recorder["tabs"] = [tab()],
  opened: { threadId: string; tabId: string } | null = null,
): Recorder =>
  ({ requests: [], sharing: [], restored: [], controls: [], tabs, ...(opened ?? {}) }) as Recorder;

const localAdapter = (record: Recorder, enabled = true) =>
  Layer.succeed(
    ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
    ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter.of({
      ...ManagedBrowserPreviewAdapter.disabledAdapter,
      enabled,
      directory: Effect.sync(() => ({
        instances: [
          { instanceId: instanceA, profileId: profileA },
          { instanceId: instanceB, profileId: profileB },
        ],
        tabs: enabled ? record.tabs : [],
      })),
      handle: (request, humanOpen) =>
        Effect.sync(() => {
          assert.equal(humanOpen?.sessionId, request.agentSessionId?.slice(ManagedBrowserPreviewAdapter.HUMAN_SESSION_PREFIX.length));
          record.requests.push(request);
          const fresh = tab({
            engineTabId: "tab-new",
            hostThreadId: request.threadId,
            hostTabId: "preview-new",
            participants: 1,
            shared: (request.input as { shareTab?: boolean }).shareTab === true,
            title: "",
            url: null,
            ...(record.tabs[0] === undefined
              ? {}
              : { phase: record.tabs[0].phase, holder: record.tabs[0].holder }),
          });
          record.tabs = [...record.tabs, fresh];
          return { tabId: "preview-new" };
        }),
      restore: ({ profileId }) =>
        record.restoreFails === true
          ? Effect.fail(
              new ServerBrowserPage.ServerBrowserOperationError(
                "PreviewAutomationExecutionError",
                "the browser would not start",
              ),
            )
          : Effect.sync(() => void record.restored.push(profileId)),
      // The lease as the browser keeps it: one holder, refused to anyone else, handed back only by that holder.
      setControl: (input) => {
        record.controls.push({
          tabId: input.tabId,
          sessionId: input.sessionId,
          action: input.action,
        });
        const found = record.tabs.find(
          (candidate) =>
            candidate.hostThreadId === input.threadId && candidate.hostTabId === input.tabId,
        );
        if (found === undefined) return Effect.succeed(false);
        const me = ManagedBrowserPreviewAdapter.nativeControlPrincipal(input.sessionId).id;
        // The lease belongs to the browser, not to a tab: every tab of the profile reads the same holder.
        const sameBrowser = (candidate: ManagedBrowserPreviewAdapter.ManagedBrowserDirectoryTab) =>
          candidate.binding.instanceId === found.binding.instanceId;
        const held = found.phase === "human";
        if (input.action === "take" ? held && found.holder !== me : !held || found.holder !== me) {
          return Effect.fail(
            new ServerBrowserPage.ServerBrowserOperationError(
              "PreviewAutomationControlInterruptedError",
              "A human controls this browser tab.",
              "humanControl",
            ),
          );
        }
        record.tabs = record.tabs.map((candidate) =>
          !sameBrowser(candidate)
            ? candidate
            : input.action === "take"
              ? { ...candidate, phase: "human" as const, holder: me }
              : { ...candidate, phase: "agent" as const, holder: null },
        );
        return Effect.succeed(true);
      },
      setSharing: (threadId, tabId, shared) =>
        Effect.sync(() => {
          record.sharing.push({ threadId, tabId, shared });
          const found = record.tabs.find(
            (candidate) => candidate.hostThreadId === threadId && candidate.hostTabId === tabId,
          );
          if (found === undefined) return false;
          record.tabs = record.tabs.map((candidate) =>
            candidate === found ? { ...candidate, shared } : candidate,
          );
          return true;
        }),
    }),
  );

const status = (
  overrides: Partial<ManagedBrowserUpdate.UpdateStatus> = {},
): ManagedBrowserUpdate.UpdateStatus => ({
  hosting: { available: true, reason: null },
  provisioning: { signingKey: true, baseline: true, releaseSource: true },
  current: "2.0.0",
  previous: "1.9.0",
  staged: null,
  policy: { paused: false, pinnedVersion: null },
  quarantined: [],
  lastCheck: null,
  lastActivation: null,
  activation: null,
  recovery: null,
  ...overrides,
});

/** An update service that keeps its status in a variable and records what it was asked to do. */
const updater = (initial: ManagedBrowserUpdate.UpdateStatus = status()) => {
  const calls: Array<string> = [];
  let current = initial;
  const service = ManagedBrowserUpdate.ManagedBrowserUpdate.of({
    status: Effect.sync(() => current),
    checkUpdate: () => Effect.sync(() => current),
    stage: () => Effect.die("unused"),
    activate: () => Effect.die("unused"),
    update: ({ automatic }) =>
      Effect.sync(() => {
        calls.push(`update:${automatic}`);
        return current;
      }),
    setPolicy: (policy) =>
      Effect.sync(() => {
        calls.push(`policy:${JSON.stringify(policy)}`);
        current = { ...current, policy: { ...current.policy, ...policy } };
        return current.policy;
      }),
    rollback: () =>
      Effect.sync(() => {
        calls.push("rollback");
        return { _tag: "Activated", version: "1.9.0", previous: "2.0.0" } as const;
      }),
    recover: () =>
      Effect.sync(() => {
        calls.push("recover");
        return { _tag: "Deferred", reasons: ["viewers", "dialogs"] } as const;
      }),
    releaseQuarantine: () => Effect.void,
    engine: () => {
      throw new Error("unused");
    },
  });
  return {
    service,
    calls,
    set: (next: ManagedBrowserUpdate.UpdateStatus) => void (current = next),
  };
};

const withControls = <A, E>(
  options: {
    readonly record?: Recorder;
    readonly enabled?: boolean;
    readonly update?: ReturnType<typeof updater>;
    readonly desktop?: boolean;
    /** Whether this owner opens its browser as a window on its own screen. */
    readonly native?: boolean;
  },
  body: (
    controls: ManagedBrowserControls.ManagedBrowserControls["Service"],
    access: ManagedBrowserAccess.ManagedBrowserAccessService["Service"],
    record: Recorder,
  ) => Effect.Effect<A, E>,
) => {
  const record = options.record ?? recorder();
  const serverEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(owner),
    getDescriptor: Effect.die("unused descriptor"),
  });
  // Each service is built from the same surroundings; siblings in one merge do not see each other.
  const surroundings = Layer.mergeAll(
    secrets,
    serverEnvironment,
    NodeCryptoService.layer,
    Layer.provide(PreviewManager.layer, NodeCryptoService.layer),
  );
  const base = Layer.mergeAll(
    ManagedBrowserAccess.layer({ ownerEnvironmentId: owner, path: null }),
    ManagedBrowserRemoteClient.layer({ path: null, downloadsRoot: "/nonexistent" }),
    localAdapter(record, options.enabled ?? true),
    options.update === undefined
      ? Layer.empty
      : Layer.succeed(ManagedBrowserUpdate.ManagedBrowserUpdate, options.update.service),
    options.desktop === true || options.native === true
      ? ManagedBrowserDesktop.layer({
          launchDesktop: options.desktop === true,
          launchNative: options.native === true,
          capability: options.desktop === true ? { available: true } : { available: false },
          native: options.native === true ? { available: true } : { available: false },
        })
      : Layer.empty,
  ).pipe(Layer.provideMerge(surroundings));
  return Effect.gen(function* () {
    const controls = yield* ManagedBrowserControls.ManagedBrowserControls;
    const access = yield* ManagedBrowserAccess.ManagedBrowserAccessService;
    return yield* body(controls, access, record);
  }).pipe(
    Effect.provide(ManagedBrowserControls.layer.pipe(Layer.provideMerge(base))),
    Effect.scoped,
  );
};

import * as NodeCryptoService from "@effect/platform-node/NodeCrypto";

const viewerGrant = (
  sessionId: string,
  access: "read" | "operate",
  resource = { instanceId: instanceA, profileId: profileA },
): ManagedBrowserGrantCreateInput => ({
  subject: { kind: "viewer", viewerSessionId: AuthSessionId.make(sessionId) },
  resources: [resource],
  access,
  ttlSeconds: 3600,
});

const refusal = <A>(exit: Exit.Exit<A, ManagedBrowserControlError>) => {
  assert.isTrue(Exit.isFailure(exit));
  const failure = Exit.isFailure(exit)
    ? (
        exit.cause.reasons.find((reason) => reason._tag === "Fail") as
          | { error?: ManagedBrowserControlError }
          | undefined
      )?.error
    : undefined;
  return failure;
};

describe("what a person sees of the shared browser", () => {
  it.effect(
    "an administrator sees every profile and tab, with the ids a viewer connects with",
    () =>
      withControls({}, (controls) =>
        Effect.gen(function* () {
          const overview = yield* controls.overview(admin);
          assert.equal(overview.ownerEnvironmentId, owner);
          assert.deepEqual(overview.hosting, { available: true, reason: null });
          assert.deepEqual(
            overview.profiles.map((profile) => [profile.profileId, profile.tabs]),
            [
              [profileA, 1],
              [profileB, 0],
            ],
          );
          const [listed] = overview.tabs;
          assert.equal(listed?.engineTabId, "tab-a");
          assert.equal(listed?.hostThreadId, "thread-a");
          assert.equal(listed?.hostTabId, "preview-a");
          assert.equal(listed?.shared, true);
          assert.equal(listed?.participants, 2);
          assert.equal(listed?.phase, "agent");
        }),
      ),
  );

  it.effect(
    "a viewer sees only the profiles its grant names; a session with no grant sees nothing",
    () =>
      withControls(
        {
          record: recorder([
            tab(),
            tab({
              binding: { ownerEnvironmentId: owner, instanceId: instanceB, profileId: profileB },
              engineTabId: "tab-b",
              hostTabId: "preview-b",
            }),
          ]),
        },
        (controls, access) =>
          Effect.gen(function* () {
            yield* access.enroll(viewerGrant(person.sessionId, "read"));
            const mine = yield* controls.overview(person);
            assert.deepEqual(
              mine.tabs.map((entry) => entry.engineTabId),
              ["tab-a"],
            );
            assert.deepEqual(
              mine.profiles.map((entry) => entry.profileId),
              [profileA],
            );
            const none = yield* controls.overview(stranger);
            assert.deepEqual(none.tabs, []);
            assert.deepEqual(none.profiles, []);
          }),
      ),
  );

  it.effect(
    "brings back tabs only in profiles the person may read, and lists them even if that fails",
    () =>
      withControls({}, (controls, access, record) =>
        Effect.gen(function* () {
          yield* access.enroll(viewerGrant(person.sessionId, "read"));
          yield* controls.overview(person);
          assert.deepEqual(record.restored, [profileA]);
          yield* controls.overview(stranger);
          assert.deepEqual(record.restored, [profileA], "a session with no grant starts nothing");
          yield* controls.overview(admin);
          assert.deepEqual(record.restored, [profileA, profileA, profileB]);

          record.restoreFails = true;
          assert.equal((yield* controls.overview(admin)).tabs.length, 1);
        }),
      ),
  );

  it.effect(
    "says full window is not set up unless the server offers it, and passes the reason on",
    () =>
      withControls({}, (controls) =>
        Effect.gen(function* () {
          const overview = yield* controls.overview(admin);
          assert.equal(overview.fullWindow.available, false);
          assert.match(overview.fullWindow.reason ?? "", /Page view is available/);
        }),
      ),
  );

  it.effect("reports full window when the server offers it", () =>
    withControls({ desktop: true }, (controls) =>
      Effect.gen(function* () {
        assert.deepEqual((yield* controls.overview(admin)).fullWindow, { available: true });
      }),
    ),
  );

  it.effect(
    "a server that cannot host a browser says why instead of listing nothing silently",
    () =>
      withControls(
        {
          enabled: false,
          update: updater(
            status({ hosting: { available: false, reason: "unprovisioned" }, current: null }),
          ),
        },
        (controls) =>
          Effect.gen(function* () {
            const overview = yield* controls.overview(admin);
            assert.deepEqual(overview.hosting, { available: false, reason: "unprovisioned" });
            assert.deepEqual(overview.tabs, []);
          }),
      ),
  );

  it.effect("a server with no browser component at all says it is not configured", () =>
    withControls({ enabled: false }, (controls) =>
      Effect.gen(function* () {
        assert.deepEqual((yield* controls.overview(admin)).hosting, {
          available: false,
          reason: "notConfigured",
        });
      }),
    ),
  );
});

describe("opening and sharing a tab", () => {
  it.effect("opens a named tab for an administrator in the chosen profile, shared on request", () =>
    withControls({ record: recorder([]) }, (controls, _access, record) =>
      Effect.gen(function* () {
        const result = yield* controls.openTab(admin, {
          instanceId: instanceA,
          profileId: profileA,
          url: "https://example.com",
          shared: true,
        });
        assert.equal(result.tab.hostTabId, "preview-new");
        assert.equal(result.tab.shared, true);
        const [request] = record.requests;
        assert.equal(request?.operation, "open");
        assert.equal(request?.callerEnvironmentId, owner);
        // A person's tab belongs to their session, not to any agent's, so no agent drives it unasked.
        assert.equal(request?.agentSessionId, "human:session-admin");
        assert.deepEqual(request?.input, {
          url: "https://example.com",
          browserBinding: { ownerEnvironmentId: owner, instanceId: instanceA, profileId: profileA },
          shareTab: true,
          reuseExistingTab: false,
          open: false,
        });
      }),
    ),
  );

  it.effect("keeps a tab private to its profile's agents unless the person asked to share it", () =>
    withControls({ record: recorder([]) }, (controls, _access, record) =>
      Effect.gen(function* () {
        const result = yield* controls.openTab(admin, {
          instanceId: instanceA,
          profileId: profileA,
        });
        assert.equal(result.tab.shared, false);
        assert.equal((record.requests[0]?.input as { shareTab?: boolean }).shareTab, false);
      }),
    ),
  );

  it.effect("refuses a viewer who may only read, before anything reaches the browser", () =>
    withControls({}, (controls, access, record) =>
      Effect.gen(function* () {
        yield* access.enroll(viewerGrant(person.sessionId, "read"));
        const error = refusal(
          yield* Effect.exit(
            controls.openTab(person, { instanceId: instanceA, profileId: profileA }),
          ),
        );
        assert.equal(error?.reason, "refused");
        assert.deepEqual(record.requests, []);
      }),
    ),
  );

  it.effect("lets a viewer with an operate grant open in its own profile only", () =>
    withControls({}, (controls, access, record) =>
      Effect.gen(function* () {
        yield* access.enroll(viewerGrant(person.sessionId, "operate"));
        yield* controls.openTab(person, { instanceId: instanceA, profileId: profileA });
        assert.equal(record.requests.length, 1);
        const other = refusal(
          yield* Effect.exit(
            controls.openTab(person, { instanceId: instanceB, profileId: profileB }),
          ),
        );
        assert.equal(other?.reason, "refused");
        assert.equal(record.requests.length, 1);
      }),
    ),
  );

  it.effect("says the server cannot host a browser rather than opening a temporary tab", () =>
    withControls({ enabled: false }, (controls, _access, record) =>
      Effect.gen(function* () {
        const error = refusal(
          yield* Effect.exit(
            controls.openTab(admin, { instanceId: instanceA, profileId: profileA }),
          ),
        );
        assert.equal(error?.reason, "notHosted");
        assert.deepEqual(record.requests, []);
      }),
    ),
  );

  it.effect("turns sharing on and off for a tab the person may operate, and only then", () =>
    withControls({}, (controls, access, record) =>
      Effect.gen(function* () {
        yield* access.enroll(viewerGrant(person.sessionId, "read"));
        const denied = refusal(
          yield* Effect.exit(
            controls.setShared(person, {
              hostThreadId: "thread-a",
              hostTabId: "preview-a",
              shared: false,
            }),
          ),
        );
        assert.equal(denied?.reason, "refused");
        assert.deepEqual(record.sharing, []);
        const done = yield* controls.setShared(admin, {
          hostThreadId: "thread-a",
          hostTabId: "preview-a",
          shared: false,
        });
        assert.equal(done.tab.shared, false);
        assert.deepEqual(record.sharing, [
          { threadId: "thread-a", tabId: "preview-a", shared: false },
        ]);
      }),
    ),
  );

  it.effect("answers an unknown tab and a tab the person cannot see identically", () =>
    withControls({}, (controls) =>
      Effect.gen(function* () {
        const unknown = refusal(
          yield* Effect.exit(
            controls.setShared(admin, { hostThreadId: "nope", hostTabId: "nope", shared: true }),
          ),
        );
        const hidden = refusal(
          yield* Effect.exit(
            controls.setShared(stranger, {
              hostThreadId: "thread-a",
              hostTabId: "preview-a",
              shared: true,
            }),
          ),
        );
        assert.equal(unknown?.reason, "notFound");
        assert.equal(hidden?.reason, "notFound");
        assert.equal(unknown?.message, hidden?.message);
      }),
    ),
  );
});

describe("who may reach the browser", () => {
  it.effect("shows an agent grant's credential once and never in the listing", () =>
    withControls({}, (controls) =>
      Effect.gen(function* () {
        const created = yield* controls.createGrant({
          subject: {
            kind: "agent",
            callerEnvironmentId: peer,
            threadId: "thread-1",
            agentSessionId: "session-1",
          },
          resources: [{ instanceId: instanceA, profileId: profileA }],
          access: "read",
          ttlSeconds: 600,
        });
        assert.isString(created.credential);
        const listed = JSON.stringify(yield* controls.listGrants);
        assert.notInclude(listed, created.credential!);
        assert.isTrue((yield* controls.revokeGrant({ id: created.grant.id })).revoked);
        assert.isFalse((yield* controls.revokeGrant({ id: created.grant.id })).revoked);
      }),
    ),
  );

  it.effect("keeps an enrollment's credential out of every answer", () =>
    withControls({}, (controls) =>
      Effect.gen(function* () {
        const credential = "c".repeat(48);
        const enrollment = yield* controls.enroll({
          id: ManagedBrowserGrantId.make("a".repeat(32)),
          ownerEnvironmentId: peer,
          endpoint: "https://owner.example.com",
          instanceId: instanceA,
          profileId: profileA,
          threadId: "thread-1",
          agentSessionId: "session-1",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString() as never,
          credential,
        });
        assert.notInclude(JSON.stringify(enrollment), credential);
        assert.notInclude(JSON.stringify(yield* controls.listEnrollments), credential);
        assert.isTrue((yield* controls.removeEnrollment({ id: enrollment.id })).removed);
      }),
    ),
  );

  it.effect("rejects an enrollment aimed at anything but an owner's bare address", () =>
    withControls({}, (controls) =>
      Effect.gen(function* () {
        const error = refusal(
          yield* Effect.exit(
            controls.enroll({
              id: ManagedBrowserGrantId.make("b".repeat(32)),
              ownerEnvironmentId: peer,
              endpoint: "https://attacker.example.com/collect?x=1",
              instanceId: instanceA,
              profileId: profileA,
              threadId: "thread-1",
              agentSessionId: "session-1",
              expiresAt: new Date(Date.now() + 3_600_000).toISOString() as never,
              credential: "c".repeat(48),
            }),
          ),
        );
        assert.equal(error?.reason, "invalid");
        assert.deepEqual((yield* controls.listEnrollments).enrollments, []);
      }),
    ),
  );
});

describe("updating the browser component", () => {
  it.effect("reports an unprovisioned build honestly: no release, no key, nothing to check", () =>
    withControls(
      {
        update: updater(
          status({
            hosting: { available: false, reason: "unprovisioned" },
            provisioning: { signingKey: false, baseline: false, releaseSource: false },
            current: null,
            previous: null,
            lastCheck: { at: 5, outcome: "unprovisioned", detail: null },
          }),
        ),
      },
      (controls) =>
        Effect.gen(function* () {
          const updateStatus = yield* controls.updateStatus;
          assert.equal(updateStatus.current, null);
          assert.deepEqual(updateStatus.provisioning, {
            signingKey: false,
            baseline: false,
            releaseSource: false,
          });
          assert.equal(updateStatus.lastCheck?.outcome, "unprovisioned");
          assert.equal(updateStatus.hosting.reason, "unprovisioned");
        }),
    ),
  );

  it.effect("passes the recovery status on, so a client can tell a retry from a restart", () =>
    Effect.forEach(["retryable", "restartRequired"] as const, (recoveryStatus) =>
      withControls(
        {
          update: updater(
            status({
              hosting: { available: false, reason: "recoveryRequired" },
              recovery: {
                failed: "2.1.0",
                from: "2.0.0",
                detail: "stop failed; exit not proven",
                at: 3,
                status: recoveryStatus,
              },
            }),
          ),
        },
        (controls) =>
          Effect.gen(function* () {
            assert.deepEqual((yield* controls.updateStatus).recovery, {
              failed: "2.1.0",
              detail: "stop failed; exit not proven",
              status: recoveryStatus,
            });
          }),
      ),
    ),
  );

  it.effect("explains why a staged release has not switched yet", () =>
    withControls(
      {
        update: updater(
          status({
            staged: "2.1.0",
            lastActivation: { at: 9, result: "deferred", detail: "viewers, dialogs" },
          }),
        ),
      },
      (controls) =>
        Effect.gen(function* () {
          const updateStatus = yield* controls.updateStatus;
          assert.equal(updateStatus.staged, "2.1.0");
          assert.deepEqual(updateStatus.waiting, { reasons: ["viewers", "dialogs"] });
        }),
    ),
  );

  it.effect("does not report a stale deferral once nothing is staged", () =>
    withControls(
      {
        update: updater(
          status({
            staged: null,
            lastActivation: { at: 9, result: "deferred", detail: "viewers" },
          }),
        ),
      },
      (controls) =>
        Effect.gen(function* () {
          assert.equal((yield* controls.updateStatus).waiting, null);
        }),
    ),
  );

  it.effect("pins the installed version, never one the client names, and unpins", () => {
    const update = updater();
    return withControls({ update }, (controls) =>
      Effect.gen(function* () {
        const pinned = yield* controls.update({ action: "pin" });
        assert.equal(pinned.status.policy.pinnedVersion, "2.0.0");
        const unpinned = yield* controls.update({ action: "unpin" });
        assert.equal(unpinned.status.policy.pinnedVersion, null);
        yield* controls.update({ action: "pause" });
        yield* controls.update({ action: "resume" });
        assert.deepEqual(update.calls, [
          'policy:{"pinnedVersion":"2.0.0"}',
          'policy:{"pinnedVersion":null}',
          'policy:{"paused":true}',
          'policy:{"paused":false}',
        ]);
      }),
    );
  });

  it.effect("refuses to pin when no release is installed", () =>
    withControls({ update: updater(status({ current: null })) }, (controls) =>
      Effect.gen(function* () {
        assert.equal(
          refusal(yield* Effect.exit(controls.update({ action: "pin" })))?.reason,
          "invalid",
        );
      }),
    ),
  );

  it.effect("a manual check applies an update only through the same drain the timer uses", () => {
    const update = updater();
    return withControls({ update }, (controls) =>
      Effect.gen(function* () {
        yield* controls.update({ action: "check" });
        // Not `automatic`: pause and pin do not silence an explicit request.
        assert.deepEqual(update.calls, ["update:false"]);
      }),
    );
  });

  it.effect("reports what rolling back and recovering did, including a deferral and why", () => {
    const update = updater();
    return withControls({ update }, (controls) =>
      Effect.gen(function* () {
        const rolled = yield* controls.update({ action: "rollback" });
        assert.deepEqual(rolled.activation, {
          result: "activated",
          version: "1.9.0",
        });
        const recovered = yield* controls.update({ action: "recover" });
        assert.deepEqual(recovered.activation, {
          result: "deferred",
          reasons: ["viewers", "dialogs"],
        });
      }),
    );
  });

  it.effect("maps a package failure to a reason a person can act on", () => {
    const update = updater();
    const failing = {
      ...update.service,
      update: () =>
        Effect.fail(
          new ManagedBrowserPackage.ManagedBrowserPackageError({
            reason: "unauthorized",
            detail: "token rejected",
          }),
        ),
    };
    return withControls({ update: { ...update, service: failing } }, (controls) =>
      Effect.gen(function* () {
        assert.equal(
          refusal(yield* Effect.exit(controls.update({ action: "check" })))?.reason,
          "unauthorized",
        );
      }),
    );
  });

  it.effect(
    "says a hand-configured browser is not updated by T3, instead of claiming nothing is hosted",
    () =>
      withControls({ enabled: true }, (controls) =>
        Effect.gen(function* () {
          const error = refusal(yield* Effect.exit(controls.updateStatus));
          assert.equal(error?.reason, "unavailable");
          assert.match(error?.message ?? "", /set up by hand/);
        }),
      ),
  );

  it.effect("says there is nothing to update on a server that does not host a browser", () =>
    withControls({ enabled: false }, (controls) =>
      Effect.gen(function* () {
        assert.equal(refusal(yield* Effect.exit(controls.updateStatus))?.reason, "notHosted");
        assert.equal(
          refusal(yield* Effect.exit(controls.update({ action: "check" })))?.reason,
          "notHosted",
        );
      }),
    ),
  );
});

describe("holding control of the browser without watching it", () => {
  const operator = (sessionId: string) => ({ sessionId, administrator: false });
  const take = (action: "take" | "release") => ({
    hostThreadId: "thread-a",
    hostTabId: "preview-a",
    action,
  });

  it.effect("says whether this owner opens its browser on its own screen, and why not", () =>
    Effect.gen(function* () {
      const off = yield* withControls({}, (controls) => controls.overview(admin));
      assert.equal(off.native?.available, false);
      assert.match(off.native?.reason ?? "", /not set to open/);
      const on = yield* withControls({ native: true }, (controls) => controls.overview(admin));
      assert.deepEqual(on.native, { available: true });
    }),
  );

  it.effect(
    "take holds the lease as this session, release hands it back, with no stream open",
    () =>
      withControls({}, (controls, access, record) =>
        Effect.gen(function* () {
          yield* access.enroll(viewerGrant(person.sessionId, "operate"));
          const taken = yield* controls.setControl(admin, take("take"));
          assert.equal(taken.tab.phase, "human");
          assert.isTrue(taken.tab.heldByYou);
          // Another person looking at the same tab is told it is held, and not by them.
          const seen = (yield* controls.overview(person)).tabs[0]!;
          assert.equal(seen.phase, "human");
          assert.isFalse(seen.heldByYou);
          // The browser was asked as the session that asked, once, and nothing watched a stream.
          assert.deepEqual(record.controls, [
            { tabId: "preview-a", sessionId: admin.sessionId, action: "take" },
          ]);
          const released = yield* controls.setControl(admin, take("release"));
          assert.equal(released.tab.phase, "agent");
          assert.isFalse(released.tab.heldByYou);
        }),
      ),
  );

  it.effect("refuses to take what someone else holds, and to release what you do not hold", () =>
    withControls({}, (controls, access) =>
      Effect.gen(function* () {
        yield* access.enroll(viewerGrant(person.sessionId, "operate"));
        yield* controls.setControl(person, take("take"));
        const taken = refusal(yield* controls.setControl(admin, take("take")).pipe(Effect.exit));
        assert.equal(taken?.reason, "busy");
        assert.match(taken?.message ?? "", /Control cannot be taken now/);
        const released = refusal(
          yield* controls.setControl(admin, take("release")).pipe(Effect.exit),
        );
        assert.equal(released?.reason, "busy");
        assert.match(released?.message ?? "", /do not hold control/);
        // The holder is untouched by either refusal.
        assert.isTrue((yield* controls.overview(person)).tabs[0]!.heldByYou);
      }),
    ),
  );

  it.effect(
    "needs the same authority as driving the tab: read is not enough, no grant sees nothing",
    () =>
      withControls({}, (controls, access, record) =>
        Effect.gen(function* () {
          yield* access.enroll(viewerGrant(person.sessionId, "read"));
          const watcher = refusal(
            yield* controls.setControl(person, take("take")).pipe(Effect.exit),
          );
          assert.equal(watcher?.reason, "refused");
          const unknown = refusal(
            yield* controls.setControl(stranger, take("take")).pipe(Effect.exit),
          );
          assert.equal(unknown?.reason, "notFound");
          const missing = refusal(
            yield* controls
              .setControl(admin, { ...take("take"), hostTabId: "preview-none" as never })
              .pipe(Effect.exit),
          );
          assert.equal(missing?.reason, "notFound");
          assert.deepEqual(record.controls, [], "nothing reached the browser");
        }),
      ),
  );

  it.effect("says so on a server that hosts no browser", () =>
    withControls({ enabled: false }, (controls, _access, record) =>
      Effect.gen(function* () {
        const result = refusal(yield* controls.setControl(admin, take("take")).pipe(Effect.exit));
        assert.equal(result?.reason, "notHosted");
        assert.deepEqual(record.controls, []);
      }),
    ),
  );

  it.effect("a tab opened to take control is held by the person before it is handed back", () =>
    withControls({}, (controls, _access, record) =>
      Effect.gen(function* () {
        const input = { instanceId: instanceA, profileId: profileA, url: "https://example.com/" };
        const held = yield* controls.openTab(admin, { ...input, takeControl: true });
        assert.equal(held.tab.phase, "human");
        assert.isTrue(held.tab.heldByYou);
        assert.deepEqual(
          record.controls.map((entry) => [entry.tabId, entry.action]),
          [["preview-new", "take"]],
        );
      }),
    ),
  );

  it.effect(
    "opens a tab as before, asking nobody to hold anything, unless told to take control",
    () =>
      withControls({}, (controls, _access, record) =>
        Effect.gen(function* () {
          const plain = yield* controls.openTab(admin, {
            instanceId: instanceA,
            profileId: profileA,
          });
          assert.equal(plain.tab.phase, "agent");
          assert.isFalse(plain.tab.heldByYou);
          assert.deepEqual(record.controls, []);
        }),
      ),
  );

  it.effect("keeps the open tab and says control was not taken when it cannot be", () =>
    withControls({}, (controls, access, record) =>
      Effect.gen(function* () {
        yield* access.enroll(viewerGrant(person.sessionId, "operate"));
        // Someone else already holds the browser the new tab belongs to.
        record.tabs = [tab({ phase: "human", holder: "human:native-someone-else" })];
        const failed = refusal(
          yield* controls
            .openTab(person, { instanceId: instanceA, profileId: profileA, takeControl: true })
            .pipe(Effect.exit),
        );
        assert.equal(failed?.reason, "busy");
        assert.match(failed?.message ?? "", /The tab opened\. Control cannot be taken now/);
        assert.equal(record.tabs.length, 2, "the tab stays open and is listed");
      }),
    ),
  );
});
