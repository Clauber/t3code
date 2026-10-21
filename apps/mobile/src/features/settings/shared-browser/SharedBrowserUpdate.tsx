import {
  UPDATE_ACTIONS,
  describeActivation,
  describeUpdate,
} from "@t3tools/client-runtime/managed-browser";
import {
  AuthEnvironmentMaintainScope,
  type EnvironmentId,
  type ManagedBrowserUpdateAction,
} from "@t3tools/contracts";
import { useState } from "react";
import { Alert, View } from "react-native";

import { MaterialButton } from "../../../components/MaterialButton";
import { managedBrowserEnvironment } from "../../../state/managedBrowser";
import { useEnvironmentQuery } from "../../../state/query";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "../components/SettingsSection";
import { SharedBrowserNote, reportCommandFailure } from "./fields";

/** The browser component's update status and the few things a person can do about it. */
export function SharedBrowserUpdate({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const status = useEnvironmentQuery(
    managedBrowserEnvironment.updateStatus({ environmentId, input: {} }),
  );
  const run = useAtomCommand(managedBrowserEnvironment.update, { reportFailure: false });
  const [busy, setBusy] = useState<ManagedBrowserUpdateAction | null>(null);
  if (status.data === null) {
    return (
      <SettingsSection title="Updates">
        <SharedBrowserNote>{status.error ?? "Loading..."}</SharedBrowserNote>
      </SettingsSection>
    );
  }
  const view = describeUpdate(status.data);
  const act = async (action: ManagedBrowserUpdateAction) => {
    setBusy(action);
    try {
      const result = await run({ environmentId, input: { action } });
      if (result._tag === "Failure") {
        reportCommandFailure("The update did not go through", result);
      } else if (result.value.activation !== null) {
        Alert.alert("Shared browser", describeActivation(result.value.activation));
      }
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection title="Updates">
      <SharedBrowserNote>{[view.headline, ...view.lines].join("\n")}</SharedBrowserNote>
      <View className="flex-row flex-wrap gap-3 px-4 pb-3">
        {UPDATE_ACTIONS.filter((entry) => view.actions[entry.enabled]).map((entry) => (
          <MaterialButton
            key={entry.action}
            label={entry.label}
            loading={busy === entry.action}
            disabled={!canMaintain || busy !== null}
            onPress={() => void act(entry.action)}
          />
        ))}
      </View>
      {canMaintain ? null : (
        <SharedBrowserNote>This connection can see updates but not change them.</SharedBrowserNote>
      )}
    </SettingsSection>
  );
}
