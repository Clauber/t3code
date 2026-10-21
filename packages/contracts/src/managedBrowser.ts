/**
 * Managed browser control vocabulary - the identities, fence, and control
 * states shared by the owner supervisor and its clients.
 *
 * This is deliberately only the protocol-independent part. The operation and
 * event messages exchanged with the engine child are not defined here until the
 * engine schema is frozen.
 *
 * @module ManagedBrowser
 */
import * as Schema from "effect/Schema";
import {
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** External identities are opaque, so they are bounded in length rather than constrained by a filesystem-style pattern. */
const ManagedBrowserOpaqueId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const ManagedBrowserInstanceId = ManagedBrowserOpaqueId.pipe(
  Schema.brand("ManagedBrowserInstanceId"),
);
export type ManagedBrowserInstanceId = typeof ManagedBrowserInstanceId.Type;

/** Names the persistent profile an instance writes; the supervisor binds each instance to exactly one. */
export const ManagedBrowserProfileId = ManagedBrowserOpaqueId.pipe(
  Schema.brand("ManagedBrowserProfileId"),
);
export type ManagedBrowserProfileId = typeof ManagedBrowserProfileId.Type;

export const ManagedBrowserTabId = ManagedBrowserOpaqueId.pipe(Schema.brand("ManagedBrowserTabId"));
export type ManagedBrowserTabId = typeof ManagedBrowserTabId.Type;

/** Authenticated caller identity, assigned by the server, never taken from a request body. */
export const ManagedBrowserPrincipalId = ManagedBrowserOpaqueId.pipe(
  Schema.brand("ManagedBrowserPrincipalId"),
);
export type ManagedBrowserPrincipalId = typeof ManagedBrowserPrincipalId.Type;

/**
 * Identifies one boot of the engine child. It is an opaque token compared for
 * equality, not a counter, so a fence minted before a T3 restart can never match
 * the incarnation of a browser started after it.
 */
export const ManagedBrowserIncarnation = ManagedBrowserOpaqueId.pipe(
  Schema.brand("ManagedBrowserIncarnation"),
);
export type ManagedBrowserIncarnation = typeof ManagedBrowserIncarnation.Type;

export const ManagedBrowserControlGeneration = NonNegativeInt.pipe(
  Schema.brand("ManagedBrowserControlGeneration"),
);
export type ManagedBrowserControlGeneration = typeof ManagedBrowserControlGeneration.Type;

/** Carried on every mutation so work queued before a restart or takeover cannot execute after it. */
export const ManagedBrowserFence = Schema.Struct({
  incarnation: ManagedBrowserIncarnation,
  generation: ManagedBrowserControlGeneration,
});
export type ManagedBrowserFence = typeof ManagedBrowserFence.Type;

/** `read` may observe state and streams; only `operate` may mutate the browser. */
export const ManagedBrowserAccess = Schema.Literals(["read", "operate"]);
export type ManagedBrowserAccess = typeof ManagedBrowserAccess.Type;

export const ManagedBrowserPrincipalKind = Schema.Literals(["agent", "human"]);
export type ManagedBrowserPrincipalKind = typeof ManagedBrowserPrincipalKind.Type;

/** The result of resource-bound grant validation, which happens before the control layer. */
export const ManagedBrowserPrincipal = Schema.Struct({
  id: ManagedBrowserPrincipalId,
  kind: ManagedBrowserPrincipalKind,
  access: ManagedBrowserAccess,
});
export type ManagedBrowserPrincipal = typeof ManagedBrowserPrincipal.Type;

/**
 * Held by whoever closed admission for maintenance. Restarting or ending maintenance
 * needs the token, so one caller can never reopen admission another still relies on.
 */
export const ManagedBrowserMaintenanceToken = ManagedBrowserOpaqueId.pipe(
  Schema.brand("ManagedBrowserMaintenanceToken"),
);
export type ManagedBrowserMaintenanceToken = typeof ManagedBrowserMaintenanceToken.Type;

/** What a caller names to start or find an instance; the supervisor fixes the instance-to-profile mapping from it. */
export const ManagedBrowserInstanceDescriptor = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  instanceId: ManagedBrowserInstanceId,
  profileId: ManagedBrowserProfileId,
});
export type ManagedBrowserInstanceDescriptor = typeof ManagedBrowserInstanceDescriptor.Type;

/**
 * A session id alone conveys no authority; the owner environment validates every
 * reference against its fixed instance-to-profile mapping and its current incarnation.
 */
export const ManagedBrowserRef = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  instanceId: ManagedBrowserInstanceId,
  profileId: ManagedBrowserProfileId,
  incarnation: ManagedBrowserIncarnation,
  tabId: Schema.optional(ManagedBrowserTabId),
});
export type ManagedBrowserRef = typeof ManagedBrowserRef.Type;

/**
 * - `agent`: no human holds the lease; agent principals may mutate.
 * - `human`: one connected human holds the lease.
 * - `reconnectHold`: the holder's viewer dropped; nobody mutates until it reacquires or the hold expires.
 * - `paused`: the hold expired or a transfer failed; nobody mutates until a human explicitly takes control.
 * - `transferring`: the lease is changing hands; nobody mutates until the previous controller's work has
 *   drained and its input is released, and then the target phase is published.
 */
export const ManagedBrowserControlPhase = Schema.Literals([
  "agent",
  "human",
  "reconnectHold",
  "paused",
  "transferring",
]);
export type ManagedBrowserControlPhase = typeof ManagedBrowserControlPhase.Type;

/** `maintenance` refuses new work while admitted work drains; `closed` is terminal for an incarnation. */
export const ManagedBrowserAdmission = Schema.Literals(["open", "maintenance", "closed"]);
export type ManagedBrowserAdmission = typeof ManagedBrowserAdmission.Type;

