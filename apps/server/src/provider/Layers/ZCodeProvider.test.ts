import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { parseZCodeCatalog } from "../ZCodeModels.ts";
import { checkZCodeProviderStatus } from "./ZCodeProvider.ts";

const encoder = new TextEncoder();

function versionSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_002),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(args.includes("version") ? 0 : 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(encoder.encode(`${version}\n`)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

const settings = { enabled: true, binaryPath: "zcode", customModels: [] } as const;

/** `settings.model` as zcode 0.16.9 reports it in a subscribe snapshot. */
const SETTINGS_MODEL = {
  available: [
    {
      ref: { providerId: "zai-api-headless", modelId: "glm-5.3-flash" },
      label: "glm-5.3-flash",
      contextWindow: 200000,
      reasoning: {
        levels: [{ value: "low" }, { value: "high" }, { value: "max" }],
        defaultLevel: "max",
      },
    },
  ],
  current: { providerId: "zai-api-headless", modelId: "glm-5.3-flash" },
};

describe("ZCodeProvider", () => {
  it.effect("lists discovered models with their reasoning levels after the default", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkZCodeProviderStatus(
        settings,
        { HOME: "/nonexistent-zcode-home" },
        parseZCodeCatalog(SETTINGS_MODEL),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, versionSpawner("0.16.9")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.version, "0.16.9");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default", "zai-api-headless/glm-5.3-flash"],
      );
      const reasoning = snapshot.models[1]?.capabilities?.optionDescriptors?.[0];
      assert.equal(reasoning?.id, "reasoning");
      assert.isTrue(
        reasoning?.type === "select" &&
          reasoning.options.find((option) => option.isDefault)?.id === "max",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("infers sign-in from zcode's credential files and never reports signed out", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-zcode-home-" });
      const check = checkZCodeProviderStatus(settings, { HOME: home }, null).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, versionSpawner("0.16.9")),
      );
      assert.equal((yield* check).auth.status, "unknown");
      yield* fileSystem.makeDirectory(path.join(home, ".zcode", "headless"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(home, ".zcode", "headless", "provider_config.json"),
        "{}",
      );
      const signedIn = yield* check;
      assert.equal(signedIn.auth.status, "authenticated");
      assert.deepEqual(
        signedIn.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
