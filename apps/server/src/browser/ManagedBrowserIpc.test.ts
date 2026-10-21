// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as NodeHash from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  EnvironmentId,
  ManagedBrowserControlGeneration,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserPrincipalId,
  ManagedBrowserProfileId,
  type ManagedBrowserPrincipal,
} from "@t3tools/contracts";
import * as ManagedBrowserControl from "./ManagedBrowserControl.ts";
import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

// ---------------------------------------------------------------------------
// Pure units: framing
// ---------------------------------------------------------------------------

const bytes = (text: string) => Buffer.from(text, "utf8");
const lines = (
  result: ReturnType<ReturnType<typeof ManagedBrowserIpc.makeLineSplitter>["push"]>,
) => {
  assert.equal(result._tag, "lines");
  return result._tag === "lines"
    ? result.lines.map((line) => Buffer.from(line).toString("utf8"))
    : [];
};

describe("line splitting", () => {
  it("yields several messages from one chunk and keeps a partial one for the next", () => {
    const splitter = ManagedBrowserIpc.makeLineSplitter(1024, true);
    assert.deepEqual(lines(splitter.push(bytes('{"a":1}\n{"b":2}\n{"c"'))), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(lines(splitter.push(bytes(":3}\n"))), ['{"c":3}']);
  });

  it("reassembles a multibyte character split across chunks", () => {
    const splitter = ManagedBrowserIpc.makeLineSplitter(1024, true);
    const whole = bytes('"héllo ✓"\n');
    const cut = whole.indexOf(0xc3) + 1;
    assert.deepEqual(lines(splitter.push(whole.subarray(0, cut))), []);
    assert.deepEqual(lines(splitter.push(whole.subarray(cut, cut + 7))), []);
    assert.deepEqual(lines(splitter.push(whole.subarray(cut + 7))), ['"héllo ✓"']);
  });

  it("ignores empty lines", () => {
    const splitter = ManagedBrowserIpc.makeLineSplitter(1024, true);
    assert.deepEqual(lines(splitter.push(bytes("\n\nabc\n\n"))), ["abc"]);
  });

  it("accepts a message of exactly the limit and refuses one byte more, without buffering it", () => {
    const exact = ManagedBrowserIpc.makeLineSplitter(8, true);
    assert.deepEqual(lines(exact.push(bytes("12345678\n"))), ["12345678"]);
    const over = ManagedBrowserIpc.makeLineSplitter(8, true);
    assert.equal(over.push(bytes("123456789"))._tag, "tooLarge");
    const split = ManagedBrowserIpc.makeLineSplitter(8, true);
    assert.equal(split.push(bytes("12345"))._tag, "lines");
    assert.equal(split.push(bytes("6789"))._tag, "tooLarge");
  });

  it("in lenient mode truncates an oversize line and resumes at the next one", () => {
    const splitter = ManagedBrowserIpc.makeLineSplitter(4, false);
    assert.deepEqual(lines(splitter.push(bytes("abcdefgh"))), []);
    assert.deepEqual(lines(splitter.push(bytes("ijkl\nnext\n"))), ["abcd", "next"]);
  });
});

// ---------------------------------------------------------------------------
// Conformance with the engine's generated protocol assets
// ---------------------------------------------------------------------------

// The engine's generated protocol assets, vendored with provenance. They are never read from a
// build tree outside this repository, so the conformance suite below cannot skip.
const GENERATED = Path.join(import.meta.dirname, "engine-contract");

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const readJson = (name: string) =>
  decodeJsonText(FS.readFileSync(Path.join(GENERATED, name), "utf8"));

interface JsonSchema {
  type?: string;
  const?: unknown;
  enum?: ReadonlyArray<unknown>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

/** The subset of JSON Schema the engine's generated assets use. */
const accepts = (root: JsonSchema, schema: JsonSchema, input: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (schema.$ref !== undefined) {
    const target = root.$defs?.[schema.$ref.replace("#/$defs/", "")];
    return target !== undefined && accepts(root, target, input, depth + 1);
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants !== undefined) {
    const matches = variants.filter((variant) => accepts(root, variant, input, depth + 1)).length;
    return schema.oneOf !== undefined ? matches === 1 : matches >= 1;
  }
  if ("const" in schema && input !== schema.const) return false;
  if (schema.enum !== undefined && !schema.enum.includes(input)) return false;
  switch (schema.type) {
    case "null":
      if (input !== null) return false;
      break;
    case "boolean":
      if (typeof input !== "boolean") return false;
      break;
    case "string":
      if (
        typeof input !== "string" ||
        input.length < (schema.minLength ?? 0) ||
        input.length > (schema.maxLength ?? Infinity) ||
        (schema.pattern !== undefined && !new RegExp(schema.pattern).test(input))
      ) {
        return false;
      }
      break;
    case "number":
    case "integer":
      if (
        typeof input !== "number" ||
        !Number.isFinite(input) ||
        (schema.type === "integer" && !Number.isSafeInteger(input)) ||
        input < (schema.minimum ?? -Infinity) ||
        input > (schema.maximum ?? Infinity)
      ) {
        return false;
      }
      break;
    case "array":
      if (!Array.isArray(input) || input.length > (schema.maxItems ?? Infinity)) return false;
      if (schema.items !== undefined) {
        const items = schema.items;
        if (!input.every((value) => accepts(root, items, value, depth + 1))) return false;
      }
      break;
    case "object": {
      if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
      const record = input as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) return false;
      for (const [key, value] of Object.entries(record)) {
        const property = Object.hasOwn(schema.properties ?? {}, key)
          ? schema.properties![key]
          : undefined;
        if (property !== undefined) {
          if (!accepts(root, property, value, depth + 1)) return false;
        } else if (schema.additionalProperties === false) {
          return false;
        } else if (typeof schema.additionalProperties === "object") {
          if (!accepts(root, schema.additionalProperties, value, depth + 1)) return false;
        }
      }
      break;
    }
  }
  return true;
};

const resource = { instanceId: "browser:1%", profileId: "profile:1%", ownerEnvironmentId: "env:1" };
const caller = { environmentId: "env:1", threadId: "thread:1", agentSessionId: "session:1" };
const fenceSample = { incarnation: "boot-1", generation: 1 };
const refSample = {
  instanceId: "browser:1%",
  profileId: "profile:1%",
  tabId: "tab-1",
  incarnation: "boot-1",
};
const target = { ref: "e1", documentId: "doc-1" };
const scopeSample = { resource, caller };
const fencedSample = { ...scopeSample, fence: fenceSample };
const sha = "a".repeat(64);

const operations: ReadonlyArray<Record<string, unknown>> = [
  { name: "navigate", url: "https://example.com/", waitUntil: "commit" },
  { name: "snapshot", format: "aria" },
  { name: "screenshot", format: "png", fullPage: false },
  { name: "click", target, button: "left" },
  { name: "fill", target, value: "text" },
  { name: "type", target, value: "text", delayMs: 10 },
  { name: "press", target, key: "Enter" },
  { name: "select", target, values: ["a"] },
  { name: "check", target, checked: true },
  { name: "hover", target },
  { name: "evaluate", expression: "1+1", argument: { a: [1, null] } },
  { name: "dialog", dialogId: "d1", accept: true, promptText: "x" },
  { name: "upload", target, artifactIds: ["a1"] },
  { name: "console", cursor: 0, limit: 10 },
  { name: "network", limit: 10 },
  { name: "recording.start", fps: 5, maxDurationMs: 1000 },
  { name: "recording.stop", recordingId: "r1" },
];

const requestFrame = (method: string, params: unknown) => ({
  protocolVersion: 1,
  kind: "request",
  requestId: "req-1",
  deadlineMs: 2_000_000_000_000,
  method,
  params,
});

const requestSamples: ReadonlyArray<readonly [string, unknown]> = [
  ["hello", requestFrame("hello", { protocolVersion: 1, adapterVersion: "1.0.0" })],
  [
    "open",
    requestFrame("open", {
      ...fencedSample,
      tabId: "tab-1",
      url: "https://example.com/",
      route: "vpn",
    }),
  ],
  ["attach", requestFrame("attach", { ...scopeSample, tabId: "tab-1" })],
  ...operations.map(
    (operation) =>
      [
        `execute.${String(operation.name)}`,
        requestFrame("execute", {
          ...fencedSample,
          ref: refSample,
          documentId: "doc-1",
          operation,
        }),
      ] as const,
  ),
  [
    "subscribe",
    requestFrame("subscribe", {
      ...scopeSample,
      ref: refSample,
      subscriptionId: "sub-1",
      surface: "page",
      maxFps: 5,
      maxWidth: 800,
      maxHeight: 600,
    }),
  ],
  ["unsubscribe", requestFrame("unsubscribe", { ...scopeSample, subscriptionId: "sub-1" })],
  ["ack", requestFrame("ack", { ...scopeSample, subscriptionId: "sub-1", frameId: 1 })],
  ...[
    { name: "pointer", action: "down", x: 1, y: 2, button: "left" },
    { name: "wheel", deltaX: 1.5, deltaY: -2 },
    { name: "key", action: "down", key: "a" },
    { name: "text", text: "hi" },
    { name: "viewport", width: 800, height: 600 },
  ].map(
    (input) =>
      [
        `viewerInput.${input.name}`,
        requestFrame("viewerInput", {
          ...fencedSample,
          ref: refSample,
          documentId: "doc-1",
          subscriptionId: "sub-1",
          input,
        }),
      ] as const,
  ),
  [
    "upload.begin",
    requestFrame("upload", {
      ...fencedSample,
      action: "begin",
      fileName: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      sha256: sha,
    }),
  ],
  [
    "upload.write",
    requestFrame("upload", {
      ...fencedSample,
      action: "write",
      artifactId: "a1",
      offset: 0,
      bytesBase64: "YWJj",
    }),
  ],
  [
    "upload.finish",
    requestFrame("upload", { ...fencedSample, action: "finish", artifactId: "a1" }),
  ],
  [
    "upload.release",
    requestFrame("upload", { ...fencedSample, action: "release", artifactId: "a1" }),
  ],
  [
    "download.read",
    requestFrame("download", {
      ...scopeSample,
      action: "read",
      artifactId: "a1",
      offset: 0,
      length: 16,
    }),
  ],
  [
    "download.release",
    requestFrame("download", { ...scopeSample, action: "release", artifactId: "a1" }),
  ],
  ["closeTab", requestFrame("closeTab", { ...fencedSample, ref: refSample })],
  ["shutdown", requestFrame("shutdown", { requireIdle: false })],
  [
    "setControlGeneration",
    requestFrame("setControlGeneration", { resource, incarnation: "boot-1", generation: 2 }),
  ],
  ["releaseInputs", requestFrame("releaseInputs", { resource, incarnation: "boot-1" })],
  ["quiesce", requestFrame("quiesce", { requestAdmissionClosed: false })],
];

const artifact = {
  artifactId: "a1",
  fileName: "shot.png",
  mimeType: "image/png",
  sizeBytes: 3,
  sha256: sha,
};
const tab = {
  resource,
  ref: refSample,
  documentId: "doc-1",
  fence: fenceSample,
  url: "https://example.com/",
  title: "Example",
};
const counts = {
  actions: 0,
  launches: 1,
  navigations: 0,
  viewers: 0,
  recordings: 0,
  uploads: 0,
  downloads: 0,
  dialogs: 0,
  sharedSessions: 1,
  externalContexts: 0,
};

const responseFrame = (method: string, result: unknown) => ({
  protocolVersion: 1,
  kind: "response",
  requestId: "req-1",
  method,
  ok: true,
  result,
});

/** [label, method, operation (for execute), frame] */
const responseSamples: ReadonlyArray<readonly [string, string, string | undefined, unknown]> = [
  [
    "hello",
    "hello",
    undefined,
    responseFrame("hello", {
      protocolVersion: 1,
      packageVersion: "1.0.0",
      incarnation: "boot-1",
      capabilities: ["open", "execute"],
      platform: { os: "linux", arch: "x64" },
    }),
  ],
  ["open", "open", undefined, responseFrame("open", tab)],
  ["attach", "attach", undefined, responseFrame("attach", tab)],
  ["execute.navigate", "execute", "navigate", responseFrame("execute", tab)],
  [
    "execute.snapshot",
    "execute",
    "snapshot",
    responseFrame("execute", {
      documentId: "doc-1",
      snapshot: "- button",
      refs: { e1: { role: "button", name: "Go", nth: 0 }, e2: { role: "link" } },
    }),
  ],
  ["execute.screenshot", "execute", "screenshot", responseFrame("execute", artifact)],
  ["execute.click", "execute", "click", responseFrame("execute", { ok: true })],
  ["execute.evaluate", "execute", "evaluate", responseFrame("execute", { value: { a: [1] } })],
  [
    "execute.console",
    "execute",
    "console",
    responseFrame("execute", {
      entries: [{ sequence: 1, level: "log", text: "x" }],
      nextCursor: 2,
    }),
  ],
  [
    "execute.network",
    "execute",
    "network",
    responseFrame("execute", {
      entries: [{ sequence: 1, url: "https://e.test/", method: "GET", status: 200, failed: false }],
      nextCursor: 2,
    }),
  ],
  [
    "execute.recording.start",
    "execute",
    "recording.start",
    responseFrame("execute", { recordingId: "r1" }),
  ],
  ["execute.recording.stop", "execute", "recording.stop", responseFrame("execute", artifact)],
  ["subscribe", "subscribe", undefined, responseFrame("subscribe", { subscriptionId: "sub-1" })],
  [
    "unsubscribe",
    "unsubscribe",
    undefined,
    responseFrame("unsubscribe", { profileDeleted: false, tabClosed: false }),
  ],
  ["ack", "ack", undefined, responseFrame("ack", { ok: true })],
  ["viewerInput", "viewerInput", undefined, responseFrame("viewerInput", { ok: true })],
  ["upload.artifact", "upload", undefined, responseFrame("upload", artifact)],
  ["upload.id", "upload", undefined, responseFrame("upload", { artifactId: "a1" })],
  [
    "download.chunk",
    "download",
    undefined,
    responseFrame("download", { offset: 0, bytesBase64: "YWJj", eof: true }),
  ],
  ["closeTab", "closeTab", undefined, responseFrame("closeTab", { closed: true })],
  ["shutdown", "shutdown", undefined, responseFrame("shutdown", { ok: true })],
  [
    "setControlGeneration",
    "setControlGeneration",
    undefined,
    responseFrame("setControlGeneration", { incarnation: "boot-1", generation: 2 }),
  ],
  ["releaseInputs", "releaseInputs", undefined, responseFrame("releaseInputs", { ok: true })],
  [
    "quiesce",
    "quiesce",
    undefined,
    responseFrame("quiesce", { admissionClosed: false, idle: true, reasons: [], counts }),
  ],
  [
    "failure",
    "execute",
    "click",
    {
      protocolVersion: 1,
      kind: "response",
      requestId: "req-1",
      method: "execute",
      ok: false,
      error: { code: "deadline_exceeded", message: "late", retryable: false },
    },
  ],
];

const eventBase = { protocolVersion: 1, kind: "event", incarnation: "boot-1", sequence: 1 };
const eventSamples: ReadonlyArray<readonly [string, unknown]> = [
  [
    "tabOpened",
    {
      ...eventBase,
      name: "tabOpened",
      ...scopeSample,
      ref: refSample,
      documentId: "doc-1",
      openerTabId: "",
      url: "https://example.com/",
    },
  ],
  [
    "tabChanged",
    {
      ...eventBase,
      name: "tabChanged",
      resource,
      ref: refSample,
      documentId: "doc-1",
      url: "https://example.com/",
      title: "t",
    },
  ],
  ["tabClosed", { ...eventBase, name: "tabClosed", resource, ref: refSample }],
  [
    "dialog",
    {
      ...eventBase,
      name: "dialog",
      ...scopeSample,
      ref: refSample,
      documentId: "doc-1",
      dialogId: "d1",
      type: "alert",
      message: "hi",
      defaultValue: "",
    },
  ],
  ["download", { ...eventBase, name: "download", ...scopeSample, ref: refSample, artifact }],
  [
    "frame",
    {
      ...eventBase,
      name: "frame",
      ...scopeSample,
      ref: refSample,
      subscriptionId: "sub-1",
      frameId: 1,
      mimeType: "image/jpeg",
      width: 10,
      height: 10,
      bytesBase64: "AAAA",
    },
  ],
  [
    "viewerState",
    {
      ...eventBase,
      name: "viewerState",
      ...scopeSample,
      subscriptionId: "sub-1",
      state: "attached",
      reason: "",
    },
  ],
  ["ownerClosed", { ...eventBase, name: "ownerClosed", resource, reason: "bye" }],
];

/** Every single-field corruption of a sample, so the two validators can be compared on each. */
const mutants = (sample: unknown): ReadonlyArray<unknown> => {
  const copy = (value: unknown): unknown => decodeJsonText(JSON.stringify(value));
  const out: unknown[] = [];
  const visit = (path: ReadonlyArray<string>, value: unknown) => {
    if (path.length > 5) return;
    const at = (root: unknown, edit: (holder: Record<string, unknown>, key: string) => void) => {
      const next = copy(root) as Record<string, unknown>;
      let holder: Record<string, unknown> = next;
      for (const key of path.slice(0, -1)) holder = holder[key] as Record<string, unknown>;
      edit(holder, path[path.length - 1]!);
      out.push(next);
    };
    if (path.length > 0) {
      at(sample, (holder, key) => delete holder[key]);
      if (typeof value === "string") {
        at(sample, (holder, key) => (holder[key] = 7));
        at(sample, (holder, key) => (holder[key] = ""));
        at(sample, (holder, key) => (holder[key] = "x".repeat(800_000)));
        at(sample, (holder, key) => (holder[key] = "not-a-valid-enum-or-hex"));
      } else if (typeof value === "number") {
        at(sample, (holder, key) => (holder[key] = "1"));
        at(sample, (holder, key) => (holder[key] = -1));
        at(sample, (holder, key) => (holder[key] = 1.5));
        at(sample, (holder, key) => (holder[key] = 2 ** 60));
        at(sample, (holder, key) => (holder[key] = 100_000));
      } else if (typeof value === "boolean") {
        at(sample, (holder, key) => (holder[key] = "true"));
      } else if (Array.isArray(value)) {
        at(sample, (holder, key) => (holder[key] = [7]));
        at(
          sample,
          (holder, key) => (holder[key] = Array.from({ length: 600 }, () => value[0] ?? "x")),
        );
      }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const extra = copy(sample) as Record<string, unknown>;
      let holder: Record<string, unknown> = extra;
      for (const key of path) holder = holder[key] as Record<string, unknown>;
      holder["zzExtra"] = 1;
      out.push(extra);
      for (const [key, child] of Object.entries(value)) visit([...path, key], child);
    }
  };
  visit([], sample);
  return out;
};

describe("conformance with the engine's generated schemas", () => {
  it("matches the digests recorded in its provenance", () => {
    const provenance = readJson("PROVENANCE.json") as {
      protocolVersion: number;
      engineCommit: string;
      sha256: Record<string, string>;
    };
    assert.equal(provenance.protocolVersion, 1);
    assert.match(provenance.engineCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(provenance.sha256).toSorted(), [
      "event.schema.json",
      "fixtures.json",
      "request.schema.json",
      "response.schema.json",
    ]);
    for (const [name, digest] of Object.entries(provenance.sha256)) {
      assert.equal(
        NodeHash.createHash("sha256")
          .update(FS.readFileSync(Path.join(GENERATED, name)))
          .digest("hex"),
        digest,
        name,
      );
    }
  });

  const requestSchema = readJson("request.schema.json") as JsonSchema;
  const responseSchema = readJson("response.schema.json") as JsonSchema;
  const eventSchema = readJson("event.schema.json") as JsonSchema;
  const t3Accepts = {
    request: (frame: unknown) => Exit.isSuccess(ManagedBrowserIpc.decodeRequestFrameForTest(frame)),
    response: (method: string, operation: string | undefined) => (frame: unknown) => {
      const envelope = ManagedBrowserIpc.decodeIncomingFrame(frame);
      if (Exit.isFailure(envelope) || envelope.value.kind !== "response") return false;
      if (!envelope.value.ok) return true;
      // The reader pairs a response with the request it answers, so the method must be that request's.
      if (envelope.value.method !== method) return false;
      return Exit.isSuccess(
        ManagedBrowserIpc.decodeResult(
          method as ManagedBrowserIpc.EngineMethod,
          operation as ManagedBrowserIpc.EngineOperation["name"] | undefined,
          envelope.value.result,
        ),
      );
    },
    event: (frame: unknown) => {
      const decoded = ManagedBrowserIpc.decodeIncomingFrame(frame);
      return Exit.isSuccess(decoded) && decoded.value.kind === "event";
    },
  };

  it("accepts every request the engine's request schema accepts, and refuses every corruption it refuses", () => {
    let refused = 0;
    for (const [label, sample] of requestSamples) {
      assert.isTrue(
        accepts(requestSchema, requestSchema, sample),
        `engine rejects sample ${label}`,
      );
      assert.isTrue(t3Accepts.request(sample), `T3 rejects sample ${label}`);
      for (const mutant of mutants(sample)) {
        const engine = accepts(requestSchema, requestSchema, mutant);
        const t3 = t3Accepts.request(mutant);
        assert.equal(
          t3,
          engine,
          `${label}: disagreement on ${JSON.stringify(mutant).slice(0, 300)}`,
        );
        if (!engine) refused += 1;
      }
    }
    assert.isAbove(refused, 500);
  });

  it("accepts every response shape the engine's response schema accepts, and refuses every corruption it refuses", () => {
    let refused = 0;
    for (const [label, method, operation, sample] of responseSamples) {
      assert.isTrue(
        accepts(responseSchema, responseSchema, sample),
        `engine rejects sample ${label}`,
      );
      const t3 = t3Accepts.response(method, operation);
      assert.isTrue(t3(sample), `T3 rejects sample ${label}`);
      for (const mutant of mutants(sample)) {
        const engine = accepts(responseSchema, responseSchema, mutant);
        assert.equal(
          t3(mutant),
          engine,
          `${label}: disagreement on ${JSON.stringify(mutant).slice(0, 300)}`,
        );
        if (!engine) refused += 1;
      }
    }
    assert.isAbove(refused, 200);
  });

  it("accepts every event the engine's event schema accepts, and refuses every corruption it refuses", () => {
    let refused = 0;
    for (const [label, sample] of eventSamples) {
      assert.isTrue(accepts(eventSchema, eventSchema, sample), `engine rejects sample ${label}`);
      assert.isTrue(t3Accepts.event(sample), `T3 rejects sample ${label}`);
      for (const mutant of mutants(sample)) {
        const engine = accepts(eventSchema, eventSchema, mutant);
        assert.equal(
          t3Accepts.event(mutant),
          engine,
          `${label}: disagreement on ${JSON.stringify(mutant).slice(0, 300)}`,
        );
        if (!engine) refused += 1;
      }
    }
    assert.isAbove(refused, 150);
  });

  it("the sample requests cover every method the engine's request schema defines", () => {
    const methods = new Set(
      (requestSchema.oneOf ?? []).map((variant) => variant.properties?.method?.const as string),
    );
    const covered = new Set(
      requestSamples.map(([, frame]) => (frame as { method: string }).method),
    );
    assert.deepEqual([...covered].sort(), [...methods].sort());
  });
});

// ---------------------------------------------------------------------------
// A real fixture child process
// ---------------------------------------------------------------------------

/** A stand-in for the engine that speaks protocol v1 over stdio and misbehaves on request. */
const FIXTURE = String.raw`
const fs = require("node:fs");
const childProcess = require("node:child_process");
const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mode = process.env.FIXTURE_MODE || "normal";
const incarnation = mode === "wrong-incarnation" ? "some-other-boot" : argValue("--incarnation");
const record = (entry) => {
  if (process.env.FIXTURE_LOG) {
    fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + "\n");
  }
};
record({ event: "start", args, envKeys: Object.keys(process.env).sort() });
if (mode === "stubborn") process.on("SIGTERM", () => record({ event: "sigterm-ignored" }));
if (mode === "grandchild") {
  const grandchild = childProcess.spawn("sleep", ["600"], { stdio: "ignore" });
  record({ event: "grandchild", grandchildPid: grandchild.pid });
}
let generation = 0, tail = Promise.resolve(), navigations = 0, admissionClosed = false, sequence = 0;
const SELF = Symbol("self");
const write = (text) => process.stdout.write(text);
const send = (message) => write(JSON.stringify(message) + "\n");
const respondOk = (request, result) => send({ protocolVersion: 1, kind: "response", requestId: request.requestId, method: request.method, ok: true, result });
const respondError = (request, code, message) => send({ protocolVersion: 1, kind: "response", requestId: request.requestId, method: request.method, ok: false, error: { code, message, retryable: false } });
const emit = (name, body, boot) => send({ protocolVersion: 1, kind: "event", incarnation: boot || incarnation, sequence: ++sequence, name, ...body });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refOf = (p, tabId) => ({ instanceId: p.resource.instanceId, profileId: p.resource.profileId, tabId, incarnation });
const tabOf = (p, tabId) => ({ resource: p.resource, ref: refOf(p, tabId), documentId: "doc-1", fence: { incarnation, generation }, url: p.url || "about:blank", title: "fixture" });
const ZERO = { actions: 0, launches: 0, navigations: 0, viewers: 0, recordings: 0, uploads: 0, downloads: 0, dialogs: 0, sharedSessions: 0, externalContexts: 0 };
const helloResult = () => ({
  protocolVersion: 1,
  packageVersion: "0.0.0-fixture",
  incarnation,
  capabilities: mode === "no-capabilities" ? ["hello"] : ["hello", "open", "attach", "execute", "closeTab", "viewerInput", "subscribe", "unsubscribe", "ack", "upload", "download", "execute.click", "execute.evaluate"],
  platform: { os: process.platform, arch: process.arch },
});
const frameOf = (request, result) => ({ protocolVersion: 1, kind: "response", requestId: request.requestId, method: request.method, ok: true, result });

async function operate(request) {
  const op = request.params.operation;
  record({ event: "underlying-start", op: op.name, expression: op.expression });
  const finish = (result) => { record({ event: "underlying-done", op: op.name, expression: op.expression }); return result; };
  if (op.name === "click") {
    if (op.target.ref === "navigates") { navigations++; setTimeout(() => { navigations--; }, 300); }
    return finish({ ok: true });
  }
  if (op.name !== "evaluate") return finish({ ok: true });
  const e = op.expression;
  if (e.startsWith("slow:")) { await sleep(Number(e.slice(5))); return finish({ value: e }); }
  if (e === "hang") { await new Promise(() => {}); }
  if (e === "crash") process.exit(3);
  if (e === "garbage") { write("this is not json\n"); return finish({ value: null }); }
  if (e === "badutf8") { write(Buffer.from([0xff, 0xfe, 0x0a])); return finish({ value: null }); }
  if (e === "oversize") { for (let i = 0; i < 20; i++) write("a".repeat(65536)); write("\n"); return finish({ value: null }); }
  if (e === "bad-frame") { send({ protocolVersion: 1, kind: "response", requestId: request.requestId, method: "execute", ok: true, result: { value: 1 }, extra: true }); return SELF; }
  if (e === "unknown-response") { send({ protocolVersion: 1, kind: "response", requestId: "nobody", method: "execute", ok: true, result: { value: null } }); return SELF; }
  if (e === "bad-result") return finish({ unexpected: true });
  if (e === "wrong-method") { send({ protocolVersion: 1, kind: "response", requestId: request.requestId, method: "open", ok: true, result: { value: null } }); return SELF; }
  if (e === "wrong-event") { emit("ownerClosed", { resource: request.params.resource, reason: "x" }, "other-boot"); return finish({ value: null }); }
  if (e === "event-order") { emit("ownerClosed", { resource: request.params.resource, reason: "a" }); sequence = 0; emit("ownerClosed", { resource: request.params.resource, reason: "b" }); return finish({ value: null }); }
  if (e === "split" || e === "two-in-one") {
    const value = "héllo ✓ wörld";
    const line = Buffer.from(JSON.stringify(frameOf(request, { value })) + "\n");
    if (e === "two-in-one") {
      write(JSON.stringify({ protocolVersion: 1, kind: "event", incarnation, sequence: ++sequence, name: "ownerClosed", resource: request.params.resource, reason: "first" }) + "\n" + line.toString());
    } else {
      const first = line.indexOf(0xc3) + 1;
      write(line.subarray(0, first)); await sleep(30);
      write(line.subarray(first, first + 9)); await sleep(30);
      write(line.subarray(first + 9));
    }
    return SELF;
  }
  return finish({ value: e });
}

async function work(request) {
  const p = request.params;
  switch (request.method) {
    case "open": emit("tabChanged", { resource: p.resource, ref: refOf(p, p.tabId), documentId: "doc-1", url: p.url, title: "fixture" }); return tabOf(p, p.tabId);
    case "attach": return tabOf(p, p.tabId);
    case "closeTab": return { closed: true };
    case "releaseInputs": return { ok: true };
    case "setControlGeneration": return { incarnation, generation: mode === "wrong-ack" ? p.generation + 1 : p.generation };
    case "shutdown":
      if (mode === "stubborn") { record({ event: "shutdown-ignored" }); return { ok: true }; }
      setTimeout(() => process.exit(0), 20);
      return { ok: true };
    case "execute": return operate(request);
    case "subscribe": return { subscriptionId: p.subscriptionId };
    case "unsubscribe": return { profileDeleted: false, tabClosed: false };
    case "ack": return { ok: true };
    case "viewerInput": return { ok: true };
    case "upload": return p.action === "begin" ? { artifactId: "artifact-1" } : { ok: true };
    case "download": return p.action === "read" ? { offset: p.offset, bytesBase64: Buffer.from("fixture bytes").toString("base64"), eof: true } : { ok: true };
    default: throw new Error("unsupported " + request.method);
  }
}

function onRequest(request) {
  const p = request.params || {};
  record({ event: "request", method: request.method, op: p.operation && p.operation.name, expression: p.operation && p.operation.expression, generation: p.generation, deadlineMs: request.deadlineMs, callerId: p.caller && p.caller.callerId, caller: p.caller, resource: p.resource, params: request.method === "hello" ? undefined : p });
  if (request.method === "hello") { if (mode === "silent-hello") return; return respondOk(request, helloResult()); }
  if (request.method === "quiesce") {
    admissionClosed = p.requestAdmissionClosed;
    record({ event: "quiesce", close: admissionClosed });
    return respondOk(request, { admissionClosed, idle: navigations === 0, reasons: navigations ? ["navigations"] : [], counts: { ...ZERO, navigations } });
  }
  if (request.method === "setControlGeneration") {
    if (p.generation <= generation) return respondError(request, "stale_control", "Generation must increase");
    generation = p.generation;
    record({ event: "generation-set", generation });
  }
  if (request.method === "execute" && p.operation.expression && p.operation.expression.startsWith("oob:")) {
    setTimeout(() => respondOk(request, { value: p.operation.expression }), Number(p.operation.expression.slice(4)));
    return;
  }
  let answered = false;
  const timer = setTimeout(() => {
    if (answered) return;
    answered = true;
    record({ event: "deadline-answer", method: request.method });
    respondError(request, "deadline_exceeded", "Deadline elapsed; underlying operation remains tracked until it finishes");
  }, Math.max(0, request.deadlineMs - Date.now()));
  const run = tail.then(async () => {
    const result = await work(request);
    clearTimeout(timer);
    if (result === SELF) { answered = true; return; }
    if (answered) { record({ event: "late-complete", method: request.method }); return; }
    answered = true;
    record({ event: "responded", method: request.method });
    respondOk(request, result);
  });
  tail = run.catch(() => {});
}

let buffered = Buffer.alloc(0);
process.stdin.on("data", (data) => {
  buffered = Buffer.concat([buffered, data]);
  let index;
  while ((index = buffered.indexOf(10)) >= 0) {
    const line = buffered.subarray(0, index).toString("utf8");
    buffered = buffered.subarray(index + 1);
    if (line.length) onRequest(JSON.parse(line));
  }
});
process.stdin.on("end", () => { record({ event: "stdin-end" }); process.exit(0); });
record({ event: "ready" });
`;

const ownerEnvironmentId = EnvironmentId.make("env-owner");
const instanceId = ManagedBrowserInstanceId.make("instance-a");
const profileId = ManagedBrowserProfileId.make("profile-a");
const specFor = (incarnation = "boot-1"): ManagedBrowserSupervisor.ManagedBrowserChildSpec => ({
  ownerEnvironmentId,
  instanceId,
  profileId,
  incarnation: ManagedBrowserIncarnation.make(incarnation),
});

const agent: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("agent-1"),
  kind: "agent",
  access: "operate",
};
const human: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("human-1"),
  kind: "human",
  access: "operate",
};

