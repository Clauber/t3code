// @effect-diagnostics nodeBuiltinImport:off - Installs extensions into a profile's own directory.
// @effect-diagnostics globalDate:off - Chrome event timestamps and install-token expiry are wall-clock values.
/**
 * Chrome Web Store extensions for persistent preview profiles. Each profile
 * session gets one host: it loads the profile's installed extensions,
 * answers the `chrome.*` calls Electron lacks (see `ExtensionApi.ts`) for
 * extension pages and service workers of that session only, and emits the
 * tab and navigation events each extension is entitled to.
 *
 * Extensions live under `<partition>/T3Extensions/<id>/<version>`, next to
 * the profile's own data, so profiles never share them.
 */
import * as Electron from "electron";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  createExtensionApi,
  emptyUiState,
  type ExtensionBrowser,
  type ExtensionCaller,
  type ExtensionUiState,
  type ExtensionWindow,
  namespaceAllowed,
  popupOf,
} from "./ExtensionApi.ts";
import { EXTENSION_CALL_CHANNEL, EXTENSION_EVENT_CHANNEL } from "./ExtensionApiSurface.ts";
import { CrxError, readBounded, verifyCrx3 } from "./Crx.ts";
import {
  commitPackage,
  discardStaged,
  type ExtensionRuntime,
  loadInstalled,
  removePackage,
  stagePackage,
  type StagedPackage,
} from "./ExtensionStore.ts";
import {
  commandForShortcut,
  type ExtensionManifest,
  manifestPolicy,
  patternMatchesUrl,
  toolbarIconPath,
  permissionWarnings,
  unsupportedPermissions,
  visibleTab,
  webStoreExtensionId,
} from "./ExtensionPolicy.ts";

const EXTENSIONS_DIRECTORY = "T3Extensions";
const PREPARED_INSTALL_TTL_MS = 10 * 60_000;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const ORIGIN = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/;

export interface ExtensionSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hasPopup: boolean;
  readonly badgeText: string;
  /** The toolbar icon as a PNG data URL; absent when the package names none that loads. */
  readonly icon?: string;
}

export interface PreparedExtensionInstall {
  readonly token: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly warnings: ReadonlyArray<string>;
  readonly unavailable: ReadonlyArray<string>;
  readonly update: boolean;
}

export interface PopupAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Host {
  readonly session: Electron.Session;
  readonly root: string;
  readonly ui: Map<string, ExtensionUiState>;
  readonly workers: Map<string, Set<Electron.ServiceWorkerMain>>;
  readonly pages: Map<string, Set<Electron.WebContents>>;
  readonly tabs: Set<Electron.WebContents>;
  readonly ownedWindows: Map<number, { readonly extensionId: string; readonly window: Electron.BrowserWindow }>;
  readonly notifications: Map<string, Electron.Notification>;
  activeTab: Electron.WebContents | undefined;
  popup: Electron.BrowserWindow | undefined;
  readonly call: ReturnType<typeof createExtensionApi>;
  /** Failures while delivering extension events; they must never reach Electron's event loop. */
  readonly report: (context: string, error: unknown) => void;
}

const hosts = new Map<Electron.Session, Host>();
const prepared = new Map<string, { readonly host: Host; readonly staged: StagedPackage; readonly expires: number }>();
let installed = false;

const manifestOf = (extension: Electron.Extension): ExtensionManifest => manifestPolicy(extension.manifest);
const uiOf = (host: Host, id: string) => {
  let state = host.ui.get(id);
  if (!state) {
    state = emptyUiState();
    host.ui.set(id, state);
  }
  return state;
};
const live = <T extends { isDestroyed(): boolean }>(set: Set<T> | undefined) =>
  [...(set ?? [])].filter((item) => !item.isDestroyed());

const windowOfTab = (tab: Electron.WebContents) =>
  Electron.BrowserWindow.fromWebContents(tab.hostWebContents ?? tab) ?? undefined;

