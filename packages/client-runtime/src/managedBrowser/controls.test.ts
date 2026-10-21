import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentId,
  ManagedBrowserOverview,
  ManagedBrowserUpdateStatus,
  PreviewManagedSession,
} from "@t3tools/contracts";

import type { PreviewStreamControl } from "../preview/serverBrowserStream.ts";
import {
  UPDATE_ACTIONS,
  canUseOnThisComputer,
  describeTabControl,
  describeActivation,
  describeGrantHolder,
  describeHosting,
  describeManagedControl,
  describeUpdate,
  managedStreamTarget,
  newProfileBinding,
  resolveOwner,
  resolveProfileSelection,
} from "./controls.ts";

const chat = "env-chat" as EnvironmentId;
const owner = "env-owner" as EnvironmentId;

const managed = (overrides: Partial<PreviewManagedSession> = {}): PreviewManagedSession => ({
  ownerEnvironmentId: owner,
  instanceId: "instance-1" as never,
  profileId: "profile-1" as never,
  incarnation: "boot-1" as never,
  engineTabId: "engine-tab" as never,
  hostThreadId: "host-thread",
  hostTabId: "host-tab",
  shared: true,
  remote: true,
  ...overrides,
});

describe("where a person watches a browser from", () => {
  it("uses the owner's own connection and the owner's ids for a browser another environment holds", () => {
    const target = managedStreamTarget(
      { threadId: "chat-thread", tabId: "shadow-tab", managed: managed() },
      chat,
    );
    expect(target).toEqual({
      environmentId: owner,
      threadId: "host-thread",
      tabId: "host-tab",
      viaOwner: true,
    });
    // Never the chat's connection: it holds no grant on the owner and its ids mean nothing there.
    expect(target.environmentId).not.toBe(chat);
  });

  it("keeps the chat's own connection for a browser this environment holds", () => {
    expect(
      managedStreamTarget(
        {
          threadId: "chat-thread",
          tabId: "tab",
          managed: managed({ remote: false, ownerEnvironmentId: chat }),
        },
        chat,
      ),
    ).toEqual({ environmentId: chat, threadId: "chat-thread", tabId: "tab", viaOwner: false });
  });

  it("leaves an ordinary preview tab exactly where it was", () => {
    expect(managedStreamTarget({ threadId: "chat-thread", tabId: "tab" }, chat)).toEqual({
      environmentId: chat,
      threadId: "chat-thread",
      tabId: "tab",
      viaOwner: false,
    });
  });
});

const control = (overrides: Partial<PreviewStreamControl> = {}): PreviewStreamControl => ({
  canOperate: true,
  controller: "agent",
  generation: 1,
  dialog: null,
  ...overrides,
});

describe("what a person is told about control", () => {
  it("says a connecting viewer is connecting and offers nothing", () => {
    expect(describeManagedControl(null, 0)).toMatchObject({ label: "Connecting...", action: null });
  });

  it("offers a read-only viewer nothing to take, and says why", () => {
    const view = describeManagedControl(control({ canOperate: false }), 0);
    expect(view.action).toBeNull();
    expect(view.label).toBe("Read-only");
    expect(view.detail).toMatch(/watch/i);
  });

  it("offers to take control from an agent or an idle browser, and to release it once held", () => {
    expect(describeManagedControl(control({ controller: "agent" }), 0)).toMatchObject({
      action: "take",
      actionLabel: "Stop agents",
    });
    expect(describeManagedControl(control({ controller: "unclaimed" }), 0).action).toBe("take");
    expect(describeManagedControl(control({ controller: "you" }), 0)).toMatchObject({
      action: "release",
      actionLabel: "Let agents continue",
    });
  });

  it("offers nothing while someone else drives, and names a reconnect hold with its seconds left", () => {
    expect(describeManagedControl(control({ controller: "another-viewer" }), 0).action).toBeNull();
    const view = describeManagedControl(
      control({ controller: "another-viewer", holdExpiresAtMs: 25_000 }),
      10_000,
    );
    expect(view.action).toBeNull();
    expect(view.detail).toContain("15 seconds");
  });

  it("lets a person resume control held for them, and says how long it is held", () => {
    const view = describeManagedControl(
      control({ controller: "held-for-you", holdExpiresAtMs: 30_000 }),
      1_000,
    );
    expect(view).toMatchObject({ action: "resume", actionLabel: "Resume control" });
    expect(view.detail).toContain("29 seconds");
  });

  it("never shows a negative or fractional countdown", () => {
    expect(
      describeManagedControl(control({ controller: "held-for-you", holdExpiresAtMs: 1_000 }), 5_000)
        .detail,
    ).toMatch(/moments|now/i);
    expect(
      describeManagedControl(control({ controller: "held-for-you", holdExpiresAtMs: 1_500 }), 0)
        .detail,
    ).toContain("2 seconds");
  });

  it("calls a browser nobody may use paused, and offers an explicit take", () => {
    const view = describeManagedControl(control({ controller: "paused" }), 0);
    expect(view.label).toBe("Paused");
    expect(view.action).toBe("take");
    expect(view.detail).toMatch(/nobody|no one/i);
  });
});

