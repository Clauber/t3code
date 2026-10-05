/**
 * ZCodeDriver — `ProviderDriver` for the zcode CLI, composing the native
 * app-server adapter (`ZCodeAdapterV2`) with the snapshot/probe layer
 * (`ZCodeProvider`).
 *
 * zcode state (sessions, settings, credentials, MCP config) lives in the
 * user's own `~/.zcode`, so continuation identity uses the default grouping.
 * The model catalog is learned from sessions the user opens, or from an
 * explicit model refresh; background health checks never open a session.
 */
import { ProviderDriverKind, ZCodeSettings } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

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
} from "../Layers/ZCodeProvider.ts";
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
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import type { ZCodeCatalog } from "../ZCodeModels.ts";
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
      const processEnv = mergeProviderInstanceEnvironment(environment, hostEnvironment);
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

      let catalog: ZCodeCatalog | null = null;
      let snapshot: ServerProviderShape | null = null;
      const rememberCatalog = (next: ZCodeCatalog) =>
        Effect.suspend(() => {
          catalog = next;
          return snapshot === null ? Effect.void : snapshot.refresh.pipe(Effect.asVoid);
        });

      const orchestrationAdapter = makeZCodeAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnv,
        spawner,
        idAllocator,
        serverConfig,
        onCatalog: rememberCatalog,
      });

      const checkProvider = Effect.suspend(() =>
        checkZCodeProviderStatus(effectiveConfig, processEnv, catalog),
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
          buildInitialZCodeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
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
        discoverZCodeCatalog(effectiveConfig, processEnv, serverConfig.cwd).pipe(
          Effect.flatMap(rememberCatalog),
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
