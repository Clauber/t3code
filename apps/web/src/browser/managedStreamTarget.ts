import { managedStreamTarget } from "@t3tools/client-runtime/managed-browser";
import type { EnvironmentId, PreviewSessionSnapshot } from "@t3tools/contracts";

import { useEnvironment } from "~/state/environments";

/**
 * Where to watch a preview session from, and whether that place can be reached right now. A shared browser
 * another environment owns is watched on its owner, over this client's own connection to it; until that
 * connection is up there is nothing to show and the person is told which computer to connect to.
 */
export function useManagedStreamTarget(
  session: Pick<PreviewSessionSnapshot, "threadId" | "tabId" | "managed">,
  chatEnvironmentId: EnvironmentId,
) {
  const target = managedStreamTarget(session, chatEnvironmentId);
  const owner = useEnvironment(target.viaOwner ? target.environmentId : null);
  return {
    target,
    ready: !target.viaOwner || owner?.connection.phase === "connected",
    ownerLabel: owner?.label ?? null,
  };
}

/** Shown in place of a viewer whose owner this client is not connected to. */
export function managedOwnerUnavailableMessage(ownerLabel: string | null): string {
  return `Connect to ${ownerLabel ?? "the computer that runs this browser"} to watch it.`;
}
