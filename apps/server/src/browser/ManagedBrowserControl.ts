/**
 * ManagedBrowserControl - the instance-wide writer lease for managed browsers.
 *
 * One lease per browser instance governs every mutation: agent calls, human page
 * input and full-window input alike. The supervisor routes all of them through
 * {@link ManagedBrowserControl.run}, so the lease is the only gate in front of
 * the engine child. This module knows nothing about the child or its protocol.
 *
 * Each mutation carries a fence of browser incarnation and control generation.
 * Every change of lease owner bumps the generation, which is what makes work
 * queued before a takeover, a disconnect or a restart fail instead of executing.
 *
 * A change of owner is a transfer: the lease enters `transferring` at once and the
 * child is told the new generation immediately, because the child may be holding the
 * running action on something only that generation unblocks (a browser dialog it then
 * dismisses). The previous controller's running work, tracked navigation and the
 * child's acknowledgement are then all awaited, input is released, and only then is
 * the target phase published. Control is never handed over before the old action has
 * drained, and never before the child has acknowledged. The fibers that have to
 * finish this are owned by the instance, so a caller that gives up can neither free
 * the writer while the browser is still executing its command nor skip the input
 * cleanup. They end when the command completes or the instance closes.
 *
 * @module ManagedBrowserControl
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  ManagedBrowserControlGeneration,
  ManagedBrowserControlState,
  ManagedBrowserFence,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserMaintenanceToken,
  ManagedBrowserPrincipalId,
  type ManagedBrowserAdmission,
  type ManagedBrowserControlPhase,
  type ManagedBrowserPrincipal,
} from "@t3tools/contracts";

/** How long a dropped human viewer keeps the lease before the instance pauses. */
export const MANAGED_BROWSER_RECONNECT_HOLD_MS = 30_000;

export class ManagedBrowserInstanceUnavailableError extends Schema.TaggedError<ManagedBrowserInstanceUnavailableError>()(
  "ManagedBrowserInstanceUnavailableError",
  { instanceId: ManagedBrowserInstanceId },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} is not running.`;
  }
}

export class ManagedBrowserAccessDeniedError extends Schema.TaggedError<ManagedBrowserAccessDeniedError>()(
  "ManagedBrowserAccessDeniedError",
  {
    instanceId: ManagedBrowserInstanceId,
    principalId: ManagedBrowserPrincipalId,
    required: Schema.Literals(["operate", "human"]),
  },
) {
  override get message(): string {
    return `Principal ${this.principalId} lacks the ${this.required} access required for managed browser ${this.instanceId}.`;
  }
}

/** The caller acted on a lease it no longer has: refetch state and snapshot before retrying. */
export class ManagedBrowserStaleFenceError extends Schema.TaggedError<ManagedBrowserStaleFenceError>()(
  "ManagedBrowserStaleFenceError",
  {
    instanceId: ManagedBrowserInstanceId,
    expected: ManagedBrowserFence,
    received: ManagedBrowserFence,
  },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} control changed. Refresh the snapshot before trying again.`;
  }
}

/** A reference or subscription names a boot of the browser that is no longer the current one. */
export class ManagedBrowserStaleIncarnationError extends Schema.TaggedError<ManagedBrowserStaleIncarnationError>()(
  "ManagedBrowserStaleIncarnationError",
  {
    instanceId: ManagedBrowserInstanceId,
    expected: ManagedBrowserIncarnation,
    received: ManagedBrowserIncarnation,
  },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} was restarted. Reconnect to its current incarnation.`;
  }
}

export class ManagedBrowserControlHeldError extends Schema.TaggedError<ManagedBrowserControlHeldError>()(
  "ManagedBrowserControlHeldError",
  {
    instanceId: ManagedBrowserInstanceId,
    phase: Schema.Literals(["human", "reconnectHold", "paused", "transferring"]),
  },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} is not available to this caller (${this.phase}).`;
  }
}

export class ManagedBrowserNotHolderError extends Schema.TaggedError<ManagedBrowserNotHolderError>()(
  "ManagedBrowserNotHolderError",
  { instanceId: ManagedBrowserInstanceId, principalId: ManagedBrowserPrincipalId },
) {
  override get message(): string {
    return `Principal ${this.principalId} does not hold control of managed browser ${this.instanceId}.`;
  }
}

export class ManagedBrowserMaintenanceError extends Schema.TaggedError<ManagedBrowserMaintenanceError>()(
  "ManagedBrowserMaintenanceError",
  { instanceId: ManagedBrowserInstanceId },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} is under maintenance and not accepting work.`;
  }
}

/** Maintenance was refused because a person, or another maintenance owner, still has the instance. */
export class ManagedBrowserBusyError extends Schema.TaggedError<ManagedBrowserBusyError>()(
  "ManagedBrowserBusyError",
  {
    instanceId: ManagedBrowserInstanceId,
    phase: Schema.Literals(["human", "reconnectHold", "maintenance"]),
  },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} is in use (${this.phase}).`;
  }
}

/** The caller does not hold the maintenance token for this instance, or no maintenance is active. */
export class ManagedBrowserMaintenanceOwnerError extends Schema.TaggedError<ManagedBrowserMaintenanceOwnerError>()(
  "ManagedBrowserMaintenanceOwnerError",
  { instanceId: ManagedBrowserInstanceId },
) {
  override get message(): string {
    return `Maintenance of managed browser ${this.instanceId} is not owned by this caller.`;
  }
}

