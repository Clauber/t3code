// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off globalTimers:off
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  EnvironmentId,
  ManagedBrowserInstanceId,
  ManagedBrowserPrincipalId,
  ManagedBrowserProfileId,
  type ManagedBrowserPrincipal,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as GithubSource from "./ManagedBrowserGithubSource.ts";
import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";
import { serveGithub } from "./ManagedBrowserGithubFixture.ts";
import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";
import * as ManagedBrowserSmoke from "./ManagedBrowserSmoke.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";
import * as ManagedBrowserUpdate from "./ManagedBrowserUpdate.ts";
import {
  COMPONENT_DIR,
  buildRelease,
  makeKeys,
  makeTemporaryDirectory,
  testLock,
  type Keys,
} from "./ManagedBrowserUpdateFixture.ts";

const ownerEnvironmentId = EnvironmentId.make("env-owner");
const descriptor = {
  ownerEnvironmentId,
  instanceId: ManagedBrowserInstanceId.make("instance-a"),
  profileId: ManagedBrowserProfileId.make("profile-a"),
};
const secondDescriptor = {
  ownerEnvironmentId,
  instanceId: ManagedBrowserInstanceId.make("instance-b"),
  profileId: ManagedBrowserProfileId.make("profile-b"),
};
const human: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("human-1"),
  kind: "human",
  access: "operate",
};
const agent: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("agent-1"),
  kind: "agent",
  access: "operate",
};

const tool = ManagedBrowserPackage.loadReleaseTool(COMPONENT_DIR);
type UpdateService = ManagedBrowserUpdate.ManagedBrowserUpdate["Service"];
type SupervisorService = ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];

// ---------------------------------------------------------------------------
// A world: a directory of releases, a shipped baseline and an installation root
// ---------------------------------------------------------------------------

interface World {
  readonly directory: string;
  readonly root: string;
  readonly keys: Keys;
  readonly offered: string;
  readonly baselineDirectory: string;
  readonly lock: ManagedBrowserPackage.ComponentLock;
}

type OfferedRelease = Omit<Parameters<typeof buildRelease>[1], "keys"> & { readonly keys?: Keys };

const makeWorld = (
  offeredReleases: ReadonlyArray<OfferedRelease>,
  baselineAdapterRange?: string,
): World => {
  const directory = makeTemporaryDirectory("update");
  const keys = makeKeys();
  const offered = Path.join(directory, "offered");
  FS.mkdirSync(offered);
  for (const spec of offeredReleases) buildRelease(offered, { ...spec, keys: spec.keys ?? keys });
  const baselineDirectory = Path.join(directory, "baseline");
  FS.mkdirSync(baselineDirectory);
  const baseline = buildRelease(baselineDirectory, {
    version: "2.0.0",
    keys,
    ...(baselineAdapterRange === undefined ? {} : { adapterRange: baselineAdapterRange }),
  });
  const manifest = JSON.parse(FS.readFileSync(baseline.manifestPath, "utf8")) as {
    archiveSha256: string;
  };
  const sha256 = (path: string) =>
    Crypto.createHash("sha256").update(FS.readFileSync(path)).digest("hex");
  return {
    directory,
    root: Path.join(directory, "root"),
    keys,
    offered,
    baselineDirectory: baseline.directory,
    lock: testLock([keys], {
      baseline: {
        version: "2.0.0",
        archiveSha256: manifest.archiveSha256,
        manifestSha256: sha256(baseline.manifestPath),
      },
      releaseSource: { kind: "directory", path: offered },
    }),
  };
};

// ---------------------------------------------------------------------------
// A launcher that records which release each child ran, and a smoke check that can fail
// ---------------------------------------------------------------------------

const makeHarness = (world: World) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const busyReasons = yield* Ref.make<ReadonlyArray<string>>([]);
    const failLaunch = new Set<string>();
    const failSmoke = new Set<string>();
    /** Versions whose child never proves its exit: the finalizer dies, as the real launcher's does. */
    const dieOnClose = new Set<string>();
    const smoked: Array<string> = [];
    /** Runs inside every smoke check, i.e. while the update holds the browser: a launch arriving then. */
    const duringSmoke: { current: ((version: string) => Effect.Effect<void>) | null } = {
      current: null,
    };
    const store = ManagedBrowserPackage.makePackageStore({
      root: world.root,
      lock: world.lock,
      tool,
      checkPrerequisites: false,
    });
    /** What the production launcher does on every launch: ask the update service which engine to run. */
    const engineGuard: { current: (() => unknown) | null } = { current: null };
    const record = (event: string) => Ref.update(events, (current) => [...current, event]);
    const launcher = ManagedBrowserSupervisor.ManagedBrowserChildLauncher.of({
      launch: Effect.fnUntraced(function* (spec) {
        const version = store.current()?.version ?? "none";
        yield* Effect.try({
          try: () => engineGuard.current?.(),
          catch: (cause) =>
            new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({
              instanceId: spec.instanceId,
              cause: String(cause),
            }),
        });
        yield* record(`launch ${spec.instanceId} ${version}`);
        if (failLaunch.has(version)) {
          return yield* new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({
            instanceId: spec.instanceId,
            cause: `${version} does not start`,
          });
        }
        const exit = yield* Deferred.make<ManagedBrowserSupervisor.ManagedBrowserChildExit>();
        yield* Effect.addFinalizer(() =>
          record(`close ${spec.instanceId} ${version}`).pipe(
            Effect.andThen(
              dieOnClose.has(version)
                ? Effect.die(
                    new ManagedBrowserIpc.ManagedBrowserChildNotTerminatedError({
                      instanceId: spec.instanceId,
                      pid: 4242,
                    }),
                  )
                : Deferred.succeed(exit, { clean: true }),
            ),
          ),
        );
        return {
          execute: (request) => Effect.succeed({ value: request.operation, pending: undefined }),
          setGeneration: () => Effect.void,
          releaseInput: Effect.void,
          scoped: () => Effect.succeed(undefined as unknown),
          events: Stream.empty,
          quiesce: () =>
            Ref.get(busyReasons).pipe(
              Effect.map((reasons) => ({ idle: reasons.length === 0, reasons })),
            ),
          exit: Deferred.await(exit),
        } satisfies ManagedBrowserSupervisor.ManagedBrowserChild;
      }),
    });
    const smoke: ManagedBrowserSmoke.ReleaseSmoke = (_engine, version) =>
      Effect.suspend(() => {
        smoked.push(version);
        return (duringSmoke.current?.(version) ?? Effect.void).pipe(
          Effect.andThen(
            failSmoke.has(version)
              ? Effect.fail(
                  new ManagedBrowserPackage.ManagedBrowserPackageError({
                    reason: "rejected",
                    detail: `smoke check failed: ${version} is broken`,
                  }),
                )
              : Effect.void,
          ),
        );
      });
    return {
      events,
      busyReasons,
      failLaunch,
      failSmoke,
      dieOnClose,
      smoked,
      duringSmoke,
      engineGuard,
      launcher,
      smoke,
      store,
    };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

