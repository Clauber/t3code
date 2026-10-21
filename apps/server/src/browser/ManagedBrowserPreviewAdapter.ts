// @effect-diagnostics nodeBuiltinImport:off
/**
 * ManagedBrowserPreviewAdapter - serves named preview sessions from a managed browser.
 *
 * A `preview_open` that carries a `browserBinding` is not an isolated temporary tab: it is a tab in a
 * persistent profile owned by the managed browser supervisor, drivable by agents and viewable by
 * people at once. This adapter maps the preview operations and the viewer stream onto the engine
 * protocol and keeps the identities straight: the caller's environment, thread and agent session
 * travel with every call, and the owner environment names only the resource.
 *
 * The ordinary preview browser is untouched. It never sees a managed tab: `owns` tells it which tabs
 * are not its own, so it builds no page for them, never idles them out, and never offers them to an
 * attached desktop. Disconnecting a viewer closes nothing.
 *
 * Authority comes from the {@link ManagedBrowserAccessPolicy}. Until cross-environment grants exist
 * the only policy is "the owner environment's own agents"; a call from any other environment is
 * refused rather than served.
 *
 * The engine acts on snapshot refs only. This adapter resolves what it safely can onto a ref, always
 * against a fresh snapshot of the document the action will run in: `role=` and `text=` locators (one
 * match among the page's interactive elements, or an error saying zero or how many), and "the focused
 * element" for press and untargeted typing. What no ref can express (CSS selectors, coordinates,
 * containers), scrolling, waiting, drag, resizing, color scheme and recording are explicit unsupported
 * errors, never approximations.
 *
 * Tabs are durable. Their instance, profile and engine tab ids are recorded in T3's state directory
 * ({@link ManagedBrowserRegistry}), so a restarted T3 reattaches the thread's tabs by those same ids
 * without navigating them. A popup a page opens becomes a session of its own, and a download becomes
 * a file the existing download route serves, after its bytes have crossed from the engine.
 *
 * @module ManagedBrowserPreviewAdapter
 */
