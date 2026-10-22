// @effect-diagnostics globalDate:off -- Native Node runtime adapter.
// @effect-diagnostics globalFetch:off -- Native Node runtime adapter.
// @effect-diagnostics nodeBuiltinImport:off -- Native Node transport adapter; shared security logic remains in Effect services.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts/relay";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import {
  decodeRelayJwt,
  signRelayJwt,
  verifyRelayJwt,
  RELAY_LINK_PROOF_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_HEALTH_REQUEST_TYP,
} from "@t3tools/shared/relayJwt";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as Configuration from "../Config.ts";
import {
  verifyEnvironmentResponse,
  verifyEnvironmentHealthResponse,
} from "../environments/EnvironmentResponse.ts";
import { validateConfig } from "./config.ts";
import { hash, nowSeconds, openState, secret } from "./state.ts";

class Rejected extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const reject = (status = 401): never => {
  throw new Rejected(status, "Request rejected");
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const Login = Schema.Struct({ secret: Schema.String });
const LinkRow = Schema.Struct({
  id: Schema.String,
  public_key: Schema.String,
  label: Schema.String,
  linked_at: Schema.String,
});

const decodeLogin = Schema.decodeUnknownSync(Login);
const decodeRelayDpopAccessTokenRequest = Schema.decodeUnknownSync(C.RelayDpopAccessTokenRequest);
const decodeRelayEnvironmentConnectRequest = Schema.decodeUnknownSync(
  C.RelayEnvironmentConnectRequest,
);
const decodeRelayEnvironmentMintResponse = Schema.decodeUnknownSync(C.RelayEnvironmentMintResponse);
const decodeRelayEnvironmentHealthResponse = Schema.decodeUnknownSync(
  C.RelayEnvironmentHealthResponse,
);
const decodeLinkRow = Schema.decodeUnknownSync(LinkRow);
const decodeRelayEnvironmentLinkChallengeRequest = Schema.decodeUnknownSync(
  C.RelayEnvironmentLinkChallengeRequest,
);
const decodeRelayEnvironmentLinkRequest = Schema.decodeUnknownSync(C.RelayEnvironmentLinkRequest);
const decodeRelayEnvironmentLinkProofPayload = Schema.decodeUnknownSync(
  C.RelayEnvironmentLinkProofPayload,
);

export async function createLocalRelay(input: unknown) {
  const config = validateConfig(input);
  const state = openState(config.stateDir);
  const tokens = await Effect.runPromise(
    RelayTokens.RelayTokens.pipe(
      Effect.provide(
        RelayTokens.layer.pipe(
          Layer.provide(
            Configuration.layer({
              relayIssuer: config.issuer,
              cloudMintPrivateKey: Redacted.make(state.keys.privateKey),
              cloudMintPublicKey: state.keys.publicKey,
              apns: null,
              clerkSecretKey: Redacted.make("unused"),
              clerkPublishableKey: "unused",
              clerkJwtAudience: "unused",
              apnsDeliveryJobSigningSecret: Redacted.make("unused"),
              managedEndpointBaseDomain: undefined,
              managedEndpointNamespace: undefined,
            }),
          ),
        ),
      ),
    ),
  );
  const endpointFor = (environment: LocalRelayConfigEnvironment) => ({
    httpBaseUrl: new URL(environment.httpBaseUrl).origin,
    wsBaseUrl: `${new URL(environment.httpBaseUrl).origin.replace(/^https:/u, "wss:")}/ws`,
    providerKind: "manual" as const,
  });
  type LocalRelayConfigEnvironment = (typeof config.environments)[number];
  const allowed = (id: string) =>
    config.environments.find((environment) => environment.environmentId === id) ?? reject(403);
  const bearer = (request: Request) => {
    const authorization = request.headers.get("authorization");
    return authorization?.startsWith("Bearer ") ? authorization.slice(7) : reject();
  };
  const authenticate = (request: Request) => state.session(bearer(request)) ?? reject();
  function proof(request: Request, expectedThumbprint?: string, expectedAccessToken?: string) {
    const result = verifyDpopProof({
      proof: request.headers.get("dpop") ?? undefined,
      method: request.method,
      url: request.url,
      nowEpochSeconds: nowSeconds(),
      ...(expectedThumbprint ? { expectedThumbprint } : {}),
      ...(expectedAccessToken ? { expectedAccessToken } : {}),
    });
    if (!result.ok) return reject();
    if (!state.consume(`dpop:${result.thumbprint}:${result.jti}`, nowSeconds() + 600))
      return reject();
    return result.thumbprint;
  }
  async function body(request: Request): Promise<unknown> {
    const text = await request.text();
    if (text.length > 64 * 1024) return reject(413);
    try {
      return request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(text))
        : JSON.parse(text);
    } catch {
      return reject(400);
    }
  }
  async function dispatch(request: Request) {
    const url = new URL(request.url);
    if (url.origin !== config.issuer) return reject(400);
    const path = url.pathname;
    const now = nowSeconds();
    state.prune();
    if (path === "/health" && request.method === "GET") return json({ ok: true, service: "relay" });
    if (path === "/v1/local/session") {
      if (request.method === "POST") {
        const login = decodeLogin(await body(request));
        if (
          !NodeCrypto.timingSafeEqual(
            Buffer.from(hash(login.secret)),
            Buffer.from(hash(state.ownerSecret)),
          )
        )
          return reject();
        const token = secret();
        const expires = now + 30 * 86400;
        state.db.prepare("INSERT INTO sessions VALUES (?,?)").run(hash(token), expires);
        return json({
          token,
          accountId: "owner",
          expiresAt: new Date(expires * 1000).toISOString(),
        });
      }
      const session = authenticate(request);
      if (request.method === "DELETE") {
        state.db.prepare("DELETE FROM sessions WHERE hash=?").run(session);
        return json({ ok: true });
      }
      if (request.method === "GET") {
        const row = state.db.prepare("SELECT expires FROM sessions WHERE hash=?").get(session);
        return json({
          accountId: "owner",
          expiresAt: new Date(Number(row?.expires) * 1000).toISOString(),
        });
      }
      return reject(405);
    }
    if (path === "/v1/client/dpop-token" && request.method === "POST") {
      const exchange = decodeRelayDpopAccessTokenRequest(await body(request));
      const session = state.session(exchange.subject_token) ?? reject();
      if (exchange.resource !== config.issuer) return reject();
      const scopes = tokens.resolveDpopAccessTokenScopes({
        clientId: exchange.client_id,
        scope: exchange.scope,
      });
      if (!scopes || scopes.includes("mobile:registration")) return reject(403);
      const thumbprint = proof(request);
      const id = NodeCrypto.randomUUID();
      const token = await Effect.runPromise(
        tokens.issueDpopAccessToken({
          userId: "owner",
          proofKeyThumbprint: thumbprint,
          jti: id,
          issuedAtEpochSeconds: now,
          expiresAtEpochSeconds: now + 1800,
          clientId: exchange.client_id,
          scopes,
        }),
      );
      state.db.prepare("INSERT INTO access VALUES (?,?,?)").run(id, session, now + 1800);
      return json({
        access_token: token,
        issued_token_type: C.RelayAccessTokenType,
        token_type: "DPoP",
        expires_in: 1800,
        scope: scopes.join(" "),
      });
    }
    const operation = /^\/v1\/environments\/([^/]+)\/(connect|status)$/u.exec(path);
    if (operation && request.method === "POST") {
      const authorization = request.headers.get("authorization");
      const token = authorization?.startsWith("DPoP ") ? authorization.slice(5) : reject();
      const claims = await Effect.runPromise(
        tokens.verifyDpopAccessToken({ token, nowEpochSeconds: now }),
      );
      if (
        !claims ||
        claims.exp <= now ||
        !claims.scope.includes(
          operation[2] === "connect" ? "environment:connect" : "environment:status",
        )
      )
        return reject();
      const thumbprint = proof(request, claims.cnf.jkt, token);
      const environment = allowed(decodeURIComponent(operation[1]!));
      const assertAccess = () => {
        const current = nowSeconds();
        if (
          !state.db
            .prepare(
              "SELECT access.id FROM access JOIN sessions ON sessions.hash=access.session WHERE access.id=? AND access.expires>? AND sessions.expires>?",
            )
            .get(claims.jti, current, current)
        )
          reject();
        const link = state.db
          .prepare("SELECT public_key FROM links WHERE id=?")
          .get(environment.environmentId);
        if (link?.public_key !== environment.environmentPublicKey) reject(403);
      };
      assertAccess();
      const endpoint = endpointFor(environment);
      const connect = operation[2] === "connect";
      const connectRequest = connect
        ? decodeRelayEnvironmentConnectRequest(await body(request))
        : {};
      if (
        (connectRequest.clientProofKeyThumbprint &&
          connectRequest.clientProofKeyThumbprint !== thumbprint) ||
        (connectRequest.clientKeyThumbprint && connectRequest.clientKeyThumbprint !== thumbprint)
      )
        return reject();
      const nonce = NodeCrypto.randomUUID();
      const requestProof = await Effect.runPromise(
        signRelayJwt({
          privateKey: state.keys.privateKey,
          typ: connect ? RELAY_MINT_REQUEST_TYP : RELAY_HEALTH_REQUEST_TYP,
          payload: {
            iss: config.issuer,
            aud: `t3-env:${environment.environmentId}`,
            sub: "owner",
            jti: NodeCrypto.randomUUID(),
            iat: now,
            exp: now + 120,
            environmentId: environment.environmentId,
            nonce,
            scope: [connect ? "environment:connect" : "environment:status"],
            ...(connect
              ? {
                  clientProofKeyThumbprint: thumbprint,
                  cnf: { jkt: thumbprint },
                  ...(connectRequest.deviceId ? { deviceId: connectRequest.deviceId } : {}),
                }
              : {}),
          },
        }),
      );
      let response: Response;
      try {
        response = await fetch(
          `${endpoint.httpBaseUrl}${connect ? "/api/connect/mint-credential" : "/api/t3-connect/health"}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ proof: requestProof }),
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok) throw new Error("Environment unavailable");
      } catch {
        if (connect) return reject(502);
        return json({
          environmentId: environment.environmentId,
          endpoint,
          status: "offline",
          checkedAt: new Date().toISOString(),
          error: "Private endpoint unavailable",
        });
      }
      const common = {
        environmentId: environment.environmentId,
        requestNonce: nonce,
        environmentPublicKeys: [environment.environmentPublicKey],
        relayIssuer: config.issuer,
      };
      if (connect) {
        const mint = decodeRelayEnvironmentMintResponse(await response.json());
        if (
          !(await Effect.runPromise(
            verifyEnvironmentResponse({
              ...common,
              response: mint,
              clientProofKeyThumbprint: thumbprint,
              nowEpochSeconds: nowSeconds(),
            }),
          ))
        )
          return reject(502);
        assertAccess();
        return json({
          environmentId: environment.environmentId,
          endpoint,
          credential: mint.credential,
          expiresAt: mint.expiresAt,
        });
      }
      const health = decodeRelayEnvironmentHealthResponse(await response.json());
      if (
        !(await Effect.runPromise(
          verifyEnvironmentHealthResponse({
            ...common,
            response: health,
            requestIssuedAt: DateTime.makeUnsafe(now * 1000),
            now: DateTime.makeUnsafe(Date.now()),
          }),
        ))
      )
        return reject(502);
      assertAccess();
      return json({
        environmentId: environment.environmentId,
        endpoint,
        status: health.status,
        descriptor: health.descriptor,
        checkedAt: health.checkedAt,
      });
    }
    authenticate(request);
    if (path === "/v1/environments" && request.method === "GET") {
      const rows = state.db
        .prepare("SELECT id,public_key,label,linked_at FROM links")
        .all()
        .map((row) => decodeLinkRow(row));
      return json({
        environments: rows.flatMap((row) => {
          const environment = config.environments.find(
            (item) => item.environmentId === row.id && item.environmentPublicKey === row.public_key,
          );
          return environment
            ? [
                {
                  environmentId: row.id,
                  label: row.label,
                  linkedAt: row.linked_at,
                  endpoint: endpointFor(environment),
                },
              ]
            : [];
        }),
      });
    }
    if (path === "/v1/client/environment-link-challenges" && request.method === "POST") {
      const preferences = decodeRelayEnvironmentLinkChallengeRequest(await body(request));
      if (preferences.notificationsEnabled || preferences.liveActivitiesEnabled) return reject(400);
      const challenge = await Effect.runPromise(
        tokens.issueLinkChallenge({
          userId: "owner",
          request: preferences,
          jti: NodeCrypto.randomUUID(),
          issuedAtEpochSeconds: now,
          expiresAtEpochSeconds: now + 300,
        }),
      );
      return json({ challenge, expiresAt: new Date((now + 300) * 1000).toISOString() });
    }
    if (path === "/v1/client/environment-links" && request.method === "POST") {
      const link = decodeRelayEnvironmentLinkRequest(await body(request));
      if (link.notificationsEnabled || link.liveActivitiesEnabled) return reject(400);
      const candidate = decodeRelayEnvironmentLinkProofPayload(decodeRelayJwt(link.proof));
      const environment = allowed(candidate.environmentId);
      if (candidate.environmentPublicKey !== environment.environmentPublicKey) return reject(403);
      const verified = await Effect.runPromise(
        verifyRelayJwt({
          publicKey: environment.environmentPublicKey,
          token: link.proof,
          typ: RELAY_LINK_PROOF_TYP,
          issuer: `t3-env:${environment.environmentId}`,
          audience: config.issuer,
          nowEpochSeconds: now,
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(C.RelayEnvironmentLinkProofPayload))),
      ).catch(() => reject());
      if (
        verified.exp <= now ||
        verified.sub !== environment.environmentId ||
        verified.descriptor.environmentId !== environment.environmentId ||
        (link.managedTunnelsEnabled && !verified.scopes.includes("managed_tunnels"))
      )
        return reject();
      const challenge = await Effect.runPromise(
        tokens.verifyLinkChallenge({
          token: verified.challenge,
          userId: "owner",
          request: link,
          nowEpochSeconds: now,
        }),
      );
      if (!challenge || challenge.exp <= now) return reject();
      authenticate(request);
      const credential = secret();
      state.db.exec("BEGIN IMMEDIATE");
      try {
        if (
          !state.consume(`link:${environment.environmentId}:${verified.jti}`, verified.exp) ||
          !state.consume(`challenge:${challenge.jti}`, challenge.exp)
        )
          reject();
        state.db
          .prepare(
            "INSERT INTO links VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,label=excluded.label,linked_at=excluded.linked_at,credential_hash=excluded.credential_hash",
          )
          .run(
            environment.environmentId,
            environment.environmentPublicKey,
            verified.descriptor.label,
            new Date().toISOString(),
            hash(credential),
          );
        state.db.exec("COMMIT");
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
      return json({
        ok: true,
        cloudUserId: "owner",
        environmentId: environment.environmentId,
        endpoint: endpointFor(environment),
        endpointRuntime: null,
        relayIssuer: config.issuer,
        environmentCredential: credential,
        cloudMintPublicKey: state.keys.publicKey,
      });
    }
    const unlink = /^\/v1\/client\/environment-links\/([^/]+)$/u.exec(path);
    if (unlink && request.method === "DELETE") {
      state.db.prepare("DELETE FROM links WHERE id=?").run(decodeURIComponent(unlink[1]!));
      return json({ ok: true });
    }
    return reject(404);
  }
  async function handle(request: Request) {
    const origin = request.headers.get("origin");
    if (origin && !config.allowedOrigins.includes(origin))
      return json({ error: "Origin rejected" }, 403);
    let response;
    try {
      response =
        request.method === "OPTIONS"
          ? new Response(null, { status: 204 })
          : await dispatch(request);
    } catch (error) {
      const status =
        error instanceof Rejected ? error.status : Schema.isSchemaError(error) ? 400 : 500;
      response =
        status === 401
          ? json(
              {
                _tag: "RelayAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_bearer",
                traceId: NodeCrypto.randomUUID(),
              },
              status,
            )
          : json({ error: "Request rejected" }, status);
    }
    response.headers.set("cache-control", "no-store");
    if (origin) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "Origin");
      response.headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      response.headers.set(
        "access-control-allow-headers",
        "authorization, b3, traceparent, content-type, dpop",
      );
    }
    return response;
  }
  return { handle, close: state.close, publicKey: state.keys.publicKey };
}
