import { selectedManagedProfileAtom } from "@t3tools/client-runtime/state/managed-browser";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  type PreviewManagedSession,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isElectron } from "~/env";
import { readThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironmentSupportsManagedBrowserPanel } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { managedBrowserEnvironment } from "~/state/managedBrowser";
import { BrowserSettingsReadError } from "./openFileInPreview";

export class ManagedBrowserOpenError extends BrowserSettingsReadError {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : "The managed browser could not open. Check Settings → Integrations → Shared browser. No standard preview was substituted.";
  }
}

/** The native desktop owns the default browser, independently of the chat's host. */
export async function openManagedThreadBrowser(input: {
  threadRef: ScopedThreadRef;
  url?: string;
  profileId?: string;
  defaultProfileId?: string;
}): Promise<PreviewManagedSession | null> {
  if (!isElectron) return null;
  if (!readEnvironmentSupportsManagedBrowserPanel(input.threadRef.environmentId))
    throw new ManagedBrowserOpenError({
      cause: new Error(
        "Update the chat host's T3 server to use the managed browser in this panel. No standard preview was opened.",
      ),
    });
  const owner = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (!owner)
    throw new ManagedBrowserOpenError({
      cause: new Error("Connect this Mac's T3 server to open its managed browser."),
    });
  try {
    const overviewResult = await executeAtomQuery(
      appAtomRegistry,
      managedBrowserEnvironment.overview({ environmentId: owner, input: {} }),
    );
    if (overviewResult._tag === "Failure") throw squashAtomCommandFailure(overviewResult);
    const overview = overviewResult.value;
    if (!overview.hosting.available || !overview.native?.available)
      throw new Error(
        "This Mac's managed browser is unavailable. Check Settings → Integrations → Shared browser; update this Mac's T3 server if needed.",
      );
    const selected = appAtomRegistry.get(selectedManagedProfileAtom);
    const previous = readThreadPreviewState(input.threadRef).snapshot?.managed;
    const profile =
      previous?.ownerEnvironmentId === owner
        ? previous
        : selected?.ownerEnvironmentId === owner
          ? selected
          : null;
    const profileId = input.profileId ?? profile?.profileId ?? input.defaultProfileId ?? "default";
    const instanceId =
      (profile?.profileId === profileId ? profile.instanceId : undefined) ??
      overview.profiles.find((entry) => entry.profileId === profileId)?.instanceId ??
      `instance-${profileId}`;
    const result = await runAtomCommand(
      appAtomRegistry,
      managedBrowserEnvironment.openTab,
      {
        environmentId: owner,
        input: {
          thread: input.threadRef,
          instanceId: ManagedBrowserInstanceId.make(instanceId),
          profileId: ManagedBrowserProfileId.make(profileId),
          ...(input.url === undefined ? {} : { url: input.url }),
          shared: true,
        },
      },
      { reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const tab = result.value.tab;
    return {
      ownerEnvironmentId: owner,
      instanceId: tab.instanceId,
      profileId: tab.profileId,
      engineTabId: tab.engineTabId,
      incarnation: tab.incarnation,
      hostThreadId: tab.hostThreadId,
      hostTabId: tab.hostTabId,
      shared: tab.shared,
      native: true,
      remote: true,
    };
  } catch (cause) {
    throw new ManagedBrowserOpenError({ cause });
  }
}
