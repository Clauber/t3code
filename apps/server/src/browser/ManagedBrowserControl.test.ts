import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ManagedBrowserControlGeneration,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserMaintenanceToken,
  ManagedBrowserPrincipalId,
  type ManagedBrowserControlState,
  type ManagedBrowserPrincipal,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";

const instanceId = ManagedBrowserInstanceId.make("instance-a");
const boot1 = ManagedBrowserIncarnation.make("boot-1");
const boot2 = ManagedBrowserIncarnation.make("boot-2");

const principal = (
  id: string,
  kind: ManagedBrowserPrincipal["kind"],
  access: ManagedBrowserPrincipal["access"] = "operate",
): ManagedBrowserPrincipal => ({ id: ManagedBrowserPrincipalId.make(id), kind, access });

const agent = principal("agent-1", "agent");
const readOnlyAgent = principal("agent-ro", "agent", "read");
const human = principal("human-1", "human");
const otherHuman = principal("human-2", "human");
const readOnlyHuman = principal("human-ro", "human", "read");

const fence = (generation: number, incarnation = boot1) => ({
  incarnation,
  generation: ManagedBrowserControlGeneration.make(generation),
});

/** Attaches one incarnation whose input release is counted. */
const setup = Effect.gen(function* () {
  const control = yield* ManagedBrowserControl.ManagedBrowserControl;
  const inputReleases = yield* Ref.make(0);
  yield* control.attach({
    instanceId,
    incarnation: boot1,
    releaseInput: Ref.update(inputReleases, (count) => count + 1),
  });
  return { control, inputReleases };
});

const provided = <A, E>(
  effect: Effect.Effect<A, E, ManagedBrowserControl.ManagedBrowserControl | Scope.Scope>,
) =>
  effect.pipe(
    Effect.provide(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
    Effect.scoped,
  );

const settle = Effect.all([Effect.yieldNow, Effect.yieldNow, Effect.yieldNow, Effect.yieldNow]);

const failureTag = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit)
    ? exit.cause.reasons.find((r) => r._tag === "Fail")
    : undefined;
  return (error as { error?: { _tag?: string } } | undefined)?.error?._tag;
};

it.effect("runs mutations one at a time per instance", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const events: string[] = [];
      const firstStarted = yield* Deferred.make<void>();
      const firstGate = yield* Deferred.make<void>();

      const first = yield* control
        .run(agent, instanceId, fence(0), () =>
          Effect.gen(function* () {
            events.push("first start");
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(firstGate);
            events.push("first end");
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* control
        .run(agent, instanceId, fence(0), () => Effect.sync(() => events.push("second start")))
        .pipe(Effect.forkScoped);

      yield* settle;
      assert.deepEqual(events, ["first start"]);
      yield* Deferred.succeed(firstGate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(events, ["first start", "first end", "second start"]);
    }),
  ),
);

it.effect(
  "takeover drains the running action and tracked navigation and rejects queued commands",
  () =>
    provided(
      Effect.gen(function* () {
        const { control, inputReleases } = yield* setup;
        const events: string[] = [];
        const runningStarted = yield* Deferred.make<void>();
        const runningGate = yield* Deferred.make<void>();
        const navigationCommitted = yield* Deferred.make<void>();

        const running = yield* control
          .run(agent, instanceId, fence(0), ({ track }) =>
            Effect.gen(function* () {
              yield* track(
                Deferred.await(navigationCommitted).pipe(
                  Effect.tap(() => Effect.sync(() => events.push("navigation committed"))),
                ),
              );
              yield* Deferred.succeed(runningStarted, undefined);
              yield* Deferred.await(runningGate);
              events.push("running finished");
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(runningStarted);
        const queued = yield* control
          .run(agent, instanceId, fence(0), () =>
            Effect.sync(() => events.push("old queued command ran")),
          )
          .pipe(Effect.exit, Effect.forkScoped);

        const acknowledged = yield* Deferred.make<void>();
        const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(
          Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
          Effect.forkScoped,
        );
        yield* settle;
        assert.isFalse(yield* Deferred.isDone(acknowledged));

        yield* Deferred.succeed(runningGate, undefined);
        yield* Fiber.join(running);
        yield* settle;
        // The running action is done but its navigation has not committed yet.
        assert.isFalse(yield* Deferred.isDone(acknowledged));

        yield* Deferred.succeed(navigationCommitted, undefined);
        const taken = yield* Fiber.join(takeover);
        assert.deepEqual(events, ["running finished", "navigation committed"]);
        assert.equal(taken.generation, 1);
        assert.equal(failureTag(yield* Fiber.join(queued)), "ManagedBrowserControlHeldError");
        assert.equal(yield* Ref.get(inputReleases), 1);
      }),
    ),
);

it.effect("rechecks the lease after waiting out tracked navigation", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const navigationCommitted = yield* Deferred.make<void>();
      const ran = yield* Ref.make(false);

      yield* control.run(agent, instanceId, fence(0), ({ track }) =>
        track(Deferred.await(navigationCommitted)),
      );
      // This one holds the writer permit but is stuck behind the navigation.
      const waiting = yield* control
        .run(agent, instanceId, fence(0), () => Ref.set(ran, true))
        .pipe(Effect.exit, Effect.forkScoped);
      yield* settle;
      const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.forkScoped);
      yield* settle;

      yield* Deferred.succeed(navigationCommitted, undefined);
      assert.equal(failureTag(yield* Fiber.join(waiting)), "ManagedBrowserControlHeldError");
      yield* Fiber.join(takeover);
      assert.isFalse(yield* Ref.get(ran));
    }),
  ),
);

