/**
 * Managed browser controls - the decisions the shared-browser screens make, kept out of the screens.
 *
 * Web and mobile render exactly what these return, so what a person is told about control, hosting and
 * updates cannot differ between the two. Nothing here touches the network: it chooses the connection a
 * viewer uses, words the states the server reports, and decides which actions are worth offering.
 *
 * @module managedBrowser/controls
 */
import type {
  EnvironmentId,
  ManagedBrowserAccess,
  ManagedBrowserGrant,
  ManagedBrowserHosting,
  ManagedBrowserOverview,
  ManagedBrowserTabSummary,
  ManagedBrowserUpdateAction,
  ManagedBrowserUpdateActivation,
  ManagedBrowserUpdateStatus,
  PreviewManagedSession,
} from "@t3tools/contracts";

import type { PreviewStreamControl } from "../preview/serverBrowserStream.ts";

// ---------------------------------------------------------------------------
// Which connection a viewer uses
// ---------------------------------------------------------------------------

export interface ManagedStreamTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  /** True when the page lives on another environment than the chat, so its stream comes from there. */
  readonly viaOwner: boolean;
}

/**
 * Where to watch a preview session from. A browser another environment owns is watched on that
 * environment, with the ids it knows the tab by and the connection this client already has to it: the
 * chat's environment holds no grant on the page and could only forward the viewer's credentials. Every
 * other session, managed here or not, is watched where the chat is.
 */
export const managedStreamTarget = (
  session: {
    readonly threadId: string;
    readonly tabId: string;
    readonly managed?:
      | Pick<PreviewManagedSession, "remote" | "ownerEnvironmentId" | "hostThreadId" | "hostTabId">
      | undefined;
  },
  chatEnvironmentId: EnvironmentId,
): ManagedStreamTarget =>
  session.managed?.remote === true
    ? {
        environmentId: session.managed.ownerEnvironmentId,
        threadId: session.managed.hostThreadId,
        tabId: session.managed.hostTabId,
        viaOwner: true,
      }
    : {
        environmentId: chatEnvironmentId,
        threadId: session.threadId,
        tabId: session.tabId,
        viaOwner: false,
      };

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export type ManagedControlAction = "take" | "release" | "resume";

export interface ManagedControlView {
  readonly label: string;
  /** A sentence of explanation, when the state needs one. */
  readonly detail?: string;
  readonly action: ManagedControlAction | null;
  readonly actionLabel?: string;
}

const secondsText = (seconds: number) => `${seconds} second${seconds === 1 ? "" : "s"}`;

/** Whole seconds left, rounded up so the countdown never says zero while time remains. */
const secondsLeft = (expiresAtMs: number, nowMs: number) =>
  Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));

/**
 * What to say about who may act in a shared browser, and the one action worth offering. A viewer
 * that cannot act is offered nothing; the server refuses it anyway, and a button that cannot work is a lie.
 */
export const describeManagedControl = (
  control: PreviewStreamControl | null,
  nowMs: number,
): ManagedControlView => {
  if (control === null) return { label: "Connecting...", action: null };
  if (!control.canOperate) {
    return {
      label: "Read-only",
      detail: "You can watch this browser but not control it.",
      action: null,
    };
  }
  const left =
    control.holdExpiresAtMs === undefined ? undefined : secondsLeft(control.holdExpiresAtMs, nowMs);
  switch (control.controller) {
    case "you":
      return { label: "You stopped agents", action: "release", actionLabel: "Let agents continue" };
    case "agent":
      return {
        label: "An agent is using the browser",
        action: "take",
        actionLabel: "Stop agents",
      };
    case "unclaimed":
      return { label: "Agents can use it", action: "take", actionLabel: "Stop agents" };
    case "another-viewer":
      return {
        label: "Another person has control",
        ...(left === undefined
          ? {}
          : {
              detail: `Their control is on hold while they reconnect (${left === 0 ? "ending now" : secondsText(left)}).`,
            }),
        action: null,
      };
    case "held-for-you":
      return {
        label: "Your control is on hold",
        detail:
          left === undefined || left === 0
            ? "Resume now or the browser pauses."
            : `Resume within ${secondsText(left)} or the browser pauses.`,
        action: "resume",
        actionLabel: "Resume control",
      };
    case "paused":
      return {
        label: "Paused",
        detail: "Nobody can use the browser until someone takes control.",
        action: "take",
        actionLabel: "Take control",
      };
  }
};

