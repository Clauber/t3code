// @effect-diagnostics nodeBuiltinImport:off
/**
 * ManagedBrowserRuntime - decides whether this server hosts a managed browser, and wires it.
 *
 * A server hosts one only when it is told where the engine is (`T3CODE_MANAGED_BROWSER_ENGINE`, the
 * engine's `managed/main.js`). Without it the preview adapter is the disabled one, so a named
 * session fails by name instead of becoming a temporary tab. A misconfiguration is logged and also
 * leaves the server running with it disabled: a browser component must never stop the server starting.
 *
 * Without it, the packaged component is used when this build carries one: a signed stealth-browser
 * release verified against the keys in the component lock, installed under the server's state directory
 * and kept current by {@link ManagedBrowserUpdate}. A host that cannot run it (nothing provisioned, no
 * Chrome, another platform) leaves the adapter disabled by name and stays a client of other owners'
 * browsers. The supervisor, the lease and the adapter below it are the same either way.
 *
 * @module ManagedBrowserRuntime
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FS from "node:fs";
import * as NodePath from "node:path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedBrowserAccess from "./ManagedBrowserAccess.ts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ManagedBrowserControls from "./ManagedBrowserControls.ts";
import * as ManagedBrowserDesktop from "./ManagedBrowserDesktop.ts";
import * as ManagedBrowserGithubSource from "./ManagedBrowserGithubSource.ts";
import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRegistry from "./ManagedBrowserRegistry.ts";
import * as ManagedBrowserRemoteClient from "./ManagedBrowserRemoteClient.ts";
import * as ManagedBrowserSmoke from "./ManagedBrowserSmoke.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";
import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";
import * as ManagedBrowserUpdate from "./ManagedBrowserUpdate.ts";
import * as Maintenance from "./managedBrowserMaintenance.ts";

export const ENGINE_VARIABLE = "T3CODE_MANAGED_BROWSER_ENGINE";
const NODE_VARIABLE = "T3CODE_MANAGED_BROWSER_NODE";
const CHROME_VARIABLE = "T3CODE_MANAGED_BROWSER_CHROME";
/** Explicit path of the component lock: where trusted keys, the baseline and the release source are named. */
export const LOCK_VARIABLE = "T3CODE_STEALTH_BROWSER_LOCK";

/** What reaches the browser process. The server's own environment, with its credentials, never does. */
const CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "PLAYWRIGHT_BROWSERS_PATH",
  "STEALTH_PROXY_URL",
  "RESIDENTIAL_PROXY_URL",
] as const;

export const childEnvironment = (
  environment: NodeJS.ProcessEnv,
  native = false,
): Readonly<Record<string, string>> => {
  // An empty display keeps a headless Chrome off any display the server happens to inherit; a native one
  // runs in the person's own session, where there is no such variable to blank.
  const result: Record<string, string> = native ? {} : { DISPLAY: "" };
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    const value = environment[name];
    if (value !== undefined && value.length > 0) result[name] = value;
  }
  return result;
};

/** The launcher's options for an engine entry; the engine itself is a path or, packaged, chosen per launch. */
const launcherOptions = (
  environment: NodeJS.ProcessEnv,
  stateDir: string,
  join: (...parts: ReadonlyArray<string>) => string,
  nodeExecutable: string,
  args: ReadonlyArray<string>,
  probe: ManagedBrowserDesktop.DesktopProbe,
): ManagedBrowserIpc.ManagedBrowserIpcOptions => {
  const chrome = environment[CHROME_VARIABLE];
  // On the host's own screen when the desktop app hosts natively; headed on a private display only when
  // full window viewing is on and every tool it needs is there; otherwise the ordinary headless browser,
  // with page viewing unchanged.
  return {
    command: environment[NODE_VARIABLE] ?? nodeExecutable,
    args,
    dataRoot: join(stateDir, "managed-browser"),
    environment: childEnvironment(environment, probe.launchNative),
    adapterVersion: "t3-server",
    ...(probe.launchNative
      ? { native: true }
      : probe.launchDesktop
        ? { desktop: true }
        : { headless: true }),
    ...(chrome === undefined || chrome.length === 0 ? {} : { browserExecutable: chrome }),
  };
};

