/**
 * ZCodeDriver — `ProviderDriver` for the zcode CLI, composing the native
 * app-server adapter (`ZCodeAdapterV2`) with the snapshot/probe layer
 * (`ZCodeProvider`).
 *
 * zcode state (sessions, settings, credentials, MCP config) lives in the
 * user's own `~/.zcode`, so continuation identity uses the default grouping.
 * Models come from the user's personal provider configs at once; the first
 * session the user opens (or an explicit model refresh) validates them and
 * learns reasoning levels. Background health checks never open a session.
 */
import { ProviderDriverKind, ZCodeSettings } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NodeOS from "node:os";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import {
  makeZCodeAdapterV2,
  type ZCodeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ZCodeAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { TextGenerationError } from "@t3tools/contracts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialZCodeProviderSnapshot,
  checkZCodeProviderStatus,
  discoverZCodeCatalog,
  materializeZCodePersonalConfig,
} from "../ZCodeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import type { ServerProviderShape } from "../ServerProvider.ts";
import {
  combineZCodeCatalog,
  type ZCodeCatalog,
  type ZCodeModelValidation,
} from "../ZCodeModels.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeZCodeSettings = Schema.decodeSync(ZCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("zcode");
// zcode ships through its own installer; T3 does not update it.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration = (): TextGeneration["Service"] => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ZCode instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

export type ZCodeDriverEnv =
  | ZCodeAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

export const ZCodeDriver: ProviderDriver<ZCodeSettings, ZCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ZCode",
    supportsMultipleInstances: true,
  },
  configSchema: ZCodeSettings,
  defaultConfig: (): ZCodeSettings => decodeZCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const crypto = yield* Crypto.Crypto;
      const instanceEnv = mergeProviderInstanceEnvironment(environment, hostEnvironment);
      // Every zcode process of this instance uses one merged personal
      // provider config, so all of the user's providers are selectable.
      // Hashed so case-only instance ids stay apart on case-insensitive disks.
      const instanceKey = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(instanceId))
        .pipe(
          Effect.map(Hex.encode),
          Effect.orElseSucceed(() => String(instanceId)),
        );
      const personalConfig = yield* materializeZCodePersonalConfig(
        instanceEnv,
        instanceEnv.HOME?.trim() || instanceEnv.USERPROFILE?.trim() || NodeOS.homedir(),
        path.join(serverConfig.stateDir, "providers", "zcode", instanceKey, "provider_config.json"),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const processEnv: NodeJS.ProcessEnv =
        personalConfig.path === null
          ? instanceEnv
          : { ...instanceEnv, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalConfig.path };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies ZCodeSettings;

      let sessionSnapshot: ZCodeCatalog | null = null;
      let validation: ReadonlyMap<string, ZCodeModelValidation> | null = null;
      let validationClaimed = false;
      const currentCatalog = () =>
        combineZCodeCatalog({
          configModels: personalConfig.models,
          snapshot: sessionSnapshot,
          validation,
        });
      let snapshot: ServerProviderShape | null = null;
      const publish = Effect.suspend(() =>
        snapshot === null ? Effect.void : snapshot.refresh.pipe(Effect.asVoid),
      );

      const orchestrationAdapter = makeZCodeAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnv,
        spawner,
        idAllocator,
        serverConfig,
        knownModels: () => currentCatalog().models,
        onCatalog: (next) =>
          Effect.suspend(() => {
            sessionSnapshot = next;
            return publish;
          }),
        // The first session the user opens validates config models once.
        modelValidation: {
          claim: () => {
            if (validationClaimed || personalConfig.models.length === 0) return false;
            validationClaimed = true;
            return true;
          },
          candidates: () => personalConfig.models,
          onResult: (result) =>
            Effect.suspend(() => {
              validation = result.validation;
              if (result.snapshot.models.length > 0) sessionSnapshot = result.snapshot;
              return publish;
            }),
        },
      });

      const checkProvider = Effect.suspend(() =>
        checkZCodeProviderStatus(effectiveConfig, processEnv, currentCatalog()),
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const managedSnapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ZCodeSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialZCodeProviderSnapshot(settings.provider, currentCatalog()).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build ZCode snapshot.",
              cause,
            }),
        ),
      );
      snapshot = managedSnapshot;

      const refreshModels = () =>
        discoverZCodeCatalog(
          effectiveConfig,
          processEnv,
          serverConfig.cwd,
          personalConfig.models,
        ).pipe(
          Effect.flatMap((result) =>
            Effect.suspend(() => {
              validationClaimed = true;
              validation = result.validation;
              if (result.snapshot.models.length > 0) sessionSnapshot = result.snapshot;
              return publish;
            }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "Failed to read the ZCode model catalog.",
                cause,
              }),
          ),
        );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: managedSnapshot,
        orchestrationAdapter,
        textGeneration: unsupportedTextGeneration(),
        refreshModels,
      } satisfies ProviderInstance;
    }),
};