it.effect("rejects a stale generation and a wrong incarnation before running", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const ran = yield* Ref.make(false);
      const mark = Ref.set(ran, true);

      const staleGeneration = yield* control
        .run(agent, instanceId, fence(3), () => mark)
        .pipe(Effect.exit);
      assert.equal(failureTag(staleGeneration), "ManagedBrowserStaleFenceError");

      const wrongIncarnation = yield* control
        .run(agent, instanceId, fence(0, boot2), () => mark)
        .pipe(Effect.exit);
      assert.equal(failureTag(wrongIncarnation), "ManagedBrowserStaleFenceError");

      // A restart reuses generation 0, so only the incarnation tells the boots apart.
      yield* control.attach({ instanceId, incarnation: boot2, releaseInput: Effect.void });
      const preRestart = yield* control
        .run(agent, instanceId, fence(0, boot1), () => mark)
        .pipe(Effect.exit);
      assert.equal(failureTag(preRestart), "ManagedBrowserStaleFenceError");
      assert.isFalse(yield* Ref.get(ran));

      yield* control.run(agent, instanceId, fence(0, boot2), () => mark);
      assert.isTrue(yield* Ref.get(ran));
    }),
  ),
);

it.effect("denies read-only principals every mutation but lets them observe", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const ran = yield* Ref.make(false);

      const agentRun = yield* control
        .run(readOnlyAgent, instanceId, fence(0), () => Ref.set(ran, true))
        .pipe(Effect.exit);
      assert.equal(failureTag(agentRun), "ManagedBrowserAccessDeniedError");
      const take = yield* control.takeControl(readOnlyHuman, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(take), "ManagedBrowserAccessDeniedError");

      // A read-only grant cannot ride on a lease another human took.
      yield* control.takeControl(human, instanceId, boot1);
      const humanRun = yield* control
        .run(readOnlyHuman, instanceId, fence(1), () => Ref.set(ran, true))
        .pipe(Effect.exit);
      assert.equal(failureTag(humanRun), "ManagedBrowserAccessDeniedError");
      assert.isFalse(yield* Ref.get(ran));

      const states = yield* control.subscribe(instanceId, boot1);
      const first = yield* Stream.runHead(states);
      assert.equal(first._tag === "Some" ? first.value.phase : null, "human");
    }),
  ),
);

it.effect("agents cannot take control and only the holder can act or release", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const agentTake = yield* control.takeControl(agent, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(agentTake), "ManagedBrowserAccessDeniedError");

      const taken = yield* control.takeControl(human, instanceId, boot1);
      const agentRun = yield* control
        .run(agent, instanceId, taken, () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(agentRun), "ManagedBrowserControlHeldError");
      const otherRun = yield* control
        .run(otherHuman, instanceId, taken, () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(otherRun), "ManagedBrowserControlHeldError");
      const steal = yield* control.takeControl(otherHuman, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(steal), "ManagedBrowserControlHeldError");
      const foreignRelease = yield* control
        .releaseControl(otherHuman, instanceId, boot1)
        .pipe(Effect.exit);
      assert.equal(failureTag(foreignRelease), "ManagedBrowserNotHolderError");

      yield* control.run(human, instanceId, taken, () => Effect.void);
      const handedBack = yield* control.releaseControl(human, instanceId, boot1);
      // The old agent fence predates the handback; it must refetch.
      const staleAgent = yield* control
        .run(agent, instanceId, fence(0), () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(staleAgent), "ManagedBrowserStaleFenceError");
      yield* control.run(agent, instanceId, handedBack, () => Effect.void);
    }),
  ),
);

it.effect("holds a disconnected human for 30s, then pauses until explicit reacquisition", () =>
  provided(
    Effect.gen(function* () {
      const { control, inputReleases } = yield* setup;
      const taken = yield* control.takeControl(human, instanceId, boot1);

      yield* control.holderDisconnected(human.id, instanceId, boot1);
      const held = yield* control.state(instanceId);
      assert.equal(held.phase, "reconnectHold");
      assert.equal(held.holder, human.id);

      // Automation does not resume and the dropped viewer's queued input is stale.
      const agentDuringHold = yield* control
        .run(agent, instanceId, fence(0), () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(agentDuringHold), "ManagedBrowserControlHeldError");
      const oldInput = yield* control
        .run(human, instanceId, taken, () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(oldInput), "ManagedBrowserControlHeldError");
      const steal = yield* control.takeControl(otherHuman, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(steal), "ManagedBrowserControlHeldError");

      // Reconnecting inside the hold is an explicit reacquisition with a fresh fence.
      yield* TestClock.adjust("29 seconds");
      assert.equal((yield* control.state(instanceId)).phase, "reconnectHold");
      const reconnected = yield* control.takeControl(human, instanceId, boot1);
      assert.isAbove(reconnected.generation, taken.generation);
      yield* control.run(human, instanceId, reconnected, () => Effect.void);

      // The first hold's timer must not pause the resumed session.
      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* control.state(instanceId)).phase, "human");

      yield* control.holderDisconnected(human.id, instanceId, boot1);
      yield* TestClock.adjust("30 seconds");
      // Expiry is a transfer settled in the background, so wait for it rather than for a turn count.
      yield* untilState(control, (state) => state.phase === "paused");
      const paused = yield* control.state(instanceId);
      assert.equal(paused.phase, "paused");
      assert.equal(paused.holder, null);
      const agentWhilePaused = yield* control
        .run(agent, instanceId, paused.fence, () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(agentWhilePaused), "ManagedBrowserControlHeldError");

      const releasesBefore = yield* Ref.get(inputReleases);
      const reacquired = yield* control.takeControl(otherHuman, instanceId, boot1);
      yield* control.run(otherHuman, instanceId, reacquired, () => Effect.void);
      const handedBack = yield* control.releaseControl(otherHuman, instanceId, boot1);
      yield* control.run(agent, instanceId, handedBack, () => Effect.void);
      assert.isAbove(yield* Ref.get(inputReleases), releasesBefore);
    }),
  ),
);

