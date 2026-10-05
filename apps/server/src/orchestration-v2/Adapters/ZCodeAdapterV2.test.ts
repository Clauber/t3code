import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import { zcodeConfigModels } from "../../provider/ZCodeModels.ts";
import type { ZCodeCatalogProbeResult } from "./ZCodeCatalogProbe.ts";
import {
  makeZCodeAdapterV2,
  zcodePermissionOptionResponse,
  type ZCodeAdapterV2Options,
} from "./ZCodeAdapterV2.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-zcode-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, serverConfigLayer);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const INSTANCE_ID = ProviderInstanceId.make("zcode");
const THREAD_ID = ThreadId.make("thread-zcode-test");
const SESSION_ID = ProviderSessionId.make("provider-session-zcode-test");
const FAKE_SESSION = "sess_fake_1";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_998;

type Rec = Record<string, unknown>;

const policy = (runtimeMode: RuntimeMode = "approval-required") =>
  ProviderAdapterV2RuntimePolicy.make({ runtimeMode, interactionMode: "default", cwd: null });

const selection = (model: string, options?: ModelSelection["options"]): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model,
  ...(options === undefined ? {} : { options }),
});

const CONFIG_WITH_GHOST = {
  config: {
    providerOrder: ["ghost"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "ghost",
          providerName: "Ghost",
          config: { modelOrder: ["kiro/claude-opus-5", "gone"], personalModelIds: ["plain"] },
        },
      ],
    },
  },
};

const ALLOW_ONCE = { decision: "allow", reason: "Approved once" };
const ALLOW_PROJECT = {
  decision: "allow",
  permissionUpdates: [{ behavior: "allow", type: "addRules" }],
  reason: "Approved for this project",
};
const DENY = { decision: "deny", reason: "rejected" };
const PERMISSION_OPTIONS = [
  { kind: "allow_once", optionId: "allow_once", response: ALLOW_ONCE },
  { kind: "allow_always", optionId: "allow_project", response: ALLOW_PROJECT },
  { kind: "deny", optionId: "deny", response: DENY },
];

/** Settings snapshot shape recorded from zcode 0.16.9's `session/subscribe`. */
const SETTINGS_MODEL = {
  available: [
    {
      ref: { providerId: "zai-fake", modelId: "glm-5.3-flash" },
      label: "glm-5.3-flash",
      contextWindow: 200000,
      reasoning: {
        levels: [{ value: "low" }, { value: "high" }, { value: "max" }],
        defaultLevel: "max",
      },
    },
  ],
  current: { providerId: "zai-fake", modelId: "glm-5.3-flash", options: { reasoningLevel: "max" } },
};

/**
 * In-process fake `zcode app-server`: answers the session/* surface like the
 * real CLI, captures every client record, and lets tests push session events
 * and server→client requests.
 */
