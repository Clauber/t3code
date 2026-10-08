import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mint }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  }),
}));
// Asset images render through the environment's file access; these tests only
// exercise the hide gate around them, so deny reads and skip the asset atoms.
vi.mock("../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: false, isPending: false }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { chatImageHideKey, useHiddenChatImagesStore } from "./chat/hiddenChatImages";

const mediaEnvironmentId = EnvironmentId.make("media-environment");
const mediaThreadRef = {
  environmentId: mediaEnvironmentId,
  threadId: ThreadId.make("media-thread"),
};

function hiddenImageChip(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ "data-hidden-chat-image": "" });
}

async function renderChatMarkdown(text: string) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ChatMarkdown cwd="/repo" threadRef={mediaThreadRef} text={text} />);
  });
  return renderer!;
}

it("replaces a hidden chat image with a chip, and every re-embed stays hidden until shown", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/dash.png", expiresAt: 1 }),
  );
  const text = `![Dashboard](https://cdn.test/dash.png)\n\n![Dashboard copy](https://cdn.test/dash.png)`;
  const key = chatImageHideKey(mediaEnvironmentId, "https://cdn.test/dash.png");
  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await renderChatMarkdown(text);
    expect(renderer.root.findAllByProps({ "data-hidden-chat-image": "" })).toHaveLength(0);

    await act(async () => {
      useHiddenChatImagesStore.getState().hideChatImage(key);
    });
    // Both embeds of the same source are gone — hiding is by identity, so a
    // re-embed in a later reply stays hidden too.
    expect(renderer.root.findAllByProps({ "data-hidden-chat-image": "" })).toHaveLength(2);
    expect(renderer.root.findAllByType("img")).toHaveLength(0);

    await act(async () => {
      useHiddenChatImagesStore.getState().showChatImage(key);
    });
    expect(renderer.root.findAllByProps({ "data-hidden-chat-image": "" })).toHaveLength(0);
  } finally {
    await act(async () => renderer?.unmount());
    useHiddenChatImagesStore.getState().showChatImage(key);
    vi.unstubAllGlobals();
  }
});

it("the chip's Show control reveals the image without following a surrounding link", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/dash.png", expiresAt: 1 }),
  );
  const key = chatImageHideKey(mediaEnvironmentId, "https://cdn.test/dash.png");
  let renderer: ReactTestRenderer | undefined;
  try {
    useHiddenChatImagesStore.getState().hideChatImage(key);
    renderer = await renderChatMarkdown(
      "[![Dashboard](https://cdn.test/dash.png)](https://t3.test)",
    );
    const chip = hiddenImageChip(renderer);
    const show = chip.findByType("button");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      show.props.onClick({ preventDefault, stopPropagation });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ "data-hidden-chat-image": "" })).toHaveLength(0);
  } finally {
    await act(async () => renderer?.unmount());
    useHiddenChatImagesStore.getState().showChatImage(key);
    vi.unstubAllGlobals();
  }
});

it("opens host media through server authorization before the client grant loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd="/repo"
          threadRef={threadRef}
          text="[Open image](/tmp/image.png)"
          onImageExpand={onImageExpand}
        />,
      );
    });
    await act(async () => {
      const link = renderer!.root
        .findAllByType("a")
        .find((node) => node.props.href === "/tmp/image.png");
      expect(link).toBeDefined();
      link!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    );
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
