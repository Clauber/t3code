import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import {
  chatImageHideKey,
  MAX_HIDDEN_CHAT_IMAGES,
  readHiddenChatImagesStorageForTest,
  useHiddenChatImagesStore,
  writeHiddenChatImagesStorageForTest,
} from "./hiddenChatImages";

function resetStore() {
  writeHiddenChatImagesStorageForTest("");
}

beforeEach(resetStore);
afterEach(resetStore);

it("persists a hide and rehydrates it as still hidden", () => {
  const key = chatImageHideKey("env-1", "/repo/.t3/shots/dash.png");
  useHiddenChatImagesStore.getState().hideChatImage(key);
  expect(useHiddenChatImagesStore.getState().hiddenKeys.has(key)).toBe(true);

  const persisted = JSON.parse(readHiddenChatImagesStorageForTest() ?? "null") as {
    entries: { key: string }[];
  };
  expect(persisted.entries).toEqual([expect.objectContaining({ key })]);

  // A reload rebuilds state from the persisted payload; the hide survives.
  writeHiddenChatImagesStorageForTest(readHiddenChatImagesStorageForTest()!);
  expect(useHiddenChatImagesStore.getState().hiddenKeys.has(key)).toBe(true);
});

it("showing removes the hide and its persisted entry", () => {
  const key = chatImageHideKey("env-1", "/repo/.t3/shots/dash.png");
  useHiddenChatImagesStore.getState().hideChatImage(key);
  useHiddenChatImagesStore.getState().showChatImage(key);
  expect(useHiddenChatImagesStore.getState().hiddenKeys.has(key)).toBe(false);
  expect(useHiddenChatImagesStore.getState().entries).toHaveLength(0);
  expect(JSON.parse(readHiddenChatImagesStorageForTest()!).entries).toEqual([]);
});

it("scopes the key by environment so the same path elsewhere is untouched", () => {
  expect(chatImageHideKey("env-1", "/repo/a.png")).not.toBe(
    chatImageHideKey("env-2", "/repo/a.png"),
  );
  expect(chatImageHideKey(null, "https://cdn.test/a.png")).toBe("\u0000https://cdn.test/a.png");
});

it("hiding the same key twice keeps one entry, moved to the front", () => {
  const key = chatImageHideKey("env-1", "/repo/a.png");
  const other = chatImageHideKey("env-1", "/repo/b.png");
  useHiddenChatImagesStore.getState().hideChatImage(other);
  useHiddenChatImagesStore.getState().hideChatImage(key);
  useHiddenChatImagesStore.getState().hideChatImage(key);

  const entries = useHiddenChatImagesStore.getState().entries;
  expect(entries.map((entry) => entry.key)).toEqual([key, other]);
});

it("evicts the oldest hide past the cap", () => {
  const keys = Array.from({ length: MAX_HIDDEN_CHAT_IMAGES + 10 }, (_, index) =>
    chatImageHideKey("env-1", `/repo/img-${index}.png`),
  );
  for (const key of keys) useHiddenChatImagesStore.getState().hideChatImage(key);

  const state = useHiddenChatImagesStore.getState();
  const oldest = keys[0] ?? "";
  const newest = keys[keys.length - 1] ?? "";
  expect(state.entries).toHaveLength(MAX_HIDDEN_CHAT_IMAGES);
  expect(state.hiddenKeys.has(oldest)).toBe(false);
  expect(state.hiddenKeys.has(newest)).toBe(true);
});

it("ignores a corrupted or malformed persisted payload", () => {
  writeHiddenChatImagesStorageForTest("{not json");
  expect(useHiddenChatImagesStore.getState().entries).toHaveLength(0);

  writeHiddenChatImagesStorageForTest(
    JSON.stringify({ version: 1, entries: [{ key: "", hiddenAt: "x" }, { nope: true }] }),
  );
  expect(useHiddenChatImagesStore.getState().entries).toHaveLength(0);
});
