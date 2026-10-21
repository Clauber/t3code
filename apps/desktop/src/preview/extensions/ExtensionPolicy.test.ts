import { describe, expect, it } from "vite-plus/test";

import {
  commandForShortcut,
  containsPermissions,
  hasHostAccess,
  patternMatchesUrl,
  permissionWarnings,
  toolbarIconPath,
  unsupportedPermissions,
  visibleTab,
  webStoreExtensionId,
  type ExtensionManifest,
} from "./ExtensionPolicy.ts";

const BITWARDEN_ID = "nngceckbapebfimnlniiiahkandclblb";
const allSites: ExtensionManifest = { host_permissions: ["https://*/*", "http://*/*"] };

describe("webStoreExtensionId", () => {
  it("reads the id from Chrome Web Store listings only", () => {
    expect(
      webStoreExtensionId(
        `https://chromewebstore.google.com/detail/bitwarden-password-manager/${BITWARDEN_ID}?hl=en`,
      ),
    ).toBe(BITWARDEN_ID);
    expect(webStoreExtensionId(`https://chrome.google.com/webstore/detail/x/${BITWARDEN_ID}`)).toBe(
      BITWARDEN_ID,
    );
    expect(webStoreExtensionId(`http://chromewebstore.google.com/detail/x/${BITWARDEN_ID}`)).toBeNull();
    expect(webStoreExtensionId(`https://chromewebstore.google.com.evil.test/detail/x/${BITWARDEN_ID}`)).toBeNull();
    expect(webStoreExtensionId("https://chromewebstore.google.com/detail/x/NOT-AN-ID")).toBeNull();
    expect(webStoreExtensionId("https://chromewebstore.google.com/")).toBeNull();
  });
});

describe("match patterns", () => {
  it("lets the * scheme reach only http and https", () => {
    expect(patternMatchesUrl("*://*/*", "https://example.com/")).toBe(true);
    expect(patternMatchesUrl("*://*/*", "ws://example.com/")).toBe(false);
    expect(patternMatchesUrl("*://*/*", "file:///etc/passwd")).toBe(false);
  });

  it("matches every port unless one is given", () => {
    expect(patternMatchesUrl("http://localhost/*", "http://localhost:3000/a")).toBe(true);
    expect(patternMatchesUrl("http://localhost:*/*", "http://localhost:3000/a")).toBe(true);
    expect(patternMatchesUrl("http://localhost:3000/*", "http://localhost:3000/a")).toBe(true);
    expect(patternMatchesUrl("http://localhost:3000/*", "http://localhost:3001/a")).toBe(false);
    expect(patternMatchesUrl("https://example.com:443/*", "https://example.com/")).toBe(true);
  });

  it("matches subdomain wildcards without matching lookalike hosts", () => {
    expect(patternMatchesUrl("https://*.example.com/*", "https://a.b.example.com/")).toBe(true);
    expect(patternMatchesUrl("https://*.example.com/*", "https://example.com/")).toBe(true);
    expect(patternMatchesUrl("https://*.example.com/*", "https://badexample.com/")).toBe(false);
  });

  it("keeps the path for content-script style matching", () => {
    expect(patternMatchesUrl("https://example.com/foo*", "https://example.com/foobar")).toBe(true);
    expect(patternMatchesUrl("https://example.com/foo*", "https://example.com/bar")).toBe(false);
  });
});

describe("host access", () => {
  it("ignores the path of host permissions", () => {
    expect(hasHostAccess({ host_permissions: ["https://example.com/only/*"] }, "https://example.com/other")).toBe(
      true,
    );
  });

  it("never grants file URLs, even to <all_urls>", () => {
    expect(hasHostAccess({ host_permissions: ["<all_urls>"] }, "file:///Users/me/secret.txt")).toBe(false);
    expect(hasHostAccess({ host_permissions: ["file:///*"] }, "file:///Users/me/secret.txt")).toBe(false);
  });

  it("denies hosts outside the grant", () => {
    expect(hasHostAccess({ host_permissions: ["https://example.com/*"] }, "https://other.test/")).toBe(false);
    expect(hasHostAccess({}, "https://example.com/")).toBe(false);
  });
});