const callerContext = {
  environmentId: "env-remote",
  threadId: "thread-1",
  agentSessionId: "session-1",
};
const evaluate = (expression: string) => ({
  kind: "execute" as const,
  caller: callerContext,
  tabId: "tab-1",
  documentId: "doc-1",
  operation: { name: "evaluate" as const, expression, argument: null },
});
const click = (ref = "e1") => ({
  kind: "execute" as const,
  caller: callerContext,
  tabId: "tab-1",
  documentId: "doc-1",
  operation: {
    name: "click" as const,
    target: { ref, documentId: "doc-1" },
    button: "left" as const,
  },
});
const open = {
  kind: "open" as const,
  caller: callerContext,
  tabId: "tab-1",
  url: "https://example.com/",
};

const childRequest = (
  spec: ManagedBrowserSupervisor.ManagedBrowserChildSpec,
  operation: unknown,
  generation = 0,
): ManagedBrowserSupervisor.ManagedBrowserChildRequest => ({
  ref: {
    ownerEnvironmentId: spec.ownerEnvironmentId,
    instanceId: spec.instanceId,
    profileId: spec.profileId,
    incarnation: spec.incarnation,
  },
  fence: {
    incarnation: spec.incarnation,
    generation: ManagedBrowserControlGeneration.make(generation),
  },
  callerId: agent.id,
  callerKind: "agent",
  operation,
});