/**
 * Who holds a listed tab's browser and the one action worth offering, from the overview alone, so it
 * needs no open stream. `canOperate` is what this session may do at the owner; without it nothing is offered.
 */
export const describeTabControl = (
  tab: Pick<ManagedBrowserTabSummary, "phase" | "heldByYou">,
  canOperate: boolean,
): ManagedControlView => {
  const offer = (action: "take" | "release", actionLabel: string) =>
    canOperate ? { action, actionLabel } : { action: null };
  switch (tab.phase) {
    case "human":
      return tab.heldByYou === true
        ? {
            label: "You stopped agents",
            // The honest limit: the lease keeps agents out; it cannot stop anyone typing in the browser's own window.
            detail:
              "Agents cannot change this browser until you let them continue. Anything typed in the browser's own window still reaches it.",
            ...offer("release", "Let agents continue"),
          }
        : { label: "Another person has control", action: null };
    case "agent":
      return { label: "Agents can use it", ...offer("take", "Stop agents") };
    case "paused":
      return {
        label: "Paused",
        detail: "Nobody can use the browser until someone takes control.",
        ...offer("take", "Take control"),
      };
    case "reconnectHold":
      return { label: "Control is on hold", action: null };
    case "transferring":
      return { label: "Changing hands", action: null };
    case "unavailable":
      return { label: "Not running", action: null };
  }
};

/**
 * Whether this client can offer the owner's browser as a window on the very computer it runs on: the owner
 * says it opens its browser on its own screen, this client is the desktop app, and that owner is the server
 * the app itself started. A phone, a web page, or the app looking at another computer's server never is.
 */
export const canUseOnThisComputer = (input: {
  readonly overview: Pick<ManagedBrowserOverview, "native">;
  readonly isDesktopApp: boolean;
  readonly isOwnLocalServer: boolean;
}): boolean =>
  input.isDesktopApp && input.isOwnLocalServer && input.overview.native?.available === true;

// ---------------------------------------------------------------------------
// Which computer runs the browser
// ---------------------------------------------------------------------------

export interface ManagedOwnerCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: string };
}

export interface ManagedOwnerChoice<T extends ManagedOwnerCandidate> {
  /** The connected computer to show, or null while there is none to show. */
  readonly owner: T | null;
  /** Why there is none, said to the person; null when there is one. */
  readonly message: string | null;
}

/**
 * The computer whose shared browser to show. A choice the person made stays theirs: when that computer
 * has dropped its connection, nothing else is shown in its place, because a different computer's tabs and
 * access list under the same heading would read as the first one's. With no choice yet, the first
 * connected computer stands in.
 */
export const resolveOwner = <T extends ManagedOwnerCandidate>(
  environments: ReadonlyArray<T>,
  chosen: EnvironmentId | null,
): ManagedOwnerChoice<T> => {
  const connected = environments.filter((entry) => entry.connection.phase === "connected");
  const picked =
    chosen === null ? undefined : environments.find((entry) => entry.environmentId === chosen);
  if (picked !== undefined) {
    return picked.connection.phase === "connected"
      ? { owner: picked, message: null }
      : {
          owner: null,
          message: `${picked.label} isn't connected right now, so its shared browser can't be shown. Reconnect to it, or choose another computer.`,
        };
  }
  const first = connected[0];
  return first === undefined
    ? {
        owner: null,
        message: "No computer is connected. Connect to one to use its shared browser.",
      }
    : { owner: first, message: null };
};

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface ManagedProfileSelection {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly instanceId: string;
  readonly profileId: string;
}

/**
 * The profile to show as chosen. A person's choice is kept for as long as it still exists on the same
 * owner, so moving between screens does not reset it; otherwise the first profile stands in, and with
 * none there is nothing to choose.
 */