export class ManagedBrowserIncarnationConflictError extends Schema.TaggedError<ManagedBrowserIncarnationConflictError>()(
  "ManagedBrowserIncarnationConflictError",
  { instanceId: ManagedBrowserInstanceId, incarnation: ManagedBrowserIncarnation },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} already has incarnation ${this.incarnation} attached.`;
  }
}

/**
 * Work an action started but did not wait for, such as a navigation, ended in failure. The browser's
 * state is unknown, so this is reported to the next drain instead of being read as idle.
 */
export class ManagedBrowserTrackedWorkFailedError extends Schema.TaggedError<ManagedBrowserTrackedWorkFailedError>()(
  "ManagedBrowserTrackedWorkFailedError",
  { instanceId: ManagedBrowserInstanceId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Background work in managed browser ${this.instanceId} failed.`;
  }
}

/** Releasing keys or buttons left pressed in the browser failed. */
export class ManagedBrowserInputReleaseError extends Schema.TaggedError<ManagedBrowserInputReleaseError>()(
  "ManagedBrowserInputReleaseError",
  { instanceId: ManagedBrowserInstanceId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not release input held in managed browser ${this.instanceId}.`;
  }
}

/** The child did not acknowledge the new control generation, so it may still be running the old controller's work. */
export class ManagedBrowserGenerationSyncError extends Schema.TaggedError<ManagedBrowserGenerationSyncError>()(
  "ManagedBrowserGenerationSyncError",
  { instanceId: ManagedBrowserInstanceId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} did not acknowledge the new control generation.`;
  }
}

/**
 * The previous controller could not be cleared out, so nobody was handed the browser.
 * The instance is paused and a human must take control again.
 */
