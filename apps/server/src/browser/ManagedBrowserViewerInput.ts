/**
 * ManagedBrowserViewerInput - what a viewer's messages become as the engine's typed input.
 *
 * Pure mapping, kept apart from the adapter: the page takes pointer, wheel, keys and text in CSS pixels;
 * the whole window takes the same in desktop pixels, but its private desktop types only a fixed set of key
 * names, so anything else printable is sent as text.
 *
 * @module ManagedBrowserViewerInput
 */

/** The key names the engine's private desktop types; anything else must arrive as text. */
const WINDOW_KEY_NAMES: ReadonlySet<string> = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "Enter",
  "Escape",
  "Backspace",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Delete",
  "Tab",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  " ",
]);
const isWindowKey = (key: string) =>
  WINDOW_KEY_NAMES.has(key) || /^[a-zA-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key);

/**
 * Input for the whole window. The engine types named keys, letters, digits and function keys directly
 * and takes everything else printable as text, so a character with no key name is sent as the text it is
 * on press, and its release is dropped. Pointer, wheel and text are the page's, in desktop pixels.
 */
export const windowInputOf = (message: Record<string, unknown>) => {
  if (message.type !== "key") return viewerInputOf(message);
  const key = typeof message.key === "string" ? message.key : "";
  if (key.length === 0 || isWindowKey(key)) return viewerInputOf(message);
  // One character, however many UTF-16 units it takes.
  if (Array.from(key).length === 1) {
    return message.action === "up" ? undefined : { name: "text" as const, text: key };
  }
  return undefined;
};

/** Maps what a viewer sends onto the engine's typed input; anything it cannot express is dropped. */
export const viewerInputOf = (message: Record<string, unknown>) => {
  const number = (value: unknown, fallback = 0) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  switch (message.type) {
    case "mouse": {
      const action = message.action === "down" || message.action === "up" ? message.action : "move";
      const button =
        message.button === "middle" || message.button === "right" ? message.button : "left";
      return {
        name: "pointer" as const,
        action,
        x: Math.max(0, Math.min(16384, Math.round(number(message.x)))),
        y: Math.max(0, Math.min(16384, Math.round(number(message.y)))),
        button,
      };
    }
    case "wheel":
      return {
        name: "wheel" as const,
        deltaX: Math.max(-100000, Math.min(100000, number(message.deltaX))),
        deltaY: Math.max(-100000, Math.min(100000, number(message.deltaY))),
      };
    case "key":
      return typeof message.key === "string" && message.key.length > 0
        ? {
            name: "key" as const,
            action: message.action === "up" ? ("up" as const) : ("down" as const),
            key: message.key.slice(0, 128),
          }
        : undefined;
    case "text":
      return typeof message.text === "string" && message.text.length > 0
        ? { name: "text" as const, text: message.text.slice(0, 10_000) }
        : undefined;
    case "resize": {
      const width = Math.round(number(message.width));
      const height = Math.round(number(message.height));
      return width >= 100 && height >= 100
        ? {
            name: "viewport" as const,
            width: Math.min(width, 4096),
            height: Math.min(height, 4096),
          }
        : undefined;
    }
    default:
      return undefined;
  }
};
