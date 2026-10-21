// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ManagedBrowserControls from "./ManagedBrowserControls.ts";
import * as ManagedBrowserDesktop from "./ManagedBrowserDesktop.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { serveGithub } from "./ManagedBrowserGithubFixture.ts";
import * as ManagedBrowserMaintenance from "./managedBrowserMaintenance.ts";
import * as ManagedBrowserRuntime from "./ManagedBrowserRuntime.ts";
import {
  COMPONENT_DIR,
  SHIPPED_LOCK,
  buildRelease,
  makeKeys,
  makeTemporaryDirectory,
  lockFileOf,
  testLock,
} from "./ManagedBrowserUpdateFixture.ts";

const join = (...parts: ReadonlyArray<string>) => parts.join("/");

describe("which environment reaches the browser process", () => {
  it("passes an allowlist only, never the server's credentials", () => {
    const environment = childEnvironmentOf({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      T3CODE_AUTH_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      PLAYWRIGHT_BROWSERS_PATH: "/browsers",
      LANG: "",
    });
    assert.deepEqual(environment, {
      DISPLAY: "",
      PATH: "/usr/bin",
      HOME: "/home/someone",
      PLAYWRIGHT_BROWSERS_PATH: "/browsers",
    });
  });
});

const childEnvironmentOf = (env: NodeJS.ProcessEnv) => ManagedBrowserRuntime.childEnvironment(env);

describe("whether this server hosts a managed browser", () => {
  it("is off without an engine, and says nothing else is configured", () => {
    assert.isNull(ManagedBrowserRuntime.resolveOptions({}, "/state", join, "/usr/bin/node"));
    assert.isNull(
      ManagedBrowserRuntime.resolveOptions(
        { [ManagedBrowserRuntime.ENGINE_VARIABLE]: "" },
        "/state",
        join,
        "/usr/bin/node",
      ),
    );
  });

  it("keeps its profiles under the server's state directory, headless, with the engine as the entry", () => {
    const options = ManagedBrowserRuntime.resolveOptions(
      {
        [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/managed/main.js",
        T3CODE_MANAGED_BROWSER_CHROME: "/usr/bin/google-chrome",
        T3CODE_SECRET: "not forwarded",
      },
      "/state",
      join,
      "/usr/bin/node",
    )!;
    assert.equal(options.command, "/usr/bin/node");
    assert.deepEqual(options.args, ["/opt/stealth/managed/main.js"]);
    assert.equal(options.dataRoot, "/state/managed-browser");
    assert.equal(options.headless, true);
    assert.equal(options.browserExecutable, "/usr/bin/google-chrome");
    assert.notProperty(options.environment, "T3CODE_SECRET");
  });
});

describe("headed or headless, by what the host can show", () => {
  const withEngine = (extra: NodeJS.ProcessEnv) =>
    ManagedBrowserRuntime.resolveOptions(
      { [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/managed/main.js", ...extra },
      "/state",
      join,
      "/usr/bin/node",
    )!;

  it("stays headless unless full window viewing was turned on, even with every tool present", () => {
    const options = withEngine({ PATH: "/usr/bin" });
    assert.equal(options.headless, true);
    assert.notProperty(options, "desktop");
  });

  it("stays headless, not broken, when full window was asked for and a tool is missing", () => {
    const options = withEngine({
      [ManagedBrowserDesktop.DESKTOP_VARIABLE]: "1",
      PATH: "/nonexistent",
    });
    assert.equal(options.headless, true);
    assert.notProperty(options, "desktop");
  });

  it("is headed on the host's own screen, with no display of its own, when the desktop app hosts it natively", () => {
    const environment = {
      [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/managed/main.js",
      [ManagedBrowserDesktop.NATIVE_VARIABLE]: "1",
      HOME: "/Users/someone",
      PATH: "/usr/bin",
    };
    const probe = ManagedBrowserDesktop.probeDesktop(environment, {
      platform: "darwin",
      desktopOwned: true,
    });
    const options = ManagedBrowserRuntime.resolveOptions(
      environment,
      "/state",
      join,
      "/usr/bin/node",
      probe,
    )!;
    assert.equal(options.native, true);
    assert.notProperty(options, "headless");
    assert.notProperty(options, "desktop");
    // The Linux display variable would only point Chrome at a screen that is not there.
    assert.notProperty(options.environment, "DISPLAY");
    assert.equal(options.environment.HOME, "/Users/someone");
    // The same variable is ignored by a server the desktop app does not own.
    const inherited = ManagedBrowserRuntime.resolveOptions(
      environment,
      "/state",
      join,
      "/usr/bin/node",
    )!;
    assert.equal(inherited.headless, true);
    assert.notProperty(inherited, "native");
  });
});

const ownerEnvironmentId = EnvironmentId.make("env-owner");

const hosted = (
  environment: NodeJS.ProcessEnv,
  /** Runs against the state directory before the runtime is built. */
  prepare?: Effect.Effect<void, never, ServerConfig.ServerConfig>,
) =>
  ManagedBrowserRuntime.layer.pipe(
    Layer.provide(prepare === undefined ? Layer.empty : Layer.effectDiscard(prepare)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(HostProcessEnvironment, environment),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(ownerEnvironmentId),
          getDescriptor: Effect.die("unused descriptor"),
        }),
        Layer.provide(PreviewManager.layer, NodeCrypto.layer),
        NodeCrypto.layer,
      ).pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-runtime-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const enabledWith = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const adapter = yield* ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter;
    return adapter.enabled;
  }).pipe(Effect.provide(hosted(environment)), Effect.scoped);

describe("the adapter the server ends up with", () => {
  it.live("is the disabled one when nothing is configured", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* enabledWith({}));
    }),
  );

  it.live("is the real one when an engine is configured", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* enabledWith({ [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/main.js" }),
      );
    }),
  );

  it.live(
    "stays disabled, instead of stopping the server, when the configuration is unusable",
    () =>
      Effect.gen(function* () {
        assert.isFalse(
          yield* enabledWith({
            [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/main.js",
            T3CODE_MANAGED_BROWSER_NODE: "node",
          }),
        );
      }),
  );
});

