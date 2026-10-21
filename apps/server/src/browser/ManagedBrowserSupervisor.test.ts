import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { EnvironmentId } from "@t3tools/contracts";
import {
  ManagedBrowserControlGeneration,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserMaintenanceToken,
  ManagedBrowserPrincipalId,
  ManagedBrowserProfileId,
  type ManagedBrowserControlState,
  type ManagedBrowserPrincipal,
  type ManagedBrowserRef,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

const ownerEnvironmentId = EnvironmentId.make("env-owner");
const instanceId = ManagedBrowserInstanceId.make("instance-a");
const profileId = ManagedBrowserProfileId.make("profile-a");
const otherProfileId = ManagedBrowserProfileId.make("profile-b");
const descriptor = { ownerEnvironmentId, instanceId, profileId };

const principal = (
  id: string,
  kind: ManagedBrowserPrincipal["kind"],
  access: ManagedBrowserPrincipal["access"] = "operate",
): ManagedBrowserPrincipal => ({ id: ManagedBrowserPrincipalId.make(id), kind, access });

const agent = principal("agent-1", "agent");
const readOnlyAgent = principal("agent-ro", "agent", "read");
const human = principal("human-1", "human");

interface FakeChild {
  readonly incarnation: string;
  readonly requests: Ref.Ref<ReadonlyArray<ManagedBrowserSupervisor.ManagedBrowserChildRequest>>;
  readonly exit: Deferred.Deferred<ManagedBrowserSupervisor.ManagedBrowserChildExit>;
  readonly inputReleases: Ref.Ref<number>;
  /** Every generation the supervisor told this child, in order. */
  readonly generations: Ref.Ref<ReadonlyArray<number>>;
  readonly scopedRequests: Ref.Ref<
    ReadonlyArray<ManagedBrowserSupervisor.ManagedBrowserChildScopedRequest>
  >;
  /** The admission each `quiesce` call asked for, in order. */
  readonly quiesceCalls: Ref.Ref<ReadonlyArray<boolean>>;
  readonly events: PubSub.PubSub<unknown>;
}

/** A launcher that records its lifecycle instead of spawning a process. */
const makeHarness = Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<string>>([]);
  const children = yield* Ref.make<ReadonlyArray<FakeChild>>([]);
  const launchGate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const closeGate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const failNextLaunch = yield* Ref.make(false);
  /** When set, a child does not acknowledge a new generation until the gate opens. */
  const generationGate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const navigationCommitted = yield* Deferred.make<void>();
  // A real promise the runtime cannot cancel, standing in for a call that is mid-flight in the child.
  let openOperation!: () => void;
  const operationPromise = new Promise<void>((resolve) => {
    openOperation = resolve;
  });
  const operationStarted = yield* Deferred.make<void>();
  /** What the children's `quiesce` reports: the reasons they are not idle, none meaning idle. */
  const busyReasons = yield* Ref.make<ReadonlyArray<string>>([]);
  /** When set, the next incarnation id is not minted until the gate opens. */
  const uuidGate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const record = (event: string) => Ref.update(events, (current) => [...current, event]);

  const launcher = ManagedBrowserSupervisor.ManagedBrowserChildLauncher.of({
    launch: Effect.fnUntraced(function* (spec) {
      yield* record(`launch ${spec.incarnation}`);
      const gate = yield* Ref.get(launchGate);
      if (gate !== null) yield* Deferred.await(gate);
      if (yield* Ref.get(failNextLaunch)) {
        return yield* new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({
          instanceId: spec.instanceId,
          cause: new Error("spawn failed"),
        });
      }
      const child: FakeChild = {
        incarnation: spec.incarnation,
        requests: yield* Ref.make<
          ReadonlyArray<ManagedBrowserSupervisor.ManagedBrowserChildRequest>
        >([]),
        exit: yield* Deferred.make<ManagedBrowserSupervisor.ManagedBrowserChildExit>(),
        inputReleases: yield* Ref.make(0),
        generations: yield* Ref.make<ReadonlyArray<number>>([]),
        scopedRequests: yield* Ref.make<
          ReadonlyArray<ManagedBrowserSupervisor.ManagedBrowserChildScopedRequest>
        >([]),
        quiesceCalls: yield* Ref.make<ReadonlyArray<boolean>>([]),
        events: yield* PubSub.unbounded<unknown>(),
      };
      yield* Ref.update(children, (current) => [...current, child]);
      yield* Effect.addFinalizer(() =>
        Ref.get(closeGate).pipe(
          Effect.flatMap((gate) => (gate === null ? Effect.void : Deferred.await(gate))),
          Effect.andThen(record(`close ${spec.incarnation}`)),
        ),
      );
      return {
        execute: (request) =>
          Ref.update(child.requests, (current) => [...current, request]).pipe(
            Effect.andThen(
              request.operation === "promise"
                ? Deferred.succeed(operationStarted, undefined).pipe(
                    Effect.andThen(Effect.promise(() => operationPromise)),
                    Effect.as({ value: "promise" as unknown, pending: undefined }),
                  )
                : Effect.succeed({
                    value: request.operation,
                    pending:
                      request.operation === "navigate"
                        ? Deferred.await(navigationCommitted)
                        : request.operation === "navigate-fails"
                          ? Effect.fail(
                              new ManagedBrowserSupervisor.ManagedBrowserChildChannelError({
                                instanceId: spec.instanceId,
                                cause: new Error("navigation lost"),
                              }),
                            )
                          : undefined,
                  }),
            ),
          ),
        setGeneration: (generation) =>
          Ref.get(generationGate).pipe(
            Effect.flatMap((gate) => (gate === null ? Effect.void : Deferred.await(gate))),
            Effect.andThen(Ref.update(child.generations, (current) => [...current, generation])),
          ),
        releaseInput: Ref.update(child.inputReleases, (count) => count + 1),
        scoped: (request) =>
          Ref.update(child.scopedRequests, (current) => [...current, request]).pipe(
            Effect.as({ answered: request.operation } as unknown),
          ),
        events: Stream.fromPubSub(child.events),
        quiesce: (closeAdmission) =>
          Ref.update(child.quiesceCalls, (current) => [...current, closeAdmission]).pipe(
            Effect.andThen(Ref.get(busyReasons)),
            Effect.map((reasons) => ({ idle: reasons.length === 0, reasons })),
          ),
        exit: Deferred.await(child.exit),
      } satisfies ManagedBrowserSupervisor.ManagedBrowserChild;
    }),
  });

  return {
    events,
    children,
    launchGate,
    closeGate,
    failNextLaunch,
    generationGate,
    navigationCommitted,
    openOperation,
    operationStarted,
    busyReasons,
    uuidGate,
    launcher,
  };
});

