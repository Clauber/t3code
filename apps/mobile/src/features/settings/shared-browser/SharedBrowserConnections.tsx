import {
  decodeAccessCode,
  enrollmentFromAccessCode,
} from "@t3tools/client-runtime/managed-browser/pairing";
import { AuthAccessReadScope, AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { MaterialButton } from "../../../components/MaterialButton";
import { useEnvironments } from "../../../state/environments";
import { managedBrowserEnvironment } from "../../../state/managedBrowser";
import { useEnvironmentQuery } from "../../../state/query";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "../components/SettingsSection";
import { SharedBrowserField, SharedBrowserNote, reportCommandFailure } from "./fields";

/** Browsers on other computers that this computer's agents may use, added with an access code from that computer. */
export function SharedBrowserConnections(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { environmentId } = props;
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const enrollments = useEnvironmentQuery(
    canRead ? managedBrowserEnvironment.enrollments({ environmentId, input: {} }) : null,
  );
  const remove = useAtomCommand(managedBrowserEnvironment.removeEnrollment, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const [adding, setAdding] = useState(false);
  return (
    <SettingsSection title={`Browsers on other computers · ${props.label}`}>
      <SharedBrowserNote>
        {`Agents on ${props.label} can open pages in a browser that another computer runs, once you add the access code that computer gave you.`}
      </SharedBrowserNote>
      {(enrollments.data?.enrollments ?? []).map((entry) => (
        <View key={entry.id} className="gap-2 border-t border-border-subtle p-4">
          <Text className="text-base text-foreground">
            {environments.find((env) => env.environmentId === entry.ownerEnvironmentId)?.label ??
              entry.endpoint}
            {" · "}
            {entry.profileId}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {entry.endpoint} · until {new Date(entry.expiresAt).toLocaleString()}
          </Text>
          <MaterialButton
            label="Remove"
            tone="danger"
            disabled={!canWrite}
            onPress={() =>
              void remove({ environmentId, input: { id: entry.id } }).then((result) => {
                if (result._tag === "Failure") reportCommandFailure("Could not remove it", result);
              })
            }
          />
        </View>
      ))}
      {enrollments.data !== null && enrollments.data.enrollments.length === 0 ? (
        <SharedBrowserNote>No other computer's browser is set up here.</SharedBrowserNote>
      ) : null}
      {adding ? (
        <AddAccessCode environmentId={environmentId} onClose={() => setAdding(false)} />
      ) : (
        <View className="border-t border-border-subtle px-4 py-3">
          <MaterialButton
            label="Add access code"
            disabled={!canWrite}
            onPress={() => setAdding(true)}
          />
        </View>
      )}
    </SettingsSection>
  );
}

function AddAccessCode(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const enroll = useAtomCommand(managedBrowserEnvironment.enroll, { reportFailure: false });
  const { environments } = useEnvironments();
  // The code is a secret: it lives in this component's state only and is cleared on close.
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const decoded = decodeAccessCode(code);
  const known = environments.find((entry) => entry.environmentId === decoded?.ownerEnvironmentId);
  const suggested = known?.displayUrl ?? "";
  const parsed = code.trim() ? enrollmentFromAccessCode(code, address || suggested) : null;
  const close = () => {
    setCode("");
    props.onClose();
  };
  const submit = async () => {
    if (parsed === null || !parsed.ok || busy) return;
    setBusy(true);
    try {
      const result = await enroll({ environmentId: props.environmentId, input: parsed.input });
      if (result._tag === "Failure") {
        reportCommandFailure("Could not add the code", result);
        return;
      }
      close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="border-t border-border-subtle">
      <SharedBrowserNote>
        Paste the code the other computer showed you. It is a password: it is sent to this computer
        only, kept in its protected storage, and never shown again.
      </SharedBrowserNote>
      <SharedBrowserField label="Access code" value={code} onChangeText={setCode} secret />
      {code.trim() && decoded === null ? (
        <SharedBrowserNote>That is not an access code.</SharedBrowserNote>
      ) : null}
      <SharedBrowserField
        label="Address of the other computer"
        value={address}
        onChangeText={setAddress}
        placeholder={suggested || "https://other-computer.example.com"}
      />
      {parsed && !parsed.ok && parsed.reason === "address" ? (
        <SharedBrowserNote>
          Enter the address only, like https://other-computer.example.com, with nothing after it.
        </SharedBrowserNote>
      ) : null}
      <View className="flex-row gap-3 px-4 py-3">
        <MaterialButton
          label="Add"
          tone="primary"
          loading={busy}
          disabled={parsed === null || !parsed.ok}
          onPress={() => void submit()}
        />
        <MaterialButton label="Cancel" tone="text" disabled={busy} onPress={close} />
      </View>
    </View>
  );
}