it.effect("releases stuck input state whenever control transfers", () =>
  provided(
    Effect.gen(function* () {
      const { control, inputReleases } = yield* setup;
      yield* control.takeControl(human, instanceId, boot1);
      assert.equal(yield* Ref.get(inputReleases), 1);
      yield* control.releaseControl(human, instanceId, boot1);
      assert.equal(yield* Ref.get(inputReleases), 2);
      yield* control.takeControl(human, instanceId, boot1);
      assert.equal(yield* Ref.get(inputReleases), 3);
      // A dropped viewer may leave a key or button down; so may the expiry that pauses it.
      yield* control.holderDisconnected(human.id, instanceId, boot1);
      assert.equal(yield* Ref.get(inputReleases), 4);
      yield* TestClock.adjust("30 seconds");
      yield* untilState(control, (state) => state.phase === "paused");
      assert.equal(yield* Ref.get(inputReleases), 5);
    }),
  ),
);

it.effect("maintenance closes admission, drains admitted work, and reopens on end", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      const navigationCommitted = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();

      const running = yield* control
        .run(agent, instanceId, fence(0), ({ track }) =>
          Effect.gen(function* () {
            yield* track(Deferred.await(navigationCommitted));
            yield* Deferred.succeed(runningStarted, undefined);
            yield* Deferred.await(runningGate);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);

      const maintenance = yield* control.beginMaintenance(instanceId).pipe(
        Effect.tap(() => Deferred.succeed(drained, undefined)),
        Effect.forkScoped,
      );
      yield* settle;
      assert.equal((yield* control.state(instanceId)).admission, "maintenance");

      const rejectedRun = yield* control
        .run(agent, instanceId, fence(0), () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(rejectedRun), "ManagedBrowserMaintenanceError");
      const rejectedTake = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(rejectedTake), "ManagedBrowserMaintenanceError");

      yield* Deferred.succeed(runningGate, undefined);
      yield* Fiber.join(running);
      yield* settle;
      assert.isFalse(yield* Deferred.isDone(drained));
      yield* Deferred.succeed(navigationCommitted, undefined);
      const token = yield* Fiber.join(maintenance);

      yield* control.endMaintenance(instanceId, token);
      assert.equal((yield* control.state(instanceId)).admission, "open");
      yield* control.run(agent, instanceId, fence(0), () => Effect.void);
    }),
  ),
);

it.effect("maintenance reports busy under human control and leaves admission open", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const taken = yield* control.takeControl(human, instanceId, boot1);

      const busy = yield* control.beginMaintenance(instanceId).pipe(Effect.exit);
      assert.equal(failureTag(busy), "ManagedBrowserBusyError");
      assert.equal((yield* control.state(instanceId)).admission, "open");
      yield* control.run(human, instanceId, taken, () => Effect.void);

      yield* control.holderDisconnected(human.id, instanceId, boot1);
      const busyHold = yield* control.beginMaintenance(instanceId).pipe(Effect.exit);
      assert.equal(failureTag(busyHold), "ManagedBrowserBusyError");
    }),
  ),
);

it.effect("an abandoned drain restores normal admission", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      const running = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runningGate)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);

      const maintenance = yield* control.beginMaintenance(instanceId).pipe(Effect.forkScoped);
      yield* settle;
      assert.equal((yield* control.state(instanceId)).admission, "maintenance");
      yield* Fiber.interrupt(maintenance);
      assert.equal((yield* control.state(instanceId)).admission, "open");

      yield* Deferred.succeed(runningGate, undefined);
      yield* Fiber.join(running);
    }),
  ),
);

it.effect("a stale incarnation cannot detach its replacement", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      yield* control.attach({ instanceId, incarnation: boot2, releaseInput: Effect.void });

      assert.isFalse(yield* control.detach(instanceId, boot1));
      yield* control.run(agent, instanceId, fence(0, boot2), () => Effect.void);

      assert.isTrue(yield* control.detach(instanceId, boot2));
      const afterExit = yield* control
        .run(agent, instanceId, fence(0, boot2), () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(afterExit), "ManagedBrowserInstanceUnavailableError");
    }),
  ),
);

it.effect("rejects queued work and ends streams when an incarnation is detached", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      const running = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runningGate)),
          ),
        )
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(runningStarted);
      const queued = yield* control
        .run(agent, instanceId, fence(0), () => Effect.die("must not run"))
        .pipe(Effect.exit, Effect.forkScoped);
      const states = yield* control.subscribe(instanceId, boot1);
      const seen = yield* Stream.runCollect(states).pipe(Effect.forkScoped);

      yield* control.detach(instanceId, boot1);
      // The running action belongs to the closed incarnation, so it ends with it.
      assert.equal(
        failureTag(yield* Fiber.join(running)),
        "ManagedBrowserInstanceUnavailableError",
      );
      assert.equal(failureTag(yield* Fiber.join(queued)), "ManagedBrowserInstanceUnavailableError");
      const phases = yield* Fiber.join(seen);
      assert.equal(phases.at(-1)?.admission, "closed");
    }),
  ),
);

