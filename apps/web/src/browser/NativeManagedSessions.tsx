import { useAtomValue } from "@effect/atom-react";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { usePreviewSession } from "~/components/preview/usePreviewSession";
import { applyPreviewServerEvent, readThreadPreviewState } from "~/previewStateStore";
import { managedBrowserEnvironment } from "~/state/managedBrowser";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";

/** Mount native guests even when a page opens from Settings or another computer. */
export function NativeManagedSessions({ environmentId }: { environmentId: EnvironmentId }) {
  const event = useAtomValue(previewEnvironment.events({ environmentId, input: {} }));
  const overview = useEnvironmentQuery(
    managedBrowserEnvironment.overview({ environmentId, input: {} }),
  );
  useEffect(() => {
    if (!AsyncResult.isSuccess(event)) return;
    const value = event.value;
    const ref = { environmentId, threadId: ThreadId.make(value.threadId) };
    const native =
      "snapshot" in value
        ? value.snapshot.managed?.native
        : readThreadPreviewState(ref).sessions[value.tabId]?.managed?.native;
    if (native) applyPreviewServerEvent(ref, value);
  }, [environmentId, event]);
  return [...new Set(overview.data?.tabs.map((tab) => tab.hostThreadId) ?? [])].map((threadId) => (
    <RestoreNativeSession key={threadId} environmentId={environmentId} threadId={threadId} />
  ));
}

function RestoreNativeSession({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  usePreviewSession({ environmentId, threadId: ThreadId.make(threadId) });
  return null;
}
