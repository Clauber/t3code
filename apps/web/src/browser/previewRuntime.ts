import { useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EnvironmentId,
  type PreviewRuntime,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";

import { confirmsManagedOwner } from "./managedOwnerSession";
import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "~/previewStateStore";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  return readEnvironmentSupportsServerBrowser(environmentId) ? "server" : undefined;
}

/** Electron hosts its own browser tabs; other clients need the environment to host them. */
export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

/**
 * Whether this client draws a server tab with its own `<webview>`. The desktop
 * app renders tabs of the server it launched, which drives them over the
 * desktop browser channel; every other client and environment streams them.
 */
export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "managed"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    (snapshot.managed === undefined ||
      (snapshot.managed.native === true &&
        (snapshot.managed.remote || snapshot.managed.ownerEnvironmentId === environmentId))) &&
    primaryEnvironmentId !== null &&
    (snapshot.managed?.ownerEnvironmentId ?? environmentId) === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "managed"> | null | undefined,
): boolean {
  const primary = useAtomValue(primaryEnvironmentIdAtom);
  const managed = snapshot?.managed;
  const owner = useThreadPreviewState(
    managed?.remote
      ? {
          environmentId: managed.ownerEnvironmentId,
          threadId: ThreadId.make(managed.hostThreadId),
        }
      : null,
  );
  if (managed?.remote) {
    const confirmed = owner.sessions[managed.hostTabId]?.managed;
    if (!confirmsManagedOwner(managed, confirmed)) return false;
  }
  return rendersServerTabNatively(environmentId, primary, snapshot);
}
