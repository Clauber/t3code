/**
 * ManagedBrowserSupervisor - owns the engine child process of each managed browser.
 *
 * The supervisor is the only holder of a running child. Every mutation reaches it
 * through {@link ManagedBrowserControl}'s lease, so nothing else can drive the
 * browser. It starts at most one child per instance, reports a dead child as
 * unavailable rather than launching a second browser over the same profile, and
 * keys every lifecycle event to the incarnation that produced it so a late exit
 * can never remove its replacement.
 *
 * Each instance is bound to one profile for the supervisor's lifetime, and each
 * profile to one instance, so a reference can never reach another profile's browser.
 * A reference also names the incarnation it was issued for and is rejected once the
 * browser has been replaced.
 *
 * Maintenance has one owner at a time, proved by an opaque token that restart and
 * end require. The check that admits a launch and the claim of its slot are a single
 * step, so no launch can slip past a window that opened a moment earlier.
 *
 * The child is reached through the {@link ManagedBrowserChildLauncher} port. Its
 * wire protocol is not defined here: requests carry an opaque operation until the
 * engine schema is frozen and the IPC adapter implements the port.
 *
 * @module ManagedBrowserSupervisor
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  EnvironmentId,
  ManagedBrowserControlGeneration,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserMaintenanceToken,
  ManagedBrowserProfileId,
  type ManagedBrowserControlState,
  type ManagedBrowserFence,
  type ManagedBrowserInstanceDescriptor,
  type ManagedBrowserPrincipal,
  type ManagedBrowserPrincipalId,
  type ManagedBrowserPrincipalKind,
  type ManagedBrowserRef,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";

export class ManagedBrowserChildLaunchError extends Schema.TaggedError<ManagedBrowserChildLaunchError>()(
  "ManagedBrowserChildLaunchError",
  { instanceId: ManagedBrowserInstanceId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to start managed browser ${this.instanceId}.`;
  }
}

export class ManagedBrowserChildChannelError extends Schema.TaggedError<ManagedBrowserChildChannelError>()(
  "ManagedBrowserChildChannelError",
  { instanceId: ManagedBrowserInstanceId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Lost contact with managed browser ${this.instanceId}.`;
  }
}

/** There is no live child to act on. A crashed child is never replaced implicitly. */
export class ManagedBrowserOwnerUnavailableError extends Schema.TaggedError<ManagedBrowserOwnerUnavailableError>()(
  "ManagedBrowserOwnerUnavailableError",
  {
    instanceId: ManagedBrowserInstanceId,
    reason: Schema.Literals([
      "notStarted",
      "starting",
      "exited",
      "crashed",
      "stopped",
      "launchFailed",
    ]),
  },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} is unavailable (${this.reason}).`;
  }
}

export class ManagedBrowserOwnerMismatchError extends Schema.TaggedError<ManagedBrowserOwnerMismatchError>()(
  "ManagedBrowserOwnerMismatchError",
  { expected: EnvironmentId, received: EnvironmentId },
) {
  override get message(): string {
    return "This managed browser belongs to a different environment.";
  }
}

/** The instance is already bound to a different profile. */
export class ManagedBrowserProfileMismatchError extends Schema.TaggedError<ManagedBrowserProfileMismatchError>()(
  "ManagedBrowserProfileMismatchError",
  {
    instanceId: ManagedBrowserInstanceId,
    expected: ManagedBrowserProfileId,
    received: ManagedBrowserProfileId,
  },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} does not use profile ${this.received}.`;
  }
}

/** The profile is already bound to another instance, and a profile has exactly one writer. */
export class ManagedBrowserProfileConflictError extends Schema.TaggedError<ManagedBrowserProfileConflictError>()(
  "ManagedBrowserProfileConflictError",
  { profileId: ManagedBrowserProfileId, instanceId: ManagedBrowserInstanceId },
) {
  override get message(): string {
    return `Profile ${this.profileId} already belongs to managed browser ${this.instanceId}.`;
  }
}

/**
 * The child reports it is still in use (shared tabs, dialogs, uploads, downloads, viewers, recordings,
 * pending launches or externally exposed contexts), so maintenance is deferred and admission is restored.
 */
