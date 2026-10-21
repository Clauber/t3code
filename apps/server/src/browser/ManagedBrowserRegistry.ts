// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
/**
 * ManagedBrowserRegistry - the durable record of which instance uses which profile, and which tabs
 * a thread has in it.
 *
 * The engine keeps a profile's tabs across restarts but has no way to list them, and T3's preview
 * sessions are minted anew every run. This file is what lets a restarted T3 reopen the same instance,
 * profile and engine tab ids for the thread that owned them instead of forgetting them (and opening a
 * second set beside them). It lives in T3's state directory, never in source, and holds identities and
 * the last URL only: no cookies, no page content, no credentials.
 *
 * Writes are atomic (temporary file, then rename) and mode 0600. A file that cannot be read is not
 * discarded: it is reported, and named opens fail until someone looks, because a registry that quietly
 * restarted empty would open second copies of tabs that are still alive in a profile.
 *
 * @module ManagedBrowserRegistry
 */
import * as FS from "node:fs";
import * as Path from "node:path";

const SCHEMA_VERSION = 1;
const MAX_TABS = 512;

export interface RegisteredInstance {
  readonly ownerEnvironmentId: string;
  readonly instanceId: string;
  readonly profileId: string;
}

export interface RegisteredTab {
  readonly ownerEnvironmentId: string;
  readonly instanceId: string;
  readonly profileId: string;
  /** The T3 thread that owns the tab. Another thread never adopts it. */
  readonly threadId: string;
  /** The engine's own tab id, which survives a restart of both the engine and T3. */
  readonly engineTabId: string;
  /** The engine tab that opened this one (a popup), when it did. */
  readonly openerEngineTabId: string | null;
  /** The environment the opening agent ran in; only that environment's agents may adopt the tab. */
  readonly callerEnvironmentId: string;
  readonly agentSessionId: string;
  /** Last known address, for display. Never navigated to on recovery. */
  readonly url: string | null;
  readonly title: string;
  /** Set when a close was requested but not confirmed; the tab must be closed, not recovered. */
  readonly closePending: boolean;
  /**
   * Whether other threads may join this engine tab. Every thread's record of one tab carries the same
   * value; it is what turns knowing a tab id into permission to ask, and never more than that.
   */
  readonly shared: boolean;
  readonly updatedAt: string;
}

interface RegistryFile {
  readonly schemaVersion: number;
  readonly instances: ReadonlyArray<RegisteredInstance>;
  readonly tabs: ReadonlyArray<RegisteredTab>;
}

export type RegistryLoad =
  | { readonly _tag: "ready" }
  | { readonly _tag: "unreadable"; readonly detail: string };

/** Why an instance or profile may not be bound as asked. */
export type RegistryBindingConflict =
  | { readonly _tag: "instanceUsesOtherProfile"; readonly profileId: string }
  | { readonly _tag: "profileUsedByOtherInstance"; readonly instanceId: string }
  | { readonly _tag: "instanceOwnedByOtherEnvironment"; readonly ownerEnvironmentId: string };

const isString = (value: unknown): value is string => typeof value === "string";

const parseTab = (value: unknown): RegisteredTab | null => {
  if (typeof value !== "object" || value === null) return null;
  const tab = value as Record<string, unknown>;
  if (
    !isString(tab.ownerEnvironmentId) ||
    !isString(tab.instanceId) ||
    !isString(tab.profileId) ||
    !isString(tab.threadId) ||
    !isString(tab.engineTabId) ||
    !isString(tab.callerEnvironmentId) ||
    !isString(tab.agentSessionId) ||
    !isString(tab.title) ||
    !isString(tab.updatedAt) ||
    typeof tab.closePending !== "boolean" ||
    !(tab.url === null || isString(tab.url)) ||
    !(tab.openerEngineTabId === null || isString(tab.openerEngineTabId))
  ) {
    return null;
  }
  return {
    ownerEnvironmentId: tab.ownerEnvironmentId,
    instanceId: tab.instanceId,
    profileId: tab.profileId,
    threadId: tab.threadId,
    engineTabId: tab.engineTabId,
    openerEngineTabId: tab.openerEngineTabId as string | null,
    callerEnvironmentId: tab.callerEnvironmentId,
    agentSessionId: tab.agentSessionId,
    url: tab.url as string | null,
    title: tab.title,
    closePending: tab.closePending,
    shared: tab.shared === true,
    updatedAt: tab.updatedAt,
  };
};

const parseInstance = (value: unknown): RegisteredInstance | null => {
  if (typeof value !== "object" || value === null) return null;
  const instance = value as Record<string, unknown>;
  if (
    !isString(instance.ownerEnvironmentId) ||
    !isString(instance.instanceId) ||
    !isString(instance.profileId)
  ) {
    return null;
  }
  return {
    ownerEnvironmentId: instance.ownerEnvironmentId,
    instanceId: instance.instanceId,
    profileId: instance.profileId,
  };
};

