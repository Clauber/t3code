// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway signed packages for tests.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import { extensionIdFromKey } from "./Crx.ts";

const field = (number: number, bytes: Buffer) => {
  const varint = (value: number) => {
    const out: number[] = [];
    while (value > 0x7f) {
      out.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(value);
    return Buffer.from(out);
  };
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
};

/** A deflated zip of the given files, enough for yauzl. */
export const zip = (files: Readonly<Record<string, string>>) => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const deflated = NodeZlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, deflated);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + deflated.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const developer = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publisher = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = (key: NodeCrypto.KeyObject) => key.export({ type: "spki", format: "der" });
export const publisherKeySha256 = NodeCrypto.createHash("sha256").update(spki(publisher.publicKey)).digest("hex");
export const developerId = extensionIdFromKey(spki(developer.publicKey));

export const crx = (options: {
  readonly archive: Buffer;
  readonly signers?: ReadonlyArray<"developer" | "publisher">;
  readonly declaredKey?: NodeCrypto.KeyObject;
}) => {
  const idBytes = NodeCrypto.createHash("sha256")
    .update(spki(options.declaredKey ?? developer.publicKey))
    .digest()
    .subarray(0, 16);
  const signed = field(1, idBytes);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signed.length);
  const message = Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), size, signed, options.archive]);
  const proofs = (options.signers ?? ["developer", "publisher"]).map((signer) => {
    const pair = signer === "developer" ? developer : publisher;
    return field(
      signer === "developer" ? 2 : 3,
      Buffer.concat([field(1, spki(pair.publicKey)), field(2, NodeCrypto.sign("sha256", message, pair.privateKey))]),
    );
  });
  const header = Buffer.concat([...proofs, field(10000, signed)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, options.archive]);
};
