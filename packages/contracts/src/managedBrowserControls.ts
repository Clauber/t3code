/**
 * Managed browser controls - what a person's client asks of the environment that owns a shared browser.
 *
 * These are the protected RPC shapes behind the settings screens and the browser viewer. They carry no
 * browser credentials of their own: a client reaches the owner over its own prepared connection, grants
 * and enrollments reuse {@link ./managedBrowser.ts}, and a tab's stream is requested from the owner by the
 * host ids listed here.
 *
 * @module ManagedBrowserControls
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString, ThreadId } from "./baseSchemas.ts";
import {
  ManagedBrowserControlPhase,
  ManagedBrowserGrantId,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  ManagedBrowserTabId,
} from "./managedBrowser.ts";
import { PreviewTabId } from "./preview.ts";

/** What a viewer can look at: the page alone, or the whole Chrome window with its toolbar and dialogs. */
export const ManagedBrowserSurface = Schema.Literals(["page", "window"]);
export type ManagedBrowserSurface = typeof ManagedBrowserSurface.Type;

/** An optional capability and, when it is missing, a sentence a person can act on. */
export const ManagedBrowserCapability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ManagedBrowserCapability = typeof ManagedBrowserCapability.Type;

/** `unavailable` is a tab whose browser is not running right now. */
export const ManagedBrowserTabPhase = Schema.Literals([
  ...ManagedBrowserControlPhase.literals,
  "unavailable",
]);
export type ManagedBrowserTabPhase = typeof ManagedBrowserTabPhase.Type;

/** One shared-browser tab the caller may look at. The host ids are how a viewer asks the owner for its stream. */
export const ManagedBrowserTabSummary = Schema.Struct({
  engineTabId: ManagedBrowserTabId,
  instanceId: ManagedBrowserInstanceId,
  profileId: ManagedBrowserProfileId,
  incarnation: ManagedBrowserIncarnation,
  hostThreadId: TrimmedNonEmptyString,
  hostTabId: PreviewTabId,
  title: Schema.String.check(Schema.isMaxLength(1024)),
  url: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
  /** Whether other chats may join this tab. */
  shared: Schema.Boolean,
  /** How many chats hold this tab. */
  participants: NonNegativeInt,
  phase: ManagedBrowserTabPhase,
  /**
   * Whether the asking session holds the browser's control now, through {@link ManagedBrowserSetControlInput}
   * or an earlier take. Only meaningful while `phase` is `human`; absent from owners that predate it.
   */
  heldByYou: Schema.optional(Schema.Boolean),
});
export type ManagedBrowserTabSummary = typeof ManagedBrowserTabSummary.Type;

export const ManagedBrowserProfileSummary = Schema.Struct({
  instanceId: ManagedBrowserInstanceId,
  profileId: ManagedBrowserProfileId,
  tabs: NonNegativeInt,
});
export type ManagedBrowserProfileSummary = typeof ManagedBrowserProfileSummary.Type;

export const ManagedBrowserHosting = Schema.Struct({
  available: Schema.Boolean,
  /** Stable machine-readable cause when unavailable; the client words it. */
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
});
export type ManagedBrowserHosting = typeof ManagedBrowserHosting.Type;

export const ManagedBrowserOverview = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  hosting: ManagedBrowserHosting,
  /** Whether the whole Chrome window can be shown here, and why not when it cannot. */
  fullWindow: ManagedBrowserCapability,
  /**
   * Whether this owner opens its browser as a window on its own computer's screen (the desktop app on a Mac).
   * It says what the owner does, not who is looking: a client may offer to use that window only when it
   * runs on that same computer. Absent from owners that predate it.
   */
  native: Schema.optional(ManagedBrowserCapability),
  profiles: Schema.Array(ManagedBrowserProfileSummary),
  tabs: Schema.Array(ManagedBrowserTabSummary),
});
export type ManagedBrowserOverview = typeof ManagedBrowserOverview.Type;