const SHORT: Partial<ManagedBrowserIpc.ManagedBrowserIpcTimeouts> = {
  helloMs: 5_000,
  requestMs: 5_000,
  answerGraceMs: 2_000,
  drainMs: 5_000,
  navigationSettleMs: 3_000,
  gracefulExitMs: 1_500,
  forceKillAfterMs: 1_000,
  exitProofMs: 5_000,
};

interface Workspace {
  readonly directory: string;
  readonly script: string;
  readonly log: string;
  readonly entries: () => ReadonlyArray<Record<string, any>>;
}

const makeWorkspace = (): Workspace => {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "managed-browser-ipc-"));
  const script = Path.join(directory, "fixture-engine.cjs");
  const log = Path.join(directory, "fixture.log");
  FS.writeFileSync(script, FIXTURE);
  FS.writeFileSync(log, "");
  return {
    directory,
    script,
    log,
    entries: () =>
      FS.readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeJsonText(line) as Record<string, any>),
  };
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const optionsFor = (
  workspace: Workspace,
  mode: string,
  timeouts: Partial<ManagedBrowserIpc.ManagedBrowserIpcTimeouts> = SHORT,
): ManagedBrowserIpc.ManagedBrowserIpcOptions => ({
  command: process.execPath,
  args: [workspace.script],
  dataRoot: Path.join(workspace.directory, "data"),
  environment: {
    PATH: process.env.PATH ?? "",
    FIXTURE_MODE: mode,
    FIXTURE_LOG: workspace.log,
  },
  adapterVersion: "1.0.0",
  timeouts,
});

