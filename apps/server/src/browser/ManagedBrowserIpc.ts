/**
 * ManagedBrowserIpc - the private launcher for the managed browser engine child.
 *
 * Implements {@link ManagedBrowserSupervisor.ManagedBrowserChildLauncher} over the
 * engine's inherited stdin/stdout NDJSON pipe. There is no listener and no debugging
 * port: the child is reachable only through the pipe this module holds, and Patchright
 * inside the child is the only browser driver.
 *
 * - Every frame in either direction is validated at the transport boundary against
 *   strict schemas that mirror the engine's generated protocol assets, with each
 *   message and buffer capped (1 MiB per message, 128 outstanding requests).
 * - The incarnation the supervisor mints is handed to the child, and the child's
 *   `hello` must echo it. A child that reports another incarnation never serves.
 * - A deadline answer from the child does not prove its work stopped. After one, the
 *   launcher keeps the caller waiting until a request queued behind that work has been
 *   answered (a drain barrier), and treats a child that cannot drain as wedged: it is
 *   terminated and its exit awaited. The same holds for the control generation, which
 *   the control layer commits a takeover on only after the child acknowledges it.
 * - Closing the scope given to `launch` shuts the child down gracefully, escalates to
 *   a kill, and returns only once the process has been observed to exit. If that cannot
 *   be proven the finalizer dies, so a replacement is never started over a profile that
 *   may still be locked.
 * - Any protocol violation (bad JSON, oversize frame, invalid schema, unknown response,
 *   mismatched incarnation, unexpected stdout close) breaks the channel, fails every
 *   waiting request, and terminates the child.
 *
 * Profile grant validation is a separate service and is not performed here.
 *
 * @module ManagedBrowserIpc
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ManagedBrowserInstanceId } from "@t3tools/contracts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MANAGED_BROWSER_IPC_LIMITS = {
  /** One NDJSON message, excluding its newline. */
  messageBytes: 1024 * 1024,
  /** Requests in flight at once; the engine refuses more. */
  outstanding: 128,
  /** One stderr line kept for logging; the rest of a longer line is discarded. */
  stderrLineBytes: 8192,
} as const;

const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const EngineErrorCode = Schema.Literals([
  "invalid_request",
  "unsupported",
  "busy",
  "deadline_exceeded",
  "not_found",
  "profile_in_use",
  "owner_unavailable",
  "stale_boot",
  "stale_control",
  "stale_document",
  "artifact_invalid",
  "admission_closed",
  "internal",
]);
export type EngineErrorCode = typeof EngineErrorCode.Type;

/** The engine answered a request with a typed failure. Carried as the cause of a channel error. */
export class ManagedBrowserEngineError extends Schema.TaggedError<ManagedBrowserEngineError>()(
  "ManagedBrowserEngineError",
  {
    method: Schema.String,
    code: EngineErrorCode,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

/** The pipe broke its contract, or the child stopped answering; the child is terminated. */
export class ManagedBrowserProtocolError extends Schema.TaggedError<ManagedBrowserProtocolError>()(
  "ManagedBrowserProtocolError",
  {
    reason: Schema.Literals([
      "invalidUtf8",
      "invalidJson",
      "invalidFrame",
      "frameTooLarge",
      "unknownResponse",
      "methodMismatch",
      "invalidResult",
      "incarnationMismatch",
      "eventOrder",
      "deadlineNotAnswered",
      "deadlineNotDrained",
      "generationNotAcknowledged",
      "navigationNotSettled",
      "stdoutClosed",
      "exited",
      "busy",
      "closed",
      "capability",
      "helloMismatch",
      "identityMismatch",
    ]),
    detail: Schema.String,
  },
) {}

/** The supervisor handed the launcher an operation envelope that does not match the schema. */
export class ManagedBrowserInvalidCommandError extends Schema.TaggedError<ManagedBrowserInvalidCommandError>()(
  "ManagedBrowserInvalidCommandError",
  { detail: Schema.String },
) {}

/** The child did not exit after shutdown, a kill, and a final wait. */
export class ManagedBrowserChildNotTerminatedError extends Schema.TaggedError<ManagedBrowserChildNotTerminatedError>()(
  "ManagedBrowserChildNotTerminatedError",
  { instanceId: ManagedBrowserInstanceId, pid: Schema.Number },
) {
  override get message(): string {
    return `Managed browser ${this.instanceId} (pid ${this.pid}) could not be proven to have exited.`;
  }
}

export class ManagedBrowserIpcConfigError extends Schema.TaggedError<ManagedBrowserIpcConfigError>()(
  "ManagedBrowserIpcConfigError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Invalid managed browser launcher configuration: ${this.detail}`;
  }
}

// ---------------------------------------------------------------------------
// Frame splitting
// ---------------------------------------------------------------------------

type SplitResult =
  | { readonly _tag: "lines"; readonly lines: ReadonlyArray<Uint8Array> }
  | { readonly _tag: "tooLarge" };

/**
 * Splits a byte stream into newline-delimited messages without ever holding more than
 * `maxBytes` of an unfinished one. A chunk may carry several messages or a fraction of one.
 * `strict` fails on an oversize message; otherwise the excess is dropped through to the newline.
 */
export const makeLineSplitter = (maxBytes: number, strict: boolean) => {
  let chunks: Uint8Array[] = [];
  let length = 0;
  let discarding = false;
  const flush = (): Uint8Array => {
    const line = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, length);
    chunks = [];
    length = 0;
    return line;
  };
  return {
    push: (data: Uint8Array): SplitResult => {
      const lines: Uint8Array[] = [];
      let start = 0;
      for (let index = 0; index <= data.length; index += 1) {
        const atEnd = index === data.length;
        if (!atEnd && data[index] !== 10) continue;
        const part = data.subarray(start, index);
        start = index + 1;
        if (!discarding) {
          const room = maxBytes - length;
          if (part.length > room) {
            if (strict) return { _tag: "tooLarge" };
            chunks.push(part.subarray(0, room));
            length = maxBytes;
            discarding = true;
          } else if (part.length > 0) {
            chunks.push(part);
            length += part.length;
          }
        }
        if (!atEnd) {
          if (length > 0) lines.push(flush());
          discarding = false;
        }
      }
      return { _tag: "lines", lines };
    },
  };
};

// ---------------------------------------------------------------------------
// Protocol schemas (mirror the engine's generated assets)
// ---------------------------------------------------------------------------

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Str = (maxLength: number, minLength = 0) =>
  minLength > 0
    ? Schema.String.check(Schema.isMinLength(minLength), Schema.isMaxLength(maxLength))
    : Schema.String.check(Schema.isMaxLength(maxLength));
const Int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const Num = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isBetween({ minimum, maximum }));
const Url = Str(65536, 1);
const Text = Str(262144);
const Base64 = Str(349528).check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);
const Sha256 = Str(64, 64).check(Schema.isPattern(/^[a-f0-9]{64}$/));
const FileName = Str(255, 1).check(Schema.isPattern(/^[^/\\\u0000]+$/));
const Button = Schema.Literals(["left", "middle", "right"]);
const Route = Schema.Literals(["direct", "vpn", "residential"]);