const makeFakeZCode = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const calls = yield* Queue.unbounded<Rec>();
  const answers = yield* Queue.unbounded<Rec>();
  const allCalls: Array<Rec> = [];
  let stdinBuffer = "";
  let refuseResume = false;
  let holdSend = false;
  /** slug → "missing", or the only reasoning level zcode accepts for it. */
  const modelRules = new Map<string, string>();
  let seq = 1;

  const write = (record: Rec) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );
  const event = (type: string, payload: Rec) =>
    write({
      method: "session/event",
      params: {
        deliveryKind: "desktop-continuous",
        type,
        payload,
        seq: seq++,
        sessionId: FAKE_SESSION,
      },
    });

  const sessionResult = (params: unknown) => ({
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: FAKE_SESSION,
      mode: (params as Rec | undefined)?.["mode"] ?? "build",
    },
  });

  const reply = (record: Rec): Rec | null => {
    const id = record["id"];
    switch (record["method"]) {
      case "session/create":
        return { id, result: sessionResult(record["params"]) };
      case "session/resume":
        return refuseResume
          ? { id, error: { code: -32602, message: "no such session" } }
          : { id, result: sessionResult(record["params"]) };
      case "session/subscribe":
        return {
          id,
          result: {
            sessionId: FAKE_SESSION,
            eventSeq: 0,
            events: [],
            snapshot: { settings: { model: SETTINGS_MODEL } },
          },
        };
      case "session/send":
        if (holdSend) return null;
        return { id, result: { accepted: true, inputId: "in-1" } };
      case "session/setModel": {
        const params = record["params"] as Rec;
        const model = params["model"] as Rec;
        const level = (model["options"] as Rec | undefined)?.["reasoningLevel"];
        const rule = modelRules.get(`${String(model["providerId"])}/${String(model["modelId"])}`);
        if (rule === "missing") {
          return { id, error: { code: -32603, message: `Provider Registry 中不存在 Model` } };
        }
        if (rule !== undefined && level !== rule) {
          return { id, error: { code: -32603, message: "Reasoning level is required" } };
        }
        return { id, result: {} };
      }
      default:
        return { id, result: {} };
    }
  };

  const handleChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as Rec;
        if (record["method"] === undefined) {
          yield* Queue.offer(answers, record);
          continue;
        }
        allCalls.push(record);
        yield* Queue.offer(calls, record);
        const response = reply(record);
        if (response !== null) yield* write(response);
      }
    });

  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

  const takeCall = (method: string) =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(calls);
        if (record["method"] === method) return record;
      }
    });

  const takeAnswer = (id: string) =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(answers);
        if (record["id"] === id) return record;
      }
    });

  return {
    spawner,
    write,
    event,
    takeCall,
    takeAnswer,
    allCalls: () => allCalls,
    setModelRule: (slug: string, rule: string) => {
      modelRules.set(slug, rule);
    },
    holdSends: () => {
      holdSend = true;
    },
    refuseNextResume: () => {
      refuseResume = true;
    },
  };
});
type FakeZCode = Effect.Success<typeof makeFakeZCode>;

const openRuntime = Effect.fnUntraced(function* (
  fake: FakeZCode,
  model = "default",
  extra: Pick<ZCodeAdapterV2Options, "knownModels" | "modelValidation"> = {},
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const adapter = makeZCodeAdapterV2({
    instanceId: INSTANCE_ID,
    settings: { enabled: true, binaryPath: "zcode", customModels: [] },
    environment: {},
    spawner: fake.spawner,
    idAllocator,
    serverConfig,
    ...extra,
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: selection(model),
    runtimePolicy: policy(),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = <E extends ProviderAdapterV2Event>(
    predicate: (event: ProviderAdapterV2Event) => event is E,
  ) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  options: {
    readonly model?: ModelSelection;
    readonly runtimeMode?: RuntimeMode;
    readonly runOrdinal?: number;
  } = {},
) {
  const now = yield* DateTime.now;
  const runOrdinal = options.runOrdinal ?? 1;
  const runId = RunId.make(`run:${THREAD_ID}:${runOrdinal}`);
  const modelSelection = options.model ?? selection("default");
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:zcode" as OrchestrationV2AppThread["projectId"],
    title: "ZCode test thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection,
    runtimeMode: options.runtimeMode ?? "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${THREAD_ID}:${runOrdinal}` as never,
      text: "Hello zcode",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy: policy(options.runtimeMode),
  });
});

const ensureThread = (runtime: ProviderAdapterV2SessionRuntime, runtimeMode?: RuntimeMode) =>
  runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: selection("default"),
    runtimePolicy: policy(runtimeMode),
  });

const isTerminal = (
  event: ProviderAdapterV2Event,
): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
  event.type === "turn.terminal";

const isRequest = (
  event: ProviderAdapterV2Event,
): event is Extract<ProviderAdapterV2Event, { type: "runtime_request.updated" }> =>
  event.type === "runtime_request.updated";

