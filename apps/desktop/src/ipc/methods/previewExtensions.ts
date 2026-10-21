import {
  DesktopPreviewExtensionInputSchema,
  DesktopPreviewExtensionInstallSchema,
  DesktopPreviewExtensionPopupInputSchema,
  DesktopPreviewExtensionSchema,
  DesktopPreviewExtensionTokenInputSchema,
  DesktopPreviewTabInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ExtensionHost from "../../preview/extensions/ExtensionHost.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export class PreviewExtensionError extends Schema.TaggedError<PreviewExtensionError>()(
  "PreviewExtensionError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `Extension ${this.operation} failed.`;
  }
}

const attempt = <A>(operation: string, run: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: async () => run(),
    catch: (cause) => new PreviewExtensionError({ operation, cause }),
  });

export const listExtensions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_LIST_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Array(DesktopPreviewExtensionSchema),
  handler: Effect.fn("desktop.ipc.preview.extensions.list")(function* ({ tabId }) {
    const tab = yield* (yield* PreviewManager.PreviewManager).getTabWebContents(tabId);
    return ExtensionHost.listExtensions(tab.session);
  }),
});

export const prepareExtensionInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_PREPARE_INSTALL_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewExtensionInstallSchema,
  handler: Effect.fn("desktop.ipc.preview.extensions.prepareInstall")(function* ({ tabId }) {
    const tab = yield* (yield* PreviewManager.PreviewManager).getTabWebContents(tabId);
    // The listing is whatever the tab really shows, not a URL the renderer names.
    return yield* attempt("install", () => ExtensionHost.prepareInstall(tab.session, tab.getURL()));
  }),
});

export const commitExtensionInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_COMMIT_INSTALL_CHANNEL,
  payload: DesktopPreviewExtensionTokenInputSchema,
  result: DesktopPreviewExtensionSchema,
  handler: Effect.fn("desktop.ipc.preview.extensions.commitInstall")(function* ({ token }) {
    return yield* attempt("install", () => ExtensionHost.commitInstall(token));
  }),
});

export const discardExtensionInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_DISCARD_INSTALL_CHANNEL,
  payload: DesktopPreviewExtensionTokenInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.extensions.discardInstall")(function* ({ token }) {
    yield* attempt("discard", () => ExtensionHost.discardInstall(token));
  }),
});

export const uninstallExtension = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_UNINSTALL_CHANNEL,
  payload: DesktopPreviewExtensionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.extensions.uninstall")(function* ({ tabId, extensionId }) {
    const tab = yield* (yield* PreviewManager.PreviewManager).getTabWebContents(tabId);
    yield* attempt("uninstall", () => ExtensionHost.uninstallExtension(tab.session, extensionId));
  }),
});

export const openExtensionPopup = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_OPEN_POPUP_CHANNEL,
  payload: DesktopPreviewExtensionPopupInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.extensions.openPopup")(function* ({ tabId, extensionId, anchor }) {
    const tab = yield* (yield* PreviewManager.PreviewManager).getTabWebContents(tabId);
    yield* attempt("popup", () => ExtensionHost.openExtensionPopup(tab, extensionId, anchor));
  }),
});
