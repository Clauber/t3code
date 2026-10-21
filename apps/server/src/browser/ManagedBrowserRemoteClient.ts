// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off globalFetch:off preferSchemaOverJson:off
/**
 * ManagedBrowserRemoteClient - how an agent here uses a managed browser that another environment owns.
 *
 * The browser's profile never leaves its owner. A call for a browser owned elsewhere is sent, as the
 * preview request the agent made, to the owner named by an **enrollment**: an administrator-made record
 * of one fixed endpoint, the browser and profile, the thread and provider session it is for, and the
 * credential the owner issued for exactly that. The credential is held in the server's secret store and
 * is read only to make a call; it appears in no log, error or tool result.
 *
 * Nothing is derived from the call: the destination is the enrolled endpoint, never a URL the agent
 * supplies; a redirect is an error; the owner must answer as the environment that was enrolled; and when
 * the owner cannot be reached or refuses, the call fails by name. No browser is started here instead.
 *
 * Files cross as bytes. An upload's files are read here and sent to the owner, which hands the browser
 * its own copy; a download is fetched from the owner with a size and digest check and the agent is shown
 * the path of the copy here. A path on the owner is never shown as a path here, and a path here is never
 * interpreted on the owner. A `localhost` address a tool gives the owner is the owner's.
 *
 * @module ManagedBrowserRemoteClient
 */
import {
  type EnvironmentId,
  MANAGED_BROWSER_DOWNLOAD_HANDLE_PREFIX,
  MANAGED_BROWSER_PEER_DISPATCH_PATH,
  MANAGED_BROWSER_PEER_DOWNLOAD_PATH,
  MANAGED_BROWSER_PEER_NAME_HEADER,
  MANAGED_BROWSER_PEER_SESSION_HEADER,
  MANAGED_BROWSER_PEER_THREAD_HEADER,
  MANAGED_BROWSER_PEER_UPLOAD_PATH,
  MANAGED_BROWSER_UPLOAD_HANDLE_PREFIX,
  type ManagedBrowserEnrollment,
  type ManagedBrowserEnrollmentCreateInput,
  ManagedBrowserPeerDispatchResponse,
  ManagedBrowserPeerUploadResponse,
  type ManagedBrowserIncarnation,
  type ManagedBrowserTabId,
  type PreviewAutomationOpenInput,
  previewAutomationBrowserBinding,
  type PreviewAutomationRequest,
  type PreviewAutomationUploadInput,
  type PreviewManagedSession,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import { remoteThreadId } from "./ManagedBrowserAccess.ts";
import * as ManagedBrowserLocal from "./ManagedBrowserPreviewAdapter.ts";
import { makeRecordStore } from "./ManagedBrowserRecordStore.ts";

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

/**
 * The only form of destination an enrollment may hold: scheme, host and port. A path, credentials, a
 * query or a fragment would let a record point somewhere other than "that environment's server".
 * Returns the normalized origin, or undefined.
 */
export const normalizeEndpoint = (raw: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.pathname !== "/" || url.hostname === "") return undefined;
  return url.origin;
};

// ---------------------------------------------------------------------------
// Enrollment record
// ---------------------------------------------------------------------------

const ENROLLMENT_SCHEMA_VERSION = 1;
const MAX_ENROLLMENTS = 256;
const TAB_SCHEMA_VERSION = 1;
const MAX_REMOTE_TABS = 512;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const secretNameOf = (id: string) => `managed-browser-enrollment-${id}`;

/** An enrollment could not be saved, read or used. */
export class ManagedBrowserEnrollmentError extends Schema.TaggedError<ManagedBrowserEnrollmentError>()(
  "ManagedBrowserEnrollmentError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const isEnrollment = Schema.is(
  Schema.Struct({
    id: Schema.String,
    ownerEnvironmentId: Schema.String,
    endpoint: Schema.String,
    instanceId: Schema.String,
    profileId: Schema.String,
    threadId: Schema.String,
    agentSessionId: Schema.String,
    expiresAt: Schema.String,
  }),
);

const isRemoteTab = Schema.is(
  Schema.Struct({
    threadId: Schema.String,
    ownerTabId: Schema.String,
    enrollmentId: Schema.String,
    engineTabId: Schema.NullOr(Schema.String),
    incarnation: Schema.NullOr(Schema.String),
    native: Schema.optional(Schema.Boolean),
    shared: Schema.Boolean,
    url: Schema.NullOr(Schema.String),
    title: Schema.String,
    updatedAt: Schema.String,
  }),
);