/** A component directory as a build lays it out: the installer, its schema, a lock and a shipped baseline. */
const makeComponent = (options: {
  readonly provisioned: boolean;
  readonly wrongDigest?: boolean;
}) => {
  const directory = makeTemporaryDirectory("component");
  const component = Path.join(directory, "stealth-browser");
  FS.cpSync(Path.join(COMPONENT_DIR, "tools"), Path.join(component, "tools"), { recursive: true });
  FS.cpSync(Path.join(COMPONENT_DIR, "release"), Path.join(component, "release"), {
    recursive: true,
  });
  if (!options.provisioned) {
    FS.copyFileSync(SHIPPED_LOCK, Path.join(component, "lock.json"));
    return component;
  }
  const keys = makeKeys();
  const baseline = buildRelease(Path.join(component, "baseline"), {
    version: "2.0.0",
    keys,
    os: process.platform,
    arch: process.arch,
  });
  const sha256 = (path: string) =>
    Crypto.createHash("sha256").update(FS.readFileSync(path)).digest("hex");
  const archiveSha256 = (
    JSON.parse(FS.readFileSync(baseline.manifestPath, "utf8")) as { archiveSha256: string }
  ).archiveSha256;
  FS.writeFileSync(
    Path.join(component, "lock.json"),
    JSON.stringify(
      lockFileOf(
        testLock([keys], {
          baseline: {
            version: "2.0.0",
            archiveSha256: options.wrongDigest === true ? "0".repeat(64) : archiveSha256,
            manifestSha256: sha256(baseline.manifestPath),
          },
        }),
      ),
    ),
  );
  return component;
};

describe("the controls the server offers a person's client", () => {
  const overviewOf = (environment: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const controls = yield* ManagedBrowserControls.ManagedBrowserControls;
      return yield* controls.overview({ sessionId: "admin", administrator: true });
    }).pipe(Effect.provide(hosted(environment)), Effect.scoped);

  it.live("exist on a server that hosts nothing, and say so instead of failing", () =>
    Effect.gen(function* () {
      const overview = yield* overviewOf({});
      assert.deepEqual(overview.hosting, { available: false, reason: "notConfigured" });
      assert.equal(overview.fullWindow.available, false);
    }),
  );

  it.live("report why the whole window is off on a server that hosts a browser", () =>
    Effect.gen(function* () {
      const overview = yield* overviewOf({
        [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/main.js",
      });
      assert.deepEqual(overview.hosting, { available: true, reason: null });
      assert.match(overview.fullWindow.reason ?? "", /turned off/);
    }),
  );
});

describe("a build that ships the unprovisioned lock", () => {
  const admin = { sessionId: "admin", administrator: true };
  const onShippedLock = Effect.gen(function* () {
    const controls = yield* ManagedBrowserControls.ManagedBrowserControls;
    return {
      overview: yield* controls.overview(admin),
      status: yield* controls.updateStatus,
      checked: (yield* controls.update({ action: "check" })).status,
    };
  }).pipe(
    Effect.provide(
      hosted({
        T3CODE_STEALTH_BROWSER_COMPONENT_DIR: makeComponent({ provisioned: false }),
        PATH: process.env.PATH ?? "",
      }),
    ),
    Effect.scoped,
  );

  it.live(
    "tells a person it is not set up, and exactly what it lacks, through the real controls",
    () =>
      Effect.gen(function* () {
        const { overview, status, checked } = yield* onShippedLock;
        assert.deepEqual(overview.hosting, { available: false, reason: "unprovisioned" });
        assert.deepEqual(status.provisioning, {
          signingKey: false,
          baseline: false,
          releaseSource: false,
        });
        assert.isNull(status.current);
        assert.isNull(status.staged);
        // A check with nothing installed finds nothing and stages nothing; it does not invent a release.
        assert.equal(checked.lastCheck?.outcome, "unavailable");
        assert.isNull(checked.staged);
      }),
  );
});

