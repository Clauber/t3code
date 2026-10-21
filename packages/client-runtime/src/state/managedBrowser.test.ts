import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthPreviewOperateScope,
  EnvironmentId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createManagedBrowserEnvironmentAtoms } from "./managedBrowser.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const owner = EnvironmentId.make("owner");
const chat = EnvironmentId.make("chat");

const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes,
  permissions: scopes,
});

const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const atoms = createManagedBrowserEnvironmentAtoms(runtime);

describe("shared browser commands are offered by the destination's own grants", () => {
  it("offers each command only to a session that holds the scope the server will demand", () => {
    const registry = AtomRegistry.make();
    registry.mount(sessions(owner));
    registry.mount(sessions(chat));
    // The chat's connection can do everything; the owner's session may only look.
    registry.set(
      sessions(chat),
      AsyncResult.success(
        session([AuthAccessWriteScope, AuthEnvironmentMaintainScope, AuthPreviewOperateScope]),
      ),
    );
    registry.set(sessions(owner), AsyncResult.success(session([])));
    const expectations = [
      [atoms.openTab, AuthPreviewOperateScope],
      [atoms.setShared, AuthPreviewOperateScope],
      [atoms.createGrant, AuthAccessWriteScope],
      [atoms.revokeGrant, AuthAccessWriteScope],
      [atoms.enroll, AuthAccessWriteScope],
      [atoms.removeEnrollment, AuthAccessWriteScope],
      [atoms.update, AuthEnvironmentMaintainScope],
    ] as const;
    for (const [command, scope] of expectations) {
      expect(command.requiredScopes()).toEqual([scope]);
      // The grant that counts is the owner's, not the chat's: a read-only owner session is refused.
      expect(registry.get(command.permissionAtom(owner))).toBe(false);
      expect(registry.get(command.permissionAtom(chat))).toBe(true);
    }
    registry.set(sessions(owner), AsyncResult.success(session([AuthAccessWriteScope])));
    expect(registry.get(atoms.createGrant.permissionAtom(owner))).toBe(true);
    // Writing access does not stretch to maintaining the environment.
    expect(registry.get(atoms.update.permissionAtom(owner))).toBe(false);
    registry.dispose();
  });
});
