// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import * as ManagedBrowserRegistry from "./ManagedBrowserRegistry.ts";
import { locatorMatches, parseLocator } from "./ManagedBrowserLocator.ts";

const instance = {
  ownerEnvironmentId: "env-owner",
  instanceId: "instance-1",
  profileId: "profile-1",
};

const tab = (engineTabId: string, extra: Partial<ManagedBrowserRegistry.RegisteredTab> = {}) => ({
  ...instance,
  threadId: "thread-1",
  engineTabId,
  openerEngineTabId: null,
  callerEnvironmentId: "env-owner",
  agentSessionId: "session-1",
  url: "https://example.com/",
  title: "Example",
  closePending: false,
  shared: false,
  updatedAt: "2026-10-16T00:00:00.000Z",
  ...extra,
});

const scratch = () => FS.mkdtempSync(Path.join(OS.tmpdir(), "managed-registry-"));

describe("the durable tab registry", () => {
  it("is written atomically, restricted to its owner, and read back by a new instance", () => {
    const root = scratch();
    try {
      const file = Path.join(root, "adapter", "registry.json");
      const first = ManagedBrowserRegistry.make(file);
      assert.isNull(first.bindInstance(instance));
      first.upsertTab(tab("tab-a"));
      first.upsertTab(tab("tab-b", { openerEngineTabId: "tab-a", closePending: true }));
      assert.equal(FS.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(
        FS.readdirSync(Path.dirname(file)),
        ["registry.json"],
        "no temporary file is left behind",
      );

      const second = ManagedBrowserRegistry.make(file);
      assert.equal(second.status._tag, "ready");
      assert.deepEqual(second.instances(), [instance]);
      assert.deepEqual(
        second.tabs().map((record) => [record.engineTabId, record.closePending]),
        [
          ["tab-a", false],
          ["tab-b", true],
        ],
      );
      second.removeTab(instance.instanceId, "tab-a");
      assert.deepEqual(
        ManagedBrowserRegistry.make(file)
          .tabs()
          .map((record) => record.engineTabId),
        ["tab-b"],
      );
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("remembers the instance-to-profile binding and refuses to change either side of it", () => {
    const registry = ManagedBrowserRegistry.make(null);
    assert.isNull(registry.bindInstance(instance));
    assert.isNull(registry.bindInstance(instance), "binding again is idempotent");
    assert.deepEqual(registry.bindInstance({ ...instance, profileId: "profile-2" }), {
      _tag: "instanceUsesOtherProfile",
      profileId: "profile-1",
    });
    assert.deepEqual(registry.bindInstance({ ...instance, instanceId: "instance-2" }), {
      _tag: "profileUsedByOtherInstance",
      instanceId: "instance-1",
    });
    assert.deepEqual(registry.bindInstance({ ...instance, ownerEnvironmentId: "env-other" }), {
      _tag: "instanceOwnedByOtherEnvironment",
      ownerEnvironmentId: "env-owner",
    });
    assert.equal(registry.instances().length, 1);
  });

  it("returns only a thread's own tabs for its own instance and profile", () => {
    const registry = ManagedBrowserRegistry.make(null);
    registry.upsertTab(tab("mine"));
    registry.upsertTab(tab("theirs", { threadId: "thread-2" }));
    registry.upsertTab(tab("elsewhere", { instanceId: "instance-2", profileId: "profile-2" }));
    assert.deepEqual(
      registry.tabsOf("thread-1", instance).map((record) => record.engineTabId),
      ["mine"],
    );
  });

  it("keeps one record per thread for a shared tab, and removes a thread's hold without the others'", () => {
    const root = scratch();
    try {
      const file = Path.join(root, "registry.json");
      const first = ManagedBrowserRegistry.make(file);
      first.upsertTab(tab("tab-s", { shared: true }));
      first.upsertTab(tab("tab-s", { threadId: "thread-2", shared: true }));
      assert.equal(first.tabs().length, 2);
      assert.sameMembers(
        first.participantsOf(instance.instanceId, "tab-s").map((record) => record.threadId),
        ["thread-1", "thread-2"],
      );
      const second = ManagedBrowserRegistry.make(file);
      assert.equal(second.participantsOf(instance.instanceId, "tab-s").length, 2);
      second.removeTab(instance.instanceId, "tab-s", "thread-1");
      assert.deepEqual(
        second.participantsOf(instance.instanceId, "tab-s").map((record) => record.threadId),
        ["thread-2"],
      );
      // Without a thread the page's every record goes: the page itself was closed.
      second.removeTab(instance.instanceId, "tab-s");
      assert.equal(second.tabs().length, 0);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a record written before sharing existed as not shared", () => {
    const root = scratch();
    try {
      const file = Path.join(root, "registry.json");
      const { shared: _shared, ...legacy } = tab("tab-old");
      FS.writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, instances: [instance], tabs: [legacy] }),
      );
      const registry = ManagedBrowserRegistry.make(file);
      assert.equal(registry.status._tag, "ready");
      assert.isFalse(registry.tabs()[0]!.shared);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a file it cannot read, instead of restarting empty beside live tabs", () => {
    const root = scratch();
    try {
      const file = Path.join(root, "registry.json");
      for (const content of [
        "{ not json",
        JSON.stringify({ schemaVersion: 99, instances: [], tabs: [] }),
        JSON.stringify({ schemaVersion: 1, instances: [], tabs: [{ engineTabId: 5 }] }),
      ]) {
        FS.writeFileSync(file, content);
        const registry = ManagedBrowserRegistry.make(file);
        assert.equal(registry.status._tag, "unreadable", content);
        assert.equal(registry.tabs().length, 0);
        // And it never overwrites what it could not read.
        registry.upsertTab(tab("tab-x"));
        assert.equal(FS.readFileSync(file, "utf8"), content);
      }
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not report a write as made when it could not be saved", () => {
    const root = scratch();
    try {
      // The registry's directory is a file, so nothing can be written there.
      const blocker = Path.join(root, "adapter");
      FS.writeFileSync(blocker, "not a directory");
      const registry = ManagedBrowserRegistry.make(Path.join(blocker, "registry.json"));
      assert.throws(() => registry.upsertTab(tab("tab-a")));
      assert.equal(registry.tabs().length, 0);
      assert.throws(() => registry.bindInstance(instance));
      assert.equal(registry.instances().length, 0);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("locators a snapshot ref can express", () => {
  it("reads refs, role locators and text locators, and says what it does not understand", () => {
    assert.deepEqual(parseLocator("aria-ref=e12"), { _tag: "ref", ref: "e12" });
    assert.deepEqual(parseLocator("role=button[name='Send']"), {
      _tag: "role",
      role: "button",
      name: { value: "Send", exact: false, caseSensitive: false },
    });
    assert.deepEqual(parseLocator('role=textbox[name="Full name" s]'), {
      _tag: "role",
      role: "textbox",
      name: { value: "Full name", exact: true, caseSensitive: true },
    });
    assert.deepEqual(parseLocator("role=link"), { _tag: "role", role: "link", name: undefined });
    assert.deepEqual(parseLocator("text=Sign in"), {
      _tag: "text",
      name: { value: "Sign in", exact: false, caseSensitive: false },
    });
    assert.deepEqual(parseLocator('text="Sign in"'), {
      _tag: "text",
      name: { value: "Sign in", exact: true, caseSensitive: false },
    });
    for (const unsupported of [
      "button.primary",
      "css=button",
      "xpath=//button",
      "text=/sign/i",
      "role=button[pressed=true]",
      "role=",
      "text=",
      "role=button[name='open",
    ]) {
      assert.equal(parseLocator(unsupported)._tag, "unsupported", unsupported);
    }
  });

  it("matches by role and by name the way the page's accessibility tree names things", () => {
    const send = { role: "button", name: "Send message" };
    const role = (name?: string) => {
      const parsed = parseLocator(
        name === undefined ? "role=button" : `role=button[name='${name}']`,
      );
      assert.equal(parsed._tag, "role");
      return parsed as Extract<ReturnType<typeof parseLocator>, { _tag: "role" }>;
    };
    assert.isTrue(locatorMatches(role(), send));
    assert.isTrue(
      locatorMatches(role("send"), send),
      "a name is a case-insensitive part by default",
    );
    assert.isFalse(locatorMatches(role("Cancel"), send));
    assert.isFalse(locatorMatches({ ...role(), role: "link" }, send));
    const exact = parseLocator('role=button[name="Send message" s]') as Extract<
      ReturnType<typeof parseLocator>,
      { _tag: "role" }
    >;
    assert.isTrue(locatorMatches(exact, send));
    assert.isFalse(locatorMatches(exact, { role: "button", name: "send message" }));
    const text = parseLocator('text="send MESSAGE"') as Extract<
      ReturnType<typeof parseLocator>,
      { _tag: "text" }
    >;
    assert.isTrue(locatorMatches(text, send));
    assert.isFalse(locatorMatches(text, { role: "button" }), "an unnamed element matches no name");
  });
});
