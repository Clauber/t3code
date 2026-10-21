import { describe, expect, it } from "vite-plus/test";

import {
  createExtensionApi,
  emptyUiState,
  type ExtensionBrowser,
  type ExtensionCaller,
  type ExtensionWindow,
} from "./ExtensionApi.ts";

const MAIN_WINDOW: ExtensionWindow = { id: 1, focused: true, top: 0, left: 0, width: 1200, height: 800, type: "normal" };

const makeBrowser = () => {
  const owned = new Map<number, string>();
  const closed: number[] = [];
  const navigated: Array<[number, string]> = [];
  let nextWindowId = 100;
  const browser: ExtensionBrowser = {
    tabs: () => [
      { id: 7, url: "https://example.com/login", title: "Log in", windowId: 1 },
      { id: 8, url: "https://other.test/", title: "Other", windowId: 1 },
    ],
    activeTabId: () => 7,
    windows: () => [MAIN_WINDOW, ...[...owned.keys()].map((id) => ({ ...MAIN_WINDOW, id, type: "popup" as const }))],
    lastFocusedWindowId: () => 1,
    ownsWindow: (extensionId, windowId) => owned.get(windowId) === extensionId,
    openExtensionWindow: (extensionId) => {
      const id = nextWindowId++;
      owned.set(id, extensionId);
      return { ...MAIN_WINDOW, id, type: "popup" };
    },
    focusWindow: () => undefined,
    closeWindow: (id) => {
      closed.push(id);
      owned.delete(id);
    },
    frames: () => [{ frameId: 0, parentFrameId: -1, url: "https://example.com/login", processId: 3 }],
    navigateTab: (tabId, url) => navigated.push([tabId, url]),
    setTabMuted: () => undefined,
    openPopup: () => undefined,
    showNotification: () => undefined,
    clearNotification: () => true,
  };
  return { browser, closed, navigated };
};

const bitwarden: ExtensionCaller = {
  id: "nngceckbapebfimnlniiiahkandclblb",
  manifest: {
    permissions: ["tabs", "webNavigation", "contextMenus", "storage"],
    host_permissions: ["https://*/*", "http://*/*"],
    action: { default_popup: "popup/index.html" },
  },
};
const other: ExtensionCaller = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", manifest: {} };

