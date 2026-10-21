import { EnvironmentId, PreviewManagedSession, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { isCurrentPreviewRuntimeTab, previewRuntimeTabId } from "./previewRuntimeTabId";

describe("previewRuntimeTabId", () => {
  it("reuses one native guest across participants without sharing ordinary or other-profile guests", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("one") };
    const managed = Schema.decodeUnknownSync(PreviewManagedSession)({
      ownerEnvironmentId: "env",
      instanceId: "instance",
      profileId: "profile",
      incarnation: "boot",
      engineTabId: "page",
      hostThreadId: "one",
      hostTabId: "tab-one",
      native: true,
      shared: true,
      remote: false,
    });
    const identity = previewRuntimeTabId(ref, "epoch", "tab-one", managed);
    expect(
      previewRuntimeTabId({ ...ref, threadId: ThreadId.make("two") }, "epoch", "tab-two", {
        ...managed,
        hostThreadId: "two",
      }),
    ).toBe(identity);
    expect(previewRuntimeTabId(ref, "epoch", "tab-one")).not.toBe(identity);
    expect(previewRuntimeTabId(ref, "epoch", "tab-one", { ...managed, native: false })).not.toBe(
      identity,
    );
    const otherProfile = Schema.decodeUnknownSync(PreviewManagedSession)({
      ...managed,
      profileId: "other",
    });
    expect(previewRuntimeTabId(ref, "epoch", "tab-one", otherProfile)).not.toBe(identity);
  });

  it("scopes process-local tab ids to their environment, thread, and server epoch", () => {
    const base = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };

    expect(previewRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      previewRuntimeTabId(
        { ...base, environmentId: EnvironmentId.make("environment-b") },
        "epoch-a",
        "tab_1",
      ),
    );
    expect(previewRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      previewRuntimeTabId({ ...base, threadId: ThreadId.make("thread-b") }, "epoch-a", "tab_1"),
    );
    expect(previewRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      previewRuntimeTabId(base, "epoch-b", "tab_1"),
    );
  });

  it("is stable for the same runtime tab", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    expect(previewRuntimeTabId(ref, null, "tab_1")).toBe(previewRuntimeTabId(ref, null, "tab_1"));
  });

  it("rejects a pinned operation target after the server epoch changes", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    const runtimeTabId = previewRuntimeTabId(ref, "epoch-a", "tab_1");

    expect(isCurrentPreviewRuntimeTab(ref, "epoch-a", "tab_1", runtimeTabId)).toBe(true);
    expect(isCurrentPreviewRuntimeTab(ref, "epoch-b", "tab_1", runtimeTabId)).toBe(false);
  });
});
