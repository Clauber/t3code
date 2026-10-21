// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
/**
 * The supervisor, the lease and the private launcher against the real engine and a real headless
 * browser, in a disposable profile. Suites here skip only when the engine build is absent
 * (`T3_MANAGED_BROWSER_ENGINE_MAIN`), never because a behavior is hard to test.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeCryptoHash from "node:crypto";
import * as NodeHttp from "node:http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ManagedBrowserRef } from "@t3tools/contracts";
import {
  agent,
  callerContext,
  descriptor,
  engineAvailable,
  evaluateCommand,
  human,
  makeDataRoot,
  openCommand,
  viewer,
  withRealEngine,
} from "./ManagedBrowserRealEngineFixture.ts";
import type * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

type Supervisor = ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];

interface OpenedTab {
  readonly ref: { readonly tabId: string };
  readonly documentId: string;
}

const REAL = { timeout: 120_000 };

/** The Tab the engine returns for an open. */
const openTab = (supervisor: Supervisor, ref: ManagedBrowserRef, tabId: string, url: string) =>
  Effect.gen(function* () {
    const { fence } = yield* supervisor.state(ref);
    return (yield* supervisor.execute(
      agent,
      ref,
      fence,
      openCommand(tabId, url),
    )) as unknown as OpenedTab;
  });

/** The supervisor retires an incarnation just after its exit is observed, so wait for that to show. */
const untilUnavailable = (supervisor: Supervisor, ref: ManagedBrowserRef) =>
  supervisor.state(ref).pipe(
    Effect.flip,
    Effect.retry({ times: 100, schedule: Schedule.spaced("20 millis") }),
    Effect.map((error) => error._tag),
  );

const channelCode = <A>(exit: Exit.Exit<A, unknown>) => {
  const error = Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as
        | { error?: { _tag?: string; cause?: { code?: string; reason?: string } } }
        | undefined)
    : undefined;
  return { tag: error?.error?._tag, ...error?.error?.cause };
};