interface Setup {
  readonly source?: ManagedBrowserPackage.ReleaseSource | null;
  readonly schedule?: boolean;
  readonly random?: () => number;
  readonly lock?: ManagedBrowserPackage.ComponentLock;
  readonly now?: () => number;
  /** Wraps the supervisor the update and the test both see, to make one of its calls fail. */
  readonly wrapSupervisor?: (
    supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
  ) => ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];
  /** Runs before the service starts, as a previous run of the server would have left things. */
  readonly beforeStart?: (harness: Harness) => void;
}

const run = <A, E>(
  world: World,
  setup: Setup,
  body: (context: {
    readonly harness: Harness;
    readonly update: ManagedBrowserUpdate.ManagedBrowserUpdate["Service"];
    readonly supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(world);
    setup.beforeStart?.(harness);
    const base = ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
      Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ManagedBrowserSupervisor.ManagedBrowserChildLauncher, harness.launcher),
          NodeCrypto.layer,
        ),
      ),
    );
    const supervisor =
      setup.wrapSupervisor === undefined
        ? base
        : Layer.effect(
            ManagedBrowserSupervisor.ManagedBrowserSupervisor,
            Effect.gen(function* () {
              const service = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
              return ManagedBrowserSupervisor.ManagedBrowserSupervisor.of(
                setup.wrapSupervisor!(service),
              );
            }),
          ).pipe(Layer.provide(base));
    const update = ManagedBrowserUpdate.layer({
      root: world.root,
      lock: setup.lock ?? world.lock,
      tool,
      source:
        setup.source === undefined
          ? ManagedBrowserPackage.directorySource(world.offered)
          : setup.source,
      baseline: ManagedBrowserPackage.directorySource(world.baselineDirectory),
      smoke: harness.smoke,
      checkPrerequisites: false,
      schedule: setup.schedule ?? false,
      ...(setup.random === undefined ? {} : { random: setup.random }),
      ...(setup.now === undefined ? {} : { now: setup.now }),
    }).pipe(Layer.provideMerge(supervisor));
    return yield* Effect.gen(function* () {
      const service = yield* ManagedBrowserUpdate.ManagedBrowserUpdate;
      harness.engineGuard.current = () => service.engine();
      return yield* body({
        harness,
        update: service,
        supervisor: yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor,
      });
    }).pipe(Effect.provide(update), Effect.scoped);
  });

const eventsOf = (harness: Harness) => Ref.get(harness.events);

/** The staged release as the service itself would hand it back: installed, with its signed digest. */
const stagedOf = (world: World, version: string) => ({
  version,
  archiveSha256: (
    JSON.parse(
      FS.readFileSync(
        Path.join(world.root, "versions", version, "release", "manifest.json"),
        "utf8",
      ),
    ) as { archiveSha256: string }
  ).archiveSha256,
});

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  const reason = Exit.isFailure(exit)
    ? exit.cause.reasons.find((entry) => entry._tag === "Fail")
    : undefined;
  return (reason as { error?: { reason?: string; detail?: string } } | undefined)?.error;
};

describe("starting from the shipped baseline", () => {
  it.effect("installs the baseline the lock pins, verified, and offers hosting", () => {
    const world = makeWorld([]);
    return run(world, {}, ({ update }) =>
      Effect.gen(function* () {
        const status = yield* update.status;
        assert.equal(status.current, "2.0.0");
        assert.isTrue(status.hosting.available);
        assert.deepEqual(status.provisioning, {
          signingKey: true,
          baseline: true,
          releaseSource: true,
        });
      }),
    );
  });

  it.effect("refuses a baseline that is not the one this build pins", () => {
    const world = makeWorld([]);
    const wrong = {
      ...world.lock,
      baseline: { ...world.lock.baseline!, archiveSha256: "0".repeat(64) },
    };
    return run(world, { lock: wrong }, ({ update }) =>
      Effect.gen(function* () {
        const status = yield* update.status;
        assert.isNull(status.current);
        assert.isFalse(status.hosting.available);
      }),
    );
  });

  it.effect("reports unprovisioned, distinctly, while the lock names no key or baseline", () => {
    const world = makeWorld([]);
    const bare = testLock([]);
    return run(world, { lock: bare, source: null }, ({ update }) =>
      Effect.gen(function* () {
        const status = yield* update.status;
        assert.isFalse(status.hosting.available);
        assert.equal(status.hosting.reason, "unprovisioned");
        assert.deepEqual(status.provisioning, {
          signingKey: false,
          baseline: false,
          releaseSource: false,
        });
        const check = yield* update.checkUpdate({ automatic: false });
        assert.equal(check.lastCheck?.outcome, "unavailable");
      }),
    );
  });

  it.effect("falls back to the baseline when the installed release no longer fits this T3", () => {
    // 2.1.0 declares support only below 3.0.0; the shipped baseline reaches further.
    const world = makeWorld([{ version: "2.1.0" }], ">=1.0.0 <4.0.0");
    return Effect.gen(function* () {
      yield* run(world, {}, ({ update }) =>
        update.update({ automatic: false }).pipe(Effect.asVoid),
      );
      const newer = { ...world.lock, adapterVersion: "3.5.0" };
      yield* run(world, { lock: newer }, ({ update }) =>
        Effect.gen(function* () {
          const status = yield* update.status;
          assert.equal(status.current, "2.0.0");
          assert.isTrue(status.hosting.available);
        }),
      );
    });
  });
});

