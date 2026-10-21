// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
/**
 * ManagedBrowserPackage - the installed copies of the signed stealth-browser package and the one place
 * that changes which of them is current.
 *
 * T3 carries no tar, digest or signature code for this. Verification, safe extraction, the authenticated
 * archive kept beside each install and the full-tree comparison on reuse and rollback are the audited
 * stealth-browser release installer, bundled unmodified under `components/stealth-browser`. This module
 * owns what that installer deliberately leaves to the host: which keys and source are trusted, immutable
 * version directories with relative `current` / `previous` pointers, and one exclusive lock.
 *
 * Trust comes only from the {@link ComponentLock}: public keys the shipped T3 carries (or an explicit
 * alternative a developer points at for local fixtures). A lock with no keys installs nothing, and the
 * fixture keys used by tests are never part of the shipped lock.
 *
 * @module ManagedBrowserPackage
 */
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Module from "node:module";
import * as Path from "node:path";
import { Worker } from "node:worker_threads";

import { compareSemverVersions, parseSemver, satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class ManagedBrowserPackageError extends Schema.TaggedError<ManagedBrowserPackageError>()(
  "ManagedBrowserPackageError",
  {
    reason: Schema.Literals([
      /** The shipped lock names no key, baseline or source yet. Provisioning, not a fault. */
      "unprovisioned",
      /** This host cannot run the browser (platform, architecture or Chrome prerequisites). */
      "unsupportedHost",
      "toolUnavailable",
      "sourceUnavailable",
      /** The release source refused the configured credential, or needs one that is not configured. */
      "unauthorized",
      /** Signature, digest, schema, compatibility or tree verification failed. */
      "rejected",
      "locked",
      "notStaged",
      "stateUnreadable",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Managed browser package (${this.reason}): ${this.detail}`;
  }
}

// ---------------------------------------------------------------------------
// The trust configuration
// ---------------------------------------------------------------------------

/**
 * Where newer releases come from. `github` reads a repository's published GitHub Releases; `tokenSecret`
 * names a secret in the server's secret store for a private repository and is never a token itself.
 * `apiBaseUrl` is for GitHub Enterprise and local fixtures; it must be https, or plain HTTP on loopback.
 */
export type ReleaseSourceConfig =
  | { readonly kind: "directory"; readonly path: string }
  | {
      readonly kind: "github";
      readonly repository: string;
      readonly apiBaseUrl?: string;
      readonly tokenSecret?: string;
    };

export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const validReleaseSource = (source: Record<string, unknown>) =>
  (source.kind === "directory" && typeof source.path === "string") ||
  (source.kind === "github" &&
    typeof source.repository === "string" &&
    GITHUB_REPOSITORY_PATTERN.test(source.repository) &&
    (source.apiBaseUrl === undefined || typeof source.apiBaseUrl === "string") &&
    (source.tokenSecret === undefined || typeof source.tokenSecret === "string"));

/** The platforms a baseline can target, by the manifest's own `os` and `arch`: one signed package each. */
export const SUPPORTED_TARGETS = ["linux-x64", "darwin-arm64"] as const;
export type Target = (typeof SUPPORTED_TARGETS)[number];

/** The target this process runs on; anything else has no package and is only ever a client. */
export const hostTarget = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string => `${platform}-${arch}`;

export interface ComponentLock {
  /** The adapter's own version, checked against a release's `supportedAdapterRange`. */
  readonly adapterVersion: string;
  readonly engineProtocolVersion: string;
  /** Operations a release must advertise to be selected. */
  readonly requiredCapabilities: ReadonlyArray<string>;
  /** Ed25519 public keys, PEM. Empty until production provisioning. */
  readonly trustedPublicKeys: ReadonlyArray<string>;
  /**
   * The release shipped inside this T3 for the target the lock was read for, by version and digests; null
   * until provisioned. A lock file pins one per target and the others are never consulted.
   */
  readonly baseline: {
    readonly version: string;
    readonly archiveSha256: string;
    readonly manifestSha256: string;
  } | null;
  /** Where newer releases come from; null until provisioned. */
  readonly releaseSource: ReleaseSourceConfig | null;
}

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isDigest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const validBaseline = (baseline: Record<string, unknown> | null) =>
  baseline === null ||
  (typeof baseline?.version === "string" &&
    isDigest(baseline.archiveSha256) &&
    isDigest(baseline.manifestSha256));

/**
 * Reads and checks a lock for one target. A malformed one is an error, never an empty one. The file pins a
 * baseline per target (`baselines`, keyed `os-arch`); the one for `target` becomes `baseline`, so a package
 * built for another platform can never be the one this host is held to.
 */
export const readComponentLock = (path: string, target: string = hostTarget()): ComponentLock => {
  const raw = JSON.parse(FS.readFileSync(path, "utf8")) as Record<string, unknown>;
  const baselines = raw.baselines as Record<string, Record<string, unknown> | null> | undefined;
  const source = raw.releaseSource as Record<string, unknown> | null;
  const baseline = baselines?.[target] ?? null;
  if (
    raw.schemaVersion !== 1 ||
    typeof baselines !== "object" ||
    baselines === null ||
    Array.isArray(baselines) ||
    "baseline" in raw ||
    Object.entries(baselines).some(
      ([name, entry]) =>
        !(SUPPORTED_TARGETS as ReadonlyArray<string>).includes(name) || !validBaseline(entry),
    ) ||
    typeof raw.adapterVersion !== "string" ||
    parseSemver(raw.adapterVersion) === null ||
    typeof raw.engineProtocolVersion !== "string" ||
    !isStringArray(raw.requiredCapabilities) ||
    !isStringArray(raw.trustedPublicKeys) ||
    (source !== null && !validReleaseSource(source))
  ) {
    throw new Error(`component lock ${path} is malformed`);
  }
  return {
    adapterVersion: raw.adapterVersion,
    engineProtocolVersion: raw.engineProtocolVersion,
    requiredCapabilities: raw.requiredCapabilities,
    trustedPublicKeys: raw.trustedPublicKeys,
    baseline: baseline as ComponentLock["baseline"],
    releaseSource: source as ReleaseSourceConfig | null,
  };
};

// ---------------------------------------------------------------------------
// The audited tool
// ---------------------------------------------------------------------------

export interface InstalledRelease {
  readonly version: string;
  readonly versionDir: string;
}

/** What T3 asks of the release installer. The bundle behind it is the stealth-browser repository's own. */
export interface ReleaseTool {
  /** Verifies signature, digest, schema, platform and Chrome; extracts into an immutable version directory. */
  readonly install: (input: {
    readonly artifactPath: string;
    readonly manifestPath: string;
    readonly signaturePath: string;
    readonly trustedKeys: ReadonlyArray<string>;
    readonly targetDir: string;
    readonly checkPrerequisites: boolean;
  }) => Promise<InstalledRelease>;
  /** Verifies the previous install against its authenticated archive, then swaps `current` and `previous`. */
  readonly rollback: (
    targetDir: string,
    trustedKeys: ReadonlyArray<string>,
  ) => Promise<{ readonly rolledBackTo: string }>;
  /** The installer's own schema and platform check; throws on any mismatch. */
  readonly validateManifest: (manifest: unknown) => void;
}

interface InstallerModule {
  readonly validateManifestSchema: (manifest: unknown) => boolean;
}

const INSTALLER_BUNDLE = Path.join("tools", "stealth-browser-installer.cjs");
const INSTALLER_WORKER = Path.join("tools", "installer-worker.cjs");

/**
 * Hashing, extracting and comparing a ~55 MB package takes seconds of synchronous work, so each operation
 * runs in a worker thread that loads the same bundled installer. A worker started from a plain file works
 * in a Node single-executable as well (the file is read from disk, not from the blob), and needs no second
 * Node. The thread is not interruptible mid-operation: a half-finished install is the one thing worse than a
 * slow one, so the caller waits for it.
 */
const runInWorker = (workerFile: string, operation: string, args: ReadonlyArray<unknown>) =>
  new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { operation, args } });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
    };
    worker.once("message", (message: { ok: boolean; result?: unknown; message?: string }) =>
      settle(() =>
        message.ok
          ? resolve(message.result)
          : reject(new Error(message.message ?? "installer failed")),
      ),
    );
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) =>
      settle(() => reject(new Error(`the installer worker ended without a result (code ${code})`))),
    );
  });

/** Loads the bundled installer from a component directory (`createRequire` also works from a single-file build). */
export const loadReleaseTool = (componentDir: string): ReleaseTool => {
  const load = Module.createRequire(Path.join(componentDir, "tools", "loader.cjs"));
  // Only the schema check runs here: it is small and synchronous. Everything heavy runs in the worker.
  const installer = load(`./${Path.basename(INSTALLER_BUNDLE)}`) as InstallerModule;
  const workerFile = Path.join(componentDir, INSTALLER_WORKER);
  if (!FS.existsSync(workerFile)) {
    throw new Error(`the component at ${componentDir} lacks ${INSTALLER_WORKER}`);
  }
  return {
    install: (input) =>
      runInWorker(workerFile, "installRelease", [
        {
          artifactPath: input.artifactPath,
          manifestPath: input.manifestPath,
          signaturePath: input.signaturePath,
          trustedKeys: input.trustedKeys,
          targetDir: input.targetDir,
          checkPrerequisites: input.checkPrerequisites,
          managed: true,
          // Required by the installer; the managed child is given its data root by T3, not by these.
          stateDir: Path.join(input.targetDir, "installer-data", "state"),
          profilesDir: Path.join(input.targetDir, "installer-data", "profiles"),
          recordingsDir: Path.join(input.targetDir, "installer-data", "recordings"),
        },
      ]) as Promise<InstalledRelease>,
    rollback: (targetDir, trustedKeys) =>
      runInWorker(workerFile, "rollbackRelease", [targetDir, { trustedKeys }]) as Promise<{
        readonly rolledBackTo: string;
      }>,
    validateManifest: (manifest) => void installer.validateManifestSchema(manifest),
  };
};

/**
 * Where the shipped component lives: the explicit override, else beside the bundle (CLI archive,
 * `resources/` of the desktop app), else null.
 */
export const resolveComponentDir = (
  environment: NodeJS.ProcessEnv,
  bundleDir: string,
): string | null => {
  const override = environment.T3CODE_STEALTH_BROWSER_COMPONENT_DIR;
  const candidates =
    override !== undefined && override.length > 0
      ? [override]
      : [Path.join(bundleDir, "stealth-browser"), Path.join(bundleDir, "..", "stealth-browser")];
  return (
    candidates
      .map((candidate) => Path.resolve(candidate))
      .find((candidate) => FS.existsSync(Path.join(candidate, INSTALLER_BUNDLE))) ?? null
  );
};

// ---------------------------------------------------------------------------
// Releases on offer
// ---------------------------------------------------------------------------

/** The three files the installer verifies for one release, on disk. */
export interface ReleaseFiles {
  readonly manifestPath: string;
  readonly signaturePath: string;
  readonly archivePath: string;
}

/**
 * A release a source offers. Its manifest is a hint until the installer has verified the signature.
 * `files` makes the release's files exist for the length of the scope that asks: a local directory has them
 * already, a remote source downloads them (bounded) and removes them when the scope ends.
 */
export interface ReleaseCandidate {
  readonly version: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly files: Effect.Effect<ReleaseFiles, ManagedBrowserPackageError, Scope.Scope>;
}

/** A candidate whose files are already local. */
export interface LocalReleaseCandidate extends ReleaseCandidate, ReleaseFiles {}

export interface ReleaseSource {
  readonly list: Effect.Effect<ReadonlyArray<ReleaseCandidate>, ManagedBrowserPackageError>;
}

/** An archive larger than this is not read, whatever its manifest claims. */
const MAX_ARCHIVE_BYTES = 700 * 1024 * 1024;

const readCandidate = (directory: string): LocalReleaseCandidate | null => {
  try {
    const manifestPath = Path.join(directory, "manifest.json");
    const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const signaturePath = [`${manifestPath}.sig`, Path.join(directory, "manifest.sig")].find(
      (candidate) => FS.existsSync(candidate),
    );
    const name = manifest.archiveFileName;
    // The name is untrusted: a plain file name inside this directory or nothing.
    if (
      signaturePath === undefined ||
      typeof manifest.version !== "string" ||
      typeof name !== "string" ||
      name !== Path.basename(name) ||
      name.startsWith(".")
    ) {
      return null;
    }
    const archivePath = Path.join(directory, name);
    const stat = FS.lstatSync(archivePath);
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) return null;
    return {
      version: manifest.version,
      manifestPath,
      signaturePath,
      archivePath,
      manifest,
      files: Effect.succeed({ manifestPath, signaturePath, archivePath }),
    };
  } catch {
    return null;
  }
};

/** A local directory holding releases, either directly or one per subdirectory. Local signed fixtures use this. */
export const directorySource = (
  root: string,
): {
  readonly list: Effect.Effect<ReadonlyArray<LocalReleaseCandidate>, ManagedBrowserPackageError>;
} => ({
  list: Effect.try({
    try: () => {
      const directories = [
        root,
        ...FS.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => Path.join(root, entry.name)),
      ];
      return directories.flatMap((directory) => {
        const candidate = readCandidate(directory);
        return candidate === null ? [] : [candidate];
      });
    },
    catch: (cause) =>
      new ManagedBrowserPackageError({
        reason: "sourceUnavailable",
        detail: cause instanceof Error ? cause.message : "release source unreadable",
      }),
  }),
});

/**
 * Whether an offered release may be considered, judged from its unverified manifest by the installer's
 * own schema and platform check plus T3's compatibility rules. Passing this selects, it does not trust:
 * the installer still verifies signature, digest and tree before anything is installed.
 */
export const compatibilityProblem = (
  manifest: Readonly<Record<string, unknown>>,
  lock: ComponentLock,
  tool: ReleaseTool,
  installed: { readonly version: string; readonly stateSchemaVersion: string } | null,
  target: string = hostTarget(),
): string | null => {
  // Judged here as well as by the installer, so a package for another platform is refused by name.
  const built = `${String(manifest.os)}-${String(manifest.arch)}`;
  if (built !== target) return `built for ${built}, not ${target}`;
  try {
    tool.validateManifest(manifest);
  } catch (cause) {
    return cause instanceof Error ? cause.message : "manifest rejected";
  }
  const version = String(manifest.version);
  const parsed = parseSemver(version);
  if (parsed === null || parsed.prerelease.length > 0) return `${version} is not a stable version`;
  if (manifest.engineProtocolVersion !== lock.engineProtocolVersion) {
    return `engine protocol ${String(manifest.engineProtocolVersion)} is not ${lock.engineProtocolVersion}`;
  }
  if (!satisfiesSemverRange(lock.adapterVersion, String(manifest.supportedAdapterRange))) {
    return `adapter ${lock.adapterVersion} is outside ${String(manifest.supportedAdapterRange)}`;
  }
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const missing = lock.requiredCapabilities.filter((name) => !capabilities.includes(name));
  if (missing.length > 0) return `lacks capability ${missing.join(", ")}`;
  if (installed !== null) {
    if (compareSemverVersions(version, installed.version) <= 0) {
      return `${version} is not newer than ${installed.version}`;
    }
    // A different state format could need a migration the automatic path never performs.
    if (manifest.stateSchemaVersion !== installed.stateSchemaVersion) {
      return `state format ${String(manifest.stateSchemaVersion)} differs from ${installed.stateSchemaVersion}`;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// The installation root
// ---------------------------------------------------------------------------

export interface PackageEngine {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface InstalledManifest {
  readonly version: string;
  readonly stateSchemaVersion: string;
  readonly archiveSha256: string;
  readonly capabilities: ReadonlyArray<string>;
  /** The signed manifest as installed. */
  readonly raw: Readonly<Record<string, unknown>>;
}

const isPackageError = Schema.is(ManagedBrowserPackageError);

const packageError = (reason: ManagedBrowserPackageError["reason"]) => (cause: unknown) =>
  isPackageError(cause)
    ? cause
    : new ManagedBrowserPackageError({
        reason,
        detail: cause instanceof Error ? cause.message : String(cause),
      });

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export interface PackageStore {
  readonly root: string;
  /** Runs `effect` holding the exclusive installation lock; a second caller fails at once rather than queueing. */
  readonly withLock: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ManagedBrowserPackageError>;
  readonly installedVersions: () => ReadonlyArray<string>;
  /** The current version's manifest, or null when nothing is current. */
  readonly current: () => InstalledManifest | null;
  readonly previous: () => string | null;
  readonly manifestOf: (version: string) => InstalledManifest | null;
  /** The executable and entry of an installed version, relocated with the root. */
  readonly engineOf: (version: string) => PackageEngine;
  /** Verifies and installs a release without activating it. Hold the lock. */
  readonly stage: (
    candidate: ReleaseFiles,
  ) => Effect.Effect<InstalledManifest, ManagedBrowserPackageError>;
  /** Re-verifies an installed version's whole tree against its authenticated archive. Hold the lock. */
  readonly reverify: (version: string) => Effect.Effect<void, ManagedBrowserPackageError>;
  /** Points `current` at an installed version, keeping the old one as `previous`. Hold the lock. */
  readonly switchTo: (version: string) => Effect.Effect<void, ManagedBrowserPackageError>;
  /** Verified swap of `current` and `previous`. Hold the lock. */
  readonly rollback: () => Effect.Effect<string, ManagedBrowserPackageError>;
}

export const makePackageStore = (options: {
  readonly root: string;
  readonly lock: ComponentLock;
  readonly tool: ReleaseTool;
  /** False only where the host's Chrome is irrelevant, such as a test of the installer's selection. */
  readonly checkPrerequisites?: boolean;
  /** The platform this store installs for; the host's, except in a test of another host's refusal. */
  readonly target?: string;
}): PackageStore => {
  const { root, lock, tool } = options;
  const target = options.target ?? hostTarget();
  const versionsDir = Path.join(root, "versions");
  const lockPath = Path.join(root, ".update.lock");
  const pointer = (name: "current" | "previous") => {
    try {
      const target = FS.readlinkSync(Path.join(root, name));
      const version = Path.basename(target);
      return target === Path.join("versions", version) ? version : null;
    } catch {
      return null;
    }
  };
  const manifestOf = (version: string): InstalledManifest | null => {
    try {
      const raw = JSON.parse(
        FS.readFileSync(Path.join(versionsDir, version, "release", "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      return {
        version: String(raw.version),
        stateSchemaVersion: String(raw.stateSchemaVersion),
        archiveSha256: String(raw.archiveSha256),
        capabilities: Array.isArray(raw.capabilities) ? (raw.capabilities as string[]) : [],
        raw,
      };
    } catch {
      return null;
    }
  };
  const failWith = packageError("rejected");

  const acquire = Effect.try({
    try: () => {
      FS.mkdirSync(root, { recursive: true, mode: 0o700 });
      for (let attempt = 0; ; attempt += 1) {
        try {
          const fd = FS.openSync(lockPath, "wx", 0o600);
          FS.writeSync(fd, String(process.pid));
          FS.closeSync(fd);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const holder = Number(FS.readFileSync(lockPath, "utf8"));
          // A holder that died leaves its lock behind; a live one, including this process, keeps it.
          if (attempt > 0 || (Number.isInteger(holder) && holder > 0 && processAlive(holder))) {
            throw new ManagedBrowserPackageError({
              reason: "locked",
              detail: "another install or activation is in progress",
            });
          }
          FS.rmSync(lockPath, { force: true });
        }
      }
    },
    catch: packageError("locked"),
  }).pipe(
    // The installer's own lock is held only inside this one, so a leftover from a crash is stale here.
    Effect.tap(() =>
      Effect.sync(() => FS.rmSync(Path.join(root, ".install.lock"), { force: true })),
    ),
  );
  const release = Effect.sync(() => FS.rmSync(lockPath, { force: true }));

  const trustedKeys = () => {
    if (lock.trustedPublicKeys.length === 0) {
      throw new ManagedBrowserPackageError({
        reason: "unprovisioned",
        detail: "no release signing key is provisioned",
      });
    }
    return lock.trustedPublicKeys;
  };

  /**
   * Refuses, before the installer sees it, a package built for another platform. The installer verifies the
   * manifest's signature and platform itself; this keeps a Linux package out of a Mac whatever it accepts.
   */
  const requireTarget = (manifestPath: string) => {
    let built: string;
    try {
      const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      built = `${String(manifest.os)}-${String(manifest.arch)}`;
    } catch (cause) {
      throw new ManagedBrowserPackageError({
        reason: "rejected",
        detail: cause instanceof Error ? cause.message : "manifest unreadable",
      });
    }
    if (built !== target) {
      throw new ManagedBrowserPackageError({
        reason: "unsupportedHost",
        detail: `this package is built for ${built}, not ${target}`,
      });
    }
  };

  const install = (paths: {
    readonly artifactPath: string;
    readonly manifestPath: string;
    readonly signaturePath: string;
  }) =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () => {
          requireTarget(paths.manifestPath);
          return tool.install({
            ...paths,
            trustedKeys: trustedKeys(),
            targetDir: root,
            checkPrerequisites: options.checkPrerequisites !== false,
          });
        },
        catch: (cause) => {
          if (isPackageError(cause)) return cause;
          const detail = cause instanceof Error ? cause.message : String(cause);
          // The installer reports Chrome and platform problems as plain messages.
          const unsupported = /prerequisite|platform|architecture|libc/i.test(detail);
          return new ManagedBrowserPackageError({
            reason: unsupported ? "unsupportedHost" : "rejected",
            detail,
          });
        },
      }),
    );

  const stage: PackageStore["stage"] = (candidate) =>
    install({
      artifactPath: candidate.archivePath,
      manifestPath: candidate.manifestPath,
      signaturePath: candidate.signaturePath,
    }).pipe(
      Effect.flatMap((installed) => {
        const manifest = manifestOf(installed.version);
        return manifest === null
          ? Effect.fail(failWith("installed release has no readable manifest"))
          : Effect.succeed(manifest);
      }),
    );

  const reverify: PackageStore["reverify"] = (version) => {
    const releaseDir = Path.join(versionsDir, version, "release");
    return install({
      artifactPath: Path.join(releaseDir, "payload.tar.gz"),
      manifestPath: Path.join(releaseDir, "manifest.json"),
      signaturePath: Path.join(releaseDir, "manifest.sig"),
    }).pipe(Effect.asVoid);
  };

  const switchTo: PackageStore["switchTo"] = (version) =>
    Effect.try({
      try: () => {
        if (manifestOf(version) === null) {
          throw new ManagedBrowserPackageError({
            reason: "notStaged",
            detail: `${version} is not installed`,
          });
        }
        const relative = Path.join("versions", version);
        const old = pointer("current");
        if (old === version) return;
        // `previous` first: if the next step is interrupted, rollback still has a verified target.
        if (old !== null) replaceLink("previous", Path.join("versions", old));
        replaceLink("current", relative);
      },
      catch: failWith,
    });

  const replaceLink = (name: string, target: string) => {
    const temporary = Path.join(root, `.${name}-${process.pid}-${Crypto.randomUUID()}.tmp`);
    FS.symlinkSync(target, temporary);
    FS.renameSync(temporary, Path.join(root, name));
  };

  const rollback: PackageStore["rollback"] = () =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () => tool.rollback(root, trustedKeys()),
        catch: failWith,
      }),
    ).pipe(Effect.map((result) => result.rolledBackTo));

  return {
    root,
    withLock: (effect) =>
      Effect.acquireUseRelease(
        acquire,
        () => effect,
        () => release,
      ),
    installedVersions: () => {
      try {
        return FS.readdirSync(versionsDir).filter((name) => parseSemver(name) !== null);
      } catch {
        return [];
      }
    },
    current: () => {
      const version = pointer("current");
      return version === null ? null : manifestOf(version);
    },
    previous: () => pointer("previous"),
    manifestOf,
    engineOf: (version) => {
      // The real path, so a relocated or symlinked root resolves once and the child sees a plain one.
      const versionDir = FS.realpathSync(Path.join(versionsDir, version));
      const manifest = JSON.parse(
        FS.readFileSync(Path.join(versionDir, "release", "manifest.json"), "utf8"),
      ) as { entrypoints?: { managed?: string } };
      const entry = manifest.entrypoints?.managed;
      if (entry === undefined || entry.startsWith("/") || entry.includes("..")) {
        throw new Error(`${version} has no managed entrypoint`);
      }
      return {
        command: Path.join(versionDir, "bin", "node"),
        args: [Path.join(versionDir, entry)],
      };
    },
    stage,
    reverify,
    switchTo,
    rollback,
  };
};
