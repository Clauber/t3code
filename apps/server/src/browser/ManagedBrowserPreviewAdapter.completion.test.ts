// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
/**
 * The preview adapter's durable and interactive behavior against the packaged engine and a real
 * headless browser: tabs that survive a T3 restart, closes that never orphan a tab, popups,
 * downloads, role and text targets, press, and what a person's viewer can do. Skipped only when
 * the packaged engine is absent.
 */
import * as FS from "node:fs";
import * as NodeHttp from "node:http";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";

import {
  EnvironmentId,
  ThreadId,
  type PreviewAutomationSharedTabs,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import type { ServerBrowserViewerOutput } from "../preview/ServerBrowser.ts";
import type { ServerBrowserOperationError } from "../preview/ServerBrowserPage.ts";
import type * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import {
  agent,
  binding,
  callerContext,
  descriptor,
  engineAvailable,
  makeDataRoot,
  ownerEnvironmentId,
  previewRequest,
  threadId,
  withRealAdapter,
} from "./ManagedBrowserRealEngineFixture.ts";
import type * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

type Adapter = ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"];
type Supervisor = ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];

const REAL = { timeout: 180_000 };

const PAGE = `<!doctype html><title>start</title>
<h1>Managed</h1>
<input aria-label="Name" onkeydown="window.__keys=(window.__keys||[]).concat([(event.shiftKey?'S+':'')+event.key]); if(event.key==='Enter') document.title='entered:'+this.value">
<button onclick="document.title='clicked'">Go</button>
<button onclick="document.title='second button'">Other</button>
<button onclick="window.open('/popup')">Pop</button>
<button onclick="alert('are you sure'); document.title='after dialog'">Alert</button>
<a href="/file" download>Get file</a>`;