describe("choosing and staging a release", () => {
  const releases: ReadonlyArray<OfferedRelease> = [
    { version: "2.1.0" },
    // Declares an adapter range this T3 is outside.
    { version: "2.2.0", adapterRange: ">=2.0.0 <3.0.0" },
    // Signed by someone else, and the newest of all.
    { version: "2.3.0", keys: makeKeys(), marker: "-forged" },
    { version: "2.4.0", capabilities: ["open"] },
    { version: "2.5.0-beta.1" },
    // Older than what is installed.
    { version: "1.9.0" },
  ];

  it.effect(
    "stages the newest that is compatible and verifies, skipping the rest, and moves nothing",
    () => {
      const world = makeWorld(releases);
      return run(world, {}, ({ update }) =>
        Effect.gen(function* () {
          const status = yield* update.checkUpdate({ automatic: false });
          assert.equal(status.lastCheck?.outcome, "staged");
          assert.equal(status.staged, "2.1.0");
          assert.equal(status.current, "2.0.0");
          const installed = FS.readdirSync(Path.join(world.root, "versions"));
          assert.deepEqual(installed.sort(), ["2.0.0", "2.1.0"]);
        }),
      );
    },
  );

  it.effect("an unreachable source leaves the working release alone", () => {
    const world = makeWorld([]);
    return run(
      world,
      { source: ManagedBrowserPackage.directorySource("/nonexistent/releases") },
      ({ update }) =>
        Effect.gen(function* () {
          const status = yield* update.checkUpdate({ automatic: false });
          assert.equal(status.lastCheck?.outcome, "offline");
          assert.equal(status.current, "2.0.0");
          assert.isTrue(status.hosting.available);
        }),
    );
  });

  it.effect("says so when no release source is provisioned", () => {
    const world = makeWorld([]);
    return run(world, { source: null }, ({ update }) =>
      Effect.gen(function* () {
        const status = yield* update.checkUpdate({ automatic: false });
        assert.equal(status.lastCheck?.outcome, "unprovisioned");
      }),
    );
  });

  it.effect("a corrupt newest archive never becomes current or leaves staging behind", () => {
    const world = makeWorld([{ version: "2.1.0" }, { version: "2.2.0", corruptArchive: true }]);
    return run(world, {}, ({ update }) =>
      Effect.gen(function* () {
        const status = yield* update.checkUpdate({ automatic: false });
        assert.equal(status.staged, "2.1.0");
        assert.equal(status.current, "2.0.0");
        assert.deepEqual(FS.readdirSync(Path.join(world.root, "versions")).sort(), [
          "2.0.0",
          "2.1.0",
        ]);
      }),
    );
  });

  it.effect("the automatic path obeys pause and pin; an explicit check does not", () => {
    const world = makeWorld([{ version: "2.1.0" }]);
    return run(world, {}, ({ update }) =>
      Effect.gen(function* () {
        yield* update.setPolicy({ paused: true });
        assert.equal((yield* update.checkUpdate({ automatic: true })).lastCheck?.outcome, "paused");
        assert.isNull((yield* update.status).staged);
        yield* update.setPolicy({ paused: false, pinnedVersion: "2.0.0" });
        assert.equal((yield* update.checkUpdate({ automatic: true })).lastCheck?.outcome, "pinned");
        const refused = yield* Effect.exit(update.setPolicy({ pinnedVersion: "9.9.9" }));
        assert.equal(failureOf(refused)?.reason, "notStaged");
        assert.equal((yield* update.checkUpdate({ automatic: false })).staged, "2.1.0");
        yield* update.setPolicy({ pinnedVersion: null });
        assert.deepEqual((yield* update.status).policy, { paused: false, pinnedVersion: null });
      }),
    );
  });

  it.effect("the policy survives a restart of the service", () => {
    const world = makeWorld([]);
    return Effect.gen(function* () {
      yield* run(world, {}, ({ update }) =>
        update.setPolicy({ paused: true, pinnedVersion: "2.0.0" }).pipe(Effect.asVoid),
      );
      yield* run(world, {}, ({ update }) =>
        Effect.gen(function* () {
          assert.deepEqual((yield* update.status).policy, { paused: true, pinnedVersion: "2.0.0" });
        }),
      );
    });
  });
});

describe("updating from GitHub Releases", () => {
  const REPOSITORY = "acme/stealth-browser";
  const githubWorld = (versions: ReadonlyArray<string>) => {
    const world = makeWorld([]);
    const built = versions.map((version) => ({
      tag: `v${version}`,
      built: buildRelease(Path.join(world.directory, "gh"), { version, keys: world.keys }),
    }));
    return { world, built };
  };
  const readerOf = (
    world: World,
    apiBaseUrl: string,
    token: string | null = null,
  ): ManagedBrowserPackage.ReleaseSource =>
    GithubSource.githubSource({
      repository: REPOSITORY,
      apiBaseUrl,
      token: Effect.succeed(token),
      downloadRoot: Path.join(world.root, "downloads"),
    });

  it.live("stages, verifies and activates a release read from the repository", () => {
    const { world, built } = githubWorld(["2.1.0", "2.0.0"]);
    return Effect.acquireUseRelease(
      Effect.promise(() => serveGithub({ repository: REPOSITORY, releases: built })),
      (fixture) =>
        run(world, { source: readerOf(world, fixture.apiUrl) }, ({ update }) =>
          Effect.gen(function* () {
            const status = yield* update.update({ automatic: false });
            assert.equal(status.current, "2.1.0");
            assert.equal(status.lastActivation?.result, "activated");
            // Nothing downloaded is left behind once the release is installed.
            assert.deepEqual(FS.readdirSync(Path.join(world.root, "downloads")), []);
          }),
        ),
      (fixture) => Effect.promise(() => fixture.close()),
    );
  });

  it.live(
    "a release signed by another key is downloaded, rejected by the installer, and never installed",
    () => {
      const { world, built } = githubWorld([]);
      const foreign = buildRelease(Path.join(world.directory, "gh"), {
        version: "2.1.0",
        keys: makeKeys(),
      });
      return Effect.acquireUseRelease(
        Effect.promise(() =>
          serveGithub({
            repository: REPOSITORY,
            releases: [...built, { tag: "v2.1.0", built: foreign }],
          }),
        ),
        (fixture) =>
          run(world, { source: readerOf(world, fixture.apiUrl) }, ({ update }) =>
            Effect.gen(function* () {
              const status = yield* update.checkUpdate({ automatic: false });
              assert.equal(status.lastCheck?.outcome, "rejected");
              assert.equal(status.current, "2.0.0");
              assert.deepEqual(status.staged, null);
              assert.deepEqual(FS.readdirSync(Path.join(world.root, "downloads")), []);
            }),
          ),
        (fixture) => Effect.promise(() => fixture.close()),
      );
    },
  );

  it.live("offline and unauthorized checks keep the installed release and say which it was", () => {
    const { world, built } = githubWorld(["2.1.0"]);
    return Effect.acquireUseRelease(
      Effect.promise(() => serveGithub({ repository: REPOSITORY, token: "t", releases: built })),
      (fixture) =>
        Effect.gen(function* () {
          yield* run(world, { source: readerOf(world, fixture.apiUrl, "wrong") }, ({ update }) =>
            Effect.gen(function* () {
              const status = yield* update.checkUpdate({ automatic: false });
              assert.equal(status.lastCheck?.outcome, "unauthorized");
              assert.equal(status.current, "2.0.0");
            }),
          );
          yield* Effect.promise(() => fixture.close());
          yield* run(world, { source: readerOf(world, fixture.apiUrl, "t") }, ({ update }) =>
            Effect.gen(function* () {
              const status = yield* update.checkUpdate({ automatic: false });
              assert.equal(status.lastCheck?.outcome, "offline");
              assert.equal(status.current, "2.0.0");
              assert.isTrue(status.hosting.available);
            }),
          );
        }),
      (fixture) => Effect.promise(() => fixture.close()),
    );
  });
});

