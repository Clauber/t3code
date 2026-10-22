import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

const AppUpdateMetadata = Schema.Struct({
  provider: Schema.NonEmptyString,
  url: Schema.optional(Schema.String),
});
export type AppUpdateMetadata = typeof AppUpdateMetadata.Type;
const decode = Schema.decodeUnknownSync(fromYaml(AppUpdateMetadata));

/** Undefined means absent; null means present but invalid. */
export function parseAppUpdateMetadata(
  raw: string | undefined,
): AppUpdateMetadata | null | undefined {
  if (raw === undefined) return undefined;
  try {
    return decode(raw);
  } catch {
    return null;
  }
}
