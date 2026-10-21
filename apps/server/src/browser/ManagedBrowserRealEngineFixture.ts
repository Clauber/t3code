// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test support: runs the real engine (compiled, with its own Patchright) as the supervisor's child
 * against a disposable data root, with a headless browser. Nothing here is used outside tests.
 *
 * The engine is the packaged release payload (fixture-signed `stealth-browser` 2.0.0, installed under a
 * path with spaces) run by the Node runtime that package carries, never a source build. Both can be
 * redirected with `T3_MANAGED_BROWSER_ENGINE_MAIN` / `T3_MANAGED_BROWSER_NODE`; an absent engine
 * disables the suites that need it rather than failing them.
 */
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import {
  EnvironmentId,
  ThreadId,
  type PreviewAutomationRequest,
  ManagedBrowserInstanceId,
  ManagedBrowserPrincipalId,
  ManagedBrowserProfileId,
  type ManagedBrowserPrincipal,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRegistry from "./ManagedBrowserRegistry.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

export const PACKAGE_ROOT =
  "/workspace/ai/sandbox/active/stealth-browser-release/managed-package-final/installed with spaces/versions/2.0.0";

export const ENGINE_MAIN =
  process.env.T3_MANAGED_BROWSER_ENGINE_MAIN ??
  Path.join(PACKAGE_ROOT, "dist", "managed", "main.js");

/** The Node the package carries; the host's own only when the engine was redirected elsewhere. */
export const ENGINE_NODE =
  process.env.T3_MANAGED_BROWSER_NODE ??
  (process.env.T3_MANAGED_BROWSER_ENGINE_MAIN === undefined
    ? Path.join(PACKAGE_ROOT, "bin", "node")
    : process.execPath);

export const engineAvailable = FS.existsSync(ENGINE_MAIN);

export const ownerEnvironmentId = EnvironmentId.make("env-owner");
export const instanceId = ManagedBrowserInstanceId.make("instance-real");
export const profileId = ManagedBrowserProfileId.make("profile-real");
export const descriptor = { ownerEnvironmentId, instanceId, profileId };

export const agent: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("agent:session-1"),
  kind: "agent",
  access: "operate",
};
export const human: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("human:viewer-1"),
  kind: "human",
  access: "operate",
};
export const viewer: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("human:viewer-2"),
  kind: "human",
  access: "read",
};

/** The caller's identity as the engine sees it: its own environment, not the owner's. */
export const callerContext = {
  environmentId: "env-owner",
  threadId: "thread-1",
  agentSessionId: "session-1",
};

export interface RealEngineOptions {
  readonly timeouts?: Partial<ManagedBrowserIpc.ManagedBrowserIpcTimeouts>;
  /** Reuse a data root across runs to prove state survives a restart. */
  readonly dataRoot?: string;
}

export const makeDataRoot = () => FS.mkdtempSync(Path.join(OS.tmpdir(), "managed-browser-real-"));

/** A disposable data root that is removed when the scope ends, after the child has exited. */
const scopedDataRoot = (given: string | undefined) =>
  given !== undefined
    ? Effect.succeed(given)
    : Effect.acquireRelease(Effect.sync(makeDataRoot), (root) =>
        Effect.sync(() => FS.rmSync(root, { recursive: true, force: true })),
      );

/**
 * The supervisor over the real engine. `body` runs inside the layer scope, so leaving it stops the
 * child and proves its exit.
 */