export const resolveProfileSelection = (
  selection: ManagedProfileSelection | null,
  overview: ManagedBrowserOverview,
): ManagedProfileSelection | null => {
  const first = overview.profiles[0];
  if (first === undefined) return null;
  const kept =
    selection !== null &&
    selection.ownerEnvironmentId === overview.ownerEnvironmentId &&
    overview.profiles.some(
      (profile) =>
        profile.instanceId === selection.instanceId && profile.profileId === selection.profileId,
    );
  return kept
    ? selection
    : {
        ownerEnvironmentId: overview.ownerEnvironmentId,
        instanceId: first.instanceId,
        profileId: first.profileId,
      };
};

const MAX_PROFILE_NAME = 48;

/**
 * The binding for a profile a person names. One profile belongs to one browser instance for good, so the
 * instance is named from the profile; a name that leaves nothing usable is refused rather than guessed.
 */
export const newProfileBinding = (name: string) => {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, MAX_PROFILE_NAME)
    .replaceAll(/-+$/g, "");
  return slug.length === 0 ? null : { instanceId: `instance-${slug}`, profileId: slug };
};

// ---------------------------------------------------------------------------
// Hosting and updates
// ---------------------------------------------------------------------------

const ANOTHER_COMPUTER = "You can still use a browser that another computer runs.";

/** Null when this computer hosts a browser; otherwise a sentence saying why not and what remains possible. */
export const describeHosting = (hosting: ManagedBrowserHosting): string | null => {
  if (hosting.available) return null;
  switch (hosting.reason) {
    case "recoveryRequired":
      return "The shared browser stopped after a failed update and needs recovery.";
    case "notConfigured":
    case "unprovisioned":
    case "unsupportedHost":
      return `This computer can't run the shared browser yet. ${ANOTHER_COMPUTER}`;
    default:
      return `The shared browser isn't available on this computer. ${ANOTHER_COMPUTER}`;
  }
};

const BUSY_REASONS: Readonly<Record<string, string>> = {
  viewers: "someone is watching",
  dialogs: "a page dialog is open",
  sharedSessions: "a tab is shared with another chat",
  actions: "an agent is working",
  launches: "the browser is starting",
  navigations: "a page is loading",
  uploads: "a file is uploading",
  downloads: "a file is downloading",
  recordings: "a recording is running",
  externalContexts: "another window is open in this browser",
};

const busyText = (reasons: ReadonlyArray<string>) =>
  [...new Set(reasons.map((reason) => BUSY_REASONS[reason] ?? "other activity"))].join(", ");

export interface ManagedUpdateActions {
  readonly check: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly pin: boolean;
  readonly unpin: boolean;
  readonly rollback: boolean;
  readonly recover: boolean;
}

export interface ManagedUpdateView {
  readonly headline: string;
  readonly lines: ReadonlyArray<string>;
  readonly actions: ManagedUpdateActions;
}

const NO_ACTIONS: ManagedUpdateActions = {
  check: false,
  pause: false,
  resume: false,
  pin: false,
  unpin: false,
  rollback: false,
  recover: false,
};

const checkLine = (status: ManagedBrowserUpdateStatus): ReadonlyArray<string> => {
  switch (status.lastCheck?.outcome) {
    case "offline":
      return ["The release source could not be reached. The installed version keeps running."];
    case "unauthorized":
      return ["The release source refused the saved access. The installed version keeps running."];
    case "rejected":
      return ["The latest release failed verification and was not used."];
    case "unavailable":
      return ["No compatible release is available."];
    default:
      return [];
  }
};

/**
 * What to say about the browser component's updates and which actions can work. A build with nothing
 * installed offers nothing (there is nothing to check, pin or roll back), and an update in progress
 * offers nothing until it ends, so a person cannot start a second one.
 */
