// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off globalRandomInEffect:off
import * as FS from "node:fs";
import * as NodeHttp from "node:http";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  EnvironmentId,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import type { ServerBrowserOperationError } from "../preview/ServerBrowserPage.ts";
import {
  recordingAdapter,
  startServer,
  type ServerFixture,
} from "./ManagedBrowserCrossHostFixture.ts";
import { normalizeEndpoint } from "./ManagedBrowserRemoteClient.ts";

const OWNER = EnvironmentId.make("env-owner");
const PEER = EnvironmentId.make("env-peer");
const instanceId = ManagedBrowserInstanceId.make("instance-1");
const profileId = ManagedBrowserProfileId.make("profile-1");
const binding = { ownerEnvironmentId: OWNER, instanceId, profileId };
const GRANTS = "/api/managed-browser/grants";
const ENROLLMENTS = "/api/managed-browser/enrollments";

const request = (
  operation: PreviewAutomationRequest["operation"],
  input: unknown,
  extra: Partial<PreviewAutomationRequest> = {},
): PreviewAutomationRequest => ({
  requestId: `request-${operation}`,
  threadId: "thread-1" as never,
  agentSessionId: "session-1",
  callerEnvironmentId: PEER,
  operation,
  input,
  timeoutMs: 15_000,
  ...extra,
});

const open = (extra: Partial<PreviewAutomationRequest> = {}, url = "http://localhost:3000/") =>
  request("open", { browserBinding: binding, url }, extra);

const failureOf = <A>(exit: Exit.Exit<A, ServerBrowserOperationError>) => {
  assert.isTrue(Exit.isFailure(exit));
  const failure = Exit.isFailure(exit)
    ? (
        exit.cause.reasons.find((reason) => reason._tag === "Fail") as
          | { error?: ServerBrowserOperationError }
          | undefined
      )?.error
    : undefined;
  return { tag: failure?.tag ?? "", message: failure?.message ?? "" };
};

const grantBody = (extra: Record<string, unknown> = {}) => ({
  subject: {
    kind: "agent",
    callerEnvironmentId: PEER,
    threadId: "thread-1",
    agentSessionId: "session-1",
  },
  resources: [{ instanceId, profileId }],
  access: "operate",
  ttlSeconds: 3600,
  ...extra,
});

/** An owner whose browser is a recorder, and a peer enrolled in it by the administrator routes on both. */
const connected = (respond?: Parameters<typeof recordingAdapter>[0], clock = { now: 70_000_000 }) =>
  Effect.gen(function* () {
    const recorder = recordingAdapter(respond);
    const now = () => clock.now;
    const owner = yield* startServer({
      environmentId: OWNER,
      engineDataRoot: null,
      fakeLocal: recorder.adapter,
      now,
    });
    const peer = yield* startServer({ environmentId: PEER, engineDataRoot: null, now });
    const enroll = (
      server: ServerFixture,
      overrides: Record<string, unknown> = {},
      grantExtra: Record<string, unknown> = {},
    ) =>
      Effect.gen(function* () {
        const made = yield* owner.request("POST", GRANTS, { body: grantBody(grantExtra) });
        const created = made.json as {
          grant: { id: string; expiresAt: string };
          credential: string;
        };
        const stored = yield* server.request("POST", ENROLLMENTS, {
          body: {
            id: created.grant.id,
            ownerEnvironmentId: OWNER,
            endpoint: owner.origin,
            instanceId,
            profileId,
            threadId: "thread-1",
            agentSessionId: "session-1",
            expiresAt: created.grant.expiresAt,
            credential: created.credential,
            ...overrides,
          },
        });
        return { created, stored };
      });
    return { owner, peer, recorder, enroll, clock };
  });

