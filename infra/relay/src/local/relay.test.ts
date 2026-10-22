// @effect-diagnostics nodeBuiltinImport:off -- Real cryptographic keys and temporary disk state.
// @effect-diagnostics globalDate:off -- Test clock inputs.
import * as NodeTest from "node:test";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as Effect from "effect/Effect";
import {
  signRelayJwt,
  verifyRelayJwt,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
} from "@t3tools/shared/relayJwt";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createLocalRelay } from "./relay.ts";
import { computeDpopAccessTokenHash } from "@t3tools/shared/dpop";

const issuer = "https://relay.example.test";
const ec = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
function dpop(path: string, accessToken?: string) {
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: ec.publicKey.export({ format: "jwk" }) }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: "POST",
      htu: issuer + path,
      jti: NodeCrypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
    }),
  ).toString("base64url");
  return `${header}.${payload}.${NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), { key: ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const preferences = {
  notificationsEnabled: false,
  liveActivitiesEnabled: false,
  managedTunnelsEnabled: true,
};
const pair = NodeCrypto.generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
function linkProof(challenge: string, environmentId = "host-a") {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ typ: "t3-env-link+jwt", alg: "EdDSA" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: `t3-env:${environmentId}`,
      aud: issuer,
      sub: environmentId,
      jti: NodeCrypto.randomUUID(),
      iat: now,
      exp: now + 300,
      challenge,
      environmentId,
      environmentPublicKey: publicKey,
      descriptor: {
        environmentId,
        label: "Test host",
        platform: { os: "linux", arch: "arm64" },
        serverVersion: "test",
        capabilities: { repositoryIdentity: true },
      },
      endpoint: {
        httpBaseUrl: "https://attacker.example.test",
        wsBaseUrl: "wss://attacker.example.test/ws",
        providerKind: "manual",
      },
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      scopes: ["managed_tunnels"],
    }),
  ).toString("base64url");
  return `${header}.${payload}.${NodeCrypto.sign(null, Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
}

NodeTest.test(
  "owner sessions, signed registration and DPoP replay survive restart; revocation and offline hosts fail closed",
  async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "private-relay-"));
    const certificate = NodePath.join(directory, "fixture.crt");
    const key = NodePath.join(directory, "fixture.key");
    NodeChildProcess.execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        certificate,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const previousCAs = NodeTls.getCACertificates("default");
    NodeTls.setDefaultCACertificates([...previousCAs, NodeFS.readFileSync(certificate, "utf8")]);
    let relayPublicKey = "";
    let corrupt = false;
    const environmentServer = NodeHttps.createServer(
      { key: NodeFS.readFileSync(key), cert: NodeFS.readFileSync(certificate) },
      async (incoming, outgoing) => {
        try {
          const chunks = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const request = JSON.parse(Buffer.concat(chunks).toString());
          const mint = incoming.url === "/api/connect/mint-credential";
          const now = Math.floor(Date.now() / 1000);
          // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Native HTTPS callback drives the actual signing service.
          const proof = await Effect.runPromise(
            verifyRelayJwt({
              token: request.proof,
              publicKey: relayPublicKey,
              typ: mint ? RELAY_MINT_REQUEST_TYP : RELAY_HEALTH_REQUEST_TYP,
              issuer,
              audience: "t3-env:host-b",
              nowEpochSeconds: now,
            }),
          );
          const common = {
            iss: "t3-env:host-b",
            aud: issuer,
            sub: "owner",
            iat: now,
            exp: now + 60,
            jti: NodeCrypto.randomUUID(),
            environmentId: "host-b",
            requestNonce: corrupt ? "wrong" : proof.nonce,
          };
          const descriptor = {
            environmentId: "host-b",
            label: "Online fixture",
            platform: { os: "linux", arch: "arm64" },
            serverVersion: "test",
            capabilities: { repositoryIdentity: true },
          };
          const checkedAt = new Date().toISOString();
          const payload = mint
            ? {
                ...common,
                credential: "fixture-credential",
                clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
              }
            : { ...common, status: "online", descriptor, checkedAt };
          // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Native HTTPS callback drives the actual signing service.
          const signed = await Effect.runPromise(
            signRelayJwt({
              privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
              typ: mint ? RELAY_MINT_RESPONSE_TYP : RELAY_HEALTH_RESPONSE_TYP,
              payload,
            }),
          );
          outgoing.writeHead(200, { "content-type": "application/json" });
          outgoing.end(
            JSON.stringify(
              mint
                ? {
                    credential: "fixture-credential",
                    expiresAt: new Date((now + 60) * 1000).toISOString(),
                    proof: signed,
                  }
                : {
                    environmentId: "host-b",
                    status: "online",
                    descriptor,
                    checkedAt,
                    proof: signed,
                  },
            ),
          );
        } catch {
          outgoing.writeHead(401).end();
        }
      },
    );
    await new Promise<void>((resolve) => environmentServer.listen(0, "127.0.0.1", resolve));
    const address = environmentServer.address();
    NodeAssert.ok(address && typeof address === "object");
    const config = {
      issuer,
      stateDir: directory,
      allowedOrigins: [issuer],
      host: "127.0.0.1",
      port: 38443,
      tlsCertFile: "unused",
      tlsKeyFile: "unused",
      environments: [
        {
          environmentId: "host-b",
          environmentPublicKey: publicKey,
          httpBaseUrl: `https://127.0.0.1:${address.port}`,
        },
        {
          environmentId: "host-a",
          environmentPublicKey: publicKey,
          httpBaseUrl: "https://127.0.0.1:1",
        },
      ],
    };
    let relay = await createLocalRelay(config);
    relayPublicKey = relay.publicKey;
    const request = (
      path: string,
      method = "GET",
      token?: string,
      body?: unknown,
      extra?: Record<string, string>,
    ) =>
      relay.handle(
        new Request(issuer + path, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/json",
            ...extra,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    try {
      NodeAssert.equal((await request("/v1/environments")).status, 401);
      NodeAssert.equal(
        (await request("/v1/local/session", "POST", undefined, { secret: "wrong" })).status,
        401,
      );
      const login = await (
        await request("/v1/local/session", "POST", undefined, {
          secret: NodeFS.readFileSync(NodePath.join(directory, "owner-secret"), "utf8"),
        })
      ).json();
      const token = login.token;
      NodeAssert.equal((await request("/v1/local/session", "GET", token)).status, 200);
      NodeAssert.equal(
        (
          await request("/v1/environments", "GET", token, undefined, {
            origin: "https://attacker.example.test",
          })
        ).status,
        403,
      );
      const challenge = await (
        await request("/v1/client/environment-link-challenges", "POST", token, preferences)
      ).json();
      const registration = { ...preferences, proof: linkProof(challenge.challenge) };
      NodeAssert.equal(
        (await request("/v1/client/environment-links", "POST", undefined, registration)).status,
        401,
      );
      const linkedResponse = await request(
        "/v1/client/environment-links",
        "POST",
        token,
        registration,
      );
      NodeAssert.equal(linkedResponse.status, 200);
      const linked = await linkedResponse.json();
      NodeAssert.equal(linked.endpoint.httpBaseUrl, "https://127.0.0.1:1");
      NodeAssert.equal(linked.endpointRuntime, null);
      NodeAssert.equal(
        (await request("/v1/client/environment-links", "POST", token, registration)).status,
        401,
      );
      const exchange = {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: token,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        resource: issuer,
        scope: "environment:connect environment:status",
        client_id: "t3-web",
      };
      const exchangeProof = dpop("/v1/client/dpop-token");
      const exchanged = await request("/v1/client/dpop-token", "POST", undefined, exchange, {
        dpop: exchangeProof,
      });
      NodeAssert.equal(exchanged.status, 200);
      const accessToken = (await exchanged.json()).access_token;
      const statusPath = "/v1/environments/host-a/status";
      const statusProof = dpop(statusPath, accessToken);
      const status = await request(statusPath, "POST", undefined, undefined, {
        authorization: `DPoP ${accessToken}`,
        dpop: statusProof,
      });
      NodeAssert.equal(status.status, 200);
      NodeAssert.equal((await status.json()).status, "offline");
      const challengeB = await (
        await request("/v1/client/environment-link-challenges", "POST", token, preferences)
      ).json();
      NodeAssert.equal(
        (
          await request("/v1/client/environment-links", "POST", token, {
            ...preferences,
            proof: linkProof(challengeB.challenge, "host-b"),
          })
        ).status,
        200,
      );
      const onlinePath = "/v1/environments/host-b/status";
      const online = await request(onlinePath, "POST", undefined, undefined, {
        authorization: `DPoP ${accessToken}`,
        dpop: dpop(onlinePath, accessToken),
      });
      NodeAssert.equal(online.status, 200);
      NodeAssert.equal((await online.json()).status, "online");
      const connectPath = "/v1/environments/host-b/connect";
      const connected = await request(
        connectPath,
        "POST",
        undefined,
        {},
        { authorization: `DPoP ${accessToken}`, dpop: dpop(connectPath, accessToken) },
      );
      NodeAssert.equal(connected.status, 200);
      NodeAssert.equal((await connected.json()).credential, "fixture-credential");
      corrupt = true;
      NodeAssert.equal(
        (
          await request(
            connectPath,
            "POST",
            undefined,
            {},
            { authorization: `DPoP ${accessToken}`, dpop: dpop(connectPath, accessToken) },
          )
        ).status,
        502,
      );
      const mintKey = relay.publicKey;
      relay.close();
      relay = await createLocalRelay(config);
      NodeAssert.equal(relay.publicKey, mintKey);
      NodeAssert.equal(
        (await (await request("/v1/environments", "GET", token)).json()).environments.length,
        2,
      );
      NodeAssert.equal(
        (
          await request("/v1/client/dpop-token", "POST", undefined, exchange, {
            dpop: exchangeProof,
          })
        ).status,
        401,
      );
      NodeAssert.equal(
        (
          await request(statusPath, "POST", undefined, undefined, {
            authorization: `DPoP ${accessToken}`,
            dpop: statusProof,
          })
        ).status,
        401,
      );
      NodeAssert.equal(
        (await request("/v1/client/environment-links", "POST", token, registration)).status,
        401,
      );
      NodeAssert.equal((await request("/v1/local/session", "DELETE", token)).status, 200);
      NodeAssert.equal((await request("/v1/environments", "GET", token)).status, 401);
      NodeAssert.equal(
        (
          await request(statusPath, "POST", undefined, undefined, {
            authorization: `DPoP ${accessToken}`,
            dpop: dpop(statusPath, accessToken),
          })
        ).status,
        401,
      );
    } finally {
      relay.close();
      await new Promise<void>((resolve) => environmentServer.close(() => resolve()));
      NodeTls.setDefaultCACertificates(previousCAs);
      NodeFS.rmSync(directory, { recursive: true });
    }
  },
);