const Resource = Schema.Struct({
  instanceId: Id,
  profileId: Id,
  ownerEnvironmentId: Schema.optionalKey(Id),
  sessionId: Schema.optionalKey(Id),
  browserName: Schema.optionalKey(Id),
});
const Caller = Schema.Struct({
  environmentId: Id,
  threadId: Id,
  agentSessionId: Id,
  callerId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(Schema.Literals(["agent", "human", "supervisor"])),
});
const BrowserRef = Schema.Struct({
  instanceId: Id,
  profileId: Id,
  tabId: Id,
  incarnation: Id,
});
const Fence = Schema.Struct({ incarnation: Id, generation: Int() });
const Target = Schema.Struct({ ref: Id, documentId: Id });

const scoped = { resource: Resource, caller: Caller };
const fenced = { ...scoped, fence: Fence };

const lit = <const L extends string>(value: L) => Schema.Literal(value);

export const EngineOperation = Schema.Union([
  Schema.Struct({
    name: lit("navigate"),
    url: Url,
    waitUntil: Schema.Literals(["commit", "domcontentloaded", "load"]),
  }),
  Schema.Struct({ name: lit("snapshot"), format: Schema.Literals(["aria", "text", "html"]) }),
  Schema.Struct({
    name: lit("screenshot"),
    format: Schema.Literals(["png", "jpeg"]),
    fullPage: Schema.Boolean,
  }),
  Schema.Struct({ name: lit("click"), target: Target, button: Button }),
  Schema.Struct({ name: lit("fill"), target: Target, value: Text }),
  Schema.Struct({
    name: lit("type"),
    target: Target,
    value: Text,
    delayMs: Int(0, 1000),
  }),
  Schema.Struct({ name: lit("press"), target: Target, key: Str(128, 1) }),
  Schema.Struct({
    name: lit("select"),
    target: Target,
    values: Schema.Array(Text).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({ name: lit("check"), target: Target, checked: Schema.Boolean }),
  Schema.Struct({ name: lit("hover"), target: Target }),
  Schema.Struct({
    name: lit("evaluate"),
    expression: Str(65536, 1),
    argument: Schema.Unknown,
  }),
  Schema.Struct({
    name: lit("dialog"),
    dialogId: Id,
    accept: Schema.Boolean,
    promptText: Schema.optionalKey(Text),
  }),
  Schema.Struct({
    name: lit("upload"),
    target: Target,
    artifactIds: Schema.Array(Id).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    name: Schema.Literals(["console", "network"]),
    cursor: Schema.optionalKey(Int()),
    limit: Int(1, 500),
  }),
  Schema.Struct({
    name: lit("recording.start"),
    fps: Int(1, 30),
    maxDurationMs: Int(100, 60000),
  }),
  Schema.Struct({ name: lit("recording.stop"), recordingId: Id }),
]);
export type EngineOperation = typeof EngineOperation.Type;

export const EngineInput = Schema.Union([
  Schema.Struct({
    name: lit("pointer"),
    action: Schema.Literals(["move", "down", "up"]),
    x: Int(0, 16384),
    y: Int(0, 16384),
    button: Button,
  }),
  Schema.Struct({
    name: lit("wheel"),
    deltaX: Num(-100000, 100000),
    deltaY: Num(-100000, 100000),
  }),
  Schema.Struct({ name: lit("key"), action: Schema.Literals(["down", "up"]), key: Str(128, 1) }),
  Schema.Struct({ name: lit("text"), text: Text }),
  Schema.Struct({ name: lit("viewport"), width: Int(100, 4096), height: Int(100, 4096) }),
]);
export type EngineInput = typeof EngineInput.Type;

const upload = Schema.Union([
  Schema.Struct({
    ...fenced,
    action: lit("begin"),
    fileName: FileName,
    mimeType: Str(255, 1),
    sizeBytes: Int(0, 32 * 1024 * 1024),
    sha256: Sha256,
  }),
  Schema.Struct({
    ...fenced,
    action: lit("write"),
    artifactId: Id,
    offset: Int(),
    bytesBase64: Base64,
  }),
  Schema.Struct({ ...fenced, action: Schema.Literals(["finish", "release"]), artifactId: Id }),
]);

const download = Schema.Union([
  Schema.Struct({
    ...scoped,
    action: lit("read"),
    artifactId: Id,
    offset: Int(),
    length: Int(1, 256 * 1024),
  }),
  Schema.Struct({ ...scoped, action: lit("release"), artifactId: Id }),
]);

const ParameterSchemas = {
  hello: Schema.Struct({ protocolVersion: Schema.Literal(1), adapterVersion: Str(128, 1) }),
  open: Schema.Struct({
    ...fenced,
    tabId: Id,
    url: Url,
    route: Schema.optionalKey(Route),
    endpoint: Schema.optionalKey(Str(4096)),
  }),
  attach: Schema.Struct({ ...scoped, tabId: Id, endpoint: Schema.optionalKey(Str(4096)) }),
  execute: Schema.Struct({
    ...fenced,
    ref: BrowserRef,
    documentId: Id,
    operation: EngineOperation,
  }),
  subscribe: Schema.Struct({
    ...scoped,
    ref: BrowserRef,
    subscriptionId: Id,
    surface: Schema.Literals(["page", "window"]),
    maxFps: Int(1, 30),
    maxWidth: Int(100, 4096),
    maxHeight: Int(100, 4096),
  }),
  unsubscribe: Schema.Struct({ ...scoped, subscriptionId: Id }),
  ack: Schema.Struct({ ...scoped, subscriptionId: Id, frameId: Int() }),
  viewerInput: Schema.Struct({
    ...fenced,
    ref: BrowserRef,
    documentId: Id,
    subscriptionId: Id,
    input: EngineInput,
  }),
  upload,
  download,
  closeTab: Schema.Struct({ ...fenced, ref: BrowserRef }),
  shutdown: Schema.Struct({ requireIdle: Schema.Boolean }),
  setControlGeneration: Schema.Struct({ resource: Resource, incarnation: Id, generation: Int() }),
  releaseInputs: Schema.Struct({ resource: Resource, incarnation: Id }),
  quiesce: Schema.Struct({ requestAdmissionClosed: Schema.Boolean }),
} as const;
export type EngineMethod = keyof typeof ParameterSchemas;

const requestFrame = <M extends EngineMethod>(method: M) =>
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    kind: lit("request"),
    requestId: Id,
    deadlineMs: Int(),
    method: Schema.Literal(method),
    params: ParameterSchemas[method],
  });

/** Every request this launcher can write; anything else is refused before it reaches the pipe. */
export const EngineRequestFrame = Schema.Union([
  requestFrame("hello"),
  requestFrame("open"),
  requestFrame("attach"),
  requestFrame("execute"),
  requestFrame("subscribe"),
  requestFrame("unsubscribe"),
  requestFrame("ack"),
  requestFrame("viewerInput"),
  requestFrame("upload"),
  requestFrame("download"),
  requestFrame("closeTab"),
  requestFrame("shutdown"),
  requestFrame("setControlGeneration"),
  requestFrame("releaseInputs"),
  requestFrame("quiesce"),
]);