/** A local origin that counts what it serves, so a test can tell who navigated. */
const serve = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly server: NodeHttp.Server;
        readonly origin: string;
        readonly hits: string[];
      }>((resolve) => {
        const hits: string[] = [];
        const server = NodeHttp.createServer((request, response) => {
          hits.push(request.url ?? "");
          if (request.url === "/file") {
            response.setHeader("Content-Type", "application/octet-stream");
            response.setHeader("Content-Disposition", 'attachment; filename="hello.txt"');
            response.end("hello bytes");
            return;
          }
          response.setHeader("Content-Type", "text/html");
          response.end(
            request.url === "/second"
              ? "<title>second</title><button>Next</button>"
              : request.url === "/popup"
                ? "<title>popup</title><button>In popup</button>"
                : PAGE,
          );
        });
        server.listen(0, "127.0.0.1", () => {
          resolve({
            server,
            hits,
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

const onTab = (
  tabId: string,
  operation: Parameters<typeof previewRequest>[0],
  input: unknown,
  extra: Record<string, unknown> = {},
) => previewRequest(operation, input, { tabId, tabIdExplicit: true, ...extra });

const evaluate = (adapter: Adapter, tabId: string, expression: string) =>
  adapter.handle(onTab(tabId, "evaluate", { expression }));

const statusOf = (adapter: Adapter, tabId: string) =>
  adapter.handle(onTab(tabId, "status", {})).pipe(Effect.map((s) => s as PreviewAutomationStatus));

/** Waits for a condition the adapter learns of from the browser's events, without sleeping to pass. */
const until = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  accept: (value: A) => boolean,
  label: string,
) =>
  effect.pipe(
    Effect.filterOrFail(accept, () => `still waiting: ${label}`),
    Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
  );

/** Whether the engine still has a tab, asked as the agent once the lease is back with agents. */
const engineHasTab = (supervisor: Supervisor, engineTabId: string) =>
  Effect.gen(function* () {
    const ref = yield* supervisor.ensure(descriptor);
    const { fence } = yield* supervisor.state(ref);
    const exit = yield* supervisor
      .execute(agent, ref, fence, { kind: "attach", caller: callerContext, tabId: engineTabId })
      .pipe(Effect.exit);
    return Exit.isSuccess(exit);
  });

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

/** An owner-sized disposable data root that survives restarts inside one test. */
const persistentRoot = Effect.acquireRelease(Effect.sync(makeDataRoot), (root) =>
  Effect.sync(() => FS.rmSync(root, { recursive: true, force: true })),
);

const snapshotRef = (snapshot: unknown, name: string) => {
  const found = (
    snapshot as { interactiveElements: ReadonlyArray<{ name: string; selector: string }> }
  ).interactiveElements.find((element) => element.name === name);
  assert.isDefined(found, `no element named ${name}`);
  return found!.selector;
};

describe.skipIf(!engineAvailable)("targets the engine cannot take directly", () => {
  it.live(
    "resolves role and text locators in the page as it is now, and says when zero or several match",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;

              // No snapshot first: the locator is resolved against a fresh one, in this document.
              yield* adapter.handle(onTab(tabId, "click", { locator: "role=button[name='Go']" }));
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "clicked");

              yield* evaluate(adapter, tabId, "(() => { document.title = 'start'; return 1; })()");
              yield* adapter.handle(onTab(tabId, "click", { locator: "text=Other" }));
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "second button");

              const several = yield* adapter
                .handle(onTab(tabId, "click", { locator: "role=button" }))
                .pipe(Effect.exit);
              assert.equal(failureOf(several).tag, "PreviewAutomationInvalidSelectorError");
              assert.match(failureOf(several).message, /4 interactive elements match/);

              const none = yield* adapter
                .handle(onTab(tabId, "click", { locator: "role=button[name='Nope']" }))
                .pipe(Effect.exit);
              assert.equal(failureOf(none).tag, "PreviewAutomationInvalidSelectorError");
              assert.match(failureOf(none).message, /No interactive element/);

              // After the page changes, the same kind of locator finds the new page's element.
              yield* adapter.handle(onTab(tabId, "navigate", { url: `${origin}/second` }));
              yield* evaluate(adapter, tabId, "(() => { window.__clicked = false; return 1; })()");
              yield* adapter.handle(onTab(tabId, "click", { locator: "role=button[name='Next']" }));
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "presses a key on the focused element, types into it with no target, and says when nothing has focus",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              const snapshot = yield* adapter.handle(onTab(tabId, "snapshot", {}));
              yield* adapter.handle(
                onTab(tabId, "click", { locator: snapshotRef(snapshot, "Name") }),
              );

              yield* adapter.handle(onTab(tabId, "type", { text: "abc" }));
              assert.equal(
                yield* evaluate(adapter, tabId, "document.querySelector('input').value"),
                "abc",
              );
              yield* adapter.handle(onTab(tabId, "press", { key: "Enter" }));
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "entered:abc");

              yield* adapter.handle(onTab(tabId, "press", { key: "a", modifiers: ["Shift"] }));
              const keys = (yield* evaluate(adapter, tabId, "window.__keys")) as string[];
              assert.include(keys, "S+a", "the key arrived with Shift held");

              // Typing needs a focused element that takes text; with nothing focused it says so.
              yield* evaluate(adapter, tabId, "document.activeElement.blur()");
              const nothing = yield* adapter
                .handle(onTab(tabId, "type", { text: "x" }))
                .pipe(Effect.exit);
              assert.equal(failureOf(nothing).tag, "PreviewAutomationTargetNotEditableError");
              assert.match(failureOf(nothing).message, /does not take text/);
              // Clearing replaces what a focused field held.
              yield* adapter.handle(
                onTab(tabId, "click", { locator: snapshotRef(snapshot, "Name") }),
              );
              yield* adapter.handle(onTab(tabId, "type", { text: "new", clear: true }));
              assert.equal(
                yield* evaluate(adapter, tabId, "document.querySelector('input').value"),
                "new",
              );
            }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("tabs that outlive a T3 restart", () => {
  it.live(
    "reattaches the thread's tab by the same engine id and profile, without the adapter navigating it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin, hits } = yield* serve;
          const dataRoot = yield* persistentRoot;

          const before = yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              const status = yield* open(adapter, origin);
              yield* evaluate(
                adapter,
                status.tabId as string,
                "(() => { localStorage.setItem('keep', 'yes'); return true; })()",
              );
              const records = registry.tabs();
              assert.equal(records.length, 1);
              return { tabId: status.tabId as string, engineTabId: records[0]!.engineTabId };
            }),
          );
          assert.equal(hits.filter((url) => url === "/").length, 1);

          yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              // A new server run, no tab known: opening the same binding gives the thread its tab back.
              const status = yield* open(adapter);
              assert.notEqual(status.tabId, before.tabId, "a new run mints a new session id");
              assert.equal(status.url, `${origin}/`);
              assert.equal(status.managed?.profileId, binding.profileId);
              const records = registry.tabs();
              assert.equal(records.length, 1, "no second tab beside the recovered one");
              assert.equal(records[0]!.engineTabId, before.engineTabId);
              assert.equal(
                yield* evaluate(adapter, status.tabId as string, "localStorage.getItem('keep')"),
                "yes",
              );
            }),
          );
          // The browser reloads the address it had when it came back (its own session restore);
          // the adapter added no navigation of its own.
          assert.equal(hits.filter((url) => url === "/").length, 2);
        }),
      ),
    REAL,
  );

  it.live(
    "remembers which profile an instance uses, and refuses to rebind either after a restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const dataRoot = yield* persistentRoot;
          yield* withRealAdapter({ dataRoot }, ({ adapter }) => open(adapter, origin));

          yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              const otherProfile = yield* adapter
                .handle(
                  previewRequest("open", {
                    browserBinding: { ...binding, profileId: "profile-other" },
                    open: false,
                  }),
                )
                .pipe(Effect.exit);
              assert.match(failureOf(otherProfile).message, /different profile/);

              const otherInstance = yield* adapter
                .handle(
                  previewRequest("open", {
                    browserBinding: { ...binding, instanceId: "instance-other" },
                    open: false,
                  }),
                )
                .pipe(Effect.exit);
              assert.match(failureOf(otherInstance).message, /already belongs/);
              assert.equal(registry.tabs().length, 1);
              assert.equal(registry.instances().length, 1);
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "never hands a tab to another thread or another environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const dataRoot = yield* persistentRoot;
          const first = yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            open(adapter, origin).pipe(Effect.map(() => registry.tabs()[0]!.engineTabId)),
          );

          yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              const stranger = EnvironmentId.make("env-remote");
              const refused = yield* adapter
                .handle(
                  previewRequest(
                    "open",
                    { browserBinding: binding, open: false },
                    { callerEnvironmentId: stranger },
                  ),
                )
                .pipe(Effect.exit);
              assert.equal(failureOf(refused).tag, "PreviewAutomationUnsupportedClientError");
              assert.match(failureOf(refused).message, /owner environment/);
              assert.equal(registry.tabs().length, 1, "a refused call records nothing");

              // Another thread of the owner's own environment gets its own tab.
              const other = (yield* adapter.handle(
                previewRequest(
                  "open",
                  { browserBinding: binding, open: false },
                  { threadId: ThreadId.make("thread-2") },
                ),
              )) as PreviewAutomationStatus;
              const records = registry.tabs();
              assert.equal(records.length, 2);
              assert.isTrue(records.some((record) => record.engineTabId === first));
              assert.notEqual(
                records.find((record) => record.threadId === "thread-2")!.engineTabId,
                first,
              );
              assert.isDefined(other.tabId);
            }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("recovery is not an authority of its own", () => {
  it.live(
    "even when a policy admits another environment, it is given its own tab and the owner's record is untouched",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const dataRoot = yield* persistentRoot;
          const owners = yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            open(adapter, origin).pipe(Effect.map(() => registry.tabs()[0]!)),
          );

          yield* withRealAdapter(
            { dataRoot, policy: { authorize: () => Effect.void } },
            ({ adapter, registry }) =>
              Effect.gen(function* () {
                const remote = EnvironmentId.make("env-remote");
                const status = (yield* adapter.handle(
                  previewRequest(
                    "open",
                    { browserBinding: binding, open: false },
                    { callerEnvironmentId: remote },
                  ),
                )) as PreviewAutomationStatus;
                const records = registry.tabs();
                assert.equal(records.length, 2, "a second tab, not the owner's");
                const mine = records.find((record) => record.engineTabId === owners.engineTabId)!;
                assert.equal(mine.callerEnvironmentId, owners.callerEnvironmentId);
                assert.equal(mine.agentSessionId, owners.agentSessionId);
                const theirs = records.find((record) => record.engineTabId !== owners.engineTabId)!;
                assert.equal(theirs.callerEnvironmentId, remote);
                assert.isDefined(status.tabId);
              }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("authenticated human tab opening", () => {
  it.live("opens another thread for the same holder without releasing control or trusting a human prefix", () =>
    Effect.scoped(withRealAdapter({}, ({ adapter, supervisor }) => Effect.gen(function* () {
      const { origin } = yield* serve;
      const first = (yield* adapter.handle(previewRequest("open", {
        url: origin, browserBinding: binding, reuseExistingTab: false, open: false,
      }, { agentSessionId: "human:viewer-one" }), { sessionId: "viewer-one" })) as PreviewAutomationStatus;
      assert.equal(first.control?.owner, "agent");
      const unheldOther = (yield* adapter.handle(previewRequest("open", {
        browserBinding: binding, reuseExistingTab: false, open: false,
      }, { threadId: ThreadId.make("unheld-other-viewer"), agentSessionId: "human:viewer-two" }), { sessionId: "viewer-two" })) as PreviewAutomationStatus;
      assert.equal(unheldOther.control?.owner, "agent");
      yield* adapter.setControl({ threadId, tabId: first.tabId!, sessionId: "viewer-one", action: "take" });
      const ref = yield* supervisor.ensure(descriptor);
      const before = yield* supervisor.state(ref);
      const fresh = (id: string, session: string) => previewRequest("open", {
        browserBinding: binding, reuseExistingTab: false, open: false,
      }, { threadId: ThreadId.make(id), agentSessionId: session });
      const second = (yield* adapter.handle(fresh("human-second-thread", "human:viewer-one"), { sessionId: "viewer-one" })) as PreviewAutomationStatus;
      assert.notEqual(second.tabId, first.tabId);
      assert.equal(second.control?.owner, "human");
      assert.deepEqual(yield* supervisor.state(ref), before);
      for (const [id, session, context] of [
        ["different-human", "human:viewer-two", { sessionId: "viewer-two" }],
        ["spoofed-human-prefix", "human:viewer-one", undefined],
        ["real-agent", "actual-agent", undefined],
      ] as const) {
        const failed = yield* adapter.handle(fresh(id, session), context).pipe(Effect.exit);
        assert.equal(failureOf(failed).tag, "PreviewAutomationControlInterruptedError");
        assert.deepEqual(yield* supervisor.state(ref), before);
      }
    }))), REAL);
});

describe.skipIf(!engineAvailable)("closing a tab from the UI", () => {
  it.live(
    "closes the browser's tab under an explicit takeover and gives the lease back",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter, manager, supervisor, registry }) =>
            Effect.gen(function* () {
              const status = yield* open(adapter, origin);
              const tabId = status.tabId as string;
              const engineTabId = registry.tabs()[0]!.engineTabId;
              yield* manager.close({ threadId, tabId });

              const outcome = yield* adapter.sessionClosed(threadId, tabId);
              assert.equal(outcome._tag, "closed");
              assert.equal(registry.tabs().length, 0);
              assert.isFalse(adapter.owns(threadId, tabId));
              const ref = yield* supervisor.ensure(descriptor);
              assert.equal((yield* supervisor.state(ref)).phase, "agent");
              assert.isFalse(yield* engineHasTab(supervisor, engineTabId));
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "does not take a tab from a person who is driving it: the close waits, is recorded, and happens when they let go",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter, manager, supervisor, registry }) =>
            Effect.gen(function* () {
              const status = yield* open(adapter, origin);
              const tabId = status.tabId as string;
              const engineTabId = registry.tabs()[0]!.engineTabId;
              const viewer = yield* adapter.attachViewer({
                threadId,
                tabId,
                maxWidth: 640,
                maxHeight: 400,
                canOperate: true,
                viewer: { sessionId: "test-administrator", administrator: true },
              });
              yield* viewer.input({ type: "takeControl" });
              yield* nextOutput(
                viewer.output,
                (output) => output._tag === "control" && output.controller === "you",
              );

              yield* manager.close({ threadId, tabId });
              const outcome = yield* adapter.sessionClosed(threadId, tabId);
              assert.equal(outcome._tag, "deferred");
              // Not orphaned: the browser still has it, and the record says it must be closed.
              assert.equal(registry.tabs().length, 1);
              assert.isTrue(registry.tabs()[0]!.closePending);

              yield* viewer.input({ type: "releaseControl" });
              yield* until(
                Effect.sync(() => registry.tabs().length),
                (count) => count === 0,
                "the deferred close to finish",
              );
              const ref = yield* supervisor.ensure(descriptor);
              assert.equal((yield* supervisor.state(ref)).phase, "agent");
              assert.isFalse(yield* engineHasTab(supervisor, engineTabId));
            }).pipe(Effect.scoped),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "a close still pending when T3 restarts is carried out before anything reopens the tab",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const dataRoot = yield* persistentRoot;
          const old = yield* withRealAdapter({ dataRoot }, ({ adapter, manager, registry }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              const engineTabId = registry.tabs()[0]!.engineTabId;
              const viewer = yield* adapter.attachViewer({
                threadId,
                tabId,
                maxWidth: 640,
                maxHeight: 400,
                canOperate: true,
                viewer: { sessionId: "test-administrator", administrator: true },
              });
              yield* viewer.input({ type: "takeControl" });
              yield* nextOutput(
                viewer.output,
                (output) => output._tag === "control" && output.controller === "you",
              );
              yield* manager.close({ threadId, tabId });
              assert.equal((yield* adapter.sessionClosed(threadId, tabId))._tag, "deferred");
              return engineTabId;
            }).pipe(Effect.scoped),
          );

          yield* withRealAdapter({ dataRoot }, ({ adapter, supervisor, registry }) =>
            Effect.gen(function* () {
              const status = yield* open(adapter, origin);
              const records = registry.tabs();
              assert.equal(records.length, 1, "the closed tab was not recovered");
              assert.notEqual(records[0]!.engineTabId, old);
              assert.isFalse(records[0]!.closePending);
              assert.isTrue(status.available);
              assert.isFalse(yield* engineHasTab(supervisor, old));
            }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("popups and downloads", () => {
  it.live(
    "a popup becomes a session of its own that the agent can address, and closing it clears its record",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter, manager, registry }) =>
            Effect.gen(function* () {
              const opener = yield* open(adapter, origin);
              const openerTabId = opener.tabId as string;
              yield* adapter.handle(
                onTab(openerTabId, "click", { locator: "role=button[name='Pop']" }),
              );

              const status = yield* until(
                statusOf(adapter, openerTabId),
                (current) => (current.tabs?.length ?? 0) === 2,
                "the popup to be adopted",
              );
              const popup = status.tabs!.find((tab) => tab.openerTabId !== undefined)!;
              assert.equal(popup.openerTabId, openerTabId);
              const popupTabId = popup.tabId as string;
              assert.isTrue(adapter.owns(threadId, popupTabId));

              yield* until(
                statusOf(adapter, popupTabId),
                (current) => current.url?.endsWith("/popup") === true,
                "the popup to load",
              );
              assert.equal(yield* evaluate(adapter, popupTabId, "document.title"), "popup");

              const sessions = (yield* manager.list({ threadId })).sessions;
              assert.isTrue(sessions.some((session) => session.tabId === popupTabId));
              const records = registry.tabs();
              assert.equal(records.length, 2);
              const popupRecord = records.find((record) => record.openerEngineTabId !== null)!;
              assert.equal(
                popupRecord.openerEngineTabId,
                records.find((record) => record.openerEngineTabId === null)!.engineTabId,
              );

              yield* adapter.handle(onTab(popupTabId, "close", {}));
              assert.equal(registry.tabs().length, 1);
              assert.isFalse(adapter.owns(threadId, popupTabId));
            }),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "a download crosses as bytes into a file the existing download route can serve",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              yield* adapter.handle(
                onTab(tabId, "click", { locator: "role=link[name='Get file']" }),
              );
              const status = yield* until(
                statusOf(adapter, tabId),
                (current) => (current.downloads?.length ?? 0) === 1,
                "the download to arrive",
              );
              const saved = status.downloads![0]!;
              assert.equal(saved.fileName, "hello.txt");
              assert.equal(saved.sizeBytes, 11);
              assert.equal(FS.readFileSync(saved.path, "utf8"), "hello bytes");
              const admin = { sessionId: "test-administrator", administrator: true };
              const served = yield* adapter.openDownload(
                threadId,
                tabId,
                Path.basename(saved.path),
                admin,
              );
              assert.isTrue(Option.isSome(served));
              assert.equal(Option.getOrThrow(served).path, saved.path);
              assert.isTrue(
                Option.isNone(
                  yield* adapter.openDownload(threadId, tabId, "not-a-download", admin),
                ),
              );
              assert.isTrue(
                Option.isNone(
                  yield* adapter.openDownload("thread-2", tabId, Path.basename(saved.path), admin),
                ),
              );
              // A session that is neither an administrator nor named by a grant is not given the file.
              assert.isTrue(
                Option.isNone(
                  yield* adapter.openDownload(threadId, tabId, Path.basename(saved.path), {
                    sessionId: "someone-else",
                    administrator: false,
                  }),
                ),
              );
              assert.isTrue(
                Option.isNone(
                  yield* adapter.openDownload(
                    threadId,
                    tabId,
                    Path.basename(saved.path),
                    undefined,
                  ),
                ),
              );
            }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("what a person's viewer can do", () => {
  const center = (adapter: Adapter, tabId: string, selector: string) =>
    evaluate(
      adapter,
      tabId,
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    ).pipe(Effect.map((point) => point as { x: number; y: number }));

  it.live(
    "a click, navigation, history, reload, probe and resize all reach the page, and what cannot is refused aloud",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin, hits } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              const go = yield* center(adapter, tabId, "button");
              const field = yield* center(adapter, tabId, "input");
              const viewer = yield* adapter.attachViewer({
                threadId,
                tabId,
                maxWidth: 640,
                maxHeight: 400,
                canOperate: true,
                viewer: { sessionId: "test-administrator", administrator: true },
              });
              const take = Effect.gen(function* () {
                yield* viewer.input({ type: "takeControl" });
                yield* nextOutput(
                  viewer.output,
                  (output) => output._tag === "control" && output.controller === "you",
                );
              });
              const release = Effect.gen(function* () {
                yield* viewer.input({ type: "releaseControl" });
                yield* nextOutput(
                  viewer.output,
                  (output) => output._tag === "control" && output.controller === "agent",
                );
              });

              // A message before control is taken is refused, with the control state to show.
              yield* viewer.input({
                type: "mouse",
                action: "down",
                x: go.x,
                y: go.y,
                button: "left",
              });
              const refused = yield* nextOutput(
                viewer.output,
                (output) => output._tag === "rejected",
              );
              assert.match((refused as { reason: string }).reason, /Take control first/);

              // A real click changes the page.
              yield* take;
              yield* viewer.input({
                type: "mouse",
                action: "down",
                x: go.x,
                y: go.y,
                button: "left",
              });
              yield* viewer.input({
                type: "mouse",
                action: "up",
                x: go.x,
                y: go.y,
                button: "left",
              });
              yield* release;
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "clicked");

              // Probe: the text field is editable, the button is not.
              yield* take;
              yield* viewer.input({ type: "probe", x: field.x, y: field.y });
              const editable = yield* nextOutput(
                viewer.output,
                (output) => output._tag === "probe",
              );
              assert.equal((editable as { editable: boolean }).editable, true);
              yield* viewer.input({ type: "probe", x: go.x, y: go.y });
              const button = yield* nextOutput(viewer.output, (output) => output._tag === "probe");
              assert.equal((button as { editable: boolean }).editable, false);

              // Navigate, then history back, then reload.
              yield* viewer.input({ type: "navigate", url: `${origin}/second` });
              yield* release;
              assert.equal(yield* evaluate(adapter, tabId, "location.pathname"), "/second");
              yield* take;
              yield* viewer.input({ type: "history", delta: -1 });
              yield* release;
              yield* until(
                evaluate(adapter, tabId, "location.pathname"),
                (path) => path === "/",
                "history back to settle",
              );
              const before = hits.filter((url) => url === "/").length;
              yield* take;
              yield* viewer.input({ type: "reload" });
              yield* release;
              yield* until(
                Effect.sync(() => hits.filter((url) => url === "/").length),
                (count) => count > before,
                "the reload to reach the server",
              );

              // Resize reaches the page.
              yield* take;
              yield* viewer.input({ type: "resize", width: 700, height: 500 });
              yield* release;
              // The page learns its new size from the browser, not from the reply to the input.
              yield* until(
                evaluate(adapter, tabId, "window.innerWidth"),
                (width) => width === 700,
                "the page to take the new width",
              );

              // Everything the engine cannot do is refused out loud, never dropped.
              yield* take;
              for (const [message, pattern] of [
                [{ type: "bogus" }, /not supported/],
                [{ type: "reload", ignoreCache: true }, /hard reload/],
                [{ type: "viewport", setting: { _tag: "fill" } }, /follows the viewer's size/],
                [{ type: "navigate", url: "not a url" }, /valid URL/],
                [{ type: "history", delta: 0 }, /direction/],
                ["nonsense", /not understood/],
              ] as const) {
                yield* viewer.input(message);
                const output = yield* nextOutput(
                  viewer.output,
                  (candidate) => candidate._tag === "rejected",
                );
                assert.match((output as { reason: string }).reason, pattern);
              }
            }).pipe(Effect.scoped),
          );
        }),
      ),
    REAL,
  );

  it.live(
    "answers a dialog the viewer's own click opened, and offers a download to the person driving",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          return yield* withRealAdapter({}, ({ adapter }) =>
            Effect.gen(function* () {
              const tabId = (yield* open(adapter, origin)).tabId as string;
              const alertButton = yield* center(adapter, tabId, "button:nth-of-type(4)");
              const link = yield* center(adapter, tabId, "a");
              const viewer = yield* adapter.attachViewer({
                threadId,
                tabId,
                maxWidth: 640,
                maxHeight: 400,
                canOperate: true,
                viewer: { sessionId: "test-administrator", administrator: true },
              });
              yield* viewer.input({ type: "takeControl" });
              yield* nextOutput(
                viewer.output,
                (output) => output._tag === "control" && output.controller === "you",
              );

              yield* viewer.input({
                type: "mouse",
                action: "down",
                x: link.x,
                y: link.y,
                button: "left",
              });
              yield* viewer.input({
                type: "mouse",
                action: "up",
                x: link.x,
                y: link.y,
                button: "left",
              });
              const offered = yield* nextOutput(
                viewer.output,
                (output) => output._tag === "download",
              );
              assert.equal((offered as { fileName: string }).fileName, "hello.txt");
              assert.equal((offered as { sizeBytes: number }).sizeBytes, 11);

              // The click that opens an alert does not return until the alert is answered.
              yield* viewer.input({
                type: "mouse",
                action: "down",
                x: alertButton.x,
                y: alertButton.y,
                button: "left",
              });
              const clicking = yield* viewer
                .input({
                  type: "mouse",
                  action: "up",
                  x: alertButton.x,
                  y: alertButton.y,
                  button: "left",
                })
                .pipe(Effect.forkScoped);
              const dialog = yield* nextOutput(
                viewer.output,
                (output) => output._tag === "control" && output.dialog !== null,
              );
              assert.equal(
                (dialog as { dialog: { message: string } }).dialog.message,
                "are you sure",
              );
              yield* viewer.input({ type: "dialog", accept: true });
              yield* Fiber.join(clicking);
              yield* viewer.input({ type: "releaseControl" });
              yield* nextOutput(
                viewer.output,
                (output) => output._tag === "control" && output.controller === "agent",
              );
              assert.equal(yield* evaluate(adapter, tabId, "document.title"), "after dialog");
            }).pipe(Effect.scoped),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("a tab several threads hold", () => {
  const second = {
    threadId: ThreadId.make("thread-2"),
    agentSessionId: "env-owner\u0000session-2",
  };
  const asThread = (
    who: typeof second,
    operation: Parameters<typeof previewRequest>[0],
    input: unknown,
    extra: Record<string, unknown> = {},
  ) => previewRequest(operation, input, { ...who, ...extra });

  it.live(
    "is joined only when shared, reattached by each holder after a restart, and kept while any holder remains",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const dataRoot = yield* persistentRoot;

          const before = yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              const mine = yield* open(adapter, origin);
              const engineTabId = mine.managed!.engineTabId!;
              // Not shared yet: a second thread that knows the id is told what a missing tab gets.
              const early = yield* adapter
                .handle(
                  asThread(second, "open", { browserBinding: binding, joinTab: { engineTabId } }),
                )
                .pipe(Effect.exit);
              assert.equal(failureOf(early).tag, "PreviewAutomationTabNotFoundError");
              yield* adapter.handle(
                onTab(mine.tabId as string, "open", { browserBinding: binding, shareTab: true }),
              );
              const joined = (yield* adapter.handle(
                asThread(second, "open", { browserBinding: binding, joinTab: { engineTabId } }),
              )) as PreviewAutomationStatus;
              assert.equal(joined.managed?.engineTabId, engineTabId);
              assert.notEqual(joined.tabId, mine.tabId);
              assert.equal(joined.managed?.participants, 2);
              // Every holder's record is durable, and says the page is shared.
              assert.sameMembers(
                registry.participantsOf(binding.instanceId, engineTabId).map((r) => r.threadId),
                ["thread-1", "thread-2"],
              );
              assert.isTrue(registry.tabs().every((record) => record.shared));
              yield* evaluate(
                adapter,
                mine.tabId as string,
                "(() => { localStorage.setItem('shared', 'one'); return 1; })()",
              );
              assert.equal(
                yield* adapter.handle(
                  asThread(
                    second,
                    "evaluate",
                    { expression: "localStorage.getItem('shared')" },
                    {
                      tabId: joined.tabId,
                      tabIdExplicit: true,
                    },
                  ),
                ),
                "one",
              );
              return { engineTabId, incarnation: mine.managed!.incarnation };
            }),
          );

          yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              // The owner restarted: the other thread's old boot is stale by name...
              const stale = yield* adapter
                .handle(
                  asThread(second, "open", {
                    browserBinding: binding,
                    joinTab: { engineTabId: before.engineTabId, incarnation: before.incarnation },
                  }),
                )
                .pipe(Effect.exit);
              assert.include(failureOf(stale).message, "stale");
              // ...and each holder gets back the one page, not a second one beside it.
              const joined = (yield* adapter.handle(
                asThread(second, "open", {
                  browserBinding: binding,
                  joinTab: { engineTabId: before.engineTabId },
                }),
              )) as PreviewAutomationStatus;
              const mine = yield* open(adapter);
              assert.equal(joined.managed?.engineTabId, before.engineTabId);
              assert.equal(mine.managed?.engineTabId, before.engineTabId);
              assert.equal(mine.managed?.participants, 2);
              assert.equal(registry.tabs().length, 2);
              // Closing by one holder only lets go; the page stays for the other.
              yield* adapter.handle(asThread(second, "close", {}, { tabId: joined.tabId }));
              assert.deepEqual(
                registry
                  .participantsOf(binding.instanceId, before.engineTabId)
                  .map((r) => r.threadId),
                ["thread-1"],
              );
              assert.equal(
                yield* evaluate(adapter, mine.tabId as string, "localStorage.getItem('shared')"),
                "one",
              );
              assert.equal(
                (yield* statusOf(adapter, mine.tabId as string)).managed?.participants,
                1,
              );
              // The last holder closes the page itself, and no record of it is left.
              yield* adapter.handle(onTab(mine.tabId as string, "close", {}));
              assert.equal(registry.tabs().length, 0);
              const gone = yield* evaluate(adapter, mine.tabId as string, "1").pipe(Effect.exit);
              assert.equal(failureOf(gone).tag, "PreviewAutomationTabNotFoundError");
            }),
          );
        }),
      ),
    REAL,
  );
});

