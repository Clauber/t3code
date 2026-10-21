// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
/**
 * ManagedBrowserUpdate - keeps the managed browser component current without ever interrupting its use.
 *
 * T3 pins the component it ships (the baseline, named by digest in the lock). An hourly check, jittered so
 * hosts do not all ask at once, may stage a newer stable release from the lock's source when the
 * installer's own verification passes and the release declares compatibility with this T3: the same engine
 * protocol, an adapter range containing this adapter, every required capability, the same state format and
 * a version above the one running. Nothing is installed blindly and no version is ever downgraded
 * implicitly. Offline or unauthenticated sources leave the working version untouched.
 *
 * Activation drains first. Every instance's admission is closed through the supervisor, which refuses
 * while a person holds the browser or the child reports a launch, navigation, dialog, upload, recording or
 * shared session; a refusal restores admission on the old version with the release left staged. Only at an
 * idle point does the pointer switch and each child get replaced after its predecessor's exit is proven.
 * A candidate that does not start, advertise its version and capabilities and run a disposable-profile
 * launch is rolled back to the previous release through the installer's verified swap and quarantined.
 *
 * Admission closes for the whole supervisor before any instance is listed (a launch of an instance nobody
 * has started yet is refused too), and cancelling the claim releases what it took. If a candidate fails and
 * the previous release cannot be restored, the candidate's children are ended (exit proven), the failure is
 * persisted as a recovery state, and launches are refused by name until `recover` or a newer verified
 * activation restores service. The smoke check lives in {@link ManagedBrowserSmoke}.
 *
 * Each phase is persisted, so a crash mid-activation resolves on the next start: before the switch nothing
 * changed; after it the current release is smoke-checked and kept, or rolled back and quarantined. A live
 * failed switch and that startup resolution share one restoration path, and both verify the release they
 * return to with a smoke check before claiming service is back; if that fails, recovery is persisted and
 * launches are refused. A child whose exit cannot be proven (a typed stop failure or a defect from its
 * finalizer) is never replaced: recovery is persisted with that cause and admission stays closed for the life
 * of this process, which status reports as `restartRequired`; `recover` refuses until T3 is restarted.
 *
 * @module ManagedBrowserUpdate
 */
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { drain } from "./managedBrowserMaintenance.ts";
import { ManagedBrowserChildNotTerminatedError } from "./ManagedBrowserIpc.ts";
import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";
import { makeRecordStore } from "./ManagedBrowserRecordStore.ts";
import type { ReleaseSmoke } from "./ManagedBrowserSmoke.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

const { ManagedBrowserPackageError } = ManagedBrowserPackage;
const isChildNotTerminated = Schema.is(ManagedBrowserChildNotTerminatedError);

const describe = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String((error as { message?: string })?.message ?? error);

/** What one failed step left behind: why, and whether a child's exit stayed unproven. */
interface StepFailure {
  readonly detail: string;
  readonly exitUnproven: boolean;
}

/**
 * Runs a step to completion and reports its failure, typed or a defect, instead of raising it, so the caller
 * always reaches its recovery bookkeeping. An interruption still propagates.
 */
const guard = <E>(step: Effect.Effect<void, E>): Effect.Effect<StepFailure | null> =>
  step.pipe(
    Effect.as(null),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed({
            detail: describe(Cause.squash(cause)),
            exitUnproven: cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && isChildNotTerminated(reason.defect),
            ),
          }),
    ),
  );

const CHECK_INTERVAL_MS = 3_600_000;
/** Added to the interval, at random, so a fleet does not check in step. */
export const MAX_JITTER_MS = 300_000;

export const nextCheckDelayMs = (random: number) =>
  CHECK_INTERVAL_MS + Math.floor(Math.min(Math.max(random, 0), 1) * MAX_JITTER_MS);

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export interface UpdatePolicy {
  /** Stops the automatic hourly update. An explicit check or update still works. */
  readonly paused: boolean;
  /** Holds the component at this installed version: the automatic path selects nothing else. */
  readonly pinnedVersion: string | null;
}

type ActivationPhase = "draining" | "switched" | "verifying" | "rollingBack";

interface ActivationRecord {
  readonly phase: ActivationPhase;
  readonly from: string | null;
  readonly to: string;
}

export interface QuarantinedRelease {
  readonly version: string;
  readonly archiveSha256: string | null;
  readonly reason: string;
  readonly at: number;
}

