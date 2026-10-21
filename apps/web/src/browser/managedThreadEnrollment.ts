import type {
  ManagedBrowserEnrollment, ManagedBrowserEnrollmentCreateInput, ManagedBrowserGrant,
  ManagedBrowserGrantCreateInput, ManagedBrowserGrantCreateResult, ManagedBrowserGrantId,
  PreviewAutomationBrowserBinding, ScopedThreadRef,
} from "@t3tools/contracts";
import { normalizeOwnerAddress } from "@t3tools/client-runtime/managed-browser/pairing";

const LABEL = "Browser panel";

export function reachableBrowserOwnerAddress(value: string): string | null {
  const origin = normalizeOwnerAddress(value);
  if (!origin) return null;
  const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "[::]" || host.startsWith("[::ffff:7f") ||
    host === "0.0.0.0" || host.startsWith("127.") ? null : origin;
}

export interface ThreadEnrollmentInput {
  threadRef: ScopedThreadRef;
  binding: PreviewAutomationBrowserBinding;
  agentSessionId: string;
  endpoint: string;
  grants: ReadonlyArray<ManagedBrowserGrant>;
  enrollments: ReadonlyArray<ManagedBrowserEnrollment>;
  replace: boolean;
}

export interface ThreadEnrollmentCommands {
  isCurrent?: () => boolean;
  create: (input: ManagedBrowserGrantCreateInput) => Promise<ManagedBrowserGrantCreateResult>;
  enroll: (input: ManagedBrowserEnrollmentCreateInput) => Promise<void>;
  revoke: (id: ManagedBrowserGrantId) => Promise<void>;
  remove: (id: ManagedBrowserGrantId) => Promise<void>;
}

export function matchingThreadGrants(input: ThreadEnrollmentInput) {
  return input.grants.filter((grant) => grant.ownerEnvironmentId === input.binding.ownerEnvironmentId &&
    grant.subject.kind === "agent" && grant.subject.callerEnvironmentId === input.threadRef.environmentId &&
    grant.subject.threadId === input.threadRef.threadId && grant.resources.some((resource) =>
      resource.instanceId === input.binding.instanceId && resource.profileId === input.binding.profileId));
}

export function threadEnrollmentReady(input: ThreadEnrollmentInput, now = Date.now()) {
  return matchingThreadGrants(input).some((grant) => grant.subject.kind === "agent" &&
    grant.subject.agentSessionId === input.agentSessionId && grant.revokedAt === null &&
    Date.parse(grant.expiresAt) > now && grant.access === "operate" && input.enrollments.some((entry) =>
      entry.id === grant.id && entry.ownerEnvironmentId === input.binding.ownerEnvironmentId &&
      entry.instanceId === input.binding.instanceId && entry.profileId === input.binding.profileId &&
      entry.threadId === input.threadRef.threadId && entry.agentSessionId === input.agentSessionId &&
      Date.parse(entry.expiresAt) > now && reachableBrowserOwnerAddress(entry.endpoint) !== null));
}

const pending = new Map<string, Promise<void>>();

/** Only the signed-in client can bridge the owner's grant to this caller's protected secret store. */
export function ensureThreadEnrollment(input: ThreadEnrollmentInput, commands: ThreadEnrollmentCommands): Promise<void> {
  const key = JSON.stringify([input.threadRef, input.binding, input.agentSessionId]);
  const running = pending.get(key);
  if (running) return running;
  const operation = performThreadEnrollment(input, commands).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

async function performThreadEnrollment(input: ThreadEnrollmentInput, commands: ThreadEnrollmentCommands) {
  const grants = matchingThreadGrants(input);
  // Session replacement invalidates only grants this panel created, never manually managed access.
  for (const grant of grants) {
    if (grant.label === LABEL && grant.subject.kind === "agent" &&
      grant.subject.agentSessionId !== input.agentSessionId && grant.revokedAt === null) {
      await commands.revoke(grant.id);
      await commands.remove(grant.id);
    }
  }
  if (threadEnrollmentReady(input)) return;
  const current = grants.filter((grant) => grant.subject.kind === "agent" &&
    grant.subject.agentSessionId === input.agentSessionId);
  if (current.length > 0 && !input.replace) {
    throw new Error("Browser access needs authorization. Revoked or expired access is not renewed automatically.");
  }
  const endpoint = reachableBrowserOwnerAddress(input.endpoint);
  if (!endpoint) throw new Error("Enter the Mac's reachable T3 address. localhost points to the other computer.");
  for (const grant of current) {
    if (grant.label === LABEL && grant.revokedAt === null) {
      await commands.revoke(grant.id);
      await commands.remove(grant.id);
    }
  }
  const created = await commands.create({
    label: LABEL,
    subject: { kind: "agent", callerEnvironmentId: input.threadRef.environmentId,
      threadId: input.threadRef.threadId, agentSessionId: input.agentSessionId },
    resources: [{ instanceId: input.binding.instanceId, profileId: input.binding.profileId }],
    access: "operate", ttlSeconds: 86_400,
  });
  if (!created.credential) {
    await commands.revoke(created.grant.id);
    throw new Error("The browser owner did not return an enrollment credential.");
  }
  try {
    if (commands.isCurrent?.() === false) throw new Error("Provider session changed.");
    await commands.enroll({ id: created.grant.id, ...input.binding, endpoint,
      threadId: input.threadRef.threadId, agentSessionId: input.agentSessionId,
      expiresAt: created.grant.expiresAt, credential: created.credential });
    if (commands.isCurrent?.() === false) {
      await commands.remove(created.grant.id);
      throw new Error("Provider session changed.");
    }
  } catch {
    await commands.revoke(created.grant.id);
    throw new Error("Could not connect this chat to the Mac browser. Check its reachable T3 address and retry.");
  }
}