const tabInfo = (tab: Electron.WebContents) => ({
  id: tab.id,
  url: tab.getURL(),
  title: tab.getTitle(),
  windowId: windowOfTab(tab)?.id ?? -1,
  index: 0,
  pinned: false,
  incognito: false,
  discarded: false,
  autoDiscardable: true,
  frozen: false,
  groupId: -1,
  status: tab.isLoading() ? "loading" : "complete",
  audible: tab.isCurrentlyAudible(),
  mutedInfo: { muted: tab.isAudioMuted() },
});

const windowInfo = (window: Electron.BrowserWindow, type: ExtensionWindow["type"]): ExtensionWindow => {
  const bounds = window.getBounds();
  return { id: window.id, focused: window.isFocused(), top: bounds.y, left: bounds.x, width: bounds.width, height: bounds.height, type };
};

const frameIdOf = (tab: Electron.WebContents, frame: Electron.WebFrameMain) =>
  frame === tab.mainFrame ? 0 : frame.frameTreeNodeId;
/** Frames disappear mid-navigation; Electron throws on any access to a destroyed one. */
const liveFrame = (frame: Electron.WebFrameMain | null | undefined) =>
  frame && !frame.isDestroyed() ? frame : undefined;

/** Sends an event to every extension of the host allowed to receive it; `args` is shaped per extension. */
const emit = (
  host: Host,
  name: string,
  args: (manifest: ExtensionManifest) => ReadonlyArray<unknown>,
  only?: string,
) => {
  const namespace = name.split(".")[0] ?? "";
  for (const extension of host.session.extensions.getAllExtensions()) {
    if (only !== undefined && extension.id !== only) continue;
    if (!namespaceAllowed(manifestOf(extension), namespace)) continue;
    const payload = args(manifestOf(extension));
    for (const worker of host.workers.get(extension.id) ?? []) {
      try {
        worker.send(EXTENSION_EVENT_CHANNEL, name, payload);
      } catch {
        host.workers.get(extension.id)?.delete(worker);
      }
    }
    for (const page of live(host.pages.get(extension.id))) {
      try {
        page.send(EXTENSION_EVENT_CHANNEL, name, payload);
      } catch (error) {
        host.report(name, error);
      }
    }
  }
};

/** Below the toolbar button's right edge, as Chrome places action popups; top-right of the window without one. */
const popupOrigin = (parent: Electron.BrowserWindow, width: number, anchor: PopupAnchor | undefined) => {
  const content = parent.getContentBounds();
  if (!anchor) return { x: content.x + content.width - width - 8, y: content.y + 48 };
  const zoom = parent.webContents.getZoomFactor();
  return {
    x: Math.round(content.x + (anchor.x + anchor.width) * zoom - width),
    y: Math.round(content.y + (anchor.y + anchor.height) * zoom + 4),
  };
};

