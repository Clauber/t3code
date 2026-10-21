// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off anyUnknownInErrorContext:off
/**
 * The viewer protocol at the engine boundary: which surface a person is shown, what their input
 * becomes, and what they are told about who holds control.
 *
 * The engine is a recording stand-in, so what these tests assert is exactly what reached it. No real
 * desktop exists here (its display tools are not installed), so nothing below claims a real window was
 * captured; it proves T3 asks for the whole window only when the engine said it can, asks with a frame
 * size the engine will accept, never touches focus, and drops nothing silently.
 */
import * as Path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  EnvironmentId,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
} from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import type { ServerBrowserViewerOutput } from "../preview/ServerBrowser.ts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRegistry from "./ManagedBrowserRegistry.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

const owner = EnvironmentId.make("env-owner");
const binding = {
  ownerEnvironmentId: owner,
  instanceId: ManagedBrowserInstanceId.make("instance-1"),
  profileId: ManagedBrowserProfileId.make("profile-1"),
};
const admin = { sessionId: "session-admin", administrator: true };
const agentSession = `${owner}\u0000agent-1`;

interface Recorded {
  readonly scoped: Array<Record<string, unknown>>;
  readonly executed: Array<Record<string, unknown>>;
}

/** An engine that answers the few commands a viewer causes, and records every one. */
const fakeEngine = (capabilities: ReadonlyArray<string>, reject: ReadonlySet<string> = new Set()) =>
  Effect.gen(function* () {
    const recorded: Recorded = { scoped: [], executed: [] };
    const events = yield* PubSub.unbounded<unknown>();
    const exit = yield* Deferred.make<ManagedBrowserSupervisor.ManagedBrowserChildExit>();
    const launcher = ManagedBrowserSupervisor.ManagedBrowserChildLauncher.of({
      launch: () =>
        Effect.succeed({
          capabilities,
          execute: (request) =>
            Effect.sync(() => {
              const operation = request.operation as Record<string, unknown>;
              recorded.executed.push(operation);
              const value =
                operation.kind === "open" || operation.kind === "attach"
                  ? { documentId: "doc-1", url: "about:blank", title: "" }
                  : { documentId: "doc-1" };
              return { value, pending: undefined };
            }),
          setGeneration: () => Effect.void,
          releaseInput: Effect.void,
          scoped: (request) => {
            const operation = request.operation as Record<string, unknown>;
            recorded.scoped.push(operation);
            const key = `${String(operation.kind)}:${String(operation.surface ?? "")}`;
            return reject.has(key)
              ? Effect.fail(
                  new ManagedBrowserSupervisor.ManagedBrowserChildChannelError({
                    instanceId: request.ref.instanceId,
                    cause: new Error("unsupported"),
                  }),
                )
              : Effect.succeed({} as unknown);
          },
          events: Stream.fromPubSub(events),
          quiesce: () => Effect.succeed({ idle: true, reasons: [] }),
          exit: Deferred.await(exit),
        } satisfies ManagedBrowserSupervisor.ManagedBrowserChild),
    });
    return { recorded, events, launcher };
  });