const Ok = Schema.Struct({ ok: Schema.Literal(true) });
const Artifact = Schema.Struct({
  artifactId: Id,
  fileName: FileName,
  mimeType: Str(255, 1),
  sizeBytes: Int(),
  sha256: Sha256,
});
const Tab = Schema.Struct({
  resource: Resource,
  ref: BrowserRef,
  documentId: Id,
  fence: Fence,
  url: Url,
  title: Str(4096),
});
const RefInfo = Schema.Struct({
  role: Str(128, 1),
  name: Schema.optionalKey(Str(8192)),
  nth: Schema.optionalKey(Int()),
});

const OperationResultSchemas = {
  click: Ok,
  fill: Ok,
  type: Ok,
  press: Ok,
  select: Ok,
  check: Ok,
  hover: Ok,
  dialog: Ok,
  upload: Ok,
  navigate: Tab,
  snapshot: Schema.Struct({
    documentId: Id,
    snapshot: Str(700000),
    refs: Schema.Record(Schema.String, RefInfo),
  }),
  screenshot: Artifact,
  evaluate: Schema.Struct({ value: Schema.Unknown }),
  console: Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({ sequence: Int(), level: Str(64), text: Str(8192) }),
    ).check(Schema.isMaxLength(500)),
    nextCursor: Int(),
  }),
  network: Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({
        sequence: Int(),
        url: Str(65536),
        method: Str(32),
        status: Int(0, 999),
        failed: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(500)),
    nextCursor: Int(),
  }),
  "recording.start": Schema.Struct({ recordingId: Id }),
  "recording.stop": Artifact,
} as const;

const Counts = Schema.Struct({
  actions: Int(),
  launches: Int(),
  navigations: Int(),
  viewers: Int(),
  recordings: Int(),
  uploads: Int(),
  downloads: Int(),
  dialogs: Int(),
  sharedSessions: Int(),
  externalContexts: Int(),
});

const HelloResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  packageVersion: Str(128, 1),
  incarnation: Id,
  capabilities: Schema.Array(Str(128, 1)).check(Schema.isMaxLength(128)),
  platform: Schema.Struct({ os: Id, arch: Id }),
});
export type EngineHelloResult = typeof HelloResult.Type;

const QuiesceResult = Schema.Struct({
  admissionClosed: Schema.Boolean,
  idle: Schema.Boolean,
  reasons: Schema.Array(Str(128)).check(Schema.isMaxLength(32)),
  counts: Counts,
});
export type EngineQuiesceResult = typeof QuiesceResult.Type;

const ExecuteResult = Schema.Union(Object.values(OperationResultSchemas));

const ResultSchemas = {
  hello: HelloResult,
  open: Tab,
  attach: Tab,
  execute: ExecuteResult,
  subscribe: Schema.Struct({ subscriptionId: Id }),
  unsubscribe: Schema.Struct({
    profileDeleted: Schema.Literal(false),
    tabClosed: Schema.Literal(false),
  }),
  ack: Ok,
  viewerInput: Ok,
  upload: Schema.Union([Artifact, Schema.Struct({ artifactId: Id }), Ok]),
  download: Schema.Union([
    Schema.Struct({ offset: Int(), bytesBase64: Base64, eof: Schema.Boolean }),
    Ok,
  ]),
  closeTab: Schema.Struct({ closed: Schema.Boolean }),
  shutdown: Ok,
  setControlGeneration: Schema.Struct({ incarnation: Id, generation: Int() }),
  releaseInputs: Ok,
  quiesce: QuiesceResult,
} as const satisfies Record<EngineMethod, Schema.Top>;

const EngineFailureBody = Schema.Struct({
  code: EngineErrorCode,
  message: Str(8192),
  retryable: Schema.Boolean,
});

/** The envelope of any response; the result is checked against the schema of the request it answers. */
const ResponseEnvelope = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    kind: lit("response"),
    requestId: Id,
    method: Str(128, 1),
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    kind: lit("response"),
    requestId: Id,
    method: Str(128, 1),
    ok: Schema.Literal(false),
    error: EngineFailureBody,
  }),
]);
export type EngineResponseFrame = typeof ResponseEnvelope.Type;

const eventFrame = <N extends string, F extends Schema.Struct.Fields>(name: N, fields: F) =>
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    kind: lit("event"),
    incarnation: Id,
    sequence: Int(),
    name: Schema.Literal(name),
    ...fields,
  });

export const EngineEventFrame = Schema.Union([
  eventFrame("tabOpened", {
    ...scoped,
    ref: BrowserRef,
    documentId: Id,
    openerTabId: Str(512),
    url: Url,
  }),
  eventFrame("tabChanged", {
    resource: Resource,
    ref: BrowserRef,
    documentId: Id,
    url: Url,
    title: Str(4096),
  }),
  eventFrame("tabClosed", { resource: Resource, ref: BrowserRef }),
  eventFrame("dialog", {
    ...scoped,
    ref: BrowserRef,
    documentId: Id,
    dialogId: Id,
    type: Schema.Literals(["alert", "beforeunload", "confirm", "prompt"]),
    message: Str(8192),
    defaultValue: Str(8192),
  }),
  eventFrame("download", { ...scoped, ref: BrowserRef, artifact: Artifact }),
  eventFrame("frame", {
    ...scoped,
    ref: BrowserRef,
    subscriptionId: Id,
    frameId: Int(),
    mimeType: lit("image/jpeg"),
    width: Int(1, 4096),
    height: Int(1, 4096),
    bytesBase64: Str(700000),
  }),
  eventFrame("viewerState", {
    ...scoped,
    subscriptionId: Id,
    state: Schema.Literals(["attached", "backpressured", "detached"]),
    reason: Str(512),
  }),
  eventFrame("ownerClosed", { resource: Resource, reason: Str(512) }),
]);
export type EngineEvent = typeof EngineEventFrame.Type;

const IncomingFrame = Schema.Union([ResponseEnvelope, EngineEventFrame]);

const strict = { onExcessProperty: "error" } as const;
const decodeIncoming = Schema.decodeUnknownExit(IncomingFrame, strict);
const decodeRequestFrame = Schema.decodeUnknownExit(EngineRequestFrame, strict);

/**
 * Checks a response result against the schema of the method it answers. For `execute` the
 * operation that was sent selects the exact result shape.
 */
export const decodeResult = (
  method: EngineMethod,
  operation: EngineOperation["name"] | undefined,
  result: unknown,
): Exit.Exit<unknown, Schema.SchemaError> => {
  const schema =
    method === "execute" && operation !== undefined
      ? OperationResultSchemas[operation]
      : ResultSchemas[method];
  return Schema.decodeUnknownExit(schema as Schema.Decoder<unknown>, strict)(result);
};

/** Exposed so a conformance test can run a frame through exactly the checks the reader applies. */
export const decodeIncomingFrame = (frame: unknown) => decodeIncoming(frame);
export const decodeRequestFrameForTest = (frame: unknown) => decodeRequestFrame(frame);

// ---------------------------------------------------------------------------
// Operation envelope (what the supervisor passes as `operation`)
// ---------------------------------------------------------------------------

/**
 * Who is calling, in the caller's own terms. `environmentId` is the caller's environment, which is
 * not the owner's when the call comes from another T3 server; the owner is named by the resource.
 */
const CallerContext = Schema.Struct({ environmentId: Id, threadId: Id, agentSessionId: Id });

/**
 * The T3 side of a managed-browser mutation. The supervisor treats it as opaque; this module
 * validates it and turns it into exactly one engine request. Requests that need no lease
 * (subscribe, download) are {@link ManagedBrowserScopedCommand}.
 */
