import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { hasPrivateRelayConfig, resolveCloudPublicConfig } from "./publicConfig";

const Session = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
const decodeSession = Schema.decodeUnknownSync(Session);
const listeners = new Set<() => void>();
let signedIn = false;
const storageKey = () => `t3:private-relay:${resolveCloudPublicConfig().relayUrl}`;

export const subscribePrivateRelay = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const privateRelaySignedIn = () => signedIn;

function activate(session: typeof Session.Type | null) {
  signedIn = session !== null;
  setManagedRelaySession(
    appAtomRegistry,
    session
      ? {
          accountId: "owner",
          readClerkToken: async () =>
            Date.parse(session.expiresAt) > Date.now() ? session.token : null,
        }
      : null,
  );
  for (const listener of listeners) listener();
}

function sessionUrl() {
  const origin = resolveCloudPublicConfig().relayUrl;
  if (!hasPrivateRelayConfig() || !origin) throw new Error("Private relay is not configured.");
  return `${origin}/v1/local/session`;
}

export async function restorePrivateRelaySession() {
  if (!hasPrivateRelayConfig()) return;
  const stored = localStorage.getItem(storageKey());
  if (!stored) return;
  let session: typeof Session.Type;
  try {
    session = decodeSession(JSON.parse(stored));
  } catch {
    localStorage.removeItem(storageKey());
    return;
  }
  if (!(Date.parse(session.expiresAt) > Date.now())) {
    localStorage.removeItem(storageKey());
    return;
  }
  const response = await fetch(sessionUrl(), {
    headers: { Authorization: `Bearer ${session.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 401) {
    localStorage.removeItem(storageKey());
    return;
  }
  if (!response.ok) throw new Error("Private relay authentication is unavailable.");
  activate(session);
}

export async function signInPrivateRelay(secret: string) {
  const response = await fetch(sessionUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Private relay sign-in failed.");
  const session = decodeSession(await response.json());
  localStorage.setItem(storageKey(), JSON.stringify(session));
  activate(session);
}

export async function signOutPrivateRelay() {
  const stored = localStorage.getItem(storageKey());
  if (stored) {
    const session = decodeSession(JSON.parse(stored));
    const response = await fetch(sessionUrl(), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok && response.status !== 401) throw new Error("Could not revoke relay session.");
  }
  localStorage.removeItem(storageKey());
  activate(null);
  await runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
  );
  await runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined);
}
