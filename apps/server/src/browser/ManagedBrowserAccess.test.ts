// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import * as Fiber from "effect/Fiber";

import {
  AuthSessionId,
  EnvironmentId,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  type ManagedBrowserGrantCreateInput,
} from "@t3tools/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedBrowserAccess from "./ManagedBrowserAccess.ts";

const owner = EnvironmentId.make("env-owner");
const peer = EnvironmentId.make("env-peer");
const instance = ManagedBrowserInstanceId.make("instance-1");
const profile = ManagedBrowserProfileId.make("profile-1");
const otherProfile = ManagedBrowserProfileId.make("profile-2");
const resource = { instanceId: instance, profileId: profile };

/** The server's secret store, in memory; one map is one server's store, shared by its restarts. */
const memoryStore = (secrets: Map<string, Uint8Array> = new Map()) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
      set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const found = secrets.get(name);
          if (found !== undefined) return found;
          const made = new Uint8Array(NodeCrypto.randomBytes(bytes));
          secrets.set(name, made);
          return made;
        }),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
    }),
  );

const temporaryFile = () => {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "managed-access-"));
  return { directory, path: Path.join(directory, "grants.json") };
};

const agentGrant = (
  extra: Partial<ManagedBrowserGrantCreateInput> = {},
): ManagedBrowserGrantCreateInput => ({
  subject: {
    kind: "agent",
    callerEnvironmentId: peer,
    threadId: "thread-1",
    agentSessionId: "session-1",
  },
  resources: [resource],
  access: "operate",
  ttlSeconds: 3600,
  ...extra,
});

const ownerThread = ManagedBrowserAccess.remoteThreadId(peer, "thread-1");

const caller = (extra: Partial<ManagedBrowserAccess.AgentAuthorization> = {}) => ({
  callerEnvironmentId: peer,
  threadId: ownerThread,
  agentSessionId: "session-1",
  resource,
  access: "operate" as const,
  ...extra,
});

const withAccess = <A, E>(
  options:
    | { path?: string | null; now?: () => number; secrets?: Map<string, Uint8Array> }
    | undefined,
  body: (
    service: ManagedBrowserAccess.ManagedBrowserAccessService["Service"],
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const service = yield* ManagedBrowserAccess.ManagedBrowserAccessService;
    return yield* body(service);
  }).pipe(
    Effect.provide(
      ManagedBrowserAccess.layer({
        ownerEnvironmentId: owner,
        path: options?.path ?? null,
        ...(options?.now === undefined ? {} : { now: options.now }),
      }).pipe(Layer.provide(memoryStore(options?.secrets))),
    ),
    Effect.scoped,
  );

const failureTag = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  return Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as { error?: { _tag?: string } })
        ?.error?._tag
    : undefined;
};

