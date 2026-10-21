/**
 * The wire between a calling environment and a managed browser's owner. A call carries the preview
 * request the calling agent made; the owner decides from the grant credential, never from the body,
 * who the caller is.
 *
 * @module ManagedBrowserPeer
 */
import * as Schema from "effect/Schema";

import { PreviewAutomationRequest } from "./previewAutomation.ts";

export const MANAGED_BROWSER_PEER_DISPATCH_PATH = "/api/managed-browser/peer/dispatch";
export const MANAGED_BROWSER_PEER_UPLOAD_PATH = "/api/managed-browser/peer/upload";
export const MANAGED_BROWSER_PEER_DOWNLOAD_PATH = "/api/managed-browser/peer/download";

/** Sent with every peer call so the owner can bind the credential to who is calling. */
export const MANAGED_BROWSER_PEER_THREAD_HEADER = "x-t3-managed-browser-thread";
export const MANAGED_BROWSER_PEER_SESSION_HEADER = "x-t3-managed-browser-session";
export const MANAGED_BROWSER_PEER_NAME_HEADER = "x-t3-managed-browser-name";

/** Prefix of a path that names bytes already sent to the owner, never an owner-local file. */
export const MANAGED_BROWSER_UPLOAD_HANDLE_PREFIX = "mbh:";
/** Prefix of a download path that names bytes still on the owner. */
export const MANAGED_BROWSER_DOWNLOAD_HANDLE_PREFIX = "mbd:";

export const ManagedBrowserPeerDispatchRequest = Schema.Struct({
  request: PreviewAutomationRequest,
});
export type ManagedBrowserPeerDispatchRequest = typeof ManagedBrowserPeerDispatchRequest.Type;

/** An operation failure, carried by tag and message so the caller's broker maps it as its own. */
export const ManagedBrowserPeerOperationFailure = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  detail: Schema.optional(Schema.Unknown),
});
export type ManagedBrowserPeerOperationFailure = typeof ManagedBrowserPeerOperationFailure.Type;

export const ManagedBrowserPeerDispatchResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ ok: Schema.Literal(false), error: ManagedBrowserPeerOperationFailure }),
]);
export type ManagedBrowserPeerDispatchResponse = typeof ManagedBrowserPeerDispatchResponse.Type;

export const ManagedBrowserPeerUploadResponse = Schema.Struct({ handle: Schema.String });
export type ManagedBrowserPeerUploadResponse = typeof ManagedBrowserPeerUploadResponse.Type;
