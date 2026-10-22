import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessInvokedAs,
  HostProcessIsExecutable,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";

import { hostingMarkerPath, publishHostingMarker } from "../browser/managedBrowserMaintenance.ts";
import { pinnedRuntimePaths } from "../cloud/pinnedRuntime.ts";
import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { repointLauncher, resolveLauncherPath, runUpdate, resolveNewestVersion } from "./update.ts";

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      // Another install's versions tree: same shape, different home.
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "./bin/t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: "" }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});

/**
 * `t3 update` runs in its own process and has no way to close the running server's admission, so a server
 * that hosts managed browsers is never restarted by it. These run the command's body end to end with the
 * service, the runner and the downloaded runtime faked at their edges, and look at whether the service
 * is told to restart.
 */
it.layer(NodeServices.layer)("t3 update and a server hosting managed browsers", (it) => {
  const TARGET = "9.9.9";

  const run = (
    withMarker: "none" | "before" | "during" | "malformed" | "unreadable",
    assumeYes = true,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-hosting-" });
      const baseDir = path.join(root, "home");
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      // The target runtime is already on disk, so nothing is downloaded.
      const paths = pinnedRuntimePaths(path, baseDir, TARGET, "linux");
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "");
      yield* fs.writeFileString(paths.sentinelPath, TARGET);
      const marker = hostingMarkerPath(stateDir);
      const scope = yield* Scope.make();
      const host = publishHostingMarker(marker).pipe(Scope.provide(scope));
      if (withMarker === "before") yield* host;
      // A marker that exists but cannot be understood is not an absent one.
      if (withMarker === "malformed" || withMarker === "unreadable") {
        yield* fs.makeDirectory(path.dirname(marker), { recursive: true });
        if (withMarker === "malformed") yield* fs.writeFileString(marker, "{ not json");
        else yield* fs.makeDirectory(marker);
      }

      const installs: Array<{ readonly start: boolean | undefined }> = [];
      const service = BootService.BootService.of({
        install: (options) =>
          Effect.sync(() => {
            installs.push({ start: options?.start });
            return {} as never;
          }),
        restart: Effect.succeed(true),
        uninstall: Effect.succeed(true),
        status: Effect.succeed({
          supported: true,
          installed: true,
          installedBaseDir: baseDir,
          installedVersion: "1.0.0",
          current: false,
          problems: [],
        } as never),
      });
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          // The runtime's own `--version` check: the moment a download would have finished.
          (withMarker === "during" ? host : Effect.void).pipe(
            Effect.as({ code: 0, stdout: `t3 v${TARGET}`, stderr: "" } as never),
          ),
      } as never);

      yield* runUpdate({
        baseDir,
        logsDir: path.join(baseDir, "logs"),
        serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
        channel: undefined,
        requestedVersion: TARGET,
        allowDowngrade: false,
        assumeYes,
        bootService: () => Layer.succeed(BootService.BootService, service),
      }).pipe(
        Effect.provideService(BootService.BootService, service),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(HostProcessEnvironment, {}),
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      yield* Scope.close(scope, Exit.void);
      return installs;
    }).pipe(Effect.scoped);

  it.effect("with nothing hosted, restarts the service as asked", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run("none"), [{ start: true }]);
    }),
  );

  it.effect(
    "points the service at the new version but does not restart one that hosts browsers",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* run("before"), [{ start: false }]);
      }),
  );

  it.effect("also declines when the marker exists but is malformed or unreadable", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run("malformed"), [{ start: false }]);
      assert.deepStrictEqual(yield* run("unreadable"), [{ start: false }]);
    }),
  );

  it.effect(
    "also declines when browsers start hosting while the new version was being prepared",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* run("during"), [{ start: false }]);
      }),
  );
});

it.effect(
  "private discovery uses only its mirror and rejects malformed or unavailable responses",
  () =>
    Effect.gen(function* () {
      const root = "http://127.0.0.1:8790";
      for (const fixture of [
        { body: '[{"tag_name":"v1.2.3"}]', status: 200, succeeds: true },
        { body: '{"invalid":true}', status: 200, succeeds: false },
        { body: "unavailable", status: 503, succeeds: false },
        { body: "[]", status: 200, succeeds: false },
      ]) {
        const requested: string[] = [];
        const client = HttpClient.make((request) => {
          requested.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(fixture.body, { status: fixture.status }),
            ),
          );
        });
        const result = yield* resolveNewestVersion("stable", root).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
        );
        assert.equal(result._tag === "Success", fixture.succeeds);
        assert.deepEqual(requested, [root + "/releases.json"]);
      }
    }),
);
