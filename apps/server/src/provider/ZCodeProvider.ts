/**
 * ZCodeProvider — snapshot/probe layer for the zcode CLI.
 *
 * Health is `zcode version` plus a sign-in inference: zcode has no
 * machine-readable auth status, so the probe looks for the credential and
 * provider-config files `zcode login` and headless installs write. Missing
 * files report "unknown", never "signed out", because a configuration this
 * probe does not know about may still work.
 *
 * Models come from the user's personal provider configs, which are plain
 * files, so a new instance lists them immediately. Opening a zcode session
 * starts the user's MCP servers, so background checks never open one;
 * validating those models and reading reasoning levels waits for an explicit
 * model refresh or a session the user starts.
 */
import {
  type CustomModelSetting,
  type ServerProviderModel,
  type ZCodeSettings,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { probeZCodeCatalog } from "../orchestration-v2/Adapters/ZCodeCatalogProbe.ts";
import { makeZCodeRpcConnection } from "../orchestration-v2/Adapters/ZCodeRpc.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";
import {
  EMPTY_ZCODE_MODEL_CAPABILITIES,
  mergeZCodePersonalConfigs,
  ZCODE_DEFAULT_MODEL_SLUG,
  zcodeConfigModels,
  zcodePersonalConfigCandidates,
  zcodeServerModels,
  type ZCodeCatalog,
  type ZCodeCatalogModel,
} from "./ZCodeModels.ts";

const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 8_000;
// Covers process start, session hooks, and the 90s validation budget.
const CATALOG_PROBE_TIMEOUT_MS = 150_000;

const ZCODE_DEFAULT_MODEL: ServerProviderModel = {
  slug: ZCODE_DEFAULT_MODEL_SLUG,
  name: "ZCode default",
  isCustom: false,
  capabilities: EMPTY_ZCODE_MODEL_CAPABILITIES,
};

export function zcodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  catalog: ZCodeCatalog | null,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [ZCODE_DEFAULT_MODEL, ...(catalog === null ? [] : zcodeServerModels(catalog))],
    customModels ?? [],
    EMPTY_ZCODE_MODEL_CAPABILITIES,
  );
}

/** Files whose presence means zcode has credentials or a provider configured. */
export function zcodeCredentialPaths(
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
): ReadonlyArray<string> {
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  const storage =
    environment.ZCODE_STORAGE_DIR?.trim() || (home === "" ? "" : path.join(home, ".zcode"));
  const dataBase = environment.ZCODE_DATA_BASE_DIR?.trim() || home;
  return [
    environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ?? "",
    dataBase === "" ? "" : path.join(dataBase, ".zcode", "v2", "credentials.json"),
    storage === "" ? "" : path.join(storage, "v2", "credentials.json"),
    storage === "" ? "" : path.join(storage, "v2", "provider_config.json"),
    storage === "" ? "" : path.join(storage, "headless", "provider_config.json"),
  ].filter((candidate) => candidate.length > 0);
}

const hasZCodeCredentials = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const candidate of zcodeCredentialPaths(environment, path)) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return true;
    }
    return false;
  });

/**
 * Reads the session snapshot's models and validates config models in a
 * throwaway deferred session. This starts the user's MCP servers, so it runs
 * only for an explicit model refresh.
 */
export const discoverZCodeCatalog = (
  settings: ZCodeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  candidates: ReadonlyArray<ZCodeCatalogModel>,
) =>
  Effect.gen(function* () {
    const connection = yield* makeZCodeRpcConnection({
      command: settings.binaryPath || "zcode",
      cwd,
      env: environment,
    });
    // session/create waits on the server requests it raises; refuse them all.
    yield* Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(connection.events);
        if (record["id"] !== undefined) {
          yield* connection.respondError(record["id"], -32601, "not implemented");
        }
      }
    }).pipe(Effect.ignore, Effect.forkScoped);
    return yield* probeZCodeCatalog(connection.request, cwd, candidates);
  }).pipe(Effect.scoped, Effect.timeout(CATALOG_PROBE_TIMEOUT_MS));

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface ZCodePersonalConfig {
  /** Merged config file every zcode process of the instance uses, if any. */
  readonly path: string | null;
  readonly models: ReadonlyArray<ZCodeCatalogModel>;
}

/**
 * Merges every personal provider config on this machine into `targetPath`
 * (mode 0600) so all of the user's providers exist in one zcode registry.
 * Unreadable or invalid files are skipped; any failure leaves zcode on its
 * own config resolution and never breaks the instance.
 */
export const materializeZCodePersonalConfig = (
  environment: NodeJS.ProcessEnv,
  home: string,
  targetPath: string,
): Effect.Effect<ZCodePersonalConfig, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const documents: Array<unknown> = [];
    for (const candidate of zcodePersonalConfigCandidates(environment, home, path.join)) {
      if (candidate === targetPath) continue;
      const text = yield* fileSystem
        .readFileString(candidate)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (text === undefined) continue;
      const document = decodeJson(text);
      if (Option.isSome(document)) documents.push(document.value);
    }
    const merged = mergeZCodePersonalConfigs(documents);
    if (merged === null) return { path: null, models: [] };
    yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    yield* fileSystem.writeFileString(targetPath, encodeJson(merged), { mode: 0o600 });
    // writeFile keeps an existing file's mode.
    yield* fileSystem.chmod(targetPath, 0o600);
    return { path: targetPath, models: zcodeConfigModels(merged) };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("ZCode personal provider config merge failed.", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as({ path: null, models: [] })),
    ),
  );

const runZCodeVersionCommand = (settings: ZCodeSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "zcode";
    const spawnCommand = yield* resolveSpawnCommand(command, ["version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialZCodeProviderSnapshot(
  settings: ZCodeSettings,
  catalog: ZCodeCatalog | null = null,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: zcodeModelsFromSettings(settings.customModels, catalog),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking zcode CLI availability..."
          : "ZCode is disabled in T3 Code settings.",
      },
    });
  });
}

export const checkZCodeProviderStatus = Effect.fn("checkZCodeProviderStatus")(function* (
  settings: ZCodeSettings,
  environment: NodeJS.ProcessEnv,
  catalog: ZCodeCatalog | null,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = zcodeModelsFromSettings(settings.customModels, catalog);
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!settings.enabled) {
    return build({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "ZCode is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runZCodeVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return build({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "ZCode CLI (`zcode`) is not installed or not on PATH."
        : "Failed to execute ZCode CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return build({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "ZCode CLI is installed but timed out while running `zcode version`.",
    });
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "ZCode CLI is installed but failed to run.",
    });
  }

  const authenticated =
    (catalog !== null && catalog.models.length > 0) || (yield* hasZCodeCredentials(environment));
  return build({
    installed: true,
    version,
    status: "ready",
    auth: authenticated ? { status: "authenticated", type: "zcode" } : { status: "unknown" },
  });
});
