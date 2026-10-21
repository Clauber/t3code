// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off globalRandomInEffect:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  EnvironmentId,
  MANAGED_BROWSER_PEER_DISPATCH_PATH,
  MANAGED_BROWSER_PEER_DOWNLOAD_PATH,
  MANAGED_BROWSER_PEER_NAME_HEADER,
  MANAGED_BROWSER_PEER_SESSION_HEADER,
  MANAGED_BROWSER_PEER_THREAD_HEADER,
  MANAGED_BROWSER_PEER_UPLOAD_PATH,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
} from "@t3tools/contracts";
import { ServerBrowserOperationError } from "../preview/ServerBrowserPage.ts";
import { remoteThreadId } from "./ManagedBrowserAccess.ts";
import { recordingAdapter, startServer } from "./ManagedBrowserCrossHostFixture.ts";

const OWNER = EnvironmentId.make("env-owner");
const PEER = EnvironmentId.make("env-peer");
const instanceId = ManagedBrowserInstanceId.make("instance-1");
const profileId = ManagedBrowserProfileId.make("profile-1");
const binding = { ownerEnvironmentId: OWNER, instanceId, profileId };
const GRANTS = "/api/managed-browser/grants";

const createInput = (extra: Record<string, unknown> = {}) => ({
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

interface Created {
  readonly grant: { readonly id: string; readonly expiresAt: string };
  readonly credential: string;
}

/** An owner whose browser is a recorder, so what reaches it is exactly what the routes let through. */
const owner = (clock = { now: 50_000_000 }) =>
  Effect.gen(function* () {
    const recorder = recordingAdapter();
    const server = yield* startServer({
      environmentId: OWNER,
      engineDataRoot: null,
      fakeLocal: recorder.adapter,
      now: () => clock.now,
    });
    const grant = (extra: Record<string, unknown> = {}) =>
      server.request("POST", GRANTS, { body: createInput(extra) }).pipe(
        Effect.map((response) => {
          assert.equal(response.status, 201, response.text);
          return response.json as Created;
        }),
      );
    return { server, recorder, grant, clock };
  });

const peerHeaders = (
  credential: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  authorization: `Bearer ${credential}`,
  [MANAGED_BROWSER_PEER_THREAD_HEADER]: "thread-1",
  [MANAGED_BROWSER_PEER_SESSION_HEADER]: "session-1",
  ...extra,
});

const call = (operation: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  request: {
    requestId: "request-1",
    threadId: "thread-1",
    agentSessionId: "session-1",
    callerEnvironmentId: PEER,
    operation,
    input,
    timeoutMs: 15_000,
    ...extra,
  },
});

const open = (extra: Record<string, unknown> = {}) =>
  call("open", { browserBinding: binding, url: "https://example.com/" }, extra);