type Harness = Effect.Success<typeof makeHarness>;

/** Real crypto, except that a test may hold back the next id until it opens a gate. */
const gatedCrypto = (harness: Harness) =>
  Layer.effect(
    Crypto.Crypto,
    Effect.gen(function* () {
      const real = yield* Crypto.Crypto;
      return {
        ...real,
        randomUUIDv4: Ref.getAndSet(harness.uuidGate, null).pipe(
          Effect.flatMap((gate) =>
            gate === null
              ? real.randomUUIDv4
              : Deferred.await(gate).pipe(Effect.andThen(real.randomUUIDv4)),
          ),
        ),
      } satisfies Crypto.Crypto;
    }),
  ).pipe(Layer.provide(NodeCrypto.layer));

const layerFor = (harness: Harness) => {
  const crypto = gatedCrypto(harness);
  return ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
    Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, crypto)),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ManagedBrowserSupervisor.ManagedBrowserChildLauncher, harness.launcher),
        crypto,
      ),
    ),
  );
};

const withSupervisor = <A, E>(
  body: (
    harness: Harness,
    supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    return yield* Effect.gen(function* () {
      const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
      return yield* body(harness, supervisor);
    }).pipe(Effect.provide(layerFor(harness)), Effect.scoped);
  });

const failureTag = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined;
  return (error as { error?: { _tag?: string } } | undefined)?.error?._tag;
};

const failureReason = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined;
  return (error as { error?: { reason?: string } } | undefined)?.error?.reason;
};

const fence0 = (live: ManagedBrowserRef) => ({
  incarnation: live.incarnation,
  generation: ManagedBrowserControlGeneration.make(0),
});

const settle = Effect.forEach(Array.from({ length: 24 }), () => Effect.yieldNow, { discard: true });

it.effect("starts exactly one child for concurrent ensure calls", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const refs = yield* Effect.all(
        [
          supervisor.ensure(descriptor),
          supervisor.ensure(descriptor),
          supervisor.ensure(descriptor),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(new Set(refs.map((live) => live.incarnation)).size, 1);
      assert.equal((yield* Ref.get(harness.children)).length, 1);
      assert.deepEqual(yield* supervisor.ensure(descriptor), refs[0]);
      assert.equal((yield* Ref.get(harness.children)).length, 1);
    }),
  ),
);

it.effect(
  "forwards only authorized, current-fence operations and attributes them to the caller",
  () =>
    withSupervisor((harness, supervisor) =>
      Effect.gen(function* () {
        const live = yield* supervisor.ensure(descriptor);
        const [child] = yield* Ref.get(harness.children);
        const { fence } = yield* supervisor.state(live);

        const result = yield* supervisor.execute(agent, live, fence, "click");
        assert.equal(result, "click");
        const sent = yield* Ref.get(child!.requests);
        assert.deepEqual(sent, [
          {
            ref: live,
            fence,
            callerId: agent.id,
            callerKind: "agent",
            operation: "click",
            deadlineMs: undefined,
          },
        ]);

        const readOnly = yield* supervisor
          .execute(readOnlyAgent, live, fence, "click")
          .pipe(Effect.exit);
        assert.equal(failureTag(readOnly), "ManagedBrowserAccessDeniedError");
        const stale = yield* supervisor
          .execute(
            agent,
            live,
            { ...fence, generation: ManagedBrowserControlGeneration.make(9) },
            "click",
          )
          .pipe(Effect.exit);
        assert.equal(failureTag(stale), "ManagedBrowserStaleFenceError");
        const foreign = yield* supervisor
          .execute(
            agent,
            { ...live, ownerEnvironmentId: EnvironmentId.make("env-other") },
            fence,
            "click",
          )
          .pipe(Effect.exit);
        assert.equal(failureTag(foreign), "ManagedBrowserOwnerMismatchError");
        assert.equal((yield* Ref.get(child!.requests)).length, 1);
      }),
    ),
);

it.effect("a crashed child surfaces owner-unavailable and never starts a second browser", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const { fence } = yield* supervisor.state(live);
      const states = yield* supervisor.subscribe(agent, live);
      const closed = yield* Stream.runDrain(states).pipe(Effect.forkScoped);

      yield* Deferred.succeed(child!.exit, { clean: false });
      yield* Fiber.join(closed);

      const exit = yield* supervisor.execute(agent, live, fence, "click").pipe(Effect.exit);
      assert.equal(failureTag(exit), "ManagedBrowserOwnerUnavailableError");
      assert.equal(failureReason(exit), "crashed");
      const take = yield* supervisor.takeControl(human, live).pipe(Effect.exit);
      assert.equal(failureTag(take), "ManagedBrowserOwnerUnavailableError");
      assert.equal((yield* Ref.get(harness.children)).length, 1);
    }),
  ),
);

