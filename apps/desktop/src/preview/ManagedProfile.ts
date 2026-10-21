import type { Session, WebContents } from "electron";

const configured = new WeakMap<Session, { proxy: string | null; ready: Promise<void> }>();
const authenticated = new WeakSet<WebContents>();

/** Whether these contents render in a dedicated managed browser profile. */
export const isManagedProfile = (contents: WebContents): boolean =>
  contents.session?.storagePath?.includes("t3code-preview-managed-") === true;

/** The route belongs to the persistent managed profile, not the tab or its viewer. */
export async function configureManagedProxy(
  contents: WebContents,
  proxy: string | null,
): Promise<void> {
  const session = contents.session;
  if (!isManagedProfile(contents))
    throw new Error("Only a dedicated managed profile may configure its network route.");
  const existing = configured.get(session);
  if (existing && existing.proxy !== proxy)
    throw new Error("A live managed profile cannot change network routes.");
  const url = proxy === null ? null : new URL(proxy);
  if (
    url &&
    (!["http:", "https:", "socks5:"].includes(url.protocol) ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash)
  )
    throw new Error("Unsupported managed proxy address.");
  if (url?.protocol === "socks5:" && (url.username || url.password))
    throw new Error("Authenticated SOCKS proxies are not supported by Chromium.");
  if (url?.username && !authenticated.has(contents)) {
    authenticated.add(contents);
    contents.on("login", (event, _details, auth, callback) => {
      if (
        !auth.isProxy ||
        auth.host !== url.hostname ||
        auth.port !== Number(url.port || (url.protocol === "https:" ? 443 : 80))
      )
        return;
      event.preventDefault();
      callback(decodeURIComponent(url.username), decodeURIComponent(url.password));
    });
  }
  if (existing) return existing.ready;
  const ready = session
    .setProxy(
      url
        ? {
            mode: "fixed_servers",
            proxyRules: `${url.protocol}//${url.host}`,
            proxyBypassRules: "<-loopback>",
          }
        : { mode: "direct" },
    )
    .then(() => session.closeAllConnections());
  configured.set(session, { proxy, ready });
  await ready;
}
