// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off
/**
 * Test support: one disposable "T3 server" per environment. Each has its own environment id, secret
 * store, grant record, enrollment record and HTTP listener serving the real managed browser routes with
 * the real access service and routed adapter; only the authenticator is stubbed, and it asks for the
 * scopes the real routes require. The hosting fixture also runs the packaged engine under the real
 * `grantPolicy`. Nothing here is used outside tests, and no server in it is the live install.
 */
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServer } from "effect/http";

import {
  AuthSessionId,
  type EnvironmentId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import type * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ManagedBrowserAccess from "./ManagedBrowserAccess.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRegistry from "./ManagedBrowserRegistry.ts";
import * as ManagedBrowserRemoteClient from "./ManagedBrowserRemoteClient.ts";
import * as ManagedBrowserRoutes from "./ManagedBrowserRoutes.ts";
import * as ManagedBrowserRuntime from "./ManagedBrowserRuntime.ts";
import { engineLayers } from "./ManagedBrowserRealEngineFixture.ts";

export const ADMIN_SCOPES = "access:read,access:write";

export interface OutboundCall {
  readonly url: string;
  readonly status: number | "unreachable";
}

export interface ServerFixture {
  readonly environmentId: EnvironmentId;
  /** `http://127.0.0.1:<port>`: what an enrollment names. */
  readonly origin: string;
  /** What the preview browser of this server consumes. */
  readonly adapter: ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"];
  readonly local: ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter["Service"];
  /** This server's own preview sessions, where a remote tab is published. */
  readonly manager: PreviewManager.PreviewManager["Service"];
  readonly access: ManagedBrowserAccess.ManagedBrowserAccessService["Service"];
  readonly remote: ManagedBrowserRemoteClient.ManagedBrowserRemoteClient["Service"];
  readonly root: string;
  /** Every call this server made to another environment, in order. */
  readonly outbound: Array<OutboundCall>;
  /** Stops the listener only; the browser engine, if this server hosts one, keeps running. */
  readonly stopListening: Effect.Effect<void>;
  /** A request to this server's own routes, as an administrator unless `scopes` says otherwise. */
  readonly request: (
    method: string,
    path: string,
    options?: {
      readonly body?: unknown;
      readonly scopes?: string | null;
      readonly headers?: Record<string, string>;
      readonly rawBody?: Uint8Array;
    },
  ) => Effect.Effect<{ readonly status: number; readonly text: string; readonly json: unknown }>;
}

export interface ServerFixtureOptions {
  readonly environmentId: EnvironmentId;
  /** A data root makes this server host the packaged engine; null makes it a client only. */
  readonly engineDataRoot: string | null;
  readonly now?: () => number;
  /**
   * Starts this server over the files of an earlier one: its secrets, grants, enrollments and remote
   * tabs. The earlier one is then to be treated as stopped.
   */
  readonly resumeRoot?: string;
  /** Stands in for the hosted engine, for tests of the routes and the client that need no browser. */
  readonly fakeLocal?: ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"];
}

/**
 * An adapter that records what reaches it and answers from a function, so a test can say what the
 * browser would do and then prove what never got there.
 */
export const recordingAdapter = (
  respond: (
    request: PreviewAutomationRequest,
  ) => Effect.Effect<unknown, ServerBrowserPage.ServerBrowserOperationError> = () =>
    Effect.succeed({ tabId: "tab-1" }),
) => {
  const calls: Array<PreviewAutomationRequest> = [];
  const downloads = new Map<string, { path: string; fileName: string }>();
  const adapter = ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter.of({
    ...ManagedBrowserPreviewAdapter.disabledAdapter,
    enabled: true,
    claims: () => true,
    handle: (request) =>
      Effect.suspend(() => {
        calls.push(request);
        return respond(request);
      }),
    openAgentDownload: (request, downloadId) =>
      Effect.sync(() => {
        const found = downloads.get(`${request.tabId}/${downloadId}`);
        return found === undefined ? Option.none() : Option.some(found);
      }),
  });
  return { adapter, calls, downloads };
};

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

const authenticator = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (request) => {
    const scopes = request.headers["x-test-scopes"];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
      : Effect.succeed({
          sessionId: AuthSessionId.make("admin-session"),
          subject: "test-administrator",
          method: "bearer-access-token" as const,
          scopes: scopes.split(",").filter((scope) => scope.length > 0) as never,
        });
  },
});

/**
 * Starts one server. Everything lives in the caller's scope, apart from the listener, which has a scope
 * of its own so a test can take the owner away while its browser stays up.
 */