const withLauncher = <A, E>(
  mode: string,
  body: (
    launcher: ManagedBrowserIpc.ManagedBrowserIpcLauncher,
    workspace: Workspace,
  ) => Effect.Effect<A, E, Scope.Scope>,
  timeouts?: Partial<ManagedBrowserIpc.ManagedBrowserIpcTimeouts>,
) =>
  Effect.gen(function* () {
    const workspace = makeWorkspace();
    const launcher = yield* ManagedBrowserIpc.makeLauncher(optionsFor(workspace, mode, timeouts));
    return yield* body(launcher, workspace);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const failureTag = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined;
  return (error as { error?: { _tag?: string } } | undefined)?.error?._tag;
};

/** The typed cause carried inside a channel or launch error. */
const causeOf = <A>(exit: Exit.Exit<A, unknown>) => {
  const error = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined;
  return (
    error as
      | { error?: { cause?: { _tag?: string; reason?: string; code?: string; detail?: string } } }
      | undefined
  )?.error?.cause;
};

const untilExit = (child: ManagedBrowserSupervisor.ManagedBrowserChild) => child.exit;

describe("a real child process", () => {
  it.live("is started with the minted incarnation, a fixed data root, and no debugging port", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const child = yield* launcher.launch(specFor("boot-7"));
        assert.equal(child.hello.incarnation, "boot-7");
        const start = workspace.entries().find((entry) => entry.event === "start")!;
        const args = start.args as string[];
        assert.equal(args[args.indexOf("--incarnation") + 1], "boot-7");
        assert.equal(args[args.indexOf("--data-root") + 1], Path.join(workspace.directory, "data"));
        assert.isFalse(args.some((arg) => arg.includes("remote-debugging")));
        assert.isTrue(isAlive(child.pid));
      }),
    ),
  );

  it.live("is started headed on its own display only when asked, and never also headless", () =>
    Effect.gen(function* () {
      const flagsOf = (extra: Partial<ManagedBrowserIpc.ManagedBrowserIpcOptions>) =>
        Effect.gen(function* () {
          const workspace = makeWorkspace();
          const launcher = yield* ManagedBrowserIpc.makeLauncher({
            ...optionsFor(workspace, "normal"),
            ...extra,
          });
          yield* launcher.launch(specFor());
          const start = workspace.entries().find((entry) => entry.event === "start")!;
          const args = start.args as string[];
          return { desktop: args.includes("--desktop"), headless: args.includes("--headless") };
        }).pipe(Effect.scoped);
      assert.deepEqual(yield* flagsOf({ desktop: true }), { desktop: true, headless: false });
      assert.deepEqual(yield* flagsOf({ headless: true }), { desktop: false, headless: true });
      // Asking for neither adds neither: the engine's own default is not overridden.
      assert.deepEqual(yield* flagsOf({}), { desktop: false, headless: false });
      // Native hosting is that same default, asked for by name: headed on the host's own screen.
      assert.deepEqual(yield* flagsOf({ native: true }), { desktop: false, headless: false });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a launcher that asks to be both headless and headed", () =>
    Effect.gen(function* () {
      const exit = yield* ManagedBrowserIpc.makeLauncher({
        ...optionsFor(makeWorkspace(), "normal"),
        headless: true,
        desktop: true,
      }).pipe(Effect.exit);
      assert.equal(failureTag(exit), "ManagedBrowserIpcConfigError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses native hosting together with a headless or Linux display launch", () =>
    Effect.gen(function* () {
      for (const other of [{ headless: true }, { desktop: true }]) {
        const exit = yield* ManagedBrowserIpc.makeLauncher({
          ...optionsFor(makeWorkspace(), "normal"),
          native: true,
          ...other,
        }).pipe(Effect.exit);
        assert.equal(failureTag(exit), "ManagedBrowserIpcConfigError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reports what the child advertised, so a viewer can tell whether full window exists",
    () =>
      withLauncher("normal", (launcher) =>
        Effect.gen(function* () {
          const child = yield* launcher.launch(specFor());
          assert.deepEqual(child.capabilities, child.hello.capabilities);
          assert.notInclude(child.capabilities ?? [], "full-window");
        }),
      ),
  );

  it.live("does not inherit the server's environment", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        process.env.T3_IPC_TEST_SECRET = "must-not-leak";
        yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.T3_IPC_TEST_SECRET));
        yield* launcher.launch(specFor());
        const start = workspace.entries().find((entry) => entry.event === "start")!;
        assert.notInclude(start.envKeys as string[], "T3_IPC_TEST_SECRET");
        assert.includeMembers(start.envKeys as string[], ["FIXTURE_MODE", "FIXTURE_LOG", "PATH"]);
      }),
    ),
  );

  it.live(
    "refuses a debugging port, a launcher-owned flag, or a relative path as configuration",
    () =>
      Effect.gen(function* () {
        const base = optionsFor(makeWorkspace(), "normal");
        const attempts: ReadonlyArray<ManagedBrowserIpc.ManagedBrowserIpcOptions> = [
          { ...base, args: [...base.args, "--remote-debugging-port=9222"] },
          { ...base, args: [...base.args, "--remote-debugging-pipe"] },
          { ...base, args: [...base.args, "--incarnation", "forged"] },
          { ...base, args: [...base.args, "--data-root=/tmp/x"] },
          { ...base, dataRoot: "relative/data" },
          { ...base, command: "node" },
        ];
        for (const attempt of attempts) {
          const exit = yield* ManagedBrowserIpc.makeLauncher(attempt).pipe(Effect.exit);
          assert.equal(failureTag(exit), "ManagedBrowserIpcConfigError");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a child whose hello reports a different incarnation, and proves it exited", () =>
    withLauncher("wrong-incarnation", (launcher, workspace) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const exit = yield* launcher
          .launch(specFor("boot-1"))
          .pipe(Scope.provide(scope), Effect.exit);
        assert.equal(failureTag(exit), "ManagedBrowserChildLaunchError");
        assert.equal(causeOf(exit)?.reason, "helloMismatch");
        const pid = workspace.entries().find((entry) => entry.event === "start")!.pid as number;
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(pid));
      }),
    ),
  );

  it.live(
    "refuses an older engine in embedded mode even with an older configured capability list",
    () =>
      Effect.gen(function* () {
        const workspace = makeWorkspace();
        const launcher = yield* ManagedBrowserIpc.makeLauncher({
          ...optionsFor(workspace, "normal"),
          embedded: true,
          requiredCapabilities: ["open"],
        });
        const scope = yield* Scope.make();
        const exit = yield* launcher.launch(specFor()).pipe(Scope.provide(scope), Effect.exit);
        assert.equal(causeOf(exit)?.reason, "capability");
        assert.include(String(causeOf(exit)?.detail), "embedded-page");
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(workspace.entries()[0]!.pid as number));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("refuses embedded mode combined with a browser launch mode", () =>
    Effect.gen(function* () {
      for (const other of [{ native: true }, { headless: true }, { desktop: true }]) {
        const exit = yield* ManagedBrowserIpc.makeLauncher({
          ...optionsFor(makeWorkspace(), "normal"),
          embedded: true,
          ...other,
        }).pipe(Effect.exit);
        assert.equal(failureTag(exit), "ManagedBrowserIpcConfigError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a child that does not advertise the operations it must serve", () =>
    withLauncher("no-capabilities", (launcher, workspace) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const exit = yield* launcher.launch(specFor()).pipe(Scope.provide(scope), Effect.exit);
        assert.equal(causeOf(exit)?.reason, "capability");
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(workspace.entries()[0]!.pid as number));
      }),
    ),
  );

  it.live("fails the launch of a child that never answers hello, and proves it exited", () =>
    withLauncher(
      "silent-hello",
      (launcher, workspace) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const exit = yield* launcher.launch(specFor()).pipe(Scope.provide(scope), Effect.exit);
          assert.equal(failureTag(exit), "ManagedBrowserChildLaunchError");
          assert.equal(causeOf(exit)?.reason, "deadlineNotAnswered");
          yield* Scope.close(scope, Exit.void);
          assert.isFalse(isAlive(workspace.entries()[0]!.pid as number));
        }),
      { ...SHORT, helloMs: 300, answerGraceMs: 200 },
    ),
  );

  it.live(
    "runs open, execute and the navigation settle against the child, validating results",
    () =>
      withLauncher("normal", (launcher) =>
        Effect.gen(function* () {
          const spec = specFor();
          const child = yield* launcher.launch(spec);
          const opened = yield* child.execute(childRequest(spec, open));
          assert.equal((opened.value as { documentId: string }).documentId, "doc-1");

          const evaluated = yield* child.execute(childRequest(spec, evaluate("1+1")));
          assert.deepEqual(evaluated.value, { value: "1+1" });
          assert.isUndefined(evaluated.pending);

          const clicked = yield* child.execute(childRequest(spec, click("navigates")));
          assert.deepEqual(clicked.value, { ok: true });
          assert.isDefined(clicked.pending);
          const started = yield* Clock.currentTimeMillis;
          yield* clicked.pending!;
          assert.isAbove((yield* Clock.currentTimeMillis) - started, 150);
          const idle = yield* child.quiesce(false);
          assert.equal(idle.counts.navigations, 0);
        }),
      ),
  );

  it.live("attributes each request to its caller and sends the supervisor's fence", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        yield* child.execute(childRequest(spec, click(), 0));
        const request = workspace
          .entries()
          .find((entry) => entry.event === "request" && entry.op === "click")!;
        assert.equal(request.callerId, "agent-1");
      }),
    ),
  );

  it.live("delivers lifecycle events with the child's incarnation to a subscriber", () =>
    withLauncher("normal", (launcher) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const received = yield* Deferred.make<ManagedBrowserIpc.EngineEvent>();
        yield* child.events.pipe(
          Stream.take(1),
          Stream.runForEach((event) => Deferred.succeed(received, event)),
          Effect.forkScoped,
        );
        yield* Effect.sleep(100);
        yield* child.execute(childRequest(spec, open));
        const event = yield* Deferred.await(received);
        assert.equal(event.name, "tabChanged");
        assert.equal(event.incarnation, "boot-1");
      }),
    ),
  );

  it.live("rejects malformed operations before they reach the pipe", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const before = workspace.entries().filter((entry) => entry.event === "request").length;
        const bad = [
          "click",
          { kind: "execute", tabId: "t" },
          {
            ...click(),
            operation: { name: "evaluate", expression: "x".repeat(70_000), argument: null },
          },
          { ...click(), extra: true },
          { ...click(), operation: { name: "teleport" } },
        ];
        for (const operation of bad) {
          const exit = yield* child.execute(childRequest(spec, operation)).pipe(Effect.exit);
          assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
          assert.equal(causeOf(exit)?._tag, "ManagedBrowserInvalidCommandError");
        }
        const mismatched = yield* child
          .execute({
            ...childRequest(spec, click()),
            fence: {
              ...childRequest(spec, click()).fence,
              incarnation: ManagedBrowserIncarnation.make("boot-9"),
            },
          })
          .pipe(Effect.exit);
        assert.equal(causeOf(mismatched)?.reason, "identityMismatch");
        assert.equal(
          workspace.entries().filter((entry) => entry.event === "request").length,
          before,
        );
      }),
    ),
  );

  it.live("a response split across chunks, mid-character, still decodes", () =>
    withLauncher("normal", (launcher) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const result = yield* child.execute(childRequest(spec, evaluate("split")));
        assert.deepEqual(result.value, { value: "héllo ✓ wörld" });
      }),
    ),
  );

  it.live("an event and a response arriving in one chunk are both handled", () =>
    withLauncher("normal", (launcher) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const received = yield* Deferred.make<ManagedBrowserIpc.EngineEvent>();
        yield* child.events.pipe(
          Stream.take(1),
          Stream.runForEach((event) => Deferred.succeed(received, event)),
          Effect.forkScoped,
        );
        yield* Effect.sleep(100);
        const result = yield* child.execute(childRequest(spec, evaluate("two-in-one")));
        assert.deepEqual(result.value, { value: "héllo ✓ wörld" });
        assert.equal((yield* Deferred.await(received)).name, "ownerClosed");
      }),
    ),
  );

  describe("protocol violations break the channel and terminate the child", () => {
    const violations: ReadonlyArray<readonly [string, string]> = [
      ["garbage", "invalidJson"],
      ["badutf8", "invalidUtf8"],
      ["oversize", "frameTooLarge"],
      ["bad-frame", "invalidFrame"],
      ["unknown-response", "unknownResponse"],
      ["wrong-method", "methodMismatch"],
      ["bad-result", "invalidResult"],
      ["wrong-event", "incarnationMismatch"],
      ["event-order", "eventOrder"],
    ];
    for (const [expression, reason] of violations) {
      it.live(`${expression} -> ${reason}`, () =>
        withLauncher("normal", (launcher, workspace) =>
          Effect.gen(function* () {
            const spec = specFor();
            const child = yield* launcher.launch(spec);
            const exit = yield* child
              .execute(childRequest(spec, evaluate(expression)))
              .pipe(Effect.exit);
            // Violations raised by a stray frame may land after the response; the channel is broken either way.
            if (Exit.isFailure(exit)) {
              assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
              assert.equal(causeOf(exit)?.reason, reason);
            }
            const ended = yield* untilExit(child);
            assert.isFalse(ended.clean);
            assert.isFalse(isAlive(child.pid));
            const next = yield* child.execute(childRequest(spec, click())).pipe(Effect.exit);
            assert.equal(failureTag(next), "ManagedBrowserChildChannelError");
            assert.isDefined(workspace);
          }),
        ),
      );
    }
  });

  it.live("a child that crashes mid-request fails the request and reports an unclean exit", () =>
    withLauncher("normal", (launcher) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const exit = yield* child.execute(childRequest(spec, evaluate("crash"))).pipe(Effect.exit);
        assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
        // The pipe closing and the process exiting race; either way the channel is gone.
        assert.include(["exited", "stdoutClosed"], causeOf(exit)?.reason);
        assert.isFalse((yield* child.exit).clean);
        assert.isFalse(isAlive(child.pid));
      }),
    ),
  );

  it.live("caps outstanding requests at 128 without writing the excess", () =>
    withLauncher(
      "normal",
      (launcher, workspace) =>
        Effect.gen(function* () {
          const spec = specFor();
          const child = yield* launcher.launch(spec);
          const calls = yield* Effect.forEach(
            Array.from({ length: 130 }, (_, index) => index),
            () =>
              child
                .execute(childRequest(spec, evaluate("oob:600")))
                .pipe(Effect.exit, Effect.forkScoped),
            { concurrency: "unbounded" },
          );
          const exits = yield* Effect.forEach(calls, Fiber.join);
          // hello already finished, so 130 callers fit 128 slots with two refused.
          const refused = exits.filter(
            (exit) => Exit.isFailure(exit) && causeOf(exit)?.reason === "busy",
          );
          assert.equal(refused.length, 2);
          const sent = workspace
            .entries()
            .filter((entry) => entry.expression === "oob:600" && entry.event === "request");
          assert.equal(sent.length, 128);
        }),
      { ...SHORT, requestMs: 20_000, drainMs: 20_000 },
    ),
  );
});

