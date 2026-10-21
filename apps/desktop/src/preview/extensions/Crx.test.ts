// @effect-diagnostics nodeBuiltinImport:off - Real temporary directories exercise unpacking.
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { CrxError, extensionIdFromKey, readBounded, readPackageManifest, unpackCrx, verifyCrx3 } from "./Crx.ts";
import { crx, developerId, publisherKeySha256, zip } from "./CrxTestPackage.ts";

const archive = zip({ "manifest.json": '{"name":"Fixture","version":"1.2.3","manifest_version":3}', "popup/index.html": "<p>hi</p>" });

describe("verifyCrx3", () => {
  it("accepts a package signed by its developer and the store", () => {
    expect(verifyCrx3(crx({ archive }), { publisherKeySha256 }).id).toBe(developerId);
  });

  it("rejects a package the store did not sign", () => {
    expect(() => verifyCrx3(crx({ archive, signers: ["developer"] }), { publisherKeySha256 })).toThrow(
      /Chrome Web Store/,
    );
    expect(() => verifyCrx3(crx({ archive }))).toThrow(/Chrome Web Store/);
  });

  it("rejects a package whose declared id is not the developer key", () => {
    const stranger = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(() => verifyCrx3(crx({ archive, declaredKey: stranger }), { publisherKeySha256 })).toThrow(/developer/);
  });

  it("rejects a tampered archive", () => {
    const file = crx({ archive });
    file[file.length - 30] = (file[file.length - 30] ?? 0) ^ 0xff;
    expect(() => verifyCrx3(file, { publisherKeySha256 })).toThrow(/does not verify/);
  });

  it("rejects non-CRX3 input", () => {
    expect(() => verifyCrx3(Buffer.from("PK\x03\x04"), { publisherKeySha256 })).toThrow(CrxError);
  });
});

const manifestWith = (fields: Record<string, unknown>) =>
  verifyCrx3(crx({ archive: zip({ "manifest.json": JSON.stringify({ name: "Fixture", version: "1.0", ...fields }) }) }), {
    publisherKeySha256,
  });

describe("readPackageManifest", () => {
  it("accepts Chrome versions and resolves a localized name", async () => {
    const localized = verifyCrx3(
      crx({
        archive: zip({
          "manifest.json": '{"name":"__MSG_extName__","version":"2026.10.0","default_locale":"en"}',
          "_locales/en/messages.json": '{"extName":{"message":"Bitwarden Password Manager"}}',
        }),
      }),
      { publisherKeySha256 },
    );
    const read = await readPackageManifest(localized);
    expect(read.manifest.version).toBe("2026.10.0");
    expect(read.displayName).toBe("Bitwarden Password Manager");
  });

  it("rejects malformed versions before anything is written", async () => {
    for (const version of ["../../escape", "1.2.3.4.5", "01.2", "70000", "", "1..2", "1.2-beta"])
      await expect(readPackageManifest(manifestWith({ version }))).rejects.toThrow(/valid manifest/);
  });

  it("rejects manifests whose consumed fields have the wrong shape", async () => {
    await expect(readPackageManifest(manifestWith({ permissions: "tabs" }))).rejects.toThrow(/valid manifest/);
    await expect(readPackageManifest(manifestWith({ host_permissions: [42] }))).rejects.toThrow(/valid manifest/);
    await expect(readPackageManifest(manifestWith({ action: { default_popup: 1 } }))).rejects.toThrow(/valid manifest/);
    await expect(readPackageManifest(manifestWith({ commands: { x: { suggested_key: { mac: 1 } } } }))).rejects.toThrow(
      /valid manifest/,
    );
    await expect(readPackageManifest(manifestWith({ default_locale: "../x" }))).rejects.toThrow(/valid manifest/);
  });
});

describe("readBounded", () => {
  it("refuses bodies over the limit, declared or streamed", async () => {
    await expect(readBounded(new Response("x".repeat(10), { headers: { "content-length": "10" } }), 5)).rejects.toThrow(
      /too large/,
    );
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    });
    await expect(readBounded(new Response(stream), 5)).rejects.toThrow(/too large/);
    expect((await readBounded(new Response("abc"), 5)).toString()).toBe("abc");
  });
});

describe("unpackCrx", () => {
  it("unpacks files and pins the developer key in the manifest", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "crx-"));
    const directory = NodePath.join(root, "1.2.3");
    const verified = verifyCrx3(crx({ archive }), { publisherKeySha256 });
    await unpackCrx(verified, (await readPackageManifest(verified)).raw, directory);
    expect(await NodeFs.readFile(NodePath.join(directory, "popup/index.html"), "utf8")).toBe("<p>hi</p>");
    const written = JSON.parse(await NodeFs.readFile(NodePath.join(directory, "manifest.json"), "utf8"));
    expect(written.version).toBe("1.2.3");
    expect(extensionIdFromKey(Buffer.from(written.key, "base64"))).toBe(developerId);
    await NodeFs.rm(root, { recursive: true });
  });

  it("refuses entries that escape the extension directory", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "crx-"));
    const evil = verifyCrx3(crx({ archive: zip({ "manifest.json": '{"name":"x","version":"1"}', "../escaped.txt": "x" }) }), {
      publisherKeySha256,
    });
    await expect(unpackCrx(evil, {}, NodePath.join(root, "1"))).rejects.toThrow();
    await expect(NodeFs.access(NodePath.join(root, "escaped.txt"))).rejects.toThrow();
    await NodeFs.rm(root, { recursive: true });
  });
});
