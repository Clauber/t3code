# Private fork updates

The owner selected private distribution. Do not upload artifacts or browser baselines to GitHub releases. Source remains in `Clauber/t3code`; release storage and version discovery are served inside Harness.

## Feed and access

Harness serves `~/.local/share/t3-release-mirror` on `127.0.0.1:8790` through the user unit `t3-release-mirror.service`. Mac and GX10 use SSH local forwards to that same loopback endpoint. No public listener or bearer secret is embedded in the app. SSH authenticates each machine and encrypts traffic between machines. Processes on the same machine can reach the loopback feed; this assumes the existing owner-controlled hosts.

Deployment definitions are in `infra/relay/deploy/`: the mirror unit, `t3-private-update-tunnel.service` for GX10, and `dev.t3code.private-updates.plist` for the Mac user's LaunchAgents. The `harness` SSH alias must already work with host-key verification and noninteractive authentication. Do not disable host-key verification. Keep the previous mirror unit and all previous artifacts when switching a host to the tunnel.

Set `T3CODE_RELEASE_BASE_URL=http://127.0.0.1:8790` and `T3CODE_PRIVATE_RELAY=1`. The root contains `releases.json`, an array of objects such as `{"tag_name":"vVERSION","draft":false}`, newest first. CLI assets and `SHA256SUMS` live in `vVERSION/`. Desktop updater YAML and desktop artifacts live at the root. Generate desktop YAML with the packager, including its SHA-512 values; do not hand-invent installer metadata. A configured feed must fail closed when unavailable. Provider CLI updates are a separate action and are not part of a T3 update.

## Build

Build from an isolated checkout of an identifiable source commit. Never reuse a deployed version number: the runtime cache is keyed by version. Record the commit, package-version patch, tool versions, baseline digests and artifact checksums alongside each release. Stage outside the live feed until verification passes.

```bash
export T3CODE_PRIVATE_RELAY=1 VITE_T3CODE_PRIVATE_RELAY=1
export T3CODE_RELEASE_BASE_URL=http://127.0.0.1:8790
export T3CODE_RELAY_URL=https://10.69.42.164:38443
export VITE_T3CODE_RELAY_URL="$T3CODE_RELAY_URL"
export T3CODE_CLERK_PUBLISHABLE_KEY= VITE_CLERK_PUBLISHABLE_KEY=
export T3CODE_CLERK_JWT_TEMPLATE= VITE_CLERK_JWT_TEMPLATE=
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID= VITE_CLERK_CLI_OAUTH_CLIENT_ID=
node scripts/update-release-package-versions.ts "$FORK_VERSION"
./node_modules/.bin/vp run --filter t3 build
node apps/server/scripts/cli.ts build-exe --verbose
```

Package Linux with `scripts/build-cli-archive.ts --platform linux --arch x64|arm64 --version "$FORK_VERSION" --resource-monitor-dir "$RESOURCE_MONITOR_DIR" --output-dir "$OUTPUT"`. Build the arm64 executable with `build-exe --target linux-arm64` first. Use the matching native resource monitor. For x64 require the verified browser baseline with `T3CODE_REQUIRE_STEALTH_BROWSER_BASELINE=1` and `T3CODE_STEALTH_BROWSER_BASELINE_DIR`; arm64 uses a remote browser. The baseline is verified against `components/stealth-browser.lock.json`, including its trusted signature. Run `scripts/smoke-cli-archive.ts` on the native host.

On the Mac, use the same private build environment and verified Darwin browser baseline. Run `scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version "$FORK_VERSION" --output-dir "$OUTPUT" --signed`. The private build omits Clerk passkey provisioning, but retains real Developer ID signing. Keep the certificate and private key in the Mac login keychain. If SSH cannot access that key, run the build from the logged-in desktop Terminal session and approve only the signing prompt. Never place a keychain password in a command line. Notarization requires additional credentials and is distinct from signing; do not claim notarization from a successful signature check. Do not disable Gatekeeper or update signature validation.

## Stage, update and rollback

Verify SHA-256 hashes before transferring CLI archives. Stage new files in a temporary directory on Harness and atomically rename the version directory into place. Install desktop artifacts before replacing updater YAML, and replace `releases.json` last. Keep the previous artifacts and back up release metadata. Back up the private feed through the existing host storage backup policy; a local second copy alone is not an off-host backup.

Before each live restart, inspect running tasks and back up configuration and SQLite databases using SQLite's backup API. Never copy only the database file while WAL writers are active. Test the new executable against an isolated data copy, then test rollback against that same copy. Compare migration sources and schema history separately; unchanged files do not alone prove every data transformation reversible.

For an initial explicit version transition, use `t3 update "$FORK_VERSION"` with the private feed configured. Updating the desktop first lets Connections → Update all target the matching client version for eligible servers. Report offline/incompatible servers and per-server failures separately. Restart idle servers one at a time, confirm private authenticated access, and leave Harness last when it hosts the rollout session. Updating a runtime without restarting its process is not a completed deployment.

Retain each previous runtime and the previous Mac app. CLI rollback uses `t3 update "$OLD_VERSION" --allow-downgrade`; rolling back to a preview can require interactive confirmation even with that flag. The tested isolated Linux path installed and switched launchers without affecting the live service, then explicitly restarted only its owned process. For a failed live rollout, stop the phase after restoring the retained artifact and checking health. Restore a database only when required by a separately assessed migration rollback, never blindly overwrite newer sessions.

## Evidence and current limits

Private release `0.0.47-nightly.20261022.2` was built from `b6d8706f843a30e238a1ba46fa86b5a725422f9f`. Linux x64 and arm64 native startup passed. An isolated x64 instance upgraded from 9016 to this release and rolled back to 9016; all three process starts returned HTTP 200, database integrity passed, and copied project/thread/event/migration counts were unchanged. Private release discovery succeeded against the local feed and failed closed for malformed metadata and HTTP 503. Evidence is under `~/ai/sandbox/active/t3-private-relay/rollout-20261022/final-proof/` and artifact provenance under `final/provenance.json`.

The Mac archive has a verified Developer ID signature under the owner's team, but is not notarized. Its isolated app launched with no runtime release-feed environment and propagated the packaged private feed to its embedded server. Browser validation of that candidate signed into the private relay and connected all three existing environments. Screenshot capture timed out, so screenshot evidence is incomplete.

Later nightlies `.3` (commit `f25e270b6`) and `.4` (commit `24eb88971`, branch `fix/managed-browser-tab-close`) were staged as version directories only; `releases.json` still advertises `.2`, and no `.3` or `.4` desktop artifact or updater YAML is in the feed root. Harness committed `.3` → `.4` and restarted with HTTP health passing. The Mac runs the signed, not notarized `.4` Nightly, which confirmed the managed-browser tab-limit fix; its earlier `.2` browser start failure was the leaked-tab bug, not a packaging fault. Private release `0.0.47-nightly.20261022.5` was built from `a2c7883cf` and carries the pending-close retry fix. Linux x64 and arm64 archives passed their native smoke tests, the Mac app has a verified Developer ID signature and is still not notarized, and the feed advertises `.5` with its desktop updater YAML. Harness, the Mac and GX10 were backed up and moved to `.5` one host at a time, GX10 last because it hosted the rollout session. The Darwin browser baseline directory on the Mac had been deleted and was restored from the Harness copy before the build. No model-provider CLI was updated. No public release was published.

The final fleet update and final UI/customization gates remain incomplete. Off-host backup coverage also remains unverified. A local SQLite backup and retained binaries are not a substitute for that coverage.
