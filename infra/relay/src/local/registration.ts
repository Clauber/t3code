// @effect-diagnostics nodeBuiltinImport:off -- Loopback SSH transport must preserve the target HTTP Host.
import * as NodeHttp from "node:http";
import * as Schema from "effect/Schema";

const Runtime = Schema.Struct({ origin: Schema.String, port: Schema.Int });
const decodeRuntime = Schema.decodeUnknownSync(Runtime);
export type RegistrationMode =
  | { readonly kind: "isolated" }
  | { readonly kind: "live" | "snapshot"; readonly environmentId: string };

export function registrationMode(arguments_: readonly string[]): RegistrationMode {
  if (arguments_.length === 0) return { kind: "isolated" };
  const [flag, environmentId] = arguments_;
  if (arguments_.length !== 2 || !environmentId || (flag !== "--live" && flag !== "--snapshot")) {
    throw new Error("Expected --live ENVIRONMENT_ID or --snapshot ENVIRONMENT_ID");
  }
  return { kind: flag === "--live" ? "live" : "snapshot", environmentId };
}

export function registrationTarget(input: {
  readonly mode: RegistrationMode;
  readonly home: string;
  readonly isolatedHome: string;
  readonly transportOrigin: string;
  readonly runtime: unknown;
  readonly environmentId: string;
  readonly pinnedEnvironmentIds: readonly string[];
}) {
  const runtime = decodeRuntime(input.runtime);
  const loopbackOrigin = (value: string) => {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Registration requires an explicit HTTP loopback origin");
    return url;
  };
  const server = loopbackOrigin(runtime.origin);
  const transport = loopbackOrigin(input.transportOrigin);
  if (runtime.port < 1 || runtime.port > 65535 || Number(server.port || "80") !== runtime.port)
    throw new Error("Runtime port and origin disagree");
  if (input.mode.kind === "isolated") {
    if (input.home !== input.isolatedHome || transport.origin !== server.origin)
      throw new Error(
        "Default registration requires this worktree's isolated home and direct runtime origin",
      );
  } else if (input.mode.environmentId !== input.environmentId) {
    throw new Error("Explicit environment ID does not match target home");
  }
  if (!input.pinnedEnvironmentIds.includes(input.environmentId))
    throw new Error("Target environment is not pinned in relay config");
  return {
    transportOrigin: transport.origin,
    serverHost: server.host,
    proofOrigin: { localHttpHost: server.hostname, localHttpPort: runtime.port },
  };
}

export function postRegistrationTarget(
  target: ReturnType<typeof registrationTarget>,
  path: string,
  payload: unknown,
  token: string,
) {
  return new Promise<Response>((resolve, reject) => {
    const request = NodeHttp.request(
      new URL(path, target.transportOrigin),
      {
        method: "POST",
        headers: {
          host: target.serverHost,
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            response.destroy(new Error("Registration response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502 })),
        );
      },
    );
    request.setTimeout(15000, () => request.destroy(new Error("Registration request timed out")));
    request.on("error", reject);
    request.end(JSON.stringify(payload));
  });
}
