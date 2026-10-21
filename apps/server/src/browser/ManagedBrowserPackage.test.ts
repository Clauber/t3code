// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off
import * as FS from "node:fs";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";
import {
  COMPONENT_DIR,
  REAL_FIXTURE,
  SHIPPED_LOCK,
  buildRelease,
  lockFileOf,
  makeKeys,
  makeTemporaryDirectory,
  realFixtureAvailable,
  testLock,
} from "./ManagedBrowserUpdateFixture.ts";

const tool = ManagedBrowserPackage.loadReleaseTool(COMPONENT_DIR);

const storeFor = (root: string, keys: ReadonlyArray<ReturnType<typeof makeKeys>>) =>
  ManagedBrowserPackage.makePackageStore({
    root,
    lock: testLock(keys),
    tool,
    // The synthetic releases test the installer's selection and integrity, not this host's Chrome.
    checkPrerequisites: false,
  });

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  const reason = Exit.isFailure(exit)
    ? exit.cause.reasons.find((entry) => entry._tag === "Fail")
    : undefined;
  return (reason as { error?: { reason?: string; detail?: string } } | undefined)?.error;
};

describe("the shipped lock", () => {
  it("names no key, baseline or source until production provisions them", () => {
    const lock = ManagedBrowserPackage.readComponentLock(SHIPPED_LOCK);
    assert.deepEqual(lock.trustedPublicKeys, []);
    assert.isNull(lock.baseline);
    assert.isNull(ManagedBrowserPackage.readComponentLock(SHIPPED_LOCK, "darwin-arm64").baseline);
    assert.isNull(lock.releaseSource);
  });

  it("is read per target: each host is held to its own baseline and no other", () => {
    const directory = makeTemporaryDirectory("package-lock");
    const entry = (version: string) => ({
      version,
      archiveSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
    });
    const write = (override: Record<string, unknown> = {}) => {
      const file = Path.join(directory, "lock.json");
      FS.writeFileSync(
        file,
        JSON.stringify({
          ...lockFileOf(testLock([])),
          baselines: { "linux-x64": entry("2.0.0"), "darwin-arm64": entry("3.0.0") },
          ...override,
        }),
      );
      return file;
    };
    assert.equal(
      ManagedBrowserPackage.readComponentLock(write(), "linux-x64").baseline?.version,
      "2.0.0",
    );
    assert.equal(
      ManagedBrowserPackage.readComponentLock(write(), "darwin-arm64").baseline?.version,
      "3.0.0",
    );
    // A platform with no package is just unprovisioned; it is never handed another platform's.
    assert.isNull(ManagedBrowserPackage.readComponentLock(write(), "win32-x64").baseline);
    assert.isNull(
      ManagedBrowserPackage.readComponentLock(
        write({ baselines: { "linux-x64": entry("2.0.0"), "darwin-arm64": null } }),
        "darwin-arm64",
      ).baseline,
    );
    // The single-baseline format and an unknown target are malformed, not silently ignored.
    const { baselines: _removed, ...withoutBaselines } = lockFileOf(testLock([]));
    for (const bad of [
      { ...withoutBaselines, baseline: entry("2.0.0") },
      { baselines: { "freebsd-x64": entry("2.0.0") } },
      { baselines: { "linux-x64": { version: "2.0.0" } } },
    ]) {
      FS.writeFileSync(
        Path.join(directory, "bad.json"),
        JSON.stringify({ ...lockFileOf(testLock([])), ...bad }),
      );
      assert.throws(
        () =>
          ManagedBrowserPackage.readComponentLock(Path.join(directory, "bad.json"), "linux-x64"),
        /malformed/,
      );
    }
  });

  it("never installs a package built for another platform, before the installer is asked", async () => {
    const keys = makeKeys();
    const root = makeTemporaryDirectory("package-foreign");
    const linux = buildRelease(root, { version: "2.0.0", keys });
    let asked = 0;
    const counting: ManagedBrowserPackage.ReleaseTool = {
      ...tool,
      install: (input) => {
        asked += 1;
        return tool.install(input);
      },
    };
    const store = ManagedBrowserPackage.makePackageStore({
      root: Path.join(root, "install"),
      lock: testLock([keys]),
      tool: counting,
      checkPrerequisites: false,
      target: "darwin-arm64",
    });
    const exit = await Effect.runPromiseExit(
      store.withLock(
        store.stage({
          manifestPath: linux.manifestPath,
          signaturePath: linux.signaturePath,
          archivePath: linux.archivePath,
        }),
      ),
    );
    assert.equal(failure(exit)?.reason, "unsupportedHost");
    assert.match(failure(exit)?.detail ?? "", /built for linux-x64, not darwin-arm64/);
    assert.equal(asked, 0);
  });

  it.skipIf(!realFixtureAvailable)("never carries the fixture's key", () => {
    const fixtureKey = FS.readFileSync(REAL_FIXTURE.publicKey, "utf8").trim();
    const everything = [
      FS.readFileSync(SHIPPED_LOCK, "utf8"),
      FS.readFileSync(Path.join(COMPONENT_DIR, "SOURCES.json"), "utf8"),
    ].join("\n");
    assert.notInclude(everything, fixtureKey.split("\n")[1]!);
  });

  it("refuses to install anything while no signing key is provisioned", () => {
    const directory = makeTemporaryDirectory("package-unprovisioned");
    const keys = makeKeys();
    const release = buildRelease(directory, { version: "2.0.0", keys });
    const store = ManagedBrowserPackage.makePackageStore({
      root: Path.join(directory, "root"),
      lock: testLock([]),
      tool,
      checkPrerequisites: false,
    });
    const exit = Effect.runSyncExit(
      store.withLock(
        store.stage({
          manifestPath: release.manifestPath,
          signaturePath: release.signaturePath,
          archivePath: release.archivePath,
        }),
      ),
    );
    assert.equal(failure(exit)?.reason, "unprovisioned");
    assert.deepEqual(store.installedVersions(), []);
  });

  it("rejects a malformed lock instead of reading it as empty", () => {
    const directory = makeTemporaryDirectory("package-lock");
    const path = Path.join(directory, "lock.json");
    FS.writeFileSync(path, JSON.stringify({ schemaVersion: 1, trustedPublicKeys: "oops" }));
    assert.throws(() => ManagedBrowserPackage.readComponentLock(path), /malformed/);
  });
});

