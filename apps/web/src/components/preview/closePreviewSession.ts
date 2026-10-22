import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type PreviewCloseInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import { useClosedViewStore } from "~/closedViewStore";
import { beginPreviewSessionClose, cancelPreviewSessionClose } from "~/previewStateStore";

interface ClosePreviewSessionInput<E> {
  readonly closePreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewCloseInput;
  }) => Promise<AtomCommandResult<void, E>>;
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly tabId: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Optimistically closes a preview while suppressing stale list responses for
 * the same tab. A failed close restores the last known snapshot.
 */
export async function closePreviewSession<E>(
  input: ClosePreviewSessionInput<E>,
): Promise<AtomCommandResult<void, E>> {
  beginPreviewSessionClose(input.threadRef, input.tabId);
  const result = await input.closePreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, tabId: input.tabId },
  });
  if (result._tag === "Failure") {
    cancelPreviewSessionClose(input.threadRef, input.snapshot, input.tabId);
  } else if (input.snapshot) {
    // A tab in another environment's browser is held there under its own session; end that too, or
    // the page outlives its chat tab and keeps counting toward the owner's tab limit.
    const managed = input.snapshot.managed;
    if (managed?.remote === true) {
      void input.closePreview({
        environmentId: managed.ownerEnvironmentId,
        input: { threadId: ThreadId.make(managed.hostThreadId), tabId: managed.hostTabId },
      });
    }
    useClosedViewStore.getState().remember({
      kind: "browser",
      threadRef: input.threadRef,
      snapshot: input.snapshot,
    });
  }
  return result;
}
