// Public protocol v1 types. Runtime validation and JSON schemas live in protocol.ts.
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface BrowserRef {
  instanceId: string;
  profileId: string;
  tabId: string;
  incarnation: string;
}
export interface Caller {
  environmentId: string;
  threadId: string;
  agentSessionId: string;
  callerId?: string;
  kind?: "agent" | "human" | "supervisor";
}
export interface Resource {
  instanceId: string;
  profileId: string;
  ownerEnvironmentId?: string;
  sessionId?: string;
  browserName?: string;
}
export interface Fence {
  incarnation: string;
  generation: number;
}
export interface Scope {
  resource: Resource;
  caller: Caller;
}
export interface FencedScope extends Scope {
  fence: Fence;
}
export interface Target {
  ref: string;
  documentId: string;
}
export type Operation =
  | {
      name: "navigate";
      url: string;
      waitUntil: "commit" | "domcontentloaded" | "load";
    }
  | { name: "snapshot"; format: "aria" | "text" | "html" }
  | { name: "screenshot"; format: "png" | "jpeg"; fullPage: boolean }
  | { name: "click"; target: Target; button: "left" | "middle" | "right" }
  | { name: "fill"; target: Target; value: string }
  | { name: "type"; target: Target; value: string; delayMs: number }
  | { name: "press"; target: Target; key: string }
  | { name: "select"; target: Target; values: string[] }
  | { name: "check"; target: Target; checked: boolean }
  | { name: "hover"; target: Target }
  | { name: "evaluate"; expression: string; argument: Json }
  | { name: "dialog"; dialogId: string; accept: boolean; promptText?: string }
  | { name: "upload"; target: Target; artifactIds: string[] }
  | { name: "console" | "network"; cursor?: number; limit: number }
  | { name: "recording.start"; fps: number; maxDurationMs: number }
  | { name: "recording.stop"; recordingId: string };
export type Input =
  | {
      name: "pointer";
      action: "move" | "down" | "up";
      x: number;
      y: number;
      button: "left" | "middle" | "right";
    }
  | { name: "wheel"; deltaX: number; deltaY: number }
  | { name: "key"; action: "down" | "up"; key: string }
  | { name: "text"; text: string }
  | { name: "viewport"; width: number; height: number };
export type Upload = FencedScope &
  (
    | {
        action: "begin";
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
      }
    | {
        action: "write";
        artifactId: string;
        offset: number;
        bytesBase64: string;
      }
    | { action: "finish" | "release"; artifactId: string }
  );
export type Download = Scope &
  (
    | { action: "read"; artifactId: string; offset: number; length: number }
    | { action: "release"; artifactId: string }
  );
export interface MethodParams {
  hello: { protocolVersion: 1; adapterVersion: string };
  open: FencedScope & {
    tabId: string;
    url: string;
    route?: "direct" | "vpn" | "residential";
  };
  attach: Scope & { tabId: string };
  execute: FencedScope & {
    ref: BrowserRef;
    documentId: string;
    operation: Operation;
  };
  subscribe: Scope & {
    ref: BrowserRef;
    subscriptionId: string;
    surface: "page" | "window";
    maxFps: number;
    maxWidth: number;
    maxHeight: number;
  };
  unsubscribe: Scope & { subscriptionId: string };
  ack: Scope & { subscriptionId: string; frameId: number };
  viewerInput: FencedScope & {
    ref: BrowserRef;
    documentId: string;
    subscriptionId: string;
    input: Input;
  };
  upload: Upload;
  download: Download;
  closeTab: FencedScope & { ref: BrowserRef };
  shutdown: { requireIdle: boolean };
  setControlGeneration: {
    resource: Resource;
    incarnation: string;
    generation: number;
  };
  releaseInputs: { resource: Resource; incarnation: string };
  quiesce: { requestAdmissionClosed: boolean };
}
export type Method = keyof MethodParams;
export type EngineRequest = {
  [M in Method]: {
    protocolVersion: 1;
    kind: "request";
    requestId: string;
    deadlineMs: number;
    method: M;
    params: MethodParams[M];
  };
}[Method];
export interface Artifact {
  artifactId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}
