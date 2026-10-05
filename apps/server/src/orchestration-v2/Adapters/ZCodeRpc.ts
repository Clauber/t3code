/**
 * ZCodeRpc — stdio transport for the zcode CLI's app-server ("ZCode Protocol").
 *
 * Spawns `zcode app-server` and speaks newline-delimited JSON with plain
 * `{id, method, params}` envelopes: there is no `jsonrpc` field. Client
 * requests are answered with `{id, result}` or `{id, error}`. Every other
 * stdout record is either a server→client request (`id` and `method`, such
 * as `interaction/requestPermission`) or a notification (`method` only, such
 * as `session/event`); both are surfaced on `events` in arrival order.
 *
 * The app-server never exits on its own, so the scope finalizer kills the
 * process group. Used by `ZCodeAdapterV2` for sessions and by `ZCodeProvider`
 * for its short-lived catalog probe.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { signalProcessGroup } from "../../process/processGroup.ts";

export class ZCodeRpcError extends Schema.TaggedError<ZCodeRpcError>()("ZCodeRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `ZCode ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class ZCodeRpcTimeoutError extends Schema.TaggedError<ZCodeRpcTimeoutError>()(
  "ZCodeRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `ZCode ${this.operation} failed: timed out after ${this.timeoutMs}ms.`;
  }
}

export type ZCodeRpcRecord = Record<string, unknown>;

export function zcodeRecordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

export function zcodeRecordString(input: unknown, key: string): string | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isString(value) ? value : undefined;
}

export function zcodeRecordNumber(input: unknown, key: string): number | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export interface ZCodeRpcSpawnOptions {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface ZCodeRpcConnection {
  /** Correlated request; resolves with the response `result`. */
  readonly request: (
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, ZCodeRpcError | ZCodeRpcTimeoutError>;
  /** Answers a server→client request. */
  readonly respond: (id: unknown, result: unknown) => Effect.Effect<void, ZCodeRpcError>;
  /** Refuses a server→client request, letting the CLI apply its own fallback. */
  readonly respondError: (
    id: unknown,
    code: number,
    message: string,
  ) => Effect.Effect<void, ZCodeRpcError>;
  /** Server requests and notifications, in arrival order. */
  readonly events: Queue.Queue<ZCodeRpcRecord, ZCodeRpcError>;
  /** Kill the process group; the transport fails and `events` ends. */
  readonly terminate: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE = Duration.seconds(1);
const MAX_RECORD_CHARS = 8 * 1024 * 1024;
const ERROR_DETAIL_MAX_CHARS = 200;

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

function makeJsonlFramer() {
  let buffer = "";
  let dropping = false;
  return (chunk: string): ReadonlyArray<string> => {
    const lines: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (buffer.length + end - start > MAX_RECORD_CHARS) {
          buffer = "";
          dropping = true;
        } else {
          buffer += chunk.slice(start, end);
        }
      }
      if (newline < 0) break;
      if (!dropping && buffer.length > 0) {
        lines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      }
      buffer = "";
      dropping = false;
      start = newline + 1;
    }
    return lines;
  };
}

