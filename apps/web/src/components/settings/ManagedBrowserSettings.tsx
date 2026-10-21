import { RegistryContext } from "@effect/atom-react";
import {
  canUseOnThisComputer,
  describeHosting,
  describeTabControl,
  newProfileBinding,
  resolveOwner,
  resolveProfileSelection,
  type ManagedProfileSelection,
} from "@t3tools/client-runtime/managed-browser";
import { selectedManagedProfileAtom } from "@t3tools/client-runtime/state/managed-browser";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  EnvironmentId,
  ThreadId,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  type ManagedBrowserOverview,
  type ManagedBrowserTabSummary,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CopyIcon, EyeIcon, PlusIcon } from "lucide-react";
import { useContext, useState } from "react";

import { PreviewView } from "~/components/preview/PreviewView";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { managedBrowserEnvironment } from "~/state/managedBrowser";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogPanel, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ManagedBrowserAccessSettings } from "./ManagedBrowserAccessSettings";
import { ManagedBrowserUpdateSettings } from "./ManagedBrowserUpdateSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The shared browser a person manages: where it runs, which profile, what is open, who may use it, and how it updates. */
export function ManagedBrowserSettings() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const hosts = environments.filter((environment) => environment.connection.phase === "connected");
  const selection = useAtomValue(selectedManagedProfileAtom);
  const { owner, message } = resolveOwner(environments, selection?.ownerEnvironmentId ?? null);
  const chosen = environments.find((host) => host.environmentId === selection?.ownerEnvironmentId);

  return (
    <SettingsSection id="shared-browser" title="Shared browser">
      <SettingsRow
        title="Runs on"
        description="The computer that keeps this browser's saved logins. Chats on other computers use it through that computer."
        control={
          <Select
            value={(owner ?? chosen)?.environmentId ?? ""}
            onValueChange={(value) =>
              value !== null &&
              registry.set(selectedManagedProfileAtom, {
                ownerEnvironmentId: EnvironmentId.make(value),
                instanceId: "",
                profileId: "",
              })
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label="Computer that runs the browser"
            >
              <SelectValue>{(owner ?? chosen)?.label ?? "No computer connected"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {hosts.map((host) => (
                <SelectItem hideIndicator key={host.environmentId} value={host.environmentId}>
                  {host.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {owner === null ? (
        <SettingsRow title="Not connected" description={message} />
      ) : (
        <ManagedBrowserOwner key={owner.environmentId} environmentId={owner.environmentId} />
      )}
    </SettingsSection>
  );
}

function ManagedBrowserOwner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const overviewQuery = useEnvironmentQuery(
    managedBrowserEnvironment.overview({ environmentId, input: {} }),
  );
  const overview = overviewQuery.data;
  if (overview === null) {
    return <SettingsRow title="Shared browser" description={overviewQuery.error ?? "Loading..."} />;
  }
  const unavailable = describeHosting(overview.hosting);
  return (
    <>
      {unavailable ? <SettingsRow title="Not available here" description={unavailable} /> : null}
      {overview.hosting.available ? (
        <ProfileAndTabs environmentId={environmentId} overview={overview} />
      ) : null}
      <ManagedBrowserAccessSettings environmentId={environmentId} overview={overview} />
      <ManagedBrowserUpdateSettings environmentId={environmentId} />
    </>
  );
}

function ProfileAndTabs({
  environmentId,
  overview,
}: {
  readonly environmentId: EnvironmentId;
  readonly overview: ManagedBrowserOverview;
}) {
  const registry = useContext(RegistryContext);
  const stored = useAtomValue(selectedManagedProfileAtom);
  const selection = resolveProfileSelection(stored, overview);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The browser's own window is only for the app that started this very server, never for a page or phone watching it.
  const onThisComputer = canUseOnThisComputer({
    overview,
    isDesktopApp: typeof window !== "undefined" && window.desktopBridge !== undefined,
    isOwnLocalServer: environmentId === primaryEnvironmentId && !isLocalEnvironmentDisabled(),
  });
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const choose = (next: ManagedProfileSelection) => registry.set(selectedManagedProfileAtom, next);
  const profile =
    selection === null
      ? null
      : { instanceId: selection.instanceId, profileId: selection.profileId };
  const binding = newProfileBinding(newName);
  const tabs = overview.tabs.filter(
    (tab) =>
      profile !== null &&
      tab.instanceId === profile.instanceId &&
      tab.profileId === profile.profileId,
  );
  const profiles = overview.profiles;

  return (
    <>
      <SettingsRow
        title="Profile"
        description="A profile keeps its own logins and cookies. Each one is used by a single browser at a time."
        control={
          <Select
            value={profile?.profileId ?? ""}
            onValueChange={(value) => {
              const found = profiles.find((entry) => entry.profileId === value);
              if (found) {
                choose({
                  ownerEnvironmentId: environmentId,
                  instanceId: found.instanceId,
                  profileId: found.profileId,
                });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Browser profile">
              <SelectValue>{profile?.profileId ?? "No profile yet"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {profiles.map((entry) => (
                <SelectItem hideIndicator key={entry.profileId} value={entry.profileId}>
                  {entry.profileId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <NewPage
        environmentId={environmentId}
        profile={profile}
        newName={newName}
        onNewName={setNewName}
        binding={binding}
        onThisComputer={onThisComputer}
        creating={creating}
        onCreating={setCreating}
        onCreated={(next) => choose({ ownerEnvironmentId: environmentId, ...next })}
      />
      {tabs.length === 0 ? (
        <SettingsRow
          title="Open tabs"
          description={
            profile === null
              ? "Add a profile to open a page."
              : "Nothing is open in this profile. Open a page here, or let an agent open one."
          }
        />
      ) : (
        tabs.map((tab) => (
          <TabRow
            key={`${tab.instanceId}:${tab.engineTabId}`}
            environmentId={environmentId}
            tab={tab}
          />
        ))
      )}
    </>
  );
}

function NewPage(props: {
  readonly environmentId: EnvironmentId;
  readonly profile: { readonly instanceId: string; readonly profileId: string } | null;
  readonly newName: string;
  readonly onNewName: (name: string) => void;
  readonly binding: ReturnType<typeof newProfileBinding>;
  /** Offer the browser's own window on this computer, with control taken for the person. */
  readonly onThisComputer: boolean;
  readonly creating: boolean;
  readonly onCreating: (creating: boolean) => void;
  readonly onCreated: (profile: { instanceId: string; profileId: string }) => void;
}) {
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const open = useAtomCommand(managedBrowserEnvironment.openTab, { reportFailure: false });
  const [url, setUrl] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = props.creating ? props.binding : props.profile;
  const submit = async (native: boolean) => {
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
        toastManager.add({
          type: "error",
          title: "Could not open the page",
          description: String(
            (squashAtomCommandFailure(result) as { message?: string }).message ?? "",
          ),
        });
        return;
      }
      if (native) {
        toastManager.add({
          type: "success",
          title: "Opened on this Mac",
          description:
            "The page is inside T3. Agents can use it; stop them from its control bar.",
        });
      }
      props.onCreated({ instanceId: target.instanceId, profileId: target.profileId });
      props.onCreating(false);
      props.onNewName("");
      setUrl("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      title={props.creating ? "Open a page in a new profile" : "Open a page"}
      description={
        props.creating
          ? "Give the profile a name; it is created when the page opens."
          : "Opens in the profile above. localhost means the computer that runs the browser."
      }
    >
      <form
        className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        {props.creating ? (
          <Input
            size="sm"
            aria-label="New profile name"
            placeholder="Profile name"
            value={props.newName}
            onChange={(event) => props.onNewName(event.target.value)}
          />
        ) : null}
        <Input
          size="sm"
          aria-label="Address to open"
          placeholder="https://example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={shared}
            onCheckedChange={setShared}
            aria-label="Let other chats join this tab"
          />
          Share
        </label>
        <Button size="sm" type="submit" disabled={!canOpen || !target || busy}>
          Open
        </Button>
        {props.onThisComputer ? (
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={!canOpen || !target || busy}
            title="Opens the page as a normal Chrome window on this Mac and gives you control of it"
            onClick={() => void submit(true)}
          >
            Open on this Mac
          </Button>
        ) : null}
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => props.onCreating(!props.creating)}
        >
          <PlusIcon className="size-3.5" />
          {props.creating ? "Use an existing profile" : "New profile"}
        </Button>
      </form>
    </SettingsRow>
  );
}

function TabRow({
  environmentId,
  tab,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: ManagedBrowserTabSummary;
}) {
  const canOperate = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const setShared = useAtomCommand(managedBrowserEnvironment.setShared, { reportFailure: false });
  const setControl = useAtomCommand(managedBrowserEnvironment.setControl, { reportFailure: false });
  const [watching, setWatching] = useState(false);
  const control = describeTabControl(tab, canOperate);
  const { action } = control;
  const changeControl = async (action: "take" | "release") => {
    const result = await setControl({
      environmentId,
      input: { hostThreadId: tab.hostThreadId, hostTabId: tab.hostTabId, action },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: action === "take" ? "Could not take control" : "Could not release control",
        description: String(
          (squashAtomCommandFailure(result) as { message?: string }).message ?? "",
        ),
      });
    }
  };
  return (
    <SettingsRow
      title={tab.title || tab.url || "New tab"}
      description={
        <>
          {tab.url ?? "Blank page"} · {control.label}
          {tab.participants > 1 ? ` · ${tab.participants} chats` : ""}
          {control.detail === undefined ? null : (
            <span className="mt-1 block text-xs text-muted-foreground">{control.detail}</span>
          )}
        </>
      }
      control={
        <div className="flex items-center gap-3">
          {action === "take" || action === "release" ? (
            <Button
              size="sm"
              variant={action === "release" ? "default" : "outline"}
              onClick={() => void changeControl(action)}
            >
              {control.actionLabel}
            </Button>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={tab.shared}
              disabled={!canOperate}
              aria-label="Let other chats join this tab"
              onCheckedChange={(shared) =>
                void setShared({
                  environmentId,
                  input: { hostThreadId: tab.hostThreadId, hostTabId: tab.hostTabId, shared },
                })
              }
            />
            Shared
          </label>
          <Button size="sm" variant="outline" onClick={() => setWatching(true)}>
            <EyeIcon className="size-3.5" /> Watch
          </Button>
          {tab.shared ? (
            <Button
              size="sm"
              variant="ghost"
              title="Copy this tab's id so an agent in another chat can join it"
              onClick={() =>
                void navigator.clipboard
                  .writeText(tab.engineTabId)
                  .then(() => toastManager.add({ type: "info", title: "Tab id copied" }))
              }
            >
              <CopyIcon className="size-3.5" /> Copy id
            </Button>
          ) : null}
        </div>
      }
    >
      {watching ? (
        <Dialog open onOpenChange={(open) => !open && setWatching(false)}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{tab.title || tab.url || "Shared browser"}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="flex h-[28rem] flex-col">
                <PreviewView threadRef={{ environmentId, threadId: ThreadId.make(tab.hostThreadId) }} tabId={tab.hostTabId} visible surfaceZIndex={60} />
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsRow>
  );
}
