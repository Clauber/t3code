import { useAtomValue } from "@effect/atom-react";
import {
  GRANT_ACCESS_TEXT,
  describeGrantHolder,
  resolveProfileSelection,
} from "@t3tools/client-runtime/managed-browser";
import {
  ACCESS_CODE_TTL_OPTIONS,
  agentGrantInput,
  encodeAccessCode,
  viewerGrantInput,
  type AccessTtl,
} from "@t3tools/client-runtime/managed-browser/pairing";
import { selectedManagedProfileAtom } from "@t3tools/client-runtime/state/managed-browser";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  EnvironmentId,
  type ManagedBrowserAccess,
  type ManagedBrowserOverview,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { CopyTextButton } from "../../../components/CopyTextButton";
import { MaterialButton } from "../../../components/MaterialButton";
import { authEnvironment } from "../../../state/auth";
import { useEnvironments } from "../../../state/environments";
import { managedBrowserEnvironment } from "../../../state/managedBrowser";
import { useEnvironmentQuery } from "../../../state/query";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsChoiceRow } from "../components/SettingsChoiceRow";
import { SettingsSection } from "../components/SettingsSection";
import { SharedBrowserField, SharedBrowserNote, reportCommandFailure } from "./fields";

/** Who may use the browser on the computer that runs it: people and devices, and agents running somewhere else. */
export function SharedBrowserAccess(props: {
  readonly environmentId: EnvironmentId;
  readonly overview: ManagedBrowserOverview;
}) {
  const { environmentId, overview } = props;
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const grants = useEnvironmentQuery(
    canRead ? managedBrowserEnvironment.grants({ environmentId, input: {} }) : null,
  );
  const revoke = useAtomCommand(managedBrowserEnvironment.revokeGrant, { reportFailure: false });
  const { environments } = useEnvironments();
  const stored = useAtomValue(selectedManagedProfileAtom);
  const profile = resolveProfileSelection(stored, overview);
  const [adding, setAdding] = useState(false);
  // The code is a secret that exists once: it lives in this component's state only, never in storage or a log.
  const [code, setCode] = useState<string | null>(null);

  if (!canRead) {
    return (
      <SettingsSection title="Access">
        <SharedBrowserNote>
          This connection can't see who may use the browser. Sign in with an administrator
          connection to manage it.
        </SharedBrowserNote>
      </SettingsSection>
    );
  }
  const live = (grants.data?.grants ?? []).filter((grant) => grant.revokedAt === null);
  return (
    <SettingsSection title="Access">
      {live.map((grant, index) => (
        <View
          key={grant.id}
          className={index > 0 ? "gap-2 border-t border-border-subtle p-4" : "gap-2 p-4"}
        >
          <Text className="text-base text-foreground">
            {describeGrantHolder(grant, environments)}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {GRANT_ACCESS_TEXT[grant.access]} ·{" "}
            {grant.resources.map((entry) => entry.profileId).join(", ")} · until{" "}
            {new Date(grant.expiresAt).toLocaleString()}
          </Text>
          <MaterialButton
            label="Remove"
            tone="danger"
            disabled={!canWrite}
            onPress={() =>
              void revoke({ environmentId, input: { id: grant.id } }).then((result) => {
                if (result._tag === "Failure")
                  reportCommandFailure("Could not remove access", result);
              })
            }
          />
        </View>
      ))}
      {grants.data !== null && live.length === 0 ? (
        <SharedBrowserNote>
          Nobody else has access. Administrators of this computer can always watch.
        </SharedBrowserNote>
      ) : null}
      {code !== null ? (
        <View className="gap-2 border-t border-border-subtle p-4">
          <Text className="text-base text-foreground">Access code</Text>
          <Text className="text-sm text-foreground-muted">
            Enter this on the other computer. It is shown only now, so copy it before closing.
            Anyone who has it can use this browser until it expires or you remove it.
          </Text>
          <Text selectable className="font-mono text-sm text-foreground">
            {code}
          </Text>
          <View className="flex-row items-center gap-3">
            <CopyTextButton accessibilityLabel="Copy access code" text={code} buttonSize={36} />
            <MaterialButton label="Done" tone="primary" onPress={() => setCode(null)} />
          </View>
        </View>
      ) : adding && profile !== null ? (
        <AddAccess
          environmentId={environmentId}
          ownerEnvironmentId={overview.ownerEnvironmentId}
          instanceId={profile.instanceId}
          profileId={profile.profileId}
          onClose={() => setAdding(false)}
          onCode={(next) => {
            setAdding(false);
            setCode(next);
          }}
        />
      ) : (
        <View className="border-t border-border-subtle px-4 py-3">
          <MaterialButton
            label="Add access"
            disabled={!canWrite || profile === null}
            onPress={() => setAdding(true)}
          />
        </View>
      )}
    </SettingsSection>
  );
}

