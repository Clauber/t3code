/**
 * The `chrome.*` methods Electron leaves out that store extensions such as
 * Bitwarden need, answered for one calling extension. Electron-free: the
 * browser it describes comes in through `ExtensionBrowser`, so the rules
 * (permission gates, which windows a caller may touch, what each extension
 * can see of a tab) are unit-tested without Electron.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EXTENSION_API_SURFACE } from "./ExtensionApiSurface.ts";
import {
  containsPermissions,
  patternMatchesUrl,
  type ExtensionIconPaths,
  type ExtensionManifest,
  type ExtensionTab,
  hasPermission,
  visibleTab,
} from "./ExtensionPolicy.ts";

export interface ExtensionCaller {
  readonly id: string;
  readonly manifest: ExtensionManifest;
}

export interface ExtensionFrame {
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly url: string;
  readonly processId: number;
}

export interface ExtensionWindow {
  readonly id: number;
  readonly focused: boolean;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly type: "normal" | "popup";
}

const MenuId = Schema.Union([Schema.String, Schema.Number]);
/** The `chrome.contextMenus` properties T3 renders; extension input is parsed here, never trusted. */
const ContextMenuProperties = Schema.Struct({
  id: Schema.optionalKey(MenuId),
  title: Schema.optionalKey(Schema.String),
  contexts: Schema.optionalKey(Schema.Array(Schema.String)),
  parentId: Schema.optionalKey(MenuId),
  documentUrlPatterns: Schema.optionalKey(Schema.Array(Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
  visible: Schema.optionalKey(Schema.Boolean),
});
const decodeContextMenuProperties = Schema.decodeUnknownOption(ContextMenuProperties);
type ContextMenuProperties = typeof ContextMenuProperties.Type;

export interface ContextMenuItem extends Omit<ContextMenuProperties, "id" | "parentId"> {
  readonly id: string;
  readonly parentId?: string;
}

const menuProperties = (value: unknown) => {
  const parsed = Option.getOrUndefined(decodeContextMenuProperties(value));
  if (!parsed) throw new ExtensionApiError("Invalid context menu properties.");
  const { id, parentId, ...rest } = parsed;
  return { ...rest, ...(parentId === undefined ? {} : { parentId: String(parentId) }), id };
};

/** What `ExtensionHost` knows about the profile's tabs and windows. */
export interface ExtensionBrowser {
  readonly tabs: () => ReadonlyArray<ExtensionTab & { readonly windowId: number }>;
  readonly activeTabId: () => number | undefined;
  readonly windows: () => ReadonlyArray<ExtensionWindow>;
  readonly lastFocusedWindowId: () => number | undefined;
  /** Windows this extension opened itself; the only ones it may change or close. */
  readonly ownsWindow: (extensionId: string, windowId: number) => boolean;
  readonly openExtensionWindow: (
    extensionId: string,
    url: string,
    size: { readonly width?: number; readonly height?: number },
  ) => ExtensionWindow;
  readonly focusWindow: (windowId: number) => void;
  readonly closeWindow: (windowId: number) => void;
  readonly frames: (tabId: number) => ReadonlyArray<ExtensionFrame> | null;
  readonly navigateTab: (tabId: number, url: string) => void;
  readonly setTabMuted: (tabId: number, muted: boolean) => void;
  readonly openPopup: (extensionId: string) => void;
  readonly showNotification: (
    extensionId: string,
    notificationId: string,
    options: { readonly title?: string; readonly message?: string },
  ) => void;
  readonly clearNotification: (extensionId: string, notificationId: string) => boolean;
}

export class ExtensionApiError extends Error {}

/** Per-extension state the API owns: toolbar action, menus, side panel options. */
export interface ExtensionUiState {
  readonly action: {
    badgeText: string;
    popup: string | undefined;
    title: string | undefined;
    /** Kept as given; Chrome hands back whatever color form was set. */
    badgeBackgroundColor: unknown;
    badgeTextColor: unknown;
    /** The icon `action.setIcon` last set by path; undefined keeps the manifest's. */
    iconPath: ExtensionIconPaths | undefined;
  };
  readonly contextMenus: Map<string, ContextMenuItem>;
  readonly sidePanel: { options: unknown; behavior: unknown };
}

export const emptyUiState = (): ExtensionUiState => ({
  action: { badgeText: "", popup: undefined, title: undefined, badgeBackgroundColor: [0, 0, 0, 0], badgeTextColor: undefined, iconPath: undefined },
  contextMenus: new Map(),
  sidePanel: { options: {}, behavior: { openPanelOnActionClick: false } },
});

type Handler = (
  args: ReadonlyArray<unknown>,
  caller: ExtensionCaller,
  state: ExtensionUiState,
) => unknown;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const requireString = (value: unknown, method: string): string => {
  if (typeof value !== "string") throw new ExtensionApiError(`${method} needs a string.`);
  return value;
};
/** The popup the toolbar button opens: one set at runtime, else the manifest's. */
export const popupOf = (caller: ExtensionCaller, state: ExtensionUiState): string =>
  state.action.popup ?? caller.manifest.action?.default_popup ?? "";
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;
const WINDOW_ID_CURRENT = EXTENSION_API_SURFACE.windows.constants.WINDOW_ID_CURRENT;

/** Which manifest permission or key a namespace needs, as in Chrome. */
const NAMESPACE_GATE: Readonly<Record<string, (manifest: ExtensionManifest) => boolean>> = {
  tabs: () => true,
  windows: () => true,
  permissions: () => true,
  commands: () => true,
  webNavigation: (manifest) => hasPermission(manifest, "webNavigation"),
  contextMenus: (manifest) => hasPermission(manifest, "contextMenus"),
  notifications: (manifest) => hasPermission(manifest, "notifications"),
  sidePanel: (manifest) => hasPermission(manifest, "sidePanel"),
  action: (manifest) => manifest.action !== undefined,
};

export const namespaceAllowed = (manifest: ExtensionManifest, namespace: string): boolean =>
  NAMESPACE_GATE[namespace]?.(manifest) ?? false;

export const createExtensionApi = (browser: ExtensionBrowser) => {
  let notificationCount = 0;
  const tabFor = (caller: ExtensionCaller, id: unknown) => {
    const tab = browser.tabs().find((candidate) => candidate.id === id);
    if (!tab) throw new ExtensionApiError(`No tab with id: ${String(id)}.`);
    return visibleTab(caller.manifest, withActive(tab));
  };
  const withActive = <T extends ExtensionTab>(tab: T) => {
    const active = tab.id === browser.activeTabId();
    return { ...tab, active, highlighted: active, selected: active };
  };
  const windowFor = (caller: ExtensionCaller, id: number | undefined, populate: boolean) => {
    const windowId = id === undefined || id === WINDOW_ID_CURRENT ? browser.lastFocusedWindowId() : id;
    const window = browser.windows().find((candidate) => candidate.id === windowId);
    if (!window) throw new ExtensionApiError(`No window with id: ${String(id)}.`);
    return populate
      ? {
          ...window,
          incognito: false,
          alwaysOnTop: false,
          state: "normal",
          tabs: browser
            .tabs()
            .filter((tab) => tab.windowId === window.id)
            .map((tab) => visibleTab(caller.manifest, withActive(tab))),
        }
      : { ...window, incognito: false, alwaysOnTop: false, state: "normal" };
  };
  const requireOwnedWindow = (caller: ExtensionCaller, windowId: unknown) => {
    if (typeof windowId !== "number" || !browser.ownsWindow(caller.id, windowId))
      throw new ExtensionApiError("Extensions can only change windows they opened.");
    return windowId;
  };
  const unsupported = (method: string) => () => {
    throw new ExtensionApiError(`${method} is not supported in T3 Code.`);
  };

  const methods: Readonly<Record<string, Handler>> = {
    "tabs.get": ([id], caller) => tabFor(caller, id),
    // Popups and extension windows are not tabs, as in Chrome.
    "tabs.getCurrent": () => undefined,
    "tabs.query": ([query], caller) => {
      const q = record(query);
      const windowId = optionalNumber(q.windowId);
      const focusedWindow = browser.lastFocusedWindowId();
      return browser
        .tabs()
        .map(withActive)
        .filter(
          (tab) =>
            (q.active === undefined || tab.active === q.active) &&
            (windowId === undefined ||
              tab.windowId === (windowId === WINDOW_ID_CURRENT ? focusedWindow : windowId)) &&
            ((q.currentWindow !== true && q.lastFocusedWindow !== true) || tab.windowId === focusedWindow) &&
            (q.url === undefined ||
              // URL filters need the same access that reveals a tab's URL.
              ("url" in visibleTab(caller.manifest, tab) &&
                [q.url].flat().some((pattern) => typeof pattern === "string" && patternMatchesUrl(pattern, tab.url)))),
        )
        .map((tab) => visibleTab(caller.manifest, tab));
    },
    "tabs.update": ([first, second], caller) => {
      const [tabId, props] =
        typeof first === "number" ? [first, record(second)] : [browser.activeTabId(), record(first)];
      const extra = Object.keys(props).filter((key) => key !== "url" && key !== "muted" && key !== "active");
      if (extra.length > 0) throw new ExtensionApiError(`tabs.update cannot change ${extra.join(", ")} in T3 Code.`);
      if (tabId === undefined) throw new ExtensionApiError("No active tab.");
      tabFor(caller, tabId);
      // T3 decides which tab shows; only the tab that already does can be "activated".
      if (props.active !== undefined && !(props.active === true && tabId === browser.activeTabId()))
        throw new ExtensionApiError("tabs.update cannot switch the active tab in T3 Code.");
      if (typeof props.url === "string") {
        if (!/^https?:\/\//.test(props.url) && !props.url.startsWith(`chrome-extension://${caller.id}/`))
          throw new ExtensionApiError("tabs.update can only open web pages or this extension's own pages.");
        browser.navigateTab(tabId, props.url);
      }
      if (typeof props.muted === "boolean") browser.setTabMuted(tabId, props.muted);
      return tabFor(caller, tabId);
    },
    "tabs.create": unsupported("tabs.create"),
    "tabs.remove": unsupported("tabs.remove"),
    "tabs.duplicate": unsupported("tabs.duplicate"),
    "tabs.move": unsupported("tabs.move"),
    "tabs.highlight": unsupported("tabs.highlight"),
    "windows.get": ([id, options], caller) =>
      windowFor(caller, optionalNumber(id), record(options).populate === true),
    "windows.getCurrent": ([options], caller) => windowFor(caller, undefined, record(options).populate === true),
    "windows.getLastFocused": ([options], caller) =>
      windowFor(caller, undefined, record(options).populate === true),
    "windows.getAll": ([options], caller) =>
      browser.windows().map((window) => windowFor(caller, window.id, record(options).populate === true)),
    "windows.create": ([data], caller) => {
      const d = record(data);
      const url = [d.url].flat()[0];
      const origin = `chrome-extension://${caller.id}/`;
      const href = typeof url === "string" ? new URL(url, origin).href : "";
      const width = optionalNumber(d.width);
      const height = optionalNumber(d.height);
      // Only the caller's own pages: a web page would need a real browser tab.
      if (!href.startsWith(origin))
        throw new ExtensionApiError("windows.create can only open this extension's own pages in T3 Code.");
      return browser.openExtensionWindow(caller.id, href, {
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      });
    },
    "windows.update": ([id, props], caller) => {
      const windowId = requireOwnedWindow(caller, id);
      if (record(props).focused === true) browser.focusWindow(windowId);
      return windowFor(caller, windowId, false);
    },
    "windows.remove": ([id], caller) => {
      browser.closeWindow(requireOwnedWindow(caller, id));
    },
    "webNavigation.getAllFrames": ([details]) => browser.frames(Number(record(details).tabId)),
    "webNavigation.getFrame": ([details]) => {
      const d = record(details);
      return browser.frames(Number(d.tabId))?.find((frame) => frame.frameId === d.frameId) ?? null;
    },
    // shortcut: icons set as imageData are ignored (the manifest icon stays); add when an extension needs it.
    "action.setIcon": ([details], _caller, state) => {
      const path = record(details).path;
      if (typeof path === "string" || (typeof path === "object" && path !== null && Object.values(path).every((value) => typeof value === "string")))
        state.action.iconPath = path as ExtensionIconPaths;
    },
    "action.setBadgeText": ([details], _caller, state) => {
      state.action.badgeText = requireString(record(details).text ?? "", "action.setBadgeText");
    },
    "action.getBadgeText": (_args, _caller, state) => state.action.badgeText,
    "action.setBadgeBackgroundColor": ([details], _caller, state) => {
      state.action.badgeBackgroundColor = record(details).color;
    },
    "action.getBadgeBackgroundColor": (_args, _caller, state) => state.action.badgeBackgroundColor,
    "action.setBadgeTextColor": ([details], _caller, state) => {
      state.action.badgeTextColor = record(details).color;
    },
    "action.setTitle": ([details], _caller, state) => {
      state.action.title = requireString(record(details).title, "action.setTitle");
    },
    "action.getTitle": (_args, caller, state) =>
      state.action.title ?? caller.manifest.action?.default_title ?? caller.manifest.name ?? "",
    "action.setPopup": ([details], _caller, state) => {
      state.action.popup = requireString(record(details).popup, "action.setPopup");
    },
    "action.getPopup": (_args, caller, state) => popupOf(caller, state),
    "action.openPopup": (_args, caller) => {
      browser.openPopup(caller.id);
    },
    "action.enable": unsupported("action.enable"),
    "action.disable": unsupported("action.disable"),
    "action.getUserSettings": () => ({ isOnToolbar: true }),
    "contextMenus.create": ([properties], _caller, state) => {
      const { id, ...item } = menuProperties(properties);
      const itemId = id === undefined ? String(state.contextMenus.size + 1) : String(id);
      state.contextMenus.set(itemId, { ...item, id: itemId });
      return id ?? itemId;
    },
    "contextMenus.update": ([id, properties], _caller, state) => {
      const existing = state.contextMenus.get(String(id));
      if (!existing) throw new ExtensionApiError(`Cannot find menu item with id ${String(id)}`);
      const { id: _ignored, ...changes } = menuProperties(properties);
      state.contextMenus.set(existing.id, { ...existing, ...changes });
    },
    "contextMenus.remove": ([id], _caller, state) => {
      if (!state.contextMenus.delete(String(id)))
        throw new ExtensionApiError(`Cannot find menu item with id ${String(id)}`);
    },
    "contextMenus.removeAll": (_args, _caller, state) => {
      state.contextMenus.clear();
    },
    "notifications.create": ([first, second], caller) => {
      const [notificationId, options] =
        typeof first === "string" ? [first, record(second)] : [`notification-${++notificationCount}`, record(first)];
      browser.showNotification(caller.id, notificationId, {
        ...(typeof options.title === "string" ? { title: options.title } : {}),
        ...(typeof options.message === "string" ? { message: options.message } : {}),
      });
      return notificationId;
    },
    "notifications.clear": ([id], caller) => browser.clearNotification(caller.id, String(id)),
    "notifications.getPermissionLevel": () => "granted",
    "permissions.contains": ([request], caller) => containsPermissions(caller.manifest, record(request)),
    "permissions.getAll": (_args, caller) => ({
      permissions: caller.manifest.permissions ?? [],
      origins: caller.manifest.host_permissions ?? [],
    }),
    // T3 grants no optional permissions; Chrome reports a refused request as false.
    "permissions.request": () => false,
    "permissions.remove": () => false,
    "commands.getAll": (_args, caller) =>
      Object.entries(caller.manifest.commands ?? {}).map(([name, command]) => ({
        name,
        description: command.description ?? "",
        shortcut: command.suggested_key?.mac ?? command.suggested_key?.default ?? "",
      })),
    "sidePanel.setOptions": ([options], _caller, state) => {
      state.sidePanel.options = options;
    },
    "sidePanel.getOptions": (_args, _caller, state) => state.sidePanel.options,
    "sidePanel.setPanelBehavior": ([behavior], _caller, state) => {
      state.sidePanel.behavior = behavior;
    },
    "sidePanel.getPanelBehavior": (_args, _caller, state) => state.sidePanel.behavior,
    "sidePanel.open": unsupported("sidePanel.open"),
  };

  return (method: string, args: ReadonlyArray<unknown>, caller: ExtensionCaller, state: ExtensionUiState): unknown => {
    const handler = methods[method];
    const namespace = method.split(".")[0] ?? "";
    if (!handler) throw new ExtensionApiError(`${method} is not supported in T3 Code.`);
    if (!namespaceAllowed(caller.manifest, namespace))
      throw new ExtensionApiError(`This extension has no permission for chrome.${namespace}.`);
    return handler(args, caller, state);
  };
};
