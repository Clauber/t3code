import type { PreviewSessionSnapshot } from "@t3tools/contracts";

/** Remote metadata identifies a guest; only the authenticated owner's snapshot admits it. */
export function confirmsManagedOwner(
  requested: PreviewSessionSnapshot["managed"],
  owner: PreviewSessionSnapshot["managed"],
): boolean {
  return Boolean(
    requested &&
    owner?.native &&
    !owner.remote &&
    owner.ownerEnvironmentId === requested.ownerEnvironmentId &&
    owner.instanceId === requested.instanceId &&
    owner.profileId === requested.profileId &&
    owner.engineTabId === requested.engineTabId &&
    owner.incarnation === requested.incarnation,
  );
}
