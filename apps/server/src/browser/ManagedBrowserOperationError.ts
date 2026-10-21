/**
 * ManagedBrowserOperationError - the errors a managed browser operation reports to the preview broker.
 *
 * Whatever the supervisor, control lease or engine said is turned into the one error type the broker
 * understands, with a message an agent can act on and nothing of the engine's internals. Each translation
 * names the next step (take a fresh snapshot, call preview_open again) rather than the cause.
 *
 * @module ManagedBrowserOperationError
 */
import * as Effect from "effect/Effect";

import * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import type * as ManagedBrowserIpc from "./ManagedBrowserIpc.ts";

export const operationError = (tag: string, message: string, detail?: unknown) =>
  new ServerBrowserPage.ServerBrowserOperationError(tag, message, detail);

const unsupported = (what: string) =>
  operationError(
    "PreviewAutomationUnsupportedClientError",
    `${what} is not supported in a managed browser session.`,
  );

/** The preview error is a plain Error, so a failure is raised explicitly rather than yielded. */
export const failOperation = (tag: string, message: string, detail?: unknown) =>
  Effect.fail(operationError(tag, message, detail));
export const failUnsupported = (what: string) => Effect.fail(unsupported(what));

const MAX_MESSAGE = 500;
const firstLine = (text: string) => (text.split("\n")[0] ?? text).slice(0, MAX_MESSAGE);

export const tagOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "_tag" in value
    ? String((value as { _tag: unknown })._tag)
    : undefined;

const engineErrorToOperationError = (error: ManagedBrowserIpc.ManagedBrowserEngineError) => {
  switch (error.code) {
    case "deadline_exceeded":
      return operationError("PreviewAutomationTimeoutError", firstLine(error.message));
    case "not_found":
      return operationError("PreviewAutomationTabNotFoundError", firstLine(error.message));
    case "stale_document":
      return operationError(
        "PreviewAutomationInvalidSelectorError",
        "That ref belongs to a page that has changed. Take a fresh snapshot.",
        { staleRef: true },
      );
    case "stale_boot":
    case "stale_control":
      return operationError(
        "PreviewAutomationControlInterruptedError",
        "Browser control changed. Take a fresh snapshot before trying again.",
        "interrupted",
      );
    case "unsupported":
      return operationError("PreviewAutomationUnsupportedClientError", firstLine(error.message));
    default:
      return operationError("PreviewAutomationExecutionError", firstLine(error.message));
  }
};

/** Turns whatever the supervisor, lease or engine said into the error the preview broker understands. */
export const toOperationError = (cause: unknown): ServerBrowserPage.ServerBrowserOperationError => {
  if (cause instanceof ServerBrowserPage.ServerBrowserOperationError) return cause;
  const tag = tagOf(cause);
  const error = cause as Record<string, unknown>;
  switch (tag) {
    case "ManagedBrowserOwnerUnavailableError":
      return operationError(
        "PreviewAutomationExecutionError",
        `The managed browser is unavailable (${String(error.reason)}). Call preview_open to start it again; no second browser is started automatically.`,
      );
    case "ManagedBrowserStaleIncarnationError":
      return operationError(
        "PreviewAutomationExecutionError",
        "The managed browser restarted since this tab was opened. Call preview_open to reattach.",
      );
    case "ManagedBrowserOwnerMismatchError":
    case "ManagedBrowserProfileMismatchError":
    case "ManagedBrowserProfileConflictError":
      return operationError(
        "PreviewAutomationExecutionError",
        "That managed browser is bound to a different profile or environment.",
      );
    case "ManagedBrowserControlHeldError":
      return operationError(
        "PreviewAutomationControlInterruptedError",
        "A human controls this browser tab, or control is changing. Wait until it is released.",
        "humanControl",
      );
    case "ManagedBrowserNotHolderError":
      return operationError(
        "PreviewAutomationControlInterruptedError",
        "This browser tab belongs to another agent session or a human.",
        "agentMismatch",
      );
    case "ManagedBrowserStaleFenceError":
      return operationError(
        "PreviewAutomationControlInterruptedError",
        "Browser control changed. Take a fresh snapshot before trying again.",
        "interrupted",
      );
    case "ManagedBrowserAccessDeniedError":
      return operationError(
        "PreviewAutomationExecutionError",
        "This caller may only observe the managed browser, not operate it.",
      );
    case "ManagedBrowserMaintenanceError":
    case "ManagedBrowserBusyError":
      return operationError(
        "PreviewAutomationExecutionError",
        "The managed browser is being maintained. Try again shortly.",
      );
    case "ManagedBrowserTrackedWorkFailedError":
      return operationError(
        "PreviewAutomationExecutionError",
        "A navigation the browser started did not complete. Take a fresh snapshot.",
      );
    case "ManagedBrowserTransferFailedError":
    case "ManagedBrowserControlChangedError":
      return operationError(
        "PreviewAutomationControlInterruptedError",
        "Browser control changed. Take a fresh snapshot before trying again.",
        "interrupted",
      );
    case "ManagedBrowserChildLaunchError":
      return operationError(
        "PreviewAutomationExecutionError",
        "The managed browser could not be started.",
      );
    case "ManagedBrowserAccessNotGrantedError":
      return operationError("PreviewAutomationUnsupportedClientError", String(error.reason));
    case "ManagedBrowserChildChannelError": {
      const inner = error.cause;
      if (tagOf(inner) === "ManagedBrowserEngineError") {
        return engineErrorToOperationError(inner as ManagedBrowserIpc.ManagedBrowserEngineError);
      }
      if (tagOf(inner) === "ManagedBrowserInvalidCommandError") {
        return operationError(
          "PreviewAutomationExecutionError",
          "The managed browser refused that request as malformed.",
        );
      }
      return operationError(
        "PreviewAutomationExecutionError",
        "The managed browser stopped responding and was ended. Call preview_open to start it again.",
      );
    }
    default:
      return operationError(
        "PreviewAutomationExecutionError",
        "The managed browser operation failed.",
      );
  }
};
