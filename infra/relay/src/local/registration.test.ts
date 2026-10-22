// @effect-diagnostics nodeBuiltinImport:off -- Exercise the native loopback HTTP transport.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import { postRegistrationTarget, registrationMode, registrationTarget } from "./registration.ts";

const input = {
  mode: registrationMode([]),
  home: "/worktree/.t3",
  isolatedHome: "/worktree/.t3",
  transportOrigin: "http://127.0.0.1:14231",
  runtime: { origin: "http://127.0.0.1:14231", port: 14231 },
  environmentId: "host-a",
  pinnedEnvironmentIds: ["host-a"],
};
NodeTest.test(
  "registration defaults refuse live homes and forwarded ports without explicit opt-in",
  () => {
    NodeAssert.equal(registrationTarget(input).serverHost, "127.0.0.1:14231");
    NodeAssert.throws(() => registrationTarget({ ...input, home: "/live/.t3" }));
    NodeAssert.throws(() =>
      registrationTarget({ ...input, transportOrigin: "http://127.0.0.1:39001" }),
    );
    NodeAssert.throws(() => registrationMode(["--live"]));
    NodeAssert.throws(() => registrationMode(["--live", "host-a", "unexpected"]));
  },
);
NodeTest.test(
  "explicit registration still requires pinned identity and consistent loopback runtime",
  () => {
    for (const flag of ["--live", "--snapshot"]) {
      const mode = registrationMode([flag, "host-a"]);
      NodeAssert.equal(
        registrationTarget({
          ...input,
          mode,
          home: "/prepared/target",
          transportOrigin: "http://127.0.0.1:39001",
        }).serverHost,
        "127.0.0.1:14231",
      );
      NodeAssert.throws(() => registrationTarget({ ...input, mode, environmentId: "host-b" }));
      NodeAssert.throws(() => registrationTarget({ ...input, mode, pinnedEnvironmentIds: [] }));
      NodeAssert.throws(() =>
        registrationTarget({
          ...input,
          mode,
          runtime: { origin: "http://127.0.0.1:3773", port: 14231 },
        }),
      );
      NodeAssert.throws(() =>
        registrationTarget({ ...input, mode, transportOrigin: "http://10.69.42.164:3773" }),
      );
      NodeAssert.throws(() =>
        registrationTarget({
          ...input,
          mode,
          runtime: { origin: "http://attacker.example.test:3773", port: 3773 },
        }),
      );
    }
  },
);
NodeTest.test(
  "forwarded registration sends the actual server Host while connecting to the SSH loopback port",
  async () => {
    const server = NodeHttp.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ host: request.headers.host }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      NodeAssert.ok(address && typeof address === "object");
      const target = registrationTarget({
        ...input,
        mode: registrationMode(["--snapshot", "host-a"]),
        transportOrigin: `http://127.0.0.1:${address.port}`,
        runtime: { origin: "http://127.0.0.1:3773", port: 3773 },
      });
      const response = await postRegistrationTarget(
        target,
        "/api/connect/link-proof",
        {},
        "fixture-token",
      );
      NodeAssert.equal((await response.json()).host, "127.0.0.1:3773");
      NodeAssert.deepEqual(target.proofOrigin, { localHttpHost: "127.0.0.1", localHttpPort: 3773 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
