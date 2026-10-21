import {
  UPDATE_ACTIONS,
  describeActivation,
  describeUpdate,
} from "@t3tools/client-runtime/managed-browser";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type EnvironmentId,
  type ManagedBrowserUpdateAction,
} from "@t3tools/contracts";
import { useState } from "react";

import { managedBrowserEnvironment } from "~/state/managedBrowser";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

/** The browser component's update status and the few things a person can do about it. */
export function ManagedBrowserUpdateSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const status = useEnvironmentQuery(
    managedBrowserEnvironment.updateStatus({ environmentId, input: {} }),
  );
  const run = useAtomCommand(managedBrowserEnvironment.update, { reportFailure: false });
  const [busy, setBusy] = useState<ManagedBrowserUpdateAction | null>(null);
  if (status.data === null) {
    return <SettingsRow title="Updates" description={status.error ?? "Loading..."} />;
  }
  const view = describeUpdate(status.data);
  const act = async (action: ManagedBrowserUpdateAction) => {
    setBusy(action);
    try {
      const result = await run({ environmentId, input: { action } });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "The update did not go through",
          description: String(
            (squashAtomCommandFailure(result) as { message?: string }).message ?? "",
          ),
        });
      } else if (result.value.activation !== null) {
        toastManager.add({ type: "info", title: describeActivation(result.value.activation) });
      }
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsRow title="Updates" description={view.headline}>
      <div className="flex flex-col gap-2 pt-3">
        {view.lines.map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          {UPDATE_ACTIONS.filter((entry) => view.actions[entry.enabled]).map((entry) => (
            <Button
              key={entry.action}
              size="sm"
              variant="outline"
              disabled={!canMaintain || busy !== null}
              onClick={() => void act(entry.action)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        {canMaintain ? null : (
          <p className="text-xs text-muted-foreground">
            This connection can see updates but not change them.
          </p>
        )}
      </div>
    </SettingsRow>
  );
}
