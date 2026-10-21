/**
 * ManagedBrowserTab - one managed tab as the adapter and its viewers share it.
 *
 * The adapter owns every tab and the maps that find it; a viewer attached to a tab reads and updates only
 * the page state kept here (document, address, refs, dialog, viewer count and sinks). Nothing in this module
 * reaches the registry, the directory or another thread's tab.
 *
 * @module ManagedBrowserTab
 */
import type {
  EnvironmentId,
  ManagedBrowserPrincipal,
  ManagedBrowserRef,
  PreviewAutomationBrowserBinding,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ServerBrowserViewerOutput } from "../preview/ServerBrowser.ts";
import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";

/** Refs are good for one document and one control generation, exactly as the tool promises. */
export interface RefScope {
  readonly documentId: string;
  readonly generation: number;
  readonly ids: ReadonlySet<string>;
}

export interface PendingDialog {
  readonly dialogId: string;
  readonly type: string;
  readonly message: string;
  readonly defaultValue: string;
}

/** A file the browser downloaded in a tab, copied onto this environment's disk. */
export interface ManagedDownload {
  readonly id: string;
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly completedAt: string;
}

/** A viewer attached to a tab, so a download can be offered to whoever is driving the page. */
export interface ViewerSink {
  readonly principalId: ManagedBrowserPrincipal["id"];
  readonly push: (message: ServerBrowserViewerOutput) => void;
}

export interface ManagedTab {
  readonly threadId: string;
  /** The preview session's tab id, minted by this server run. */
  readonly tabId: string;
  /** The engine's tab id. It is what survives a restart, and what every engine call names. */
  readonly engineTabId: string;
  /** The preview session of the page that opened this one, for a popup. */
  readonly openerTabId: string | undefined;
  readonly binding: PreviewAutomationBrowserBinding;
  /** The agent session that opened it, which alone may act on it as an agent. */
  agentSessionId: string;
  readonly callerEnvironmentId: EnvironmentId;
  ref: ManagedBrowserRef;
  /** Whether other granted threads may join this engine tab. Equal for every participant of one tab. */
  shared: boolean;
  documentId: string;
  url: string | null;
  title: string;
  refs: RefScope | null;
  dialog: PendingDialog | null;
  viewers: number;
  readonly sinks: Set<ViewerSink>;
  readonly downloads: Array<ManagedDownload>;
  readonly timeline: Array<PreviewAutomationSnapshot["actionTimeline"][number]>;
}

/** The deadline for an engine call that only reads or changes state, never navigates or waits. */
export const ENGINE_STATE_DEADLINE_MS = 5_000;

/** What a navigation or action returns about the page it ended on. */
export type EngineTabResult = {
  readonly documentId: string;
  readonly url?: string;
  readonly title?: string;
};

export const isEngineEvent = Schema.is(ManagedBrowserIpc.EngineEventFrame);
