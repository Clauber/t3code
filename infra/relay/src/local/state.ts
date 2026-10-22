// @effect-diagnostics globalDate:off -- Native Node runtime adapter.
// @effect-diagnostics nodeBuiltinImport:off -- Synchronous Node SQLite persistence boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";

export const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
export const secret = () => NodeCrypto.randomBytes(32).toString("base64url");
export const nowSeconds = () => Math.floor(Date.now() / 1000);
const Keys = Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String });

const decodeKeys = Schema.decodeUnknownSync(Keys);

export function openState(directory: string) {
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(directory, 0o700);
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "relay.sqlite"));
  NodeFS.chmodSync(NodePath.join(directory, "relay.sqlite"), 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS access (id TEXT PRIMARY KEY, session TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS replay (key TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, label TEXT NOT NULL, linked_at TEXT NOT NULL, credential_hash TEXT NOT NULL);
  `);
  const saved = db.prepare("SELECT value FROM settings WHERE key='mint-keys'").get();
  let keys;
  if (saved) {
    keys = decodeKeys(JSON.parse(String(saved.value)));
  } else {
    const pair = NodeCrypto.generateKeyPairSync("ed25519");
    keys = {
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    db.prepare("INSERT INTO settings VALUES ('mint-keys', ?)").run(JSON.stringify(keys));
  }
  const secretFile = NodePath.join(directory, "owner-secret");
  try {
    NodeFS.writeFileSync(secretFile, secret(), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  NodeFS.chmodSync(secretFile, 0o600);
  const ownerSecret = NodeFS.readFileSync(secretFile, "utf8").trim();
  if (ownerSecret.length < 40)
    throw new Error("Owner secret must contain at least 32 random bytes");
  function consume(key: string, expires: number) {
    return db.prepare("INSERT OR IGNORE INTO replay VALUES (?, ?)").run(key, expires).changes === 1;
  }
  function session(token: string) {
    const tokenHash = hash(token);
    return db
      .prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?")
      .get(tokenHash, nowSeconds())
      ? tokenHash
      : null;
  }
  function prune() {
    const now = nowSeconds();
    db.prepare("DELETE FROM replay WHERE expires<?").run(now - 300);
    db.prepare("DELETE FROM access WHERE expires<?").run(now);
    db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
  }
  return { db, keys, ownerSecret, consume, session, prune, close: () => db.close() };
}
