/**
 * ManagedBrowserViewer - one person's view of a managed tab, and the input they may send it.
 *
 * Attaching admits a viewer to a tab the adapter already holds: reading needs a viewer grant, driving needs
 * both the client's scope and an operate grant, and every input checks that authority again. A viewer is a
 * principal of its own (stable across reconnects when it names itself), takes control explicitly, and has
 * its input forwarded to the engine only while it holds the lease. Disconnecting closes nothing; the hold on
 * a lease starts when the principal's last connection is gone.
 *
 * The adapter owns the tab, the directory and the durable record. This module reads and updates only the
 * page state in {@link ManagedTab}, and reports a navigation a person made back through
 * {@link ManagedBrowserViewerContext.recordNavigation}.
 *
 * @module ManagedBrowserViewer
 */
import {
  ManagedBrowserPrincipalId,
  type ManagedBrowserAccess as ManagedBrowserGrantAccess,
  type ManagedBrowserControlState,
  type ManagedBrowserPrincipal,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import type { ServerBrowserViewer, ServerBrowserViewerOutput } from "../preview/ServerBrowser.ts";
import type { ManagedBrowserAccessNotGrantedError } from "./ManagedBrowserAccess.ts";
import { tagOf } from "./ManagedBrowserOperationError.ts";
import {
  ENGINE_STATE_DEADLINE_MS,
  isEngineEvent,
  type EngineTabResult,
  type ManagedTab,
  type ViewerSink,
} from "./ManagedBrowserTab.ts";
import type * as ManagedBrowserSupervisor from "./ManagedBrowserSupervisor.ts";
import { viewerInputOf, windowInputOf } from "./ManagedBrowserViewerInput.ts";

/** Who is watching: an authenticated session of the owner, from the stream route. */
export interface ManagedBrowserViewerIdentity {
  readonly sessionId: string;
  /** Whether the session may mint grants, which makes withholding a view from it meaningless. */
  readonly administrator: boolean;
}

/** What a viewer holds once admitted: `ended` completes when the authority behind it is gone. */
export interface ManagedBrowserViewerAuthority {
  readonly ended: Effect.Effect<void>;
}

/** Why a viewer could not attach. The stream route turns these into its own close codes. */
export class ManagedBrowserViewerError extends Schema.TaggedError<ManagedBrowserViewerError>()(
  "ManagedBrowserViewerError",
  { reason: Schema.Literals(["notFound", "unavailable"]), cause: Schema.optional(Schema.Defect()) },
) {}

export interface ManagedBrowserViewerInput {
  readonly threadId: string;
  readonly tabId: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly canOperate: boolean;
  /** Who is watching, from the authenticated stream request. Without it only a local trusted caller may see a tab. */
  readonly viewer: ManagedBrowserViewerIdentity | undefined;
  /**
   * Names this viewer across reconnects (a browser tab's own id). With it, control held for a dropped
   * viewer can be resumed by that viewer alone; without it every connection is a new, unrelated viewer.
   */
  readonly viewerKey?: string;
}

const VIEWER_OUTPUT_LIMIT = 64;
/** What a viewer may call itself across reconnects: a short opaque token, never anything with structure. */
const VIEWER_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** Whether the element under a point takes typed text: the same test the ordinary browser's viewer uses. */
const EDITABLE_AT_POINT_SCRIPT = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
}`;

/** What the adapter hands a viewer: its tab, its authority checks, and the shared state it must keep straight. */
export interface ManagedBrowserViewerContext {
  readonly tab: ManagedTab;
  readonly input: ManagedBrowserViewerInput;
  readonly supervisor: ManagedBrowserSupervisor.ManagedBrowserSupervisor["Service"];
  readonly crypto: Crypto.Crypto;
  /** Open viewer connections by principal, so one dropping while another remains starts no hold. */
  readonly connections: Map<string, number>;
  /** What this server offers for the whole Chrome window; the child's own advertisement still decides. */
  readonly fullWindow:
    | { readonly available: boolean; readonly reason?: string | undefined }
    | undefined;
  /** Whether this viewer may `read` (watch) or `operate` (drive) the tab, decided by the owner's policy now. */
  readonly authorize: (
    access: ManagedBrowserGrantAccess,
  ) => Effect.Effect<ManagedBrowserViewerAuthority, ManagedBrowserAccessNotGrantedError>;
  /** A person navigated the tab: the adapter reports the status and saves the durable record. */
  readonly recordNavigation: (tab: ManagedTab) => Effect.Effect<void>;
}

export const attach = (
  context: ManagedBrowserViewerContext,
): Effect.Effect<ServerBrowserViewer, ManagedBrowserViewerError, Scope.Scope> =>
  Effect.gen(function* () {
    const { tab, input, supervisor, connections } = context;
    const viewerAccess = context.authorize;
    // An unauthorized viewer is told the tab does not exist, exactly as for a tab that does not.
    const authority = yield* viewerAccess("read").pipe(
      Effect.mapError(() => new ManagedBrowserViewerError({ reason: "notFound" })),
    );
    // Reading is all a grant may allow; driving needs both the client's scope and an operate grant.
    const canOperate =
      input.canOperate &&
      (yield* viewerAccess("operate").pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
    const viewerId = yield* context.crypto.randomUUIDv4.pipe(Effect.orDie);
    // A viewer that names itself keeps its identity across reconnects, so control held for it is
    // its to resume. The session is part of the identity: another session cannot claim the same name.
    const stableViewer =
      input.viewer !== undefined &&
      input.viewerKey !== undefined &&
      VIEWER_KEY.test(input.viewerKey)
        ? `${input.viewer.sessionId}:${input.viewerKey}`
        : undefined;
    const principal: ManagedBrowserPrincipal = {
      id: ManagedBrowserPrincipalId.make(
        (stableViewer === undefined
          ? `human:viewer-${viewerId}`
          : `human:session-${stableViewer}`
        ).slice(0, 512),
      ),
      kind: "human",
      access: canOperate ? "operate" : "read",
    };
    const subscriptionIds = {
      page: `viewer-${viewerId}`,
      window: `viewer-${viewerId}-window`,
    } as const;
    let surface: "page" | "window" = "page";
    let subscriptionId: string = subscriptionIds.page;
    /** The size of the last frame, which is the coordinate space a viewer's pointer is mapped into. */
    let frameSize: { readonly width: number; readonly height: number } | null = null;
    const caller = {
      environmentId: tab.callerEnvironmentId,
      threadId: input.threadId,
      agentSessionId: `viewer:${viewerId}`,
    };
    const ref = tab.ref;
    const unavailable = (cause: unknown) =>
      new ManagedBrowserViewerError({ reason: "unavailable", cause });
    const output = yield* Queue.make<ServerBrowserViewerOutput>({
      capacity: VIEWER_OUTPUT_LIMIT,
      strategy: "dropping",
    });
    const push = (message: ServerBrowserViewerOutput) => Queue.offer(output, message);

    const controlOf = (state: ManagedBrowserControlState): ServerBrowserViewerOutput => ({
      _tag: "control",
      canOperate,
      controller:
        state.phase === "agent"
          ? "agent"
          : state.phase === "human"
            ? state.holder === principal.id
              ? "you"
              : "another-viewer"
            : state.phase === "reconnectHold"
              ? state.holder === principal.id
                ? "held-for-you"
                : "another-viewer"
              : state.phase === "paused"
                ? "paused"
                : "unclaimed",
      ...(state.phase === "reconnectHold" && state.holdExpiresAtMs !== null
        ? { holdExpiresAtMs: state.holdExpiresAtMs }
        : {}),
      generation: Number(state.fence.generation),
      dialog:
        tab.dialog === null
          ? null
          : {
              type: tab.dialog.type,
              message: tab.dialog.message,
              defaultValue: tab.dialog.defaultValue,
            },
    });

    const events = yield* supervisor.events(principal, ref).pipe(Effect.mapError(unavailable));
    yield* events.pipe(
      Stream.runForEach((raw) =>
        Effect.gen(function* () {
          if (!isEngineEvent(raw)) return;
          // Only the surface being shown: a late frame of the one just left is dropped, never painted.
          if (raw.name === "frame" && raw.subscriptionId === subscriptionId) {
            // A page frame is the page at one CSS pixel per pixel; a window frame is the desktop. Either
            // way the frame's size is the space pointer coordinates are in, and the viewer is told when it changes.
            if (frameSize?.width !== raw.width || frameSize?.height !== raw.height) {
              frameSize = { width: raw.width, height: raw.height };
              yield* push({ _tag: "viewport", ...frameSize });
            }
            yield* push({
              _tag: "frame",
              data: Buffer.from(raw.bytesBase64, "base64"),
              ack: supervisor
                .scoped(principal, ref, {
                  kind: "ack",
                  caller,
                  subscriptionId: raw.subscriptionId,
                  frameId: raw.frameId,
                })
                .pipe(Effect.ignore),
            });
          } else if (raw.name === "tabClosed" && raw.ref.tabId === tab.engineTabId) {
            yield* push({ _tag: "gone" });
          } else if (raw.name === "dialog" && raw.ref.tabId === tab.engineTabId) {
            // The tab's own follower records the dialog too; whichever hears first sets it, so the
            // control state sent below never lacks the dialog that caused it.
            tab.dialog = {
              dialogId: raw.dialogId,
              type: raw.type,
              message: raw.message,
              defaultValue: raw.defaultValue,
            };
            const state = yield* supervisor.state(ref).pipe(Effect.option);
            if (Option.isSome(state)) yield* push(controlOf(state.value));
          }
        }),
      ),
      // The incarnation ended; the tab is still known, so the viewer reconnects.
      Effect.andThen(push({ _tag: "reconnect" })),
      Effect.forkScoped,
    );

    const states = yield* supervisor.subscribe(principal, ref).pipe(Effect.mapError(unavailable));
    yield* states.pipe(
      Stream.runForEach((state) => push(controlOf(state))),
      Effect.forkScoped,
    );

    /**
     * The whole window is a fixed 1280x720 desktop the engine refuses to show at a smaller size,
     * so it is always asked for at least that, however small the viewer. Subscribing never selects
     * a tab or moves focus: viewing the display is not an action in the page.
     */
    const subscribeTo = (target: "page" | "window") =>
      supervisor.scoped(principal, ref, {
        kind: "subscribe",
        caller,
        tabId: tab.engineTabId,
        subscriptionId: subscriptionIds[target],
        surface: target,
        maxFps: target === "window" ? 10 : 15,
        maxWidth: Math.max(target === "window" ? 1280 : 100, Math.min(input.maxWidth, 4096)),
        maxHeight: Math.max(target === "window" ? 720 : 100, Math.min(input.maxHeight, 4096)),
      });
    yield* subscribeTo("page").pipe(Effect.mapError(unavailable));

    // Whether the whole window can be shown: this server offers it and the engine said it can.
    const advertised = yield* supervisor
      .capabilities(ref)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const offered = context.fullWindow ?? { available: true };
    const windowSupport: { readonly available: boolean; readonly reason?: string } =
      offered.available && advertised.includes("full-window")
        ? { available: true }
        : {
            available: false,
            reason:
              offered.reason ??
              "This browser could not start the full window view. Page view is available.",
          };
    const announceSurface = Effect.suspend(() =>
      push({ _tag: "surface", current: surface, window: windowSupport }),
    );
    const switching = yield* Semaphore.make(1);
    // The stream ends the moment the grant behind it is revoked or expires.
    yield* authority.ended.pipe(Effect.andThen(push({ _tag: "gone" })), Effect.forkScoped);
    tab.viewers += 1;
    const sink: ViewerSink = {
      principalId: principal.id,
      push: (message) => {
        Queue.offerUnsafe(output, message);
      },
    };
    tab.sinks.add(sink);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        tab.viewers = Math.max(0, tab.viewers - 1);
        tab.sinks.delete(sink);
        // Disconnecting closes nothing: the tab and its profile stay. A held lease starts its hold.
        yield* supervisor
          .scoped(principal, ref, { kind: "unsubscribe", caller, subscriptionId })
          .pipe(Effect.ignore);
        // A reconnecting viewer overlaps its old socket; the hold starts when the last one is gone.
        const remaining = (connections.get(principal.id) ?? 1) - 1;
        if (remaining > 0) connections.set(principal.id, remaining);
        else {
          connections.delete(principal.id);
          yield* supervisor.holderDisconnected(principal.id, ref);
        }
      }),
    );
    connections.set(principal.id, (connections.get(principal.id) ?? 0) + 1);
    const initial = yield* supervisor.state(ref).pipe(Effect.option);
    if (Option.isSome(initial)) yield* push(controlOf(initial.value));
    yield* announceSurface;

    /** What a viewer is told when its message did nothing, so no message is dropped without a word. */
    const reject = (type: string, reason: string) =>
      push({ _tag: "rejected", type, reason }).pipe(
        Effect.andThen(Effect.logDebug("managed browser viewer message refused", { type, reason })),
      );

    /** Runs one fenced engine call as this viewer, which holds the lease when it gets here. */
    const asViewer = (
      fence: ManagedBrowserControlState["fence"],
      command: Record<string, unknown>,
    ) =>
      supervisor.execute(
        principal,
        ref,
        fence,
        { ...command, caller },
        { deadlineMs: ENGINE_STATE_DEADLINE_MS },
      );

    const evaluateAsViewer = (fence: ManagedBrowserControlState["fence"], expression: string) =>
      asViewer(fence, {
        kind: "execute",
        tabId: tab.engineTabId,
        documentId: tab.documentId,
        operation: { name: "evaluate", expression, argument: null },
      });

    /**
     * Taking control is explicit, as in the ordinary browser: a viewer asks for it, and only the
     * lease's holder has its input forwarded. A message from a viewer that does not hold it is
     * refused with the current control state, so the viewer shows who does.
     */
    /**
     * Changes what this viewer is shown. Watching is not acting, so a read-only viewer may do it. The new
     * subscription is made before the old one is dropped, and a refusal leaves the viewer exactly where
     * it was, told why, so the screen is never blank because a switch failed.
     */
    const switchSurface = (target: unknown) =>
      switching.withPermits(1)(
        Effect.gen(function* () {
          if (target !== "page" && target !== "window") {
            return yield* reject("surface", "Choose the page or the full window.");
          }
          if (Option.isNone(yield* viewerAccess("read").pipe(Effect.option))) {
            return yield* push({ _tag: "gone" });
          }
          if (target === surface) return yield* announceSurface;
          if (target === "window" && !windowSupport.available) {
            yield* reject("surface", windowSupport.reason ?? "The full window is not available.");
            return yield* announceSurface;
          }
          const subscribed = yield* subscribeTo(target).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!subscribed) {
            yield* reject(
              "surface",
              target === "window"
                ? "The browser could not show the full window. Page view is still available."
                : "The browser could not show the page.",
            );
            return yield* announceSurface;
          }
          const previous = subscriptionId;
          surface = target;
          subscriptionId = subscriptionIds[target];
          frameSize = null;
          yield* supervisor
            .scoped(principal, ref, { kind: "unsubscribe", caller, subscriptionId: previous })
            .pipe(Effect.ignore);
          yield* announceSurface;
        }),
      );

    const receive = (message: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "surface"
        ) {
          return yield* switchSurface((message as { surface?: unknown }).surface);
        }
        if (!canOperate) return;
        // Authority is checked again for every input: a grant revoked a moment ago must not act.
        const stillAllowed = yield* viewerAccess("operate").pipe(Effect.option);
        if (Option.isNone(stillAllowed)) return yield* push({ _tag: "gone" });
        const record =
          typeof message === "object" && message !== null && !Array.isArray(message)
            ? (message as Record<string, unknown>)
            : undefined;
        const type = typeof record?.type === "string" ? record.type : undefined;
        if (record === undefined || type === undefined) {
          return yield* reject("unknown", "The message was not understood.");
        }
        if (type === "takeControl") {
          return yield* supervisor.takeControl(principal, ref).pipe(
            Effect.asVoid,
            Effect.catch(() =>
              supervisor.state(ref).pipe(
                Effect.flatMap((state) => push(controlOf(state))),
                Effect.andThen(
                  reject(
                    type,
                    "Control cannot be taken now: someone else holds it, or the browser is changing.",
                  ),
                ),
                Effect.ignore,
              ),
            ),
          );
        }
        if (type === "releaseControl") {
          return yield* supervisor.releaseControl(principal, ref).pipe(
            Effect.asVoid,
            Effect.catch(() => reject(type, "You do not hold control.")),
          );
        }
        if (type === "viewport") {
          return yield* reject(
            type,
            "A managed browser tab follows the viewer's size; a fixed viewport cannot be set.",
          );
        }
        const current = yield* supervisor.state(ref);
        if (current.phase !== "human" || current.holder !== principal.id) {
          yield* push(controlOf(current));
          return yield* reject(type, "You do not control this tab. Take control first.");
        }
        const fence = current.fence;

        if (type === "dialog") {
          const pending = tab.dialog;
          if (pending === null || typeof record.accept !== "boolean") {
            return yield* reject(type, "There is no dialog to answer.");
          }
          yield* supervisor.execute(
            principal,
            ref,
            fence,
            {
              kind: "execute",
              caller,
              tabId: tab.engineTabId,
              documentId: tab.documentId,
              operation: {
                name: "dialog",
                dialogId: pending.dialogId,
                accept: record.accept,
                ...(typeof record.promptText === "string" ? { promptText: record.promptText } : {}),
              },
            },
            { deadlineMs: ENGINE_STATE_DEADLINE_MS, outOfBand: true },
          );
          tab.dialog = null;
          const after = yield* supervisor.state(ref);
          return yield* push(controlOf(after));
        }
        if (type === "navigate") {
          const raw = typeof record.url === "string" ? record.url : "";
          const url = yield* Effect.try({
            try: () => normalizePreviewUrl(raw),
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (url === undefined) return yield* reject(type, "That address is not a valid URL.");
          const moved = (yield* asViewer(fence, {
            kind: "execute",
            tabId: tab.engineTabId,
            documentId: tab.documentId,
            operation: { name: "navigate", url, waitUntil: "load" },
          })) as EngineTabResult;
          tab.documentId = moved.documentId;
          tab.refs = null;
          tab.url = url;
          return yield* context.recordNavigation(tab);
        }
        if (type === "history") {
          const delta = typeof record.delta === "number" ? record.delta : 0;
          if (delta === 0) return yield* reject(type, "A history step needs a direction.");
          yield* evaluateAsViewer(fence, delta < 0 ? "history.back()" : "history.forward()");
          return;
        }
        if (type === "reload") {
          if (record.ignoreCache === true) {
            return yield* reject(
              type,
              "A hard reload that skips the cache is not supported here; use a normal reload.",
            );
          }
          yield* evaluateAsViewer(fence, "location.reload()");
          return;
        }
        if (type === "probe" && surface === "window") {
          // A point in the window is not a point in the page, so nothing can say whether it takes text;
          // every tap may, which is the only answer that never keeps a person from typing.
          const x = typeof record.x === "number" && Number.isFinite(record.x) ? record.x : 0;
          const y = typeof record.y === "number" && Number.isFinite(record.y) ? record.y : 0;
          return yield* push({ _tag: "probe", x, y, editable: true });
        }
        if (type === "probe") {
          const x = typeof record.x === "number" && Number.isFinite(record.x) ? record.x : 0;
          const y = typeof record.y === "number" && Number.isFinite(record.y) ? record.y : 0;
          const answer = (yield* evaluateAsViewer(
            fence,
            `(${EDITABLE_AT_POINT_SCRIPT})(${x}, ${y})`,
          )) as { readonly value?: unknown };
          return yield* push({ _tag: "probe", x, y, editable: answer.value === true });
        }
        const mapped = surface === "window" ? windowInputOf(record) : viewerInputOf(record);
        // A fixed-size window is not resized by the viewer's layout, and that is not a failure.
        if (surface === "window" && record.type === "resize") return;
        const wire = mapped;
        if (wire === undefined) {
          return yield* reject(
            type,
            "That input is not supported in a managed browser tab or was malformed.",
          );
        }
        yield* asViewer(fence, {
          kind: "viewerInput",
          tabId: tab.engineTabId,
          documentId: tab.documentId,
          subscriptionId,
          input: wire,
        });
      }).pipe(
        Effect.catch((error) =>
          reject("input", `The browser could not apply that: ${tagOf(error) ?? "failed"}.`),
        ),
        Effect.ignore,
      );

    const viewer: ServerBrowserViewer = { output, input: receive };
    return viewer;
  });