describe.skipIf(!engineAvailable)("tabs people opened, after the owner restarts", () => {
  const hostThread = ThreadId.make(`managed-browser:${binding.profileId}`);
  const person = { threadId: hostThread, agentSessionId: "human:session-admin" };
  const otherAgent = {
    threadId: ThreadId.make("thread-2"),
    agentSessionId: `${ownerEnvironmentId}\u0000session-2`,
  };
  const admin = { sessionId: "session-admin", administrator: true };

  it.live(
    "lists a shared tab again without being reopened, hides the rest, and navigates nothing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin } = yield* serve;
          const dataRoot = yield* persistentRoot;

          const before = yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              const humanOpen = (shareTab: boolean) =>
                adapter
                  .handle(
                    previewRequest(
                      "open",
                      {
                        browserBinding: binding,
                        url: origin,
                        open: false,
                        reuseExistingTab: false,
                        shareTab,
                      },
                      person,
                    ),
                  )
                  .pipe(Effect.map((status) => status as PreviewAutomationStatus));
              const shared = yield* humanOpen(true);
              const privateTab = yield* humanOpen(false);
              const agentTab = yield* open(adapter, origin);
              assert.equal(registry.tabs().length, 3);
              return {
                shared: shared.managed!.engineTabId!,
                privateOne: privateTab.managed!.engineTabId!,
                agent: agentTab.managed!.engineTabId!,
              };
            }),
          );

          yield* withRealAdapter({ dataRoot }, ({ adapter, registry }) =>
            Effect.gen(function* () {
              const recorded = registry
                .tabs()
                .map((record) => `${record.engineTabId}@${record.url}`);
              assert.equal((yield* adapter.directory).tabs.length, 0, "nothing is open yet");

              // Another thread asks what is shared; it never opened or reopened anything.
              const listed = (yield* adapter.handle(
                previewRequest("sharedTabs", { browserBinding: binding }, otherAgent),
              )) as PreviewAutomationSharedTabs;
              assert.deepEqual(
                listed.tabs.map((tab) => tab.engineTabId),
                [before.shared],
              );
              assert.equal(listed.tabs[0]!.url, `${origin}/`);
              assert.isFalse(listed.tabs[0]!.held);

              // Both people's tabs are back for their owner; the agent's is not adopted by anyone.
              const directory = yield* adapter.directory;
              assert.sameMembers(
                directory.tabs.map((tab) => tab.engineTabId),
                [before.shared, before.privateOne],
              );
              assert.isTrue(directory.tabs.every((tab) => tab.hostThreadId === hostThread));
              assert.sameMembers(
                registry.tabs().map((record) => `${record.engineTabId}@${record.url}`),
                recorded,
                "the records did not change: no new tab, no navigation recorded",
              );

              // The restored tab streams to a person through its new session ids.
              const row = directory.tabs.find((tab) => tab.engineTabId === before.shared)!;
              const viewer = yield* adapter.attachViewer({
                threadId: row.hostThreadId,
                tabId: row.hostTabId,
                maxWidth: 640,
                maxHeight: 400,
                canOperate: false,
                viewer: admin,
              });
              const frame = yield* Queue.take(viewer.output).pipe(
                Effect.repeat({ until: (output) => output._tag === "frame" }),
              );
              assert.equal(frame._tag, "frame");

              // Making it private again takes it off the list at once, and joining it is refused.
              assert.isTrue(yield* adapter.setSharing(row.hostThreadId, row.hostTabId, false));
              const none = (yield* adapter.handle(
                previewRequest("sharedTabs", { browserBinding: binding }, otherAgent),
              )) as PreviewAutomationSharedTabs;
              assert.deepEqual(none.tabs, []);
              const refused = yield* adapter
                .handle(
                  previewRequest(
                    "open",
                    { browserBinding: binding, joinTab: { engineTabId: before.shared } },
                    otherAgent,
                  ),
                )
                .pipe(Effect.exit);
              assert.equal(failureOf(refused).tag, "PreviewAutomationTabNotFoundError");
            }),
          );
        }),
      ),
    REAL,
  );
});