describe("an enrollment's endpoint", () => {
  it.effect("is the owner's address and nothing that could point elsewhere", () =>
    Effect.sync(() => {
      assert.equal(normalizeEndpoint("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
      assert.equal(normalizeEndpoint("https://t3.example.net/"), "https://t3.example.net");
      for (const refused of [
        "",
        "not a url",
        "ftp://example.net",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:pass@example.net",
        "https://example.net/api",
        "https://example.net/?next=http://evil.example",
        "https://example.net/#frag",
      ]) {
        assert.isUndefined(normalizeEndpoint(refused), refused);
      }
    }),
  );
});

describe("enrolling a server in another environment's browser", () => {
  it.effect(
    "keeps the credential in the secret store, never in the record, a listing or a log",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { peer, enroll } = yield* connected();
          const { created, stored } = yield* enroll(peer);
          assert.equal(stored.status, 201, stored.text);
          assert.notInclude(stored.text, created.credential);
          const listed = yield* peer.request("GET", ENROLLMENTS);
          assert.notInclude(listed.text, created.credential);
          assert.notInclude(listed.text, "credential");
          assert.include(listed.text, created.grant.id);
          const record = FS.readFileSync(Path.join(peer.root, "enrollments.json"), "utf8");
          assert.notInclude(record, created.credential);
          assert.notInclude(record, created.credential.split(".")[2]!);
          // It is in the secret store, owner-only, under the server's secrets directory.
          const stored1 = yield* peer.remote.list;
          assert.equal(stored1.length, 1);
        }),
      ),
  );

  it.effect("refuses an endpoint with a path, a self-enrollment and a malformed record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, enroll } = yield* connected();
        for (const overrides of [
          { endpoint: "https://owner.example.net/api/anything" },
          { endpoint: "http://user:pw@owner.example.net" },
          { endpoint: "gopher://owner.example.net" },
          { ownerEnvironmentId: PEER },
          { id: "not-a-grant-id" },
          { credential: "short" },
        ]) {
          const { stored } = yield* enroll(peer, overrides);
          assert.isTrue(stored.status === 409 || stored.status === 400, JSON.stringify(overrides));
        }
        assert.deepEqual((yield* peer.request("GET", ENROLLMENTS)).json, { enrollments: [] });
      }),
    ),
  );

  it.effect("can be removed, after which nothing is sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, enroll, recorder } = yield* connected();
        const { created } = yield* enroll(peer);
        yield* peer.adapter.handle(open());
        assert.equal(recorder.calls.length, 1);
        const removed = yield* peer.request("DELETE", `${ENROLLMENTS}/${created.grant.id}`);
        assert.deepEqual(removed.json, { removed: true });
        const after = failureOf(yield* Effect.exit(peer.adapter.handle(open())));
        assert.include(after.message, "no enrollment");
        assert.equal(recorder.calls.length, 1);
        assert.equal(peer.outbound.length, 1);
      }),
    ),
  );
});

