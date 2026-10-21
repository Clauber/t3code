// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off globalRandomInEffect:off
/**
 * Four disposable T3 servers against one packaged engine and one real headless browser.
 *
 * The first is the owner and hosts the browser. The second and third are granted by the owner's
 * administrator routes and enrolled through their own, then drive the browser from their own threads
 * over real HTTP. The fourth was never granted. Each server has its own environment id, secret store,
 * grant record and enrollment record; only the authenticator is a stand-in, and it asks for the scopes
 * the real routes require. Skipped only when the packaged engine is absent.
 */
import * as FS from "node:fs";
import * as NodeHttp from "node:http";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";

import {
  EnvironmentId,
  MANAGED_BROWSER_PEER_DISPATCH_PATH,
  MANAGED_BROWSER_PEER_SESSION_HEADER,
  MANAGED_BROWSER_PEER_THREAD_HEADER,
  ManagedBrowserProfileId,
  type PreviewAutomationRequest,
  type PreviewAutomationSharedTabs,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import type { ServerBrowserViewerOutput } from "../preview/ServerBrowser.ts";
import type { ServerBrowserOperationError } from "../preview/ServerBrowserPage.ts";
import { ManagedBrowserViewerError } from "./ManagedBrowserViewer.ts";
import { startServer, type ServerFixture } from "./ManagedBrowserCrossHostFixture.ts";
import {
  ENGINE_MAIN,
  binding,
  engineAvailable,
  instanceId,
  makeDataRoot,
  ownerEnvironmentId,
  previewRequest,
  profileId,
} from "./ManagedBrowserRealEngineFixture.ts";

const REAL = { timeout: 240_000 };
const GRANTS = "/api/managed-browser/grants";
const ENROLLMENTS = "/api/managed-browser/enrollments";
const PEER_TWO = EnvironmentId.make("env-peer-two");
const PEER_THREE = EnvironmentId.make("env-peer-three");
const PEER_FOUR = EnvironmentId.make("env-peer-four");
const PEER_FIVE = EnvironmentId.make("env-peer-five");

const PAGE = `<!doctype html><title>shared</title>
<h1>One browser, many environments</h1>
<button onclick="document.title='clicked'">Go</button>
<input type="file" aria-label="File" onchange="document.title='file:' + this.files[0].name + ':' + this.files[0].size">
<a href="/file" download>Get file</a>`;

interface Page {
  readonly server: NodeHttp.Server;
  readonly origin: string;
  readonly port: number;
  readonly hosts: string[];
}

/** A page origin that records the hosts it was asked for, so a test can tell who reached it. */
const servePage = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<Page>((resolve) => {
        const hosts: string[] = [];
        const server = NodeHttp.createServer((incoming, outgoing) => {
          hosts.push(incoming.headers.host ?? "");
          if (incoming.url === "/file") {
            outgoing.setHeader("Content-Type", "application/octet-stream");
            outgoing.setHeader("Content-Disposition", 'attachment; filename="hello.txt"');
            outgoing.end("hello bytes");
            return;
          }
          outgoing.setHeader("Content-Type", "text/html");
          outgoing.end(PAGE);
        });
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as { port: number }).port;
          resolve({ server, hosts, port, origin: `http://127.0.0.1:${port}` });
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

/** The engine processes this test run started, read from /proc: it only reads, it signals nothing. */
const engineChildren = () =>
  FS.readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((entry) => {
      try {
        const stat = FS.readFileSync(`/proc/${entry}/stat`, "utf8");
        const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        const command = FS.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ");
        return parent === process.pid && command.includes(ENGINE_MAIN) ? [Number(entry)] : [];
      } catch {
        return [];
      }
    });

const failureOf = <A>(exit: Exit.Exit<A, ServerBrowserOperationError>) => {
  assert.isTrue(Exit.isFailure(exit));
  const failure = Exit.isFailure(exit)
    ? (
        exit.cause.reasons.find((reason) => reason._tag === "Fail") as
          | { error?: ServerBrowserOperationError }
          | undefined
      )?.error
    : undefined;
  return { tag: failure?.tag ?? "", message: failure?.message ?? "", detail: failure?.detail };
};

const nextOutput = (
  queue: Queue.Dequeue<ServerBrowserViewerOutput>,
  predicate: (output: ServerBrowserViewerOutput) => boolean,
) =>
  Effect.gen(function* () {
    for (;;) {
      const output = yield* Queue.take(queue);
      if (predicate(output)) return output;
    }
  });

const until = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  accept: (value: A) => boolean,
  label: string,
  /** In 50 ms steps. A machine running other browsers needs a generous bound. */
  steps = 600,
) =>
  effect.pipe(
    Effect.filterOrFail(accept, () => `still waiting: ${label}`),
    Effect.retry({ times: steps, schedule: Schedule.spaced("50 millis") }),
  );

// ---------------------------------------------------------------------------
// People and agents
// ---------------------------------------------------------------------------

interface Agent {
  readonly server: ServerFixture;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly credential: string;
  readonly grantId: string;
}

/** What a tool call becomes by the time a server's preview browser receives it. */
const callOf = (
  agent: Pick<Agent, "environmentId" | "threadId" | "agentSessionId">,
  operation: PreviewAutomationRequest["operation"],
  input: unknown,
  extra: Partial<PreviewAutomationRequest> = {},
): PreviewAutomationRequest => ({
  requestId: `request-${operation}`,
  threadId: agent.threadId as never,
  agentSessionId: agent.agentSessionId,
  callerEnvironmentId: agent.environmentId,
  operation,
  input,
  timeoutMs: 20_000,
  ...extra,
});

/** The owner's administrator grants an agent, and the agent's own server is enrolled in the grant. */
const enrolled = (
  owner: ServerFixture,
  server: ServerFixture,
  environmentId: EnvironmentId,
  name: string,
  grantExtra: Record<string, unknown> = {},
  threadName?: string,
) =>
  Effect.gen(function* () {
    const threadId = threadName ?? `thread-${name}`;
    const agentSessionId = `${environmentId}\u0000provider-${name}`;
    const made = yield* owner.request("POST", GRANTS, {
      body: {
        subject: { kind: "agent", callerEnvironmentId: environmentId, threadId, agentSessionId },
        resources: [{ instanceId, profileId }],
        access: "operate",
        ttlSeconds: 3600,
        ...grantExtra,
      },
    });
    assert.equal(made.status, 201, made.text);
    const created = made.json as { grant: { id: string; expiresAt: string }; credential: string };
    const stored = yield* server.request("POST", ENROLLMENTS, {
      body: {
        id: created.grant.id,
        ownerEnvironmentId,
        endpoint: owner.origin,
        instanceId,
        profileId,
        threadId,
        agentSessionId,
        expiresAt: created.grant.expiresAt,
        credential: created.credential,
      },
    });
    assert.equal(stored.status, 201, stored.text);
    return {
      server,
      environmentId,
      threadId,
      agentSessionId,
      credential: created.credential,
      grantId: created.grant.id,
    } satisfies Agent;
  });

/** `tabId` is what the broker supplies from the agent's previous result, when it has one. */
const open = (agent: Agent, url: string, tabId?: string) =>
  agent.server.adapter
    .handle(
      callOf(
        agent,
        "open",
        { browserBinding: binding, url, open: false },
        tabId === undefined ? {} : { tabId: tabId as never },
      ),
    )
    .pipe(Effect.map((status) => status as PreviewAutomationStatus));

const onTab = (
  agent: Agent,
  tabId: string,
  operation: PreviewAutomationRequest["operation"],
  input: unknown,
) =>
  agent.server.adapter.handle(
    callOf(agent, operation, input, { tabId: tabId as never, tabIdExplicit: true }),
  );

const evaluate = (agent: Agent, tabId: string, expression: string) =>
  onTab(agent, tabId, "evaluate", { expression });

const statusOf = (agent: Agent, tabId: string) =>
  onTab(agent, tabId, "status", {}).pipe(Effect.map((status) => status as PreviewAutomationStatus));

/** An open that names a browser, with whatever else the test says: sharing, joining, a url. */
const openWith = (agent: Agent, input: Record<string, unknown>, tabId?: string) =>
  agent.server.adapter
    .handle(
      callOf(
        agent,
        "open",
        { browserBinding: binding, open: false, ...input },
        tabId === undefined ? {} : { tabId: tabId as never },
      ),
    )
    .pipe(Effect.map((status) => status as PreviewAutomationStatus));

/** Where the owner keeps a remote agent's tab: its thread, under the caller's environment. */
const ownerThread = (agent: Agent) => `remote:${agent.environmentId}:${agent.threadId}`;

/** The owner's own agent, which needs no grant. */
const localAgent = (owner: ServerFixture): Agent => ({
  server: owner,
  environmentId: ownerEnvironmentId,
  threadId: "thread-1",
  agentSessionId: `${ownerEnvironmentId}\u0000session-1`,
  credential: "",
  grantId: "",
});

const captureLogs = (logs: string[]) =>
  Logger.layer(
    [
      Logger.make(({ message }) => {
        try {
          logs.push(JSON.stringify(message));
        } catch {
          logs.push(String(message));
        }
      }),
    ],
    { mergeWithExisting: true },
  );

const everyone = (
  body: (world: {
    readonly owner: ServerFixture;
    readonly two: ServerFixture;
    readonly three: ServerFixture;
    readonly four: ServerFixture;
    readonly five: ServerFixture;
    readonly page: Page;
    readonly clock: { now: number };
    readonly logs: string[];
    readonly dataRoot: string;
  }) => Effect.Effect<void, unknown, never>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const logs: string[] = [];
      const page = yield* servePage;
      const dataRoot = yield* Effect.acquireRelease(Effect.sync(makeDataRoot), (root) =>
        Effect.sync(() => FS.rmSync(root, { recursive: true, force: true })),
      );
      const clock = { now: Date.now() };
      const now = () => clock.now;
      const owner = yield* startServer({
        environmentId: ownerEnvironmentId,
        engineDataRoot: dataRoot,
        now,
      });
      const two = yield* startServer({ environmentId: PEER_TWO, engineDataRoot: null, now });
      const three = yield* startServer({ environmentId: PEER_THREE, engineDataRoot: null, now });
      const four = yield* startServer({ environmentId: PEER_FOUR, engineDataRoot: null, now });
      const five = yield* startServer({ environmentId: PEER_FIVE, engineDataRoot: null, now });
      yield* body({ owner, two, three, four, five, page, clock, logs, dataRoot }).pipe(
        Effect.provide(captureLogs(logs)),
      );
    }),
  );