const openPopup = (host: Host, extensionId: string, anchor?: { readonly window: Electron.BrowserWindow; readonly rect: PopupAnchor }) => {
  const extension = host.session.extensions.getExtension(extensionId);
  if (!extension) return;
  const popupPath = popupOf({ id: extensionId, manifest: manifestOf(extension) }, uiOf(host, extensionId));
  const activeTab = host.activeTab;
  if (popupPath === "") {
    if (activeTab) emit(host, "action.onClicked", (manifest) => [visibleTab(manifest, tabInfo(activeTab))], extensionId);
    return;
  }
  host.popup?.close();
  const parent = anchor?.window ?? (activeTab ? windowOfTab(activeTab) : undefined);
  const popup = new Electron.BrowserWindow({
    ...(parent ? { parent } : {}),
    show: false,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: extension.name,
    skipTaskbar: true,
    width: 380,
    height: 600,
    webPreferences: { session: host.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  host.popup = popup;
  popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popup.on("blur", () => {
    if (!popup.isDestroyed() && !popup.webContents.isDestroyed() && !popup.webContents.isDevToolsOpened()) popup.close();
  });
  popup.on("closed", () => {
    if (host.popup === popup) host.popup = undefined;
  });
  popup.webContents.once("did-finish-load", () => {
    void popup.webContents
      .executeJavaScript("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")
      .then((size: unknown) => {
        if (popup.isDestroyed()) return;
        const [rawWidth, rawHeight] = Array.isArray(size) ? size : [380, 600];
        // Chrome clamps action popups to 25..800 by 25..600.
        const width = Math.min(800, Math.max(25, Number(rawWidth) || 380));
        const height = Math.min(600, Math.max(25, Number(rawHeight) || 600));
        popup.setContentSize(width, height);
        if (parent) {
          const origin = popupOrigin(parent, popup.getBounds().width, anchor?.rect);
          popup.setPosition(origin.x, origin.y);
        }
        popup.show();
      });
  });
  void popup.loadURL(`chrome-extension://${extensionId}/${popupPath.replace(/^\//, "")}`);
};

const createHost = (
  session: Electron.Session,
  root: string,
  report: (context: string, error: unknown) => void,
): Host => {
  const liveTabs = () => [...host.tabs].filter((tab) => !tab.isDestroyed());
  const tabById = (id: number) => liveTabs().find((tab) => tab.id === id);
  const browser: ExtensionBrowser = {
    tabs: () => liveTabs().map(tabInfo),
    activeTabId: () => (host.activeTab && !host.activeTab.isDestroyed() ? host.activeTab.id : liveTabs().at(-1)?.id),
    windows: () => [
      ...new Set(liveTabs().flatMap((tab) => windowOfTab(tab) ?? [])),
    ].map((window) => windowInfo(window, "normal")).concat(
      [...host.ownedWindows.values()].filter(({ window }) => !window.isDestroyed()).map(({ window }) => windowInfo(window, "popup")),
    ),
    lastFocusedWindowId: () => {
      const active = host.activeTab && !host.activeTab.isDestroyed() ? host.activeTab : liveTabs().at(-1);
      return (active ? windowOfTab(active)?.id : undefined) ?? Electron.BrowserWindow.getFocusedWindow()?.id;
    },
    ownsWindow: (extensionId, windowId) => host.ownedWindows.get(windowId)?.extensionId === extensionId,
    openExtensionWindow: (extensionId, url, size) => {
      const window = new Electron.BrowserWindow({
        width: size.width ?? 380,
        height: size.height ?? 630,
        webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      host.ownedWindows.set(window.id, { extensionId, window });
      const id = window.id;
      window.on("closed", () => {
        host.ownedWindows.delete(id);
        emit(host, "windows.onRemoved", () => [id]);
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      void window.loadURL(url);
      return windowInfo(window, "popup");
    },
    focusWindow: (windowId) => host.ownedWindows.get(windowId)?.window.focus(),
    closeWindow: (windowId) => host.ownedWindows.get(windowId)?.window.close(),
    frames: (tabId) => {
      const tab = tabById(tabId);
      if (!tab) return null;
      return tab.mainFrame.framesInSubtree.flatMap((candidate) => {
        const frame = liveFrame(candidate);
        if (!frame) return [];
        const parent = liveFrame(frame.parent);
        return [
          {
            frameId: frameIdOf(tab, frame),
            parentFrameId: parent ? frameIdOf(tab, parent) : -1,
            url: frame.url,
            processId: frame.processId,
            errorOccurred: false,
          },
        ];
      });
    },
    navigateTab: (tabId, url) => void tabById(tabId)?.loadURL(url),
    setTabMuted: (tabId, muted) => tabById(tabId)?.setAudioMuted(muted),
    openPopup: (extensionId) => openPopup(host, extensionId),
    showNotification: (extensionId, notificationId, options) => {
      const key = `${extensionId}\u0000${notificationId}`;
      host.notifications.get(key)?.close();
      const notification = new Electron.Notification({ title: options.title ?? "", body: options.message ?? "" });
      notification.on("click", () => emit(host, "notifications.onClicked", () => [notificationId], extensionId));
      notification.on("close", () => {
        host.notifications.delete(key);
        emit(host, "notifications.onClosed", () => [notificationId, true], extensionId);
      });
      host.notifications.set(key, notification);
      notification.show();
    },
    clearNotification: (extensionId, notificationId) => {
      const notification = host.notifications.get(`${extensionId}\u0000${notificationId}`);
      notification?.close();
      return notification !== undefined;
    },
  };
  const host: Host = {
    session,
    root,
    ui: new Map(),
    workers: new Map(),
    pages: new Map(),
    tabs: new Set(),
    ownedWindows: new Map(),
    notifications: new Map(),
    activeTab: undefined,
    popup: undefined,
    call: createExtensionApi(browser),
    report,
  };
  return host;
};

/** Resolves the calling extension from where the call really came from: its session and origin. */
const authorize = (session: Electron.Session, origin: string | undefined) => {
  const host = hosts.get(session);
  const id = ORIGIN.exec(origin ?? "")?.[1];
  const extension = id ? host?.session.extensions.getExtension(id) : undefined;
  return host && extension ? { host, caller: { id: extension.id, manifest: manifestOf(extension) } satisfies ExtensionCaller } : null;
};

const invoke = (
  host: Host,
  caller: ExtensionCaller,
  method: unknown,
  args: unknown,
) => {
  if (typeof method !== "string" || !Array.isArray(args)) throw new Error("Malformed extension API call.");
  return host.call(method, args, caller, uiOf(host, caller.id));
};

const trackTab = (host: Host, tab: Electron.WebContents) => {
  if (host.tabs.has(tab)) return;
  host.tabs.add(tab);
  const tabId = tab.id;
  const tabFor = (manifest: ExtensionManifest) => visibleTab(manifest, tabInfo(tab));
  // `emit` only reaches extensions holding webNavigation, which in Chrome reveals these URLs.
  const navigation = (details: Record<string, unknown>) => () => [{ tabId, timeStamp: Date.now(), ...details }];
  const frameFrom = (isMainFrame: boolean, processId: number, routingId: number) =>
    liveFrame(isMainFrame ? tab.mainFrame : Electron.webFrameMain.fromId(processId, routingId));
  const guarded =
    <A extends ReadonlyArray<unknown>>(context: string, listener: (...args: A) => void) =>
    (...args: A) => {
      try {
        listener(...args);
      } catch (error) {
        host.report(context, error);
      }
    };
  emit(host, "tabs.onCreated", (manifest) => [tabFor(manifest)]);
  tab.on("did-start-navigation", guarded("did-start-navigation", (details) => {
    const frame = liveFrame(details.frame);
    if (details.isSameDocument || !frame) return;
    const parent = liveFrame(frame.parent);
    emit(
      host,
      "webNavigation.onBeforeNavigate",
      navigation({ frameId: frameIdOf(tab, frame), parentFrameId: parent ? frameIdOf(tab, parent) : -1, url: details.url }),
    );
  }));
  tab.on("did-frame-navigate", guarded("did-frame-navigate", (_event, url, _code, _status, isMainFrame, processId, routingId) => {
    const frame = frameFrom(isMainFrame, processId, routingId);
    if (!frame) return;
    emit(
      host,
      "webNavigation.onCommitted",
      navigation({ frameId: frameIdOf(tab, frame), url, processId, transitionType: "link", transitionQualifiers: [] }),
    );
    if (isMainFrame)
      emit(host, "tabs.onUpdated", (manifest) => [
        tabId,
        "url" in tabFor(manifest) ? { status: "loading", url } : { status: "loading" },
        tabFor(manifest),
      ]);
  }));
  tab.on("did-frame-finish-load", guarded("did-frame-finish-load", (_event, isMainFrame, processId, routingId) => {
    const frame = frameFrom(isMainFrame, processId, routingId);
    if (!frame) return;
    const details = { frameId: frameIdOf(tab, frame), url: frame.url, processId };
    // Electron reports load completion only; DOMContentLoaded is announced with it.
    emit(host, "webNavigation.onDOMContentLoaded", navigation(details));
    emit(host, "webNavigation.onCompleted", navigation(details));
    if (isMainFrame) emit(host, "tabs.onUpdated", (manifest) => [tabId, { status: "complete" }, tabFor(manifest)]);
  }));
  tab.on("did-navigate-in-page", guarded("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    emit(host, "webNavigation.onHistoryStateUpdated", navigation({ frameId: 0, url, transitionType: "link", transitionQualifiers: [] }));
  }));
  tab.on("focus", guarded("focus", () => {
    host.activeTab = tab;
    emit(host, "tabs.onActivated", () => [{ tabId, windowId: windowOfTab(tab)?.id ?? -1 }]);
  }));
  tab.on("before-input-event", guarded("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    for (const extension of host.session.extensions.getAllExtensions()) {
      const command = commandForShortcut(manifestOf(extension), process.platform, input);
      if (command === null) continue;
      event.preventDefault();
      host.activeTab = tab;
      if (command === "_execute_action") openPopup(host, extension.id);
      else emit(host, "commands.onCommand", (manifest) => [command, tabFor(manifest)], extension.id);
      return;
    }
  }));
  tab.once("destroyed", () => {
    host.tabs.delete(tab);
    if (host.activeTab === tab) host.activeTab = undefined;
    emit(host, "tabs.onRemoved", () => [tabId, { windowId: -1, isWindowClosing: false }]);
  });
};

const installGlobalHandlers = () => {
  if (installed) return;
  installed = true;
  Electron.ipcMain.handle(EXTENSION_CALL_CHANNEL, (event, method: unknown, args: unknown) => {
    const resolved = authorize(event.sender.session, event.senderFrame?.origin);
    if (!resolved) throw new Error("Not an extension page of this browser profile.");
    let pages = resolved.host.pages.get(resolved.caller.id);
    if (!pages) resolved.host.pages.set(resolved.caller.id, (pages = new Set()));
    if (!pages.has(event.sender)) {
      const page = event.sender;
      const registered = pages;
      registered.add(page);
      page.once("destroyed", () => registered.delete(page));
    }
    return invoke(resolved.host, resolved.caller, method, args);
  });
  Electron.app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    const host = hosts.get(contents.session);
    if (!host) return;
    try {
      trackTab(host, contents);
    } catch (error) {
      host.report("tabs.onCreated", error);
    }
  });
};

const extensionRoot = (session: Electron.Session) =>
  session.storagePath ? NodePath.join(session.storagePath, EXTENSIONS_DIRECTORY) : null;

const runtimeOf = (session: Electron.Session): ExtensionRuntime => ({
  isLoaded: (id) => session.extensions.getExtension(id) !== null,
  unload: (id) => session.extensions.removeExtension(id),
  // No allowFileAccess: T3 offers no per-profile file:// grant.
  load: async (directory) => {
    await session.extensions.loadExtension(directory);
  },
  clearData: async (id) => {
    await session.clearStorageData({ origin: `chrome-extension://${id}` });
    if (session.storagePath)
      await NodeFs.rm(NodePath.join(session.storagePath, "Local Extension Settings", id), { recursive: true, force: true });
  },
});

/**
 * Enables extensions for a persistent profile session and loads its installed
 * ones. In-memory sessions cannot load extensions in Electron, so private
 * profiles stay without them.
 */
export const enableExtensions = async (
  session: Electron.Session,
  preloadPath: string,
  report: (context: string, error: unknown) => void,
): Promise<ReadonlyArray<{ readonly id: string; readonly cause: unknown }>> => {
  const root = extensionRoot(session);
  if (!root || hosts.has(session)) return [];
  installGlobalHandlers();
  for (const type of ["frame", "service-worker"] as const)
    session.registerPreloadScript({ id: `t3-extension-api-${type}`, type, filePath: preloadPath });
  const host = createHost(session, root, report);
  hosts.set(session, host);
  // Electron reuses one ServiceWorkerMain (and its ipc) when an idle worker restarts, so its
  // handler is registered once per object; running state only decides who receives events.
  const answered = new WeakSet<Electron.ServiceWorkerMain>();
  session.serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
    const id = worker ? ORIGIN.exec(worker.scope)?.[1] : undefined;
    if (!worker || !id) return;
    let workers = host.workers.get(id);
    if (!workers) host.workers.set(id, (workers = new Set()));
    if (runningStatus === "stopped" || runningStatus === "stopping") workers.delete(worker);
    else workers.add(worker);
    if (answered.has(worker)) return;
    answered.add(worker);
    worker.ipc.handle(EXTENSION_CALL_CHANNEL, (event, method: unknown, args: unknown) => {
      const resolved = authorize(event.session, event.serviceWorker.scope);
      if (!resolved || resolved.host !== host) throw new Error("Not an extension of this browser profile.");
      return invoke(host, resolved.caller, method, args);
    });
  });
  return loadInstalled(root, runtimeOf(session));
};

