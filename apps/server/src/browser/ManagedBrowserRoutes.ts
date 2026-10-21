// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off anyUnknownInErrorContext:off
/**
 * ManagedBrowserRoutes - the HTTP surface of cross-environment managed browsers.
 *
 * Two kinds of caller, two kinds of credential, kept apart on purpose:
 *
 * - **Administrators** manage grants (on the owner) and enrollments (on a calling server) through the
 *   normal authenticated routes, with the same protected `access:*` scopes that guard pairing and
 *   sessions. Holding an ordinary session, even a paired one, grants nothing here.
 * - **Calling servers** reach the owner at `/peer/*` with a grant credential. The credential is bound to
 *   one environment, thread and provider session and to named browsers; the headers and body of a call
 *   are checked against it, never believed. Whatever the credential does not name is refused before the
 *   browser sees the request, and each call is checked again where it is served, so a revocation or an
 *   expiry stops the next one.
 *
 * Routes only decode, call one service and map errors. A peer request is served by the **local** adapter
 * and never passed on to another environment. Files cross as bytes: an upload becomes a handle the owner
 * resolves to its own copy (a remote caller cannot name an owner path), and a download's owner path is
 * replaced by a handle the caller redeems for the bytes.
 *
 * @module ManagedBrowserRoutes
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  MANAGED_BROWSER_DOWNLOAD_HANDLE_PREFIX,
  MANAGED_BROWSER_PEER_DISPATCH_PATH,
  MANAGED_BROWSER_PEER_DOWNLOAD_PATH,
  MANAGED_BROWSER_PEER_NAME_HEADER,
  MANAGED_BROWSER_PEER_SESSION_HEADER,
  MANAGED_BROWSER_PEER_THREAD_HEADER,
  MANAGED_BROWSER_PEER_UPLOAD_PATH,
  MANAGED_BROWSER_ROUTE_PREFIX,
  MANAGED_BROWSER_UPLOAD_HANDLE_PREFIX,
  ManagedBrowserEnrollmentCreateInput,
  ManagedBrowserGrantCreateInput,
  type ManagedBrowserGrant,
  ManagedBrowserPeerDispatchRequest,
  type ManagedBrowserPeerDispatchResponse,
  previewAutomationBrowserBinding,
  type PreviewAutomationRequest,
  type PreviewAutomationUploadInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EffectPath from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { authenticateRawRequest } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import * as ManagedBrowserAccess from "./ManagedBrowserAccess.ts";
import * as ManagedBrowserPreviewAdapter from "./ManagedBrowserPreviewAdapter.ts";
import * as ManagedBrowserRemoteClient from "./ManagedBrowserRemoteClient.ts";

const OWNER_HEADER = "x-t3-managed-browser-owner";
const DIGEST_HEADER = "x-t3-managed-browser-sha256";
const NAME_HEADER = "x-t3-managed-browser-name";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_HANDLES_PER_GRANT = 40;
const HANDLE_TTL_MS = 10 * 60 * 1000;

const isStoreFailure = Schema.is(
  Schema.Union([
    ManagedBrowserAccess.ManagedBrowserAccessStoreError,
    ManagedBrowserRemoteClient.ManagedBrowserEnrollmentError,
  ]),
);
const decodeCreate = Schema.decodeUnknownEffect(ManagedBrowserGrantCreateInput);
const decodeEnrollment = Schema.decodeUnknownEffect(ManagedBrowserEnrollmentCreateInput);
const decodeDispatch = Schema.decodeUnknownEffect(ManagedBrowserPeerDispatchRequest);

export interface ManagedBrowserRoutesOptions {
  /** Where uploads from calling servers wait for the browser to take them. Created on demand, mode 0700. */
  readonly transfersRoot: string;
  readonly now?: () => number;
}

interface Transfer {
  readonly grantId: string;
  readonly path: string;
  readonly expiresAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonResponse = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", ...extra },
  });

const bearerOf = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers.authorization;
  return header !== undefined && header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
};

/** Headers carry the thread and session percent-encoded, since a provider session id may hold any character. */
const decodeHeader = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