const overview = (overrides: Partial<ManagedBrowserOverview> = {}): ManagedBrowserOverview => ({
  ownerEnvironmentId: owner,
  hosting: { available: true, reason: null },
  fullWindow: { available: false, reason: "Full window view is turned off." },
  profiles: [
    { instanceId: "instance-1" as never, profileId: "work" as never, tabs: 1 },
    { instanceId: "instance-2" as never, profileId: "personal" as never, tabs: 0 },
  ],
  tabs: [],
  ...overrides,
});

describe("which profile stays selected", () => {
  const work = { ownerEnvironmentId: owner, instanceId: "instance-1", profileId: "work" };

  it("keeps the person's choice while it still exists", () => {
    expect(resolveProfileSelection(work, overview())).toEqual(work);
  });

  it("falls back to the first profile when the chosen one is gone, and to nothing when there are none", () => {
    expect(resolveProfileSelection({ ...work, profileId: "deleted" }, overview())).toEqual({
      ownerEnvironmentId: owner,
      instanceId: "instance-1",
      profileId: "work",
    });
    expect(resolveProfileSelection(work, overview({ profiles: [] }))).toBeNull();
  });

  it("drops a choice made for a different owner", () => {
    expect(resolveProfileSelection({ ...work, ownerEnvironmentId: chat }, overview())).toEqual({
      ownerEnvironmentId: owner,
      instanceId: "instance-1",
      profileId: "work",
    });
  });
});

describe("naming a new profile", () => {
  it("makes a stable binding from a plain name", () => {
    expect(newProfileBinding("Work Account")).toEqual({
      instanceId: "instance-work-account",
      profileId: "work-account",
    });
  });

  it("refuses a name that cannot be a profile", () => {
    expect(newProfileBinding("")).toBeNull();
    expect(newProfileBinding("   ")).toBeNull();
    expect(newProfileBinding("../etc")).toEqual({
      instanceId: "instance-etc",
      profileId: "etc",
    });
    expect(newProfileBinding("***")).toBeNull();
    expect(newProfileBinding("x".repeat(80))?.profileId.length).toBeLessThanOrEqual(48);
  });
});

describe("what a person is told about hosting", () => {
  it("explains why a computer cannot run the shared browser without implementation words", () => {
    for (const reason of [
      "notConfigured",
      "unprovisioned",
      "unsupportedHost",
      "recoveryRequired",
      "somethingNew",
    ]) {
      const text = describeHosting({ available: false, reason });
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/incarnation|supervisor|IPC|engine|CDP|lease|fence|generation/i);
    }
    expect(describeHosting({ available: true, reason: null })).toBeNull();
  });

  it("keeps remote ownership available when this computer cannot host", () => {
    expect(describeHosting({ available: false, reason: "unprovisioned" })).toMatch(
      /another computer/i,
    );
  });
});

const status = (
  overrides: Partial<ManagedBrowserUpdateStatus> = {},
): ManagedBrowserUpdateStatus => ({
  hosting: { available: true, reason: null },
  provisioning: { signingKey: true, baseline: true, releaseSource: true },
  current: "2.0.0",
  previous: "1.9.0",
  staged: null,
  policy: { paused: false, pinnedVersion: null },
  quarantined: [],
  lastCheck: { at: 1, outcome: "upToDate" },
  waiting: null,
  applying: false,
  recovery: null,
  ...overrides,
});

