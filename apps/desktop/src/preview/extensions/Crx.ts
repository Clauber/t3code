// @effect-diagnostics nodeBuiltinImport:off - Verifies and unpacks extension packages on disk.
/**
 * Chrome Web Store packages (CRX3), checked the way Chromium's
 * `crx_verifier.cc` does before anything is unpacked: every proof must verify
 * over the signed header and archive, one proof must be the developer key the
 * declared id derives from, and one must be the Web Store publisher key.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as Yauzl from "yauzl";

import * as Option from "effect/Option";

import { decodeInstallableManifest, type InstallableManifest } from "./ExtensionPolicy.ts";

/** SHA-256 of the Chrome Web Store publisher key (`kPublisherKeyHash` in Chromium). */
export const WEB_STORE_PUBLISHER_KEY_SHA256 =
  "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf";
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\x00", "latin1");
const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

export class CrxError extends Error {}

export interface VerifiedCrx {
  readonly id: string;
  /** Base64 developer key, written into the manifest so the id stays stable. */
  readonly publicKey: string;
  readonly archive: Buffer;
}

interface Field {
  readonly number: number;
  readonly bytes: Buffer;
}

/** The length-delimited fields of a protobuf message; CRX headers use no other wire type. */
const readFields = (message: Buffer): ReadonlyArray<Field> => {
  const fields: Field[] = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = message[offset++];
      if (byte === undefined) throw new CrxError("The package header is truncated.");
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new CrxError("The package header is malformed.");
  };
  while (offset < message.length) {
    const key = varint();
    if ((key & 7) !== 2) throw new CrxError("The package header is malformed.");
    const length = varint();
    if (offset + length > message.length) throw new CrxError("The package header is truncated.");
    fields.push({ number: Math.floor(key / 8), bytes: message.subarray(offset, offset + length) });
    offset += length;
  }
  return fields;
};

const idAlphabet = (hex: string) =>
  [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
export const extensionIdFromKey = (spki: Buffer): string =>
  idAlphabet(NodeCrypto.createHash("sha256").update(spki).digest("hex").slice(0, 32));

export const verifyCrx3 = (
  file: Buffer,
  options: { readonly publisherKeySha256?: string } = {},
): VerifiedCrx => {
  if (file.length < 12 || file.toString("latin1", 0, 4) !== "Cr24")
    throw new CrxError("This is not a Chrome extension package.");
  if (file.readUInt32LE(4) !== 3) throw new CrxError("Only CRX3 packages are supported.");
  const headerSize = file.readUInt32LE(8);
  if (12 + headerSize > file.length) throw new CrxError("The package header is truncated.");
  const header = readFields(file.subarray(12, 12 + headerSize));
  const archive = file.subarray(12 + headerSize);
  const signedData = header.find((field) => field.number === 10000)?.bytes;
  const crxId = signedData && readFields(signedData).find((field) => field.number === 1)?.bytes;
  if (!signedData || !crxId || crxId.length !== 16) throw new CrxError("The package has no declared id.");
  const declaredId = idAlphabet(crxId.toString("hex"));
  const signedSize = Buffer.alloc(4);
  signedSize.writeUInt32LE(signedData.length);
  const signedBytes = Buffer.concat([SIGNATURE_CONTEXT, signedSize, signedData, archive]);
  const publisherHash = options.publisherKeySha256 ?? WEB_STORE_PUBLISHER_KEY_SHA256;
  let developerKey: Buffer | undefined;
  let publisherSigned = false;
  for (const proof of header) {
    if (proof.number !== 2 && proof.number !== 3) continue;
    const parts = readFields(proof.bytes);
    const spki = parts.find((field) => field.number === 1)?.bytes;
    const signature = parts.find((field) => field.number === 2)?.bytes;
    if (!spki || !signature) throw new CrxError("The package has an incomplete signature.");
    const key = NodeCrypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    const expectedType = proof.number === 2 ? "rsa" : "ec";
    if (key.asymmetricKeyType !== expectedType) throw new CrxError("The package signature uses the wrong key type.");
    if (!NodeCrypto.verify("sha256", signedBytes, key, signature))
      throw new CrxError("The package signature does not verify.");
    if (extensionIdFromKey(spki) === declaredId) developerKey = spki;
    if (NodeCrypto.createHash("sha256").update(spki).digest("hex") === publisherHash) publisherSigned = true;
  }
  if (!developerKey) throw new CrxError("The package is not signed by its developer key.");
  if (!publisherSigned) throw new CrxError("The package is not signed by the Chrome Web Store.");
  return { id: declaredId, publicKey: developerKey.toString("base64"), archive };
};

/** Reads a response body, refusing anything larger than `maxBytes`. */
export const readBounded = async (response: Response, maxBytes: number): Promise<Buffer> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new CrxError("The extension package is too large.");
  const reader = response.body?.getReader();
  if (!reader) throw new CrxError("The extension package is empty.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CrxError("The extension package is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

const openZip = (archive: Buffer) =>
  new Promise<Yauzl.ZipFile>((resolve, reject) =>
    Yauzl.fromBuffer(
      archive,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => (error || !zip ? reject(new CrxError("The package archive is unreadable.")) : resolve(zip)),
    ),
  );

const readEntry = (zip: Yauzl.ZipFile, entry: Yauzl.Entry) =>
  new Promise<Buffer>((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(new CrxError("The package archive is unreadable."));
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", () => reject(new CrxError("The package archive is unreadable.")));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    }),
  );

const nextEntry = (zip: Yauzl.ZipFile) =>
  new Promise<Yauzl.Entry | null>((resolve, reject) => {
    const settle = (finish: () => void) => () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
      finish();
    };
    const onEntry = (entry: Yauzl.Entry) => settle(() => resolve(entry))();
    const onEnd = settle(() => resolve(null));
    const onError = settle(() => reject(new CrxError("The package archive is unreadable.")));
    zip.on("entry", onEntry);
    zip.on("end", onEnd);
    zip.on("error", onError);
    zip.readEntry();
  });

/** Calls `visit` for each archive entry, enforcing the entry and size limits. */
const eachEntry = async (archive: Buffer, visit: (zip: Yauzl.ZipFile, entry: Yauzl.Entry) => Promise<void>) => {
  const zip = await openZip(archive);
  let entries = 0;
  let unpacked = 0;
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      entries += 1;
      unpacked += entry.uncompressedSize;
      if (entries > MAX_ENTRIES || unpacked > MAX_UNPACKED_BYTES) throw new CrxError("The package is too large.");
      await visit(zip, entry);
    }
  } finally {
    zip.close();
  }
};

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const parseJsonObject = (bytes: Buffer): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(stripBom(bytes.toString("utf8")));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null;
  } catch {
    return null;
  }
};