/**
 * An activation failed and the release before it could not be restored. Ordinary launches are refused until
 * an explicit {@link ManagedBrowserUpdate.recover} succeeds or a newer verified release activates.
 */
export interface RecoveryState {
  readonly failed: string;
  /** The release recovery returns to. */
  readonly from: string | null;
  readonly detail: string;
  readonly at: number;
}

/**
 * Whether `recover` can work in this process. `restartRequired` while a child's exit is unproven: admission
 * stays closed, so no drain can succeed until the T3 process is restarted. Restarting does not prove the
 * child exited; the next `recover` attempt still has to restore service and says so if it cannot.
 */
export type RecoveryStatus = "retryable" | "restartRequired";

export type CheckOutcome =
  | "upToDate"
  | "staged"
  | "paused"
  | "pinned"
  | "offline"
  | "rejected"
  | "unprovisioned"
  | "unauthorized"
  | "unavailable";

interface UpdateState {
  readonly policy: UpdatePolicy;
  readonly quarantined: ReadonlyArray<QuarantinedRelease>;
  readonly staged: string | null;
  readonly activation: ActivationRecord | null;
  readonly recovery: RecoveryState | null;
  readonly lastCheck: {
    readonly at: number;
    readonly outcome: CheckOutcome;
    readonly detail: string | null;
  } | null;
  readonly lastActivation: {
    readonly at: number;
    readonly result: string;
    readonly detail: string | null;
  } | null;
}

const EMPTY_STATE: UpdateState = {
  policy: { paused: false, pinnedVersion: null },
  quarantined: [],
  staged: null,
  activation: null,
  recovery: null,
  lastCheck: null,
  lastActivation: null,
};

/** The one record the store holds: the state under a fixed key. */
type UpdateRecord = UpdateState & { readonly key: "state" };