const withViewerAdapter = <A, E>(
  capabilities: ReadonlyArray<string>,
  body: (services: {
    readonly adapter: ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"];
    readonly supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];
    readonly recorded: Recorded;
    readonly events: PubSub.PubSub<unknown>;
    readonly tabId: string;
    readonly attach: (
      overrides?: Partial<
        Parameters<
          ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"]["attachViewer"]
        >[0]
      >,
    ) => Effect.Effect<Viewer, unknown, Scope.Scope>;
  }) => Effect.Effect<A, E, Scope.Scope>,
  options: {
    readonly reject?: ReadonlySet<string>;
    readonly fullWindow?: { readonly available: boolean; readonly reason?: string };
  } = {},
) =>
  Effect.gen(function* () {
    const engine = yield* fakeEngine(capabilities, options.reject);
    const supervisorLayer = ManagedBrowserSupervisor.layer({ ownerEnvironmentId: owner }).pipe(
      Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ManagedBrowserSupervisor.ManagedBrowserChildLauncher, engine.launcher),
          NodeCrypto.layer,
        ),
      ),
    );
    const surroundings = Layer.mergeAll(
      Layer.provide(PreviewManager.layer, NodeCrypto.layer),
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(owner),
        getDescriptor: Effect.die("unused descriptor"),
      }),
      NodeServices.layer,
      NodeCrypto.layer,
    );
    const registry = ManagedBrowserRegistry.make(null);
    const adapterLayer = ManagedBrowserPreviewAdapter.layer({
      registry,
      ...(options.fullWindow === undefined ? {} : { fullWindow: options.fullWindow }),
    }).pipe(Layer.provide(Layer.mergeAll(supervisorLayer, surroundings)));
    const layer = Layer.mergeAll(adapterLayer, supervisorLayer, surroundings);
    return yield* Effect.gen(function* () {
      const adapter = yield* ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter;
      const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
      const status = (yield* adapter.handle({
        requestId: "open",
        threadId: "thread-1" as never,
        agentSessionId: agentSession,
        callerEnvironmentId: owner,
        operation: "open",
        input: { browserBinding: binding, open: false },
        timeoutMs: 15_000,
      })) as { tabId: string };
      const attach = (
        overrides: Partial<
          Parameters<
            ManagedBrowserPreviewAdapter.ManagedBrowserPreviewAdapter["Service"]["attachViewer"]
          >[0]
        > = {},
      ) =>
        adapter.attachViewer({
          threadId: "thread-1",
          tabId: status.tabId,
          maxWidth: 800,
          maxHeight: 600,
          canOperate: true,
          viewer: admin,
          ...overrides,
        });
      return yield* body({
        adapter,
        supervisor,
        recorded: engine.recorded,
        events: engine.events,
        tabId: status.tabId,
        attach,
      });
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.scoped);

type Viewer = {
  readonly output: Queue.Dequeue<ServerBrowserViewerOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
};

/** Everything queued so far, without waiting for more. */
const drain = (viewer: Viewer) =>
  Effect.gen(function* () {
    const taken: Array<ServerBrowserViewerOutput> = [];
    for (;;) {
      const next = yield* Queue.poll(viewer.output);
      if (next._tag === "None") return taken;
      taken.push(next.value);
    }
  });

/** A frame event as the engine writes it, complete enough to pass the launcher's own validation. */
const frameEvent = (
  subscribedAs: unknown,
  size: { readonly width: number; readonly height: number },
  incarnation: string,
  engineTabId: string,
  frameId = 1,
) => ({
  protocolVersion: 1,
  kind: "event",
  incarnation,
  sequence: frameId,
  name: "frame",
  resource: { instanceId: binding.instanceId, profileId: binding.profileId },
  caller: { environmentId: owner, threadId: "thread-1", agentSessionId: "agent-1" },
  ref: {
    instanceId: binding.instanceId,
    profileId: binding.profileId,
    tabId: engineTabId,
    incarnation,
  },
  subscriptionId: subscribedAs,
  frameId,
  mimeType: "image/jpeg",
  ...size,
  bytesBase64: Buffer.from("jpeg").toString("base64"),
});

const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });

const subscribes = (recorded: Recorded) =>
  recorded.scoped.filter((operation) => operation.kind === "subscribe");