describe("deadlines and generations do not free work that is still running", () => {
  it.live(
    "a deadline answer is not an answer: the caller waits for the queued work to finish",
    () =>
      withLauncher(
        "normal",
        (launcher, workspace) =>
          Effect.gen(function* () {
            const spec = specFor();
            const child = yield* launcher.launch(spec);
            const started = yield* Clock.currentTimeMillis;
            const exit = yield* child
              .execute(childRequest(spec, evaluate("slow:700")))
              .pipe(Effect.exit);
            const elapsed = (yield* Clock.currentTimeMillis) - started;

            assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
            const cause = causeOf(exit) as { code?: string } | undefined;
            assert.equal(cause?.code, "deadline_exceeded");
            // The deadline passed at ~250 ms, but the call is only reported after the 700 ms of work ended.
            assert.isAbove(elapsed, 650);
            const events = workspace.entries().map((entry) => entry.event as string);
            assert.isBelow(events.indexOf("deadline-answer"), events.indexOf("underlying-done"));
            assert.isBelow(events.indexOf("underlying-done"), events.lastIndexOf("responded"));
            // The child was healthy afterwards and still serves.
            const after = yield* child.execute(childRequest(spec, click()));
            assert.deepEqual(after.value, { ok: true });
          }),
        { ...SHORT, requestMs: 250 },
      ),
  );

  it.live("a child that cannot drain past its deadline is terminated and its exit proven", () =>
    withLauncher(
      "normal",
      (launcher) =>
        Effect.gen(function* () {
          const spec = specFor();
          const child = yield* launcher.launch(spec);
          const exit = yield* child.execute(childRequest(spec, evaluate("hang"))).pipe(Effect.exit);
          assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
          const ended = yield* child.exit;
          assert.isFalse(ended.clean);
          assert.isFalse(isAlive(child.pid));
          const next = yield* child.execute(childRequest(spec, click())).pipe(Effect.exit);
          assert.equal(failureTag(next), "ManagedBrowserChildChannelError");
        }),
      { ...SHORT, requestMs: 200, drainMs: 300 },
    ),
  );

  it.live("the generation is acknowledged only after the child's running work has finished", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const running = yield* child
          .execute(childRequest(spec, evaluate("slow:500")))
          .pipe(Effect.forkScoped);
        yield* Effect.sleep(100);
        yield* child.setGeneration(ManagedBrowserControlGeneration.make(1));
        const events = workspace.entries().map((entry) => entry.event as string);
        // The child switched generation on arrival, but answered only once the work behind it was done.
        assert.isAbove(events.indexOf("generation-set"), -1);
        assert.isBelow(events.indexOf("underlying-done"), events.lastIndexOf("responded"));
        yield* Fiber.join(running);
        // A command still using the old fence is the child's to refuse; setting it again must increase.
        const again = yield* child
          .setGeneration(ManagedBrowserControlGeneration.make(1))
          .pipe(Effect.exit);
        assert.equal(failureTag(again), "ManagedBrowserChildChannelError");
        assert.equal((causeOf(again) as { code?: string } | undefined)?.code, "stale_control");
        // A refusal is not a wedge: the child still serves.
        const after = yield* child.execute(childRequest(spec, click(), 1));
        assert.deepEqual(after.value, { ok: true });
      }),
    ),
  );

  it.live("a generation the child cannot acknowledge in time fails, and wedges the child", () =>
    withLauncher(
      "normal",
      (launcher) =>
        Effect.gen(function* () {
          const spec = specFor();
          const child = yield* launcher.launch(spec);
          // Work that never finishes, started with a deadline far away so only the generation request expires.
          const running = yield* child
            .execute(childRequest(spec, evaluate("hang")))
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Effect.sleep(100);
          const exit = yield* child
            .setGeneration(ManagedBrowserControlGeneration.make(1))
            .pipe(Effect.exit);
          assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
          assert.isFalse((yield* child.exit).clean);
          assert.isFalse(isAlive(child.pid));
          assert.equal(failureTag(yield* Fiber.join(running)), "ManagedBrowserChildChannelError");
        }),
      { ...SHORT, requestMs: 30_000, drainMs: 400 },
    ),
  );
});

