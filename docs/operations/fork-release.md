# Private fork releases

Use `fork-release.yml` in `Clauber/t3code`. It runs only through `workflow_dispatch`; its `publish` input defaults to false. The inherited upstream release workflow is disabled for this repository. No workflow has been dispatched or release uploaded as part of this setup.

Select the reviewed source branch or commit, a unique stable or nightly version, the private HTTPS relay URL, and the browser baseline release tag. Preview versions are rejected because their desktop packages intentionally carry no updater feed. The workflow builds Linux x64, Linux arm64, and Apple Silicon packages using the existing native packaging and CLI smoke checks. GitHub-hosted runner labels follow [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

The workflow sets private relay mode without Clerk credentials and does not deploy or inspect Cloudflare. It leaves npm and hosted web publishing out of this release path. Each build produces a `fork-release` artifact containing the CLI archives, desktop installers and update manifests, `SHA256SUMS`, and `source.json`. The latter records the source commit, version, relay endpoint, browser baseline tag and workflow run. This is build provenance metadata, not a signed SLSA attestation.

Review the artifact and run the isolated update check below before publishing. Publication requires a separate explicit decision to invoke with `publish=true`. Configure the `fork-release` GitHub environment with a required reviewer if publication should require an additional approval. Existing release versions must not be reused: runtimes are cached by version, not repository or checksum. Updating an existing installation does not replace its cached runtime at the same version.

## Prerequisites

Mac publishing must have the existing release secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `MACOS_PROVISIONING_PROFILE`, plus repository variable `APPLE_TEAM_ID`. The reusable packager signs and notarizes the desktop and CLI with these credentials. The fork workflow refuses unsigned Mac packaging. On 2026-10-21, GitHub returned no repository secrets or variables for Clauber/t3code. The inspected Mac had one Apple Development identity and no Developer ID Application identity. A successful signed/notarized CI build remains blocked until the required distribution credentials are supplied and validated. The existing passkey provisioning requirements still apply to the reusable packager even though private authentication does not use Clerk.

The managed browser baselines must first be made available in an approved release in the same fork. That bootstrap upload needs separate approval. For each of `linux-x64` and `darwin-arm64`, upload:

- `<target>.manifest.json`, copied from the baseline's `manifest.json`.
- `<target>.manifest.sig`, copied from its detached signature.
- The original `stealth-browser-v<version>-<target>.tar.gz` archive.

The packaging code verifies each archive and manifest against `components/stealth-browser.lock.json` and its trusted signing keys before staging it. Missing packages fail the build. Linux arm64 intentionally carries no local browser baseline and uses a browser hosted elsewhere. Never regenerate a signature or alter the lock simply to make an arbitrary package pass.

The local 9016 builders live outside this repository and are historical evidence, not this release entry point. In particular, `~/ai/sandbox/active/t3code-zcode/build-archive.sh` explicitly injects the official relay and writes directly to the local live mirror; do not use it for private relay builds.

## Local build equivalent

Run in an isolated source checkout on each native architecture with its dependencies installed. Keep build outputs outside live mirrors. Use a unique fork version and explicitly configure the private endpoint for both server and web:

```bash
export T3CODE_PRIVATE_RELAY=1 VITE_T3CODE_PRIVATE_RELAY=1
export T3CODE_RELAY_URL=https://10.69.42.164:38443
export VITE_T3CODE_RELAY_URL="$T3CODE_RELAY_URL"
export T3CODE_CLERK_PUBLISHABLE_KEY= VITE_CLERK_PUBLISHABLE_KEY=
export T3CODE_CLERK_JWT_TEMPLATE= VITE_CLERK_JWT_TEMPLATE=
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=
export T3CODE_DESKTOP_UPDATE_REPOSITORY=Clauber/t3code
export VP_NODE_VERSION=26.8.2
node scripts/update-release-package-versions.ts "$FORK_VERSION"
vp run build:desktop
```

On Linux x64 and macOS arm64, set `T3CODE_STEALTH_BROWSER_BASELINE_DIR` to the verified baseline directory and `T3CODE_REQUIRE_STEALTH_BROWSER_BASELINE=1`. The release workflow supplies these from the approved baseline release. Use the native platform's existing `scripts/build-desktop-artifact.ts --platform <linux|mac> --target <AppImage|dmg> --arch <x64|arm64> --build-version "$FORK_VERSION" --skip-build`; Mac additionally requires `--signed` and the real signing/notarization configuration. Package the CLI with `scripts/build-cli-archive.ts` only after building its SEA executable and resource monitor, following the exact steps in `release-desktop.yml`. Run `scripts/smoke-cli-archive.ts --archive <archive> --expect-version "$FORK_VERSION"` on the native target. A cross-built archive without a native smoke run is not release evidence.

## Isolated update and rollback

Use a fresh directory under `~/ai/sandbox/active/` and a verified previous fork archive. Extract it into `<proof>/home/runtime/versions/<old-version>` with its enclosing archive directory stripped, write `<old-version>\n` to `.install-complete`, and point `<proof>/bin/t3` at that directory's `t3` executable. Verify the previous archive against its retained `SHA256SUMS` before extraction.

```bash
export T3CODE_HOME="$PROOF_DIR/home"
export T3CODE_RELEASE_BASE_URL="$VERIFIED_RELEASE_BASE_URL"
"$PROOF_DIR/bin/t3" --version
"$PROOF_DIR/bin/t3" update "$NEW_VERSION" --base-dir "$T3CODE_HOME"
"$PROOF_DIR/bin/t3" --version
"$PROOF_DIR/bin/t3" update "$OLD_VERSION" --allow-downgrade --base-dir "$T3CODE_HOME"
"$PROOF_DIR/bin/t3" --version
```

Do not add `--yes` or run `service install/restart` for this check. The boot service has a shared unit name; an isolated home is not a separate service. Confirm that the live service's PID, ExecStart and unit-file digest are identical before and after. This check proves verified runtime installation, launcher switching and cached rollback. It does not test a running service restart, database downgrade, Mac signature acceptance or desktop replacement. Those require separate approved rollout gates and retained data/app backups.
