import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewStreamClient,
  previewStreamControlLabel,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("marks passive viewers without changing active viewer URLs", () => {
    const { client, socket } = connect();
    expect(new URL(socket.url).searchParams.has("interactive")).toBe(false);
    client.stop();
    const passive = createPreviewStreamClient(
      { ...target, interactive: false },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(new URL(FakeSocket.current.url).searchParams.get("interactive")).toBe("false");
    passive.stop();
  });

  it("does not resize or navigate before ownership is granted", () => {
    const { client, socket } = connect();
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "navigate", url: "http://example.test" })).toBe(false);
    socket.control(agent);
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(client.send({ type: "text", text: "premature" })).toBe(false);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send({ type: "text", text: "owned" })).toBe(true);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "takeControl" },
      { type: "text", text: "owned" },
    ]);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});

describe("managed browser stream: surface, held control and reconnect identity", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = (events: Partial<Parameters<typeof createPreviewStreamClient>[1]> = {}) => {
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
      ...events,
    });
    return { client, socket: FakeSocket.current, onControl };
  };
  const base: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("reports which surface is shown and whether the whole window is on offer, with the reason", () => {
    const onSurface = vi.fn();
    const { socket } = connect({ onSurface });
    socket.message(
      JSON.stringify({
        type: "surface",
        current: "page",
        window: { available: false, reason: "Full window view is turned off." },
      }),
    );
    expect(onSurface).toHaveBeenLastCalledWith({
      current: "page",
      window: { available: false, reason: "Full window view is turned off." },
    });
    socket.message(
      JSON.stringify({ type: "surface", current: "window", window: { available: true } }),
    );
    expect(onSurface).toHaveBeenLastCalledWith({ current: "window", window: { available: true } });
  });

  it("ignores a surface message that names neither surface", () => {
    const onSurface = vi.fn();
    const { socket } = connect({ onSurface });
    socket.message(
      JSON.stringify({ type: "surface", current: "desktop", window: { available: true } }),
    );
    socket.message(JSON.stringify({ type: "surface", current: "page", window: {} }));
    expect(onSurface).not.toHaveBeenCalled();
  });

  it("lets a read-only viewer choose the surface it watches, and still nothing that acts", () => {
    const { client, socket } = connect();
    socket.control({ ...base, canOperate: false });
    expect(client.send({ type: "surface", surface: "window" })).toBe(true);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "text", text: "no" })).toBe(false);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "surface", surface: "window" },
    ]);
    client.stop();
  });

  it("does not send a surface choice on a socket that is not open", () => {
    const { client, socket } = connect();
    socket.readyState = 3;
    expect(client.send({ type: "surface", surface: "window" })).toBe(false);
  });

  it("lets a person resume control held for them, or take a paused browser, but not type until then", () => {
    const { client, socket, onControl } = connect();
    const held = { ...base, controller: "held-for-you" as const, holdExpiresAtMs: 9_000 };
    socket.control(held);
    expect(onControl).toHaveBeenLastCalledWith(held);
    expect(client.send({ type: "text", text: "too early" })).toBe(false);
    expect(client.send({ type: "takeControl" })).toBe(true);
    socket.control({ ...base, controller: "paused" });
    expect(client.send({ type: "text", text: "too early" })).toBe(false);
    expect(client.send({ type: "takeControl" })).toBe(true);
    client.stop();
  });

  it("refuses a hold with no end time, because a countdown needs one", () => {
    const { socket, onControl } = connect();
    socket.control({ ...base, controller: "another-viewer", holdExpiresAtMs: Number.NaN });
    expect(onControl).toHaveBeenLastCalledWith({
      ...base,
      controller: "another-viewer",
    });
  });

  it("names itself the same way across reconnects and differently from every other viewer", () => {
    const first = connect();
    const key = new URL(first.socket.url).searchParams.get("viewerKey");
    expect(key).toMatch(/^[A-Za-z0-9_.-]{8,64}$/);
    first.client.stop();
    const second = connect();
    expect(new URL(second.socket.url).searchParams.get("viewerKey")).not.toBe(key);
    second.client.stop();
  });

  it("keeps the same viewer name when the connection drops and comes back", () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = connect();
      const key = new URL(socket.url).searchParams.get("viewerKey");
      socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
      vi.advanceTimersByTime(60_000);
      const reconnected = FakeSocket.current;
      expect(reconnected).not.toBe(socket);
      expect(new URL(reconnected.url).searchParams.get("viewerKey")).toBe(key);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says plainly what a paused or held browser means", () => {
    expect(previewStreamControlLabel({ ...base, controller: "paused" })).toBe("Paused");
    expect(previewStreamControlLabel({ ...base, controller: "held-for-you" })).toBe(
      "Your control is on hold",
    );
  });
});
