import { createManagedBrowserEnvironmentAtoms } from "@t3tools/client-runtime/state/managed-browser";

import { connectionAtomRuntime } from "../connection/runtime";

export const managedBrowserEnvironment =
  createManagedBrowserEnvironmentAtoms(connectionAtomRuntime);