describe("activating a staged release", () => {
  const world2 = () => makeWorld([{ version: "2.1.0" }]);

  it.effect(
    "replaces each running child once its predecessor has exited, then reopens admission",
    () => {
      const world = world2();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          yield* supervisor.ensure(secondDescriptor);
          const status = yield* update.update({ automatic: false });
          assert.equal(status.current, "2.1.0");
          assert.equal(status.previous, "2.0.0");
          assert.isNull(status.staged);
          assert.isNull(status.activation);
          assert.equal(status.lastActivation?.result, "activated");
          const events = yield* eventsOf(harness);
          // Each old child closed before its replacement launched on the new release.
          for (const id of ["instance-a", "instance-b"]) {
            const closed = events.indexOf(`close ${id} 2.0.0`);
            const launched = events.indexOf(`launch ${id} 2.1.0`);
            assert.isAbove(closed, -1);
            assert.isAbove(launched, closed);
          }
          assert.deepEqual(harness.smoked, ["2.1.0"]);
          // Admission is open on the new release.
          const live = yield* supervisor.ensure(descriptor);
          const { fence } = yield* supervisor.state(live);
          assert.equal(yield* supervisor.execute(agent, live, fence, "click"), "click");
        }),
      );
    },
  );

  it.effect(
    "switches without a restart when nothing is running, and the next launch uses the new release",
    () => {
      const world = world2();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* update.update({ automatic: false });
          assert.equal((yield* update.status).current, "2.1.0");
          yield* supervisor.ensure(descriptor);
          assert.deepEqual(yield* eventsOf(harness), ["launch instance-a 2.1.0"]);
        }),
      );
    },
  );

  it.effect(
    "defers while a person controls the browser, killing nothing, and succeeds once they let go",
    () => {
      const world = world2();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          const live = yield* supervisor.ensure(descriptor);
          yield* supervisor.takeControl(human, live);
          const status = yield* update.update({ automatic: false });
          assert.equal(status.current, "2.0.0");
          assert.equal(status.staged, "2.1.0");
          assert.equal(status.lastActivation?.result, "deferred");
          assert.deepEqual(yield* eventsOf(harness), ["launch instance-a 2.0.0"]);
          assert.deepEqual(harness.smoked, []);
          // The old browser still answers the person who holds it.
          assert.isDefined(yield* supervisor.state(live));
          yield* supervisor.releaseControl(human, live);
          assert.equal((yield* update.update({ automatic: false })).current, "2.1.0");
        }),
      );
    },
  );

  for (const reason of [
    "dialogs",
    "uploads",
    "navigations",
    "launches",
    "externalContexts",
    "recordings",
  ]) {
    it.effect(`defers while the child reports ${reason} in progress and kills nothing`, () => {
      const world = world2();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          yield* Ref.set(harness.busyReasons, [reason]);
          const status = yield* update.update({ automatic: false });
          assert.equal(status.current, "2.0.0");
          assert.equal(status.lastActivation?.result, "deferred");
          assert.equal(status.lastActivation?.detail, reason);
          const events = yield* eventsOf(harness);
          assert.deepEqual(events, ["launch instance-a 2.0.0"]);
          assert.notInclude(events.join(","), "close");
          // Normal admission is back on the old release.
          const live = yield* supervisor.ensure(descriptor);
          const { fence } = yield* supervisor.state(live);
          assert.equal(yield* supervisor.execute(agent, live, fence, "click"), "click");
        }),
      );
    });
  }

  it.effect("claims every instance or none: a busy second instance restores the first", () => {
    const world = world2();
    return run(world, {}, ({ harness, update, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor);
        const second = yield* supervisor.ensure(secondDescriptor);
        yield* supervisor.takeControl(human, second);
        const status = yield* update.update({ automatic: false });
        assert.equal(status.lastActivation?.result, "deferred");
        assert.notInclude((yield* eventsOf(harness)).join(","), "close");
        const first = yield* supervisor.ensure(descriptor);
        const { fence } = yield* supervisor.state(first);
        assert.equal(yield* supervisor.execute(agent, first, fence, "click"), "click");
      }),
    );
  });

  it.effect("refuses to move forward onto an older, equal or quarantined release", () => {
    const world = world2();
    return run(world, {}, ({ update }) =>
      Effect.gen(function* () {
        const older = yield* Effect.exit(update.activate(stagedOf(world, "2.0.0")));
        assert.equal(failureOf(older)?.reason, "rejected");
        const missing = yield* Effect.exit(
          update.activate({ version: "9.9.9", archiveSha256: "x" }),
        );
        assert.equal(failureOf(missing)?.reason, "notStaged");
      }),
    );
  });

  it.effect("activates only the release that was staged, by its digest", () => {
    const world = world2();
    return run(world, {}, ({ update }) =>
      Effect.gen(function* () {
        yield* update.checkUpdate({ automatic: false });
        const other = { ...stagedOf(world, "2.1.0"), archiveSha256: "0".repeat(64) };
        const exit = yield* Effect.exit(update.activate(other));
        assert.equal(failureOf(exit)?.reason, "rejected");
        assert.match(failureOf(exit)?.detail ?? "", /differs from the release that was staged/);
        assert.equal((yield* update.status).current, "2.0.0");
      }),
    );
  });

  it.effect("only one activation runs at a time", () => {
    const world = world2();
    return run(world, {}, ({ update, supervisor }) =>
      Effect.gen(function* () {
        yield* update.checkUpdate({ automatic: false });
        const staged = stagedOf(world, "2.1.0");
        const results = yield* Effect.all(
          [Effect.exit(update.activate(staged)), Effect.exit(update.activate(staged))],
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter((exit) => Exit.isSuccess(exit)).length, 1);
        const refused = results.flatMap((exit) => {
          const reason = failureOf(exit)?.reason;
          return reason === undefined ? [] : [reason];
        });
        // Refused at the lock, or, had the first finished already, as nothing left to move to.
        assert.equal(refused.length, 1);
        assert.include(["locked", "rejected"], refused[0]);
        assert.equal((yield* update.status).current, "2.1.0");
        yield* supervisor.ensure(descriptor);
      }),
    );
  });
});