/**
 * What this server remembers of a tab it uses on another environment's browser: enough to find the
 * same tab again after a restart. It is a pointer, not authority; the owner validates it on every use.
 */
export interface RemoteTab {
  readonly threadId: string;
  /** The tab's session id on the owner, which every call names. */
  readonly ownerTabId: string;
  readonly enrollmentId: string;
  /** The browser's id for the page; null for a tab only learned of in a list (a popup). */
  readonly engineTabId: string | null;
  readonly incarnation: string | null;
  readonly native?: boolean;
  readonly shared: boolean;
  readonly url: string | null;
  readonly title: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ManagedBrowserRemoteClient extends Context.Service<
  ManagedBrowserRemoteClient,
  {
    /** Whether this request is for a browser another environment owns, so it must not be served here. */
    readonly claims: (request: PreviewAutomationRequest) => boolean;
    /** Whether a preview session of this server stands for a tab on another environment's browser. */
    readonly owns: (threadId: string, tabId: string) => boolean;
    readonly handle: (
      request: PreviewAutomationRequest,
    ) => Effect.Effect<unknown, ServerBrowserPage.ServerBrowserOperationError>;
    /**
     * The session standing for a remote tab was closed here. The owner is told to let go of the tab:
     * it closes the page only if no other thread holds it.
     */
    readonly sessionClosed: (
      threadId: string,
      tabId: string,
    ) => Effect.Effect<ManagedBrowserLocal.ManagedCloseOutcome>;
    /** Stores the credential in the secret store and the record beside it. */
    readonly enroll: (
      input: ManagedBrowserEnrollmentCreateInput,
    ) => Effect.Effect<ManagedBrowserEnrollment, ManagedBrowserEnrollmentError>;
    readonly list: Effect.Effect<
      ReadonlyArray<ManagedBrowserEnrollment>,
      ManagedBrowserEnrollmentError
    >;
    /** Forgets the record and wipes the credential. Calls stop immediately. */
    readonly remove: (id: string) => Effect.Effect<boolean, ManagedBrowserEnrollmentError>;
  }
>()("t3/browser/ManagedBrowserRemoteClient") {}

export interface ManagedBrowserRemoteClientOptions {
  /** File holding the enrollments, beside the other managed browser state. Null keeps them in memory. */
  readonly path: string | null;
  /** File holding the remote tabs this server uses, so a restart reattaches them. Null keeps them in memory. */
  readonly tabsPath?: string | null;
  /** Where downloaded files are written on this environment. */
  readonly downloadsRoot: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_FILES = 20;
const DOWNLOAD_LIMIT = 20;
const MAX_CALL_MS = 125_000;
const OWNER_HEADER = "x-t3-managed-browser-owner";
const DIGEST_HEADER = "x-t3-managed-browser-sha256";

const operationError = (tag: string, message: string, detail?: unknown) =>
  new ServerBrowserPage.ServerBrowserOperationError(tag, message, detail);

const unavailable = (message: string) => operationError("PreviewAutomationExecutionError", message);
/** The preview error is a plain Error, so a failure is raised explicitly rather than yielded. */
const failUnavailable = (message: string) => Effect.fail(unavailable(message));

const keyOf = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const make = (options: ManagedBrowserRemoteClientOptions) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const manager = yield* PreviewManager.PreviewManager;
    const ownEnvironmentId = yield* environment.getEnvironmentId;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    const store = makeRecordStore<ManagedBrowserEnrollment>(options.path, {
      version: ENROLLMENT_SCHEMA_VERSION,
      field: "enrollments",
      label: "enrollment",
      max: MAX_ENROLLMENTS,
      keyOf: (enrollment) => enrollment.id,
      valid: (value): value is ManagedBrowserEnrollment => isEnrollment(value),
    });
    const tabStore = makeRecordStore<RemoteTab>(options.tabsPath ?? null, {
      version: TAB_SCHEMA_VERSION,
      field: "tabs",
      label: "remote tab",
      max: MAX_REMOTE_TABS,
      keyOf: (tab) => keyOf(tab.threadId, tab.ownerTabId),
      valid: (value): value is RemoteTab => isRemoteTab(value),
    });
    if (tabStore.status._tag !== "ready") {
      yield* Effect.logError(
        "managed browser remote tab record is unreadable; none are reattached",
        {
          detail: tabStore.status.detail,
        },
      );
    }
    if (store.status._tag !== "ready") {
      yield* Effect.logError(
        "managed browser enrollment record is unreadable; remote calls are refused",
        {
          detail: store.status.detail,
        },
      );
    }
    /**
     * Sessions published here for tabs that live on an owner, so this server's preview list knows them and
     * a client can find the owner's page. Memory only: a new run publishes them afresh.
     */
    const shadowOwnerTab = new Map<string, string>();
    const shadowOfOwnerTab = new Map<string, string>();
    /** Downloads already copied here, by owner-side name, so a status is not a second transfer. */
    const fetched = new Map<string, string>();

