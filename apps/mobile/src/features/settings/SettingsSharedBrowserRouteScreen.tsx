import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  TAB_PHASE_TEXT,
  describeHosting,
  newProfileBinding,
  resolveOwner,
  resolveProfileSelection,
} from "@t3tools/client-runtime/managed-browser";
import { selectedManagedProfileAtom } from "@t3tools/client-runtime/state/managed-browser";
import {
  AuthPreviewOperateScope,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  type EnvironmentId,
  type ManagedBrowserOverview,
  type ManagedBrowserTabSummary,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { managedBrowserEnvironment } from "../../state/managedBrowser";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  SharedBrowserField,
  SharedBrowserNote,
  reportCommandFailure,
} from "./shared-browser/fields";
import { SharedBrowserAccess } from "./shared-browser/SharedBrowserAccess";
import { SharedBrowserConnections } from "./shared-browser/SharedBrowserConnections";
import { SharedBrowserUpdate } from "./shared-browser/SharedBrowserUpdate";

/** The shared browser a person manages from a phone: which computer runs it, its profile and tabs, who may use it, and how it updates. */
export function SettingsSharedBrowserRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const selection = useAtomValue(selectedManagedProfileAtom);
  const choose = useAtomSet(selectedManagedProfileAtom);
  const { owner, message } = resolveOwner(environments, selection?.ownerEnvironmentId ?? null);
  const connected = environments.filter((entry) => entry.connection.phase === "connected");

  return (
    <SettingsScreen title="Shared browser">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Runs on">
          {environments.length === 0 ? (
            <SharedBrowserNote>
              No computer is set up yet. Add one under Environments.
            </SharedBrowserNote>
          ) : (
            environments.map((entry, index) => (
              <SettingsChoiceRow
                key={entry.environmentId}
                label={entry.label}
                description={entry.connection.phase === "connected" ? "Connected" : "Not connected"}
                selected={(owner ?? null)?.environmentId === entry.environmentId}
                separated={index > 0}
                disabled={entry.connection.phase !== "connected"}
                onPress={() =>
                  choose({
                    ownerEnvironmentId: entry.environmentId,
                    instanceId: "",
                    profileId: "",
                  })
                }
              />
            ))
          )}
        </SettingsSection>
        {owner === null ? (
          <SettingsSection>
            <SharedBrowserNote>{message ?? ""}</SharedBrowserNote>
          </SettingsSection>
        ) : (
          <SharedBrowserOwner key={owner.environmentId} environmentId={owner.environmentId} />
        )}
        {connected.map((entry) => (
          <SharedBrowserConnections
            key={entry.environmentId}
            environmentId={entry.environmentId}
            label={entry.label}
          />
        ))}
      </ScrollView>
    </SettingsScreen>
  );
}

function SharedBrowserOwner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const overviewQuery = useEnvironmentQuery(
    managedBrowserEnvironment.overview({ environmentId, input: {} }),
  );
  const overview = overviewQuery.data;
  if (overview === null) {
    return (
      <SettingsSection>
        <SharedBrowserNote>{overviewQuery.error ?? "Loading..."}</SharedBrowserNote>
      </SettingsSection>
    );
  }
  const unavailable = describeHosting(overview.hosting);
  return (
    <>
      {unavailable ? (
        <SettingsSection title="Not available here">
          <SharedBrowserNote>{unavailable}</SharedBrowserNote>
        </SettingsSection>
      ) : (
        <ProfileAndTabs environmentId={environmentId} overview={overview} />
      )}
      <SharedBrowserAccess environmentId={environmentId} overview={overview} />
      <SharedBrowserUpdate environmentId={environmentId} />
    </>
  );
}