it.effect("streams the current state and then the latest after each lease change", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const states = yield* control.subscribe(instanceId, boot1);
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const reachedAgent = yield* Deferred.make<void>();
      yield* Stream.runForEach(states, (state) =>
        Ref.update(seen, (current) => [
          ...current,
          `${state.phase}@${state.fence.generation}`,
        ]).pipe(
          Effect.andThen(
            state.phase === "agent" && state.fence.generation === 3
              ? Deferred.succeed(reachedAgent, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);

      yield* control.takeControl(human, instanceId, boot1);
      yield* control.holderDisconnected(human.id, instanceId, boot1);
      yield* control.releaseControl(human, instanceId, boot1);
      yield* Deferred.await(reachedAgent);

      // A consumer may skip a transient `transferring` state, but never sees a phase out of order.
      const phases = (yield* Ref.get(seen)).filter((entry) => !entry.startsWith("transferring"));
      assert.deepEqual(phases, ["agent@0", "human@1", "reconnectHold@2", "agent@3"]);
    }),
  ),
);

// ---------------------------------------------------------------------------
// Correction pass: exclusive maintenance, owned operations, safe transfers.
// ---------------------------------------------------------------------------

/** Resolves once the instance's state satisfies `predicate`, however many scheduler turns that takes. */
const untilState = (
  control: ManagedBrowserControl.ManagedBrowserControl["Service"],
  predicate: (state: ManagedBrowserControlState) => boolean,
  incarnation = boot1,
) =>
  control.subscribe(instanceId, incarnation).pipe(
    Effect.flatMap((states) => Stream.runHead(Stream.filter(states, predicate))),
    Effect.asVoid,
  );

const untilAdmission = (
  control: ManagedBrowserControl.ManagedBrowserControl["Service"],
  admission: ManagedBrowserControlState["admission"],
) => untilState(control, (state) => state.admission === admission);

const transferring = (generation?: number) => (state: ManagedBrowserControlState) =>
  state.phase === "transferring" &&
  (generation === undefined || state.fence.generation === generation);

/** A promise-backed operation the Effect runtime cannot cancel, like a real child call. */
const promiseGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const failureError = <A, E>(exit: Exit.Exit<A, E>) => {
  const reason = Exit.isFailure(exit)
    ? exit.cause.reasons.find((candidate) => candidate._tag === "Fail")
    : undefined;
  return (reason as { error?: Record<string, unknown> } | undefined)?.error;
};

/** Like `setup`, with the input release under the test's control. */
const setupWith = (
  releaseInput: Effect.Effect<void, ManagedBrowserControl.ManagedBrowserInputReleaseError>,
) =>
  Effect.gen(function* () {
    const control = yield* ManagedBrowserControl.ManagedBrowserControl;
    yield* control.attach({ instanceId, incarnation: boot1, releaseInput });
    return { control };
  });

it.effect(
  "maintenance is exclusive: a second owner is refused and cannot end the first window",
  () =>
    provided(
      Effect.gen(function* () {
        const { control } = yield* setup;
        const token = yield* control.beginMaintenance(instanceId);

        const second = yield* control.beginMaintenance(instanceId).pipe(Effect.exit);
        assert.equal(failureTag(second), "ManagedBrowserBusyError");
        assert.equal(failureError(second)?.phase, "maintenance");
        assert.equal((yield* control.state(instanceId)).admission, "maintenance");

        const foreign = yield* control
          .endMaintenance(instanceId, ManagedBrowserMaintenanceToken.make("not-the-owner"))
          .pipe(Effect.exit);
        assert.equal(failureTag(foreign), "ManagedBrowserMaintenanceOwnerError");
        assert.equal((yield* control.state(instanceId)).admission, "maintenance");

        yield* control.endMaintenance(instanceId, token);
        assert.equal((yield* control.state(instanceId)).admission, "open");
        const reused = yield* control.endMaintenance(instanceId, token).pipe(Effect.exit);
        assert.equal(failureTag(reused), "ManagedBrowserMaintenanceOwnerError");
      }),
    ),
);

it.effect("a refused or abandoned maintenance attempt only reopens admission it owns", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      const running = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runningGate)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);

      const first = yield* control.beginMaintenance(instanceId).pipe(Effect.forkScoped);
      yield* settle;
      const refused = yield* control.beginMaintenance(instanceId).pipe(Effect.exit);
      assert.equal(failureTag(refused), "ManagedBrowserBusyError");
      // The refusal must not run the cleanup that reopens the first owner's window.
      assert.equal((yield* control.state(instanceId)).admission, "maintenance");

      yield* Fiber.interrupt(first);
      assert.equal((yield* control.state(instanceId)).admission, "open");
      yield* Deferred.succeed(runningGate, undefined);
      yield* Fiber.join(running);
    }),
  ),
);

it.effect("a cancelled caller does not free the writer while its real operation still runs", () =>
  provided(
    Effect.gen(function* () {
      const { control, inputReleases } = yield* setup;
      const gate = promiseGate();
      let finished = false;
      const started = yield* Deferred.make<void>();
      const caller = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(
              Effect.promise(() =>
                gate.promise.then(() => {
                  finished = true;
                }),
              ),
            ),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(caller);

      const acknowledged = yield* Deferred.make<void>();
      const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(
        Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
        Effect.forkScoped,
      );
      yield* untilState(control, transferring(1));
      assert.isFalse(yield* Deferred.isDone(acknowledged));
      assert.equal(yield* Ref.get(inputReleases), 0);
      assert.isFalse(finished);

      gate.open();
      const taken = yield* Fiber.join(takeover);
      assert.isTrue(finished);
      assert.equal(taken.generation, 1);
      assert.equal(yield* Ref.get(inputReleases), 1);
    }),
  ),
);

