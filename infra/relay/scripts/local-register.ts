// @effect-diagnostics nodeBuiltinImport:off -- Operator CLI reads credential files and signs a DPoP key.
// @effect-diagnostics globalFetch:off -- Native Node CLI transport.
// @effect-diagnostics globalDate:off -- JWT timestamps and backup directory names.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { verifyRelayJwt, RELAY_LINK_PROOF_TYP } from "@t3tools/shared/relayJwt";
import {
  postRegistrationTarget,
  registrationMode,
  registrationTarget,
} from "../src/local/registration.ts";
import * as C from "@t3tools/contracts/relay";
import { EnvironmentCloudRelayConfigResult } from "@t3tools/contracts";
import { computeDpopAccessTokenHash } from "@t3tools/shared/dpop";
import { validateConfig } from "../src/local/config.ts";

const AuthFile = Schema.Struct({ token: Schema.String });
const Session = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
const decodeAuth = Schema.decodeUnknownSync(AuthFile);
const decodeSession = Schema.decodeUnknownSync(Session);
const decodeChallenge = Schema.decodeUnknownSync(C.RelayEnvironmentLinkChallengeResponse);
const decodeProof = Schema.decodeUnknownSync(C.RelayEnvironmentLinkProof);
const decodeLink = Schema.decodeUnknownSync(C.RelayEnvironmentLinkResponse);
const decodeConfigResult = Schema.decodeUnknownSync(EnvironmentCloudRelayConfigResult);
const isDisabledRuntime = Schema.is(Schema.Struct({ status: Schema.Literal("disabled") }));
const decodeAccess = Schema.decodeUnknownSync(C.RelayDpopAccessTokenResponse);
const decodeStatus = Schema.decodeUnknownSync(C.RelayEnvironmentStatusResponse);
const decodeConnect = Schema.decodeUnknownSync(C.RelayEnvironmentConnectResponse);
const encodeLinkProof = Schema.decodeUnknownSync(C.RelayLinkProofRequest);
const encodeRelayConfig = Schema.decodeUnknownSync(C.RelayEnvironmentConfigRequest);

const [
  configFile,
  authFile,
  ownerSecretFile,
  serverOrigin,
  targetHome,
  backupRoot,
  ...modeArguments
] = process.argv.slice(2);
if (!configFile || !authFile || !ownerSecretFile || !serverOrigin || !targetHome || !backupRoot) {
  throw new Error(
    "Usage (from worktree root): node --experimental-strip-types infra/relay/scripts/local-register.ts CONFIG ADMIN_TOKEN_JSON OWNER_SECRET_FILE LOOPBACK_SERVER_ORIGIN TARGET_HOME_OR_SNAPSHOT BACKUP_DIRECTORY [--live EXPECTED_ENVIRONMENT_ID | --snapshot EXPECTED_ENVIRONMENT_ID]",
  );
}
const config = validateConfig(JSON.parse(NodeFS.readFileSync(configFile, "utf8")));
const home = NodeFS.realpathSync(targetHome);
const runtime = JSON.parse(
  NodeFS.readFileSync(NodePath.join(home, "userdata/server-runtime.json"), "utf8"),
);
const environmentId = NodeFS.readFileSync(
  NodePath.join(home, "userdata/environment-id"),
  "utf8",
).trim();
const mode = registrationMode(modeArguments);
const isolatedPath = NodePath.join(process.cwd(), ".t3");
const target = registrationTarget({
  mode,
  home,
  isolatedHome: NodeFS.existsSync(isolatedPath) ? NodeFS.realpathSync(isolatedPath) : isolatedPath,
  transportOrigin: serverOrigin,
  runtime,
  environmentId,
  pinnedEnvironmentIds: config.environments.map((entry) => entry.environmentId),
});
const environment = config.environments.find((entry) => entry.environmentId === environmentId);
if (!environment) throw new Error("Target environment is not pinned in relay config");
const adminToken = decodeAuth(JSON.parse(NodeFS.readFileSync(authFile, "utf8"))).token;
const ownerSecret = NodeFS.readFileSync(ownerSecretFile, "utf8").trim();
const backup = NodePath.join(backupRoot, `relay-config-${Date.now()}`);
NodeFS.mkdirSync(backup, { recursive: true, mode: 0o700 });
const secrets = NodePath.join(home, "userdata/secrets");
const files = NodeFS.readdirSync(secrets).filter(
  (name) => name.startsWith("cloud-") && name.endsWith(".bin"),
);
for (const name of files) {
  NodeFS.copyFileSync(NodePath.join(secrets, name), NodePath.join(backup, name));
  NodeFS.chmodSync(NodePath.join(backup, name), 0o600);
}
NodeFS.writeFileSync(
  NodePath.join(backup, "manifest.json"),
  JSON.stringify({ targetHome: home, mode: mode.kind, environmentId, files }, null, 2),
  { mode: 0o600 },
);
process.stdout.write(`Backed up ${files.length} cloud configuration files to ${backup}\n`);