function AddAccess(props: {
  readonly environmentId: EnvironmentId;
  readonly ownerEnvironmentId: EnvironmentId;
  readonly instanceId: string;
  readonly profileId: string;
  readonly onClose: () => void;
  readonly onCode: (code: string) => void;
}) {
  const create = useAtomCommand(managedBrowserEnvironment.createGrant, { reportFailure: false });
  const accessChanges = useEnvironmentQuery(
    authEnvironment.accessChanges({ environmentId: props.environmentId, input: null }),
  );
  const clientSessions =
    accessChanges.data?.type === "snapshot" ? accessChanges.data.payload.clientSessions : [];
  const { environments } = useEnvironments();
  const [kind, setKind] = useState<"viewer" | "agent">("viewer");
  const [sessionId, setSessionId] = useState("");
  const [callerId, setCallerId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [agentSessionId, setAgentSessionId] = useState("");
  const [access, setAccess] = useState<ManagedBrowserAccess>("read");
  const [ttl, setTtl] = useState<AccessTtl>("1d");
  const [busy, setBusy] = useState(false);
  const resource = { instanceId: props.instanceId, profileId: props.profileId };
  const input =
    kind === "viewer"
      ? sessionId
        ? viewerGrantInput({ sessionId, access, ttl, resource })
        : null
      : callerId
        ? agentGrantInput({
            callerEnvironmentId: EnvironmentId.make(callerId),
            threadId,
            agentSessionId,
            access,
            ttl,
            resource,
          })
        : null;
  const others = environments.filter((entry) => entry.environmentId !== props.ownerEnvironmentId);
  const submit = async () => {
    if (!input || busy) return;
    setBusy(true);
    try {
      const result = await create({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") {
        reportCommandFailure("Could not add access", result);
        return;
      }
      const { grant, credential } = result.value;
      if (kind === "agent" && credential !== undefined && grant.subject.kind === "agent") {
        props.onCode(
          encodeAccessCode({
            ownerEnvironmentId: props.ownerEnvironmentId,
            instanceId: props.instanceId,
            profileId: props.profileId,
            threadId: grant.subject.threadId,
            agentSessionId: grant.subject.agentSessionId,
            expiresAt: grant.expiresAt,
            credential,
          }),
        );
      } else {
        props.onClose();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="border-t border-border-subtle">
      <SharedBrowserNote>
        {kind === "viewer"
          ? `Let a signed-in person or device watch ${props.profileId}, or watch and control it.`
          : `Let one chat's agent on another computer use ${props.profileId}. You get a code to enter on that computer.`}
      </SharedBrowserNote>
      <SettingsChoiceRow
        label="A person or device"
        description="Watches this browser from a signed-in client."
        selected={kind === "viewer"}
        separated={false}
        disabled={false}
        onPress={() => setKind("viewer")}
      />
      <SettingsChoiceRow
        label="An agent on another computer"
        description="Uses this browser from a chat there."
        selected={kind === "agent"}
        separated
        disabled={false}
        onPress={() => setKind("agent")}
      />
      {kind === "viewer" ? (
        clientSessions.map((entry) => (
          <SettingsChoiceRow
            key={entry.sessionId}
            label={`${entry.client.label ?? entry.subject}${entry.current ? " (this one)" : ""}`}
            description="Device"
            selected={sessionId === entry.sessionId}
            separated
            disabled={false}
            onPress={() => setSessionId(entry.sessionId)}
          />
        ))
      ) : (
        <>
          {others.map((entry) => (
            <SettingsChoiceRow
              key={entry.environmentId}
              label={entry.label}
              description="Computer the agent runs on"
              selected={callerId === entry.environmentId}
              separated
              disabled={false}
              onPress={() => setCallerId(entry.environmentId)}
            />
          ))}
          <SharedBrowserField
            label="Chat id (from that computer)"
            value={threadId}
            onChangeText={setThreadId}
          />
          <SharedBrowserField
            label="Agent session id (from that computer)"
            value={agentSessionId}
            onChangeText={setAgentSessionId}
          />
        </>
      )}
      {(["read", "operate"] as const).map((level) => (
        <SettingsChoiceRow
          key={level}
          label={GRANT_ACCESS_TEXT[level]}
          description="What they can do"
          selected={access === level}
          separated
          disabled={false}
          onPress={() => setAccess(level)}
        />
      ))}
      {ACCESS_CODE_TTL_OPTIONS.map((option) => (
        <SettingsChoiceRow
          key={option.value}
          label={option.label}
          description="How long"
          selected={ttl === option.value}
          separated
          disabled={false}
          onPress={() => setTtl(option.value)}
        />
      ))}
      <View className="flex-row gap-3 px-4 py-3">
        <MaterialButton
          label="Add access"
          tone="primary"
          loading={busy}
          disabled={input === null}
          onPress={() => void submit()}
        />
        <MaterialButton label="Cancel" tone="text" disabled={busy} onPress={props.onClose} />
      </View>
    </View>
  );
}