describe("a lock naming a GitHub release source", () => {
  const lockWith = (releaseSource: unknown) => {
    const path = Path.join(makeTemporaryDirectory("package-github-lock"), "lock.json");
    FS.writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(FS.readFileSync(SHIPPED_LOCK, "utf8")), releaseSource }),
    );
    return path;
  };

  it("reads the repository and the name of a secret, never a token", () => {
    const lock = ManagedBrowserPackage.readComponentLock(
      lockWith({
        kind: "github",
        repository: "acme/stealth-browser",
        tokenSecret: "release-token",
      }),
    );
    assert.deepEqual(lock.releaseSource, {
      kind: "github",
      repository: "acme/stealth-browser",
      tokenSecret: "release-token",
    });
  });

  it("rejects a malformed repository or an unknown kind", () => {
    for (const source of [
      { kind: "github", repository: "no-slash" },
      { kind: "github", repository: "a/b/c" },
      { kind: "github", repository: "acme/x", tokenSecret: 5 },
      { kind: "ftp", repository: "acme/x" },
    ]) {
      assert.throws(() => ManagedBrowserPackage.readComponentLock(lockWith(source)), /malformed/);
    }
  });
});

describe("installing and switching releases", () => {
  it.effect(
    "stages without activating and then switches current, keeping the old as previous",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-switch");
        const keys = makeKeys();
        const store = storeFor(Path.join(directory, "root"), [keys]);
        const first = buildRelease(directory, { version: "2.0.0", keys });
        const second = buildRelease(directory, { version: "2.1.0", keys });
        const stage = (release: typeof first) =>
          store.withLock(
            store.stage({
              manifestPath: release.manifestPath,
              signaturePath: release.signaturePath,
              archivePath: release.archivePath,
            }),
          );
        yield* stage(first);
        // Staging alone never moves what runs.
        assert.isNull(store.current());
        yield* store.withLock(store.switchTo("2.0.0"));
        yield* stage(second);
        assert.equal(store.current()?.version, "2.0.0");
        yield* store.withLock(store.switchTo("2.1.0"));
        assert.equal(store.current()?.version, "2.1.0");
        assert.equal(store.previous(), "2.0.0");
        // The pointers are relative, so the whole root can move.
        assert.equal(FS.readlinkSync(Path.join(store.root, "current")), "versions/2.1.0");
      }),
  );

  it.effect(
    "rejects a wrong key, a changed manifest and a corrupt archive, installing nothing",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-reject");
        const keys = makeKeys();
        const stranger = makeKeys();
        const root = Path.join(directory, "root");
        const store = storeFor(root, [keys]);
        const attempt = (release: ReturnType<typeof buildRelease>) =>
          Effect.exit(
            store.withLock(
              store.stage({
                manifestPath: release.manifestPath,
                signaturePath: release.signaturePath,
                archivePath: release.archivePath,
              }),
            ),
          );

        const wrongKey = buildRelease(directory, { version: "2.1.0", keys: stranger });
        assert.equal(failure(yield* attempt(wrongKey))?.reason, "rejected");

        const changed = buildRelease(directory, { version: "2.2.0", keys });
        FS.writeFileSync(
          changed.manifestPath,
          FS.readFileSync(changed.manifestPath, "utf8").replace('"2.2.0"', '"9.9.9"'),
        );
        assert.equal(failure(yield* attempt(changed))?.reason, "rejected");

        const corrupt = buildRelease(directory, { version: "2.3.0", keys, corruptArchive: true });
        const corruptResult = failure(yield* attempt(corrupt));
        assert.equal(corruptResult?.reason, "rejected");
        assert.match(corruptResult?.detail ?? "", /digest|size|gzip|archive/i);

        const wrongPlatform = buildRelease(directory, { version: "2.4.0", keys, os: "darwin" });
        assert.equal(failure(yield* attempt(wrongPlatform))?.reason, "unsupportedHost");

        // Nothing became a version, and no staging directory was left to be mistaken for one.
        assert.deepEqual(store.installedVersions(), []);
        assert.deepEqual(
          FS.existsSync(Path.join(root, "versions"))
            ? FS.readdirSync(Path.join(root, "versions"))
            : [],
          [],
        );
      }),
  );

  it.effect(
    "rolls back only to a previous release whose every byte still matches its archive",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-rollback");
        const keys = makeKeys();
        const store = storeFor(Path.join(directory, "root"), [keys]);
        for (const version of ["2.0.0", "2.1.0"]) {
          const release = buildRelease(directory, { version, keys });
          yield* store.withLock(
            store.stage({
              manifestPath: release.manifestPath,
              signaturePath: release.signaturePath,
              archivePath: release.archivePath,
            }),
          );
          yield* store.withLock(store.switchTo(version));
        }
        assert.equal(store.current()?.version, "2.1.0");

        // The same number of bytes, so a size check alone would pass.
        const file = Path.join(store.root, "versions", "2.0.0", "dist", "server.js");
        const original = FS.readFileSync(file);
        FS.writeFileSync(file, Buffer.from(original).fill(0x78));
        const refused = yield* Effect.exit(store.withLock(store.rollback()));
        assert.equal(failure(refused)?.reason, "rejected");
        assert.equal(store.current()?.version, "2.1.0");
        assert.deepEqual(FS.readFileSync(file), Buffer.from(original).fill(0x78));

        FS.writeFileSync(file, original);
        assert.equal(yield* store.withLock(store.rollback()), "2.0.0");
        assert.equal(store.current()?.version, "2.0.0");
        assert.equal(store.previous(), "2.1.0");
      }),
  );

  it.effect("re-verifies an installed release's whole tree", () =>
    Effect.gen(function* () {
      const directory = makeTemporaryDirectory("package-reverify");
      const keys = makeKeys();
      const store = storeFor(Path.join(directory, "root"), [keys]);
      const release = buildRelease(directory, { version: "2.0.0", keys });
      yield* store.withLock(
        store.stage({
          manifestPath: release.manifestPath,
          signaturePath: release.signaturePath,
          archivePath: release.archivePath,
        }),
      );
      yield* store.withLock(store.reverify("2.0.0"));
      FS.writeFileSync(Path.join(store.root, "versions", "2.0.0", "dist", "extra.js"), "x");
      const exit = yield* Effect.exit(store.withLock(store.reverify("2.0.0")));
      assert.equal(failure(exit)?.reason, "rejected");
    }),
  );
});