const ENGINE_MAIN = "/workspace/projects/stealth-browser/.worktree/engine/dist/managed/main.js";

/** The real engine, started the way production starts it, but never asked to launch a browser. */
describe.skipIf(!FS.existsSync(ENGINE_MAIN))("the real engine child (no browser launched)", () => {
  it.live(
    "answers hello with the minted incarnation, acknowledges a generation, reports idle, and exits on scope close",
    () =>
      Effect.gen(function* () {
        const workspace = makeWorkspace();
        const launcher = yield* ManagedBrowserIpc.makeLauncher({
          command: process.execPath,
          args: [ENGINE_MAIN],
          dataRoot: Path.join(workspace.directory, "engine-data"),
          environment: { PATH: process.env.PATH ?? "" },
          adapterVersion: "1.0.0",
          headless: true,
          timeouts: { ...SHORT, helloMs: 20_000 },
        });
        const scope = yield* Scope.make();
        const spec = specFor("real-engine-boot-1");
        const child = yield* launcher.launch(spec).pipe(Scope.provide(scope));
        assert.equal(child.hello.incarnation, "real-engine-boot-1");
        assert.include(child.hello.capabilities, "execute.navigate");
        assert.notInclude(child.hello.capabilities, "setControlGeneration");

        yield* child.setGeneration(ManagedBrowserControlGeneration.make(1));
        const refused = yield* child
          .setGeneration(ManagedBrowserControlGeneration.make(1))
          .pipe(Effect.exit);
        assert.equal((causeOf(refused) as { code?: string } | undefined)?.code, "stale_control");
        const status = yield* child.quiesce(false);
        assert.isTrue(status.idle);
        assert.equal(status.counts.launches, 0);
        yield* child.releaseInput;

        const pid = child.pid;
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(pid));
        assert.isTrue((yield* child.exit).clean);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("a wrong generation acknowledgement", () => {
  it.live("is not accepted: the call fails and the child is terminated", () =>
    withLauncher("wrong-ack", (launcher) =>
      Effect.gen(function* () {
        const child = yield* launcher.launch(specFor());
        const exit = yield* child
          .setGeneration(ManagedBrowserControlGeneration.make(1))
          .pipe(Effect.exit);
        assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
        assert.equal(causeOf(exit)?.reason, "generationNotAcknowledged");
        assert.isFalse((yield* child.exit).clean);
        assert.isFalse(isAlive(child.pid));
      }),
    ),
  );
});

describe("scoped termination proves the child exited", () => {
  it.live("a cooperative child is asked to shut down and exits cleanly", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const child = yield* launcher.launch(specFor()).pipe(Scope.provide(scope));
        const pid = child.pid;
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(pid));
        assert.isTrue((yield* child.exit).clean);
        const methods = workspace
          .entries()
          .filter((entry) => entry.event === "request")
          .map((entry) => entry.method);
        assert.include(methods, "shutdown");
      }),
    ),
  );

  it.live(
    "a child that ignores shutdown and SIGTERM is killed, and the close returns only after",
    () =>
      withLauncher(
        "stubborn",
        (launcher, workspace) =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const child = yield* launcher.launch(specFor()).pipe(Scope.provide(scope));
            const pid = child.pid;
            const started = yield* Clock.currentTimeMillis;
            yield* Scope.close(scope, Exit.void);
            assert.isFalse(isAlive(pid));
            assert.isAbove((yield* Clock.currentTimeMillis) - started, 400);
            const events = workspace.entries().map((entry) => entry.event as string);
            assert.include(events, "shutdown-ignored");
            assert.include(events, "sigterm-ignored");
            assert.isFalse((yield* child.exit).clean);
          }),
        { ...SHORT, gracefulExitMs: 300, forceKillAfterMs: 300 },
      ),
  );

  it.live("takes processes the child started down with it", () =>
    withLauncher("grandchild", (launcher, workspace) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const child = yield* launcher.launch(specFor()).pipe(Scope.provide(scope));
        const grandchild = workspace.entries().find((entry) => entry.event === "grandchild")!
          .grandchildPid as number;
        assert.isTrue(isAlive(grandchild));
        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(child.pid));
        // The orphan is reaped asynchronously by the OS after its parent exits.
        for (let attempt = 0; attempt < 100 && isAlive(grandchild); attempt++)
          yield* Effect.sleep("10 millis");
        assert.isFalse(isAlive(grandchild));
      }),
    ),
  );

  it.live("dies instead of returning when the exit cannot be proven", () =>
    Effect.gen(function* () {
      const never = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.never,
        stderr: Stream.never,
        all: Stream.never,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(never));
      const workspace = makeWorkspace();
      const launcher = yield* ManagedBrowserIpc.makeLauncher(
        optionsFor(workspace, "normal", {
          ...SHORT,
          helloMs: 100,
          answerGraceMs: 50,
          gracefulExitMs: 50,
          exitProofMs: 150,
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const scope = yield* Scope.make();
      const launched = yield* launcher.launch(specFor()).pipe(Scope.provide(scope), Effect.exit);
      assert.equal(failureTag(launched), "ManagedBrowserChildLaunchError");
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(closed));
      const defect = Exit.isFailure(closed)
        ? closed.cause.reasons.find((reason) => reason._tag === "Die")
        : undefined;
      assert.equal(
        (defect as { defect?: { _tag?: string } } | undefined)?.defect?._tag,
        "ManagedBrowserChildNotTerminatedError",
      );
    }),
  );
});

