import type { ManagedBrowserAgentIdentity, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { browserAgentSessionId } from "../mcp/browserAgentIdentity.ts";
import { readMcpProviderSession } from "../mcp/McpProviderSession.ts";
import type { McpSessionRegistryShape } from "../mcp/McpSessionRegistry.ts";

/** Resolve the injected MCP principal, never the orchestration runtime's shared session id. */
export const readAgentIdentity = (
  threadId: ThreadId,
  registry: Pick<McpSessionRegistryShape, "describe">,
): Effect.Effect<ManagedBrowserAgentIdentity> =>
  Effect.gen(function* () {
    const current = readMcpProviderSession(threadId);
    if (!current) return { agentSessionId: null };
    const scope = yield* registry.describe(current.providerSessionId);
    if (
      readMcpProviderSession(threadId) !== current ||
      !scope ||
      scope.thread.threadId !== threadId ||
      scope.environmentId !== current.environmentId ||
      scope.thread.providerInstanceId !== current.providerInstanceId ||
      scope.thread.providerSessionId !== current.providerSessionId ||
      !scope.capabilities.has("preview")
    )
      return { agentSessionId: null };
    return {
      agentSessionId: browserAgentSessionId(scope.environmentId, scope.thread.providerSessionId),
    };
  });