it.effect("restarts after a crash only once the old child's resources are released", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const first = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const { fence: oldFence } = yield* supervisor.state(first);
      const states = yield* supervisor.subscribe(agent, first);
      const closed = yield* Stream.runDrain(states).pipe(Effect.forkScoped);
      yield* Deferred.succeed(child!.exit, { clean: false });
      yield* Fiber.join(closed);

      const second = yield* supervisor.ensure(descriptor);
      assert.notEqual(second.incarnation, first.incarnation);
      assert.deepEqual(yield* Ref.get(harness.events), [
        `launch ${first.incarnation}`,
        `close ${first.incarnation}`,
        `launch ${second.incarnation}`,
      ]);

      const preCrash = yield* supervisor
        .execute(agent, second, oldFence, "click")
        .pipe(Effect.exit);
      assert.equal(failureTag(preCrash), "ManagedBrowserStaleIncarnationError");
      const { fence } = yield* supervisor.state(second);
      assert.equal(yield* supervisor.execute(agent, second, fence, "click"), "click");
    }),
  ),
);

it.effect("a replacement waits for the previous process to be proven gone", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const first = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const slowClose = yield* Deferred.make<void>();
      yield* Ref.set(harness.closeGate, slowClose);
      const states = yield* supervisor.subscribe(agent, first);
      const closed = yield* Stream.runDrain(states).pipe(Effect.forkScoped);
      yield* Deferred.succeed(child!.exit, { clean: false });
      yield* Fiber.join(closed);

      const replacement = yield* supervisor.ensure(descriptor).pipe(Effect.forkScoped);
      yield* settle;
      // The old scope is still closing, so no second browser may start over its profile.
      assert.deepEqual(yield* Ref.get(harness.events), [`launch ${first.incarnation}`]);

      yield* Deferred.succeed(slowClose, undefined);
      const second = yield* Fiber.join(replacement);
      assert.deepEqual(yield* Ref.get(harness.events), [
        `launch ${first.incarnation}`,
        `close ${first.incarnation}`,
        `launch ${second.incarnation}`,
      ]);
    }),
  ),
);

it.effect("a late exit from a retired child cannot remove its replacement", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const first = yield* supervisor.ensure(descriptor);
      const [oldChild] = yield* Ref.get(harness.children);

      const token = yield* supervisor.beginMaintenance(instanceId);
      const second = yield* supervisor.restart(instanceId, token);
      assert.notEqual(second.incarnation, first.incarnation);
      assert.deepEqual(yield* Ref.get(harness.events), [
        `launch ${first.incarnation}`,
        `close ${first.incarnation}`,
        `launch ${second.incarnation}`,
      ]);

      // The old process's exit is only now reported.
      yield* Deferred.succeed(oldChild!.exit, { clean: false });
      yield* settle;

      yield* supervisor.endMaintenance(instanceId, token);
      assert.deepEqual(yield* supervisor.ensure(descriptor), second);
      const { fence } = yield* supervisor.state(second);
      assert.equal(fence.incarnation, second.incarnation);
      assert.equal(yield* supervisor.execute(agent, second, fence, "click"), "click");
    }),
  ),
);

it.effect("keeps admission closed across a maintenance restart until maintenance ends", () =>
  withSupervisor((_harness, supervisor) =>
    Effect.gen(function* () {
      yield* supervisor.ensure(descriptor);
      const token = yield* supervisor.beginMaintenance(instanceId);

      const refused = yield* supervisor.ensure(descriptor).pipe(Effect.exit);
      assert.equal(failureTag(refused), "ManagedBrowserMaintenanceError");

      const replacement = yield* supervisor.restart(instanceId, token);
      const { fence, admission } = yield* supervisor.state(replacement);
      assert.equal(admission, "maintenance");
      const duringMaintenance = yield* supervisor
        .execute(agent, replacement, fence, "click")
        .pipe(Effect.exit);
      assert.equal(failureTag(duringMaintenance), "ManagedBrowserMaintenanceError");

      yield* supervisor.endMaintenance(instanceId, token);
      assert.equal(yield* supervisor.execute(agent, replacement, fence, "click"), "click");
    }),
  ),
);

it.effect("maintenance waits for a pending launch and refuses new ensures meanwhile", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(harness.launchGate, gate);
      const launching = yield* supervisor.ensure(descriptor).pipe(Effect.forkScoped);
      yield* settle;

      const drained = yield* Deferred.make<void>();
      const maintenance = yield* supervisor.beginMaintenance(instanceId).pipe(
        Effect.tap(() => Deferred.succeed(drained, undefined)),
        Effect.forkScoped,
      );
      yield* settle;
      assert.isFalse(yield* Deferred.isDone(drained));
      const refused = yield* supervisor.ensure(descriptor).pipe(Effect.exit);
      assert.equal(failureTag(refused), "ManagedBrowserMaintenanceError");

      yield* Deferred.succeed(gate, undefined);
      const live = yield* Fiber.join(launching);
      const token = yield* Fiber.join(maintenance);
      const { fence, admission } = yield* supervisor.state(live);
      assert.equal(fence.incarnation, live.incarnation);
      assert.equal(admission, "maintenance");
      yield* supervisor.endMaintenance(instanceId, token);
    }),
  ),
);

it.effect("maintenance is refused while a person holds the browser and then leaves it open", () =>
  withSupervisor((_harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const taken = yield* supervisor.takeControl(human, live);

      const busy = yield* supervisor.beginMaintenance(instanceId).pipe(Effect.exit);
      assert.equal(failureTag(busy), "ManagedBrowserBusyError");
      assert.equal(yield* supervisor.execute(human, live, taken, "type"), "type");
      // The refused maintenance left no claim behind, so ensure still works.
      yield* supervisor.ensure(descriptor);
    }),
  ),
);