describe("under the supervisor and the control lease", () => {
  const descriptor = { ownerEnvironmentId, instanceId, profileId };

  const withSupervisor = <A, E>(
    mode: string,
    body: (
      supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"],
      workspace: Workspace,
    ) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const workspace = makeWorkspace();
      const launcher = ManagedBrowserIpc.layer(optionsFor(workspace, mode)).pipe(
        Layer.provide(NodeServices.layer),
      );
      const layer = ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
        Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
        Layer.provide(Layer.mergeAll(launcher, NodeCrypto.layer)),
      );
      return yield* Effect.gen(function* () {
        const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
        return yield* body(supervisor, workspace);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

  it.live("starts one child per instance whose incarnation matches the reference", () =>
    withSupervisor("normal", (supervisor, workspace) =>
      Effect.gen(function* () {
        const refs = yield* Effect.all(
          [supervisor.ensure(descriptor), supervisor.ensure(descriptor)],
          {
            concurrency: "unbounded",
          },
        );
        assert.equal(refs[0].incarnation, refs[1].incarnation);
        const starts = workspace.entries().filter((entry) => entry.event === "start");
        assert.equal(starts.length, 1);
        const args = starts[0]!.args as string[];
        assert.equal(args[args.indexOf("--incarnation") + 1], refs[0].incarnation);
      }),
    ),
  );

  it.live(
    "the child hears the generation while the action runs, and the takeover waits for its answer",
    () =>
      withSupervisor("normal", (supervisor, workspace) =>
        Effect.gen(function* () {
          const live = yield* supervisor.ensure(descriptor);
          const { fence } = yield* supervisor.state(live);
          yield* supervisor.execute(agent, live, fence, open);

          const running = yield* supervisor
            .execute(agent, live, fence, evaluate("slow:500"))
            .pipe(Effect.forkScoped);
          yield* Effect.sleep(100);
          const acknowledged = yield* Deferred.make<void>();
          const takeover = yield* supervisor.takeControl(human, live).pipe(
            Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
            Effect.forkScoped,
          );
          yield* Effect.sleep(100);
          assert.isFalse(yield* Deferred.isDone(acknowledged));

          const taken = yield* Fiber.join(takeover);
          yield* Fiber.join(running);
          assert.equal(taken.generation, 1);
          const entries = workspace.entries();
          const doneAt = entries.findIndex((entry) => entry.event === "underlying-done");
          const requestedAt = entries.findIndex(
            (entry) => entry.event === "request" && entry.method === "setControlGeneration",
          );
          const answeredAt = entries.findIndex(
            (entry) => entry.event === "responded" && entry.method === "setControlGeneration",
          );
          // Told at once, because the child may be holding the action on something only this unblocks;
          // answered only after that action finished, which is what the takeover waits for.
          assert.isAbove(requestedAt, -1);
          assert.isBelow(requestedAt, doneAt);
          assert.isAbove(answeredAt, doneAt);
          const requested = workspace
            .entries()
            .find((entry) => entry.method === "setControlGeneration")!;
          assert.equal(requested.generation, 1);

          // The old agent fence never reaches the child; the human's does.
          const before = workspace.entries().filter((entry) => entry.event === "request").length;
          const old = yield* supervisor.execute(agent, live, fence, click()).pipe(Effect.exit);
          assert.equal(failureTag(old), "ManagedBrowserControlHeldError");
          assert.equal(
            workspace.entries().filter((entry) => entry.event === "request").length,
            before,
          );
          assert.deepEqual(yield* supervisor.execute(human, live, taken, click()), { ok: true });
        }),
      ),
  );

  it.live(
    "a child that cannot drain past its deadline fails the takeover closed instead of acknowledging it",
    () =>
      Effect.gen(function* () {
        const workspace = makeWorkspace();
        const launcher = ManagedBrowserIpc.layer(
          optionsFor(workspace, "normal", { ...SHORT, requestMs: 500, drainMs: 400 }),
        ).pipe(Layer.provide(NodeServices.layer));
        const layer = ManagedBrowserSupervisor.layer({ ownerEnvironmentId }).pipe(
          Layer.provideMerge(Layer.provide(ManagedBrowserControl.layer, NodeCrypto.layer)),
          Layer.provide(Layer.mergeAll(launcher, NodeCrypto.layer)),
        );
        yield* Effect.gen(function* () {
          const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
          const live = yield* supervisor.ensure(descriptor);
          const { fence } = yield* supervisor.state(live);
          const running = yield* supervisor
            .execute(agent, live, fence, evaluate("hang"))
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Effect.sleep(100);

          // The takeover waits for the stuck action. Its deadline passes, the child cannot drain, and
          // the child is terminated, so the takeover fails instead of being acknowledged.
          const take = yield* supervisor.takeControl(human, live).pipe(Effect.exit);
          // Either the stuck action's failure let the takeover reach the dead channel (the generation
          // cannot be acknowledged) or the child's death reached it first; it is never acknowledged.
          assert.include(
            ["ManagedBrowserTransferFailedError", "ManagedBrowserOwnerUnavailableError"],
            failureTag(take),
          );
          // The wedged child is gone, and the supervisor never started a second browser.
          const pid = workspace.entries().find((entry) => entry.event === "start")!.pid as number;
          yield* Effect.sleep(200);
          assert.isFalse(isAlive(pid));
          assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
          const after = yield* supervisor.execute(agent, live, fence, click()).pipe(Effect.exit);
          assert.equal(failureTag(after), "ManagedBrowserOwnerUnavailableError");
          assert.equal(workspace.entries().filter((entry) => entry.event === "start").length, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
  );

  it.live(
    "a restart proves the old process gone before a new one with a fresh incarnation serves",
    () =>
      withSupervisor("normal", (supervisor, workspace) =>
        Effect.gen(function* () {
          const first = yield* supervisor.ensure(descriptor);
          const firstPid = workspace.entries().find((entry) => entry.event === "start")!
            .pid as number;

          const token = yield* supervisor.beginMaintenance(instanceId);
          const second = yield* supervisor.restart(instanceId, token);
          yield* supervisor.endMaintenance(instanceId, token);

          assert.notEqual(first.incarnation, second.incarnation);
          assert.isFalse(isAlive(firstPid));
          const starts = workspace.entries().filter((entry) => entry.event === "start");
          assert.equal(starts.length, 2);
          assert.notEqual(starts[1]!.pid, firstPid);
          const secondArgs = starts[1]!.args as string[];
          assert.equal(secondArgs[secondArgs.indexOf("--incarnation") + 1], second.incarnation);

          // The old reference is stale; the new one serves.
          const { fence } = yield* supervisor.state(second);
          const stale = yield* supervisor.execute(agent, first, fence, click()).pipe(Effect.exit);
          assert.equal(failureTag(stale), "ManagedBrowserStaleIncarnationError");
          assert.deepEqual(yield* supervisor.execute(agent, second, fence, click()), { ok: true });
        }),
      ),
  );

  it.live(
    "a crashed child is unavailable until explicitly restarted, and its old reference stays stale",
    () =>
      withSupervisor("normal", (supervisor, workspace) =>
        Effect.gen(function* () {
          const live = yield* supervisor.ensure(descriptor);
          const { fence } = yield* supervisor.state(live);
          const crashed = yield* supervisor
            .execute(agent, live, fence, evaluate("crash"))
            .pipe(Effect.exit);
          assert.equal(failureTag(crashed), "ManagedBrowserChildChannelError");
          yield* Effect.sleep(200);
          const after = yield* supervisor.execute(agent, live, fence, click()).pipe(Effect.exit);
          assert.equal(failureTag(after), "ManagedBrowserOwnerUnavailableError");
          assert.equal(workspace.entries().filter((entry) => entry.event === "start").length, 1);

          const replacement = yield* supervisor.ensure(descriptor);
          assert.notEqual(replacement.incarnation, live.incarnation);
          assert.equal(workspace.entries().filter((entry) => entry.event === "start").length, 2);
          const stale = yield* supervisor.takeControl(human, live).pipe(Effect.exit);
          assert.equal(failureTag(stale), "ManagedBrowserStaleIncarnationError");
        }),
      ),
  );
});

// ---------------------------------------------------------------------------
// Wire identity, per-call deadlines, scoped requests and uploads
// ---------------------------------------------------------------------------

const subscribeCommand = {
  kind: "subscribe" as const,
  caller: callerContext,
  tabId: "tab-1",
  subscriptionId: "sub-1",
  surface: "page" as const,
  maxFps: 10,
  maxWidth: 1280,
  maxHeight: 800,
};

const scopedRequest = (
  spec: ManagedBrowserSupervisor.ManagedBrowserChildSpec,
  operation: unknown,
  extra: Partial<ManagedBrowserSupervisor.ManagedBrowserChildScopedRequest> = {},
): ManagedBrowserSupervisor.ManagedBrowserChildScopedRequest => ({
  ref: childRequest(spec, operation).ref,
  callerId: agent.id,
  callerKind: "agent",
  operation,
  ...extra,
});

describe("what the engine is told about who is calling", () => {
  it.live("keeps the caller's own environment and kind; the owner names only the resource", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        yield* child.execute({ ...childRequest(spec, click()), callerKind: "human" });
        const sent = workspace
          .entries()
          .find((entry) => entry.event === "request" && entry.op === "click")!;
        assert.equal(sent.caller.environmentId, "env-remote");
        assert.equal(sent.caller.threadId, "thread-1");
        assert.equal(sent.caller.agentSessionId, "session-1");
        assert.equal(sent.caller.callerId, "agent-1");
        assert.equal(sent.caller.kind, "human");
        assert.equal(sent.resource.ownerEnvironmentId, "env-owner");
      }),
    ),
  );

  it.live("a command without the caller's environment is refused before it reaches the pipe", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const exit = yield* child
          .execute(
            childRequest(spec, {
              ...click(),
              caller: { threadId: "thread-1", agentSessionId: "session-1" },
            }),
          )
          .pipe(Effect.exit);
        assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
        assert.isFalse(
          workspace.entries().some((entry) => entry.event === "request" && entry.op === "click"),
        );
      }),
    ),
  );
});

describe("per-call deadlines", () => {
  it.live(
    "a call's own deadline replaces the launcher default and is drained before it fails",
    () =>
      withLauncher("normal", (launcher, workspace) =>
        Effect.gen(function* () {
          const spec = specFor();
          const child = yield* launcher.launch(spec);
          const started = Date.now();
          const exit = yield* child
            .execute({ ...childRequest(spec, evaluate("slow:900")), deadlineMs: 300 })
            .pipe(Effect.exit);
          const elapsed = Date.now() - started;
          const error = Exit.isFailure(exit)
            ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as {
                error?: { cause?: { code?: string } };
              })
            : undefined;
          assert.equal(error?.error?.cause?.code, "deadline_exceeded");
          const sent = workspace
            .entries()
            .find((entry) => entry.event === "request" && entry.op === "evaluate")!;
          // The request carried 300 ms, not the 5 s default, and the failure waited for the work to finish.
          assert.isBelow(sent.deadlineMs - sent.at, 1_000);
          assert.isAtLeast(elapsed, 850);
          const events = workspace.entries().map((entry) => entry.event);
          assert.isBelow(events.indexOf("deadline-answer"), events.indexOf("underlying-done"));
          assert.isAbove(
            events.indexOf("responded"),
            events.indexOf("underlying-done"),
            "the drain barrier is answered only after the underlying work finished",
          );
        }),
      ),
  );

  it.live("a deadline in the past or beyond the cap is refused, not clamped silently", () =>
    withLauncher("normal", (launcher) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        for (const deadlineMs of [0, -5, 1.5, 10 * 60_000]) {
          const exit = yield* child
            .execute({ ...childRequest(spec, click()), deadlineMs })
            .pipe(Effect.exit);
          assert.equal(failureTag(exit), "ManagedBrowserChildChannelError", String(deadlineMs));
        }
      }),
    ),
  );
});

