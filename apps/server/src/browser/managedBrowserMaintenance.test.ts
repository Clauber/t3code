// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  EnvironmentId,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserPrincipalId,
  ManagedBrowserProfileId,
  type ManagedBrowserPrincipal,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";
import * as Maintenance from "./managedBrowserMaintenance.ts";

const ownerEnvironmentId = EnvironmentId.make("env-owner");
const descriptor = (name: string) => ({
  ownerEnvironmentId,
  instanceId: ManagedBrowserInstanceId.make(`instance-${name}`),
  profileId: ManagedBrowserProfileId.make(`profile-${name}`),
});
const human: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("human-1"),
  kind: "human",
  access: "operate",
};
const agent: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("agent-1"),
  kind: "agent",
  access: "operate",
};

const makeLauncher = Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<string>>([]);
  const busyReasons = yield* Ref.make<ReadonlyArray<string>>([]);
  /** A launch of an instance named here does not finish until its gate opens. */
  const gates = new Map<string, Deferred.Deferred<void>>();
  const record = (event: string) => Ref.update(events, (current) => [...current, event]);
  const launcher = ManagedBrowserSupervisor.ManagedBrowserChildLauncher.of({
    launch: Effect.fnUntraced(function* (spec) {
      yield* record(`launch ${spec.instanceId}`);
      const gate = gates.get(spec.instanceId);
      if (gate !== undefined) yield* Deferred.await(gate);
      const exit = yield* Deferred.make<ManagedBrowserSupervisor.ManagedBrowserChildExit>();
      yield* Effect.addFinalizer(() =>
        record(`close ${spec.instanceId}`).pipe(
          Effect.andThen(Deferred.succeed(exit, { clean: true })),
        ),
      );
      return {
        execute: (request) => Effect.succeed({ value: request.operation, pending: undefined }),
        setGeneration: () => Effect.void,
        releaseInput: Effect.void,
        scoped: () => Effect.succeed(undefined as unknown),
        events: Stream.empty,
        quiesce: () =>
          Ref.get(busyReasons).pipe(
            Effect.map((reasons) => ({ idle: reasons.length === 0, reasons })),
          ),
        exit: Deferred.await(exit),
      } satisfies ManagedBrowserSupervisor.ManagedBrowserChild;
    }),
  });
  return { events, busyReasons, gates, launcher };
});

const withSupervisor = <A, E>(
  body: (context: {
    readonly events: Ref.Ref<ReadonlyArray<string>>;
    readonly busyReasons: Ref.Ref<ReadonlyArray<string>>;
    readonly gates: Map<string, Deferred.Deferred<void>>;
    readonly supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];
    readonly gate: Maintenance.OuterUpdateGate["Service"];
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeLauncher;
    const supervisor = ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
      Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ManagedBrowserSupervisor.ManagedBrowserChildLauncher, harness.launcher),
          NodeCrypto.layer,
        ),
      ),
    );
    const layer = Maintenance.gateLayer.pipe(Layer.provideMerge(supervisor));
    return yield* Effect.gen(function* () {
      return yield* body({
        events: harness.events,
        busyReasons: harness.busyReasons,
        gates: harness.gates,
        supervisor: yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor,
        gate: yield* Maintenance.OuterUpdateGate,
      });
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

const reasonsOf = <A>(exit: { readonly _tag: string } & A) =>
  (
    exit as unknown as {
      cause?: { reasons: Array<{ _tag: string; error?: { reasons?: string[] } }> };
    }
  ).cause?.reasons.find((reason) => reason._tag === "Fail")?.error?.reasons ?? [];

describe("draining every managed browser", () => {
  it.effect(
    "claims all instances, replaces each child after its predecessor exits, and reopens on release",
    () =>
      withSupervisor(({ events, supervisor }) =>
        Effect.gen(function* () {
          yield* supervisor.ensure(descriptor("a"));
          yield* supervisor.ensure(descriptor("b"));
          const claims = yield* Maintenance.drain(supervisor);
          assert.equal(claims.claimed.length, 2);
          // While claimed, no launch or call is admitted.
          const refused = yield* Effect.exit(supervisor.ensure(descriptor("a")));
          assert.equal(refused._tag, "Failure");
          yield* claims.restartAll;
          yield* claims.release;
          yield* claims.release;
          const log = yield* Ref.get(events);
          for (const name of ["a", "b"]) {
            assert.isAbove(
              log.lastIndexOf(`launch instance-${name}`),
              log.indexOf(`close instance-${name}`),
            );
          }
          const live = yield* supervisor.ensure(descriptor("a"));
          const { fence } = yield* supervisor.state(live);
          assert.equal(yield* supervisor.execute(agent, live, fence, "click"), "click");
        }),
      ),
  );

  it.effect(
    "claims all or none: a person on the second instance restores the first and stops nothing",
    () =>
      withSupervisor(({ events, supervisor }) =>
        Effect.gen(function* () {
          const first = yield* supervisor.ensure(descriptor("a"));
          const second = yield* supervisor.ensure(descriptor("b"));
          yield* supervisor.takeControl(human, second);
          const exit = yield* Effect.exit(Maintenance.drain(supervisor));
          assert.equal(exit._tag, "Failure");
          assert.deepEqual(reasonsOf(exit), ["human"]);
          assert.notInclude((yield* Ref.get(events)).join(","), "close");
          const { fence } = yield* supervisor.state(first);
          assert.equal(yield* supervisor.execute(agent, first, fence, "click"), "click");
        }),
      ),
  );

  it.effect("reports what the child itself is still doing", () =>
    withSupervisor(({ busyReasons, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor("a"));
        yield* Ref.set(busyReasons, ["uploads", "dialogs"]);
        const exit = yield* Effect.exit(Maintenance.drain(supervisor));
        assert.deepEqual(reasonsOf(exit), ["uploads", "dialogs"]);
      }),
    ),
  );

  it.effect("a maintenance already in progress is reported as an update in progress", () =>
    withSupervisor(({ supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor("a"));
        const claims = yield* Maintenance.drain(supervisor);
        const exit = yield* Effect.exit(Maintenance.drain(supervisor));
        assert.deepEqual(reasonsOf(exit), ["updateInProgress"]);
        yield* claims.release;
      }),
    ),
  );
});