it.effect(
  "maintenance is not acknowledged until a cancelled caller's real operation completes",
  () =>
    provided(
      Effect.gen(function* () {
        const { control } = yield* setup;
        const gate = promiseGate();
        const started = yield* Deferred.make<void>();
        const caller = yield* control
          .run(agent, instanceId, fence(0), () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.promise(() => gate.promise)),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(caller);

        const acknowledged = yield* Deferred.make<void>();
        const maintenance = yield* control.beginMaintenance(instanceId).pipe(
          Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
          Effect.forkScoped,
        );
        yield* untilState(control, (state) => state.admission === "maintenance");
        assert.isFalse(yield* Deferred.isDone(acknowledged));

        gate.open();
        yield* Fiber.join(maintenance);
        assert.isTrue(yield* Deferred.isDone(acknowledged));
      }),
    ),
);

it.effect("a caller cancelled while queued never runs its work", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const firstStarted = yield* Deferred.make<void>();
      const firstGate = yield* Deferred.make<void>();
      const first = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      let ran = false;
      const queued = yield* control
        .run(agent, instanceId, fence(0), () =>
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* settle;
      yield* Fiber.interrupt(queued);

      yield* Deferred.succeed(firstGate, undefined);
      yield* Fiber.join(first);
      yield* control.run(agent, instanceId, fence(0), () => Effect.void);
      assert.isFalse(ran);
    }),
  ),
);

it.effect("child death releases a takeover waiting on an operation that cannot be cancelled", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const gate = promiseGate();
      const started = yield* Deferred.make<void>();
      yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.promise(() => gate.promise)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const settled = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      yield* control.takeControl(human, instanceId, boot1).pipe(
        Effect.exit,
        Effect.tap((exit) => Deferred.succeed(settled, exit)),
        Effect.forkScoped,
      );
      yield* untilState(control, transferring(1));
      assert.isFalse(yield* Deferred.isDone(settled));

      yield* control.detach(instanceId, boot1);
      assert.equal(
        failureTag(yield* Deferred.await(settled)),
        "ManagedBrowserInstanceUnavailableError",
      );
    }),
  ),
);

it.effect("a failed tracked navigation fails the takeover closed instead of reading as idle", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      yield* control.run(agent, instanceId, fence(0), ({ track }) =>
        track(Effect.fail("navigation lost")),
      );

      const take = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(take), "ManagedBrowserTransferFailedError");
      assert.equal(failureError(take)?.stage, "navigation");
      const state = yield* control.state(instanceId);
      assert.equal(state.phase, "paused");
      assert.equal(state.holder, null);

      // The failure was reported once; a deliberate retry then takes control.
      const retried = yield* control.takeControl(human, instanceId, boot1);
      assert.equal((yield* control.state(instanceId)).phase, "human");
      assert.equal(retried.generation, (yield* control.state(instanceId)).fence.generation);
    }),
  ),
);

it.effect("the next agent action also learns that tracked navigation failed", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      yield* control.run(agent, instanceId, fence(0), ({ track }) =>
        track(Effect.fail("navigation lost")),
      );
      const next = yield* control
        .run(agent, instanceId, fence(0), () => Effect.die("must not run"))
        .pipe(Effect.exit);
      assert.equal(failureTag(next), "ManagedBrowserTrackedWorkFailedError");
      yield* control.run(agent, instanceId, fence(0), () => Effect.void);
    }),
  ),
);

it.effect("publishes the transfer, and the new phase only once the old work has drained", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const states = yield* control.subscribe(instanceId, boot1);
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const sawTransfer = yield* Deferred.make<void>();
      yield* Stream.runForEach(states, (state) =>
        Ref.update(seen, (current) => [
          ...current,
          `${state.phase}@${state.fence.generation}`,
        ]).pipe(
          Effect.andThen(
            transferring(1)(state) ? Deferred.succeed(sawTransfer, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);

      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      const running = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runningGate)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);
      const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.forkScoped);
      yield* Deferred.await(sawTransfer);
      // The lease itself has not reached the target while the old work is still running.
      assert.equal((yield* control.state(instanceId)).phase, "transferring");
      assert.deepEqual(yield* Ref.get(seen), ["agent@0", "transferring@1"]);

      yield* Deferred.succeed(runningGate, undefined);
      yield* Fiber.join(running);
      yield* Fiber.join(takeover);
      yield* untilState(control, (state) => state.phase === "human");
      assert.equal((yield* control.state(instanceId)).fence.generation, 1);
    }),
  ),
);

it.effect("a cancelled takeover still releases the input the previous controller left down", () =>
  provided(
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const { control } = yield* setupWith(
        Deferred.succeed(released, undefined).pipe(Effect.asVoid),
      );
      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      const running = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runningGate)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);
      const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.forkScoped);
      yield* untilState(control, transferring(1));
      yield* Fiber.interrupt(takeover);

      yield* Deferred.succeed(runningGate, undefined);
      yield* Fiber.join(running);
      yield* Deferred.await(released);
      yield* untilState(control, (state) => state.phase === "human");
      const state = yield* control.state(instanceId);
      assert.equal(state.phase, "human");
      assert.equal(state.holder, human.id);
    }),
  ),
);

it.effect("an overlapping release returns the superseded takeover its changed state", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      const running = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runningGate)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);
      const takeover = yield* control
        .takeControl(human, instanceId, boot1)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* untilState(control, transferring(1));
      const release = yield* control
        .releaseControl(human, instanceId, boot1)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* untilState(control, transferring(2));

      yield* Deferred.succeed(runningGate, undefined);
      yield* Fiber.join(running);
      const takeExit = yield* Fiber.join(takeover);
      const releaseExit = yield* Fiber.join(release);

      assert.equal(failureTag(takeExit), "ManagedBrowserControlChangedError");
      const changed = failureError(takeExit)?.state as
        | { fence: { generation: number } }
        | undefined;
      assert.equal(changed?.fence.generation, 2);
      assert.isTrue(Exit.isSuccess(releaseExit));
      const final = yield* control.state(instanceId);
      assert.equal(final.phase, "agent");
      assert.equal(final.fence.generation, 2);
    }),
  ),
);