/** Null when no managed browser is configured; otherwise the launcher's options. */
export const resolveOptions = (
  environment: NodeJS.ProcessEnv,
  stateDir: string,
  join: (...parts: ReadonlyArray<string>) => string,
  nodeExecutable: string,
  probe: ManagedBrowserDesktop.DesktopProbe = ManagedBrowserDesktop.probeDesktop(environment),
): ManagedBrowserIpc.ManagedBrowserIpcOptions | null => {
  const engine = environment[ENGINE_VARIABLE];
  if (engine === undefined || engine.length === 0) return null;
  return launcherOptions(environment, stateDir, join, nodeExecutable, [engine], probe);
};

export interface ManagedBrowserLayerPaths {
  readonly ownerEnvironmentId: EnvironmentId;
  /** The owner's grants. */
  readonly grantsPath: string;
  /** This server's enrollments in other owners' browsers. */
  readonly enrollmentsPath: string;
  /** Where files fetched from another owner are kept on this environment. */
  readonly remoteDownloadsRoot: string;
  /** The tabs this server holds on other owners' browsers, so a restart reattaches the same ones. */
  readonly remoteTabsPath?: string;
  /** Test seams: the outbound call and the clock. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/**
 * Everything the preview browser and the routes consume, from one place: the owner's access record, this
 * server's enrollments, the adapter for browsers it hosts (or the disabled one), and the one adapter that
 * routes a call to where its browser is. `hosted` null is a server that cannot run a browser but can
 * still use a remote one.
 */
export const composeLayers = <
  ROut extends ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
  E = never,
  R = never,
>(
  paths: ManagedBrowserLayerPaths,
  hosted: Layer.Layer<ROut, E, R> | null,
  desktop: ManagedBrowserDesktop.DesktopProbe | null = null,
) => {
  const access = ManagedBrowserAccess.layer({
    ownerEnvironmentId: paths.ownerEnvironmentId,
    path: paths.grantsPath,
    ...(paths.now === undefined ? {} : { now: paths.now }),
  });
  const remote = ManagedBrowserRemoteClient.layer({
    path: paths.enrollmentsPath,
    tabsPath: paths.remoteTabsPath ?? null,
    downloadsRoot: paths.remoteDownloadsRoot,
    ...(paths.fetch === undefined ? {} : { fetch: paths.fetch }),
    ...(paths.now === undefined ? {} : { now: paths.now }),
  });
  const shared = Layer.mergeAll(access, remote);
  // With nothing hosted the disabled adapter is the whole of ROut.
  const local = (hosted ??
    Layer.succeed(
      ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
      ManagedBrowserPreviewAdapter.disabledAdapter,
    )) as Layer.Layer<ROut, E, R>;
  const adapters = ManagedBrowserRemoteClient.routedLayer.pipe(
    Layer.provideMerge(local.pipe(Layer.provideMerge(shared))),
  );
  // What a person's client asks of this owner: the same services, answered for their session.
  return ManagedBrowserControls.layer.pipe(
    Layer.provideMerge(
      adapters.pipe(
        Layer.provideMerge(desktop === null ? Layer.empty : ManagedBrowserDesktop.layer(desktop)),
      ),
    ),
  );
};

/**
 * The release source the lock names. A GitHub source reads its credential, when the lock names one, from
 * the server's secret store on each request; the lock holds the secret's name, never a token.
 */
export const releaseSourceOf = (
  config: ManagedBrowserPackage.ReleaseSourceConfig | null,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  downloadRoot: string,
  target: string = ManagedBrowserPackage.hostTarget(),
): ManagedBrowserPackage.ReleaseSource | null => {
  if (config === null) return null;
  if (config.kind === "directory") return ManagedBrowserPackage.directorySource(config.path);
  const tokenSecret = config.tokenSecret;
  return ManagedBrowserGithubSource.githubSource({
    repository: config.repository,
    ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
    downloadRoot,
    target,
    token:
      tokenSecret === undefined
        ? Effect.succeed(null)
        : secrets.get(tokenSecret).pipe(
            Effect.map((value) =>
              value._tag === "Some" ? new TextDecoder().decode(value.value).trim() || null : null,
            ),
            // An unreadable store is a missing credential: the check then reports unauthorized.
            Effect.orElseSucceed(() => null),
          ),
  });
};

/** The component's lock, from an explicit path, beside the shipped component, or in the source tree. */
const resolveLockPath = (environment: NodeJS.ProcessEnv, componentDir: string) =>
  [
    environment[LOCK_VARIABLE],
    NodePath.join(componentDir, "lock.json"),
    NodePath.join(componentDir, "..", "stealth-browser.lock.json"),
  ].find(
    (candidate) => candidate !== undefined && candidate.length > 0 && FS.existsSync(candidate),
  );

interface PackagedComponent {
  readonly lock: ManagedBrowserPackage.ComponentLock;
  readonly tool: ManagedBrowserPackage.ReleaseTool;
  readonly componentDir: string;
  readonly root: string;
  readonly options: ManagedBrowserIpc.ManagedBrowserIpcOptions;
}

/** The packaged component this build carries, or null when it carries none. Throws when it is malformed. */
const loadComponent = (
  environment: NodeJS.ProcessEnv,
  stateDir: string,
  join: (...parts: ReadonlyArray<string>) => string,
  probe: ManagedBrowserDesktop.DesktopProbe,
): PackagedComponent | null => {
  const componentDir = ManagedBrowserPackage.resolveComponentDir(environment, import.meta.dirname);
  const lockPath = componentDir === null ? undefined : resolveLockPath(environment, componentDir);
  if (componentDir === null || lockPath === undefined) return null;
  const lock = ManagedBrowserPackage.readComponentLock(lockPath);
  const tool = ManagedBrowserPackage.loadReleaseTool(componentDir);
  const root = join(stateDir, "managed-browser", "package");
  const store = ManagedBrowserPackage.makePackageStore({ root, lock, tool });
  return {
    lock,
    tool,
    componentDir,
    root,
    options: {
      ...launcherOptions(environment, stateDir, join, process.execPath, [], probe),
      // Each launch reads the pointer, so an activation reaches the next child without a restart.
      resolveEngine: () => {
        const current = store.current();
        if (current === null) throw new Error("no managed browser release is installed");
        return store.engineOf(current.version);
      },
    },
  };
};

/** The launcher for the supervisor; each launch is told which engine to run. */
const launcherLayer = (options: ManagedBrowserIpc.ManagedBrowserIpcOptions) =>
  Layer.effect(
    ManagedBrowserSupervisor.ManagedBrowserChildLauncher,
    ManagedBrowserIpc.makeLauncher(options).pipe(
      Effect.map((launcher) =>
        ManagedBrowserSupervisor.ManagedBrowserChildLauncher.of({ launch: launcher.launch }),
      ),
    ),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* HostProcessEnvironment;
    const config = yield* ServerConfig.ServerConfig;
    const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
    const path = yield* Path.Path;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const ownerEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const markerPath = Maintenance.hostingMarkerPath(config.stateDir);
    // The record of instances, profiles and tabs sits beside the browser's profiles, in T3's state
    // directory and outside any source tree or release, so a restart finds the same bindings.
    const adapterDirectory = path.join(config.stateDir, "managed-browser", "adapter");
    // Who may use which browser, and where this server's calls to other owners go. Both are empty
    // until an administrator adds to them, so nothing is reachable by default. They exist even where
    // no browser is hosted: a server that cannot run Chrome can still be a client of one that can.
    const paths: ManagedBrowserLayerPaths = {
      ownerEnvironmentId,
      grantsPath: path.join(config.stateDir, "managed-browser", "grants.json"),
      enrollmentsPath: path.join(config.stateDir, "managed-browser", "enrollments.json"),
      remoteDownloadsRoot: path.join(adapterDirectory, "remote-downloads"),
      remoteTabsPath: path.join(config.stateDir, "managed-browser", "remote-tabs.json"),
    };

    // Native hosting is only for the server the desktop app started for itself, whatever the environment says.
    const desktop = ManagedBrowserDesktop.probeDesktop(environment, {
      desktopOwned: config.mode === "desktop",
    });
    // An explicit engine wins; otherwise the packaged component, when this build carries a usable one.
    const explicit = resolveOptions(
      environment,
      config.stateDir,
      path.join,
      process.execPath,
      desktop,
    );
    const component =
      explicit !== null
        ? null
        : yield* Effect.try({
            try: () => loadComponent(environment, config.stateDir, path.join, desktop),
            catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
          }).pipe(
            Effect.catch((detail) =>
              Effect.logWarning("managed browser component is unusable; it is disabled", {
                detail,
              }).pipe(Effect.as(null)),
            ),
          );
    const options = explicit ?? component?.options ?? null;
    if (options === null) return composeLayers(paths, null, desktop);
    const embedded = desktopChannel.available && desktop.launchNative;
    const endpoints = new Map<
      string,
      { incarnation: string; url: string; scope: Scope.Closeable }
    >();
    yield* desktopChannel.detached.pipe(
      Stream.runForEach((key) =>
        Effect.gen(function* () {
          const id = `${key.threadId}\u0000${key.tabId}`;
          const endpoint = endpoints.get(id);
          if (!endpoint) return;
          endpoints.delete(id);
          yield* Scope.close(endpoint.scope, Exit.void);
        }),
      ),
      Effect.forkScoped,
    );
    const embeddedEndpoint: NonNullable<
      ManagedBrowserIpc.ManagedBrowserIpcOptions["embeddedEndpoint"]
    > = (instanceId, tabId, incarnation) =>
      Effect.gen(function* () {
        const key = { threadId: instanceId, tabId };
        const id = `${instanceId}\u0000${tabId}`;
        const previous = endpoints.get(id);
        if (previous?.incarnation === incarnation) return previous.url;
        if (previous) {
          endpoints.delete(id);
          yield* Scope.close(previous.scope, Exit.void);
        }
        if (!(yield* desktopChannel.awaitAttached(key, "15 seconds")))
          return yield* Effect.fail(
            new ManagedBrowserSupervisor.ManagedBrowserChildChannelError({
              instanceId,
              cause: new Error("The native managed tab is not attached to T3."),
            }),
          );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => {
          if (endpoints.get(id)?.scope === scope) endpoints.delete(id);
          return Scope.close(scope, Exit.void);
        });
        const url = yield* desktopChannel.endpoint(key).pipe(Scope.provide(scope));
        endpoints.set(id, { incarnation, url, scope });
        return url;
      });
    const engineLauncher = embedded
      ? {
          ...options,
          native: false,
          headless: false,
          desktop: false,
          embedded: true,
          embeddedEndpoint,
        }
      : options;
    // A launcher that cannot be configured must not stop the server: report it and stay disabled.
    const checked = yield* ManagedBrowserIpc.makeLauncher(engineLauncher).pipe(
      Effect.map(() => true),
      Effect.catch((error) =>
        Effect.logWarning("managed browser is configured but unusable; it is disabled", {
          detail: error.detail,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!checked) return composeLayers(paths, null, desktop);
    yield* Effect.logInfo("managed browser enabled", {
      engine: component === null ? environment[ENGINE_VARIABLE] : "packaged component",
      node: engineLauncher.command,
      dataRoot: engineLauncher.dataRoot,
    });
    const supervisor = ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
      Layer.provideMerge(ManagedBrowserControl.layer),
      Layer.provide(launcherLayer(engineLauncher)),
    );
    const registry = ManagedBrowserRegistry.make(path.join(adapterDirectory, "registry.json"));
    if (registry.status._tag !== "ready") {
      yield* Effect.logError(
        "managed browser tab record is unreadable; named sessions are refused",
        {
          detail: registry.status.detail,
        },
      );
    }
    // T3's own update path takes this before it hands off to a restart that would end the child.
    const gate = Maintenance.gateLayer.pipe(Layer.provide(supervisor));
    // Hosting is offered only once the marker `t3 update` reads is published; otherwise this server is a client.
    const publishedBeforeHosting = <A, E, R>(adapter: Effect.Effect<A, E, R>) =>
      Maintenance.publishHostingMarker(markerPath).pipe(
        Effect.matchEffect({
          onSuccess: () => adapter,
          onFailure: (error) =>
            Effect.logError(
              "managed browser hosting is off: the hosting marker was not published",
              {
                detail: error.detail,
              },
            ).pipe(Effect.as(ManagedBrowserPreviewAdapter.disabledAdapter)),
        }),
      );
    // Agents of other environments are served only under a live grant; the owner's own agents as before.
    const adapter = Effect.gen(function* () {
      const grants = yield* ManagedBrowserAccess.ManagedBrowserAccessService;
      return yield* ManagedBrowserPreviewAdapter.make({
        registry,
        ...(embedded ? { desktop: desktopChannel } : {}),
        downloadsRoot: path.join(adapterDirectory, "downloads"),
        policy: ManagedBrowserPreviewAdapter.grantPolicy(ownerEnvironmentId, grants),
        fullWindow: desktop.capability,
      });
    });
    if (component === null) {
      const hosted = Layer.effect(
        ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
        publishedBeforeHosting(adapter),
      ).pipe(Layer.provide(supervisor));
      return composeLayers(paths, Layer.merge(hosted, gate), desktop);
    }
    const { lock, tool, componentDir, root } = component;
    const update = ManagedBrowserUpdate.layer({
      root,
      lock,
      tool,
      source: yield* Effect.try({
        try: () => releaseSourceOf(lock.releaseSource, secrets, path.join(root, "downloads")),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.catch((detail) =>
          Effect.logWarning("the managed browser release source is unusable; updates are off", {
            detail,
          }).pipe(Effect.as(null)),
        ),
      ),
      baseline: ManagedBrowserPackage.directorySource(path.join(componentDir, "baseline")),
      smoke: ManagedBrowserSmoke.makeLauncherSmoke(
        { ...engineLauncher, resolveEngine: undefined },
        ownerEnvironmentId,
        spawner,
      ),
    }).pipe(Layer.provide(supervisor));
    // Hosting is only offered once a verified release is installed; otherwise this server is a client.
    const hosted = Layer.effect(
      ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
      Effect.gen(function* () {
        const status = yield* (yield* ManagedBrowserUpdate.ManagedBrowserUpdate).status;
        // A pending recovery refuses launches by name through the engine choice; the adapter stays so it can end.
        if (!status.hosting.available && status.hosting.reason !== "recoveryRequired") {
          yield* Effect.logWarning("managed browser hosting is unavailable on this server", {
            reason: status.hosting.reason,
            provisioning: status.provisioning,
          });
          return ManagedBrowserPreviewAdapter.disabledAdapter;
        }
        return yield* publishedBeforeHosting(adapter);
      }),
    ).pipe(Layer.provide(Layer.merge(supervisor, update)));
    return composeLayers(paths, Layer.mergeAll(hosted, gate, update), desktop);
  }),
).pipe(Layer.provide(DesktopBrowserChannel.layer));
