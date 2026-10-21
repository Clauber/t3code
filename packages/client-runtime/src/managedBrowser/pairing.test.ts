import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  agentGrantInput,
  ACCESS_CODE_TTL_OPTIONS,
  decodeAccessCode,
  encodeAccessCode,
  enrollmentFromAccessCode,
  normalizeOwnerAddress,
  viewerGrantInput,
} from "./pairing.ts";

const credential = `mbg.${"a".repeat(32)}.${"B".repeat(43)}`;
const content = {
  ownerEnvironmentId: "env-owner",
  instanceId: "instance-work",
  profileId: "work",
  threadId: "thread-1",
  agentSessionId: "env-caller\u0000session-1",
  expiresAt: "2030-01-01T00:00:00.000Z",
  credential,
};

describe("access codes", () => {
  it("round-trips everything an enrollment needs, including a provider session id with a NUL", () => {
    const code = encodeAccessCode(content);
    expect(code.startsWith("t3mb1.")).toBe(true);
    expect(decodeAccessCode(code)).toEqual(content);
  });

  it("does not show the credential in the clear", () => {
    expect(encodeAccessCode(content)).not.toContain(credential);
  });

  it("refuses anything that is not a code of this kind, without throwing", () => {
    for (const bad of [
      "",
      "t3mb1.",
      "t3mb1.@@@",
      "t3mb2.abc",
      credential,
      "t3mb1.bm90IGpzb24",
      encodeAccessCode({ ...content, credential: "mbg.short" }),
      encodeAccessCode({ ...content, expiresAt: "tomorrow" }),
      encodeAccessCode({ ...content, profileId: "" }),
    ]) {
      expect(decodeAccessCode(bad)).toBeNull();
    }
  });

  it("tolerates the whitespace a pasted code picks up", () => {
    expect(decodeAccessCode(`  ${encodeAccessCode(content)}\n`)).toEqual(content);
  });
});

describe("owner addresses", () => {
  it("accepts only an address: scheme, host and port", () => {
    expect(normalizeOwnerAddress("https://owner.example.com")).toBe("https://owner.example.com");
    expect(normalizeOwnerAddress("http://192.168.1.4:3773/")).toBe("http://192.168.1.4:3773");
    for (const bad of [
      "owner.example.com",
      "ftp://owner.example.com",
      "https://user:pw@owner.example.com",
      "https://owner.example.com/path",
      "https://owner.example.com/?token=1",
      "https://owner.example.com/#frag",
      "",
    ]) {
      expect(normalizeOwnerAddress(bad)).toBeNull();
    }
  });
});

describe("turning a code into an enrollment", () => {
  it("takes the grant id from the credential and the address from the person, never from the code", () => {
    const result = enrollmentFromAccessCode(encodeAccessCode(content), "https://owner.example.com");
    expect(result).toEqual({
      ok: true,
      input: {
        id: "a".repeat(32),
        ownerEnvironmentId: "env-owner",
        endpoint: "https://owner.example.com",
        instanceId: "instance-work",
        profileId: "work",
        threadId: "thread-1",
        agentSessionId: "env-caller\u0000session-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
        credential,
      },
    });
  });

  it("says what is wrong instead of sending a credential to a bad address", () => {
    expect(enrollmentFromAccessCode("nonsense", "https://owner.example.com")).toEqual({
      ok: false,
      reason: "code",
    });
    expect(
      enrollmentFromAccessCode(encodeAccessCode(content), "https://x.example.com/evil"),
    ).toEqual({
      ok: false,
      reason: "address",
    });
  });
});

describe("grants a person can create", () => {
  const owner = "env-owner" as EnvironmentId;
  it("makes a viewer grant for a signed-in device, read or drive", () => {
    expect(
      viewerGrantInput({
        sessionId: "session-1",
        access: "operate",
        ttl: "1d",
        resource: { instanceId: "instance-work", profileId: "work" },
      }),
    ).toEqual({
      subject: { kind: "viewer", viewerSessionId: "session-1" },
      resources: [{ instanceId: "instance-work", profileId: "work" }],
      access: "operate",
      ttlSeconds: 86_400,
    });
  });

  it("makes an agent grant bound to one chat and refuses a draft missing what binds it", () => {
    const draft = {
      callerEnvironmentId: "env-caller" as EnvironmentId,
      threadId: " thread-1 ",
      agentSessionId: "env-caller\u0000session-1",
      access: "read" as const,
      ttl: "1h" as const,
      resource: { instanceId: "instance-work", profileId: "work" },
    };
    expect(agentGrantInput(draft)).toMatchObject({
      subject: {
        kind: "agent",
        callerEnvironmentId: "env-caller",
        threadId: "thread-1",
        agentSessionId: "env-caller\u0000session-1",
      },
      access: "read",
      ttlSeconds: 3_600,
    });
    expect(agentGrantInput({ ...draft, threadId: "  " })).toBeNull();
    expect(agentGrantInput({ ...draft, agentSessionId: "" })).toBeNull();
    void owner;
  });

  it("offers lifetimes that all fit the longest the owner allows", () => {
    for (const option of ACCESS_CODE_TTL_OPTIONS) {
      expect(option.seconds).toBeGreaterThan(0);
      expect(option.seconds).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    }
  });
});
