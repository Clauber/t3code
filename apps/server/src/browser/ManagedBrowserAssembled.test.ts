// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
/**
 * The assembled preview chain with nothing standing in for the layers under test: the real MCP tool
 * handlers, the real broker, the real server browser and the real managed-browser runtime configured
 * the way a server is (an engine path and a Node runtime from the environment, a state directory in a
 * disposable home), driving the packaged engine and a real headless browser. A tool call enters at
 * `McpServer.callTool` exactly as `/mcp` hands it over; a viewer attaches through the same
 * `ServerBrowser.attachViewer` the stream route calls.
 *
 * What is not in this chain: the HTTP framing and bearer authentication of `/mcp` and of the viewer
 * socket, and the gate that a calling thread owns a live provider run. A disposable server has no
 * provider run, so the thread gate is the testkit's live-thread stand-in; everything else is the code
 * a server runs. Skipped only when the packaged engine is absent.
 */
import * as FS from "node:fs";
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as PreviewHandlers from "../mcp/toolkits/preview/handlers.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "../mcp/toolkits/preview/tools.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "../preview/DesktopBrowserChannel.ts";
import * as Manager from "../preview/Manager.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { ENGINE_MAIN, ENGINE_NODE, engineAvailable } from "./ManagedBrowserRealEngineFixture.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRuntime from "./ManagedBrowserRuntime.ts";

const REAL = { timeout: 240_000 };

const environmentId = EnvironmentId.make("environment-assembled");
const threadId = ThreadId.make("thread-assembled");
const invocation = {
  environmentId,
  requestNamespace: "provider-session-assembled",
  thread: {
    threadId,
    providerSessionId: "provider-session-assembled",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "assembled-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "assembled-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** The environment a server would be started with: where the engine is, and which Node runs it. */
const hostEnvironment = Layer.succeed(HostProcessEnvironment, {
  ...process.env,
  [ManagedBrowserRuntime.ENGINE_VARIABLE]: ENGINE_MAIN,
  T3CODE_MANAGED_BROWSER_NODE: ENGINE_NODE,
});

const dependenciesWith = (environment: Layer.Layer<never>) =>
  Layer.mergeAll(
    Broker.layer,
    Manager.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    // Ordinary previews are not under test here and never start a browser of their own.
    Layer.succeed(PreviewBrowser.PreviewBrowser, {
      executable: Effect.die("the ordinary preview browser must not start"),
      installed: Effect.die("the ordinary preview browser must not start"),
    }),
    Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
      available: false,
      awaitAttached: () => Effect.succeed(false),
      detached: Stream.empty,
      isAttached: () => Effect.succeed(false),
      endpoint: () => Effect.die("no desktop is attached"),
      pointer: () => Effect.void,
    }),
  ).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-assembled-home-" })),
    Layer.provideMerge(environment),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

// The runtime the server composes, then the browser that consumes it, then the tools over both.
/**
 * `/mcp` registers each toolkit through its access-checked handlers (`McpHttpServer.toolkitRegistration`);
 * the same registration is spelled out here because that module also loads the SSH device host, which
 * this checkout's shared node_modules cannot resolve.
 */
const previewTools = Layer.mergeAll(
  McpServer.toolkit(PreviewStandardToolkit).pipe(
    Layer.provide(McpToolAccess.HandlersLayer.layer(PreviewHandlers.layerStandard)),
  ),
  McpServer.toolkit(PreviewSnapshotToolkit).pipe(
    Layer.provide(McpToolAccess.HandlersLayer.layer(PreviewHandlers.layerSnapshot)),
  ),
);

const assembledOver = (environment: Layer.Layer<never>) =>
  previewTools.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(ServerBrowser.layer),
    Layer.provideMerge(ManagedBrowserRuntime.layer),
    Layer.provideMerge(dependenciesWith(environment)),
  );
const assembled = assembledOver(hostEnvironment);
const assembledWithoutEngine = assembledOver(
  Layer.succeed(HostProcessEnvironment, {
    ...process.env,
    [ManagedBrowserRuntime.ENGINE_VARIABLE]: "",
  }),
);

const PAGE = `<!doctype html><title>start</title>
<h1>Assembled</h1>
<input aria-label="Name" onkeydown="if(event.key==='Enter') document.title='entered:'+this.value">
<button onclick="document.title='clicked'">Go</button>`;