export const ManagedBrowserEngineCommand = Schema.Union([
  Schema.Struct({
    kind: lit("open"),
    caller: CallerContext,
    tabId: Id,
    url: Url,
    route: Schema.optionalKey(Route),
    endpoint: Schema.optionalKey(Str(4096)),
  }),
  Schema.Struct({ kind: lit("attach"), caller: CallerContext, tabId: Id }),
  Schema.Struct({
    kind: lit("execute"),
    caller: CallerContext,
    tabId: Id,
    documentId: Id,
    operation: EngineOperation,
  }),
  Schema.Struct({
    kind: lit("viewerInput"),
    caller: CallerContext,
    tabId: Id,
    documentId: Id,
    subscriptionId: Id,
    input: EngineInput,
  }),
  Schema.Struct({ kind: lit("closeTab"), caller: CallerContext, tabId: Id }),
  // Uploads carry the lease's fence, so a takeover ends an upload the old controller had begun.
  Schema.Struct({
    kind: lit("uploadBegin"),
    caller: CallerContext,
    fileName: FileName,
    mimeType: Str(255, 1),
    sizeBytes: Int(0, 32 * 1024 * 1024),
    sha256: Sha256,
  }),
  Schema.Struct({
    kind: lit("uploadWrite"),
    caller: CallerContext,
    artifactId: Id,
    offset: Int(),
    bytesBase64: Base64,
  }),
  Schema.Struct({ kind: lit("uploadFinish"), caller: CallerContext, artifactId: Id }),
  Schema.Struct({ kind: lit("uploadRelease"), caller: CallerContext, artifactId: Id }),
]);
export type ManagedBrowserEngineCommand = typeof ManagedBrowserEngineCommand.Type;
const decodeCommand = Schema.decodeUnknownExit(ManagedBrowserEngineCommand, strict);

/**
 * Requests that need no lease and no fence: they observe or finish something the caller already
 * owns in the engine, which scopes every one of them by the caller it is told.
 */
export const ManagedBrowserScopedCommand = Schema.Union([
  Schema.Struct({
    kind: lit("subscribe"),
    caller: CallerContext,
    tabId: Id,
    subscriptionId: Id,
    surface: Schema.Literals(["page", "window"]),
    maxFps: Int(1, 30),
    maxWidth: Int(100, 4096),
    maxHeight: Int(100, 4096),
  }),
  Schema.Struct({ kind: lit("unsubscribe"), caller: CallerContext, subscriptionId: Id }),
  Schema.Struct({
    kind: lit("ack"),
    caller: CallerContext,
    subscriptionId: Id,
    frameId: Int(),
  }),
  Schema.Struct({
    kind: lit("downloadRead"),
    caller: CallerContext,
    artifactId: Id,
    offset: Int(),
    length: Int(1, 256 * 1024),
  }),
  Schema.Struct({ kind: lit("downloadRelease"), caller: CallerContext, artifactId: Id }),
]);
export type ManagedBrowserScopedCommand = typeof ManagedBrowserScopedCommand.Type;
const decodeScopedCommand = Schema.decodeUnknownExit(ManagedBrowserScopedCommand, strict);

/** The longest a single call may be given; recording stop is the longest the engine itself allows. */
export const MANAGED_BROWSER_MAX_CALL_DEADLINE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ManagedBrowserIpcTimeouts {
  /** How long the child has to answer `hello`. */
  readonly helloMs: number;
  /** The deadline given to an ordinary request. The engine caps its own browser work at 30 s. */
  readonly requestMs: number;
  /** Extra time past a deadline for the child's own deadline answer to arrive before it is called wedged. */
  readonly answerGraceMs: number;
  /** How long a drain barrier or a generation acknowledgement may take once a deadline has passed. */
  readonly drainMs: number;
  /** How long to wait for navigation the child still reports as committing. */
  readonly navigationSettleMs: number;
  /** Shutdown request, then the wait for a voluntary exit. */
  readonly gracefulExitMs: number;
  /** After SIGTERM, how long before SIGKILL. */
  readonly forceKillAfterMs: number;
  /** Final wait for the exit to be observed after SIGKILL. */
  readonly exitProofMs: number;
}

export const DEFAULT_MANAGED_BROWSER_IPC_TIMEOUTS: ManagedBrowserIpcTimeouts = {
  helloMs: 20_000,
  requestMs: 35_000,
  answerGraceMs: 5_000,
  drainMs: 40_000,
  navigationSettleMs: 30_000,
  gracefulExitMs: 5_000,
  forceKillAfterMs: 5_000,
  exitProofMs: 10_000,
};

export interface ManagedBrowserIpcOptions {
  /** Absolute path of the executable that runs the engine (Node, or the packaged binary). */
  readonly command: string;
  /** Arguments that precede the engine's own flags, such as the path of its entry script. */
  readonly args: ReadonlyArray<string>;
  /**
   * Chooses the executable and entry for each launch instead of fixing them when the launcher is made,
   * so a component update takes effect on the next child. A throw refuses that launch.
   */
  readonly resolveEngine?:
    | (() => {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      })
    | undefined;
  /** Absolute directory the engine keeps profiles in; it hashes each profile id into a subdirectory itself. */
  readonly dataRoot: string;
  /**
   * The complete environment of the child. It is never merged with T3's own, so credentials the
   * server holds do not reach the browser process.
   */
  readonly environment: Readonly<Record<string, string>>;
  readonly adapterVersion: string;
  readonly headless?: boolean;
  /**
   * Run Chrome headed on the engine's own private display, which is what makes the whole window
   * viewable. Mutually exclusive with `headless`; the engine refuses to start a desktop it cannot
   * build, so this is only set when the host has been checked for the tools it needs.
   */
  readonly desktop?: boolean;
  /**
   * Run Chrome headed on this computer's own screen (the Mac desktop app). It adds no mode flag, which is
   * the engine's headed default, and is refused together with either of the others so the intent is never ambiguous.
   */
  readonly native?: boolean;
  readonly embedded?: boolean;
  readonly embeddedEndpoint?: (
    instanceId: ManagedBrowserSupervisor.ManagedBrowserChildSpec["instanceId"],
    tabId: string,
    incarnation: string,
  ) => Effect.Effect<string, ManagedBrowserSupervisor.ManagedBrowserChildChannelError, Scope.Scope>;
  readonly browserExecutable?: string;
  readonly display?: string;
  readonly timeouts?: Partial<ManagedBrowserIpcTimeouts>;
  /** Operations a child must advertise in `hello` before it is allowed to serve. */
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

const REQUIRED_CAPABILITIES = ["open", "execute", "closeTab"] as const;

const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

const validateOptions = (options: ManagedBrowserIpcOptions) => {
  if (!isAbsolutePath(options.command)) return "command must be an absolute path";
  if (!isAbsolutePath(options.dataRoot)) return "dataRoot must be an absolute path";
  if (options.browserExecutable !== undefined && !isAbsolutePath(options.browserExecutable)) {
    return "browserExecutable must be an absolute path";
  }
  if (options.headless === true && options.desktop === true) {
    return "headless and desktop are mutually exclusive";
  }
  if (options.native === true && (options.headless === true || options.desktop === true)) {
    return "native is exclusive with headless and desktop";
  }
  if (
    options.embedded === true &&
    (options.native === true || options.headless === true || options.desktop === true)
  ) {
    return "embedded is exclusive with native, headless and desktop";
  }
  const owned = ["--data-root", "--incarnation"];
  for (const arg of options.args) {
    if (arg.startsWith("--remote-debugging")) return "a debugging port or pipe is never allowed";
    if (owned.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      return `${arg.split("=")[0]} is set by the launcher`;
    }
  }
  if (options.adapterVersion.length < 1 || options.adapterVersion.length > 128) {
    return "adapterVersion must be 1 to 128 characters";
  }
  return null;
};

// ---------------------------------------------------------------------------
// The launched child
// ---------------------------------------------------------------------------

export interface ManagedBrowserIpcChild extends ManagedBrowserSupervisor.ManagedBrowserChild {
  readonly pid: number;
  readonly hello: EngineHelloResult;
  /**
   * Lifecycle and frame events, validated and tied to this incarnation. A consumer that falls
   * behind loses the oldest events; they are advisory and the browser's state is re-read, not replayed.
   */
  readonly events: Stream.Stream<EngineEvent>;
  /**
   * Reports whether the child is idle and, when asked, closes its own admission. The launcher
   * remembers the last admission it asked for so its internal polling never reopens a closed one.
   */
  readonly quiesce: (
    requestAdmissionClosed: boolean,
  ) => Effect.Effect<EngineQuiesceResult, ManagedBrowserSupervisor.ManagedBrowserChildChannelError>;
}

type ChannelHealth =
  | { readonly _tag: "Healthy" }
  | { readonly _tag: "Broken"; readonly cause: ManagedBrowserProtocolError };

interface PendingRequest {
  readonly method: EngineMethod;
  readonly deferred: Deferred.Deferred<EngineResponseFrame, ManagedBrowserProtocolError>;
}

type Exchange =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ManagedBrowserEngineError };