it.effect("fails closed to paused when releasing the previous controller's input fails", () =>
  provided(
    Effect.gen(function* () {
      const stuck = yield* Ref.make(true);
      const { control } = yield* setupWith(
        Ref.get(stuck).pipe(
          Effect.flatMap((isStuck) =>
            isStuck
              ? Effect.fail(
                  new ManagedBrowserControl.ManagedBrowserInputReleaseError({
                    instanceId,
                    cause: "input stuck",
                  }),
                )
              : Effect.void,
          ),
        ),
      );

      const take = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(take), "ManagedBrowserTransferFailedError");
      assert.equal(failureError(take)?.stage, "input");
      assert.equal((yield* control.state(instanceId)).phase, "paused");
      const blocked = yield* control
        .run(agent, instanceId, (yield* control.state(instanceId)).fence, () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(blocked), "ManagedBrowserControlHeldError");

      yield* Ref.set(stuck, false);
      const retried = yield* control.takeControl(human, instanceId, boot1);
      assert.equal((yield* control.state(instanceId)).phase, "human");
      yield* control.run(human, instanceId, retried, () => Effect.void);
    }),
  ),
);

it.effect("a stalled viewer holds only the latest state, not the history", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const states = yield* control.subscribe(instanceId, boot1);
      for (let cycle = 0; cycle < 5; cycle += 1) {
        yield* control.takeControl(human, instanceId, boot1);
        yield* control.releaseControl(human, instanceId, boot1);
      }
      const latest = yield* control.state(instanceId);

      const seen = yield* Stream.take(states, 2).pipe(Stream.runCollect);
      assert.deepEqual(
        seen.map((state) => state.fence.generation),
        [0, latest.fence.generation],
      );
    }),
  ),
);

it.effect("subscribing to a superseded incarnation is rejected", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const stale = yield* control.subscribe(instanceId, boot2).pipe(Effect.exit);
      assert.equal(failureTag(stale), "ManagedBrowserStaleIncarnationError");
      const current = yield* control.subscribe(instanceId, boot1);
      assert.isDefined(current);
    }),
  ),
);

/** Attaches boot1, then replaces it with boot2, whose input releases are counted. */
const replaced = Effect.gen(function* () {
  const { control } = yield* setup;
  const inputReleases = yield* Ref.make(0);
  yield* control.attach({
    instanceId,
    incarnation: boot2,
    releaseInput: Ref.update(inputReleases, (count) => count + 1),
  });
  return { control, inputReleases };
});

it.effect(
  "a takeover aimed at a replaced incarnation is refused and the replacement is untouched",
  () =>
    provided(
      Effect.gen(function* () {
        const { control, inputReleases } = yield* replaced;
        const before = yield* control.state(instanceId);

        const take = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.exit);
        assert.equal(failureTag(take), "ManagedBrowserStaleIncarnationError");

        assert.deepEqual(yield* control.state(instanceId), before);
        assert.equal(before.phase, "agent");
        assert.equal(yield* Ref.get(inputReleases), 0);
        // The current boot is still takeable by a viewer that names it.
        const taken = yield* control.takeControl(human, instanceId, boot2);
        assert.equal(taken.incarnation, boot2);
      }),
    ),
);

it.effect(
  "a handback aimed at a replaced incarnation cannot release the replacement's holder",
  () =>
    provided(
      Effect.gen(function* () {
        const { control, inputReleases } = yield* replaced;
        yield* control.takeControl(human, instanceId, boot2);
        const releasesBefore = yield* Ref.get(inputReleases);
        const before = yield* control.state(instanceId);

        const release = yield* control.releaseControl(human, instanceId, boot1).pipe(Effect.exit);
        assert.equal(failureTag(release), "ManagedBrowserStaleIncarnationError");

        assert.deepEqual(yield* control.state(instanceId), before);
        assert.equal(before.phase, "human");
        assert.equal(yield* Ref.get(inputReleases), releasesBefore);
      }),
    ),
);

it.effect("a delayed disconnect from the old incarnation does not pause the replacement", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* replaced;
      const taken = yield* control.takeControl(human, instanceId, boot2);

      // The same person's old viewer drops after the restart and reports late.
      yield* control.holderDisconnected(human.id, instanceId, boot1);
      assert.equal((yield* control.state(instanceId)).phase, "human");

      yield* TestClock.adjust("31 seconds");
      const after = yield* control.state(instanceId);
      assert.equal(after.phase, "human");
      assert.equal(after.holder, human.id);
      assert.equal(after.fence.generation, taken.generation);
      yield* control.run(human, instanceId, taken, () => Effect.void);
    }),
  ),
);

it.effect("a disconnect that names the current incarnation still starts the hold", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* replaced;
      yield* control.takeControl(human, instanceId, boot2);
      yield* control.holderDisconnected(human.id, instanceId, boot2);
      assert.equal((yield* control.state(instanceId)).phase, "reconnectHold");
      yield* TestClock.adjust("30 seconds");
      yield* untilState(control, (state) => state.phase === "paused", boot2);
      assert.equal((yield* control.state(instanceId)).phase, "paused");
    }),
  ),
);