async function post(url: string, payload: unknown, token?: string, dpop?: string) {
  const response =
    new URL(url).origin === target.transportOrigin
      ? await postRegistrationTarget(target, new URL(url).pathname, payload, token ?? "")
      : await fetch(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `${dpop ? "DPoP" : "Bearer"} ${token}` } : {}),
            ...(dpop ? { dpop } : {}),
          },
          body: JSON.stringify(payload),
        });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const details =
      typeof body === "object" && body !== null
        ? Object.fromEntries(
            Object.entries(body).filter(
              ([name, value]) =>
                ["_tag", "code", "reason", "operation"].includes(name) && typeof value === "string",
            ),
          )
        : {};
    throw new Error(`${new URL(url).pathname}: HTTP ${response.status} ${JSON.stringify(details)}`);
  }
  return response.json();
}
const session = decodeSession(
  await post(`${config.issuer}/v1/local/session`, { secret: ownerSecret }),
);
try {
  const preferences = {
    notificationsEnabled: false,
    liveActivitiesEnabled: false,
    managedTunnelsEnabled: false,
  };
  const challenge = decodeChallenge(
    await post(
      `${config.issuer}/v1/client/environment-link-challenges`,
      preferences,
      session.token,
    ),
  );
  const proof = decodeProof(
    await post(
      `${target.transportOrigin}/api/connect/link-proof`,
      encodeLinkProof({
        challenge: challenge.challenge,
        relayIssuer: config.issuer,
        endpoint: {
          httpBaseUrl: environment.httpBaseUrl,
          wsBaseUrl: `${environment.httpBaseUrl.replace(/^https:/u, "wss:")}/ws`,
          providerKind: "manual",
        },
        origin: target.proofOrigin,
      }),
      adminToken,
    ),
  );
  const verifiedProof = await Effect.runPromise(
    verifyRelayJwt({
      publicKey: environment.environmentPublicKey,
      token: proof,
      typ: RELAY_LINK_PROOF_TYP,
      issuer: `t3-env:${environmentId}`,
      audience: config.issuer,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(C.RelayEnvironmentLinkProofPayload))),
  );
  if (
    verifiedProof.environmentId !== environmentId ||
    verifiedProof.environmentPublicKey.trim() !== environment.environmentPublicKey ||
    verifiedProof.challenge !== challenge.challenge
  )
    throw new Error("Target proof does not match pinned identity and challenge");
  const linked = decodeLink(
    await post(
      `${config.issuer}/v1/client/environment-links`,
      { ...preferences, proof },
      session.token,
    ),
  );
  if (linked.environmentId !== environmentId || linked.endpointRuntime !== null)
    throw new Error("Relay returned unexpected environment or tunnel runtime");
  const applied = decodeConfigResult(
    await post(
      `${target.transportOrigin}/api/connect/relay-config`,
      encodeRelayConfig({
        relayUrl: config.issuer,
        relayIssuer: linked.relayIssuer,
        cloudUserId: linked.cloudUserId,
        environmentCredential: linked.environmentCredential,
        cloudMintPublicKey: linked.cloudMintPublicKey,
        endpointRuntime: null,
      }),
      adminToken,
    ),
  );
  if (!applied.ok || !isDisabledRuntime(applied.endpointRuntimeStatus))
    throw new Error("Relay configuration did not disable external tunnel runtime");
  process.stdout.write(`Registered environment ${environmentId}; endpoint runtime disabled\n`);
  const pair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const proofFor = (url: string, accessToken?: string) => {
    const header = Buffer.from(
      JSON.stringify({
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: pair.publicKey.export({ format: "jwk" }),
      }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        htm: "POST",
        htu: url,
        jti: NodeCrypto.randomUUID(),
        iat: Math.floor(Date.now() / 1000),
        ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
      }),
    ).toString("base64url");
    return `${header}.${payload}.${NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const accessUrl = `${config.issuer}/v1/client/dpop-token`;
  const access = decodeAccess(
    await post(
      accessUrl,
      {
        grant_type: C.RelayDpopTokenExchangeGrantType,
        subject_token: session.token,
        subject_token_type: C.RelayJwtSubjectTokenType,
        requested_token_type: C.RelayAccessTokenType,
        resource: config.issuer,
        scope: "environment:connect environment:status",
        client_id: "t3-web",
      },
      undefined,
      proofFor(accessUrl),
    ),
  );
  const statusUrl = `${config.issuer}/v1/environments/${environmentId}/status`;
  const status = decodeStatus(
    await post(statusUrl, {}, access.access_token, proofFor(statusUrl, access.access_token)),
  );
  if (status.status !== "online")
    throw new Error(`Signed health did not report online: ${status.error ?? "unavailable"}`);
  const connectUrl = `${config.issuer}/v1/environments/${environmentId}/connect`;
  const connected = decodeConnect(
    await post(connectUrl, {}, access.access_token, proofFor(connectUrl, access.access_token)),
  );
  if (connected.environmentId !== environmentId)
    throw new Error("Credential minted for unexpected environment");
  process.stdout.write(
    `Verified signed health and DPoP-bound credential mint against real target server; credential expires ${connected.expiresAt}\n`,
  );
} finally {
  const revoked = await fetch(`${config.issuer}/v1/local/session`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${session.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!revoked?.ok) {
    process.stderr.write(
      `Bootstrap session revocation failed: ${revoked ? `HTTP ${revoked.status}` : "network unavailable"}\n`,
    );
    process.exitCode = 1;
  }
}
