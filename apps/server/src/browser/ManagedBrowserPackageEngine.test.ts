// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off globalTimersInEffect:off globalTimers:off
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  EnvironmentId,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";
import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";
import * as ManagedBrowserSmoke from "./ManagedBrowserSmoke.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";
import * as ManagedBrowserUpdate from "./ManagedBrowserUpdate.ts";
import { stageStealthBrowserComponent } from "../../../../scripts/lib/stealth-browser-component.ts";
import {
  COMPONENT_DIR,
  REAL_FIXTURE,
  makeTemporaryDirectory,
  realFixtureAvailable,
  lockFileOf,
  testLock,
} from "./ManagedBrowserUpdateFixture.ts";

const ownerEnvironmentId = EnvironmentId.make("env-owner");
const descriptor = {
  ownerEnvironmentId,
  instanceId: ManagedBrowserInstanceId.make("instance-real"),
  profileId: ManagedBrowserProfileId.make("profile-real"),
};

/**
 * The whole path with the real parts: the signed fixture package installed as the baseline by the audited
 * installer, then its own bundled Node and engine launched by the real IPC launcher through the pointer
 * the update service maintains, before and after the installation root is moved.
 */
describe.skipIf(!realFixtureAvailable)("a signed package installed and launched", () => {
  const tool = ManagedBrowserPackage.loadReleaseTool(COMPONENT_DIR);
  const sha256 = (path: string) =>
    Crypto.createHash("sha256").update(FS.readFileSync(path)).digest("hex");

  const withInstallation = <A, E>(
    root: string,
    dataRoot: string,
    body: (context: {
      readonly update: ManagedBrowserUpdate.ManagedBrowserUpdate["Service"];
      readonly supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];
      readonly options: ManagedBrowserIpc.ManagedBrowserIpcOptions;
    }) => Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    /** A staged component directory (tools, lock, baseline) to run from instead of the source tree. */
    component?: string,
  ) => {
    const manifest = JSON.parse(FS.readFileSync(REAL_FIXTURE.manifest, "utf8")) as {
      archiveSha256: string;
    };
    const lock =
      component === undefined
        ? {
            ...testLock([]),
            trustedPublicKeys: [FS.readFileSync(REAL_FIXTURE.publicKey, "utf8")],
            baseline: {
              version: "2.0.0",
              archiveSha256: manifest.archiveSha256,
              manifestSha256: sha256(REAL_FIXTURE.manifest),
            },
          }
        : ManagedBrowserPackage.readComponentLock(Path.join(component, "lock.json"));
    const installer =
      component === undefined ? tool : ManagedBrowserPackage.loadReleaseTool(component);
    const baselineDirectory =
      component === undefined
        ? Path.dirname(REAL_FIXTURE.manifest)
        : Path.join(component, "baseline");
    const store = ManagedBrowserPackage.makePackageStore({ root, lock, tool: installer });
    const options: ManagedBrowserIpc.ManagedBrowserIpcOptions = {
      command: process.execPath,
      args: [],
      dataRoot,
      environment: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? OS.tmpdir(),
        DISPLAY: "",
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
          ? {}
          : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
      },
      adapterVersion: "1.0.0",
      headless: true,
      // Chosen per launch from the pointer, as the server does.
      resolveEngine: () => store.engineOf(store.current()!.version),
    };
    const supervisor = ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
      Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mergeAll(
          ManagedBrowserIpc.layer(options).pipe(Layer.provide(NodeServices.layer)),
          NodeCrypto.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const update = ManagedBrowserUpdate.layer({
        root,
        lock,
        tool: installer,
        source: null,
        baseline: ManagedBrowserPackage.directorySource(baselineDirectory),
        smoke: ManagedBrowserSmoke.makeLauncherSmoke(
          { ...options, resolveEngine: undefined },
          ownerEnvironmentId,
          spawner,
        ),
        schedule: false,
      }).pipe(Layer.provideMerge(supervisor));
      return yield* Effect.gen(function* () {
        return yield* body({
          update: yield* ManagedBrowserUpdate.ManagedBrowserUpdate,
          supervisor: yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor,
          options,
        });
      }).pipe(Effect.provide(update), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer));
  };

  it.live(
    "installs the baseline, launches its own Node and engine, and does so again from a moved root",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-engine");
        const first = Path.join(directory, "a place with spaces", "package");
        const dataRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-pe-"));
        yield* withInstallation(first, dataRoot, ({ update, supervisor }) =>
          Effect.gen(function* () {
            const status = yield* update.status;
            assert.equal(status.current, "2.0.0");
            assert.isTrue(status.hosting.available);
            // The real child: hello advertised the package version and the capabilities T3 requires.
            const live = yield* supervisor.ensure(descriptor);
            assert.isDefined(live.incarnation);
            assert.include(update.engine().command, "a place with spaces");
          }),
        );

        // The scope above ended, which proves the child exited. Move the installation and start again.
        const second = Path.join(directory, "moved", "package");
        FS.mkdirSync(Path.dirname(second), { recursive: true });
        FS.renameSync(first, second);
        yield* withInstallation(second, dataRoot, ({ update, supervisor }) =>
          Effect.gen(function* () {
            assert.equal((yield* update.status).current, "2.0.0");
            assert.include(update.engine().command, "moved");
            assert.isDefined((yield* supervisor.ensure(descriptor)).incarnation);
          }),
        );
        FS.rmSync(dataRoot, { recursive: true, force: true });
      }),
    180_000,
  );

  it.live(
    "the smoke check passes the installed release and fails one that reports another version",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-engine-smoke");
        const dataRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-pe-"));
        yield* withInstallation(Path.join(directory, "package"), dataRoot, ({ update, options }) =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const smoke = ManagedBrowserSmoke.makeLauncherSmoke(
              { ...options, resolveEngine: undefined },
              ownerEnvironmentId,
              spawner,
            );
            yield* smoke(update.engine(), "2.0.0");
            const wrong = yield* Effect.exit(smoke(update.engine(), "2.0.1"));
            assert.isTrue(Exit.isFailure(wrong));
          }),
        );
        FS.rmSync(dataRoot, { recursive: true, force: true });
      }),
    180_000,
  );

  it.live(
    "staging the full-size package leaves the event loop free",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-loop");
        const manifest = JSON.parse(FS.readFileSync(REAL_FIXTURE.manifest, "utf8")) as {
          archiveSha256: string;
        };
        const store = ManagedBrowserPackage.makePackageStore({
          root: Path.join(directory, "package"),
          lock: {
            ...testLock([]),
            trustedPublicKeys: [FS.readFileSync(REAL_FIXTURE.publicKey, "utf8")],
          },
          tool,
        });
        // A heartbeat that must keep beating while the archive is hashed, extracted and compared.
        let last = Date.now();
        let longestGap = 0;
        const beat = setInterval(() => {
          const now = Date.now();
          longestGap = Math.max(longestGap, now - last);
          last = now;
        }, 10);
        const staged = yield* store
          .withLock(
            store.stage({
              archivePath: REAL_FIXTURE.archive,
              manifestPath: REAL_FIXTURE.manifest,
              signaturePath: REAL_FIXTURE.signature,
            }),
          )
          .pipe(Effect.ensuring(Effect.sync(() => clearInterval(beat))));
        assert.equal(staged.archiveSha256, manifest.archiveSha256);
        // Installed correctly, and the loop never stalled for as long as the old in-process work did.
        assert.isBelow(longestGap, 400, `the event loop stalled for ${longestGap} ms`);
        yield* store.withLock(store.reverify("2.0.0"));
        FS.rmSync(directory, { recursive: true, force: true });
      }),
    180_000,
  );

  /** Paths of live processes whose command line mentions `needle`, read from /proc (never signalled). */
  const processesMentioning = (needle: string) =>
    FS.readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .filter((entry) => {
        try {
          return FS.readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(needle);
        } catch {
          return false;
        }
      });

  it.live(
    "the smoke check drives a real Chrome page, then leaves no profile or process behind",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-engine-page");
        const dataRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-pe-"));
        yield* withInstallation(Path.join(directory, "package"), dataRoot, ({ update, options }) =>
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            // A hello-only engine would pass the old check: it starts and speaks the protocol.
            // Without a usable Chrome it must fail on the page itself.
            const noChrome = ManagedBrowserSmoke.makeLauncherSmoke(
              {
                ...options,
                resolveEngine: undefined,
                browserExecutable: "/nonexistent/chrome",
              },
              ownerEnvironmentId,
              spawner,
            );
            const failed = yield* Effect.exit(noChrome(update.engine(), "2.0.0"));
            assert.isTrue(Exit.isFailure(failed));

            const smoke = ManagedBrowserSmoke.makeLauncherSmoke(
              { ...options, resolveEngine: undefined },
              ownerEnvironmentId,
              spawner,
            );
            const before = new Set(
              FS.readdirSync(OS.tmpdir()).filter((n) => n.startsWith("t3-bsmoke-")),
            );
            yield* smoke(update.engine(), "2.0.0");
            // Every smoke directory this check made is gone and no process still names one.
            const leftover = FS.readdirSync(OS.tmpdir()).filter(
              (n) => n.startsWith("t3-bsmoke-") && !before.has(n),
            );
            assert.deepEqual(leftover, []);
            // The needle is built here, so no command line that merely quotes this file contains it.
            assert.deepEqual(processesMentioning(Path.join(OS.tmpdir(), "t3-bsmoke-")), []);
          }),
        );
        FS.rmSync(dataRoot, { recursive: true, force: true });
      }),
    180_000,
  );

  it.live(
    "a component staged for a CLI archive or the desktop's resources installs and launches the baseline",
    () =>
      Effect.gen(function* () {
        const directory = makeTemporaryDirectory("package-layout");
        const manifest = JSON.parse(FS.readFileSync(REAL_FIXTURE.manifest, "utf8")) as {
          archiveSha256: string;
        };
        const lockPath = Path.join(directory, "lock.json");
        FS.writeFileSync(
          lockPath,
          JSON.stringify(
            lockFileOf({
              ...testLock([]),
              trustedPublicKeys: [FS.readFileSync(REAL_FIXTURE.publicKey, "utf8")],
              baseline: {
                version: "2.0.0",
                archiveSha256: manifest.archiveSha256,
                manifestSha256: sha256(REAL_FIXTURE.manifest),
              },
            }),
          ),
        );
        const repoRoot = Path.resolve(import.meta.dirname, "../../../..");
        // `t3` + `stealth-browser/` side by side; `resources/stealth-browser` found through the desktop's variable.
        const layouts = [
          { name: "cli", bundleDir: Path.join(directory, "cli"), environment: {} },
          {
            name: "desktop",
            bundleDir: Path.join(directory, "elsewhere", "dist"),
            environment: {
              T3CODE_STEALTH_BROWSER_COMPONENT_DIR: Path.join(
                directory,
                "resources",
                "stealth-browser",
              ),
            },
          },
        ] as const;
        for (const layout of layouts) {
          const destination =
            layout.name === "cli"
              ? Path.join(layout.bundleDir, "stealth-browser")
              : Path.join(directory, "resources", "stealth-browser");
          const staged = yield* Effect.promise(() =>
            stageStealthBrowserComponent({
              repoRoot,
              destination,
              baselineDirectory: Path.dirname(REAL_FIXTURE.manifest),
              platform: "linux",
              arch: "x64",
              lockPath,
              required: true,
            }),
          );
          assert.equal(staged.status, "staged");
          const found = ManagedBrowserPackage.resolveComponentDir(
            layout.environment,
            layout.bundleDir,
          );
          assert.equal(found, destination);
          const dataRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-pl-"));
          yield* withInstallation(
            Path.join(directory, layout.name, "state a b", "package"),
            dataRoot,
            ({ update, supervisor }) =>
              Effect.gen(function* () {
                const status = yield* update.status;
                assert.equal(status.current, "2.0.0");
                assert.isTrue(status.hosting.available);
                // The release installed from the staged baseline, run with its own Node and engine.
                assert.isDefined((yield* supervisor.ensure(descriptor)).incarnation);
              }),
            found!,
          );
          FS.rmSync(dataRoot, { recursive: true, force: true });
        }
      }),
    240_000,
  );
});