it.effect("reports a launch failure as a typed error and allows a later retry", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      yield* Ref.set(harness.failNextLaunch, true);
      const failed = yield* supervisor.ensure(descriptor).pipe(Effect.exit);
      assert.equal(failureTag(failed), "ManagedBrowserChildLaunchError");

      const fence = {
        incarnation: ManagedBrowserIncarnation.make("none"),
        generation: ManagedBrowserControlGeneration.make(0),
      };
      const unavailable = yield* supervisor
        .execute(agent, { ...descriptor, incarnation: fence.incarnation }, fence, "click")
        .pipe(Effect.exit);
      assert.equal(failureTag(unavailable), "ManagedBrowserOwnerUnavailableError");
      assert.equal(failureReason(unavailable), "launchFailed");

      yield* Ref.set(harness.failNextLaunch, false);
      yield* supervisor.ensure(descriptor);
      assert.equal((yield* Ref.get(harness.children)).length, 1);
    }),
  ),
);

it.effect("a takeover waits for navigation the child reported as still committing", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const { fence } = yield* supervisor.state(live);
      assert.equal(yield* supervisor.execute(agent, live, fence, "navigate"), "navigate");

      const acknowledged = yield* Deferred.make<void>();
      const takeover = yield* supervisor.takeControl(human, live).pipe(
        Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
        Effect.forkScoped,
      );
      yield* settle;
      assert.isFalse(yield* Deferred.isDone(acknowledged));

      yield* Deferred.succeed(harness.navigationCommitted, undefined);
      const taken = yield* Fiber.join(takeover);
      assert.equal(taken.generation, 1);
      const [child] = yield* Ref.get(harness.children);
      assert.equal(yield* Ref.get(child!.inputReleases), 1);
    }),
  ),
);

it.effect("closing the supervisor's scope shuts the child down", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layerFor(harness), scope);
    const supervisor = Context.get(context, ManagedBrowserSupervisor.ManagedBrowserSupervisor);
    const { incarnation } = yield* supervisor.ensure(descriptor);
    assert.deepEqual(yield* Ref.get(harness.events), [`launch ${incarnation}`]);

    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(yield* Ref.get(harness.events), [
      `launch ${incarnation}`,
      `close ${incarnation}`,
    ]);
  }),
);

// ---------------------------------------------------------------------------
// Correction pass: exclusive maintenance, profile/incarnation refs, owned operations.
// ---------------------------------------------------------------------------

const otherInstanceId = ManagedBrowserInstanceId.make("instance-b");

/** Resolves once the running browser's state satisfies `predicate`, however many scheduler turns that takes. */
const untilState = (
  supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
  live: ManagedBrowserRef,
  predicate: (state: ManagedBrowserControlState) => boolean,
) =>
  supervisor.subscribe(agent, live).pipe(
    Effect.flatMap((states) => Stream.runHead(Stream.filter(states, predicate))),
    Effect.asVoid,
  );

const transferring = (state: ManagedBrowserControlState) => state.phase === "transferring";

const failureError = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined;
  return (error as { error?: Record<string, unknown> } | undefined)?.error;
};

it.effect("binds each instance to one profile and each profile to one instance", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      assert.equal(live.profileId, profileId);
      assert.equal(live.instanceId, instanceId);
      assert.equal(live.ownerEnvironmentId, ownerEnvironmentId);
      assert.deepEqual(yield* supervisor.ensure(descriptor), live);

      const swapped = yield* supervisor
        .ensure({ ...descriptor, profileId: otherProfileId })
        .pipe(Effect.exit);
      assert.equal(failureTag(swapped), "ManagedBrowserProfileMismatchError");
      const shared = yield* supervisor
        .ensure({ ...descriptor, instanceId: otherInstanceId })
        .pipe(Effect.exit);
      assert.equal(failureTag(shared), "ManagedBrowserProfileConflictError");
      const foreign = yield* supervisor
        .ensure({ ...descriptor, ownerEnvironmentId: EnvironmentId.make("env-other") })
        .pipe(Effect.exit);
      assert.equal(failureTag(foreign), "ManagedBrowserOwnerMismatchError");
      assert.equal((yield* Ref.get(harness.children)).length, 1);
    }),
  ),
);

it.effect("a ref must name the instance's profile and its current incarnation", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const { fence } = yield* supervisor.state(live);

      assert.equal(yield* supervisor.execute(agent, live, fence, "click"), "click");
      assert.deepEqual(yield* Ref.get(child!.requests), [
        {
          ref: live,
          fence,
          callerId: agent.id,
          callerKind: "agent",
          operation: "click",
          deadlineMs: undefined,
        },
      ]);

      const otherProfile = { ...live, profileId: otherProfileId };
      const crossProfile = yield* supervisor
        .execute(agent, otherProfile, fence, "click")
        .pipe(Effect.exit);
      assert.equal(failureTag(crossProfile), "ManagedBrowserProfileMismatchError");
      const staleRef = {
        ...live,
        incarnation: ManagedBrowserIncarnation.make("an-older-boot"),
      };
      // The fence is current; the ref alone is stale.
      const staleExecute = yield* supervisor
        .execute(agent, staleRef, fence, "click")
        .pipe(Effect.exit);
      assert.equal(failureTag(staleExecute), "ManagedBrowserStaleIncarnationError");
      assert.equal(
        failureTag(yield* supervisor.state(staleRef).pipe(Effect.exit)),
        "ManagedBrowserStaleIncarnationError",
      );
      assert.equal(
        failureTag(yield* supervisor.state(otherProfile).pipe(Effect.exit)),
        "ManagedBrowserProfileMismatchError",
      );
      assert.equal(
        failureTag(yield* supervisor.subscribe(agent, staleRef).pipe(Effect.exit)),
        "ManagedBrowserStaleIncarnationError",
      );
      assert.equal(
        failureTag(yield* supervisor.subscribe(agent, otherProfile).pipe(Effect.exit)),
        "ManagedBrowserProfileMismatchError",
      );
      assert.equal((yield* Ref.get(child!.requests)).length, 1);
    }),
  ),
);