describe("the exclusive installation lock", () => {
  it.effect("refuses a second holder at once and frees the lock afterwards", () =>
    Effect.gen(function* () {
      const directory = makeTemporaryDirectory("package-lock-held");
      const store = storeFor(Path.join(directory, "root"), [makeKeys()]);
      const inner = yield* store.withLock(Effect.exit(store.withLock(Effect.void)));
      assert.equal(failure(inner)?.reason, "locked");
      yield* store.withLock(Effect.void);
    }),
  );

  it.effect(
    "takes over a lock whose holder died, including the installer's own leftover lock",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-lock-stale");
        const root = Path.join(directory, "root");
        FS.mkdirSync(root, { recursive: true });
        // A pid that cannot be alive.
        FS.writeFileSync(Path.join(root, ".update.lock"), "2147483646");
        FS.writeFileSync(Path.join(root, ".install.lock"), "");
        const keys = makeKeys();
        const store = storeFor(root, [keys]);
        const release = buildRelease(directory, { version: "2.0.0", keys });
        yield* store.withLock(
          store.stage({
            manifestPath: release.manifestPath,
            signaturePath: release.signaturePath,
            archivePath: release.archivePath,
          }),
        );
        assert.deepEqual(store.installedVersions(), ["2.0.0"]);
      }),
  );
});

