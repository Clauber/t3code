// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
/**
 * ManagedBrowserSmoke - the check a candidate release passes before it serves anyone.
 *
 * Hello alone proves the process speaks the protocol, not that Chrome works. The check starts the candidate
 * through the real IPC launcher on a disposable data root, opens a real page, lets its script run, acts on
 * it and reads the answer back, then closes the tab and ends the child (exit proven) before the profile is
 * removed.
 *
 * @module ManagedBrowserSmoke
 */
import {
  ManagedBrowserControlGeneration,
  ManagedBrowserIncarnation,
  ManagedBrowserInstanceId,
  ManagedBrowserPrincipalId,
  ManagedBrowserProfileId,
  ManagedBrowserTabId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";
import * as ManagedBrowserPackage from "./ManagedBrowserPackage.ts";

const { ManagedBrowserPackageError } = ManagedBrowserPackage;
const isPackageError = Schema.is(ManagedBrowserPackageError);

const describe = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String((error as { message?: string })?.message ?? error);

const SMOKE_CALLER = ManagedBrowserPrincipalId.make("agent:t3-smoke");
/** Each smoke step may take this long; a candidate that cannot drive Chrome in time has failed. */
const SMOKE_STEP_MS = 30_000;

/** Starts a candidate on a disposable profile, opens a real page in Chrome, acts on it and judges the answer. */
export type ReleaseSmoke = (
  engine: ManagedBrowserPackage.PackageEngine,
  version: string,
) => Effect.Effect<void, ManagedBrowserPackage.ManagedBrowserPackageError>;

export const makeLauncherSmoke = (
  base: ManagedBrowserIpc.ManagedBrowserIpcOptions,
  ownerEnvironmentId: EnvironmentId,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ReleaseSmoke => {
  const rejected = (cause: unknown) =>
    new ManagedBrowserPackageError({
      reason: "rejected",
      detail: `smoke check failed: ${describe(cause)}`,
    });
  return (engine, version) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Short and outside every package and profile path: Chrome's socket path has a tight limit.
        const dataRoot = yield* Effect.acquireRelease(
          Effect.sync(() => FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-bsmoke-"))),
          (directory) => Effect.sync(() => FS.rmSync(directory, { recursive: true, force: true })),
        );
        const launcher = yield* ManagedBrowserIpc.makeLauncher({
          ...base,
          ...engine,
          dataRoot,
          resolveEngine: undefined,
        });
        const spec = {
          ownerEnvironmentId,
          instanceId: ManagedBrowserInstanceId.make("smoke"),
          profileId: ManagedBrowserProfileId.make("smoke"),
          incarnation: ManagedBrowserIncarnation.make(Crypto.randomUUID()),
        };
        const child = yield* launcher.launch(spec);
        if (child.hello.packageVersion !== version) {
          return yield* new ManagedBrowserPackageError({
            reason: "rejected",
            detail: `smoke check failed: reports version ${child.hello.packageVersion}, expected ${version}`,
          });
        }
        // Hello alone proves the process speaks the protocol, not that Chrome works: open a real page in
        // the disposable profile, let its script run, act on it and read the answer back.
        const nonce = Crypto.randomUUID();
        const expected = [...nonce].reverse().join("");
        const page = `<!doctype html><title>t3 smoke</title><button id="go">go</button><script>document.getElementById("go").addEventListener("click",()=>{document.body.dataset.v=${JSON.stringify(nonce)}.split("").reverse().join("")})</script>`;
        const request = (operation: unknown, tabId: string) => ({
          ref: {
            ownerEnvironmentId,
            instanceId: spec.instanceId,
            profileId: spec.profileId,
            incarnation: spec.incarnation,
            tabId: ManagedBrowserTabId.make(tabId),
          },
          fence: {
            incarnation: spec.incarnation,
            generation: ManagedBrowserControlGeneration.make(0),
          },
          callerId: SMOKE_CALLER,
          callerKind: "agent" as const,
          operation,
          deadlineMs: SMOKE_STEP_MS,
        });
        const caller = {
          environmentId: String(ownerEnvironmentId),
          threadId: "smoke",
          agentSessionId: "smoke",
        };
        const tab = (yield* child.execute(
          request(
            {
              kind: "open",
              caller,
              tabId: "smoke-tab",
              url: `data:text/html,${encodeURIComponent(page)}`,
            },
            "smoke-tab",
          ),
        )).value as { readonly documentId: string };
        const evaluate = (expression: string) =>
          child
            .execute(
              request(
                {
                  kind: "execute",
                  caller,
                  tabId: "smoke-tab",
                  documentId: tab.documentId,
                  operation: { name: "evaluate", expression, argument: null },
                },
                "smoke-tab",
              ),
            )
            .pipe(Effect.map((result) => (result.value as { readonly value: unknown }).value));
        const title = yield* evaluate("() => document.title");
        const answer = yield* evaluate(
          '() => { document.getElementById("go").click(); return document.body.dataset.v }',
        );
        if (title !== "t3 smoke" || answer !== expected) {
          return yield* new ManagedBrowserPackageError({
            reason: "rejected",
            detail: "smoke check failed: the page did not behave as written",
          });
        }
        yield* child.execute(
          request({ kind: "closeTab", caller, tabId: "smoke-tab" }, "smoke-tab"),
        );
        const idle = yield* child.quiesce(false);
        if (!idle.idle) {
          return yield* new ManagedBrowserPackageError({
            reason: "rejected",
            detail: "smoke check failed: a fresh browser is not idle",
          });
        }
      }),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) => (isPackageError(cause) ? cause : rejected(cause))),
    );
};