function ProfileAndTabs(props: {
  readonly environmentId: EnvironmentId;
  readonly overview: ManagedBrowserOverview;
}) {
  const stored = useAtomValue(selectedManagedProfileAtom);
  const choose = useAtomSet(selectedManagedProfileAtom);
  const selection = resolveProfileSelection(stored, props.overview);
  const profile =
    selection === null
      ? null
      : { instanceId: selection.instanceId, profileId: selection.profileId };
  const tabs = props.overview.tabs.filter(
    (tab) =>
      profile !== null &&
      tab.instanceId === profile.instanceId &&
      tab.profileId === profile.profileId,
  );
  return (
    <>
      <SettingsSection title="Profile">
        {props.overview.profiles.length === 0 ? (
          <SharedBrowserNote>
            No profile yet. Open a page in a new profile to create one.
          </SharedBrowserNote>
        ) : (
          props.overview.profiles.map((entry, index) => (
            <SettingsChoiceRow
              key={entry.profileId}
              label={entry.profileId}
              description={`${entry.tabs} open tab${entry.tabs === 1 ? "" : "s"}. Keeps its own logins and cookies.`}
              selected={profile?.profileId === entry.profileId}
              separated={index > 0}
              disabled={false}
              onPress={() =>
                choose({
                  ownerEnvironmentId: props.environmentId,
                  instanceId: entry.instanceId,
                  profileId: entry.profileId,
                })
              }
            />
          ))
        )}
      </SettingsSection>
      <NewPage
        environmentId={props.environmentId}
        profile={profile}
        onOpened={(next) => choose({ ownerEnvironmentId: props.environmentId, ...next })}
      />
      <SettingsSection title="Open tabs">
        {tabs.length === 0 ? (
          <SharedBrowserNote>
            {profile === null
              ? "Add a profile to open a page."
              : "Nothing is open in this profile. Open a page here, or let an agent open one."}
          </SharedBrowserNote>
        ) : (
          tabs.map((tab, index) => (
            <TabRow
              key={`${tab.instanceId}:${tab.engineTabId}`}
              environmentId={props.environmentId}
              tab={tab}
              separated={index > 0}
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

function NewPage(props: {
  readonly environmentId: EnvironmentId;
  readonly profile: { readonly instanceId: string; readonly profileId: string } | null;
  readonly onOpened: (profile: { instanceId: string; profileId: string }) => void;
}) {
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const open = useAtomCommand(managedBrowserEnvironment.openTab, { reportFailure: false });
  const [creating, setCreating] = useState(props.profile === null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = creating ? newProfileBinding(name) : props.profile;
  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      const result = await open({
        environmentId: props.environmentId,
        input: {
          instanceId: ManagedBrowserInstanceId.make(target.instanceId),
          profileId: ManagedBrowserProfileId.make(target.profileId),
          ...(url.trim() ? { url: url.trim() } : {}),
          shared,
        },
      });
      if (result._tag === "Failure") {
        reportCommandFailure("Could not open the page", result);
        return;
      }
      props.onOpened({ instanceId: target.instanceId, profileId: target.profileId });
      setCreating(false);
      setName("");
      setUrl("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title={creating ? "Open a page in a new profile" : "Open a page"}>
      {creating ? (
        <SharedBrowserField label="New profile name" value={name} onChangeText={setName} />
      ) : null}
      <SharedBrowserField
        label="Address"
        value={url}
        onChangeText={setUrl}
        placeholder="https://example.com"
      />
      <SettingsSwitchRow
        icon="person.2"
        label="Let other chats join"
        subtitle="localhost means the computer that runs the browser."
        value={shared}
        onValueChange={setShared}
      />
      <View className="flex-row flex-wrap gap-3 px-4 py-3">
        <MaterialButton
          label="Open"
          tone="primary"
          loading={busy}
          disabled={!canOpen || !target}
          onPress={() => void submit()}
        />
        {props.profile === null ? null : (
          <MaterialButton
            label={creating ? "Use an existing profile" : "New profile"}
            tone="text"
            onPress={() => setCreating(!creating)}
          />
        )}
      </View>
      {canOpen ? null : (
        <SharedBrowserNote>This connection can see pages but not open them.</SharedBrowserNote>
      )}
    </SettingsSection>
  );
}

function TabRow(props: {
  readonly environmentId: EnvironmentId;
  readonly tab: ManagedBrowserTabSummary;
  readonly separated: boolean;
}) {
  const navigation = useNavigation();
  const canOperate = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const setShared = useAtomCommand(managedBrowserEnvironment.setShared, { reportFailure: false });
  const { tab } = props;
  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      <SettingsRow
        icon="globe"
        label={tab.title || tab.url || "New tab"}
        value={`${tab.url ?? "Blank page"} · ${TAB_PHASE_TEXT[tab.phase]}${
          tab.participants > 1 ? ` · ${tab.participants} chats` : ""
        }`}
        onPress={() =>
          navigation.navigate("ThreadBrowserPreview", {
            environmentId: props.environmentId,
            threadId: tab.hostThreadId,
            tabId: tab.hostTabId,
          })
        }
      />
      <SettingsSwitchRow
        icon="person.2"
        label="Shared"
        subtitle="Let other chats join this tab."
        value={tab.shared}
        disabled={!canOperate}
        onValueChange={(shared) =>
          void setShared({
            environmentId: props.environmentId,
            input: { hostThreadId: tab.hostThreadId, hostTabId: tab.hostTabId, shared },
          }).then((result) => {
            if (result._tag === "Failure") reportCommandFailure("Could not change sharing", result);
          })
        }
      />
    </View>
  );
}
