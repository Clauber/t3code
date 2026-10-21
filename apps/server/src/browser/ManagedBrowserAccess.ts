// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off
/**
 * ManagedBrowserAccess - the owner's record of who may use which managed browser, and the checks
 * that stand between a request and the browser.
 *
 * Nothing is reachable by default. A grant names one subject, the profiles it reaches and whether it
 * may only look (`read`) or also act (`operate`), and it expires. Two kinds of subject exist:
 *
 * - an **agent** in another environment, bound to that environment, thread and provider session and
 *   proved by a credential the owner issues once. Pairing a client with several environments, or
 *   logging in to the owner, does not make one environment's server able to call another's: this
 *   credential is a separate thing, minted by an administrator of the owner;
 * - a **viewer**, bound to one authenticated client session of the owner. A paired or logged-in
 *   session sees no managed profile unless it holds such a grant (or is itself an administrator).
 *
 * The record lives in T3's state directory, outside any release or source tree, mode 0600. It stores
 * an HMAC of each credential keyed by a secret held in the server's secret store, never the credential:
 * a copy of the file cannot be used to call the owner and cannot be used to forge a credential. A file
 * that cannot be read is not treated as empty - every check then fails closed.
 *
 * Every check reads current state, so a revocation or an expiry takes effect on the next call or
 * input, and revocations are also published so a stream already open can be ended.
 *
 * @module ManagedBrowserAccess
 */