/** Attaches boot1 with a child whose generation acknowledgement and input release are observable. */
const setupWithChildAck = (
  advanceGeneration: (
    generation: number,
  ) => Effect.Effect<void, ManagedBrowserControl.ManagedBrowserGenerationSyncError>,
  events: string[],
) =>
  Effect.gen(function* () {
    const control = yield* ManagedBrowserControl.ManagedBrowserControl;
    yield* control.attach({
      instanceId,
      incarnation: boot1,
      releaseInput: Effect.sync(() => events.push("input released")),
      advanceGeneration: (generation) =>
        Effect.sync(() => events.push(`advance ${generation}`)).pipe(
          Effect.andThen(advanceGeneration(generation)),
          Effect.tap(() => Effect.sync(() => events.push(`acknowledged ${generation}`))),
        ),
    });
    return control;
  });

it.effect(
  "the child learns the new generation while the old action runs, and a takeover waits for both",
  () =>
    provided(
      Effect.gen(function* () {
        const events: string[] = [];
        const ackGate = yield* Deferred.make<void>();
        const control = yield* setupWithChildAck(() => Deferred.await(ackGate), events);
        const runningStarted = yield* Deferred.make<void>();
        const runningGate = yield* Deferred.make<void>();
        yield* control
          .run(agent, instanceId, fence(0), () =>
            Deferred.succeed(runningStarted, undefined).pipe(
              Effect.andThen(Deferred.await(runningGate)),
              Effect.tap(() => Effect.sync(() => events.push("running finished"))),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(runningStarted);
        const acknowledged = yield* Deferred.make<void>();
        const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(
          Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
          Effect.forkScoped,
        );
        yield* untilState(control, transferring(1));

        // The child is told at once: a dialog or a stuck page it must unblock is waiting for this.
        yield* settle;
        assert.deepEqual(events, ["advance 1"]);
        yield* Deferred.succeed(runningGate, undefined);
        yield* settle;
        assert.deepEqual(events, ["advance 1", "running finished"]);
        // The running action is done but the child has not answered, so control is not handed over.
        assert.isFalse(yield* Deferred.isDone(acknowledged));

        yield* Deferred.succeed(ackGate, undefined);
        const taken = yield* Fiber.join(takeover);
        assert.equal(taken.generation, 1);
        assert.deepEqual(events, [
          "advance 1",
          "running finished",
          "acknowledged 1",
          "input released",
        ]);
      }),
    ),
);

it.effect("an early acknowledgement cannot hand over control before the old action returns", () =>
  provided(
    Effect.gen(function* () {
      const events: string[] = [];
      const control = yield* setupWithChildAck(() => Effect.void, events);
      const runningStarted = yield* Deferred.make<void>();
      const runningGate = yield* Deferred.make<void>();
      yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runningGate)),
            Effect.tap(() => Effect.sync(() => events.push("running finished"))),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);
      const acknowledged = yield* Deferred.make<void>();
      const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(
        Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
        Effect.forkScoped,
      );
      yield* untilState(control, transferring(1));
      yield* settle;
      // The child acknowledged, yet the action it was told about is still executing on our side.
      assert.deepEqual(events, ["advance 1", "acknowledged 1"]);
      assert.isFalse(yield* Deferred.isDone(acknowledged));
      assert.equal((yield* control.state(instanceId)).phase, "transferring");

      yield* Deferred.succeed(runningGate, undefined);
      yield* Fiber.join(takeover);
      assert.deepEqual(events, [
        "advance 1",
        "acknowledged 1",
        "running finished",
        "input released",
      ]);
    }),
  ),
);

