import { randomUUID } from "~/lib/utils";

const STORAGE_KEY = "t3.preview-stream.viewer-key";
let fallback: string | null = null;

/**
 * Names this browser window to a shared browser across reconnects and reopened viewers, so control held for it
 * while it was away is its to resume. Per window (session storage), so two windows are two viewers.
 */
export function windowViewerKey(): string {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    const created = randomUUID();
    window.sessionStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    fallback ??= randomUUID();
    return fallback;
  }
}
