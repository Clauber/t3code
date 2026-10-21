/**
 * Managed browser pairing - turning what a person types and pastes into the grants and enrollments the
 * server accepts.
 *
 * An agent's access to another computer's browser needs a grant on the owner and an enrollment on the
 * computer the agent runs on, with the same details and one credential between them. The owner shows an
 * access code once; the other computer's administrator pastes it into a secret field and adds the
 * address. The code is a convenience for carrying those details, not a new kind of trust: the server
 * validates everything in it again, and the address always comes from the person, never from the code.
 *
 * @module managedBrowser/pairing
 */
import {
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  ManagedBrowserGrantId,
  ManagedBrowserInstanceId,
  ManagedBrowserProfileId,
  type ManagedBrowserAccess,
  type ManagedBrowserEnrollmentCreateInput,
  type ManagedBrowserGrantCreateInput,
} from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

export const ACCESS_CODE_PREFIX = "t3mb1.";

export interface AccessCodeContent {
  readonly ownerEnvironmentId: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly expiresAt: string;
  readonly credential: string;
}

const CREDENTIAL = /^mbg\.([0-9a-f]{32})\.[A-Za-z0-9_-]{43}$/;

export const encodeAccessCode = (content: AccessCodeContent): string =>
  `${ACCESS_CODE_PREFIX}${Base64Url.encode(JSON.stringify(content))}`;

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The code's content, or null for anything that is not a well-formed code. Never throws. */
export const decodeAccessCode = (raw: string): AccessCodeContent | null => {
  const code = raw.trim();
  if (!code.startsWith(ACCESS_CODE_PREFIX)) return null;
  try {
    const decoded = Base64Url.decodeString(code.slice(ACCESS_CODE_PREFIX.length));
    if (Result.isFailure(decoded)) return null;
    const value: unknown = JSON.parse(decoded.success);
    if (typeof value !== "object" || value === null) return null;
    const content = value as Record<string, unknown>;
    if (
      !text(content.ownerEnvironmentId) ||
      !text(content.instanceId) ||
      !text(content.profileId) ||
      !text(content.threadId) ||
      !text(content.agentSessionId) ||
      !text(content.expiresAt) ||
      Number.isNaN(Date.parse(content.expiresAt)) ||
      !text(content.credential) ||
      !CREDENTIAL.test(content.credential)
    ) {
      return null;
    }
    return {
      ownerEnvironmentId: content.ownerEnvironmentId,
      instanceId: content.instanceId,
      profileId: content.profileId,
      threadId: content.threadId,
      agentSessionId: content.agentSessionId,
      expiresAt: content.expiresAt,
      credential: content.credential,
    };
  } catch {
    return null;
  }
};

/** The owner's address as the server wants it: scheme, host and optional port, nothing else. */
export const normalizeOwnerAddress = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return null;
    }
    if (url.pathname !== "/" || url.hostname === "") return null;
    return url.origin;
  } catch {
    return null;
  }
};

export type EnrollmentFromCode =
  | { readonly ok: true; readonly input: ManagedBrowserEnrollmentCreateInput }
  | { readonly ok: false; readonly reason: "code" | "address" };

/** The enrollment a pasted code and an address make. The grant id is the credential's own, so it cannot disagree. */
export const enrollmentFromAccessCode = (
  rawCode: string,
  rawAddress: string,
): EnrollmentFromCode => {
  const content = decodeAccessCode(rawCode);
  if (content === null) return { ok: false, reason: "code" };
  const endpoint = normalizeOwnerAddress(rawAddress);
  if (endpoint === null) return { ok: false, reason: "address" };
  const id = CREDENTIAL.exec(content.credential)?.[1];
  if (id === undefined) return { ok: false, reason: "code" };
  return {
    ok: true,
    input: {
      id: ManagedBrowserGrantId.make(id),
      ownerEnvironmentId: EnvironmentId.make(content.ownerEnvironmentId),
      endpoint,
      instanceId: ManagedBrowserInstanceId.make(content.instanceId),
      profileId: ManagedBrowserProfileId.make(content.profileId),
      threadId: content.threadId,
      agentSessionId: content.agentSessionId,
      expiresAt: IsoDateTime.make(content.expiresAt),
      credential: content.credential,
    },
  };
};

export const ACCESS_CODE_TTL_OPTIONS = [
  { value: "1h", label: "1 hour", seconds: 3_600 },
  { value: "1d", label: "1 day", seconds: 86_400 },
  { value: "7d", label: "7 days", seconds: 7 * 86_400 },
  { value: "30d", label: "30 days", seconds: 30 * 86_400 },
] as const;
export type AccessTtl = (typeof ACCESS_CODE_TTL_OPTIONS)[number]["value"];

const secondsOf = (ttl: AccessTtl) =>
  ACCESS_CODE_TTL_OPTIONS.find((option) => option.value === ttl)?.seconds ?? 3_600;

interface Resource {
  readonly instanceId: string;
  readonly profileId: string;
}

const resourceOf = ({ instanceId, profileId }: Resource) => ({
  instanceId: ManagedBrowserInstanceId.make(instanceId),
  profileId: ManagedBrowserProfileId.make(profileId),
});

/** A grant for a signed-in device or person to watch (and, with `operate`, drive) one profile. */
export const viewerGrantInput = (draft: {
  readonly sessionId: string;
  readonly access: ManagedBrowserAccess;
  readonly ttl: AccessTtl;
  readonly resource: Resource;
}): ManagedBrowserGrantCreateInput => ({
  subject: { kind: "viewer", viewerSessionId: AuthSessionId.make(draft.sessionId) },
  resources: [resourceOf(draft.resource)],
  access: draft.access,
  ttlSeconds: secondsOf(draft.ttl),
});

/** A grant for one chat's agent on another computer; null while what binds it to that chat is missing. */
export const agentGrantInput = (draft: {
  readonly callerEnvironmentId: EnvironmentId;
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly access: ManagedBrowserAccess;
  readonly ttl: AccessTtl;
  readonly resource: Resource;
}): ManagedBrowserGrantCreateInput | null => {
  const threadId = draft.threadId.trim();
  const agentSessionId = draft.agentSessionId.trim();
  if (threadId.length === 0 || agentSessionId.length === 0) return null;
  return {
    subject: {
      kind: "agent",
      callerEnvironmentId: draft.callerEnvironmentId,
      threadId,
      agentSessionId,
    },
    resources: [resourceOf(draft.resource)],
    access: draft.access,
    ttlSeconds: secondsOf(draft.ttl),
  };
};