import {
  MANAGED_BROWSER_GRANT_MAX_TTL_SECONDS,
  type EnvironmentId,
  type ManagedBrowserAccess as GrantAccess,
  type ManagedBrowserGrant,
  type ManagedBrowserGrantCreateInput,
  type ManagedBrowserGrantCreateResult,
  type ManagedBrowserGrantResource,
  type ManagedBrowserGrantSubject,
  ManagedBrowserGrantId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The caller may not use this browser. The reason is for people; it never says which grant exists. */
export class ManagedBrowserAccessNotGrantedError extends Schema.TaggedError<ManagedBrowserAccessNotGrantedError>()(
  "ManagedBrowserAccessNotGrantedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The record could not be read, written or checked. Never a reason to allow anything. */
export class ManagedBrowserAccessStoreError extends Schema.TaggedError<ManagedBrowserAccessStoreError>()(
  "ManagedBrowserAccessStoreError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Preview operations that only look. Everything else acts on the browser, including opening a tab. */
const READ_OPERATIONS: ReadonlySet<string> = new Set(["status", "snapshot"]);

export const accessForOperation = (operation: string): GrantAccess =>
  READ_OPERATIONS.has(operation) ? "read" : "operate";

export const satisfies = (granted: GrantAccess, required: GrantAccess) =>
  granted === "operate" || required === "read";

/**
 * A remote agent's thread id is only unique within its own environment, so the owner keeps its tabs
 * under a name that includes the environment. Two environments can then both have a `thread-1`, and
 * neither can reach a tab of the owner's own `thread-1`.
 */
export const remoteThreadId = (callerEnvironmentId: string, threadId: string) =>
  `remote:${callerEnvironmentId}:${threadId}`;

const CREDENTIAL_PREFIX = "mbg";
const SECRET_NAME = "managed-browser-grant-key";
const SCHEMA_VERSION = 1;
const MAX_GRANTS = 1024;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface StoredGrant extends ManagedBrowserGrant {
  /** HMAC of the credential, hex. Absent for viewer grants, which have none. */
  readonly digest?: string;
}

const digestOf = (key: Uint8Array, credential: string) =>
  NodeCrypto.createHmac("sha256", key).update(credential).digest("hex");

const sameDigest = (left: string, right: string) => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && NodeCrypto.timingSafeEqual(a, b);
};

/** `mbg.<grant id>.<secret>`: the id finds the record, the secret proves it. */
const parseCredential = (credential: string) => {
  const parts = credential.split(".");
  if (parts.length !== 3 || parts[0] !== CREDENTIAL_PREFIX) return undefined;
  const id = parts[1] ?? "";
  const secret = parts[2] ?? "";
  return /^[0-9a-f]{32}$/.test(id) && /^[A-Za-z0-9_-]{43}$/.test(secret) ? { id } : undefined;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface GrantFile {
  readonly schemaVersion: number;
  readonly grants: ReadonlyArray<StoredGrant>;
}

const isGrant = Schema.is(
  Schema.Struct({
    id: Schema.String,
    ownerEnvironmentId: Schema.String,
    subject: Schema.Unknown,
    resources: Schema.Array(Schema.Unknown),
    access: Schema.Literals(["read", "operate"]),
    createdAt: Schema.String,
    expiresAt: Schema.String,
    revokedAt: Schema.NullOr(Schema.String),
  }),
);

type StoreLoad =
  | { readonly _tag: "ready" }
  | { readonly _tag: "unreadable"; readonly detail: string };

const makeStore = (path: string | null) => {
  const grants = new Map<string, StoredGrant>();
  let status: StoreLoad = { _tag: "ready" };
  if (path !== null) {
    try {
      if (FS.existsSync(path)) {
        const parsed = JSON.parse(FS.readFileSync(path, "utf8")) as Partial<GrantFile>;
        if (parsed.schemaVersion !== SCHEMA_VERSION) {
          status = {
            _tag: "unreadable",
            detail: `unsupported grant record version ${String(parsed.schemaVersion)}`,
          };
        } else {
          for (const entry of parsed.grants ?? []) {
            if (!isGrant(entry)) throw new Error("a grant record is malformed");
            grants.set(entry.id, entry as unknown as StoredGrant);
          }
        }
      }
    } catch (cause) {
      grants.clear();
      status = {
        _tag: "unreadable",
        detail: cause instanceof Error ? cause.message : "unreadable",
      };
    }
  }
  const save = () => {
    if (path === null || status._tag !== "ready") return;
    FS.mkdirSync(Path.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const body: GrantFile = { schemaVersion: SCHEMA_VERSION, grants: [...grants.values()] };
    FS.writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
    FS.renameSync(temporary, path);
  };
  return {
    get status() {
      return status;
    },
    get: (id: string) => grants.get(id),
    all: () => [...grants.values()],
    put: (grant: StoredGrant) => {
      const previous = grants.get(grant.id);
      if (previous === undefined && grants.size >= MAX_GRANTS) {
        throw new Error("the managed browser grant record is full; remove expired grants");
      }
      grants.set(grant.id, grant);
      try {
        save();
      } catch (cause) {
        if (previous === undefined) grants.delete(grant.id);
        else grants.set(grant.id, previous);
        throw cause;
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AgentAuthorization {
  readonly callerEnvironmentId: EnvironmentId | string;
  /** The thread id as the owner keeps it ({@link remoteThreadId}), which is what its adapter sees. */
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly resource: ManagedBrowserGrantResource;
  readonly access: GrantAccess;
}

export interface ViewerAuthorization {
  readonly viewerSessionId: string;
  readonly resource: ManagedBrowserGrantResource;
  readonly access: GrantAccess;
}

export class ManagedBrowserAccessService extends Context.Service<
  ManagedBrowserAccessService,
  {
    /** Mints a grant. The credential of an agent grant is in the result and nowhere else, ever. */
    readonly enroll: (
      input: ManagedBrowserGrantCreateInput,
    ) => Effect.Effect<ManagedBrowserGrantCreateResult, ManagedBrowserAccessStoreError>;
    readonly list: Effect.Effect<
      ReadonlyArray<ManagedBrowserGrant>,
      ManagedBrowserAccessStoreError
    >;
    /** True when a live grant was revoked. Revoking twice, or an unknown id, is false. */
    readonly revoke: (id: string) => Effect.Effect<boolean, ManagedBrowserAccessStoreError>;
    /** The agent grant a credential proves, if it is still live. */
    readonly authenticate: (
      credential: string,
    ) => Effect.Effect<ManagedBrowserGrant, ManagedBrowserAccessNotGrantedError>;
    /** Whether a live agent grant covers this exact caller, resource and access right now. */
    readonly authorizeAgent: (
      request: AgentAuthorization,
    ) => Effect.Effect<ManagedBrowserGrant, ManagedBrowserAccessNotGrantedError>;
    readonly authorizeViewer: (
      request: ViewerAuthorization,
    ) => Effect.Effect<ManagedBrowserGrant, ManagedBrowserAccessNotGrantedError>;
    /** Grant ids as they are revoked, so an open stream can end at once. */
    readonly revocations: Stream.Stream<string>;
    /** Completes when the grant is revoked or expires (at once if it already has). */
    readonly untilEnded: (id: string) => Effect.Effect<void>;
    /** Milliseconds since the epoch, from the clock grants expire by. */
    readonly now: () => number;
  }
>()("t3/browser/ManagedBrowserAccess/ManagedBrowserAccessService") {}

export interface ManagedBrowserAccessOptions {
  /** The environment that owns the browsers these grants reach. */
  readonly ownerEnvironmentId: EnvironmentId;
  /** File holding the grants. Null keeps them in memory, for tests that do not restart. */
  readonly path: string | null;
  readonly now?: () => number;
}

const denied = (reason: string) => new ManagedBrowserAccessNotGrantedError({ reason });

const make = (options: ManagedBrowserAccessOptions) =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    // Credentials are digested under a key only this server holds, so the grant record alone proves nothing.
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const key = yield* secrets.getOrCreateRandom(SECRET_NAME, 32);
    const store = makeStore(options.path);
    const revoked = yield* PubSub.unbounded<string>();
    if (store.status._tag !== "ready") {
      yield* Effect.logError("managed browser grant record is unreadable; every grant is refused", {
        detail: store.status.detail,
      });
    }

    const unreadable = () =>
      store.status._tag === "ready"
        ? undefined
        : new ManagedBrowserAccessStoreError({
            detail: `The managed browser grant record could not be read (${store.status.detail}).`,
          });

    const live = (grant: StoredGrant) =>
      grant.revokedAt === null && Date.parse(grant.expiresAt) > now();

    const covers = (grant: StoredGrant, resource: ManagedBrowserGrantResource) =>
      grant.resources.some(
        (candidate) =>
          candidate.instanceId === resource.instanceId &&
          candidate.profileId === resource.profileId,
      );

    const publicGrant = (grant: StoredGrant): ManagedBrowserGrant => {
      const { digest: _digest, ...rest } = grant;
      return rest;
    };

    const enroll: ManagedBrowserAccessService["Service"]["enroll"] = (input) =>
      Effect.gen(function* () {
        const failure = unreadable();
        if (failure !== undefined) return yield* failure;
        if (input.ttlSeconds < 1 || input.ttlSeconds > MANAGED_BROWSER_GRANT_MAX_TTL_SECONDS) {
          return yield* new ManagedBrowserAccessStoreError({
            detail: "The lifetime is out of range.",
          });
        }
        const id = NodeCrypto.randomBytes(16).toString("hex");
        const created = now();
        const agent = input.subject.kind === "agent";
        const secret = agent ? NodeCrypto.randomBytes(32).toString("base64url") : undefined;
        const credential =
          secret === undefined ? undefined : `${CREDENTIAL_PREFIX}.${id}.${secret}`;
        const grant: StoredGrant = {
          id: ManagedBrowserGrantId.make(id),
          ...(input.label === undefined ? {} : { label: input.label }),
          ownerEnvironmentId: options.ownerEnvironmentId,
          subject: input.subject,
          resources: input.resources,
          access: input.access,
          createdAt: new Date(created).toISOString(),
          expiresAt: new Date(created + input.ttlSeconds * 1000).toISOString(),
          revokedAt: null,
          ...(credential === undefined ? {} : { digest: digestOf(key, credential) }),
        };
        yield* Effect.try({
          try: () => store.put(grant),
          catch: (cause) =>
            new ManagedBrowserAccessStoreError({
              detail: cause instanceof Error ? cause.message : "The grant could not be saved.",
            }),
        });
        return {
          grant: publicGrant(grant),
          ...(credential === undefined ? {} : { credential }),
        };
      });

    const list: ManagedBrowserAccessService["Service"]["list"] = Effect.suspend(() => {
      const failure = unreadable();
      return failure !== undefined
        ? Effect.fail(failure)
        : Effect.succeed(store.all().map(publicGrant));
    });

    const revoke: ManagedBrowserAccessService["Service"]["revoke"] = (id) =>
      Effect.gen(function* () {
        const failure = unreadable();
        if (failure !== undefined) return yield* failure;
        const grant = store.get(id);
        if (grant === undefined || grant.revokedAt !== null) return false;
        yield* Effect.try({
          try: () => store.put({ ...grant, revokedAt: new Date(now()).toISOString() }),
          catch: (cause) =>
            new ManagedBrowserAccessStoreError({
              detail: cause instanceof Error ? cause.message : "The revocation could not be saved.",
            }),
        });
        yield* PubSub.publish(revoked, id);
        return true;
      });

    const authenticate: ManagedBrowserAccessService["Service"]["authenticate"] = (credential) =>
      Effect.suspend(() => {
        if (store.status._tag !== "ready") return Effect.fail(denied("Access is unavailable."));
        const parsed = parseCredential(credential);
        const grant = parsed === undefined ? undefined : store.get(parsed.id);
        // Compare even when nothing matched, so the time taken does not say which part was wrong.
        const expected = grant?.digest ?? "00".repeat(32);
        const matches = sameDigest(digestOf(key, credential), expected);
        if (grant === undefined || !matches || grant.subject.kind !== "agent" || !live(grant)) {
          return Effect.fail(denied("That credential is not valid."));
        }
        return Effect.succeed(publicGrant(grant));
      });

    const authorizeAgent: ManagedBrowserAccessService["Service"]["authorizeAgent"] = (request) =>
      Effect.suspend(() => {
        if (store.status._tag !== "ready") return Effect.fail(denied("Access is unavailable."));
        const match = store.all().find((grant) => {
          const subject = grant.subject;
          return (
            subject.kind === "agent" &&
            subject.callerEnvironmentId === request.callerEnvironmentId &&
            remoteThreadId(subject.callerEnvironmentId, subject.threadId) === request.threadId &&
            subject.agentSessionId === request.agentSessionId &&
            covers(grant, request.resource) &&
            satisfies(grant.access, request.access) &&
            live(grant)
          );
        });
        return match === undefined
          ? Effect.fail(
              denied("This caller has no live grant for that managed browser and kind of access."),
            )
          : Effect.succeed(publicGrant(match));
      });

    const authorizeViewer: ManagedBrowserAccessService["Service"]["authorizeViewer"] = (request) =>
      Effect.suspend(() => {
        if (store.status._tag !== "ready") return Effect.fail(denied("Access is unavailable."));
        const match = store.all().find((grant) => {
          const subject = grant.subject;
          return (
            subject.kind === "viewer" &&
            subject.viewerSessionId === request.viewerSessionId &&
            covers(grant, request.resource) &&
            satisfies(grant.access, request.access) &&
            live(grant)
          );
        });
        return match === undefined
          ? Effect.fail(denied("This session has no live grant to view that managed browser."))
          : Effect.succeed(publicGrant(match));
      });

    const untilEnded: ManagedBrowserAccessService["Service"]["untilEnded"] = (id) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before looking, so a revocation between the two cannot be missed.
          const subscription = yield* PubSub.subscribe(revoked);
          const grant = store.get(id);
          if (grant === undefined || !live(grant)) return;
          const remaining = Math.max(0, Date.parse(grant.expiresAt) - now());
          const revokedHere = Stream.fromSubscription(subscription).pipe(
            Stream.filter((revokedId) => revokedId === id),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* Effect.raceFirst(revokedHere, Effect.sleep(Duration.millis(remaining)));
        }),
      );

    return ManagedBrowserAccessService.of({
      enroll,
      list,
      revoke,
      authenticate,
      authorizeAgent,
      authorizeViewer,
      revocations: Stream.fromPubSub(revoked),
      untilEnded,
      now,
    });
  });

export const layer = (options: ManagedBrowserAccessOptions) =>
  Layer.effect(ManagedBrowserAccessService, make(options));

/** For code that must work with or without access control wired in. */
export const optionalService = Effect.serviceOption(ManagedBrowserAccessService).pipe(
  Effect.map(Option.getOrUndefined),
);

export type { ManagedBrowserGrantSubject };
