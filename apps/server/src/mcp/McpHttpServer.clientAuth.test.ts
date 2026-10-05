import { expect, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-client-auth");

const layerFor = (session: EnvironmentAuth.AuthenticatedSession | undefined) =>
  Layer.mergeAll(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: () => Effect.succeed(undefined),
    }),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      authenticateHttpRequest: () =>
        session === undefined
          ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}))
          : Effect.succeed(session),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  );

/** Runs one request through the MCP auth middleware and reports the scope it granted. */
const authenticate = (
  session: EnvironmentAuth.AuthenticatedSession | undefined,
  authorization: string | undefined,
) =>
  Effect.gen(function* () {
    const middleware = yield* McpHttpServer.makeMcpAuthMiddleware;
    let granted: McpInvocationContext.McpInvocationScope | undefined;
    const response = yield* middleware(
      Effect.gen(function* () {
        granted = yield* McpInvocationContext.McpInvocationContext;
        return HttpServerResponse.text("ok");
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://127.0.0.1/mcp", {
            method: "POST",
            headers: authorization === undefined ? {} : { authorization },
          }),
        ),
      ),
    );
    return { status: response.status, granted };
  }).pipe(Effect.provide(layerFor(session)));

const bearerSession = {
  sessionId: AuthSessionId.make("session-omb"),
  subject: "openmausbot",
  method: "bearer-access-token",
  scopes: AuthAdministrativeScopes,
} satisfies EnvironmentAuth.AuthenticatedSession;

it.effect("accepts an environment bearer session as a client caller", () =>
  Effect.gen(function* () {
    const { status, granted } = yield* authenticate(bearerSession, "Bearer session-token");
    expect(status).toBe(200);
    expect(granted?.thread).toBeUndefined();
    expect(granted?.client).toEqual({
      sessionId: "session-omb",
      label: "openmausbot",
      runtimeModeCeiling: "full-access",
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
    const { status, granted } = yield* authenticate(
      { ...bearerSession, method: "browser-session-cookie" },
      undefined,
    );
    expect(status).toBe(401);
    expect(granted).toBeUndefined();
  }),
);

it.effect("rejects bearer sessions without orchestration operate scope", () =>
  Effect.gen(function* () {
    const { status } = yield* authenticate(
      { ...bearerSession, scopes: [AuthOrchestrationReadScope] },
      "Bearer session-token",
    );
    expect(status).toBe(401);
  }),
);

it.effect("rejects unknown bearer tokens", () =>
  Effect.gen(function* () {
    const { status } = yield* authenticate(undefined, "Bearer nope");
    expect(status).toBe(401);
  }),
);
