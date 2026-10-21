// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
/**
 * managedBrowserMaintenance - closing admission to every managed browser so something that would stop its
 * process can run, and the ways a T3 update outside this component is made to honor that.
 *
 * Both a component activation and T3's own restart use {@link drain}: each instance's maintenance is
 * claimed through the supervisor, which refuses while a person holds the browser, work is tracked, or the
 * child itself reports a dialog, upload, navigation, launch, recording or shared session. All instances are
 * claimed or none: a refusal restores normal admission on everything claimed so far, and nothing is stopped.
 *
 * T3's update paths that run in this process (a remote update that hands off to the service launcher, a
 * desktop update's commit) take an {@link OuterUpdateGate} hold before they hand off and release it only
 * if the handoff fails. The `t3 update` command runs in another process and no authenticated control path
 * to the running server's admission exists for it, so it cannot drain atomically: the server publishes a
 * marker for as long as it hosts managed browsers and the command never restarts such a server.
 *
 * @module managedBrowserMaintenance
 */
import type { ManagedBrowserInstanceId, ManagedBrowserMaintenanceToken } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FS from "node:fs";
import * as Path from "node:path";

import type * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

/** Something is still using a managed browser. Nothing was stopped and admission is back to normal. */
export class ManagedBrowserDrainDeferredError extends Schema.TaggedError<ManagedBrowserDrainDeferredError>()(
  "ManagedBrowserDrainDeferredError",
  { reasons: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `A managed browser is still in use (${this.reasons.join(", ")}).`;
  }
}

export interface DrainClaims {
  readonly claimed: ReadonlyArray<{
    readonly instanceId: ManagedBrowserInstanceId;
    readonly token: ManagedBrowserMaintenanceToken;
  }>;
  /** Replaces every running child, each after its predecessor's exit is proven. */
  readonly restartAll: Effect.Effect<
    void,
    | ManagedBrowserSupervisor.ManagedBrowserChildLaunchError
    | ManagedBrowserSupervisor.ManagedBrowserOwnerUnavailableError
    | ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError
  >;
  /** Ends every running child with its exit proven and starts none. */
  readonly stopAll: Effect.Effect<void, ManagedBrowserControl.ManagedBrowserMaintenanceOwnerError>;
  /** Reopens admission. Safe to run more than once. */
  readonly release: Effect.Effect<void>;
}

const reasonOf = (error: unknown): ReadonlyArray<string> => {
  const tagged = error as { readonly _tag?: string; readonly phase?: string };
  switch (tagged._tag) {
    case "ManagedBrowserMaintenanceDeferredError":
      return (error as ManagedBrowserSupervisor.ManagedBrowserMaintenanceDeferredError).reasons;
    case "ManagedBrowserBusyError":
      return [tagged.phase === "maintenance" ? "updateInProgress" : (tagged.phase ?? "busy")];
    case "ManagedBrowserTrackedWorkFailedError":
      return ["trackedWorkFailed"];
    default:
      return ["childUnresponsive"];
  }
};

/**
 * Closes admission of the whole supervisor, then claims maintenance of every instance bound, or of none.
 * The barrier comes first: an instance nobody has launched yet cannot start between the barrier and the
 * list, so the list is complete for as long as the claims stand. Cancelling or failing the claim releases
 * the claims made so far and the barrier; a completed claim keeps both until `release`.
 */