    const storeError = (cause: unknown) =>
      new ManagedBrowserEnrollmentError({
        detail: cause instanceof Error ? cause.message : "The enrollment could not be saved.",
      });

    const unreadable = () =>
      store.status._tag === "ready"
        ? undefined
        : new ManagedBrowserEnrollmentError({
            detail: `The managed browser enrollments could not be read (${store.status.detail}).`,
          });

    // --- administration -------------------------------------------------------

    const enroll: ManagedBrowserRemoteClient["Service"]["enroll"] = (input) =>
      Effect.gen(function* () {
        const failure = unreadable();
        if (failure !== undefined) return yield* failure;
        const endpoint = normalizeEndpoint(input.endpoint);
        if (endpoint === undefined) {
          return yield* new ManagedBrowserEnrollmentError({
            detail:
              "The endpoint must be the owner's address only: http(s)://host[:port], with no path, credentials, query or fragment.",
          });
        }
        if (!ID_PATTERN.test(input.id)) {
          return yield* new ManagedBrowserEnrollmentError({ detail: "The grant id is not valid." });
        }
        if (input.ownerEnvironmentId === ownEnvironmentId) {
          return yield* new ManagedBrowserEnrollmentError({
            detail: "This server is the owner; it needs no enrollment to use its own browser.",
          });
        }
        const { credential, ...record } = input;
        const enrollment: ManagedBrowserEnrollment = { ...record, endpoint };
        // The credential first: a record without one can only fail closed, one with nothing to find cannot.
        yield* secrets
          .set(secretNameOf(enrollment.id), new TextEncoder().encode(credential))
          .pipe(Effect.mapError(storeError));
        yield* Effect.try({ try: () => store.put(enrollment), catch: storeError }).pipe(
          Effect.tapError(() => secrets.remove(secretNameOf(enrollment.id)).pipe(Effect.ignore)),
        );
        // A new grant for the same browser, thread and provider session replaces the old one: the owner
        // honors only a live grant, so keeping a dead record beside it could only be picked by mistake.
        for (const earlier of store.all()) {
          if (
            earlier.id !== enrollment.id &&
            earlier.ownerEnvironmentId === enrollment.ownerEnvironmentId &&
            earlier.instanceId === enrollment.instanceId &&
            earlier.profileId === enrollment.profileId &&
            earlier.threadId === enrollment.threadId &&
            earlier.agentSessionId === enrollment.agentSessionId
          ) {
            yield* Effect.try({ try: () => store.remove(earlier.id), catch: storeError });
            yield* secrets.remove(secretNameOf(earlier.id)).pipe(Effect.ignore);
            for (const tab of tabStore.all()) {
              // The tab stays the owner's; it is the new grant that reaches it from here on.
              if (tab.enrollmentId === earlier.id) {
                yield* Effect.try({
                  try: () => tabStore.put({ ...tab, enrollmentId: enrollment.id }),
                  catch: storeError,
                });
              }
            }
          }
        }
        return enrollment;
      });

    const list: ManagedBrowserRemoteClient["Service"]["list"] = Effect.suspend(() => {
      const failure = unreadable();
      return failure !== undefined ? Effect.fail(failure) : Effect.succeed(store.all());
    });

    const remove: ManagedBrowserRemoteClient["Service"]["remove"] = (id) =>
      Effect.gen(function* () {
        const failure = unreadable();
        if (failure !== undefined) return yield* failure;
        const removed = yield* Effect.try({ try: () => store.remove(id), catch: storeError });
        yield* secrets.remove(secretNameOf(id)).pipe(Effect.mapError(storeError));
        for (const tab of tabStore.all()) {
          if (tab.enrollmentId === id) yield* forgetTab(tab);
        }
        return removed;
      });

    // --- routing --------------------------------------------------------------

    const openInputOf = (request: PreviewAutomationRequest) =>
      request.operation === "open"
        ? (request.input as PreviewAutomationOpenInput | undefined)
        : undefined;

    /** A request that names a session published here by its own id is meant for the owner's tab behind it. */
    const ownerTabOf = (request: PreviewAutomationRequest): string | undefined =>
      request.tabId === undefined
        ? undefined
        : (shadowOwnerTab.get(keyOf(request.threadId, request.tabId)) ?? request.tabId);