export class ManagedBrowserMaintenanceDeferredError extends Schema.TaggedError<ManagedBrowserMaintenanceDeferredError>()(
  "ManagedBrowserMaintenanceDeferredError",
  { instanceId: ManagedBrowserInstanceId, reasons: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} is still in use (${this.reasons.join(", ")}).`;
  }
}

export interface ManagedBrowserChildSpec {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly instanceId: ManagedBrowserInstanceId;
  readonly profileId: ManagedBrowserProfileId;
  readonly incarnation: ManagedBrowserIncarnation;
}

export interface ManagedBrowserChildExit {
  /** False when the process ended without being asked to. */
  readonly clean: boolean;
}

/**
 * What the supervisor tells the child to do. The envelope names the identities the
 * child needs; `operation` stays opaque until the engine schema is frozen.
 */
export interface ManagedBrowserChildRequest {
  readonly ref: ManagedBrowserRef;
  readonly fence: ManagedBrowserFence;
  readonly callerId: ManagedBrowserPrincipalId;
  readonly callerKind: ManagedBrowserPrincipalKind;
  readonly operation: unknown;
  /** How long this call may take, in milliseconds; the child's default when omitted. */
  readonly deadlineMs?: number | undefined;
}

/** A request that needs no lease and no fence: opening or closing a viewer, acknowledging a frame, reading a download. */
export interface ManagedBrowserChildScopedRequest {
  readonly ref: ManagedBrowserRef;
  readonly callerId: ManagedBrowserPrincipalId;
  readonly callerKind: ManagedBrowserPrincipalKind;
  readonly operation: unknown;
  readonly deadlineMs?: number | undefined;
}

/** What the child says about whether it can be stopped without losing work. */
export interface ManagedBrowserChildIdleReport {
  readonly idle: boolean;
  /** Why it is not idle, such as `sharedSessions` or `dialogs`. */
  readonly reasons: ReadonlyArray<string>;
}

export interface ManagedBrowserChildResult {
  readonly value: unknown;
  /**
   * Settles when work the operation started but did not wait for, such as a navigation, has
   * committed. If it fails, the browser's state is unknown and a takeover must not proceed as if idle.
   */
  readonly pending?: Effect.Effect<void, ManagedBrowserChildChannelError> | undefined;
}

export interface ManagedBrowserChild {
  /**
   * The capabilities the child advertised when it started, such as `full-window`. Absent for a child
   * that does not report them, which is read as having none beyond the required ones.
   */
  readonly capabilities?: ReadonlyArray<string>;
  readonly execute: (
    request: ManagedBrowserChildRequest,
  ) => Effect.Effect<ManagedBrowserChildResult, ManagedBrowserChildChannelError>;
  /**
   * Tells the child the lease's new control generation. Resolves only when the child acknowledges it,
   * which must mean the previous controller's work in the child has finished; a deadline answer
   * while that work still runs must fail, not succeed. Generations are strictly increasing.
   */
  readonly setGeneration: (
    generation: ManagedBrowserControlGeneration,
  ) => Effect.Effect<void, ManagedBrowserChildChannelError>;
  /** Releases any key or button the previous controller left pressed. */
  readonly releaseInput: Effect.Effect<void, ManagedBrowserChildChannelError>;
  /** Answers a request that needs no lease. The caller's reference is validated before it gets here. */
  readonly scoped: (
    request: ManagedBrowserChildScopedRequest,
  ) => Effect.Effect<unknown, ManagedBrowserChildChannelError>;
  /**
   * What the child reports as it happens. A consumer that falls behind loses the oldest events, so
   * they are advisory: state is read again, not replayed.
   */
  readonly events: Stream.Stream<unknown>;
  /**
   * Reports whether the child is idle and, when asked, closes its own admission. The answer is the
   * child's, not an inference from what this process has seen.
   */
  readonly quiesce: (
    closeAdmission: boolean,
  ) => Effect.Effect<ManagedBrowserChildIdleReport, ManagedBrowserChildChannelError>;
  /** Completes when the process has ended, however it ended. */
  readonly exit: Effect.Effect<ManagedBrowserChildExit>;
}

/**
 * Starts the engine child. Closing the scope it is given must end the process and
 * wait for its exit, which is what proves the profile lock is released before a
 * replacement may start.
 */
export class ManagedBrowserChildLauncher extends Context.Service<
  ManagedBrowserChildLauncher,
  {
    readonly launch: (
      spec: ManagedBrowserChildSpec,
    ) => Effect.Effect<ManagedBrowserChild, ManagedBrowserChildLaunchError, Scope.Scope>;
  }
>()("t3/browser/ManagedBrowserSupervisor/ManagedBrowserChildLauncher") {}

export interface ManagedBrowserSupervisorOptions {
  /** The environment that owns the browsers; references to any other are rejected. */
  readonly ownerEnvironmentId: EnvironmentId;
}

/** Why a reference was refused before reaching the lease. */
export type ManagedBrowserRefError =
  | ManagedBrowserOwnerUnavailableError
  | ManagedBrowserOwnerMismatchError
  | ManagedBrowserProfileMismatchError
  | ManagedBrowserControl.ManagedBrowserStaleIncarnationError;

export interface ManagedBrowserCallOptions {
  readonly deadlineMs?: number | undefined;
  /**
   * Skips the writer's queue, for answering what the running action is blocked on (a dialog). It is
   * admitted against the same lease and fence. Use it for nothing else.
   */
  readonly outOfBand?: boolean | undefined;
}

export type ManagedBrowserExecuteError =
  | ManagedBrowserRefError
  | ManagedBrowserControl.ManagedBrowserAdmissionError
  | ManagedBrowserControl.ManagedBrowserTrackedWorkFailedError
  | ManagedBrowserChildChannelError;

export type ManagedBrowserTransferError =
  | ManagedBrowserRefError
  | ManagedBrowserControl.ManagedBrowserTransferFailedError
  | ManagedBrowserControl.ManagedBrowserControlChangedError;

export type ManagedBrowserEnsureError =
  | ManagedBrowserChildLaunchError
  | ManagedBrowserOwnerMismatchError
  | ManagedBrowserProfileMismatchError
  | ManagedBrowserProfileConflictError
  | ManagedBrowserControl.ManagedBrowserMaintenanceError;

export class ManagedBrowserSupervisor extends Context.Service<
  ManagedBrowserSupervisor,
  {
    /**
     * Starts the instance's child unless one is already running or starting, and resolves to a
     * reference to the running incarnation. The first ensure binds the instance to its profile for good.
     */
    readonly ensure: (
      descriptor: ManagedBrowserInstanceDescriptor,
    ) => Effect.Effect<ManagedBrowserRef, ManagedBrowserEnsureError>;
    /** The lease state, including the fence an agent must present to mutate. */
    readonly state: (
      ref: ManagedBrowserRef,
    ) => Effect.Effect<ManagedBrowserControlState, ManagedBrowserRefError>;
    /** `options.deadlineMs` bounds this one call; the child's default applies without it. */
    readonly execute: (
      principal: ManagedBrowserPrincipal,
      ref: ManagedBrowserRef,
      fence: ManagedBrowserFence,
      operation: unknown,
      options?: ManagedBrowserCallOptions,
    ) => Effect.Effect<unknown, ManagedBrowserExecuteError>;
    /**
     * A request that needs no lease (a viewer, a frame acknowledgement, a download), for any principal
     * that may read the browser `ref` names. The engine scopes what it returns by the caller it is told.
     */
    readonly scoped: (
      principal: ManagedBrowserPrincipal,
      ref: ManagedBrowserRef,
      operation: unknown,
      options?: ManagedBrowserCallOptions,
    ) => Effect.Effect<unknown, ManagedBrowserRefError | ManagedBrowserChildChannelError>;
    /** What the running browser `ref` names advertised at start. */
    readonly capabilities: (
      ref: ManagedBrowserRef,
    ) => Effect.Effect<ReadonlyArray<string>, ManagedBrowserRefError>;
    /** The child's events for as long as the incarnation `ref` names is alive; the stream ends with it. */
    readonly events: (
      principal: ManagedBrowserPrincipal,
      ref: ManagedBrowserRef,
    ) => Effect.Effect<Stream.Stream<unknown>, ManagedBrowserRefError, Scope.Scope>;
    /**
     * Gives a human the lease of the browser `ref` names. The reference is validated before the
     * transition and its incarnation again inside it, so a viewer of a replaced browser can never
     * take the replacement, even if the restart lands between the two.
     */
    readonly takeControl: (
      principal: ManagedBrowserPrincipal,
      ref: ManagedBrowserRef,
    ) => Effect.Effect<
      ManagedBrowserFence,
      | ManagedBrowserTransferError
      | ManagedBrowserControl.ManagedBrowserAccessDeniedError
      | ManagedBrowserControl.ManagedBrowserMaintenanceError
      | ManagedBrowserControl.ManagedBrowserControlHeldError
    >;
    /** Hands the browser `ref` names back to agents; validated like {@link takeControl}. */
    readonly releaseControl: (
      principal: ManagedBrowserPrincipal,
      ref: ManagedBrowserRef,
    ) => Effect.Effect<
      ManagedBrowserFence,
      ManagedBrowserTransferError | ManagedBrowserControl.ManagedBrowserNotHolderError
    >;
    /**
     * The controlling human's viewer dropped; starts the reconnect hold. A report that names a
     * replaced browser, or one that is gone, is ignored and cannot affect the replacement.
     */
    readonly holderDisconnected: (
      principalId: ManagedBrowserPrincipalId,
      ref: ManagedBrowserRef,
    ) => Effect.Effect<void>;
    readonly subscribe: (
      principal: ManagedBrowserPrincipal,
      ref: ManagedBrowserRef,
    ) => Effect.Effect<
      Stream.Stream<ManagedBrowserControlState>,
      ManagedBrowserRefError,
      Scope.Scope
    >;
    /**
     * Claims maintenance for the instance, closing admission including new launches, and waits for
     * admitted work to drain. It then asks the child itself whether it is idle: shared tabs, dialogs,
     * artifacts, viewers and the rest defer maintenance, and admission is restored. Refuses without
     * disturbing anything when a person is still using the browser or another caller already owns
     * maintenance. Resolves to the token that restart and end require; if the wait fails, defers or
     * is abandoned, only this claim is released.
     */
    readonly beginMaintenance: (
      instanceId: ManagedBrowserInstanceId,
    ) => Effect.Effect<
      ManagedBrowserMaintenanceToken,
      | ManagedBrowserControl.ManagedBrowserBusyError
      | ManagedBrowserControl.ManagedBrowserTrackedWorkFailedError
      | ManagedBrowserMaintenanceDeferredError
      | ManagedBrowserChildChannelError
    >;
    readonly endMaintenance: (
      instanceId: ManagedBrowserInstanceId,
      token: ManagedBrowserMaintenanceToken,
    ) => Effect.Effect<void, ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError>;
    /** Every instance this supervisor has bound to a profile, running or not: what a component update must drain. */
    readonly instances: Effect.Effect<ReadonlyArray<ManagedBrowserInstanceId>>;
    /**
     * Closes admission of every launch, including an instance nothing has launched before, until
     * {@link openAdmission}. Take it before listing {@link instances}: after it, no instance can be bound
     * that the list would miss. A restart for a maintenance owner still passes. Fails while another
     * barrier stands.
     */
    readonly closeAdmission: Effect.Effect<
      ManagedBrowserMaintenanceToken,
      ManagedBrowserControl.ManagedBrowserBusyError
    >;
    readonly openAdmission: (
      barrier: ManagedBrowserMaintenanceToken,
    ) => Effect.Effect<void, ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError>;
    /**
     * Ends the running child for the maintenance owner and resolves once its exit is proven, leaving the
     * instance unavailable. Nothing is started; admission stays closed until {@link endMaintenance}.
     */
    readonly stop: (
      instanceId: ManagedBrowserInstanceId,
      token: ManagedBrowserMaintenanceToken,
    ) => Effect.Effect<void, ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError>;
    /**
     * Replaces the running child for the maintenance owner, starting the new one only after the
     * old one's exit is proven. Admission stays closed until {@link endMaintenance}.
     */
    readonly restart: (
      instanceId: ManagedBrowserInstanceId,
      token: ManagedBrowserMaintenanceToken,
    ) => Effect.Effect<
      ManagedBrowserRef,
      | ManagedBrowserChildLaunchError
      | ManagedBrowserOwnerUnavailableError
      | ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError
    >;
  }
>()("t3/browser/ManagedBrowserSupervisor") {}

type UnavailableReason = ManagedBrowserOwnerUnavailableError["reason"];

type Slot =
  | {
      readonly _tag: "Starting";
      readonly incarnation: ManagedBrowserIncarnation;
      readonly ready: Deferred.Deferred<ManagedBrowserIncarnation, ManagedBrowserChildLaunchError>;
    }
  | {
      readonly _tag: "Running";
      readonly incarnation: ManagedBrowserIncarnation;
      readonly child: ManagedBrowserChild;
      readonly scope: Scope.Closeable;
    }
  | {
      readonly _tag: "Unavailable";
      readonly incarnation: ManagedBrowserIncarnation;
      readonly reason: UnavailableReason;
      /** Completes once the incarnation's process resources are released. */
      readonly released: Deferred.Deferred<void>;
    };

type Claim =
  | { readonly _tag: "running"; readonly slot: Extract<Slot, { _tag: "Running" }> }
  | { readonly _tag: "joined"; readonly slot: Extract<Slot, { _tag: "Starting" }> }
  | { readonly _tag: "claimed"; readonly previous: Deferred.Deferred<void> | null }
  | { readonly _tag: "maintenance" }
  | { readonly _tag: "notOwner" }
  | { readonly _tag: "profileMismatch"; readonly expected: ManagedBrowserProfileId }
  | { readonly _tag: "profileConflict"; readonly instanceId: ManagedBrowserInstanceId };

/** The maintenance one caller owns: its own token, the lease's token, and the child admission it closed. */
interface MaintenanceTicket {
  readonly token: ManagedBrowserMaintenanceToken;
  readonly control: ManagedBrowserMaintenanceToken | null;
  /** The incarnation whose own admission this maintenance closed, which ending it must reopen. */
  readonly childClosed: ManagedBrowserIncarnation | null;
}

interface SupervisorState {
  readonly slots: ReadonlyMap<ManagedBrowserInstanceId, Slot>;
  readonly maintenance: ReadonlyMap<ManagedBrowserInstanceId, MaintenanceTicket>;
  /** Set while a component update or outer update holds every launch, bound or not. */
  readonly barrier: ManagedBrowserMaintenanceToken | null;
  /** Fixed once bound: an instance's profile, and the one instance each profile belongs to. */
  readonly profiles: ReadonlyMap<ManagedBrowserInstanceId, ManagedBrowserProfileId>;
  readonly profileOwners: ReadonlyMap<ManagedBrowserProfileId, ManagedBrowserInstanceId>;
}

const make = (options: ManagedBrowserSupervisorOptions) =>
  Effect.gen(function* () {
    const control = yield* ManagedBrowserControl.ManagedBrowserControl;
    const launcher = yield* ManagedBrowserChildLauncher;
    const crypto = yield* Crypto.Crypto;
    const layerScope = yield* Effect.scope;
    const state = yield* Ref.make<SupervisorState>({
      slots: new Map(),
      maintenance: new Map(),
      barrier: null,
      profiles: new Map(),
      profileOwners: new Map(),
    });

    const setSlot = (instanceId: ManagedBrowserInstanceId, slot: Slot) =>
      Ref.update(state, (current) => ({
        ...current,
        slots: new Map(current.slots).set(instanceId, slot),
      }));

    const refTo = (
      descriptor: ManagedBrowserInstanceDescriptor,
      incarnation: ManagedBrowserIncarnation,
    ): ManagedBrowserRef => ({
      ownerEnvironmentId: descriptor.ownerEnvironmentId,
      instanceId: descriptor.instanceId,
      profileId: descriptor.profileId,
      incarnation,
    });

    /** Fails with why there is no live child, read from the slot's current state. */
    const unavailable = (instanceId: ManagedBrowserInstanceId) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const slot = current.slots.get(instanceId);
          const reason: UnavailableReason =
            slot === undefined
              ? "notStarted"
              : slot._tag === "Starting"
                ? "starting"
                : slot._tag === "Unavailable"
                  ? slot.reason
                  : "exited";
          return Effect.fail(new ManagedBrowserOwnerUnavailableError({ instanceId, reason }));
        }),
      );

    const requireRunning = Effect.fnUntraced(function* (instanceId: ManagedBrowserInstanceId) {
      const slot = (yield* Ref.get(state)).slots.get(instanceId);
      if (slot?._tag !== "Running") return yield* unavailable(instanceId);
      return slot;
    });

    const requireOwner = Effect.fnUntraced(function* (ownerEnvironmentId: EnvironmentId) {
      if (ownerEnvironmentId !== options.ownerEnvironmentId) {
        return yield* new ManagedBrowserOwnerMismatchError({
          expected: options.ownerEnvironmentId,
          received: ownerEnvironmentId,
        });
      }
    });

    /**
     * A reference is good only for the running incarnation of the instance bound to its profile.
     * Returns the running slot so the caller uses the child the reference was checked against.
     */
    const requireRef = Effect.fnUntraced(function* (ref: ManagedBrowserRef) {
      yield* requireOwner(ref.ownerEnvironmentId);
      const slot = yield* requireRunning(ref.instanceId);
      const bound = (yield* Ref.get(state)).profiles.get(ref.instanceId);
      if (bound !== ref.profileId) {
        return yield* new ManagedBrowserProfileMismatchError({
          instanceId: ref.instanceId,
          expected: bound ?? ref.profileId,
          received: ref.profileId,
        });
      }
      if (slot.incarnation !== ref.incarnation) {
        return yield* new ManagedBrowserControl.ManagedBrowserStaleIncarnationError({
          instanceId: ref.instanceId,
          expected: slot.incarnation,
          received: ref.incarnation,
        });
      }
      return slot;
    });

    /**
     * A control-layer miss means the child went away between lookup and use. Naming why: a
     * replacement is a stale reference, anything else is an unavailable owner.
     */
    const lostRef = (ref: ManagedBrowserRef) =>
      requireRef(ref).pipe(Effect.andThen(unavailable(ref.instanceId)));

    const mintIncarnation = crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map(ManagedBrowserIncarnation.make),
    );
    const mintToken = crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map(ManagedBrowserMaintenanceToken.make),
    );

    /** Records the lease's maintenance token on the ticket, if the ticket still belongs to `token`. */
    const recordControlToken = (
      instanceId: ManagedBrowserInstanceId,
      token: ManagedBrowserMaintenanceToken,
      controlToken: ManagedBrowserMaintenanceToken | null,
    ) =>
      Ref.modify(state, (current) => {
        const ticket = current.maintenance.get(instanceId);
        if (ticket?.token !== token) return [false, current] as const;
        return [
          true,
          {
            ...current,
            maintenance: new Map(current.maintenance).set(instanceId, {
              token,
              control: controlToken,
              childClosed: controlToken === null ? null : ticket.childClosed,
            }),
          },
        ] as const;
      });

    /** Remembers which incarnation's admission this maintenance closed, if the ticket still belongs to `token`. */
    const recordChildClosed = (
      instanceId: ManagedBrowserInstanceId,
      token: ManagedBrowserMaintenanceToken,
      incarnation: ManagedBrowserIncarnation | null,
    ) =>
      Ref.update(state, (current) => {
        const ticket = current.maintenance.get(instanceId);
        if (ticket?.token !== token) return current;
        return {
          ...current,
          maintenance: new Map(current.maintenance).set(instanceId, {
            ...ticket,
            childClosed: incarnation,
          }),
        };
      });

    /**
     * Records the end of one incarnation. Only the incarnation that is still the
     * running one may retire the slot, so a stale exit is ignored entirely.
     */
    const retire = Effect.fnUntraced(function* (
      instanceId: ManagedBrowserInstanceId,
      incarnation: ManagedBrowserIncarnation,
      reason: UnavailableReason,
    ) {
      const released = yield* Deferred.make<void>();
      const retired = yield* Ref.modify(state, (current) => {
        const slot = current.slots.get(instanceId);
        if (slot?._tag !== "Running" || slot.incarnation !== incarnation) {
          return [null, current] as const;
        }
        return [
          slot,
          {
            ...current,
            slots: new Map(current.slots).set(instanceId, {
              _tag: "Unavailable",
              incarnation,
              reason,
              released,
            }),
          },
        ] as const;
      });
      if (retired === null) return false;
      yield* control.detach(instanceId, incarnation);
      yield* Scope.close(retired.scope, Exit.void);
      yield* Deferred.succeed(released, undefined);
      return true;
    });

    const watch = (
      instanceId: ManagedBrowserInstanceId,
      incarnation: ManagedBrowserIncarnation,
      child: ManagedBrowserChild,
    ) =>
      child.exit.pipe(
        Effect.flatMap((exit) =>
          retire(instanceId, incarnation, exit.clean ? "exited" : "crashed"),
        ),
        Effect.forkIn(layerScope),
        Effect.asVoid,
      );

    const launch = Effect.fnUntraced(function* (
      descriptor: ManagedBrowserInstanceDescriptor,
      incarnation: ManagedBrowserIncarnation,
      ready: Deferred.Deferred<ManagedBrowserIncarnation, ManagedBrowserChildLaunchError>,
      previous: Deferred.Deferred<void> | null,
      owner: ManagedBrowserMaintenanceToken | null,
    ) {
      const { instanceId, profileId } = descriptor;
      // A replacement never starts until the previous process is proven gone.
      if (previous !== null) yield* Deferred.await(previous);
      const scope = yield* Scope.fork(layerScope, "sequential");
      const launched = yield* launcher
        .launch({
          ownerEnvironmentId: descriptor.ownerEnvironmentId,
          instanceId,
          profileId,
          incarnation,
        })
        .pipe(Scope.provide(scope), Effect.exit);
      if (Exit.isFailure(launched)) {
        const released = yield* Deferred.make<void>();
        yield* Scope.close(scope, Exit.void);
        yield* Deferred.succeed(released, undefined);
        yield* setSlot(instanceId, {
          _tag: "Unavailable",
          incarnation,
          reason: "launchFailed",
          released,
        });
        return yield* Deferred.failCause(ready, launched.cause);
      }
      const child = launched.value;
      // A replacement made for the maintenance owner starts with admission already closed.
      const controlToken = yield* control
        .attach({
          instanceId,
          incarnation,
          releaseInput: child.releaseInput.pipe(
            Effect.mapError(
              (cause) =>
                new ManagedBrowserControl.ManagedBrowserInputReleaseError({ instanceId, cause }),
            ),
          ),
          advanceGeneration: (generation) =>
            child.setGeneration(generation).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedBrowserControl.ManagedBrowserGenerationSyncError({
                    instanceId,
                    cause,
                  }),
              ),
            ),
          startInMaintenance: owner !== null,
        })
        .pipe(Effect.orDie);
      if (owner !== null) {
        const recorded = yield* recordControlToken(instanceId, owner, controlToken);
        // Maintenance ended while this launched, so nobody is left to reopen what it closed.
        if (!recorded && controlToken !== null) {
          yield* control.endMaintenance(instanceId, controlToken).pipe(Effect.ignore);
        }
      }
      yield* setSlot(instanceId, { _tag: "Running", incarnation, child, scope });
      yield* watch(instanceId, incarnation, child);
      yield* Deferred.succeed(ready, incarnation);
    });

    /**
     * Claims the instance for a launch, or joins the one already in flight or running. Whether
     * maintenance admits the launch, the profile binding, and the slot claim are decided in one
     * step: `owner` is null for an ordinary launch, which maintenance refuses, or the token of the
     * maintenance a restart is acting for.
     */
    const start = Effect.fnUntraced(function* (
      descriptor: ManagedBrowserInstanceDescriptor,
      owner: ManagedBrowserMaintenanceToken | null,
    ) {
      const { instanceId, profileId } = descriptor;
      const incarnation = yield* mintIncarnation;
      const ready = yield* Deferred.make<
        ManagedBrowserIncarnation,
        ManagedBrowserChildLaunchError
      >();
      const claim = yield* Ref.modify(state, (current): readonly [Claim, SupervisorState] => {
        const ticket = current.maintenance.get(instanceId);
        if (owner === null && (ticket !== undefined || current.barrier !== null)) {
          return [{ _tag: "maintenance" }, current];
        }
        if (owner !== null && ticket?.token !== owner) return [{ _tag: "notOwner" }, current];
        const bound = current.profiles.get(instanceId);
        if (bound !== undefined && bound !== profileId) {
          return [{ _tag: "profileMismatch", expected: bound }, current];
        }
        const holder = current.profileOwners.get(profileId);
        if (holder !== undefined && holder !== instanceId) {
          return [{ _tag: "profileConflict", instanceId: holder }, current];
        }
        const slot = current.slots.get(instanceId);
        if (slot?._tag === "Running") return [{ _tag: "running", slot }, current];
        if (slot?._tag === "Starting") return [{ _tag: "joined", slot }, current];
        return [
          { _tag: "claimed", previous: slot?._tag === "Unavailable" ? slot.released : null },
          {
            ...current,
            slots: new Map(current.slots).set(instanceId, {
              _tag: "Starting",
              incarnation,
              ready,
            }),
            profiles: new Map(current.profiles).set(instanceId, profileId),
            profileOwners: new Map(current.profileOwners).set(profileId, instanceId),
          },
        ];
      });
      switch (claim._tag) {
        case "maintenance":
          return yield* new ManagedBrowserControl.ManagedBrowserMaintenanceError({ instanceId });
        case "notOwner":
          return yield* new ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError({
            instanceId,
          });
        case "profileMismatch":
          return yield* new ManagedBrowserProfileMismatchError({
            instanceId,
            expected: claim.expected,
            received: profileId,
          });
        case "profileConflict":
          return yield* new ManagedBrowserProfileConflictError({
            profileId,
            instanceId: claim.instanceId,
          });
        case "running":
          return refTo(descriptor, claim.slot.incarnation);
        case "joined":
          return refTo(descriptor, yield* Deferred.await(claim.slot.ready));
        case "claimed":
          break;
      }
      // The launch outlives this caller, so an interrupted ensure cannot strand the slot in Starting.
      yield* launch(descriptor, incarnation, ready, claim.previous, owner).pipe(
        Effect.catchCause((cause) => Deferred.failCause(ready, cause)),
        Effect.forkIn(layerScope),
      );
      return refTo(descriptor, yield* Deferred.await(ready));
    });

    const ensure: ManagedBrowserSupervisor["Service"]["ensure"] = Effect.fnUntraced(
      function* (descriptor) {
        yield* requireOwner(descriptor.ownerEnvironmentId);
        return yield* start(descriptor, null).pipe(
          Effect.catchTag("ManagedBrowserMaintenanceOwnerError", (error) => Effect.die(error)),
        );
      },
    );

    const controlState: ManagedBrowserSupervisor["Service"]["state"] = Effect.fnUntraced(
      function* (ref) {
        yield* requireRef(ref);
        const current = yield* control
          .state(ref.instanceId)
          .pipe(Effect.catchTag("ManagedBrowserInstanceUnavailableError", () => lostRef(ref)));
        // A restart between the two reads replaced the browser this reference named.
        if (current.fence.incarnation !== ref.incarnation) {
          return yield* new ManagedBrowserControl.ManagedBrowserStaleIncarnationError({
            instanceId: ref.instanceId,
            expected: current.fence.incarnation,
            received: ref.incarnation,
          });
        }
        return current;
      },
    );

    const capabilities: ManagedBrowserSupervisor["Service"]["capabilities"] = (ref) =>
      requireRef(ref).pipe(Effect.map(({ child }) => child.capabilities ?? []));

    const execute: ManagedBrowserSupervisor["Service"]["execute"] = Effect.fnUntraced(
      function* (principal, ref, fence, operation, options) {
        const { child } = yield* requireRef(ref);
        // The child was chosen by the reference, so the fence must name the same boot.
        if (fence.incarnation !== ref.incarnation) {
          return yield* new ManagedBrowserControl.ManagedBrowserStaleIncarnationError({
            instanceId: ref.instanceId,
            expected: ref.incarnation,
            received: fence.incarnation,
          });
        }
        const request: ManagedBrowserChildRequest = {
          ref,
          fence,
          callerId: principal.id,
          callerKind: principal.kind,
          operation,
          deadlineMs: options?.deadlineMs,
        };
        if (options?.outOfBand === true) {
          return yield* control
            .runOutOfBand(principal, ref.instanceId, fence, () =>
              child.execute(request).pipe(Effect.map((result) => result.value)),
            )
            .pipe(Effect.catchTag("ManagedBrowserInstanceUnavailableError", () => lostRef(ref)));
        }
        return yield* control
          .run(principal, ref.instanceId, fence, ({ track }) =>
            Effect.gen(function* () {
              const result = yield* child.execute(request);
              if (result.pending !== undefined) yield* track(result.pending);
              return result.value;
            }),
          )
          .pipe(Effect.catchTag("ManagedBrowserInstanceUnavailableError", () => lostRef(ref)));
      },
    );

    const scoped: ManagedBrowserSupervisor["Service"]["scoped"] = Effect.fnUntraced(
      function* (principal, ref, operation, options) {
        const { child } = yield* requireRef(ref);
        return yield* child.scoped({
          ref,
          callerId: principal.id,
          callerKind: principal.kind,
          operation,
          deadlineMs: options?.deadlineMs,
        });
      },
    );

    const events: ManagedBrowserSupervisor["Service"]["events"] = Effect.fnUntraced(
      function* (principal, ref) {
        yield* Effect.annotateCurrentSpan("principalId", principal.id);
        const { child } = yield* requireRef(ref);
        // The stream belongs to this incarnation and ends when it does.
        return child.events.pipe(Stream.interruptWhen(child.exit));
      },
    );

    const takeControl: ManagedBrowserSupervisor["Service"]["takeControl"] = Effect.fnUntraced(
      function* (principal, ref) {
        yield* requireRef(ref);
        return yield* control
          .takeControl(principal, ref.instanceId, ref.incarnation)
          .pipe(Effect.catchTag("ManagedBrowserInstanceUnavailableError", () => lostRef(ref)));
      },
    );

    const releaseControl: ManagedBrowserSupervisor["Service"]["releaseControl"] = Effect.fnUntraced(
      function* (principal, ref) {
        yield* requireRef(ref);
        return yield* control
          .releaseControl(principal, ref.instanceId, ref.incarnation)
          .pipe(Effect.catchTag("ManagedBrowserInstanceUnavailableError", () => lostRef(ref)));
      },
    );

    const holderDisconnected: ManagedBrowserSupervisor["Service"]["holderDisconnected"] = (
      principalId,
      ref,
    ) =>
      requireRef(ref).pipe(
        Effect.andThen(control.holderDisconnected(principalId, ref.instanceId, ref.incarnation)),
        Effect.ignore,
      );

    const subscribe: ManagedBrowserSupervisor["Service"]["subscribe"] = Effect.fnUntraced(
      function* (principal, ref) {
        yield* Effect.annotateCurrentSpan("principalId", principal.id);
        yield* requireRef(ref);
        return yield* control
          .subscribe(ref.instanceId, ref.incarnation)
          .pipe(Effect.catchTag("ManagedBrowserInstanceUnavailableError", () => lostRef(ref)));
      },
    );

    /** Gives up the maintenance `token` owns, and the lease's admission closure that goes with it. */
    const releaseMaintenance = Effect.fnUntraced(function* (
      instanceId: ManagedBrowserInstanceId,
      token: ManagedBrowserMaintenanceToken,
    ) {
      const ticket = yield* Ref.modify(state, (current) => {
        const held = current.maintenance.get(instanceId);
        if (held?.token !== token) return [null, current] as const;
        const maintenance = new Map(current.maintenance);
        maintenance.delete(instanceId);
        return [held, { ...current, maintenance }] as const;
      });
      if (ticket === null) return false;
      // Only the incarnation whose admission was closed is reopened; a replacement was never closed.
      if (ticket.childClosed !== null) {
        const slot = (yield* Ref.get(state)).slots.get(instanceId);
        if (slot?._tag === "Running" && slot.incarnation === ticket.childClosed) {
          yield* slot.child.quiesce(false).pipe(Effect.ignore);
        }
      }
      if (ticket.control !== null) {
        yield* control.endMaintenance(instanceId, ticket.control).pipe(Effect.ignore);
      }
      return true;
    });

    const endMaintenance: ManagedBrowserSupervisor["Service"]["endMaintenance"] = Effect.fnUntraced(
      function* (instanceId, token) {
        if (!(yield* releaseMaintenance(instanceId, token))) {
          return yield* new ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError({
            instanceId,
          });
        }
      },
    );

    const beginMaintenance: ManagedBrowserSupervisor["Service"]["beginMaintenance"] =
      Effect.fnUntraced(function* (instanceId) {
        const token = yield* mintToken;
        return yield* Effect.acquireUseRelease(
          // Claiming the window and reading what is running are one step.
          Ref.modify(
            state,
            (current): readonly [{ claimed: boolean; slot: Slot | undefined }, SupervisorState] => {
              if (current.maintenance.has(instanceId)) {
                return [{ claimed: false, slot: undefined }, current];
              }
              return [
                { claimed: true, slot: current.slots.get(instanceId) },
                {
                  ...current,
                  maintenance: new Map(current.maintenance).set(instanceId, {
                    token,
                    control: null,
                    childClosed: null,
                  }),
                },
              ];
            },
          ).pipe(
            Effect.flatMap((claim) =>
              claim.claimed
                ? Effect.succeed(claim.slot)
                : Effect.fail(
                    new ManagedBrowserControl.ManagedBrowserBusyError({
                      instanceId,
                      phase: "maintenance",
                    }),
                  ),
            ),
          ),
          (slot) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                // A launch in flight is admitted work; it settles before the drain is judged.
                if (slot?._tag === "Starting") {
                  yield* restore(Deferred.await(slot.ready)).pipe(Effect.ignore);
                }
                if ((yield* Ref.get(state)).slots.get(instanceId)?._tag !== "Running") return token;
                // Nothing running is nothing to drain; a child that vanished meanwhile has no admission left to close.
                const controlToken = yield* restore(control.beginMaintenance(instanceId)).pipe(
                  Effect.catchTag("ManagedBrowserInstanceUnavailableError", () =>
                    Effect.succeed(null),
                  ),
                );
                // Remembering the lease's token cannot be cancelled once it exists, or nobody could reopen it.
                const recorded = yield* recordControlToken(instanceId, token, controlToken);
                if (!recorded && controlToken !== null) {
                  yield* control.endMaintenance(instanceId, controlToken).pipe(Effect.ignore);
                }
                if (!recorded || controlToken === null) return token;
                // T3 has drained what it knows of; whether the child is idle is the child's to say.
                const running = (yield* Ref.get(state)).slots.get(instanceId);
                if (running?._tag !== "Running") return token;
                // Recorded before the child is asked, so a failure or deferral reopens what it closed.
                yield* recordChildClosed(instanceId, token, running.incarnation);
                const report = yield* restore(running.child.quiesce(true));
                if (!report.idle) {
                  return yield* new ManagedBrowserMaintenanceDeferredError({
                    instanceId,
                    reasons: report.reasons,
                  });
                }
                return token;
              }),
            ),
          (_slot, exit) =>
            Exit.isSuccess(exit) ? Effect.void : releaseMaintenance(instanceId, token),
        );
      });

    const closeAdmission: ManagedBrowserSupervisor["Service"]["closeAdmission"] = Effect.gen(
      function* () {
        const token = yield* mintToken;
        const taken = yield* Ref.modify(state, (current) =>
          current.barrier === null
            ? ([true, { ...current, barrier: token }] as const)
            : ([false, current] as const),
        );
        if (!taken) {
          return yield* new ManagedBrowserControl.ManagedBrowserBusyError({
            instanceId: ManagedBrowserInstanceId.make("*"),
            phase: "maintenance",
          });
        }
        return token;
      },
    );

    const openAdmission: ManagedBrowserSupervisor["Service"]["openAdmission"] = (barrier) =>
      Ref.modify(state, (current) =>
        current.barrier === barrier
          ? ([true, { ...current, barrier: null }] as const)
          : ([false, current] as const),
      ).pipe(
        Effect.flatMap((opened) =>
          opened
            ? Effect.void
            : Effect.fail(
                new ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError({
                  instanceId: ManagedBrowserInstanceId.make("*"),
                }),
              ),
        ),
      );

    const stop: ManagedBrowserSupervisor["Service"]["stop"] = Effect.fnUntraced(
      function* (instanceId, token) {
        const current = yield* Ref.get(state);
        if (current.maintenance.get(instanceId)?.token !== token) {
          return yield* new ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError({
            instanceId,
          });
        }
        const slot = current.slots.get(instanceId);
        if (slot?._tag === "Running") {
          yield* retire(instanceId, slot.incarnation, "stopped");
          yield* recordControlToken(instanceId, token, null);
        }
      },
    );

    const restart: ManagedBrowserSupervisor["Service"]["restart"] = Effect.fnUntraced(
      function* (instanceId, token) {
        const current = yield* Ref.get(state);
        if (current.maintenance.get(instanceId)?.token !== token) {
          return yield* new ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError({
            instanceId,
          });
        }
        const profileId = current.profiles.get(instanceId);
        if (profileId === undefined) return yield* unavailable(instanceId);
        const slot = current.slots.get(instanceId);
        if (slot?._tag === "Running") {
          yield* retire(instanceId, slot.incarnation, "stopped");
          // The replaced lease took its maintenance token with it; the new one records its own.
          yield* recordControlToken(instanceId, token, null);
        }
        return yield* start(
          { ownerEnvironmentId: options.ownerEnvironmentId, instanceId, profileId },
          token,
        ).pipe(
          Effect.catchTags({
            ManagedBrowserProfileMismatchError: Effect.die,
            ManagedBrowserProfileConflictError: Effect.die,
            ManagedBrowserMaintenanceError: Effect.die,
          }),
        );
      },
    );

    return ManagedBrowserSupervisor.of({
      ensure,
      state: controlState,
      capabilities,
      execute,
      scoped,
      events,
      takeControl,
      releaseControl,
      holderDisconnected,
      subscribe,
      beginMaintenance,
      endMaintenance,
      instances: Effect.map(Ref.get(state), (current) => [...current.profiles.keys()]),
      closeAdmission,
      openAdmission,
      stop,
      restart,
    });
  });

export const layer = (options: ManagedBrowserSupervisorOptions) =>
  Layer.effect(ManagedBrowserSupervisor, make(options));
