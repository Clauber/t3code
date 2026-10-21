// @effect-diagnostics nodeBuiltinImport:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Schema from "effect/Schema";
import { PreviewManagedSession, PreviewAutomationRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  attachDefaultOpen,
  readThreadAttachment,
  writeThreadAttachment,
} from "./ManagedBrowserThreadAttachment.ts";
const managed = Schema.decodeUnknownSync(PreviewManagedSession)({
  ownerEnvironmentId: "mac",
  instanceId: "instance-default",
  profileId: "default",
  incarnation: "boot",
  engineTabId: "page",
  hostThreadId: "human-thread",
  hostTabId: "owner-tab",
  shared: true,
  native: true,
  remote: true,
});
const request = Schema.decodeUnknownSync(PreviewAutomationRequest)({
  requestId: "request",
  threadId: "chat",
  callerEnvironmentId: "harness",
  agentSessionId: "real-provider-session",
  operation: "open",
  input: {},
  timeoutMs: 1000,
});
describe("managed thread attachment", () => {
  it("persists a human-selected page before any provider exists and scopes it to its thread", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-panel-"));
    try {
      writeThreadAttachment(dir, "chat", managed);
      expect(readThreadAttachment(dir, "chat")).toEqual(managed);
      expect(readThreadAttachment(dir, "another-chat")).toBeNull();
      writeThreadAttachment(dir, "chat", null);
      expect(readThreadAttachment(dir, "chat")).toBeNull();
    } finally {
      FS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("joins the human page without changing authenticated caller identity", () => {
    const attached = attachDefaultOpen(request, managed);
    expect(attached.agentSessionId).toBe(request.agentSessionId);
    expect(attached.callerEnvironmentId).toBe(request.callerEnvironmentId);
    expect(attached.input).toMatchObject({
      browserBinding: { ownerEnvironmentId: "mac", profileId: "default" },
      joinTab: { engineTabId: "page", incarnation: "boot" },
    });
    const replaced = attachDefaultOpen(
      { ...request, agentSessionId: "replacement-session" },
      managed,
    );
    expect(replaced.agentSessionId).toBe("replacement-session");
  });
  it("joins the human page when the agent names that same browser, unless it asks for its own tab", () => {
    const binding = { ownerEnvironmentId: "mac", instanceId: "instance-default", profileId: "default" };
    const named = { ...request, input: { browserBinding: binding } };
    expect(attachDefaultOpen(named, managed).input).toMatchObject({
      browserBinding: binding,
      joinTab: { engineTabId: "page", incarnation: "boot" },
    });
    for (const input of [
      { browserBinding: binding, reuseExistingTab: false },
      { browserBinding: binding, joinTab: { engineTabId: "other-page" } },
      { browserBinding: { ...binding, profileId: "work" } },
    ]) {
      const own = { ...request, input };
      expect(attachDefaultOpen(own, managed)).toBe(own);
    }
    expect(attachDefaultOpen(named, { ...managed, closed: true })).toBe(named);
  });
  it("does not override an explicitly requested browser", () => {
    const explicit = { ...request, input: { browserBinding: { ownerEnvironmentId: "other" } } };
    expect(attachDefaultOpen(explicit, managed)).toBe(explicit);
  });
});

it("keeps the selected managed profile but stops joining a detached page", () => {
  const reopened = attachDefaultOpen(request, { ...managed, closed: true });
  expect(reopened.input).toMatchObject({
    browserBinding: { ownerEnvironmentId: "mac", profileId: "default" },
  });
  expect(reopened.input).not.toHaveProperty("joinTab");
});

it("honors an explicit existing tab or a request for a new tab in the selected profile", () => {
  const explicit = { ...request, tabId: "explicit-tab", tabIdExplicit: true };
  expect(attachDefaultOpen(explicit, managed)).toBe(explicit);
  const fresh = attachDefaultOpen({ ...request, input: { reuseExistingTab: false } }, managed);
  expect(fresh.input).toHaveProperty("browserBinding");
  expect(fresh.input).not.toHaveProperty("joinTab");
});
