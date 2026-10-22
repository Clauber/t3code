import {
  RelayEnvironmentHealthResponseProofPayload,
  RelayEnvironmentMintResponseProofPayload,
  type RelayEnvironmentHealthResponse,
  type RelayEnvironmentMintResponse,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_RESPONSE_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
const ENVIRONMENT_HEALTH_CLOCK_SKEW_MILLIS = 60 * 1_000;
const decodeMintResponseProof = Schema.decodeUnknownEffect(
  RelayEnvironmentMintResponseProofPayload,
);
const decodeHealthResponseProof = Schema.decodeUnknownEffect(
  RelayEnvironmentHealthResponseProofPayload,
);
const verifyWithEnvironmentKeys = Effect.fnUntraced(function* <A, E>(input: {
  readonly token: string;
  readonly typ: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowEpochSeconds: number;
  readonly environmentPublicKeys: ReadonlyArray<string>;
  readonly decodePayload: (input: unknown) => Effect.Effect<A, E>;
}) {
  const { decodePayload, ...rest } = input;
  for (const publicKey of input.environmentPublicKeys) {
    const proof = yield* verifyRelayJwt({ ...rest, publicKey }).pipe(
      Effect.flatMap(decodePayload),
      Effect.option,
    );
    if (Option.isSome(proof)) {
      return proof.value;
    }
    // A linked environment can have rotated keys; try the remaining active keys.
  }
  return null;
});

export function verifyEnvironmentResponse(input: {
  readonly response: RelayEnvironmentMintResponse;
  readonly environmentId: string;
  readonly requestNonce: string;
  readonly clientProofKeyThumbprint: string;
  readonly environmentPublicKeys: ReadonlyArray<string>;
  readonly relayIssuer: string;
  readonly nowEpochSeconds: number;
}) {
  return verifyWithEnvironmentKeys({
    token: input.response.proof,
    typ: RELAY_MINT_RESPONSE_TYP,
    issuer: `t3-env:${input.environmentId}`,
    audience: normalizeRelayIssuer(input.relayIssuer),
    nowEpochSeconds: input.nowEpochSeconds,
    environmentPublicKeys: input.environmentPublicKeys,
    decodePayload: decodeMintResponseProof,
  }).pipe(
    Effect.map(
      (proof) =>
        proof !== null &&
        proof.environmentId === input.environmentId &&
        proof.requestNonce === input.requestNonce &&
        proof.clientProofKeyThumbprint === input.clientProofKeyThumbprint &&
        proof.credential === input.response.credential &&
        Option.match(DateTime.make(input.response.expiresAt), {
          onNone: () => false,
          onSome: (expiresAt) => Math.floor(expiresAt.epochMilliseconds / 1_000) === proof.exp,
        }),
    ),
  );
}

export function verifyEnvironmentHealthResponse(input: {
  readonly response: RelayEnvironmentHealthResponse;
  readonly environmentId: string;
  readonly requestNonce: string;
  readonly requestIssuedAt: DateTime.DateTime;
  readonly environmentPublicKeys: ReadonlyArray<string>;
  readonly relayIssuer: string;
  readonly now: DateTime.DateTime;
}) {
  return verifyWithEnvironmentKeys({
    token: input.response.proof,
    typ: RELAY_HEALTH_RESPONSE_TYP,
    issuer: `t3-env:${input.environmentId}`,
    audience: normalizeRelayIssuer(input.relayIssuer),
    nowEpochSeconds: Math.floor(input.now.epochMilliseconds / 1_000),
    environmentPublicKeys: input.environmentPublicKeys,
    decodePayload: decodeHealthResponseProof,
  }).pipe(
    Effect.map((proof) => {
      if (
        proof === null ||
        input.response.environmentId !== input.environmentId ||
        proof.environmentId !== input.environmentId ||
        proof.requestNonce !== input.requestNonce ||
        proof.status !== input.response.status ||
        proof.checkedAt !== input.response.checkedAt ||
        stableStringify(proof.descriptor) !== stableStringify(input.response.descriptor)
      ) {
        return false;
      }
      const checkedAt = DateTime.make(input.response.checkedAt);
      if (Option.isNone(checkedAt)) {
        return false;
      }
      return (
        checkedAt.value.epochMilliseconds >=
          input.requestIssuedAt.epochMilliseconds - ENVIRONMENT_HEALTH_CLOCK_SKEW_MILLIS &&
        checkedAt.value.epochMilliseconds <=
          input.now.epochMilliseconds + ENVIRONMENT_HEALTH_CLOCK_SKEW_MILLIS
      );
    }),
  );
}
