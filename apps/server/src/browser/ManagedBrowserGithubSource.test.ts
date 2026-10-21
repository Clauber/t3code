// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
import * as FS from "node:fs";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as GithubSource from "./ManagedBrowserGithubSource.ts";
import { serveGithub, type GithubFixture } from "./ManagedBrowserGithubFixture.ts";
import {
  buildRelease,
  makeKeys,
  makeTemporaryDirectory,
  type BuiltRelease,
} from "./ManagedBrowserUpdateFixture.ts";

const REPOSITORY = "acme/stealth-browser";
const TOKEN = "fixture-token-never-shipped";

interface World {
  readonly keys: ReturnType<typeof makeKeys>;
  readonly built: Record<string, BuiltRelease>;
  readonly downloads: string;
}

const makeWorld = (versions: ReadonlyArray<string>): World => {
  const directory = makeTemporaryDirectory("github");
  const keys = makeKeys();
  const built: Record<string, BuiltRelease> = {};
  for (const version of versions) built[version] = buildRelease(directory, { version, keys });
  return { keys, built, downloads: Path.join(directory, "downloads") };
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  (Exit.isFailure(exit) ? exit.cause.reasons.find((entry) => entry._tag === "Fail") : undefined) as
    | { error?: { reason?: string; detail?: string } }
    | undefined;

const withFixture = <A, E>(
  options: Parameters<typeof serveGithub>[0],
  body: (fixture: GithubFixture) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => serveGithub(options)),
    body,
    (fixture) => Effect.promise(() => fixture.close()),
  );

const source = (
  fixture: GithubFixture,
  world: World,
  extra: Partial<Parameters<typeof GithubSource.githubSource>[0]> = {},
) =>
  GithubSource.githubSource({
    repository: REPOSITORY,
    apiBaseUrl: fixture.apiUrl,
    token: Effect.succeed(null),
    downloadRoot: world.downloads,
    ...extra,
  });

