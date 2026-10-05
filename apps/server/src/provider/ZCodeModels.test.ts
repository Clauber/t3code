import { assert, describe, it } from "@effect/vitest";

import {
  combineZCodeCatalog,
  mergeZCodePersonalConfigs,
  parseZCodeModelSlug,
  zcodeConfigModels,
  zcodePersonalConfigCandidates,
} from "./ZCodeModels.ts";

const join = (...segments: ReadonlyArray<string>) => segments.join("/");

describe("ZCodeModels", () => {
  it("ends the provider id at the first slash", () => {
    assert.deepEqual(parseZCodeModelSlug("zai/glm-5"), { providerId: "zai", modelId: "glm-5" });
    assert.deepEqual(parseZCodeModelSlug("prov/kiro/claude-opus-5"), {
      providerId: "prov",
      modelId: "kiro/claude-opus-5",
    });
    assert.isNull(parseZCodeModelSlug("no-slash"));
    assert.isNull(parseZCodeModelSlug("/glm-5"));
    assert.isNull(parseZCodeModelSlug("zai/"));
  });

  it("looks for personal configs in the env override, v2, and headless locations", () => {
    assert.deepEqual(
      zcodePersonalConfigCandidates(
        { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom.json", ZCODE_DATA_BASE_DIR: "/data" },
        "/home/u",
        join,
      ),
      [
        "/custom.json",
        "/data/.zcode/v2/provider_config.json",
        "/home/u/.zcode/headless/provider_config.json",
      ],
    );
    // The env override may already point at a default location.
    assert.deepEqual(
      zcodePersonalConfigCandidates(
        { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/home/u/.zcode/headless/provider_config.json" },
        "/home/u",
        join,
      ),
      ["/home/u/.zcode/headless/provider_config.json", "/home/u/.zcode/v2/provider_config.json"],
    );
  });

  it("merges personal configs first-file-wins and lists their models", () => {
    const merged = mergeZCodePersonalConfigs([
      {
        schemaVersion: 1,
        config: {
          providerOrder: ["zai-fake", "deepseek"],
          providerConfigRules: {
            providerRules: [
              {
                providerId: "zai-fake",
                providerName: "Z.AI Fake",
                config: { personalModelIds: ["glm-5"], modelOrder: ["glm-5"] },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "zai-fake",
                modelId: "glm-5",
                config: { properties: { contextWindow: 200000 } },
              },
            ],
            manualProviderModelRules: [{ providerId: "zai-fake", modelId: "glm-5" }],
          },
        },
      },
      "not a config",
      {
        config: {
          providerOrder: ["deepseek", "zai-fake"],
          providerConfigRules: {
            providerRules: [
              {
                providerId: "deepseek",
                providerName: "DeepSeek",
                enabled: true,
                config: { modelOrder: ["deepseek-chat"], personalModelIds: ["deepseek-reasoner"] },
              },
              {
                providerId: "zai-fake",
                providerName: "Ignored",
                config: { personalModelIds: ["x"] },
              },
              { providerId: "off", enabled: false, config: { personalModelIds: ["m"] } },
            ],
          },
          modelConfigRules: { providerModelRules: [] },
        },
      },
    ]);
    assert.isNotNull(merged);
    // The CLI's strict schema needs both rule lists, and the first order wins.
    assert.deepEqual((merged!["config"] as { modelConfigRules: unknown }).modelConfigRules, {
      providerModelRules: [
        {
          providerId: "zai-fake",
          modelId: "glm-5",
          config: { properties: { contextWindow: 200000 } },
        },
      ],
      manualProviderModelRules: [{ providerId: "zai-fake", modelId: "glm-5" }],
    });
    assert.deepEqual(
      zcodeConfigModels(merged).map((model) => [model.slug, model.name, model.contextWindow]),
      [
        ["zai-fake/glm-5", "glm-5 · Z.AI Fake", 200000],
        ["deepseek/deepseek-chat", "deepseek-chat · DeepSeek", null],
        ["deepseek/deepseek-reasoner", "deepseek-reasoner · DeepSeek", null],
      ],
    );
    assert.isNull(mergeZCodePersonalConfigs([]));
  });

  it("drops rejected config models and records the level zcode accepted", () => {
    const configModels = zcodeConfigModels(
      mergeZCodePersonalConfigs([
        {
          config: {
            providerConfigRules: {
              providerRules: [{ providerId: "p", config: { modelOrder: ["a", "b", "c", "d"] } }],
            },
          },
        },
      ]),
    );
    const catalog = combineZCodeCatalog({
      configModels,
      snapshot: null,
      validation: new Map([
        ["p/a", { accepted: true, reasoningLevel: "high" }],
        ["p/b", { accepted: false }],
        ["p/c", { accepted: true, reasoningLevel: null }],
      ]),
    });
    assert.deepEqual(
      catalog.models.map((model) => [model.slug, model.defaultReasoningLevel]),
      [
        ["p/a", "high"],
        ["p/c", null],
        // Never probed (budget or cap): still listed.
        ["p/d", null],
      ],
    );
  });
});
