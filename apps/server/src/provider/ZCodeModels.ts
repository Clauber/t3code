/**
 * ZCode model catalog shared by the provider snapshot and the adapter.
 *
 * The app-server never serves the full model market. A session's subscribe
 * snapshot carries `settings.model`: the models the user's zcode settings make
 * available plus the current selection. T3 slugs are `providerId/modelId`;
 * the reasoning level is a separate select option because zcode rejects
 * `session/setModel` for a model that needs a level when none is given.
 */
import { type ModelCapabilities, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Predicate from "effect/Predicate";

/** Keep whatever model the user's own zcode settings selected. */
export const ZCODE_DEFAULT_MODEL_SLUG = "default";
export const ZCODE_REASONING_OPTION_ID = "reasoning";

export const EMPTY_ZCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export interface ZCodeCatalogModel {
  readonly slug: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly reasoningLevels: ReadonlyArray<string>;
  readonly defaultReasoningLevel: string | null;
}

export interface ZCodeCatalog {
  readonly models: ReadonlyArray<ZCodeCatalogModel>;
  /** Slug of the session's current model, when reported. */
  readonly currentSlug: string | null;
}

function field(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

function nonEmptyString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

/** Splits a `providerId/modelId` slug; null when it is not one. */
export function parseZCodeModelSlug(
  slug: string,
): { readonly providerId: string; readonly modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { providerId: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

/** Parses `snapshot.settings.model` from a `session/subscribe` result. */
export function parseZCodeCatalog(settingsModel: unknown): ZCodeCatalog {
  const models: Array<ZCodeCatalogModel> = [];
  const seen = new Set<string>();
  const available = field(settingsModel, "available");
  for (const option of Array.isArray(available) ? available : []) {
    const ref = field(option, "ref");
    const providerId = nonEmptyString(field(ref, "providerId"));
    const modelId = nonEmptyString(field(ref, "modelId"));
    if (providerId === undefined || modelId === undefined) continue;
    const slug = `${providerId}/${modelId}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const reasoning = field(option, "reasoning");
    const levelsField = field(reasoning, "levels");
    const reasoningLevels = (Array.isArray(levelsField) ? levelsField : []).flatMap((level) => {
      const value = nonEmptyString(field(level, "value"));
      return value === undefined ? [] : [value];
    });
    const defaultLevel = nonEmptyString(field(reasoning, "defaultLevel"));
    const contextWindow = field(option, "contextWindow");
    models.push({
      slug,
      providerId,
      modelId,
      name: nonEmptyString(field(option, "label")) ?? slug,
      contextWindow:
        typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
          ? contextWindow
          : null,
      reasoningLevels,
      defaultReasoningLevel:
        defaultLevel !== undefined && reasoningLevels.includes(defaultLevel)
          ? defaultLevel
          : (reasoningLevels[0] ?? null),
    });
  }
  const current = field(settingsModel, "current");
  const currentProvider = nonEmptyString(field(current, "providerId"));
  const currentModel = nonEmptyString(field(current, "modelId"));
  return {
    models,
    currentSlug:
      currentProvider === undefined || currentModel === undefined
        ? null
        : `${currentProvider}/${currentModel}`,
  };
}

export function zcodeModelCapabilities(model: ZCodeCatalogModel): ModelCapabilities {
  if (model.reasoningLevels.length === 0) return EMPTY_ZCODE_MODEL_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: ZCODE_REASONING_OPTION_ID,
        label: "Reasoning",
        type: "select",
        options: model.reasoningLevels.map((level) => ({
          id: level,
          label: level.charAt(0).toUpperCase() + level.slice(1),
          ...(level === model.defaultReasoningLevel ? { isDefault: true } : {}),
        })),
      },
    ],
  });
}

export function zcodeServerModels(catalog: ZCodeCatalog): ReadonlyArray<ServerProviderModel> {
  return catalog.models.map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    capabilities: zcodeModelCapabilities(model),
  }));
}