export interface Tab {
  resource: Resource;
  ref: BrowserRef;
  documentId: string;
  fence: Fence;
  url: string;
  title: string;
}
export interface RefInfo {
  role: string;
  name?: string;
  nth?: number;
}
export interface ConsoleEntry {
  sequence: number;
  level: string;
  text: string;
}
export interface NetworkEntry {
  sequence: number;
  url: string;
  method: string;
  status: number;
  failed: boolean;
}
export interface Ack {
  ok: true;
}
export interface OperationResults {
  navigate: Tab;
  snapshot: {
    documentId: string;
    snapshot: string;
    refs: Record<string, RefInfo>;
  };
  screenshot: Artifact;
  click: Ack;
  fill: Ack;
  type: Ack;
  press: Ack;
  select: Ack;
  check: Ack;
  hover: Ack;
  evaluate: { value: Json };
  dialog: Ack;
  upload: Ack;
  console: { entries: ConsoleEntry[]; nextCursor: number };
  network: { entries: NetworkEntry[]; nextCursor: number };
  "recording.start": { recordingId: string };
  "recording.stop": Artifact;
}
export interface Counts {
  actions: number;
  launches: number;
  navigations: number;
  viewers: number;
  recordings: number;
  uploads: number;
  downloads: number;
  dialogs: number;
  sharedSessions: number;
  externalContexts: number;
}
export interface MethodResults {
  hello: {
    protocolVersion: 1;
    packageVersion: string;
    incarnation: string;
    capabilities: string[];
    platform: { os: string; arch: string };
  };
  open: Tab;
  attach: Tab;
  execute: OperationResults[keyof OperationResults];
  subscribe: { subscriptionId: string };
  unsubscribe: { profileDeleted: false; tabClosed: false };
  ack: Ack;
  viewerInput: Ack;
  upload: Artifact | { artifactId: string } | Ack;
  download: { offset: number; bytesBase64: string; eof: boolean } | Ack;
  closeTab: { closed: boolean };
  shutdown: Ack;
  setControlGeneration: Fence;
  releaseInputs: Ack;
  quiesce: {
    admissionClosed: boolean;
    idle: boolean;
    reasons: string[];
    counts: Counts;
  };
}
export type ErrorCode =
  | "invalid_request"
  | "unsupported"
  | "busy"
  | "deadline_exceeded"
  | "not_found"
  | "profile_in_use"
  | "owner_unavailable"
  | "stale_boot"
  | "stale_control"
  | "stale_document"
  | "artifact_invalid"
  | "admission_closed"
  | "internal";
export type EngineFailure = {
  protocolVersion: 1;
  kind: "response";
  requestId: string;
  method: string;
  ok: false;
  error: { code: ErrorCode; message: string; retryable: boolean };
};
export type Success<M extends Method> = {
  protocolVersion: 1;
  kind: "response";
  requestId: string;
  method: M;
  ok: true;
  result: MethodResults[M];
};
export type EngineResult =
  | EngineFailure
  | { [M in Method]: Success<M> }[Method];
export type ResultFor<R extends EngineRequest> =
  | EngineFailure
  | {
      protocolVersion: 1;
      kind: "response";
      requestId: string;
      method: R["method"];
      ok: true;
      result: R extends { method: "execute"; params: { operation: infer O } }
        ? O extends Operation
          ? OperationResults[O["name"]]
          : never
        : MethodResults[R["method"]];
    };
export interface EventBodies {
  tabOpened: Scope & {
    ref: BrowserRef;
    documentId: string;
    openerTabId: string;
    url: string;
  };
  tabChanged: {
    resource: Resource;
    ref: BrowserRef;
    documentId: string;
    url: string;
    title: string;
  };
  tabClosed: { resource: Resource; ref: BrowserRef };
  dialog: Scope & {
    ref: BrowserRef;
    documentId: string;
    dialogId: string;
    type: "alert" | "beforeunload" | "confirm" | "prompt";
    message: string;
    defaultValue: string;
  };
  download: Scope & { ref: BrowserRef; artifact: Artifact };
  frame: Scope & {
    ref: BrowserRef;
    subscriptionId: string;
    frameId: number;
    mimeType: "image/jpeg";
    width: number;
    height: number;
    bytesBase64: string;
  };
  viewerState: Scope & {
    subscriptionId: string;
    state: "attached" | "backpressured" | "detached";
    reason: string;
  };
  ownerClosed: { resource: Resource; reason: string };
}
export type EngineEvent = {
  [N in keyof EventBodies]: {
    protocolVersion: 1;
    kind: "event";
    incarnation: string;
    sequence: number;
    name: N;
  } & EventBodies[N];
}[keyof EventBodies];