export class ManagedBrowserTransferFailedError extends Schema.TaggedError<ManagedBrowserTransferFailedError>()(
  "ManagedBrowserTransferFailedError",
  {
    instanceId: ManagedBrowserInstanceId,
    stage: Schema.Literals(["navigation", "generation", "input"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not clear the previous controller of managed browser ${this.instanceId} (${this.stage}).`;
  }
}

/** Another change of control overtook this one; the fence it would have returned is already stale. */
export class ManagedBrowserControlChangedError extends Schema.TaggedError<ManagedBrowserControlChangedError>()(
  "ManagedBrowserControlChangedError",
  { instanceId: ManagedBrowserInstanceId, state: ManagedBrowserControlState },
) {
  override get message(): string {
    return `Control of managed browser ${this.instanceId} changed before this request completed.`;
  }
}

export type ManagedBrowserAdmissionError =
  | ManagedBrowserInstanceUnavailableError
  | ManagedBrowserAccessDeniedError
  | ManagedBrowserStaleFenceError
  | ManagedBrowserControlHeldError
  | ManagedBrowserNotHolderError
  | ManagedBrowserMaintenanceError;

export type ManagedBrowserTransferError =
  | ManagedBrowserInstanceUnavailableError
  | ManagedBrowserStaleIncarnationError
  | ManagedBrowserTransferFailedError
  | ManagedBrowserControlChangedError;

export interface ManagedBrowserAttachInput {
  readonly instanceId: ManagedBrowserInstanceId;
  readonly incarnation: ManagedBrowserIncarnation;
  /** Releases any key or button the previous controller left pressed in the browser. */
  readonly releaseInput: Effect.Effect<void, ManagedBrowserInputReleaseError>;
  /**
   * Tells the child the lease's new generation and resolves only once the child has acknowledged it,
   * which means the old controller's work in the child has finished. A transfer is never committed
   * before this resolves, so a deadline answer from the child cannot stand in for the work stopping.
   * Generations sent are strictly increasing; a transfer overtaken by a later one sends nothing.
   */
  readonly advanceGeneration?: (
    generation: ManagedBrowserControlGeneration,
  ) => Effect.Effect<void, ManagedBrowserGenerationSyncError>;
  /** Starts the incarnation with admission already closed, so a maintenance restart never opens a gap. */
  readonly startInMaintenance?: boolean;
}

export interface ManagedBrowserRunContext {
  /**
   * Registers work the action started but did not wait for, such as a navigation that
   * commits after the action returned. Later actions and takeovers wait for it, and a
   * failure of it is reported to them rather than treated as finished.
   */
  readonly track: <E>(work: Effect.Effect<void, E>) => Effect.Effect<void>;
}

export class ManagedBrowserControl extends Context.Service<
  ManagedBrowserControl,
  {
    /**
     * Registers a freshly started incarnation with an open agent lease at generation 0.
     * A previous incarnation of the same instance is closed; attaching the same one
     * twice fails. Resolves to the maintenance token when it started in maintenance.
     */
    readonly attach: (
      input: ManagedBrowserAttachInput,
    ) => Effect.Effect<
      ManagedBrowserMaintenanceToken | null,
      ManagedBrowserIncarnationConflictError
    >;
    /**
     * Closes an incarnation after its child exited. A stale incarnation is ignored so
     * a late exit event can never remove its replacement. Resolves to whether it removed anything.
     */
    readonly detach: (
      instanceId: ManagedBrowserInstanceId,
      incarnation: ManagedBrowserIncarnation,
    ) => Effect.Effect<boolean>;
    readonly state: (
      instanceId: ManagedBrowserInstanceId,
    ) => Effect.Effect<ManagedBrowserControlState, ManagedBrowserInstanceUnavailableError>;
    /**
     * Runs one mutation under the lease, strictly after every earlier admitted mutation
     * and any navigation they tracked. Admission and the start of execution each check
     * the fence, so a takeover while queued rejects the work.
     *
     * The mutation runs in a fiber the instance owns. If the caller is cancelled while it
     * runs, it keeps the writer until it completes or the instance closes; if the caller is
     * cancelled while still queued, it never starts.
     */
    readonly run: <A, E, R>(
      principal: ManagedBrowserPrincipal,
      instanceId: ManagedBrowserInstanceId,
      fence: ManagedBrowserFence,
      work: (context: ManagedBrowserRunContext) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | ManagedBrowserAdmissionError | ManagedBrowserTrackedWorkFailedError,
      R
    >;
    /**
     * Runs a call that must not queue behind the running mutation, because that mutation may be
     * waiting for exactly this: answering a browser dialog. It is admitted against the same
     * lease, fence and access as {@link run}, and is refused while ownership is changing, but it
     * takes no turn at the writer and waits for nothing. Maintenance does not refuse it, since
     * it finishes work that was already admitted. Use it only for such answers.
     */
    readonly runOutOfBand: <A, E, R>(
      principal: ManagedBrowserPrincipal,
      instanceId: ManagedBrowserInstanceId,
      fence: ManagedBrowserFence,
      work: () => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ManagedBrowserAdmissionError, R>;
    /**
     * Gives a human the lease. Resolves once running work and tracked navigation have
     * drained and stuck input is released, with the fence the holder must now present.
     * Re-taking while holding, or during the reconnect hold, is the explicit reacquisition.
     * `incarnation` is the boot the caller was shown; it is checked inside the lease change, so a
     * viewer of a replaced browser can never take the replacement.
     * Fails closed to `paused` if the previous controller cannot be cleared out, and with the
     * current state if another change of control overtook this one.
     */
    readonly takeControl: (
      principal: ManagedBrowserPrincipal,
      instanceId: ManagedBrowserInstanceId,
      incarnation: ManagedBrowserIncarnation,
    ) => Effect.Effect<
      ManagedBrowserFence,
      | ManagedBrowserTransferError
      | ManagedBrowserAccessDeniedError
      | ManagedBrowserMaintenanceError
      | ManagedBrowserControlHeldError
    >;
    /** Hands the lease back to agents. Callers need a fresh fence afterwards. */
    readonly releaseControl: (
      principal: ManagedBrowserPrincipal,
      instanceId: ManagedBrowserInstanceId,
      incarnation: ManagedBrowserIncarnation,
    ) => Effect.Effect<
      ManagedBrowserFence,
      ManagedBrowserTransferError | ManagedBrowserNotHolderError
    >;
    /**
     * The holder's viewer dropped. Nobody mutates for {@link MANAGED_BROWSER_RECONNECT_HOLD_MS};
     * after that the instance stays paused until a human explicitly takes control. A report that
     * names a replaced incarnation is ignored, so a late disconnect cannot pause the replacement.
     */
    readonly holderDisconnected: (
      principalId: ManagedBrowserPrincipalId,
      instanceId: ManagedBrowserInstanceId,
      incarnation: ManagedBrowserIncarnation,
    ) => Effect.Effect<void>;
    /**
     * The current state, then the latest state after any further changes, ending after the
     * instance closes. A slow consumer skips intermediate states instead of making the
     * instance retain them; every state is a complete snapshot.
     */
    readonly subscribe: (
      instanceId: ManagedBrowserInstanceId,
      incarnation: ManagedBrowserIncarnation,
    ) => Effect.Effect<
      Stream.Stream<ManagedBrowserControlState>,
      ManagedBrowserInstanceUnavailableError | ManagedBrowserStaleIncarnationError,
      Scope.Scope
    >;
    /**
     * Closes admission for the caller alone, then waits for admitted work and tracked navigation to
     * drain. Refuses without disturbing anything when a person holds the lease or another caller
     * already owns maintenance. Resolves to the token needed to end it; if the wait is abandoned
     * or fails, only the admission this call closed is reopened.
     */
    readonly beginMaintenance: (
      instanceId: ManagedBrowserInstanceId,
    ) => Effect.Effect<
      ManagedBrowserMaintenanceToken,
      | ManagedBrowserInstanceUnavailableError
      | ManagedBrowserBusyError
      | ManagedBrowserTrackedWorkFailedError
    >;
    readonly endMaintenance: (
      instanceId: ManagedBrowserInstanceId,
      token: ManagedBrowserMaintenanceToken,
    ) => Effect.Effect<
      void,
      ManagedBrowserInstanceUnavailableError | ManagedBrowserMaintenanceOwnerError
    >;
  }
>()("t3/browser/ManagedBrowserControl") {}

type SettledPhase = Exclude<ManagedBrowserControlPhase, "transferring">;

/** Where a transfer ends once the previous controller is cleared out. */
interface Transfer {
  readonly target: SettledPhase;
  readonly holder: ManagedBrowserPrincipalId | null;
  readonly holdExpiresAtMs: number | null;
}

interface LeaseState {
  /** The last committed phase; while `transfer` is set, the phase being left. */
  readonly phase: SettledPhase;
  readonly generation: number;
  readonly holder: ManagedBrowserPrincipalId | null;
  readonly admission: ManagedBrowserAdmission;
  readonly maintenanceToken: ManagedBrowserMaintenanceToken | null;
  readonly holdExpiresAtMs: number | null;
  readonly transfer: Transfer | null;
}

interface Entry {
  readonly instanceId: ManagedBrowserInstanceId;
  readonly incarnation: ManagedBrowserIncarnation;
  readonly lease: Ref.Ref<LeaseState>;
  /** Orders lease changes with their publication. */
  readonly stateLock: Semaphore.Semaphore;
  /** The single writer: at most one mutation reaches the child at a time. */
  readonly serial: Semaphore.Semaphore;
  readonly tracked: Ref.Ref<
    ReadonlyArray<Deferred.Deferred<void, ManagedBrowserTrackedWorkFailedError>>
  >;
  /** Holds only the latest state, so a stalled viewer cannot make the instance retain history. */
  readonly changes: PubSub.PubSub<ManagedBrowserControlState>;
  readonly releaseInput: Effect.Effect<void, ManagedBrowserInputReleaseError>;
  readonly advanceGeneration: NonNullable<ManagedBrowserAttachInput["advanceGeneration"]>;
  /** The highest generation already sent to the child; the child accepts only increases. */
  readonly sentGeneration: Ref.Ref<number>;
  /** Owns the entry's background work, so closing it cancels tracked navigation, transfers and hold timers. */
  readonly scope: Scope.Closeable;
}

const initialLease = (maintenanceToken: ManagedBrowserMaintenanceToken | null): LeaseState => ({
  phase: "agent",
  generation: 0,
  holder: null,
  admission: maintenanceToken === null ? "open" : "maintenance",
  maintenanceToken,
  holdExpiresAtMs: null,
  transfer: null,
});

const fenceAt = (entry: Entry, generation: number): ManagedBrowserFence => ({
  incarnation: entry.incarnation,
  generation: ManagedBrowserControlGeneration.make(generation),
});

/** Where the lease is headed: the transfer's target while one is settling, otherwise where it stands. */
const effective = (lease: LeaseState) => {
  const view = lease.transfer ?? lease;
  return {
    phase: lease.transfer?.target ?? lease.phase,
    holder: view.holder,
    holdExpiresAtMs: view.holdExpiresAtMs,
  };
};

const stateOf = (entry: Entry, lease: LeaseState): ManagedBrowserControlState => {
  const view = effective(lease);
  return {
    instanceId: entry.instanceId,
    fence: fenceAt(entry, lease.generation),
    phase: lease.transfer === null ? lease.phase : "transferring",
    admission: lease.admission,
    holder: view.holder,
    holdExpiresAtMs: view.holdExpiresAtMs,
  };
};

const beginTransfer = (lease: LeaseState, transfer: Transfer): LeaseState => ({
  ...lease,
  generation: lease.generation + 1,
  transfer,
});

/** What a lease change decided: the generation to settle, and whether anything has to be drained. */
interface Begun {
  readonly generation: number;
  readonly settle: boolean;
  readonly holdExpiresAtMs: number | null;
}

interface Settled {
  readonly generation: number;
  readonly outcome: "committed" | "superseded";
}

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

const make = Effect.gen(function* () {
  const layerScope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const registry = yield* Ref.make<ReadonlyMap<ManagedBrowserInstanceId, Entry>>(new Map());

  const mintMaintenanceToken = crypto.randomUUIDv4.pipe(
    Effect.orDie,
    Effect.map(ManagedBrowserMaintenanceToken.make),
  );

  const lookup = Effect.fnUntraced(function* (instanceId: ManagedBrowserInstanceId) {
    const entry = (yield* Ref.get(registry)).get(instanceId);
    if (entry === undefined) {
      return yield* new ManagedBrowserInstanceUnavailableError({ instanceId });
    }
    return entry;
  });

  /** Applies a lease change and publishes it, serialized so subscribers see changes in order. */
  const transition = <A, E>(
    entry: Entry,
    change: (lease: LeaseState) => Effect.Effect<readonly [A, LeaseState], E>,
  ) =>
    entry.stateLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(entry.lease);
        const [value, next] = yield* change(current);
        if (next !== current) {
          yield* Ref.set(entry.lease, next);
          yield* PubSub.publish(entry.changes, stateOf(entry, next));
        }
        return value;
      }),
    );

  const unlessClosed = (entry: Entry, lease: LeaseState) =>
    lease.admission === "closed"
      ? Effect.fail(new ManagedBrowserInstanceUnavailableError({ instanceId: entry.instanceId }))
      : Effect.void;

  /** Checked inside the lease change itself, against the entry that change applies to. */
  const sameIncarnation = (entry: Entry, received: ManagedBrowserIncarnation) =>
    entry.incarnation === received
      ? Effect.void
      : Effect.fail(
          new ManagedBrowserStaleIncarnationError({
            instanceId: entry.instanceId,
            expected: entry.incarnation,
            received,
          }),
        );

  const staleFence = (entry: Entry, lease: LeaseState, received: ManagedBrowserFence) =>
    new ManagedBrowserStaleFenceError({
      instanceId: entry.instanceId,
      expected: fenceAt(entry, lease.generation),
      received,
    });

  const admit = Effect.fnUntraced(function* (
    entry: Entry,
    principal: ManagedBrowserPrincipal,
    received: ManagedBrowserFence,
    mode: "admission" | "start",
  ) {
    const lease = yield* Ref.get(entry.lease);
    yield* unlessClosed(entry, lease);
    if (principal.access !== "operate") {
      return yield* new ManagedBrowserAccessDeniedError({
        instanceId: entry.instanceId,
        principalId: principal.id,
        required: "operate",
      });
    }
    if (received.incarnation !== entry.incarnation) {
      return yield* staleFence(entry, lease, received);
    }
    // Work admitted before maintenance began is allowed to finish; only new work is refused.
    if (mode === "admission" && lease.admission === "maintenance") {
      return yield* new ManagedBrowserMaintenanceError({ instanceId: entry.instanceId });
    }
    if (lease.transfer !== null) {
      return yield* new ManagedBrowserControlHeldError({
        instanceId: entry.instanceId,
        phase: "transferring",
      });
    }
    if (lease.phase === "agent") {
      if (principal.kind !== "agent") {
        return yield* new ManagedBrowserNotHolderError({
          instanceId: entry.instanceId,
          principalId: principal.id,
        });
      }
    } else if (lease.phase !== "human" || lease.holder !== principal.id) {
      return yield* new ManagedBrowserControlHeldError({
        instanceId: entry.instanceId,
        phase: lease.phase,
      });
    }
    if (received.generation !== lease.generation) {
      return yield* staleFence(entry, lease, received);
    }
  });

  /**
   * Waits for every piece of tracked work to settle, then reports the first failure. All of it is
   * forgotten afterwards, so each failure is reported once and a later drain starts clean.
   */
  const drainTracked = Effect.fnUntraced(function* (entry: Entry) {
    const pending = yield* Ref.get(entry.tracked);
    const exits = yield* Effect.forEach(pending, (done) => Effect.exit(Deferred.await(done)));
    yield* Ref.update(entry.tracked, (current) =>
      current.filter((done) => !pending.includes(done)),
    );
    const failed = exits.find(Exit.isFailure);
    if (failed !== undefined) return yield* Effect.failCause(failed.cause);
  });

  /** Waits out an owned fiber without owning it: a caller that is cancelled just stops waiting. */
  const awaitOwned = Effect.fnUntraced(function* <A, E>(
    entry: Entry,
    restore: Restore,
    fiber: Fiber.Fiber<A, E>,
    onCallerInterrupt: Effect.Effect<void> = Effect.void,
  ) {
    const exit = yield* restore(Fiber.await(fiber)).pipe(
      Effect.onInterrupt(() => onCallerInterrupt),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    // The instance closed underneath the work, which is the only way an owned fiber is interrupted.
    if (Cause.hasInterruptsOnly(exit.cause)) {
      return yield* new ManagedBrowserInstanceUnavailableError({ instanceId: entry.instanceId });
    }
    return yield* Effect.failCause(exit.cause);
  });

  /**
   * Tells the child the lease's new generation and resolves when it acknowledges it. A generation is
   * sent only if nothing newer went before it, so the child sees strictly increasing values; a
   * transfer another change has overtaken has nothing left to send, and its refusal is moot.
   */
  const requestGeneration = (entry: Entry, generation: number) =>
    Effect.gen(function* () {
      const reserved = yield* Ref.modify(entry.sentGeneration, (sent) =>
        generation > sent ? ([true, generation] as const) : ([false, sent] as const),
      );
      if (!reserved) return;
      yield* entry.advanceGeneration(ManagedBrowserControlGeneration.make(generation)).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new ManagedBrowserGenerationSyncError({ instanceId: entry.instanceId, cause: defect }),
          ),
        ),
        Effect.catch((error) =>
          Ref.get(entry.lease).pipe(
            Effect.flatMap((lease) =>
              lease.generation === generation ? Effect.fail(error) : Effect.void,
            ),
          ),
        ),
      );
    });

  /**
   * Runs after a lease change. The child hears the new generation first and concurrently with the
   * running action: it may be blocked on something only the generation clears. Then the running
   * action and tracked navigation drain, the child's acknowledgement (which it gives only after
   * earlier work finished) is awaited, and the old controller's input is cleared.
   */
  const clearPreviousController = (entry: Entry, generation: number) =>
    Effect.gen(function* () {
      const acknowledged = yield* Effect.forkIn(
        Effect.exit(requestGeneration(entry, generation)),
        entry.scope,
      );
      const drained = yield* Effect.exit(
        entry.serial.withPermits(1)(
          drainTracked(entry).pipe(
            Effect.mapError(
              (error) =>
                new ManagedBrowserTransferFailedError({
                  instanceId: entry.instanceId,
                  stage: "navigation",
                  cause: error.cause,
                }),
            ),
          ),
        ),
      );
      // Always settled, so a failed drain never leaves the request dangling.
      const acknowledgement = yield* Fiber.join(acknowledged);
      if (Exit.isFailure(drained)) return yield* Effect.failCause(drained.cause);
      if (Exit.isFailure(acknowledgement)) {
        return yield* new ManagedBrowserTransferFailedError({
          instanceId: entry.instanceId,
          stage: "generation",
          cause: Cause.squash(acknowledgement.cause),
        });
      }
      yield* entry.serial.withPermits(1)(
        entry.releaseInput.pipe(
          Effect.mapError(
            (error) =>
              new ManagedBrowserTransferFailedError({
                instanceId: entry.instanceId,
                stage: "input",
                cause: error.cause,
              }),
          ),
          Effect.catchDefect((defect) =>
            Effect.fail(
              new ManagedBrowserTransferFailedError({
                instanceId: entry.instanceId,
                stage: "input",
                cause: defect,
              }),
            ),
          ),
        ),
      );
    });

  /** Nobody was cleanly handed the browser, so nobody gets it until a human takes it again. */
  const failClosed = (entry: Entry, generation: number) =>
    transition(entry, (lease) =>
      Effect.succeed([
        undefined,
        lease.generation === generation
          ? ({
              ...lease,
              phase: "paused",
              holder: null,
              holdExpiresAtMs: null,
              transfer: null,
              generation: lease.generation + 1,
            } satisfies LeaseState)
          : lease,
      ] as const),
    );

  const commit = (entry: Entry, generation: number) =>
    transition(entry, (lease) => {
      if (lease.generation !== generation) {
        return Effect.succeed(["superseded", lease] as const);
      }
      const pending = lease.transfer;
      if (pending === null) return Effect.succeed(["committed", lease] as const);
      return Effect.succeed([
        "committed",
        {
          ...lease,
          phase: pending.target,
          holder: pending.holder,
          holdExpiresAtMs: pending.holdExpiresAtMs,
          transfer: null,
        } satisfies LeaseState,
      ] as const);
    });

  const settleTransfer = Effect.fnUntraced(function* (entry: Entry, generation: number) {
    const cleared = yield* Effect.exit(clearPreviousController(entry, generation));
    if (Exit.isFailure(cleared)) {
      yield* failClosed(entry, generation);
      return yield* Effect.failCause(cleared.cause);
    }
    return yield* commit(entry, generation);
  });

  /**
   * Changes who holds the lease and settles the change. The change and the start of its settling are
   * one uninterruptible step, so a caller cancelled in between cannot strand the lease in
   * `transferring`; the caller then waits for the owned settling and may abandon that wait.
   * Resolves to null when the change decided there was nothing to do.
   */
  const transfer = <E>(
    entry: Entry,
    begin: (lease: LeaseState) => Effect.Effect<readonly [Begun | null, LeaseState], E>,
    onBegun: (begun: Begun, restore: Restore) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const begun = yield* transition(entry, begin);
        if (begun === null) return null;
        yield* onBegun(begun, restore);
        if (!begun.settle) {
          return { generation: begun.generation, outcome: "committed" } satisfies Settled;
        }
        const fiber = yield* Effect.forkIn(
          restore(settleTransfer(entry, begun.generation)),
          entry.scope,
        );
        const outcome = yield* awaitOwned(entry, restore, fiber);
        return { generation: begun.generation, outcome } satisfies Settled;
      }),
    );

  const confirmed = Effect.fnUntraced(function* (entry: Entry, settled: Settled | null) {
    if (settled === null) return yield* Effect.die("A control transfer decided nothing to do.");
    if (settled.outcome === "committed") return fenceAt(entry, settled.generation);
    return yield* new ManagedBrowserControlChangedError({
      instanceId: entry.instanceId,
      state: stateOf(entry, yield* Ref.get(entry.lease)),
    });
  });

  const closeEntry = Effect.fnUntraced(function* (entry: Entry) {
    yield* transition(entry, (lease) =>
      Effect.succeed([undefined, { ...lease, admission: "closed" } satisfies LeaseState] as const),
    );
    yield* Scope.close(entry.scope, Exit.void);
  });

  const expireHold = (entry: Entry, generation: number) =>
    transfer(entry, (lease) => {
      if (lease.generation !== generation || effective(lease).phase !== "reconnectHold") {
        return Effect.succeed([null, lease] as const);
      }
      const next = beginTransfer(lease, { target: "paused", holder: null, holdExpiresAtMs: null });
      return Effect.succeed([
        { generation: next.generation, settle: true, holdExpiresAtMs: null },
        next,
      ] as const);
    }).pipe(Effect.ignore);

  const attach: ManagedBrowserControl["Service"]["attach"] = Effect.fnUntraced(function* (input) {
    const token = input.startInMaintenance === true ? yield* mintMaintenanceToken : null;
    const entry: Entry = {
      instanceId: input.instanceId,
      incarnation: input.incarnation,
      lease: yield* Ref.make(initialLease(token)),
      stateLock: yield* Semaphore.make(1),
      serial: yield* Semaphore.make(1),
      tracked: yield* Ref.make<
        ReadonlyArray<Deferred.Deferred<void, ManagedBrowserTrackedWorkFailedError>>
      >([]),
      changes: yield* PubSub.sliding<ManagedBrowserControlState>(1),
      releaseInput: input.releaseInput,
      advanceGeneration: input.advanceGeneration ?? (() => Effect.void),
      sentGeneration: yield* Ref.make(0),
      scope: yield* Scope.fork(layerScope, "sequential"),
    };
    const replaced = yield* Ref.modify(registry, (current) => {
      const previous = current.get(input.instanceId);
      if (previous?.incarnation === input.incarnation) return [previous, current] as const;
      return [previous ?? null, new Map(current).set(input.instanceId, entry)] as const;
    });
    if (replaced?.incarnation === input.incarnation) {
      yield* Scope.close(entry.scope, Exit.void);
      return yield* new ManagedBrowserIncarnationConflictError({
        instanceId: input.instanceId,
        incarnation: input.incarnation,
      });
    }
    if (replaced !== null) yield* closeEntry(replaced);
    return token;
  });

  const detach: ManagedBrowserControl["Service"]["detach"] = Effect.fnUntraced(
    function* (instanceId, incarnation) {
      const removed = yield* Ref.modify(registry, (current) => {
        const entry = current.get(instanceId);
        if (entry === undefined || entry.incarnation !== incarnation) {
          return [null, current] as const;
        }
        const next = new Map(current);
        next.delete(instanceId);
        return [entry, next] as const;
      });
      if (removed === null) return false;
      yield* closeEntry(removed);
      return true;
    },
  );

  const state: ManagedBrowserControl["Service"]["state"] = Effect.fnUntraced(
    function* (instanceId) {
      const entry = yield* lookup(instanceId);
      return stateOf(entry, yield* Ref.get(entry.lease));
    },
  );

  const trackOn = (entry: Entry): ManagedBrowserRunContext["track"] =>
    Effect.fnUntraced(function* <E>(work: Effect.Effect<void, E>) {
      const done = yield* Deferred.make<void, ManagedBrowserTrackedWorkFailedError>();
      yield* Ref.update(entry.tracked, (current) => [...current, done]);
      yield* Effect.exit(work).pipe(
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? Deferred.succeed(done, undefined)
            : Deferred.fail(
                done,
                new ManagedBrowserTrackedWorkFailedError({
                  instanceId: entry.instanceId,
                  cause: Cause.squash(exit.cause),
                }),
              ),
        ),
        // The instance closing is the only interruption; there is nothing left to wait for.
        Effect.onInterrupt(() => Deferred.succeed(done, undefined)),
        Effect.forkIn(entry.scope),
      );
    });

  const run: ManagedBrowserControl["Service"]["run"] = Effect.fnUntraced(
    function* (principal, instanceId, fence, work) {
      const entry = yield* lookup(instanceId);
      yield* admit(entry, principal, fence, "admission");
      const turn = yield* Ref.make<"queued" | "started" | "cancelled">("queued");
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(
            restore(
              entry.serial.withPermits(1)(
                Effect.gen(function* () {
                  const mine = yield* Ref.modify(turn, (current) =>
                    current === "queued"
                      ? ([true, "started"] as const)
                      : ([false, current] as const),
                  );
                  if (!mine) return yield* Effect.interrupt;
                  // The lease may have changed while this waited its turn.
                  yield* admit(entry, principal, fence, "start");
                  yield* drainTracked(entry);
                  yield* admit(entry, principal, fence, "start");
                  return yield* work({ track: trackOn(entry) });
                }),
              ),
            ),
            entry.scope,
          );
          // Cancelling a caller whose work has not started withdraws it; once started it runs on.
          const withdrawIfQueued = Ref.modify(turn, (current) =>
            current === "queued" ? ([true, "cancelled"] as const) : ([false, current] as const),
          ).pipe(Effect.flatMap((queued) => (queued ? Fiber.interrupt(fiber) : Effect.void)));
          return yield* awaitOwned(entry, restore, fiber, withdrawIfQueued);
        }),
      );
    },
  );

  const runOutOfBand: ManagedBrowserControl["Service"]["runOutOfBand"] = Effect.fnUntraced(
    function* (principal, instanceId, fence, work) {
      const entry = yield* lookup(instanceId);
      yield* admit(entry, principal, fence, "start");
      return yield* work();
    },
  );

  const takeControl: ManagedBrowserControl["Service"]["takeControl"] = Effect.fnUntraced(
    function* (principal, instanceId, incarnation) {
      const entry = yield* lookup(instanceId);
      if (principal.access !== "operate" || principal.kind !== "human") {
        return yield* new ManagedBrowserAccessDeniedError({
          instanceId,
          principalId: principal.id,
          required: principal.access !== "operate" ? "operate" : "human",
        });
      }
      const settled = yield* transfer(entry, (lease) =>
        Effect.gen(function* () {
          yield* unlessClosed(entry, lease);
          yield* sameIncarnation(entry, incarnation);
          if (lease.admission === "maintenance") {
            return yield* new ManagedBrowserMaintenanceError({ instanceId });
          }
          const heading = effective(lease);
          if (
            (heading.phase === "human" || heading.phase === "reconnectHold") &&
            heading.holder !== principal.id
          ) {
            return yield* new ManagedBrowserControlHeldError({ instanceId, phase: heading.phase });
          }
          if (heading.phase === "human") {
            // Already theirs; only an unfinished transfer to them still has to settle.
            return [
              {
                generation: lease.generation,
                settle: lease.transfer !== null,
                holdExpiresAtMs: null,
              },
              lease,
            ] as const;
          }
          const next = beginTransfer(lease, {
            target: "human",
            holder: principal.id,
            holdExpiresAtMs: null,
          });
          return [
            { generation: next.generation, settle: true, holdExpiresAtMs: null },
            next,
          ] as const;
        }),
      );
      return yield* confirmed(entry, settled);
    },
  );

  const releaseControl: ManagedBrowserControl["Service"]["releaseControl"] = Effect.fnUntraced(
    function* (principal, instanceId, incarnation) {
      const entry = yield* lookup(instanceId);
      const settled = yield* transfer(entry, (lease) =>
        Effect.gen(function* () {
          yield* unlessClosed(entry, lease);
          yield* sameIncarnation(entry, incarnation);
          const heading = effective(lease);
          if (
            (heading.phase !== "human" && heading.phase !== "reconnectHold") ||
            heading.holder !== principal.id
          ) {
            return yield* new ManagedBrowserNotHolderError({
              instanceId,
              principalId: principal.id,
            });
          }
          const next = beginTransfer(lease, {
            target: "agent",
            holder: null,
            holdExpiresAtMs: null,
          });
          return [
            { generation: next.generation, settle: true, holdExpiresAtMs: null },
            next,
          ] as const;
        }),
      );
      return yield* confirmed(entry, settled);
    },
  );

  const holderDisconnected: ManagedBrowserControl["Service"]["holderDisconnected"] =
    Effect.fnUntraced(function* (principalId, instanceId, incarnation) {
      // A viewer dropping after its browser is gone, or after it was replaced, has nothing left to hold.
      const entry = (yield* Ref.get(registry)).get(instanceId);
      if (entry === undefined || entry.incarnation !== incarnation) return;
      const now = yield* Clock.currentTimeMillis;
      yield* transfer(
        entry,
        (lease) => {
          const heading = effective(lease);
          if (heading.phase !== "human" || heading.holder !== principalId) {
            return Effect.succeed([null, lease] as const);
          }
          const holdExpiresAtMs = now + MANAGED_BROWSER_RECONNECT_HOLD_MS;
          const next = beginTransfer(lease, {
            target: "reconnectHold",
            holder: principalId,
            holdExpiresAtMs,
          });
          return Effect.succeed([
            { generation: next.generation, settle: true, holdExpiresAtMs },
            next,
          ] as const);
        },
        ({ generation, holdExpiresAtMs }, restore) =>
          holdExpiresAtMs === null
            ? Effect.void
            : // The timer measures from the recorded expiry, so it is right even if it starts late.
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((current) => Effect.sleep(Math.max(0, holdExpiresAtMs - current))),
                Effect.andThen(expireHold(entry, generation)),
                restore,
                Effect.forkIn(entry.scope),
                Effect.asVoid,
              ),
      ).pipe(Effect.ignore);
    });

  const subscribe: ManagedBrowserControl["Service"]["subscribe"] = Effect.fnUntraced(
    function* (instanceId, incarnation) {
      const entry = yield* lookup(instanceId);
      if (entry.incarnation !== incarnation) {
        return yield* new ManagedBrowserStaleIncarnationError({
          instanceId,
          expected: entry.incarnation,
          received: incarnation,
        });
      }
      // Subscribing and reading the current state are one step, so no change falls between them.
      const { subscription, initial } = yield* entry.stateLock.withPermits(1)(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(entry.changes);
          return { subscription, initial: stateOf(entry, yield* Ref.get(entry.lease)) };
        }),
      );
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription)).pipe(
        Stream.takeUntil((next) => next.admission === "closed"),
      );
    },
  );

  /** Reopens admission only if the maintenance still belongs to `token`. */
  const releaseMaintenance = (entry: Entry, token: ManagedBrowserMaintenanceToken) =>
    transition(entry, (lease) =>
      Effect.succeed([
        undefined,
        lease.maintenanceToken === token
          ? ({ ...lease, admission: "open", maintenanceToken: null } satisfies LeaseState)
          : lease,
      ] as const),
    );

  const beginMaintenance: ManagedBrowserControl["Service"]["beginMaintenance"] = Effect.fnUntraced(
    function* (instanceId) {
      const entry = yield* lookup(instanceId);
      const token = yield* mintMaintenanceToken;
      return yield* Effect.acquireUseRelease(
        transition(entry, (lease) =>
          Effect.gen(function* () {
            yield* unlessClosed(entry, lease);
            if (lease.maintenanceToken !== null) {
              return yield* new ManagedBrowserBusyError({ instanceId, phase: "maintenance" });
            }
            const heading = effective(lease);
            if (heading.phase === "human" || heading.phase === "reconnectHold") {
              return yield* new ManagedBrowserBusyError({ instanceId, phase: heading.phase });
            }
            return [
              token,
              { ...lease, admission: "maintenance", maintenanceToken: token } satisfies LeaseState,
            ] as const;
          }),
        ),
        // Anything queued before this point sits ahead of this permit, so waiting for it drains them.
        (owned) => entry.serial.withPermits(1)(drainTracked(entry)).pipe(Effect.as(owned)),
        (owned, exit) => (Exit.isSuccess(exit) ? Effect.void : releaseMaintenance(entry, owned)),
      );
    },
  );

  const endMaintenance: ManagedBrowserControl["Service"]["endMaintenance"] = Effect.fnUntraced(
    function* (instanceId, token) {
      const entry = yield* lookup(instanceId);
      yield* transition(entry, (lease) =>
        Effect.gen(function* () {
          yield* unlessClosed(entry, lease);
          if (lease.maintenanceToken !== token) {
            return yield* new ManagedBrowserMaintenanceOwnerError({ instanceId });
          }
          return [
            undefined,
            { ...lease, admission: "open", maintenanceToken: null } satisfies LeaseState,
          ] as const;
        }),
      );
    },
  );

  return ManagedBrowserControl.of({
    attach,
    detach,
    state,
    run,
    runOutOfBand,
    takeControl,
    releaseControl,
    holderDisconnected,
    subscribe,
    beginMaintenance,
    endMaintenance,
  });
});

export const layer = Layer.effect(ManagedBrowserControl, make);
