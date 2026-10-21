/**
 * ManagedBrowserControls - what a person's client asks of the environment that owns a shared browser.
 *
 * The RPC handlers behind the settings screens and the viewer call this and nothing else. Each answer is
 * made for the session that asked: an administrator may see and do everything on this server, a viewer
 * grant only what it names, and a session with neither gets an empty answer, never a hint of what exists.
 * Grants and enrollments are the existing services, so a credential still appears once and nowhere else.
 *
 * A tab opened here belongs to the person's session, not to any agent: no agent drives it until it joins
 * the tab, which needs the page to be shared and a live grant. This service neither widens that rule nor
 * keeps a copy of browser state; it reads the adapter's directory and applies the viewer policy to it.
 *
 * @module ManagedBrowserControls
 */
import {
  ManagedBrowserControlError,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  ManagedBrowserTabId,
  type ManagedBrowserCapability,
  type ManagedBrowserEnrollment,
  type ManagedBrowserEnrollmentCreateInput,
  type ManagedBrowserEnrollmentList,
  type ManagedBrowserEnrollmentRemoveInput,
  type ManagedBrowserEnrollmentRemoveResult,
  type ManagedBrowserGrantCreateInput,
  type ManagedBrowserGrantCreateResult,
  type ManagedBrowserGrantList,
  type ManagedBrowserGrantRevokeInput,
  type ManagedBrowserGrantRevokeResult,
  type ManagedBrowserHosting,
  type ManagedBrowserOpenTabInput,
  type ManagedBrowserOpenTabResult,
  type ManagedBrowserOverview,
  type ManagedBrowserSetControlInput,
  type ManagedBrowserSetControlResult,
  type ManagedBrowserSetSharedInput,
  type ManagedBrowserSetSharedResult,
  type ManagedBrowserTabSummary,
  type ManagedBrowserUpdateActivation,
  type ManagedBrowserUpdateInput,
  type ManagedBrowserUpdateResult,
  type ManagedBrowserUpdateStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import * as ManagedBrowserAccess from "./ManagedBrowserAccess.ts";
import * as ManagedBrowserDesktop from "./ManagedBrowserDesktop.ts";
import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRemoteClient from "./ManagedBrowserRemoteClient.ts";
import type { ManagedBrowserViewerIdentity } from "./ManagedBrowserViewer.ts";
import * as ManagedBrowserUpdate from "./ManagedBrowserUpdate.ts";

type Viewer = ManagedBrowserViewerIdentity;
type Failure = ManagedBrowserControlError;

export class ManagedBrowserControls extends Context.Service<
  ManagedBrowserControls,
  {
    readonly overview: (viewer: Viewer) => Effect.Effect<ManagedBrowserOverview, Failure>;
    readonly openTab: (
      viewer: Viewer,
      input: ManagedBrowserOpenTabInput,
    ) => Effect.Effect<ManagedBrowserOpenTabResult, Failure>;
    readonly setShared: (
      viewer: Viewer,
      input: ManagedBrowserSetSharedInput,
    ) => Effect.Effect<ManagedBrowserSetSharedResult, Failure>;
    readonly setControl: (
      viewer: Viewer,
      input: ManagedBrowserSetControlInput,
    ) => Effect.Effect<ManagedBrowserSetControlResult, Failure>;
    readonly listGrants: Effect.Effect<ManagedBrowserGrantList, Failure>;
    readonly createGrant: (
      input: ManagedBrowserGrantCreateInput,
    ) => Effect.Effect<ManagedBrowserGrantCreateResult, Failure>;
    readonly revokeGrant: (
      input: ManagedBrowserGrantRevokeInput,
    ) => Effect.Effect<ManagedBrowserGrantRevokeResult, Failure>;
    readonly listEnrollments: Effect.Effect<ManagedBrowserEnrollmentList, Failure>;
    readonly enroll: (
      input: ManagedBrowserEnrollmentCreateInput,
    ) => Effect.Effect<ManagedBrowserEnrollment, Failure>;
    readonly removeEnrollment: (
      input: ManagedBrowserEnrollmentRemoveInput,
    ) => Effect.Effect<ManagedBrowserEnrollmentRemoveResult, Failure>;
    readonly updateStatus: Effect.Effect<ManagedBrowserUpdateStatus, Failure>;
    readonly update: (
      input: ManagedBrowserUpdateInput,
    ) => Effect.Effect<ManagedBrowserUpdateResult, Failure>;
  }
>()("t3/browser/ManagedBrowserControls") {}

const isControlError = Schema.is(ManagedBrowserControlError);

const failure = (reason: Failure["reason"], message: string) =>
  new ManagedBrowserControlError({ reason, message });

const NOT_HOSTED = "This computer does not run a shared browser.";

const storeFailure = () =>
  failure("unavailable", "The shared browser's access records could not be read or saved.");

const operationFailure = (error: ServerBrowserPage.ServerBrowserOperationError) => {
  switch (error.tag) {
    case "PreviewAutomationUnsupportedClientError":
      return failure("notHosted", NOT_HOSTED);
    case "PreviewAutomationControlInterruptedError":
      return failure("busy", error.message);
    case "PreviewAutomationTabNotFoundError":
      return failure("notFound", error.message);
    default:
      return failure("unavailable", error.message);
  }
};

const packageFailure = (error: ManagedBrowserPackage.ManagedBrowserPackageError) => {
  switch (error.reason) {
    case "unprovisioned":
      return failure("unprovisioned", "No browser release has been set up for this build yet.");
    case "unsupportedHost":
      return failure("notHosted", "This computer cannot run the shared browser.");
    case "unauthorized":
      return failure("unauthorized", "The release source refused the saved access token.");
    case "sourceUnavailable":
      return failure("sourceUnavailable", "The release source could not be reached.");
    case "rejected":
      return failure("rejected", "That release did not pass verification and was not used.");
    case "locked":
      return failure("busy", "Another update is already running.");
    case "notStaged":
      return failure("invalid", "There is no downloaded release to switch to.");
    default:
      return failure("unavailable", "The browser component could not be read.");
  }
};

/** What a person is told when taking or releasing control did nothing, in the words the viewer uses. */
const controlRefusal = (action: ManagedBrowserSetControlInput["action"]) =>
  failure(
    "busy",
    action === "take"
      ? "Control cannot be taken now: someone else holds it, or the browser is changing."
      : "You do not hold control.",
  );

/** A failed take or release as a person is told it: a lease conflict in the viewer's words, anything else as it is. */
const controlFailure =
  (action: ManagedBrowserSetControlInput["action"], prefix = "") =>
  (error: ServerBrowserPage.ServerBrowserOperationError) =>
    error.tag === "PreviewAutomationControlInterruptedError"
      ? failure("busy", `${prefix}${controlRefusal(action).message}`)
      : operationFailure(error);

const summaryOf = (
  tab: ManagedBrowserPreviewAdapter.ManagedBrowserDirectoryTab,
  viewer: Viewer,
): ManagedBrowserTabSummary => ({
  engineTabId: ManagedBrowserTabId.make(tab.engineTabId),
  instanceId: tab.binding.instanceId,
  profileId: tab.binding.profileId,
  incarnation: ManagedBrowserIncarnation.make(tab.incarnation),
  hostThreadId: tab.hostThreadId,
  hostTabId: tab.hostTabId,
  title: tab.title,
  url: tab.url,
  shared: tab.shared,
  participants: tab.participants,
  phase: tab.phase,
  heldByYou:
    tab.phase === "human" &&
    tab.holder === ManagedBrowserPreviewAdapter.nativeControlPrincipal(viewer.sessionId).id,
});

const activationOf = (
  result: ManagedBrowserUpdate.ActivationResult,
): ManagedBrowserUpdateActivation => {
  switch (result._tag) {
    case "Activated":
      return { result: "activated", version: result.version };
    case "Deferred":
      return { result: "deferred", reasons: result.reasons };
    case "RolledBack":
      return { result: "rolledBack", version: result.failed, detail: result.detail };
    case "RecoveryFailed":
      return { result: "recoveryFailed", version: result.failed, detail: result.detail };
  }
};

const updateStatusOf = (status: ManagedBrowserUpdate.UpdateStatus): ManagedBrowserUpdateStatus => ({
  hosting: status.hosting,
  provisioning: status.provisioning,
  current: status.current,
  previous: status.previous,
  staged: status.staged,
  policy: status.policy,
  quarantined: status.quarantined.map(({ version, reason }) => ({ version, reason })),
  lastCheck:
    status.lastCheck === null
      ? null
      : { at: status.lastCheck.at, outcome: status.lastCheck.outcome },
  // A deferral only means something while the release it deferred is still waiting.
  waiting:
    status.staged !== null && status.lastActivation?.result === "deferred"
      ? {
          reasons: (status.lastActivation.detail ?? "")
            .split(", ")
            .filter((reason) => reason.length > 0),
        }
      : null,
  applying: status.activation !== null,
  recovery:
    status.recovery === null
      ? null
      : {
          failed: status.recovery.failed,
          detail: status.recovery.detail,
          status: status.recovery.status,
        },
});

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const ownerEnvironmentId = yield* environment.getEnvironmentId;
  const access = yield* ManagedBrowserAccess.ManagedBrowserAccessService;
  const remote = yield* ManagedBrowserRemoteClient.ManagedBrowserRemoteClient;
  const local = yield* ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter;
  const crypto = yield* Crypto.Crypto;
  const update = Option.getOrUndefined(
    yield* Effect.serviceOption(ManagedBrowserUpdate.ManagedBrowserUpdate),
  );
  const desktop = Option.getOrUndefined(
    yield* Effect.serviceOption(ManagedBrowserDesktop.ManagedBrowserDesktop),
  );
  const policy = ManagedBrowserPreviewAdapter.grantPolicy(ownerEnvironmentId, access);

  const bindingOf = (instanceId: string, profileId: string) => ({
    ownerEnvironmentId,
    instanceId: ManagedBrowserInstanceId.make(instanceId),
    profileId: ManagedBrowserProfileId.make(profileId),
  });

  /** Whether this session may act on the profile at this level, by the same rule the viewer stream applies. */
  const may = (viewer: Viewer, instanceId: string, profileId: string, level: "read" | "operate") =>
    policy.authorizeViewer === undefined
      ? Effect.succeed(false)
      : policy
          .authorizeViewer({ viewer, binding: bindingOf(instanceId, profileId), access: level })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );

  const hosting = Effect.gen(function* (): Effect.fn.Return<ManagedBrowserHosting> {
    if (update !== undefined) return (yield* update.status).hosting;
    return local.enabled
      ? { available: true, reason: null }
      : { available: false, reason: "notConfigured" };
  });

  const fullWindow: ManagedBrowserCapability =
    desktop?.capability ?? ManagedBrowserDesktop.NOT_SET_UP;
  const native: ManagedBrowserCapability =
    desktop?.native ?? ManagedBrowserDesktop.NATIVE_NOT_SET_UP;

  /** Every tab this session may look at, with the directory it came from. */
  const visibleTabs = (viewer: Viewer) =>
    Effect.gen(function* () {
      const directory = yield* local.directory;
      const tabs = yield* Effect.filter(
        directory.tabs,
        (tab) => may(viewer, tab.binding.instanceId, tab.binding.profileId, "read"),
        { concurrency: 8 },
      );
      return { directory, tabs };
    });

  const overview: ManagedBrowserControls["Service"]["overview"] = (viewer) =>
    Effect.gen(function* () {
      // A tab people opened before the owner restarted comes back before anyone is told what is open.
      const known = yield* local.directory;
      yield* Effect.forEach(
        known.instances,
        (instance) =>
          may(viewer, instance.instanceId, instance.profileId, "read").pipe(
            Effect.flatMap((allowed) => (allowed ? local.restore(instance) : Effect.void)),
            // The list is still true without them; a browser that will not start must not hide it.
            Effect.catch((error) =>
              Effect.logWarning("shared browser tabs could not be restored", { detail: error.tag }),
            ),
          ),
        { discard: true },
      );
      const { directory, tabs } = yield* visibleTabs(viewer);
      const instances = yield* Effect.filter(
        directory.instances,
        ({ instanceId, profileId }) => may(viewer, instanceId, profileId, "read"),
        { concurrency: 8 },
      );
      return {
        ownerEnvironmentId,
        hosting: yield* hosting,
        fullWindow,
        native,
        profiles: instances.map(({ instanceId, profileId }) => ({
          instanceId: ManagedBrowserInstanceId.make(instanceId),
          profileId: ManagedBrowserProfileId.make(profileId),
          tabs: tabs.filter(
            (tab) => tab.binding.instanceId === instanceId && tab.binding.profileId === profileId,
          ).length,
        })),
        tabs: tabs.map((tab) => summaryOf(tab, viewer)),
      } satisfies ManagedBrowserOverview;
    });

  const summaryFor = (viewer: Viewer, threadId: string, tabId: string) =>
    visibleTabs(viewer).pipe(
      Effect.map(({ tabs }) =>
        tabs.find((tab) => tab.hostThreadId === threadId && tab.hostTabId === tabId),
      ),
    );

  const openTab: ManagedBrowserControls["Service"]["openTab"] = (viewer, input) =>
    Effect.gen(function* () {
      if (!local.enabled) return yield* failure("notHosted", NOT_HOSTED);
      if (!(yield* may(viewer, input.instanceId, input.profileId, "operate"))) {
        return yield* failure("refused", "You cannot open tabs in this browser profile.");
      }
      const threadId = ThreadId.make(input.thread
        ? `managed-browser:${input.thread.environmentId}:${input.thread.threadId}`
        : `managed-browser:${input.profileId}`);
      const result = yield* local
        .handle({
          requestId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          threadId,
          // Owned by this person's session, so no agent acts on it unless it joins the shared tab.
          agentSessionId: `${ManagedBrowserPreviewAdapter.HUMAN_SESSION_PREFIX}${viewer.sessionId}`,
          callerEnvironmentId: ownerEnvironmentId,
          operation: "open",
          input: {
            ...(input.url === undefined ? {} : { url: input.url }),
            browserBinding: bindingOf(input.instanceId, input.profileId),
            shareTab: input.shared === true,
            reuseExistingTab: false,
            open: false,
          },
          timeoutMs: 60_000,
        }, { sessionId: viewer.sessionId })
        .pipe(Effect.mapError(operationFailure));
      const tabId = (result as { tabId?: unknown } | null)?.tabId;
      const found =
        typeof tabId === "string" ? yield* summaryFor(viewer, threadId, tabId) : undefined;
      if (found === undefined) {
        return yield* failure("unavailable", "The tab opened but could not be found afterwards.");
      }
      if (input.takeControl !== true) return { tab: summaryOf(found, viewer) };
      // The person's hold comes before the tab is handed back, so no agent can act in between.
      const held = yield* local
        .setControl({
          threadId: found.hostThreadId,
          tabId: found.hostTabId,
          sessionId: viewer.sessionId,
          action: "take",
        })
        .pipe(Effect.mapError(controlFailure("take", "The tab opened. ")));
      const fresh = held ? yield* summaryFor(viewer, threadId, found.hostTabId) : undefined;
      return { tab: summaryOf(fresh ?? found, viewer) };
    });

  const setShared: ManagedBrowserControls["Service"]["setShared"] = (viewer, input) =>
    Effect.gen(function* () {
      // A tab this session cannot see is a tab that does not exist, and the answer is the same.
      const notFound = failure("notFound", "That tab is not open.");
      const tab = yield* summaryFor(viewer, input.hostThreadId, input.hostTabId);
      if (tab === undefined) return yield* notFound;
      if (!(yield* may(viewer, tab.binding.instanceId, tab.binding.profileId, "operate"))) {
        return yield* failure("refused", "You can watch this tab but not change who may join it.");
      }
      const changed = yield* local
        .setSharing(input.hostThreadId, input.hostTabId, input.shared)
        .pipe(Effect.mapError(operationFailure));
      if (!changed) return yield* notFound;
      const fresh = yield* summaryFor(viewer, input.hostThreadId, input.hostTabId);
      return fresh === undefined ? yield* notFound : { tab: summaryOf(fresh, viewer) };
    });

  const setControl: ManagedBrowserControls["Service"]["setControl"] = (viewer, input) =>
    Effect.gen(function* () {
      if (!local.enabled) return yield* failure("notHosted", NOT_HOSTED);
      const notFound = failure("notFound", "That tab is not open.");
      const tab = yield* summaryFor(viewer, input.hostThreadId, input.hostTabId);
      if (tab === undefined) return yield* notFound;
      // The same rule as driving the tab from its viewer: reading it is not enough.
      if (!(yield* may(viewer, tab.binding.instanceId, tab.binding.profileId, "operate"))) {
        return yield* failure("refused", "You can watch this tab but not take control of it.");
      }
      const changed = yield* local
        .setControl({
          threadId: input.hostThreadId,
          tabId: input.hostTabId,
          sessionId: viewer.sessionId,
          action: input.action,
        })
        .pipe(Effect.mapError(controlFailure(input.action)));
      if (!changed) return yield* notFound;
      const fresh = yield* summaryFor(viewer, input.hostThreadId, input.hostTabId);
      return fresh === undefined ? yield* notFound : { tab: summaryOf(fresh, viewer) };
    });

  const grantFailure = Effect.mapError(storeFailure);
  const enrollmentFailure = Effect.mapError(
    (error: ManagedBrowserRemoteClient.ManagedBrowserEnrollmentError) =>
      // The messages describe what is wrong with the address or the record; none quotes the credential.
      failure("invalid", error.detail),
  );

  // A browser the host configured by hand has no component to update; say so rather than "not hosted".
  const requireUpdate =
    update !== undefined
      ? Effect.succeed(update)
      : Effect.fail(
          local.enabled
            ? failure("unavailable", "This browser was set up by hand, so T3 does not update it.")
            : failure("notHosted", NOT_HOSTED),
        );
  const updateStatus = Effect.gen(function* () {
    return updateStatusOf(yield* (yield* requireUpdate).status);
  });

  const runUpdate: ManagedBrowserControls["Service"]["update"] = ({ action }) =>
    Effect.gen(function* () {
      const service = yield* requireUpdate;
      const policyChange = (change: Parameters<typeof service.setPolicy>[0]) =>
        service.setPolicy(change).pipe(Effect.as(null));
      const run = (): Effect.Effect<
        ManagedBrowserUpdateActivation | null,
        ManagedBrowserPackage.ManagedBrowserPackageError | Failure
      > => {
        switch (action) {
          // Explicit, so pause and pin (which silence the timer) do not silence a person asking.
          case "check":
            return service.update({ automatic: false }).pipe(Effect.as(null));
          case "pause":
            return policyChange({ paused: true });
          case "resume":
            return policyChange({ paused: false });
          case "unpin":
            return policyChange({ pinnedVersion: null });
          case "pin":
            // Only what is installed can be pinned; the client never names a version.
            return Effect.gen(function* () {
              const { current } = yield* service.status;
              if (current === null) {
                return yield* failure("invalid", "No browser release is installed to hold.");
              }
              return yield* policyChange({ pinnedVersion: current });
            });
          case "rollback":
            return service.rollback().pipe(Effect.map(activationOf));
          case "recover":
            return service.recover().pipe(Effect.map(activationOf));
        }
      };
      const activation = yield* run().pipe(
        Effect.mapError((error) => (isControlError(error) ? error : packageFailure(error))),
      );
      return { status: updateStatusOf(yield* service.status), activation };
    });

  return ManagedBrowserControls.of({
    overview,
    openTab,
    setShared,
    setControl,
    listGrants: access.list.pipe(
      Effect.map((grants) => ({ grants })),
      grantFailure,
    ),
    createGrant: (input) => access.enroll(input).pipe(grantFailure),
    revokeGrant: ({ id }) =>
      access.revoke(id).pipe(
        Effect.map((revoked) => ({ revoked })),
        grantFailure,
      ),
    listEnrollments: remote.list.pipe(
      Effect.map((enrollments) => ({ enrollments })),
      enrollmentFailure,
    ),
    enroll: (input) => remote.enroll(input).pipe(enrollmentFailure),
    removeEnrollment: ({ id }) =>
      remote.remove(id).pipe(
        Effect.map((removed) => ({ removed })),
        enrollmentFailure,
      ),
    updateStatus,
    update: runUpdate,
  });
});

export const layer = Layer.effect(ManagedBrowserControls, make);