describe("the marker that keeps `t3 update` from restarting a hosting server", () => {
  const markerPresent = (environment: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      yield* ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter;
      const config = yield* ServerConfig.ServerConfig;
      return ManagedBrowserMaintenance.managedBrowserHosted(
        ManagedBrowserMaintenance.hostingMarkerPath(config.stateDir),
      );
    }).pipe(Effect.provide(hosted(environment)), Effect.scoped);

  it.live("exists while managed browsers can be hosted, and not when nothing is", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* markerPresent({ [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/main.js" }),
      );
      assert.isFalse(yield* markerPresent({}));
    }),
  );
});

describe("when the marker cannot be published", () => {
  it.live("no managed browser is hosted, because `t3 update` could not be told", () =>
    Effect.gen(function* () {
      const enabled = yield* Effect.gen(function* () {
        const adapter = yield* ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter;
        return adapter.enabled;
      }).pipe(
        Effect.provide(
          hosted(
            { [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/main.js" },
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              // A directory where the marker file must go.
              FS.mkdirSync(ManagedBrowserMaintenance.hostingMarkerPath(config.stateDir), {
                recursive: true,
              });
            }),
          ),
        ),
        Effect.scoped,
      );
      assert.isFalse(enabled);
    }),
  );
});

describe("hosting from the packaged component", () => {
  const withComponent = (component: string) =>
    Effect.gen(function* () {
      const adapter = yield* ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter;
      const config = yield* ServerConfig.ServerConfig;
      // Read inside the scope: the test server's state directory goes with it.
      const packageRoot = Path.join(config.stateDir, "managed-browser", "package");
      return {
        enabled: adapter.enabled,
        current: FS.existsSync(Path.join(packageRoot, "current"))
          ? FS.readlinkSync(Path.join(packageRoot, "current"))
          : null,
        installed: FS.existsSync(Path.join(packageRoot, "versions")),
      };
    }).pipe(
      Effect.provide(
        hosted({ T3CODE_STEALTH_BROWSER_COMPONENT_DIR: component, PATH: process.env.PATH ?? "" }),
      ),
      Effect.scoped,
    );

  it.live("installs the pinned baseline into the state directory and hosts from it", () =>
    Effect.gen(function* () {
      const { enabled, current } = yield* withComponent(makeComponent({ provisioned: true }));
      assert.isTrue(enabled);
      assert.equal(current, Path.join("versions", "2.0.0"));
    }),
  );

  it.live("stays a client, installing nothing, while no key or baseline is provisioned", () =>
    Effect.gen(function* () {
      const { enabled, installed } = yield* withComponent(makeComponent({ provisioned: false }));
      assert.isFalse(enabled);
      assert.isFalse(installed);
    }),
  );

  it.live("stays a client when the shipped baseline is not the one the lock pins", () =>
    Effect.gen(function* () {
      const { enabled } = yield* withComponent(
        makeComponent({ provisioned: true, wrongDigest: true }),
      );
      assert.isFalse(enabled);
    }),
  );

  it.live("an explicit engine still wins over the component", () =>
    Effect.gen(function* () {
      const enabled = yield* enabledWith({
        [ManagedBrowserRuntime.ENGINE_VARIABLE]: "/opt/stealth/main.js",
        T3CODE_STEALTH_BROWSER_COMPONENT_DIR: makeComponent({ provisioned: false }),
      });
      assert.isTrue(enabled);
    }),
  );
});

describe("the release source the lock names", () => {
  const secretStore = Layer.mergeAll(NodeCrypto.layer).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-release-source-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  it.live("reads a private repository with the token held in the secret store, found by name", () =>
    Effect.gen(function* () {
      const directory = makeTemporaryDirectory("runtime-source");
      const keys = makeKeys();
      const release = buildRelease(directory, { version: "2.1.0", keys });
      const fixture = yield* Effect.promise(() =>
        serveGithub({
          repository: "acme/stealth-browser",
          token: "stored-token",
          releases: [{ tag: "v2.1.0", built: release }],
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => fixture.close()));
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const source = ManagedBrowserRuntime.releaseSourceOf(
        {
          kind: "github",
          repository: "acme/stealth-browser",
          apiBaseUrl: fixture.apiUrl,
          tokenSecret: "release-token",
        },
        secrets,
        Path.join(directory, "downloads"),
      )!;
      // Unset: the repository answers as it does to anyone it does not admit.
      const unset = yield* Effect.exit(source.list);
      assert.equal(unset._tag, "Failure");
      yield* secrets.set("release-token", new TextEncoder().encode("stored-token\n"));
      assert.deepEqual(
        (yield* source.list).map((candidate) => candidate.version),
        ["2.1.0"],
      );
      assert.isNull(
        ManagedBrowserRuntime.releaseSourceOf(null, secrets, Path.join(directory, "downloads")),
      );
    }).pipe(Effect.provide(secretStore), Effect.scoped),
  );
});