/** Operations that may start a navigation they do not wait for. */
const MAY_NAVIGATE = new Set<string>([
  "navigate",
  "click",
  "press",
  "fill",
  "type",
  "select",
  "check",
  "upload",
  "dialog",
]);

const protocol = (
  reason: ManagedBrowserProtocolError["reason"],
  detail: string,
): ManagedBrowserProtocolError => new ManagedBrowserProtocolError({ reason, detail });

const isProtocolError = Schema.is(ManagedBrowserProtocolError);
const parseJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

/** Null when the bytes are not valid UTF-8. */
const decodeUtf8Strict = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const sanitize = (text: string, limit = 300) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

export interface ManagedBrowserIpcLauncher {
  readonly launch: (
    spec: ManagedBrowserSupervisor.ManagedBrowserChildSpec,
  ) => Effect.Effect<
    ManagedBrowserIpcChild,
    ManagedBrowserSupervisor.ManagedBrowserChildLaunchError,
    Scope.Scope
  >;
}

export const makeLauncher = (
  options: ManagedBrowserIpcOptions,
): Effect.Effect<
  ManagedBrowserIpcLauncher,
  ManagedBrowserIpcConfigError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const invalid = validateOptions(options);
    if (invalid !== null) return yield* new ManagedBrowserIpcConfigError({ detail: invalid });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const timeouts = { ...DEFAULT_MANAGED_BROWSER_IPC_TIMEOUTS, ...options.timeouts };
    const required = [
      ...new Set([
        ...(options.requiredCapabilities ?? REQUIRED_CAPABILITIES),
        ...(options.embedded === true ? ["embedded-page"] : []),
      ]),
    ];

    const launch: ManagedBrowserIpcLauncher["launch"] = (spec) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const { instanceId } = spec;
        const channelError = (cause: unknown) =>
          new ManagedBrowserSupervisor.ManagedBrowserChildChannelError({ instanceId, cause });

        const engine = yield* Effect.try({
          try: () => options.resolveEngine?.() ?? options,
          catch: (cause) =>
            new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({ instanceId, cause }),
        });
        const invalidEngine = validateOptions({ ...options, ...engine });
        if (invalidEngine !== null) {
          return yield* new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({
            instanceId,
            cause: new ManagedBrowserIpcConfigError({ detail: invalidEngine }),
          });
        }
        const args = [
          ...engine.args,
          "--data-root",
          options.dataRoot,
          "--incarnation",
          spec.incarnation,
          ...(options.headless === true ? ["--headless"] : []),
          ...(options.desktop === true ? ["--desktop"] : []),
          ...(options.embedded === true ? ["--embedded"] : []),
          ...(options.browserExecutable === undefined
            ? []
            : ["--browser-executable", options.browserExecutable]),
          ...(options.display === undefined ? [] : ["--display", options.display]),
        ];
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(engine.command, args, {
              env: { ...options.environment },
              extendEnv: false,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter: timeouts.forceKillAfterMs,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({ instanceId, cause }),
            ),
          );

        const resource = {
          instanceId: spec.instanceId,
          profileId: spec.profileId,
          ownerEnvironmentId: spec.ownerEnvironmentId,
        };

        const health = yield* Ref.make<ChannelHealth>({ _tag: "Healthy" });
        const closing = yield* Ref.make(false);
        const counter = yield* Ref.make(0);
        const pending = yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map());
        const writes = yield* Queue.bounded<Uint8Array>(MANAGED_BROWSER_IPC_LIMITS.outstanding + 8);
        const events = yield* PubSub.sliding<EngineEvent>(256);
        const exited = yield* Deferred.make<ManagedBrowserSupervisor.ManagedBrowserChildExit>();
        const admissionClosed = yield* Ref.make(false);
        const lastSequence = yield* Ref.make(0);
        const stderrTail = yield* Ref.make("");

        // --- failure handling -------------------------------------------------

        const failPending = (cause: ManagedBrowserProtocolError) =>
          Ref.getAndSet(pending, new Map()).pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(
                [...entries.values()],
                (entry) => Deferred.fail(entry.deferred, cause),
                {
                  discard: true,
                },
              ),
            ),
          );

        /** Ends the process and proves it gone, without making the caller wait for that. */
        const terminate = handle
          .kill({ killSignal: "SIGTERM", forceKillAfter: timeouts.forceKillAfterMs })
          .pipe(Effect.ignore);

        /** Breaks the channel exactly once: waiters fail, the child is terminated. */
        const wedge = (cause: ManagedBrowserProtocolError) =>
          Ref.modify(health, (current): readonly [boolean, ChannelHealth] =>
            current._tag === "Broken" ? [false, current] : [true, { _tag: "Broken", cause }],
          ).pipe(
            Effect.flatMap((first) =>
              first
                ? failPending(cause).pipe(
                    Effect.andThen(Queue.shutdown(writes)),
                    Effect.andThen(Effect.forkIn(terminate, scope)),
                    Effect.asVoid,
                  )
                : Effect.void,
            ),
          );

        // --- reading ----------------------------------------------------------

        const resolveResponse = (frame: EngineResponseFrame) =>
          Ref.modify(pending, (current) => {
            const entry = current.get(frame.requestId);
            if (entry === undefined) return [undefined, current] as const;
            const next = new Map(current);
            next.delete(frame.requestId);
            return [entry, next] as const;
          }).pipe(
            Effect.flatMap((entry) => {
              if (entry === undefined) {
                return Effect.fail(
                  protocol("unknownResponse", `no request ${sanitize(frame.requestId)} is waiting`),
                );
              }
              if (entry.method !== frame.method) {
                return Deferred.fail(
                  entry.deferred,
                  protocol("methodMismatch", `${entry.method} was answered as ${frame.method}`),
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      protocol("methodMismatch", `${entry.method} was answered as ${frame.method}`),
                    ),
                  ),
                );
              }
              return Deferred.succeed(entry.deferred, frame);
            }),
          );

        const handleLine = (line: Uint8Array) =>
          Effect.gen(function* () {
            const text = decodeUtf8Strict(line);
            if (text === null) {
              return yield* protocol("invalidUtf8", "stdout carried invalid UTF-8");
            }
            const parsed = parseJson(text);
            if (Exit.isFailure(parsed)) {
              return yield* protocol("invalidJson", sanitize(text));
            }
            const decoded = decodeIncoming(parsed.value);
            if (Exit.isFailure(decoded)) {
              return yield* protocol("invalidFrame", sanitize(String(decoded.cause)));
            }
            const frame = decoded.value;
            if (frame.kind === "response") return yield* resolveResponse(frame);
            if (frame.incarnation !== spec.incarnation) {
              return yield* protocol(
                "incarnationMismatch",
                `event from ${sanitize(frame.incarnation)}, expected ${spec.incarnation}`,
              );
            }
            const previous = yield* Ref.getAndSet(lastSequence, frame.sequence);
            if (frame.sequence <= previous) {
              return yield* protocol("eventOrder", `sequence ${frame.sequence} after ${previous}`);
            }
            yield* PubSub.publish(events, frame);
          });

        const splitter = makeLineSplitter(MANAGED_BROWSER_IPC_LIMITS.messageBytes, true);
        const readStdout = handle.stdout.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              const split = splitter.push(chunk);
              if (split._tag === "tooLarge") {
                return yield* protocol("frameTooLarge", "a message exceeded 1 MiB");
              }
              for (const line of split.lines) yield* handleLine(line);
            }),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              isProtocolError(error)
                ? wedge(error)
                : wedge(protocol("stdoutClosed", `stdout failed: ${String(error)}`)),
            onSuccess: () =>
              Ref.get(closing).pipe(
                Effect.flatMap((isClosing) =>
                  isClosing ? Effect.void : wedge(protocol("stdoutClosed", "stdout ended")),
                ),
              ),
          }),
        );

        const stderrSplitter = makeLineSplitter(MANAGED_BROWSER_IPC_LIMITS.stderrLineBytes, false);
        const readStderr = handle.stderr.pipe(
          Stream.runForEach((chunk) => {
            const split = stderrSplitter.push(chunk);
            if (split._tag !== "lines") return Effect.void;
            return Effect.forEach(
              split.lines,
              (line) => {
                const text = new TextDecoder("utf-8").decode(line);
                return Ref.update(stderrTail, (current) => `${current}${text}\n`.slice(-4096)).pipe(
                  Effect.andThen(
                    Effect.logDebug("managed browser stderr").pipe(
                      Effect.annotateLogs({ instanceId, line: text }),
                    ),
                  ),
                );
              },
              { discard: true },
            );
          }),
          Effect.ignore,
        );

        const watchExit = handle.exitCode.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              const asked = yield* Ref.get(closing);
              const code = Exit.isSuccess(exit) ? Number(exit.value) : null;
              yield* wedge(
                protocol("exited", code === null ? "terminated by signal" : `exit code ${code}`),
              );
              yield* Deferred.succeed(exited, { clean: asked && code === 0 });
            }),
          ),
        );

        // --- writing ----------------------------------------------------------

        const writeLoop = Stream.fromQueue(writes).pipe(
          Stream.run(handle.stdin),
          Effect.matchEffect({
            onFailure: (cause) => wedge(protocol("closed", `stdin failed: ${String(cause)}`)),
            onSuccess: () => Effect.void,
          }),
        );

        yield* Effect.forkIn(readStdout, scope);
        yield* Effect.forkIn(readStderr, scope);
        yield* Effect.forkIn(writeLoop, scope);
        yield* Effect.forkIn(watchExit, scope);

        // --- scoped termination -----------------------------------------------
        // Registered after the fibers above, so it runs before they are interrupted.

        const stillRunning = Deferred.isDone(exited).pipe(Effect.map((done) => !done));
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Ref.set(closing, true);
            if (yield* stillRunning) {
              const healthy = (yield* Ref.get(health))._tag === "Healthy";
              if (healthy) {
                yield* exchange(
                  "shutdown",
                  { requireIdle: false },
                  timeouts.gracefulExitMs,
                  undefined,
                ).pipe(Effect.ignore);
              }
              const voluntary = yield* Deferred.await(exited).pipe(
                Effect.timeoutOption(timeouts.gracefulExitMs),
              );
              if (Option.isNone(voluntary)) yield* terminate;
            }
            const proven = yield* Deferred.await(exited).pipe(
              Effect.timeoutOption(timeouts.exitProofMs),
            );
            if (Option.isNone(proven)) {
              return yield* Effect.die(
                new ManagedBrowserChildNotTerminatedError({ instanceId, pid: Number(handle.pid) }),
              );
            }
          }),
        );

        // --- requests ---------------------------------------------------------

        const exchange = (
          method: EngineMethod,
          params: unknown,
          timeoutMs: number,
          operation: EngineOperation["name"] | undefined,
        ): Effect.Effect<Exchange, ManagedBrowserSupervisor.ManagedBrowserChildChannelError> =>
          Effect.gen(function* () {
            const current = yield* Ref.get(health);
            if (current._tag === "Broken") return yield* channelError(current.cause);
            const now = yield* Clock.currentTimeMillis;
            const requestId = `r${yield* Ref.updateAndGet(counter, (value) => value + 1)}`;
            const frame = {
              protocolVersion: PROTOCOL_VERSION,
              kind: "request",
              requestId,
              deadlineMs: now + timeoutMs,
              method,
              params,
            };
            const checked = decodeRequestFrame(frame);
            if (Exit.isFailure(checked)) {
              return yield* channelError(
                new ManagedBrowserInvalidCommandError({ detail: sanitize(String(checked.cause)) }),
              );
            }
            const encoded = encodeJson(frame);
            if (Exit.isFailure(encoded)) {
              return yield* channelError(
                new ManagedBrowserInvalidCommandError({ detail: sanitize(String(encoded.cause)) }),
              );
            }
            const line = Buffer.from(`${encoded.value}\n`);
            if (line.length - 1 > MANAGED_BROWSER_IPC_LIMITS.messageBytes) {
              return yield* channelError(protocol("frameTooLarge", `${method} exceeds 1 MiB`));
            }
            const deferred = yield* Deferred.make<
              EngineResponseFrame,
              ManagedBrowserProtocolError
            >();
            const registered = yield* Ref.modify(pending, (entries) => {
              if (entries.size >= MANAGED_BROWSER_IPC_LIMITS.outstanding) {
                return [false, entries] as const;
              }
              return [true, new Map(entries).set(requestId, { method, deferred })] as const;
            });
            if (!registered) {
              return yield* channelError(protocol("busy", "128 requests are already outstanding"));
            }
            const offered = yield* Queue.offer(writes, line).pipe(Effect.exit);
            if (Exit.isFailure(offered)) {
              yield* Ref.update(pending, (entries) => {
                const next = new Map(entries);
                next.delete(requestId);
                return next;
              });
              return yield* channelError(protocol("closed", "the pipe is closed"));
            }
            const answered = yield* Deferred.await(deferred).pipe(
              Effect.timeoutOption(timeoutMs + timeouts.answerGraceMs),
              Effect.mapError(channelError),
            );
            if (Option.isNone(answered)) {
              const silent = protocol(
                "deadlineNotAnswered",
                `${method} was not answered ${timeouts.answerGraceMs} ms after its deadline`,
              );
              yield* wedge(silent);
              return yield* channelError(silent);
            }
            const response = answered.value;
            if (!response.ok) {
              return {
                ok: false,
                error: new ManagedBrowserEngineError({
                  method,
                  code: response.error.code,
                  message: response.error.message,
                  retryable: response.error.retryable,
                }),
              } satisfies Exchange;
            }
            const result = decodeResult(method, operation, response.result);
            if (Exit.isFailure(result)) {
              const bad = protocol("invalidResult", `${method}: ${sanitize(String(result.cause))}`);
              yield* wedge(bad);
              return yield* channelError(bad);
            }
            return { ok: true, result: result.value } satisfies Exchange;
          });

        /** Success, or the engine's refusal as a channel error. */
        const succeed = (
          method: EngineMethod,
          params: unknown,
          timeoutMs: number,
          operation?: EngineOperation["name"],
        ) =>
          exchange(method, params, timeoutMs, operation).pipe(
            Effect.flatMap((outcome) =>
              outcome.ok
                ? Effect.succeed(outcome.result)
                : Effect.fail(channelError(outcome.error)),
            ),
          );

        // --- handshake --------------------------------------------------------

        const hello = yield* succeed(
          "hello",
          { protocolVersion: PROTOCOL_VERSION, adapterVersion: options.adapterVersion },
          timeouts.helloMs,
        ).pipe(
          Effect.map((result) => result as EngineHelloResult),
          Effect.mapError(
            (error) =>
              new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({
                instanceId,
                cause: error.cause,
              }),
          ),
        );
        if (hello.incarnation !== spec.incarnation) {
          return yield* new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({
            instanceId,
            cause: protocol(
              "helloMismatch",
              `child reports incarnation ${sanitize(hello.incarnation)}, expected ${spec.incarnation}`,
            ),
          });
        }
        const missing = required.filter((name) => !hello.capabilities.includes(name));
        if (missing.length > 0) {
          return yield* new ManagedBrowserSupervisor.ManagedBrowserChildLaunchError({
            instanceId,
            cause: protocol("capability", `child does not advertise ${missing.join(", ")}`),
          });
        }

        // --- operations -------------------------------------------------------

        const quiesce = (requestAdmissionClosed: boolean) =>
          Ref.set(admissionClosed, requestAdmissionClosed).pipe(
            Effect.andThen(succeed("quiesce", { requestAdmissionClosed }, timeouts.requestMs)),
            Effect.map((result) => result as EngineQuiesceResult),
          );

        /** Waits until the child reports no navigation still committing. */
        const settleNavigation = Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          for (;;) {
            const desired = yield* Ref.get(admissionClosed);
            const status = yield* succeed(
              "quiesce",
              { requestAdmissionClosed: desired },
              timeouts.requestMs,
            ).pipe(Effect.map((result) => result as EngineQuiesceResult));
            if (status.counts.navigations === 0) return;
            const waited = (yield* Clock.currentTimeMillis) - started;
            if (waited >= timeouts.navigationSettleMs) {
              return yield* channelError(
                protocol(
                  "navigationNotSettled",
                  `a navigation was still committing after ${waited} ms`,
                ),
              );
            }
            yield* Effect.sleep(50);
          }
        });

        /**
         * A deadline answer does not mean the work stopped. A request queued behind it is answered
         * only once the child has finished everything ahead of it, so wait for that answer; a child
         * that cannot give it is wedged and is terminated.
         */
        const drainAfterDeadline = exchange(
          "releaseInputs",
          { resource, incarnation: spec.incarnation },
          timeouts.drainMs,
          undefined,
        ).pipe(
          Effect.flatMap((outcome) =>
            outcome.ok
              ? Effect.void
              : (() => {
                  const stuck = protocol(
                    "deadlineNotDrained",
                    `the child could not drain work past its deadline: ${outcome.error.code}`,
                  );
                  return wedge(stuck);
                })(),
          ),
          Effect.ignore,
        );

        const buildWire = (
          request: ManagedBrowserSupervisor.ManagedBrowserChildRequest,
          command: ManagedBrowserEngineCommand,
        ) => {
          const caller = {
            environmentId: command.caller.environmentId,
            threadId: command.caller.threadId,
            agentSessionId: command.caller.agentSessionId,
            callerId: request.callerId,
            kind: request.callerKind,
          };
          const fence = {
            incarnation: request.fence.incarnation,
            generation: Number(request.fence.generation),
          };
          // Uploads name no tab, and none of them reads `ref`.
          const ref = {
            instanceId: spec.instanceId,
            profileId: spec.profileId,
            tabId: "tabId" in command ? command.tabId : "",
            incarnation: spec.incarnation,
          };
          switch (command.kind) {
            case "open":
              return {
                method: "open" as const,
                operation: undefined,
                params: {
                  resource,
                  caller,
                  fence,
                  tabId: command.tabId,
                  url: command.url,
                  ...(command.route === undefined ? {} : { route: command.route }),
                },
              };
            case "attach":
              return {
                method: "attach" as const,
                operation: undefined,
                params: { resource, caller, tabId: command.tabId },
              };
            case "execute":
              return {
                method: "execute" as const,
                operation: command.operation.name,
                params: {
                  resource,
                  caller,
                  fence,
                  ref,
                  documentId: command.documentId,
                  operation: command.operation,
                },
              };
            case "viewerInput":
              return {
                method: "viewerInput" as const,
                operation: undefined,
                params: {
                  resource,
                  caller,
                  fence,
                  ref,
                  documentId: command.documentId,
                  subscriptionId: command.subscriptionId,
                  input: command.input,
                },
              };
            case "closeTab":
              return {
                method: "closeTab" as const,
                operation: undefined,
                params: { resource, caller, fence, ref },
              };
            case "uploadBegin":
              return {
                method: "upload" as const,
                operation: undefined,
                params: {
                  resource,
                  caller,
                  fence,
                  action: "begin" as const,
                  fileName: command.fileName,
                  mimeType: command.mimeType,
                  sizeBytes: command.sizeBytes,
                  sha256: command.sha256,
                },
              };
            case "uploadWrite":
              return {
                method: "upload" as const,
                operation: undefined,
                params: {
                  resource,
                  caller,
                  fence,
                  action: "write" as const,
                  artifactId: command.artifactId,
                  offset: command.offset,
                  bytesBase64: command.bytesBase64,
                },
              };
            case "uploadFinish":
            case "uploadRelease":
              return {
                method: "upload" as const,
                operation: undefined,
                params: {
                  resource,
                  caller,
                  fence,
                  action:
                    command.kind === "uploadFinish" ? ("finish" as const) : ("release" as const),
                  artifactId: command.artifactId,
                },
              };
          }
        };

        /** One call's own time limit, or the launcher default; a limit that cannot work is refused. */
        const callDeadline = (requested: number | undefined) =>
          requested === undefined
            ? Effect.succeed(timeouts.requestMs)
            : Number.isInteger(requested) &&
                requested >= 1 &&
                requested <= MANAGED_BROWSER_MAX_CALL_DEADLINE_MS
              ? Effect.succeed(requested)
              : channelError(
                  new ManagedBrowserInvalidCommandError({
                    detail: `deadlineMs must be an integer from 1 to ${MANAGED_BROWSER_MAX_CALL_DEADLINE_MS}`,
                  }),
                );

        const execute: ManagedBrowserSupervisor.ManagedBrowserChild["execute"] = (request) =>
          Effect.gen(function* () {
            const decoded = decodeCommand(request.operation);
            if (Exit.isFailure(decoded)) {
              return yield* channelError(
                new ManagedBrowserInvalidCommandError({ detail: sanitize(String(decoded.cause)) }),
              );
            }
            const command = decoded.value;
            if (
              request.ref.instanceId !== spec.instanceId ||
              request.ref.profileId !== spec.profileId ||
              request.ref.incarnation !== spec.incarnation ||
              request.fence.incarnation !== spec.incarnation ||
              (request.ref.tabId !== undefined &&
                "tabId" in command &&
                request.ref.tabId !== command.tabId)
            ) {
              return yield* channelError(
                protocol("identityMismatch", "the request does not name this child's browser"),
              );
            }
            const callMs = yield* callDeadline(request.deadlineMs);
            const wire = buildWire(request, command);
            const endpoint =
              options.embeddedEndpoint && (command.kind === "open" || command.kind === "attach")
                ? yield* options
                    .embeddedEndpoint(spec.instanceId, command.tabId, spec.incarnation)
                    .pipe(Scope.provide(scope))
                : undefined;
            const outcome = yield* exchange(
              wire.method,
              endpoint === undefined ? wire.params : { ...wire.params, endpoint },
              callMs,
              wire.operation,
            );
            if (!outcome.ok) {
              if (outcome.error.code === "deadline_exceeded") yield* drainAfterDeadline;
              return yield* channelError(outcome.error);
            }
            const navigates =
              command.kind === "execute" && MAY_NAVIGATE.has(command.operation.name);
            return {
              value: outcome.result,
              pending: navigates ? settleNavigation : undefined,
            };
          });

        const scopedCall: ManagedBrowserSupervisor.ManagedBrowserChild["scoped"] = (request) =>
          Effect.gen(function* () {
            const decoded = decodeScopedCommand(request.operation);
            if (Exit.isFailure(decoded)) {
              return yield* channelError(
                new ManagedBrowserInvalidCommandError({ detail: sanitize(String(decoded.cause)) }),
              );
            }
            const command = decoded.value;
            if (
              request.ref.instanceId !== spec.instanceId ||
              request.ref.profileId !== spec.profileId ||
              request.ref.incarnation !== spec.incarnation
            ) {
              return yield* channelError(
                protocol("identityMismatch", "the request does not name this child's browser"),
              );
            }
            const callMs = yield* callDeadline(request.deadlineMs);
            const caller = {
              environmentId: command.caller.environmentId,
              threadId: command.caller.threadId,
              agentSessionId: command.caller.agentSessionId,
              callerId: request.callerId,
              kind: request.callerKind,
            };
            const wire = (() => {
              switch (command.kind) {
                case "subscribe":
                  return {
                    method: "subscribe" as const,
                    params: {
                      resource,
                      caller,
                      ref: {
                        instanceId: spec.instanceId,
                        profileId: spec.profileId,
                        tabId: command.tabId,
                        incarnation: spec.incarnation,
                      },
                      subscriptionId: command.subscriptionId,
                      surface: command.surface,
                      maxFps: command.maxFps,
                      maxWidth: command.maxWidth,
                      maxHeight: command.maxHeight,
                    },
                  };
                case "unsubscribe":
                  return {
                    method: "unsubscribe" as const,
                    params: { resource, caller, subscriptionId: command.subscriptionId },
                  };
                case "ack":
                  return {
                    method: "ack" as const,
                    params: {
                      resource,
                      caller,
                      subscriptionId: command.subscriptionId,
                      frameId: command.frameId,
                    },
                  };
                case "downloadRead":
                  return {
                    method: "download" as const,
                    params: {
                      resource,
                      caller,
                      action: "read" as const,
                      artifactId: command.artifactId,
                      offset: command.offset,
                      length: command.length,
                    },
                  };
                case "downloadRelease":
                  return {
                    method: "download" as const,
                    params: {
                      resource,
                      caller,
                      action: "release" as const,
                      artifactId: command.artifactId,
                    },
                  };
              }
            })();
            // Nothing here is lease-bound work, so a deadline answer needs no drain barrier.
            return yield* succeed(wire.method, wire.params, callMs);
          });

        const setGeneration: ManagedBrowserSupervisor.ManagedBrowserChild["setGeneration"] = (
          generation,
        ) =>
          Effect.gen(function* () {
            const outcome = yield* exchange(
              "setControlGeneration",
              { resource, incarnation: spec.incarnation, generation: Number(generation) },
              timeouts.drainMs,
              undefined,
            );
            if (!outcome.ok) {
              if (outcome.error.code === "deadline_exceeded") {
                yield* wedge(
                  protocol(
                    "generationNotAcknowledged",
                    `generation ${generation} was not acknowledged before its deadline`,
                  ),
                );
              }
              return yield* channelError(outcome.error);
            }
            const result = outcome.result as { incarnation: string; generation: number };
            if (
              result.incarnation !== spec.incarnation ||
              result.generation !== Number(generation)
            ) {
              const bad = protocol(
                "generationNotAcknowledged",
                `child acknowledged ${result.incarnation}/${result.generation}`,
              );
              yield* wedge(bad);
              return yield* channelError(bad);
            }
          });

        const releaseInput = succeed(
          "releaseInputs",
          { resource, incarnation: spec.incarnation },
          timeouts.requestMs,
        ).pipe(Effect.asVoid);

        const child: ManagedBrowserIpcChild = {
          pid: Number(handle.pid),
          hello,
          capabilities: hello.capabilities,
          events: Stream.fromPubSub(events),
          quiesce,
          scoped: scopedCall,
          execute,
          setGeneration,
          releaseInput,
          exit: Deferred.await(exited),
        };
        return child;
      });

    return { launch };
  });

/**
 * Provides the supervisor's launcher port with the real child process. The returned child is
 * also an {@link ManagedBrowserIpcChild}, for callers that need its events or `quiesce`.
 */
export const layer = (options: ManagedBrowserIpcOptions) =>
  Layer.effect(
    ManagedBrowserSupervisor.ManagedBrowserChildLauncher,
    makeLauncher(options).pipe(
      Effect.map((launcher) =>
        ManagedBrowserSupervisor.ManagedBrowserChildLauncher.of({ launch: launcher.launch }),
      ),
    ),
  );