describe("a grant's credential", () => {
  it.effect("is shown once, and neither the listing nor the file on disk holds it", () =>
    Effect.gen(function* () {
      const { path, directory } = temporaryFile();
      yield* withAccess({ path }, (access) =>
        Effect.gen(function* () {
          const created = yield* access.enroll(agentGrant());
          const credential = created.credential!;
          assert.match(credential, /^mbg\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
          const listed = JSON.stringify(yield* access.list);
          assert.notInclude(listed, credential);
          assert.notInclude(listed, "digest");
          const onDisk = FS.readFileSync(path, "utf8");
          assert.notInclude(onDisk, credential);
          assert.notInclude(onDisk, credential.split(".")[2]!);
          assert.equal(FS.statSync(path).mode & 0o777, 0o600);
          // The digest alone does not authenticate.
          const digest = (JSON.parse(onDisk) as { grants: Array<{ digest: string }> }).grants[0]!
            .digest;
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(access.authenticate(`mbg.${created.grant.id}.${digest}`)),
            ),
          );
        }),
      );
      FS.rmSync(directory, { recursive: true, force: true });
    }),
  );

  it.effect("authenticates the grant it was issued for, and nothing similar", () =>
    withAccess(undefined, (access) =>
      Effect.gen(function* () {
        const created = yield* access.enroll(agentGrant());
        const credential = created.credential!;
        const grant = yield* access.authenticate(credential);
        assert.equal(grant.id, created.grant.id);
        const [prefix, id, secret] = credential.split(".");
        const flipped = `${secret!.slice(0, -1)}${secret!.endsWith("A") ? "B" : "A"}`;
        for (const attempt of [
          `${prefix}.${id}.${flipped}`,
          `${prefix}.${"0".repeat(32)}.${secret}`,
          `${prefix}.${id}`,
          `x.${id}.${secret}`,
          "",
          credential + "x",
        ]) {
          assert.equal(
            failureTag(yield* Effect.exit(access.authenticate(attempt))),
            "ManagedBrowserAccessNotGrantedError",
            attempt,
          );
        }
      }),
    ),
  );

  it.effect("stops working when revoked, and when it expires", () => {
    let clock = 1_000_000;
    return withAccess({ now: () => clock }, (access) =>
      Effect.gen(function* () {
        const revoked = yield* access.enroll(agentGrant());
        const expiring = yield* access.enroll(agentGrant({ ttlSeconds: 60 }));
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(access.authenticate(revoked.credential!))));
        assert.isTrue(yield* access.revoke(revoked.grant.id));
        assert.isFalse(yield* access.revoke(revoked.grant.id));
        assert.isFalse(yield* access.revoke("0".repeat(32)));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(access.authenticate(revoked.credential!))));
        assert.isTrue(
          Exit.isSuccess(yield* Effect.exit(access.authenticate(expiring.credential!))),
        );
        clock += 59_999;
        assert.isTrue(
          Exit.isSuccess(yield* Effect.exit(access.authenticate(expiring.credential!))),
        );
        clock += 2;
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(access.authenticate(expiring.credential!))),
        );
      }),
    );
  });

  it.effect("is not issued for a viewer, whose authority is its logged-in session", () =>
    withAccess(undefined, (access) =>
      Effect.gen(function* () {
        const created = yield* access.enroll({
          subject: { kind: "viewer", viewerSessionId: AuthSessionId.make("session-viewer") },
          resources: [resource],
          access: "read",
          ttlSeconds: 60,
        });
        assert.isUndefined(created.credential);
      }),
    ),
  );

  it.effect("has a lifetime that is always bounded", () =>
    withAccess(undefined, (access) =>
      Effect.gen(function* () {
        for (const ttlSeconds of [0, -5, 30 * 24 * 3600 + 1]) {
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(access.enroll(agentGrant({ ttlSeconds })))),
          );
        }
      }),
    ),
  );
});

describe("an agent grant", () => {
  it.effect("covers exactly its environment, thread, provider session, browser and access", () =>
    withAccess(undefined, (access) =>
      Effect.gen(function* () {
        yield* access.enroll(agentGrant());
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(access.authorizeAgent(caller()))));
        const refused: Array<[string, ManagedBrowserAccess.AgentAuthorization]> = [
          ["environment", caller({ callerEnvironmentId: "env-other" })],
          ["thread", caller({ threadId: ManagedBrowserAccess.remoteThreadId(peer, "thread-2") })],
          ["owner's own thread of the same name", caller({ threadId: "thread-1" })],
          ["provider session", caller({ agentSessionId: "session-2" })],
          ["profile", caller({ resource: { instanceId: instance, profileId: otherProfile } })],
          [
            "instance",
            caller({
              resource: { instanceId: ManagedBrowserInstanceId.make("i-2"), profileId: profile },
            }),
          ],
        ];
        for (const [label, request] of refused) {
          assert.equal(
            failureTag(yield* Effect.exit(access.authorizeAgent(request))),
            "ManagedBrowserAccessNotGrantedError",
            label,
          );
        }
      }),
    ),
  );

  it.effect("distinguishes looking from acting", () =>
    withAccess(undefined, (access) =>
      Effect.gen(function* () {
        yield* access.enroll(agentGrant({ access: "read" }));
        assert.isTrue(
          Exit.isSuccess(yield* Effect.exit(access.authorizeAgent(caller({ access: "read" })))),
        );
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(access.authorizeAgent(caller({ access: "operate" })))),
        );
        assert.equal(ManagedBrowserAccess.accessForOperation("snapshot"), "read");
        assert.equal(ManagedBrowserAccess.accessForOperation("status"), "read");
        for (const operation of [
          "open",
          "click",
          "navigate",
          "evaluate",
          "upload",
          "close",
          "type",
        ]) {
          assert.equal(ManagedBrowserAccess.accessForOperation(operation), "operate", operation);
        }
      }),
    ),
  );

  it.effect("is refused the moment it is revoked or expires, with no other change", () => {
    let clock = 5_000_000;
    return withAccess({ now: () => clock }, (access) =>
      Effect.gen(function* () {
        const first = yield* access.enroll(agentGrant({ ttlSeconds: 100 }));
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(access.authorizeAgent(caller()))));
        clock += 100_000;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(access.authorizeAgent(caller()))));
        yield* access.enroll(agentGrant({ ttlSeconds: 100 }));
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(access.authorizeAgent(caller()))));
        const second = (yield* access.list).find((grant) => grant.id !== first.grant.id)!;
        yield* access.revoke(second.id);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(access.authorizeAgent(caller()))));
      }),
    );
  });
});

