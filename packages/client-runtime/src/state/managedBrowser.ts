import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { ManagedProfileSelection } from "../managedBrowser/controls.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** The profile a person last picked, kept for as long as the app runs so moving between screens does not reset it. */
export const selectedManagedProfileAtom = Atom.make<ManagedProfileSelection | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("managed-browser:selected-profile"),
);

type Target = { readonly environmentId: EnvironmentId };

/**
 * The shared browser of one environment: what it lists and the commands that change it. Every call goes
 * to the environment it is given, over the connection this client already holds to it, and is checked
 * against that connection's grants: the chat's environment is never asked in the owner's place, and a
 * command's `permissionAtom` says whether the destination's session may run it before it is offered.
 */
export function createManagedBrowserEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Changes to one environment's shared browser apply in the order they were made.
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };

  const overview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:managed-browser:overview",
    tag: WS_METHODS.managedBrowserOverview,
    staleTimeMs: 2_000,
    // Who holds control and which tabs are open change while a person is looking.
    refreshIntervalMs: 5_000,
  });
  const grants = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:managed-browser:grants",
    tag: WS_METHODS.managedBrowserListGrants,
    staleTimeMs: 5_000,
  });
  const enrollments = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:managed-browser:enrollments",
    tag: WS_METHODS.managedBrowserListEnrollments,
    staleTimeMs: 5_000,
  });
  const updateStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:managed-browser:update-status",
    tag: WS_METHODS.managedBrowserUpdateStatus,
    staleTimeMs: 5_000,
    refreshIntervalMs: 15_000,
  });

  // A change is followed by a re-read of what it changed, so a screen never shows the state before it.
  const reread =
    (refresh: (target: Target, registry: AtomRegistry.AtomRegistry) => void) =>
    (target: Target, registry: AtomRegistry.AtomRegistry) =>
      Effect.sync(() => refresh(target, registry));
  const afterTab = reread(({ environmentId }, registry) =>
    registry.refresh(overview({ environmentId, input: {} })),
  );
  const afterGrant = reread(({ environmentId }, registry) => {
    registry.refresh(grants({ environmentId, input: {} }));
    registry.refresh(overview({ environmentId, input: {} }));
  });
  const afterEnrollment = reread(({ environmentId }, registry) =>
    registry.refresh(enrollments({ environmentId, input: {} })),
  );
  const afterUpdate = reread(({ environmentId }, registry) => {
    registry.refresh(updateStatus({ environmentId, input: {} }));
    registry.refresh(overview({ environmentId, input: {} }));
  });

  return {
    agentIdentity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:managed-browser:agent-identity",
      tag: WS_METHODS.managedBrowserAgentIdentity,
      staleTimeMs: 0,
      refreshIntervalMs: 1_000,
    }),
    overview,
    grants,
    enrollments,
    updateStatus,
    openTab: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:open-tab",
      tag: WS_METHODS.managedBrowserOpenTab,
      scheduler,
      concurrency,
      onSuccess: afterTab,
    }),
    setShared: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:set-shared",
      tag: WS_METHODS.managedBrowserSetShared,
      scheduler,
      concurrency,
      onSuccess: afterTab,
    }),
    setControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:set-control",
      tag: WS_METHODS.managedBrowserSetControl,
      scheduler,
      concurrency,
      onSuccess: afterTab,
    }),
    createGrant: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:create-grant",
      tag: WS_METHODS.managedBrowserCreateGrant,
      scheduler,
      concurrency,
      onSuccess: afterGrant,
    }),
    revokeGrant: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:revoke-grant",
      tag: WS_METHODS.managedBrowserRevokeGrant,
      scheduler,
      concurrency,
      onSuccess: afterGrant,
    }),
    enroll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:enroll",
      tag: WS_METHODS.managedBrowserEnroll,
      scheduler,
      concurrency,
      onSuccess: afterEnrollment,
    }),
    removeEnrollment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:remove-enrollment",
      tag: WS_METHODS.managedBrowserRemoveEnrollment,
      scheduler,
      concurrency,
      onSuccess: afterEnrollment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:managed-browser:update",
      tag: WS_METHODS.managedBrowserUpdate,
      scheduler,
      concurrency,
      onSuccess: afterUpdate,
    }),
  };
}
