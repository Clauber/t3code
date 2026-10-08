import { create } from "zustand";

import { createMemoryStorage, type StateStorage } from "../../lib/storage";

export const HIDDEN_CHAT_IMAGES_STORAGE_KEY = "t3code:hidden-chat-images:v1";

/**
 * Chat images are hidden by identity, not by message: agents re-embed the same
 * screenshot file across turns (the browser tools tell them to embed
 * `![alt](path)` in their reply), and a hide that only covered one message
 * would let the picture pop back on the very next reply. The key is the
 * environment plus the stable source — the workspace path or the direct URL —
 * so every current and future embed of that source stays hidden until shown.
 */
export function chatImageHideKey(environmentId: string | null | undefined, source: string): string {
  return `${environmentId ?? ""}\u0000${source}`;
}

export interface HiddenChatImageEntry {
  key: string;
  hiddenAt: string;
}

/** Entries are tiny; the cap exists so the bag cannot grow forever, not for size. */
export const MAX_HIDDEN_CHAT_IMAGES = 300;

/**
 * Reading the `localStorage` property itself can throw `SecurityError` when
 * storage is blocked by policy — so the access is guarded at property access,
 * not just at get/set, or importing this module would crash the app at load.
 */
function resolveBaseStorage(): StateStorage {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // Fall through to the in-memory store.
  }
  return createMemoryStorage();
}

const baseStorage = resolveBaseStorage();

interface PersistedHiddenChatImages {
  version: 1;
  entries: ReadonlyArray<HiddenChatImageEntry>;
}

function persistEntries(entries: ReadonlyArray<HiddenChatImageEntry>): void {
  try {
    baseStorage.setItem(
      HIDDEN_CHAT_IMAGES_STORAGE_KEY,
      JSON.stringify({ version: 1, entries } satisfies PersistedHiddenChatImages),
    );
  } catch (error) {
    console.error("[HIDDEN-CHAT-IMAGES] Could not persist hidden images (storage quota?).", error);
  }
}

function decodeEntries(raw: ReturnType<StateStorage["getItem"]>): HiddenChatImageEntry[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries = (parsed as PersistedHiddenChatImages | null)?.entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(
      (entry): entry is HiddenChatImageEntry =>
        typeof entry?.key === "string" &&
        entry.key.length > 0 &&
        typeof entry?.hiddenAt === "string",
    );
  } catch {
    return [];
  }
}

interface HiddenChatImagesStoreState {
  /** Keys of images hidden on this client, newest hides first. */
  hiddenKeys: ReadonlySet<string>;
  entries: ReadonlyArray<HiddenChatImageEntry>;
  hideChatImage: (key: string) => void;
  showChatImage: (key: string) => void;
}

export const useHiddenChatImagesStore = create<HiddenChatImagesStoreState>()((set, get) => ({
  hiddenKeys: new Set<string>(),
  entries: [],
  hideChatImage: (key) => {
    const withoutExisting = get().entries.filter((entry) => entry.key !== key);
    const entries = [{ key, hiddenAt: new Date().toISOString() }, ...withoutExisting].slice(
      0,
      MAX_HIDDEN_CHAT_IMAGES,
    );
    persistEntries(entries);
    set(() => ({ entries, hiddenKeys: new Set(entries.map((entry) => entry.key)) }));
  },
  showChatImage: (key) => {
    const entries = get().entries.filter((entry) => entry.key !== key);
    persistEntries(entries);
    set(() => ({ entries, hiddenKeys: new Set(entries.map((entry) => entry.key)) }));
  },
}));

// Hydrate once at startup. Like the app's other persisted stores, tabs are
// last-write-wins: no cross-tab merging or storage-event syncing.
{
  const entries = decodeEntries(baseStorage.getItem(HIDDEN_CHAT_IMAGES_STORAGE_KEY));
  if (entries.length > 0) {
    useHiddenChatImagesStore.setState({
      entries,
      hiddenKeys: new Set(entries.map((entry) => entry.key)),
    });
  }
}

/**
 * Test seam: seeds the persisted payload through the same storage the store
 * reads and rehydrates, without needing a real `localStorage` global.
 * Pass an empty string to clear.
 */
export function writeHiddenChatImagesStorageForTest(raw: string): void {
  baseStorage.setItem(HIDDEN_CHAT_IMAGES_STORAGE_KEY, raw);
  const entries = decodeEntries(raw);
  useHiddenChatImagesStore.setState({
    entries,
    hiddenKeys: new Set(entries.map((entry) => entry.key)),
  });
}

/** Test seam for the raw persisted payload, so tests assert on storage itself. */
export function readHiddenChatImagesStorageForTest(): string | null {
  const raw = baseStorage.getItem(HIDDEN_CHAT_IMAGES_STORAGE_KEY);
  return typeof raw === "string" ? raw : null;
}
