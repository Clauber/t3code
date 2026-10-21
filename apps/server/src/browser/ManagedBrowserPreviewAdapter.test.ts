// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
/**
 * The preview adapter against the real engine and a real headless browser in a disposable profile.
 * It runs the preview operations an agent calls and the viewer a person watches, and checks what is
 * refused by name. Skipped only when the engine build is absent.
 */
import * as FS from "node:fs";
import * as NodeHttp from "node:http";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import { EnvironmentId, type PreviewAutomationStatus } from "@t3tools/contracts";
import type { ServerBrowserViewerOutput } from "../preview/ServerBrowser.ts";
import type { ServerBrowserOperationError } from "../preview/ServerBrowserPage.ts";
import type * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import {
  binding,
  engineAvailable,
  ownerEnvironmentId,
  previewRequest,
  threadId,
  withRealAdapter,
} from "./ManagedBrowserRealEngineFixture.ts";

type Adapter = ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"];

const REAL = { timeout: 180_000 };

const PAGE = `<!doctype html><title>start</title>
<h1>Managed</h1>
<input aria-label="Name">
<button onclick="document.title='clicked'">Go</button>
<select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
<input type="file" aria-label="File">
<button onclick="alert('are you sure'); document.title='after dialog'">Alert</button>`;

/** Rewrites its own address as it finishes loading, the way many sites add a query after load. */
const REWRITES = `<!doctype html><title>rewrites</title><button>Go</button><script>
const delay = Number(new URLSearchParams(location.search).get("delay") ?? 0);
addEventListener("DOMContentLoaded", () =>
  setTimeout(() => history.replaceState(null, "", location.pathname + "?rewritten=1"), delay));
</script>`;