describe("the GitHub releases source", () => {
  it.live(
    "lists only stable, published, well-formed releases, newest first, with their manifests",
    () => {
      const world = makeWorld(["2.1.0", "2.2.0", "2.3.0", "2.4.0", "2.5.0"]);
      return withFixture(
        {
          repository: REPOSITORY,
          releases: [
            { tag: "v2.1.0", built: world.built["2.1.0"]! },
            { tag: "v2.2.0", built: world.built["2.2.0"]! },
            { tag: "v2.3.0-rc.1", prerelease: true, built: world.built["2.3.0"]! },
            { tag: "v2.4.0", draft: true, built: world.built["2.4.0"]! },
            // The tag says 2.5.0 but the signed manifest says 2.1.0 elsewhere: skipped.
            { tag: "v9.9.9", built: world.built["2.5.0"]! },
            // Not a release of this component at all.
            { tag: "nightly", built: world.built["2.1.0"]! },
          ],
        },
        (fixture) =>
          Effect.gen(function* () {
            const offered = yield* source(fixture, world).list;
            assert.deepEqual(
              offered.map((candidate) => candidate.version),
              ["2.2.0", "2.1.0"],
            );
            assert.equal(offered[0]!.manifest.version, "2.2.0");
            const request = fixture.requests.find((entry) => entry.url.startsWith("/repos/"))!;
            assert.equal(request.headers["accept"], "application/vnd.github+json");
            assert.isString(request.headers["x-github-api-version"]);
            assert.isString(request.headers["user-agent"]);
            assert.isUndefined(request.headers["authorization"]);
            assert.include(request.url, "per_page=");
          }),
      );
    },
  );

  it.live(
    "reads the manifest of the host's own platform from a release that carries several",
    () => {
      const world = makeWorld(["2.1.0"]);
      const mac = buildRelease(makeTemporaryDirectory("github-mac"), {
        version: "2.1.0",
        keys: world.keys,
        os: "darwin",
        arch: "arm64",
        archiveFileName: "stealth-browser-v2.1.0-darwin-arm64.tar.gz",
      });
      return withFixture(
        {
          repository: REPOSITORY,
          releases: [
            { tag: "v2.1.0", built: world.built["2.1.0"]!, targets: { "darwin-arm64": mac } },
          ],
        },
        (fixture) =>
          Effect.gen(function* () {
            const platformOf = (target: string | undefined) =>
              source(fixture, world, target === undefined ? {} : { target }).list.pipe(
                Effect.map(
                  ([candidate]) => `${candidate!.manifest.os}-${candidate!.manifest.arch}`,
                ),
              );
            assert.equal(yield* platformOf("darwin-arm64"), "darwin-arm64");
            // Linux has no suffixed pair here, so it reads the single-platform layout; naming no target does too.
            assert.equal(yield* platformOf("linux-x64"), "linux-x64");
            assert.equal(yield* platformOf(undefined), "linux-x64");
            // The Mac's archive is the one that downloads for it.
            const [candidate] = yield* source(fixture, world, { target: "darwin-arm64" }).list;
            const bytes = yield* Effect.scoped(
              candidate!.files.pipe(Effect.map((files) => FS.readFileSync(files.archivePath))),
            );
            assert.deepEqual(bytes, FS.readFileSync(mac.archivePath));
          }),
      );
    },
  );

  it.live("does not fall back to the other platform's pair when its own is incomplete", () => {
    const world = makeWorld(["2.1.0"]);
    const mac = buildRelease(makeTemporaryDirectory("github-mac"), {
      version: "2.1.0",
      keys: world.keys,
      os: "darwin",
      arch: "arm64",
      archiveFileName: "stealth-browser-v2.1.0-darwin-arm64.tar.gz",
    });
    return withFixture(
      {
        repository: REPOSITORY,
        releases: [
          {
            tag: "v2.1.0",
            built: world.built["2.1.0"]!,
            targets: { "darwin-arm64": mac },
            omit: ["manifest-darwin-arm64.sig"],
          },
        ],
      },
      (fixture) =>
        Effect.gen(function* () {
          const offered = yield* source(fixture, world, { target: "darwin-arm64" }).list;
          assert.deepEqual(offered, []);
        }),
    );
  });

  it.live("downloads exactly the assets a candidate needs, into a scope that removes them", () => {
    const world = makeWorld(["2.1.0"]);
    return withFixture(
      { repository: REPOSITORY, releases: [{ tag: "v2.1.0", built: world.built["2.1.0"]! }] },
      (fixture) =>
        Effect.gen(function* () {
          const [candidate] = yield* source(fixture, world).list;
          let seen: { manifestPath: string; archivePath: string } | null = null;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const files = yield* candidate!.files;
              seen = files;
              assert.deepEqual(
                FS.readFileSync(files.archivePath),
                FS.readFileSync(world.built["2.1.0"]!.archivePath),
              );
              assert.deepEqual(
                FS.readFileSync(files.manifestPath),
                FS.readFileSync(world.built["2.1.0"]!.manifestPath),
              );
              assert.deepEqual(
                FS.readFileSync(files.signaturePath),
                FS.readFileSync(world.built["2.1.0"]!.signaturePath),
              );
            }),
          );
          assert.isFalse(FS.existsSync(seen!.archivePath));
        }),
    );
  });

  describe("a private repository", () => {
    it.live("is read with the configured credential, which never leaves the API origin", () => {
      const world = makeWorld(["2.1.0"]);
      return withFixture(
        {
          repository: REPOSITORY,
          token: TOKEN,
          releases: [{ tag: "v2.1.0", built: world.built["2.1.0"]! }],
        },
        (fixture) =>
          Effect.gen(function* () {
            const reader = source(fixture, world, { token: Effect.succeed(TOKEN) });
            const [candidate] = yield* reader.list;
            yield* Effect.scoped(candidate!.files);
            const api = fixture.requests.filter((entry) => entry.origin === "api");
            const asset = fixture.requests.filter((entry) => entry.origin === "asset");
            assert.isAbove(asset.length, 0);
            for (const request of api) {
              assert.equal(request.headers["authorization"], `Bearer ${TOKEN}`);
            }
            // The asset host sits on another origin and must never see the credential, in a header or a URL.
            for (const request of asset) {
              assert.isUndefined(request.headers["authorization"]);
              assert.notInclude(request.url, TOKEN);
            }
            for (const request of fixture.requests) assert.notInclude(request.url, TOKEN);
          }),
      );
    });

    it.live(
      "reports a missing, wrong or unset credential as unauthorized, not as being offline",
      () => {
        const world = makeWorld(["2.1.0"]);
        return withFixture(
          {
            repository: REPOSITORY,
            token: TOKEN,
            releases: [{ tag: "v2.1.0", built: world.built["2.1.0"]! }],
          },
          (fixture) =>
            Effect.gen(function* () {
              for (const token of [Effect.succeed(null), Effect.succeed("wrong")]) {
                const exit = yield* Effect.exit(source(fixture, world, { token }).list);
                assert.equal(failureOf(exit)?.error?.reason, "unauthorized");
                assert.notInclude(failureOf(exit)?.error?.detail ?? "", "wrong");
              }
            }),
        );
      },
    );
  });

  describe("failures leave the caller to keep what it has", () => {
    const cases: ReadonlyArray<
      readonly [string, string, import("./ManagedBrowserGithubFixture.ts").Fault, string]
    > = [
      ["a server error", "list", { kind: "status", status: 503 }, "sourceUnavailable"],
      [
        "a rate limit",
        "list",
        { kind: "status", status: 403, headers: { "x-ratelimit-remaining": "0" } },
        "sourceUnavailable",
      ],
      ["a malformed list", "list", { kind: "garbage" }, "sourceUnavailable"],
    ];
    for (const [label, key, fault, reason] of cases) {
      it.live(`${label} while listing`, () => {
        const world = makeWorld(["2.1.0"]);
        return withFixture(
          { repository: REPOSITORY, releases: [{ tag: "v2.1.0", built: world.built["2.1.0"]! }] },
          (fixture) =>
            Effect.gen(function* () {
              fixture.faults.set(key, fault);
              const exit = yield* Effect.exit(source(fixture, world).list);
              assert.equal(failureOf(exit)?.error?.reason, reason);
            }),
        );
      });
    }

    it.live("an unreachable server", () => {
      const world = makeWorld(["2.1.0"]);
      return Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          serveGithub({
            repository: REPOSITORY,
            releases: [{ tag: "v2.1.0", built: world.built["2.1.0"]! }],
          }),
        );
        yield* Effect.promise(() => fixture.close());
        const exit = yield* Effect.exit(source(fixture, world).list);
        assert.equal(failureOf(exit)?.error?.reason, "sourceUnavailable");
      });
    });

    it.live("a release missing its signature is not offered", () => {
      const world = makeWorld(["2.1.0", "2.2.0"]);
      return withFixture(
        {
          repository: REPOSITORY,
          releases: [
            { tag: "v2.1.0", built: world.built["2.1.0"]! },
            { tag: "v2.2.0", built: world.built["2.2.0"]!, omit: ["manifest.sig"] },
          ],
        },
        (fixture) =>
          Effect.gen(function* () {
            const offered = yield* source(fixture, world).list;
            assert.deepEqual(
              offered.map((candidate) => candidate.version),
              ["2.1.0"],
            );
          }),
      );
    });

    const downloads: ReadonlyArray<
      readonly [string, string, import("./ManagedBrowserGithubFixture.ts").Fault]
    > = [
      ["an archive that ends early", "archive", { kind: "truncate", bytes: 1000 }],
      ["an archive larger than it declared", "archive", { kind: "oversize", bytes: 4_000_000 }],
      ["an archive server error", "archive", { kind: "status", status: 500 }],
      ["a redirect loop", "archive", { kind: "redirectLoop" }],
      ["an oversized manifest", "manifest.json", { kind: "oversize", bytes: 2_000_000 }],
    ];
    for (const [label, which, fault] of downloads) {
      it.live(`${label} fails the download and leaves nothing behind`, () => {
        const world = makeWorld(["2.1.0"]);
        return withFixture(
          { repository: REPOSITORY, releases: [{ tag: "v2.1.0", built: world.built["2.1.0"]! }] },
          (fixture) =>
            Effect.gen(function* () {
              const name =
                which === "archive" ? Path.basename(world.built["2.1.0"]!.archivePath) : which;
              const offered = yield* Effect.exit(source(fixture, world).list);
              // An oversized manifest is already refused while listing.
              if (which === "manifest.json") {
                fixture.faults.set(name, fault);
                const relisted = yield* Effect.exit(source(fixture, world).list);
                assert.isTrue(
                  Exit.isFailure(relisted) ||
                    (Exit.isSuccess(relisted) && relisted.value.length === 0),
                );
                return;
              }
              assert.isTrue(Exit.isSuccess(offered));
              const [candidate] = Exit.isSuccess(offered) ? offered.value : [];
              fixture.faults.set(name, fault);
              const exit = yield* Effect.exit(Effect.scoped(candidate!.files));
              assert.isTrue(Exit.isFailure(exit));
              assert.equal(failureOf(exit)?.error?.reason, "sourceUnavailable");
              const left = FS.existsSync(world.downloads) ? FS.readdirSync(world.downloads) : [];
              assert.deepEqual(left, []);
            }),
        );
      });
    }
  });

  describe("configuration", () => {
    it("refuses a plain-HTTP API on any host but loopback, and a malformed repository", () => {
      const base = { token: Effect.succeed(null), downloadRoot: "/tmp/never" };
      assert.throws(() =>
        GithubSource.githubSource({
          ...base,
          repository: REPOSITORY,
          apiBaseUrl: "http://api.example.com",
        }),
      );
      assert.throws(() => GithubSource.githubSource({ ...base, repository: "not a repo" }));
      assert.throws(() => GithubSource.githubSource({ ...base, repository: "a/b/c" }));
      assert.doesNotThrow(() =>
        GithubSource.githubSource({
          ...base,
          repository: REPOSITORY,
          apiBaseUrl: "http://127.0.0.1:1",
        }),
      );
      assert.doesNotThrow(() => GithubSource.githubSource({ ...base, repository: REPOSITORY }));
    });
  });
});
