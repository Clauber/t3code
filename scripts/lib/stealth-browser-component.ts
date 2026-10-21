// @effect-diagnostics nodeBuiltinImport:off
/**
 * Stages the managed browser component into a distribution: the audited installer bundle, its schema, the
 * lock and the shipped baseline package, all as plain files outside any archive the server is packed into.
 *
 * The baseline is verified here, by the same installer code the server uses, against the lock's public keys
 * and pinned digests, so a build can never ship a package the server would refuse. A lock that names no
 * key or baseline (production provisioning has not happened) stages nothing and says why; a build that
 * must carry the component sets `T3CODE_REQUIRE_STEALTH_BROWSER_BASELINE=1`, which turns that into a failure.
 */
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";

export const STEALTH_BROWSER_BASELINE_ENV = "T3CODE_STEALTH_BROWSER_BASELINE_DIR";
export const STEALTH_BROWSER_REQUIRED_ENV = "T3CODE_REQUIRE_STEALTH_BROWSER_BASELINE";
/** The platforms a baseline package exists for, by the manifest's own `os` and `arch`. Kept equal to the server's list by a test. */
export const STEALTH_BROWSER_TARGETS = ["linux-x64", "darwin-arm64"] as const;

export interface StageStealthBrowserInput {
  readonly repoRoot: string;
  /** The directory the component is copied to, created fresh. */
  readonly destination: string;
  /** A directory holding `manifest.json`, `manifest.sig` and the archive; absent when none is supplied. */
  readonly baselineDirectory: string | undefined;
  readonly platform: string;
  readonly arch: string;
  /** Overrides the shipped lock; tests and fixture builds point this at their own. */
  readonly lockPath?: string | undefined;
  readonly required?: boolean | undefined;
}

export type StageStealthBrowserResult =
  | { readonly status: "staged"; readonly version: string }
  | { readonly status: "skipped"; readonly reason: string };

interface Baseline {
  readonly version: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
}

interface Lock {
  readonly trustedPublicKeys: ReadonlyArray<string>;
  /** One pinned package per target; this build is only ever held to its own. */
  readonly baselines: Readonly<Record<string, Baseline | null>>;
}

interface InstallerBundle {
  readonly verifyRelease: (
    artifactPath: string,
    manifestPath: string,
    trustedKeys: ReadonlyArray<string>,
    options: { readonly signaturePath: string; readonly checkPrerequisites: boolean },
  ) => Promise<{
    readonly manifest: {
      readonly version: string;
      readonly archiveFileName: string;
      readonly os: string;
      readonly arch: string;
    };
  }>;
}

const sha256 = (file: string) =>
  Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");

export class StealthBrowserStageError extends Error {
  override readonly name = "StealthBrowserStageError";
}

const skipOrFail = (input: StageStealthBrowserInput, reason: string): StageStealthBrowserResult => {
  if (input.required === true) throw new StealthBrowserStageError(reason);
  return { status: "skipped", reason };
};

export const stageStealthBrowserComponent = async (
  input: StageStealthBrowserInput,
): Promise<StageStealthBrowserResult> => {
  const target = `${input.platform}-${input.arch}`;
  if (!(STEALTH_BROWSER_TARGETS as ReadonlyArray<string>).includes(target)) {
    // Other platforms are clients of a browser hosted elsewhere; they carry no baseline.
    return {
      status: "skipped",
      reason: `no baseline package targets ${input.platform}/${input.arch}`,
    };
  }
  const componentSource = Path.join(input.repoRoot, "components", "stealth-browser");
  const lockPath =
    input.lockPath ?? Path.join(input.repoRoot, "components", "stealth-browser.lock.json");
  const lock = JSON.parse(FS.readFileSync(lockPath, "utf8")) as Lock;
  const pinned = lock.baselines[target] ?? null;
  if (lock.trustedPublicKeys.length === 0 || pinned === null) {
    return skipOrFail(
      input,
      `the component lock names no signing key or ${target} baseline yet (production provisioning is pending)`,
    );
  }
  if (input.baselineDirectory === undefined) {
    return skipOrFail(input, `no baseline package supplied (${STEALTH_BROWSER_BASELINE_ENV})`);
  }

  const manifestPath = Path.join(input.baselineDirectory, "manifest.json");
  const signaturePath = [
    Path.join(input.baselineDirectory, "manifest.sig"),
    `${manifestPath}.sig`,
  ].find((candidate) => FS.existsSync(candidate));
  if (!FS.existsSync(manifestPath) || signaturePath === undefined) {
    throw new StealthBrowserStageError(
      `${input.baselineDirectory} lacks manifest.json or its signature`,
    );
  }
  const bundle = Module.createRequire(Path.join(componentSource, "tools", "loader.cjs"))(
    "./stealth-browser-installer.cjs",
  ) as InstallerBundle;
  const archiveName = (
    JSON.parse(FS.readFileSync(manifestPath, "utf8")) as { archiveFileName?: string }
  ).archiveFileName;
  if (typeof archiveName !== "string" || archiveName !== Path.basename(archiveName)) {
    throw new StealthBrowserStageError("the baseline manifest names an unsafe archive file");
  }
  const archivePath = Path.join(input.baselineDirectory, archiveName);
  // Signature, digest, schema and platform, by the installer's own code.
  const verified = await bundle.verifyRelease(archivePath, manifestPath, lock.trustedPublicKeys, {
    signaturePath,
    checkPrerequisites: false,
  });
  // The installer judges the platform too; this makes a package for another platform fail by name here.
  if (`${verified.manifest.os}-${verified.manifest.arch}` !== target) {
    throw new StealthBrowserStageError(
      `the baseline package is built for ${verified.manifest.os}-${verified.manifest.arch}, not ${target}`,
    );
  }
  if (
    verified.manifest.version !== pinned.version ||
    sha256(archivePath) !== pinned.archiveSha256 ||
    sha256(manifestPath) !== pinned.manifestSha256
  ) {
    throw new StealthBrowserStageError(
      "the baseline package verifies but is not the release the lock pins",
    );
  }

  FS.rmSync(input.destination, { recursive: true, force: true });
  FS.mkdirSync(input.destination, { recursive: true });
  for (const directory of ["tools", "release"]) {
    FS.cpSync(Path.join(componentSource, directory), Path.join(input.destination, directory), {
      recursive: true,
    });
  }
  FS.copyFileSync(lockPath, Path.join(input.destination, "lock.json"));
  const baseline = Path.join(input.destination, "baseline");
  FS.mkdirSync(baseline);
  FS.copyFileSync(manifestPath, Path.join(baseline, "manifest.json"));
  FS.copyFileSync(signaturePath, Path.join(baseline, "manifest.sig"));
  FS.copyFileSync(archivePath, Path.join(baseline, archiveName));
  return { status: "staged", version: verified.manifest.version };
};
