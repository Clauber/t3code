// @effect-diagnostics nodeBuiltinImport:off - Real temporary directories exercise install and rollback.
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { verifyCrx3 } from "./Crx.ts";
import { crx, developerId, publisherKeySha256, zip } from "./CrxTestPackage.ts";
import { commitPackage, currentPackage, loadInstalled, removePackage, stagePackage, type ExtensionRuntime } from "./ExtensionStore.ts";

const packageOf = (version: string) =>
  verifyCrx3(
    crx({ archive: zip({ "manifest.json": JSON.stringify({ name: "Fixture", version }), "popup.html": version }) }),
    { publisherKeySha256 },
  );

/** Records what the browser has loaded; `failOn` makes loading that version fail like a broken package. */
const fakeRuntime = (failOn?: string, events: string[] = []) => {
  let loaded: string | null = null;
  const runtime: ExtensionRuntime = {
    isLoaded: () => loaded !== null,
    unload: () => {
      loaded = null;
    },
    load: async (directory) => {
      const version = await NodeFs.readFile(NodePath.join(directory, "popup.html"), "utf8");
      events.push(`load ${version}`);
      if (version === failOn) throw new Error("Electron refused the extension");
      loaded = directory;
    },
    clearData: async () => {
      events.push("clear data");
    },
  };
  return { runtime, loaded: () => loaded, events };
};

const withRoot = async (test: (root: string) => Promise<void>) => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "extensions-"));
  try {
    await test(root);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
};

const install = async (root: string, version: string, runtime: ExtensionRuntime) =>
  commitPackage(root, await stagePackage(root, packageOf(version)), runtime);

describe("ExtensionStore", () => {
  it("installs, updates and reloads the current package", () =>
    withRoot(async (root) => {
      const { runtime, loaded } = fakeRuntime();
      await install(root, "1.0", runtime);
      const first = await currentPackage(root, developerId);
      await install(root, "2.0", runtime);
      const second = await currentPackage(root, developerId);
      expect(second).toMatch(/^2\.0\+/);
      expect(loaded()).toBe(NodePath.join(root, developerId, second ?? ""));
      await expect(NodeFs.access(NodePath.join(root, developerId, first ?? ""))).rejects.toThrow();

      const restarted = fakeRuntime();
      expect(await loadInstalled(root, restarted.runtime)).toEqual([]);
      expect(restarted.loaded()).toBe(NodePath.join(root, developerId, second ?? ""));
    }));

  it("keeps the previous version loaded and current when an update fails to load", () =>
    withRoot(async (root) => {
      const { runtime, loaded } = fakeRuntime("2.0");
      await install(root, "1.0", runtime);
      const previous = await currentPackage(root, developerId);
      await expect(install(root, "2.0", runtime)).rejects.toThrow(/refused/);
      expect(await currentPackage(root, developerId)).toBe(previous);
      expect(loaded()).toBe(NodePath.join(root, developerId, previous ?? ""));
      expect(await NodeFs.readFile(NodePath.join(root, developerId, previous ?? "", "popup.html"), "utf8")).toBe("1.0");
      expect((await NodeFs.readdir(NodePath.join(root, developerId))).filter((name) => name.startsWith("2.0"))).toEqual([]);
    }));

  it("rolls back to the previous version when the pointer cannot be switched", () =>
    withRoot(async (root) => {
      const { runtime, loaded } = fakeRuntime();
      await install(root, "1.0", runtime);
      const previous = await currentPackage(root, developerId);
      const blockPointer: ExtensionRuntime = {
        ...runtime,
        load: async (directory) => {
          await runtime.load(directory);
          // A directory where the pointer goes makes the final rename fail after the switch.
          const current = NodePath.join(root, developerId, "current");
          await NodeFs.rm(current, { force: true });
          await NodeFs.mkdir(NodePath.join(current, "blocked"), { recursive: true });
        },
      };
      await expect(commitPackage(root, await stagePackage(root, packageOf("2.0")), blockPointer)).rejects.toThrow();
      expect(loaded()).toBe(NodePath.join(root, developerId, previous ?? ""));
      expect((await NodeFs.readdir(NodePath.join(root, developerId))).filter((name) => name.startsWith("2.0"))).toEqual([]);
    }));

  it("finishes clearing an uninstalled extension's data before a reinstall loads it", () =>
    withRoot(async (root) => {
      const events: string[] = [];
      let release = () => {};
      let entered = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const clearing = new Promise<void>((resolve) => (entered = resolve));
      const { runtime } = fakeRuntime(undefined, events);
      await install(root, "1.0", runtime);
      const staged = await stagePackage(root, packageOf("1.0"));
      const removal = removePackage(root, developerId, {
        ...runtime,
        clearData: async () => {
          entered();
          await gate;
          events.push("clear data");
        },
      });
      await clearing;
      const reinstall = commitPackage(root, staged, runtime);
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(events).toEqual(["load 1.0"]);
      release();
      await Promise.all([removal, reinstall]);
      expect(events).toEqual(["load 1.0", "clear data", "load 1.0"]);
      expect(await currentPackage(root, developerId)).toMatch(/^1\.0\+/);
    }));

  it("reinstalls the same version without deleting the running package first", () =>
    withRoot(async (root) => {
      const { runtime, loaded } = fakeRuntime();
      await install(root, "1.0", runtime);
      await install(root, "1.0", runtime);
      expect(await NodeFs.readFile(NodePath.join(loaded() ?? "", "popup.html"), "utf8")).toBe("1.0");
    }));

  it("serializes concurrent installs of one extension", () =>
    withRoot(async (root) => {
      const { runtime } = fakeRuntime();
      const stagedA = await stagePackage(root, packageOf("1.0"));
      const stagedB = await stagePackage(root, packageOf("2.0"));
      await Promise.all([commitPackage(root, stagedA, runtime), commitPackage(root, stagedB, runtime)]);
      const names = (await NodeFs.readdir(NodePath.join(root, developerId))).filter((name) => !name.startsWith("current"));
      expect(names).toEqual([await currentPackage(root, developerId)]);
    }));

  it("refuses ids and staged paths outside the profile's directory", () =>
    withRoot(async (root) => {
      const { runtime } = fakeRuntime();
      await expect(removePackage(root, "../../etc", runtime)).rejects.toThrow(/Invalid extension id/);
      const staged = await stagePackage(root, packageOf("1.0"));
      await expect(commitPackage(root, { ...staged, staging: NodePath.join(root, "..", "elsewhere") }, runtime)).rejects.toThrow(
        /Unknown staged package/,
      );
    }));

  it("ignores a tampered current pointer", () =>
    withRoot(async (root) => {
      const { runtime } = fakeRuntime();
      await install(root, "1.0", runtime);
      await NodeFs.writeFile(NodePath.join(root, developerId, "current"), "../../outside");
      const restarted = fakeRuntime();
      expect(await loadInstalled(root, restarted.runtime)).toEqual([]);
      expect(restarted.loaded()).toBeNull();
    }));
});