describe("an instance nobody has launched before, arriving during an update", () => {
  const thirdDescriptor = {
    ownerEnvironmentId,
    instanceId: ManagedBrowserInstanceId.make("instance-late"),
    profileId: ManagedBrowserProfileId.make("profile-late"),
  };
  /** Records, at every smoke check, what a launch of a never-seen instance gets. */
  const probeLaunches = (
    harness: Harness,
    supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
  ) => {
    const outcomes: Array<string> = [];
    harness.duringSmoke.current = (version) =>
      Effect.exit(supervisor.ensure(thirdDescriptor)).pipe(
        Effect.map((exit) => void outcomes.push(`${version}:${exit._tag}`)),
      );
    return outcomes;
  };

  it.effect("is refused while a release activates, and launches on it afterwards", () => {
    const world = makeWorld([{ version: "2.1.0" }]);
    return run(world, {}, ({ harness, update, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor);
        const outcomes = probeLaunches(harness, supervisor);
        yield* update.update({ automatic: false });
        assert.deepEqual(outcomes, ["2.1.0:Failure"]);
        assert.notInclude((yield* eventsOf(harness)).join(","), "launch instance-late");
        assert.isDefined(yield* supervisor.ensure(thirdDescriptor));
      }),
    );
  });

  it.effect(
    "is refused while a failed candidate is rolled back, so it never starts on either",
    () => {
      const world = makeWorld([{ version: "2.1.0" }]);
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          harness.failSmoke.add("2.1.0");
          const outcomes = probeLaunches(harness, supervisor);
          const result = yield* update.update({ automatic: false }).pipe(Effect.as(null));
          assert.isNull(result);
          // Refused at the candidate's smoke check and again at the recovered release's.
          assert.deepEqual(outcomes, ["2.1.0:Failure", "2.0.0:Failure"]);
          assert.notInclude((yield* eventsOf(harness)).join(","), "launch instance-late");
        }),
      );
    },
  );

  it.effect("is refused during an operator rollback", () => {
    const world = makeWorld([{ version: "2.1.0" }]);
    return run(world, {}, ({ harness, update, supervisor }) =>
      Effect.gen(function* () {
        yield* update.update({ automatic: false });
        yield* supervisor.ensure(descriptor);
        const outcomes = probeLaunches(harness, supervisor);
        assert.equal((yield* update.rollback())._tag, "Activated");
        assert.deepEqual(outcomes, ["2.0.0:Failure"]);
        assert.isDefined(yield* supervisor.ensure(thirdDescriptor));
      }),
    );
  });
});

