/**
 * ZCodeAdapterV2 — orchestrator-v2 adapter for the zcode CLI, driving its
 * native app-server protocol ("ZCode Protocol") over stdio via `ZCodeRpc.ts`.
 *
 * One app-server process serves one provider session. A thread is a zcode
 * session: `session/create` (or `session/resume` on the stored session id),
 * then `session/subscribe` for events. Each turn reasserts the permission
 * mode and model with `session/setMode` / `session/setModel` and sends the
 * prompt with `session/send`. `turn.completed` and `turn.failed` session
 * events are the only terminal signals; Stop sends `session/stop`.
 *
 * Wire traps, verified against zcode 0.16.9:
 * - A session event's discriminator is `params.type`; its data rides
 *   `params.payload`.
 * - `session/create` blocks until the server→client requests it raises
 *   (runtime preferences, official MCP auth headers) are answered. Refusing
 *   them with -32601 selects the CLI's own fallback.
 * - A permission answer must be one of the request's own option responses.
 *   "Always allow" options persist for the whole project, so T3's
 *   accept-for-session answers once and remembers the grant itself.
 * - Text arrives twice: as `model.streaming` deltas and as `part.delta`.
 *   Only the former is decoded.
 *
 * T3's MCP server is passed as an HTTP entry in the session's `mcpServers`,
 * merged by name over the user's own zcode MCP configuration.
 */
import {
  ProviderDriverKind,
  ZCodeSettings,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { mcpToolPresentation } from "../../provider/McpToolPresentation.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { t3OrchestrationPromptForFirstRun } from "../../provider/T3OrchestrationInstructions.ts";
import {
  parseZCodeCatalog,
  parseZCodeModelSlug,
  ZCODE_DEFAULT_MODEL_SLUG,
  ZCODE_REASONING_OPTION_ID,
  type ZCodeCatalog,
} from "../../provider/ZCodeModels.ts";
import { providerMessageTextWithAttachmentPaths } from "../AttachmentPrompt.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  makeZCodeRpcConnection,
  zcodeRecordField as recordField,
  zcodeRecordNumber as recordNumber,
  zcodeRecordString as recordString,
  type ZCodeRpcConnection,
  type ZCodeRpcRecord,
} from "./ZCodeRpc.ts";

export const ZCODE_PROVIDER = ProviderDriverKind.make("zcode");
const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZCodeSettings)({});
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(UnknownFromJsonString);
const decodeJson = Schema.decodeOption(UnknownFromJsonString);

const STREAM_FLUSH_MS = 50;
const ZCODE_REQUEST_TIMEOUT_MS = 30_000;
// Session creation runs the user's SessionStart hooks and starts MCP servers.
const ZCODE_SESSION_TIMEOUT_MS = 120_000;
const ZCODE_STOP_TIMEOUT_MS = 5_000;
const DELIVERY_KIND = "desktop-continuous";
const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const ZCodeProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // `session/setMode` runs before every turn.
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ZCodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  /** Receives the model catalog each session's snapshot reports. */
  readonly onCatalog?: (catalog: ZCodeCatalog) => Effect.Effect<void>;
}

/** T3 runtime modes → zcode permission modes. */
export function zcodePermissionMode(runtimeMode: RuntimeMode): "build" | "edit" | "yolo" {
  if (runtimeMode === "full-access") return "yolo";
  if (runtimeMode === "auto-accept-edits") return "edit";
  return "build";
}

/** The option response the CLI offered for a decision, preferring one-shot grants. */
export function zcodePermissionOptionResponse(
  options: unknown,
  decision: "allow" | "deny",
): Record<string, unknown> | null {
  const list = Array.isArray(options) ? options : [];
  const matching = list.filter(
    (option) => recordString(recordField(option, "response"), "decision") === decision,
  );
  const preferred =
    matching.find((option) => recordString(option, "kind") === `${decision}_once`) ??
    matching.find((option) => recordString(option, "kind") === decision) ??
    matching.find((option) => recordString(option, "kind") !== "allow_always") ??
    (decision === "deny" ? matching[0] : undefined);
  const response = recordField(preferred, "response");
  return response !== null && typeof response === "object"
    ? (response as Record<string, unknown>)
    : null;
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: ZCODE_PROVIDER, nativeId, strength };
}

function toolOutputText(result: unknown): string {
  const content = recordField(result, "content");
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (recordString(block, "text") ?? "")))
      .join("");
  }
  return "";
}