export const ManagedBrowserOpenTabInput = Schema.Struct({
  /** Human tab opened from a chat, before or after its provider session exists. */
  thread: Schema.optional(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
  instanceId: ManagedBrowserInstanceId,
  profileId: ManagedBrowserProfileId,
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  /** Let other chats join the tab. */
  shared: Schema.optional(Schema.Boolean),
  /** Hold the browser's control as this session as soon as the tab is open, before any agent can act on it. */
  takeControl: Schema.optional(Schema.Boolean),
});
export type ManagedBrowserOpenTabInput = typeof ManagedBrowserOpenTabInput.Type;

export const ManagedBrowserOpenTabResult = Schema.Struct({ tab: ManagedBrowserTabSummary });
export type ManagedBrowserOpenTabResult = typeof ManagedBrowserOpenTabResult.Type;

export const ManagedBrowserSetSharedInput = Schema.Struct({
  hostThreadId: TrimmedNonEmptyString,
  hostTabId: PreviewTabId,
  shared: Schema.Boolean,
});
export type ManagedBrowserSetSharedInput = typeof ManagedBrowserSetSharedInput.Type;

export const ManagedBrowserSetSharedResult = Schema.Struct({ tab: ManagedBrowserTabSummary });
export type ManagedBrowserSetSharedResult = typeof ManagedBrowserSetSharedResult.Type;

/**
 * Take the browser's control as a person, or give it back to agents, without watching its stream. This is the
 * same lease the viewer's Take and Release use; holding it here keeps agents from changing the page while a
 * person works in the browser's own window, but it cannot stop what that person types into that window.
 */
export const ManagedBrowserControlAction = Schema.Literals(["take", "release"]);
export type ManagedBrowserControlAction = typeof ManagedBrowserControlAction.Type;

export const ManagedBrowserSetControlInput = Schema.Struct({
  hostThreadId: TrimmedNonEmptyString,
  hostTabId: PreviewTabId,
  action: ManagedBrowserControlAction,
});
export type ManagedBrowserSetControlInput = typeof ManagedBrowserSetControlInput.Type;

export const ManagedBrowserSetControlResult = Schema.Struct({ tab: ManagedBrowserTabSummary });
export type ManagedBrowserSetControlResult = typeof ManagedBrowserSetControlResult.Type;

export const ManagedBrowserGrantRevokeInput = Schema.Struct({ id: ManagedBrowserGrantId });
export type ManagedBrowserGrantRevokeInput = typeof ManagedBrowserGrantRevokeInput.Type;
export const ManagedBrowserGrantRevokeResult = Schema.Struct({ revoked: Schema.Boolean });
export type ManagedBrowserGrantRevokeResult = typeof ManagedBrowserGrantRevokeResult.Type;

export const ManagedBrowserEnrollmentRemoveInput = Schema.Struct({ id: ManagedBrowserGrantId });
export type ManagedBrowserEnrollmentRemoveInput = typeof ManagedBrowserEnrollmentRemoveInput.Type;
export const ManagedBrowserEnrollmentRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type ManagedBrowserEnrollmentRemoveResult = typeof ManagedBrowserEnrollmentRemoveResult.Type;

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export const ManagedBrowserUpdateCheckOutcome = Schema.Literals([
  "upToDate",
  "staged",
  "paused",
  "pinned",
  "offline",
  "rejected",
  "unprovisioned",
  "unauthorized",
  "unavailable",
]);
export type ManagedBrowserUpdateCheckOutcome = typeof ManagedBrowserUpdateCheckOutcome.Type;

/**
 * The state of the browser component's updates. `provisioning` says what this build still lacks (a
 * signing key, a bundled release, a release source): each is a setup step, not a fault, and nothing
 * here claims a release exists that does not.
 */
export const ManagedBrowserUpdateStatus = Schema.Struct({
  hosting: ManagedBrowserHosting,
  provisioning: Schema.Struct({
    signingKey: Schema.Boolean,
    baseline: Schema.Boolean,
    releaseSource: Schema.Boolean,
  }),
  current: Schema.NullOr(Schema.String),
  previous: Schema.NullOr(Schema.String),
  staged: Schema.NullOr(Schema.String),
  policy: Schema.Struct({
    paused: Schema.Boolean,
    pinnedVersion: Schema.NullOr(Schema.String),
  }),
  quarantined: Schema.Array(Schema.Struct({ version: Schema.String, reason: Schema.String })),
  lastCheck: Schema.NullOr(
    Schema.Struct({
      at: Schema.Number,
      outcome: ManagedBrowserUpdateCheckOutcome,
    }),
  ),
  /** A staged release that could not be switched to yet, and what it is waiting on. */
  waiting: Schema.NullOr(Schema.Struct({ reasons: Schema.Array(Schema.String) })),
  /** An update is being applied right now. */
  applying: Schema.Boolean,
  /**
   * The last switch failed and the previous release could not be restored. `restartRequired` means a browser's
   * exit is unproven and this server keeps launches off until it is restarted, so a retry cannot work yet.
   */
  recovery: Schema.NullOr(
    Schema.Struct({
      failed: Schema.String,
      detail: Schema.String,
      status: Schema.Literals(["retryable", "restartRequired"]),
    }),
  ),
});
export type ManagedBrowserUpdateStatus = typeof ManagedBrowserUpdateStatus.Type;

export const ManagedBrowserUpdateAction = Schema.Literals([
  "check",
  "pause",
  "resume",
  "pin",
  "unpin",
  "rollback",
  "recover",
]);
export type ManagedBrowserUpdateAction = typeof ManagedBrowserUpdateAction.Type;

export const ManagedBrowserUpdateInput = Schema.Struct({ action: ManagedBrowserUpdateAction });
export type ManagedBrowserUpdateInput = typeof ManagedBrowserUpdateInput.Type;

/** What switching releases did, when the action tried to. */
export const ManagedBrowserUpdateActivation = Schema.Struct({
  result: Schema.Literals(["activated", "deferred", "rolledBack", "recoveryFailed"]),
  version: Schema.optional(Schema.String),
  reasons: Schema.optional(Schema.Array(Schema.String)),
  detail: Schema.optional(Schema.String),
});
export type ManagedBrowserUpdateActivation = typeof ManagedBrowserUpdateActivation.Type;

export const ManagedBrowserUpdateResult = Schema.Struct({
  status: ManagedBrowserUpdateStatus,
  activation: Schema.NullOr(ManagedBrowserUpdateActivation),
});
export type ManagedBrowserUpdateResult = typeof ManagedBrowserUpdateResult.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ManagedBrowserControlErrorReason = Schema.Literals([
  /** This server cannot run a shared browser, so there is nothing here to manage. */
  "notHosted",
  "notFound",
  "refused",
  "invalid",
  "busy",
  "unprovisioned",
  "unauthorized",
  "sourceUnavailable",
  "rejected",
  "unavailable",
]);
export type ManagedBrowserControlErrorReason = typeof ManagedBrowserControlErrorReason.Type;

export class ManagedBrowserControlError extends Schema.TaggedError<ManagedBrowserControlError>()(
  "ManagedBrowserControlError",
  {
    reason: ManagedBrowserControlErrorReason,
    message: Schema.String,
  },
) {}

/** Opaque live MCP principal; contains no bearer credential. Null until a browser-enabled session exists. */
export const ManagedBrowserAgentIdentity = Schema.Struct({ agentSessionId: Schema.NullOr(Schema.String) });
export type ManagedBrowserAgentIdentity = typeof ManagedBrowserAgentIdentity.Type;
