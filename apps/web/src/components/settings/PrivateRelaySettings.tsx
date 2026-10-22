import { useState, useSyncExternalStore } from "react";
import { hasPrivateRelayConfig, resolveCloudPublicConfig } from "../../cloud/publicConfig";
import {
  privateRelaySignedIn,
  signInPrivateRelay,
  signOutPrivateRelay,
  subscribePrivateRelay,
} from "../../cloud/privateRelayAuth";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

export function PrivateRelaySettings() {
  const signedIn = useSyncExternalStore(subscribePrivateRelay, privateRelaySignedIn);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!hasPrivateRelayConfig()) return null;
  return (
    <SettingsSection title="Private T3 Connect">
      <p>{resolveCloudPublicConfig().relayUrl}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            if (signedIn) await signOutPrivateRelay();
            else await signInPrivateRelay(secret);
            setSecret("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Private relay request failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {signedIn ? (
          <span>Signed in as owner</span>
        ) : (
          <Input
            type="password"
            autoComplete="current-password"
            aria-label="Private relay owner secret"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Please wait…" : signedIn ? "Sign out and revoke session" : "Sign in"}
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </SettingsSection>
  );
}