function parseRecord(line: string): ZCodeRpcRecord | undefined {
  try {
    const parsed: unknown = decodeJsonLine(line);
    return Predicate.isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeError(error: unknown): string {
  const message = zcodeRecordString(error, "message");
  const text = message ?? (typeof error === "string" ? error : JSON.stringify(error));
  if (text === undefined) return "unknown error";
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

export const makeZCodeRpcConnection = Effect.fnUntraced(function* (options: ZCodeRpcSpawnOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const scope = yield* Effect.scope;

  const spawnCommand = yield* resolveSpawnCommand(options.command, ["app-server"], {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new ZCodeRpcError({ operation: "spawn", cause })));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        extendEnv: false,
        shell: spawnCommand.shell,
        detached: platform !== "win32",
      }),
    )
    .pipe(Effect.mapError((cause) => new ZCodeRpcError({ operation: "spawn", cause })));

  let childExited = false;
  const killProcessGroup = (signal: NodeJS.Signals): boolean => {
    try {
      if (platform === "win32") process.kill(Number(child.pid), signal);
      else signalProcessGroup(Number(child.pid), signal);
      return true;
    } catch {
      return false;
    }
  };
  // Signal 0 probes liveness; once the child is gone its pgid can be reused.
  const hasExited = (): boolean => {
    if (childExited) return true;
    try {
      if (platform === "win32") process.kill(Number(child.pid), 0);
      else signalProcessGroup(Number(child.pid), 0);
      return false;
    } catch {
      return true;
    }
  };
  const terminateProcess =
    platform === "win32"
      ? Effect.gen(function* () {
          if (hasExited()) return;
          const taskkill = yield* spawner.spawn(
            ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
          );
          yield* taskkill.exitCode;
        }).pipe(Effect.scoped, Effect.ignore)
      : Effect.gen(function* () {
          if (hasExited()) return;
          if (!killProcessGroup("SIGTERM")) return;
          yield* Effect.sleep(TERMINATION_GRACE).pipe(
            // Tests drive adapters under TestClock; the kill grace is real time.
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
          );
          if (hasExited()) return;
          killProcessGroup("SIGKILL");
        });

  // Registered first so an interrupt during setup cannot leak the process.
  yield* Scope.addFinalizer(scope, terminateProcess.pipe(Effect.ignore, Effect.uninterruptible));

  const pending = new Map<
    number,
    { readonly method: string; readonly deferred: Deferred.Deferred<unknown, ZCodeRpcError> }
  >();
  const events = yield* Queue.unbounded<ZCodeRpcRecord, ZCodeRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, ZCodeRpcError>();
  const transportDown = yield* Deferred.make<never, ZCodeRpcError>();
  const exitDeferred = yield* Deferred.make<number, ZCodeRpcError>();
  let nextRequestId = 1;
  let diagnosingStdoutClose = false;

  const failTransport = (error: ZCodeRpcError) =>
    Effect.gen(function* () {
      const claimed = yield* Deferred.fail(transportDown, error);
      if (!claimed) return;
      for (const [key, entry] of pending) {
        pending.delete(key);
        yield* Deferred.fail(entry.deferred, error);
      }
      yield* Queue.fail(outgoing, error);
      yield* Queue.fail(events, error);
    });

  const routeRecord = (record: ZCodeRpcRecord) =>
    Effect.gen(function* () {
      const id = record["id"];
      if (record["method"] === undefined && typeof id === "number") {
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        if (record["error"] !== undefined) {
          yield* Deferred.fail(
            entry.deferred,
            new ZCodeRpcError({
              operation: entry.method,
              detail: summarizeError(record["error"]),
              cause: record["error"],
            }),
          );
        } else {
          yield* Deferred.succeed(entry.deferred, record["result"]);
        }
        return;
      }
      if (typeof record["method"] === "string") yield* Queue.offer(events, record);
    });

  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Deferred.fail(exitDeferred, new ZCodeRpcError({ operation: "exit", cause })),
      onSuccess: (code) =>
        Effect.suspend(() => {
          childExited = true;
          return Deferred.succeed(exitDeferred, Number(code));
        }),
    }),
    Effect.forkIn(scope),
  );

  yield* Effect.gen(function* () {
    const frame = makeJsonlFramer();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.forEach(
          frame(chunk),
          (line) => {
            const record = parseRecord(line);
            return record === undefined ? Effect.void : routeRecord(record);
          },
          { discard: true },
        ),
      ),
    );
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => failTransport(new ZCodeRpcError({ operation: "read", cause })),
      onSuccess: () =>
        Effect.gen(function* () {
          diagnosingStdoutClose = true;
          const exitCode = yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(Duration.millis(250)),
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
            Effect.orElseSucceed(() => Option.none<number>()),
          );
          return yield* failTransport(
            new ZCodeRpcError({
              operation: "read",
              // stderr stays out of details: it can carry credentials or prompt text.
              detail: Option.isSome(exitCode)
                ? `zcode app-server exited with code ${exitCode.value}`
                : "zcode app-server closed stdout",
            }),
          );
        }),
    }),
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) =>
      diagnosingStdoutClose
        ? Effect.void
        : failTransport(new ZCodeRpcError({ operation: "write", cause })),
    ),
    Effect.forkIn(scope),
  );

  const send = (record: ZCodeRpcRecord): Effect.Effect<void, ZCodeRpcError> =>
    Effect.gen(function* () {
      const accepted = yield* Queue.offer(
        outgoing,
        new TextEncoder().encode(`${encodeJsonLine(record)}\n`),
      );
      if (!accepted) return yield* Deferred.await(transportDown);
    });

  const request = (
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Effect.Effect<unknown, ZCodeRpcError | ZCodeRpcTimeoutError> =>
    Effect.gen(function* () {
      const id = nextRequestId++;
      const deferred = yield* Deferred.make<unknown, ZCodeRpcError>();
      pending.set(id, { method, deferred });
      yield* send({ id, method, params }).pipe(
        Effect.tapError(() => Effect.sync(() => pending.delete(id))),
      );
      return yield* Effect.raceFirst(Deferred.await(deferred), Deferred.await(transportDown)).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () => Effect.fail(new ZCodeRpcTimeoutError({ operation: method, timeoutMs })),
        }),
        Effect.onExit(() => Effect.sync(() => pending.delete(id))),
      );
    });

  return {
    request,
    respond: (id, result) => send({ id, result }),
    respondError: (id, code, message) => send({ id, error: { code, message } }),
    events,
    terminate: failTransport(
      new ZCodeRpcError({ operation: "terminate", detail: "zcode app-server was stopped" }),
    ).pipe(Effect.andThen(terminateProcess), Effect.ignore, Effect.uninterruptible),
  } satisfies ZCodeRpcConnection;
});