const lastSegment = (pathname: string) =>
  decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));

const makeHandler = (
  options: ManagedBrowserRoutesOptions,
  services: {
    readonly access: ManagedBrowserAccess.ManagedBrowserAccessService["Service"];
    readonly local: ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter["Service"];
    readonly remote: ManagedBrowserRemoteClient.ManagedBrowserRemoteClient["Service"];
    readonly ownerEnvironmentId: string;
  },
) => {
  const now = options.now ?? Date.now;
  const transfers = new Map<string, Transfer>();
  const { access, local, remote, ownerEnvironmentId } = services;
  const ownerHeaders = { [OWNER_HEADER]: ownerEnvironmentId };

  const forgetTransfer = (handle: string) => {
    const transfer = transfers.get(handle);
    if (transfer === undefined) return;
    transfers.delete(handle);
    // Each file waits in a directory of its own, so the browser sees the caller's file name, not a handle.
    FS.rmSync(Path.dirname(transfer.path), { recursive: true, force: true });
  };

  const purgeExpired = () => {
    for (const [handle, transfer] of transfers) {
      if (transfer.expiresAt <= now()) forgetTransfer(handle);
    }
  };

  const refuse = (status: 401 | 403 | 404 | 413 | 400, reason: string) =>
    jsonResponse({ error: reason }, status, ownerHeaders);

  // --- who is calling -----------------------------------------------------------

  /**
   * The grant behind a bearer credential, and the thread and session the call says it is for, which
   * must be the ones the grant names. The owner's own name for the thread includes the environment.
   */
  const authenticatePeer = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const credential = bearerOf(request);
      if (credential === undefined) {
        return { _tag: "refused" as const, response: refuse(401, "unauthorized") };
      }
      const grant = yield* access.authenticate(credential).pipe(Effect.option);
      if (Option.isNone(grant) || grant.value.subject.kind !== "agent") {
        // The credential itself is never logged, only that one was not accepted.
        yield* Effect.logWarning("managed browser peer call refused", { reason: "credential" });
        return { _tag: "refused" as const, response: refuse(401, "unauthorized") };
      }
      const subject = grant.value.subject;
      if (
        decodeHeader(request.headers[MANAGED_BROWSER_PEER_THREAD_HEADER]) !== subject.threadId ||
        decodeHeader(request.headers[MANAGED_BROWSER_PEER_SESSION_HEADER]) !==
          subject.agentSessionId
      ) {
        yield* Effect.logWarning("managed browser peer call refused", {
          reason: "thread or provider session does not match the grant",
          grantId: grant.value.id,
        });
        return { _tag: "refused" as const, response: refuse(403, "forbidden") };
      }
      return {
        _tag: "granted" as const,
        grant: grant.value,
        subject,
        ownerThreadId: ManagedBrowserAccess.remoteThreadId(
          subject.callerEnvironmentId,
          subject.threadId,
        ),
      };
    });

  const readBodyText = (request: HttpServerRequest.HttpServerRequest, limit: number) =>
    Effect.gen(function* () {
      if (Number(request.headers["content-length"] ?? "0") > limit) return undefined;
      const text = yield* request.text;
      return text.length > limit ? undefined : text;
    });

  // --- owner: grants ------------------------------------------------------------

  const administer = (request: HttpServerRequest.HttpServerRequest, pathname: string) => {
    const sub = pathname.slice(MANAGED_BROWSER_ROUTE_PREFIX.length);
    if (sub === "/grants" && request.method === "GET") {
      return Effect.gen(function* () {
        yield* authenticateRawRequest(AuthAccessReadScope);
        const grants = yield* access.list;
        return jsonResponse({ grants });
      });
    }
    if (sub === "/grants" && request.method === "POST") {
      return Effect.gen(function* () {
        yield* authenticateRawRequest(AuthAccessWriteScope);
        const text = yield* readBodyText(request, MAX_JSON_BYTES);
        if (text === undefined) return refuse(413, "too large");
        const input = yield* Effect.try({
          try: () => JSON.parse(text),
          catch: () => undefined,
        }).pipe(Effect.flatMap(decodeCreate), Effect.option);
        if (Option.isNone(input)) return refuse(400, "invalid grant");
        const result = yield* access.enroll(input.value);
        // The credential is in this response and in no log, event or later read.
        return jsonResponse(result, 201);
      });
    }
    if (sub.startsWith("/grants/") && request.method === "DELETE") {
      return Effect.gen(function* () {
        yield* authenticateRawRequest(AuthAccessWriteScope);
        const revoked = yield* access.revoke(lastSegment(pathname));
        return jsonResponse({ revoked });
      });
    }
    if (sub === "/enrollments" && request.method === "GET") {
      return Effect.gen(function* () {
        yield* authenticateRawRequest(AuthAccessReadScope);
        return jsonResponse({ enrollments: yield* remote.list });
      });
    }
    if (sub === "/enrollments" && request.method === "POST") {
      return Effect.gen(function* () {
        yield* authenticateRawRequest(AuthAccessWriteScope);
        const text = yield* readBodyText(request, MAX_JSON_BYTES);
        if (text === undefined) return refuse(413, "too large");
        const input = yield* Effect.try({
          try: () => JSON.parse(text),
          catch: () => undefined,
        }).pipe(Effect.flatMap(decodeEnrollment), Effect.option);
        if (Option.isNone(input)) return refuse(400, "invalid enrollment");
        const enrollment = yield* remote.enroll(input.value);
        return jsonResponse(enrollment, 201);
      });
    }
    if (sub.startsWith("/enrollments/") && request.method === "DELETE") {
      return Effect.gen(function* () {
        yield* authenticateRawRequest(AuthAccessWriteScope);
        return jsonResponse({ removed: yield* remote.remove(lastSegment(pathname)) });
      });
    }
    return Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 }));
  };

  // --- owner: calls from enrolled servers --------------------------------------

  /** An owner path in a result is replaced by a handle the caller redeems for bytes. */
  const scrub = (result: unknown): unknown => {
    if (!isRecord(result) || !Array.isArray(result.downloads)) return result;
    const tabId = typeof result.tabId === "string" ? result.tabId : "";
    return {
      ...result,
      downloads: result.downloads.map((entry) =>
        isRecord(entry) && typeof entry.path === "string"
          ? {
              ...entry,
              path: `${MANAGED_BROWSER_DOWNLOAD_HANDLE_PREFIX}${tabId}/${Path.basename(entry.path)}`,
            }
          : entry,
      ),
    };
  };

  const failure = (error: unknown): ManagedBrowserPeerDispatchResponse => {
    if (error instanceof ServerBrowserPage.ServerBrowserOperationError) {
      return {
        ok: false,
        error: {
          tag: error.tag,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      };
    }
    return {
      ok: false,
      error: {
        tag: "PreviewAutomationExecutionError",
        message: "The managed browser call failed.",
      },
    };
  };

  /** Resolves handles in an upload to the owner's own copies. Anything else is an owner path and is refused. */
  const resolveUploads = (grant: ManagedBrowserGrant, request: PreviewAutomationRequest) => {
    if (request.operation !== "upload")
      return { _tag: "ok" as const, request, used: [] as string[] };
    const input = request.input as PreviewAutomationUploadInput;
    const used: string[] = [];
    const paths: string[] = [];
    for (const candidate of input.paths) {
      const handle = candidate.startsWith(MANAGED_BROWSER_UPLOAD_HANDLE_PREFIX)
        ? candidate.slice(MANAGED_BROWSER_UPLOAD_HANDLE_PREFIX.length)
        : undefined;
      const transfer = handle === undefined ? undefined : transfers.get(handle);
      if (
        handle === undefined ||
        transfer === undefined ||
        transfer.grantId !== grant.id ||
        transfer.expiresAt <= now()
      ) {
        return { _tag: "refused" as const };
      }
      used.push(handle);
      paths.push(transfer.path);
    }
    return { _tag: "ok" as const, request: { ...request, input: { ...input, paths } }, used };
  };

  const dispatch = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const peer = yield* authenticatePeer(request);
      if (peer._tag === "refused") return peer.response;
      const text = yield* readBodyText(request, MAX_JSON_BYTES);
      if (text === undefined) return refuse(413, "too large");
      const decoded = yield* Effect.try({
        try: () => JSON.parse(text),
        catch: () => undefined,
      }).pipe(Effect.flatMap(decodeDispatch), Effect.option);
      if (Option.isNone(decoded)) return refuse(400, "invalid request");
      const call = decoded.value.request;
      const { subject } = peer;
      // What the body says about who is calling must be what the credential says; it is never extra authority.
      if (
        call.threadId !== subject.threadId ||
        call.agentSessionId !== subject.agentSessionId ||
        (call.callerEnvironmentId !== undefined &&
          call.callerEnvironmentId !== subject.callerEnvironmentId)
      ) {
        yield* Effect.logWarning("managed browser peer call refused", {
          reason: "request does not match the grant's caller",
          grantId: peer.grant.id,
        });
        return refuse(403, "forbidden");
      }
      const binding = previewAutomationBrowserBinding(call);
      if (
        binding !== undefined &&
        (binding.ownerEnvironmentId !== ownerEnvironmentId ||
          !peer.grant.resources.some(
            (resource) =>
              resource.instanceId === binding.instanceId &&
              resource.profileId === binding.profileId,
          ))
      ) {
        yield* Effect.logWarning("managed browser peer call refused", {
          reason: "browser not covered by the grant",
          grantId: peer.grant.id,
        });
        return refuse(403, "forbidden");
      }
      const uploads = resolveUploads(peer.grant, call);
      if (uploads._tag === "refused") {
        return jsonResponse(
          {
            ok: false,
            error: {
              tag: "PreviewAutomationExecutionError",
              message:
                "Files on the browser's owner cannot be named by a remote caller; files are sent as bytes.",
            },
          } satisfies ManagedBrowserPeerDispatchResponse,
          200,
          ownerHeaders,
        );
      }
      const forwarded: PreviewAutomationRequest = {
        ...uploads.request,
        threadId: peer.ownerThreadId as never,
        callerEnvironmentId: subject.callerEnvironmentId,
      };
      const outcome = yield* local.handle(forwarded).pipe(
        Effect.map((result): ManagedBrowserPeerDispatchResponse => ({
          ok: true,
          result: scrub(result),
        })),
        Effect.catch((error) => Effect.succeed(failure(error))),
        // A defect in the browser path is the owner's to read in its log; the caller is told it failed.
        Effect.catchCause((cause) =>
          Effect.logError("managed browser peer call failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(failure(undefined)),
          ),
        ),
        Effect.ensuring(Effect.sync(() => uploads.used.forEach(forgetTransfer))),
      );
      return jsonResponse(outcome, 200, ownerHeaders);
    });

  const upload = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const peer = yield* authenticatePeer(request);
      if (peer._tag === "refused") return peer.response;
      if (peer.grant.access !== "operate") {
        yield* Effect.logWarning("managed browser peer call refused", {
          reason: "upload needs an operate grant",
          grantId: peer.grant.id,
        });
        return refuse(403, "forbidden");
      }
      if (Number(request.headers["content-length"] ?? "0") > MAX_FILE_BYTES) {
        return refuse(413, "too large");
      }
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      if (bytes.byteLength > MAX_FILE_BYTES) return refuse(413, "too large");
      purgeExpired();
      const held = [...transfers.values()].filter((t) => t.grantId === peer.grant.id).length;
      if (held >= MAX_HANDLES_PER_GRANT) return refuse(413, "too many files waiting");
      const handle = NodeCrypto.randomBytes(16).toString("hex");
      const directory = Path.join(options.transfersRoot, peer.grant.id, handle);
      FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // The caller's name is only a label; the file on this disk is named by the handle.
      const label = Path.basename(
        decodeHeader(request.headers[MANAGED_BROWSER_PEER_NAME_HEADER]) ?? "upload",
      );
      const target = Path.join(directory, label.replace(/[^A-Za-z0-9._ -]/g, "_") || "upload");
      FS.writeFileSync(target, bytes, { mode: 0o600 });
      transfers.set(handle, {
        grantId: peer.grant.id,
        path: target,
        expiresAt: now() + HANDLE_TTL_MS,
      });
      return jsonResponse({ handle }, 200, ownerHeaders);
    });

  const download = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const peer = yield* authenticatePeer(request);
      if (peer._tag === "refused") return peer.response;
      const text = yield* readBodyText(request, 4096);
      const body = yield* Effect.try({
        try: () => (text === undefined ? undefined : JSON.parse(text)),
        catch: () => undefined,
      });
      if (
        !isRecord(body) ||
        typeof body.tabId !== "string" ||
        typeof body.downloadId !== "string" ||
        body.threadId !== peer.subject.threadId
      ) {
        return refuse(400, "invalid request");
      }
      const found = yield* local.openAgentDownload(
        {
          requestId: "download",
          threadId: peer.ownerThreadId as never,
          tabId: body.tabId,
          agentSessionId: peer.subject.agentSessionId,
          callerEnvironmentId: peer.subject.callerEnvironmentId,
          operation: "status",
          input: {},
          timeoutMs: 1000,
        } as PreviewAutomationRequest,
        body.downloadId,
      );
      if (Option.isNone(found)) return refuse(404, "not found");
      const bytes = yield* Effect.try({
        try: () => new Uint8Array(FS.readFileSync(found.value.path)),
        catch: () => undefined,
      });
      if (bytes === undefined || bytes.byteLength > MAX_FILE_BYTES) return refuse(404, "not found");
      return HttpServerResponse.uint8Array(bytes, {
        headers: {
          ...ownerHeaders,
          "content-type": "application/octet-stream",
          [DIGEST_HEADER]: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          [NAME_HEADER]: found.value.fileName,
          "cache-control": "no-store",
        },
      });
    });

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const pathname = url.value.pathname;
    if (request.method === "POST" && pathname === MANAGED_BROWSER_PEER_DISPATCH_PATH) {
      return yield* dispatch(request);
    }
    if (request.method === "POST" && pathname === MANAGED_BROWSER_PEER_UPLOAD_PATH) {
      return yield* upload(request);
    }
    if (request.method === "POST" && pathname === MANAGED_BROWSER_PEER_DOWNLOAD_PATH) {
      return yield* download(request);
    }
    if (pathname.startsWith(`${MANAGED_BROWSER_ROUTE_PREFIX}/peer/`)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* administer(request, pathname).pipe(
      Effect.catch((error: unknown) =>
        isStoreFailure(error)
          ? Effect.succeed(jsonResponse({ error: error.message }, 409))
          : HttpServerRespondable.isRespondable(error)
            ? HttpServerRespondable.toResponse(error)
            : Effect.die(error),
      ),
    );
  });
};

/**
 * Registers the routes. The owner's grants and the peer calls use the access service; the
 * enrollments belong to the server that calls out. Both halves are always present, and neither does
 * anything until an administrator creates a grant or an enrollment.
 */
export const routeLayerWith = (options: ManagedBrowserRoutesOptions) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const access = yield* ManagedBrowserAccess.ManagedBrowserAccessService;
      const local = yield* ManagedBrowserPreviewAdapter.ManagedBrowserLocalAdapter;
      const remote = yield* ManagedBrowserRemoteClient.ManagedBrowserRemoteClient;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const ownerEnvironmentId = yield* environment.getEnvironmentId;
      const handler = makeHandler(options, { access, local, remote, ownerEnvironmentId });
      for (const method of ["GET", "POST", "DELETE"] as const) {
        yield* router.add(method, `${MANAGED_BROWSER_ROUTE_PREFIX}/*`, handler);
      }
    }),
  );

/** The routes with their working directory beside the other managed browser state. */
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* EffectPath.Path;
    return routeLayerWith({
      transfersRoot: path.join(config.stateDir, "managed-browser", "peer-transfers"),
    });
  }),
);
