import { describeTabControl } from "@t3tools/client-runtime/managed-browser";
import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type PreviewManagedSession,
} from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { managedBrowserEnvironment } from "~/state/managedBrowser";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

export function ManagedNativeControl({
  environmentId,
  managed,
}: {
  environmentId: EnvironmentId;
  managed: PreviewManagedSession;
}) {
  const query = useEnvironmentQuery(
    managedBrowserEnvironment.overview({ environmentId, input: {} }),
  );
  const canOperate = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const setControl = useAtomCommand(managedBrowserEnvironment.setControl);
  const tab = query.data?.tabs.find(
    (tab) => tab.instanceId === managed.instanceId && tab.engineTabId === managed.engineTabId,
  );
  const control = tab ? describeTabControl(tab, canOperate) : null;
  const action = control?.action;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs" role="status">
      <span>{control?.label ?? query.error ?? "Connecting to shared browser control…"}</span>
      {action === "take" || action === "release" ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void setControl({
              environmentId,
              input: { hostThreadId: managed.hostThreadId, hostTabId: managed.hostTabId, action },
            })
          }
        >
          {control?.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