describe("what a person is told about updates", () => {
  it("says an unprovisioned build has nothing to update from, and offers no action that cannot work", () => {
    const view = describeUpdate(
      status({
        current: null,
        previous: null,
        provisioning: { signingKey: false, baseline: false, releaseSource: false },
        hosting: { available: false, reason: "unprovisioned" },
        lastCheck: { at: 1, outcome: "unprovisioned" },
      }),
    );
    expect(view.headline).toMatch(/not set up/i);
    expect(view.actions).toEqual({
      check: false,
      pause: false,
      resume: false,
      pin: false,
      unpin: false,
      rollback: false,
      recover: false,
    });
  });

  it("explains that a waiting update is waiting for the browser to be free, and for what", () => {
    const view = describeUpdate(
      status({ staged: "2.1.0", waiting: { reasons: ["viewers", "dialogs", "mystery"] } }),
    );
    expect(view.headline).toContain("2.1.0");
    expect(view.lines.join(" ")).toMatch(/someone is watching/);
    expect(view.lines.join(" ")).toMatch(/dialog/);
    // A reason it does not know is still not a raw token.
    expect(view.lines.join(" ")).not.toContain("mystery");
    expect(view.actions.check).toBe(true);
  });

  it("offers recovery, and only recovery-relevant actions, after a failed switch", () => {
    const view = describeUpdate(
      status({
        hosting: { available: false, reason: "recoveryRequired" },
        recovery: { failed: "2.1.0", detail: "smoke failed", status: "retryable" },
      }),
    );
    expect(view.headline).toMatch(/recover/i);
    expect(view.lines.join(" ")).toContain("smoke failed");
    expect(view.actions.recover).toBe(true);
    expect(view.actions.rollback).toBe(false);
  });

  it("says a restart is needed, and offers no recovery or other action, while a browser's exit is unproven", () => {
    const view = describeUpdate(
      status({
        hosting: { available: false, reason: "recoveryRequired" },
        recovery: {
          failed: "2.1.0",
          detail: "stop failed; exit not proven",
          status: "restartRequired",
        },
      }),
    );
    expect(view.headline).toMatch(/restart/i);
    const text = view.lines.join(" ");
    expect(text).toContain("exit not proven");
    expect(text).toMatch(/restart t3/i);
    // Restarting is not promised to end the old browser.
    expect(text).toMatch(/does not end it by itself/i);
    expect(view.actions).toEqual({
      check: false,
      pause: false,
      resume: false,
      pin: false,
      unpin: false,
      rollback: false,
      recover: false,
    });
    expect(UPDATE_ACTIONS.filter((entry) => view.actions[entry.enabled])).toEqual([]);
  });

  it("offers pin and rollback only when they mean something", () => {
    const plain = describeUpdate(status());
    expect(plain.actions).toMatchObject({
      pin: true,
      unpin: false,
      pause: true,
      resume: false,
      rollback: true,
    });
    const pinned = describeUpdate(
      status({ policy: { paused: true, pinnedVersion: "2.0.0" }, previous: null }),
    );
    expect(pinned.actions).toMatchObject({
      pin: false,
      unpin: true,
      pause: false,
      resume: true,
      rollback: false,
    });
  });

  it("disables everything while an update is being applied", () => {
    const view = describeUpdate(status({ applying: true }));
    expect(view.headline).toMatch(/updating/i);
    expect(Object.values(view.actions).every((enabled) => !enabled)).toBe(true);
  });

  it("names what a failed check means in words", () => {
    expect(
      describeUpdate(status({ lastCheck: { at: 1, outcome: "offline" } })).lines.join(" "),
    ).toMatch(/could not be reached/i);
    expect(
      describeUpdate(status({ lastCheck: { at: 1, outcome: "unauthorized" } })).lines.join(" "),
    ).toMatch(/refused|access/i);
  });
});