it.effect("a ref from before a restart is rejected for reads, streams and execution", () =>
  withSupervisor((_harness, supervisor) =>
    Effect.gen(function* () {
      const before = yield* supervisor.ensure(descriptor);
      const token = yield* supervisor.beginMaintenance(instanceId);
      const after = yield* supervisor.restart(instanceId, token);
      yield* supervisor.endMaintenance(instanceId, token);
      assert.notEqual(after.incarnation, before.incarnation);
      const { fence } = yield* supervisor.state(after);

      assert.equal(
        failureTag(yield* supervisor.state(before).pipe(Effect.exit)),
        "ManagedBrowserStaleIncarnationError",
      );
      assert.equal(
        failureTag(yield* supervisor.subscribe(agent, before).pipe(Effect.exit)),
        "ManagedBrowserStaleIncarnationError",
      );
      assert.equal(
        failureTag(yield* supervisor.execute(agent, before, fence, "click").pipe(Effect.exit)),
        "ManagedBrowserStaleIncarnationError",
      );
      assert.equal(yield* supervisor.execute(agent, after, fence, "click"), "click");
    }),
  ),
);

it.effect("maintenance has one owner: restart and end need its token", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      yield* supervisor.ensure(descriptor);
      const token = yield* supervisor.beginMaintenance(instanceId);

      const second = yield* supervisor.beginMaintenance(instanceId).pipe(Effect.exit);
      assert.equal(failureTag(second), "ManagedBrowserBusyError");
      assert.equal(failureError(second)?.phase, "maintenance");

      const stranger = ManagedBrowserMaintenanceToken.make("not-the-owner");
      const restart = yield* supervisor.restart(instanceId, stranger).pipe(Effect.exit);
      assert.equal(failureTag(restart), "ManagedBrowserMaintenanceOwnerError");
      assert.equal((yield* Ref.get(harness.children)).length, 1);
      const end = yield* supervisor.endMaintenance(instanceId, stranger).pipe(Effect.exit);
      assert.equal(failureTag(end), "ManagedBrowserMaintenanceOwnerError");
      assert.equal(
        failureTag(yield* supervisor.ensure(descriptor).pipe(Effect.exit)),
        "ManagedBrowserMaintenanceError",
      );

      yield* supervisor.endMaintenance(instanceId, token);
      yield* supervisor.ensure(descriptor);
    }),
  ),
);

it.effect("a refused maintenance attempt does not reopen the window another owner holds", () =>
  withSupervisor((_harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const token = yield* supervisor.beginMaintenance(instanceId);
      const refused = yield* supervisor.beginMaintenance(instanceId).pipe(Effect.exit);
      assert.equal(failureTag(refused), "ManagedBrowserBusyError");

      assert.equal((yield* supervisor.state(live)).admission, "maintenance");
      assert.equal(
        failureTag(yield* supervisor.ensure(descriptor).pipe(Effect.exit)),
        "ManagedBrowserMaintenanceError",
      );
      yield* supervisor.endMaintenance(instanceId, token);
    }),
  ),
);

it.effect(
  "ensure cannot slip a launch past a maintenance window that opens while it is starting",
  () =>
    withSupervisor((harness, supervisor) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        yield* Ref.set(harness.uuidGate, gate);
        const ensuring = yield* supervisor.ensure(descriptor).pipe(Effect.exit, Effect.forkScoped);
        yield* settle;

        const token = yield* supervisor.beginMaintenance(instanceId);
        yield* Deferred.succeed(gate, undefined);
        const outcome = yield* Fiber.join(ensuring);
        assert.equal(failureTag(outcome), "ManagedBrowserMaintenanceError");
        assert.equal((yield* Ref.get(harness.children)).length, 0);
        yield* supervisor.endMaintenance(instanceId, token);
      }),
    ),
);

it.effect("concurrent restarts by the owner start exactly one replacement", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const first = yield* supervisor.ensure(descriptor);
      const token = yield* supervisor.beginMaintenance(instanceId);
      const restarted = yield* Effect.all(
        [supervisor.restart(instanceId, token), supervisor.restart(instanceId, token)],
        { concurrency: "unbounded" },
      );
      assert.equal(restarted[0].incarnation, restarted[1].incarnation);
      assert.notEqual(restarted[0].incarnation, first.incarnation);
      assert.equal((yield* Ref.get(harness.children)).length, 2);
      yield* supervisor.endMaintenance(instanceId, token);
    }),
  ),
);

it.effect("a cancelled request keeps the writer until the child's real call returns", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const { fence } = yield* supervisor.state(live);
      const caller = yield* supervisor
        .execute(agent, live, fence, "promise")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(harness.operationStarted);
      yield* Fiber.interrupt(caller);

      const acknowledged = yield* Deferred.make<void>();
      const takeover = yield* supervisor.takeControl(human, live).pipe(
        Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
        Effect.forkScoped,
      );
      yield* untilState(supervisor, live, transferring);
      assert.isFalse(yield* Deferred.isDone(acknowledged));
      assert.equal(yield* Ref.get(child!.inputReleases), 0);

      harness.openOperation();
      yield* Fiber.join(takeover);
      assert.equal(yield* Ref.get(child!.inputReleases), 1);
    }),
  ),
);

it.effect("maintenance is not acknowledged while a cancelled request's call is still running", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const { fence } = yield* supervisor.state(live);
      const caller = yield* supervisor
        .execute(agent, live, fence, "promise")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(harness.operationStarted);
      yield* Fiber.interrupt(caller);

      const acknowledged = yield* Deferred.make<void>();
      const maintenance = yield* supervisor.beginMaintenance(instanceId).pipe(
        Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
        Effect.forkScoped,
      );
      // Admission closes first; acknowledging waits for the drain behind it.
      yield* untilState(supervisor, live, (state) => state.admission === "maintenance");
      assert.isFalse(yield* Deferred.isDone(acknowledged));

      harness.openOperation();
      const token = yield* Fiber.join(maintenance);
      yield* supervisor.endMaintenance(instanceId, token);
    }),
  ),
);

