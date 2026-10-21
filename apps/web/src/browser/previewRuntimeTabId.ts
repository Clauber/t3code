import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * The server only guarantees preview tab ids are unique within one process.
 * Desktop resources live across every connected environment, so they need a
 * stronger identity that also changes when a server process restarts.
 */
export function previewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
  managed?: import("@t3tools/contracts").PreviewManagedSession,
): string {
  if (managed?.native)
    return JSON.stringify([
      managed.ownerEnvironmentId,
      managed.instanceId,
      managed.profileId,
      managed.engineTabId,
    ]);
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, serverEpoch, tabId]);
}

export function isCurrentPreviewRuntimeTab(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
  runtimeTabId: string,
): boolean {
  return previewRuntimeTabId(threadRef, serverEpoch, tabId) === runtimeTabId;
}