describe("the administrator routes", () => {
  it.effect("need a session with the protected access scopes, not just any session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* owner();
        const body = createInput();
        // No credential at all.
        assert.equal((yield* server.request("GET", GRANTS, { scopes: null })).status, 401);
        assert.equal((yield* server.request("POST", GRANTS, { scopes: null, body })).status, 401);
        // A signed-in session that can drive agents and previews but does not administer access.
        const ordinary = "orchestration:read,orchestration:operate,preview:operate,settings:write";
        assert.equal((yield* server.request("GET", GRANTS, { scopes: ordinary })).status, 403);
        assert.equal(
          (yield* server.request("POST", GRANTS, { scopes: ordinary, body })).status,
          403,
        );
        // Reading access is not writing it.
        assert.equal((yield* server.request("GET", GRANTS, { scopes: "access:read" })).status, 200);
        assert.equal(
          (yield* server.request("POST", GRANTS, { scopes: "access:read", body })).status,
          403,
        );
        assert.equal(
          (yield* server.request("DELETE", `${GRANTS}/${"0".repeat(32)}`, {
            scopes: "access:read",
          })).status,
          403,
        );
        // Enrollments are administered the same way.
        assert.equal(
          (yield* server.request("POST", "/api/managed-browser/enrollments", {
            scopes: null,
            body: {},
          })).status,
          401,
        );
        assert.equal(
          (yield* server.request("GET", "/api/managed-browser/enrollments", {
            scopes: "orchestration:read",
          })).status,
          403,
        );
        const created = yield* server.request("POST", GRANTS, { body });
        assert.equal(created.status, 201);
      }),
    ),
  );

  it.effect("show a credential once, and never in a listing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, grant } = yield* owner();
        const created = yield* grant();
        assert.match(created.credential, /^mbg\./);
        const listed = yield* server.request("GET", GRANTS);
        assert.equal(listed.status, 200);
        assert.notInclude(listed.text, created.credential);
        assert.notInclude(listed.text, created.credential.split(".")[2]!);
        assert.include(listed.text, created.grant.id);
        assert.equal(
          (yield* server.request("GET", GRANTS, { headers: { "x-extra": "1" } })).text.includes(
            "credential",
          ),
          false,
        );
      }),
    ),
  );

  it.effect("reject malformed, unbounded and unknown requests without making a grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* owner();
        const bad = [
          { subject: { kind: "agent" } },
          createInput({ ttlSeconds: 0 }),
          createInput({ ttlSeconds: 31 * 24 * 3600 }),
          createInput({ resources: [] }),
          createInput({ access: "root" }),
        ];
        for (const body of bad) {
          assert.equal((yield* server.request("POST", GRANTS, { body })).status, 400);
        }
        const notJson = yield* server.request("POST", GRANTS, {
          rawBody: new TextEncoder().encode("{ nope"),
        });
        assert.equal(notJson.status, 400);
        assert.deepEqual((yield* server.request("GET", GRANTS)).json, { grants: [] });
        assert.equal((yield* server.request("GET", "/api/managed-browser/nothing")).status, 404);
        assert.equal((yield* server.request("GET", "/api/managed-browser/peer/other")).status, 404);
      }),
    ),
  );

  it.effect("revoke a grant, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, grant } = yield* owner();
        const created = yield* grant();
        const first = yield* server.request("DELETE", `${GRANTS}/${created.grant.id}`);
        assert.deepEqual(first.json, { revoked: true });
        const second = yield* server.request("DELETE", `${GRANTS}/${created.grant.id}`);
        assert.deepEqual(second.json, { revoked: false });
      }),
    ),
  );
});