export const withRealEngine = <A, E>(
  options: RealEngineOptions,
  body: (
    supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
    dataRoot: string,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const dataRoot = yield* scopedDataRoot(options.dataRoot);
    const launcher = ManagedBrowserIpc.layer({
      command: ENGINE_NODE,
      args: [ENGINE_MAIN],
      dataRoot,
      environment: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? OS.tmpdir(),
        DISPLAY: "",
        STEALTH_PROXY_URL: "",
        RESIDENTIAL_PROXY_URL: "",
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
          ? {}
          : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
      },
      adapterVersion: "1.0.0",
      headless: true,
      ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    }).pipe(Layer.provide(NodeServices.layer));
    const layer = ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
      Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
      Layer.provide(Layer.mergeAll(launcher, NodeCrypto.layer)),
    );
    return yield* Effect.gen(function* () {
      const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
      return yield* body(supervisor, dataRoot);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.scoped);

// ---------------------------------------------------------------------------
// Commands, as the adapter sends them
// ---------------------------------------------------------------------------

export const openCommand = (tabId: string, url: string) => ({
  kind: "open" as const,
  caller: callerContext,
  tabId,
  url,
});

export const evaluateCommand = (tabId: string, documentId: string, expression: string) => ({
  kind: "execute" as const,
  caller: callerContext,
  tabId,
  documentId,
  operation: { name: "evaluate" as const, expression, argument: null },
});

// ---------------------------------------------------------------------------
// The preview adapter over the real engine
// ---------------------------------------------------------------------------

export const threadId = ThreadId.make("thread-1");
export const agentSessionId = `${ownerEnvironmentId}\u0000session-1`;

/** The request the broker would hand the server browser for one tool call. */
export const previewRequest = (
  operation: PreviewAutomationRequest["operation"],
  input: unknown,
  extra: Partial<PreviewAutomationRequest> = {},
): PreviewAutomationRequest => ({
  requestId: `request-${operation}`,
  threadId,
  agentSessionId,
  callerEnvironmentId: ownerEnvironmentId,
  operation,
  input,
  timeoutMs: 15_000,
  ...extra,
});

export const binding = { ownerEnvironmentId, instanceId, profileId };

export interface RealAdapterOptions extends RealEngineOptions {
  readonly policy?: ManagedBrowserPreviewAdapter.ManagedBrowserAccessPolicy;
}

/** The supervisor over the real engine, and what the preview adapter needs around it. */
export const engineLayers = (
  dataRoot: string,
  options: { readonly timeouts?: Partial<ManagedBrowserIpc.ManagedBrowserIpcTimeouts> } = {},
  environmentId: EnvironmentId = ownerEnvironmentId,
) => {
  const launcher = ManagedBrowserIpc.layer({
    command: ENGINE_NODE,
    args: [ENGINE_MAIN],
    dataRoot,
    environment: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? OS.tmpdir(),
      DISPLAY: "",
      STEALTH_PROXY_URL: "",
      RESIDENTIAL_PROXY_URL: "",
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
        ? {}
        : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
    },
    adapterVersion: "1.0.0",
    headless: true,
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  }).pipe(Layer.provide(NodeServices.layer));
  const supervisorLayer = ManagedBrowserSupervisor.layer({
    ownerEnvironmentId: environmentId,
  }).pipe(
    Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
    Layer.provide(Layer.mergeAll(launcher, NodeCrypto.layer)),
  );
  const surroundings = Layer.mergeAll(
    Layer.provide(PreviewManager.layer, NodeCrypto.layer),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    NodeServices.layer,
    NodeCrypto.layer,
  );
  return { supervisorLayer, surroundings };
};

/** The adapter, the preview manager and the supervisor over one real engine and a disposable profile. */
export const withRealAdapter = <A, E>(
  options: RealAdapterOptions,
  body: (services: {
    readonly adapter: ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"];
    readonly supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];
    readonly manager: PreviewManager.PreviewManager["Service"];
    readonly registry: ManagedBrowserRegistry.ManagedBrowserRegistry;
    readonly dataRoot: string;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const dataRoot = yield* scopedDataRoot(options.dataRoot);
    const { supervisorLayer, surroundings } = engineLayers(dataRoot, options);
    // The same layout the server uses: the adapter's record and downloads beside the browser's profiles.
    const registry = ManagedBrowserRegistry.make(Path.join(dataRoot, "adapter", "registry.json"));
    const adapterLayer = ManagedBrowserPreviewAdapter.layer({
      registry,
      downloadsRoot: Path.join(dataRoot, "adapter", "downloads"),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    }).pipe(Layer.provide(Layer.mergeAll(supervisorLayer, surroundings)));
    const layer = Layer.mergeAll(adapterLayer, supervisorLayer, surroundings).pipe(
      Layer.provideMerge(Layer.empty),
    );
    return yield* Effect.gen(function* () {
      const adapter = yield* ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter;
      const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
      const manager = yield* PreviewManager.PreviewManager;
      return yield* body({ adapter, supervisor, manager, registry, dataRoot });
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.scoped);
