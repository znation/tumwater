/** The codex adapter's native-to-canonical stream translator (plans/codex-backend.md "The
 * stream translator and the rollout read that completes it"). `codex exec --json` emits one
 * JSON object per line whose vocabulary is nothing like pi's: `thread.started`, then item
 * start/completed events (`agent_message`, `command_execution`, `file_change`, `error`), and
 * finally `turn.completed` or `turn.failed`. Rather than teach ~fifteen readers a third
 * dialect, every native line is translated here into pi's vocabulary — the canonical stream —
 * so `PiStreamParser`, the raw log, the transcript, progress, and the GUI all stay unchanged.
 *
 * Pure translation: no spawn, no backend registration, no config. The factory keeps per-run
 * state (the open tool calls, the turn's usage fallback, the unmapped native types seen), so
 * call it once per run. Unmapped native types, the distinct text of `error` items, and a
 * command abandoned at the end of its turn are recorded once each on the seam's optional
 * `warnings()` — src/agent/run-agent.ts forwards each as an `agent_unknown_event` warning
 * after the run. `sessionId()` reports the thread id once `thread.started` has named it.
 */

import { nonNegativeNumber, objectOrEmpty, parseJsonObject } from "../../files/json-object.js";
import { boundText, outputLimits } from "../../pi-extension/bounded-output.js";
import type { BackendFailureKind } from "../../pi/pi-failure.js";
import type { TumwaterKind } from "../../pi/pi-stream.js";
import type { StreamTranslator } from "../agent-backend.js";

type Json = Record<string, unknown>;

/** The codex translator, narrowed to the concrete return type whose extra methods part 7/9's
 * adapter reads. */
