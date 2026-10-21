import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ManagedBrowserOpenTabInput,
  ManagedBrowserOverview,
  ManagedBrowserSetControlInput,
  ManagedBrowserTabPhase,
  ManagedBrowserTabSummary,
  ManagedBrowserUpdateInput,
} from "./managedBrowserControls.ts";

describe("shared browser controls", () => {
  it("accepts only the update actions a person can take, never a version they name", () => {
    const decode = Schema.decodeUnknownSync(ManagedBrowserUpdateInput);
    for (const action of ["check", "pause", "resume", "pin", "unpin", "rollback", "recover"]) {
      expect(decode({ action })).toEqual({ action });
    }
    expect(() => decode({ action: "install" })).toThrow();
    // Extra fields are not an escape hatch: the only parameter is the action.
    expect(decode({ action: "pin", version: "9.9.9" })).toEqual({ action: "pin" });
  });

  it("bounds the address a tab is opened at", () => {
    const decode = Schema.decodeUnknownSync(ManagedBrowserOpenTabInput);
    const base = { instanceId: "instance-1", profileId: "profile-1" };
    expect(decode({ ...base, url: "https://example.com" }).url).toBe("https://example.com");
    expect(() => decode({ ...base, url: "x".repeat(2049) })).toThrow();
    expect(() => decode({ ...base, instanceId: "" })).toThrow();
  });

  it("names every state a tab can be in, including one whose browser is not running", () => {
    expect(Schema.is(ManagedBrowserTabPhase)("unavailable")).toBe(true);
    for (const phase of ["agent", "human", "reconnectHold", "paused", "transferring"]) {
      expect(Schema.is(ManagedBrowserTabPhase)(phase)).toBe(true);
    }
    expect(Schema.is(ManagedBrowserTabPhase)("idle")).toBe(false);
  });

  it("takes or releases control by naming a tab and one of two actions, nothing else", () => {
    const decode = Schema.decodeUnknownSync(ManagedBrowserSetControlInput);
    const tab = { hostThreadId: "thread-1", hostTabId: "tab-1" };
    expect(decode({ ...tab, action: "take" }).action).toBe("take");
    expect(decode({ ...tab, action: "release" }).action).toBe("release");
    expect(() => decode({ ...tab, action: "force" })).toThrow();
    expect(() => decode({ ...tab, action: "take", hostThreadId: "" })).toThrow();
    // The holder is the asking session, never a name in the request.
    expect(decode({ ...tab, action: "take", holder: "human:other" })).toEqual({
      ...tab,
      action: "take",
    });
  });

  it("opens a tab and takes control only when told to", () => {
    const decode = Schema.decodeUnknownSync(ManagedBrowserOpenTabInput);
    const base = { instanceId: "instance-1", profileId: "profile-1" };
    expect(decode(base).takeControl).toBeUndefined();
    expect(decode({ ...base, takeControl: true }).takeControl).toBe(true);
  });

  it("reads an owner that predates native hosting and the held-by-you flag", () => {
    const summary = {
      engineTabId: "tab-1",
      instanceId: "instance-1",
      profileId: "profile-1",
      incarnation: "boot-1",
      hostThreadId: "thread-1",
      hostTabId: "preview-1",
      title: "",
      url: null,
      shared: false,
      participants: 1,
      phase: "agent",
    };
    expect(Schema.decodeUnknownSync(ManagedBrowserTabSummary)(summary).heldByYou).toBeUndefined();
    expect(
      Schema.decodeUnknownSync(ManagedBrowserTabSummary)({ ...summary, heldByYou: true }).heldByYou,
    ).toBe(true);
    const overview = {
      ownerEnvironmentId: "env-owner",
      hosting: { available: true, reason: null },
      fullWindow: { available: false },
      profiles: [],
      tabs: [],
    };
    expect(Schema.decodeUnknownSync(ManagedBrowserOverview)(overview).native).toBeUndefined();
    expect(
      Schema.decodeUnknownSync(ManagedBrowserOverview)({ ...overview, native: { available: true } })
        .native,
    ).toEqual({ available: true });
  });
});
