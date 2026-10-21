import { AuthAccessReadScope, AuthAccessWriteScope, type PreviewAutomationBrowserBinding, type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { managedBrowserEnvironment } from "~/state/managedBrowser";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { ensureThreadEnrollment, reachableBrowserOwnerAddress, threadEnrollmentReady } from "./managedThreadEnrollment";

export function ManagedThreadBrowserEnrollment({ threadRef, binding, ownerEndpoint }: {
  threadRef: ScopedThreadRef;
  binding: PreviewAutomationBrowserBinding;
  ownerEndpoint?: string;
}) {
  const remote = threadRef.environmentId !== binding.ownerEnvironmentId;
  const readOwner = useEnvironmentScope(binding.ownerEnvironmentId, AuthAccessReadScope);
  const writeOwner = useEnvironmentScope(binding.ownerEnvironmentId, AuthAccessWriteScope);
  const readCaller = useEnvironmentScope(threadRef.environmentId, AuthAccessReadScope);
  const writeCaller = useEnvironmentScope(threadRef.environmentId, AuthAccessWriteScope);
  const grants = useEnvironmentQuery(remote && readOwner ? managedBrowserEnvironment.grants({ environmentId: binding.ownerEnvironmentId, input: {} }) : null);
  const enrollments = useEnvironmentQuery(remote && readCaller ? managedBrowserEnvironment.enrollments({ environmentId: threadRef.environmentId, input: {} }) : null);
  const identity = useEnvironmentQuery(remote && readCaller ? managedBrowserEnvironment.agentIdentity({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } }) : null);
  const principal = identity.isSuccess ? identity.data?.agentSessionId ?? null : null;
  const create = useAtomCommand(managedBrowserEnvironment.createGrant, { reportFailure: false, reportDefect: false });
  const enroll = useAtomCommand(managedBrowserEnvironment.enroll, { reportFailure: false, reportDefect: false });
  const revoke = useAtomCommand(managedBrowserEnvironment.revokeGrant, { reportFailure: false, reportDefect: false });
  const remove = useAtomCommand(managedBrowserEnvironment.removeEnrollment, { reportFailure: false, reportDefect: false });
  const [address, setAddress] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [authorized, setAuthorized] = useState<{ scope: string; principal: string | null; endpoint: string } | null>(null);
  const [status, setStatus] = useState<{ key: string; message: string } | null>(null);
  const attempted = useRef<string | null>(null);
  const scope = JSON.stringify([threadRef, binding]);
  const key = JSON.stringify([scope, principal]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const knownEndpoint = enrollments.data?.enrollments.find((entry) =>
    entry.ownerEnvironmentId === binding.ownerEnvironmentId && reachableBrowserOwnerAddress(entry.endpoint))?.endpoint;
  const endpoint = (authorized?.scope === scope ? authorized.endpoint : "") || ownerEndpoint || knownEndpoint || "";
  const input = principal && grants.data && enrollments.data ? {
    threadRef, binding, agentSessionId: principal, endpoint,
    grants: grants.data.grants, enrollments: enrollments.data.enrollments, replace: authorized?.scope === scope && authorized.principal === principal,
  } : null;
  const ready = input !== null && threadEnrollmentReady(input);

  useEffect(() => {
    if (!remote || !writeOwner || !writeCaller || !grants.isSuccess || !enrollments.isSuccess || !input) return;
    if (!ready && !reachableBrowserOwnerAddress(endpoint)) return;
    const attemptKey = JSON.stringify([key, endpoint, attempt]);
    if (attempted.current === attemptKey) return;
    attempted.current = attemptKey;
    if (input.replace) setAuthorized((value) => value?.scope === scope && value.principal === principal
      ? { ...value, principal: null } : value);
    setStatus({ key, message: "Connecting this agent to the Mac browser…" });
    void ensureThreadEnrollment(input, {
      isCurrent: () => currentKey.current === key,
      create: async (value) => {
        const result = await create({ environmentId: binding.ownerEnvironmentId, input: value });
        if (result._tag === "Failure") throw new Error("Could not authorize browser access on the Mac.");
        return result.value;
      },
      enroll: async (value) => {
        const result = await enroll({ environmentId: threadRef.environmentId, input: value });
        if (result._tag === "Failure") throw new Error("Could not enroll browser access on the chat host.");
      },
      revoke: async (id) => {
        const result = await revoke({ environmentId: binding.ownerEnvironmentId, input: { id } });
        if (result._tag === "Failure") throw new Error("Could not revoke the previous browser authorization.");
      },
      remove: async (id) => {
        const result = await remove({ environmentId: threadRef.environmentId, input: { id } });
        if (result._tag === "Failure") throw new Error("Could not remove the previous browser connection.");
      },
    }).then(() => {
      if (currentKey.current === key) setStatus({ key, message: "Browser access needs authorization." });
    }, (error: unknown) => {
      if (currentKey.current === key) setStatus({ key, message: error instanceof Error ? error.message : "Browser connection failed." });
    });
  }, [remote, writeOwner, writeCaller, grants.isSuccess, enrollments.isSuccess, input, ready, endpoint, key, scope, principal, attempt, create, enroll, revoke, remove, binding.ownerEnvironmentId, threadRef.environmentId]);

  if (!remote) return null;
  const permissions = readOwner && writeOwner && readCaller && writeCaller;
  const message = !permissions ? "Browser sharing needs access-management permission on both computers."
    : identity.error || grants.error || enrollments.error ? "Browser sharing is unavailable. Update and reconnect both T3 hosts."
    : !principal ? "Your browser is ready. Agent access connects when this chat starts its provider session."
    : ready ? "Agent connected to this browser"
    : status?.key === key ? status.message : "Connect this chat to the Mac browser.";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs" role="status">
      <span>{message}</span>
      {permissions && !ready && !identity.error && !grants.error && !enrollments.error ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); setAuthorized({ scope, principal, endpoint: address || endpoint }); setAttempt((value) => value + 1); }}>
          <Input aria-label="Mac T3 address reachable from the chat host" placeholder="https://your-mac:3773" value={address || endpoint} onChange={(event) => setAddress(event.target.value)} />
          <Button type="submit" size="sm" variant="outline" disabled={!reachableBrowserOwnerAddress(address || endpoint)}>{principal ? "Authorize agent" : "Save address"}</Button>
        </form>
      ) : null}
    </div>
  );
}
