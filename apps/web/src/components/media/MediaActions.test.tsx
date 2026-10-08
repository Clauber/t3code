import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { createElement, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  sessions: new Map<string, Pick<AuthSessionState, "authenticated" | "scopes">>(),
  mint: vi.fn(),
  download: vi.fn(),
  png: vi.fn(),
  showMenu: vi.fn(),
  openFile: vi.fn(),
  clipboard: vi.fn(),
  menuFinished: null as (() => void) | null,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A,>(callback: A) => callback,
  useRef: <A,>(current: A) => ({ current }),
  useState: <A,>(initial: A) => [initial, () => {}],
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: state.showMenu } }),
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: (environmentId: string) => environmentId },
  readPreparedConnection: () => ({ httpBaseUrl: "https://host.test" }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (environmentId: string) => ({
    data: state.sessions.get(environmentId) ?? null,
    error: null,
  }),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (environmentId: string) => {
      const session = state.sessions.get(environmentId);
      return session === undefined ? AsyncResult.initial() : AsyncResult.success(session);
    },
  },
}));
vi.mock("./mediaContent", () => ({ downloadMedia: state.download, readMediaPng: state.png }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "Tooltip",
  TooltipTrigger: "TooltipTrigger",
  TooltipPopup: "TooltipPopup",
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: <A,>(toast: A) => toast,
  toastManager: {
    add: (toast: { type: string }) => {
      if (toast.type !== "loading") state.menuFinished?.();
      return "toast";
    },
    update: () => state.menuFinished?.(),
  },
}));

import { MediaActions, type MediaActionSource } from "./MediaActions";

const environmentId = EnvironmentId.make("media-environment");
const denied: Pick<AuthSessionState, "authenticated" | "scopes"> = {
  authenticated: true,
  scopes: [],
};

function openMenu(source: MediaActionSource) {
  const find = (node: ReactNode): ((event: unknown) => void) | undefined => {
    if (Array.isArray(node)) return node.map(find).find((handler) => handler !== undefined);
    if (!isValidElement<{ children?: ReactNode; onContextMenu?: (event: unknown) => void }>(node))
      return undefined;
    return node.props.onContextMenu ?? find(node.props.children);
  };
  const handler = find(MediaActions({ source, children: createElement("img") }));
  if (!handler) throw new Error("Media menu handler missing");
  handler({
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) },
    clientX: 1,
    clientY: 1,
  });
}

beforeEach(() => {
  state.sessions.clear();
  state.sessions.set(environmentId, denied);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
  state.download.mockReset().mockResolvedValue(undefined);
  state.png.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  state.showMenu.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.menuFinished = null;
  class TestClipboardItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  state.clipboard.mockReset().mockImplementation(async (items: TestClipboardItem[]) => {
    await Promise.all(items.flatMap((item) => Object.values(item.items)));
  });
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  vi.stubGlobal("navigator", { clipboard: { write: state.clipboard } });
});

afterEach(() => vi.unstubAllGlobals());

it("keeps nonhost menu actions available with pending or denied host grants", () => {
  const sources: MediaActionSource[] = [
    { kind: "image", name: "image.png", src: "https://cdn.test/image.png" },
    { kind: "image", name: "image.png", src: "blob:local-image" },
    {
      kind: "image",
      name: "image.png",
      src: null,
      asset: { environmentId, resource: { _tag: "attachment", attachmentId: "upload" } },
    },
  ];
  for (const session of [null, denied]) {
    if (session === null) state.sessions.delete(environmentId);
    else state.sessions.set(environmentId, session);
    for (const source of sources) {
      openMenu(source);
      expect(state.showMenu.mock.lastCall![0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "save", disabled: false }),
          expect.objectContaining({ id: "copy-image", disabled: false }),
        ]),
      );
    }
  }
});

it("offers hide image only when the source can hide it", () => {
  openMenu({ kind: "image", name: "image.png", src: "https://cdn.test/image.png" });
  expect(state.showMenu.mock.lastCall![0]).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "hide-image" })]),
  );

  const onHide = vi.fn();
  openMenu({ kind: "image", name: "image.png", src: "https://cdn.test/image.png", onHide });
  expect(state.showMenu.mock.lastCall![0]).toContainEqual({
    id: "hide-image",
    label: "Hide image",
  });
});

it("invokes the source's hide callback when hide image is selected", async () => {
  const onHide = vi.fn();
  const choice = deferred<string>();
  state.showMenu.mockReturnValue(choice.promise);
  openMenu({ kind: "image", name: "image.png", src: "https://cdn.test/image.png", onHide });

  choice.resolve("hide-image");
  await Promise.resolve();
  await Promise.resolve();

  expect(onHide).toHaveBeenCalledOnce();
  expect(state.download).not.toHaveBeenCalled();
});