describe("a release that fails after activation", () => {
  const world3 = () => makeWorld([{ version: "2.1.0" }]);

  it.effect(
    "rolls back to the previous release, quarantines the failed one and says recovery worked",
    () => {
      const world = world3();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          harness.failSmoke.add("2.1.0");
          const staged = yield* update.checkUpdate({ automatic: false });
          assert.equal(staged.staged, "2.1.0");
          const result = yield* update.activate(stagedOf(world, "2.1.0"));
          assert.equal(result._tag, "RolledBack");
          const status = yield* update.status;
          assert.equal(status.current, "2.0.0");
          assert.equal(status.previous, "2.1.0");
          assert.deepEqual(
            status.quarantined.map((entry) => entry.version),
            ["2.1.0"],
          );
          assert.isNull(status.staged);
          assert.deepEqual(yield* eventsOf(harness), [
            "launch instance-a 2.0.0",
            "close instance-a 2.0.0",
            "launch instance-a 2.1.0",
            "close instance-a 2.1.0",
            "launch instance-a 2.0.0",
          ]);
          // The recovered browser was verified, and admission is open on it.
          assert.deepEqual(harness.smoked, ["2.1.0", "2.0.0"]);
          const live = yield* supervisor.ensure(descriptor);
          const { fence } = yield* supervisor.state(live);
          assert.equal(yield* supervisor.execute(agent, live, fence, "click"), "click");
          // A quarantined release is not offered again until an operator releases it.
          assert.equal(
            (yield* update.checkUpdate({ automatic: false })).lastCheck?.outcome,
            "upToDate",
          );
          yield* update.releaseQuarantine("2.1.0");
          assert.equal((yield* update.checkUpdate({ automatic: false })).staged, "2.1.0");
        }),
      );
    },
  );

  it.effect("rolls back when the new child cannot even start", () => {
    const world = world3();
    return run(world, {}, ({ harness, update, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor);
        harness.failLaunch.add("2.1.0");
        yield* update.checkUpdate({ automatic: false });
        const result = yield* update.activate(stagedOf(world, "2.1.0"));
        assert.equal(result._tag, "RolledBack");
        assert.equal((yield* update.status).current, "2.0.0");
        assert.isDefined(yield* supervisor.ensure(descriptor));
      }),
    );
  });

  /** An activation of 2.1.0 whose smoke fails, after the release it would return to was damaged. */
  const failedRecovery = (world: World, harness: Harness, update: UpdateService) =>
    Effect.gen(function* () {
      harness.failSmoke.add("2.1.0");
      yield* update.checkUpdate({ automatic: false });
      const serverJs = Path.join(world.root, "versions", "2.0.0", "dist", "server.js");
      const original = FS.readFileSync(serverJs);
      FS.writeFileSync(serverJs, Buffer.from(original).fill(0x78));
      const result = yield* update.activate(stagedOf(world, "2.1.0"));
      return { result, repair: () => FS.writeFileSync(serverJs, original) };
    });

  it.effect(
    "a failed recovery stops the candidate and keeps ordinary launches off it until repaired",
    () => {
      const world = world3();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          const { result } = yield* failedRecovery(world, harness, update);
          assert.equal(result._tag, "RecoveryFailed");
          assert.match(result._tag === "RecoveryFailed" ? result.detail : "", /recovery failed/);
          const status = yield* update.status;
          assert.equal(status.lastActivation?.result, "recoveryFailed");
          assert.deepEqual(status.hosting, { available: false, reason: "recoveryRequired" });
          assert.equal(status.recovery?.failed, "2.1.0");
          // Admission is open again, so a retry can work.
          assert.equal(status.recovery?.status, "retryable");
          // The candidate child was ended with its exit proven, and nothing was started after it.
          const events = yield* eventsOf(harness);
          assert.equal(events[events.length - 1], "close instance-a 2.1.0");
          // Admission is open, but only to a typed refusal: no browser starts on the failed candidate.
          const refused = yield* Effect.exit(supervisor.ensure(descriptor));
          assert.equal(refused._tag, "Failure");
          const launches = (yield* eventsOf(harness)).filter((event) => event.startsWith("launch"));
          assert.deepEqual(launches, ["launch instance-a 2.0.0", "launch instance-a 2.1.0"]);
          const quarantined = status.quarantined.map((entry) => entry.version);
          assert.deepEqual(quarantined, ["2.1.0"]);
        }),
      );
    },
  );

  it.effect("the recovery state survives a restart, and an explicit retry restores service", () => {
    const world = world3();
    let repair = () => {};
    return Effect.gen(function* () {
      yield* run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          repair = (yield* failedRecovery(world, harness, update)).repair;
        }),
      );
      yield* run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          const status = yield* update.status;
          assert.equal(status.hosting.reason, "recoveryRequired");
          assert.equal(status.recovery?.failed, "2.1.0");
          assert.equal((yield* Effect.exit(supervisor.ensure(descriptor)))._tag, "Failure");
          // Still damaged: the retry fails, says so, and changes nothing.
          const still = yield* Effect.exit(update.recover());
          assert.equal(still._tag, "Failure");
          assert.equal((yield* update.status).recovery?.failed, "2.1.0");
          assert.equal((yield* Effect.exit(supervisor.ensure(descriptor)))._tag, "Failure");
          repair();
          const restored = yield* update.recover();
          assert.equal(restored._tag, "Activated");
          const after = yield* update.status;
          assert.isNull(after.recovery);
          assert.equal(after.current, "2.0.0");
          assert.isTrue(after.hosting.available);
          assert.deepEqual(harness.smoked.slice(-1), ["2.0.0"]);
          assert.isDefined(yield* supervisor.ensure(descriptor));
        }),
      );
    }).pipe(Effect.scoped);
  });

  it.effect("a newer verified release also repairs it", () => {
    const world = world3();
    return run(world, {}, ({ harness, update, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor);
        const { result } = yield* failedRecovery(world, harness, update);
        assert.equal(result._tag, "RecoveryFailed");
        buildRelease(world.offered, { version: "2.2.0", keys: world.keys });
        const status = yield* update.update({ automatic: false });
        assert.equal(status.current, "2.2.0");
        assert.isNull(status.recovery);
        assert.isTrue(status.hosting.available);
        assert.isDefined(yield* supervisor.ensure(descriptor));
      }),
    );
  });

  describe("when a child's exit cannot be proven", () => {
    /** Nothing may start on the profile again, and admission stays closed until a person recovers. */
    const assertHeld = (harness: Harness, update: UpdateService, supervisor: SupervisorService) =>
      Effect.gen(function* () {
        const status = yield* update.status;
        assert.deepEqual(status.hosting, { available: false, reason: "recoveryRequired" });
        assert.match(status.recovery?.detail ?? "", /exit not proven/);
        // A retry cannot drain while admission is held, so no ordinary recovery is advertised.
        assert.equal(status.recovery?.status, "restartRequired");
        assert.equal(status.lastActivation?.result, "recoveryFailed");
        assert.equal((yield* Effect.exit(supervisor.closeAdmission))._tag, "Failure");
        assert.equal((yield* Effect.exit(supervisor.ensure(descriptor)))._tag, "Failure");
        return (yield* eventsOf(harness)).filter((event) => event.startsWith("launch"));
      });

    it.effect(
      "a stop that fails with an ownership error keeps admission closed and says why",
      () => {
        const world = world3();
        return run(
          world,
          {
            wrapSupervisor: (supervisor) => ({
              ...supervisor,
              stop: (instanceId) =>
                Effect.fail(
                  new ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError({ instanceId }),
                ),
            }),
          },
          ({ harness, update, supervisor }) =>
            Effect.gen(function* () {
              yield* supervisor.ensure(descriptor);
              const { result } = yield* failedRecovery(world, harness, update);
              assert.equal(result._tag, "RecoveryFailed");
              const launches = yield* assertHeld(harness, update, supervisor);
              assert.deepEqual(launches, ["launch instance-a 2.0.0", "launch instance-a 2.1.0"]);
            }),
        );
      },
    );

    it.effect("a child that dies while being stopped keeps admission closed and says why", () => {
      const world = world3();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          harness.dieOnClose.add("2.1.0");
          const { result } = yield* failedRecovery(world, harness, update);
          assert.equal(result._tag, "RecoveryFailed");
          const launches = yield* assertHeld(harness, update, supervisor);
          assert.deepEqual(launches, ["launch instance-a 2.0.0", "launch instance-a 2.1.0"]);
        }),
      );
    });

    it.effect("recover refuses without draining or launching while admission is held", () => {
      const world = world3();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          harness.dieOnClose.add("2.1.0");
          const { result } = yield* failedRecovery(world, harness, update);
          assert.equal(result._tag, "RecoveryFailed");
          const before = yield* assertHeld(harness, update, supervisor);
          const smoked = harness.smoked.length;
          const retry = yield* Effect.exit(update.recover());
          assert.equal(failureOf(retry)?.reason, "locked");
          assert.match(failureOf(retry)?.detail ?? "", /restart/);
          assert.deepEqual(yield* assertHeld(harness, update, supervisor), before);
          assert.equal(harness.smoked.length, smoked);
        }),
      );
    });

    it.effect(
      "a recovery whose own stop cannot be proven records it, and a restarted process offers a real retry",
      () => {
        const world = world3();
        let repair = () => {};
        return Effect.gen(function* () {
          yield* run(world, {}, ({ harness, update, supervisor }) =>
            Effect.gen(function* () {
              yield* supervisor.ensure(descriptor);
              repair = (yield* failedRecovery(world, harness, update)).repair;
              const first = yield* update.status;
              assert.equal(first.recovery?.status, "retryable");
              assert.notMatch(first.recovery?.detail ?? "", /exit not proven/);
              // The retry starts the previous release again, which fails and then cannot be stopped.
              repair();
              harness.failSmoke.add("2.0.0");
              harness.dieOnClose.add("2.0.0");
              const retry = yield* Effect.exit(update.recover());
              assert.equal(failureOf(retry)?.reason, "rejected");
              assert.match(
                failureOf(retry)?.detail ?? "",
                /recovery failed again.*exit not proven/,
              );
              // The status now describes this failure, not the one the retry started from.
              const again = yield* update.status;
              assert.equal(again.recovery?.status, "restartRequired");
              assert.match(again.recovery?.detail ?? "", /recovery failed again.*exit not proven/);
              assert.equal((yield* Effect.exit(supervisor.closeAdmission))._tag, "Failure");
              assert.equal((yield* Effect.exit(supervisor.ensure(descriptor)))._tag, "Failure");
            }),
          );
          // A new process holds no barrier: the notice clears itself and a retry that works clears the state.
          yield* run(world, {}, ({ update, supervisor }) =>
            Effect.gen(function* () {
              const status = yield* update.status;
              assert.equal(status.recovery?.failed, "2.1.0");
              assert.equal(status.recovery?.status, "retryable");
              assert.equal((yield* update.recover())._tag, "Activated");
              const after = yield* update.status;
              assert.isNull(after.recovery);
              assert.isTrue(after.hosting.available);
              assert.isDefined(yield* supervisor.ensure(descriptor));
            }),
          );
        }).pipe(Effect.scoped);
      },
    );

    it.effect("a child that dies while being replaced starts no replacement on its profile", () => {
      const world = world3();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor);
          harness.dieOnClose.add("2.0.0");
          yield* update.checkUpdate({ automatic: false });
          const result = yield* update.activate(stagedOf(world, "2.1.0"));
          assert.equal(result._tag, "RecoveryFailed");
          const launches = yield* assertHeld(harness, update, supervisor);
          assert.deepEqual(launches, ["launch instance-a 2.0.0"]);
          assert.equal((yield* update.status).recovery?.failed, "2.1.0");
        }),
      );
    });
  });

  it.effect(
    "an operator rollback runs the same drain and verification, and keeps the release it left from returning",
    () => {
      const world = world3();
      return run(world, {}, ({ harness, update, supervisor }) =>
        Effect.gen(function* () {
          yield* update.update({ automatic: false });
          assert.equal((yield* update.status).current, "2.1.0");
          const live = yield* supervisor.ensure(descriptor);
          yield* supervisor.takeControl(human, live);
          assert.equal((yield* update.rollback())._tag, "Deferred");
          assert.equal((yield* update.status).current, "2.1.0");
          yield* supervisor.releaseControl(human, live);
          assert.equal((yield* update.rollback())._tag, "Activated");
          const status = yield* update.status;
          assert.equal(status.current, "2.0.0");
          assert.deepEqual(
            status.quarantined.map((entry) => entry.version),
            ["2.1.0"],
          );
          assert.equal(
            (yield* update.checkUpdate({ automatic: false })).lastCheck?.outcome,
            "upToDate",
          );
          assert.include(harness.smoked, "2.0.0");
        }),
      );
    },
  );
});