describe.skipIf(!engineAvailable)("one browser shared by four environments' agents", () => {
  it.live(
    "three granted principals see the same browser state and a fourth is refused",
    () =>
      everyone(({ owner, two, three, four, page, logs, dataRoot }) =>
        Effect.gen(function* () {
          const mine = localAgent(owner);
          const ownerTab = (yield* open(mine, `${page.origin}/`)).tabId as string;
          const token = `token-${Math.random().toString(16).slice(2)}`;
          yield* evaluate(
            mine,
            ownerTab,
            `(() => { localStorage.setItem('shared', ${JSON.stringify(token)}); return 1; })()`,
          );
          const ownerStatus = yield* statusOf(mine, ownerTab);
          assert.equal(ownerStatus.managed?.ownerEnvironmentId, ownerEnvironmentId);

          const agentTwo = yield* enrolled(owner, two, PEER_TWO, "two");
          const agentThree = yield* enrolled(owner, three, PEER_THREE, "three");

          const tabs: Array<[Agent, string]> = [];
          for (const agent of [agentTwo, agentThree]) {
            const status = yield* open(agent, `${page.origin}/`);
            const tabId = status.tabId as string;
            tabs.push([agent, tabId]);
            // The same browser: the same boot of the same instance and profile, owned by the owner...
            assert.equal(status.managed?.ownerEnvironmentId, ownerEnvironmentId);
            assert.equal(status.managed?.profileId, profileId);
            assert.equal(status.managed?.incarnation, ownerStatus.managed?.incarnation);
            // ...showing the same stored page state the owner's agent left there.
            assert.equal(yield* evaluate(agent, tabId, "localStorage.getItem('shared')"), token);
            assert.equal(yield* evaluate(agent, tabId, "document.title"), "shared");
          }
          // A write by one environment is seen by the other two, and by the owner's own agent.
          yield* evaluate(
            tabs[0]![0],
            tabs[0]![1],
            "(() => { localStorage.setItem('from-two', 'yes'); return 1; })()",
          );
          assert.equal(
            yield* evaluate(tabs[1]![0], tabs[1]![1], "localStorage.getItem('from-two')"),
            "yes",
          );
          assert.equal(yield* evaluate(mine, ownerTab, "localStorage.getItem('from-two')"), "yes");

          // A tab belongs to the thread that opened it: another granted environment, with its own valid
          // credential, is told there is no such tab.
          const crossed = yield* owner.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
            scopes: null,
            headers: {
              authorization: `Bearer ${agentThree.credential}`,
              [MANAGED_BROWSER_PEER_THREAD_HEADER]: encodeURIComponent(agentThree.threadId),
              [MANAGED_BROWSER_PEER_SESSION_HEADER]: encodeURIComponent(agentThree.agentSessionId),
            },
            body: {
              request: callOf(
                agentThree,
                "evaluate",
                { expression: "1" },
                { tabId: tabs[0]![1] as never, tabIdExplicit: true },
              ),
            },
          });
          assert.equal(
            (crossed.json as { error?: { tag: string } }).error?.tag,
            "PreviewAutomationTabNotFoundError",
          );

          // The fourth principal, an environment nobody granted anything to.
          const strangerCall = callOf(
            {
              environmentId: PEER_FOUR,
              threadId: "thread-four",
              agentSessionId: `${PEER_FOUR}\u0000p`,
            },
            "open",
            { browserBinding: binding, url: `${page.origin}/` },
          );
          // (a) It has no enrollment: nothing is sent, nothing is started.
          const unenrolled = failureOf(yield* Effect.exit(four.adapter.handle(strangerCall)));
          assert.include(unenrolled.message, "no enrollment");
          assert.equal(four.outbound.length, 0);
          // (b) It borrows another environment's credential: the owner refuses before the browser hears of it.
          const borrowed = yield* four.request("POST", ENROLLMENTS, {
            body: {
              id: agentThree.grantId,
              ownerEnvironmentId,
              endpoint: owner.origin,
              instanceId,
              profileId,
              threadId: "thread-four",
              agentSessionId: `${PEER_FOUR}\u0000p`,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              credential: agentThree.credential,
            },
          });
          assert.equal(borrowed.status, 201);
          const refused = failureOf(yield* Effect.exit(four.adapter.handle(strangerCall)));
          assert.include(refused.message, "refused this server's grant");
          assert.equal(four.outbound.at(-1)?.status, 403);
          // (c) The same borrowed credential straight at the owner, with the borrower's own claims.
          const direct = yield* owner.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
            scopes: null,
            headers: {
              authorization: `Bearer ${agentThree.credential}`,
              [MANAGED_BROWSER_PEER_THREAD_HEADER]: encodeURIComponent("thread-four"),
              [MANAGED_BROWSER_PEER_SESSION_HEADER]: encodeURIComponent(`${PEER_FOUR}\u0000p`),
            },
            body: { request: strangerCall },
          });
          assert.equal(direct.status, 403);
          // (d) The granted environment's own credential for another browser profile.
          const otherProfile = yield* owner.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
            scopes: null,
            headers: {
              authorization: `Bearer ${agentTwo.credential}`,
              [MANAGED_BROWSER_PEER_THREAD_HEADER]: encodeURIComponent(agentTwo.threadId),
              [MANAGED_BROWSER_PEER_SESSION_HEADER]: encodeURIComponent(agentTwo.agentSessionId),
            },
            body: {
              request: callOf(agentTwo, "open", {
                browserBinding: { ...binding, profileId: "profile-someone-elses" },
              }),
            },
          });
          assert.equal(otherProfile.status, 403);
          // Nothing for the fourth was ever created in the owner's record of tabs; the other two are
          // there under the owner's own names for their threads.
          const recorded = (
            JSON.parse(
              FS.readFileSync(Path.join(dataRoot, "adapter", "registry.json"), "utf8"),
            ) as {
              tabs: ReadonlyArray<{ threadId: string }>;
            }
          ).tabs.map((tab) => tab.threadId);
          assert.sameMembers(recorded, [
            "thread-1",
            "remote:env-peer-two:thread-two",
            "remote:env-peer-three:thread-three",
          ]);

          // Those three principals did not spawn another browser, and nothing leaked a credential.
          assert.equal(engineChildren().length, 1);
          const everything =
            logs.join("\n") + JSON.stringify([two.outbound, three.outbound, four.outbound]);
          for (const secret of [agentTwo.credential, agentThree.credential]) {
            assert.notInclude(everything, secret);
            assert.notInclude(everything, secret.split(".")[2]!);
          }
        }),
      ),
    REAL,
  );

  it.live(
    "viewers see the same tab only when a grant names their session",
    () =>
      everyone(({ owner, page }) =>
        Effect.gen(function* () {
          const mine = localAgent(owner);
          const ownerTab = (yield* open(mine, `${page.origin}/`)).tabId as string;
          const attach = (sessionId: string, administrator: boolean, canOperate = false) =>
            owner.adapter.attachViewer({
              threadId: "thread-1",
              tabId: ownerTab,
              maxWidth: 640,
              maxHeight: 400,
              canOperate,
              viewer: { sessionId, administrator },
            });
          const grantViewer = (sessionId: string, access: "read" | "operate") =>
            owner
              .request("POST", GRANTS, {
                body: {
                  subject: { kind: "viewer", viewerSessionId: sessionId },
                  resources: [{ instanceId, profileId }],
                  access,
                  ttlSeconds: 3600,
                },
              })
              .pipe(
                Effect.map((response) => (response.json as { grant: { id: string } }).grant.id),
              );

          // A signed-in session with no grant is told the tab does not exist.
          const ungranted = yield* attach("session-nobody", false).pipe(Effect.scoped, Effect.exit);
          assert.isTrue(Exit.isFailure(ungranted));
          const error = Exit.isFailure(ungranted)
            ? (
                ungranted.cause.reasons.find((reason) => reason._tag === "Fail") as {
                  error?: ManagedBrowserViewerError;
                }
              )?.error
            : undefined;
          assert.equal(error?.reason, "notFound");
          // No stream means no download either.
          assert.isTrue(
            (yield* owner.adapter.openDownload("thread-1", ownerTab, "anything", {
              sessionId: "session-nobody",
              administrator: false,
            }))._tag === "None",
          );

          const phoneGrant = yield* grantViewer("session-phone", "read");
          const macGrant = yield* grantViewer("session-mac", "operate");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const phone = yield* attach("session-phone", false, true);
              const mac = yield* attach("session-mac", false, true);
              const admin = yield* attach("session-admin", true, true);
              // A viewer drains its stream as the route does; a message is never left to be dropped
              // from a queue nobody is reading.
              const watch = (viewer: typeof phone) =>
                Effect.gen(function* () {
                  const seen: Array<ServerBrowserViewerOutput> = [];
                  yield* Queue.take(viewer.output).pipe(
                    Effect.tap((output) => Effect.sync(() => void seen.push(output))),
                    Effect.forever,
                    Effect.forkScoped,
                  );
                  const lastControl = () =>
                    seen.findLast((output) => output._tag === "control") as
                      | { canOperate: boolean; controller: string }
                      | undefined;
                  const has = (accept: (output: ServerBrowserViewerOutput) => boolean) =>
                    seen.some(accept);
                  const waitFor = (
                    accept: (output: ServerBrowserViewerOutput) => boolean,
                    label: string,
                  ) =>
                    until(
                      Effect.sync(() => has(accept)),
                      Boolean,
                      label,
                    );
                  return { seen, lastControl, waitFor, viewer };
                });
              const phoneWatch = yield* watch(phone);
              const macWatch = yield* watch(mac);
              const adminWatch = yield* watch(admin);
              // All three are shown the same tab: a frame and the control state for it.
              for (const watching of [phoneWatch, macWatch, adminWatch]) {
                yield* watching.waitFor((output) => output._tag === "frame", "a frame");
                yield* watching.waitFor((output) => output._tag === "control", "the control state");
              }
              // ...but a read grant cannot drive it even when the client's scope says it may.
              assert.equal(phoneWatch.lastControl()?.canOperate, false);
              assert.equal(macWatch.lastControl()?.canOperate, true);

              yield* phone.input({ type: "takeControl" });
              yield* mac.input({ type: "takeControl" });
              yield* macWatch.waitFor(
                (output) => output._tag === "control" && output.controller === "you",
                "the Mac to hold control",
              );
              // Revoking the phone's grant ends its stream; the Mac's goes on.
              yield* owner.request("DELETE", `${GRANTS}/${phoneGrant}`);
              yield* phoneWatch.waitFor(
                (output) => output._tag === "gone",
                "the phone's stream to end",
              );
              assert.isFalse(macWatch.seen.some((output) => output._tag === "gone"));
              yield* mac.input({ type: "mouse", action: "move", x: 5, y: 5, button: "left" });
              // Revoking the Mac's grant ends its stream too, and its input no longer acts.
              yield* owner.request("DELETE", `${GRANTS}/${macGrant}`);
              yield* macWatch.waitFor(
                (output) => output._tag === "gone",
                "the Mac's stream to end",
              );
              // The administrator, who needs no grant, is unaffected by either.
              assert.isFalse(adminWatch.seen.some((output) => output._tag === "gone"));
            }),
          );
          // And a revoked grant admits no new stream.
          const afterwards = yield* attach("session-phone", false).pipe(Effect.scoped, Effect.exit);
          assert.isTrue(Exit.isFailure(afterwards));
        }),
      ),
    REAL,
  );

  it.live(
    "revocation, expiry, read-only grants and a person's control all reach a remote agent's next call",
    () =>
      everyone(({ owner, two, three, page }) =>
        Effect.gen(function* () {
          const agentTwo = yield* enrolled(owner, two, PEER_TWO, "two", { ttlSeconds: 600 });
          const reader = yield* enrolled(owner, three, PEER_THREE, "three", { access: "read" });
          const tabTwo = (yield* open(agentTwo, `${page.origin}/`)).tabId as string;
          yield* onTab(agentTwo, tabTwo, "click", { locator: "role=button[name='Go']" });
          assert.equal(yield* evaluate(agentTwo, tabTwo, "document.title"), "clicked");

          // An address that is not a URL is a named failure of the call, not a fault in the owner.
          const invalid = failureOf(yield* Effect.exit(open(agentTwo, "not a url")));
          assert.equal(invalid.tag, "PreviewAutomationExecutionError");
          assert.include(invalid.message, "not a valid URL");

          // A read grant can look, and cannot open, drive or run script.
          const opened = failureOf(yield* Effect.exit(open(reader, `${page.origin}/`)));
          assert.include(opened.message, "no live grant");
          assert.equal(three.outbound.at(-1)?.status, 200);

          // A person takes control on the owner; the remote agent is told, as a local one would be.
          const mine = localAgent(owner);
          const ownerTab = (yield* open(mine, `${page.origin}/`)).tabId as string;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const watcher = yield* owner.adapter.attachViewer({
                threadId: "thread-1",
                tabId: ownerTab,
                maxWidth: 640,
                maxHeight: 400,
                canOperate: true,
                viewer: { sessionId: "session-admin", administrator: true },
              });
              yield* watcher.input({ type: "takeControl" });
              yield* nextOutput(
                watcher.output,
                (output) => output._tag === "control" && output.controller === "you",
              );
              const held = failureOf(
                yield* Effect.exit(onTab(agentTwo, tabTwo, "evaluate", { expression: "1" })),
              );
              assert.equal(held.tag, "PreviewAutomationControlInterruptedError");
              yield* watcher.input({ type: "releaseControl" });
              yield* nextOutput(
                watcher.output,
                (output) => output._tag === "control" && output.controller === "agent",
              );
            }),
          );
          assert.equal(yield* evaluate(agentTwo, tabTwo, "1 + 1"), 2);

          // The owner is unreachable: a named failure, and no second browser anywhere.
          const before = engineChildren();
          yield* owner.stopListening;
          const outage = failureOf(
            yield* Effect.exit(onTab(agentTwo, tabTwo, "evaluate", { expression: "1" })),
          );
          assert.include(outage.message, "could not be reached");
          assert.include(outage.message, "No browser was started here");
          assert.deepEqual(engineChildren(), before);
          // The browser itself is untouched by its listener going away.
          assert.equal(yield* evaluate(mine, ownerTab, "2 + 2"), 4);
        }),
      ),
    REAL,
  );

  it.live(
    "a person holding control with no stream open stops remote agents; releasing lets the same tab continue, and a revoked grant still ends it",
    () =>
      everyone(({ owner, two, three, page }) =>
        Effect.gen(function* () {
          const agentTwo = yield* enrolled(owner, two, PEER_TWO, "two", { ttlSeconds: 600 });
          const agentThree = yield* enrolled(owner, three, PEER_THREE, "three", {
            ttlSeconds: 600,
          });
          const tabTwo = (yield* open(agentTwo, `${page.origin}/`)).tabId as string;
          const tabThree = (yield* open(agentThree, `${page.origin}/`)).tabId as string;
          const mine = localAgent(owner);
          const ownerTab = (yield* open(mine, `${page.origin}/`)).tabId as string;
          const hold = (action: "take" | "release") =>
            owner.local.setControl({
              threadId: "thread-1",
              tabId: ownerTab,
              sessionId: "session-admin",
              action,
            });

          // The owner's person works in the browser's own window: no viewer is attached anywhere.
          assert.isTrue(yield* hold("take"));
          for (const [agent, tab] of [
            [agentTwo, tabTwo],
            [agentThree, tabThree],
          ] as const) {
            const held = failureOf(
              yield* Effect.exit(onTab(agent, tab, "evaluate", { expression: "1" })),
            );
            assert.equal(held.tag, "PreviewAutomationControlInterruptedError");
          }
          const ownerHeld = failureOf(
            yield* Effect.exit(onTab(mine, ownerTab, "evaluate", { expression: "1" })),
          );
          assert.equal(ownerHeld.tag, "PreviewAutomationControlInterruptedError");

          // Release: the same remote agents act on the same tabs, with no new grant or enrollment.
          assert.isTrue(yield* hold("release"));
          assert.equal(yield* evaluate(agentTwo, tabTwo, "1 + 1"), 2);
          assert.equal(yield* evaluate(agentThree, tabThree, "2 + 2"), 4);

          // Revoking a grant still ends that agent's access immediately; the other is unaffected.
          yield* owner.request("DELETE", `${GRANTS}/${agentTwo.grantId}`);
          const revoked = failureOf(
            yield* Effect.exit(onTab(agentTwo, tabTwo, "evaluate", { expression: "1" })),
          );
          assert.include(revoked.message, "refused this server's grant");
          assert.equal(yield* evaluate(agentThree, tabThree, "3 + 3"), 6);
        }),
      ),
    REAL,
  );

  it.live(
    "a revoked or expired grant stops the very next call, and the tab is still the owner's to reattach",
    () =>
      everyone(({ owner, two, page, clock, logs }) =>
        Effect.gen(function* () {
          const agentTwo = yield* enrolled(owner, two, PEER_TWO, "two", { ttlSeconds: 600 });
          const tabTwo = (yield* open(agentTwo, `${page.origin}/`)).tabId as string;
          assert.equal(yield* evaluate(agentTwo, tabTwo, "1"), 1);

          // Revoked between two calls from the same session.
          yield* owner.request("DELETE", `${GRANTS}/${agentTwo.grantId}`);
          const revoked = failureOf(
            yield* Effect.exit(onTab(agentTwo, tabTwo, "evaluate", { expression: "1" })),
          );
          assert.include(revoked.message, "refused this server's grant");
          assert.equal(two.outbound.at(-1)?.status, 401);

          // A new grant for the same thread and session picks the same tab up again.
          const again = yield* enrolled(owner, two, PEER_TWO, "two", { ttlSeconds: 600 });
          const reopened = yield* open(again, `${page.origin}/`, tabTwo);
          assert.equal(reopened.tabId, tabTwo);
          assert.equal(yield* evaluate(again, tabTwo, "2"), 2);

          // Expired between two calls: the owner's clock passes the grant's end.
          clock.now += 601_000;
          const expired = failureOf(
            yield* Effect.exit(onTab(again, tabTwo, "evaluate", { expression: "1" })),
          );
          assert.isTrue(
            expired.message.includes("expired") ||
              expired.message.includes("refused this server's grant"),
          );
          const everything = logs.join("\n");
          assert.notInclude(everything, again.credential);
          assert.notInclude(everything, agentTwo.credential);
        }),
      ),
    REAL,
  );

  it.live(
    "a grant replaced by a read-only one still lets the agent look at its tab, and no longer act",
    () =>
      everyone(({ owner, three, page }) =>
        Effect.gen(function* () {
          const operator = yield* enrolled(owner, three, PEER_THREE, "three");
          const tab = (yield* open(operator, `${page.origin}/`)).tabId as string;
          yield* owner.request("DELETE", `${GRANTS}/${operator.grantId}`);
          const reader = yield* enrolled(owner, three, PEER_THREE, "three", { access: "read" });
          assert.equal(
            (yield* statusOf(reader, tab)).managed?.ownerEnvironmentId,
            ownerEnvironmentId,
          );
          const snapshot = (yield* onTab(reader, tab, "snapshot", {})) as {
            interactiveElements: ReadonlyArray<{ name: string }>;
          };
          assert.isTrue(snapshot.interactiveElements.some((element) => element.name === "Go"));
          for (const [operation, input] of [
            ["click", { locator: "role=button[name='Go']" }],
            ["evaluate", { expression: "document.title = 'tampered'" }],
            ["navigate", { url: `${page.origin}/` }],
            ["type", { text: "hello", locator: "role=textbox" }],
            ["close", {}],
          ] as const) {
            const refused = failureOf(yield* Effect.exit(onTab(reader, tab, operation, input)));
            assert.include(refused.message, "no live grant", operation);
          }
          // Nothing the reader tried reached the page.
          const writer = yield* enrolled(owner, three, PEER_THREE, "three");
          assert.equal(yield* evaluate(writer, tab, "document.title"), "shared");
        }),
      ),
    REAL,
  );

  it.live(
    "the same thread name in two environments is two different threads on the owner",
    () =>
      everyone(({ owner, two, page, dataRoot }) =>
        Effect.gen(function* () {
          const mine = localAgent(owner);
          const ownerTab = (yield* open(mine, `${page.origin}/`)).tabId as string;
          // The peer's thread is called exactly what the owner's own is.
          const peer = yield* enrolled(owner, two, PEER_TWO, "two", {}, mine.threadId);
          const peerTab = (yield* open(peer, `${page.origin}/`)).tabId as string;
          assert.notEqual(peerTab, ownerTab);
          yield* evaluate(peer, peerTab, "(() => { window.name = 'peers'; return 1; })()");
          assert.equal(yield* evaluate(mine, ownerTab, "window.name"), "");
          assert.equal(yield* evaluate(peer, peerTab, "window.name"), "peers");
          // The peer cannot name the owner's own tab, and its status is of its own tab.
          const reach = yield* owner.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
            scopes: null,
            headers: {
              authorization: `Bearer ${peer.credential}`,
              [MANAGED_BROWSER_PEER_THREAD_HEADER]: encodeURIComponent(peer.threadId),
              [MANAGED_BROWSER_PEER_SESSION_HEADER]: encodeURIComponent(peer.agentSessionId),
            },
            body: {
              request: callOf(
                peer,
                "evaluate",
                { expression: "window.name" },
                { tabId: ownerTab as never, tabIdExplicit: true },
              ),
            },
          });
          assert.equal(
            (reach.json as { error?: { tag: string } }).error?.tag,
            "PreviewAutomationTabNotFoundError",
          );
          const recorded = (
            JSON.parse(
              FS.readFileSync(Path.join(dataRoot, "adapter", "registry.json"), "utf8"),
            ) as {
              tabs: ReadonlyArray<{ threadId: string; callerEnvironmentId: string }>;
            }
          ).tabs;
          assert.sameDeepMembers(
            recorded.map((tab) => [tab.threadId, tab.callerEnvironmentId]),
            [
              ["thread-1", ownerEnvironmentId],
              ["remote:env-peer-two:thread-1", PEER_TWO],
            ],
          );
        }),
      ),
    REAL,
  );

  it.live(
    "files cross as bytes and an address the owner can reach is the owner's",
    () =>
      everyone(({ owner, two, page, dataRoot }) =>
        Effect.gen(function* () {
          const agentTwo = yield* enrolled(owner, two, PEER_TWO, "two");
          // `localhost` is spelled by the caller and resolved by the owner's browser.
          const tab = (yield* open(agentTwo, `http://localhost:${page.port}/`)).tabId as string;
          assert.include(page.hosts, `localhost:${page.port}`);
          assert.isTrue(
            two.outbound.every((call) => call.url.startsWith(owner.origin)),
            "this server only ever spoke to the owner",
          );

          // Upload: the file is on this server's disk, and reaches the page as bytes.
          const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "caller-upload-"));
          const file = Path.join(directory, "notes.txt");
          FS.writeFileSync(file, "caller bytes 1234");
          const snapshot = (yield* onTab(agentTwo, tab, "snapshot", {})) as {
            interactiveElements: ReadonlyArray<{ name: string; selector: string }>;
          };
          const input = snapshot.interactiveElements.find((element) => element.name === "File")!;
          yield* onTab(agentTwo, tab, "upload", { locator: input.selector, paths: [file] });
          assert.equal(
            yield* evaluate(
              agentTwo,
              tab,
              "(() => { const f = document.querySelector('input[type=file]').files[0]; return f.name + ':' + f.size; })()",
            ),
            "notes.txt:17",
          );
          const transfers = Path.join(owner.root, "peer-transfers");
          const waiting = FS.existsSync(transfers)
            ? FS.readdirSync(transfers).flatMap((grant) =>
                FS.readdirSync(Path.join(transfers, grant)),
              )
            : [];
          assert.deepEqual(waiting, [], "the owner's copy is gone once the browser took it");
          // A path on the owner cannot be named from here at all.
          const direct = yield* owner.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
            scopes: null,
            headers: {
              authorization: `Bearer ${agentTwo.credential}`,
              [MANAGED_BROWSER_PEER_THREAD_HEADER]: encodeURIComponent(agentTwo.threadId),
              [MANAGED_BROWSER_PEER_SESSION_HEADER]: encodeURIComponent(agentTwo.agentSessionId),
            },
            body: {
              request: callOf(
                agentTwo,
                "upload",
                { locator: input.selector, paths: [file] },
                { tabId: tab as never },
              ),
            },
          });
          assert.equal((direct.json as { ok: boolean }).ok, false);

          // Download: the page saves a file on the owner; this server gets the bytes.
          yield* onTab(agentTwo, tab, "click", { locator: "text=Get file" });
          const status = yield* until(
            statusOf(agentTwo, tab),
            (current) => (current.downloads?.length ?? 0) === 1,
            "the download to arrive",
          );
          const saved = status.downloads![0]!;
          assert.equal(saved.fileName, "hello.txt");
          assert.equal(FS.readFileSync(saved.path, "utf8"), "hello bytes");
          assert.include(saved.path, Path.join(two.root, "remote-downloads"));
          assert.notInclude(saved.path, dataRoot);
          assert.notInclude(saved.path, owner.root);
          FS.rmSync(directory, { recursive: true, force: true });
        }),
      ),
    REAL,
  );

  it.live(
    "granted principals that opt in attach the very same tab; a human takeover, a read grant, a fourth stranger and a revocation each act on the right ones",
    () =>
      everyone(({ owner, two, three, four, five, page, dataRoot }) =>
        Effect.gen(function* () {
          const first = yield* enrolled(owner, two, PEER_TWO, "two");
          const second = yield* enrolled(owner, three, PEER_THREE, "three");
          const reader = yield* enrolled(owner, five, PEER_FIVE, "five", { access: "read" });

          // One principal opens a tab. Its id alone admits nobody: not even a granted principal.
          const created = yield* openWith(first, { url: `${page.origin}/` });
          const engineTabId = created.managed!.engineTabId!;
          const incarnation = created.managed!.incarnation;
          assert.equal(created.managed?.shared, false);
          const join = { engineTabId, incarnation };
          const early = failureOf(yield* Effect.exit(openWith(second, { joinTab: join })));
          assert.equal(early.tag, "PreviewAutomationTabNotFoundError");
          // An id that names nothing gives the same answer as one nobody shared.
          const unknown = failureOf(
            yield* Effect.exit(openWith(second, { joinTab: { engineTabId: "tab_nothing" } })),
          );
          assert.equal(unknown.message, early.message);

          // Sharing is explicit, and is a property of the page: the opener turns it on for this tab.
          const shared = yield* openWith(first, { shareTab: true }, created.tabId as string);
          assert.equal(shared.tabId, created.tabId);
          assert.equal(shared.managed?.shared, true);

          const joinedTwo = yield* openWith(second, { joinTab: join });
          const joinedReader = yield* openWith(reader, { joinTab: join });
          // The same page of the same boot for all three; the preview sessions stay each thread's own.
          for (const status of [shared, joinedTwo, joinedReader]) {
            assert.equal(status.managed?.engineTabId, engineTabId);
            assert.equal(status.managed?.incarnation, incarnation);
            assert.equal(status.managed?.ownerEnvironmentId, ownerEnvironmentId);
          }
          assert.equal(new Set([shared.tabId, joinedTwo.tabId, joinedReader.tabId]).size, 3);
          assert.equal((yield* statusOf(first, shared.tabId as string)).managed?.participants, 3);
          assert.equal(engineChildren().length, 1);

          // One changes the DOM; the others observe it in that same tab.
          const token = `dom-${Math.random().toString(16).slice(2)}`;
          yield* evaluate(
            first,
            shared.tabId as string,
            `(() => { const p = document.createElement('p'); p.textContent = ${JSON.stringify(token)}; document.body.append(p); return 1; })()`,
          );
          assert.equal(
            yield* evaluate(
              second,
              joinedTwo.tabId as string,
              `document.body.innerText.includes(${JSON.stringify(token)})`,
            ),
            true,
          );
          const looked = (yield* onTab(reader, joinedReader.tabId as string, "snapshot", {})) as {
            visibleText: string;
          };
          assert.include(looked.visibleText, token);

          // The read grant looks and cannot act; a clicking participant reaches the others' page.
          for (const [operation, input] of [
            ["click", { locator: "role=button[name='Go']" }],
            ["evaluate", { expression: "document.title = 'tampered'" }],
            ["navigate", { url: `${page.origin}/` }],
          ] as const) {
            const refused = failureOf(
              yield* Effect.exit(onTab(reader, joinedReader.tabId as string, operation, input)),
            );
            assert.include(refused.message, "no live grant", operation);
          }
          yield* onTab(second, joinedTwo.tabId as string, "click", {
            locator: "role=button[name='Go']",
          });
          assert.equal(yield* evaluate(first, shared.tabId as string, "document.title"), "clicked");

          // Navigation by one is a new page for all: no one is left acting on the old document.
          yield* onTab(first, shared.tabId as string, "navigate", { url: `${page.origin}/next` });
          assert.equal(
            yield* evaluate(second, joinedTwo.tabId as string, "location.pathname"),
            "/next",
          );
          const moved = (yield* onTab(reader, joinedReader.tabId as string, "snapshot", {})) as {
            visibleText: string;
          };
          assert.include(moved.visibleText, "One browser, many environments");
          assert.notInclude(moved.visibleText, token);

          // A fourth server was never granted: no enrollment, nothing sent, and the id is no help.
          const stranger = failureOf(
            yield* Effect.exit(
              four.adapter.handle(
                callOf(
                  {
                    environmentId: PEER_FOUR,
                    threadId: "thread-four",
                    agentSessionId: `${PEER_FOUR}\u0000p`,
                  },
                  "open",
                  { browserBinding: binding, joinTab: join },
                ),
              ),
            ),
          );
          assert.include(stranger.message, "no enrollment");
          assert.equal(four.outbound.length, 0);

          // One person on the owner takes the single lease; it blocks all three at once.
          const driver = yield* Effect.scoped(
            Effect.gen(function* () {
              const watcher = yield* owner.adapter.attachViewer({
                threadId: ownerThread(first),
                tabId: shared.tabId as string,
                maxWidth: 640,
                maxHeight: 400,
                canOperate: true,
                viewer: { sessionId: "session-admin", administrator: true },
              });
              yield* watcher.input({ type: "takeControl" });
              yield* nextOutput(
                watcher.output,
                (output) => output._tag === "control" && output.controller === "you",
              );
              const blocked: string[] = [];
              for (const [agent, tab] of [
                [first, shared.tabId],
                [second, joinedTwo.tabId],
              ] as const) {
                blocked.push(
                  failureOf(yield* Effect.exit(evaluate(agent, tab as string, "1"))).tag,
                );
              }
              blocked.push(
                failureOf(
                  yield* Effect.exit(onTab(reader, joinedReader.tabId as string, "snapshot", {})),
                ).tag,
              );
              assert.deepEqual(blocked, Array(3).fill("PreviewAutomationControlInterruptedError"));
              for (const [agent, tab] of [
                [first, shared.tabId],
                [second, joinedTwo.tabId],
                [reader, joinedReader.tabId],
              ] as const) {
                assert.equal((yield* statusOf(agent, tab as string)).managed?.phase, "human");
              }
              yield* watcher.input({ type: "releaseControl" });
              yield* nextOutput(
                watcher.output,
                (output) => output._tag === "control" && output.controller === "agent",
              );
              return true;
            }),
          );
          assert.isTrue(driver);
          assert.equal(
            yield* evaluate(second, joinedTwo.tabId as string, "document.title"),
            "shared",
          );

          // A viewer holding only a read grant is shown the tab and cannot drive it.
          const viewerGrant = (sessionId: string, access: "read" | "operate") =>
            owner
              .request("POST", GRANTS, {
                body: {
                  subject: { kind: "viewer", viewerSessionId: sessionId },
                  resources: [{ instanceId, profileId }],
                  access,
                  ttlSeconds: 3600,
                },
              })
              .pipe(
                Effect.map((response) => (response.json as { grant: { id: string } }).grant.id),
              );
          const phoneGrant = yield* viewerGrant("session-phone", "read");
          yield* viewerGrant("session-mac", "operate");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const attach = (sessionId: string, agent: Agent, tabId: string) =>
                owner.adapter.attachViewer({
                  threadId: ownerThread(agent),
                  tabId,
                  maxWidth: 640,
                  maxHeight: 400,
                  canOperate: true,
                  viewer: { sessionId, administrator: false },
                });
              const phone = yield* attach("session-phone", second, joinedTwo.tabId as string);
              const mac = yield* attach("session-mac", first, shared.tabId as string);
              const phoneSeen: Array<ServerBrowserViewerOutput> = [];
              const macSeen: Array<ServerBrowserViewerOutput> = [];
              for (const [viewer, seen] of [
                [phone, phoneSeen],
                [mac, macSeen],
              ] as const) {
                yield* Queue.take(viewer.output).pipe(
                  Effect.tap((output) => Effect.sync(() => void seen.push(output))),
                  Effect.forever,
                  Effect.forkScoped,
                );
              }
              yield* until(
                Effect.sync(() => phoneSeen.some((output) => output._tag === "control")),
                Boolean,
                "the phone's control state",
              );
              assert.equal(
                (
                  phoneSeen.findLast((output) => output._tag === "control") as {
                    canOperate: boolean;
                  }
                ).canOperate,
                false,
              );
              yield* phone.input({ type: "takeControl" });
              yield* Effect.sleep("400 millis");
              assert.equal(
                (yield* statusOf(first, shared.tabId as string)).managed?.phase,
                "agent",
              );
              yield* until(
                Effect.sync(() => macSeen.some((output) => output._tag === "frame")),
                Boolean,
                "the Mac to be shown the tab",
              );

              // Revoking a viewer's grant ends that stream only.
              yield* owner.request("DELETE", `${GRANTS}/${phoneGrant}`);
              yield* until(
                Effect.sync(() => phoneSeen.some((output) => output._tag === "gone")),
                Boolean,
                "the phone's stream to end",
              );
              assert.isFalse(macSeen.some((output) => output._tag === "gone"));
            }),
          );

          // Revoking one participant's grant stops that participant at its next call and no one else.
          yield* owner.request("DELETE", `${GRANTS}/${second.grantId}`);
          const revoked = failureOf(
            yield* Effect.exit(evaluate(second, joinedTwo.tabId as string, "1")),
          );
          assert.include(revoked.message, "refused this server's grant");
          assert.equal(yield* evaluate(first, shared.tabId as string, "document.title"), "shared");
          const afterRevoke = (yield* onTab(
            reader,
            joinedReader.tabId as string,
            "snapshot",
            {},
          )) as {
            visibleText: string;
          };
          assert.include(afterRevoke.visibleText, "One browser, many environments");

          // Leaving is not closing. The read-only participant lets go; the page and the others stay.
          yield* onTab(reader, joinedReader.tabId as string, "close", {});
          assert.equal(yield* evaluate(first, shared.tabId as string, "document.title"), "shared");
          // The reader's session is gone from its own server; the owner counts the creator and the revoked holder.
          assert.isFalse(
            reader.server.adapter.claims(
              callOf(reader, "status", {}, { tabId: joinedReader.tabId as never }),
            ),
          );
          assert.equal((yield* statusOf(first, shared.tabId as string)).managed?.participants, 2);
          // The creator is the last live holder (the revoked one no longer counts): closing ends the page.
          yield* onTab(first, shared.tabId as string, "close", {});
          const records = (
            JSON.parse(
              FS.readFileSync(Path.join(dataRoot, "adapter", "registry.json"), "utf8"),
            ) as { tabs: ReadonlyArray<{ engineTabId: string }> }
          ).tabs.filter((tab) => tab.engineTabId === engineTabId);
          assert.deepEqual(records, [], "no thread keeps a record of the closed page");
          assert.equal(engineChildren().length, 1);
        }),
      ),
    REAL,
  );

  it.live(
    "a caller that restarts reattaches the same remote tab, and says so plainly when the tab or the owner is gone",
    () =>
      everyone(({ owner, two, page, dataRoot }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* enrolled(owner, two, PEER_TWO, "two");
            const created = yield* openWith(first, { url: `${page.origin}/`, shareTab: true });
            const engineTabId = created.managed!.engineTabId!;
            const tabId = created.tabId as string;
            yield* evaluate(
              first,
              tabId,
              "(() => { window.name = 'before-restart'; return 1; })()",
            );

            // What this server remembers is a pointer: no credential, readable by its owner only.
            const recordFile = Path.join(two.root, "remote-tabs.json");
            const text = FS.readFileSync(recordFile, "utf8");
            assert.include(text, engineTabId);
            assert.notInclude(text, first.credential);
            assert.equal(FS.statSync(recordFile).mode & 0o777, 0o600);

            // The caller restarts: same files, a new process, nothing in memory.
            const restarted = yield* startServer({
              environmentId: PEER_TWO,
              engineDataRoot: null,
              resumeRoot: two.root,
            });
            const again: Agent = { ...first, server: restarted };
            // Its preview list already shows the tab and where it really lives, for a client to go there.
            const listed = yield* restarted.manager.list({ threadId: first.threadId as never });
            assert.equal(listed.sessions.length, 1);
            const described = listed.sessions[0]!.managed!;
            assert.equal(described.engineTabId, engineTabId);
            assert.equal(described.remote, true);
            assert.equal(described.ownerEnvironmentId, ownerEnvironmentId);
            assert.equal(described.hostThreadId, ownerThread(first));
            assert.equal(described.hostTabId, tabId);
            assert.equal(described.incarnation, created.managed!.incarnation);
            assert.equal(described.shared, true);
            // The page's session here is not a page: the ordinary browser built nothing for it.
            assert.isTrue(restarted.adapter.owns(first.threadId, listed.sessions[0]!.tabId));

            // A call that still holds the owner's tab id goes straight on.
            assert.equal(yield* evaluate(again, tabId, "window.name"), "before-restart");
            // An open that remembers nothing finds the tab it held, instead of starting another.
            const reopened = yield* openWith(again, {});
            assert.equal(reopened.tabId, tabId);
            assert.equal(reopened.managed?.engineTabId, engineTabId);
            assert.equal(reopened.managed?.participants, 1);
            assert.equal(yield* evaluate(again, tabId, "window.name"), "before-restart");
            const owned = (
              JSON.parse(
                FS.readFileSync(Path.join(dataRoot, "adapter", "registry.json"), "utf8"),
              ) as { tabs: ReadonlyArray<{ engineTabId: string }> }
            ).tabs;
            assert.equal(owned.length, 1, "the owner never opened a second tab");
            assert.equal(engineChildren().length, 1);

            // A pointer to another boot is stale, by name, and does not attach.
            const stale = failureOf(
              yield* Effect.exit(
                openWith(again, { joinTab: { engineTabId, incarnation: "mbi_an_older_boot" } }),
              ),
            );
            assert.include(stale.message, "stale");

            // The owner is away: the call says so, and no browser is started here in its place.
            yield* owner.stopListening;
            const away = failureOf(yield* Effect.exit(openWith(again, {})));
            assert.include(away.message, "could not be reached");
            assert.include(away.message, "No browser was started here");
            assert.equal(engineChildren().length, 1);
          }),
        ),
      ),
    REAL,
  );

  it.live(
    "a remote tab that was closed on the owner is reported gone once, then a fresh open starts a new one",
    () =>
      everyone(({ owner, two, page }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* enrolled(owner, two, PEER_TWO, "two");
            const created = yield* openWith(first, { url: `${page.origin}/` });
            // A person on the owner closes the thread's session there.
            const closed = yield* owner.adapter.sessionClosed(
              ownerThread(first),
              created.tabId as string,
            );
            assert.equal(closed._tag, "closed");
            const restarted = yield* startServer({
              environmentId: PEER_TWO,
              engineDataRoot: null,
              resumeRoot: two.root,
            });
            const again: Agent = { ...first, server: restarted };
            const gone = failureOf(yield* Effect.exit(openWith(again, {})));
            assert.equal(gone.tag, "PreviewAutomationTabNotFoundError");
            const fresh = yield* openWith(again, { url: `${page.origin}/` });
            assert.notEqual(fresh.managed?.engineTabId, created.managed?.engineTabId);
            assert.equal(engineChildren().length, 1);
          }),
        ),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("finding what is shared in another environment's browser", () => {
  it.live(
    "lists only shared tabs of the browser a read grant names, and sends nothing for a stranger",
    () =>
      everyone(({ owner, three, four, page }) =>
        Effect.gen(function* () {
          const mine = localAgent(owner);
          const shared = yield* openWith(mine, { url: `${page.origin}/`, shareTab: true });
          const kept = yield* openWith(mine, { url: `${page.origin}/`, reuseExistingTab: false });
          const reader = yield* enrolled(owner, three, PEER_THREE, "three", { access: "read" });

          const listed = (yield* reader.server.adapter.handle(
            callOf(reader, "sharedTabs", { browserBinding: binding }),
          )) as PreviewAutomationSharedTabs;
          assert.deepEqual(
            listed.tabs.map((tab) => tab.engineTabId),
            [shared.managed!.engineTabId],
          );
          assert.notInclude(JSON.stringify(listed), kept.managed!.engineTabId!);
          assert.isFalse(listed.tabs[0]!.held);

          // A browser the grant does not name is refused by the owner, whatever the caller asks.
          const elsewhere = yield* Effect.exit(
            reader.server.adapter.handle(
              callOf(reader, "sharedTabs", {
                browserBinding: { ...binding, profileId: ManagedBrowserProfileId.make("other") },
              }),
            ),
          );
          assert.isTrue(Exit.isFailure(elsewhere));

          // An environment with no enrollment sends nothing and learns nothing.
          const unenrolled = failureOf(
            yield* Effect.exit(
              four.adapter.handle(
                callOf(
                  {
                    environmentId: PEER_FOUR,
                    threadId: "thread-four",
                    agentSessionId: `${PEER_FOUR}\u0000p`,
                  },
                  "sharedTabs",
                  { browserBinding: binding },
                ),
              ),
            ),
          );
          assert.include(unenrolled.message, "no enrollment");
          assert.equal(four.outbound.length, 0);
        }),
      ),
    REAL,
  );
});