export const describeUpdate = (status: ManagedBrowserUpdateStatus): ManagedUpdateView => {
  if (status.applying) {
    return { headline: "Updating the shared browser...", lines: [], actions: NO_ACTIONS };
  }
  if (status.recovery !== null) {
    const { failed, detail } = status.recovery;
    const restart = status.recovery.status === "restartRequired";
    return {
      headline: restart
        ? "The shared browser needs a restart before it can recover."
        : "The shared browser needs recovery.",
      lines: [
        `Version ${failed} did not start, and the previous version could not be restored.`,
        ...(restart
          ? [
              "A browser process may still be running, so recovery is blocked. Stop it, then restart T3 on this computer. Restarting does not end it by itself.",
            ]
          : []),
        `Details: ${detail}`,
      ],
      actions: { ...NO_ACTIONS, recover: !restart },
    };
  }
  if (status.current === null) {
    const missing = [
      status.provisioning.baseline ? null : "no browser release is bundled",
      status.provisioning.signingKey ? null : "no signing key is set",
      status.provisioning.releaseSource ? null : "no release source is set",
    ].filter((line): line is string => line !== null);
    return {
      headline: "Updates are not set up for this build yet.",
      lines: missing.length === 0 ? [] : [`Missing: ${missing.join(", ")}.`],
      actions: NO_ACTIONS,
    };
  }
  const lines: Array<string> = [];
  if (status.policy.pinnedVersion !== null) {
    lines.push(`Held at version ${status.policy.pinnedVersion}.`);
  }
  if (status.policy.paused) lines.push("Automatic updates are paused.");
  if (status.waiting !== null) {
    lines.push(
      `It will be installed when the browser isn't in use: ${busyText(status.waiting.reasons)}.`,
    );
  }
  lines.push(...checkLine(status));
  const headline =
    status.staged === null
      ? `The shared browser is up to date (version ${status.current}).`
      : status.waiting === null
        ? `Version ${status.staged} is downloaded.`
        : `Version ${status.staged} is ready and waiting.`;
  return {
    headline,
    lines,
    actions: {
      check: true,
      pause: !status.policy.paused,
      resume: status.policy.paused,
      pin: status.policy.pinnedVersion === null,
      unpin: status.policy.pinnedVersion !== null,
      rollback: status.previous !== null,
      recover: false,
    },
  };
};

export const TAB_PHASE_TEXT: Readonly<Record<ManagedBrowserTabSummary["phase"], string>> = {
  agent: "Agents can use it",
  human: "A person has control",
  reconnectHold: "Control is on hold",
  paused: "Paused",
  transferring: "Changing hands",
  unavailable: "Not running",
};

export const GRANT_ACCESS_TEXT: Readonly<Record<ManagedBrowserAccess, string>> = {
  read: "Can watch",
  operate: "Can watch and control",
};

/** Who a grant is for, in words a person recognises. The computer's name comes from the connections this client holds. */
export const describeGrantHolder = (
  { subject, label }: ManagedBrowserGrant,
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
): string =>
  subject.kind === "viewer"
    ? (label ?? "A signed-in device")
    : `An agent on ${
        environments.find((entry) => entry.environmentId === subject.callerEnvironmentId)?.label ??
        "another computer"
      }`;

export const UPDATE_ACTIONS: ReadonlyArray<{
  readonly action: ManagedBrowserUpdateAction;
  readonly label: string;
  readonly enabled: keyof ManagedUpdateActions;
}> = [
  { action: "check", label: "Check for updates", enabled: "check" },
  { action: "pause", label: "Pause updates", enabled: "pause" },
  { action: "resume", label: "Resume updates", enabled: "resume" },
  { action: "pin", label: "Keep this version", enabled: "pin" },
  { action: "unpin", label: "Allow newer versions", enabled: "unpin" },
  { action: "rollback", label: "Go back a version", enabled: "rollback" },
  { action: "recover", label: "Recover", enabled: "recover" },
];

/** What an update action did, when it did something worth saying. */
export const describeActivation = (activation: ManagedBrowserUpdateActivation): string => {
  switch (activation.result) {
    case "activated":
      return `Now on version ${activation.version ?? ""}.`.trim();
    case "deferred":
      return "The browser is in use, so nothing changed. It will switch when it is free.";
    case "rolledBack":
      return "The new version did not start, so the previous one was restored.";
    case "recoveryFailed":
      return "The previous version could not be restored. The update status says what to do next.";
  }
};
