// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off globalFetch:off preferSchemaOverJson:off
/**
 * ManagedBrowserGithubSource - newer stealth-browser packages from a repository's GitHub Releases.
 *
 * This only finds and fetches files. Whether a release is trusted is decided afterwards, unchanged, by the
 * audited installer: signature over the manifest, the archive's digest, schema, platform and tree. A
 * release listed here is a candidate, never a verdict, so nothing in this file needs to be correct for the
 * installation to be safe, only to be bounded and to hand files over.
 *
 * Shape of the GitHub REST API relied on (docs.github.com/en/rest/releases): `GET /repos/{owner}/{repo}/
 * releases` returns releases newest first with `draft`, `prerelease`, `tag_name` and `assets[]`
 * (`id`, `name`, `size`, `state`, `url`); `GET assets/{id}` with `Accept: application/octet-stream`
 * answers 200 or 302 to a host that is not the API's. The bearer credential is therefore sent to the API
 * origin only: a redirect to another origin is followed without it.
 *
 * Failure classes callers act on: `unauthorized` (401, 404 or an unset credential: a private repository
 * answers 404 to anyone it does not admit), `sourceUnavailable` (network, 5xx, rate limit, malformed or
 * oversized answers). Both leave the installed release untouched.
 *
 * @module ManagedBrowserGithubSource
 */
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  GITHUB_REPOSITORY_PATTERN,
  ManagedBrowserPackageError,
  type ReleaseCandidate,
  type ReleaseFiles,
  type ReleaseSource,
} from "./ManagedBrowserPackage.ts";

const DEFAULT_API = "https://api.github.com";
/** A version of the REST API this relies on; GitHub supports each for years after the next appears. */
const API_VERSION = "2022-11-28";
const USER_AGENT = "t3-code-managed-browser";
const RELEASES_PER_PAGE = 30;
/** Releases whose manifest is read per check, newest tag first: a check reads a handful of small files. */
const MAX_MANIFESTS = 8;
const MAX_REDIRECTS = 3;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_ARCHIVE_BYTES = 700 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export interface GithubSourceOptions {
  /** `owner/name`. */
  readonly repository: string;
  /** Defaults to GitHub's API. Must be https, or http on a loopback host (a local fixture). */
  readonly apiBaseUrl?: string;
  /** The read-only credential, resolved per request from the server's secret store; null for none. */
  readonly token: Effect.Effect<string | null>;
  /** Where downloads live while they are staged. */
  readonly downloadRoot: string;
  /**
   * The platform this host runs (`linux-x64`, `darwin-arm64`). One release can carry a package for each,
   * as `manifest-<target>.json` and `manifest-<target>.sig`; a release with only the unsuffixed pair is the
   * single-platform layout, whose own platform the compatibility check still judges.
   */
  readonly target?: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface GithubAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly url: string;
}

interface GithubRelease {
  readonly tag: string;
  readonly version: string;
  readonly assets: ReadonlyMap<string, GithubAsset>;
}

const isPackageError = Schema.is(ManagedBrowserPackageError);

const fail = (reason: ManagedBrowserPackageError["reason"], detail: string) =>
  new ManagedBrowserPackageError({ reason, detail });

const isLoopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1";

const requireSafeUrl = (url: URL) => {
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) return;
  throw fail("sourceUnavailable", `refusing a non-HTTPS release host: ${url.origin}`);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A source for one repository's GitHub Releases. Throws on a configuration it will not use. */