const serve = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly server: NodeHttp.Server; readonly origin: string }>((resolve) => {
        const server = NodeHttp.createServer((request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end(
            request.url === "/second"
              ? "<title>second</title><button>Next</button>"
              : request.url?.startsWith("/rewrites")
                ? REWRITES
                : PAGE,
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

const failureOf = <A>(exit: Exit.Exit<A, ServerBrowserOperationError>) => {
  assert.isTrue(Exit.isFailure(exit));
  const failure = Exit.isFailure(exit)
    ? (
        exit.cause.reasons.find((reason) => reason._tag === "Fail") as
          | { error?: ServerBrowserOperationError }
          | undefined
      )?.error
    : undefined;
  return { tag: failure?.tag, message: failure?.message ?? "", detail: failure?.detail };
};

const open = (adapter: Adapter, url?: string, extra: Record<string, unknown> = {}) =>
  adapter
    .handle(
      previewRequest("open", {
        browserBinding: binding,
        ...(url === undefined ? {} : { url }),
        open: false,
        ...extra,
      }),
    )
    .pipe(Effect.map((status) => status as PreviewAutomationStatus));

/** The request an agent's tool call becomes once the broker has routed it to this tab. */
const onTab = (
  tabId: string,
  operation: Parameters<typeof previewRequest>[0],
  input: unknown,
  extra: Record<string, unknown> = {},
) => previewRequest(operation, input, { tabId, tabIdExplicit: true, ...extra });

const refFor = (snapshot: unknown, name: string) => {
  const found = (
    snapshot as { interactiveElements: ReadonlyArray<{ name: string; selector: string }> }
  ).interactiveElements.find((element) => element.name === name);
  assert.isDefined(found, `no element named ${name} in the snapshot`);
  return found!.selector;
};

const evaluate = (adapter: Adapter, tabId: string, expression: string) =>
  adapter.handle(onTab(tabId, "evaluate", { expression }));

describe.skipIf(!engineAvailable)("the preview adapter over the real engine", () => {
  it.live(
    "opens a named session that is a preview session, owned by the adapter, in a persistent profile",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter, manager, supervisor }) =>
            Effect.gen(function* () {
              const status = yield* open(adapter, origin);
              assert.equal(status.available, true);
              assert.equal(status.url, `${origin}/`);
              assert.equal(status.managed?.ownerEnvironmentId, ownerEnvironmentId);
              assert.equal(status.managed?.instanceId, binding.instanceId);
              assert.equal(status.managed?.profileId, binding.profileId);
              assert.equal(status.managed?.phase, "agent");
              assert.equal(status.control?.owner, "agent");
              assert.equal(status.control?.ownedByCaller, true);

              const tabId = status.tabId as string;
              // A preview session viewers can list and attach, whose tab the ordinary browser skips.
              const listed = yield* manager.list({ threadId });
              assert.isTrue(
                listed.sessions.some(
                  (session) => session.tabId === tabId && session.runtime === "server",
                ),
              );
              assert.isTrue(adapter.owns(threadId, tabId));
              assert.isFalse(adapter.owns(threadId, "some-other-tab"));
              assert.equal(
                (yield* supervisor.state(yield* supervisor.ensure(binding))).phase,
                "agent",
              );
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "start");
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "navigates, snapshots, then clicks, types, selects and hovers by ref, and closes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter, manager }) =>
            Effect.gen(function* () {
              const opened = yield* open(adapter);
              const tabId = opened.tabId as string;

              const navigated = (yield* adapter.handle(
                onTab(tabId, "navigate", { url: origin, readiness: "load" }),
              )) as PreviewAutomationStatus;
              assert.equal(navigated.url, `${origin}/`);

              const snapshot = yield* adapter.handle(onTab(tabId, "snapshot", {}));
              const shot = snapshot as {
                url: string;
                visibleText: string;
                screenshot: { mimeType: string; data: string; width: number; height: number };
              };
              assert.equal(shot.url, `${origin}/`);
              assert.include(shot.visibleText, "Managed");
              assert.equal(shot.screenshot.mimeType, "image/png");
              assert.isAbove(shot.screenshot.width, 100);
              assert.isAbove(Buffer.from(shot.screenshot.data, "base64").length, 100);

              yield* adapter.handle(
                onTab(tabId, "type", { locator: refFor(snapshot, "Name"), text: "Ada" }),
              );
              yield* adapter.handle(onTab(tabId, "click", { locator: refFor(snapshot, "Go") }));
              const selected = yield* adapter.handle(
                onTab(tabId, "select", { locator: refFor(snapshot, "Size"), values: ["l"] }),
              );
              assert.deepEqual(selected, { selected: ["l"] });
              yield* adapter.handle(onTab(tabId, "hover", { locator: refFor(snapshot, "Go") }));

              assert.deepEqual(
                yield* evaluate(
                  adapter,
                  tabId,
                  "({ title: document.title, name: document.querySelector('input').value, size: document.querySelector('select').value })",
                ),
                { title: "clicked", name: "Ada", size: "l" },
              );

              yield* adapter.handle(onTab(tabId, "close", {}));
              assert.isFalse(adapter.owns(threadId, tabId));
              const listed = yield* manager.list({ threadId });
              assert.isFalse(listed.sessions.some((session) => session.tabId === tabId));
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "keeps acting on a tab whose page rewrote its address while the open or navigate was replying",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              // The rewrite races the reply; several delays make the losing order likely.
              for (const delay of [0, 0, 1, 2, 5, 10]) {
                const tabId = (yield* open(adapter, `${origin}/rewrites?delay=${delay}`))
                  .tabId as string;
                const snapshot = yield* adapter.handle(onTab(tabId, "snapshot", {}));
                assert.isDefined(refFor(snapshot, "Go"));
                yield* adapter.handle(
                  onTab(tabId, "navigate", { url: `${origin}/rewrites?delay=${delay}` }),
                );
                assert.equal(yield* evaluate(adapter, tabId, "document.title"), "rewrites");
                yield* adapter.handle(onTab(tabId, "close", {}));
              }
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "refuses a ref from before a navigation or a change of control, and a ref it never issued",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter, supervisor }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              const first = yield* adapter.handle(onTab(tabId, "snapshot", {}));
              const go = refFor(first, "Go");

              const invented = yield* adapter
                .handle(onTab(tabId, "click", { locator: "aria-ref=e9999" }))
                .pipe(Effect.exit);
              assert.equal(failureOf(invented).tag, "PreviewAutomationInvalidSelectorError");
              assert.deepEqual(failureOf(invented).detail, { staleRef: true });

              yield* adapter.handle(onTab(tabId, "navigate", { url: `${origin}/second` }));
              const afterNavigation = yield* adapter
                .handle(onTab(tabId, "click", { locator: go }))
                .pipe(Effect.exit);
              assert.deepEqual(failureOf(afterNavigation).detail, { staleRef: true });

              // A fresh snapshot is good until control changes hands.
              const second = yield* adapter.handle(onTab(tabId, "snapshot", {}));
              const heading = refFor(second, "Next");
              const ref = yield* supervisor.ensure(binding);
              const human = {
                id: "human:someone" as never,
                kind: "human" as const,
                access: "operate" as const,
              };
              yield* supervisor.takeControl(human, ref);
              yield* supervisor.releaseControl(human, ref);
              const afterHandoff = yield* adapter
                .handle(onTab(tabId, "hover", { locator: heading }))
                .pipe(Effect.exit);
              assert.deepEqual(failureOf(afterHandoff).detail, { staleRef: true });
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "refuses by name what the engine cannot do, instead of approximating it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              const snapshot = yield* adapter.handle(onTab(tabId, "snapshot", {}));
              const go = refFor(snapshot, "Go");
              const refused: ReadonlyArray<
                readonly [string, Parameters<typeof previewRequest>[0], unknown]
              > = [
                ["scroll", "scroll", { y: 100 }],
                ["waitFor", "waitFor", { text: "Managed" }],
                ["drag", "drag", { source: go, target: go }],
                ["resize", "resize", { mode: "fill" }],
                ["setColorScheme", "setColorScheme", { colorScheme: "dark" }],
                ["recordingStart", "recordingStart", {}],
                ["recordingStop", "recordingStop", {}],
                ["CSS selector click", "click", { selector: "button" }],
                ["coordinate click", "click", { x: 10, y: 10 }],
                ["a double click", "click", { locator: go, clickCount: 2 }],
                ["a regular-expression text locator", "click", { locator: "text=/Go/" }],
                [
                  "a role attribute the tree cannot answer",
                  "click",
                  { locator: "role=button[pressed=true]" },
                ],
                ["answering a file picker", "upload", { paths: ["/tmp/x"] }],
              ];
              for (const [label, operation, input] of refused) {
                const exit = yield* adapter
                  .handle(onTab(tabId, operation, input))
                  .pipe(Effect.exit);
                const failure = failureOf(exit);
                assert.equal(failure.tag, "PreviewAutomationUnsupportedClientError", label);
                assert.include(failure.message, "not supported", label);
              }
              // None of those reached the page.
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "start");
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "uploads files as data, never as a path the owner might read as its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "managed-upload-"));
          const file = Path.join(directory, "notes.txt");
          FS.writeFileSync(file, "uploaded as bytes".repeat(20_000));
          return yield* withRealAdapter({}, ({ adapter, supervisor }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              const snapshot = yield* adapter.handle(onTab(tabId, "snapshot", {}));
              yield* adapter.handle(
                onTab(tabId, "upload", { locator: refFor(snapshot, "File"), paths: [file] }),
              );
              assert.deepEqual(
                yield* evaluate(
                  adapter,
                  tabId,
                  "(() => { const f = document.querySelector('input[type=file]').files[0]; return { name: f.name, size: f.size }; })()",
                ),
                { name: "notes.txt", size: "uploaded as bytes".length * 20_000 },
              );
              // The engine kept no artifact, so a maintenance window is not left waiting on one.
              yield* adapter.handle(onTab(tabId, "close", {}));
              const token = yield* supervisor.beginMaintenance(binding.instanceId);
              yield* supervisor.endMaintenance(binding.instanceId, token);

              const relative = yield* adapter
                .handle(
                  onTab(tabId, "upload", { locator: "aria-ref=e1", paths: ["relative/path.txt"] }),
                )
                .pipe(Effect.exit);
              assert.isTrue(Exit.isFailure(relative));
            }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("who may use a named browser", () => {
  it.live(
    "refuses another environment's agent, another owner, and an unknown caller",
    () =>
      withRealAdapter({}, ({ adapter, manager }) =>
        Effect.gen(function* () {
          const elsewhere = previewRequest(
            "open",
            { browserBinding: binding },
            { callerEnvironmentId: EnvironmentId.make("env-remote") },
          );
          const remote = yield* adapter.handle(elsewhere).pipe(Effect.exit);
          assert.equal(failureOf(remote).tag, "PreviewAutomationUnsupportedClientError");
          assert.include(failureOf(remote).message, "owner environment");

          const otherOwner = yield* adapter
            .handle(
              previewRequest("open", {
                browserBinding: {
                  ...binding,
                  ownerEnvironmentId: EnvironmentId.make("env-remote"),
                },
                url: "about:blank",
              }),
            )
            .pipe(Effect.exit);
          assert.equal(failureOf(otherOwner).tag, "PreviewAutomationUnsupportedClientError");
          assert.include(failureOf(otherOwner).message, "does not own");

          const unknown = yield* adapter
            .handle(
              previewRequest(
                "open",
                { browserBinding: binding },
                { callerEnvironmentId: undefined as never },
              ),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(unknown));

          // Nothing was opened for any of them.
          assert.equal((yield* manager.list({ threadId })).sessions.length, 0);
        }),
      ),
    REAL,
  );

  it.live(
    "claims a named open and the work on a managed tab, but not a request for a new tab",
    () =>
      withRealAdapter({}, ({ adapter }) =>
        Effect.gen(function* () {
          const tabId = (yield* open(adapter)).tabId as string;
          const claims = (
            operation: Parameters<typeof previewRequest>[0],
            input: unknown,
            extra: Record<string, unknown> = {},
          ) => adapter.claims(previewRequest(operation, input, extra));

          assert.isTrue(claims("open", { browserBinding: binding }));
          assert.isTrue(claims("evaluate", {}, { tabId }));
          assert.isTrue(claims("open", {}, { tabId }));
          // The broker points an agent's current tab at its last result; asking for a new tab is the
          // ordinary browser's, and so is any tab this adapter does not hold.
          assert.isFalse(claims("open", { reuseExistingTab: false }, { tabId }));
          assert.isFalse(claims("evaluate", {}, { tabId: "an-ordinary-tab" }));
          assert.isFalse(claims("open", {}));
          assert.isFalse(claims("status", {}));
        }),
      ),
    REAL,
  );

  it.live(
    "keeps one agent session's tab and one thread's tabs from another",
    () =>
      withRealAdapter({}, ({ adapter }) =>
        Effect.gen(function* () {
          const tabId = (yield* open(adapter)).tabId as string;
          const other = yield* adapter
            .handle(
              onTab(
                tabId,
                "evaluate",
                { expression: "1" },
                {
                  agentSessionId: `${ownerEnvironmentId}\u0000session-2`,
                },
              ),
            )
            .pipe(Effect.exit);
          assert.deepEqual(failureOf(other).detail, "agentMismatch");

          const anotherThread = yield* adapter
            .handle(
              onTab(tabId, "evaluate", { expression: "1" }, { threadId: "thread-2" as never }),
            )
            .pipe(Effect.exit);
          assert.equal(failureOf(anotherThread).tag, "PreviewAutomationTabNotFoundError");
          assert.isFalse(adapter.owns("thread-2", tabId));
        }),
      ),
    REAL,
  );

  it.live(
    "sends the caller's own environment to the engine, and the owner only as the resource",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const remote = EnvironmentId.make("env-remote");
          return yield* withRealAdapter(
            { policy: { authorize: () => Effect.void } },
            ({ adapter }) =>
              Effect.gen(function* () {
                const asRemote = { callerEnvironmentId: remote };
                const status = (yield* adapter.handle(
                  previewRequest(
                    "open",
                    { browserBinding: binding, url: origin, open: false },
                    asRemote,
                  ),
                )) as PreviewAutomationStatus;
                assert.equal(status.managed?.ownerEnvironmentId, ownerEnvironmentId);
                const tabId = status.tabId as string;
                // The snapshot's screenshot is read back by artifact, which the engine scopes by the
                // caller's environment: it only works because every call carried the same identity.
                const snapshot = yield* adapter.handle(onTab(tabId, "snapshot", {}, asRemote));
                assert.include((snapshot as { visibleText: string }).visibleText, "Managed");
              }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)(
  "a page blocked on a dialog, and a browser that stops answering",
  () => {
    it.live(
      "a dialog answer does not queue behind the click that is waiting for it",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { origin } = yield* serve;
            return yield* withRealAdapter({}, ({ adapter }) =>
              Effect.gen(function* () {
                const tabId = (yield* open(adapter, origin)).tabId as string;
                const snapshot = yield* adapter.handle(onTab(tabId, "snapshot", {}));
                const alertButton = refFor(snapshot, "Alert");

                const clicking = yield* adapter
                  .handle(onTab(tabId, "click", { locator: alertButton }))
                  .pipe(Effect.forkScoped);
                // The adapter learns of the dialog from the browser's event.
                const pending = yield* adapter.handle(onTab(tabId, "status", {})).pipe(
                  Effect.map((status) => status as PreviewAutomationStatus),
                  Effect.filterOrFail(
                    (status) => status.dialog !== null && status.dialog !== undefined,
                    () => "no dialog yet",
                  ),
                  Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
                );
                assert.equal(pending.dialog?.message, "are you sure");

                // Every other operation is refused until the dialog is answered, as the ordinary browser does.
                const blocked = yield* adapter
                  .handle(onTab(tabId, "evaluate", { expression: "1" }))
                  .pipe(Effect.exit);
                assert.deepEqual(failureOf(blocked).detail, "dialogPending");

                const answered = (yield* adapter.handle(
                  onTab(tabId, "dialog", { accept: true }),
                )) as PreviewAutomationStatus;
                assert.equal(answered.dialog, null);
                yield* Fiber.join(clicking);
                assert.equal(yield* evaluate(adapter, tabId, "document.title"), "after dialog");
              }),
            );
          }),
        ),
      REAL,
    );

    it.live(
      "a browser that stops answering is reported as unavailable, and reopening reattaches the same tab and profile",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { origin } = yield* serve;
            return yield* withRealAdapter(
              { timeouts: { drainMs: 1_500, answerGraceMs: 1_000 } },
              ({ adapter }) =>
                Effect.gen(function* () {
                  const tabId = (yield* open(adapter, origin)).tabId as string;
                  yield* evaluate(
                    adapter,
                    tabId,
                    "(() => { localStorage.setItem('keep', 'yes'); return true; })()",
                  );
                  const first = (yield* adapter.handle(
                    onTab(tabId, "status", {}),
                  )) as PreviewAutomationStatus;

                  // A page that never returns: the request's own deadline passes and the browser is ended.
                  const hung = yield* adapter
                    .handle(
                      onTab(
                        tabId,
                        "evaluate",
                        { expression: "new Promise(() => {})" },
                        { timeoutMs: 400 },
                      ),
                    )
                    .pipe(Effect.exit);
                  assert.equal(failureOf(hung).tag, "PreviewAutomationTimeoutError");

                  // No quiet replacement: operations fail by name until someone opens again.
                  const unavailable = yield* adapter
                    .handle(onTab(tabId, "evaluate", { expression: "1" }))
                    .pipe(
                      Effect.exit,
                      Effect.repeat({
                        until: (exit) =>
                          Exit.isFailure(exit) && failureOf(exit).message.includes("unavailable"),
                        schedule: Schedule.spaced("50 millis"),
                        times: 100,
                      }),
                    );
                  assert.include(failureOf(unavailable).message, "Call preview_open");

                  const again = (yield* adapter.handle(
                    onTab(tabId, "open", { browserBinding: binding, open: false }),
                  )) as PreviewAutomationStatus;
                  assert.equal(again.tabId, tabId);
                  assert.notEqual(again.managed?.incarnation, first.managed?.incarnation);
                  assert.equal(again.managed?.phase, "agent");
                  // The profile's storage survived the browser that held it.
                  assert.equal(
                    yield* evaluate(adapter, tabId, "localStorage.getItem('keep')"),
                    "yes",
                  );
                }),
            );
          }),
        ),
      REAL,
    );
  },
);

describe.skipIf(!engineAvailable)("a person watching the managed tab", () => {
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

  it.live(
    "receives frames, takes control with input, and disconnecting holds the agent out without closing the tab",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;

              const viewerScope = yield* Scope.make();
              const viewer = yield* adapter
                .attachViewer({
                  threadId,
                  tabId,
                  maxWidth: 640,
                  maxHeight: 400,
                  canOperate: true,
                  viewer: { sessionId: "test-administrator", administrator: true },
                })
                .pipe(Scope.provide(viewerScope));

              const frame = yield* nextOutput(viewer.output, (output) => output._tag === "frame");
              assert.equal(frame._tag, "frame");
              if (frame._tag === "frame") {
                assert.isAbove(frame.data.length, 100);
                yield* frame.ack;
              }
              const watching = (yield* adapter.handle(
                onTab(tabId, "status", {}),
              )) as PreviewAutomationStatus;
              assert.equal(watching.visible, true);

              // The agent acts, then a person clicks into the page and holds the lease.
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "start");
              // Input from a viewer that has not asked for control reaches nothing.
              yield* viewer.input({ type: "mouse", action: "down", x: 40, y: 40, button: "left" });
              assert.equal(
                ((yield* adapter.handle(onTab(tabId, "status", {}))) as PreviewAutomationStatus)
                  .managed?.phase,
                "agent",
              );
              yield* viewer.input({ type: "takeControl" });
              const held = yield* nextOutput(
                viewer.output,
                (output) => output._tag === "control" && output.controller === "you",
              );
              assert.equal(held._tag, "control");
              const blocked = yield* adapter
                .handle(onTab(tabId, "evaluate", { expression: "1" }))
                .pipe(Effect.exit);
              assert.deepEqual(failureOf(blocked).detail, "humanControl");

              // Closing the viewer closes nothing, and the agent is still held out while the person reconnects.
              yield* Scope.close(viewerScope, Exit.void);
              const after = (yield* adapter.handle(
                onTab(tabId, "status", {}),
              )) as PreviewAutomationStatus;
              assert.equal(after.available, true);
              assert.equal(after.visible, false);
              assert.equal(after.managed?.phase, "reconnectHold");
              const stillBlocked = yield* adapter
                .handle(onTab(tabId, "evaluate", { expression: "1" }))
                .pipe(Effect.exit);
              assert.deepEqual(failureOf(stillBlocked).detail, "humanControl");
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "a person holds control with no stream open: agents are refused, then run again once it is released",
    () =>
      withRealAdapter({}, ({ adapter }) =>
        Effect.gen(function* () {
          const tabId = (yield* open(adapter)).tabId as string;
          const asked = (action: "take" | "release", sessionId = "native-session") =>
            adapter.setControl({ threadId, tabId, sessionId, action });
          assert.equal(yield* evaluate(adapter, tabId, "1 + 1"), 2);

          assert.isTrue(yield* asked("take"));
          // Nothing watched the tab: this is the lease alone, not a viewer's.
          const status = (yield* adapter.handle(
            onTab(tabId, "status", {}),
          )) as PreviewAutomationStatus;
          assert.equal(status.managed?.phase, "human");
          assert.equal(status.visible, false);
          const row = (yield* adapter.directory).tabs[0]!;
          assert.equal(row.phase, "human");
          assert.equal(row.holder, "human:native-native-session");
          const blocked = yield* adapter
            .handle(onTab(tabId, "evaluate", { expression: "1" }))
            .pipe(Effect.exit);
          assert.deepEqual(failureOf(blocked).detail, "humanControl");

          // Another session can neither take it from them nor give it back for them.
          assert.equal(
            failureOf(yield* asked("take", "someone-else").pipe(Effect.exit)).tag,
            "PreviewAutomationControlInterruptedError",
          );
          assert.equal(
            failureOf(yield* asked("release", "someone-else").pipe(Effect.exit)).tag,
            "PreviewAutomationControlInterruptedError",
          );
          assert.deepEqual(
            failureOf(
              yield* adapter
                .handle(onTab(tabId, "evaluate", { expression: "1" }))
                .pipe(Effect.exit),
            ).detail,
            "humanControl",
          );

          // Releasing is the explicit hand-back, and the same agent works on the same tab again.
          assert.isTrue(yield* asked("release"));
          assert.equal(yield* evaluate(adapter, tabId, "1 + 1"), 2);
          assert.equal((yield* adapter.directory).tabs[0]!.phase, "agent");
          // A tab that is not here is reported as missing, never as an error or a lease on nothing.
          assert.isFalse(
            yield* adapter.setControl({
              threadId,
              tabId: "no-such-tab",
              sessionId: "native-session",
              action: "take",
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "a read-only viewer sees the page but cannot take control",
    () =>
      withRealAdapter({}, ({ adapter }) =>
        Effect.gen(function* () {
          const tabId = (yield* open(adapter)).tabId as string;
          const viewer = yield* adapter.attachViewer({
            threadId,
            tabId,
            maxWidth: 640,
            maxHeight: 400,
            canOperate: false,
            viewer: { sessionId: "test-administrator", administrator: true },
          });
          yield* nextOutput(viewer.output, (output) => output._tag === "frame");
          yield* viewer.input({ type: "mouse", action: "down", x: 10, y: 10, button: "left" });
          yield* viewer.input({ type: "key", action: "down", key: "a" });
          const status = (yield* adapter.handle(
            onTab(tabId, "status", {}),
          )) as PreviewAutomationStatus;
          assert.equal(status.managed?.phase, "agent");
          assert.equal(yield* evaluate(adapter, tabId, "1 + 1"), 2);
        }).pipe(Effect.scoped),
      ),
    REAL,
  );

  it.live(
    "a viewer of a tab that is not managed here is refused as not found",
    () =>
      withRealAdapter({}, ({ adapter }) =>
        Effect.gen(function* () {
          const exit = yield* adapter
            .attachViewer({
              threadId,
              tabId: "not-a-managed-tab",
              maxWidth: 640,
              maxHeight: 400,
              canOperate: true,
              viewer: { sessionId: "test-administrator", administrator: true },
            })
            .pipe(Effect.scoped, Effect.exit);
          assert.isTrue(Exit.isFailure(exit));
          void Deferred;
        }),
      ),
    REAL,
  );
});