const serve = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly server: NodeHttp.Server; readonly origin: string }>((resolve) => {
        const server = NodeHttp.createServer((request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end(
            request.url === "/second" ? "<title>second</title><h1>Second page</h1>" : PAGE,
          );
        });
        server.listen(0, "127.0.0.1", () => {
          resolve({
            server,
            origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

/** The child processes this test run started, read from /proc: it only reads, it signals nothing. */
const childrenRunning = (needle: string) =>
  FS.readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((entry) => {
      try {
        const stat = FS.readFileSync(`/proc/${entry}/stat`, "utf8");
        const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        const command = FS.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ");
        return parent === process.pid && command.includes(needle)
          ? [{ pid: Number(entry), command }]
          : [];
      } catch {
        return [];
      }
    });

describe.skipIf(!engineAvailable)("the assembled preview chain over the packaged engine", () => {
  it.live(
    "opens a named managed session through the MCP tools and drives it, with a viewer taking control",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const server = yield* McpServer.McpServer;
          const browser = yield* ServerBrowser.ServerBrowser;
          // The server browser connects its host to the broker as it starts.
          yield* Effect.yieldNow;

          const tool = (name: string, args: Record<string, unknown>) =>
            server.callTool({ name, arguments: args }).pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
              Effect.map((result) => {
                const structured = result.structuredContent as Record<string, unknown> | undefined;
                assert.isNotTrue(
                  result.isError === true,
                  `${name} failed: ${JSON.stringify(result.content)}`,
                );
                return structured ?? {};
              }),
            );
          const toolFailure = (name: string, args: Record<string, unknown>) =>
            server.callTool({ name, arguments: args }).pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
              Effect.map((result) => {
                assert.isTrue(result.isError === true, `${name} should have failed`);
                return JSON.stringify(result.content);
              }),
            );
          const title = () =>
            tool("preview_evaluate", { expression: "document.title" }).pipe(
              Effect.map((result) => JSON.stringify(result)),
            );

          // preview_open with a browserBinding: a named session in a managed persistent profile.
          const opened = yield* tool("preview_open", {
            browserBinding: {
              ownerEnvironmentId: environmentId,
              instanceId: "instance-assembled",
              profileId: "profile-assembled",
            },
            url: origin,
            open: false,
          });
          const tabId = opened.tabId as string;
          const managed = opened.managed as Record<string, unknown>;
          assert.equal(opened.url, `${origin}/`);
          assert.equal(managed.instanceId, "instance-assembled");
          assert.equal(managed.profileId, "profile-assembled");
          assert.equal(managed.ownerEnvironmentId, environmentId);
          assert.equal(managed.phase, "agent");

          // The browser running is the installed package's Node on the package's engine entrypoint.
          const running = childrenRunning("versions/2.0.0/dist/managed/main.js");
          assert.equal(running.length, 1, "exactly one engine child");
          assert.include(running[0]!.command, "installed with spaces/versions/2.0.0/bin/node");

          // Navigate and snapshot, then act on the page by role without a prior ref.
          const navigated = yield* tool("preview_navigate", { url: `${origin}/second` });
          assert.equal(navigated.url, `${origin}/second`);
          const snapshot = yield* tool("preview_snapshot", { includeImage: false });
          assert.include(JSON.stringify(snapshot), "Second page");
          yield* tool("preview_navigate", { url: origin });
          yield* tool("preview_click", { locator: "role=button[name='Go']" });
          assert.include(yield* title(), "clicked");

          // preview_press and untargeted typing reach the focused element.
          yield* tool("preview_click", { locator: "role=textbox[name='Name']" });
          yield* tool("preview_type", { text: "abc" });
          yield* tool("preview_press", { key: "Enter" });
          assert.include(yield* title(), "entered:abc");

          // What the engine cannot do is refused by name through the same tools.
          assert.include(
            yield* toolFailure("preview_click", { selector: "button" }),
            "does not support click",
          );

          // A viewer attaches the way the stream route does, takes control and clicks the page.
          const point = (yield* tool("preview_evaluate", {
            expression:
              "(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
          })) as Record<string, unknown>;
          const target = JSON.parse(JSON.stringify(point)) as {
            value?: { x: number; y: number };
            x?: number;
            y?: number;
          };
          const coordinates = target.value ?? { x: target.x ?? 0, y: target.y ?? 0 };
          yield* tool("preview_evaluate", {
            expression: "(() => { document.title = 'reset'; return 1; })()",
          });
          const viewer = yield* browser.attachViewer({
            threadId,
            tabId,
            maxWidth: 640,
            maxHeight: 400,
            quality: 70,
            canOperate: true,
            viewer: { sessionId: "test-administrator", administrator: true },
          });
          const frame = yield* Queue.take(viewer.output).pipe(
            Effect.repeat({ until: (output) => output._tag === "frame" }),
          );
          assert.equal(frame._tag, "frame");
          yield* viewer.input({ type: "takeControl" });
          for (;;) {
            const output = yield* Queue.take(viewer.output);
            if (output._tag === "control" && output.controller === "you") break;
          }
          // While a person holds the browser, the agent is held out by name.
          assert.include(
            yield* toolFailure("preview_evaluate", { expression: "1" }),
            "human controls",
          );
          yield* viewer.input({
            type: "mouse",
            action: "down",
            x: coordinates.x,
            y: coordinates.y,
            button: "left",
          });
          yield* viewer.input({
            type: "mouse",
            action: "up",
            x: coordinates.x,
            y: coordinates.y,
            button: "left",
          });
          yield* viewer.input({ type: "releaseControl" });
          for (;;) {
            const output = yield* Queue.take(viewer.output);
            if (output._tag === "control" && output.controller === "agent") break;
          }
          assert.include(yield* title(), "clicked");

          const status = yield* tool("preview_status", {});
          assert.equal((status.managed as Record<string, unknown>).phase, "agent");
        }).pipe(Effect.provide(assembled)),
      ),
    REAL,
  );

  it.live(
    "lists to an agent only what people shared in its browser, and lets it join that page by what was listed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const server = yield* McpServer.McpServer;
          const owner = yield* ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter;
          yield* Effect.yieldNow;

          const tool = (name: string, args: Record<string, unknown>) =>
            server.callTool({ name, arguments: args }).pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
              Effect.map((result) => {
                assert.isNotTrue(
                  result.isError === true,
                  `${name} failed: ${JSON.stringify(result.content)}`,
                );
                return (result.structuredContent ?? {}) as Record<string, any>;
              }),
            );
          const binding = (profileId: string) => ({
            ownerEnvironmentId: environmentId,
            instanceId: `instance-${profileId}`,
            profileId,
          });
          // What a person's client does through the controls service: a tab owned by their session.
          const personOpens = (profileId: string, shareTab: boolean) =>
            owner
              .handle({
                requestId: `person-${profileId}-${shareTab}`,
                threadId: ThreadId.make(`managed-browser:${profileId}`),
                agentSessionId: `${ManagedBrowserPreviewAdapter.HUMAN_SESSION_PREFIX}session-admin`,
                callerEnvironmentId: environmentId,
                operation: "open",
                input: {
                  browserBinding: binding(profileId),
                  url: origin,
                  open: false,
                  reuseExistingTab: false,
                  shareTab,
                },
                timeoutMs: 60_000,
              })
              .pipe(
                Effect.map(
                  (status) => (status as { managed: { engineTabId: string } }).managed.engineTabId,
                ),
              );

          const shared = yield* personOpens("profile-assembled", true);
          yield* personOpens("profile-assembled", false);
          const elsewhere = yield* personOpens("profile-elsewhere", true);

          const listed = yield* tool("preview_shared_tabs", {
            browserBinding: binding("profile-assembled"),
          });
          assert.deepEqual(
            listed.tabs.map((entry: { engineTabId: string }) => entry.engineTabId),
            [shared],
            "the private tab and the other profile's shared tab are not described",
          );
          assert.notInclude(JSON.stringify(listed), elsewhere);
          assert.equal(listed.tabs[0].held, false);
          assert.equal(listed.tabs[0].url, `${origin}/`);

          // What the listing gave is what joining takes.
          const joined = yield* tool("preview_open", {
            browserBinding: binding("profile-assembled"),
            joinTab: {
              engineTabId: listed.tabs[0].engineTabId,
              incarnation: listed.tabs[0].incarnation,
            },
            open: false,
          });
          assert.equal(joined.managed.engineTabId, shared);
          assert.equal(joined.managed.participants, 2);
          const again = yield* tool("preview_shared_tabs", {
            browserBinding: binding("profile-assembled"),
          });
          assert.equal(again.tabs[0].held, true);
          assert.equal(again.tabs[0].participants, 2);

          // A profile nothing was shared in lists nothing, and says nothing about the others.
          const empty = yield* tool("preview_shared_tabs", {
            browserBinding: binding("profile-none"),
          });
          assert.deepEqual(empty.tabs, []);
        }).pipe(Effect.provide(assembled)),
      ),
    REAL,
  );

  it.live(
    "refuses a named open with no managed browser configured, and opens nothing in its place",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          yield* Effect.yieldNow;
          const result = yield* server
            .callTool({
              name: "preview_open",
              arguments: {
                browserBinding: {
                  ownerEnvironmentId: environmentId,
                  instanceId: "instance-assembled",
                  profileId: "profile-assembled",
                },
                open: false,
              },
            })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
            );
          assert.isTrue(result.isError === true);
          // The agent is told this client cannot do it; nothing was opened in its place.
          assert.include(JSON.stringify(result.content), "does not support open");
          const manager = yield* Manager.PreviewManager;
          assert.equal((yield* manager.list({ threadId })).sessions.length, 0);
          assert.equal(childrenRunning("versions/2.0.0/dist/managed/main.js").length, 0);
        }).pipe(Effect.provide(assembledWithoutEngine)),
      ),
    REAL,
  );
});
