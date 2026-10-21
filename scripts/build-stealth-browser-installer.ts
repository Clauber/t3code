#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Regenerates `components/stealth-browser/`: the audited release verifier and installer from the
 * stealth-browser repository, bundled unmodified (with their `ajv` and `tar` dependencies) into one
 * CommonJS file the server loads at runtime. T3 carries no tar or signature code of its own; this is
 * the only way those scripts reach it. The source repository's own esbuild does the bundling.
 *
 *   node scripts/build-stealth-browser-installer.ts --source <stealth-browser worktree>
 */
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

const sourceFlag = process.argv.indexOf("--source");
const source = sourceFlag === -1 ? undefined : process.argv[sourceFlag + 1];
if (source === undefined) throw new Error("Pass --source <stealth-browser worktree>.");

const componentDir = Path.resolve(import.meta.dirname, "../components/stealth-browser");
const sha256 = (file: string) =>
  Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex");
const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  ChildProcess.execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

const scripts = Path.join(source, "scripts");
const schema = Path.join(source, "release", "manifest.schema.json");
const esbuild = Path.join(source, "node_modules", ".bin", "esbuild");
// Not the system temp directory: esbuild reads every package.json above the entry file.
FS.mkdirSync(componentDir, { recursive: true });
const scratch = FS.mkdtempSync(Path.join(componentDir, ".build-"));
try {
  const entry = Path.join(scratch, "entry.mjs");
  FS.writeFileSync(
    entry,
    [
      `export { installRelease, rollbackRelease } from ${JSON.stringify(Path.join(scripts, "install.mjs"))};`,
      `export { verifyRelease, validateManifestSchema, checkBrowserPrerequisites } from ${JSON.stringify(Path.join(scripts, "verify-release.mjs"))};`,
    ].join("\n"),
  );
  const bundle = Path.join(componentDir, "tools", "stealth-browser-installer.cjs");
  FS.mkdirSync(Path.dirname(bundle), { recursive: true });
  // The scripts locate their schema from import.meta.url; in the bundle that is the bundle's own path,
  // so `release/manifest.schema.json` sits one directory above `tools/`.
  run(
    esbuild,
    [
      entry,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node22",
      "--define:import.meta.url=__importMetaUrl",
      "--banner:js=const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
      `--outfile=${bundle}`,
      "--log-level=warning",
    ],
    source,
  );
  FS.mkdirSync(Path.join(componentDir, "release"), { recursive: true });
  FS.copyFileSync(schema, Path.join(componentDir, "release", "manifest.schema.json"));
  FS.writeFileSync(
    Path.join(componentDir, "SOURCES.json"),
    JSON.stringify(
      {
        origin: "stealth-browser release worktree",
        sourceCommit: run("git", ["rev-parse", "HEAD"], source),
        esbuild: run(esbuild, ["--version"], source),
        sources: {
          "scripts/install.mjs": sha256(Path.join(scripts, "install.mjs")),
          "scripts/verify-release.mjs": sha256(Path.join(scripts, "verify-release.mjs")),
          "release/manifest.schema.json": sha256(schema),
        },
        bundle: { "tools/stealth-browser-installer.cjs": sha256(bundle) },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  FS.rmSync(scratch, { recursive: true, force: true });
}