describe("which surface a viewer is shown", () => {
  it.effect("starts on the page, and says plainly that the whole window is not on offer", () =>
    withViewerAdapter(
      ["open", "execute"],
      ({ attach, recorded }) =>
        Effect.gen(function* () {
          const viewer = yield* attach();
          yield* settle;
          assert.deepEqual(
            subscribes(recorded).map((operation) => operation.surface),
            ["page"],
          );
          const surface = (yield* drain(viewer)).find((message) => message._tag === "surface");
          assert.equal(surface?._tag, "surface");
          if (surface?._tag !== "surface") return;
          assert.equal(surface.current, "page");
          assert.equal(surface.window.available, false);
          assert.match(surface.window.reason ?? "", /Page view is available|not available/);
        }),
      {
        fullWindow: {
          available: false,
          reason: "Full window view is turned off. Page view is available.",
        },
      },
    ),
  );

  it.effect(
    "asks the engine for the whole window only when it advertised full-window, at a size it accepts",
    () =>
      withViewerAdapter(["open", "execute", "full-window"], ({ attach, recorded, supervisor }) =>
        Effect.gen(function* () {
          const viewer = yield* attach({ maxWidth: 800, maxHeight: 600 });
          yield* settle;
          const initial = (yield* drain(viewer)).find((message) => message._tag === "surface");
          assert.equal(initial?._tag === "surface" && initial.window.available, true);
          yield* viewer.input({ type: "surface", surface: "window" });
          yield* settle;
          const [page, window] = subscribes(recorded);
          assert.equal(page?.surface, "page");
          assert.equal(window?.surface, "window");
          // The engine refuses a window smaller than its desktop, so a small viewer still asks for all of it.
          assert.isAtLeast(window?.maxWidth as number, 1280);
          assert.isAtLeast(window?.maxHeight as number, 720);
          // Different subscriptions, so a late page frame is never painted as the window.
          assert.notEqual(page?.subscriptionId, window?.subscriptionId);
          const messages = yield* drain(viewer);
          const current = messages.filter((message) => message._tag === "surface").at(-1);
          assert.equal(current?._tag === "surface" && current.current, "window");
          // The page behind the window is unsubscribed so one viewer is never streaming twice.
          assert.deepEqual(
            recorded.scoped
              .filter((operation) => operation.kind === "unsubscribe")
              .map((operation) => operation.subscriptionId),
            [page?.subscriptionId],
          );
          assert.isDefined(supervisor);
        }),
      ),
  );

  it.effect("never moves the browser's focus or touches the page to show a window", () =>
    withViewerAdapter(["open", "execute", "full-window"], ({ attach, recorded }) =>
      Effect.gen(function* () {
        const viewer = yield* attach();
        yield* settle;
        const before = recorded.executed.length;
        yield* viewer.input({ type: "surface", surface: "window" });
        yield* settle;
        // Subscribing is scoped and unfenced; nothing was executed in the page by switching.
        assert.equal(recorded.executed.length, before);
      }),
    ),
  );

  it.effect(
    "keeps a page viewer on the page, with the reason, when the engine cannot show the window",
    () =>
      withViewerAdapter(["open", "execute"], ({ attach, recorded }) =>
        Effect.gen(function* () {
          const viewer = yield* attach();
          yield* settle;
          yield* drain(viewer);
          yield* viewer.input({ type: "surface", surface: "window" });
          yield* settle;
          assert.deepEqual(
            subscribes(recorded).map((operation) => operation.surface),
            ["page"],
          );
          const messages = yield* drain(viewer);
          const rejected = messages.find((message) => message._tag === "rejected");
          assert.equal(rejected?._tag, "rejected");
          const current = messages.filter((message) => message._tag === "surface").at(-1);
          assert.equal(current?._tag === "surface" && current.current, "page");
        }),
      ),
  );

  it.effect("stays on the page when the engine refuses the window after advertising it", () =>
    withViewerAdapter(
      ["open", "execute", "full-window"],
      ({ attach, recorded }) =>
        Effect.gen(function* () {
          const viewer = yield* attach();
          yield* settle;
          yield* drain(viewer);
          yield* viewer.input({ type: "surface", surface: "window" });
          yield* settle;
          const messages = yield* drain(viewer);
          assert.isTrue(messages.some((message) => message._tag === "rejected"));
          const current = messages.filter((message) => message._tag === "surface").at(-1);
          assert.equal(current?._tag === "surface" && current.current, "page");
          // The page subscription was never dropped, so the viewer still sees something.
          assert.deepEqual(
            recorded.scoped.filter((operation) => operation.kind === "unsubscribe"),
            [],
          );
        }),
      { reject: new Set(["subscribe:window"]) },
    ),
  );

  it.effect("lets a read-only viewer change what it watches, but not what it can do", () =>
    withViewerAdapter(["open", "execute", "full-window"], ({ attach, recorded }) =>
      Effect.gen(function* () {
        const viewer = yield* attach({ canOperate: false });
        yield* settle;
        yield* viewer.input({ type: "surface", surface: "window" });
        yield* settle;
        assert.deepEqual(
          subscribes(recorded).map((operation) => operation.surface),
          ["page", "window"],
        );
        yield* viewer.input({ type: "takeControl" });
        yield* settle;
        assert.deepEqual(
          recorded.executed.filter((operation) => operation.kind === "viewerInput"),
          [],
        );
      }),
    ),
  );
});