describe("permissions.contains", () => {
  const manifest: ExtensionManifest = { permissions: ["storage", "tabs"], host_permissions: ["https://*/*"] };

  it("reports granted permissions and covered origins", () => {
    expect(containsPermissions(manifest, { permissions: ["storage"], origins: ["https://example.com/*"] })).toBe(true);
  });

  it("does not treat origins outside the grant as granted", () => {
    expect(containsPermissions(manifest, { origins: ["http://example.com/*"] })).toBe(false);
    expect(containsPermissions(manifest, { origins: ["<all_urls>"] })).toBe(false);
    expect(containsPermissions(manifest, { origins: ["file:///*"] })).toBe(false);
    expect(containsPermissions({ host_permissions: ["https://example.com:8443/*"] }, { origins: ["https://example.com/*"] })).toBe(false);
  });

  it("does not report optional or missing permissions as granted", () => {
    expect(containsPermissions({ ...manifest, optional_permissions: ["privacy"] }, { permissions: ["privacy"] })).toBe(
      false,
    );
    expect(containsPermissions(manifest, { permissions: ["nativeMessaging"] })).toBe(false);
    expect(containsPermissions(manifest, { permissions: "storage" })).toBe(false);
    expect(containsPermissions(manifest, { permissions: [42] })).toBe(false);
  });
});

describe("visibleTab", () => {
  const tab = { id: 7, url: "https://example.com/login", title: "Log in", windowId: 1 };

  it("hides URL and title from extensions without tabs or host access", () => {
    expect(visibleTab({}, tab)).toEqual({ id: 7, windowId: 1 });
    expect(visibleTab({ host_permissions: ["https://other.test/*"] }, tab)).toEqual({ id: 7, windowId: 1 });
  });

  it("shows them with the tabs permission or host access", () => {
    expect(visibleTab({ permissions: ["tabs"] }, tab)).toEqual(tab);
    expect(visibleTab(allSites, tab)).toEqual(tab);
  });

  it("hides file URLs from host-only access", () => {
    expect(visibleTab({ host_permissions: ["<all_urls>"] }, { ...tab, url: "file:///Users/me/a.txt" })).toEqual({
      id: 7,
      windowId: 1,
    });
  });
});

describe("install prompt", () => {
  it("uses Chrome's warnings and lists APIs T3 lacks", () => {
    const manifest: ExtensionManifest = {
      permissions: ["tabs", "webNavigation", "clipboardRead", "notifications", "sidePanel", "storage"],
      host_permissions: ["https://*/*", "http://*/*"],
      optional_permissions: ["nativeMessaging"],
    };
    expect(permissionWarnings(manifest)).toEqual([
      "Read and change all your data on all websites",
      "Read your browsing history",
      "Read data you copy and paste",
      "Display notifications",
    ]);
    expect(unsupportedPermissions(manifest)).toEqual(["sidePanel"]);
  });

  it("names a single site", () => {
    expect(permissionWarnings({ host_permissions: ["https://example.com/*"] })).toEqual([
      "Read and change your data on example.com",
    ]);
  });
});

describe("commandForShortcut", () => {
  const manifest: ExtensionManifest = {
    commands: {
      autofill_login: { suggested_key: { default: "Ctrl+Shift+L" } },
      generate_password: { suggested_key: { default: "Ctrl+Shift+9", mac: "MacCtrl+Shift+9" } },
    },
  };
  const press = (key: string, modifiers: Partial<Record<"meta" | "control" | "alt" | "shift", boolean>>) => ({
    key,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...modifiers,
  });

  it("maps Ctrl to Command on macOS and MacCtrl to Control", () => {
    expect(commandForShortcut(manifest, "darwin", press("L", { meta: true, shift: true }))).toBe("autofill_login");
    expect(commandForShortcut(manifest, "darwin", press("L", { control: true, shift: true }))).toBeNull();
    expect(commandForShortcut(manifest, "darwin", press("9", { control: true, shift: true }))).toBe(
      "generate_password",
    );
    expect(commandForShortcut(manifest, "linux", press("l", { control: true, shift: true }))).toBe("autofill_login");
  });
});

describe("toolbar icon", () => {
  it("prefers what the extension set, then the action default, then its icons, sized like Chrome", () => {
    const manifest: ExtensionManifest = {
      icons: { "16": "i16.png", "128": "i128.png" },
      action: { default_icon: { "19": "a19.png", "38": "a38.png", "48": "a48.png" } },
    };
    expect(toolbarIconPath(manifest)).toBe("a38.png");
    expect(toolbarIconPath({ icons: manifest.icons })).toBe("i128.png");
    expect(toolbarIconPath({ icons: { "16": "only16.png" } })).toBe("only16.png");
    expect(toolbarIconPath(manifest, "locked.png")).toBe("locked.png");
    expect(toolbarIconPath(manifest, { "32": "set32.png", "64": "set64.png" })).toBe("set32.png");
    expect(toolbarIconPath({})).toBeUndefined();
  });
});
