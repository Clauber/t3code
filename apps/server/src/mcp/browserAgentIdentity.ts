export const browserAgentSessionId = (environmentId: string, mcpSessionId: string): string =>
  `${environmentId}\u0000${mcpSessionId}`;
