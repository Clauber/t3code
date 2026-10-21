import type {
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "~/browser/browserDefaults";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { openManagedThreadBrowser } from "~/browser/openManagedThreadBrowser";
import { previewRuntimeFor } from "~/browser/previewRuntime";
import { applyPreviewServerSnapshot, rememberPreviewUrl } from "~/previewStateStore";

interface OpenPreviewSessionInput<E> {
  openPreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewOpenInput;
  }) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;
  threadRef: ScopedThreadRef;
  url?: string;
  /** Overrides the configured default; automation passes an explicit size. */
  viewport?: PreviewViewportSetting;
  /** Overrides the configured default profile. */
  profileId?: string;
  standardBrowser?: boolean;
}

export async function openPreviewSession<E>(
  input: OpenPreviewSessionInput<E>,
): Promise<AtomCommandResult<PreviewSessionSnapshot, E | BrowserSettingsReadError>> {
  // Resolved once: a tab opened before client settings hydrate would otherwise
  // be born at the schema defaults and never corrected.
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const managed = input.standardBrowser
    ? null
    : await openManagedThreadBrowser({
        threadRef: input.threadRef,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        defaultProfileId: browserDefaultOpenProfileId(defaults),
      }).catch((error: BrowserSettingsReadError) => error);
  if (managed instanceof BrowserSettingsReadError) return AsyncResult.failure(Cause.fail(managed));
  const runtime = previewRuntimeFor(input.threadRef.environmentId);
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      ...(managed ? { managedAttachment: managed } : {}),
      ...(input.standardBrowser ? { standardBrowser: true } : {}),
      ...(input.url === undefined ? {} : { url: input.url }),
      viewport: input.viewport ?? browserDefaultOpenViewport(defaults),
      profileId: input.profileId ?? browserDefaultOpenProfileId(defaults),
      ...(runtime === undefined ? {} : { runtime }),
    },
  });
  if (result._tag === "Failure") {
    return result;
  }
  const snapshot = result.value;
  applyPreviewServerSnapshot(input.threadRef, snapshot);
  if (input.url !== undefined) {
    rememberPreviewUrl(
      input.threadRef,
      snapshot.navStatus._tag === "Idle" ? input.url : snapshot.navStatus.url,
    );
  }
  return result;
}