describe("one barrier over the whole supervisor", () => {
  it.effect("refuses a launch that arrives between taking the barrier and listing instances", () =>
    withSupervisor(({ events, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor("a"));
        let late: Exit.Exit<unknown, unknown> | null = null;
        const racing = {
          ...supervisor,
          instances: Effect.gen(function* () {
            // A caller that never launched anything before asks for a browser at the worst moment.
            late = yield* Effect.exit(supervisor.ensure(descriptor("late")));
            return yield* supervisor.instances;
          }),
        };
        const claims = yield* Maintenance.drain(racing);
        assert.equal(
          late === null ? "unset" : (late as Exit.Exit<unknown, unknown>)._tag,
          "Failure",
        );
        assert.notInclude((yield* Ref.get(events)).join(","), "launch instance-late");
        yield* claims.release;
        assert.isDefined(yield* supervisor.ensure(descriptor("late")));
      }),
    ),
  );

  it.effect("rejects a never-seen instance for as long as the claims are held", () =>
    withSupervisor(({ supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor("a"));
        const claims = yield* Maintenance.drain(supervisor);
        const refused = yield* Effect.exit(supervisor.ensure(descriptor("new")));
        assert.equal(refused._tag, "Failure");
        yield* claims.restartAll;
        assert.equal((yield* Effect.exit(supervisor.ensure(descriptor("new"))))._tag, "Failure");
        yield* claims.release;
        assert.isDefined(yield* supervisor.ensure(descriptor("new")));
      }),
    ),
  );

  it.effect("cancelling the claim releases the partial claims and the barrier", () =>
    withSupervisor(({ gates, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor("a"));
        // The second instance is still launching, so claiming it waits.
        gates.set("instance-b", yield* Deferred.make<void>());
        const launching = yield* Effect.forkChild(supervisor.ensure(descriptor("b")));
        yield* Effect.yieldNow;
        const draining = yield* Effect.forkChild(Maintenance.drain(supervisor));
        // Wait until the first instance is claimed: the drain is parked on the second.
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const exit = yield* Effect.exit(supervisor.ensure(descriptor("a")));
          if (exit._tag === "Failure") break;
          yield* Effect.yieldNow;
        }
        assert.equal((yield* Effect.exit(supervisor.ensure(descriptor("a"))))._tag, "Failure");
        yield* Fiber.interrupt(draining);
        yield* Deferred.succeed(gates.get("instance-b")!, undefined);
        yield* Fiber.join(launching);
        // Nothing stays claimed and the barrier is gone.
        assert.isDefined(yield* supervisor.ensure(descriptor("a")));
        assert.isDefined(yield* supervisor.ensure(descriptor("c")));
      }),
    ),
  );
});