describe("what a person's input becomes in the whole window", () => {
  const takeWindow = (attach: () => Effect.Effect<Viewer, unknown, Scope.Scope>) =>
    Effect.gen(function* () {
      const viewer = yield* attach();
      yield* settle;
      yield* viewer.input({ type: "surface", surface: "window" });
      yield* settle;
      yield* viewer.input({ type: "takeControl" });
      yield* settle;
      return viewer;
    });

  const inputs = (recorded: Recorded) =>
    recorded.executed.filter((operation) => operation.kind === "viewerInput");

  it.effect(
    "sends pointer, wheel and named keys through the fenced input of the window subscription",
    () =>
      withViewerAdapter(["open", "execute", "full-window"], ({ attach, recorded }) =>
        Effect.gen(function* () {
          const viewer = yield* takeWindow(() => attach());
          yield* viewer.input({ type: "mouse", action: "down", x: 640, y: 360, button: "left" });
          yield* viewer.input({ type: "key", action: "down", key: "Enter", code: "Enter" });
          yield* viewer.input({ type: "key", action: "down", key: "a", code: "KeyA" });
          yield* viewer.input({ type: "key", action: "down", key: "F5", code: "F5" });
          yield* settle;
          const window = subscribes(recorded).find((operation) => operation.surface === "window");
          const sent = inputs(recorded);
          assert.deepEqual(
            sent.map((operation) => (operation.input as { name: string }).name),
            ["pointer", "key", "key", "key"],
          );
          assert.isTrue(
            sent.every((operation) => operation.subscriptionId === window?.subscriptionId),
          );
          assert.deepEqual(sent[0]?.input, {
            name: "pointer",
            action: "down",
            x: 640,
            y: 360,
            button: "left",
          });
        }),
      ),
  );

  it.effect("sends a printable character the engine has no key name for as text, once", () =>
    withViewerAdapter(["open", "execute", "full-window"], ({ attach, recorded }) =>
      Effect.gen(function* () {
        const viewer = yield* takeWindow(() => attach());
        yield* viewer.input({ type: "key", action: "down", key: "@", code: "Digit2", text: "@" });
        yield* viewer.input({ type: "key", action: "up", key: "@", code: "Digit2" });
        yield* viewer.input({ type: "key", action: "down", key: "é", code: "", text: "é" });
        yield* settle;
        assert.deepEqual(
          inputs(recorded).map((operation) => operation.input),
          [
            { name: "text", text: "@" },
            { name: "text", text: "é" },
          ],
        );
      }),
    ),
  );

  it.effect(
    "says so for a key the window cannot type, instead of sending a command it would reject",
    () =>
      withViewerAdapter(["open", "execute", "full-window"], ({ attach, recorded }) =>
        Effect.gen(function* () {
          const viewer = yield* takeWindow(() => attach());
          yield* drain(viewer);
          yield* viewer.input({ type: "key", action: "down", key: "CapsLock", code: "CapsLock" });
          yield* settle;
          assert.deepEqual(inputs(recorded), []);
          assert.isTrue((yield* drain(viewer)).some((message) => message._tag === "rejected"));
        }),
      ),
  );

  it.effect(
    "does not resize a window that has a fixed size, and does not report that as a failure",
    () =>
      withViewerAdapter(["open", "execute", "full-window"], ({ attach, recorded }) =>
        Effect.gen(function* () {
          const viewer = yield* takeWindow(() => attach());
          yield* drain(viewer);
          yield* viewer.input({ type: "resize", width: 390, height: 700 });
          yield* settle;
          assert.deepEqual(inputs(recorded), []);
          assert.deepEqual(
            (yield* drain(viewer)).filter((message) => message._tag === "rejected"),
            [],
          );
        }),
      ),
  );

  it.effect(
    "treats every tap as one that may take text, because the page under a window point is unknown",
    () =>
      withViewerAdapter(["open", "execute", "full-window"], ({ attach }) =>
        Effect.gen(function* () {
          const viewer = yield* takeWindow(() => attach());
          yield* drain(viewer);
          yield* viewer.input({ type: "probe", x: 100, y: 100 });
          yield* settle;
          const probe = (yield* drain(viewer)).find((message) => message._tag === "probe");
          assert.deepEqual(probe, { _tag: "probe", x: 100, y: 100, editable: true });
        }),
      ),
  );

  it.effect("reports the window's own size as the coordinate space from its frames", () =>
    withViewerAdapter(["open", "execute", "full-window"], ({ adapter, attach, events, recorded }) =>
      Effect.gen(function* () {
        const viewer = yield* takeWindow(() => attach());
        yield* drain(viewer);
        const window = subscribes(recorded).find((operation) => operation.surface === "window");
        const row = (yield* adapter.directory).tabs[0]!;
        yield* PubSub.publish(
          events,
          frameEvent(
            window?.subscriptionId,
            { width: 1280, height: 720 },
            row.incarnation,
            row.engineTabId,
          ),
        );
        yield* settle;
        const messages = yield* drain(viewer);
        assert.deepEqual(
          messages.find((message) => message._tag === "viewport"),
          { _tag: "viewport", width: 1280, height: 720 },
        );
        assert.isTrue(messages.some((message) => message._tag === "frame"));
      }),
    ),
  );

  it.effect("ignores a late frame of the page subscription once the window is shown", () =>
    withViewerAdapter(["open", "execute", "full-window"], ({ adapter, attach, events, recorded }) =>
      Effect.gen(function* () {
        const viewer = yield* takeWindow(() => attach());
        yield* drain(viewer);
        const page = subscribes(recorded).find((operation) => operation.surface === "page");
        const row = (yield* adapter.directory).tabs[0]!;
        yield* PubSub.publish(
          events,
          frameEvent(
            page?.subscriptionId,
            { width: 800, height: 600 },
            row.incarnation,
            row.engineTabId,
            7,
          ),
        );
        yield* settle;
        assert.deepEqual(yield* drain(viewer), []);
      }),
    ),
  );
});

