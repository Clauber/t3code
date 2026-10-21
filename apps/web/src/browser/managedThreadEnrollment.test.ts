import { EnvironmentId, ThreadId, PreviewAutomationBrowserBinding, ManagedBrowserGrant } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ensureThreadEnrollment, reachableBrowserOwnerAddress, threadEnrollmentReady, type ThreadEnrollmentCommands, type ThreadEnrollmentInput } from "./managedThreadEnrollment";

const binding = Schema.decodeUnknownSync(PreviewAutomationBrowserBinding)({ ownerEnvironmentId: "mac", instanceId: "browser", profileId: "default" });
const grant = Schema.decodeUnknownSync(ManagedBrowserGrant)({
  id: "grant-one", label: "Browser panel", ownerEnvironmentId: "mac",
  subject: { kind: "agent", callerEnvironmentId: "harness", threadId: "thread", agentSessionId: "active-mcp-principal" },
  resources: [{ instanceId: "browser", profileId: "default" }], access: "operate",
  createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null,
});
function fixture() {
  const calls: string[] = [];
  const input: ThreadEnrollmentInput = {
    threadRef: { environmentId: EnvironmentId.make("harness"), threadId: ThreadId.make("thread") }, binding,
    agentSessionId: "active-mcp-principal", endpoint: "http://100.64.0.12:3773",
    grants: [], enrollments: [], replace: false,
  };
  const commands: ThreadEnrollmentCommands = {
    create: async (value) => { calls.push("create"); expect(value.subject).toEqual(grant.subject); return { grant, credential: "test-credential-never-displayed" }; },
    enroll: async (value) => { calls.push("enroll"); expect(value.agentSessionId).toBe(input.agentSessionId); expect(value.threadId).toBe("thread"); },
    revoke: async () => { calls.push("revoke"); }, remove: async () => { calls.push("remove"); },
  };
  return { input, commands, calls };
}

describe("thread browser enrollment", () => {
  it("never turns a client-local address into a remote browser endpoint", () => {
    for (const url of ["http://localhost:3773", "http://127.0.0.1:3773", "http://[::1]:3773", "http://0.0.0.0:3773", "https://mac/path", "https://user:pass@mac"]) expect(reachableBrowserOwnerAddress(url)).toBeNull();
    expect(reachableBrowserOwnerAddress("http://100.64.0.12:3773")).toBe("http://100.64.0.12:3773");
  });
  it("shares one in-flight exact-session enrollment across duplicate panel mounts", async () => {
    const { input, commands, calls } = fixture();
    await Promise.all([ensureThreadEnrollment(input, commands), ensureThreadEnrollment(input, commands)]);
    expect(calls).toEqual(["create", "enroll"]);
  });
  it("does not resurrect revoked authorization automatically", async () => {
    const { input, commands, calls } = fixture();
    await expect(ensureThreadEnrollment({ ...input, grants: [{ ...grant, revokedAt: grant.createdAt }] }, commands)).rejects.toThrow("not renewed automatically");
    expect(calls).toEqual([]);
  });
  it("revokes old panel-session access before granting the new session", async () => {
    const { input, commands, calls } = fixture();
    const old = Schema.decodeUnknownSync(ManagedBrowserGrant)({ ...grant, subject: { ...grant.subject, agentSessionId: "previous-mcp-principal" } });
    await ensureThreadEnrollment({ ...input, grants: [old] }, commands);
    expect(calls).toEqual(["revoke", "remove", "create", "enroll"]);
  });
  it("revokes the new credential if remote enrollment fails", async () => {
    const { input, commands, calls } = fixture();
    await expect(ensureThreadEnrollment(input, { ...commands, enroll: async () => { throw new Error("secret response"); } })).rejects.toThrow("Could not connect");
    expect(calls).toEqual(["create", "revoke"]);
  });
  it("does not enroll a credential for a session that changed while creation was in flight", async () => {
    const { input, commands, calls } = fixture();
    await expect(ensureThreadEnrollment(input, { ...commands, isCurrent: () => false })).rejects.toThrow("Could not connect");
    expect(calls).toEqual(["create", "revoke"]);
  });
  it("requires exact owner, profile, session and live owner authorization before reporting ready", () => {
    const { input } = fixture();
    const enrollment = { id: grant.id, ...binding, endpoint: input.endpoint, threadId: "thread", agentSessionId: input.agentSessionId, expiresAt: grant.expiresAt };
    expect(threadEnrollmentReady({ ...input, grants: [grant], enrollments: [enrollment] })).toBe(true);
    expect(threadEnrollmentReady({ ...input, grants: [grant], enrollments: [{ ...enrollment, agentSessionId: "other" }] })).toBe(false);
    expect(threadEnrollmentReady({ ...input, grants: [{ ...grant, revokedAt: grant.createdAt }], enrollments: [enrollment] })).toBe(false);
  });
});
