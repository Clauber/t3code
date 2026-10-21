import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  query: vi.fn(),
  get: vi.fn(),
  supports: vi.fn(),
}));
vi.mock("~/state/entities", () => ({ readEnvironmentSupportsManagedBrowserPanel: state.supports }));
vi.mock("~/previewStateStore", () => ({ readThreadPreviewState: () => ({ snapshot: null }) }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: state.get } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: "primary" }));
vi.mock("~/state/managedBrowser", () => ({
  managedBrowserEnvironment: { overview: () => "overview", openTab: "open" },
}));
vi.mock("@t3tools/client-runtime/state/managed-browser", () => ({
  selectedManagedProfileAtom: "selected",
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: state.query,
  runAtomCommand: state.open,
}));
import { openManagedThreadBrowser } from "./openManagedThreadBrowser";
const threadRef = {
  environmentId: EnvironmentId.make("harness"),
  threadId: ThreadId.make("draft-id"),
};
beforeEach(() => {
  vi.clearAllMocks();
  state.supports.mockReturnValue(true);
  state.get.mockImplementation((atom) => (atom === "primary" ? "mac" : null));
  state.query.mockResolvedValue(
    AsyncResult.success({
      hosting: { available: true },
      native: { available: true },
      profiles: [],
    }),
  );
  state.open.mockResolvedValue(
    AsyncResult.success({
      tab: {
        instanceId: "instance-default",
        profileId: "default",
        engineTabId: "engine-tab",
        incarnation: "boot",
        hostThreadId: "human-draft",
        hostTabId: "host-tab",
        shared: true,
      },
    }),
  );
});
describe("normal desktop managed browser open", () => {
  it("requires the chat host attachment capability before opening any page", async () => {
    state.supports.mockReturnValue(false);
    await expect(openManagedThreadBrowser({ threadRef })).rejects.toThrow("Update the chat host");
    expect(state.open).not.toHaveBeenCalled();
  });
  it("opens the Mac page for agents to use before a provider session exists", async () => {
    const result = await openManagedThreadBrowser({ threadRef });
    expect(state.open.mock.calls[0]?.[2]).toEqual({
      environmentId: "mac",
      input: {
        thread: threadRef,
        instanceId: "instance-default",
        profileId: "default",
        shared: true,
      },
    });
    expect(result).toMatchObject({
      ownerEnvironmentId: "mac",
      engineTabId: "engine-tab",
      native: true,
      remote: true,
    });
    expect(state.open.mock.calls[0]?.[2].input).not.toHaveProperty("agentSessionId");
  });
  it("refuses unavailable native hosting without opening an ordinary browser", async () => {
    state.query.mockResolvedValue(
      AsyncResult.success({ hosting: { available: false }, profiles: [] }),
    );
    await expect(openManagedThreadBrowser({ threadRef })).rejects.toThrow(
      "managed browser is unavailable",
    );
    expect(state.open).not.toHaveBeenCalled();
  });
  it("preserves the owner's access refusal", async () => {
    state.open.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("No access to this profile"))),
    );
    await expect(openManagedThreadBrowser({ threadRef })).rejects.toThrow(
      "No access to this profile",
    );
  });
});