export interface CodexStreamTranslator extends StreamTranslator {
  warnings(): string[];
  /** The thread id once `thread.started` has named it, else undefined. */
  sessionId(): string | undefined;
  /** The stream's own `turn.completed.usage` figure, kept as a fallback when the rollout
   * cannot be read (plans/codex-backend.md finding 4: the stream's usage counts the whole
   * thread, so the rollout's per-turn figure replaces it when available). */
  turnCompletedUsage(): { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined;
  /** Flag this run's usage as partial (the rollout read found nothing) so `warnings()`
   * reports `codex_usage_partial`. Part 7/9's afterRun calls it. */
  flagUsagePartial(): void;
  /** Flag that codex switched models behind the harness's back (finding 24: it can swap the
   * model on a usage limit), so `warnings()` reports `codex_model_switched {requested, ran}`.
   * Part 7/9's afterRun calls it once per switch. */
  flagModelSwitched(requested: string, ran: string): void;
  finalize(): string[];
}

/** How codex wraps every shell command — the prefix to strip (with its quoting) so the
 * canonical `bash` call carries the model's own command, which suite-rerun detection matches. */
const SHELL_WRAPPER = /^\/(?:bin\/)?(?:zsh|bash) -lc '(.*)'$/s;

/** A top-level `error` line that is Codex's own WebSocket/HTTPS reconnect ("Reconnecting...
 * n/m (reason)") — canonical `auto_retry_start`. */
const RECONNECT = /^Reconnecting\.\.\. (\d+)\/(\d+) /;

/** The item types dropped silently, with no canonical event and no `warnings()` entry
 * (design §5's `item.*` row): `todo_list` and `web_search`. */
const DROPPED_ITEM_TYPES = new Set(["todo_list", "web_search"]);

/** HTTP status classes that mean a transient backend failure (shared with the claude and
 * codex classifiers' reading of `codex exec`'s JSON error). */
const SERVER_STATUS = new Set([500, 502, 503, 504, 529]);

/** Strip codex's `/bin/zsh -lc '<cmd>'` (or `bash -lc`) wrapper and its quoting, returning
 * the model's own command — the argument suite-rerun detection matches. Passes a command the
 * capture did not wrap through unchanged. */
function innerCommand(command: string): string {
  const m = SHELL_WRAPPER.exec(command);
  return m ? m[1]! : command;
}

/** The canonical window type name for a window-minutes value (shared with the rollout reader
 * in codex-rollout.ts): Codex's 300-minute window reads as `five_hour`, its 10080-minute as
 * `seven_day`, so a reserve reads the same on claude and codex (decision 7). */
export function windowTypeName(windowMinutes: number): string {
  if (windowMinutes === 300) return "five_hour";
  if (windowMinutes === 10080) return "seven_day";
  return `${windowMinutes}_minute`;
}

/** One codex `error` item's distinct message → a run warning; repeated identical messages are
 * warned once (finding 11). */

/** How a `turn.failed` error message classifies into the canonical `tumwaterKind` (and, for a
 * transient backend, its kind), trusted by `PiStreamParser` before its text regexes. The inner
 * `message` is a JSON string carrying `status` and `error.type` / `error.code` (finding 11).
 * Returns the canonical lines to emit beside the closing `message_end`: a rejected rate-limit
 * reading when the error names a used-up window. */
function classifyTurnFailed(
  parsed: Json,
): { kind?: TumwaterKind; backendKind?: BackendFailureKind; errorMessage?: string; rateLimit?: Json } {
  const kind: { kind?: TumwaterKind; backendKind?: BackendFailureKind; errorMessage?: string; rateLimit?: Json } = {};
  const error = objectOrEmpty(parsed.error);
  const code = typeof error.code === "string" ? error.code : undefined;
  const errType = typeof error.type === "string" ? error.type : undefined;
  const message = typeof error.message === "string" ? error.message : typeof parsed.message === "string" ? parsed.message : undefined;
  kind.errorMessage = message;
  const status = nonNegativeNumber(parsed.status, undefined);

  // The context-window signal is tested BEFORE the generic 400 `invalid_request_error`
  // branch (as claude's classifyResult tests "prompt is too long" before CONFIG_STATUS): a
  // `context_window_exceeded` code, or a 400 whose message names the context window, is
  // `contextExceeded`, never `configError`.
  const namesContextWindow = (t: string | undefined): boolean =>
    t !== undefined &&
    /context window|context length|too long|exceeds? (the )?(model'?s )?context|prompt is too long/i.test(t);
  if (code === "context_window_exceeded" || (status === 400 && errType === "invalid_request_error" && namesContextWindow(message))) {
    kind.kind = "contextExceeded";
    return kind;
  }

  if (code === "usage_limit_reached" || code === "rate_limit_exceeded" || status === 429) {
    // Which window the account hit, from the error's own `rate_limit_reached_type` (else the
    // five-hour window, the one Plus exhausts first). The rejected reading's wait comes from
    // `resets_at`.
    const minutes = nonNegativeNumber(parsed.rate_limit_reached_type as number, undefined);
    const named = typeof parsed.rate_limit_reached_type === "string" ? parsed.rate_limit_reached_type : undefined;
    const resetsAt = nonNegativeNumber(parsed.resets_at, undefined);
    const retryAfter = resetsAt === undefined ? undefined : Math.max(0, Math.round(resetsAt - Date.now() / 1000));
    kind.kind = "transientRateLimit";
    kind.rateLimit = {
      type: "rate_limit",
      rateLimitType: typeof named === "string" && /_minute$|_hour$|_day$/.test(named)
        ? named
        : windowTypeName(minutes ?? 300),
      status: "rejected",
      utilization: 1,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    };
    return kind;
  }

  if (code === "usage_not_included") {
    kind.kind = "configError";
    return kind;
  }
  if (status !== undefined && SERVER_STATUS.has(status)) {
    kind.kind = "transientBackend";
    kind.backendKind = "server";
    return kind;
  }
  // A refresh-token failure and an absent/invalid login are permanent config errors, which
  // the doctor names with the login command (design §5).
  if (/refresh_token_reused|invalidated refresh token/i.test(message ?? "")) {
    kind.kind = "configError";
    return kind;
  }
  if (status === 401) {
    kind.kind = "configError";
    return kind;
  }
  if (status === 400 && errType === "invalid_request_error") {
    // A 400 `invalid_request_error` names the model as unsupported on a ChatGPT account.
    kind.kind = "configError";
    return kind;
  }
  return kind;
}

/** Build a fresh per-run codex translator. `cwd` (optional) lands on the canonical `session`
 * event (design §5's `session {id, cwd}`) so part 7/9's adapter can stamp the run's own
 * directory; when omitted the session carries no `cwd`, like the opencode translator. */
export function codexTranslator(opts: { contextWindow?: unknown; cwd?: string } = {}): CodexStreamTranslator {
  const bashLimit = outputLimits(opts.contextWindow).bash;
  const cwd = opts.cwd;
  let sessionIdValue: string | undefined;
  let sawTurnCompleted = false;
  let sawTurnFailed = false;
  /** Tool calls open on this run, keyed by the item id that started them: command_execution
   * and file_change items. A call still open when the turn ends was abandoned (finding 19).
   * The value is the item type, so the abandonment close can name a command vs an edit. */
  const openCalls = new Map<string, string>();
  let warnedAbandoned = false;
  /** The last non-reconnecting top-level `error` message, held as the fallback text for a
   * following `turn.failed` whose own message is absent (design §5). */
  let pendingFailureText: string | undefined;
  let turnUsage: { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined;
  const seenEvents = new Set<string>();
  const seenItems = new Set<string>();
  const warnings = new Set<string>();

  const recordEvent = (type: string): void => {
    if (seenEvents.has(type)) return;
    seenEvents.add(type);
    warnings.add(type);
  };
  const recordItem = (item: Json): void => {
    const key = `item:${typeof item.type === "string" ? item.type : "unknown"}`;
    if (seenItems.has(key)) return;
    seenItems.add(key);
    warnings.add(key);
  };
  /** Record one distinct `error` item message as a run warning (never a failure). */
  const recordErrorItem = (message: string): void => {
    if (warnings.has(message)) return;
    warnings.add(message);
  };
  /** Close every still-open tool call as abandoned (the turn ended while they ran, finding
   * 19): the command's open `sleep` never completed. Returns the canonical close lines.
   * The `codex_command_abandoned` warning is recorded only when an open `command_execution`
   * was actually closed (design §5), so a clean run's `warnings()` stays empty and a
   * file_change abandoned on its own does not claim a command was. */
  const abandonOpenCalls = (): string[] => {
    const out: string[] = [];
    let abandonedCommand = false;
    for (const [id, type] of openCalls) {
      openCalls.delete(id);
      if (type === "command_execution") abandonedCommand = true;
      out.push(
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: id,
          isError: true,
          ...(type === "command_execution"
            ? { result: "abandoned: the run ended while this command was still running" }
            : {}),
        }),
      );
    }
    if (abandonedCommand && !warnedAbandoned) {
      warnedAbandoned = true;
      warnings.add("codex_command_abandoned");
    }
    return out;
  };

  const translate = (line: string): string[] => {
    const parsed = parseJsonObject(line);
    if (!parsed) return []; // Non-JSON noise on stdout; ignore, as pi's parser does.
    const event = parsed as Json;
    const type = typeof event.type === "string" ? event.type : "unknown";
    const out: string[] = [];

    switch (type) {
      case "thread.started": {
        const id = typeof event.thread_id === "string" ? event.thread_id : undefined;
        if (id === undefined) {
          recordEvent(type);
          return [];
        }
        sessionIdValue = id;
        out.push(
          JSON.stringify({
            type: "session",
            id,
            ...(cwd !== undefined ? { cwd } : {}),
          }),
        );
        out.push(JSON.stringify({ type: "agent_start" }));
        return out;
      }
      case "turn.started":
        return [];
      case "turn.completed": {
        sawTurnCompleted = true;
        const usage = objectOrEmpty(event.usage);
        turnUsage =
          usage.input_tokens !== undefined || usage.output_tokens !== undefined
            ? {
                input: nonNegativeNumber(usage.input_tokens, 0),
                cacheRead: nonNegativeNumber(usage.cached_input_tokens, 0),
                cacheWrite: nonNegativeNumber(usage.cache_write_input_tokens, 0),
                output: nonNegativeNumber(usage.output_tokens, 0),
              }
            : undefined;
        return abandonOpenCalls();
      }
      case "turn.failed": {
        sawTurnFailed = true;
        // The error message is itself a JSON string (finding 11); fall back to the held
        // top-level error text when it is not.
        const raw = typeof event.error === "object" && event.error !== null && !Array.isArray(event.error)
          ? (event.error as Json).message
          : undefined;
        const inner = typeof raw === "string" ? (parseJsonObject(raw) as Json | undefined) : undefined;
        const cls = inner ? classifyTurnFailed(inner) : {};
        const errorMessage = cls.errorMessage ?? (typeof raw === "string" ? raw : pendingFailureText);
        const closes = abandonOpenCalls();
        const message: Json = { role: "assistant", content: [], stopReason: "error" };
        if (errorMessage !== undefined) message.errorMessage = errorMessage;
        const end: Json = {
          type: "message_end",
          message,
          ...(cls.kind !== undefined ? { tumwaterKind: cls.kind } : {}),
          ...(cls.backendKind !== undefined ? { backendKind: cls.backendKind } : {}),
        };
        if (cls.kind === "transientRateLimit" && typeof cls.rateLimit?.retryAfterSeconds === "number")
          end.retryAfterSeconds = cls.rateLimit.retryAfterSeconds;
        return [...(cls.rateLimit !== undefined ? [JSON.stringify(cls.rateLimit)] : []), ...closes, JSON.stringify(end)];
      }
      case "error": {
        const message = typeof event.message === "string" ? event.message : undefined;
        const reconnect = message === undefined ? undefined : RECONNECT.exec(message);
        if (reconnect) {
          return [
            JSON.stringify({
              type: "auto_retry_start",
              attempt: Number(reconnect[1]),
              maxAttempts: Number(reconnect[2]),
              errorMessage: message,
            }),
          ];
        }
        // Other top-level `error` lines are not fatal (design §5): held as the fallback text
        // for a following `turn.failed`.
        if (message !== undefined) pendingFailureText = message;
        return [];
      }
      case "item.started":
      case "item.completed": {
        const item = objectOrEmpty(event.item);
        const itemType = typeof item.type === "string" ? item.type : "unknown";
        const started = type === "item.started";
        if (itemType === "command_execution") {
          const command = typeof item.command === "string" ? item.command : "";
          if (started) {
            const id = typeof item.id === "string" ? item.id : `cmd-${openCalls.size}`;
            openCalls.set(id, "command_execution");
            const inner = innerCommand(command);
            out.push(
              JSON.stringify({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "toolCall", id, name: "bash", arguments: { command: inner } }],
                },
              }),
            );
            out.push(
              JSON.stringify({
                type: "tool_execution_start",
                toolCallId: id,
                toolName: "bash",
                args: { command: inner },
              }),
            );
          } else {
            const id = typeof item.id === "string" ? item.id : "";
            openCalls.delete(id);
            const aggregated = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
            const exitCode = nonNegativeNumber(item.exit_code, undefined);
            out.push(
              JSON.stringify({
                type: "tool_execution_end",
                toolCallId: id,
                isError: exitCode !== undefined ? exitCode !== 0 : item.status !== "completed",
                result: boundText(aggregated, bashLimit),
              }),
            );
          }
          return out;
        }
        if (itemType === "file_change") {
          const changes = Array.isArray(item.changes) ? item.changes.filter((c): c is Json => typeof c === "object" && c !== null) : [];
          const id = typeof item.id === "string" ? item.id : "";
          if (!started) {
            const isError = typeof item.status === "string" && item.status !== "completed";
            for (let i = 0; i < changes.length; i++) {
              const callId = `${id}-${i}`;
              openCalls.delete(callId);
              out.push(JSON.stringify({ type: "tool_execution_end", toolCallId: callId, isError }));
            }
            return out;
          }
          const content: Json[] = changes.map((c, i) => ({
            type: "toolCall",
            id: `${id}-${i}`,
            name: "edit",
            arguments: {
              path: typeof c.path === "string" ? c.path : undefined,
              kind: typeof c.kind === "string" ? c.kind : undefined,
            },
          }));
          if (content.length === 0) return out; // no changes to mirror, nothing else to emit
          out.push(JSON.stringify({ type: "message_end", message: { role: "assistant", content } }));
          for (let i = 0; i < content.length; i++) {
            const callId = `${id}-${i}`;
            openCalls.set(callId, "file_change");
            out.push(
              JSON.stringify({
                type: "tool_execution_start",
                toolCallId: callId,
                toolName: "edit",
                args: (content[i] as Json).arguments,
              }),
            );
          }
          return out;
        }
        if (itemType === "error") {
          // An error item is a non-fatal notice (finding 11); warned once per distinct message.
          const message = typeof item.message === "string" ? item.message : undefined;
          if (message !== undefined) recordErrorItem(message);
          return [];
        }
        if (itemType === "agent_message") {
          // The model's reply: one canonical `message_end` with one text block.
          const text = typeof item.text === "string" ? item.text : "";
          return [
            JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text }] },
            }),
          ];
        }
        if (DROPPED_ITEM_TYPES.has(itemType)) return [];
        // mcp_tool_call / reasoning and any unknown item shape map to nothing canonical; a
        // once-per-type warning only (design §5).
        recordItem(item);
        return [];
      }
      default:
        recordEvent(type);
        return [];
    }
  };

  return {
    translate,
    sessionId(): string | undefined {
      return sessionIdValue;
    },
    turnCompletedUsage(): { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined {
      return turnUsage;
    },
    flagUsagePartial(): void {
      warnings.add("codex_usage_partial");
    },
    flagModelSwitched(requested: string, ran: string): void {
      warnings.add(`codex_model_switched requested=${requested} ran=${ran}`);
    },
    finalize(): string[] {
      // The stream ended with neither turn.completed nor turn.failed (a SIGTERM the harness
      // did not send, finding 12): report the turn never finished.
      if (sawTurnCompleted || sawTurnFailed) return [];
      return [
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "error", errorMessage: "codex exited without finishing its turn" },
        }),
      ];
    },
    warnings(): string[] {
      return [...warnings];
    },
  };
}