export const ManagedBrowserControlState = Schema.Struct({
  instanceId: ManagedBrowserInstanceId,
  fence: ManagedBrowserFence,
  phase: ManagedBrowserControlPhase,
  admission: ManagedBrowserAdmission,
  holder: Schema.NullOr(ManagedBrowserPrincipalId),
  holdExpiresAtMs: Schema.NullOr(Schema.Number),
});
export type ManagedBrowserControlState = typeof ManagedBrowserControlState.Type;

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** Names one grant. It is not a secret: the credential that proves it is shown once, at creation. */
export const ManagedBrowserGrantId = ManagedBrowserOpaqueId.pipe(
  Schema.brand("ManagedBrowserGrantId"),
);
export type ManagedBrowserGrantId = typeof ManagedBrowserGrantId.Type;

/** One browser a grant reaches: an instance and the single profile it writes. */
export const ManagedBrowserGrantResource = Schema.Struct({
  instanceId: ManagedBrowserInstanceId,
  profileId: ManagedBrowserProfileId,
});
export type ManagedBrowserGrantResource = typeof ManagedBrowserGrantResource.Type;

/**
 * An agent in another environment. The grant is bound to the calling environment, the thread and the
 * provider session the agent runs in, so a credential copied into any other thread is useless.
 */
export const ManagedBrowserAgentGrantSubject = Schema.Struct({
  kind: Schema.Literal("agent"),
  callerEnvironmentId: EnvironmentId,
  threadId: ManagedBrowserOpaqueId,
  agentSessionId: ManagedBrowserOpaqueId,
});
export type ManagedBrowserAgentGrantSubject = typeof ManagedBrowserAgentGrantSubject.Type;

/**
 * A person's client session. Logging in to the owner, or pairing with it, grants no view of a managed
 * profile by itself; this names the one authenticated session that may watch (and, with `operate`, drive).
 */
export const ManagedBrowserViewerGrantSubject = Schema.Struct({
  kind: Schema.Literal("viewer"),
  viewerSessionId: AuthSessionId,
});
export type ManagedBrowserViewerGrantSubject = typeof ManagedBrowserViewerGrantSubject.Type;

export const ManagedBrowserGrantSubject = Schema.Union([
  ManagedBrowserAgentGrantSubject,
  ManagedBrowserViewerGrantSubject,
]);
export type ManagedBrowserGrantSubject = typeof ManagedBrowserGrantSubject.Type;

/** What the owner remembers about a grant. The credential itself is never part of this record. */
export const ManagedBrowserGrant = Schema.Struct({
  id: ManagedBrowserGrantId,
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  ownerEnvironmentId: EnvironmentId,
  subject: ManagedBrowserGrantSubject,
  resources: Schema.Array(ManagedBrowserGrantResource).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  access: ManagedBrowserAccess,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type ManagedBrowserGrant = typeof ManagedBrowserGrant.Type;

/** Longest a grant may live. Renewal is a new grant, so expiry is always a real bound. */
export const MANAGED_BROWSER_GRANT_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

export const ManagedBrowserGrantCreateInput = Schema.Struct({
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  subject: ManagedBrowserGrantSubject,
  resources: Schema.Array(ManagedBrowserGrantResource).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  access: ManagedBrowserAccess,
  ttlSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(MANAGED_BROWSER_GRANT_MAX_TTL_SECONDS),
  ),
});
export type ManagedBrowserGrantCreateInput = typeof ManagedBrowserGrantCreateInput.Type;

/** `credential` is present for agent grants only, and only in this response. */
export const ManagedBrowserGrantCreateResult = Schema.Struct({
  grant: ManagedBrowserGrant,
  credential: Schema.optional(Schema.String),
});
export type ManagedBrowserGrantCreateResult = typeof ManagedBrowserGrantCreateResult.Type;

export const ManagedBrowserGrantList = Schema.Struct({ grants: Schema.Array(ManagedBrowserGrant) });
export type ManagedBrowserGrantList = typeof ManagedBrowserGrantList.Type;

// ---------------------------------------------------------------------------
// Enrollment (the calling side of a grant)
// ---------------------------------------------------------------------------

/**
 * Where a calling environment sends its calls for one owner. The endpoint is fixed here, by an
 * administrator, and is never taken from a tool call. The credential is stored in the server's secret
 * store and is not part of this record.
 */
export const ManagedBrowserEnrollment = Schema.Struct({
  id: ManagedBrowserGrantId,
  ownerEnvironmentId: EnvironmentId,
  /** Scheme, host and port of the owner. No path, credentials, query or fragment. */
  endpoint: Schema.String,
  instanceId: ManagedBrowserInstanceId,
  profileId: ManagedBrowserProfileId,
  threadId: ManagedBrowserOpaqueId,
  agentSessionId: ManagedBrowserOpaqueId,
  /** The owner is authoritative; this only lets the caller stop sending a call it knows is dead. */
  expiresAt: IsoDateTime,
});
export type ManagedBrowserEnrollment = typeof ManagedBrowserEnrollment.Type;

export const ManagedBrowserEnrollmentCreateInput = Schema.Struct({
  ...ManagedBrowserEnrollment.fields,
  credential: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
});
export type ManagedBrowserEnrollmentCreateInput = typeof ManagedBrowserEnrollmentCreateInput.Type;

export const ManagedBrowserEnrollmentList = Schema.Struct({
  enrollments: Schema.Array(ManagedBrowserEnrollment),
});
export type ManagedBrowserEnrollmentList = typeof ManagedBrowserEnrollmentList.Type;

/** Paths of the owner's admin and peer routes. Everything lives under one prefix. */
export const MANAGED_BROWSER_ROUTE_PREFIX = "/api/managed-browser";
