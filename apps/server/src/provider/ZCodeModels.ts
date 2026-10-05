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
  /** Reasoning level of the session's current model, when reported. */
  readonly currentReasoningLevel: string | null;
}

function field(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

function nonEmptyString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

/**
 * Splits a `providerId/modelId` slug; null when it is not one. The provider
 * ends at the FIRST slash: personal model ids carry their own slashes
 * ("kiro/claude-opus-5").
 */
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
      name: modelLabel(
        nonEmptyString(field(option, "label")) ?? modelId,
        nonEmptyString(field(option, "providerLabel")) ?? providerId,
      ),
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
    currentReasoningLevel:
      nonEmptyString(field(field(current, "options"), "reasoningLevel")) ?? null,
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

function modelLabel(model: string, provider: string): string {
  return `${model} · ${provider}`;
}

// ── personal provider config ─────────────────────────────────────────
// zcode's registry is its built-in providers plus ONE personal provider
// config file (ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, else
// `<dataBase>/.zcode/v2/provider_config.json`). The protocol only serves the
// current model, so T3 merges every personal config it finds into one file,
// points its zcode processes at it, and lists the catalog from it.

/** Where a personal provider config may live, most specific first. */
export function zcodePersonalConfigCandidates(
  environment: NodeJS.ProcessEnv,
  home: string,
  join: (...segments: ReadonlyArray<string>) => string,
): ReadonlyArray<string> {
  const dataBase = environment.ZCODE_DATA_BASE_DIR?.trim() || home;
  const candidates = [
    environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ?? "",
    dataBase === "" ? "" : join(dataBase, ".zcode", "v2", "provider_config.json"),
    home === "" ? "" : join(home, ".zcode", "headless", "provider_config.json"),
  ].filter((candidate) => candidate.length > 0);
  return [...new Set(candidates)];
}

function arrayField(input: unknown, key: string): ReadonlyArray<unknown> {
  const value = field(input, key);
  return Array.isArray(value) ? value : [];
}

function stringArray(input: unknown): ReadonlyArray<string> {
  return Array.isArray(input) ? input.filter((value) => typeof value === "string") : [];
}

/**
 * Merges personal configs: provider and model rules first-file-wins by id,
 * providerOrder kept with later providers appended. Null when no file has a
 * provider. The CLI's schema is strict, so `manualProviderModelRules` is
 * always written: a missing key rejects the whole file.
 */
export function mergeZCodePersonalConfigs(
  documents: ReadonlyArray<unknown>,
): Record<string, unknown> | null {
  const providerRules: Array<unknown> = [];
  const providerModelRules: Array<unknown> = [];
  const manualProviderModelRules: Array<unknown> = [];
  const providerOrder: Array<string> = [];
  const seenProviders = new Set<string>();
  const seenModels = new Set<string>();
  let schemaVersion: unknown = 1;
  for (const document of documents) {
    const config = field(document, "config");
    if (!Predicate.isObject(config)) continue;
    const version = field(document, "schemaVersion");
    if (version !== undefined) schemaVersion = version;
    for (const id of stringArray(field(config, "providerOrder"))) {
      if (!providerOrder.includes(id)) providerOrder.push(id);
    }
    for (const rule of arrayField(field(config, "providerConfigRules"), "providerRules")) {
      const id = nonEmptyString(field(rule, "providerId"));
      if (id === undefined || seenProviders.has(id)) continue;
      seenProviders.add(id);
      providerRules.push(rule);
    }
    const modelConfigRules = field(config, "modelConfigRules");
    for (const [kind, rules, target] of [
      ["model", arrayField(modelConfigRules, "providerModelRules"), providerModelRules],
      [
        "manual",
        arrayField(modelConfigRules, "manualProviderModelRules"),
        manualProviderModelRules,
      ],
    ] as const) {
      for (const rule of rules) {
        if (!Predicate.isObject(rule)) continue;
        const key = `${kind}\u0000${String(rule["providerId"])}\u0000${String(rule["modelId"])}`;
        if (seenModels.has(key)) continue;
        seenModels.add(key);
        target.push(rule);
      }
    }
  }
  if (providerRules.length === 0) return null;
  return {
    schemaVersion,
    config: {
      providerOrder,
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules, manualProviderModelRules },
    },
  };
}

