// @effect-diagnostics globalConsole:off - Reports failures inside extension contexts, which have no Effect runtime.
/**
 * Session preload for preview profiles, for frames and extension service
 * workers. In extension contexts it adds the `chrome.*` methods Electron
 * lacks, each forwarding to `ExtensionHost` in the main process; everywhere
 * else (ordinary pages, including T3's non-isolated preview guests) it does
 * nothing.
 */
import { contextBridge, ipcRenderer } from "electron";

import {
  EXTENSION_API_SURFACE,
  EXTENSION_CALL_CHANNEL,
  EXTENSION_EVENT_CHANNEL,
} from "./preview/extensions/ExtensionApiSurface.ts";

/** Runs in the extension's own world; serialized, so it cannot close over anything. */
function installApis(surface: typeof EXTENSION_API_SURFACE) {
  const scope = globalThis as unknown as {
    __t3ExtensionBridge: {
      call: (method: string, args: ReadonlyArray<unknown>) => Promise<unknown>;
      subscribe: (listener: (name: string, args: ReadonlyArray<unknown>) => void) => void;
    };
    chrome: Record<string, Record<string, unknown> | undefined>;
  };
  const bridge = scope.__t3ExtensionBridge;
  const listeners = new Map<string, Set<(...args: ReadonlyArray<unknown>) => void>>();
  bridge.subscribe((name, args) => {
    for (const listener of listeners.get(name) ?? []) {
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  });
  const event = (name: string) => ({
    addListener: (listener: (...args: ReadonlyArray<unknown>) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
    },
    removeListener: (listener: (...args: ReadonlyArray<unknown>) => void) => listeners.get(name)?.delete(listener),
    hasListener: (listener: (...args: ReadonlyArray<unknown>) => void) => listeners.get(name)?.has(listener) ?? false,
    hasListeners: () => (listeners.get(name)?.size ?? 0) > 0,
  });
  const method =
    (name: string) =>
    (...args: Array<unknown>) => {
      const last = args.at(-1);
      const callback = typeof last === "function" ? last : undefined;
      if (callback) args.pop();
      const result = bridge.call(name, args);
      if (!callback) return result;
      result.then(
        (value) => callback(value),
        (error: unknown) => {
          console.error(`chrome.${name}: ${error instanceof Error ? error.message : String(error)}`);
          callback();
        },
      );
      return undefined;
    };
  for (const [namespace, spec] of Object.entries(surface)) {
    const target = (scope.chrome[namespace] ??= {});
    for (const name of spec.methods) target[name] = method(`${namespace}.${name}`);
    for (const name of spec.events) target[name] ??= event(`${namespace}.${name}`);
    Object.assign(target, spec.constants);
  }
  scope.chrome.browserAction ??= scope.chrome.action;
}

const contextUrl: unknown =
  process.type === "service-worker"
    ? contextBridge.executeInMainWorld({ func: () => self.location.href })
    : globalThis.location?.href;

// Extension frames inside T3's preview guests are not isolated; the bridge needs isolation.
if (
  typeof contextUrl === "string" &&
  contextUrl.startsWith("chrome-extension://") &&
  (process.type === "service-worker" || process.contextIsolated)
) {
  const listeners = new Set<(name: string, args: ReadonlyArray<unknown>) => void>();
  ipcRenderer.on(EXTENSION_EVENT_CHANNEL, (_event, name: string, args: ReadonlyArray<unknown>) => {
    for (const listener of listeners) listener(name, args);
  });
  contextBridge.exposeInMainWorld("__t3ExtensionBridge", {
    call: (name: string, args: ReadonlyArray<unknown>) => ipcRenderer.invoke(EXTENSION_CALL_CHANNEL, name, args),
    subscribe: (listener: (name: string, args: ReadonlyArray<unknown>) => void) => {
      listeners.add(listener);
    },
  });
  contextBridge.executeInMainWorld({ func: installApis, args: [EXTENSION_API_SURFACE] });
}
