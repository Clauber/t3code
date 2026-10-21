/**
 * Electron-free rules for Chrome Web Store extensions in preview profiles:
 * which store pages can install, what the user is warned about, and which
 * tab data each extension may see. Kept pure so it is testable without
 * Electron; `ExtensionHost.ts` applies it.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Strings = Schema.Array(Schema.String);

/** Chrome's format: one to four dot-separated integers 0..65535 without leading zeros. */
export const ExtensionVersion = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/),
  Schema.makeFilter((version: string) => version.split(".").every((part) => Number(part) <= 65_535)),
);

/** The manifest fields T3 reads; anything else in a manifest is left to Electron. */
export const ExtensionManifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(ExtensionVersion),
  manifest_version: Schema.optionalKey(Schema.Number),
  default_locale: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})*$/))),
  permissions: Schema.optionalKey(Strings),
  optional_permissions: Schema.optionalKey(Strings),
  host_permissions: Schema.optionalKey(Strings),
  icons: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  action: Schema.optionalKey(
    Schema.Struct({
      default_popup: Schema.optionalKey(Schema.String),
      default_title: Schema.optionalKey(Schema.String),
      default_icon: Schema.optionalKey(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
    }),
  ),
  commands: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.optionalKey(Schema.String),
        suggested_key: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  ),
});
export type ExtensionManifest = typeof ExtensionManifest.Type;

/** What an installable package must declare. */
export const InstallableManifest = Schema.Struct({
  ...ExtensionManifest.fields,
  name: Schema.String,
  version: ExtensionVersion,
});
export type InstallableManifest = typeof InstallableManifest.Type;

export const decodeInstallableManifest = Schema.decodeUnknownOption(InstallableManifest);
const decodeManifest = Schema.decodeUnknownOption(ExtensionManifest);
/** A loaded extension's manifest as policy sees it; malformed fields grant nothing. */
export const manifestPolicy = (manifest: unknown): ExtensionManifest =>
  Option.getOrElse(decodeManifest(manifest), () => ({}));

const EXTENSION_ID = /^[a-p]{32}$/;

/** The extension id of a Chrome Web Store listing, or null for any other page. */
export const webStoreExtensionId = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const id =
    parsed.protocol === "https:" && parsed.hostname === "chromewebstore.google.com"
      ? segments[0] === "detail"
        ? segments.at(-1)
        : undefined
      : parsed.protocol === "https:" &&
          parsed.hostname === "chrome.google.com" &&
          segments[0] === "webstore" &&
          segments[1] === "detail"
        ? segments.at(-1)
        : undefined;
  return id !== undefined && EXTENSION_ID.test(id) ? id : null;
};

interface MatchPattern {
  readonly schemes: ReadonlyArray<string>;
  /** `*` for any host, `*.example.com` for the domain and its subdomains. */
  readonly host: string;
  /** Undefined or `*` match every port, as Chrome does. */
  readonly port: string | undefined;
  readonly path: RegExp;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: "80", https: "443", ws: "80", wss: "443", ftp: "21" };