import {
  EnvironmentId,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserPrincipalId,
  ManagedBrowserProfileId,
  ManagedBrowserTabId,
  previewAutomationBrowserBinding,
  type ManagedBrowserAccess as ManagedBrowserGrantAccess,
  type ManagedBrowserControlState,
  type ManagedBrowserPrincipal,
  type ManagedBrowserRef,
  type PreviewAutomationBrowserBinding,
  type PreviewAutomationClickInput,
  type PreviewAutomationDialogInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSharedTabs,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewManagedSession,
  type PreviewSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import type { ServerBrowserViewer } from "../preview/ServerBrowser.ts";
import * as ManagedBrowserAccess from "./ManagedBrowserAccess.ts";
import { ManagedBrowserAccessNotGrantedError, accessForOperation } from "./ManagedBrowserAccess.ts";
import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";
import * as ManagedBrowserRegistry from "./ManagedBrowserRegistry.ts";
import * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";
import { locatorMatches, parseLocator, type ParsedLocator } from "./ManagedBrowserLocator.ts";
import {
  failOperation,
  failUnsupported,
  operationError,
  tagOf,
  toOperationError,
} from "./ManagedBrowserOperationError.ts";
import {
  ENGINE_STATE_DEADLINE_MS,
  isEngineEvent,
  type EngineTabResult,
  type ManagedDownload,
  type ManagedTab,
} from "./ManagedBrowserTab.ts";
import * as ManagedBrowserViewer from "./ManagedBrowserViewer.ts";
import {
  ManagedBrowserViewerError,
  type ManagedBrowserViewerAuthority,
  type ManagedBrowserViewerIdentity,
  type ManagedBrowserViewerInput,
} from "./ManagedBrowserViewer.ts";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export { ManagedBrowserAccessNotGrantedError, accessForOperation } from "./ManagedBrowserAccess.ts";

export interface ManagedBrowserAccessRequest {
  /** The environment the calling agent runs in, from authenticated scope. */
  readonly callerEnvironmentId: EnvironmentId;
  /** The thread as this browser's owner keeps it. */
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly binding: PreviewAutomationBrowserBinding;
  /** `read` for calls that only look; `operate` for anything that acts on the browser. */
  readonly access: ManagedBrowserGrantAccess;
}

export interface ManagedBrowserViewerAccessRequest {
  /** Absent when the caller did not say who is watching, which is never enough. */
  readonly viewer: ManagedBrowserViewerIdentity | undefined;
  readonly binding: PreviewAutomationBrowserBinding;
  readonly access: ManagedBrowserGrantAccess;
}

/**
 * Decides whether a caller may drive a named browser, and who may watch one. The owner validates
 * every call and every viewer input; a session id alone conveys no authority.
 */
export interface ManagedBrowserAccessPolicy {
  readonly authorize: (
    request: ManagedBrowserAccessRequest,
  ) => Effect.Effect<void, ManagedBrowserAccessNotGrantedError>;
  /** Absent: only administrator sessions may watch. */
  readonly authorizeViewer?: (
    request: ManagedBrowserViewerAccessRequest,
  ) => Effect.Effect<ManagedBrowserViewerAuthority, ManagedBrowserAccessNotGrantedError>;
}

const administratorsOnly = (
  request: ManagedBrowserViewerAccessRequest,
): Effect.Effect<ManagedBrowserViewerAuthority, ManagedBrowserAccessNotGrantedError> =>
  request.viewer?.administrator === true
    ? Effect.succeed({ ended: Effect.never })
    : Effect.fail(
        new ManagedBrowserAccessNotGrantedError({
          reason:
            "Only an administrator session, or a session holding a grant, may watch this browser.",
        }),
      );

/**
 * Only agents running in the owner environment itself, and only for browsers that environment owns.
 * Another environment's call is refused, not served. Used alone, nothing remote is reachable.
 */
export const localOwnerPolicy = (
  ownerEnvironmentId: EnvironmentId,
): ManagedBrowserAccessPolicy => ({
  authorize: ({ callerEnvironmentId, binding }) =>
    binding.ownerEnvironmentId !== ownerEnvironmentId
      ? Effect.fail(
          new ManagedBrowserAccessNotGrantedError({
            reason: "This server does not own that managed browser.",
          }),
        )
      : callerEnvironmentId !== ownerEnvironmentId
        ? Effect.fail(
            new ManagedBrowserAccessNotGrantedError({
              reason: "Only agents in the browser's owner environment may use it without a grant.",
            }),
          )
        : Effect.void,
  authorizeViewer: administratorsOnly,
});

/**
 * The owner's own agents as before; any other environment only with a live grant that names its
 * environment, thread and provider session, the browser, and the kind of access. Viewers: an
 * administrator session, or one holding a viewer grant; a grant that is revoked or expires ends the
 * stream it admitted.
 */
export const grantPolicy = (
  ownerEnvironmentId: EnvironmentId,
  access: ManagedBrowserAccess.ManagedBrowserAccessService["Service"],
): ManagedBrowserAccessPolicy => {
  const local = localOwnerPolicy(ownerEnvironmentId);
  return {
    authorize: (request) =>
      request.binding.ownerEnvironmentId !== ownerEnvironmentId ||
      request.callerEnvironmentId === ownerEnvironmentId
        ? local.authorize(request)
        : access
            .authorizeAgent({
              callerEnvironmentId: request.callerEnvironmentId,
              threadId: request.threadId,
              agentSessionId: request.agentSessionId,
              resource: {
                instanceId: request.binding.instanceId,
                profileId: request.binding.profileId,
              },
              access: request.access,
            })
            .pipe(Effect.asVoid),
    authorizeViewer: (request) => {
      if (request.binding.ownerEnvironmentId !== ownerEnvironmentId) {
        return administratorsOnly({ ...request, viewer: undefined });
      }
      if (request.viewer?.administrator === true) return administratorsOnly(request);
      const viewer = request.viewer;
      if (viewer === undefined) return administratorsOnly(request);
      return access
        .authorizeViewer({
          viewerSessionId: viewer.sessionId,
          resource: {
            instanceId: request.binding.instanceId,
            profileId: request.binding.profileId,
          },
          access: request.access,
        })
        .pipe(Effect.map((grant) => ({ ended: access.untilEnded(grant.id) })));
    },
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** What became of a tab whose session was closed. `deferred` means it is still open and will be closed. */
export type ManagedCloseOutcome =
  | { readonly _tag: "notManaged" }
  | { readonly _tag: "closed" }
  | { readonly _tag: "deferred"; readonly reason: string };

/** One engine tab, as the screens that list shared-browser tabs see it. Holds no authority. */
export interface ManagedBrowserDirectoryTab {
  readonly binding: PreviewAutomationBrowserBinding;
  readonly engineTabId: string;
  readonly incarnation: string;
  /** The preview session that holds the tab longest: where a viewer asks for its stream. */
  readonly hostThreadId: string;
  readonly hostTabId: string;
  readonly title: string;
  readonly url: string | null;
  readonly shared: boolean;
  readonly participants: number;
  readonly phase: ManagedBrowserControlState["phase"] | "unavailable";
  /** Who holds the lease while a person does or is held for; null otherwise. Opaque to everything but {@link nativeControlPrincipal}. */
  readonly holder: string | null;
}

export interface ManagedBrowserDirectory {
  /** Every instance bound to a profile on this server, whether or not it is running. */
  readonly instances: ReadonlyArray<{ readonly instanceId: string; readonly profileId: string }>;
  readonly tabs: ReadonlyArray<ManagedBrowserDirectoryTab>;
}

export class ManagedBrowserPreviewAdapter extends Context.Service<
  ManagedBrowserPreviewAdapter,
  {
    /** False when no managed browser component is configured; a named open then fails explicitly. */
    readonly enabled: boolean;
    /** The ordinary preview browser must not touch a tab this returns true for. */
    readonly owns: (threadId: string, tabId: string) => boolean;
    /** Whether a request belongs here: a named open, or an operation on a managed tab. */
    readonly claims: (request: PreviewAutomationRequest) => boolean;
    readonly handle: (
      request: PreviewAutomationRequest,
      /** Server-only context from authenticated Controls.openTab; never read from the request. */
      humanOpen?: { readonly sessionId: string },
    ) => Effect.Effect<unknown, ServerBrowserPage.ServerBrowserOperationError>;
    readonly attachViewer: (
      input: ManagedBrowserViewerInput,
    ) => Effect.Effect<ServerBrowserViewer, ManagedBrowserViewerError, Scope.Scope>;
    /**
     * A session was closed by someone else (a person in the UI, or the thread going away). The browser's
     * tab is closed under an explicit, fenced takeover, and a close that cannot happen yet is retried
     * until it does, so the tab is never left open with no session.
     */
    readonly sessionClosed: (threadId: string, tabId: string) => Effect.Effect<ManagedCloseOutcome>;
    /**
     * A finished download of a managed tab, for the authenticated download route. Offered only to a
     * viewer the policy admits to that tab; anyone else gets the answer a missing file gets.
     */
    readonly openDownload: (
      threadId: string,
      tabId: string,
      downloadId: string,
      viewer: ManagedBrowserViewerIdentity | undefined,
    ) => Effect.Effect<Option.Option<{ readonly path: string; readonly fileName: string }>>;
    /**
     * The same file for the agent that owns the tab, read with its own grant: how the bytes of a
     * download reach an agent in another environment.
     */
    readonly openAgentDownload: (
      request: PreviewAutomationRequest,
      downloadId: string,
    ) => Effect.Effect<Option.Option<{ readonly path: string; readonly fileName: string }>>;
    /**
     * What is open now, for the screens that list shared-browser tabs. It applies no authorization: the
     * service that answers a person filters it by what that person may see.
     */
    readonly directory: Effect.Effect<ManagedBrowserDirectory>;
    /**
     * Brings back, without navigating them, the tabs people opened in this profile before the owner
     * restarted, so the directory lists them again. A profile with none starts nothing.
     */
    readonly restore: (instance: {
      readonly instanceId: string;
      readonly profileId: string;
    }) => Effect.Effect<void, ServerBrowserPage.ServerBrowserOperationError>;
    /**
     * A person takes or releases the browser's control with no stream open: the same lease a viewer's Take
     * and Release use, held by a principal of that session alone. False when no such tab. Taking stops
     * agents changing the page; it cannot stop the person's own input in the browser's own window.
     */
    readonly setControl: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly sessionId: string;
      readonly action: "take" | "release";
    }) => Effect.Effect<boolean, ServerBrowserPage.ServerBrowserOperationError>;
    /** Turns joining by other chats on or off for a page, for every chat holding it. False when no such tab. */
    readonly setSharing: (
      threadId: string,
      tabId: string,
      shared: boolean,
    ) => Effect.Effect<boolean, ServerBrowserPage.ServerBrowserOperationError>;
  }
>()("t3/browser/ManagedBrowserPreviewAdapter") {}

/**
 * The adapter for browsers this server hosts. It is what the owner's peer routes call: a call that
 * arrives from another environment is served here and never passed on to a third.
 */
export class ManagedBrowserLocalAdapter extends Context.Service<
  ManagedBrowserLocalAdapter,
  ManagedBrowserPreviewAdapter["Service"]
>()("t3/browser/ManagedBrowserPreviewAdapter/ManagedBrowserLocalAdapter") {}

/** A save or removal in the durable record failed. */
class ManagedBrowserRegistryError extends Schema.TaggedError<ManagedBrowserRegistryError>()(
  "ManagedBrowserRegistryError",
  { detail: Schema.String },
) {}

const registryError = (cause: unknown) =>
  new ManagedBrowserRegistryError({ detail: cause instanceof Error ? cause.message : "unknown" });

// ---------------------------------------------------------------------------
// Tab registry
// ---------------------------------------------------------------------------

const tabKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

/** The engine keys artifacts and subscriptions by caller, so the same string must be sent every time. */
const engineSessionId = (agentSessionId: string) => agentSessionId.replaceAll("\u0000", ":");

const agentPrincipal = (agentSessionId: string): ManagedBrowserPrincipal => ({
  id: ManagedBrowserPrincipalId.make(`agent:${engineSessionId(agentSessionId)}`.slice(0, 512)),
  kind: "agent",
  access: "operate",
});

/**
 * A person's session as the holder of the lease without a stream. Stable for the session, so Take and
 * Release from separate calls are the same holder, and distinct from any viewer's, which holds it only
 * while connected.
 */
export const nativeControlPrincipal = (sessionId: string): ManagedBrowserPrincipal => ({
  id: ManagedBrowserPrincipalId.make(`human:native-${sessionId}`.slice(0, 512)),
  kind: "human",
  access: "operate",
});

/** The adapter's own read-only identity, for watching the browser's events. */
const watcher: ManagedBrowserPrincipal = {
  id: ManagedBrowserPrincipalId.make("adapter:events"),
  kind: "human",
  access: "read",
};

const MAX_CALL_MS = 60_000;
const ARTIFACT_CHUNK = 256 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const TIMELINE_LIMIT = 50;
const AGENT_TAB_LIMIT = 8;
const SERVER_TAB_LIMIT = 32;
/** An agent session id that names a person's session; tabs they opened carry it. */
export const HUMAN_SESSION_PREFIX = "human:";
const UPLOAD_MAX_FILES = 20;

const phaseOf = (state: ManagedBrowserControlState) => state.phase;

export interface ManagedBrowserPreviewAdapterOptions {
  readonly desktop?: import("../preview/DesktopBrowserChannel.ts").DesktopBrowserChannel["Service"];
  readonly policy?: ManagedBrowserAccessPolicy;
  /**
   * The durable record of instances, profiles and tabs. Without one the adapter remembers nothing
   * across a restart, which only tests want.
   */
  readonly registry?: ManagedBrowserRegistry.ManagedBrowserRegistry;
  /** Where downloaded files are written. Without it downloads are refused, loudly. */
  readonly downloadsRoot?: string;
  /**
   * What this server offers for the whole Chrome window, and why not when it is off. The child's own
   * advertisement still decides whether a viewer may switch to it.
   */
  readonly fullWindow?: { readonly available: boolean; readonly reason?: string | undefined };
}

/** How many times, and how far apart, a close that could not happen yet is tried again. */
const CLOSE_RETRY_ATTEMPTS = 6;
const CLOSE_RETRY_BASE = Duration.seconds(1);
const DOWNLOAD_LIMIT = 20;
const DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

export const make = (options: ManagedBrowserPreviewAdapterOptions) =>
  Effect.gen(function* () {
    const supervisor = yield* ManagedBrowserSupervisor.ManagedBrowserSupervisor;
    const manager = yield* PreviewManager.PreviewManager;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const layerScope = yield* Effect.scope;
    const ownerEnvironmentId = yield* environment.getEnvironmentId;
    const policy = options.policy ?? localOwnerPolicy(ownerEnvironmentId);
    const registry = options.registry ?? ManagedBrowserRegistry.make(null);

    const tabs = new Map<string, ManagedTab>();
    /** Open viewer connections by viewer identity, so one dropping while another remains starts no hold. */
    const connections = new Map<string, number>();
    /**
     * The same tabs by the engine's id, which is how the browser's events name them. One engine tab has
     * one participant per thread that holds it: a tab nobody shared has exactly one.
     */
    const byEngine = new Map<string, Set<ManagedTab>>();
    /** Tabs an open has reserved before its session publishes, so the ordinary browser skips them. */
    const reserved = new Set<string>();
    /** Instance → the incarnation whose events are being followed. */
    const followed = new Map<string, string>();
    /** Engine tabs whose close has been requested and is being retried, so one close runs at a time. */
    const closing = new Set<string>();

    const owns = (threadId: string, tabId: string) =>
      tabs.has(tabKey(threadId, tabId)) || reserved.has(tabKey(threadId, tabId));

    const engineKey = (instanceId: string, engineTabId: string) =>
      `${instanceId}\u0000${engineTabId}`;
    const participantsOf = (instanceId: string, engineTabId: string): ReadonlyArray<ManagedTab> => [
      ...(byEngine.get(engineKey(instanceId, engineTabId)) ?? []),
    ];
    /** The participant that has held the tab longest: the one a popup and a download are attributed to. */
    const engineTabOf = (instanceId: string, engineTabId: string) =>
      participantsOf(instanceId, engineTabId)[0];
    const remember = (tab: ManagedTab) => {
      tabs.set(tabKey(tab.threadId, tab.tabId), tab);
      const key = engineKey(tab.binding.instanceId, tab.engineTabId);
      byEngine.set(key, (byEngine.get(key) ?? new Set()).add(tab));
    };

    const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

    // --- identity ----------------------------------------------------------

    const callerEnvironmentOf = (request: PreviewAutomationRequest) =>
      request.callerEnvironmentId === undefined
        ? Effect.fail(
            operationError(
              "PreviewAutomationExecutionError",
              "The caller's environment is unknown, so a managed browser cannot authorize this call.",
            ),
          )
        : Effect.succeed(request.callerEnvironmentId);

    const agentSessionOf = (request: PreviewAutomationRequest) =>
      request.agentSessionId === undefined || request.agentSessionId.length === 0
        ? Effect.fail(
            operationError(
              "PreviewAutomationControlInterruptedError",
              "The agent session is missing. Reconnect the provider.",
            ),
          )
        : Effect.succeed(request.agentSessionId);

    const callerContext = (tab: ManagedTab, request: PreviewAutomationRequest) => ({
      environmentId: tab.callerEnvironmentId,
      threadId: request.threadId,
      agentSessionId: engineSessionId(tab.agentSessionId),
    });

    // --- the durable record ---------------------------------------------------

    const recordOf = (
      tab: ManagedTab,
      closePending = false,
    ): ManagedBrowserRegistry.RegisteredTab => ({
      ownerEnvironmentId: tab.binding.ownerEnvironmentId,
      instanceId: tab.binding.instanceId,
      profileId: tab.binding.profileId,
      threadId: tab.threadId,
      engineTabId: tab.engineTabId,
      openerEngineTabId:
        tab.openerTabId === undefined
          ? null
          : (tabs.get(tabKey(tab.threadId, tab.openerTabId))?.engineTabId ?? null),
      callerEnvironmentId: tab.callerEnvironmentId,
      agentSessionId: tab.agentSessionId,
      url: tab.url,
      title: tab.title.slice(0, 1024),
      closePending,
      shared: tab.shared,
      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });

    /** Saves a tab. A failure is an operation failure: an unsaved tab would be forgotten by a restart. */
    const persist = (tab: ManagedTab, closePending = false) =>
      Effect.try({
        try: () => registry.upsertTab(recordOf(tab, closePending)),
        catch: () =>
          operationError(
            "PreviewAutomationExecutionError",
            "The managed browser could not record this tab, so it was not opened.",
          ),
      });

    /** For changes that follow the page (address, title): the page is fine, so only log a failed save. */
    const persistQuietly = (tab: ManagedTab) =>
      Effect.try({
        try: () => registry.upsertTab(recordOf(tab)),
        catch: registryError,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("managed browser tab record could not be saved", {
            detail: error.detail,
          }),
        ),
      );

    const unrecord = (tab: ManagedTab) =>
      Effect.try({
        try: () => registry.removeTab(tab.binding.instanceId, tab.engineTabId, tab.threadId),
        catch: registryError,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("managed browser tab record could not be removed", {
            detail: error.detail,
          }),
        ),
      );

    // --- following the browser's events -----------------------------------

    /** Where this session's page lives, for clients that watch it on the owner. */
    const managedSessionOf = (tab: ManagedTab): PreviewManagedSession => ({
      ownerEnvironmentId: tab.binding.ownerEnvironmentId,
      instanceId: tab.binding.instanceId,
      profileId: tab.binding.profileId,
      incarnation: tab.ref.incarnation,
      engineTabId: ManagedBrowserTabId.make(tab.engineTabId),
      hostThreadId: tab.threadId,
      hostTabId: tab.tabId,
      shared: tab.shared,
      remote: false,
      ...(options.desktop?.available ? { native: true } : {}),
    });

    const reportNav = (tab: ManagedTab) =>
      manager
        .reportStatus({
          managed: managedSessionOf(tab),
          threadId: tab.threadId as never,
          tabId: tab.tabId as never,
          navStatus:
            tab.url === null
              ? { _tag: "Idle" }
              : { _tag: "Success", url: tab.url, title: tab.title },
          canGoBack: false,
          canGoForward: false,
          serverControlled: true,
        })
        .pipe(Effect.ignore);

    const downloadDirectory = (tab: ManagedTab) =>
      options.downloadsRoot === undefined
        ? undefined
        : NodePath.join(
            options.downloadsRoot,
            NodeCrypto.createHash("sha256")
              .update(`${tab.threadId}\u0000${tab.engineTabId}`)
              .digest("hex"),
          );

    const forgetTab = (tab: ManagedTab) => {
      tabs.delete(tabKey(tab.threadId, tab.tabId));
      const key = engineKey(tab.binding.instanceId, tab.engineTabId);
      const holders = byEngine.get(key);
      holders?.delete(tab);
      if (holders?.size === 0) byEngine.delete(key);
      const directory = downloadDirectory(tab);
      if (directory !== undefined)
        void NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => {});
    };

    /** A principal that presents a tab's recorded caller exactly, which the engine needs to hand back its artifacts. */
    const principalOfCaller = (caller: {
      readonly callerId?: string | undefined;
      readonly kind?: string | undefined;
    }): ManagedBrowserPrincipal | undefined =>
      caller.callerId === undefined || caller.callerId.length === 0
        ? undefined
        : {
            id: ManagedBrowserPrincipalId.make(caller.callerId.slice(0, 512)),
            kind: caller.kind === "human" ? "human" : "agent",
            access: "read",
          };

    /**
     * A download crosses from the engine as bytes, never as a path on the engine's disk: the file is
     * read in protocol-sized chunks, written under this server's state, and the engine's copy released.
     * It is offered to whoever is driving the page; agents read it from status.
     */
    const saveDownload = (
      tab: ManagedTab,
      event: Extract<ManagedBrowserIpc.EngineEvent, { readonly name: "download" }>,
    ) =>
      Effect.gen(function* () {
        const directory = downloadDirectory(tab);
        const principal = principalOfCaller(event.caller);
        if (directory === undefined || principal === undefined) {
          yield* Effect.logWarning("managed browser download was not saved", {
            reason: directory === undefined ? "no downloads directory" : "no caller identity",
          });
          return;
        }
        const caller = {
          environmentId: event.caller.environmentId,
          threadId: event.caller.threadId,
          agentSessionId: event.caller.agentSessionId,
        };
        const artifactId = event.artifact.artifactId;
        const release = supervisor
          .scoped(principal, tab.ref, { kind: "downloadRelease", caller, artifactId })
          .pipe(Effect.ignore);
        const id = yield* uuid;
        const path = NodePath.join(directory, id);
        yield* Effect.gen(function* () {
          if (event.artifact.sizeBytes > DOWNLOAD_MAX_BYTES) {
            return yield* Effect.logWarning("managed browser download exceeds the size limit", {
              sizeBytes: event.artifact.sizeBytes,
            });
          }
          yield* Effect.promise(() => NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }));
          const hash = NodeCrypto.createHash("sha256");
          let offset = 0;
          for (;;) {
            const chunk = (yield* supervisor.scoped(
              principal,
              tab.ref,
              { kind: "downloadRead", caller, artifactId, offset, length: ARTIFACT_CHUNK },
              { deadlineMs: ENGINE_STATE_DEADLINE_MS * 2 },
            )) as { readonly bytesBase64: string; readonly eof: boolean };
            const bytes = Buffer.from(chunk.bytesBase64, "base64");
            if (bytes.length > 0) {
              hash.update(bytes);
              yield* Effect.promise(() => NodeFSP.appendFile(path, bytes, { mode: 0o600 }));
              offset += bytes.length;
            }
            if (offset > DOWNLOAD_MAX_BYTES) {
              yield* Effect.promise(() => NodeFSP.rm(path, { force: true }));
              return yield* Effect.logWarning("managed browser download exceeds the size limit");
            }
            if (chunk.eof || bytes.length === 0) break;
          }
          // The bytes that arrived are the bytes the engine described, or the file is not kept.
          if (offset !== event.artifact.sizeBytes || hash.digest("hex") !== event.artifact.sha256) {
            yield* Effect.promise(() => NodeFSP.rm(path, { force: true }));
            return yield* Effect.logWarning("managed browser download failed verification", {
              expectedBytes: event.artifact.sizeBytes,
              receivedBytes: offset,
            });
          }
          const saved: ManagedDownload = {
            id,
            fileName: event.artifact.fileName.slice(0, 255) || "download",
            path,
            sizeBytes: offset,
            url: "",
            completedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          };
          tab.downloads.push(saved);
          for (const evicted of tab.downloads.splice(0, tab.downloads.length - DOWNLOAD_LIMIT)) {
            yield* Effect.promise(() => NodeFSP.rm(evicted.path, { force: true }).catch(() => {}));
          }
          const lease = yield* supervisor.state(tab.ref).pipe(Effect.option);
          const driver = Option.isSome(lease)
            ? [...tab.sinks].find(
                (sink) => lease.value.phase === "human" && lease.value.holder === sink.principalId,
              )
            : undefined;
          driver?.push({
            _tag: "download",
            id,
            fileName: saved.fileName,
            sizeBytes: saved.sizeBytes,
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("managed browser download could not be transferred", {
              detail: tagOf(error) ?? "unknown",
            }).pipe(Effect.andThen(Effect.promise(() => NodeFSP.rm(path, { force: true })))),
          ),
          Effect.ensuring(release),
        );
      });

    /**
     * A page opened another (window.open, target=_blank). It becomes a session of its own, owned by
     * the same agent and thread as the page that opened it, so a viewer can attach and an agent can
     * address it. A popup beyond the tab limit is closed rather than left running with no session.
     */
    const adoptPopup = (
      opener: ManagedTab,
      event: Extract<ManagedBrowserIpc.EngineEvent, { readonly name: "tabOpened" }>,
    ) =>
      Effect.gen(function* () {
        if (engineTabOf(opener.binding.instanceId, event.ref.tabId) !== undefined) return;
        const owned = [...tabs.values()];
        if (
          owned.length >= SERVER_TAB_LIMIT ||
          owned.filter((tab) => tab.agentSessionId === opener.agentSessionId).length >=
            AGENT_TAB_LIMIT
        ) {
          yield* Effect.logWarning("managed browser popup closed: too many tabs", {
            threadId: opener.threadId,
          });
          yield* closeEngineTab(opener, event.ref.tabId);
          return;
        }
        const session = yield* publishSession(opener.threadId, opener.agentSessionId, undefined, { binding: opener.binding, ref: opener.ref, engineTabId: event.ref.tabId });
        const tab: ManagedTab = {
          threadId: opener.threadId,
          tabId: session.tabId,
          engineTabId: event.ref.tabId,
          openerTabId: opener.tabId,
          binding: opener.binding,
          agentSessionId: opener.agentSessionId,
          callerEnvironmentId: opener.callerEnvironmentId,
          ref: opener.ref,
          shared: false,
          documentId: event.documentId,
          url: event.url === "about:blank" ? null : event.url,
          title: "",
          refs: null,
          dialog: null,
          viewers: 0,
          sinks: new Set(),
          downloads: [],
          timeline: [],
        };
        remember(tab);
        reserved.delete(tabKey(tab.threadId, tab.tabId));
        const saved = yield* persist(tab).pipe(Effect.exit);
        if (saved._tag === "Failure") {
          forgetTab(tab);
          yield* manager
            .close({ threadId: tab.threadId, tabId: tab.tabId } as never)
            .pipe(Effect.ignore);
          return yield* closeEngineTab(opener, event.ref.tabId);
        }
        yield* reportNav(tab);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("managed browser popup could not be adopted", {
            detail: tagOf(error) ?? "unknown",
          }),
        ),
      );

    const followEvents = (ref: ManagedBrowserRef) =>
      Effect.gen(function* () {
        const events = yield* supervisor.events(watcher, ref);
        yield* events.pipe(
          Stream.runForEach((raw) =>
            Effect.gen(function* () {
              if (!isEngineEvent(raw)) return;
              const event = raw;
              switch (event.name) {
                // Every thread that holds the page learns of a change to it, whoever made the change.
                case "tabChanged": {
                  for (const tab of participantsOf(event.ref.instanceId, event.ref.tabId)) {
                    if (tab.documentId !== event.documentId) tab.refs = null;
                    tab.documentId = event.documentId;
                    tab.url = event.url === "about:blank" ? null : event.url;
                    // The engine's navigation event carries no title; keep the last one it gave.
                    if (event.title.length > 0) tab.title = event.title;
                    yield* reportNav(tab);
                    yield* persistQuietly(tab);
                  }
                  return;
                }
                case "dialog": {
                  for (const tab of participantsOf(event.ref.instanceId, event.ref.tabId)) {
                    tab.dialog = {
                      dialogId: event.dialogId,
                      type: event.type,
                      message: event.message,
                      defaultValue: event.defaultValue,
                    };
                  }
                  return;
                }
                case "tabOpened": {
                  // Only a page opened by another page; a tab this adapter opened or recovered has no opener.
                  if (event.openerTabId.length === 0) return;
                  const opener = engineTabOf(event.ref.instanceId, event.openerTabId);
                  if (opener === undefined) return;
                  yield* adoptPopup(opener, event);
                  return;
                }
                case "download": {
                  // The engine hands the file over once: it goes to the thread that caused it, else the first holder.
                  const holders = participantsOf(event.ref.instanceId, event.ref.tabId);
                  const tab =
                    holders.find((holder) => holder.threadId === event.caller.threadId) ??
                    holders[0];
                  if (tab === undefined) return;
                  yield* saveDownload(tab, event);
                  return;
                }
                case "tabClosed": {
                  for (const tab of participantsOf(event.ref.instanceId, event.ref.tabId)) {
                    forgetTab(tab);
                    yield* unrecord(tab);
                    yield* manager
                      .close({ threadId: tab.threadId as never, tabId: tab.tabId as never })
                      .pipe(Effect.ignore);
                  }
                  return;
                }
                default:
                  return;
              }
            }),
          ),
        );
      }).pipe(
        // The subscription lives exactly as long as this follower does.
        Effect.scoped,
        Effect.ignore,
        Effect.forkIn(layerScope),
        Effect.asVoid,
      );

    /** One follower per incarnation of an instance; a replaced browser gets a new one. */
    const followOnce = (ref: ManagedBrowserRef) =>
      Effect.suspend(() => {
        if (followed.get(ref.instanceId) === ref.incarnation) return Effect.void;
        followed.set(ref.instanceId, ref.incarnation);
        return followEvents(ref);
      });

    // --- calling the engine -----------------------------------------------

    const fenceOf = (tab: ManagedTab) =>
      supervisor.state(tab.ref).pipe(Effect.mapError(toOperationError));

    type CallOptions = { readonly outOfBand?: boolean; readonly humanOpenPrincipal?: ManagedBrowserPrincipal };

    /** A page-wide command (no snapshot-ref target) the engine refused because the page has a newer document. */
    const isStalePageCommand = (command: Record<string, unknown>, error: ServerBrowserPage.ServerBrowserOperationError) =>
      command.kind === "execute" &&
      !(typeof command.operation === "object" && command.operation !== null && "target" in command.operation) &&
      error.tag === "PreviewAutomationInvalidSelectorError" &&
      (error.detail as { staleRef?: boolean } | undefined)?.staleRef === true;

    /**
     * One lease-bound engine call, with the caller's own scope and the request's deadline. A page-wide
     * command whose remembered document is already replaced (an open or navigate reply can land after
     * the page's own navigation event) refreshes the document once and retries. A command aimed at a
     * snapshot ref is not retried: its ref belongs to the old document.
     */
    const call = <A = unknown>(
      tab: ManagedTab,
      request: PreviewAutomationRequest,
      command: Record<string, unknown>,
      callOptions?: CallOptions,
    ) =>
      callOnce<A>(tab, request, command, callOptions).pipe(
        Effect.catchIf(
          (error) => isStalePageCommand(command, error),
          () =>
            callOnce<EngineTabResult>(tab, request, { kind: "attach", tabId: tab.engineTabId }).pipe(
              Effect.andThen((current) => {
                tab.documentId = current.value.documentId;
                if (current.value.url !== undefined)
                  tab.url = current.value.url === "about:blank" ? null : current.value.url;
                return callOnce<A>(tab, request, { ...command, documentId: tab.documentId }, callOptions);
              }),
            ),
        ),
      );

    const callOnce = <A = unknown>(
      tab: ManagedTab,
      request: PreviewAutomationRequest,
      command: Record<string, unknown>,
      callOptions?: CallOptions,
    ) =>
      Effect.gen(function* () {
        const state = yield* fenceOf(tab);
        const result = yield* supervisor
          .execute(
            state.phase === "agent"
              ? agentPrincipal(tab.agentSessionId)
              : callOptions?.humanOpenPrincipal ?? agentPrincipal(tab.agentSessionId),
            tab.ref,
            state.fence,
            { ...command, caller: callerContext(tab, request) },
            {
              deadlineMs: Math.max(1, Math.min(request.timeoutMs, MAX_CALL_MS)),
              ...(callOptions?.outOfBand === true ? { outOfBand: true } : {}),
            },
          )
          .pipe(Effect.mapError(toOperationError));
        return { value: result as A, fence: state.fence };
      });

    const recordAction = <A, E>(tab: ManagedTab, action: string, effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const id = yield* uuid;
        const entry = {
          id,
          action,
          status: "running" as "running" | "succeeded" | "failed",
          startedAt: DateTime.formatIso(yield* DateTime.now),
        } as PreviewAutomationSnapshot["actionTimeline"][number] & { status: string };
        tab.timeline.push(entry);
        while (tab.timeline.length > TIMELINE_LIMIT) tab.timeline.shift();
        return yield* effect.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              (entry as { status: string }).status = "succeeded";
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              (entry as { status: string }).status = "failed";
            }),
          ),
        );
      });

    // --- targets and refs ---------------------------------------------------

    interface AriaResult {
      readonly documentId: string;
      readonly snapshot: string;
      readonly refs: Record<string, { role: string; name?: string; nth?: number }>;
    }

    /** Takes the aria snapshot that refs come from and makes it the tab's current one. */
    const ariaSnapshot = (tab: ManagedTab, request: PreviewAutomationRequest) =>
      Effect.gen(function* () {
        const aria = yield* call<AriaResult>(tab, request, {
          kind: "execute",
          tabId: tab.engineTabId,
          documentId: tab.documentId,
          operation: { name: "snapshot", format: "aria" },
        });
        tab.documentId = aria.value.documentId;
        tab.refs = {
          documentId: aria.value.documentId,
          generation: Number(aria.fence.generation),
          ids: new Set(Object.keys(aria.value.refs)),
        };
        return aria;
      });

    interface TargetFields {
      readonly locator?: string | undefined;
      readonly selector?: string | undefined;
      readonly x?: number | undefined;
      readonly y?: number | undefined;
    }

    const noMatch = (what: string) =>
      failOperation(
        "PreviewAutomationInvalidSelectorError",
        `${what} Take a fresh snapshot and use one of its refs, or a more specific locator.`,
        { selectorKind: "locator" },
      );

    /**
     * An element the page's accessibility tree names uniquely: the one place a role or text locator can
     * be resolved safely. The snapshot is taken now, in the document the action will run in; the
     * engine re-checks that document when it acts, so a page that moved on in between fails as stale
     * instead of acting on a different element.
     */
    const resolveByLocator = (
      tab: ManagedTab,
      request: PreviewAutomationRequest,
      locator: Exclude<ParsedLocator, { readonly _tag: "ref" | "unsupported" }>,
    ) =>
      Effect.gen(function* () {
        const aria = yield* ariaSnapshot(tab, request);
        const matches = Object.entries(aria.value.refs).filter(([, info]) =>
          locatorMatches(locator, info),
        );
        if (matches.length === 0) {
          return yield* noMatch("No interactive element on the page matches that locator.");
        }
        if (matches.length > 1) {
          return yield* noMatch(
            `${matches.length} interactive elements match that locator (${matches
              .slice(0, 5)
              .map(([ref]) => `aria-ref=${ref}`)
              .join(", ")}).`,
          );
        }
        return { ref: matches[0]![0], documentId: aria.value.documentId };
      });

    /**
     * The engine acts on snapshot refs only. A ref from the latest snapshot is used as given and a
     * role or text locator is resolved against a fresh snapshot. CSS selectors and coordinates cannot
     * be turned into a ref, and "the focused element" is not a ref at all: it is served by the
     * keyboard path below.
     */
    const resolveTarget = (
      tab: ManagedTab,
      request: PreviewAutomationRequest,
      input: TargetFields,
    ) =>
      Effect.gen(function* () {
        if (input.selector !== undefined) {
          return yield* failUnsupported(
            "Targeting by CSS selector (the engine acts on accessibility refs; use a ref or a role/text locator)",
          );
        }
        if (input.x !== undefined || input.y !== undefined) {
          return yield* failUnsupported("Targeting by coordinates");
        }
        if (input.locator === undefined) {
          return yield* failUnsupported("An operation with no target");
        }
        const parsed = parseLocator(input.locator);
        if (parsed._tag === "unsupported") return yield* failUnsupported(parsed.what);
        if (parsed._tag === "ref") {
          const state = yield* fenceOf(tab);
          const known = tab.refs;
          if (
            known === null ||
            !known.ids.has(parsed.ref) ||
            known.documentId !== tab.documentId ||
            known.generation !== state.fence.generation
          ) {
            return yield* failOperation(
              "PreviewAutomationInvalidSelectorError",
              "That ref is not from the latest snapshot of this page. Take a fresh snapshot.",
              { staleRef: true },
            );
          }
          return { ref: parsed.ref, documentId: known.documentId };
        }
        return yield* resolveByLocator(tab, request, parsed);
      });

    // --- the focused element ---------------------------------------------------

    type KeyboardInput =
      | { readonly name: "key"; readonly action: "down" | "up"; readonly key: string }
      | { readonly name: "text"; readonly text: string };

    /**
     * Sends keys to whatever has focus in the page, which no snapshot ref can name. The engine's input
     * path is a viewer subscription, so a short one is opened under the agent's own identity, used under
     * the agent's fence, and closed again whatever happens. A page that has moved on since the last
     * event fails as stale rather than receiving keys meant for another.
     */
    const keyboard = (
      tab: ManagedTab,
      request: PreviewAutomationRequest,
      inputs: ReadonlyArray<KeyboardInput>,
    ) =>
      Effect.gen(function* () {
        const principal = agentPrincipal(tab.agentSessionId);
        const caller = callerContext(tab, request);
        const subscriptionId = `agent-keys-${yield* uuid}`;
        yield* supervisor
          .scoped(principal, tab.ref, {
            kind: "subscribe",
            caller,
            tabId: tab.engineTabId,
            subscriptionId,
            surface: "page",
            maxFps: 1,
            maxWidth: 100,
            maxHeight: 100,
          })
          .pipe(Effect.mapError(toOperationError));
        yield* Effect.gen(function* () {
          for (const input of inputs) {
            const state = yield* fenceOf(tab);
            yield* supervisor
              .execute(
                principal,
                tab.ref,
                state.fence,
                {
                  kind: "viewerInput",
                  caller,
                  tabId: tab.engineTabId,
                  documentId: tab.documentId,
                  subscriptionId,
                  input,
                },
                { deadlineMs: Math.max(1, Math.min(request.timeoutMs, MAX_CALL_MS)) },
              )
              .pipe(Effect.mapError(toOperationError));
          }
        }).pipe(
          Effect.ensuring(
            supervisor
              .scoped(principal, tab.ref, { kind: "unsubscribe", caller, subscriptionId })
              .pipe(Effect.ignore),
          ),
        );
      });

    /** `Shift+a` as the key events a keyboard would make: modifiers down, the key, modifiers up. */
    const chord = (keys: ReadonlyArray<string>): ReadonlyArray<KeyboardInput> => [
      ...keys.map((key) => ({ name: "key" as const, action: "down" as const, key })),
      ...[...keys].reverse().map((key) => ({ name: "key" as const, action: "up" as const, key })),
    ];

    const FOCUSED_EDITABLE = `(() => {
      const element = document.activeElement;
      if (!element) return false;
      if (element.isContentEditable) return true;
      if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
      if (element.tagName !== "INPUT") return false;
      const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
      return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
    })()`;

    // --- status -------------------------------------------------------------

    const statusOf = (tab: ManagedTab, request: PreviewAutomationRequest) =>
      supervisor.state(tab.ref).pipe(
        Effect.option,
        Effect.map((state): PreviewAutomationStatus => {
          const control = Option.map(state, (current) => ({
            owner:
              current.phase === "agent"
                ? ("agent" as const)
                : current.phase === "human" || current.phase === "reconnectHold"
                  ? ("human" as const)
                  : ("unclaimed" as const),
            ownedByCaller:
              current.phase === "agent" && tab.agentSessionId === request.agentSessionId,
            generation: Number(current.fence.generation),
          }));
          return {
            available: true,
            visible: tab.viewers > 0,
            tabId: tab.tabId as never,
            url: tab.url,
            title: tab.title,
            loading: false,
            ...(Option.isSome(control) ? { control: control.value } : {}),
            dialog:
              tab.dialog === null
                ? null
                : {
                    type: tab.dialog.type,
                    message: tab.dialog.message,
                    defaultValue: tab.dialog.defaultValue,
                  },
            managed: {
              ...(options.desktop?.available ? { native: true } : {}),
              ownerEnvironmentId: tab.binding.ownerEnvironmentId,
              instanceId: tab.binding.instanceId,
              profileId: tab.binding.profileId,
              incarnation: tab.ref.incarnation,
              engineTabId: ManagedBrowserTabId.make(tab.engineTabId),
              shared: tab.shared,
              participants: participantsOf(tab.binding.instanceId, tab.engineTabId).length,
              phase: Option.isSome(state) ? phaseOf(state.value) : "unavailable",
            },
            // Every tab this agent session holds in the thread, popups included.
            tabs: [...tabs.values()]
              .filter(
                (candidate) =>
                  candidate.threadId === tab.threadId &&
                  candidate.agentSessionId === tab.agentSessionId,
              )
              .map((candidate) => ({
                tabId: candidate.tabId as never,
                url: candidate.url,
                ...(candidate.openerTabId === undefined
                  ? {}
                  : { openerTabId: candidate.openerTabId as never }),
              })),
            downloads: tab.downloads.map(({ fileName, path, sizeBytes, url, completedAt }) => ({
              fileName,
              path,
              sizeBytes,
              url,
              completedAt,
            })),
          };
        }),
      );

    // --- artifacts ------------------------------------------------------------

    /** Streams an artifact out in protocol-sized chunks and releases it, whatever happens. */
    const readArtifact = (tab: ManagedTab, request: PreviewAutomationRequest, artifactId: string) =>
      Effect.gen(function* () {
        const principal = agentPrincipal(tab.agentSessionId);
        const caller = callerContext(tab, request);
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const chunk = (yield* supervisor
            .scoped(
              principal,
              tab.ref,
              { kind: "downloadRead", caller, artifactId, offset, length: ARTIFACT_CHUNK },
              { deadlineMs: ENGINE_STATE_DEADLINE_MS * 2 },
            )
            .pipe(Effect.mapError(toOperationError))) as {
            readonly bytesBase64: string;
            readonly eof: boolean;
          };
          const bytes = Buffer.from(chunk.bytesBase64, "base64");
          chunks.push(bytes);
          offset += bytes.length;
          if (offset > MAX_ARTIFACT_BYTES) {
            return yield* failOperation(
              "PreviewAutomationResultTooLargeError",
              `The artifact is larger than ${MAX_ARTIFACT_BYTES} bytes.`,
              { maximumBytes: MAX_ARTIFACT_BYTES },
            );
          }
          if (chunk.eof || bytes.length === 0) break;
        }
        return Buffer.concat(chunks);
      }).pipe(
        Effect.ensuring(
          supervisor
            .scoped(agentPrincipal(tab.agentSessionId), tab.ref, {
              kind: "downloadRelease",
              caller: callerContext(tab, request),
              artifactId,
            })
            .pipe(Effect.ignore),
        ),
      );

    // --- operations -------------------------------------------------------------

    const snapshotOf = (tab: ManagedTab, request: PreviewAutomationRequest) =>
      Effect.gen(function* () {
        const ids = { tabId: tab.engineTabId, documentId: tab.documentId };
        const text = yield* call<{ snapshot: string }>(tab, request, {
          kind: "execute",
          ...ids,
          operation: { name: "snapshot", format: "text" },
        });
        const shot = yield* call<{ artifactId: string }>(tab, request, {
          kind: "execute",
          ...ids,
          operation: { name: "screenshot", format: "png", fullPage: false },
        });
        const png = yield* readArtifact(tab, request, shot.value.artifactId);
        const logs = yield* call<{
          entries: ReadonlyArray<{ level: string; text: string }>;
        }>(tab, request, {
          kind: "execute",
          ...ids,
          operation: { name: "console", limit: 100 },
        });
        const network = yield* call<{
          entries: ReadonlyArray<{ url: string; method: string; status: number; failed: boolean }>;
        }>(tab, request, {
          kind: "execute",
          ...ids,
          operation: { name: "network", limit: 100 },
        });
        // The aria snapshot goes last: any other snapshot clears the refs it issues.
        const aria = yield* ariaSnapshot(tab, request);
        const now = DateTime.formatIso(yield* DateTime.now);
        const result: PreviewAutomationSnapshot = {
          url: tab.url ?? "about:blank",
          title: tab.title,
          loading: false,
          visibleText: text.value.snapshot,
          interactiveElements: Object.entries(aria.value.refs).map(([ref, info]) => ({
            tag: info.role,
            role: info.role,
            name: info.name ?? "",
            selector: `aria-ref=${ref}`,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
          })),
          accessibilityTree: { format: "aria", snapshot: aria.value.snapshot },
          consoleEntries: logs.value.entries.map((entry) => ({
            level: entry.level,
            text: entry.text,
            timestamp: now,
          })),
          networkEntries: network.value.entries.map((entry) => ({
            url: entry.url,
            method: entry.method,
            status: entry.status === 0 ? null : entry.status,
            failed: entry.failed,
            timestamp: now,
          })),
          actionTimeline: [...tab.timeline],
          screenshot: {
            mimeType: "image/png",
            data: png.toString("base64"),
            width: png.length >= 24 ? png.readUInt32BE(16) : 0,
            height: png.length >= 24 ? png.readUInt32BE(20) : 0,
          },
        };
        return result;
      });

    const sendFile = (tab: ManagedTab, request: PreviewAutomationRequest, path: string) =>
      Effect.gen(function* () {
        if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
          return yield* failOperation(
            "PreviewAutomationExecutionError",
            "Upload paths must be absolute.",
          );
        }
        const bytes = yield* fs
          .readFile(path)
          .pipe(
            Effect.mapError(() =>
              operationError(
                "PreviewAutomationExecutionError",
                "A file to upload could not be read.",
              ),
            ),
          );
        const buffer = Buffer.from(bytes);
        const name = path.split(/[\\/]/).at(-1) ?? "file";
        const begun = yield* call<{ artifactId: string }>(tab, request, {
          kind: "uploadBegin",
          fileName: name,
          mimeType: "application/octet-stream",
          sizeBytes: buffer.length,
          sha256: NodeCrypto.createHash("sha256").update(buffer).digest("hex"),
        });
        const artifactId = begun.value.artifactId;
        for (let offset = 0; offset < buffer.length; offset += 192 * 1024) {
          yield* call(tab, request, {
            kind: "uploadWrite",
            artifactId,
            offset,
            bytesBase64: buffer.subarray(offset, offset + 192 * 1024).toString("base64"),
          });
        }
        yield* call(tab, request, { kind: "uploadFinish", artifactId });
        return artifactId;
      });

    const releaseUpload = (
      tab: ManagedTab,
      request: PreviewAutomationRequest,
      artifactId: string,
    ) => call(tab, request, { kind: "uploadRelease", artifactId }).pipe(Effect.ignore);

    const requireTab = (request: PreviewAutomationRequest) =>
      Effect.gen(function* () {
        const agentSessionId = yield* agentSessionOf(request);
        const tabId = request.tabId;
        const tab = tabId === undefined ? undefined : tabs.get(tabKey(request.threadId, tabId));
        if (tab === undefined) {
          return yield* failOperation(
            "PreviewAutomationTabNotFoundError",
            "No managed browser tab is open for this thread. Call preview_open with a browserBinding.",
          );
        }
        if (tab.agentSessionId !== agentSessionId) {
          return yield* failOperation(
            "PreviewAutomationControlInterruptedError",
            "This tab belongs to another agent session or a human. Open your own tab.",
            "agentMismatch",
          );
        }
        return tab;
      });

    // --- sessions ----------------------------------------------------------------

    /** Publishes a preview session for a tab, registering it first so the ordinary browser skips it. */
    const publishSession = (
      threadId: string,
      agentSessionId: string,
      url: string | undefined,
      identity: { binding: PreviewAutomationBrowserBinding; ref: ManagedBrowserRef; engineTabId?: string },
    ): Effect.Effect<PreviewSessionSnapshot, ServerBrowserPage.ServerBrowserOperationError> =>
      manager
        .open({
          threadId: threadId as never,
          ...(options.desktop?.available || url === undefined ? {} : { url }),
          managed: (tabId) => ({
            ...identity.binding, incarnation: identity.ref.incarnation,
            engineTabId: ManagedBrowserTabId.make(identity.engineTabId ?? tabId),
            hostThreadId: threadId, hostTabId: tabId, shared: false, remote: false,
            ...(options.desktop?.available ? { native: true } : {}),
          }),
          runtime: "server",
          reveal: false,
          automationOwner: agentSessionId,
          beforePublish: (snapshot) => {
            reserved.add(tabKey(threadId, snapshot.tabId));
          },
        })
        .pipe(
          Effect.mapError(() =>
            operationError(
              "PreviewAutomationExecutionError",
              "The preview session could not be created.",
            ),
          ),
        );

    const closeSession = (tab: ManagedTab) =>
      manager
        .close({ threadId: tab.threadId as never, tabId: tab.tabId as never })
        .pipe(Effect.ignore);

    // --- leaving a shared tab ------------------------------------------------------

    /** Whether a participant's own grant still admits it, so a revoked one never keeps a page open. */
    const stillAdmitted = (participant: ManagedTab) =>
      policy
        .authorize({
          callerEnvironmentId: participant.callerEnvironmentId,
          threadId: participant.threadId,
          agentSessionId: participant.agentSessionId,
          binding: participant.binding,
          access: "read",
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

    /** The other threads that hold this tab and are still entitled to it. */
    const otherParticipants = (tab: ManagedTab) =>
      Effect.gen(function* () {
        const others = participantsOf(tab.binding.instanceId, tab.engineTabId).filter(
          (candidate) => candidate !== tab,
        );
        const admitted = yield* Effect.forEach(others, stillAdmitted);
        return others.filter((_, index) => admitted[index] === true);
      });

    /**
     * One thread lets go of a tab that others still hold: its session and record go, and viewers of its
     * session are told it is gone. The page itself, and every other thread's hold on it, stay.
     */
    const detach = (tab: ManagedTab) =>
      Effect.gen(function* () {
        for (const sink of tab.sinks) sink.push({ _tag: "gone" });
        forgetTab(tab);
        yield* unrecord(tab);
      });

    /** After the page itself is closed: the revoked holders it leaves behind have nothing left to hold. */
    const dropOthers = (tab: ManagedTab) =>
      Effect.forEach(
        participantsOf(tab.binding.instanceId, tab.engineTabId).filter(
          (candidate) => candidate !== tab,
        ),
        (other) => detach(other).pipe(Effect.andThen(closeSession(other))),
        { discard: true },
      );

    // --- closing ---------------------------------------------------------------------

    /**
     * Who closes a tab on behalf of whoever closed its session. The person was authorized by the RPC
     * that closed the session; the control layer sees a human with operate access who must take the
     * lease, which is the explicit, fenced step a close under someone else's control needs.
     */
    const closer: ManagedBrowserPrincipal = {
      id: ManagedBrowserPrincipalId.make("human:ui-close"),
      kind: "human",
      access: "operate",
    };
    const closeLock = yield* Semaphore.make(1);

    interface CloseTarget {
      readonly threadId: string;
      readonly engineTabId: string;
      readonly ref: ManagedBrowserRef;
      readonly callerEnvironmentId: EnvironmentId;
      readonly agentSessionId: string;
    }

    const targetOf = (tab: ManagedTab, engineTabId = tab.engineTabId): CloseTarget => ({
      threadId: tab.threadId,
      engineTabId,
      ref: tab.ref,
      callerEnvironmentId: tab.callerEnvironmentId,
      agentSessionId: tab.agentSessionId,
    });

    /**
     * Closes a tab in the browser by taking the lease explicitly, closing under the fence that gives,
     * and handing the lease back. Fails, without closing, when a person holds it: their control is
     * never taken away by a close. `attach` first makes the engine restore the profile's tabs, for a
     * tab that this run has not touched.
     */
    const closeUnderControl = (target: CloseTarget, options: { readonly attach: boolean }) =>
      closeLock.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* supervisor.state(target.ref);
          const fence = yield* supervisor.takeControl(closer, target.ref);
          const caller = {
            environmentId: target.callerEnvironmentId,
            threadId: target.threadId,
            agentSessionId: engineSessionId(target.agentSessionId),
          };
          return yield* Effect.gen(function* () {
            if (options.attach) {
              yield* supervisor.execute(
                closer,
                target.ref,
                fence,
                { kind: "attach", caller, tabId: target.engineTabId },
                { deadlineMs: ENGINE_STATE_DEADLINE_MS },
              );
            }
            yield* supervisor.execute(
              closer,
              target.ref,
              fence,
              { kind: "closeTab", caller, tabId: target.engineTabId },
              { deadlineMs: ENGINE_STATE_DEADLINE_MS },
            );
          }).pipe(
            // A paused browser stays paused (nobody but a person may resume it); anything else returns to agents.
            Effect.ensuring(
              before.phase === "paused"
                ? supervisor.holderDisconnected(closer.id, target.ref)
                : supervisor.releaseControl(closer, target.ref).pipe(Effect.ignore),
            ),
          );
        }),
      );

    /** The browser has no such tab (any more): a close has nothing left to do. */
    const alreadyGone = (error: unknown) => {
      const inner = (error as { cause?: unknown })?.cause;
      return (
        tagOf(error) === "ManagedBrowserChildChannelError" &&
        tagOf(inner) === "ManagedBrowserEngineError" &&
        (inner as ManagedBrowserIpc.ManagedBrowserEngineError).code === "not_found"
      );
    };

    /** A refusal that will pass: someone holds the lease, it is changing hands, or maintenance is under way. */
    const closeDeferrable = (error: unknown) =>
      [
        "ManagedBrowserControlHeldError",
        "ManagedBrowserNotHolderError",
        "ManagedBrowserMaintenanceError",
        "ManagedBrowserTransferFailedError",
        "ManagedBrowserControlChangedError",
        "ManagedBrowserBusyError",
      ].includes(tagOf(error) ?? "");

    const markClosePending = (tab: ManagedTab) =>
      Effect.try({
        try: () => registry.upsertTab(recordOf(tab, true)),
        catch: registryError,
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("managed browser tab close is pending but could not be recorded", {
            detail: error.detail,
          }),
        ),
      );

    /**
     * Waits until nobody holds the lease, then closes. The wait follows the lease's own state changes
     * rather than polling it, and ends with the browser incarnation: a replaced browser restores the
     * tab from the profile, where the durable close-pending mark closes it on the next open.
     */
    const closeWhenFree = (tab: ManagedTab) => {
      const target = targetOf(tab);
      const key = engineKey(tab.binding.instanceId, tab.engineTabId);
      if (closing.has(key)) return Effect.void;
      closing.add(key);
      return Effect.gen(function* () {
        const states = yield* supervisor.subscribe(watcher, target.ref);
        const current = yield* supervisor.state(target.ref);
        if (current.phase !== "agent" && current.phase !== "paused") {
          yield* states.pipe(
            Stream.filter((state) => state.phase === "agent" || state.phase === "paused"),
            Stream.take(1),
            Stream.runDrain,
          );
        }
        yield* closeUnderControl(target, { attach: false }).pipe(
          Effect.retry({
            times: CLOSE_RETRY_ATTEMPTS,
            schedule: Schedule.exponential(CLOSE_RETRY_BASE),
            while: closeDeferrable,
          }),
        );
        yield* unrecord(tab);
        yield* Effect.logInfo("managed browser tab closed after its session closed", {
          engineTabId: tab.engineTabId,
        });
      }).pipe(
        Effect.scoped,
        Effect.catch((error) =>
          alreadyGone(error)
            ? unrecord(tab)
            : Effect.logError(
                "managed browser tab could not be closed; it is marked to close on the next open",
                {
                  detail: tagOf(error) ?? "unknown",
                },
              ),
        ),
        Effect.ensuring(Effect.sync(() => closing.delete(key))),
        Effect.forkIn(layerScope),
        Effect.asVoid,
      );
    };

    /** Closes one engine tab now, as {@link closeUnderControl}, reporting whether it is certain to be gone. */
    const closeEngineTab = (opener: ManagedTab, engineTabId: string) =>
      closeUnderControl(targetOf(opener, engineTabId), { attach: false }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("managed browser tab could not be closed", {
            detail: tagOf(error) ?? "unknown",
          }).pipe(Effect.as(alreadyGone(error))),
        ),
      );

    const sessionClosed: ManagedBrowserPreviewAdapter["Service"]["sessionClosed"] = (
      threadId,
      tabId,
    ) =>
      Effect.gen(function* () {
        const tab = tabs.get(tabKey(threadId, tabId));
        if (tab === undefined) return { _tag: "notManaged" as const };
        // Closing one holder's session of a shared tab leaves the page to the others.
        if ((yield* otherParticipants(tab)).length > 0) {
          yield* detach(tab);
          return { _tag: "closed" as const };
        }
        forgetTab(tab);
        const exit = yield* closeUnderControl(targetOf(tab), { attach: false }).pipe(Effect.exit);
        if (exit._tag === "Success") {
          yield* unrecord(tab);
          yield* dropOthers(tab);
          return { _tag: "closed" as const };
        }
        const failure = Exit.isFailure(exit)
          ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
          : undefined;
        const error = (failure as { error?: unknown } | undefined)?.error;
        if (alreadyGone(error)) {
          yield* unrecord(tab);
          return { _tag: "closed" as const };
        }
        // Not closed: a person holds the browser, or it is busy or gone. The close is recorded durably
        // so that a restart still closes it, and retried here as soon as the lease is free.
        yield* markClosePending(tab);
        yield* Effect.logWarning("managed browser tab close deferred", {
          engineTabId: tab.engineTabId,
          detail: tagOf(error) ?? "unknown",
        });
        if (closeDeferrable(error)) yield* closeWhenFree(tab);
        return { _tag: "deferred" as const, reason: tagOf(error) ?? "unknown" };
      });

    /** Closes tabs whose close was requested earlier but never confirmed, before anything reopens them. */
    const finishPendingCloses = (
      instance: ManagedBrowserRegistry.RegisteredInstance,
      ref: ManagedBrowserRef,
    ) =>
      Effect.forEach(
        registry
          .tabs()
          .filter(
            (tab) =>
              tab.closePending &&
              tab.instanceId === instance.instanceId &&
              tab.profileId === instance.profileId &&
              tab.ownerEnvironmentId === instance.ownerEnvironmentId,
          ),
        (record) =>
          // Another thread may still hold the page this one asked to close; then only this hold ends.
          (registry
            .participantsOf(record.instanceId, record.engineTabId)
            .some((other) => other.threadId !== record.threadId && !other.closePending) ||
          participantsOf(record.instanceId, record.engineTabId).length > 0
            ? Effect.void
            : closeUnderControl(
                {
                  threadId: record.threadId,
                  engineTabId: record.engineTabId,
                  ref,
                  callerEnvironmentId: record.callerEnvironmentId as EnvironmentId,
                  agentSessionId: record.agentSessionId,
                },
                { attach: true },
              )
          ).pipe(
            Effect.catchIf(alreadyGone, () => Effect.void),
            Effect.andThen(
              Effect.try({
                try: () =>
                  registry.removeTab(record.instanceId, record.engineTabId, record.threadId),
                catch: registryError,
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("a managed browser tab that was to be closed is still open", {
                detail: tagOf(error) ?? "unknown",
              }),
            ),
          ),
        { discard: true },
      );

    // --- opening and recovering ------------------------------------------------------

    const bindingConflict = (conflict: ManagedBrowserRegistry.RegistryBindingConflict) =>
      failOperation(
        "PreviewAutomationExecutionError",
        conflict._tag === "instanceUsesOtherProfile"
          ? "That managed browser instance is bound to a different profile."
          : conflict._tag === "profileUsedByOtherInstance"
            ? "That profile already belongs to a different managed browser instance."
            : "That managed browser instance belongs to a different environment.",
      );

    /**
     * Gives the thread back the tabs it had in this profile before a restart: the same instance, profile
     * and engine tab ids, each in a session of its own, attached without being navigated. Tabs another
     * environment opened, or another thread, are never adopted. A tab the browser no longer has is
     * dropped from the record.
     */
    const recoverTabs = (
      request: PreviewAutomationRequest,
      binding: PreviewAutomationBrowserBinding,
      ref: ManagedBrowserRef,
      agentSessionId: string,
      callerEnvironmentId: EnvironmentId,
      onlyEngineTabId?: string,
    ) =>
      Effect.gen(function* () {
        const durable = registry
          .tabsOf(request.threadId, {
            ownerEnvironmentId: binding.ownerEnvironmentId,
            instanceId: binding.instanceId,
            profileId: binding.profileId,
          })
          .filter(
            (record) =>
              record.callerEnvironmentId === callerEnvironmentId &&
              !record.closePending &&
              // A person's tab is restored for that person's session only, never adopted by an agent.
              (!record.agentSessionId.startsWith(HUMAN_SESSION_PREFIX) ||
                record.agentSessionId === agentSessionId) &&
              (onlyEngineTabId === undefined || record.engineTabId === onlyEngineTabId) &&
              !participantsOf(record.instanceId, record.engineTabId).some(
                (holder) => holder.threadId === record.threadId,
              ),
          )
          .sort(
            (a, b) =>
              Number(a.openerEngineTabId !== null) - Number(b.openerEngineTabId !== null) ||
              b.updatedAt.localeCompare(a.updatedAt),
          );
        const recovered: ManagedTab[] = [];
        for (const record of durable) {
          const session = yield* publishSession(request.threadId, agentSessionId, undefined, { binding, ref, engineTabId: record.engineTabId });
          const opener =
            record.openerEngineTabId === null
              ? undefined
              : engineTabOf(record.instanceId, record.openerEngineTabId);
          const tab: ManagedTab = {
            threadId: request.threadId,
            tabId: session.tabId,
            engineTabId: record.engineTabId,
            openerTabId: opener?.tabId,
            binding,
            agentSessionId,
            callerEnvironmentId,
            ref,
            shared: record.shared,
            documentId: "",
            url: record.url,
            title: record.title,
            refs: null,
            dialog: null,
            viewers: 0,
            sinks: new Set(),
            downloads: [],
            timeline: [],
          };
          remember(tab);
          reserved.delete(tabKey(tab.threadId, tab.tabId));
          const attached = yield* call<EngineTabResult>(tab, request, {
            kind: "attach",
            tabId: tab.engineTabId,
          }).pipe(Effect.exit);
          if (attached._tag === "Failure") {
            forgetTab(tab);
            yield* closeSession(tab);
            const failure = attached.cause.reasons.find((reason) => reason._tag === "Fail") as
              | { error?: ServerBrowserPage.ServerBrowserOperationError }
              | undefined;
            // The browser does not have it any more: forget it. Anything else is the caller's to see.
            if (failure?.error?.tag === "PreviewAutomationTabNotFoundError") {
              yield* unrecord(tab);
              continue;
            }
            return yield* Effect.failCause(attached.cause);
          }
          tab.documentId = attached.value.value.documentId;
          if (attached.value.value.url !== undefined) {
            tab.url = attached.value.value.url === "about:blank" ? null : attached.value.value.url;
          }
          if (attached.value.value.title !== undefined && attached.value.value.title.length > 0) {
            tab.title = attached.value.value.title;
          }
          yield* persist(tab);
          yield* reportNav(tab);
          recovered.push(tab);
        }
        return recovered[0];
      });

    /** Sharing belongs to the page, so every thread's record of it changes together. */
    const setShared = (tab: ManagedTab, shared: boolean) =>
      Effect.gen(function* () {
        for (const holder of participantsOf(tab.binding.instanceId, tab.engineTabId)) {
          holder.shared = shared;
          yield* persist(holder);
          yield* reportNav(holder);
        }
      });

    /** Whether a participant of this page, now or before a restart, shared it. */
    const isShared = (instanceId: string, engineTabId: string) =>
      participantsOf(instanceId, engineTabId).some((holder) => holder.shared) ||
      registry
        .participantsOf(instanceId, engineTabId)
        .some((record) => record.shared && !record.closePending);

    /**
     * Attaches a thread to a page it does not hold yet. The page must be one a participant shared on
     * purpose: knowing its id gets nothing, and the answer for an unshared page is the answer for a
     * page that does not exist. The grant behind this call has already been checked for the browser.
     */
    const joinSession = (
      request: PreviewAutomationRequest,
      input: PreviewAutomationOpenInput,
      binding: PreviewAutomationBrowserBinding,
      ref: ManagedBrowserRef,
      agentSessionId: string,
      callerEnvironmentId: EnvironmentId,
      engineTabId: string,
      url: string | undefined,
    ) =>
      Effect.gen(function* () {
        // This thread held the page before a restart of the owner: reattach its own record.
        const recovered = yield* recoverTabs(
          request,
          binding,
          ref,
          agentSessionId,
          callerEnvironmentId,
          engineTabId,
        );
        const joined =
          recovered ??
          (yield* newParticipant(
            request,
            binding,
            ref,
            agentSessionId,
            callerEnvironmentId,
            engineTabId,
          ));
        if (url !== undefined) {
          const moved = yield* call<EngineTabResult>(joined, request, {
            kind: "execute",
            tabId: joined.engineTabId,
            documentId: joined.documentId,
            operation: { name: "navigate", url, waitUntil: "load" },
          });
          joined.documentId = moved.value.documentId;
          joined.url = url;
          yield* persist(joined);
          yield* reportNav(joined);
        }
        if (input.shareTab !== undefined) yield* setShared(joined, input.shareTab);
        const reveal = input.open ?? input.show;
        if (reveal !== false) {
          yield* manager
            .requestReveal({
              threadId: request.threadId,
              tabId: joined.tabId,
              force: reveal === true,
            })
            .pipe(Effect.ignore);
        }
        return yield* statusOf(joined, request);
      });

    const newParticipant = (
      request: PreviewAutomationRequest,
      binding: PreviewAutomationBrowserBinding,
      ref: ManagedBrowserRef,
      agentSessionId: string,
      callerEnvironmentId: EnvironmentId,
      engineTabId: string,
    ) =>
      Effect.gen(function* () {
        if (!isShared(binding.instanceId, engineTabId)) {
          return yield* failOperation(
            "PreviewAutomationTabNotFoundError",
            "No tab with that id is shared with this thread.",
          );
        }
        const owned = [...tabs.values()];
        if (
          owned.length >= SERVER_TAB_LIMIT ||
          owned.filter((held) => held.agentSessionId === agentSessionId).length >= AGENT_TAB_LIMIT
        ) {
          return yield* failOperation(
            "PreviewAutomationControlInterruptedError",
            "Too many managed browser tabs are open. Close one with t3_preview_close, or reuse a tabId.",
            "tabLimit",
          );
        }
        const session = yield* publishSession(request.threadId, agentSessionId, undefined, { binding, ref, engineTabId });
        const tab: ManagedTab = {
          threadId: request.threadId,
          tabId: session.tabId,
          engineTabId,
          openerTabId: undefined,
          binding,
          agentSessionId,
          callerEnvironmentId,
          ref,
          shared: true,
          documentId: "",
          url: null,
          title: "",
          refs: null,
          dialog: null,
          viewers: 0,
          sinks: new Set(),
          downloads: [],
          timeline: [],
        };
        remember(tab);
        reserved.delete(tabKey(tab.threadId, tab.tabId));
        const abandon = Effect.sync(() => forgetTab(tab)).pipe(
          Effect.andThen(unrecord(tab)),
          Effect.andThen(closeSession(tab)),
        );
        yield* persist(tab).pipe(Effect.tapError(() => abandon));
        const attached = yield* call<EngineTabResult>(tab, request, {
          kind: "attach",
          tabId: engineTabId,
        }).pipe(Effect.tapError(() => abandon));
        tab.documentId = attached.value.documentId;
        if (attached.value.url !== undefined) {
          tab.url = attached.value.url === "about:blank" ? null : attached.value.url;
        }
        if (attached.value.title !== undefined) tab.title = attached.value.title;
        yield* persistQuietly(tab);
        yield* reportNav(tab);
        return tab;
      });

    const openSession = (request: PreviewAutomationRequest, input: PreviewAutomationOpenInput, humanPrincipal?: ManagedBrowserPrincipal) =>
      Effect.gen(function* () {
        const reuse = input.reuseExistingTab ?? true;
        const joining = input.joinTab;
        // Joining names the page by its engine id, so a thread that already holds it is simply
        // reattached to it (a restarted caller finds its own tab again), whatever tab id it has to hand.
        const existing =
          joining !== undefined
            ? [...tabs.values()].find(
                (held) =>
                  held.threadId === request.threadId &&
                  held.engineTabId === joining.engineTabId &&
                  held.binding.instanceId === input.browserBinding?.instanceId &&
                  held.binding.profileId === input.browserBinding?.profileId,
              )
            : reuse && request.tabId !== undefined
              ? tabs.get(tabKey(request.threadId, request.tabId))
              : undefined;
        // Reopening a managed tab needs no binding: the tab already knows its browser.
        const binding = input.browserBinding ?? existing?.binding;
        if (binding === undefined) {
          return yield* failOperation(
            "PreviewAutomationExecutionError",
            "A managed browser tab needs a browserBinding.",
          );
        }
        const agentSessionId = yield* agentSessionOf(request);
        const callerEnvironmentId = yield* callerEnvironmentOf(request);
        // Attaching to a page only looks at it; every action on it is authorized again, per call.
        yield* policy
          .authorize({
            callerEnvironmentId,
            threadId: request.threadId,
            agentSessionId,
            binding,
            access:
              joining !== undefined && input.url === undefined && input.shareTab !== true
                ? "read"
                : "operate",
          })
          .pipe(Effect.mapError(toOperationError));
        if (registry.status._tag !== "ready") {
          return yield* failOperation(
            "PreviewAutomationExecutionError",
            `The managed browser's tab record could not be read (${registry.status.detail}), so no tab was opened or recovered. Repair or remove the record and try again.`,
          );
        }
        const instance = {
          ownerEnvironmentId: binding.ownerEnvironmentId,
          instanceId: binding.instanceId,
          profileId: binding.profileId,
        };
        // The instance-to-profile binding is explicit and durable: a restart cannot rebind it.
        const conflict = yield* Effect.try({
          try: () => registry.bindInstance(instance),
          catch: () =>
            operationError(
              "PreviewAutomationExecutionError",
              "The managed browser could not record its profile binding, so nothing was opened.",
            ),
        });
        if (conflict !== null) return yield* bindingConflict(conflict);
        const url = yield* Effect.try({
          try: () => (input.url === undefined ? undefined : normalizePreviewUrl(input.url)),
          catch: () =>
            operationError("PreviewAutomationExecutionError", "That address is not a valid URL."),
        });
        const ref = yield* supervisor
          .ensure({
            ownerEnvironmentId,
            instanceId: binding.instanceId,
            profileId: binding.profileId,
          })
          .pipe(Effect.mapError(toOperationError));
        yield* followOnce(ref);
        yield* finishPendingCloses(instance, ref);

        if (
          joining?.incarnation !== undefined &&
          (joining.incarnation as string) !== (ref.incarnation as string)
        ) {
          return yield* failOperation(
            "PreviewAutomationExecutionError",
            "That managed browser restarted since the tab was last seen, so the tab reference is stale. Join again without an incarnation to attach to the restored tab, or open a new one.",
            { stale: true },
          );
        }

        if (existing !== undefined) {
          if (existing.agentSessionId !== agentSessionId) {
            return yield* failOperation(
              "PreviewAutomationControlInterruptedError",
              "This tab belongs to another agent session or a human. Open your own tab.",
              "agentMismatch",
            );
          }
          if (
            existing.binding.instanceId !== binding.instanceId ||
            existing.binding.profileId !== binding.profileId
          ) {
            return yield* failOperation(
              "PreviewAutomationExecutionError",
              "That tab lives in a different managed browser profile.",
            );
          }
          // Reattaching adopts the current incarnation and drops refs from the one before it.
          existing.ref = ref;
          if (input.shareTab !== undefined) yield* setShared(existing, input.shareTab);
          const attached = yield* call<EngineTabResult>(existing, request, {
            kind: "attach",
            tabId: existing.engineTabId,
          });
          existing.documentId = attached.value.documentId;
          existing.refs = null;
          if (attached.value.url !== undefined) {
            existing.url = attached.value.url === "about:blank" ? null : attached.value.url;
          }
          if (attached.value.title !== undefined) existing.title = attached.value.title;
          if (url !== undefined) {
            const moved = yield* call<EngineTabResult>(existing, request, {
              kind: "execute",
              tabId: existing.engineTabId,
              documentId: existing.documentId,
              operation: { name: "navigate", url, waitUntil: "load" },
            });
            existing.documentId = moved.value.documentId;
            existing.url = url;
          }
          yield* persist(existing);
          yield* reportNav(existing);
          return yield* statusOf(existing, request);
        }

        if (joining !== undefined) {
          return yield* joinSession(
            request,
            input,
            binding,
            ref,
            agentSessionId,
            callerEnvironmentId,
            joining.engineTabId,
            url,
          );
        }

        // After a restart this thread's tabs are in the profile, not in memory: reattach them instead
        // of opening a second set beside them. Nothing is navigated unless the caller gave a url.
        if (reuse) {
          const recovered = yield* recoverTabs(
            request,
            binding,
            ref,
            agentSessionId,
            callerEnvironmentId,
          );
          if (recovered !== undefined) {
            if (url !== undefined) {
              const moved = yield* call<EngineTabResult>(recovered, request, {
                kind: "execute",
                tabId: recovered.engineTabId,
                documentId: recovered.documentId,
                operation: { name: "navigate", url, waitUntil: "load" },
              });
              recovered.documentId = moved.value.documentId;
              recovered.url = url;
              yield* persist(recovered);
              yield* reportNav(recovered);
            }
            const revealRecovered = input.open ?? input.show;
            if (revealRecovered !== false) {
              yield* manager
                .requestReveal({
                  threadId: request.threadId,
                  tabId: recovered.tabId,
                  force: revealRecovered === true,
                })
                .pipe(Effect.ignore);
            }
            return yield* statusOf(recovered, request);
          }
        }

        const owned = [...tabs.values()];
        if (
          owned.length >= SERVER_TAB_LIMIT ||
          owned.filter((tab) => tab.agentSessionId === agentSessionId).length >= AGENT_TAB_LIMIT
        ) {
          return yield* failOperation(
            "PreviewAutomationControlInterruptedError",
            "Too many managed browser tabs are open. Close one with t3_preview_close, or reuse a tabId.",
            "tabLimit",
          );
        }

        // The session is published for viewers, but its tab is registered first so the ordinary
        // browser, which mirrors every server session, finds it already claimed.
        const session = yield* publishSession(request.threadId, agentSessionId, url, { binding, ref });
        const tab: ManagedTab = {
          threadId: request.threadId,
          tabId: session.tabId,
          engineTabId: session.tabId,
          openerTabId: undefined,
          binding,
          agentSessionId,
          callerEnvironmentId,
          ref,
          shared: input.shareTab === true,
          documentId: "",
          url: null,
          title: "",
          refs: null,
          dialog: null,
          viewers: 0,
          sinks: new Set(),
          downloads: [],
          timeline: [],
        };
        remember(tab);
        reserved.delete(tabKey(tab.threadId, tab.tabId));
        const abandon = Effect.sync(() => forgetTab(tab)).pipe(
          Effect.andThen(unrecord(tab)),
          Effect.andThen(closeSession(tab)),
        );

        // Recorded before the browser opens it: a tab the record does not know would be orphaned by a
        // restart, while a record of a tab that never opened is simply dropped at the next attach.
        yield* persist(tab).pipe(Effect.tapError(() => abandon));
        const opened = yield* call<EngineTabResult>(tab, request, {
          kind: "open",
          tabId: tab.engineTabId,
          url: url ?? "about:blank",
        }, humanPrincipal === undefined ? undefined : { humanOpenPrincipal: humanPrincipal }).pipe(Effect.tapError(() => abandon));
        tab.documentId = opened.value.documentId;
        tab.url = url ?? null;
        tab.title = opened.value.title ?? "";
        yield* persistQuietly(tab);
        yield* reportNav(tab);
        const reveal = input.open ?? input.show;
        if (reveal !== false) {
          yield* manager
            .requestReveal({
              threadId: request.threadId,
              tabId: tab.tabId,
              force: reveal === true,
            })
            .pipe(Effect.ignore);
        }
        return yield* statusOf(tab, request);
      });

    const navigationUrl = (input: PreviewAutomationNavigateInput) => {
      if (input.url !== undefined) return normalizePreviewUrl(input.url);
      const target = input.target!;
      if (target.kind === "url") return normalizePreviewUrl(target.url);
      // The browser belongs to the owner, so `localhost` and its ports are the owner's loopback, whichever
      // environment the calling agent runs in.
      const path = target.path ?? "";
      return `${target.protocol ?? "http"}://localhost:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
    };

    const restoreLock = yield* Semaphore.make(1);

    const restoreHuman: ManagedBrowserPreviewAdapter["Service"]["restore"] = (instance) =>
      restoreLock.withPermits(1)(
        Effect.gen(function* () {
          if (registry.status._tag !== "ready") return;
          const pending = registry
            .tabs()
            .filter(
              (record) =>
                record.ownerEnvironmentId === ownerEnvironmentId &&
                record.instanceId === instance.instanceId &&
                record.profileId === instance.profileId &&
                record.agentSessionId.startsWith(HUMAN_SESSION_PREFIX) &&
                !record.closePending &&
                !participantsOf(record.instanceId, record.engineTabId).some(
                  (holder) => holder.threadId === record.threadId,
                ),
            );
          if (pending.length === 0) return;
          const binding = {
            ownerEnvironmentId,
            instanceId: ManagedBrowserInstanceId.make(instance.instanceId),
            profileId: ManagedBrowserProfileId.make(instance.profileId),
          };
          const ref = yield* supervisor.ensure(binding).pipe(Effect.mapError(toOperationError));
          yield* followOnce(ref);
          yield* finishPendingCloses(binding, ref);
          const owners = new Map(
            pending.map((record) => [`${record.threadId}\u0000${record.agentSessionId}`, record]),
          );
          for (const record of owners.values()) {
            yield* recoverTabs(
              {
                requestId: yield* uuid,
                threadId: record.threadId as ThreadId,
                agentSessionId: record.agentSessionId,
                callerEnvironmentId: ownerEnvironmentId,
                operation: "open",
                input: {},
                timeoutMs: 60_000,
              },
              binding,
              ref,
              record.agentSessionId,
              ownerEnvironmentId,
            );
          }
        }),
      );

    /**
     * The pages in a profile that someone shared on purpose, for an agent that holds a grant on it. The
     * grant is checked first, and only shared pages of that one profile are listed: an unshared page, or
     * one in another profile, is not described, so an id learned elsewhere confirms nothing.
     */
    const sharedTabs = (request: PreviewAutomationRequest) =>
      Effect.gen(function* () {
        const binding = previewAutomationBrowserBinding(request);
        if (binding === undefined) {
          return yield* failOperation(
            "PreviewAutomationExecutionError",
            "Listing shared tabs needs a browserBinding.",
          );
        }
        yield* policy
          .authorize({
            callerEnvironmentId: yield* callerEnvironmentOf(request),
            threadId: request.threadId,
            agentSessionId: yield* agentSessionOf(request),
            binding,
            access: "read",
          })
          .pipe(Effect.mapError(toOperationError));
        yield* restoreHuman(binding);
        const { tabs: listed } = yield* directory;
        return {
          browserBinding: binding,
          tabs: listed
            .filter(
              (tab) =>
                tab.shared &&
                tab.binding.instanceId === binding.instanceId &&
                tab.binding.profileId === binding.profileId,
            )
            .map((tab) => ({
              engineTabId: ManagedBrowserTabId.make(tab.engineTabId),
              incarnation: ManagedBrowserIncarnation.make(tab.incarnation),
              title: tab.title,
              url: tab.url,
              participants: tab.participants,
              phase: tab.phase,
              held: participantsOf(tab.binding.instanceId, tab.engineTabId).some(
                (holder) => holder.threadId === request.threadId,
              ),
            })),
        } satisfies PreviewAutomationSharedTabs;
      });

    const handle: ManagedBrowserPreviewAdapter["Service"]["handle"] = (request, humanOpen) =>
      Effect.gen(function* () {
        const input = request.input;
        if (request.operation === "open") {
          const open = input as PreviewAutomationOpenInput;
          if (humanOpen !== undefined && (
            request.agentSessionId !== `${HUMAN_SESSION_PREFIX}${humanOpen.sessionId}` ||
            request.callerEnvironmentId !== ownerEnvironmentId ||
            open.reuseExistingTab !== false || open.joinTab !== undefined
          )) return yield* failOperation("PreviewAutomationControlInterruptedError", "Authenticated human opening requires a fresh local tab.");
          return yield* openSession(request, open, humanOpen === undefined ? undefined : nativeControlPrincipal(humanOpen.sessionId));
        }
        if (request.operation === "sharedTabs") return yield* sharedTabs(request);
        const tab = yield* requireTab(request);
        // Leaving a tab others still hold changes nothing for them, so it needs no more than a look.
        const leaving =
          request.operation === "close" && tab.shared && (yield* otherParticipants(tab)).length > 0;
        // Grants are checked on every call, not only when the tab was opened: a revocation or an
        // expiry stops the next call, and a read grant cannot act.
        const authorizeAs = (access: ManagedBrowserGrantAccess) =>
          policy
            .authorize({
              callerEnvironmentId: request.callerEnvironmentId ?? tab.callerEnvironmentId,
              threadId: request.threadId,
              agentSessionId: tab.agentSessionId,
              binding: tab.binding,
              access,
            })
            .pipe(Effect.mapError(toOperationError));
        yield* authorizeAs(leaving ? "read" : accessForOperation(request.operation));
        if (request.operation === "status") return yield* statusOf(tab, request);

        // Answering a dialog must not queue behind the action that is waiting for it.
        if (request.operation === "dialog") {
          const dialog = input as PreviewAutomationDialogInput;
          const pending = tab.dialog;
          if (pending === null) {
            return yield* failOperation(
              "PreviewAutomationExecutionError",
              "No browser dialog is pending.",
            );
          }
          yield* call(
            tab,
            request,
            {
              kind: "execute",
              tabId: tab.engineTabId,
              documentId: tab.documentId,
              operation: {
                name: "dialog",
                dialogId: pending.dialogId,
                accept: dialog.accept,
                ...(dialog.promptText === undefined ? {} : { promptText: dialog.promptText }),
              },
            },
            { outOfBand: true },
          );
          tab.dialog = null;
          return yield* statusOf(tab, request);
        }

        if (request.operation === "close") {
          // A shared tab is closed by its last holder; anyone else only lets go of it.
          if ((yield* otherParticipants(tab)).length > 0) {
            yield* detach(tab);
            yield* closeSession(tab);
            return {};
          }
          // Closing the page itself is an action on it, whatever the reason this caller could leave.
          yield* authorizeAs("operate");
          yield* call(tab, request, { kind: "closeTab", tabId: tab.engineTabId });
          yield* dropOthers(tab);
          forgetTab(tab);
          yield* unrecord(tab);
          yield* closeSession(tab);
          return {};
        }

        if (tab.dialog !== null) {
          return yield* failOperation(
            "PreviewAutomationControlInterruptedError",
            "A browser dialog is pending. Read preview_status and use preview_dialog first.",
            "dialogPending",
          );
        }

        const base = { tabId: tab.engineTabId };
        switch (request.operation) {
          case "navigate": {
            const navigate = input as PreviewAutomationNavigateInput;
            const url = yield* Effect.try({
              try: () => navigationUrl(navigate),
              catch: () =>
                operationError(
                  "PreviewAutomationExecutionError",
                  "That address is not a valid URL.",
                ),
            });
            const readiness = navigate.readiness ?? "load";
            const moved = yield* recordAction(
              tab,
              "navigate",
              call<EngineTabResult>(tab, request, {
                kind: "execute",
                ...base,
                documentId: tab.documentId,
                operation: {
                  name: "navigate",
                  url,
                  waitUntil:
                    readiness === "domContentLoaded"
                      ? "domcontentloaded"
                      : readiness === "none"
                        ? "commit"
                        : "load",
                },
              }),
            );
            tab.documentId = moved.value.documentId;
            tab.refs = null;
            tab.url =
              moved.value.url === undefined || moved.value.url === "about:blank"
                ? url
                : moved.value.url;
            if (moved.value.title !== undefined) tab.title = moved.value.title;
            yield* reportNav(tab);
            yield* persistQuietly(tab);
            return yield* statusOf(tab, request);
          }
          case "snapshot":
            return yield* recordAction(tab, "snapshot", snapshotOf(tab, request));
          case "click": {
            const click = input as PreviewAutomationClickInput;
            if ((click.clickCount ?? 1) !== 1) {
              return yield* failUnsupported("Double and triple clicks");
            }
            const target = yield* resolveTarget(tab, request, click);
            yield* recordAction(
              tab,
              "click",
              call(tab, request, {
                kind: "execute",
                ...base,
                documentId: target.documentId,
                operation: {
                  name: "click",
                  target,
                  button: click.button ?? "left",
                },
              }),
            );
            return undefined;
          }
          case "hover": {
            const hover = input as PreviewAutomationHoverInput;
            const target = yield* resolveTarget(tab, request, hover);
            yield* recordAction(
              tab,
              "hover",
              call(tab, request, {
                kind: "execute",
                ...base,
                documentId: target.documentId,
                operation: { name: "hover", target },
              }),
            );
            return {};
          }
          case "select": {
            const select = input as PreviewAutomationSelectInput;
            const target = yield* resolveTarget(tab, request, select);
            yield* recordAction(
              tab,
              "select",
              call(tab, request, {
                kind: "execute",
                ...base,
                documentId: target.documentId,
                operation: { name: "select", target, values: [...select.values] },
              }),
            );
            // The engine confirms the selection happened; it does not echo the chosen options.
            return { selected: [...select.values] };
          }
          case "type": {
            const type = input as PreviewAutomationTypeInput;
            if (type.locator === undefined && type.selector === undefined) {
              // No target: the text goes to the focused element, which must take text.
              const editable = yield* call<{ value: unknown }>(tab, request, {
                kind: "execute",
                ...base,
                documentId: tab.documentId,
                operation: { name: "evaluate", expression: FOCUSED_EDITABLE, argument: null },
              });
              if (editable.value.value !== true) {
                return yield* Effect.fail(
                  operationError(
                    "PreviewAutomationTargetNotEditableError",
                    "The focused element does not take text. Click a field first, or pass a locator.",
                    { selectorKind: "focused-element" },
                  ),
                );
              }
              yield* recordAction(
                tab,
                "type",
                keyboard(tab, request, [
                  ...(type.clear === true
                    ? [...chord(["Control", "a"]), ...chord(["Backspace"])]
                    : []),
                  { name: "text", text: type.text },
                ]),
              );
              return {};
            }
            const target = yield* resolveTarget(tab, request, type);
            yield* recordAction(
              tab,
              "type",
              call(tab, request, {
                kind: "execute",
                ...base,
                documentId: target.documentId,
                operation:
                  type.clear === true
                    ? { name: "fill", target, value: type.text }
                    : { name: "type", target, value: type.text, delayMs: 0 },
              }),
            );
            return {};
          }
          case "press": {
            const press = input as PreviewAutomationPressInput;
            // The key goes to whatever has focus in the page, as a keyboard's would.
            yield* recordAction(
              tab,
              "press",
              keyboard(tab, request, chord([...(press.modifiers ?? []), press.key])),
            );
            return {};
          }
          case "evaluate": {
            const evaluate = input as PreviewAutomationEvaluateInput;
            const result = yield* call<{ value: unknown }>(tab, request, {
              kind: "execute",
              ...base,
              documentId: tab.documentId,
              operation: { name: "evaluate", expression: evaluate.expression, argument: null },
            });
            return result.value.value;
          }
          case "upload": {
            const upload = input as PreviewAutomationUploadInput;
            if (upload.locator === undefined || upload.selector !== undefined) {
              return yield* failUnsupported(
                "Answering an open file picker or targeting a file input by selector",
              );
            }
            if (upload.paths.length === 0 || upload.paths.length > UPLOAD_MAX_FILES) {
              return yield* failOperation(
                "PreviewAutomationExecutionError",
                `Give between 1 and ${UPLOAD_MAX_FILES} files.`,
              );
            }
            const target = yield* resolveTarget(tab, request, upload);
            const artifactIds: string[] = [];
            return yield* recordAction(
              tab,
              "upload",
              Effect.gen(function* () {
                for (const path of upload.paths) {
                  artifactIds.push(yield* sendFile(tab, request, path));
                }
                yield* call(tab, request, {
                  kind: "execute",
                  ...base,
                  documentId: target.documentId,
                  operation: { name: "upload", target, artifactIds },
                });
                return {};
              }).pipe(
                // The files were handed to the page; the browser keeps no copy a maintenance would wait on.
                Effect.ensuring(
                  Effect.forEach(artifactIds, (id) => releaseUpload(tab, request, id), {
                    discard: true,
                  }),
                ),
              ),
            );
          }
          case "scroll":
            return yield* failUnsupported("Scrolling");
          case "waitFor":
            return yield* failUnsupported("Waiting for a condition");
          case "drag":
            return yield* failUnsupported("Drag and drop");
          case "resize":
            return yield* failUnsupported("Resizing the viewport");
          case "setColorScheme":
            return yield* failUnsupported("Changing the color scheme");
          case "recordingStart":
          case "recordingStop":
            return yield* failUnsupported("Recording");
          default:
            return yield* failUnsupported(`The ${String(request.operation)} operation`);
        }
      }).pipe(Effect.mapError(toOperationError));

    /**
     * A named open is ours. So is anything aimed at a managed tab, except an open that asks for a new
     * tab: the broker keeps pointing an agent's current tab at its last result, but `reuseExistingTab:
     * false` is a request for an ordinary tab and must not be served from the managed one.
     */
    const claims: ManagedBrowserPreviewAdapter["Service"]["claims"] = (request) => {
      if (request.operation === "sharedTabs") return true;
      if (request.operation === "open") {
        const open = request.input as PreviewAutomationOpenInput | undefined;
        if (open?.browserBinding !== undefined) return true;
        return (
          (open?.reuseExistingTab ?? true) &&
          request.tabId !== undefined &&
          owns(request.threadId, request.tabId)
        );
      }
      return request.tabId !== undefined && owns(request.threadId, request.tabId);
    };

    // --- viewers ----------------------------------------------------------------

    const attachViewer: ManagedBrowserPreviewAdapter["Service"]["attachViewer"] = (input) =>
      Effect.suspend(() => {
        const tab = tabs.get(tabKey(input.threadId, input.tabId));
        if (tab === undefined)
          return Effect.fail(new ManagedBrowserViewerError({ reason: "notFound" }));
        // An unauthorized viewer is told the tab does not exist, exactly as for a tab that does not.
        const authorizeViewer = policy.authorizeViewer ?? administratorsOnly;
        return ManagedBrowserViewer.attach({
          tab,
          input,
          supervisor,
          crypto,
          connections,
          fullWindow: options.fullWindow,
          authorize: (access) =>
            authorizeViewer({ viewer: input.viewer, binding: tab.binding, access }),
          recordNavigation: (navigated) =>
            reportNav(navigated).pipe(Effect.andThen(persistQuietly(navigated))),
        });
      });

    const openDownload: ManagedBrowserPreviewAdapter["Service"]["openDownload"] = (
      threadId,
      tabId,
      downloadId,
      viewer,
    ) =>
      Effect.gen(function* () {
        const tab = tabs.get(tabKey(threadId, tabId));
        const found = tab?.downloads.find((candidate) => candidate.id === downloadId);
        if (tab === undefined || found === undefined) return Option.none();
        const admitted = yield* (policy.authorizeViewer ?? administratorsOnly)({
          viewer,
          binding: tab.binding,
          access: "read",
        }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        return admitted
          ? Option.some({ path: found.path, fileName: found.fileName })
          : Option.none();
      });

    const openAgentDownload: ManagedBrowserPreviewAdapter["Service"]["openAgentDownload"] = (
      request,
      downloadId,
    ) =>
      Effect.gen(function* () {
        const tab = yield* requireTab(request);
        yield* policy.authorize({
          callerEnvironmentId: request.callerEnvironmentId ?? tab.callerEnvironmentId,
          threadId: request.threadId,
          agentSessionId: tab.agentSessionId,
          binding: tab.binding,
          access: "read",
        });
        const found = tab.downloads.find((candidate) => candidate.id === downloadId);
        return found === undefined
          ? Option.none()
          : Option.some({ path: found.path, fileName: found.fileName });
      }).pipe(Effect.orElseSucceed(() => Option.none()));

    const directory: ManagedBrowserPreviewAdapter["Service"]["directory"] = Effect.gen(
      function* () {
        // One row per page: chats that joined the same page are participants of it, not copies.
        const rows = new Map<string, ManagedBrowserDirectoryTab>();
        for (const tab of tabs.values()) {
          const key = engineKey(tab.binding.instanceId, tab.engineTabId);
          if (rows.has(key)) continue;
          const holders = participantsOf(tab.binding.instanceId, tab.engineTabId);
          const lease = yield* supervisor.state(tab.ref).pipe(
            Effect.map((state) => ({ phase: state.phase, holder: state.holder })),
            Effect.orElseSucceed(() => ({ phase: "unavailable" as const, holder: null })),
          );
          rows.set(key, {
            binding: tab.binding,
            engineTabId: tab.engineTabId,
            incarnation: tab.ref.incarnation,
            hostThreadId: tab.threadId,
            hostTabId: tab.tabId,
            title: tab.title,
            url: tab.url,
            shared: holders.some((holder) => holder.shared),
            participants: holders.length,
            phase: lease.phase,
            holder: lease.holder,
          });
        }
        return {
          instances: registry
            .instances()
            .map(({ instanceId, profileId }) => ({ instanceId, profileId })),
          tabs: [...rows.values()],
        };
      },
    );

    const setSharing: ManagedBrowserPreviewAdapter["Service"]["setSharing"] = (
      threadId,
      tabId,
      shared,
    ) => {
      const tab = tabs.get(tabKey(threadId, tabId));
      return tab === undefined
        ? Effect.succeed(false)
        : setShared(tab, shared).pipe(Effect.as(true), Effect.mapError(toOperationError));
    };

    const setControl: ManagedBrowserPreviewAdapter["Service"]["setControl"] = (input) => {
      const tab = tabs.get(tabKey(input.threadId, input.tabId));
      if (tab === undefined) return Effect.succeed(false);
      const principal = nativeControlPrincipal(input.sessionId);
      const change =
        input.action === "take"
          ? supervisor.takeControl(principal, tab.ref).pipe(Effect.mapError(toOperationError))
          : supervisor.releaseControl(principal, tab.ref).pipe(Effect.mapError(toOperationError));
      return change.pipe(Effect.as(true));
    };

    return ManagedBrowserPreviewAdapter.of({
      enabled: true,
      owns,
      claims,
      handle,
      attachViewer,
      sessionClosed,
      openDownload,
      openAgentDownload,
      directory,
      restore: restoreHuman,
      setControl,
      setSharing,
    });
  });

export const layer = (options: ManagedBrowserPreviewAdapterOptions = {}) =>
  Layer.effect(ManagedBrowserPreviewAdapter, make(options));

/** The same adapter, offered as the one for browsers this server hosts. */
export const localLayer = (options: ManagedBrowserPreviewAdapterOptions = {}) =>
  Layer.effect(ManagedBrowserLocalAdapter, make(options));

/** Stands in when no managed browser component is configured: a named open fails by name. */
export const disabledAdapter = ManagedBrowserPreviewAdapter.of({
  enabled: false,
  owns: () => false,
  claims: (request) => previewAutomationBrowserBinding(request) !== undefined,
  handle: () =>
    Effect.fail(
      operationError(
        "PreviewAutomationUnsupportedClientError",
        "No managed browser is configured on this server, so a named browser session cannot be opened. No temporary browser is substituted.",
      ),
    ),
  attachViewer: () => Effect.fail(new ManagedBrowserViewerError({ reason: "notFound" })),
  sessionClosed: () => Effect.succeed({ _tag: "notManaged" } as const),
  openDownload: () => Effect.succeedNone,
  openAgentDownload: () => Effect.succeedNone,
  directory: Effect.succeed({ instances: [], tabs: [] }),
  restore: () => Effect.void,
  setControl: () => Effect.succeed(false),
  setSharing: () => Effect.succeed(false),
});

export const disabledLayer = Layer.succeed(ManagedBrowserPreviewAdapter, disabledAdapter);
export const disabledLocalLayer = Layer.succeed(ManagedBrowserLocalAdapter, disabledAdapter);