export const listExtensions = (session: Electron.Session): ReadonlyArray<ExtensionSummary> => {
  const host = hosts.get(session);
  if (!host) return [];
  return session.extensions.getAllExtensions().map((extension) => ({
    id: extension.id,
    name: extension.name,
    version: extension.version,
    hasPopup: popupOf({ id: extension.id, manifest: manifestOf(extension) }, uiOf(host, extension.id)) !== "",
    badgeText: uiOf(host, extension.id).action.badgeText,
    ...iconOf(extension, uiOf(host, extension.id).action.iconPath),
  }));
};

/** Reads the toolbar icon from the package itself; a path that leaves the package is ignored. */
const iconOf = (extension: Electron.Extension, set: Parameters<typeof toolbarIconPath>[1]): { icon?: string } => {
  const relative = toolbarIconPath(manifestOf(extension), set);
  if (!relative) return {};
  const file = NodePath.resolve(extension.path, relative.replace(/^\/+/, ""));
  if (!file.startsWith(extension.path + NodePath.sep)) return {};
  const image = Electron.nativeImage.createFromPath(file);
  return image.isEmpty() ? {} : { icon: image.resize({ width: 32, height: 32 }).toDataURL() };
};

const discardPrepared = async (token: string) => {
  const entry = prepared.get(token);
  prepared.delete(token);
  if (entry) await discardStaged(entry.host.root, entry.staged);
};