export interface ManagedBrowserRegistry {
  /** Whether the file could be read at start. Anything but `ready` refuses named opens. */
  readonly status: RegistryLoad;
  /** Records that `instanceId` uses `profileId`, or says why that contradicts what was recorded. */
  readonly bindInstance: (instance: RegisteredInstance) => RegistryBindingConflict | null;
  readonly checkInstance: (instance: RegisteredInstance) => RegistryBindingConflict | null;
  readonly upsertTab: (tab: RegisteredTab) => void;
  /** One thread's record of a tab, or every thread's when no thread is named. */
  readonly removeTab: (instanceId: string, engineTabId: string, threadId?: string) => void;
  readonly tabs: () => ReadonlyArray<RegisteredTab>;
  /** Every thread's record of one engine tab. */
  readonly participantsOf: (
    instanceId: string,
    engineTabId: string,
  ) => ReadonlyArray<RegisteredTab>;
  readonly tabsOf: (threadId: string, instance: RegisteredInstance) => ReadonlyArray<RegisteredTab>;
  readonly instances: () => ReadonlyArray<RegisteredInstance>;
}

const tabKey = (instanceId: string, engineTabId: string, threadId: string) =>
  `${instanceId}\u0000${engineTabId}\u0000${threadId}`;

/**
 * `path` null keeps everything in memory, for tests that do not exercise restarts. A write that fails
 * is raised to the caller: a binding that was not saved must not be reported as made.
 */
export const make = (path: string | null): ManagedBrowserRegistry => {
  const instances = new Map<string, RegisteredInstance>();
  const tabs = new Map<string, RegisteredTab>();
  let status: RegistryLoad = { _tag: "ready" };

  if (path !== null) {
    try {
      if (FS.existsSync(path)) {
        const parsed = JSON.parse(FS.readFileSync(path, "utf8")) as Partial<RegistryFile>;
        if (parsed.schemaVersion !== SCHEMA_VERSION) {
          status = {
            _tag: "unreadable",
            detail: `unsupported registry version ${String(parsed.schemaVersion)}`,
          };
        } else {
          for (const entry of parsed.instances ?? []) {
            const instance = parseInstance(entry);
            if (instance === null) throw new Error("an instance record is malformed");
            instances.set(instance.instanceId, instance);
          }
          for (const entry of parsed.tabs ?? []) {
            const tab = parseTab(entry);
            if (tab === null) throw new Error("a tab record is malformed");
            tabs.set(tabKey(tab.instanceId, tab.engineTabId, tab.threadId), tab);
          }
        }
      }
    } catch (cause) {
      instances.clear();
      tabs.clear();
      status = {
        _tag: "unreadable",
        detail: cause instanceof Error ? cause.message : "unreadable",
      };
    }
  }

  const save = () => {
    if (path === null || status._tag !== "ready") return;
    FS.mkdirSync(Path.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const body: RegistryFile = {
      schemaVersion: SCHEMA_VERSION,
      instances: [...instances.values()],
      tabs: [...tabs.values()],
    };
    FS.writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
    FS.renameSync(temporary, path);
  };

  const conflictOf = (candidate: RegisteredInstance): RegistryBindingConflict | null => {
    const recorded = instances.get(candidate.instanceId);
    if (recorded !== undefined) {
      if (recorded.ownerEnvironmentId !== candidate.ownerEnvironmentId) {
        return {
          _tag: "instanceOwnedByOtherEnvironment",
          ownerEnvironmentId: recorded.ownerEnvironmentId,
        };
      }
      if (recorded.profileId !== candidate.profileId) {
        return { _tag: "instanceUsesOtherProfile", profileId: recorded.profileId };
      }
      return null;
    }
    for (const other of instances.values()) {
      if (
        other.profileId === candidate.profileId &&
        other.ownerEnvironmentId === candidate.ownerEnvironmentId
      ) {
        return { _tag: "profileUsedByOtherInstance", instanceId: other.instanceId };
      }
    }
    return null;
  };

  return {
    get status() {
      return status;
    },
    checkInstance: conflictOf,
    bindInstance: (candidate) => {
      const conflict = conflictOf(candidate);
      if (conflict !== null) return conflict;
      if (!instances.has(candidate.instanceId)) {
        instances.set(candidate.instanceId, candidate);
        try {
          save();
        } catch (cause) {
          instances.delete(candidate.instanceId);
          throw cause;
        }
      }
      return null;
    },
    upsertTab: (tab) => {
      const key = tabKey(tab.instanceId, tab.engineTabId, tab.threadId);
      const previous = tabs.get(key);
      if (previous === undefined && tabs.size >= MAX_TABS) {
        throw new Error("the managed browser tab registry is full");
      }
      tabs.set(key, tab);
      try {
        save();
      } catch (cause) {
        if (previous === undefined) tabs.delete(key);
        else tabs.set(key, previous);
        throw cause;
      }
    },
    removeTab: (instanceId, engineTabId, threadId) => {
      const removed = [...tabs.entries()].filter(
        ([, tab]) =>
          tab.instanceId === instanceId &&
          tab.engineTabId === engineTabId &&
          (threadId === undefined || tab.threadId === threadId),
      );
      if (removed.length === 0) return;
      for (const [key] of removed) tabs.delete(key);
      try {
        save();
      } catch (cause) {
        for (const [key, tab] of removed) tabs.set(key, tab);
        throw cause;
      }
    },
    participantsOf: (instanceId, engineTabId) =>
      [...tabs.values()].filter(
        (tab) => tab.instanceId === instanceId && tab.engineTabId === engineTabId,
      ),
    tabs: () => [...tabs.values()],
    tabsOf: (threadId, instance) =>
      [...tabs.values()].filter(
        (tab) =>
          tab.threadId === threadId &&
          tab.instanceId === instance.instanceId &&
          tab.profileId === instance.profileId &&
          tab.ownerEnvironmentId === instance.ownerEnvironmentId,
      ),
    instances: () => [...instances.values()],
  };
};
