// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
/**
 * Test support: small signed releases for the component installer, built with a key generated per run.
 *
 * The archives are real gzip tars signed with a real Ed25519 key and installed by the real audited
 * installer; only their contents are tiny stand-ins (a shell script where Node would be). The key never
 * leaves the test process and is never part of any shipped lock. `REAL_FIXTURE` is the separately signed,
 * full-size package a release build produced, for the tests that run its own Node and engine.
 */
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { hostTarget, type ComponentLock } from "./ManagedBrowserPackage.ts";

export const COMPONENT_DIR = Path.resolve(
  import.meta.dirname,
  "../../../../components/stealth-browser",
);
export const SHIPPED_LOCK = Path.resolve(
  import.meta.dirname,
  "../../../../components/stealth-browser.lock.json",
);

const FIXTURE_ROOT = "/workspace/ai/sandbox/active/stealth-browser-release/managed-package-final";
export const REAL_FIXTURE = {
  archive: Path.join(
    FIXTURE_ROOT,
    "signed managed fixture",
    "stealth-browser-v2.0.0-linux-x64.tar.gz",
  ),
  manifest: Path.join(FIXTURE_ROOT, "signed managed fixture", "manifest.json"),
  signature: Path.join(FIXTURE_ROOT, "signed managed fixture", "manifest.sig"),
  publicKey: Path.join(FIXTURE_ROOT, "fixture.pub.pem"),
};
export const realFixtureAvailable = FS.existsSync(REAL_FIXTURE.archive);

/**
 * `T3_TEST_TMPDIR` moves test directories off the system temp directory. Node reads every `package.json`
 * above a CommonJS file it loads, so a malformed one in the temp directory would break the installer bundle.
 */
export const makeTemporaryDirectory = (label: string) => {
  const parent = process.env.T3_TEST_TMPDIR ?? OS.tmpdir();
  FS.mkdirSync(parent, { recursive: true });
  return FS.mkdtempSync(Path.join(parent, `t3-${label}-`));
};

export const makeKeys = () => {
  const { publicKey, privateKey } = Crypto.generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (bytes: Buffer) => Crypto.sign(null, bytes, privateKey).toString("base64"),
  };
};
export type Keys = ReturnType<typeof makeKeys>;

export const CAPABILITIES = [
  "open",
  "attach",
  "execute",
  "subscribe",
  "ack",
  "upload",
  "download",
  "closeTab",
  "shutdown",
  "persistent-profile",
];

export const testLock = (
  keys: ReadonlyArray<Keys>,
  overrides: Partial<ComponentLock> = {},
): ComponentLock => ({
  adapterVersion: "1.0.0",
  engineProtocolVersion: "1.0.0",
  requiredCapabilities: ["open", "execute", "closeTab", "persistent-profile"],
  trustedPublicKeys: keys.map((key) => key.publicPem),
  baseline: null,
  releaseSource: null,
  ...overrides,
});

/** A lock as its file holds it: the host's baseline filed under its target, as production provisioning will. */
export const lockFileOf = (lock: ComponentLock, target: string = hostTarget()) => {
  const { baseline, ...rest } = lock;
  return { schemaVersion: 1, ...rest, baselines: { [target]: baseline } };
};

export interface BuiltRelease {
  readonly directory: string;
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly signaturePath: string;
}

export interface ReleaseSpec {
  readonly version: string;
  readonly keys: Keys;
  readonly adapterRange?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly engineProtocolVersion?: string;
  readonly os?: string;
  readonly arch?: string;
  readonly stateSchemaVersion?: string;
  /** Different payload bytes at the same version. */
  readonly marker?: string;
  /** Flip a byte of the archive after it was signed for. */
  readonly corruptArchive?: boolean;
  readonly archiveFileName?: string;
}

/** Builds `<root>/<name>/{manifest.json,manifest.sig,archive}` the way a release build lays them out. */
export const buildRelease = (root: string, spec: ReleaseSpec): BuiltRelease => {
  const directory = Path.join(root, `release-${spec.version}${spec.marker ?? ""}`);
  const payload = Path.join(directory, ".payload");
  FS.mkdirSync(Path.join(payload, "bin"), { recursive: true });
  FS.mkdirSync(Path.join(payload, "dist", "managed"), { recursive: true });
  // Stand-ins sized for a test; the installer cares only that these files exist.
  FS.writeFileSync(Path.join(payload, "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  FS.writeFileSync(
    Path.join(payload, "dist", "server.js"),
    `// ${spec.version} ${spec.marker ?? ""}\n`,
  );
  FS.writeFileSync(
    Path.join(payload, "dist", "managed", "main.js"),
    `// managed ${spec.version} ${spec.marker ?? ""}\n`,
  );
  const archiveFileName = `stealth-browser-v${spec.version}-${spec.os ?? "linux"}-${spec.arch ?? "x64"}.tar.gz`;
  const archivePath = Path.join(directory, archiveFileName);
  ChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", payload, "bin", "dist"]);
  FS.rmSync(payload, { recursive: true });
  const bytes = FS.readFileSync(archivePath);
  const manifest = {
    schemaVersion: "1.0.0",
    name: "stealth-browser",
    version: spec.version,
    sourceCommit: "279bbe3ddfac11e140e3b66fb94448650e852b2b",
    os: spec.os ?? "linux",
    arch: spec.arch ?? "x64",
    ...(spec.os === "darwin" ? { minOsVersion: "13.0" } : { minLibcVersion: "2.31" }),
    engineProtocolVersion: spec.engineProtocolVersion ?? "1.0.0",
    supportedAdapterRange: spec.adapterRange ?? ">=1.0.0 <3.0.0",
    nodeVersion: "24.16.0",
    patchrightVersion: "1.59.4",
    stateSchemaVersion: spec.stateSchemaVersion ?? "1.0.0",
    entrypoint: "dist/server.js",
    entrypoints: { standalone: "dist/server.js", managed: "dist/managed/main.js" },
    capabilities: spec.capabilities ?? CAPABILITIES,
    browserPrerequisites: {
      browser: "chrome",
      alternatives: ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"],
      requiredVersionRange: ">=128.0.0.0",
    },
    archiveFileName: spec.archiveFileName ?? archiveFileName,
    archiveSha256: Crypto.createHash("sha256").update(bytes).digest("hex"),
    archiveSize: bytes.length,
    createdAt: "2026-10-17T00:00:00.000Z",
    protocolAssets: {
      schemaDir: "protocol/schemas",
      fixturesDir: "protocol/fixtures",
      typesFile: "protocol/protocol.d.ts",
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const manifestPath = Path.join(directory, "manifest.json");
  const signaturePath = Path.join(directory, "manifest.sig");
  FS.writeFileSync(manifestPath, manifestBytes);
  FS.writeFileSync(signaturePath, spec.keys.sign(manifestBytes));
  if (spec.corruptArchive === true) {
    const corrupted = Buffer.from(bytes);
    const middle = Math.floor(corrupted.length / 2);
    corrupted.writeUInt8(corrupted.readUInt8(middle) ^ 0xff, middle);
    FS.writeFileSync(archivePath, corrupted);
  }
  return { directory, archivePath, manifestPath, signaturePath };
};
