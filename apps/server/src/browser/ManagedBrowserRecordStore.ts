// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
/**
 * ManagedBrowserRecordStore - a small durable map for the managed browser's per-server records
 * (enrollments, remote tabs): one JSON file, atomic and private, never replaced by an empty one.
 *
 * @module ManagedBrowserRecordStore
 */
import * as FS from "node:fs";
import * as Path from "node:path";

type RecordLoad =
  | { readonly _tag: "ready" }
  | { readonly _tag: "unreadable"; readonly detail: string };

/**
 * A small durable map: one JSON file, written atomically with mode 0600, whose version or content is
 * checked when it is read. A file that cannot be read is reported, never replaced by an empty one.
 */
export const makeRecordStore = <A>(
  path: string | null,
  options: {
    readonly version: number;
    readonly field: string;
    readonly label: string;
    readonly max: number;
    readonly keyOf: (record: A) => string;
    readonly valid: (value: unknown) => value is A;
  },
) => {
  const records = new Map<string, A>();
  let status: RecordLoad = { _tag: "ready" };
  if (path !== null) {
    try {
      if (FS.existsSync(path)) {
        const parsed = JSON.parse(FS.readFileSync(path, "utf8")) as Record<string, unknown>;
        if (parsed.schemaVersion !== options.version) {
          status = { _tag: "unreadable", detail: `unsupported ${options.label} record version` };
        } else {
          const entries = parsed[options.field];
          for (const entry of Array.isArray(entries) ? entries : []) {
            if (!options.valid(entry)) throw new Error(`a ${options.label} record is malformed`);
            records.set(options.keyOf(entry), entry);
          }
        }
      }
    } catch (cause) {
      records.clear();
      status = {
        _tag: "unreadable",
        detail: cause instanceof Error ? cause.message : "unreadable",
      };
    }
  }
  const save = () => {
    if (path === null || status._tag !== "ready") return;
    FS.mkdirSync(Path.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    FS.writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: options.version, [options.field]: [...records.values()] }),
      { mode: 0o600 },
    );
    FS.renameSync(temporary, path);
  };
  return {
    get status() {
      return status;
    },
    all: () => [...records.values()],
    get: (key: string) => records.get(key),
    put: (record: A) => {
      const key = options.keyOf(record);
      const previous = records.get(key);
      if (previous === undefined && records.size >= options.max) {
        throw new Error(`the managed browser ${options.label} record is full`);
      }
      records.set(key, record);
      try {
        save();
      } catch (cause) {
        if (previous === undefined) records.delete(key);
        else records.set(key, previous);
        throw cause;
      }
    },
    remove: (key: string) => {
      const previous = records.get(key);
      if (previous === undefined) return false;
      records.delete(key);
      try {
        save();
      } catch (cause) {
        records.set(key, previous);
        throw cause;
      }
      return true;
    },
  };
};