const validState = (value: unknown): value is UpdateRecord => {
  const state = value as Partial<UpdateState> | null;
  return (
    typeof state === "object" &&
    state !== null &&
    typeof state.policy?.paused === "boolean" &&
    Array.isArray(state.quarantined) &&
    (state.staged === null || typeof state.staged === "string") &&
    (state.activation === null || typeof state.activation?.to === "string") &&
    (state.recovery === undefined ||
      state.recovery === null ||
      typeof state.recovery.failed === "string")
  );
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface StagedRelease {
  readonly version: string;
  readonly archiveSha256: string;
}

export type ActivationResult =
  | { readonly _tag: "Activated"; readonly version: string; readonly previous: string | null }
  /** Something was in use. The old version still runs, admission is open again and the release stays staged. */
  | { readonly _tag: "Deferred"; readonly reasons: ReadonlyArray<string> }
  /** The candidate failed and the previous release was restored and verified. */
  | { readonly _tag: "RolledBack"; readonly failed: string; readonly detail: string }
  /**
   * The candidate failed and the previous release could not be restored. The candidate's children were
   * stopped and ordinary launches are refused (`status.hosting.reason` is `recoveryRequired`).
   */
  | { readonly _tag: "RecoveryFailed"; readonly failed: string; readonly detail: string };

export interface UpdateStatus {
  /** Whether this host can run a managed browser from an installed, verified release. */
  readonly hosting: { readonly available: boolean; readonly reason: string | null };
  /** What production still lacks. Each is a provisioning step, not a fault. */
  readonly provisioning: {
    readonly signingKey: boolean;
    readonly baseline: boolean;
    readonly releaseSource: boolean;
  };
  readonly current: string | null;
  readonly previous: string | null;
  readonly staged: string | null;
  readonly policy: UpdatePolicy;
  readonly quarantined: ReadonlyArray<QuarantinedRelease>;
  readonly lastCheck: UpdateState["lastCheck"];
  readonly lastActivation: UpdateState["lastActivation"];
  readonly activation: ActivationRecord | null;
  readonly recovery: (RecoveryState & { readonly status: RecoveryStatus }) | null;
}

export class ManagedBrowserUpdate extends Context.Service<
  ManagedBrowserUpdate,
  {
    readonly status: Effect.Effect<UpdateStatus>;
    /** Finds the newest compatible release and stages it. `automatic` obeys pause and pin. */
    readonly checkUpdate: (options: {
      readonly automatic: boolean;
    }) => Effect.Effect<UpdateStatus, ManagedBrowserPackage.ManagedBrowserPackageError>;
    readonly stage: (
      release: ManagedBrowserPackage.ReleaseCandidate,
    ) => Effect.Effect<StagedRelease, ManagedBrowserPackage.ManagedBrowserPackageError>;
    readonly activate: (
      staged: StagedRelease,
    ) => Effect.Effect<ActivationResult, ManagedBrowserPackage.ManagedBrowserPackageError>;
    /** Check, stage and, when idle, activate: what the hourly timer runs. */
    readonly update: (options: {
      readonly automatic: boolean;
    }) => Effect.Effect<UpdateStatus, ManagedBrowserPackage.ManagedBrowserPackageError>;
    readonly setPolicy: (
      policy: Partial<UpdatePolicy>,
    ) => Effect.Effect<UpdatePolicy, ManagedBrowserPackage.ManagedBrowserPackageError>;
    /** Returns to the previous release through the same drain, verification and smoke check. */
    readonly rollback: () => Effect.Effect<
      ActivationResult,
      ManagedBrowserPackage.ManagedBrowserPackageError
    >;
    /**
     * Retries restoring the release a failed recovery was returning to: the same drain, verified swap,
     * restart and smoke check. Succeeds only when service is verifiably back.
     */
    readonly recover: () => Effect.Effect<
      ActivationResult,
      ManagedBrowserPackage.ManagedBrowserPackageError
    >;
    /** Lets a quarantined version be selected again. */
    readonly releaseQuarantine: (
      version: string,
    ) => Effect.Effect<void, ManagedBrowserPackage.ManagedBrowserPackageError>;
    /** The executable and entry the launcher should use now; throws when no release is current. */
    readonly engine: () => ManagedBrowserPackage.PackageEngine;
  }
>()("t3/browser/ManagedBrowserUpdate") {}

export interface ManagedBrowserUpdateOptions {
  readonly root: string;
  readonly lock: ManagedBrowserPackage.ComponentLock;
  readonly tool: ManagedBrowserPackage.ReleaseTool;
  readonly source: ManagedBrowserPackage.ReleaseSource | null;
  /** The shipped, verified baseline as a one-release directory source; null when this build carries none. */
  readonly baseline: {
    readonly list: Effect.Effect<
      ReadonlyArray<ManagedBrowserPackage.LocalReleaseCandidate>,
      ManagedBrowserPackage.ManagedBrowserPackageError
    >;
  } | null;
  readonly smoke: ReleaseSmoke;
  readonly checkPrerequisites?: boolean;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Off in tests that drive the update by hand. */
  readonly schedule?: boolean;
}

export const make = (options: ManagedBrowserUpdateOptions) =>
  Effect.gen(function* () {
    const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
    const scope = yield* Effect.scope;
    const now = options.now ?? Date.now;
    const packages = ManagedBrowserPackage.makePackageStore({
      root: options.root,
      lock: options.lock,
      tool: options.tool,
      ...(options.checkPrerequisites === undefined
        ? {}
        : { checkPrerequisites: options.checkPrerequisites }),
    });
    const records = makeRecordStore<UpdateRecord>(Path.join(options.root, "update-state.json"), {
      version: 1,
      field: "state",
      label: "component update",
      max: 1,
      keyOf: () => "state",
      valid: validState,
    });
    const stateError = (detail: string) =>
      new ManagedBrowserPackageError({ reason: "stateUnreadable", detail });
    const read = (): UpdateState => records.get("state") ?? EMPTY_STATE;
    const writable = Effect.suspend(() =>
      records.status._tag === "ready"
        ? Effect.void
        : Effect.fail(
            stateError(
              `update record is unreadable: ${records.status._tag === "unreadable" ? records.status.detail : ""}`,
            ),
          ),
    );
    const persist = (change: (state: UpdateState) => UpdateState) =>
      Effect.try({
        try: () => records.put({ ...change(read()), key: "state" }),
        catch: (cause) => stateError(describe(cause)),
      });
    const quarantine = (version: string, reason: string) =>
      persist((state) => ({
        ...state,
        staged: state.staged === version ? null : state.staged,
        quarantined: [
          ...state.quarantined.filter((entry) => entry.version !== version),
          {
            version,
            archiveSha256: packages.manifestOf(version)?.archiveSha256 ?? null,
            reason,
            at: now(),
          },
        ],
      }));
    const isQuarantined = (version: string, archiveSha256?: unknown) =>
      read().quarantined.some(
        (entry) =>
          entry.version === version ||
          (archiveSha256 !== undefined && entry.archiveSha256 === archiveSha256),
      );

    /** True only while a drained switch or `recover` restarts children: the launches allowed under a recovery. */
    let repairing = false;
    /**
     * Why the start could not settle the installation, until the next start retries it. The release on disk is
     * not known to be the one that was verified, so it is not offered even though it is readable.
     */
    let unsettled: string | null = null;
    /**
     * Set once a child's exit is unproven and admission is therefore kept closed. In memory on purpose: it is
     * true of this process only, so a restarted process offers a real retry instead of a stale restart notice.
     */
    let admissionRetained = false;

    const hosting = (): UpdateStatus["hosting"] =>
      read().recovery !== null
        ? { available: false, reason: "recoveryRequired" }
        : packages.current() !== null
          ? unsettled === null
            ? { available: true, reason: null }
            : { available: false, reason: "recoveryRequired" }
          : {
              available: false,
              reason:
                options.lock.trustedPublicKeys.length === 0 || options.lock.baseline === null
                  ? "unprovisioned"
                  : "no release is installed",
            };

    const status: Effect.Effect<UpdateStatus> = Effect.sync(() => {
      const state = read();
      return {
        hosting: hosting(),
        provisioning: {
          signingKey: options.lock.trustedPublicKeys.length > 0,
          baseline: options.lock.baseline !== null,
          releaseSource: options.lock.releaseSource !== null,
        },
        current: packages.current()?.version ?? null,
        previous: packages.previous(),
        staged: state.staged,
        policy: state.policy,
        quarantined: state.quarantined,
        lastCheck: state.lastCheck,
        lastActivation: state.lastActivation,
        activation: state.activation,
        recovery: state.recovery
          ? { ...state.recovery, status: admissionRetained ? "restartRequired" : "retryable" }
          : null,
      };
    });

    const setPhase = (phase: ActivationPhase, from: string | null, to: string) =>
      persist((state) => ({ ...state, activation: { phase, from, to } }));
    const finish = (result: string, detail: string | null) =>
      persist((state) => ({
        ...state,
        activation: null,
        lastActivation: { at: now(), result, detail },
      }));

    const engineOfCurrent = () => {
      const current = packages.current();
      if (current === null) throw new Error("no managed browser release is installed");
      const recovery = read().recovery;
      if (recovery !== null && !repairing) {
        throw new Error(
          `recovery is required after ${recovery.failed} failed and the previous release could not be restored`,
        );
      }
      if (unsettled !== null) {
        throw new Error(
          `recovery is required: the installation could not be settled (${unsettled})`,
        );
      }
      return packages.engineOf(current.version);
    };

    // -- staging -------------------------------------------------------------

    const stage: ManagedBrowserUpdate["Service"]["stage"] = (release) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* writable;
          // Downloaded (or located) before the installation lock is taken: a slow download holds nothing.
          const files = yield* release.files;
          const manifest = yield* packages.withLock(
            Effect.gen(function* () {
              const staged = yield* packages.stage(files);
              if (isQuarantined(staged.version, staged.archiveSha256)) {
                return yield* new ManagedBrowserPackageError({
                  reason: "rejected",
                  detail: `${staged.version} is quarantined`,
                });
              }
              return staged;
            }),
          );
          yield* persist((state) => ({ ...state, staged: manifest.version }));
          return { version: manifest.version, archiveSha256: manifest.archiveSha256 };
        }),
      );

    // -- the switch ----------------------------------------------------------

    /**
     * Returns `current` to `from` and proves it works. The one restoration path for a failed live switch and
     * for crash recovery: `undoMove` swaps the pointer back, `restart` replaces whatever ran, and the release
     * returned to is smoke-checked, because a verified package is not a browser that starts.
     */
    const restoreRelease = <E>(step: {
      readonly from: string | null;
      readonly undoMove: boolean;
      readonly verify: boolean;
      readonly restart: Effect.Effect<void, E>;
    }) =>
      guard(
        Effect.gen(function* () {
          if (step.undoMove) yield* packages.rollback();
          yield* step.restart;
          if (step.verify && step.from !== null) {
            yield* options.smoke(packages.engineOf(step.from), step.from);
          }
        }),
      );

    /** Neither release is known good: persists the state that refuses launches until recovery succeeds. */
    const requireRecovery = (failed: string, from: string | null, detail: string) =>
      persist((state) => ({ ...state, recovery: { failed, from, detail, at: now() } })).pipe(
        Effect.andThen(finish("recoveryFailed", detail)),
        Effect.as({ _tag: "RecoveryFailed", failed, detail } satisfies ActivationResult),
      );

    const unprovenExit = (detail: string) => `${detail}; exit not proven`;

    /**
     * A drained move of `current` to `target`: `prepare` before anything is closed, `move` the pointer once
     * every instance is claimed, then each child replaced and the result smoke-checked. A failure restores
     * what it left and says whether that worked. Holds the installation lock throughout.
     */
    const drainedSwitch = (change: {
      readonly target: string;
      readonly prepare: Effect.Effect<void, ManagedBrowserPackage.ManagedBrowserPackageError>;
      readonly move: Effect.Effect<void, ManagedBrowserPackage.ManagedBrowserPackageError>;
      /** What else a success records, given the release it left. */
      readonly afterSuccess: (
        from: string | null,
      ) => Effect.Effect<void, ManagedBrowserPackage.ManagedBrowserPackageError>;
    }): Effect.Effect<ActivationResult, ManagedBrowserPackage.ManagedBrowserPackageError> =>
      packages.withLock(
        Effect.gen(function* () {
          yield* writable;
          const { target } = change;
          const from = packages.current()?.version ?? null;
          yield* change.prepare;
          yield* setPhase("draining", from, target);
          const drained = yield* drain(supervisor).pipe(
            Effect.map((claims) => ({ _tag: "drained" as const, claims })),
            Effect.catchTag("ManagedBrowserDrainDeferredError", (error) =>
              Effect.succeed({ _tag: "deferred" as const, reasons: error.reasons }),
            ),
          );
          if (drained._tag === "deferred") {
            yield* finish("deferred", drained.reasons.join(", "));
            return { _tag: "Deferred", reasons: drained.reasons } satisfies ActivationResult;
          }
          const claims = drained.claims;
          // Admission is closed to everyone else now, so only the restarts below can launch.
          repairing = true;
          let moved = false;
          const attempt = Effect.gen(function* () {
            yield* setPhase("switched", from, target);
            yield* change.move;
            moved = true;
            yield* claims.restartAll;
            yield* setPhase("verifying", from, target);
            yield* options.smoke(packages.engineOf(target), target);
          });
          return yield* Effect.gen(function* () {
            const failure = yield* guard(attempt);
            if (failure === null) {
              yield* change.afterSuccess(from);
              yield* persist((state) => ({
                ...state,
                staged: state.staged === target ? null : state.staged,
                recovery: null,
              }));
              yield* finish("activated", target);
              return {
                _tag: "Activated",
                version: target,
                previous: from,
              } satisfies ActivationResult;
            }
            if (failure.exitUnproven) {
              admissionRetained = true;
              return yield* requireRecovery(target, from, unprovenExit(failure.detail));
            }
            yield* quarantine(target, failure.detail);
            yield* setPhase("rollingBack", from, target);
            // The pointer swap is its own inverse, and only undone if it happened.
            const restored = yield* restoreRelease({
              from,
              undoMove: moved,
              verify: moved,
              restart: claims.restartAll,
            });
            if (restored === null) {
              yield* finish("rolledBack", failure.detail);
              return {
                _tag: "RolledBack",
                failed: target,
                detail: failure.detail,
              } satisfies ActivationResult;
            }
            const detail = `${failure.detail}; recovery failed: ${restored.detail}`;
            if (restored.exitUnproven) {
              admissionRetained = true;
              return yield* requireRecovery(target, from, unprovenExit(detail));
            }
            // Neither release is known good: end what ran on the candidate (exit proven) and keep it off.
            const stopped = yield* guard(claims.stopAll);
            if (stopped !== null) {
              admissionRetained = true;
              return yield* requireRecovery(
                target,
                from,
                unprovenExit(`${detail}; stop failed: ${stopped.detail}`),
              );
            }
            return yield* requireRecovery(target, from, detail);
          }).pipe(
            // Stop allowing restarts before admission reopens, so a pending recovery refuses everything else.
            Effect.ensuring(
              Effect.sync(() => void (repairing = false)).pipe(
                Effect.andThen(
                  Effect.suspend(() => (admissionRetained ? Effect.void : claims.release)),
                ),
              ),
            ),
          );
        }).pipe(Effect.ensuring(Effect.sync(() => void (repairing = false)))),
      );

    const refuse = (
      reason: ManagedBrowserPackage.ManagedBrowserPackageError["reason"],
      detail: string,
    ) => Effect.fail(new ManagedBrowserPackageError({ reason, detail }));

    const activate: ManagedBrowserUpdate["Service"]["activate"] = (staged) =>
      Effect.suspend(() => {
        const installed = packages.manifestOf(staged.version);
        const current = packages.current()?.version ?? null;
        if (installed === null) return refuse("notStaged", `${staged.version} is not installed`);
        // What is activated is the release that was staged, byte for byte.
        if (installed.archiveSha256 !== staged.archiveSha256) {
          return refuse("rejected", `${staged.version} differs from the release that was staged`);
        }
        if (isQuarantined(staged.version, installed.archiveSha256)) {
          return refuse("rejected", `${staged.version} is quarantined`);
        }
        if (current !== null && compareSemverVersions(staged.version, current) <= 0) {
          return refuse("rejected", `${staged.version} would not move forward from ${current}`);
        }
        return drainedSwitch({
          target: staged.version,
          prepare: packages.reverify(staged.version),
          move: packages.switchTo(staged.version),
          afterSuccess: () => Effect.void,
        });
      });

    const rollback: ManagedBrowserUpdate["Service"]["rollback"] = () =>
      Effect.suspend(() => {
        const previous = packages.previous();
        if (previous === null) return refuse("notStaged", "there is no previous release");
        return drainedSwitch({
          target: previous,
          prepare: Effect.void,
          move: packages.rollback().pipe(Effect.asVoid),
          // Otherwise the next check would offer the release just left and undo the rollback.
          afterSuccess: (from) =>
            from === null ? Effect.void : quarantine(from, "rolled back by the operator"),
        });
      });

    const recover: ManagedBrowserUpdate["Service"]["recover"] = () =>
      packages.withLock(
        Effect.gen(function* () {
          yield* writable;
          const recovery = read().recovery;
          if (recovery === null) return yield* refuse("notStaged", "no recovery is pending");
          const target = recovery.from;
          if (target === null) return yield* refuse("rejected", "there is no release to return to");
          // The barrier kept for an unproven exit cannot be drained: say why instead of attempting it.
          if (admissionRetained) {
            return yield* refuse(
              "locked",
              "a browser's exit is unproven and admission stays closed; restart T3 first",
            );
          }
          const drained = yield* drain(supervisor).pipe(
            Effect.catchTag("ManagedBrowserDrainDeferredError", (error) =>
              Effect.fail(
                new ManagedBrowserPackageError({
                  reason: "locked",
                  detail: `a browser is still in use (${error.reasons.join(", ")})`,
                }),
              ),
            ),
          );
          return yield* Effect.gen(function* () {
            repairing = true;
            const current = packages.current()?.version ?? null;
            const attempt = Effect.gen(function* () {
              if (current !== target) {
                if (current !== recovery.failed || packages.previous() !== target) {
                  return yield* refuse(
                    "rejected",
                    "the installation is not in a state recovery knows",
                  );
                }
                yield* packages.rollback();
              }
              yield* drained.restartAll;
              yield* options.smoke(packages.engineOf(target), target);
            });
            const failure = yield* guard(attempt);
            if (failure !== null) {
              // A child whose exit is unproven keeps admission closed; otherwise end what ran and reopen.
              const stopped = failure.exitUnproven ? null : yield* guard(drained.stopAll);
              if (failure.exitUnproven || stopped !== null) admissionRetained = true;
              const detail = `recovery failed again: ${
                stopped === null
                  ? failure.detail
                  : `${failure.detail}; stop failed: ${stopped.detail}`
              }`;
              const message = admissionRetained ? unprovenExit(detail) : detail;
              // The status says what was last observed, not the failure this recovery started from.
              yield* persist((state) => ({
                ...state,
                recovery: { ...recovery, detail: message, at: now() },
              })).pipe(Effect.ignore);
              return yield* refuse("rejected", message);
            }
            yield* persist((state) => ({ ...state, recovery: null }));
            yield* finish("recovered", `restored ${target}`);
            return {
              _tag: "Activated",
              version: target,
              previous: recovery.failed,
            } satisfies ActivationResult;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => void (repairing = false)).pipe(
                Effect.andThen(
                  Effect.suspend(() => (admissionRetained ? Effect.void : drained.release)),
                ),
              ),
            ),
          );
        }),
      );

    // -- checking ------------------------------------------------------------

    const recordCheck = (outcome: CheckOutcome, detail: string | null = null) =>
      persist((state) => ({ ...state, lastCheck: { at: now(), outcome, detail } }));

    /** Stages the newest offered release that is compatible and verifies; one that does not is skipped. */
    const stageNewest = (
      offered: ReadonlyArray<ManagedBrowserPackage.ReleaseCandidate>,
      current: ManagedBrowserPackage.InstalledManifest,
    ) =>
      Effect.gen(function* () {
        const problems: Array<string> = [];
        const eligible = offered
          .filter((candidate) => {
            const problem =
              ManagedBrowserPackage.compatibilityProblem(
                candidate.manifest,
                options.lock,
                options.tool,
                current,
              ) ??
              (isQuarantined(candidate.version, candidate.manifest.archiveSha256)
                ? "quarantined"
                : null);
            if (problem !== null) problems.push(`${candidate.version}: ${problem}`);
            return problem === null;
          })
          .sort((a, b) => compareSemverVersions(b.version, a.version));
        for (const candidate of eligible) {
          const staged = yield* stage(candidate).pipe(
            Effect.map((release) => release.version),
            Effect.catchTag("ManagedBrowserPackageError", (error) =>
              error.reason === "locked" || error.reason === "stateUnreadable"
                ? Effect.fail(error)
                : Effect.sync(() => {
                    problems.push(`${candidate.version}: ${error.detail}`);
                    return null;
                  }),
            ),
          );
          if (staged !== null) return { outcome: "staged" as const, detail: staged };
        }
        return {
          outcome: eligible.length > 0 ? ("rejected" as const) : ("upToDate" as const),
          detail: problems.length > 0 ? problems.join("; ") : null,
        };
      });

    const checkUpdate: ManagedBrowserUpdate["Service"]["checkUpdate"] = ({ automatic }) =>
      Effect.gen(function* () {
        yield* writable;
        const policy = read().policy;
        const current = packages.current();
        if (automatic && policy.paused) yield* recordCheck("paused");
        else if (automatic && policy.pinnedVersion !== null)
          yield* recordCheck("pinned", policy.pinnedVersion);
        else if (current === null) yield* recordCheck("unavailable", hosting().reason);
        else if (options.source === null)
          yield* recordCheck("unprovisioned", "no release source is configured");
        else {
          const offered = yield* options.source.list.pipe(
            Effect.catch((error) =>
              recordCheck(
                error.reason === "unauthorized" ? "unauthorized" : "offline",
                error.detail,
              ).pipe(Effect.as(null)),
            ),
          );
          if (offered !== null) {
            const result = yield* stageNewest(offered, current);
            yield* recordCheck(result.outcome, result.detail);
          }
        }
        return yield* status;
      });

    const update: ManagedBrowserUpdate["Service"]["update"] = (input) =>
      Effect.gen(function* () {
        yield* checkUpdate(input);
        const state = read();
        const held =
          input.automatic && (state.policy.paused || state.policy.pinnedVersion !== null);
        const staged = state.staged;
        if (!held && staged !== null && staged !== packages.current()?.version) {
          const manifest = packages.manifestOf(staged);
          if (manifest !== null) {
            yield* activate({ version: staged, archiveSha256: manifest.archiveSha256 }).pipe(
              // A busy installer is a retry next hour, not a failed update.
              Effect.catchTag("ManagedBrowserPackageError", (error) =>
                error.reason === "locked" || error.reason === "rejected"
                  ? Effect.void
                  : Effect.fail(error),
              ),
            );
          }
        }
        return yield* status;
      });

    const setPolicy: ManagedBrowserUpdate["Service"]["setPolicy"] = (policy) =>
      Effect.gen(function* () {
        yield* writable;
        if (
          policy.pinnedVersion !== undefined &&
          policy.pinnedVersion !== null &&
          !packages.installedVersions().includes(policy.pinnedVersion)
        ) {
          return yield* new ManagedBrowserPackageError({
            reason: "notStaged",
            detail: `${policy.pinnedVersion} is not installed`,
          });
        }
        yield* persist((state) => ({ ...state, policy: { ...state.policy, ...policy } }));
        return read().policy;
      });

    const releaseQuarantine: ManagedBrowserUpdate["Service"]["releaseQuarantine"] = (version) =>
      writable.pipe(
        Effect.andThen(
          persist((state) => ({
            ...state,
            quarantined: state.quarantined.filter((entry) => entry.version !== version),
          })),
        ),
      );

    // -- start: baseline and crash recovery ---------------------------------------

    /**
     * Resolves an activation a crash interrupted, by the phase it reached. The pointer moves only after
     * `switched` is persisted and children are replaced only after it moves, so `draining`, or `switched` with
     * the pointer still on `from`, changed nothing. In `rollingBack` the pointer may be on either release, so
     * only the phase says the previous release still has to be verified. No child runs at start.
     */
    const settleInterrupted = (act: ActivationRecord) =>
      Effect.gen(function* () {
        const current = packages.current()?.version ?? null;
        if (
          act.phase === "draining" ||
          current === null ||
          (act.phase === "switched" && current === act.from)
        ) {
          return yield* finish("interrupted", `${act.phase} before the switch`);
        }
        let reason = "activation was interrupted while rolling back";
        if (act.phase !== "rollingBack") {
          const healthy = yield* options.smoke(packages.engineOf(current), current).pipe(
            Effect.map(() => true),
            Effect.orElseSucceed(() => false),
          );
          if (healthy) return yield* finish("recovered", `kept ${current}`);
          reason = "failed its smoke check after an interrupted activation";
        }
        yield* quarantine(act.to, reason);
        const restored = yield* restoreRelease({
          from: act.from,
          undoMove: current === act.to,
          verify: true,
          restart: Effect.void,
        });
        if (restored === null) return yield* finish("recovered", `rolled back from ${act.to}`);
        yield* requireRecovery(act.to, act.from, `${reason}; recovery failed: ${restored.detail}`);
      });

    /** Brings the installation to a defined state before anything can launch from it. */
    const settle = packages.withLock(
      Effect.gen(function* () {
        yield* writable;
        const act = read().activation;
        if (act !== null) yield* settleInterrupted(act);
        // A release this T3 cannot use (an older release after a T3 update, or none) falls back to the baseline.
        const current = packages.current();
        const usable =
          current !== null &&
          ManagedBrowserPackage.compatibilityProblem(
            current.raw,
            options.lock,
            options.tool,
            null,
          ) === null;
        if (!usable && options.baseline !== null && options.lock.baseline !== null) {
          const [shipped] = yield* options.baseline.list;
          if (shipped !== undefined) {
            const pinned = options.lock.baseline;
            const manifestSha = Crypto.createHash("sha256")
              .update(FS.readFileSync(shipped.manifestPath))
              .digest("hex");
            if (
              shipped.version !== pinned.version ||
              shipped.manifest.archiveSha256 !== pinned.archiveSha256 ||
              manifestSha !== pinned.manifestSha256
            ) {
              return yield* new ManagedBrowserPackageError({
                reason: "rejected",
                detail: "the shipped baseline is not the one this build pins",
              });
            }
            const baseline = yield* packages.stage(shipped);
            yield* packages.switchTo(baseline.version);
          }
        }
      }),
    );
    // A host that cannot install anything still serves as a client, so a failed start only disables hosting.
    yield* settle.pipe(
      Effect.catchTag("ManagedBrowserPackageError", (error) =>
        Effect.sync(() => void (unsettled = error.detail)).pipe(
          Effect.andThen(
            Effect.logWarning("managed browser component is unavailable on this host", {
              reason: error.reason,
              detail: error.detail,
            }),
          ),
        ),
      ),
    );

    if (options.schedule !== false) {
      const random = options.random ?? Math.random;
      yield* Effect.forever(
        Effect.sleep(nextCheckDelayMs(random())).pipe(
          Effect.andThen(update({ automatic: true })),
          Effect.catch((error) =>
            Effect.logWarning("managed browser update check failed", { detail: describe(error) }),
          ),
        ),
      ).pipe(Effect.forkIn(scope));
    }

    return ManagedBrowserUpdate.of({
      status,
      checkUpdate,
      stage,
      activate,
      update,
      setPolicy,
      rollback,
      recover,
      releaseQuarantine,
      engine: engineOfCurrent,
    });
  });

export const layer = (options: ManagedBrowserUpdateOptions) =>
  Layer.effect(ManagedBrowserUpdate, make(options));