describe("which computer's shared browser is shown", () => {
  const computer = (id: string, phase: string) => ({
    environmentId: id as EnvironmentId,
    label: id,
    connection: { phase },
  });
  const mac = computer("mac", "connected");
  const server = computer("server", "connected");
  const offline = computer("server", "connecting");

  it("shows the first connected computer until the person chooses one", () => {
    expect(resolveOwner([mac, server], null)).toEqual({ owner: mac, message: null });
    expect(resolveOwner([mac, server], "server" as EnvironmentId)).toEqual({
      owner: server,
      message: null,
    });
  });

  it("says the chosen computer is not connected instead of showing another one's browser", () => {
    const choice = resolveOwner([mac, offline], "server" as EnvironmentId);
    expect(choice.owner).toBeNull();
    expect(choice.message).toMatch(/server isn't connected/);
  });

  it("says so when no computer is connected at all", () => {
    const choice = resolveOwner([computer("mac", "disconnected")], null);
    expect(choice.owner).toBeNull();
    expect(choice.message).toMatch(/No computer is connected/);
  });
});

describe("what a person reads about access and updates", () => {
  const grant = (subject: unknown, label?: string) =>
    ({ subject, ...(label === undefined ? {} : { label }) }) as never;

  it("names an agent's computer from the connections held, and a device by its label", () => {
    const known = [{ environmentId: "env-a" as EnvironmentId, label: "Work server" }];
    expect(describeGrantHolder(grant({ kind: "agent", callerEnvironmentId: "env-a" }), known)).toBe(
      "An agent on Work server",
    );
    expect(describeGrantHolder(grant({ kind: "agent", callerEnvironmentId: "env-z" }), known)).toBe(
      "An agent on another computer",
    );
    expect(describeGrantHolder(grant({ kind: "viewer" }, "Phone"), known)).toBe("Phone");
  });

  it("says what a switch did in words", () => {
    expect(describeActivation({ result: "activated", version: "2.1.0" })).toBe(
      "Now on version 2.1.0.",
    );
    expect(describeActivation({ result: "deferred", reasons: ["viewers"] })).toMatch(/in use/);
  });

  it("does not tell a person to retry a recovery that failed to restore the previous version", () => {
    expect(describeActivation({ result: "recoveryFailed", version: "2.1.0" })).not.toMatch(
      /try again|use recover/i,
    );
  });
});

describe("who holds a listed tab, without a stream", () => {
  it("offers Release to the holder and says what the hold does not stop", () => {
    const view = describeTabControl({ phase: "human", heldByYou: true }, true);
    expect(view).toMatchObject({
      label: "You stopped agents",
      action: "release",
      actionLabel: "Let agents continue",
    });
    expect(view.detail).toMatch(/Agents cannot change this browser/);
    // No claim that the browser's own window is locked.
    expect(view.detail).toMatch(/still reaches it/);
  });

  it("offers Take only where agents or nobody hold it", () => {
    expect(describeTabControl({ phase: "agent" }, true)).toMatchObject({ action: "take" });
    expect(describeTabControl({ phase: "paused" }, true)).toMatchObject({ action: "take" });
    for (const phase of ["reconnectHold", "transferring", "unavailable"] as const) {
      expect(describeTabControl({ phase }, true).action).toBeNull();
    }
    // Another person's hold is theirs to release, whatever this session may do.
    expect(describeTabControl({ phase: "human", heldByYou: false }, true)).toMatchObject({
      label: "Another person has control",
      action: null,
    });
    // An owner that predates the flag never claims the hold is ours.
    expect(describeTabControl({ phase: "human" }, true).action).toBeNull();
  });

  it("offers nothing to a session that may only watch", () => {
    expect(describeTabControl({ phase: "agent" }, false).action).toBeNull();
    expect(describeTabControl({ phase: "human", heldByYou: true }, false).action).toBeNull();
  });
});

describe("whether the owner's browser can be used as a window on this computer", () => {
  const native = { native: { available: true } };
  it("needs the desktop app, its own server, and an owner that says it opens on its own screen", () => {
    expect(
      canUseOnThisComputer({ overview: native, isDesktopApp: true, isOwnLocalServer: true }),
    ).toBe(true);
    // A phone or web page watching a Mac's browser keeps streaming.
    expect(
      canUseOnThisComputer({ overview: native, isDesktopApp: false, isOwnLocalServer: true }),
    ).toBe(false);
    // The desktop app looking at another computer's server is not that computer's screen.
    expect(
      canUseOnThisComputer({ overview: native, isDesktopApp: true, isOwnLocalServer: false }),
    ).toBe(false);
    expect(
      canUseOnThisComputer({
        overview: { native: { available: false, reason: "no" } },
        isDesktopApp: true,
        isOwnLocalServer: true,
      }),
    ).toBe(false);
    // An older owner has no flag at all.
    expect(canUseOnThisComputer({ overview: {}, isDesktopApp: true, isOwnLocalServer: true })).toBe(
      false,
    );
  });
});
