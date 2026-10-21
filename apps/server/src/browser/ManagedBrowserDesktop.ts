// @effect-diagnostics nodeBuiltinImport:off
/**
 * ManagedBrowserDesktop - whether this server can show a managed browser's whole Chrome window.
 *
 * Page streaming needs nothing beyond the browser. The whole window (toolbar, extension prompts, native
 * dialogs) needs the engine to run Chrome headed on a private display it captures, which depends on a
 * handful of Linux tools. This module decides, from the environment alone, whether to ask the engine for
 * that: turned on explicitly, on Linux, with every tool present. Anything less launches the ordinary
 * headless browser and reports full window as unavailable with the reason, so page viewing keeps working
 * and nothing quietly falls back to a display it was not given.
 *
 * @module ManagedBrowserDesktop
 */
import type { ManagedBrowserCapability } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FS from "node:fs";
import * as Path from "node:path";

/** Set to `1` on the host that should offer full window viewing. Off by default. */
export const DESKTOP_VARIABLE = "T3CODE_MANAGED_BROWSER_DESKTOP";

/**
 * Set to `1` by the T3 desktop app on the server it owns. On a Mac the browser then runs in its own
 * ordinary window on that Mac's screen, so its person uses it directly instead of through a video of it.
 */
export const NATIVE_VARIABLE = "T3CODE_MANAGED_BROWSER_NATIVE";

/** What the engine's private display needs, by executable name. */
export const DESKTOP_TOOLS = ["Xvfb", "xauth", "openbox", "ffmpeg", "xdotool"] as const;

export interface DesktopProbe {
  /** Launch the engine headed on a private display. */
  readonly launchDesktop: boolean;
  /** Launch the engine headed on this computer's own screen. Never together with `launchDesktop`. */
  readonly launchNative: boolean;
  /** Whether the whole Chrome window can be streamed to a viewer. */
  readonly capability: ManagedBrowserCapability;
  /** Whether the browser opens as a window on the screen of the computer that runs it. */
  readonly native: ManagedBrowserCapability;
}

const isExecutable = (path: string) => {
  try {
    FS.accessSync(path, FS.constants.X_OK);
    return FS.statSync(path).isFile();
  } catch {
    return false;
  }
};

export const probeDesktop = (
  environment: NodeJS.ProcessEnv,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly isExecutable?: (path: string) => boolean;
    /** Whether this server is the one the T3 desktop app started for itself; nothing else may host natively. */
    readonly desktopOwned?: boolean;
  } = {},
): DesktopProbe => {
  const platform = options.platform ?? process.platform;
  const nativeRequested =
    environment[NATIVE_VARIABLE] === "1" || environment[NATIVE_VARIABLE] === "true";
  const nativeOff = (reason: string): ManagedBrowserCapability => ({ available: false, reason });
  if (nativeRequested && platform === "darwin" && options.desktopOwned === true) {
    // Chrome opens on the Mac's own screen: no private display, no capture, and no tools to look for.
    return {
      launchDesktop: false,
      launchNative: true,
      native: { available: true },
      capability: nativeOff(
        "This browser runs in its own window on this Mac, so there is no separate full window view. Page view is available.",
      ),
    };
  }
  const native = nativeOff(
    !nativeRequested
      ? "This browser is not set to open on the screen of the computer that runs it."
      : options.desktopOwned !== true
        ? "Only the T3 desktop app can open the browser on its own computer's screen."
        : "Opening the browser on this computer's screen is only available on a Mac.",
  );
  const unavailable = (reason: string): DesktopProbe => ({
    launchDesktop: false,
    launchNative: false,
    native,
    capability: { available: false, reason },
  });
  const requested =
    environment[DESKTOP_VARIABLE] === "1" || environment[DESKTOP_VARIABLE] === "true";
  if (!requested) {
    return unavailable(
      "Full window view is turned off on the computer that runs this browser. Page view is available.",
    );
  }
  if (platform !== "linux") {
    return unavailable(
      "Full window view is only available when the browser runs on Linux. Page view is available.",
    );
  }
  const executable = options.isExecutable ?? isExecutable;
  const directories = (environment.PATH ?? "")
    .split(Path.delimiter)
    .filter((entry) => entry !== "");
  const missing = DESKTOP_TOOLS.filter(
    (tool) => !directories.some((directory) => executable(Path.join(directory, tool))),
  );
  if (missing.length > 0) {
    return unavailable(
      `Full window view needs ${missing.join(", ")} installed on the computer that runs this browser. Page view is available.`,
    );
  }
  return { launchDesktop: true, launchNative: false, native, capability: { available: true } };
};

/** What this server offers, supplied by the runtime. A server without it offers page view only. */
export class ManagedBrowserDesktop extends Context.Service<
  ManagedBrowserDesktop,
  { readonly capability: ManagedBrowserCapability; readonly native: ManagedBrowserCapability }
>()("t3/browser/ManagedBrowserDesktop") {}

export const layer = (probe: DesktopProbe) =>
  Layer.succeed(ManagedBrowserDesktop, { capability: probe.capability, native: probe.native });

export const NATIVE_NOT_SET_UP: ManagedBrowserCapability = {
  available: false,
  reason: "This browser is not set to open on the screen of the computer that runs it.",
};

export const NOT_SET_UP: ManagedBrowserCapability = {
  available: false,
  reason: "Full window view is not set up here. Page view is available.",
};
