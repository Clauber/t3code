// @effect-diagnostics nodeBuiltinImport:off -- Node HTTPS is this runtime adapter boundary.
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import { validateConfig } from "./config.ts";
import { createLocalRelay } from "./relay.ts";

const filename = process.argv[2];
if (!filename)
  throw new Error("Usage: node --experimental-strip-types src/local/main.ts /path/to/config.json");
const config = validateConfig(JSON.parse(NodeFS.readFileSync(filename, "utf8")));
const relay = await createLocalRelay(config);
const server = NodeHttps.createServer(
  {
    cert: NodeFS.readFileSync(config.tlsCertFile),
    key: NodeFS.readFileSync(config.tlsKeyFile),
    minVersion: "TLSv1.2",
  },
  async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== new URL(config.issuer).host) {
        outgoing.writeHead(400).end();
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of incoming) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += data.length;
        if (length > 64 * 1024) {
          outgoing.writeHead(413).end();
          incoming.destroy();
          return;
        }
        chunks.push(data);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const response = await relay.handle(
        new Request(new URL(incoming.url ?? "/", config.issuer), {
          method: incoming.method ?? "GET",
          headers,
          ...(length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end();
    }
  },
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => {
  process.stdout.write(`Private relay listening on ${config.host}:${config.port}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    server.close(() => {
      relay.close();
      process.exit(0);
    }),
  );
}