/**
 * Every selectable model a merged config declares: providerOrder, then
 * modelOrder ∪ personalModelIds per enabled provider.
 */
export function zcodeConfigModels(merged: unknown): ReadonlyArray<ZCodeCatalogModel> {
  const config = field(merged, "config");
  const providers = new Map<
    string,
    { readonly name: string; readonly modelIds: ReadonlyArray<string> }
  >();
  for (const rule of arrayField(field(config, "providerConfigRules"), "providerRules")) {
    const id = nonEmptyString(field(rule, "providerId"));
    if (id === undefined || field(rule, "enabled") === false) continue;
    const ruleConfig = field(rule, "config");
    providers.set(id, {
      name: nonEmptyString(field(rule, "providerName")) ?? id,
      modelIds: [
        ...new Set([
          ...stringArray(field(ruleConfig, "modelOrder")),
          ...stringArray(field(ruleConfig, "personalModelIds")),
        ]),
      ].filter((modelId) => modelId.trim().length > 0),
    });
  }
  const contextWindows = new Map<string, number>();
  for (const rule of arrayField(field(config, "modelConfigRules"), "providerModelRules")) {
    const providerId = nonEmptyString(field(rule, "providerId"));
    const modelId = nonEmptyString(field(rule, "modelId"));
    const window = field(field(field(rule, "config"), "properties"), "contextWindow");
    if (providerId === undefined || modelId === undefined) continue;
    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
      contextWindows.set(`${providerId}/${modelId}`, window);
    }
  }
  const order = [...new Set([...stringArray(field(config, "providerOrder")), ...providers.keys()])];
  const models: Array<ZCodeCatalogModel> = [];
  for (const providerId of order) {
    const provider = providers.get(providerId);
    if (provider === undefined) continue;
    for (const modelId of provider.modelIds) {
      const slug = `${providerId}/${modelId}`;
      models.push({
        slug,
        providerId,
        modelId,
        name: modelLabel(modelId, provider.name),
        contextWindow: contextWindows.get(slug) ?? null,
        reasoningLevels: [],
        defaultReasoningLevel: null,
      });
    }
  }
  return models;
}

/** Outcome of probing one config model with `session/setModel`. */
export type ZCodeModelValidation =
  | { readonly accepted: true; readonly reasoningLevel: string | null }
  | { readonly accepted: false };

/**
 * The picker catalog: the session snapshot's models (which carry real
 * reasoning ladders) first, then config models. Config models a validation
 * probe rejected are dropped; accepted ones record the reasoning level zcode
 * took.
 */
export function combineZCodeCatalog(input: {
  readonly configModels: ReadonlyArray<ZCodeCatalogModel>;
  readonly snapshot: ZCodeCatalog | null;
  readonly validation: ReadonlyMap<string, ZCodeModelValidation> | null;
}): ZCodeCatalog {
  const models: Array<ZCodeCatalogModel> = [...(input.snapshot?.models ?? [])];
  const seen = new Set(models.map((model) => model.slug));
  for (const model of input.configModels) {
    if (seen.has(model.slug)) continue;
    const result = input.validation?.get(model.slug);
    // Models the probe never reached (budget, cap) stay listed.
    if (result?.accepted === false) continue;
    seen.add(model.slug);
    const level = result?.accepted === true ? result.reasoningLevel : null;
    models.push(
      level === null ? model : { ...model, reasoningLevels: [level], defaultReasoningLevel: level },
    );
  }
  return {
    models,
    currentSlug: input.snapshot?.currentSlug ?? null,
    currentReasoningLevel: input.snapshot?.currentReasoningLevel ?? null,
  };
}