describe("recovering from a crash during activation", () => {
  /** An installation on 2.1.0 with 2.0.0 previous, and the interrupted activation a crash left behind. */
  const interrupted = (
    phase: string,
    from: string,
    to: string,
    pointerOn: "to" | "from" = "to",
  ) => {
    const world = makeWorld([{ version: "2.1.0" }]);
    return Effect.gen(function* () {
      yield* run(world, {}, ({ update }) =>
        update.update({ automatic: false }).pipe(Effect.asVoid),
      );
      // A crash after the rollback moved the pointer back, before the previous release was verified.
      if (pointerOn === "from") {
        const store = ManagedBrowserPackage.makePackageStore({
          root: world.root,
          lock: world.lock,
          tool,
          checkPrerequisites: false,
        });
        yield* store.withLock(store.rollback());
      }
      const path = Path.join(world.root, "update-state.json");
      const record = JSON.parse(FS.readFileSync(path, "utf8")) as {
        state: Array<Record<string, unknown>>;
      };
      record.state[0]!.activation = { phase, from, to };
      FS.writeFileSync(path, JSON.stringify(record));
      return world;
    });
  };

  it.effect("before the switch nothing changed, so it only clears the record", () =>
    Effect.gen(function* () {
      const world = yield* interrupted("draining", "2.1.0", "2.2.0");
      yield* run(world, {}, ({ harness, update }) =>
        Effect.gen(function* () {
          const status = yield* update.status;
          assert.equal(status.current, "2.1.0");
          assert.isNull(status.activation);
          assert.deepEqual(harness.smoked, []);
        }),
      );
    }),
  );

  it.effect("after the switch it keeps a release that passes its smoke check", () =>
    Effect.gen(function* () {
      const world = yield* interrupted("verifying", "2.0.0", "2.1.0");
      yield* run(world, {}, ({ harness, update }) =>
        Effect.gen(function* () {
          const status = yield* update.status;
          assert.equal(status.current, "2.1.0");
          assert.isNull(status.activation);
          assert.deepEqual(harness.smoked, ["2.1.0"]);
        }),
      );
    }),
  );

  it.effect("after the switch it rolls back, verifies the previous release and quarantines", () =>
    Effect.gen(function* () {
      const world = yield* interrupted("switched", "2.0.0", "2.1.0");
      yield* run(
        world,
        { beforeStart: (harness) => harness.failSmoke.add("2.1.0") },
        ({ harness, update }) =>
          Effect.gen(function* () {
            const status = yield* update.status;
            assert.equal(status.current, "2.0.0");
            assert.isNull(status.activation);
            assert.isNull(status.recovery);
            assert.isTrue(status.hosting.available);
            assert.deepEqual(
              status.quarantined.map((entry) => entry.version),
              ["2.1.0"],
            );
            assert.deepEqual(harness.smoked, ["2.1.0", "2.0.0"]);
          }),
      );
    }),
  );

  for (const pointerOn of ["to", "from"] as const) {
    it.effect(
      `an interrupted rollback with the pointer on ${pointerOn === "to" ? "the failed release" : "the previous release"} is finished and verified`,
      () =>
        Effect.gen(function* () {
          const world = yield* interrupted("rollingBack", "2.0.0", "2.1.0", pointerOn);
          yield* run(world, {}, ({ harness, update }) =>
            Effect.gen(function* () {
              const status = yield* update.status;
              assert.equal(status.current, "2.0.0");
              assert.isNull(status.activation);
              assert.isNull(status.recovery);
              assert.isTrue(status.hosting.available);
              assert.deepEqual(
                status.quarantined.map((entry) => entry.version),
                ["2.1.0"],
              );
              assert.deepEqual(harness.smoked, ["2.0.0"]);
            }),
          );
        }),
    );

    it.effect(
      `an interrupted rollback with the pointer on ${pointerOn === "to" ? "the failed release" : "the previous release"} does not offer a previous release that fails its smoke check`,
      () =>
        Effect.gen(function* () {
          const world = yield* interrupted("rollingBack", "2.0.0", "2.1.0", pointerOn);
          yield* run(
            world,
            { beforeStart: (harness) => harness.failSmoke.add("2.0.0") },
            ({ harness, update, supervisor }) =>
              Effect.gen(function* () {
                const status = yield* update.status;
                assert.deepEqual(harness.smoked, ["2.0.0"]);
                assert.deepEqual(status.hosting, { available: false, reason: "recoveryRequired" });
                assert.isNull(status.activation);
                assert.equal(status.lastActivation?.result, "recoveryFailed");
                assert.equal(status.recovery?.failed, "2.1.0");
                assert.equal(status.recovery?.from, "2.0.0");
                assert.equal((yield* Effect.exit(supervisor.ensure(descriptor)))._tag, "Failure");
                // The refusal is persistent and an explicit retry ends it once the release works.
                harness.failSmoke.delete("2.0.0");
                assert.equal((yield* update.recover())._tag, "Activated");
                const after = yield* update.status;
                assert.isNull(after.recovery);
                assert.equal(after.current, "2.0.0");
                assert.isTrue(after.hosting.available);
              }),
          );
        }),
    );
  }

  it.effect(
    "a candidate and a previous release that both fail their smoke checks need recovery",
    () =>
      Effect.gen(function* () {
        const world = yield* interrupted("verifying", "2.0.0", "2.1.0");
        yield* run(
          world,
          {
            beforeStart: (harness) => {
              harness.failSmoke.add("2.1.0");
              harness.failSmoke.add("2.0.0");
            },
          },
          ({ harness, update }) =>
            Effect.gen(function* () {
              const status = yield* update.status;
              assert.deepEqual(harness.smoked, ["2.1.0", "2.0.0"]);
              assert.deepEqual(status.hosting, { available: false, reason: "recoveryRequired" });
              assert.equal(status.recovery?.failed, "2.1.0");
              assert.isNull(status.activation);
              assert.deepEqual(
                status.quarantined.map((entry) => entry.version),
                ["2.1.0"],
              );
              assert.throws(() => update.engine(), /recovery is required/);
            }),
        );
      }),
  );

  it.effect("a settlement that fails with a readable current release still refuses launches", () =>
    Effect.gen(function* () {
      const world = yield* interrupted("verifying", "2.0.0", "2.1.0");
      // The release to return to is damaged, so the verified swap back cannot be made.
      const serverJs = Path.join(world.root, "versions", "2.0.0", "dist", "server.js");
      FS.writeFileSync(serverJs, Buffer.from(FS.readFileSync(serverJs)).fill(0x78));
      yield* run(
        world,
        { beforeStart: (harness) => harness.failSmoke.add("2.1.0") },
        ({ update, supervisor }) =>
          Effect.gen(function* () {
            const status = yield* update.status;
            assert.equal(status.current, "2.1.0");
            assert.deepEqual(status.hosting, { available: false, reason: "recoveryRequired" });
            assert.equal(status.recovery?.failed, "2.1.0");
            assert.throws(() => update.engine(), /recovery is required/);
            assert.equal((yield* Effect.exit(supervisor.ensure(descriptor)))._tag, "Failure");
          }),
      );
      // It is still refused after another start, from the persisted state alone.
      yield* run(world, {}, ({ update }) =>
        Effect.gen(function* () {
          assert.equal((yield* update.status).hosting.reason, "recoveryRequired");
        }),
      );
    }),
  );
});

