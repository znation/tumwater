/** The opencode adapter's native-to-canonical stream translator (plans/opencode-backend.md
 * §6, "The stream translator"). `opencode run --format json` writes one JSON object per line
 * whose vocabulary differs from pi's in every dimension the readers care about: each step is
 * opened by `step_start` and closed by `step_finish` carrying the step's cost and tokens; a
 * tool is reported as a `tool_use` event only ONCE it has completed or errored (never while
 * it runs); and errors arrive as their own `{type: "error", error: {type, message,
 * status?, response?}}` line rather than as prose in a message. Rather than teach ~fifteen
 * readers a second dialect, every native line is translated here into pi's vocabulary — the
 * canonical stream — so `PiStreamParser`, the
 * raw log, the transcript, progress, and the GUI all stay unchanged.
 *
 * Pure translation: no spawn, no backend registration, no config. The factory keeps per-run
 * state (the open step buffer, the queued tool calls, the unmapped native types seen, whether
 * the run was refused by the free tier), so call it once per run. Unmapped native types and a
 * malformed (non-JSON) line are recorded once each on the seam's optional `warnings()`, and
 * `opencode_free_tier_refused` is added there once when any step was refused. `--thinking` is
 * never passed, so no `reasoning` event appears; the mapping below still recognizes one so a
 * future `--thinking` run degrades gracefully. */

import { canonicalUsageBlock, isJsonObject, nonNegativeNumber, objectOrEmpty, parseJsonObject } from "../../files/json-object.js";
import type { BackendFailureKind } from "../../pi/pi-failure.js";
import type { TumwaterKind } from "../../pi/pi-stream.js";
import type { StreamTranslator } from "../agent-backend.js";

type Json = Record<string, unknown>;

/** The opencode translator, narrowed to the concrete return type whose `warnings()` the seam
 * now also declares optional (part 3c consumes it). */
export interface OpencodeStreamTranslator extends StreamTranslator {
  /** Native event types this run did not map, a malformed line, and `opencode_free_tier_refused`
   * when the free tier refused a step, each once and in first-seen order. */
  warnings(): string[];
  /** Flush an open step at stream close — redeclared non-optional so callers can rely on it. */
  finalize(): string[];
  /** Record that this run's authoritative export (the post-run reconciliation, part 5/7)
   * failed or was malformed, so the seam reports `opencode_usage_partial` once and the run
   * keeps its streamed numbers. */
  noteOpencodeUsagePartial(): void;
}

/** opencode's tool names → the canonical pi names the readers already know. `shell`→`bash` and
 * `patch`→`edit` (pi has one edit tool); anything else is lower-cased so a future tool still
 * reads as a name rather than as `undefined`. */
const TOOL_NAMES: Record<string, string> = {
  shell: "bash",
  patch: "edit",
};

/** A Retry-After hint spelled out in a rate-limit error's message text ("retry after 30s" /
 * "retry in 30 seconds"). */
const RETRY_AFTER = /retry (?:after|in) (\d+)\s*s(?:econds?)?\b/i;

/** How an `error` line classifies into the canonical `tumwaterKind` (and, for a transient
 * backend, its kind), trusted by `PiStreamParser` before its text regexes. The error's
 * `type` — the provider signal the plan's table maps (provider.auth, provider.no-route,
 * unknown) — is consulted FIRST, the message text second (plans/opencode-backend.md §8 and
 * its classification table). */