describe("ExtensionApi", () => {
  it("keeps the icon an extension sets by path and ignores other forms", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    const state = emptyUiState();
    call("action.setIcon", [{ path: { "19": "locked19.png", "38": "locked38.png" } }], bitwarden, state);
    expect(state.action.iconPath).toEqual({ "19": "locked19.png", "38": "locked38.png" });
    call("action.setIcon", [{ imageData: {} }], bitwarden, state);
    expect(state.action.iconPath).toEqual({ "19": "locked19.png", "38": "locked38.png" });
    call("action.setIcon", [{ path: "unlocked.png" }], bitwarden, state);
    expect(state.action.iconPath).toBe("unlocked.png");
  });

  it("answers the tab and frame queries Bitwarden makes", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    const state = emptyUiState();
    expect(call("tabs.query", [{ active: true, currentWindow: true }], bitwarden, state)).toEqual([
      expect.objectContaining({ id: 7, url: "https://example.com/login", active: true }),
    ]);
    expect(call("tabs.getCurrent", [], bitwarden, state)).toBeUndefined();
    expect(call("webNavigation.getAllFrames", [{ tabId: 7 }], bitwarden, state)).toEqual([
      expect.objectContaining({ frameId: 0, parentFrameId: -1 }),
    ]);
  });

  it("hides tab URLs from extensions without access, including through URL filters", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    const tab = call("tabs.get", [7], other, emptyUiState());
    expect(tab).not.toHaveProperty("url");
    expect(tab).not.toHaveProperty("title");
    expect(call("tabs.query", [{ url: "https://example.com/*" }], other, emptyUiState())).toEqual([]);
  });

  it("refuses namespaces the manifest did not ask for", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    expect(() => call("webNavigation.getAllFrames", [{ tabId: 7 }], other, emptyUiState())).toThrow(/permission/);
    expect(() => call("contextMenus.create", [{ id: "x" }], other, emptyUiState())).toThrow(/permission/);
    expect(() => call("action.openPopup", [], other, emptyUiState())).toThrow(/permission/);
    expect(() => call("debugger.attach", [], bitwarden, emptyUiState())).toThrow(/not supported/);
  });

  it("does not pretend to create or remove tabs", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    expect(() => call("tabs.create", [{ url: "https://example.com" }], bitwarden, emptyUiState())).toThrow(
      /not supported/,
    );
    expect(() => call("tabs.remove", [7], bitwarden, emptyUiState())).toThrow(/not supported/);
  });

  it("only lets an extension change or close windows it opened", () => {
    const { browser, closed } = makeBrowser();
    const call = createExtensionApi(browser);
    expect(() => call("windows.remove", [MAIN_WINDOW.id], bitwarden, emptyUiState())).toThrow(/windows they opened/);
    const popout = call("windows.create", [{ url: "popup/index.html?uilocation=popout" }], bitwarden, emptyUiState());
    const popoutId = (popout as ExtensionWindow).id;
    expect(() => call("windows.remove", [popoutId], other, emptyUiState())).toThrow(/windows they opened/);
    expect(() => call("windows.update", [popoutId, { focused: true }], other, emptyUiState())).toThrow(
      /windows they opened/,
    );
    call("windows.remove", [popoutId], bitwarden, emptyUiState());
    expect(closed).toEqual([popoutId]);
  });

  it("opens only the caller's own pages in extension windows", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    expect(() => call("windows.create", [{ url: "https://example.com" }], bitwarden, emptyUiState())).toThrow();
    expect(() =>
      call("windows.create", [{ url: `chrome-extension://${other.id}/page.html` }], bitwarden, emptyUiState()),
    ).toThrow();
  });

  it("navigates tabs only to web pages or the caller's own pages", () => {
    const { browser, navigated } = makeBrowser();
    const call = createExtensionApi(browser);
    expect(() => call("tabs.update", [7, { url: "javascript:alert(1)" }], bitwarden, emptyUiState())).toThrow();
    expect(() => call("tabs.update", [7, { pinned: true }], bitwarden, emptyUiState())).toThrow(/pinned/);
    call("tabs.update", [7, { url: "https://example.com/next" }], bitwarden, emptyUiState());
    expect(navigated).toEqual([[7, "https://example.com/next"]]);
    expect(() => call("tabs.update", [8, { active: true }], bitwarden, emptyUiState())).toThrow(/active tab/);
    expect(() => call("tabs.update", [7, { active: false }], bitwarden, emptyUiState())).toThrow(/active tab/);
    expect(call("tabs.update", [7, { active: true }], bitwarden, emptyUiState())).toEqual(
      expect.objectContaining({ id: 7, active: true }),
    );
  });

  it("keeps context menu items per extension state", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    const state = emptyUiState();
    call("contextMenus.create", [{ id: "autofill", title: "Autofill", contexts: ["all"] }], bitwarden, state);
    expect([...state.contextMenus.keys()]).toEqual(["autofill"]);
    expect(() => call("contextMenus.remove", ["missing"], bitwarden, state)).toThrow(/Cannot find/);
    call("contextMenus.removeAll", [], bitwarden, state);
    expect(state.contextMenus.size).toBe(0);
  });

  it("refuses malformed menu and action input instead of storing it", () => {
    const { browser } = makeBrowser();
    const call = createExtensionApi(browser);
    const state = emptyUiState();
    expect(() => call("contextMenus.create", [{ id: "x", title: 42 }], bitwarden, state)).toThrow(/Invalid context menu/);
    expect(() => call("contextMenus.create", [{ id: "x", contexts: "all" }], bitwarden, state)).toThrow(/Invalid context menu/);
    expect(state.contextMenus.size).toBe(0);
    expect(() => call("action.setBadgeText", [{ text: 3 }], bitwarden, state)).toThrow(/string/);
    expect(call("action.getBadgeText", [], bitwarden, state)).toBe("");
    call("contextMenus.create", [{ id: 7, parentId: 1, title: "Fill" }], bitwarden, state);
    expect(state.contextMenus.get("7")).toEqual({ id: "7", parentId: "1", title: "Fill" });
  });
});
