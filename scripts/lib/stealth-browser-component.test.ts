// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildRelease,
  lockFileOf,
  makeKeys,
  makeTemporaryDirectory,
  testLock,
} from "../../apps/server/src/browser/ManagedBrowserUpdateFixture.ts";
import * as ManagedBrowserPackage from "../../apps/server/src/browser/ManagedBrowserPackage.ts";
import {
  STEALTH_BROWSER_TARGETS,
  stageStealthBrowserComponent,
} from "./stealth-browser-component.ts";

const repoRoot = Path.resolve(import.meta.dirname, "../..");
const sha256 = (file: string) =>
  Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");

/** A baseline signed with a per-run key and a lock that pins it, as production provisioning will. */
const provisioned = () => {
  const directory = makeTemporaryDirectory("stage");
  const keys = makeKeys();
  const baseline = buildRelease(directory, { version: "2.0.0", keys });
  const lockPath = Path.join(directory, "lock.json");
  const archiveSha256 = (
    JSON.parse(FS.readFileSync(baseline.manifestPath, "utf8")) as { archiveSha256: string }
  ).archiveSha256;
  const writeLock = (overrides: { archiveSha256?: string; version?: string } = {}) =>
    FS.writeFileSync(
      lockPath,
      JSON.stringify(
        lockFileOf(
          testLock([keys], {
            baseline: {
              version: overrides.version ?? "2.0.0",
              archiveSha256: overrides.archiveSha256 ?? archiveSha256,
              manifestSha256: sha256(baseline.manifestPath),
            },
          }),
        ),
      ),
    );
  writeLock();
  return { directory, keys, baseline, lockPath, writeLock };
};

const stage = (
  setup: ReturnType<typeof provisioned>,
  overrides: Partial<Parameters<typeof stageStealthBrowserComponent>[0]> = {},
) =>
  stageStealthBrowserComponent({
    repoRoot,
    destination: Path.join(setup.directory, "dist", "stealth-browser"),
    baselineDirectory: setup.baseline.directory,
    platform: "linux",
    arch: "x64",
    lockPath: setup.lockPath,
    ...overrides,
  });