describe("scoped requests and uploads", () => {
  it.live("subscribe, ack, unsubscribe and download reach the engine with the caller's scope", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        assert.deepEqual(yield* child.scoped(scopedRequest(spec, subscribeCommand)), {
          subscriptionId: "sub-1",
        });
        yield* child.scoped(
          scopedRequest(spec, {
            kind: "ack",
            caller: callerContext,
            subscriptionId: "sub-1",
            frameId: 4,
          }),
        );
        yield* child.scoped(
          scopedRequest(spec, {
            kind: "unsubscribe",
            caller: callerContext,
            subscriptionId: "sub-1",
          }),
        );
        const chunk = yield* child.scoped(
          scopedRequest(spec, {
            kind: "downloadRead",
            caller: callerContext,
            artifactId: "artifact-1",
            offset: 0,
            length: 1024,
          }),
        );
        assert.deepEqual(chunk, {
          offset: 0,
          bytesBase64: Buffer.from("fixture bytes").toString("base64"),
          eof: true,
        });
        yield* child.scoped(
          scopedRequest(spec, {
            kind: "downloadRelease",
            caller: callerContext,
            artifactId: "artifact-1",
          }),
        );

        const methods = workspace
          .entries()
          .filter((entry) => entry.event === "request")
          .map((entry) => entry.method);
        assert.deepEqual(methods.slice(-5), [
          "subscribe",
          "ack",
          "unsubscribe",
          "download",
          "download",
        ]);
        const subscribe = workspace.entries().find((entry) => entry.method === "subscribe")!;
        assert.equal(subscribe.caller.environmentId, "env-remote");
        assert.equal(subscribe.caller.kind, "agent");
        assert.equal(subscribe.params.ref.tabId, "tab-1");
        assert.equal(subscribe.params.ref.incarnation, "boot-1");
        assert.equal(subscribe.resource.ownerEnvironmentId, "env-owner");
      }),
    ),
  );

  it.live("a scoped request that names another browser is refused before it reaches the pipe", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const stale = scopedRequest(spec, subscribeCommand);
        const exit = yield* child
          .scoped({
            ...stale,
            ref: { ...stale.ref, incarnation: ManagedBrowserIncarnation.make("old") },
          })
          .pipe(Effect.exit);
        assert.equal(causeOf(exit)?.reason, "identityMismatch");
        assert.isFalse(workspace.entries().some((entry) => entry.method === "subscribe"));
      }),
    ),
  );

  it.live(
    "a subscribe with an unknown surface or a download beyond 256 KiB is refused locally",
    () =>
      withLauncher("normal", (launcher, workspace) =>
        Effect.gen(function* () {
          const spec = specFor();
          const child = yield* launcher.launch(spec);
          const bad = [
            { ...subscribeCommand, surface: "desktop" },
            { ...subscribeCommand, maxFps: 31 },
            {
              kind: "downloadRead",
              caller: callerContext,
              artifactId: "artifact-1",
              offset: 0,
              length: 256 * 1024 + 1,
            },
            { kind: "evaluate", caller: callerContext },
          ];
          for (const operation of bad) {
            const exit = yield* child.scoped(scopedRequest(spec, operation)).pipe(Effect.exit);
            assert.equal(failureTag(exit), "ManagedBrowserChildChannelError");
          }
          assert.isFalse(
            workspace
              .entries()
              .some((entry) => entry.method === "subscribe" || entry.method === "download"),
          );
        }),
      ),
  );

  it.live("upload actions travel through execute with the fence of the lease", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        const sha256 = "a".repeat(64);
        const begun = yield* child.execute(
          childRequest(
            spec,
            {
              kind: "uploadBegin",
              caller: callerContext,
              fileName: "photo.png",
              mimeType: "image/png",
              sizeBytes: 4,
              sha256,
            },
            3,
          ),
        );
        assert.deepEqual(begun.value, { artifactId: "artifact-1" });
        yield* child.execute(
          childRequest(
            spec,
            {
              kind: "uploadWrite",
              caller: callerContext,
              artifactId: "artifact-1",
              offset: 0,
              bytesBase64: Buffer.from("data").toString("base64"),
            },
            3,
          ),
        );
        yield* child.execute(
          childRequest(
            spec,
            { kind: "uploadFinish", caller: callerContext, artifactId: "artifact-1" },
            3,
          ),
        );
        yield* child.execute(
          childRequest(
            spec,
            { kind: "uploadRelease", caller: callerContext, artifactId: "artifact-1" },
            3,
          ),
        );
        const uploads = workspace
          .entries()
          .filter((entry) => entry.event === "request" && entry.method === "upload");
        assert.deepEqual(
          uploads.map((entry) => entry.params.action),
          ["begin", "write", "finish", "release"],
        );
        assert.isTrue(uploads.every((entry) => entry.params.fence.generation === 3));
        assert.isTrue(uploads.every((entry) => entry.caller.environmentId === "env-remote"));
      }),
    ),
  );

  it.live("viewer input travels through execute with the subscription it belongs to", () =>
    withLauncher("normal", (launcher, workspace) =>
      Effect.gen(function* () {
        const spec = specFor();
        const child = yield* launcher.launch(spec);
        yield* child.execute(
          childRequest(spec, {
            kind: "viewerInput",
            caller: callerContext,
            tabId: "tab-1",
            documentId: "doc-1",
            subscriptionId: "sub-1",
            input: { name: "key", action: "down", key: "a" },
          }),
        );
        const sent = workspace.entries().find((entry) => entry.method === "viewerInput")!;
        assert.equal(sent.params.subscriptionId, "sub-1");
        assert.equal(sent.params.input.name, "key");
        assert.equal(sent.caller.kind, "agent");
      }),
    ),
  );
});
