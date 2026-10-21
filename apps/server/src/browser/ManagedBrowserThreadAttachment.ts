// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { PreviewManagedSession, type PreviewAutomationRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ThreadAttachment = Schema.Struct({
  ...PreviewManagedSession.fields,
  closed: Schema.optional(Schema.Boolean),
});
export type ThreadAttachment = typeof ThreadAttachment.Type;
const decode = Schema.decodeUnknownSync(ThreadAttachment);
const filename = (stateDir: string, threadId: string) =>
  Path.join(
    stateDir,
    "managed-browser",
    "thread-attachments",
    `${createHash("sha256").update(threadId).digest("hex")}.json`,
  );

/** Pointers only. The owner still authorizes every viewer and every exact agent session. */
export function readThreadAttachment(stateDir: string, threadId: string): ThreadAttachment | null {
  const path = filename(stateDir, threadId);
  if (!FS.existsSync(path)) return null;
  return decode(JSON.parse(FS.readFileSync(path, "utf8")));
}

export function writeThreadAttachment(
  stateDir: string,
  threadId: string,
  managed: ThreadAttachment | null,
): void {
  const path = filename(stateDir, threadId);
  if (managed === null) {
    FS.rmSync(path, { force: true });
    return;
  }
  FS.mkdirSync(Path.dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    FS.writeFileSync(temp, JSON.stringify(managed), { mode: 0o600 });
    FS.renameSync(temp, path);
  } finally {
    FS.rmSync(temp, { force: true });
  }
}

export function attachDefaultOpen(
  request: PreviewAutomationRequest,
  managed: ThreadAttachment | null,
): PreviewAutomationRequest {
  if (request.operation !== "open" || managed === null || request.tabIdExplicit) return request;
  const input = Schema.decodeUnknownSync(
    Schema.Struct({
      browserBinding: Schema.optional(Schema.Unknown),
      reuseExistingTab: Schema.optional(Schema.Boolean),
      joinTab: Schema.optional(Schema.Unknown),
    }),
  )(request.input);
  if (input.browserBinding !== undefined) {
    // Naming the chat's own browser still means the page its person is watching, not a hidden one.
    const named = input.browserBinding as Partial<Record<"ownerEnvironmentId" | "instanceId" | "profileId", unknown>> | null;
    const same =
      named?.ownerEnvironmentId === managed.ownerEnvironmentId &&
      named.instanceId === managed.instanceId &&
      named.profileId === managed.profileId;
    if (!same || managed.closed || input.joinTab !== undefined || input.reuseExistingTab === false) return request;
    return {
      ...request,
      tabId: undefined,
      input: { ...(request.input as object), joinTab: { engineTabId: managed.engineTabId, incarnation: managed.incarnation } },
    };
  }
  return {
    ...request,
    tabId: undefined,
    input: {
      ...(typeof request.input === "object" && request.input !== null ? request.input : {}),
      browserBinding: {
        ownerEnvironmentId: managed.ownerEnvironmentId,
        instanceId: managed.instanceId,
        profileId: managed.profileId,
      },
      ...(managed.closed || input.reuseExistingTab === false
        ? {}
        : { joinTab: { engineTabId: managed.engineTabId, incarnation: managed.incarnation } }),
    },
  };
}