describe("the hourly check", () => {
  it("is an hour plus a bounded jitter", () => {
    assert.equal(ManagedBrowserUpdate.nextCheckDelayMs(0), 3_600_000);
    assert.equal(
      ManagedBrowserUpdate.nextCheckDelayMs(1),
      3_600_000 + ManagedBrowserUpdate.MAX_JITTER_MS,
    );
    assert.equal(
      ManagedBrowserUpdate.nextCheckDelayMs(5),
      3_600_000 + ManagedBrowserUpdate.MAX_JITTER_MS,
    );
    assert.equal(ManagedBrowserUpdate.nextCheckDelayMs(-1), 3_600_000);
    assert.isAtMost(ManagedBrowserUpdate.MAX_JITTER_MS, 600_000);
  });

  it.effect("runs on its schedule, stages and activates when idle, and not before", () => {
    const world = makeWorld([{ version: "2.1.0" }]);
    let lists = 0;
    const counting: ManagedBrowserPackage.ReleaseSource = {
      list: Effect.suspend(() => {
        lists += 1;
        return ManagedBrowserPackage.directorySource(world.offered).list;
      }),
    };
    return run(world, { source: counting, schedule: true, random: () => 0 }, ({ update }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(3_599_000);
        assert.equal(lists, 0);
        yield* TestClock.adjust(1_000);
        // The timer runs the whole update: it checks, stages and, nothing being in use, activates.
        for (let index = 0; index < 400 && (yield* update.status).current !== "2.1.0"; index += 1) {
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
        }
        assert.equal(lists, 1);
        assert.equal((yield* update.status).current, "2.1.0");
      }),
    );
  });

  it.effect("a paused host's timer does nothing", () => {
    const world = makeWorld([{ version: "2.1.0" }]);
    return run(world, { schedule: true, random: () => 0 }, ({ update }) =>
      Effect.gen(function* () {
        yield* update.setPolicy({ paused: true });
        yield* TestClock.adjust(3_700_000);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        const status = yield* update.status;
        assert.equal(status.current, "2.0.0");
        assert.isNull(status.staged);
        assert.equal(status.lastCheck?.outcome, "paused");
      }),
    );
  });
});