    const claims: ManagedBrowserRemoteClient["Service"]["claims"] = (request) => {
      const binding = previewAutomationBrowserBinding(request);
      if (binding !== undefined) return binding.ownerEnvironmentId !== ownEnvironmentId;
      const tabId = ownerTabOf(request);
      return tabId !== undefined && tabStore.get(keyOf(request.threadId, tabId)) !== undefined;
    };

    const owns: ManagedBrowserRemoteClient["Service"]["owns"] = (threadId, tabId) =>
      shadowOwnerTab.has(keyOf(threadId, tabId));

    const enrollmentFor = (request: PreviewAutomationRequest) => {
      const binding = previewAutomationBrowserBinding(request);
      if (binding === undefined) {
        const tabId = ownerTabOf(request);
        const known =
          tabId === undefined ? undefined : tabStore.get(keyOf(request.threadId, tabId));
        return known === undefined ? undefined : store.get(known.enrollmentId);
      }
      return store
        .all()
        .find(
          (candidate) =>
            candidate.ownerEnvironmentId === binding.ownerEnvironmentId &&
            candidate.instanceId === binding.instanceId &&
            candidate.profileId === binding.profileId &&
            candidate.threadId === request.threadId &&
            candidate.agentSessionId === request.agentSessionId,
        );
    };

    // --- transport ------------------------------------------------------------

    const credentialOf = (enrollment: ManagedBrowserEnrollment) =>
      secrets.get(secretNameOf(enrollment.id)).pipe(
        Effect.map((found) =>
          found._tag === "Some" ? new TextDecoder().decode(found.value) : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      );

    /** One call to the owner. Refusals and outages become named operation errors; the credential never leaves this scope. */
    const send = (
      enrollment: ManagedBrowserEnrollment,
      path: string,
      init: {
        readonly body: string | Uint8Array;
        readonly contentType: string;
        readonly name?: string;
        readonly timeoutMs: number;
      },
    ) =>
      Effect.gen(function* () {
        if (Date.parse(enrollment.expiresAt) <= now()) {
          return yield* failUnavailable(
            "This server's grant for that managed browser has expired. Ask the owner's administrator for a new one.",
          );
        }
        const credential = yield* credentialOf(enrollment);
        if (credential === undefined) {
          return yield* failUnavailable(
            "This server holds no credential for that managed browser. Enroll it again.",
          );
        }
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImpl(`${enrollment.endpoint}${path}`, {
              method: "POST",
              redirect: "error",
              headers: {
                authorization: `Bearer ${credential}`,
                "content-type": init.contentType,
                // A provider session id can hold characters a header cannot (the broker joins its parts with NUL).
                [MANAGED_BROWSER_PEER_THREAD_HEADER]: encodeURIComponent(enrollment.threadId),
                [MANAGED_BROWSER_PEER_SESSION_HEADER]: encodeURIComponent(
                  enrollment.agentSessionId,
                ),
                ...(init.name === undefined
                  ? {}
                  : { [MANAGED_BROWSER_PEER_NAME_HEADER]: encodeURIComponent(init.name) }),
              },
              body: typeof init.body === "string" ? init.body : Buffer.from(init.body),
              signal: AbortSignal.timeout(Math.min(init.timeoutMs, MAX_CALL_MS)),
            }),
          catch: () =>
            unavailable(
              `The environment that owns this managed browser could not be reached. No browser was started here in its place; try again when the owner is back.`,
            ),
        });
        if (response.headers.get(OWNER_HEADER) !== enrollment.ownerEnvironmentId) {
          // Drain nothing: the body is not read, so a wrong server learns nothing and sends nothing back.
          void response.body?.cancel().catch(() => undefined);
          return yield* failUnavailable(
            "That endpoint did not answer as the environment this grant was issued by, so the call was not trusted.",
          );
        }
        if (response.status === 401 || response.status === 403) {
          void response.body?.cancel().catch(() => undefined);
          return yield* failUnavailable(
            "The browser's owner refused this server's grant (revoked, expired, or not valid for this thread and browser). Ask the owner's administrator.",
          );
        }
        return response;
      });

