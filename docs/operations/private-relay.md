# Private T3 Connect on Harness

This deployment belongs to `https://github.com/Clauber/t3code`, branch `feat/private-relay`, based on deployed customization commit `7adef38ef6`. The shared checkout's `origin` is upstream; use the `fork` remote when publication is approved. No main branch merge or release publication is part of this deployment.

## Running deployment

Harness is Ubuntu in Proxmox LXC 140, private address `10.69.42.164`. Nothing was installed on the hypervisor. The relay is `https://10.69.42.164:38443`; the validation client is `https://10.69.42.164:38447/settings/connections`. Trust the existing Harness CA through an authenticated channel. Never bypass TLS verification.

The client is currently a source preview, not a replacement of the installed desktop app. Open Connections, sign in under Private T3 Connect using the owner credential, and add the three discovered environments once. Registration and saved client connections persist. The owner credential is a mode-600 file at `~/.local/share/t3-private-relay/owner-secret` on Harness; retrieve it privately over authenticated SSH, not through a shared log or message. Sign out revokes that relay session. Existing server sessions have their own lifetime and Access settings revocation; relay logout is not a claim to terminate already-open server sessions.

| Environment | Identity                               | Private endpoint             | Installed version / manager                            |
| ----------- | -------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| harness     | `5c4a1b38-a947-4e57-84ec-52d80a420e48` | `https://10.69.42.164:38444` | `0.0.46-preview.20261020.9016`, Linux x64 user systemd |
| MBP-MFER    | `89e1d92f-618f-490b-9f59-09738dd50573` | `https://10.69.42.164:38445` | same version, macOS arm64 desktop                      |
| gx10-5548   | `7bdd6ab9-6d83-43fa-a2fd-91a26be48ccd` | `https://10.69.42.164:38446` | same version, Linux arm64 user systemd                 |

These servers were registered without restarting their T3 processes. The fourth registration is the isolated validation instance and is hidden when it is the client's primary environment.

## Connection and trust boundaries

Upstream `infra/relay` uses Cloudflare Workers, Clerk, PlanetScale/Hyperdrive, managed tunnels, and optional push services. The local adapter reuses shared relay schemas, JWT/DPoP verification, token scopes, signed health responses, and signed credential minting. Node HTTPS replaces the worker host, SQLite replaces relay persistence, and a random owner credential plus revocable sessions replaces hosted authentication. Cloudflare tunnels, APNs and hosted Clerk sign-in are disabled for this path.

The relay is a control plane. Application WebSockets go from the client to the environment endpoints above. Caddy terminates private TLS, then uses Harness loopback for Harness, an SSH local forward for the Mac, and a GX10 SSH reverse forward for GX10. The latter two terminate at each server's loopback port 3773. They are private SSH transports, not public tunnels. Caddy sets `X-Forwarded-Proto: https` so the server verifies DPoP against the actual HTTPS URL, and strips untrusted forwarded authority headers. Administrative link-proof requests use a separate authenticated loopback path.

The relay configuration pins each environment ID, public key and HTTPS endpoint. Owner authentication is required for discovery and registration; server access additionally uses signed, DPoP-bound credentials. No public relay fallback is configured. Model-provider calls, GitHub release downloads, and the inherited upstream model-manifest fetch are separate external requests: this system is not offline.

## Files and startup

- Source and deployment definitions: `/workspace/projects/t3code/.worktree/private-relay/infra/relay/`.
- Configuration: `~/.config/t3-private-relay/config.json`, mode 600. It contains endpoint/key pins and paths, not the owner secret.
- Persistent relay state: `~/.local/share/t3-private-relay/`, mode 700; SQLite and owner secret mode 600.
- TLS: `~/ai/certs/harness-dev.{crt,key}` and `harness-dev-ca.crt`; existing private key remains mode 600.
- Harness user units: `~/.config/systemd/user/t3-private-relay.service`, `t3-private-mac-tunnel.service`, and the relay backup/health service and timer pairs.
- GX10 user unit: `~/.config/systemd/user/t3-private-gx10-tunnel.service`, running as `c`.
- Caddy container: `t3-private-relay-endpoints-1`, Docker Compose `infra/relay/deploy/compose.yaml`.

The installed relay unit depends on this worktree and its Node dependencies. Do not delete or move the worktree until replacing the unit with a release installation. Node must provide `node:sqlite` and TypeScript stripping. Tested locally on Node 22.23.2. For a clean checkout install the repository's locked dependencies using its specified package manager; the present worktree reuses existing installed dependencies.

Install the matching user units on their indicated hosts, then enable them with `systemctl --user enable --now`. User lingering is enabled on Harness and GX10. Services restart on failure; SSH forwards use keepalives, strict host-key checking and fail if forwarding cannot be established. No host-key verification is disabled.

```bash
T3_PRIVATE_CERT_DIR=/home/clauber/ai/certs \
  docker compose -f infra/relay/deploy/compose.yaml up -d
systemctl --user status t3-private-relay.service t3-private-mac-tunnel.service
systemctl --user list-timers 't3-private-relay-*'
curl --fail --cacert ~/ai/certs/harness-dev-ca.crt https://10.69.42.164:38443/health
```

Docker logs rotate at 5 MB with three files. User services use journal rate limits and the host journal's retention policy. The health timer checks HTTPS once per minute and records failures in the journal. It does not restart T3 servers. The relay unit recovers a terminated relay process automatically.

## Registration and recovery

`infra/relay/scripts/local-register.ts` performs the upstream challenge/proof/link/config protocol. It verifies the target's signed identity against configuration pins, backs up cloud configuration before changing it, disables the managed endpoint runtime, checks signed health and credential minting, and revokes its bootstrap relay session. Supply a short-lived server session scoped to `relay:read` and `relay:write`, saved to a mode-600 JSON file. Never pass its token as a command-line argument.

