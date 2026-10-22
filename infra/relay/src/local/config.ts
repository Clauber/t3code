import * as Schema from "effect/Schema";

export const LocalRelayConfig = Schema.Struct({
  issuer: Schema.String,
  allowedOrigins: Schema.Array(Schema.String),
  environments: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      environmentPublicKey: Schema.String,
      httpBaseUrl: Schema.String,
    }),
  ),
  host: Schema.String,
  port: Schema.Int,
  tlsCertFile: Schema.String,
  tlsKeyFile: Schema.String,
  stateDir: Schema.String,
});
export type LocalRelayConfig = typeof LocalRelayConfig.Type;

const decodeLocalRelayConfig = Schema.decodeUnknownSync(LocalRelayConfig);

export function validateConfig(input: unknown) {
  const config = decodeLocalRelayConfig(input);
  const origin = (value: string) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Private relay URLs must be HTTPS origins");
    }
    return url.origin;
  };
  const clientOrigin = (value: string) => (value === "t3code://app" ? value : origin(value));
  origin(config.issuer);
  config.allowedOrigins.forEach(clientOrigin);
  const ids = new Set<string>();
  for (const environment of config.environments) {
    origin(environment.httpBaseUrl);
    if (!environment.environmentId || ids.has(environment.environmentId))
      throw new Error("Duplicate or missing environment id");
    ids.add(environment.environmentId);
  }
  if (config.port < 1 || config.port > 65535) throw new Error("Invalid listen port");
  return {
    ...config,
    issuer: origin(config.issuer),
    allowedOrigins: config.allowedOrigins.map(clientOrigin),
    environments: config.environments.map((environment) => ({
      ...environment,
      environmentPublicKey: environment.environmentPublicKey.trim(),
    })),
  };
}
