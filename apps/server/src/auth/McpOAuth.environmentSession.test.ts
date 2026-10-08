import { expect, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";

const environmentId = EnvironmentId.make("environment-client-auth");

/** Authenticates one request as a token that is not an MCP client session. */
const authenticate = (session: EnvironmentAuth.AuthenticatedSession | undefined) =>
  Effect.gen(function* () {
    const authenticator = yield* McpHttpServer.McpClientAuthenticator;
    return yield* authenticator.authenticate(
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: { authorization: "Bearer session-token" },
        }),
      ),
    );
  }).pipe(
    Effect.provide(
      McpOAuth.layerMcpClientAuthenticator.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateMcpClient: () =>
                Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({})),
              authenticateHttpRequest: () =>
                session === undefined
                  ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}))
                  : Effect.succeed(session),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(environmentId),
            }),
          ),
        ),
      ),
    ),
  );

const bearerSession = {
  sessionId: AuthSessionId.make("session-omb"),
  subject: "openmausbot",
  method: "bearer-access-token",
  scopes: AuthAdministrativeScopes,
} satisfies EnvironmentAuth.AuthenticatedSession;

it.effect("accepts an environment bearer session as a full-access client caller", () =>
  Effect.gen(function* () {
    const granted = yield* authenticate(bearerSession);
    expect(granted?.thread).toBeUndefined();
    expect(granted?.client).toEqual({
      sessionId: "session-omb",
      label: "openmausbot",
      access: "full-access",
    });
    expect([...(granted?.capabilities ?? [])].toSorted()).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

it.effect("rejects browser cookie sessions even when they authenticate", () =>
  Effect.gen(function* () {
    expect(yield* authenticate({ ...bearerSession, method: "browser-session-cookie" })).toBe(
      undefined,
    );
  }),
);

it.effect("rejects bearer sessions without orchestration operate scope", () =>
  Effect.gen(function* () {
    expect(yield* authenticate({ ...bearerSession, scopes: [AuthOrchestrationReadScope] })).toBe(
      undefined,
    );
  }),
);

it.effect("rejects unknown bearer tokens", () =>
  Effect.gen(function* () {
    expect(yield* authenticate(undefined)).toBe(undefined);
  }),
);
