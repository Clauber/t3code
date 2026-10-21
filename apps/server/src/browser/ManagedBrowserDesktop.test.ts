import { describe, expect, it } from "@effect/vitest";

import {
  DESKTOP_TOOLS,
  DESKTOP_VARIABLE,
  NATIVE_VARIABLE,
  probeDesktop,
} from "./ManagedBrowserDesktop.ts";

const environment = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/bin:/opt/tools",
  ...extra,
});
const everything = () => true;

describe("probing for full window viewing", () => {
  it("stays headless and says it is off unless someone turned it on", () => {
    const probe = probeDesktop(environment(), { platform: "linux", isExecutable: everything });
    expect(probe.launchDesktop).toBe(false);
    expect(probe.capability.available).toBe(false);
    expect(probe.capability.reason).toMatch(/turned off/);
    // Page view is the honest fallback and the message says so.
    expect(probe.capability.reason).toMatch(/Page view is available/);
  });

  it("launches headed only on Linux with every tool on the PATH the engine will see", () => {
    const probe = probeDesktop(environment({ [DESKTOP_VARIABLE]: "1" }), {
      platform: "linux",
      isExecutable: everything,
    });
    expect(probe).toMatchObject({
      launchDesktop: true,
      launchNative: false,
      capability: { available: true },
    });
  });

  it("names exactly the missing tools instead of launching a display that cannot start", () => {
    const present = new Set(
      DESKTOP_TOOLS.filter((tool) => tool !== "ffmpeg" && tool !== "xdotool"),
    );
    const probe = probeDesktop(environment({ [DESKTOP_VARIABLE]: "1" }), {
      platform: "linux",
      isExecutable: (path) => present.has(path.split("/").pop() as never),
    });
    expect(probe.launchDesktop).toBe(false);
    expect(probe.capability.reason).toContain("ffmpeg, xdotool");
    expect(probe.capability.reason).not.toContain("Xvfb");
  });

  it("does not offer it away from Linux, even when every tool is present", () => {
    const probe = probeDesktop(environment({ [DESKTOP_VARIABLE]: "1" }), {
      platform: "darwin",
      isExecutable: everything,
    });
    expect(probe.launchDesktop).toBe(false);
    expect(probe.capability.reason).toMatch(/Linux/);
  });

  it("looks only on the PATH it is given, never the ambient one", () => {
    const seen: Array<string> = [];
    probeDesktop(environment({ [DESKTOP_VARIABLE]: "1", PATH: "/only/here" }), {
      platform: "linux",
      isExecutable: (path) => {
        seen.push(path);
        return false;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => path.startsWith("/only/here/"))).toBe(true);
  });

  it("hosts the browser natively on a Mac only when the desktop app that owns this server asks", () => {
    const native = { [NATIVE_VARIABLE]: "1" };
    const probe = probeDesktop(environment(native), {
      platform: "darwin",
      desktopOwned: true,
      isExecutable: () => false,
    });
    // No display tools are looked for: Chrome opens on the Mac's own screen.
    expect(probe).toMatchObject({
      launchNative: true,
      launchDesktop: false,
      native: { available: true },
      capability: { available: false },
    });
    expect(probe.capability.reason).toMatch(/own window on this Mac/);
    expect(probe.capability.reason).toMatch(/Page view is available/);
  });

  it("does not host natively for a server the desktop app does not own, or off a Mac", () => {
    const native = environment({ [NATIVE_VARIABLE]: "1" });
    // A remote or standalone server that merely inherited the variable.
    const standalone = probeDesktop(native, { platform: "darwin", desktopOwned: false });
    expect(standalone.launchNative).toBe(false);
    expect(standalone.native.available).toBe(false);
    expect(standalone.native.reason).toMatch(/desktop app/);
    const linux = probeDesktop(native, { platform: "linux", desktopOwned: true });
    expect(linux.launchNative).toBe(false);
    expect(linux.native.reason).toMatch(/Mac/);
  });

  it("is off by default, and never also launches the Linux display", () => {
    expect(probeDesktop(environment(), { platform: "darwin", desktopOwned: true })).toMatchObject({
      launchNative: false,
      native: { available: false },
    });
    const both = probeDesktop(environment({ [NATIVE_VARIABLE]: "1", [DESKTOP_VARIABLE]: "1" }), {
      platform: "darwin",
      desktopOwned: true,
      isExecutable: everything,
    });
    expect(both.launchNative).toBe(true);
    expect(both.launchDesktop).toBe(false);
  });
});
