import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";
import { configureManagedProxy } from "./ManagedProfile.ts";

function managedContents() {
  const setProxy = vi.fn(async () => {});
  const closeAllConnections = vi.fn(async () => {});
  const contents = {
    session: {
      storagePath: "/profiles/t3code-preview-managed-test",
      setProxy,
      closeAllConnections,
    },
    on: vi.fn(),
  } as unknown as WebContents;
  return { contents, setProxy, closeAllConnections };
}

describe("managed profile proxy boundary", () => {
  it.each([
    "http://proxy.example:1080",
    "https://proxy.example:1080/",
    "socks5://proxy.example:1080",
  ])("configures %s once on reattach", async (proxy) => {
    const { contents, setProxy, closeAllConnections } = managedContents();
    await configureManagedProxy(contents, proxy);
    await configureManagedProxy(contents, proxy);
    expect(setProxy).toHaveBeenCalledExactlyOnceWith({
      mode: "fixed_servers",
      proxyRules: proxy.replace(/\/$/, ""),
      proxyBypassRules: "<-loopback>",
    });
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it.each([
    "socks5://proxy.example:1080/path",
    "http://proxy.example/path",
    "http://proxy.example/?q=1",
    "socks5://proxy.example:1080#fragment",
    "socks5://user:pass@proxy.example:1080",
  ])("refuses %s before configuring the session", async (proxy) => {
    const { contents, setProxy } = managedContents();
    await expect(configureManagedProxy(contents, proxy)).rejects.toThrow();
    expect(setProxy).not.toHaveBeenCalled();
  });

  it("refuses changing a live profile route", async () => {
    const { contents, setProxy } = managedContents();
    await configureManagedProxy(contents, null);
    await expect(configureManagedProxy(contents, "http://proxy.example:1080")).rejects.toThrow(
      "cannot change",
    );
    expect(setProxy).toHaveBeenCalledExactlyOnceWith({ mode: "direct" });
  });
});
