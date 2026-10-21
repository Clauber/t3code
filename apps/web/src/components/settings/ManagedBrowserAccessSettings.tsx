import { useAtomValue } from "@effect/atom-react";
import { GRANT_ACCESS_TEXT, describeGrantHolder } from "@t3tools/client-runtime/managed-browser";
import {
  ACCESS_CODE_TTL_OPTIONS,
  agentGrantInput,
  encodeAccessCode,
  viewerGrantInput,
  type AccessTtl,
} from "@t3tools/client-runtime/managed-browser/pairing";
import { resolveProfileSelection } from "@t3tools/client-runtime/managed-browser";
import { selectedManagedProfileAtom } from "@t3tools/client-runtime/state/managed-browser";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  EnvironmentId,
  type ManagedBrowserAccess,
  type ManagedBrowserGrant,
  type ManagedBrowserOverview,
} from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironments } from "~/state/environments";
import { authEnvironment } from "~/state/auth";
import { managedBrowserEnvironment } from "~/state/managedBrowser";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

/** Who may use the browser on this computer: people and devices, and agents running somewhere else. */
export function ManagedBrowserAccessSettings({
  environmentId,
  overview,
}: {
  readonly environmentId: EnvironmentId;
  readonly overview: ManagedBrowserOverview;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const grants = useEnvironmentQuery(
    canRead ? managedBrowserEnvironment.grants({ environmentId, input: {} }) : null,
  );
  const revoke = useAtomCommand(managedBrowserEnvironment.revokeGrant, { reportFailure: false });
  const { environments } = useEnvironments();
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const stored = useAtomValue(selectedManagedProfileAtom);
  const profile = resolveProfileSelection(stored, overview);

  if (!canRead) {
    return (
      <SettingsRow
        title="Access"
        description="This connection can't see who may use the browser. Sign in with an administrator connection to manage it."
      />
    );
  }
  const who = (grant: ManagedBrowserGrant) => describeGrantHolder(grant, environments);
  return (
    <SettingsRow
      title="Access"
      description="People and devices that may watch or control this browser, and agents on other computers that may use it."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || profile === null}
          onClick={() => setAdding(true)}
        >
          Add access
        </Button>
      }
    >
      <div className="flex flex-col gap-2 pt-3">
        {(grants.data?.grants ?? [])
          .filter((grant) => grant.revokedAt === null)
          .map((grant) => (
            <div key={grant.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate">{who(grant)}</p>
                <p className="text-xs text-muted-foreground">
                  {GRANT_ACCESS_TEXT[grant.access]} ·{" "}
                  {grant.resources.map((entry) => entry.profileId).join(", ")} · until{" "}
                  {new Date(grant.expiresAt).toLocaleString()}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite}
                onClick={() => void revoke({ environmentId, input: { id: grant.id } })}
              >
                Remove
              </Button>
            </div>
          ))}
        {grants.data !== null && grants.data.grants.every((grant) => grant.revokedAt !== null) ? (
          <p className="text-xs text-muted-foreground">
            Nobody else has access. Administrators of this computer can always watch.
          </p>
        ) : null}
      </div>
      {adding && profile !== null ? (
        <AddAccess
          environmentId={environmentId}
          instanceId={profile.instanceId}
          profileId={profile.profileId}
          ownerEnvironmentId={overview.ownerEnvironmentId}
          onClose={() => setAdding(false)}
          onCode={(next) => {
            setAdding(false);
            setCode(next);
          }}
        />
      ) : null}
      {code === null ? null : <ShowCode code={code} onClose={() => setCode(null)} />}
    </SettingsRow>
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
        toastManager.add({
          type: "error",
          title: "Could not add access",
          description: String(
            (squashAtomCommandFailure(result) as { message?: string }).message ?? "",
          ),
        });
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
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add access to {props.profileId}</DialogTitle>
          <DialogDescription>
            {kind === "viewer"
              ? "Let a signed-in person or device watch this browser, or watch and control it."
              : "Let one chat's agent on another computer use this browser. You get a code to enter on that computer."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Select value={kind} onValueChange={(value) => setKind(value as "viewer" | "agent")}>
              <SelectTrigger size="sm" aria-label="Who to add">
                <SelectValue>
                  {kind === "viewer" ? "A person or device" : "An agent on another computer"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem hideIndicator value="viewer">
                  A person or device
                </SelectItem>
                <SelectItem hideIndicator value="agent">
                  An agent on another computer
                </SelectItem>
              </SelectPopup>
            </Select>
            {kind === "viewer" ? (
              <Select value={sessionId} onValueChange={(value) => setSessionId(value ?? "")}>
                <SelectTrigger size="sm" aria-label="Device">
                  <SelectValue>
                    {clientSessions.find((entry) => entry.sessionId === sessionId)?.client.label ??
                      "Choose a device"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {clientSessions.map((entry) => (
                    <SelectItem hideIndicator key={entry.sessionId} value={entry.sessionId}>
                      {entry.client.label ?? entry.subject}
                      {entry.current ? " (this one)" : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <>
                <Select value={callerId} onValueChange={(value) => setCallerId(value ?? "")}>
                  <SelectTrigger size="sm" aria-label="Computer the agent runs on">
                    <SelectValue>
                      {others.find((entry) => entry.environmentId === callerId)?.label ??
                        "Choose a computer"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {others.map((entry) => (
                      <SelectItem
                        hideIndicator
                        key={entry.environmentId}
                        value={entry.environmentId}
                      >
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Input
                  size="sm"
                  aria-label="Chat id"
                  placeholder="Chat id (from that computer)"
                  value={threadId}
                  onChange={(event) => setThreadId(event.target.value)}
                />
                <Input
                  size="sm"
                  aria-label="Agent session id"
                  placeholder="Agent session id (from that computer)"
                  value={agentSessionId}
                  onChange={(event) => setAgentSessionId(event.target.value)}
                />
              </>
            )}
            <div className="flex gap-2">
              <Select
                value={access}
                onValueChange={(value) => setAccess(value as ManagedBrowserAccess)}
              >
                <SelectTrigger size="sm" aria-label="What they can do">
                  <SelectValue>{GRANT_ACCESS_TEXT[access]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem hideIndicator value="read">
                    {GRANT_ACCESS_TEXT.read}
                  </SelectItem>
                  <SelectItem hideIndicator value="operate">
                    {GRANT_ACCESS_TEXT.operate}
                  </SelectItem>
                </SelectPopup>
              </Select>
              <Select value={ttl} onValueChange={(value) => setTtl(value as AccessTtl)}>
                <SelectTrigger size="sm" aria-label="How long">
                  <SelectValue>
                    {ACCESS_CODE_TTL_OPTIONS.find((option) => option.value === ttl)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {ACCESS_CODE_TTL_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={input === null || busy}>
            Add access
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ShowCode({ code, onClose }: { readonly code: string; readonly onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Access code</DialogTitle>
          <DialogDescription>
            Enter this on the other computer. It is shown only now, so copy it before closing.
            Anyone who has it can use this browser until it expires or you remove it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            readOnly
            size="sm"
            font="mono"
            aria-label="Access code"
            value={code}
            onFocus={(event) => event.currentTarget.select()}
          />
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(code)
                .then(() => toastManager.add({ type: "info", title: "Copied" }))
            }
          >
            <CopyIcon className="size-3.5" /> Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