NodeTest.test("rejects insecure relay and environment endpoints", async () => {
  await NodeAssert.rejects(
    createLocalRelay({
      issuer: "http://relay.example.test",
      stateDir: "/unused",
      allowedOrigins: [],
      host: "127.0.0.1",
      port: 38443,
      tlsCertFile: "unused",
      tlsKeyFile: "unused",
      environments: [],
    }),
  );
  await NodeAssert.rejects(
    createLocalRelay({
      issuer,
      stateDir: "/unused",
      allowedOrigins: [],
      host: "127.0.0.1",
      port: 38443,
      tlsCertFile: "unused",
      tlsKeyFile: "unused",
      environments: [
        { environmentId: "host", environmentPublicKey: publicKey, httpBaseUrl: "http://127.0.0.1" },
      ],
    }),
  );
});

NodeTest.test(
  "preflight permits the instrumented relay client's headers only for allowed origins",
  async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "private-relay-cors-"));
    const clientOrigin = "https://client.example.test";
    const relay = await createLocalRelay({
      issuer,
      stateDir: directory,
      allowedOrigins: [clientOrigin],
      host: "127.0.0.1",
      port: 38443,
      tlsCertFile: "unused",
      tlsKeyFile: "unused",
      environments: [],
    });
    const requestedHeaders = ["authorization", "b3", "traceparent", "content-type", "dpop"];
    const preflight = (origin: string) =>
      relay.handle(
        new Request(`${issuer}/v1/environments`, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "GET",
            "access-control-request-headers": requestedHeaders.join(","),
          },
        }),
      );
    try {
      const allowed = await preflight(clientOrigin);
      NodeAssert.equal(allowed.status, 204);
      NodeAssert.equal(allowed.headers.get("access-control-allow-origin"), clientOrigin);
      const permittedHeaders = new Set(
        allowed.headers
          .get("access-control-allow-headers")
          ?.split(",")
          .map((header) => header.trim()),
      );
      for (const header of requestedHeaders)
        NodeAssert.ok(permittedHeaders.has(header), `Browser must permit ${header}`);
      NodeAssert.equal(permittedHeaders.has("*"), false);
      NodeAssert.equal(permittedHeaders.has("x-arbitrary-header"), false);
      const denied = await preflight("https://untrusted.example.test");
      NodeAssert.equal(denied.status, 403);
      NodeAssert.equal(denied.headers.get("access-control-allow-origin"), null);
    } finally {
      relay.close();
      NodeFS.rmSync(directory, { recursive: true });
    }
  },
);