describe("choosing among offered releases", () => {
  const keys = makeKeys();
  const lock = testLock([keys]);
  const candidate = (
    directory: string,
    spec: Parameters<typeof buildRelease>[1],
  ): ManagedBrowserPackage.ReleaseCandidate => {
    const built = buildRelease(directory, spec);
    return {
      version: spec.version,
      files: Effect.succeed({
        manifestPath: built.manifestPath,
        signaturePath: built.signaturePath,
        archivePath: built.archivePath,
      }),
      manifest: JSON.parse(FS.readFileSync(built.manifestPath, "utf8")),
    };
  };
  const installed = { version: "2.0.0", stateSchemaVersion: "1.0.0" };
  const problem = (spec: Omit<Parameters<typeof buildRelease>[1], "keys">) =>
    ManagedBrowserPackage.compatibilityProblem(
      candidate(makeTemporaryDirectory("package-choose"), { ...spec, keys }).manifest,
      lock,
      tool,
      installed,
    );

  it("accepts a newer stable release that declares compatibility", () => {
    assert.isNull(problem({ version: "2.1.0" }));
  });

  it("rejects what is not newer, so there is no implicit downgrade", () => {
    assert.match(problem({ version: "2.0.0" }) ?? "", /not newer/);
    assert.match(problem({ version: "1.9.0" }) ?? "", /not newer/);
  });

  it("rejects an adapter range, protocol, capability, state format or prerelease T3 cannot take", () => {
    assert.match(problem({ version: "2.1.0", adapterRange: ">=2.0.0 <3.0.0" }) ?? "", /adapter/);
    assert.match(
      problem({ version: "2.1.0", capabilities: ["open", "execute"] }) ?? "",
      /lacks capability/,
    );
    assert.match(problem({ version: "2.1.0", stateSchemaVersion: "2.0.0" }) ?? "", /state format/);
    assert.match(problem({ version: "2.1.0-beta.1" }) ?? "", /stable/);
    assert.match(problem({ version: "2.1.0", os: "darwin" }) ?? "", /built for darwin-x64/);
  });

  it("holds a package to the host's own platform, whatever the installer would accept", () => {
    const linux = candidate(makeTemporaryDirectory("package-target"), { version: "2.1.0", keys });
    const mac = candidate(makeTemporaryDirectory("package-target"), {
      version: "2.1.0",
      keys,
      os: "darwin",
      arch: "arm64",
    });
    const asked = (manifest: ManagedBrowserPackage.ReleaseCandidate["manifest"], target: string) =>
      ManagedBrowserPackage.compatibilityProblem(manifest, lock, tool, installed, target);
    // A Linux package is refused on a Mac, and a Mac package on Linux, before any installer runs.
    assert.match(
      asked(linux.manifest, "darwin-arm64") ?? "",
      /built for linux-x64, not darwin-arm64/,
    );
    assert.match(asked(mac.manifest, "linux-x64") ?? "", /built for darwin-arm64, not linux-x64/);
    assert.isNull(asked(linux.manifest, "linux-x64"));
  });
});