interface ZCodeStreamItem {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

interface ActiveZCodeTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  readonly streamItems: Map<string, ZCodeStreamItem>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly toolInputs: Map<string, unknown>;
  readonly toolNames: Map<string, string>;
  /** Assistant text seen through streaming deltas. */
  sawAssistantText: boolean;
  interrupted: boolean;
  lastUsage: {
    readonly usedTokens: number;
    readonly maxTokens: number;
    readonly raw: unknown;
  } | null;
}

interface PendingZCodeRequest {
  readonly nativeRequestId: unknown;
  readonly method: "permission" | "user_input";
  readonly options: unknown;
  readonly approvalKey: string | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

interface ZCodeThreadState {
  providerThread: OrchestrationV2ProviderThread;
  readonly sessionId: string;
  activeTurn: ActiveZCodeTurn | null;
}

export function makeZCodeAdapterV2(
  options: ZCodeAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2Shape {
  const { idAllocator } = options;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ZCODE_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: ZCODE_PROVIDER,
    getCapabilities: () => Effect.succeed(ZCodeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("ZCodeAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      const connection: ZCodeRpcConnection = yield* makeZCodeRpcConnection({
        command: options.settings.binaryPath || "zcode",
        cwd,
        env: McpProviderSession.withAgentDeviceEnvironment(options.environment, mcpSession),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: ZCODE_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      const mcpServers =
        mcpSession === undefined
          ? []
          : [
              {
                name: "t3-code",
                type: "http",
                url: mcpSession.endpoint,
                headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
              },
            ];
      const workspace = { workspacePath: cwd, workspaceKey: cwd };

      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: ZCODE_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: ZCodeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingRequests = new Map<string, PendingZCodeRequest>();
      const sessionApprovals = new Set<string>();
      // Serializes the event pump with request answers and turn installation,
      // so `turn.terminal` cannot overtake a request's resolution updates.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: ZCodeThreadState | null = null;
      let catalog: ZCodeCatalog = { models: [], currentSlug: null };
      let appliedMode: string | null = null;
      let appliedModelKey: string | null = null;
      let stopRequested = false;

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = sessionEntity.lastError,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: ZCODE_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread = (
        state: ZCodeThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: ZCODE_PROVIDER,
            providerThread: state.providerThread,
          });
        });

      const request = (method: string, params: unknown, timeoutMs = ZCODE_REQUEST_TIMEOUT_MS) =>
        connection.request(method, params, timeoutMs);

      const itemOrdinal = (turn: ActiveZCodeTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const baseItemFields = (
        turn: ActiveZCodeTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({ driver: ZCODE_PROVIDER, nativeItemId }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({ driver: ZCODE_PROVIDER, nativeItemId }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActiveZCodeTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: ZCODE_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({ driver: ZCODE_PROVIDER, nativeItemId }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      // ── streaming text / reasoning ────────────────────────

      const emitStreamItem = (turn: ActiveZCodeTurn, item: ZCodeStreamItem, streaming: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          const status = streaming ? "running" : "completed";
          const completedAt = streaming ? null : emittedAt;
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            status,
            item.startedAt,
            completedAt,
          );
          if (item.kind === "reasoning") {
            yield* emit({
              type: "turn_item.updated",
              driver: ZCODE_PROVIDER,
              turnItem: {
                ...base,
                status,
                title: null,
                completedAt,
                type: "reasoning",
                text: item.text,
                streaming,
              },
            });
            return;
          }
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: ZCODE_PROVIDER,
            nativeItemId: item.nativeItemId,
          });
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...base,
              status,
              title: null,
              completedAt,
              type: "assistant_message",
              messageId,
              text: item.text,
              streaming,
            },
          });
          yield* emit({
            type: "message.updated",
            driver: ZCODE_PROVIDER,
            message: {
              id: messageId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              nodeId: base.nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt,
              updatedAt: emittedAt,
            },
          });
        });

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActiveZCodeTurn,
        kind: ZCodeStreamItem["kind"],
        assistantMessageId: string,
      ) {
        const nativeItemId = `${assistantMessageId}:${kind}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined && !existing.completed) return existing;
        // A completed item reopened by later deltas gets a fresh segment so
        // the timeline keeps text and tool calls in their real order.
        const segmentId =
          existing === undefined ? nativeItemId : `${nativeItemId}:${turn.nextItemOrdinal}`;
        const startedAt = yield* DateTime.now;
        const item: ZCodeStreamItem = {
          nativeItemId: segmentId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        itemOrdinal(turn, segmentId);
        return item;
      });

      const scheduleStreamFlush = (turn: ActiveZCodeTurn, item: ZCodeStreamItem) =>
        Effect.gen(function* () {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const completeOpenStreamItems = (turn: ActiveZCodeTurn) =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) =>
            Effect.suspend(() => {
              item.completed = true;
              return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
            }),
          { discard: true },
        );

      // ── tools ─────────────────────────────────────────────

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActiveZCodeTurn,
        toolCallId: string,
        phase: "running" | "completed" | "failed",
        result?: unknown,
      ) {
        const toolName = turn.toolNames.get(toolCallId) ?? "tool";
        const args = turn.toolInputs.get(toolCallId);
        const emittedAt = yield* DateTime.now;
        const startedAt = turn.toolStartedAt.get(toolCallId) ?? emittedAt;
        turn.toolStartedAt.set(toolCallId, startedAt);
        const completed = phase !== "running";
        const status = phase === "failed" && turn.interrupted ? "interrupted" : phase;
        const outputText = completed ? toolOutputText(result) : "";
        yield* emitItemNode(
          turn,
          toolCallId,
          "tool_call",
          status,
          startedAt,
          completed ? emittedAt : null,
        );
        const shared = {
          ...baseItemFields(turn, toolCallId, startedAt, emittedAt),
          status,
          completedAt: completed ? emittedAt : null,
          title: toolName,
        } as const;
        if (toolName === "Bash") {
          const exitCode = recordNumber(
            recordField(recordField(recordField(result, "perf"), "detail"), "command"),
            "exitCode",
          );
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...shared,
              type: "command_execution",
              input: recordString(args, "command") ?? "",
              ...(outputText.length > 0 ? { output: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            },
          });
          return;
        }
        const fileName = recordString(args, "file_path") ?? recordString(args, "path");
        if (FILE_CHANGE_TOOLS.has(toolName) && fileName !== undefined) {
          const newStr = recordString(args, "content") ?? recordString(args, "new_string");
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...shared,
              type: "file_change",
              fileName,
              ...(newStr === undefined ? {} : { newStr }),
              ...(phase === "failed" && outputText.length > 0 ? { diffStr: outputText } : {}),
            },
          });
          return;
        }
        yield* emit({
          type: "turn_item.updated",
          driver: ZCODE_PROVIDER,
          turnItem: {
            ...shared,
            type: "dynamic_tool",
            ...mcpToolPresentation({ toolName }),
            toolName,
            input: args ?? {},
            ...(outputText.length > 0 ? { output: outputText } : {}),
          },
        });
      });

      // ── server→client interaction requests ────────────────

      const resolvePending = (
        pending: PendingZCodeRequest,
        status: "resolved" | "cancelled",
        resolvedAt: DateTime.Utc,
      ) =>
        Effect.gen(function* () {
          pending.runtimeRequest = { ...pending.runtimeRequest, status, resolvedAt };
          yield* emit({
            type: "runtime_request.updated",
            driver: ZCODE_PROVIDER,
            threadId: pending.node.threadId,
            runtimeRequest: pending.runtimeRequest,
          });
          const itemStatus = status === "resolved" ? "completed" : "cancelled";
          yield* emit({
            type: "node.updated",
            driver: ZCODE_PROVIDER,
            node: { ...pending.node, status: itemStatus, completedAt: resolvedAt },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...pending.turnItem,
              status: itemStatus,
              completedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          });
        });

      /** Answers a request the user did not: permissions deny, questions cancel. */
      const refusalFor = (pending: PendingZCodeRequest): Record<string, unknown> =>
        pending.method === "permission"
          ? (zcodePermissionOptionResponse(pending.options, "deny") ?? { decision: "deny" })
          : { action: "cancel" };

      const cancelPendingRequests = (resolvedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const pending = Array.from(pendingRequests.values());
          pendingRequests.clear();
          yield* Effect.forEach(
            pending,
            (entry) =>
              connection
                .respond(entry.nativeRequestId, refusalFor(entry))
                .pipe(
                  Effect.ignore,
                  Effect.andThen(resolvePending(entry, "cancelled", resolvedAt)),
                ),
            { discard: true },
          );
        });

      const openRuntimeRequest = Effect.fnUntraced(function* (input_: {
        readonly record: ZCodeRpcRecord;
        readonly method: PendingZCodeRequest["method"];
        readonly nativeKey: string;
        readonly title: string;
        readonly approvalKey: string | null;
        readonly item:
          | { readonly type: "approval_request"; readonly prompt: string }
          | { readonly type: "user_input_request"; readonly question: string };
        readonly kind: "command" | "file-change" | "user_input";
        readonly options: ReadonlyArray<{
          readonly label: string;
          readonly description: string;
          readonly value: string;
        }>;
      }) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: ZCODE_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId: input_.nativeKey,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const threadId =
          turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(input_.nativeKey),
          kind: input_.kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: input_.method === "permission" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(input_.nativeKey),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(input_.nativeKey),
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, input_.nativeKey),
          status: "waiting" as const,
          title: input_.title,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
          requestId,
        };
        const turnItem: OrchestrationV2TurnItem =
          input_.item.type === "approval_request"
            ? {
                ...itemBase,
                type: "approval_request",
                requestKind: input_.kind === "file-change" ? "file-change" : "command",
                prompt: input_.item.prompt,
              }
            : {
                ...itemBase,
                type: "user_input_request",
                questions: [
                  {
                    id: input_.nativeKey,
                    header: input_.title,
                    question: input_.item.question,
                    options: input_.options,
                    ...(input_.options.length === 0 ? { allowCustomAnswer: true } : {}),
                  },
                ],
              };
        pendingRequests.set(String(requestId), {
          nativeRequestId: input_.record["id"],
          method: input_.method,
          options: recordField(input_.record["params"], "options"),
          approvalKey: input_.approvalKey,
          runtimeRequest,
          node,
          turnItem,
        });
        yield* emit({
          type: "runtime_request.updated",
          driver: ZCODE_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
      });

      const handlePermissionRequest = Effect.fnUntraced(function* (record: ZCodeRpcRecord) {
        const params = record["params"];
        const toolName = recordString(params, "toolName") ?? "tool";
        const toolInput = recordField(params, "input");
        const toolCallId = recordString(params, "toolCallId");
        const turn = threadState?.activeTurn ?? null;
        if (turn !== null && toolCallId !== undefined) {
          turn.toolNames.set(toolCallId, toolName);
          if (toolInput !== undefined) turn.toolInputs.set(toolCallId, toolInput);
        }
        const approvalKey = `${toolName}:${encodeJson(toolInput ?? null)}`;
        const autoAllow =
          turn?.turnInput.runtimePolicy.runtimeMode === "full-access" ||
          sessionApprovals.has(approvalKey);
        const allow = autoAllow
          ? zcodePermissionOptionResponse(recordField(params, "options"), "allow")
          : null;
        if (allow !== null) {
          yield* connection.respond(record["id"], allow);
          return;
        }
        const command = recordString(toolInput, "command");
        const reason = recordString(params, "reason");
        const prompt = command ?? reason ?? toolName;
        yield* openRuntimeRequest({
          record,
          method: "permission",
          nativeKey: recordString(params, "requestId") ?? String(record["id"]),
          title: toolName,
          approvalKey,
          kind: FILE_CHANGE_TOOLS.has(toolName) ? "file-change" : "command",
          options: [],
          item: { type: "approval_request", prompt },
        });
      });

      const handleUserInputRequest = Effect.fnUntraced(function* (record: ZCodeRpcRecord) {
        const params = record["params"];
        const nativeKey = recordString(params, "requestId") ?? String(record["id"]);
        const prompt = recordString(params, "prompt")?.trim() || "ZCode asks for input";
        const choices = recordField(params, "choices");
        const options = (Array.isArray(choices) ? choices : [])
          .filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "")
          .map((choice) => ({ label: choice, description: choice, value: choice }));
        yield* openRuntimeRequest({
          record,
          method: "user_input",
          nativeKey,
          title: "Question",
          approvalKey: null,
          kind: "user_input",
          options,
          item: { type: "user_input_request", question: prompt },
        });
      });

      const handleServerRequest = (record: ZCodeRpcRecord) => {
        switch (record["method"]) {
          case "interaction/requestPermission":
            return handlePermissionRequest(record);
          case "interaction/requestUserInput":
            return handleUserInputRequest(record);
          default:
            // Unknown asks (runtime preferences, official MCP auth headers)
            // fail closed so the CLI applies its own fallback.
            return connection.respondError(
              record["id"],
              -32601,
              `Unsupported server request: ${String(record["method"])}`,
            );
        }
      };

      // ── turn lifecycle ────────────────────────────────────

      const finalizeTurn = Effect.fnUntraced(function* (
        state: ZCodeThreadState,
        failure: ReturnType<typeof makeProviderFailure> | null,
      ) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        yield* cancelPendingRequests(completedAt);
        const effectiveFailure = turn.interrupted ? null : failure;
        const tokenUsage: OrchestrationV2ProviderTurnTokenUsage | undefined =
          turn.lastUsage === null
            ? undefined
            : {
                usedTokens: turn.lastUsage.usedTokens,
                maxTokens: turn.lastUsage.maxTokens,
                updatedAt: DateTime.formatIso(completedAt),
              };
        yield* emit({
          type: "provider_turn.updated",
          driver: ZCODE_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            status: turn.interrupted
              ? "interrupted"
              : effectiveFailure !== null
                ? "failed"
                : "completed",
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
          },
        });
        yield* updateProviderThread(state, { status: "idle" });
        yield* updateProviderSession(
          effectiveFailure !== null ? "error" : "ready",
          effectiveFailure?.message ?? null,
        );
        if (effectiveFailure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          yield* emit({
            type: "turn_item.updated",
            driver: ZCODE_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, failureItemId, completedAt, completedAt),
              status: "failed",
              title: null,
              completedAt,
              type: "error",
              failure: effectiveFailure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: ZCODE_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure: effectiveFailure,
            threadDisposition: "reusable",
          });
          return;
        }
        yield* emit({
          type: "turn.terminal",
          driver: ZCODE_PROVIDER,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.turnInput.runOrdinal,
          status: turn.interrupted ? "interrupted" : "completed",
          failure: null,
          threadDisposition: "reusable",
        });
      });

      const handleSessionEvent = Effect.fnUntraced(function* (params: unknown) {
        const state = threadState;
        if (state === null || recordString(params, "sessionId") !== state.sessionId) return;
        const turn = state.activeTurn;
        if (turn === null) return;
        const payload = recordField(params, "payload");
        switch (recordString(params, "type")) {
          case "model.streaming": {
            const kind = recordString(payload, "kind");
            const delta = recordString(payload, "delta") ?? "";
            const toolCallId = recordString(payload, "toolCallId");
            if (kind === "tool_input_delta" && toolCallId !== undefined) {
              const previous = turn.toolInputs.get(toolCallId);
              turn.toolInputs.set(
                toolCallId,
                (typeof previous === "string" ? previous : "") + delta,
              );
              return;
            }
            if ((kind !== "text_delta" && kind !== "reasoning_delta") || delta.length === 0) return;
            const item = yield* streamItemFor(
              turn,
              kind === "text_delta" ? "assistant_message" : "reasoning",
              recordString(payload, "assistantMessageId") ?? turn.providerTurn.id,
            );
            if (kind === "text_delta") turn.sawAssistantText = true;
            item.text += delta;
            yield* scheduleStreamFlush(turn, item);
            return;
          }
          case "permission.requested": {
            // Carries the tool input the scheduled tool update omits.
            const toolCallId = recordString(payload, "toolCallId");
            const toolInput = recordField(payload, "input");
            if (toolCallId !== undefined && toolInput !== undefined) {
              turn.toolInputs.set(toolCallId, toolInput);
            }
            return;
          }
          case "tool.updated": {
            const toolCallId = recordString(payload, "toolCallId");
            if (toolCallId === undefined) return;
            const toolName = recordString(payload, "toolName");
            if (toolName !== undefined) turn.toolNames.set(toolCallId, toolName);
            // Streamed tool input arrives as JSON text; decode it once known.
            const streamedInput = turn.toolInputs.get(toolCallId);
            if (typeof streamedInput === "string") {
              const decoded = decodeJson(streamedInput);
              if (Option.isSome(decoded)) turn.toolInputs.set(toolCallId, decoded.value);
              else turn.toolInputs.delete(toolCallId);
            }
            const inputField = recordField(payload, "input");
            if (inputField !== undefined && typeof inputField === "object") {
              turn.toolInputs.set(toolCallId, inputField);
            }
            const kind = recordString(payload, "kind");
            if (kind === "scheduled" || kind === "started") {
              yield* completeOpenStreamItems(turn);
              yield* emitToolItem(turn, toolCallId, "running");
            } else if (kind === "result" || kind === "completed") {
              const result = recordField(payload, "result");
              yield* emitToolItem(
                turn,
                toolCallId,
                recordField(result, "success") === false ? "failed" : "completed",
                result,
              );
            }
            return;
          }
          case "session.updated": {
            // Each model response reports its usage and the context window.
            const usage = recordField(payload, "usage");
            const usedTokens = recordNumber(usage, "totalTokens");
            const maxTokens = recordNumber(payload, "contextWindow");
            if (
              recordString(payload, "stopReason") !== undefined &&
              usedTokens !== undefined &&
              maxTokens !== undefined &&
              maxTokens > 0
            ) {
              turn.lastUsage = {
                usedTokens: Math.max(0, Math.trunc(usedTokens)),
                maxTokens: Math.trunc(maxTokens),
                raw: usage,
              };
            }
            return;
          }
          case "turn.completed": {
            const response = recordString(payload, "response") ?? "";
            if (!turn.sawAssistantText && response.trim().length > 0) {
              const item = yield* streamItemFor(turn, "assistant_message", turn.providerTurn.id);
              item.text = response;
            }
            if (recordString(payload, "resultType") === "cancelled") turn.interrupted = true;
            yield* finalizeTurn(state, null);
            return;
          }
          case "turn.failed": {
            const error = recordField(payload, "error");
            const message = recordString(error, "message") ?? "ZCode turn failed.";
            yield* finalizeTurn(
              state,
              makeProviderFailure({
                message,
                code: recordString(error, "code") ?? null,
                class: "provider_error",
              }),
            );
            return;
          }
          default:
            return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const record = yield* Queue.take(connection.events);
          yield* sessionEventPermit.withPermits(1)(
            record["id"] !== undefined
              ? handleServerRequest(record)
              : record["method"] === "session/event"
                ? handleSessionEvent(record["params"])
                : Effect.void,
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              const state = threadState;
              const interrupted = state?.activeTurn?.interrupted === true;
              if (state?.activeTurn != null) {
                yield* finalizeTurn(
                  state,
                  makeProviderFailure({
                    cause,
                    message: "ZCode app-server exited unexpectedly.",
                    class: "transport_error",
                  }),
                );
              }
              if (stopRequested) {
                yield* updateProviderSession("stopped", null);
                yield* Queue.end(events);
              } else {
                yield* updateProviderSession(
                  "error",
                  interrupted ? "ZCode was stopped." : "ZCode app-server exited unexpectedly.",
                );
                yield* Queue.fail(
                  events,
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: ZCODE_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
                );
              }
            }),
          ),
        ),
        Effect.forkIn(scope),
      );

      // ── session runtime ───────────────────────────────────

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (threadState?.activeTurn != null) {
          return yield* protocolError("Cannot register a ZCode thread while a turn is active");
        }
        const existing = threadInput.existingProviderThread;
        const resumeId = existing?.nativeThreadRef?.nativeId ?? null;
        if (threadState !== null && resumeId === threadState.sessionId) {
          return threadState.providerThread;
        }
        const mode = zcodePermissionMode(threadInput.runtimePolicy.runtimeMode);
        const mcpParam = mcpServers.length === 0 ? {} : { mcpServers };
        // A refused resume fails the thread instead of silently starting a
        // blank conversation under the old identity.
        const opened = yield* request(
          resumeId !== null ? "session/resume" : "session/create",
          resumeId !== null
            ? { sessionId: resumeId, workspace, ...mcpParam }
            : { workspace, mode, titleGenerationEnabled: false, ...mcpParam },
          ZCODE_SESSION_TIMEOUT_MS,
        );
        const sessionId =
          recordString(recordField(opened, "session"), "sessionId") ?? resumeId ?? undefined;
        if (sessionId === undefined) {
          return yield* protocolError("ZCode did not return a session id", opened);
        }
        const subscribed = yield* request("session/subscribe", {
          sessionId,
          deliveryKind: DELIVERY_KIND,
          includeSnapshot: true,
        });
        catalog = parseZCodeCatalog(
          recordField(recordField(recordField(subscribed, "snapshot"), "settings"), "model"),
        );
        if (options.onCatalog !== undefined && catalog.models.length > 0) {
          yield* options.onCatalog(catalog).pipe(Effect.ignore, Effect.forkIn(scope));
        }
        appliedMode = resumeId === null ? mode : null;
        appliedModelKey = null;
        const previous = threadState;
        if (previous !== null && previous.sessionId !== sessionId) {
          yield* request("session/close", { sessionId: previous.sessionId }).pipe(Effect.ignore);
        }
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(sessionId),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: ZCODE_PROVIDER,
                  nativeThreadId: sessionId,
                }),
                driver: ZCODE_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(sessionId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        threadState = { providerThread, sessionId, activeTurn: null };
        yield* emit({ type: "provider_thread.updated", driver: ZCODE_PROVIDER, providerThread });
        return providerThread;
      });

      /** Reasserts the mode and model before every turn; a session keeps its last ones. */
      const applyTurnSettings = Effect.fnUntraced(function* (
        sessionId: string,
        runtimeMode: RuntimeMode,
        modelSelection: ModelSelection,
      ) {
        const mode = zcodePermissionMode(runtimeMode);
        if (mode !== appliedMode) {
          yield* request("session/setMode", { sessionId, mode });
          appliedMode = mode;
        }
        if (modelSelection.model === ZCODE_DEFAULT_MODEL_SLUG) return;
        const parsed = parseZCodeModelSlug(modelSelection.model);
        if (parsed === null) {
          return yield* protocolError(
            `ZCode model '${modelSelection.model}' must use provider/model format`,
          );
        }
        const known = catalog.models.find((model) => model.slug === modelSelection.model);
        const requestedLevel = getModelSelectionStringOptionValue(
          modelSelection,
          ZCODE_REASONING_OPTION_ID,
        );
        // Models with reasoning levels reject setModel without one.
        const level =
          requestedLevel !== undefined &&
          (known === undefined || known.reasoningLevels.includes(requestedLevel))
            ? requestedLevel
            : (known?.defaultReasoningLevel ?? undefined);
        const key = `${modelSelection.model}$${level ?? ""}`;
        if (key === appliedModelKey) return;
        yield* request("session/setModel", {
          sessionId,
          model: {
            providerId: parsed.providerId,
            modelId: parsed.modelId,
            ...(level === undefined ? {} : { options: { reasoningLevel: level } }),
          },
        });
        appliedModelKey = key;
        const updatedAt = yield* DateTime.now;
        sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
        yield* emit({
          type: "provider_session.updated",
          driver: ZCODE_PROVIDER,
          providerSession: sessionEntity,
        });
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: ZCODE_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        getModelContextWindow: (selection) => {
          if (selection.instanceId !== options.instanceId) return undefined;
          const slug =
            selection.model === ZCODE_DEFAULT_MODEL_SLUG ? catalog.currentSlug : selection.model;
          return catalog.models.find((model) => model.slug === slug)?.contextWindow ?? undefined;
        },
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: ZCODE_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: ZCODE_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("ZCode session has no registered thread");
            }
            if (state.activeTurn !== null) {
              return yield* protocolError(
                `ZCode provider thread ${turnInput.providerThread.id} already has an active turn`,
              );
            }
            if (turnInput.providerThread.nativeThreadRef?.nativeId !== state.sessionId) {
              return yield* protocolError("ZCode turn requested for a different native session");
            }
            state.providerThread = turnInput.providerThread;
            yield* applyTurnSettings(
              state.sessionId,
              turnInput.runtimePolicy.runtimeMode,
              turnInput.modelSelection,
            );
            const content = t3OrchestrationPromptForFirstRun({
              prompt: providerMessageTextWithAttachmentPaths({
                text: turnInput.message.text,
                attachments: turnInput.message.attachments,
                attachmentsDir: options.serverConfig.attachmentsDir,
              }),
              runOrdinal: turnInput.runOrdinal,
              hasT3Mcp: mcpServers.length > 0,
            });
            if (content.trim().length === 0) {
              return yield* protocolError("ZCode turn requires non-empty text");
            }
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: ZCODE_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const activeTurn: ActiveZCodeTurn = {
              turnInput,
              providerTurn,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              streamItems: new Map(),
              toolStartedAt: new Map(),
              toolInputs: new Map(),
              toolNames: new Map(),
              sawAssistantText: false,
              interrupted: false,
              lastUsage: null,
            };
            yield* Effect.gen(function* () {
              state.activeTurn = activeTurn;
              yield* emit({
                type: "provider_turn.updated",
                driver: ZCODE_PROVIDER,
                threadId: turnInput.threadId,
                providerTurn,
              });
              yield* updateProviderThread(state, {
                status: "active",
                firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                lastRunOrdinal: turnInput.runOrdinal,
              });
              yield* updateProviderSession("running", null);
            }).pipe(sessionEventPermit.withPermits(1));
            // Sent outside the permit: the pump must stay free to answer the
            // requests zcode raises before it acknowledges the input.
            yield* request("session/send", { sessionId: state.sessionId, content }).pipe(
              Effect.tapError(() =>
                sessionEventPermit.withPermits(1)(
                  Effect.suspend(() =>
                    state.activeTurn === activeTurn
                      ? Effect.gen(function* () {
                          state.activeTurn = null;
                          yield* updateProviderThread(state, { status: "idle" });
                          yield* updateProviderSession("ready", null);
                        })
                      : Effect.void,
                  ),
                ),
              ),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: ZCODE_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: ZCODE_PROVIDER,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            if (turn === null && interruptInput.requestRuntimeRestart === true) return;
            if (
              state === null ||
              turn === null ||
              turn.providerTurn.id !== interruptInput.providerTurnId
            ) {
              return yield* protocolError(
                `ZCode turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            if (interruptInput.requestRuntimeRestart === true) {
              stopRequested = true;
              yield* connection.terminate;
              return;
            }
            // zcode settles a stopped turn with `turn.completed` (cancelled).
            // An app-server that cannot stop is retired instead.
            yield* request(
              "session/stop",
              { sessionId: state.sessionId },
              ZCODE_STOP_TIMEOUT_MS,
            ).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  stopRequested = true;
                }).pipe(Effect.andThen(connection.terminate)),
              ),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: ZCODE_PROVIDER,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.gen(function* () {
            const pending = pendingRequests.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(`No pending ZCode request ${requestInput.requestId}`);
            }
            const response = zcodeRequestResponse(
              pending,
              requestInput.decision,
              requestInput.answers,
            );
            yield* connection.respond(pending.nativeRequestId, response);
            pendingRequests.delete(String(requestInput.requestId));
            if (requestInput.decision === "acceptForSession" && pending.approvalKey !== null) {
              sessionApprovals.add(pending.approvalKey);
            }
            yield* resolvePending(pending, "resolved", yield* DateTime.now);
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: ZCODE_PROVIDER,
                  requestId: requestInput.requestId,
                  cause,
                }),
            ),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.succeed({
            providerThread: threadState?.providerThread ?? snapshotInput.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: ZCODE_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              checkpointId: rollbackInput.target.checkpointId,
              cause: protocolError("ZCode cannot roll back its conversation"),
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: ZCODE_PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: protocolError("ZCode does not support native thread forks"),
            }),
          ),
      };
      return runtime;
    }),
  });
}