it.effect("a child that dies mid-call fails the waiting takeover as owner-unavailable", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const { fence } = yield* supervisor.state(live);
      const caller = yield* supervisor
        .execute(agent, live, fence, "promise")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(harness.operationStarted);
      yield* Fiber.interrupt(caller);

      const settled = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      yield* supervisor.takeControl(human, live).pipe(
        Effect.exit,
        Effect.tap((exit) => Deferred.succeed(settled, exit)),
        Effect.forkScoped,
      );
      yield* untilState(supervisor, live, transferring);
      assert.isFalse(yield* Deferred.isDone(settled));

      yield* Deferred.succeed(child!.exit, { clean: false });
      assert.equal(
        failureTag(yield* Deferred.await(settled)),
        "ManagedBrowserOwnerUnavailableError",
      );
    }),
  ),
);

it.effect(
  "navigation the child reports as failed stops a takeover instead of reading as idle",
  () =>
    withSupervisor((_harness, supervisor) =>
      Effect.gen(function* () {
        const live = yield* supervisor.ensure(descriptor);
        const { fence } = yield* supervisor.state(live);
        assert.equal(
          yield* supervisor.execute(agent, live, fence, "navigate-fails"),
          "navigate-fails",
        );

        const take = yield* supervisor.takeControl(human, live).pipe(Effect.exit);
        assert.equal(failureTag(take), "ManagedBrowserTransferFailedError");
        assert.equal(failureError(take)?.stage, "navigation");
        assert.equal((yield* supervisor.state(live)).phase, "paused");
      }),
    ),
);

/** Restarts the browser the way the update gate does, leaving admission open afterwards. */
const restartBrowser = (supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"]) =>
  Effect.gen(function* () {
    const token = yield* supervisor.beginMaintenance(instanceId);
    const replacement = yield* supervisor.restart(instanceId, token);
    yield* supervisor.endMaintenance(instanceId, token);
    return replacement;
  });

it.effect("a viewer of a replaced browser cannot take, release or disconnect the replacement", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const before = yield* supervisor.ensure(descriptor);
      const after = yield* restartBrowser(supervisor);
      const replacement = (yield* Ref.get(harness.children)).find(
        (child) => child.incarnation === after.incarnation,
      )!;
      const initial = yield* supervisor.state(after);

      const take = yield* supervisor.takeControl(human, before).pipe(Effect.exit);
      assert.equal(failureTag(take), "ManagedBrowserStaleIncarnationError");
      assert.deepEqual(yield* supervisor.state(after), initial);
      assert.equal(yield* Ref.get(replacement.inputReleases), 0);

      // A person legitimately holding the replacement is out of reach of the old viewer.
      const taken = yield* supervisor.takeControl(human, after);
      assert.equal(taken.incarnation, after.incarnation);
      const held = yield* supervisor.state(after);
      const releasesBefore = yield* Ref.get(replacement.inputReleases);

      const release = yield* supervisor.releaseControl(human, before).pipe(Effect.exit);
      assert.equal(failureTag(release), "ManagedBrowserStaleIncarnationError");
      yield* supervisor.holderDisconnected(human.id, before);
      yield* TestClock.adjust("31 seconds");
      assert.deepEqual(yield* supervisor.state(after), held);
      assert.equal(held.phase, "human");
      assert.equal(yield* Ref.get(replacement.inputReleases), releasesBefore);
      assert.equal(yield* supervisor.execute(human, after, taken, "type"), "type");
    }),
  ),
);

it.effect("takeover, handback and disconnect validate the owner and profile of the reference", () =>
  withSupervisor((_harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const foreign = { ...live, ownerEnvironmentId: EnvironmentId.make("env-other") };
      const wrongProfile = { ...live, profileId: otherProfileId };
      const taken = yield* supervisor.takeControl(human, live);

      assert.equal(
        failureTag(yield* supervisor.takeControl(human, foreign).pipe(Effect.exit)),
        "ManagedBrowserOwnerMismatchError",
      );
      assert.equal(
        failureTag(yield* supervisor.takeControl(human, wrongProfile).pipe(Effect.exit)),
        "ManagedBrowserProfileMismatchError",
      );
      assert.equal(
        failureTag(yield* supervisor.releaseControl(human, wrongProfile).pipe(Effect.exit)),
        "ManagedBrowserProfileMismatchError",
      );
      yield* supervisor.holderDisconnected(human.id, wrongProfile);
      yield* supervisor.holderDisconnected(human.id, foreign);
      const state = yield* supervisor.state(live);
      assert.equal(state.phase, "human");
      assert.equal(state.fence.generation, taken.generation);
    }),
  ),
);

/** Lets a test run code at the instant a transition reaches the control layer, after the reference was checked. */
const makeRace = Effect.gen(function* () {
  const armed = yield* Ref.make(false);
  const reached = yield* Deferred.make<void>();
  const proceed = yield* Deferred.make<void>();
  const hook = Ref.getAndSet(armed, false).pipe(
    Effect.flatMap((wasArmed) =>
      wasArmed
        ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(proceed)))
        : Effect.void,
    ),
  );
  return { arm: Ref.set(armed, true), reached, proceed, hook };
});

type Race = Effect.Success<typeof makeRace>;