/**
 * Downloads the listing's package from the Chrome Web Store, verifies it and
 * stages it unpacked, without loading anything. The caller shows the
 * returned warnings and then commits or discards the token.
 */
export const prepareInstall = async (session: Electron.Session, listingUrl: string): Promise<PreparedExtensionInstall> => {
  const host = hosts.get(session);
  if (!host) throw new CrxError("Extensions need a saved browser profile; private profiles cannot use them.");
  const id = webStoreExtensionId(listingUrl);
  if (!id) throw new CrxError("Open the extension's Chrome Web Store page first.");
  for (const [token, entry] of prepared) if (entry.expires < Date.now()) await discardPrepared(token);
  const url = new URL("https://clients2.google.com/service/update2/crx");
  url.searchParams.set("response", "redirect");
  url.searchParams.set("prodversion", process.versions.chrome ?? "");
  url.searchParams.set("acceptformat", "crx3");
  url.searchParams.set("x", `id=${id}&uc`);
  const response = await session.fetch(url.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new CrxError(`The Chrome Web Store did not provide the extension (HTTP ${response.status}).`);
  const crx = verifyCrx3(await readBounded(response, MAX_PACKAGE_BYTES));
  if (crx.id !== id) throw new CrxError("The Chrome Web Store sent a different extension than the listing.");
  const staged = await stagePackage(host.root, crx);
  const token = NodeCrypto.randomBytes(16).toString("hex");
  prepared.set(token, { host, staged, expires: Date.now() + PREPARED_INSTALL_TTL_MS });
  return {
    token,
    id,
    name: staged.displayName,
    version: staged.manifest.version,
    warnings: permissionWarnings(staged.manifest),
    unavailable: unsupportedPermissions(staged.manifest),
    update: session.extensions.getExtension(id) !== null,
  };
};

export const commitInstall = async (token: string): Promise<ExtensionSummary> => {
  const entry = prepared.get(token);
  if (!entry || entry.expires < Date.now()) {
    await discardPrepared(token);
    throw new CrxError("This install request expired; start it again from the store page.");
  }
  prepared.delete(token);
  await commitPackage(entry.host.root, entry.staged, runtimeOf(entry.host.session));
  const summary = listExtensions(entry.host.session).find((extension) => extension.id === entry.staged.id);
  if (!summary) throw new CrxError("The extension was installed but did not load.");
  return summary;
};

export const discardInstall = discardPrepared;

/** Removes the extension, its files and its data from this profile. */
export const uninstallExtension = async (session: Electron.Session, id: string): Promise<void> => {
  const host = hosts.get(session);
  if (!host) return;
  for (const owned of host.ownedWindows.values()) if (owned.extensionId === id) owned.window.close();
  await removePackage(host.root, id, runtimeOf(session));
  host.ui.delete(id);
};

/** Opens an extension's toolbar popup for `tab`, below `anchor` (CSS pixels in the tab's window). */
export const openExtensionPopup = (tab: Electron.WebContents, id: string, anchor: PopupAnchor): void => {
  const host = hosts.get(tab.session);
  const window = windowOfTab(tab);
  if (!host || !host.session.extensions.getExtension(id)) throw new CrxError("That extension is not installed in this profile.");
  host.activeTab = tab;
  openPopup(host, id, window ? { window, rect: anchor } : undefined);
};

const CONTEXTS = (params: Electron.ContextMenuParams): ReadonlyArray<string> => [
  "all",
  params.isEditable ? "editable" : "page",
  ...(params.selectionText ? ["selection"] : []),
  ...(params.linkURL ? ["link"] : []),
  ...(params.mediaType === "image" ? ["image"] : []),
  ...(params.frameURL ? ["frame"] : []),
];

/** Context menu entries extensions registered for this tab, one submenu per extension. */
export const extensionContextMenu = (
  tab: Electron.WebContents,
  params: Electron.ContextMenuParams,
): Electron.MenuItemConstructorOptions[] => {
  const host = hosts.get(tab.session);
  if (!host) return [];
  const contexts = CONTEXTS(params);
  return host.session.extensions.getAllExtensions().flatMap((extension) => {
    const items = [...uiOf(host, extension.id).contextMenus.values()].filter(
      (item) =>
        item.visible !== false &&
        (item.contexts ?? ["page"]).some((context) => contexts.includes(context)) &&
        (item.documentUrlPatterns === undefined || item.documentUrlPatterns.some((pattern) => patternMatchesUrl(pattern, params.pageURL))),
    );
    const build = (parentId: string | undefined): Electron.MenuItemConstructorOptions[] =>
      items
        .filter((item) => item.parentId === parentId)
        .map((item) => {
          const children = build(item.id);
          return {
            label: (item.title ?? "").replace("%s", params.selectionText),
            enabled: item.enabled !== false,
            ...(children.length > 0
              ? { submenu: children }
              : {
                  click: () =>
                    emit(
                      host,
                      "contextMenus.onClicked",
                      (manifest) => [
                        {
                          menuItemId: item.id,
                          ...(item.parentId === undefined ? {} : { parentMenuItemId: item.parentId }),
                          editable: params.isEditable,
                          pageUrl: params.pageURL,
                          ...(params.frameURL ? { frameUrl: params.frameURL } : {}),
                          ...(params.selectionText ? { selectionText: params.selectionText } : {}),
                          ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
                          frameId: params.frame && !params.frame.isDestroyed() ? frameIdOf(tab, params.frame) : 0,
                        },
                        visibleTab(manifest, tabInfo(tab)),
                      ],
                      extension.id,
                    ),
                }),
          };
        });
    const top = build(undefined);
    return top.length === 0 ? [] : [{ label: extension.name, submenu: top }];
  });
};