function zcodeRequestResponse(
  pending: PendingZCodeRequest,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (pending.method === "permission") {
    const allowed = decision === "accept" || decision === "acceptForSession";
    return (
      zcodePermissionOptionResponse(pending.options, allowed ? "allow" : "deny") ?? {
        decision: allowed ? "allow" : "deny",
      }
    );
  }
  const questionId =
    pending.turnItem.type === "user_input_request" ? pending.turnItem.questions[0]?.id : undefined;
  const answer = questionId === undefined ? undefined : answers?.[questionId];
  return typeof answer === "string"
    ? { action: "accept", content: { value: answer } }
    : { action: "cancel" };
}

// ── driver ────────────────────────────────────────────────────

export type ZCodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocator.IdAllocatorV2
  | ServerConfig.ServerConfig;

export const ZCodeAdapterV2Driver: ProviderAdapterDriver<ZCodeSettings, ZCodeAdapterV2DriverEnv> = {
  driverKind: ZCODE_PROVIDER,
  configSchema: ZCodeSettings,
  defaultConfig: (): ZCodeSettings => DEFAULT_ZCODE_SETTINGS,
  create: Effect.fn("ZCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ZCodeSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig.ServerConfig;
      return makeZCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        spawner,
        idAllocator,
        serverConfig,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ZCODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create ZCode adapter.",
              cause,
            }),
        ),
      ),
  ),
};
