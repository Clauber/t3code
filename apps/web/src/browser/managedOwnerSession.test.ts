import { describe, expect, it } from "vite-plus/test";
import { PreviewManagedSession, ManagedBrowserIncarnation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { confirmsManagedOwner } from "./managedOwnerSession";
const owner = Schema.decodeUnknownSync(PreviewManagedSession)({
  ownerEnvironmentId: "mac",
  instanceId: "instance-default",
  profileId: "default",
  incarnation: "boot",
  engineTabId: "page",
  hostThreadId: "human-thread",
  hostTabId: "owner-tab",
  shared: true,
  native: true,
  remote: false,
});
describe("managed owner confirmation", () => {
  it("admits only the same native guest confirmed by its authenticated owner", () => {
    const shadow = { ...owner, remote: true };
    expect(confirmsManagedOwner(shadow, owner)).toBe(true);
    expect(confirmsManagedOwner(shadow, undefined)).toBe(false);
    expect(confirmsManagedOwner(shadow, shadow)).toBe(false);
    expect(confirmsManagedOwner(shadow, { ...owner, native: false })).toBe(false);
    expect(
      confirmsManagedOwner(
        { ...shadow, incarnation: ManagedBrowserIncarnation.make("old") },
        owner,
      ),
    ).toBe(false);
    expect(
      confirmsManagedOwner(
        {
          ...shadow,
          profileId: Schema.decodeUnknownSync(PreviewManagedSession)({
            ...owner,
            profileId: "private",
          }).profileId,
        },
        owner,
      ),
    ).toBe(false);
  });
});