const racingLayerFor = (harness: Harness, race: Race) => {
  const crypto = gatedCrypto(harness);
  const racingControl = Layer.effect(
    ManagedBrowserControl.ManagedBrowserControl,
    Effect.gen(function* () {
      const real = yield* ManagedBrowserControl.ManagedBrowserControl;
      return ManagedBrowserControl.ManagedBrowserControl.of({
        ...real,
        takeControl: (...args) => race.hook.pipe(Effect.andThen(real.takeControl(...args))),
        releaseControl: (...args) => race.hook.pipe(Effect.andThen(real.releaseControl(...args))),
        holderDisconnected: (...args) =>
          race.hook.pipe(Effect.andThen(real.holderDisconnected(...args))),
      });
    }),
  ).pipe(Layer.provide(Layer.provide(ManagedBrowserControl.layer, crypto)));
  return ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
    Layer.provideMerge(racingControl),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ManagedBrowserSupervisor.ManagedBrowserChildLauncher, harness.launcher),
        crypto,
      ),
    ),
  );
};

const withRacingSupervisor = <A, E>(
  body: (
    harness: Harness,
    supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
    race: Race,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const race = yield* makeRace;
    return yield* Effect.gen(function* () {
      const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
      return yield* body(harness, supervisor, race);
    }).pipe(Effect.provide(racingLayerFor(harness, race)), Effect.scoped);
  });

it.effect(
  "a restart between the reference check and the takeover cannot hand over the replacement",
  () =>
    withRacingSupervisor((harness, supervisor, race) =>
      Effect.gen(function* () {
        const before = yield* supervisor.ensure(descriptor);
        yield* race.arm;
        const take = yield* supervisor
          .takeControl(human, before)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(race.reached);

        const after = yield* restartBrowser(supervisor);
        const initial = yield* supervisor.state(after);
        yield* Deferred.succeed(race.proceed, undefined);

        assert.equal(failureTag(yield* Fiber.join(take)), "ManagedBrowserStaleIncarnationError");
        assert.deepEqual(yield* supervisor.state(after), initial);
        assert.equal(initial.phase, "agent");
        const replacement = (yield* Ref.get(harness.children)).find(
          (child) => child.incarnation === after.incarnation,
        )!;
        assert.equal(yield* Ref.get(replacement.inputReleases), 0);
      }),
    ),
);

it.effect(
  "a restart between the reference check and the handback cannot release the replacement's holder",
  () =>
    withRacingSupervisor((_harness, supervisor, race) =>
      Effect.gen(function* () {
        const before = yield* supervisor.ensure(descriptor);
        yield* supervisor.takeControl(human, before);
        yield* supervisor.releaseControl(human, before);
        yield* race.arm;
        const release = yield* supervisor
          .releaseControl(human, before)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(race.reached);

        const after = yield* restartBrowser(supervisor);
        yield* supervisor.takeControl(human, after);
        const held = yield* supervisor.state(after);
        yield* Deferred.succeed(race.proceed, undefined);

        assert.equal(failureTag(yield* Fiber.join(release)), "ManagedBrowserStaleIncarnationError");
        assert.deepEqual(yield* supervisor.state(after), held);
        assert.equal(held.phase, "human");
      }),
    ),
);

it.effect(
  "a disconnect from the old boot delayed past a restart does not pause the new browser",
  () =>
    withRacingSupervisor((_harness, supervisor, race) =>
      Effect.gen(function* () {
        const before = yield* supervisor.ensure(descriptor);
        yield* supervisor.takeControl(human, before);
        yield* supervisor.releaseControl(human, before);
        yield* race.arm;
        const disconnect = yield* supervisor
          .holderDisconnected(human.id, before)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(race.reached);

        const after = yield* restartBrowser(supervisor);
        const taken = yield* supervisor.takeControl(human, after);
        yield* Deferred.succeed(race.proceed, undefined);
        yield* Fiber.join(disconnect);

        yield* TestClock.adjust("31 seconds");
        const state = yield* supervisor.state(after);
        assert.equal(state.phase, "human");
        assert.equal(state.holder, human.id);
        assert.equal(yield* supervisor.execute(human, after, taken, "type"), "type");
      }),
    ),
);

it.effect("a takeover is acknowledged only after the child acknowledges the new generation", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(harness.generationGate, gate);

      const acknowledged = yield* Deferred.make<void>();
      const takeover = yield* supervisor.takeControl(human, live).pipe(
        Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
        Effect.forkScoped,
      );
      yield* settle;
      assert.isFalse(yield* Deferred.isDone(acknowledged));
      assert.deepEqual(yield* Ref.get(child!.generations), []);

      yield* Deferred.succeed(gate, undefined);
      const taken = yield* Fiber.join(takeover);
      assert.deepEqual(yield* Ref.get(child!.generations), [taken.generation]);
      assert.equal(taken.generation, 1);
    }),
  ),
);

// ---------------------------------------------------------------------------
// Caller scope, per-call deadlines, scoped child requests and events
// ---------------------------------------------------------------------------

it.effect("execute passes the caller's kind and a per-call deadline to the child", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      yield* supervisor.execute(agent, live, fence0(live), "click", { deadlineMs: 1_500 });
      yield* supervisor.execute(agent, live, fence0(live), "type");
      const [first, second] = yield* Ref.get(child!.requests);
      assert.equal(first?.callerKind, "agent");
      assert.equal(first?.deadlineMs, 1_500);
      assert.equal(second?.deadlineMs, undefined);
    }),
  ),
);

it.effect("a scoped request is validated against its reference and reaches the child opaque", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const answer = yield* supervisor.scoped(readOnlyAgent, live, "subscribe", {
        deadlineMs: 2_000,
      });
      assert.deepEqual(answer, { answered: "subscribe" });
      const [request] = yield* Ref.get(child!.scopedRequests);
      assert.equal(request?.callerId, readOnlyAgent.id);
      assert.equal(request?.callerKind, "agent");
      assert.equal(request?.deadlineMs, 2_000);
      assert.equal(request?.ref.incarnation, live.incarnation);

      const wrongProfile = yield* supervisor
        .scoped(agent, { ...live, profileId: otherProfileId }, "subscribe")
        .pipe(Effect.exit);
      assert.equal(failureTag(wrongProfile), "ManagedBrowserProfileMismatchError");
      assert.equal((yield* Ref.get(child!.scopedRequests)).length, 1);
    }),
  ),
);

