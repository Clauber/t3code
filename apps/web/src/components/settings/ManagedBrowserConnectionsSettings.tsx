import {
  enrollmentFromAccessCode,
  decodeAccessCode,
} from "@t3tools/client-runtime/managed-browser/pairing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthAccessReadScope, AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironments } from "~/state/environments";
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
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Browsers on other computers that this computer's agents may use, added with an access code from that computer. */
export function ManagedBrowserConnectionsSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const enrollments = useEnvironmentQuery(
    environmentId !== null && canRead
      ? managedBrowserEnvironment.enrollments({ environmentId, input: {} })
      : null,
  );
  const remove = useAtomCommand(managedBrowserEnvironment.removeEnrollment, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const [adding, setAdding] = useState(false);
  return (
    <SettingsSection id="other-computers-browsers" title="Browsers on other computers">
      <SettingsRow
        title="Use another computer's browser"
        description="Agents on this computer can open pages in a browser that another computer runs, once you add the access code that computer gave you."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={environmentId === null || !canWrite}
            onClick={() => setAdding(true)}
          >
            Add access code
          </Button>
        }
      >
        <div className="flex flex-col gap-2 pt-3">
          {(enrollments.data?.enrollments ?? []).map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate">
                  {environments.find((env) => env.environmentId === entry.ownerEnvironmentId)
                    ?.label ?? entry.endpoint}
                  {" · "}
                  {entry.profileId}
                </p>
                <p className="text-xs text-muted-foreground">
                  {entry.endpoint} · until {new Date(entry.expiresAt).toLocaleString()}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={environmentId === null || !canWrite}
                onClick={() =>
                  environmentId !== null && void remove({ environmentId, input: { id: entry.id } })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          {enrollments.data !== null && enrollments.data.enrollments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No other computer's browser is set up here.
            </p>
          ) : null}
        </div>
        {adding && environmentId !== null ? (
          <AddAccessCode environmentId={environmentId} onClose={() => setAdding(false)} />
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function AddAccessCode({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const enroll = useAtomCommand(managedBrowserEnvironment.enroll, { reportFailure: false });
  const { environments } = useEnvironments();
  // The code is a secret: it lives in this component's state only, never in storage or a log, and is cleared on close.
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const decoded = decodeAccessCode(code);
  const known = environments.find((entry) => entry.environmentId === decoded?.ownerEnvironmentId);
  const suggested = known?.displayUrl ?? "";
  const effectiveAddress = address || suggested;
  const parsed = code.trim() ? enrollmentFromAccessCode(code, effectiveAddress) : null;
  const close = () => {
    setCode("");
    onClose();
  };
  const submit = async () => {
    if (parsed === null || !parsed.ok || busy) return;
    setBusy(true);
    try {
      const result = await enroll({ environmentId, input: parsed.input });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not add the code",
          description: String(
            (squashAtomCommandFailure(result) as { message?: string }).message ?? "",
          ),
        });
        return;
      }
      close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogPopup
        render={
          <form
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>Add an access code</DialogTitle>
          <DialogDescription>
            Paste the code the other computer showed you. It is a password: it is sent to this
            computer only, kept in its protected storage, and never shown again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              type="password"
              size="sm"
              name="managed-browser-access-code"
              autoComplete="off"
              spellCheck={false}
              aria-label="Access code"
              placeholder="Access code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            {code.trim() && decoded === null ? (
              <p className="text-xs text-destructive-foreground">That is not an access code.</p>
            ) : null}
            <Input
              size="sm"
              aria-label="Address of the other computer"
              placeholder={suggested || "https://other-computer.example.com"}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            {parsed && !parsed.ok && parsed.reason === "address" ? (
              <p className="text-xs text-destructive-foreground">
                Enter the address only, like https://other-computer.example.com, with nothing after
                it.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={parsed === null || !parsed.ok || busy}>
            Add
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