describe("staging the managed browser component into a distribution", () => {
  it("stages nothing, and says why, while the shipped lock is unprovisioned", async () => {
    const directory = makeTemporaryDirectory("stage-unprovisioned");
    const result = await stageStealthBrowserComponent({
      repoRoot,
      destination: Path.join(directory, "stealth-browser"),
      baselineDirectory: undefined,
      platform: "linux",
      arch: "x64",
    });
    assert.equal(result.status, "skipped");
    assert.match(result.status === "skipped" ? result.reason : "", /provisioning is pending/);
    assert.isFalse(FS.existsSync(Path.join(directory, "stealth-browser")));
    // A build that must carry the component fails instead of quietly omitting it.
    let failure: unknown;
    await stageStealthBrowserComponent({
      repoRoot,
      destination: Path.join(directory, "stealth-browser"),
      baselineDirectory: undefined,
      platform: "linux",
      arch: "x64",
      required: true,
    }).catch((error: unknown) => (failure = error));
    assert.match(String(failure), /provisioning is pending/);
  });

  it("carries no baseline for platforms that cannot host", async () => {
    const setup = provisioned();
    const result = await stage(setup, { platform: "win32", arch: "x64" });
    assert.equal(result.status, "skipped");
    assert.isFalse(FS.existsSync(Path.join(setup.directory, "dist")));
  });

  it("targets the same platforms the server accepts", () => {
    assert.deepEqual([...STEALTH_BROWSER_TARGETS], [...ManagedBrowserPackage.SUPPORTED_TARGETS]);
  });

  describe("for a Mac", () => {
    /**
     * A source tree whose installer accepts any manifest it is shown: the shipped bundle still refuses
     * everything but Linux, so this isolates the staging rules (which target, which pin, which platform).
     */
    const macSetup = (built: { os: string; arch: string }, pinned = "darwin-arm64") => {
      const root = makeTemporaryDirectory("stage-mac");
      const component = Path.join(root, "components", "stealth-browser");
      FS.mkdirSync(Path.join(component, "tools"), { recursive: true });
      FS.mkdirSync(Path.join(component, "release"), { recursive: true });
      FS.writeFileSync(
        Path.join(component, "tools", "stealth-browser-installer.cjs"),
        `const FS = require("node:fs");
exports.verifyRelease = async (_archive, manifestPath) => ({
  manifest: JSON.parse(FS.readFileSync(manifestPath, "utf8")),
});
`,
      );
      FS.writeFileSync(Path.join(component, "release", "manifest.schema.json"), "{}");
      const keys = makeKeys();
      const release = buildRelease(makeTemporaryDirectory("stage-mac-release"), {
        version: "2.0.0",
        keys,
        ...built,
      });
      const manifest = JSON.parse(FS.readFileSync(release.manifestPath, "utf8")) as {
        archiveSha256: string;
      };
      const lockPath = Path.join(root, "lock.json");
      FS.writeFileSync(
        lockPath,
        JSON.stringify(
          lockFileOf(
            testLock([keys], {
              baseline: {
                version: "2.0.0",
                archiveSha256: manifest.archiveSha256,
                manifestSha256: sha256(release.manifestPath),
              },
            }),
            pinned,
          ),
        ),
      );
      return (platform: string, arch: string) =>
        stageStealthBrowserComponent({
          repoRoot: root,
          destination: Path.join(root, "dist", "stealth-browser"),
          baselineDirectory: release.directory,
          platform,
          arch,
          lockPath,
        });
    };

    it("stages a darwin-arm64 baseline when the lock pins one for that target", async () => {
      const result = await macSetup({ os: "darwin", arch: "arm64" })("darwin", "arm64");
      assert.deepEqual(result, { status: "staged", version: "2.0.0" });
    });

    it("never stages a Linux package for a Mac, even one the lock pins under the Mac's name", async () => {
      let failure: unknown;
      await macSetup({ os: "linux", arch: "x64" })("darwin", "arm64").catch(
        (error: unknown) => (failure = error),
      );
      assert.match(String(failure), /built for linux-x64, not darwin-arm64/);
    });

    it("skips, and names the target, when only another platform's baseline is pinned", async () => {
      const result = await macSetup({ os: "linux", arch: "x64" }, "linux-x64")("darwin", "arm64");
      assert.equal(result.status, "skipped");
      assert.match(result.status === "skipped" ? result.reason : "", /darwin-arm64 baseline/);
    });

    it("does not stage an Intel Mac, which has no package", async () => {
      const result = await macSetup({ os: "darwin", arch: "arm64" })("darwin", "x64");
      assert.equal(result.status, "skipped");
    });
  });

  it("verifies the baseline and stages plain files the server can load and use", async () => {
    const setup = provisioned();
    const result = await stage(setup);
    assert.deepEqual(result, { status: "staged", version: "2.0.0" });
    const staged = Path.join(setup.directory, "dist", "stealth-browser");
    for (const file of [
      "tools/stealth-browser-installer.cjs",
      "release/manifest.schema.json",
      "lock.json",
      "baseline/manifest.json",
      "baseline/manifest.sig",
      "baseline/stealth-browser-v2.0.0-linux-x64.tar.gz",
    ]) {
      assert.isTrue(FS.statSync(Path.join(staged, file)).isFile(), file);
    }
    // The staged copy is exactly what the server resolves and installs from, not an archive of it.
    assert.equal(
      ManagedBrowserPackage.resolveComponentDir({}, Path.join(setup.directory, "dist")),
      staged,
    );
    const lock = ManagedBrowserPackage.readComponentLock(Path.join(staged, "lock.json"));
    const store = ManagedBrowserPackage.makePackageStore({
      root: Path.join(setup.directory, "installed"),
      lock,
      tool: ManagedBrowserPackage.loadReleaseTool(staged),
      checkPrerequisites: false,
    });
    const [shipped] = await Effect.runPromise(
      ManagedBrowserPackage.directorySource(Path.join(staged, "baseline")).list,
    );
    const manifest = await Effect.runPromise(store.withLock(store.stage(shipped!)));
    assert.equal(manifest.version, "2.0.0");
  });

  it("refuses a baseline signed by someone else, tampered, or not the release the lock pins", async () => {
    const setup = provisioned();
    const stranger = buildRelease(makeTemporaryDirectory("stage-stranger"), {
      version: "2.0.0",
      keys: makeKeys(),
    });
    let failure: unknown;
    await stage(setup, { baselineDirectory: stranger.directory }).catch(
      (error: unknown) => (failure = error),
    );
    assert.match(String(failure), /Signature verification failed|not.*signed/i);

    FS.writeFileSync(
      setup.baseline.manifestPath,
      FS.readFileSync(setup.baseline.manifestPath, "utf8").replace('"2.0.0"', '"2.0.1"'),
    );
    failure = undefined;
    await stage(setup).catch((error: unknown) => (failure = error));
    assert.match(String(failure), /Signature verification failed/);

    const pinned = provisioned();
    pinned.writeLock({ archiveSha256: "0".repeat(64) });
    failure = undefined;
    await stage(pinned).catch((error: unknown) => (failure = error));
    assert.match(String(failure), /not the release the lock pins/);
    assert.isFalse(FS.existsSync(Path.join(pinned.directory, "dist")));
  });
});