describe("a call to a browser another environment owns", () => {
  it.effect("goes to the enrolled owner and nowhere else, whatever the call says", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, owner, enroll, recorder } = yield* connected();
        yield* enroll(peer);
        const result = yield* peer.adapter.handle(
          request("open", {
            browserBinding: binding,
            url: "http://localhost:3000/",
            // Things a prompt-injected caller might try to steer the call with.
            endpoint: "http://attacker.example",
            destination: "http://attacker.example",
            baseUrl: "http://attacker.example",
          }),
        );
        assert.deepEqual(result, { tabId: "tab-1" });
        assert.deepEqual(
          peer.outbound.map((call) => new URL(call.url).origin),
          [owner.origin],
        );
        assert.equal(recorder.calls.length, 1);
      }),
    ),
  );

  it.effect("keeps a localhost address the owner's: it is not read or rewritten here", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, enroll, recorder } = yield* connected();
        yield* enroll(peer);
        yield* peer.adapter.handle(open({}, "http://localhost:3000/dev"));
        const seen = recorder.calls[0]!.input as { url: string };
        assert.equal(seen.url, "http://localhost:3000/dev");
        // Only the owner was contacted; this server did not try the address itself.
        assert.isTrue(peer.outbound.every((call) => !call.url.includes("3000")));
      }),
    ),
  );

  it.effect(
    "is claimed here only for a browser another environment owns, or a tab it is known to hold",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { peer, enroll } = yield* connected();
          yield* enroll(peer);
          assert.isTrue(peer.remote.claims(open()));
          assert.isFalse(
            peer.remote.claims(
              request("open", { browserBinding: { ...binding, ownerEnvironmentId: PEER } }),
            ),
          );
          assert.isFalse(peer.remote.claims(request("status", {}, { tabId: "tab-1" as never })));
          yield* peer.adapter.handle(open());
          assert.isTrue(peer.remote.claims(request("status", {}, { tabId: "tab-1" as never })));
          assert.isFalse(
            peer.remote.claims(
              request("status", {}, { tabId: "tab-1" as never, threadId: "other" as never }),
            ),
          );
        }),
      ),
  );

  it.effect("fails by name with no enrollment, sending nothing and starting nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, recorder } = yield* connected();
        const failure = failureOf(yield* Effect.exit(peer.adapter.handle(open())));
        assert.equal(failure.tag, "PreviewAutomationExecutionError");
        assert.include(failure.message, "no enrollment");
        assert.include(failure.message, "never started here");
        assert.equal(peer.outbound.length, 0);
        assert.equal(recorder.calls.length, 0);
      }),
    ),
  );

  it.effect("needs the enrollment to be for this thread, provider session and browser", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, enroll, recorder } = yield* connected();
        yield* enroll(peer);
        for (const other of [
          open({ threadId: "thread-2" as never }),
          open({ agentSessionId: "session-2" }),
          request("open", { browserBinding: { ...binding, profileId: "profile-2" } }),
          request("open", { browserBinding: { ...binding, instanceId: "instance-2" } }),
        ]) {
          failureOf(yield* Effect.exit(peer.adapter.handle(other)));
        }
        assert.equal(peer.outbound.length, 0);
        assert.equal(recorder.calls.length, 0);
      }),
    ),
  );

  it.effect(
    "fails by name when the owner cannot be reached, and starts no browser in its place",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { peer, owner, enroll, recorder } = yield* connected();
          yield* enroll(peer);
          yield* peer.adapter.handle(open());
          yield* owner.stopListening;
          const failure = failureOf(yield* Effect.exit(peer.adapter.handle(open())));
          assert.equal(failure.tag, "PreviewAutomationExecutionError");
          assert.include(failure.message, "could not be reached");
          assert.include(failure.message, "No browser was started here");
          assert.equal(peer.outbound.at(-1)?.status, "unreachable");
          // The peer hosts nothing, and the one call that was served is the only one the browser saw.
          assert.isFalse(peer.local.enabled);
          assert.equal(recorder.calls.length, 1);
          // A status of the remote tab fails the same way rather than falling back to an ordinary tab.
          const status = failureOf(
            yield* Effect.exit(
              peer.adapter.handle(request("status", {}, { tabId: "tab-1" as never })),
            ),
          );
          assert.include(status.message, "could not be reached");
        }),
      ),
  );

  it.effect("reports a refusal as the owner refusing this server's grant, not as an outage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, owner, enroll, recorder } = yield* connected();
        const { created } = yield* enroll(peer);
        yield* peer.adapter.handle(open());
        yield* owner.request("DELETE", `${GRANTS}/${created.grant.id}`);
        const failure = failureOf(yield* Effect.exit(peer.adapter.handle(open())));
        assert.include(failure.message, "refused this server's grant");
        assert.notInclude(failure.message, created.credential);
        assert.equal(recorder.calls.length, 1);
        assert.equal(peer.outbound.at(-1)?.status, 401);
      }),
    ),
  );

  it.effect("does not send a call it knows the grant has expired for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clock = { now: 70_000_000 };
        const { peer, enroll } = yield* connected(undefined, clock);
        yield* enroll(peer, {}, { ttlSeconds: 60 });
        yield* peer.adapter.handle(open());
        clock.now += 61_000;
        const failure = failureOf(yield* Effect.exit(peer.adapter.handle(open())));
        assert.include(failure.message, "expired");
        assert.equal(peer.outbound.length, 1);
      }),
    ),
  );

  it.effect("does not trust an endpoint that answers as a different environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, enroll, recorder } = yield* connected();
        // The owner's record, but the endpoint is another server of the same kind.
        const stranger = yield* startServer({
          environmentId: EnvironmentId.make("env-stranger"),
          engineDataRoot: null,
          fakeLocal: recorder.adapter,
        });
        yield* enroll(peer, { endpoint: stranger.origin });
        const failure = failureOf(yield* Effect.exit(peer.adapter.handle(open())));
        assert.include(failure.message, "did not answer as the environment");
        assert.equal(recorder.calls.length, 0);
      }),
    ),
  );

  it.effect("follows no redirect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, enroll } = yield* connected();
        const landed: string[] = [];
        const target = NodeHttp.createServer((incoming, outgoing) => {
          landed.push(incoming.url ?? "");
          outgoing.end("{}");
        });
        const redirecting = NodeHttp.createServer((_incoming, outgoing) => {
          outgoing.statusCode = 307;
          outgoing.setHeader(
            "location",
            `http://127.0.0.1:${(target.address() as { port: number }).port}/captured`,
          );
          outgoing.end();
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<void>((resolve) =>
                target.listen(0, "127.0.0.1", () =>
                  redirecting.listen(0, "127.0.0.1", () => resolve()),
                ),
              ),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  target.closeAllConnections();
                  redirecting.closeAllConnections();
                  target.close(() => redirecting.close(() => resolve()));
                }),
            ),
        );
        const redirectOrigin = `http://127.0.0.1:${(redirecting.address() as { port: number }).port}`;
        yield* enroll(peer, { endpoint: redirectOrigin });
        failureOf(yield* Effect.exit(peer.adapter.handle(open())));
        assert.deepEqual(
          landed,
          [],
          "the redirect target was never contacted, with or without the credential",
        );
      }),
    ),
  );

  it.effect("sends a file as bytes and shows the page a copy the owner holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, enroll, recorder } = yield* connected();
        yield* enroll(peer);
        const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "caller-files-"));
        const local = Path.join(directory, "resume.txt");
        FS.writeFileSync(local, "caller bytes");
        yield* peer.adapter.handle(open());
        yield* peer.adapter.handle(
          request(
            "upload",
            { paths: [local], locator: "role=button" },
            { tabId: "tab-1" as never },
          ),
        );
        const uploadCall = recorder.calls.find((call) => call.operation === "upload")!;
        const paths = (uploadCall.input as { paths: string[] }).paths;
        // The owner's adapter was given the owner's own copy, never the caller's path.
        assert.notInclude(paths[0]!, directory);
        assert.include(paths[0]!, "peer-transfers");
        // A file this server cannot read, or that is too large, fails before anything is sent.
        const before = peer.outbound.length;
        failureOf(
          yield* Effect.exit(
            peer.adapter.handle(
              request(
                "upload",
                { paths: [Path.join(directory, "missing.txt")], locator: "role=button" },
                { tabId: "tab-1" as never },
              ),
            ),
          ),
        );
        assert.equal(peer.outbound.length, before);
        FS.rmSync(directory, { recursive: true, force: true });
      }),
    ),
  );

  it.effect(
    "copies a download here after checking it, and shows a path here, not the owner's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ownerDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "owner-dl-"));
          const ownerFile = Path.join(ownerDirectory, "id-1");
          FS.writeFileSync(ownerFile, "report bytes");
          const { peer, enroll, recorder } = yield* connected((call) =>
            Effect.succeed({
              tabId: "tab-1",
              downloads:
                call.operation === "status"
                  ? [
                      {
                        fileName: "report.csv",
                        path: ownerFile,
                        sizeBytes: 12,
                        url: "https://example.com/r.csv",
                        completedAt: "2026-10-16T00:00:00.000Z",
                      },
                    ]
                  : [],
            }),
          );
          recorder.downloads.set("tab-1/id-1", { path: ownerFile, fileName: "report.csv" });
          yield* enroll(peer);
          yield* peer.adapter.handle(open());
          const status = (yield* peer.adapter.handle(
            request("status", {}, { tabId: "tab-1" as never }),
          )) as { downloads: Array<{ path: string; fileName: string }> };
          assert.equal(status.downloads.length, 1);
          const local = status.downloads[0]!.path;
          assert.notInclude(local, ownerDirectory);
          assert.include(local, Path.join(peer.root, "remote-downloads"));
          assert.equal(FS.readFileSync(local, "utf8"), "report bytes");
          assert.equal(FS.statSync(local).mode & 0o777, 0o600);
          // A second status is not a second transfer.
          const transfers = peer.outbound.length;
          yield* peer.adapter.handle(request("status", {}, { tabId: "tab-1" as never }));
          assert.equal(peer.outbound.length, transfers + 1);
          FS.rmSync(ownerDirectory, { recursive: true, force: true });
        }),
      ),
  );

  it.effect("carries an operation's own failure through unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ServerBrowserOperationError: OperationError } = yield* Effect.promise(
          () => import("../preview/ServerBrowserPage.ts"),
        );
        const { peer, enroll } = yield* connected(() =>
          Effect.fail(
            new OperationError(
              "PreviewAutomationControlInterruptedError",
              "A human controls this browser tab.",
              "humanControl",
            ),
          ),
        );
        yield* enroll(peer);
        const exit = yield* Effect.exit(peer.adapter.handle(open()));
        assert.deepEqual(failureOf(exit), {
          tag: "PreviewAutomationControlInterruptedError",
          message: "A human controls this browser tab.",
        });
        const failure = Exit.isFailure(exit)
          ? (
              exit.cause.reasons.find((reason) => reason._tag === "Fail") as {
                error?: ServerBrowserOperationError;
              }
            )?.error
          : undefined;
        assert.equal(failure?.detail, "humanControl");
        assert.isTrue(Option.isNone(Option.fromNullishOr(undefined)));
      }),
    ),
  );
});
