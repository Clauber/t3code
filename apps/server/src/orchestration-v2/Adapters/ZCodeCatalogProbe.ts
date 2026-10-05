/**
 * ZCode model validation over an open app-server connection.
 *
 * Registry membership and reasoning levels never cross the wire, so a config
 * model is tried with `session/setModel` on a throwaway deferred session. The
 * error text separates "no such model" from "needs a reasoning level", and the
 * object form of setModel rejects a missing level outright, so each candidate
 * walks a short level ladder. `persistAsWorkspaceLastUsed: false` keeps the
 * probe from rewriting the user's zcode workspace default.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  parseZCodeCatalog,
  type ZCodeCatalog,
  type ZCodeCatalogModel,
  type ZCodeModelValidation,
} from "../../provider/ZCodeModels.ts";
import {
  zcodeRecordField as recordField,
  zcodeRecordString as recordString,
  type ZCodeRpcConnection,
} from "./ZCodeRpc.ts";

/**
 * Effort ladders accept low…max; on/off reasoning models accept only
 * "enabled" (zcode 0.16.9 reports it as their current level).
 */
export const ZCODE_REASONING_LADDER = [
  undefined,
  "high",
  "low",
  "medium",
  "max",
  "enabled",
] as const;
const SET_MODEL_TIMEOUT_MS = 6_000;
const PROBE_BUDGET_MS = 90_000;
const MAX_VALIDATED_MODELS = 200;

type ZCodeRequest = ZCodeRpcConnection["request"];

export function zcodeSetModelParams(
  sessionId: string,
  model: { readonly providerId: string; readonly modelId: string },
  reasoningLevel: string | undefined,
) {
  return {
    sessionId,
    model: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(reasoningLevel === undefined ? {} : { options: { reasoningLevel } }),
    },
    // A T3 selection must not rewrite the user's zcode workspace default.
    persistAsWorkspaceLastUsed: false,
  };
}

/** Whether a setModel failure means "try another reasoning level". */
export function isZCodeReasoningLevelError(error: { readonly message: string }): boolean {
  return !/不存在|not exist/i.test(error.message) && /reasoning/i.test(error.message);
}

/** Finds the first reasoning level zcode accepts for a model. */
export const validateZCodeModel = Effect.fnUntraced(function* (
  request: ZCodeRequest,
  sessionId: string,
  model: { readonly providerId: string; readonly modelId: string },
) {
  for (const level of ZCODE_REASONING_LADDER) {
    const result = yield* request(
      "session/setModel",
      zcodeSetModelParams(sessionId, model, level),
      SET_MODEL_TIMEOUT_MS,
    ).pipe(Effect.result);
    if (Result.isSuccess(result)) {
      return { accepted: true, reasoningLevel: level ?? null } satisfies ZCodeModelValidation;
    }
    // Unknown models and any other failure are not offered.
    if (!isZCodeReasoningLevelError(result.failure)) break;
  }
  return { accepted: false } satisfies ZCodeModelValidation;
});

export interface ZCodeCatalogProbeResult {
  readonly snapshot: ZCodeCatalog;
  readonly validation: ReadonlyMap<string, ZCodeModelValidation>;
}

/** Validates config models in a throwaway deferred session. */
export const probeZCodeCatalog = Effect.fnUntraced(function* (
  request: ZCodeRequest,
  cwd: string,
  candidates: ReadonlyArray<ZCodeCatalogModel>,
) {
  const created = yield* request("session/create", {
    workspace: { workspacePath: cwd, workspaceKey: cwd },
    mode: "build",
    persistence: "deferred",
    titleGenerationEnabled: false,
  });
  const sessionId = recordString(recordField(created, "session"), "sessionId");
  const validation = new Map<string, ZCodeModelValidation>();
  if (sessionId === undefined) {
    return { snapshot: parseZCodeCatalog(undefined), validation } satisfies ZCodeCatalogProbeResult;
  }
  const subscribed = yield* request("session/subscribe", {
    sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: true,
  });
  const snapshot = parseZCodeCatalog(
    recordField(recordField(recordField(subscribed, "snapshot"), "settings"), "model"),
  );
  const snapshotSlugs = new Set(snapshot.models.map((model) => model.slug));
  const deadline = (yield* Clock.currentTimeMillis) + PROBE_BUDGET_MS;
  for (const candidate of candidates) {
    if (validation.size >= MAX_VALIDATED_MODELS) break;
    if ((yield* Clock.currentTimeMillis) > deadline) break;
    if (snapshotSlugs.has(candidate.slug) || validation.has(candidate.slug)) continue;
    validation.set(candidate.slug, yield* validateZCodeModel(request, sessionId, candidate));
  }
  yield* request("session/close", { sessionId }).pipe(Effect.ignore);
  return { snapshot, validation } satisfies ZCodeCatalogProbeResult;
});