it.effect("a scoped request with a ref from before a restart never reaches the replacement", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const old = yield* supervisor.ensure(descriptor);
      const token = yield* supervisor.beginMaintenance(instanceId);
      yield* supervisor.restart(instanceId, token);
      yield* supervisor.endMaintenance(instanceId, token);
      const replacement = (yield* Ref.get(harness.children))[1]!;
      const exit = yield* supervisor.scoped(agent, old, "subscribe").pipe(Effect.exit);
      assert.equal(failureTag(exit), "ManagedBrowserStaleIncarnationError");
      assert.equal((yield* Ref.get(replacement.scopedRequests)).length, 0);
      const events = yield* supervisor.events(agent, old).pipe(Effect.scoped, Effect.exit);
      assert.equal(failureTag(events), "ManagedBrowserStaleIncarnationError");
    }),
  ),
);

it.effect("events from the child reach a viewer of the same reference", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const stream = yield* supervisor.events(readOnlyAgent, live);
      const received = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
      yield* settle;
      yield* PubSub.publish(child!.events, { name: "tabOpened" });
      yield* PubSub.publish(child!.events, { name: "tabClosed" });
      assert.deepEqual(yield* Fiber.join(received), [{ name: "tabOpened" }, { name: "tabClosed" }]);
    }),
  ),
);

// ---------------------------------------------------------------------------
// Maintenance consults the child
// ---------------------------------------------------------------------------

it.effect("maintenance defers while the child reports shared tabs, dialogs or artifacts", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      yield* Ref.set(harness.busyReasons, ["sharedSessions", "dialogs"]);

      const deferred = yield* supervisor.beginMaintenance(instanceId).pipe(Effect.exit);
      assert.equal(failureTag(deferred), "ManagedBrowserMaintenanceDeferredError");
      const reasons = Exit.isFailure(deferred)
        ? (
            deferred.cause.reasons.find((reason) => reason._tag === "Fail") as {
              error: { reasons: ReadonlyArray<string> };
            }
          ).error.reasons
        : [];
      assert.deepEqual(reasons, ["sharedSessions", "dialogs"]);

      // The child's admission was closed to look, and is open again; so is the lease's and the claim.
      assert.deepEqual(yield* Ref.get(child!.quiesceCalls), [true, false]);
      assert.equal((yield* supervisor.state(live)).admission, "open");
      assert.equal(yield* supervisor.execute(agent, live, fence0(live), "click"), "click");
      yield* Ref.set(harness.busyReasons, []);
      const token = yield* supervisor.beginMaintenance(instanceId);
      yield* supervisor.endMaintenance(instanceId, token);
    }),
  ),
);

it.effect("an idle child has its admission closed for maintenance and reopened when it ends", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const token = yield* supervisor.beginMaintenance(instanceId);
      assert.deepEqual(yield* Ref.get(child!.quiesceCalls), [true]);
      yield* supervisor.endMaintenance(instanceId, token);
      assert.deepEqual(yield* Ref.get(child!.quiesceCalls), [true, false]);
    }),
  ),
);

it.effect("a restart for the maintenance owner does not try to reopen the retired child", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      yield* supervisor.ensure(descriptor);
      const [old] = yield* Ref.get(harness.children);
      const token = yield* supervisor.beginMaintenance(instanceId);
      const live = yield* supervisor.restart(instanceId, token);
      yield* supervisor.endMaintenance(instanceId, token);
      const replacement = (yield* Ref.get(harness.children))[1]!;
      assert.equal(replacement.incarnation, live.incarnation);
      assert.deepEqual(yield* Ref.get(old!.quiesceCalls), [true]);
      // The replacement was never closed by a quiesce, so ending maintenance leaves it alone.
      assert.deepEqual(yield* Ref.get(replacement.quiesceCalls), []);
    }),
  ),
);

it.effect(
  "an out-of-band execute reaches the child while an earlier call is still running there",
  () =>
    withSupervisor((harness, supervisor) =>
      Effect.gen(function* () {
        const live = yield* supervisor.ensure(descriptor);
        const [child] = yield* Ref.get(harness.children);
        // The first call is mid-flight in the child; a queued second one would wait for it.
        const running = yield* supervisor
          .execute(agent, live, fence0(live), "promise")
          .pipe(Effect.forkScoped);
        yield* Deferred.await(harness.operationStarted);
        const answer = yield* supervisor.execute(agent, live, fence0(live), "dialog", {
          outOfBand: true,
        });
        assert.equal(answer, "dialog");
        assert.deepEqual(
          (yield* Ref.get(child!.requests)).map((request) => request.operation),
          ["promise", "dialog"],
        );
        harness.openOperation();
        yield* Fiber.join(running);
      }),
    ),
);

it.effect("an out-of-band execute carries the same fence checks as any other", () =>
  withSupervisor((harness, supervisor) =>
    Effect.gen(function* () {
      const live = yield* supervisor.ensure(descriptor);
      const [child] = yield* Ref.get(harness.children);
      const taken = yield* supervisor.takeControl(human, live);
      const stale = yield* supervisor
        .execute(agent, live, fence0(live), "dialog", { outOfBand: true })
        .pipe(Effect.exit);
      assert.equal(failureTag(stale), "ManagedBrowserControlHeldError");
      assert.equal((yield* Ref.get(child!.requests)).length, 0);
      assert.equal(
        yield* supervisor.execute(human, live, taken, "dialog", { outOfBand: true }),
        "dialog",
      );
    }),
  ),
);