it.effect(
  "an action blocked until the child learns the generation does not stall the takeover",
  () =>
    provided(
      Effect.gen(function* () {
        const events: string[] = [];
        // Models an action stuck on a browser dialog that the child dismisses when the generation arrives.
        const dialogDismissed = yield* Deferred.make<void>();
        const control = yield* setupWithChildAck(
          () => Deferred.succeed(dialogDismissed, undefined).pipe(Effect.asVoid),
          events,
        );
        const runningStarted = yield* Deferred.make<void>();
        yield* control
          .run(agent, instanceId, fence(0), () =>
            Deferred.succeed(runningStarted, undefined).pipe(
              Effect.andThen(Deferred.await(dialogDismissed)),
              Effect.tap(() => Effect.sync(() => events.push("action unblocked"))),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(runningStarted);

        const taken = yield* control.takeControl(human, instanceId, boot1);
        assert.equal(taken.generation, 1);
        assert.equal((yield* control.state(instanceId)).phase, "human");
        // The child's answer and the unblocked action race; only the ends are ordered.
        assert.equal(events[0], "advance 1");
        assert.equal(events.at(-1), "input released");
        assert.sameMembers(events, [
          "advance 1",
          "acknowledged 1",
          "action unblocked",
          "input released",
        ]);
      }),
    ),
  // Without the generation-first order this waits on the blocked action until the suite's timeout.
  { timeout: 5_000 },
);

it.effect("a child that cannot acknowledge the generation fails the takeover closed", () =>
  provided(
    Effect.gen(function* () {
      const events: string[] = [];
      const control = yield* setupWithChildAck(
        () =>
          Effect.fail(
            new ManagedBrowserControl.ManagedBrowserGenerationSyncError({
              instanceId,
              cause: new Error("deadline"),
            }),
          ),
        events,
      );

      const take = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.exit);
      assert.equal(failureTag(take), "ManagedBrowserTransferFailedError");
      assert.equal(failureError(take)?.stage, "generation");
      const state = yield* control.state(instanceId);
      assert.equal(state.phase, "paused");
      assert.equal(state.holder, null);
      // The old fence is dead and nobody was handed the browser.
      const old = yield* control
        .run(agent, instanceId, fence(0), () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(old), "ManagedBrowserControlHeldError");
      assert.notInclude(events, "input released");
    }),
  ),
);

it.effect(
  "a transfer overtaken by a later one is reported as changed and generations only increase",
  () =>
    provided(
      Effect.gen(function* () {
        const events: string[] = [];
        const control = yield* setupWithChildAck(() => Effect.void, events);
        const runningStarted = yield* Deferred.make<void>();
        const runningGate = yield* Deferred.make<void>();
        const running = yield* control
          .run(agent, instanceId, fence(0), () =>
            Deferred.succeed(runningStarted, undefined).pipe(
              Effect.andThen(Deferred.await(runningGate)),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(runningStarted);
        const takeover = yield* control
          .takeControl(human, instanceId, boot1)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* untilState(control, transferring(1));
        const release = yield* control
          .releaseControl(human, instanceId, boot1)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* untilState(control, transferring(2));

        yield* Deferred.succeed(runningGate, undefined);
        yield* Fiber.join(running);
        yield* Fiber.join(takeover);
        yield* Fiber.join(release);

        const sent = events
          .filter((event) => event.startsWith("advance"))
          .map((event) => Number(event.slice("advance ".length)));
        assert.isTrue(sent.length >= 1 && sent[sent.length - 1] === 2);
        assert.deepEqual(
          sent,
          [...sent].toSorted((a, b) => a - b),
        );
        assert.equal(new Set(sent).size, sent.length);
      }),
    ),
);

// ---------------------------------------------------------------------------
// Out-of-band calls: answering what the running action is blocked on
// ---------------------------------------------------------------------------

it.effect("an out-of-band call is not queued behind the action that is waiting for it", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const events: string[] = [];
      const runningStarted = yield* Deferred.make<void>();
      const answered = yield* Deferred.make<void>();
      // A running action blocked until something answers it, like a click waiting on a dialog.
      const running = yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(answered)),
            Effect.tap(() => Effect.sync(() => events.push("action finished"))),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);

      yield* control.runOutOfBand(agent, instanceId, fence(0), () =>
        Effect.sync(() => events.push("answer")).pipe(
          Effect.andThen(Deferred.succeed(answered, undefined)),
        ),
      );
      yield* Fiber.join(running);
      assert.deepEqual(events, ["answer", "action finished"]);
    }),
  ),
);

it.effect("an out-of-band call is checked against the lease exactly like a queued one", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const work = () => Effect.void;
      const stale = yield* control
        .runOutOfBand(agent, instanceId, fence(7), work)
        .pipe(Effect.exit);
      assert.equal(failureTag(stale), "ManagedBrowserStaleFenceError");
      const readOnly = yield* control
        .runOutOfBand(readOnlyAgent, instanceId, fence(0), work)
        .pipe(Effect.exit);
      assert.equal(failureTag(readOnly), "ManagedBrowserAccessDeniedError");
      const wrongBoot = yield* control
        .runOutOfBand(agent, instanceId, fence(0, boot2), work)
        .pipe(Effect.exit);
      assert.equal(failureTag(wrongBoot), "ManagedBrowserStaleFenceError");

      const taken = yield* control.takeControl(human, instanceId, boot1);
      // The agent is shut out after a takeover, with its old fence or the new one; the holder is not.
      const oldAgent = yield* control
        .runOutOfBand(agent, instanceId, fence(0), work)
        .pipe(Effect.exit);
      assert.equal(failureTag(oldAgent), "ManagedBrowserControlHeldError");
      const agentNow = yield* control
        .runOutOfBand(agent, instanceId, taken, work)
        .pipe(Effect.exit);
      assert.equal(failureTag(agentNow), "ManagedBrowserControlHeldError");
      yield* control.runOutOfBand(human, instanceId, taken, work);
    }),
  ),
);

it.effect("an out-of-band call is refused while a transfer is settling", () =>
  provided(
    Effect.gen(function* () {
      const events: string[] = [];
      const ackGate = yield* Deferred.make<void>();
      const control = yield* setupWithChildAck(() => Deferred.await(ackGate), events);
      const takeover = yield* control.takeControl(human, instanceId, boot1).pipe(Effect.forkScoped);
      yield* untilState(control, transferring(1));
      const exit = yield* control
        .runOutOfBand(agent, instanceId, fence(0), () => Effect.void)
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      yield* Deferred.succeed(ackGate, undefined);
      yield* Fiber.join(takeover);
    }),
  ),
);

it.effect("an out-of-band call still finishes work admitted before maintenance began", () =>
  provided(
    Effect.gen(function* () {
      const { control } = yield* setup;
      const runningStarted = yield* Deferred.make<void>();
      const answered = yield* Deferred.make<void>();
      yield* control
        .run(agent, instanceId, fence(0), () =>
          Deferred.succeed(runningStarted, undefined).pipe(
            Effect.andThen(Deferred.await(answered)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(runningStarted);
      const maintenance = yield* control.beginMaintenance(instanceId).pipe(Effect.forkScoped);
      yield* untilAdmission(control, "maintenance");
      // New queued work is refused, but the answer the running action needs is not.
      const refused = yield* control
        .run(agent, instanceId, fence(0), () => Effect.void)
        .pipe(Effect.exit);
      assert.equal(failureTag(refused), "ManagedBrowserMaintenanceError");
      yield* control.runOutOfBand(agent, instanceId, fence(0), () =>
        Deferred.succeed(answered, undefined),
      );
      const token = yield* Fiber.join(maintenance);
      yield* control.endMaintenance(instanceId, token);
    }),
  ),
);