export const drain = (
  supervisor: Pick<
    ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
    | "closeAdmission"
    | "openAdmission"
    | "instances"
    | "beginMaintenance"
    | "endMaintenance"
    | "restart"
    | "stop"
  >,
): Effect.Effect<DrainClaims, ManagedBrowserDrainDeferredError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const barrier = yield* supervisor.closeAdmission.pipe(
        Effect.mapError(
          (error) => new ManagedBrowserDrainDeferredError({ reasons: reasonOf(error) }),
        ),
      );
      const claimed: Array<{
        instanceId: ManagedBrowserInstanceId;
        token: ManagedBrowserMaintenanceToken;
      }> = [];
      let released = false;
      const release = Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return Effect.forEach(claimed, (claim) =>
          supervisor.endMaintenance(claim.instanceId, claim.token).pipe(Effect.ignore),
        ).pipe(
          Effect.andThen(supervisor.openAdmission(barrier).pipe(Effect.ignore)),
          Effect.asVoid,
        );
      });
      const claimAll = Effect.gen(function* () {
        for (const instanceId of yield* supervisor.instances) {
          const token = yield* supervisor
            .beginMaintenance(instanceId)
            .pipe(
              Effect.mapError(
                (error) => new ManagedBrowserDrainDeferredError({ reasons: reasonOf(error) }),
              ),
            );
          claimed.push({ instanceId, token });
        }
      });
      yield* restore(claimAll).pipe(Effect.onError(() => release));
      return {
        claimed,
        release,
        restartAll: Effect.forEach(claimed, (claim) =>
          supervisor.restart(claim.instanceId, claim.token),
        ).pipe(Effect.asVoid),
        stopAll: Effect.forEach(claimed, (claim) =>
          supervisor.stop(claim.instanceId, claim.token),
        ).pipe(Effect.asVoid),
      };
    }),
  );

/**
 * What an update of T3 itself takes before it hands off to a restart. A hold keeps admission closed until
 * the process ends; `release` exists for a handoff that failed and left the server running.
 */
export class OuterUpdateGate extends Context.Service<
  OuterUpdateGate,
  {
    readonly hold: Effect.Effect<
      { readonly release: Effect.Effect<void> },
      ManagedBrowserDrainDeferredError
    >;
  }
>()("t3/browser/managedBrowserMaintenance/OuterUpdateGate") {}

export const gateLayer = Layer.effect(
  OuterUpdateGate,
  Effect.gen(function* () {
    const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
    return OuterUpdateGate.of({
      hold: drain(supervisor).pipe(Effect.map((claims) => ({ release: claims.release }))),
    });
  }),
);

// ---------------------------------------------------------------------------
// The marker `t3 update` reads
// ---------------------------------------------------------------------------

export const hostingMarkerPath = (stateDir: string) =>
  Path.join(stateDir, "managed-browser", "hosting.json");

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** The marker could not be written, so no other process can be told that this server hosts browsers. */
export class ManagedBrowserHostingMarkerError extends Schema.TaggedError<ManagedBrowserHostingMarkerError>()(
  "ManagedBrowserHostingMarkerError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The managed browser hosting marker could not be published: ${this.detail}`;
  }
}

/**
 * Whether `t3 update` must treat this server as hosting managed browsers. Only an absent marker, or one that
 * names a hosting process that is gone (or says nothing is hosted), means no. A marker that exists but cannot
 * be read or understood is its only safety signal gone unreliable, so it counts as hosting.
 */
export const managedBrowserHosted = (markerPath: string): boolean => {
  let text: string;
  try {
    text = FS.readFileSync(markerPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  let marker: { pid?: unknown; hosting?: unknown } | null;
  try {
    marker = JSON.parse(text) as typeof marker;
  } catch {
    return true;
  }
  if (typeof marker !== "object" || marker === null || typeof marker.hosting !== "boolean") {
    return true;
  }
  if (!marker.hosting) return false;
  return typeof marker.pid !== "number" || processAlive(marker.pid);
};

/**
 * Publishes, for as long as the scope lives, that this process can launch managed browsers. Another
 * process (`t3 update`) cannot close this server's admission, so it must never restart a server that hosts
 * one: a launch can land at any moment between its check and the restart. Hosting must not be offered
 * unless this succeeds, because the marker is the only signal that process gets.
 */
export const publishHostingMarker = (markerPath: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        FS.mkdirSync(Path.dirname(markerPath), { recursive: true, mode: 0o700 });
        const temporary = `${markerPath}.${process.pid}.tmp`;
        try {
          FS.writeFileSync(temporary, JSON.stringify({ pid: process.pid, hosting: true }), {
            mode: 0o600,
          });
          FS.renameSync(temporary, markerPath);
        } catch (cause) {
          FS.rmSync(temporary, { force: true });
          throw cause;
        }
      },
      catch: (cause) =>
        new ManagedBrowserHostingMarkerError({
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
    () => Effect.sync(() => FS.rmSync(markerPath, { force: true })),
  );