describe("the gate an update of T3 itself takes", () => {
  it.effect("an accepted hold keeps refusing instances nobody has launched before", () =>
    withSupervisor(({ gate, supervisor }) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(descriptor("a"));
        yield* gate.hold;
        // The outer update was accepted: nothing releases the hold, so even a new instance is refused.
        assert.equal((yield* Effect.exit(supervisor.ensure(descriptor("new"))))._tag, "Failure");
      }),
    ),
  );

  it.effect("keeps admission closed while held and refuses a busy browser", () =>
    withSupervisor(({ gate, supervisor, busyReasons }) =>
      Effect.gen(function* () {
        const live = yield* supervisor.ensure(descriptor("a"));
        const { fence } = yield* supervisor.state(live);
        const hold = yield* gate.hold;
        const during = yield* Effect.exit(supervisor.execute(agent, live, fence, "click"));
        assert.equal(during._tag, "Failure");
        yield* hold.release;
        assert.equal(yield* supervisor.execute(agent, live, fence, "click"), "click");

        yield* Ref.set(busyReasons, ["navigations"]);
        const busy = yield* Effect.exit(gate.hold);
        assert.deepEqual(reasonsOf(busy), ["navigations"]);
      }),
    ),
  );
});

describe("the marker `t3 update` reads", () => {
  const markerDirectory = () => FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-marker-"));

  it.effect(
    "exists exactly while the server hosts managed browsers, and only for a live server",
    () =>
      Effect.gen(function* () {
        const marker = Maintenance.hostingMarkerPath(markerDirectory());
        assert.isFalse(Maintenance.managedBrowserHosted(marker));
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Maintenance.publishHostingMarker(marker);
            assert.isTrue(Maintenance.managedBrowserHosted(marker));
          }),
        );
        assert.isFalse(Maintenance.managedBrowserHosted(marker));
        assert.isFalse(FS.existsSync(marker));
      }),
  );

  it("is ignored when its server is gone or it says nothing is hosted, and only then", () => {
    const marker = Maintenance.hostingMarkerPath(markerDirectory());
    // Only a marker that is actually absent means nothing is hosted.
    assert.isFalse(Maintenance.managedBrowserHosted(marker));
    FS.mkdirSync(Path.dirname(marker), { recursive: true });
    FS.writeFileSync(marker, JSON.stringify({ pid: 2147483646, hosting: true }));
    assert.isFalse(Maintenance.managedBrowserHosted(marker));
    FS.writeFileSync(marker, JSON.stringify({ pid: process.pid, hosting: false }));
    assert.isFalse(Maintenance.managedBrowserHosted(marker));
    FS.writeFileSync(marker, JSON.stringify({ pid: process.pid, hosting: true }));
    assert.isTrue(Maintenance.managedBrowserHosted(marker));
  });

  it("is conservative when it exists but cannot be read or understood", () => {
    const marker = Maintenance.hostingMarkerPath(markerDirectory());
    FS.mkdirSync(Path.dirname(marker), { recursive: true });
    for (const content of ["not json", "null", "[]", "{}", JSON.stringify({ hosting: true })]) {
      FS.writeFileSync(marker, content);
      assert.isTrue(Maintenance.managedBrowserHosted(marker), content);
    }
    // Present but unreadable as a file.
    FS.rmSync(marker);
    FS.mkdirSync(marker);
    assert.isTrue(Maintenance.managedBrowserHosted(marker));
  });

  it.effect("is never reported as published when it could not be written", () =>
    Effect.gen(function* () {
      const marker = Maintenance.hostingMarkerPath(markerDirectory());
      // A directory where the file must go: the engine and profile directory stay usable.
      FS.mkdirSync(marker, { recursive: true });
      const exit = yield* Effect.exit(Effect.scoped(Maintenance.publishHostingMarker(marker)));
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(
        FS.readdirSync(Path.dirname(marker)).filter((name) => name.endsWith(".tmp")),
        [],
      );
    }),
  );
});