export const githubSource = (options: GithubSourceOptions): ReleaseSource => {
  if (!GITHUB_REPOSITORY_PATTERN.test(options.repository)) {
    throw new Error(`${options.repository} is not an owner/name repository`);
  }
  const apiBase = new URL(options.apiBaseUrl ?? DEFAULT_API);
  if (
    apiBase.protocol !== "https:" &&
    !(apiBase.protocol === "http:" && isLoopback(apiBase.hostname))
  ) {
    throw new Error("the release API must be https, or http on a loopback host");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiOrigin = apiBase.origin;
  const apiPath = apiBase.pathname.replace(/\/$/, "");

  /**
   * One request, following at most a few redirects by hand so the credential can be withheld from any
   * origin but the API's. Non-2xx answers become the typed failures above.
   */
  const request = async (first: URL, accept: string, timeoutMs: number): Promise<Response> => {
    const token = await Effect.runPromise(options.token);
    let url = first;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
      requireSafeUrl(url);
      const headers: Record<string, string> = {
        accept,
        "x-github-api-version": API_VERSION,
        "user-agent": USER_AGENT,
      };
      if (token !== null && url.origin === apiOrigin) headers.authorization = `Bearer ${token}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw fail(
          "sourceUnavailable",
          `release host unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null) throw fail("sourceUnavailable", "a redirect named no location");
        url = new URL(location, url);
        continue;
      }
      if (response.status >= 200 && response.status < 300) return response;
      await response.body?.cancel();
      const limited =
        response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.get("retry-after") !== null ||
        response.status === 429;
      if (limited) throw fail("sourceUnavailable", "the release host is rate limiting requests");
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw fail(
          "unauthorized",
          token === null
            ? `release host answered ${response.status} and no credential is configured`
            : `release host answered ${response.status} to the configured credential`,
        );
      }
      throw fail("sourceUnavailable", `release host answered ${response.status}`);
    }
    throw fail("sourceUnavailable", "too many redirects");
  };

  const readBounded = async (response: Response, limit: number): Promise<Buffer> => {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > limit) {
      await response.body?.cancel();
      throw fail("sourceUnavailable", `a release answer of ${declared} bytes exceeds ${limit}`);
    }
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    try {
      for await (const chunk of Readable.fromWeb(
        response.body as never,
      ) as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > limit) {
          throw fail("sourceUnavailable", `a release answer exceeds ${limit} bytes`);
        }
        chunks.push(chunk);
      }
    } catch (cause) {
      if (isPackageError(cause)) throw cause;
      throw fail("sourceUnavailable", "a release answer ended early");
    }
    return Buffer.concat(chunks);
  };

  const getJson = async (path: string): Promise<unknown> => {
    const url = new URL(`${apiPath}${path}`, apiBase);
    const response = await request(url, "application/vnd.github+json", API_TIMEOUT_MS);
    try {
      return JSON.parse((await readBounded(response, MAX_JSON_BYTES)).toString("utf8"));
    } catch (cause) {
      if (isPackageError(cause)) throw cause;
      throw fail("sourceUnavailable", "the release list is not valid JSON");
    }
  };

  const assetUrl = (asset: GithubAsset) => {
    const url = new URL(asset.url);
    // An asset is read through the API, never through a URL the listing could point anywhere with.
    if (url.origin !== apiOrigin) throw fail("sourceUnavailable", "an asset names another host");
    return url;
  };

  const downloadBytes = async (asset: GithubAsset, limit: number) =>
    readBounded(
      await request(assetUrl(asset), "application/octet-stream", API_TIMEOUT_MS),
      Math.min(limit, asset.size),
    );

  /** Streams an asset to `file`, enforcing its declared size exactly. */
  const downloadFile = async (asset: GithubAsset, file: string) => {
    const response = await request(
      assetUrl(asset),
      "application/octet-stream",
      DOWNLOAD_TIMEOUT_MS,
    );
    if (response.body === null) throw fail("sourceUnavailable", "an asset had no body");
    let bytes = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > asset.size) {
          done(
            fail(
              "sourceUnavailable",
              `${asset.name} is larger than the ${asset.size} bytes it declared`,
            ),
          );
        } else done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        counting,
        FS.createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
    } catch (cause) {
      if (isPackageError(cause)) throw cause;
      throw fail("sourceUnavailable", `${asset.name} did not download completely`);
    }
    if (bytes !== asset.size) {
      throw fail(
        "sourceUnavailable",
        `${asset.name} is ${bytes} bytes, not the ${asset.size} declared`,
      );
    }
  };

  const parseReleases = (body: unknown): ReadonlyArray<GithubRelease> => {
    if (!Array.isArray(body)) throw fail("sourceUnavailable", "the release list is not a list");
    const releases: Array<GithubRelease> = [];
    for (const entry of body) {
      const release = asRecord(entry);
      if (release === null || release.draft !== false || release.prerelease !== false) continue;
      const tag = release.tag_name;
      const version = typeof tag === "string" ? /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1] : undefined;
      if (version === undefined || parseSemver(version) === null || !Array.isArray(release.assets))
        continue;
      const assets = new Map<string, GithubAsset>();
      for (const raw of release.assets) {
        const asset = asRecord(raw);
        if (
          asset !== null &&
          asset.state === "uploaded" &&
          typeof asset.name === "string" &&
          asset.name === Path.basename(asset.name) &&
          !asset.name.startsWith(".") &&
          typeof asset.id === "number" &&
          typeof asset.size === "number" &&
          Number.isSafeInteger(asset.size) &&
          asset.size >= 0 &&
          typeof asset.url === "string"
        ) {
          assets.set(asset.name, {
            id: asset.id,
            name: asset.name,
            size: asset.size,
            url: asset.url,
          });
        }
      }
      releases.push({ tag: String(tag), version, assets });
    }
    return releases;
  };

  const candidateOf = async (release: GithubRelease): Promise<ReleaseCandidate | null> => {
    const targeted =
      options.target === undefined
        ? undefined
        : {
            manifest: release.assets.get(`manifest-${options.target}.json`),
            signature: release.assets.get(`manifest-${options.target}.sig`),
          };
    // A release that names this host's pair is read only through it; a half pair is not a fallback.
    const manifestAsset =
      targeted?.manifest ?? (targeted?.signature ? undefined : release.assets.get("manifest.json"));
    const signatureAsset =
      targeted?.signature ?? (targeted?.manifest ? undefined : release.assets.get("manifest.sig"));
    if (manifestAsset === undefined || signatureAsset === undefined) return null;
    if (manifestAsset.size > MAX_MANIFEST_BYTES || signatureAsset.size > MAX_SIGNATURE_BYTES)
      return null;
    let manifest: Record<string, unknown> | null;
    try {
      manifest = asRecord(
        JSON.parse((await downloadBytes(manifestAsset, MAX_MANIFEST_BYTES)).toString("utf8")),
      );
    } catch (cause) {
      if (isPackageError(cause) && cause.reason !== "sourceUnavailable") throw cause;
      return null;
    }
    const name = manifest?.archiveFileName;
    if (manifest === null || manifest.version !== release.version || typeof name !== "string")
      return null;
    // The name is untrusted: a plain asset name of this release, within the size limit, as large as declared.
    const archiveAsset = name === Path.basename(name) ? release.assets.get(name) : undefined;
    if (
      archiveAsset === undefined ||
      archiveAsset.size > MAX_ARCHIVE_BYTES ||
      (typeof manifest.archiveSize === "number" && manifest.archiveSize !== archiveAsset.size)
    ) {
      return null;
    }
    const files = Effect.acquireRelease(
      Effect.tryPromise({
        try: async (): Promise<{ directory: string; files: ReleaseFiles }> => {
          FS.mkdirSync(options.downloadRoot, { recursive: true, mode: 0o700 });
          const directory = FS.mkdtempSync(
            Path.join(options.downloadRoot, `${Crypto.randomUUID().slice(0, 8)}-`),
          );
          const result = {
            manifestPath: Path.join(directory, "manifest.json"),
            signaturePath: Path.join(directory, "manifest.sig"),
            archivePath: Path.join(directory, "archive"),
          };
          try {
            await downloadFile(manifestAsset, result.manifestPath);
            await downloadFile(signatureAsset, result.signaturePath);
            await downloadFile(archiveAsset, result.archivePath);
          } catch (cause) {
            FS.rmSync(directory, { recursive: true, force: true });
            throw cause;
          }
          return { directory, files: result };
        },
        catch: (cause) =>
          isPackageError(cause)
            ? cause
            : fail("sourceUnavailable", cause instanceof Error ? cause.message : String(cause)),
      }),
      ({ directory }) => Effect.sync(() => FS.rmSync(directory, { recursive: true, force: true })),
    ).pipe(Effect.map(({ files: downloaded }) => downloaded));
    return { version: release.version, manifest, files };
  };

  const list: ReleaseSource["list"] = Effect.tryPromise({
    try: async () => {
      const body = await getJson(
        `/repos/${options.repository}/releases?per_page=${RELEASES_PER_PAGE}`,
      );
      const newest = [...parseReleases(body)]
        .sort((a, b) => compareSemverVersions(b.version, a.version))
        .slice(0, MAX_MANIFESTS);
      const candidates: Array<ReleaseCandidate> = [];
      for (const release of newest) {
        const candidate = await candidateOf(release);
        if (candidate !== null) candidates.push(candidate);
      }
      return candidates;
    },
    catch: (cause) =>
      isPackageError(cause)
        ? cause
        : fail("sourceUnavailable", cause instanceof Error ? cause.message : String(cause)),
  });

  return { list };
};