/** A local origin on an ephemeral port the test owns; closed with the scope. */
const serve = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeHttp.Server; readonly origin: string }>((resolve) => {
          const server = NodeHttp.createServer(handler);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address() as { port: number };
            resolve({ server, origin: `http://127.0.0.1:${address.port}` });
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

const failureOf = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? (
        exit.cause.reasons.find((reason) => reason._tag === "Fail") as
          | { error?: { _tag?: string; reasons?: ReadonlyArray<string> } }
          | undefined
      )?.error
    : undefined;

describe.skipIf(!engineAvailable)("the real engine under the supervisor", () => {
  it.live(
    "opens a tab, evaluates in it, and reports the caller's own environment and the owner's resource",
    () =>
      withRealEngine({}, (supervisor) =>
        Effect.gen(function* () {
          const ref = yield* supervisor.ensure(descriptor);
          const tab = yield* openTab(
            supervisor,
            ref,
            "tab-1",
            "data:text/html,<title>real</title><h1>hello</h1>",
          );
          assert.equal(tab.ref.tabId, "tab-1");
          const { fence } = yield* supervisor.state(ref);
          const result = yield* supervisor.execute(
            agent,
            ref,
            fence,
            evaluateCommand("tab-1", tab.documentId, "() => document.title"),
          );
          assert.deepEqual(result, { value: "real" });
        }),
      ),
    REAL,
  );

  describe("a call's own deadline", () => {
    it.live(
      "fails after the deadline only once the page's work has actually finished",
      () =>
        withRealEngine({}, (supervisor) =>
          Effect.gen(function* () {
            const ref = yield* supervisor.ensure(descriptor);
            const tab = yield* openTab(supervisor, ref, "tab-1", "data:text/html,<h1>slow</h1>");
            const { fence } = yield* supervisor.state(ref);
            const started = Date.now();
            const exit = yield* supervisor
              .execute(
                agent,
                ref,
                fence,
                evaluateCommand(
                  "tab-1",
                  tab.documentId,
                  "() => new Promise((resolve) => setTimeout(() => { window.__finished = true; resolve('late'); }, 1500))",
                ),
                { deadlineMs: 400 },
              )
              .pipe(Effect.exit);
            const elapsed = Date.now() - started;
            assert.equal(channelCode(exit).code, "deadline_exceeded");
            // The deadline was 400 ms, but the failure was only reported after the work drained.
            assert.isAtLeast(elapsed, 1_300);
            const finished = yield* supervisor.execute(
              agent,
              ref,
              fence,
              evaluateCommand("tab-1", tab.documentId, "() => window.__finished === true"),
            );
            assert.deepEqual(finished, { value: true });
          }),
        ),
      REAL,
    );

    it.live(
      "a page that never returns costs the browser: the child is killed, its exit proven, and no second one starts",
      () =>
        withRealEngine({ timeouts: { drainMs: 1_500, answerGraceMs: 1_000 } }, (supervisor) =>
          Effect.gen(function* () {
            const ref = yield* supervisor.ensure(descriptor);
            const tab = yield* openTab(supervisor, ref, "tab-1", "data:text/html,<h1>stuck</h1>");
            const { fence } = yield* supervisor.state(ref);
            const events = yield* supervisor.events(human, ref);
            const exit = yield* supervisor
              .execute(
                agent,
                ref,
                fence,
                evaluateCommand("tab-1", tab.documentId, "() => new Promise(() => {})"),
                { deadlineMs: 400 },
              )
              .pipe(Effect.exit);
            assert.equal(channelCode(exit).code, "deadline_exceeded");

            // The event stream ends with the incarnation, which is the proof the process exited.
            yield* Stream.runDrain(events);
            // The owner is now unavailable rather than quietly replaced.
            const stateError = yield* untilUnavailable(supervisor, ref);
            assert.equal(stateError, "ManagedBrowserOwnerUnavailableError");

            // An explicit ensure starts a new incarnation on the same profile, which can only happen
            // because the old process was proven gone and released the profile lock.
            const replacement = yield* supervisor.ensure(descriptor);
            assert.notEqual(replacement.incarnation, ref.incarnation);
            const reopened = yield* openTab(
              supervisor,
              replacement,
              "tab-2",
              "data:text/html,<h1>again</h1>",
            );
            assert.equal(reopened.ref.tabId, "tab-2");
          }),
        ),
      REAL,
    );
  });

  describe("a takeover while the page is blocked on a dialog", () => {
    it.live(
      "completes promptly: the engine learns the generation first and dismisses the dialog",
      () =>
        withRealEngine({ timeouts: { requestMs: 8_000, drainMs: 8_000 } }, (supervisor) =>
          Effect.gen(function* () {
            const ref = yield* supervisor.ensure(descriptor);
            const tab = yield* openTab(supervisor, ref, "tab-1", "data:text/html,<h1>dialog</h1>");
            const { fence } = yield* supervisor.state(ref);
            const events = yield* supervisor.events(human, ref);
            const dialogShown = yield* Deferred.make<void>();
            yield* events.pipe(
              Stream.runForEach((event) =>
                (event as { name?: string }).name === "dialog"
                  ? Deferred.succeed(dialogShown, undefined)
                  : Effect.void,
              ),
              Effect.forkScoped,
            );

            const order: string[] = [];
            const running = yield* supervisor
              .execute(
                agent,
                ref,
                fence,
                evaluateCommand(
                  "tab-1",
                  tab.documentId,
                  "() => { alert('blocked until transfer'); return 'finished'; }",
                ),
              )
              .pipe(
                Effect.tap((value) =>
                  Effect.sync(() => order.push(`agent ${JSON.stringify(value)}`)),
                ),
                Effect.forkScoped,
              );
            yield* Deferred.await(dialogShown);

            const started = Date.now();
            const taken = yield* supervisor.takeControl(human, ref);
            order.push("takeover acknowledged");
            const took = Date.now() - started;

            // Far below the 8 s call deadline the old ordering would have waited out.
            assert.isBelow(took, 4_000);
            assert.equal(taken.generation, 1);
            // The old action returned before control moved: the dialog was dismissed, not abandoned.
            yield* Fiber.join(running);
            assert.deepEqual(order, ['agent {"value":"finished"}', "takeover acknowledged"]);

            // The old controller's fence is dead, and the human's reaches the page.
            const stale = yield* supervisor
              .execute(agent, ref, fence, evaluateCommand("tab-1", tab.documentId, "() => 'stale'"))
              .pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(stale));
            const live = yield* supervisor.execute(
              human,
              ref,
              taken,
              evaluateCommand("tab-1", tab.documentId, "() => 'human'"),
            );
            assert.deepEqual(live, { value: "human" });
          }),
        ),
      REAL,
    );
  });
});

describe.skipIf(!engineAvailable)(
  "the real engine: maintenance, artifacts, viewers, persistence",
  () => {
    it.live(
      "maintenance is deferred by a shared tab and by an unreleased artifact, and admission is restored each time",
      () =>
        withRealEngine({}, (supervisor) =>
          Effect.gen(function* () {
            const ref = yield* supervisor.ensure(descriptor);
            const tab = yield* openTab(supervisor, ref, "tab-1", "data:text/html,<h1>shared</h1>");

            const withTab = yield* supervisor
              .beginMaintenance(descriptor.instanceId)
              .pipe(Effect.exit);
            assert.equal(failureOf(withTab)?._tag, "ManagedBrowserMaintenanceDeferredError");
            assert.include(failureOf(withTab)?.reasons ?? [], "sharedSessions");
            // Admission is open again on the child, the lease and the claim.
            let { fence } = yield* supervisor.state(ref);
            assert.deepEqual(
              yield* supervisor.execute(
                agent,
                ref,
                fence,
                evaluateCommand("tab-1", tab.documentId, "() => 'still serving'"),
              ),
              { value: "still serving" },
            );

            const artifact = (yield* supervisor.execute(agent, ref, fence, {
              kind: "execute",
              caller: callerContext,
              tabId: "tab-1",
              documentId: tab.documentId,
              operation: { name: "screenshot", format: "png", fullPage: false },
            })) as { artifactId: string };
            yield* supervisor.execute(agent, ref, fence, {
              kind: "closeTab",
              caller: callerContext,
              tabId: "tab-1",
            });
            const withArtifact = yield* supervisor
              .beginMaintenance(descriptor.instanceId)
              .pipe(Effect.exit);
            assert.equal(failureOf(withArtifact)?._tag, "ManagedBrowserMaintenanceDeferredError");
            assert.include(failureOf(withArtifact)?.reasons ?? [], "downloads");

            yield* supervisor.scoped(agent, ref, {
              kind: "downloadRelease",
              caller: callerContext,
              artifactId: artifact.artifactId,
            });
            ({ fence } = yield* supervisor.state(ref));
            const token = yield* supervisor.beginMaintenance(descriptor.instanceId);
            // Closed while maintenance holds it, open again once it ends.
            const during = yield* supervisor
              .execute(agent, ref, fence, openCommand("tab-2", "data:text/html,<h1>x</h1>"))
              .pipe(Effect.exit);
            assert.equal(failureOf(during)?._tag, "ManagedBrowserMaintenanceError");
            yield* supervisor.endMaintenance(descriptor.instanceId, token);
            const reopened = yield* supervisor.execute(
              agent,
              ref,
              fence,
              openCommand("tab-2", "data:text/html,<h1>x</h1>"),
            );
            assert.equal((reopened as OpenedTab).ref.tabId, "tab-2");
          }),
        ),
      REAL,
    );

    it.live(
      "uploads stream in chunks into a file input and downloads stream out, scoped to the caller",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { origin } = yield* serve((request, response) => {
              if (request.url === "/download") {
                response.setHeader("Content-Disposition", "attachment; filename=report.txt");
                response.end("download payload");
              } else {
                response.setHeader("Content-Type", "text/html");
                response.end("<input type=file aria-label='File'><a href='/download'>Get</a>");
              }
            });
            return yield* withRealEngine({}, (supervisor) =>
              Effect.gen(function* () {
                const ref = yield* supervisor.ensure(descriptor);
                const tab = yield* openTab(supervisor, ref, "tab-1", origin);
                const { fence } = yield* supervisor.state(ref);

                const payload = Buffer.from("uploaded through three chunks");
                const sha256 = NodeCryptoHash.createHash("sha256").update(payload).digest("hex");
                const begun = (yield* supervisor.execute(agent, ref, fence, {
                  kind: "uploadBegin",
                  caller: callerContext,
                  fileName: "notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: payload.length,
                  sha256,
                })) as { artifactId: string };
                for (const [offset, end] of [
                  [0, 10],
                  [10, 20],
                  [20, payload.length],
                ] as const) {
                  yield* supervisor.execute(agent, ref, fence, {
                    kind: "uploadWrite",
                    caller: callerContext,
                    artifactId: begun.artifactId,
                    offset,
                    bytesBase64: payload.subarray(offset, end).toString("base64"),
                  });
                }
                yield* supervisor.execute(agent, ref, fence, {
                  kind: "uploadFinish",
                  caller: callerContext,
                  artifactId: begun.artifactId,
                });

                const snapshot = (yield* supervisor.execute(agent, ref, fence, {
                  kind: "execute",
                  caller: callerContext,
                  tabId: "tab-1",
                  documentId: tab.documentId,
                  operation: { name: "snapshot", format: "aria" },
                })) as { refs: Record<string, { name?: string }> };
                const fileRef = Object.keys(snapshot.refs).find(
                  (key) => snapshot.refs[key]?.name === "File",
                )!;
                yield* supervisor.execute(agent, ref, fence, {
                  kind: "execute",
                  caller: callerContext,
                  tabId: "tab-1",
                  documentId: tab.documentId,
                  operation: {
                    name: "upload",
                    target: { ref: fileRef, documentId: tab.documentId },
                    artifactIds: [begun.artifactId],
                  },
                });
                assert.deepEqual(
                  yield* supervisor.execute(
                    agent,
                    ref,
                    fence,
                    evaluateCommand(
                      "tab-1",
                      tab.documentId,
                      "() => { const f = document.querySelector('input').files[0]; return f.name + ':' + f.size; }",
                    ),
                  ),
                  { value: `notes.txt:${payload.length}` },
                );

                // A download: the page saves a file, the engine announces it, and its bytes stream out.
                const events = yield* supervisor.events(viewer, ref);
                const announced = yield* Deferred.make<{ artifactId: string; sha256: string }>();
                yield* events.pipe(
                  Stream.runForEach((event) => {
                    const named = event as { name?: string; artifact?: never };
                    return named.name === "download"
                      ? Deferred.succeed(
                          announced,
                          (event as unknown as { artifact: { artifactId: string; sha256: string } })
                            .artifact,
                        )
                      : Effect.void;
                  }),
                  Effect.forkScoped,
                );
                yield* supervisor.execute(
                  agent,
                  ref,
                  fence,
                  evaluateCommand(
                    "tab-1",
                    tab.documentId,
                    "() => document.querySelector('a').click()",
                  ),
                );
                const artifact = yield* Deferred.await(announced);
                const chunk = (yield* supervisor.scoped(agent, ref, {
                  kind: "downloadRead",
                  caller: callerContext,
                  artifactId: artifact.artifactId,
                  offset: 0,
                  length: 1024,
                })) as { bytesBase64: string; eof: boolean };
                const bytes = Buffer.from(chunk.bytesBase64, "base64");
                assert.equal(bytes.toString(), "download payload");
                assert.equal(chunk.eof, true);
                assert.equal(
                  NodeCryptoHash.createHash("sha256").update(bytes).digest("hex"),
                  artifact.sha256,
                );

                // Another caller's scope cannot read what this one downloaded.
                const other = yield* supervisor
                  .scoped(agent, ref, {
                    kind: "downloadRead",
                    caller: { ...callerContext, threadId: "someone-elses-thread" },
                    artifactId: artifact.artifactId,
                    offset: 0,
                    length: 1024,
                  })
                  .pipe(Effect.exit);
                assert.equal(channelCode(other).code, "not_found");
              }),
            );
          }),
        ),
      REAL,
    );

    it.live(
      "a viewer receives frames, at most two ahead of its acknowledgements, and stops on unsubscribe",
      () =>
        withRealEngine({}, (supervisor) =>
          Effect.gen(function* () {
            const ref = yield* supervisor.ensure(descriptor);
            const tab = yield* openTab(
              supervisor,
              ref,
              "tab-1",
              "data:text/html,<body style='background:teal'><h1 id=n>0</h1><script>let n=0;setInterval(()=>{document.getElementById('n').textContent=++n},50)</script>",
            );
            const frames: Array<{ frameId: number; width: number; bytesBase64: string }> = [];
            const events = yield* supervisor.events(viewer, ref);
            yield* events.pipe(
              Stream.runForEach((event) =>
                (event as { name?: string }).name === "frame"
                  ? Effect.sync(() => frames.push(event as unknown as (typeof frames)[number]))
                  : Effect.void,
              ),
              Effect.forkScoped,
            );
            const subscribe = {
              kind: "subscribe" as const,
              caller: callerContext,
              tabId: "tab-1",
              subscriptionId: "viewer-1",
              surface: "page" as const,
              maxFps: 20,
              maxWidth: 640,
              maxHeight: 400,
            };
            assert.deepEqual(yield* supervisor.scoped(viewer, ref, subscribe), {
              subscriptionId: "viewer-1",
            });
            yield* Effect.sleep("1500 millis");
            // Unacknowledged, the engine holds the viewer to two frames.
            assert.equal(frames.length, 2);
            assert.isAbove(Buffer.from(frames[0]!.bytesBase64, "base64").length, 100);

            yield* supervisor.scoped(viewer, ref, {
              kind: "ack",
              caller: callerContext,
              subscriptionId: "viewer-1",
              frameId: frames[0]!.frameId,
            });
            yield* Effect.sleep("800 millis");
            assert.isAtLeast(frames.length, 3);

            yield* supervisor.scoped(viewer, ref, {
              kind: "unsubscribe",
              caller: callerContext,
              subscriptionId: "viewer-1",
            });
            const settled = frames.length;
            yield* Effect.sleep("800 millis");
            assert.isAtMost(frames.length, settled + 1);
            // The page is still there: disconnecting a viewer closes nothing.
            const { fence } = yield* supervisor.state(ref);
            assert.deepEqual(
              yield* supervisor.execute(
                agent,
                ref,
                fence,
                evaluateCommand("tab-1", tab.documentId, "() => 'alive'"),
              ),
              { value: "alive" },
            );
          }),
        ),
      REAL,
    );

    it.live(
      "cookies and local storage survive a maintenance restart of the child, in the same profile",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { origin } = yield* serve((_request, response) => {
              response.setHeader("Content-Type", "text/html");
              response.end("<h1>origin</h1>");
            });
            const dataRoot = makeDataRoot();
            return yield* withRealEngine({ dataRoot }, (supervisor) =>
              Effect.gen(function* () {
                const first = yield* supervisor.ensure(descriptor);
                const tab = yield* openTab(supervisor, first, "tab-1", origin);
                const { fence } = yield* supervisor.state(first);
                yield* supervisor.execute(
                  agent,
                  first,
                  fence,
                  evaluateCommand(
                    "tab-1",
                    tab.documentId,
                    "() => { document.cookie = 'keep=yes; max-age=3600'; localStorage.setItem('k', 'v'); return true; }",
                  ),
                );
                yield* supervisor.execute(agent, first, fence, {
                  kind: "closeTab",
                  caller: callerContext,
                  tabId: "tab-1",
                });

                const token = yield* supervisor.beginMaintenance(descriptor.instanceId);
                const second = yield* supervisor.restart(descriptor.instanceId, token);
                yield* supervisor.endMaintenance(descriptor.instanceId, token);
                assert.notEqual(second.incarnation, first.incarnation);

                const reopened = yield* openTab(supervisor, second, "tab-1", origin);
                const state = yield* supervisor.state(second);
                assert.deepEqual(
                  yield* supervisor.execute(
                    agent,
                    second,
                    state.fence,
                    evaluateCommand(
                      "tab-1",
                      reopened.documentId,
                      "() => ({ cookie: document.cookie, local: localStorage.getItem('k') })",
                    ),
                  ),
                  { value: { cookie: "keep=yes", local: "v" } },
                );
                // The first browser's reference is stale, not silently redirected to the second.
                const stale = yield* supervisor.state(first).pipe(Effect.exit);
                assert.equal(failureOf(stale)?._tag, "ManagedBrowserStaleIncarnationError");
              }),
            );
          }),
        ),
      REAL,
    );
  },
);