    const readLimited = (response: Response, limit: number) =>
      Effect.tryPromise({
        try: async () => {
          const declared = Number(response.headers.get("content-length") ?? "0");
          if (declared > limit) throw new Error("too large");
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > limit) throw new Error("too large");
          return bytes;
        },
        catch: () =>
          unavailable(
            "The managed browser's owner sent an answer that was too large or incomplete.",
          ),
      });

    const decodeResponse = Schema.decodeUnknownEffect(ManagedBrowserPeerDispatchResponse);

    // --- bytes ----------------------------------------------------------------

    /** Sends one local file to the owner and returns the handle it will accept in place of a path. */
    const uploadFile = (
      enrollment: ManagedBrowserEnrollment,
      localPath: string,
      timeoutMs: number,
    ) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.tryPromise({
          try: async () => {
            const stat = await FS.promises.stat(localPath);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("not a usable file");
            return new Uint8Array(await FS.promises.readFile(localPath));
          },
          catch: () =>
            operationError(
              "PreviewAutomationExecutionError",
              `The file ${Path.basename(localPath)} could not be read here, or is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB.`,
            ),
        });
        const response = yield* send(enrollment, MANAGED_BROWSER_PEER_UPLOAD_PATH, {
          body: bytes,
          contentType: "application/octet-stream",
          name: Path.basename(localPath),
          timeoutMs,
        });
        if (!response.ok) {
          return yield* failUnavailable("The managed browser's owner did not accept the file.");
        }
        const body = yield* readLimited(response, 4096);
        const handle = yield* Schema.decodeUnknownEffect(ManagedBrowserPeerUploadResponse)(
          JSON.parse(new TextDecoder().decode(body)),
        ).pipe(
          Effect.mapError(() => unavailable("The owner's answer to an upload was not understood.")),
        );
        return `${MANAGED_BROWSER_UPLOAD_HANDLE_PREFIX}${handle.handle}`;
      });

    /** Copies a download from the owner after checking its size and digest; returns where it is now. */
    const fetchDownload = (
      enrollment: ManagedBrowserEnrollment,
      request: PreviewAutomationRequest,
      tabId: string,
      downloadId: string,
    ) =>
      Effect.gen(function* () {
        const cacheKey = `${enrollment.id}\u0000${tabId}\u0000${downloadId}`;
        const known = fetched.get(cacheKey);
        if (known !== undefined && FS.existsSync(known)) return known;
        const response = yield* send(enrollment, MANAGED_BROWSER_PEER_DOWNLOAD_PATH, {
          body: JSON.stringify({ threadId: request.threadId, tabId, downloadId }),
          contentType: "application/json",
          timeoutMs: 60_000,
        });
        if (!response.ok) return yield* failUnavailable("The owner did not provide that download.");
        const bytes = yield* readLimited(response, MAX_FILE_BYTES);
        const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        if (response.headers.get(DIGEST_HEADER) !== digest) {
          return yield* failUnavailable("A download did not match its digest and was discarded.");
        }
        const name = Path.basename(response.headers.get("x-t3-managed-browser-name") ?? downloadId);
        const directory = Path.join(
          options.downloadsRoot,
          enrollment.id,
          NodeCrypto.createHash("sha256").update(tabId).digest("hex").slice(0, 16),
        );
        const target = Path.join(directory, `${downloadId.replace(/[^A-Za-z0-9-]/g, "_")}-${name}`);
        yield* Effect.try({
          try: () => {
            FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
            FS.writeFileSync(target, bytes, { mode: 0o600 });
          },
          catch: () => unavailable("A download could not be saved here."),
        });
        fetched.set(cacheKey, target);
        // Bound what accumulates: the oldest copies go first.
        for (const [oldKey, oldPath] of [...fetched].slice(
          0,
          Math.max(0, fetched.size - DOWNLOAD_LIMIT),
        )) {
          fetched.delete(oldKey);
          FS.rmSync(oldPath, { force: true });
        }
        return target;
      });

    /** An owner path in a result is replaced by the path of a copy here, or the entry is dropped. */
    const localizeDownloads = (
      enrollment: ManagedBrowserEnrollment,
      request: PreviewAutomationRequest,
      result: unknown,
    ) =>
      Effect.gen(function* () {
        if (!isRecord(result) || !Array.isArray(result.downloads)) return result;
        const kept: Array<unknown> = [];
        for (const entry of result.downloads) {
          if (!isRecord(entry) || typeof entry.path !== "string") continue;
          if (!entry.path.startsWith(MANAGED_BROWSER_DOWNLOAD_HANDLE_PREFIX)) continue;
          const [tabId, downloadId] = entry.path
            .slice(MANAGED_BROWSER_DOWNLOAD_HANDLE_PREFIX.length)
            .split("/");
          if (tabId === undefined || downloadId === undefined) continue;
          const local = yield* fetchDownload(enrollment, request, tabId, downloadId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("managed browser download could not be copied", {
                reason: error.message,
              }).pipe(Effect.as(undefined)),
            ),
          );
          if (local !== undefined) kept.push({ ...entry, path: local });
        }
        return { ...result, downloads: kept };
      });

    /** Replaces each caller-local upload path with bytes the owner holds, so no path crosses as a path. */
    const withUploads = (enrollment: ManagedBrowserEnrollment, request: PreviewAutomationRequest) =>
      Effect.gen(function* () {
        if (request.operation !== "upload") return request;
        const input = request.input as PreviewAutomationUploadInput;
        if (input.paths.length > MAX_UPLOAD_FILES) return request;
        const handles: Array<string> = [];
        for (const localPath of input.paths) {
          handles.push(yield* uploadFile(enrollment, localPath, request.timeoutMs));
        }
        return { ...request, input: { ...input, paths: handles } };
      });

    // --- remote tabs ------------------------------------------------------------

    /** Forgets a remote tab and the session published for it. A record that cannot be removed is logged, not fatal. */
    const forgetTab = (tab: RemoteTab) =>
      Effect.gen(function* () {
        const key = keyOf(tab.threadId, tab.ownerTabId);
        yield* Effect.try({ try: () => tabStore.remove(key), catch: storeError }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("managed browser remote tab record could not be removed", {
              detail: error.detail,
            }),
          ),
        );
        const shadow = shadowOfOwnerTab.get(key);
        if (shadow === undefined) return;
        shadowOfOwnerTab.delete(key);
        shadowOwnerTab.delete(keyOf(tab.threadId, shadow));
        yield* manager
          .close({ threadId: tab.threadId as never, tabId: shadow as never })
          .pipe(Effect.ignore);
      });

    /** Where the page really lives, in the terms a client needs to watch it on the owner. */
    const managedOf = (
      tab: RemoteTab,
      enrollment: ManagedBrowserEnrollment,
    ): PreviewManagedSession | undefined =>
      tab.engineTabId === null || tab.incarnation === null
        ? undefined
        : {
            ownerEnvironmentId: enrollment.ownerEnvironmentId,
            instanceId: enrollment.instanceId,
            profileId: enrollment.profileId,
            incarnation: tab.incarnation as ManagedBrowserIncarnation,
            engineTabId: tab.engineTabId as ManagedBrowserTabId,
            hostThreadId: remoteThreadId(ownEnvironmentId, tab.threadId),
            hostTabId: tab.ownerTabId,
            shared: tab.shared,
            remote: true,
            ...(tab.native === true ? { native: true } : {}),
          };

    /**
     * Makes this server's preview list know the tab: a session whose snapshot says which environment holds
     * the page and under which ids. It carries no page and no stream; a client opens its own connection to
     * the owner. It is registered as remote before it is announced, so the ordinary browser never builds a
     * page for it.
     */
    const publishShadow = (tab: RemoteTab) =>
      Effect.gen(function* () {
        const enrollment = store.get(tab.enrollmentId);
        const managed = enrollment === undefined ? undefined : managedOf(tab, enrollment);
        if (enrollment === undefined || managed === undefined) return;
        const key = keyOf(tab.threadId, tab.ownerTabId);
        const navStatus =
          tab.url === null
            ? ({ _tag: "Idle" } as const)
            : ({ _tag: "Success", url: tab.url, title: tab.title.slice(0, 512) } as const);
        const report = (tabId: string) =>
          manager
            .reportStatus({
              threadId: tab.threadId as never,
              tabId: tabId as never,
              navStatus: navStatus as never,
              canGoBack: false,
              canGoForward: false,
              serverControlled: true,
              managed,
            })
            .pipe(Effect.ignore);
        const known = shadowOfOwnerTab.get(key);
        if (known !== undefined) return yield* report(known);
        const opened = yield* manager
          .open({
            threadId: tab.threadId as never,
            runtime: "server",
            reveal: false,
            automationOwner: enrollment.agentSessionId,
            managed,
            beforePublish: (snapshot) => {
              shadowOwnerTab.set(keyOf(tab.threadId, snapshot.tabId), tab.ownerTabId);
              shadowOfOwnerTab.set(key, snapshot.tabId);
            },
          })
          .pipe(Effect.option);
        if (Option.isSome(opened)) yield* report(opened.value.tabId);
      });

    const nowIso = () => new Date(now()).toISOString();

    /** What the owner's answer says about the tabs this thread holds: remembered, and shown in the preview list. */
    const learn = (enrollment: ManagedBrowserEnrollment, threadId: string, result: unknown) =>
      Effect.gen(function* () {
        if (!isRecord(result)) return;
        const keep = (tab: RemoteTab) =>
          Effect.try({ try: () => tabStore.put(tab), catch: storeError }).pipe(
            Effect.as(tab),
            Effect.catch((error) =>
              Effect.logWarning("managed browser remote tab could not be recorded", {
                detail: error.detail,
              }).pipe(Effect.as(tab)),
            ),
          );
        const text = (value: unknown) => (typeof value === "string" ? value : undefined);
        if (typeof result.tabId === "string") {
          const previous = tabStore.get(keyOf(threadId, result.tabId));
          const managed = isRecord(result.managed) ? result.managed : undefined;
          const tab = yield* keep({
            threadId,
            ownerTabId: result.tabId,
            enrollmentId: enrollment.id,
            engineTabId: text(managed?.engineTabId) ?? previous?.engineTabId ?? null,
            incarnation: text(managed?.incarnation) ?? previous?.incarnation ?? null,
            native: managed?.native === true,
            shared: managed?.shared === true,
            url: text(result.url) ?? (result.url === null ? null : (previous?.url ?? null)),
            title: text(result.title) ?? previous?.title ?? "",
            updatedAt: nowIso(),
          });
          yield* publishShadow(tab);
        }
        // Tabs only named in a list (a popup) are routable but not described: there is no page id to show.
        for (const entry of Array.isArray(result.tabs) ? result.tabs : []) {
          const ownerTabId = isRecord(entry) ? text(entry.tabId) : undefined;
          if (ownerTabId === undefined || tabStore.get(keyOf(threadId, ownerTabId)) !== undefined) {
            continue;
          }
          yield* keep({
            threadId,
            ownerTabId,
            enrollmentId: enrollment.id,
            engineTabId: null,
            incarnation: null,
            shared: false,
            url: null,
            title: "",
            updatedAt: nowIso(),
          });
        }
      });

    /**
     * A thread that opens again without saying which tab is asking for the tab it already holds on this
     * browser, so a restart of this server never ends in a second tab beside the first. The owner checks
     * the pointer: it reattaches the same page, or answers that the page or its boot is gone.
     */
    const withRejoin = (
      enrollment: ManagedBrowserEnrollment,
      request: PreviewAutomationRequest,
    ) => {
      const input = openInputOf(request);
      if (
        input === undefined ||
        input.joinTab !== undefined ||
        input.reuseExistingTab === false ||
        request.tabId !== undefined
      ) {
        return { request, rejoin: undefined };
      }
      const current = tabStore
        .all()
        .filter(
          (tab) =>
            tab.threadId === request.threadId &&
            tab.enrollmentId === enrollment.id &&
            tab.engineTabId !== null,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (current === undefined || current.engineTabId === null)
        return { request, rejoin: undefined };
      const joinTab = {
        engineTabId: current.engineTabId,
        ...(current.incarnation === null ? {} : { incarnation: current.incarnation }),
      };
      return { request: { ...request, input: { ...input, joinTab } }, rejoin: current };
    };

    const handle: ManagedBrowserRemoteClient["Service"]["handle"] = (called) =>
      Effect.gen(function* () {
        const failure = unreadable();
        if (failure !== undefined) return yield* failUnavailable(failure.message);
        // A session published here stands for a tab on the owner; the owner knows it by its own id.
        const named = ownerTabOf(called);
        const request =
          named === undefined || named === called.tabId
            ? called
            : { ...called, tabId: named as never };
        const enrollment = enrollmentFor(request);
        if (enrollment === undefined) {
          return yield* failUnavailable(
            "This server has no enrollment for that managed browser, thread and provider session, and a browser owned by another environment is never started here instead. Ask the owner's administrator for a grant.",
          );
        }
        const rejoining = withRejoin(enrollment, request);
        const outgoing = yield* withUploads(enrollment, rejoining.request);
        // The call carries who is calling; the owner trusts only what its own record says about the credential.
        const response = yield* send(enrollment, MANAGED_BROWSER_PEER_DISPATCH_PATH, {
          body: JSON.stringify({ request: outgoing }),
          contentType: "application/json",
          timeoutMs: request.timeoutMs + 5_000,
        });
        const body = yield* readLimited(response, MAX_RESPONSE_BYTES);
        const decoded = yield* Effect.try({
          try: () => JSON.parse(new TextDecoder().decode(body)) as unknown,
          catch: () => unavailable("The owner's answer was not understood."),
        }).pipe(
          Effect.flatMap(decodeResponse),
          Effect.mapError((cause) =>
            cause instanceof ServerBrowserPage.ServerBrowserOperationError
              ? cause
              : unavailable("The owner's answer was not understood."),
          ),
        );
        if (!decoded.ok) {
          // The tab this thread held is gone from the owner: the pointer is dead, and says so.
          if (
            rejoining.rejoin !== undefined &&
            decoded.error.tag === "PreviewAutomationTabNotFoundError"
          ) {
            yield* forgetTab(rejoining.rejoin);
          }
          return yield* Effect.fail(
            operationError(decoded.error.tag, decoded.error.message, decoded.error.detail),
          );
        }
        const localized = yield* localizeDownloads(enrollment, request, decoded.result);
        if (request.operation === "close") {
          const held =
            request.tabId === undefined
              ? undefined
              : tabStore.get(keyOf(request.threadId, request.tabId));
          if (held !== undefined) yield* forgetTab(held);
        } else {
          yield* learn(enrollment, request.threadId, localized);
        }
        return localized;
      });

    const sessionClosed: ManagedBrowserRemoteClient["Service"]["sessionClosed"] = (
      threadId,
      tabId,
    ) =>
      Effect.gen(function* () {
        const ownerTabId = shadowOwnerTab.get(keyOf(threadId, tabId));
        if (ownerTabId === undefined) return { _tag: "notManaged" as const };
        const key = keyOf(threadId, ownerTabId);
        // The session is already gone; what remains is telling the owner this thread lets go.
        shadowOwnerTab.delete(keyOf(threadId, tabId));
        shadowOfOwnerTab.delete(key);
        const held = tabStore.get(key);
        const enrollment = held === undefined ? undefined : store.get(held.enrollmentId);
        if (held === undefined || enrollment === undefined) {
          if (held !== undefined) yield* forgetTab(held);
          return { _tag: "closed" as const };
        }
        const exit = yield* handle({
          requestId: `release-${ownerTabId}`,
          threadId: threadId as never,
          tabId: ownerTabId as never,
          agentSessionId: enrollment.agentSessionId,
          callerEnvironmentId: ownEnvironmentId,
          operation: "close",
          input: {},
          timeoutMs: 20_000,
        }).pipe(Effect.exit);
        return exit._tag === "Success"
          ? { _tag: "closed" as const }
          : { _tag: "deferred" as const, reason: "The owner could not be told; the tab is kept." };
      });

    // Sessions for what was held before this run, so the preview list shows them without waiting for a call.
    if (tabStore.status._tag === "ready") {
      yield* Effect.forEach(tabStore.all(), publishShadow, { discard: true });
    }

    return ManagedBrowserRemoteClient.of({
      claims,
      owns,
      handle,
      sessionClosed,
      enroll,
      list,
      remove,
    });
  });