export interface PackageManifest {
  readonly manifest: InstallableManifest;
  /** The whole manifest, written back with the developer key on unpack. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** `name` with a `__MSG_x__` placeholder resolved from the default locale. */
  readonly displayName: string;
}

/** Reads and validates the manifest from the archive in memory, before anything touches the disk. */
export const readPackageManifest = async (crx: VerifiedCrx): Promise<PackageManifest> => {
  const files = new Map<string, Buffer>();
  await eachEntry(crx.archive, async (zip, entry) => {
    if (entry.fileName === "manifest.json" || /^_locales\/[^/]+\/messages\.json$/.test(entry.fileName))
      files.set(entry.fileName, await readEntry(zip, entry));
  });
  const manifestBytes = files.get("manifest.json");
  const raw = manifestBytes ? parseJsonObject(manifestBytes) : null;
  const manifest = raw ? Option.getOrUndefined(decodeInstallableManifest(raw)) : undefined;
  if (!raw || !manifest) throw new CrxError("The package has no valid manifest.");
  const placeholder = /^__MSG_(\w+)__$/.exec(manifest.name)?.[1];
  const messagesBytes = manifest.default_locale ? files.get(`_locales/${manifest.default_locale}/messages.json`) : undefined;
  const messages = messagesBytes ? parseJsonObject(messagesBytes) : null;
  const entry =
    placeholder && messages
      ? Object.entries(messages).find(([key]) => key.toLowerCase() === placeholder.toLowerCase())?.[1]
      : undefined;
  const localized = typeof entry === "object" && entry !== null && "message" in entry ? entry.message : undefined;
  return { manifest, raw, displayName: typeof localized === "string" ? localized : manifest.name };
};

/** Unpacks into `directory`, which must not exist yet, pinning the developer key in the manifest. */
export const unpackCrx = async (crx: VerifiedCrx, raw: Readonly<Record<string, unknown>>, directory: string) => {
  await NodeFs.mkdir(directory, { recursive: false });
  await eachEntry(crx.archive, async (zip, entry) => {
    // yauzl's strictFileNames already refuses absolute and `..` names; this keeps the guarantee local.
    const target = NodePath.resolve(directory, entry.fileName);
    if (!target.startsWith(directory + NodePath.sep)) throw new CrxError("The package has an unsafe path.");
    if (entry.fileName.endsWith("/")) {
      await NodeFs.mkdir(target, { recursive: true });
      return;
    }
    await NodeFs.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFs.writeFile(target, await readEntry(zip, entry), { flag: "wx" });
  });
  await NodeFs.writeFile(NodePath.join(directory, "manifest.json"), JSON.stringify({ ...raw, key: crx.publicKey }, null, 2));
};