describe("a viewer grant", () => {
  const viewer = (sessionId: string) => ({
    viewerSessionId: sessionId,
    resource,
    access: "read" as const,
  });
  const viewerGrant = (sessionId: string, access: "read" | "operate" = "read") => ({
    subject: { kind: "viewer" as const, viewerSessionId: AuthSessionId.make(sessionId) },
    resources: [resource],
    access,
    ttlSeconds: 60,
  });

  it.effect("names one session and one browser", () =>
    withAccess(undefined, (access) =>
      Effect.gen(function* () {
        yield* access.enroll(viewerGrant("session-a"));
        assert.isTrue(
          Exit.isSuccess(yield* Effect.exit(access.authorizeViewer(viewer("session-a")))),
        );
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(access.authorizeViewer(viewer("session-b")))),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              access.authorizeViewer({
                ...viewer("session-a"),
                resource: { instanceId: instance, profileId: otherProfile },
              }),
            ),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              access.authorizeViewer({ ...viewer("session-a"), access: "operate" }),
            ),
          ),
        );
        // An agent grant never admits a viewer, and a viewer grant never admits an agent.
        yield* access.enroll(agentGrant());
        assert.isTrue(Exit.isFailure(yield* Effect.exit(access.authorizeViewer(viewer(peer)))));
      }),
    ),
  );

  it.effect("ends the stream it admitted when it is revoked, and at once if it already was", () =>
    withAccess(undefined, (access) =>
      Effect.gen(function* () {
        const created = yield* access.enroll(viewerGrant("session-a"));
        const ended = yield* access.untilEnded(created.grant.id).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isUndefined(ended.pollUnsafe());
        yield* access.revoke(created.grant.id);
        yield* Fiber.join(ended);
        // Already revoked: nothing to wait for.
        yield* access.untilEnded(created.grant.id);
        yield* access.untilEnded("0".repeat(32));
      }),
    ),
  );
});

describe("the grant record", () => {
  it.effect("survives a restart with the same credentials, and keeps revocations", () =>
    Effect.gen(function* () {
      const { path, directory } = temporaryFile();
      const secrets = new Map<string, Uint8Array>();
      const created = yield* withAccess({ path, secrets }, (access) =>
        Effect.gen(function* () {
          const kept = yield* access.enroll(agentGrant());
          const dropped = yield* access.enroll(agentGrant());
          yield* access.revoke(dropped.grant.id);
          return { kept, dropped };
        }),
      );
      yield* withAccess({ path, secrets }, (access) =>
        Effect.gen(function* () {
          assert.isTrue(
            Exit.isSuccess(yield* Effect.exit(access.authenticate(created.kept.credential!))),
          );
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(access.authenticate(created.dropped.credential!))),
          );
        }),
      );
      FS.rmSync(directory, { recursive: true, force: true });
    }),
  );

  it.effect("is not treated as empty when it cannot be read: everything fails closed", () =>
    Effect.gen(function* () {
      const { path, directory } = temporaryFile();
      const secrets = new Map<string, Uint8Array>();
      const created = yield* withAccess({ path, secrets }, (access) => access.enroll(agentGrant()));
      FS.writeFileSync(path, "{ not json");
      yield* withAccess({ path, secrets }, (access) =>
        Effect.gen(function* () {
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(access.authenticate(created.credential!))),
          );
          assert.isTrue(Exit.isFailure(yield* Effect.exit(access.authorizeAgent(caller()))));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(access.enroll(agentGrant()))));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(access.list)));
        }),
      );
      // The unreadable file was left for someone to look at, not overwritten.
      assert.equal(FS.readFileSync(path, "utf8"), "{ not json");
      FS.rmSync(directory, { recursive: true, force: true });
    }),
  );

  it.effect("cannot be used with a different key: a copied file authenticates nothing", () =>
    Effect.gen(function* () {
      const { path, directory } = temporaryFile();
      const created = yield* withAccess({ path }, (access) => access.enroll(agentGrant()));
      // Another server, with its own secret store, holding a copy of the file.
      const copied = yield* withAccess({ path }, (access) =>
        Effect.exit(access.authenticate(created.credential!)),
      );
      assert.isTrue(Exit.isFailure(copied));
      FS.rmSync(directory, { recursive: true, force: true });
    }),
  );
});