describe("a directory of offered releases", () => {
  it.effect("lists releases, one per subdirectory, and skips an archive name that escapes", () =>
    Effect.gen(function* () {
      const directory = makeTemporaryDirectory("package-source");
      const keys = makeKeys();
      buildRelease(directory, { version: "2.1.0", keys });
      buildRelease(directory, { version: "2.2.0", keys, archiveFileName: "../escape.tar.gz" });
      buildRelease(directory, { version: "2.3.0", keys, archiveFileName: ".hidden.tar.gz" });
      const offered = yield* ManagedBrowserPackage.directorySource(directory).list;
      assert.deepEqual(
        offered.map((entry) => entry.version),
        ["2.1.0"],
      );
    }),
  );

  it.effect("reports an unreachable source as unavailable", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        ManagedBrowserPackage.directorySource("/nonexistent/releases").list,
      );
      assert.equal(failure(exit)?.reason, "sourceUnavailable");
    }),
  );
});

describe.skipIf(!realFixtureAvailable)("the signed fixture package", () => {
  const trusted = realFixtureAvailable ? [FS.readFileSync(REAL_FIXTURE.publicKey, "utf8")] : [];
  const realStore = (root: string) =>
    ManagedBrowserPackage.makePackageStore({
      root,
      lock: { ...testLock([]), trustedPublicKeys: trusted },
      tool,
    });
  const real = {
    manifestPath: REAL_FIXTURE.manifest,
    signaturePath: REAL_FIXTURE.signature,
    archivePath: REAL_FIXTURE.archive,
  };

  it.effect(
    "installs under a path with spaces and still resolves its own Node and engine after the root moves",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-real");
        const first = Path.join(directory, "a place with spaces", "package");
        const store = realStore(first);
        yield* store.withLock(store.stage(real));
        yield* store.withLock(store.switchTo("2.0.0"));
        const before = store.engineOf("2.0.0");
        assert.include(before.command, "a place with spaces");

        // Relocating the root (a moved T3 home) must not break the engine's own resources.
        const second = Path.join(directory, "moved elsewhere", "package");
        FS.mkdirSync(Path.dirname(second), { recursive: true });
        FS.renameSync(first, second);
        const moved = realStore(second);
        const after = moved.engineOf(moved.current()!.version);
        assert.include(after.command, "moved elsewhere");
        assert.isTrue(FS.statSync(after.command).isFile());
        assert.isTrue(FS.statSync(after.args[0]!).isFile());
        // Reverifying the moved tree proves it is still byte for byte the signed archive.
        yield* moved.withLock(moved.reverify("2.0.0"));
      }),
    120_000,
  );

  it.effect("rejects a corrupt copy of the signed archive and installs nothing", () =>
    Effect.gen(function* () {
      const directory = makeTemporaryDirectory("package-real-corrupt");
      const corrupt = Path.join(directory, "stealth-browser-v2.0.0-linux-x64.tar.gz");
      FS.copyFileSync(REAL_FIXTURE.archive, corrupt);
      const fd = FS.openSync(corrupt, "r+");
      FS.writeSync(fd, Buffer.from([0xde, 0xad]), 0, 2, 1024);
      FS.closeSync(fd);
      const store = realStore(Path.join(directory, "root"));
      const exit = yield* Effect.exit(
        store.withLock(store.stage({ ...real, archivePath: corrupt })),
      );
      assert.equal(failure(exit)?.reason, "rejected");
      assert.match(failure(exit)?.detail ?? "", /digest/i);
      assert.deepEqual(store.installedVersions(), []);
    }),
  );
});
