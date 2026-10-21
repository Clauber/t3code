// @effect-diagnostics nodeBuiltinImport:off - Owns the on-disk extension packages of a profile.
/**
 * A profile's installed extensions on disk: `<root>/<id>/<package>/` holds
 * one unpacked version and `<root>/<id>/current` names the package that
 * loads. Electron-free; the browser that loads packages comes in as
 * `ExtensionRuntime`, so install, update and rollback are testable alone.
 *
 * An update never touches the running package until its replacement has
 * loaded: a failed load reloads the previous package and leaves `current`
 * pointing at it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { CrxError, readPackageManifest, unpackCrx, type PackageManifest, type VerifiedCrx } from "./Crx.ts";

export interface ExtensionRuntime {
  readonly isLoaded: (id: string) => boolean;
  readonly unload: (id: string) => void;
  readonly load: (directory: string) => Promise<void>;
  /** Deletes the extension's own storage; runs inside the same serialization as installs. */
  readonly clearData: (id: string) => Promise<void>;
}

const EXTENSION_ID = /^[a-p]{32}$/;
const PACKAGE_NAME = /^\d+(?:\.\d+){0,3}\+[0-9a-f]{16}$/;
const STAGING_NAME = /^\.staging-[0-9a-f]{16}$/;

/** `target` resolved, refusing anything outside `root`. */
const inside = (root: string, ...segments: ReadonlyArray<string>) => {
  const base = NodePath.resolve(root);
  const target = NodePath.resolve(base, ...segments);
  if (!target.startsWith(base + NodePath.sep)) throw new CrxError("Refusing a path outside the extension directory.");
  return target;
};
const extensionDirectory = (root: string, id: string) => {
  if (!EXTENSION_ID.test(id)) throw new CrxError("Invalid extension id.");
  return inside(root, id);
};

const locks = new Map<string, Promise<unknown>>();
/** Runs installs, updates and removals of one extension in one profile one at a time. */
const serialized = <A>(root: string, id: string, task: () => Promise<A>): Promise<A> => {
  const key = `${NodePath.resolve(root)}\u0000${id}`;
  const run = (locks.get(key) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => undefined);
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return run;
};

export const currentPackage = async (root: string, id: string): Promise<string | null> => {
  const name = (await NodeFs.readFile(NodePath.join(extensionDirectory(root, id), "current"), "utf8").catch(() => "")).trim();
  return PACKAGE_NAME.test(name) ? name : null;
};

export interface StagedPackage extends PackageManifest {
  readonly id: string;
  readonly staging: string;
}

/**
 * Verifies the manifest in memory, then unpacks into a fresh staging directory
 * beside (not inside) the extension's own, so a concurrent removal cannot touch it.
 */
export const stagePackage = async (root: string, crx: VerifiedCrx): Promise<StagedPackage> => {
  const manifest = await readPackageManifest(crx);
  extensionDirectory(root, crx.id);
  await NodeFs.mkdir(root, { recursive: true });
  const staging = inside(root, `.staging-${NodeCrypto.randomBytes(8).toString("hex")}`);
  try {
    await unpackCrx(crx, manifest.raw, staging);
  } catch (error) {
    await NodeFs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { ...manifest, id: crx.id, staging };
};

const isStaging = (root: string, staging: string) =>
  STAGING_NAME.test(NodePath.basename(staging)) && NodePath.dirname(staging) === NodePath.resolve(root);

export const discardStaged = (root: string, staged: StagedPackage) =>
  isStaging(root, staged.staging) ? NodeFs.rm(staged.staging, { recursive: true, force: true }) : Promise.resolve();

/** Makes a staged package the extension's loaded one, keeping the previous package until it is. */
export const commitPackage = (root: string, staged: StagedPackage, runtime: ExtensionRuntime): Promise<void> =>
  serialized(root, staged.id, async () => {
    const directory = extensionDirectory(root, staged.id);
    if (!isStaging(root, staged.staging)) throw new CrxError("Unknown staged package.");
    await NodeFs.mkdir(directory, { recursive: true });
    const name = `${staged.manifest.version}+${NodeCrypto.randomBytes(8).toString("hex")}`;
    const target = inside(directory, name);
    await NodeFs.rename(staged.staging, target);
    const previous = await currentPackage(root, staged.id);
    // The pointer is staged before the runtime switches, so the only step after it is one rename.
    const pointer = inside(directory, "current.tmp");
    await NodeFs.writeFile(pointer, name);
    const wasLoaded = runtime.isLoaded(staged.id);
    if (wasLoaded) runtime.unload(staged.id);
    try {
      await runtime.load(target);
      await NodeFs.rename(pointer, inside(directory, "current"));
    } catch (error) {
      if (runtime.isLoaded(staged.id)) runtime.unload(staged.id);
      await NodeFs.rm(target, { recursive: true, force: true });
      await NodeFs.rm(pointer, { force: true });
      if (wasLoaded && previous)
        await runtime.load(inside(directory, previous)).catch((restoreError: unknown) => {
          throw new AggregateError([error, restoreError], "The update failed and the previous version did not reload.");
        });
      throw error;
    }
    if (previous) await NodeFs.rm(inside(directory, previous), { recursive: true, force: true });
  });

/** Unloads the extension and deletes its package and data, before any later install of it runs. */
export const removePackage = (root: string, id: string, runtime: ExtensionRuntime): Promise<void> =>
  serialized(root, id, async () => {
    const directory = extensionDirectory(root, id);
    if (runtime.isLoaded(id)) runtime.unload(id);
    await NodeFs.rm(directory, { recursive: true, force: true });
    await runtime.clearData(id);
  });

/** Loads every installed package; one broken package does not stop the others. */
export const loadInstalled = async (
  root: string,
  runtime: ExtensionRuntime,
): Promise<ReadonlyArray<{ readonly id: string; readonly cause: unknown }>> => {
  const failures: Array<{ readonly id: string; readonly cause: unknown }> = [];
  const entries = await NodeFs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !EXTENSION_ID.test(entry.name)) continue;
    const name = await currentPackage(root, entry.name);
    if (name === null) continue;
    await runtime.load(inside(root, entry.name, name)).catch((cause: unknown) => failures.push({ id: entry.name, cause }));
  }
  return failures;
};