export const startServer = (options: ServerFixtureOptions) =>
  Effect.gen(function* () {
    const { environmentId } = options;
    // A restart is the same files under a new process: the caller that made the root removes it.
    const root =
      options.resumeRoot ??
      (yield* Effect.acquireRelease(
        Effect.sync(() => FS.mkdtempSync(Path.join(OS.tmpdir(), `managed-host-${environmentId}-`))),
        (directory) => Effect.sync(() => FS.rmSync(directory, { recursive: true, force: true })),
      ));
    const outbound: Array<OutboundCall> = [];
    const spy: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      try {
        const response = await globalThis.fetch(input, init);
        outbound.push({ url, status: response.status });
        return response;
      } catch (cause) {
        outbound.push({ url, status: "unreachable" });
        throw cause;
      }
    };

    const environmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused descriptor"),
    });
    const previewLayer = Layer.provide(PreviewManager.layer, NodeCrypto.layer);
    const base = Layer.mergeAll(environmentLayer, previewLayer, NodeServices.layer).pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), Path.join(root, "base"))),
      Layer.provideMerge(NodeServices.layer),
    );

    let hosted: Layer.Layer<
      ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
      never,
      ManagedBrowserAccess.ManagedBrowserAccessService
    > | null = null;
    if (options.fakeLocal !== undefined) {
      hosted = Layer.succeed(
        ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
        options.fakeLocal,
      );
    } else if (options.engineDataRoot !== null) {
      const { supervisorLayer, surroundings } = engineLayers(
        options.engineDataRoot,
        {},
        environmentId,
      );
      const registry = ManagedBrowserRegistry.make(
        Path.join(options.engineDataRoot, "adapter", "registry.json"),
      );
      hosted = Layer.effect(
        ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter,
        Effect.gen(function* () {
          const grants = yield* ManagedBrowserAccess.ManagedBrowserAccessService;
          return yield* ManagedBrowserPreviewAdapter.make({
            registry,
            downloadsRoot: Path.join(options.engineDataRoot!, "adapter", "downloads"),
            policy: ManagedBrowserPreviewAdapter.grantPolicy(environmentId, grants),
          });
        }),
      ).pipe(Layer.provide(Layer.mergeAll(supervisorLayer, surroundings)), Layer.orDie);
    }

    const composed = ManagedBrowserRuntime.composeLayers(
      {
        ownerEnvironmentId: environmentId,
        grantsPath: Path.join(root, "grants.json"),
        enrollmentsPath: Path.join(root, "enrollments.json"),
        remoteDownloadsRoot: Path.join(root, "remote-downloads"),
        remoteTabsPath: Path.join(root, "remote-tabs.json"),
        fetch: spy,
        ...(options.now === undefined ? {} : { now: options.now }),
      },
      hosted,
    ).pipe(Layer.provideMerge(base));
    const services = yield* Layer.build(composed);

    // The listener has its own scope so a test can end it without touching the browser.
    const listenerScope = yield* Scope.make();
    const serving = HttpRouter.serve(
      ManagedBrowserRoutes.routeLayerWith({
        transfersRoot: Path.join(root, "peer-transfers"),
        ...(options.now === undefined ? {} : { now: options.now }),
      }).pipe(Layer.provide(platformLayer)),
      { disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(authenticator));
    const listening = yield* Layer.build(serving).pipe(
      Effect.provideContext(services),
      Scope.provide(listenerScope),
    );
    yield* Effect.addFinalizer(() => Scope.close(listenerScope, Exit.void));
    const server = Context.get(listening, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address);

    const request: ServerFixture["request"] = (method, path, requestOptions = {}) =>
      Effect.promise(async () => {
        const scopes = requestOptions.scopes === undefined ? ADMIN_SCOPES : requestOptions.scopes;
        const body =
          requestOptions.rawBody ??
          (requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body));
        const response = await globalThis.fetch(`${origin}${path}`, {
          method,
          redirect: "manual",
          headers: {
            ...(scopes === null ? {} : { "x-test-scopes": scopes }),
            ...(requestOptions.rawBody === undefined && body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...requestOptions.headers,
          },
          ...(body === undefined ? {} : { body: body as never }),
        });
        const text = await response.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { status: response.status, text, json };
      });

    return {
      environmentId,
      origin,
      adapter: Context.get(services, ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter),
      local: Context.get(services, ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter),
      manager: Context.get(services, PreviewManager.PreviewManager),
      access: Context.get(services, ManagedBrowserAccess.ManagedBrowserAccessService),
      remote: Context.get(services, ManagedBrowserRemoteClient.ManagedBrowserRemoteClient),
      root,
      outbound,
      stopListening: Scope.close(listenerScope, Exit.void),
      request,
    } satisfies ServerFixture;
  });