const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
export const parseMatchPattern = (pattern: string): MatchPattern | null => {
  if (pattern === "<all_urls>")
    return { schemes: ["http", "https", "ws", "wss", "ftp", "file"], host: "*", port: undefined, path: /^\/.*$/ };
  const match = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/*:]+|[^/*:]*)(?::(\*|\d+))?(\/.*)$/.exec(pattern);
  if (!match) return null;
  const [, scheme, host, port, path] = match;
  if (scheme === undefined || host === undefined || path === undefined) return null;
  if ((scheme === "file") !== (host === "")) return null;
  return {
    schemes: scheme === "*" ? ["http", "https"] : [scheme],
    host: host.toLowerCase(),
    port,
    path: new RegExp(`^${path.split("*").map(escapeRegExp).join(".*")}$`),
  };
};

const hostMatches = (patternHost: string, host: string): boolean =>
  patternHost === "*" ||
  patternHost === host ||
  (patternHost.startsWith("*.") &&
    (host === patternHost.slice(2) || host.endsWith(patternHost.slice(1))));

const originMatches = (pattern: MatchPattern, target: URL): boolean => {
  const scheme = target.protocol.slice(0, -1);
  return (
    pattern.schemes.includes(scheme) &&
    hostMatches(pattern.host, target.hostname.toLowerCase()) &&
    (pattern.port === undefined ||
      pattern.port === "*" ||
      pattern.port === (target.port || DEFAULT_PORTS[scheme]))
  );
};

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** Content-script style match: scheme, host, port and path. */
export const patternMatchesUrl = (pattern: string, url: string): boolean => {
  const parsed = parseMatchPattern(pattern);
  const target = parseUrl(url);
  return (
    parsed !== null &&
    target !== null &&
    originMatches(parsed, target) &&
    parsed.path.test(target.pathname + target.search)
  );
};

/** True when every origin `requested` reaches is also reached by `granted`; host permissions ignore paths. */
export const patternCovers = (granted: string, requested: string): boolean => {
  const g = parseMatchPattern(granted);
  const r = parseMatchPattern(requested);
  if (!g || !r || r.schemes.includes("file")) return false;
  const hostCovered =
    g.host === "*" ||
    (r.host !== "*" &&
      (r.host.startsWith("*.")
        ? g.host.startsWith("*.") && hostMatches(g.host, r.host.slice(2))
        : hostMatches(g.host, r.host)));
  const portCovered = g.port === undefined || g.port === "*" || g.port === r.port;
  return r.schemes.every((scheme) => g.schemes.includes(scheme)) && hostCovered && portCovered;
};

const hostPermissions = (manifest: ExtensionManifest): ReadonlyArray<string> => [
  ...(manifest.host_permissions ?? []),
  // Manifest V2 listed host patterns under `permissions`.
  ...(manifest.permissions ?? []).filter((entry) => parseMatchPattern(entry) !== null),
];

/**
 * Host permissions ignore the path. File URLs need a manual per-profile grant
 * in Chrome; T3 offers none, so file access is always denied (and extensions
 * load without Electron's `allowFileAccess`).
 */
export const hasHostAccess = (manifest: ExtensionManifest, url: string): boolean => {
  const target = parseUrl(url);
  if (!target || target.protocol === "file:") return false;
  return hostPermissions(manifest).some((pattern) => {
    const parsed = parseMatchPattern(pattern);
    return parsed !== null && originMatches(parsed, target);
  });
};

export const hasPermission = (manifest: ExtensionManifest, permission: string): boolean =>
  (manifest.permissions ?? []).includes(permission);

/** `chrome.permissions.contains`: only what the manifest granted; T3 grants no optional permissions. */
export const containsPermissions = (
  manifest: ExtensionManifest,
  request: { readonly permissions?: unknown; readonly origins?: unknown },
): boolean => {
  const list = (value: unknown) => (value === undefined ? [] : Array.isArray(value) ? value : null);
  const permissions = list(request.permissions);
  const origins = list(request.origins);
  if (permissions === null || origins === null) return false;
  return (
    permissions.every((permission) => typeof permission === "string" && hasPermission(manifest, permission)) &&
    origins.every(
      (origin) =>
        typeof origin === "string" &&
        hostPermissions(manifest).some((granted) => patternCovers(granted, origin)),
    )
  );
};

export interface ExtensionTab {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly [key: string]: unknown;
}

/** Chrome only shows a tab's URL and title to extensions holding `tabs` or host access to it. */
export const visibleTab = <T extends ExtensionTab>(manifest: ExtensionManifest, tab: T): T | Omit<T, "url" | "title"> => {
  if (hasPermission(manifest, "tabs") || hasHostAccess(manifest, tab.url)) return tab;
  const { url: _url, title: _title, ...rest } = tab;
  return rest;
};

/**
 * APIs an installed extension can actually use here: Electron's own, plus the
 * ones `ExtensionHost` provides. Anything else is listed as unavailable in the
 * install prompt instead of failing silently later.
 */
const SUPPORTED_PERMISSIONS = new Set([
  "activeTab",
  "alarms",
  "clipboardRead",
  "clipboardWrite",
  "contextMenus",
  "idle",
  "notifications",
  "offscreen",
  "scripting",
  "storage",
  "tabs",
  "unlimitedStorage",
  "webNavigation",
  "webRequest",
  "webRequestAuthProvider",
]);

export const unsupportedPermissions = (manifest: ExtensionManifest): ReadonlyArray<string> =>
  (manifest.permissions ?? []).filter(
    (permission) => !SUPPORTED_PERMISSIONS.has(permission) && parseMatchPattern(permission) === null,
  );

// Chrome's own wording: https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
const PERMISSION_WARNINGS: Readonly<Record<string, string>> = {
  bookmarks: "Read and change your bookmarks",
  clipboardRead: "Read data you copy and paste",
  clipboardWrite: "Modify data you copy and paste",
  contentSettings:
    "Change your settings that control websites' access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc.",
  debugger: "Access the page debugger backend",
  declarativeNetRequest: "Block content on any page",
  desktopCapture: "Capture content of your screen",
  downloads: "Manage your downloads",
  geolocation: "Detect your physical location",
  history: "Read and change your browsing history on all your signed-in devices",
  management: "Manage your apps, extensions, and themes",
  nativeMessaging: "Communicate with cooperating native applications",
  notifications: "Display notifications",
  privacy: "Change your privacy-related settings",
  tabs: "Read your browsing history",
  topSites: "Read a list of your most frequently visited websites",
  webNavigation: "Read your browsing history",
};

export const permissionWarnings = (manifest: ExtensionManifest): ReadonlyArray<string> => {
  const hosts = hostPermissions(manifest);
  const allSites = hosts.some((pattern) => parseMatchPattern(pattern)?.host === "*");
  const named = [...new Set(hosts.map((pattern) => parseMatchPattern(pattern)?.host).filter((host) => host !== undefined && host !== "*"))];
  const hostWarning = allSites
    ? "Read and change all your data on all websites"
    : named.length === 1
      ? `Read and change your data on ${named[0]}`
      : named.length > 1
        ? `Read and change your data on ${named.length} websites`
        : null;
  return [
    ...new Set([
      ...(hostWarning === null ? [] : [hostWarning]),
      ...(manifest.permissions ?? []).flatMap((permission) => PERMISSION_WARNINGS[permission] ?? []),
    ]),
  ];
};

export interface ShortcutInput {
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/**
 * The manifest command whose suggested key is this keystroke on `platform`.
 * Chrome maps `Ctrl` to Command on macOS and `MacCtrl` to Control.
 */
export const commandForShortcut = (
  manifest: ExtensionManifest,
  platform: NodeJS.Platform,
  input: ShortcutInput,
): string | null => {
  const platformKey = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  for (const [name, command] of Object.entries(manifest.commands ?? {})) {
    const shortcut = command.suggested_key?.[platformKey] ?? command.suggested_key?.default;
    if (!shortcut) continue;
    const parts = shortcut.split("+");
    const key = parts.at(-1)?.toLowerCase();
    const modifiers = new Set(parts.slice(0, -1));
    const wantsMeta = modifiers.has("Command") || (platform === "darwin" && modifiers.has("Ctrl"));
    const wantsControl = modifiers.has("MacCtrl") || (platform !== "darwin" && modifiers.has("Ctrl"));
    if (
      key === input.key.toLowerCase() &&
      wantsMeta === input.meta &&
      wantsControl === input.control &&
      modifiers.has("Alt") === input.alt &&
      modifiers.has("Shift") === input.shift
    )
      return name;
  }
  return null;
};

/** An icon as a manifest or `action.setIcon` gives it: one path, or paths by pixel size. */
export type ExtensionIconPaths = string | Readonly<Record<string, string>>;

const TOOLBAR_ICON_SIZE = 32;

/**
 * The toolbar icon's path inside the package, as Chrome picks it: what the extension last set, else
 * the action's default, else its general icons; by size, the smallest at least 32px, else the largest.
 */
export const toolbarIconPath = (manifest: ExtensionManifest, set?: ExtensionIconPaths): string | undefined => {
  const paths = set ?? manifest.action?.default_icon ?? manifest.icons;
  if (paths === undefined || typeof paths === "string") return paths;
  const sizes = Object.keys(paths).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const size = sizes.find((candidate) => candidate >= TOOLBAR_ICON_SIZE) ?? sizes.at(-1);
  return size === undefined ? undefined : paths[String(size)];
};