function classifyError(err: Json): {
  kind?: TumwaterKind;
  backendKind?: BackendFailureKind;
  freeTier?: boolean;
  retryAfterSeconds?: number;
} {
  const message = typeof err.message === "string" ? err.message : "";
  const type = typeof err.type === "string" ? err.type : "";
  const status = err.status;
  // The free tier refuses intermittently (a provider failure, not a config error): three
  // refusals in a row move the tier to its fallback through the existing model-failure
  // episode. Typed `provider.auth` WITH status 403 — the free tier's own refusal — or the
  // text naming the free tier. A `provider.auth` with any other status (a 401 bad
  // credential) is not a refusal and falls through to the config-error row below.
  if ((type === "provider.auth" && status === 403) || /free\s?tier|FreeTierError/i.test(message))
    return { kind: "transientBackend", backendKind: "server", freeTier: true };
  // Rate limiting — 429 or rate-limit text — is the world saying "later", inherently
  // retryable; carry the echoed Retry-After hint when the message spells it.
  if (status === 429 || /\b429\b|rate limit|too many requests/i.test(message)) {
    const retry = RETRY_AFTER.exec(message);
    return { kind: "transientRateLimit", ...(retry ? { retryAfterSeconds: Number(retry[1]) } : {}) };
  }
  // An unknown model or variant, and the malformed `ses_` id, are permanent config errors
  // (a misconfiguration, not a transient outage): typed `provider.no-route` / `unknown`, or
  // the model-not-found / 401 text.
  if (
    type === "provider.no-route" ||
    type === "unknown" ||
    status === 401 ||
    /unknown model|unknown provider|model not found|provider not found|unauthorized|status\s*401|\b401\b/i.test(message)
  )
    return { kind: "configError" };
  // Context overflow that compaction could not fix. Matched STRICTLY (the same shape pi's
  // own CONTEXT_ERROR matches), so a message that merely mentions "context" or "too long"
  // in passing — a plugin error, say — is never misread as an overflow that would then be
  // trusted by PiStreamParser over its own tighter regex.
  if (/context (size|length|window)?\s*(has been |was )?exceeded|exceeds? (the )?context|too (long|large) for .*context/i.test(message))
    return { kind: "contextExceeded" };
  // Transient server, connection and timeout failures.
  if (/\b(500|501|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway timeout|overloaded/i.test(message))
    return { kind: "transientBackend", backendKind: "server" };
  if (/connection|econn|refused|reset|terminated/i.test(message)) return { kind: "transientBackend", backendKind: "connection" };
  if (/timed out|timeout/i.test(message)) return { kind: "transientBackend", backendKind: "timeout" };
  return {};
}

/** The step's token counts and cost → pi's canonical usage block: the four counts, their sum
 * as `totalTokens`, and `cost.total` = the step's USD cost (plans/opencode-backend.md §6).
 * `totalTokens` feeds `peakContextTokens`; `cost.total` accumulates into `costUsd`. */
function canonicalUsage(tokens: Json, cost: number): Json {
  const cache = objectOrEmpty(tokens.cache);
  return canonicalUsageBlock(
    nonNegativeNumber(tokens.input, 0),
    nonNegativeNumber(cache.read, 0),
    nonNegativeNumber(cache.write, 0),
    nonNegativeNumber(tokens.output, 0),
    cost,
  );
}

/** Build a fresh per-run opencode translator. */
export function opencodeTranslator(opts: { cwd?: string } = {}): OpencodeStreamTranslator {
  /** True once the run's session has been announced (the first event with a non-empty
   * `sessionID` emits `session` then `agent_start`, once). */
  let sessionStarted = false;
  /** The open step: its buffered content blocks and the tool calls reported so far. OpenCode
   * reports each call only once it has ended, so the calls are queued and emitted AFTER their
   * step's `message_end`, in order — the assistant message, then its tool executions, the
   * order every reader of the raw log assumes. */
  let step:
    | { content: Json[]; calls: { id: string; name: string; args: Json; isError: boolean }[]; usage?: Json }
    | undefined;
  const seen = new Set<string>();
  const warnings = new Set<string>();
  let sawFreeTier = false;

  const record = (kind: string): void => {
    if (seen.has(kind)) return;
    seen.add(kind);
    warnings.add(kind);
  };

  /** Emit the open step (if any) as ONE canonical `message_end` (role assistant) carrying
   * its buffered blocks and, when `withUsage`, its usage; then one `tool_execution_start`
   * followed by a `tool_execution_end` for each queued call in order. A cut-off step (stream
   * ended or an error arrived before `step_finish`) flushes without usage. */
  const flush = (withUsage: boolean): string[] => {
    const s = step;
    if (!s) return [];
    step = undefined;
    const message: Json = { role: "assistant", content: s.content };
    if (withUsage) message.usage = s.usage;
    const out = [JSON.stringify({ type: "message_end", message })];
    for (const call of s.calls) {
      out.push(
        JSON.stringify({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args }),
      );
      out.push(JSON.stringify({ type: "tool_execution_end", toolCallId: call.id, isError: call.isError }));
    }
    return out;
  };

  const translate = (line: string): string[] => {
    const parsed = parseJsonObject(line);
    if (!parsed) {
      // A malformed / non-JSON line on stdout is skipped with one warning for the run.
      record("malformed");
      return [];
    }
    const event = parsed as Json;
    // The first event with a non-empty `sessionID` announces the session and the agent start.
    // An error raised before a session exists has `sessionID: ""` (or none) and emits neither.
    let out: string[] = [];
    if (!sessionStarted) {
      const sid = event.sessionID;
      if (typeof sid === "string" && sid !== "") {
        sessionStarted = true;
        out.push(
          JSON.stringify({
            type: "session",
            id: sid,
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          }),
        );
        out.push(JSON.stringify({ type: "agent_start" }));
      }
    }

    const type = event.type;
    switch (type) {
      case "step_start":
        step = { content: [], calls: [] };
        break;
      case "text": {
        // A content block with no open buffer opens one: `step_start` is sometimes missing, and
        // edit-run.jsonl's final `text` lands after its last `step_finish`, so a block dropped
        // for want of a buffer would lose the run's last turn.
        step ??= { content: [], calls: [] };
        step.content.push({ type: "text", text: objectOrEmpty(event.part).text ?? "" });
        break;
      }
      case "reasoning": {
        step ??= { content: [], calls: [] };
        const thinking = objectOrEmpty(event.part).text ?? "";
        step.content.push({ type: "thinking", thinking: typeof thinking === "string" ? thinking : "" });
        break;
      }
      case "tool_use": {
        // As above, a tool reported with no open buffer opens one.
        step ??= { content: [], calls: [] };
        const partValue = objectOrEmpty(event.part);
        const state = objectOrEmpty(partValue.state);
        const input = objectOrEmpty(state.input);
        // `arguments` is the tool's `input` plus a `path` alias of `filePath` —
        // describeToolCall reads either.
        const args: Json = { ...input };
        if (typeof input.filePath === "string") args.path = input.filePath;
        // V2 2.0.32 emits the native tool name in `part.tool` (not `part.name`); the live
        // captures agree.
        const name = typeof partValue.tool === "string" ? partValue.tool : "";
        // Own-property test, not a bare index: a tool name like `constructor` or
        // `__proto__` would otherwise inherit a function from the table's prototype chain and
        // bypass the lower-cased fallback (the same guard claude-stream.ts applies).
        const canonicalName = Object.hasOwn(TOOL_NAMES, name) ? (TOOL_NAMES[name] ?? name.toLowerCase()) : name.toLowerCase();
        const id = typeof partValue.id === "string" ? partValue.id : "";
        step.content.push({ type: "toolCall", id, name: canonicalName, arguments: args });
        step.calls.push({ id, name: canonicalName, args, isError: state.status === "error" });
        break;
      }
      case "step_finish": {
        if (!step) break;
        const part = objectOrEmpty(event.part);
        const tokens = objectOrEmpty(part.tokens);
        const cache = objectOrEmpty(tokens.cache);
        step.usage = canonicalUsage(
          {
            input: tokens.input,
            output: tokens.output,
            cache: { read: cache.read, write: cache.write },
          },
          nonNegativeNumber(part.cost, 0),
        );
        out.push(...flush(true));
        break;
      }
      case "error": {
        // Errors carry their payload in `event.error` (`{type, message, status?, response?}`,
        // plan finding 8); classification reads type first, message second.
        const err = objectOrEmpty(event.error);
        const cls = classifyError(err);
        if (cls.freeTier) sawFreeTier = true;
        const message = typeof err.message === "string" ? err.message : "";
        // The open step (if any) is cut off by the error and flushed without usage first.
        out.push(...flush(false));
        const m: Json = { role: "assistant", content: [], stopReason: "error" };
        if (message !== "") m.errorMessage = message;
        // tumwaterKind/backendKind ride the canonical EVENT (not its message): the parser
        // reads event.tumwaterKind and trusts it before its text regexes.
        out.push(
          JSON.stringify({
            type: "message_end",
            message: m,
            ...(cls.kind !== undefined ? { tumwaterKind: cls.kind } : {}),
            ...(cls.backendKind !== undefined ? { backendKind: cls.backendKind } : {}),
            ...(cls.retryAfterSeconds !== undefined ? { retryAfterSeconds: cls.retryAfterSeconds } : {}),
          }),
        );
        break;
      }
      default:
        // Record the unknown type ("" for a type-less line), once, in first-seen order.
        record(typeof type === "string" ? type : "unknown");
        break;
    }
    return out;
  };

  return {
    translate,
    finalize(): string[] {
      // The native stream ended with a step still open (a killed run, or a stream that just
      // went idle): flush it as a message_end without usage so the last turn is not lost.
      return flush(false);
    },
    noteOpencodeUsagePartial(): void {
      warnings.add("opencode_usage_partial");
    },
    warnings(): string[] {
      // The free-tier refusal is recorded lazily so a run reports it exactly once.
      if (sawFreeTier) warnings.add("opencode_free_tier_refused");
      return [...warnings];
    },
  };
}

/** Turn an `opencode session export` object into the run's two authoritative canonical lines,
 * `run_cost` and `run_usage`, read from the export's `info`. The live stream drops the final
 * step's usage in most runs (finding 5), so the export — not the sum of the streamed steps — is
 * the run's real cost and token totals. Anything malformed returns `[]`; part 5/7 logs
 * `opencode_usage_partial` when this is empty. */
export function opencodeExportLines(exportJson: unknown): string[] {
  if (typeof exportJson !== "object" || exportJson === null || Array.isArray(exportJson)) return [];
  const info = (exportJson as Json).info;
  if (typeof info !== "object" || info === null) return [];
  const cost = nonNegativeNumber((info as Json).cost, undefined);
  if (cost === undefined) return [];
  // `info.tokens` must itself be a JSON object: a missing, scalar, or array (torn) section
  // returns [] — never a zeroed run_usage — so part 5/7's `opencode_usage_partial` trigger
  // fires. isJsonObject rejects the array a bare `typeof === "object"` lets through.
  const rawTokens = (info as Json).tokens;
  if (!isJsonObject(rawTokens)) return [];
  const tokens = rawTokens;
  const input = nonNegativeNumber(tokens.input, 0);
  const output = nonNegativeNumber(tokens.output, 0);
  const cache = objectOrEmpty(tokens.cache);
  const cacheRead = nonNegativeNumber(cache.read, 0);
  const cacheWrite = nonNegativeNumber(cache.write, 0);
  return [
    JSON.stringify({ type: "run_cost", total: cost }),
    JSON.stringify({ type: "run_usage", input, output, cacheRead, cacheWrite }),
  ];
}