describe("who holds control, as each viewer is told", () => {
  type Attach = (
    overrides?: Record<string, unknown>,
  ) => Effect.Effect<Viewer, unknown, Scope.Scope>;

  /** A viewer that can be disconnected on its own, as a closed socket would. */
  const connection = (attach: Attach, overrides: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const viewer = yield* attach(overrides).pipe(Effect.provideService(Scope.Scope, scope));
      yield* settle;
      return {
        viewer,
        disconnect: Scope.close(scope, { _tag: "Success", value: undefined } as never),
      };
    });

  const lastControl = (viewer: Viewer) =>
    drain(viewer).pipe(
      Effect.map((messages) => messages.filter((message) => message._tag === "control").at(-1)),
    );

  it.effect(
    "tells the person whose control is held for a reconnect that it is theirs to resume",
    () =>
      withViewerAdapter(["open", "execute"], ({ attach }) =>
        Effect.gen(function* () {
          const first = yield* connection(attach, { viewerKey: "laptop" });
          yield* first.viewer.input({ type: "takeControl" });
          yield* settle;
          assert.equal((yield* lastControl(first.viewer))?.controller, "you");
          yield* first.disconnect;
          yield* settle;
          // The same person, back on the same device: control waits for them rather than for a timeout.
          const back = yield* connection(attach, { viewerKey: "laptop" });
          const held = yield* lastControl(back.viewer);
          assert.equal(held?.controller, "held-for-you");
          assert.isAbove(held?.holdExpiresAtMs ?? 0, 0);
          yield* back.viewer.input({ type: "takeControl" });
          yield* settle;
          assert.equal((yield* lastControl(back.viewer))?.controller, "you");
        }),
      ),
  );

  it.effect(
    "tells everyone else the browser is on hold for someone, then paused once the hold lapses",
    () =>
      withViewerAdapter(["open", "execute"], ({ attach }) =>
        Effect.gen(function* () {
          const first = yield* connection(attach, { viewerKey: "laptop" });
          yield* first.viewer.input({ type: "takeControl" });
          yield* settle;
          const watcher = yield* connection(attach, { viewerKey: "phone" });
          yield* drain(watcher.viewer);
          yield* first.disconnect;
          yield* settle;
          const held = yield* lastControl(watcher.viewer);
          assert.equal(held?.controller, "another-viewer");
          assert.isAbove(held?.holdExpiresAtMs ?? 0, 0);
          // Nobody may take it during the hold.
          yield* watcher.viewer.input({ type: "takeControl" });
          yield* settle;
          assert.isTrue(
            (yield* drain(watcher.viewer)).some((message) => message._tag === "rejected"),
          );
          yield* TestClock.adjust("31 seconds");
          yield* settle;
          const lapsed = yield* lastControl(watcher.viewer);
          assert.equal(lapsed?.controller, "paused");
          // And a person must take it again, explicitly; nothing hands it back by itself.
          yield* watcher.viewer.input({ type: "takeControl" });
          yield* settle;
          assert.equal((yield* lastControl(watcher.viewer))?.controller, "you");
        }),
      ),
  );

  it.effect("does not start a hold while another connection of the same person is still open", () =>
    withViewerAdapter(["open", "execute"], ({ attach }) =>
      Effect.gen(function* () {
        const one = yield* connection(attach, { viewerKey: "laptop" });
        const two = yield* connection(attach, { viewerKey: "laptop" });
        yield* one.viewer.input({ type: "takeControl" });
        yield* settle;
        yield* one.disconnect;
        yield* settle;
        yield* TestClock.adjust("31 seconds");
        yield* settle;
        assert.equal((yield* lastControl(two.viewer))?.controller, "you");
      }),
    ),
  );

  it.effect(
    "never lets one session resume another session's held control by naming the same device",
    () =>
      withViewerAdapter(["open", "execute"], ({ attach }) =>
        Effect.gen(function* () {
          const mine = yield* connection(attach, { viewerKey: "laptop" });
          yield* mine.viewer.input({ type: "takeControl" });
          yield* settle;
          yield* mine.disconnect;
          yield* settle;
          const other = yield* connection(attach, {
            viewerKey: "laptop",
            viewer: { sessionId: "session-other", administrator: true },
          });
          const seen = yield* lastControl(other.viewer);
          assert.equal(seen?.controller, "another-viewer");
          yield* other.viewer.input({ type: "takeControl" });
          yield* settle;
          assert.notEqual((yield* lastControl(other.viewer))?.controller, "you");
        }),
      ),
  );

  it.effect("calls a browser nobody may act in 'paused', not 'watching'", () =>
    withViewerAdapter(["open", "execute"], ({ attach }) =>
      Effect.gen(function* () {
        const one = yield* connection(attach, { viewerKey: "a" });
        yield* one.viewer.input({ type: "takeControl" });
        yield* settle;
        yield* one.disconnect;
        yield* TestClock.adjust("31 seconds");
        yield* settle;
        const watcher = yield* connection(attach, { viewerKey: "b" });
        assert.equal((yield* lastControl(watcher.viewer))?.controller, "paused");
      }),
    ),
  );
});