The default target is only the worktree's isolated `.t3`. Live targets require `--live EXPECTED_ENVIRONMENT_ID`. Remote targets use `--snapshot EXPECTED_ENVIRONMENT_ID`, a protected snapshot of `userdata/environment-id`, `userdata/server-runtime.json` and `userdata/secrets/cloud-*.bin`, and an already-authenticated loopback SSH forward. The script preserves the actual runtime Host header and signs the runtime origin even when the transport port differs.

```bash
NODE_EXTRA_CA_CERTS=/home/clauber/ai/certs/harness-dev-ca.crt \
node --experimental-strip-types infra/relay/scripts/local-register.ts \
  ~/.config/t3-private-relay/config.json /protected/server-admin.json \
  ~/.local/share/t3-private-relay/owner-secret \
  http://127.0.0.1:39001 /protected/mac-snapshot /protected/bootstrap-backups \
  --snapshot 89e1d92f-618f-490b-9f59-09738dd50573
```

Original fleet cloud files were backed up on each host under `~/.t3/backups/private-relay-20261021`, and on Harness under `~/ai/sandbox/active/t3-private-relay/fleet/`. No original data was deleted. An unlink/relink is an administrative operation; do not overwrite active cloud state from an old backup without inspecting current connections first.

Daily backups go to `~/.local/share/t3-private-relay-backups/<UTC timestamp>`. `deploy/backup.py` uses SQLite's online backup API and checks integrity; it does not copy a live WAL file. It includes owner credentials and config, so keep backups private. TLS keys are managed separately in the existing certificate directory. These local copies are not independent disaster-recovery storage; host/ZFS backup coverage must be verified separately. No automatic deletion policy was introduced.

For recovery, stop only `t3-private-relay.service`, preserve its current state directory, restore the backup database and owner-secret into a new mode-700 directory, update `stateDir`, and start the service. Restore required TLS material separately. Keep the same issuer and endpoints; changing them requires deliberate re-registration. A restored copy was actually started on a temporary private port, authenticated, and returned all four registrations before being stopped.

## Configuration and releases

`T3CODE_RELAY_URL` is injected into bundled server/client builds by their Vite configs and `scripts/lib/public-config.ts`. The server also accepts a runtime override and stores each installed link's relay URL. The web/desktop client requires a rebuild to change its embedded URL. `T3CODE_PRIVATE_RELAY=1` enables the local owner flow and suppresses hosted Clerk authentication. Invalid/insecure client relay configuration disables that flow rather than selecting a public relay.

`T3CODE_DESKTOP_UPDATE_REPOSITORY` is packaging-time configuration. The packager now defaults to `Clauber/t3code` and rejects another explicit repository. `T3CODE_RELEASE_BASE_URL` is a runtime archive/checksum mirror override; it never selected the release-discovery repository. Release discovery and package eligibility now share `CLI_RELEASE_REPOSITORY=Clauber/t3code`; installer defaults, update links and desktop metadata are fork-specific. The inherited public model-manifest URL is unrelated to binary updates.

See [fork-release.md](fork-release.md) for builds, signing, artifact checksums/provenance and controlled rollback. Existing Update all UI is retained, including per-server progress, eligibility and partial failures. Offline servers cannot update; desktop-managed servers require their desktop update path. Provider CLI updates remain a separate selection. Inspect active sessions before authorizing any restart.

**The live 9016 binaries and installed desktop have not yet been replaced with this updater patch. Do not use their update action as proof of fork-only updates.** Publication and active-server restarts remain approval gates. GitHub currently reports no releases, repository secrets or variables for this fork; the inspected Mac has only an Apple Development signing identity. A signed/notarized distributable desktop release and its update acceptance remain unverified.

## Validation record

Evidence directory: `~/ai/sandbox/active/t3-private-relay/` on Harness. Browser route: `/settings/connections` at port 38447, private owner session, actual three fleet servers plus the isolated primary. The preview tab is left open.

- Trusted private TLS loads after the explicitly approved shared-browser restart. T3 processes were not restarted.
- Browser displays all three real hosts Connected after a single owner sign-in; refresh and relay restart retain authentication and saved connections.
- Stopping only the new Mac SSH route makes Mac reconnect while Harness/GX10 remain Connected; restoring the route reconnects Mac.
- Real unauthenticated discovery, all three project APIs, and protocol-2 WebSocket handshakes return 401. Untrusted CORS origin returns 403; revoked relay token returns 401. See `security-evidence.json`.
- Browser HTTP and WebSocket capture during sign-out/sign-in and connecting all three hosts contains only private relay/environment origins; see `browser-traffic.json`. No claim is made about unrelated model-provider or release traffic.
- Production web build completed successfully; the open preview still serves the development build.
- Relay SQLite backup restored into a separate running instance and returned all registrations. `restore-proof/` retains the protected proof copy.
- Real retained fork runtimes updated 9015 → 9016 → 9015 with verified archives, without modifying the live unit or PID. See `../private-relay-update-proof/result.json`. This did not exercise database downgrade or live service restart and does not prove a future migration is reversible.
- Local relay and bootstrap guard/transport tests, focused client/update tests and typechecks cover changed boundaries. Browser integration found and corrected CORS tracing headers, SQLite boolean binding, and HTTPS DPoP proxy scheme handling.

Not yet complete: signed new release artifacts on all three platforms, installed desktop private-auth build, live updater replacement, a running-service update/rollback with the final release, migration downgrade assessment, and full regression coverage of every fork customization. Keep these gates open; successful relay startup is not release readiness.