const permissionRequest = (id: string, command = "ls") => ({
  id,
  method: "interaction/requestPermission",
  params: {
    requestId: `perm_${id}`,
    toolCallId: "call_1",
    toolName: "Bash",
    reason: "High risk tools require explicit approval",
    input: { command },
    options: PERMISSION_OPTIONS,
    sessionId: FAKE_SESSION,
  },
});

describe("ZCodeAdapterV2", () => {
  it.effect("streams a turn with a tool call and settles on turn.completed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION);
      const create = yield* fake.takeCall("session/create");
      assert.equal((create["params"] as Rec)["mode"], "build");
      assert.isUndefined((create["params"] as Rec)["mcpServers"]);

      yield* startTurn(runtime, providerThread);
      const send = yield* fake.takeCall("session/send");
      assert.equal((send["params"] as Rec)["content"], "Hello zcode");
      // The session already runs `build`, and "default" keeps zcode's model.
      assert.isFalse(fake.allCalls().some((call) => call["method"] === "session/setMode"));
      assert.isFalse(fake.allCalls().some((call) => call["method"] === "session/setModel"));

      yield* fake.event("model.streaming", {
        kind: "reasoning_delta",
        delta: "thinking",
        assistantMessageId: "m1",
      });
      yield* fake.event("model.streaming", {
        kind: "text_delta",
        delta: "Hel",
        assistantMessageId: "m1",
      });
      yield* fake.event("model.streaming", {
        kind: "text_delta",
        delta: "lo",
        assistantMessageId: "m1",
      });
      yield* fake.event("tool.updated", {
        kind: "scheduled",
        toolCallId: "call_1",
        toolName: "Bash",
        inputOmitted: true,
      });
      yield* fake.event("permission.requested", { toolCallId: "call_1", input: { command: "ls" } });
      yield* fake.event("tool.updated", {
        kind: "started",
        toolCallId: "call_1",
        toolName: "Bash",
      });
      yield* fake.event("tool.updated", {
        kind: "result",
        toolCallId: "call_1",
        result: { success: true, content: "files", perf: { detail: { command: { exitCode: 0 } } } },
      });
      yield* fake.event("session.updated", {
        stopReason: "stop",
        contextWindow: 200000,
        usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107 },
      });
      yield* fake.event("turn.completed", { response: "Hello", resultType: "success" });

      const message = yield* takeEvent(
        (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
          event.type === "message.updated" && !event.message.streaming,
      );
      assert.equal(message.message.text, "Hello");
      const terminal = yield* takeEvent(isTerminal);
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reports the tool call as a command with its input and output", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread);
      yield* fake.takeCall("session/send");
      yield* fake.event("tool.updated", {
        kind: "started",
        toolCallId: "call_9",
        toolName: "Bash",
      });
      yield* fake.event("permission.requested", {
        toolCallId: "call_9",
        input: { command: "echo hi" },
      });
      yield* fake.event("tool.updated", {
        kind: "result",
        toolCallId: "call_9",
        result: { success: false, content: "boom", perf: { detail: { command: { exitCode: 2 } } } },
      });
      const item = yield* takeEvent(
        (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        item.turnItem.type === "command_execution" &&
          item.turnItem.input === "echo hi" &&
          item.turnItem.output === "boom" &&
          item.turnItem.exitCode === 2,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("asks through T3 and answers with the CLI's own one-shot option", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread);
      yield* fake.takeCall("session/send");

      yield* fake.write(permissionRequest("srv-1"));
      const pending = yield* takeEvent(isRequest);
      assert.equal(pending.runtimeRequest.status, "pending");
      assert.equal(pending.runtimeRequest.kind, "command");

      yield* runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "acceptForSession",
      });
      // Session approval must not persist zcode's project-wide grant.
      const answer = yield* fake.takeAnswer("srv-1");
      assert.deepEqual(answer["result"], ALLOW_ONCE);
      const resolved = yield* takeEvent(isRequest);
      assert.equal(resolved.runtimeRequest.status, "resolved");

      // The same request is now answered from the session grant.
      yield* fake.write(permissionRequest("srv-2"));
      const repeat = yield* fake.takeAnswer("srv-2");
      assert.deepEqual(repeat["result"], ALLOW_ONCE);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("declines with the deny option and denies open asks when the turn ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread);
      yield* fake.takeCall("session/send");

      yield* fake.write(permissionRequest("srv-1"));
      const first = yield* takeEvent(isRequest);
      yield* runtime.respondToRuntimeRequest({
        requestId: first.runtimeRequest.id,
        decision: "decline",
      });
      assert.deepEqual((yield* fake.takeAnswer("srv-1"))["result"], DENY);

      yield* fake.write(permissionRequest("srv-2", "rm -rf /tmp/x"));
      yield* takeEvent(
        (event): event is Extract<ProviderAdapterV2Event, { type: "runtime_request.updated" }> =>
          isRequest(event) && event.runtimeRequest.status === "pending",
      );
      yield* fake.event("turn.completed", { response: "", resultType: "success" });
      assert.deepEqual((yield* fake.takeAnswer("srv-2"))["result"], DENY);
      const cancelled = yield* takeEvent(
        (event): event is Extract<ProviderAdapterV2Event, { type: "runtime_request.updated" }> =>
          isRequest(event) && event.runtimeRequest.status === "cancelled",
      );
      assert.equal(cancelled.runtimeRequest.status, "cancelled");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("auto-allows in full access and sets yolo mode", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread, { runtimeMode: "full-access" });
      const setMode = yield* fake.takeCall("session/setMode");
      assert.deepEqual(setMode["params"], { sessionId: FAKE_SESSION, mode: "yolo" });
      yield* fake.takeCall("session/send");
      yield* fake.write(permissionRequest("srv-1"));
      assert.deepEqual((yield* fake.takeAnswer("srv-1"))["result"], ALLOW_ONCE);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("answers a structured question and refuses unknown server requests", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread);
      yield* fake.takeCall("session/send");

      yield* fake.write({ id: "srv-x", method: "session/requestRuntimePreferences", params: {} });
      const refused = yield* fake.takeAnswer("srv-x");
      assert.equal((refused["error"] as Rec)["code"], -32601);

      yield* fake.write({
        id: "srv-q",
        method: "interaction/requestUserInput",
        params: { requestId: "uq-1", prompt: "Pick one", choices: ["alpha", "beta"] },
      });
      const question = yield* takeEvent(isRequest);
      assert.equal(question.runtimeRequest.kind, "user_input");
      yield* runtime.respondToRuntimeRequest({
        requestId: question.runtimeRequest.id,
        answers: { "uq-1": "beta" },
      });
      assert.deepEqual((yield* fake.takeAnswer("srv-q"))["result"], {
        action: "accept",
        content: { value: "beta" },
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops with session/stop and reports the turn interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread);
      yield* fake.takeCall("session/send");
      const running = yield* takeEvent(
        (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
          event.type === "provider_turn.updated",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
      const stop = yield* fake.takeCall("session/stop");
      assert.deepEqual(stop["params"], { sessionId: FAKE_SESSION });
      yield* fake.event("turn.completed", { response: "", resultType: "cancelled" });
      const terminal = yield* takeEvent(isTerminal);
      assert.equal(terminal.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the turn on turn.failed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread);
      yield* fake.takeCall("session/send");
      yield* fake.event("turn.failed", { error: { message: "quota exceeded" } });
      const terminal = yield* takeEvent(isTerminal);
      assert.isTrue(terminal.status === "failed" && terminal.failure.message === "quota exceeded");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes the stored session id and applies the selected reasoning level", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime } = yield* openRuntime(fake);
      const created = yield* ensureThread(runtime);
      const resumed = yield* runtime.resumeThread({
        providerThread: {
          ...created,
          nativeThreadRef: { ...created.nativeThreadRef!, nativeId: "sess_old" },
        },
      });
      const resume = yield* fake.takeCall("session/resume");
      assert.equal((resume["params"] as Rec)["sessionId"], "sess_old");
      assert.equal(resumed.nativeThreadRef?.nativeId, FAKE_SESSION);

      yield* startTurn(runtime, resumed, { model: selection("zai-fake/glm-5.3-flash") });
      const defaultLevel = yield* fake.takeCall("session/setModel");
      assert.deepEqual((defaultLevel["params"] as Rec)["model"], {
        providerId: "zai-fake",
        modelId: "glm-5.3-flash",
        options: { reasoningLevel: "max" },
      });
      assert.equal(runtime.getModelContextWindow?.(selection("zai-fake/glm-5.3-flash")), 200000);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the resume instead of starting a blank session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime } = yield* openRuntime(fake);
      const created = yield* ensureThread(runtime);
      fake.refuseNextResume();
      const exit = yield* runtime
        .resumeThread({
          providerThread: {
            ...created,
            nativeThreadRef: { ...created.nativeThreadRef!, nativeId: "sess_gone" },
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
      assert.isFalse(
        fake.allCalls().filter((call) => call["method"] === "session/create").length > 1,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("passes T3's MCP server as an HTTP entry", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-zcode-mcp"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-session-zcode",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-zcode-token",
        browserToolsAvailable: false,
      });
      const fake = yield* makeFakeZCode;
      const { runtime } = yield* openRuntime(fake);
      yield* ensureThread(runtime);
      const create = yield* fake.takeCall("session/create");
      assert.deepEqual((create["params"] as Rec)["mcpServers"], [
        {
          name: "t3-code",
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: [{ name: "Authorization", value: "Bearer secret-zcode-token" }],
        },
      ]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID))),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );

  it.effect("retires the app-server when session/send times out", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      fake.holdSends();
      const turn = yield* startTurn(runtime, providerThread).pipe(Effect.exit, Effect.forkScoped);
      yield* fake.takeCall("session/send");
      yield* fake.write(permissionRequest("srv-1"));
      yield* takeEvent(isRequest);
      yield* TestClock.adjust("31 seconds");
      const exit = yield* Fiber.join(turn);
      assert.isTrue(exit._tag === "Failure");
      assert.deepEqual((yield* fake.takeAnswer("srv-1"))["result"], DENY);
      const sessionError = yield* takeEvent(
        (event): event is Extract<ProviderAdapterV2Event, { type: "provider_session.updated" }> =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      assert.equal(sessionError.providerSession.status, "error");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restores the session's own model when the selection returns to default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread, {
        model: selection("zai-fake/glm-5.3-flash", [{ id: "reasoning", value: "low" }]),
      });
      const picked = yield* fake.takeCall("session/setModel");
      assert.deepEqual(picked["params"], {
        sessionId: FAKE_SESSION,
        model: {
          providerId: "zai-fake",
          modelId: "glm-5.3-flash",
          options: { reasoningLevel: "low" },
        },
        persistAsWorkspaceLastUsed: false,
      });
      yield* fake.event("turn.completed", { response: "ok", resultType: "success" });
      yield* takeEvent(isTerminal);

      yield* startTurn(runtime, providerThread, { runOrdinal: 2 });
      const restored = yield* fake.takeCall("session/setModel");
      assert.deepEqual((restored["params"] as Rec)["model"], {
        providerId: "zai-fake",
        modelId: "glm-5.3-flash",
        options: { reasoningLevel: "max" },
      });
      yield* fake.event("turn.completed", { response: "ok", resultType: "success" });
      yield* takeEvent(isTerminal);

      // Staying on default sends nothing further.
      yield* startTurn(runtime, providerThread, { runOrdinal: 3 });
      yield* fake.takeCall("session/send");
      assert.equal(
        fake.allCalls().filter((call) => call["method"] === "session/setModel").length,
        2,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses a permission request that no turn owns", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime } = yield* openRuntime(fake);
      yield* ensureThread(runtime);
      yield* fake.write(permissionRequest("srv-1"));
      assert.deepEqual((yield* fake.takeAnswer("srv-1"))["result"], DENY);
      yield* fake.write({
        id: "srv-q",
        method: "interaction/requestUserInput",
        params: { requestId: "uq-1", prompt: "Pick one", choices: ["a"] },
      });
      assert.deepEqual((yield* fake.takeAnswer("srv-q"))["result"], { action: "cancel" });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("denies open asks before stopping", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread);
      yield* fake.takeCall("session/send");
      yield* fake.write(permissionRequest("srv-1"));
      const pending = yield* takeEvent(isRequest);
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.runtimeRequest.providerTurnId!,
      });
      assert.deepEqual((yield* fake.takeAnswer("srv-1"))["result"], DENY);
      const cancelled = yield* takeEvent(isRequest);
      assert.equal(cancelled.runtimeRequest.status, "cancelled");
      yield* fake.takeCall("session/stop");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("validates config models with the reasoning-level ladder", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      fake.setModelRule("ghost/kiro/claude-opus-5", "low");
      fake.setModelRule("ghost/gone", "missing");
      const candidates = zcodeConfigModels(CONFIG_WITH_GHOST);
      const result = yield* Deferred.make<ZCodeCatalogProbeResult>();
      let claims = 0;
      const { runtime } = yield* openRuntime(fake, "default", {
        modelValidation: {
          claim: () => claims++ === 0,
          candidates: () => candidates,
          onResult: (probe) => Deferred.succeed(result, probe).pipe(Effect.asVoid),
        },
      });
      yield* ensureThread(runtime);
      const probe = yield* Deferred.await(result);
      assert.deepEqual(Object.fromEntries(probe.validation), {
        "ghost/kiro/claude-opus-5": { accepted: true, reasoningLevel: "low" },
        "ghost/gone": { accepted: false },
        "ghost/plain": { accepted: true, reasoningLevel: null },
      });
      const deferred = fake
        .allCalls()
        .find(
          (call) =>
            call["method"] === "session/create" &&
            (call["params"] as Rec)["persistence"] === "deferred",
        );
      assert.isDefined(deferred);
      const ladder = fake
        .allCalls()
        .filter((call) => call["method"] === "session/setModel")
        .map((call) => call["params"] as Rec);
      // none, high, low for the slashed model; one try for the others.
      assert.equal(ladder.length, 5);
      assert.isTrue(ladder.every((params) => params["persistAsWorkspaceLastUsed"] === false));
      assert.deepEqual(ladder[0]?.["model"], {
        providerId: "ghost",
        modelId: "kiro/claude-opus-5",
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("finds an accepted reasoning level when a picked config model needs one", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeZCode;
      fake.setModelRule("ghost/kiro/claude-opus-5", "high");
      const { runtime } = yield* openRuntime(fake, "default", {
        knownModels: () => zcodeConfigModels(CONFIG_WITH_GHOST),
      });
      const providerThread = yield* ensureThread(runtime);
      yield* startTurn(runtime, providerThread, { model: selection("ghost/kiro/claude-opus-5") });
      yield* fake.takeCall("session/send");
      const levels = fake
        .allCalls()
        .filter((call) => call["method"] === "session/setModel")
        .map((call) => ((call["params"] as Rec)["model"] as Rec)["options"]);
      assert.deepEqual(levels, [undefined, undefined, { reasoningLevel: "high" }]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("zcodePermissionOptionResponse", () => {
  it("never picks a project-wide grant for allow", () => {
    assert.deepEqual(
      zcodePermissionOptionResponse([PERMISSION_OPTIONS[1], PERMISSION_OPTIONS[2]], "allow"),
      null,
    );
    assert.deepEqual(zcodePermissionOptionResponse(PERMISSION_OPTIONS, "allow"), ALLOW_ONCE);
    assert.deepEqual(zcodePermissionOptionResponse(PERMISSION_OPTIONS, "deny"), DENY);
  });
});
