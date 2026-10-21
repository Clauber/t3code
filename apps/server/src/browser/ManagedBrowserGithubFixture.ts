// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
/**
 * Test support: a local HTTP server that speaks the part of GitHub's Releases API the release source uses.
 *
 * Two real servers on two origins (`127.0.0.1` for the API, `localhost` for the asset host), because the
 * production API redirects an asset download to a different host and the credential must not follow it.
 * Releases are real signed fixtures from {@link buildRelease}. Nothing here reaches the network.
 */
import * as FS from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Path from "node:path";

import type { BuiltRelease } from "./ManagedBrowserUpdateFixture.ts";

export interface FixtureRelease {
  readonly tag: string;
  readonly built: BuiltRelease;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  /** Asset names left out of the release. */
  readonly omit?: ReadonlyArray<string>;
  /** Packages for other platforms in the same release, filed as `manifest-<target>.json` and `.sig`. */
  readonly targets?: Readonly<Record<string, BuiltRelease>>;
}

export interface RecordedRequest {
  readonly origin: "api" | "asset";
  readonly method: string;
  readonly url: string;
  readonly headers: Http.IncomingHttpHeaders;
}

export type Fault =
  | { readonly kind: "status"; readonly status: number; readonly headers?: Record<string, string> }
  | { readonly kind: "garbage" }
  | { readonly kind: "truncate"; readonly bytes: number }
  | { readonly kind: "oversize"; readonly bytes: number }
  | { readonly kind: "redirectLoop" }
  | { readonly kind: "hang" };

export interface GithubFixtureOptions {
  readonly repository: string;
  readonly releases: ReadonlyArray<FixtureRelease>;
  /** When set the repository is private: requests without this bearer token are refused. */
  readonly token?: string;
}

export interface GithubFixture {
  readonly apiUrl: string;
  readonly requests: Array<RecordedRequest>;
  /** Faults by request kind: `list`, or an asset file name. */
  readonly faults: Map<string, Fault>;
  readonly close: () => Promise<void>;
}

const listen = (server: Http.Server, host: string) =>
  new Promise<number>((resolve) =>
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port)),
  );

const closeServer = (server: Http.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

export const serveGithub = async (options: GithubFixtureOptions): Promise<GithubFixture> => {
  const requests: Array<RecordedRequest> = [];
  const faults = new Map<string, Fault>();
  // asset id -> file and name
  const assets = new Map<number, { readonly name: string; readonly file: string }>();
  let nextId = 1000;
  let assetOrigin = "";
  let apiOrigin = "";

  const releaseJson = (release: FixtureRelease) => {
    const files: Array<readonly [string, string]> = [
      ["manifest.json", release.built.manifestPath],
      ["manifest.sig", release.built.signaturePath],
      [Path.basename(release.built.archivePath), release.built.archivePath],
      ...Object.entries(release.targets ?? {}).flatMap(([target, built]) => {
        const archive = (
          JSON.parse(FS.readFileSync(built.manifestPath, "utf8")) as { archiveFileName: string }
        ).archiveFileName;
        return [
          [`manifest-${target}.json`, built.manifestPath],
          [`manifest-${target}.sig`, built.signaturePath],
          [archive, built.archivePath],
        ] as const;
      }),
    ];
    return {
      id: nextId++,
      tag_name: release.tag,
      name: release.tag,
      draft: release.draft ?? false,
      prerelease: release.prerelease ?? false,
      assets: files
        .filter(([name]) => !(release.omit ?? []).includes(name))
        .map(([name, file]) => {
          const id = nextId++;
          assets.set(id, { name, file });
          return {
            id,
            name,
            size: FS.statSync(file).size,
            state: "uploaded",
            url: `${apiOrigin}/repos/${options.repository}/releases/assets/${id}`,
            browser_download_url: `${assetOrigin}/download/${release.tag}/${name}`,
          };
        }),
    };
  };

  const authorized = (request: Http.IncomingMessage, response: Http.ServerResponse) => {
    if (options.token === undefined) return true;
    const header = request.headers.authorization;
    if (header === undefined) {
      // A private repository does not admit it exists.
      response
        .writeHead(404, { "content-type": "application/json" })
        .end('{"message":"Not Found"}');
      return false;
    }
    if (header !== `Bearer ${options.token}`) {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end('{"message":"Bad credentials"}');
      return false;
    }
    return true;
  };

  const applyFault = (fault: Fault | undefined, response: Http.ServerResponse) => {
    if (fault === undefined) return false;
    switch (fault.kind) {
      case "status":
        response.writeHead(fault.status, fault.headers ?? {}).end("{}");
        return true;
      case "garbage":
        response.writeHead(200, { "content-type": "application/json" }).end("not json {");
        return true;
      case "hang":
        return true;
      default:
        return false;
    }
  };

  const api = Http.createServer((request, response) => {
    requests.push({
      origin: "api",
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
    });
    const url = new URL(request.url ?? "/", "http://fixture");
    if (!authorized(request, response)) return;
    if (url.pathname === `/repos/${options.repository}/releases`) {
      if (applyFault(faults.get("list"), response)) return;
      const body = JSON.stringify(options.releases.map(releaseJson));
      response.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    const match = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(url.pathname);
    const asset = match === null ? undefined : assets.get(Number(match[1]));
    if (asset === undefined) {
      response.writeHead(404).end('{"message":"Not Found"}');
      return;
    }
    const fault = faults.get(asset.name);
    if (applyFault(fault, response)) return;
    if (fault?.kind === "redirectLoop") {
      response.writeHead(302, { location: request.url ?? "/" }).end();
      return;
    }
    if (request.headers.accept !== "application/octet-stream") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({}));
      return;
    }
    response.writeHead(302, { location: `${assetOrigin}/blob/${match![1]}` }).end();
  });

  const cdn = Http.createServer((request, response) => {
    requests.push({
      origin: "asset",
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
    });
    const match = /^\/blob\/(\d+)$/.exec(request.url ?? "");
    const asset = match === null ? undefined : assets.get(Number(match[1]));
    if (asset === undefined) {
      response.writeHead(404).end();
      return;
    }
    const bytes = FS.readFileSync(asset.file);
    const fault = faults.get(asset.name);
    if (fault?.kind === "truncate") {
      // Promises the whole file, sends part of it, and ends the connection.
      response.writeHead(200, { "content-length": String(bytes.length) });
      response.write(bytes.subarray(0, fault.bytes));
      response.destroy();
      return;
    }
    if (fault?.kind === "oversize") {
      response.writeHead(200, { "content-length": String(fault.bytes) });
      response.end(Buffer.alloc(fault.bytes, 0x61));
      return;
    }
    response.writeHead(200, { "content-length": String(bytes.length) }).end(bytes);
  });

  // The API on one origin, assets on another: `localhost` is a different origin from `127.0.0.1`.
  const apiPort = await listen(api, "127.0.0.1");
  const cdnPort = await listen(cdn, "127.0.0.1");
  apiOrigin = `http://127.0.0.1:${apiPort}`;
  assetOrigin = `http://localhost:${cdnPort}`;
  return {
    apiUrl: apiOrigin,
    requests,
    faults,
    close: async () => {
      await Promise.all([closeServer(api), closeServer(cdn)]);
    },
  };
};