export const layer = (options: ManagedBrowserRemoteClientOptions) =>
  Layer.effect(ManagedBrowserRemoteClient, make(options));

// ---------------------------------------------------------------------------
// One adapter for the preview browser
// ---------------------------------------------------------------------------

/**
 * What the preview browser sees: one adapter. A named browser this server hosts goes to the local
 * adapter; one another environment owns goes to its owner; anything else about a remote tab goes where
 * the tab is. Viewers and files of tabs hosted here are served here, so a person watches a remote
 * agent's tab by connecting to its owner, which is the environment that holds the page.
 */
export const routedLayer = Layer.effect(
  ManagedBrowserLocal.ManagedBrowserPreviewAdapter,
  Effect.gen(function* () {
    const local = yield* ManagedBrowserLocal.ManagedBrowserLocalAdapter;
    const remote = yield* ManagedBrowserRemoteClient;
    const serving: ManagedBrowserLocal.ManagedBrowserPreviewAdapter["Service"] = {
      ...local,
      owns: (threadId, tabId) => remote.owns(threadId, tabId) || local.owns(threadId, tabId),
      claims: (request) => remote.claims(request) || local.claims(request),
      handle: (request) =>
        remote.claims(request) ? remote.handle(request) : local.handle(request),
      sessionClosed: (threadId, tabId) =>
        remote.owns(threadId, tabId)
          ? remote.sessionClosed(threadId, tabId)
          : local.sessionClosed(threadId, tabId),
    };
    return ManagedBrowserLocal.ManagedBrowserPreviewAdapter.of(serving);
  }),
);

export type { EnvironmentId };