describe("a call from another environment", () => {
  it.effect("is served as the grant's caller, under the owner's name for its thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, recorder, grant } = yield* owner();
        const created = yield* grant();
        const response = yield* server.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
          scopes: null,
          headers: peerHeaders(created.credential),
          body: open(),
        });
        assert.equal(response.status, 200, response.text);
        assert.deepEqual(response.json, { ok: true, result: { tabId: "tab-1" } });
        assert.equal(recorder.calls.length, 1);
        const served = recorder.calls[0]!;
        // The owner never sees a bare `thread-1` from another environment.
        assert.equal(served.threadId, remoteThreadId(PEER, "thread-1"));
        assert.equal(served.callerEnvironmentId, PEER);
        assert.equal(served.agentSessionId, "session-1");
      }),
    ),
  );

  it.effect(
    "is refused before it reaches the browser unless the credential, thread and session agree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const clock = { now: 50_000_000 };
          const { server, recorder, grant } = yield* owner(clock);
          const created = yield* grant({ ttlSeconds: 600 });
          const revoked = yield* grant();
          yield* server.request("DELETE", `${GRANTS}/${revoked.grant.id}`);
          const dispatch = (headers: Record<string, string>, body: unknown = open()) =>
            server.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
              scopes: null,
              headers,
              body,
            });
          const cases: Array<[string, number, Record<string, string>, unknown?]> = [
            ["no credential", 401, {}],
            ["garbage credential", 401, peerHeaders("garbage")],
            ["a revoked credential", 401, peerHeaders(revoked.credential)],
            [
              "another thread's header",
              403,
              peerHeaders(created.credential, { [MANAGED_BROWSER_PEER_THREAD_HEADER]: "thread-2" }),
            ],
            [
              "another provider session's header",
              403,
              peerHeaders(created.credential, {
                [MANAGED_BROWSER_PEER_SESSION_HEADER]: "session-2",
              }),
            ],
            [
              "a body for another thread",
              403,
              peerHeaders(created.credential),
              open({ threadId: "thread-2" }),
            ],
            [
              "a body for another provider session",
              403,
              peerHeaders(created.credential),
              open({ agentSessionId: "session-2" }),
            ],
            [
              "a body claiming another environment",
              403,
              peerHeaders(created.credential),
              open({ callerEnvironmentId: "env-other" }),
            ],
            [
              "another profile",
              403,
              peerHeaders(created.credential),
              call("open", { browserBinding: { ...binding, profileId: "profile-2" } }),
            ],
            [
              "another instance",
              403,
              peerHeaders(created.credential),
              call("open", { browserBinding: { ...binding, instanceId: "instance-2" } }),
            ],
            [
              "a browser some other environment owns",
              403,
              peerHeaders(created.credential),
              call("open", { browserBinding: { ...binding, ownerEnvironmentId: "env-third" } }),
            ],
          ];
          for (const [label, status, headers, body] of cases) {
            const response = yield* dispatch(headers, body);
            assert.equal(response.status, status, label);
            // The refusal says no more than that, and never why.
            assert.notInclude(response.text, created.credential, label);
          }
          assert.equal(recorder.calls.length, 0, "nothing reached the browser");
          // An expired credential is refused the same way.
          clock.now += 601_000;
          assert.equal((yield* dispatch(peerHeaders(created.credential))).status, 401);
          assert.equal(recorder.calls.length, 0);
        }),
      ),
  );

  it.effect("cannot name a path on the owner: files arrive as bytes and become handles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, recorder, grant } = yield* owner();
        const created = yield* grant();
        const other = yield* grant();
        const dispatch = (credential: string, paths: ReadonlyArray<string>) =>
          server.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
            scopes: null,
            headers: peerHeaders(credential),
            body: call("upload", { paths, locator: "role=button" }),
          });
        const upload = (credential: string, bytes: string, name = "notes.txt") =>
          server.request("POST", MANAGED_BROWSER_PEER_UPLOAD_PATH, {
            scopes: null,
            headers: peerHeaders(credential, { [MANAGED_BROWSER_PEER_NAME_HEADER]: name }),
            rawBody: new TextEncoder().encode(bytes),
          });

        // An owner path is refused outright, and nothing is read from it.
        const refused = yield* dispatch(created.credential, ["/etc/passwd"]);
        assert.equal(refused.status, 200);
        assert.equal((refused.json as { ok: boolean }).ok, false);
        assert.equal(recorder.calls.length, 0);

        const sent = yield* upload(created.credential, "hello owner", "../../etc/evil name.txt");
        assert.equal(sent.status, 200, sent.text);
        const handle = (sent.json as { handle: string }).handle;

        // Another grant's handle is no use to this one.
        const stolen = yield* dispatch(other.credential, [`mbh:${handle}`]);
        assert.equal((stolen.json as { ok: boolean }).ok, false);
        assert.equal(recorder.calls.length, 0);

        const served = yield* dispatch(created.credential, [`mbh:${handle}`]);
        assert.equal((served.json as { ok: boolean }).ok, true);
        const [seen] = recorder.calls;
        const paths = (seen!.input as { paths: string[] }).paths;
        assert.equal(paths.length, 1);
        // The browser is handed the owner's own copy, under its own transfer directory, not a caller path.
        assert.include(paths[0]!, "peer-transfers");
        assert.notInclude(paths[0]!, "..");
        // It was consumed: the copy is gone and the handle works once.
        assert.isFalse(FS.existsSync(paths[0]!));
        const again = yield* dispatch(created.credential, [`mbh:${handle}`]);
        assert.equal((again.json as { ok: boolean }).ok, false);
        assert.equal(recorder.calls.length, 1);
      }),
    ),
  );

  it.effect("accepts an upload only from a grant that may operate, and within its limits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, grant } = yield* owner();
        const reader = yield* grant({ access: "read" });
        const upload = (credential: string, rawBody: Uint8Array) =>
          server.request("POST", MANAGED_BROWSER_PEER_UPLOAD_PATH, {
            scopes: null,
            headers: peerHeaders(credential),
            rawBody,
          });
        assert.equal((yield* upload(reader.credential, new Uint8Array(4))).status, 403);
        assert.equal((yield* upload("garbage", new Uint8Array(4))).status, 401);
        const writer = yield* grant();
        // Too many files waiting for one grant.
        let last = 200;
        for (let index = 0; index < 41; index += 1) {
          last = (yield* upload(writer.credential, new Uint8Array(1))).status;
        }
        assert.equal(last, 413);
      }),
    ),
  );

  it.effect("shows the caller a handle where the browser reported a path on the owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const downloaded = Path.join(OS.tmpdir(), "owner-secret-dir", "11111111-aaaa");
        const recorder = recordingAdapter(() =>
          Effect.succeed({
            tabId: "tab-1",
            downloads: [
              {
                fileName: "report.csv",
                path: downloaded,
                sizeBytes: 5,
                url: "https://example.com/report.csv",
                completedAt: "2026-10-16T00:00:00.000Z",
              },
            ],
          }),
        );
        const server = yield* startServer({
          environmentId: OWNER,
          engineDataRoot: null,
          fakeLocal: recorder.adapter,
        });
        const created = (yield* server.request("POST", GRANTS, { body: createInput() }))
          .json as Created;
        const response = yield* server.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
          scopes: null,
          headers: peerHeaders(created.credential),
          body: call("status", {}, { tabId: "tab-1" }),
        });
        assert.notInclude(response.text, "owner-secret-dir");
        const result = (response.json as { result: { downloads: Array<{ path: string }> } }).result;
        assert.equal(result.downloads[0]!.path, "mbd:tab-1/11111111-aaaa");
      }),
    ),
  );

  it.effect(
    "fetches a download's bytes with a digest, for the grant that owns the tab, and for no other",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "owner-download-"));
          const file = Path.join(directory, "id-1");
          FS.writeFileSync(file, "owner bytes");
          const { server, recorder, grant } = yield* owner();
          recorder.downloads.set("tab-1/id-1", { path: file, fileName: "report.csv" });
          const created = yield* grant();
          const fetchBytes = (credential: string, body: unknown, headers = {}) =>
            server.request("POST", MANAGED_BROWSER_PEER_DOWNLOAD_PATH, {
              scopes: null,
              headers: { ...peerHeaders(credential), ...headers },
              body,
            });
          const ok = yield* fetchBytes(created.credential, {
            threadId: "thread-1",
            tabId: "tab-1",
            downloadId: "id-1",
          });
          assert.equal(ok.status, 200);
          assert.equal(ok.text, "owner bytes");
          assert.equal(
            (yield* fetchBytes(created.credential, {
              threadId: "thread-1",
              tabId: "tab-1",
              downloadId: "missing",
            })).status,
            404,
          );
          assert.equal(
            (yield* fetchBytes(created.credential, {
              threadId: "thread-2",
              tabId: "tab-1",
              downloadId: "id-1",
            })).status,
            400,
          );
          assert.equal(
            (yield* fetchBytes("garbage", {
              threadId: "thread-1",
              tabId: "tab-1",
              downloadId: "id-1",
            })).status,
            401,
          );
          FS.rmSync(directory, { recursive: true, force: true });
        }),
      ),
  );

  it.effect("carries an operation's failure to the caller by tag and message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = recordingAdapter(() =>
          Effect.fail(
            new ServerBrowserOperationError(
              "PreviewAutomationControlInterruptedError",
              "A human controls this browser tab.",
              "humanControl",
            ),
          ),
        );
        const server = yield* startServer({
          environmentId: OWNER,
          engineDataRoot: null,
          fakeLocal: recorder.adapter,
        });
        const created = (yield* server.request("POST", GRANTS, { body: createInput() }))
          .json as Created;
        const response = yield* server.request("POST", MANAGED_BROWSER_PEER_DISPATCH_PATH, {
          scopes: null,
          headers: peerHeaders(created.credential),
          body: open(),
        });
        assert.deepEqual(response.json, {
          ok: false,
          error: {
            tag: "PreviewAutomationControlInterruptedError",
            message: "A human controls this browser tab.",
            detail: "humanControl",
          },
        });
      }),
    ),
  );
});
