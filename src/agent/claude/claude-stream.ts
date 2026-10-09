/** The claude adapter's native-to-canonical stream translator (plans/agent-backends.md
 * "Canonical event stream"). Claude Code's `--output-format stream-json` vocabulary differs
 * from pi's in every dimension the readers care about: one content block per `assistant`
 * event (with the same `message.id` and its usage repeated on each), tool calls named `Bash`/
 * `Read`/`File`-style, `file_path` rather than `path`, cost only in the final `result`, and
 * errors carried as `is_error` + `api_error_status` + `terminal_reason` rather than as prose
 * in a message. Rather than teach ~fifteen readers a second dialect, every native line is
 * translated here into pi's vocabulary — the canonical stream — so `PiStreamParser`, the raw
 * log, the transcript, progress, and the GUI all stay unchanged.
 *
 * Pure translation: no spawn, no backend registration, no config. The factory keeps per-run
 * state (the pending split-block assistant message, the unmapped native types seen, whether a
 * `run_cost` arrived), so call it once per run. Unmapped native types are recorded once each
 * on the seam's optional `warnings()` — src/agent/run-agent.ts forwards each as an
 * `agent_unknown_event` warning after the run. `cost_unknown` is recorded the same way when a
 * run produced no authoritative `run_cost`. */

import { isJsonObject, parseJsonObject } from "../../files/json-object.js";
import type { BackendFailureKind, TumwaterKind } from "../../pi/pi-stream.js";
import type { StreamTranslator } from "../agent-backend.js";

type Json = Record<string, unknown>;

/** The claude translator, narrowed to the concrete return type whose `warnings()` the seam
 * now also declares optional (part 3c consumes it). */
export interface ClaudeStreamTranslator extends StreamTranslator {
  /** Native event types this run did not map, plus `cost_unknown`, each once and in first-seen
   * order. Empty on a fully-mapped run. */
  warnings(): string[];
}

interface ClaudeTranslatorOptions {
  /** True when the run targets a third-party provider (an `ANTHROPIC_BASE_URL`/proxy the
   * isolation env could not scrub): the run bills as API even when `apiKeySource` is absent. */
  thirdPartyProvider?: boolean;
}

/** claude's tool names → the canonical pi names the readers already know. Glob/Grep are kept
 * lower-cased; MultiEdit collapses onto edit (pi has one edit tool). Anything else is
 * lower-cased so a future tool still reads as a name rather than as `undefined`. */
const TOOL_NAMES: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
};

/** claude's HTTP status classes that mean a transient backend failure. 529 is Anthropic's
 * "overloaded" spelling. */
const SERVER_STATUS = new Set([500, 502, 503, 504, 529]);
/** claude's HTTP status classes that mean a permanent configuration error. */
const CONFIG_STATUS = new Set([400, 401, 403, 404]);

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A finite, non-negative wire number, or undefined when unusable — the same guard pi-stream's
 * usageNumber applies, kept local because this module must not import the parser's private
 * helpers. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** claude's usage block → pi's canonical usage block, with `cost.total` 0 because the run's
 * authoritative cost rides the final `run_cost` event (a split-block message repeats its usage
 * on every event, so summing per event would double-count — the fold takes it once). */
function canonicalUsage(usage: Json | undefined): Json {
  const input = finiteNumber(usage?.input_tokens) ?? 0;
  const cacheRead = finiteNumber(usage?.cache_read_input_tokens) ?? 0;
  const cacheWrite = finiteNumber(usage?.cache_creation_input_tokens) ?? 0;
  const output = finiteNumber(usage?.output_tokens) ?? 0;
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    totalTokens: input + cacheRead + cacheWrite + output,
    cost: { total: 0 },
  };
}

/** One claude content block → one pi content block, or undefined for a block pi has no
 * vocabulary for (dropped, like any other unmapped native shape). `tool_use` becomes pi's
 * `toolCall` with the canonical name and an `arguments` object carrying claude's `input` plus
 * a `path` alias of `file_path` — `describeToolCall` reads either. */
function canonicalBlock(block: Json): Json | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: str(block.text) ?? "" };
    case "thinking":
      return { type: "thinking", thinking: str(block.thinking) ?? str(block.text) ?? "" };
    case "tool_use": {
      const input = isJsonObject(block.input) ? block.input : {};
      const args: Json = { ...input };
      if (typeof input.file_path === "string") args.path = input.file_path;
      const name = str(block.name) ?? "";
      return {
        type: "toolCall",
        id: str(block.id) ?? "",
        name: TOOL_NAMES[name] ?? name.toLowerCase(),
        arguments: args,
      };
    }
    default:
      return undefined;
  }
}

/** How a `result` event's error signals classify into the canonical `tumwaterKind` (and, for
 * a transient backend, its kind), trusted by `PiStreamParser` before its text regexes. Empty
 * when the result is not an error or carries no signal the vocabulary names — a SIGTERM
 * (`terminal_reason: "aborted_tools"`) is deliberate: the harness killed the run, so no
 * provider classification applies. `status` is `api_error_status`, which is null on the
 * not-logged-in result, so the text checks carry that case. */
function classifyResult(result: Json): {
  kind?: TumwaterKind;
  backendKind?: BackendFailureKind;
} {
  const terminal = str(result.terminal_reason);
  if (terminal === "aborted_tools") return {};
  if (terminal === "error_max_budget_usd") return { kind: "budgetCapped" };
  const text = [str(result.result), str(result.error)].filter(Boolean).join(" ");
  if (/error_max_budget_usd/i.test(text)) return { kind: "budgetCapped" };
  const status = finiteNumber(result.api_error_status);
  if (status === 429) return { kind: "transientRateLimit" };
  if (status !== undefined && SERVER_STATUS.has(status)) return { kind: "transientBackend", backendKind: "server" };
  // The context-overflow text wins over a configuration status: claude reports an oversized
  // prompt as HTTP 400 ("prompt is too long"), whose status alone would read as configError.
  if (/prompt is too long/i.test(text)) return { kind: "contextExceeded" };
  if (status !== undefined && CONFIG_STATUS.has(status)) return { kind: "configError" };
  // Text fallbacks, for the statuses claude leaves null or omits.
  if (/No conversation found with session ID/i.test(text)) return { kind: "resumeMissing" };
  if (/Not logged in|issue with the selected model|does not support this model/i.test(text))
    return { kind: "configError" };
  if (/\b429\b|rate limit/i.test(text)) return { kind: "transientRateLimit" };
  if (/overloaded|internal server error|bad gateway|service unavailable|gateway timeout|\b5\d\d\b/i.test(text))
    return { kind: "transientBackend", backendKind: "server" };
  if (/connection|econn|refused|reset|terminated/i.test(text)) return { kind: "transientBackend", backendKind: "connection" };
  if (/timed out|timeout/i.test(text)) return { kind: "transientBackend", backendKind: "timeout" };
  if (/\b(400|401|403|404)\b/i.test(text)) return { kind: "configError" };
  return {};
}

/** Build a fresh per-run claude translator. */
export function claudeTranslator(opts: ClaudeTranslatorOptions = {}): ClaudeStreamTranslator {
  /** The split-block assistant message being folded: claude emits one event per content
   * block, so a text+tool_use turn arrives as two events with the same `message.id` and the
   * full usage repeated on each. */
  let pending: { id: string; content: Json[]; usage: Json; stopReason?: string } | undefined;
  let anonymous = 0;
  let sawRunCost = false;
  /** True once the run produced real work (an assistant turn or a result) — the signal that a
   * missing `run_cost` is a gap rather than the quiet of an eventless stream. */
  let sawActivity = false;
  const seen = new Set<string>();
  const warnings = new Set<string>();

  /** Emit the pending assistant message (if any) as ONE canonical `message_end`, followed by
   * a `tool_execution_start` per tool call in order — the design emits a call's start when its
   * message closes, not when the block streams. */
  const flush = (): string[] => {
    const message = pending;
    if (!message) return [];
    pending = undefined;
    const out = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: message.content,
          usage: message.usage,
          ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
        },
      }),
    ];
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      out.push(
        JSON.stringify({
          type: "tool_execution_start",
          toolCallId: block.id,
          toolName: block.name,
          args: block.arguments,
        }),
      );
    }
    return out;
  };

  const record = (kind: string): void => {
    if (seen.has(kind)) return;
    seen.add(kind);
    warnings.add(kind);
  };

  const translate = (line: string): string[] => {
    const parsed = parseJsonObject(line);
    if (!parsed) return []; // Non-JSON noise on stdout; ignore, as pi's parser does.
    const event = parsed as Json;
    const type = str(event.type);
    switch (type) {
      case "system": {
        const subtype = str(event.subtype);
        if (subtype === "init") {
          const out: string[] = [];
          const cwd = str(event.cwd);
          const id = str(event.session_id);
          out.push(JSON.stringify({ type: "session", ...(cwd !== undefined ? { cwd } : {}), ...(id !== undefined ? { id } : {}) }));
          out.push(JSON.stringify({ type: "agent_start" }));
          const billing = billingOf(str(event.apiKeySource), opts.thirdPartyProvider === true);
          if (billing) out.push(JSON.stringify({ type: "billing", billing }));
          return out;
        }
        if (subtype === "api_retry") {
          const attempt = finiteNumber(event.attempt);
          const maxAttempts = finiteNumber(event.max_retries);
          const status = finiteNumber(event.error_status);
          const error = str(event.error) ?? "";
          const errorMessage = [status !== undefined ? `status ${status}` : "", error].filter(Boolean).join(": ");
          return [
            JSON.stringify({
              type: "auto_retry_start",
              ...(attempt !== undefined ? { attempt } : {}),
              ...(maxAttempts !== undefined ? { maxAttempts } : {}),
              errorMessage: errorMessage || "api retry",
            }),
          ];
        }
        if (subtype === "compact_boundary") return [JSON.stringify({ type: "compaction_start" })];
        record(`system:${subtype ?? "unknown"}`);
        return [];
      }
      case "assistant": {
        sawActivity = true;
        const message = isJsonObject(event.message) ? event.message : {};
        const id = str(message.id) ?? `anon-${anonymous++}`;
        if (!pending || pending.id !== id) {
          const out = flush();
          pending = { id, content: [], usage: canonicalUsage(isJsonObject(message.usage) ? message.usage : undefined) };
          const blocks = Array.isArray(message.content) ? message.content : [];
          for (const raw of blocks) {
            if (!isJsonObject(raw)) continue;
            const block = canonicalBlock(raw);
            if (block) pending.content.push(block);
          }
          const stopReason = str(message.stop_reason);
          if (stopReason !== undefined) pending.stopReason = stopReason;
          return out;
        }
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const raw of blocks) {
          if (!isJsonObject(raw)) continue;
          const block = canonicalBlock(raw);
          if (block) pending.content.push(block);
        }
        // Usage repeats on every event of the same message; the last read wins and is counted
        // once because the fold emits one message_end per id.
        pending.usage = canonicalUsage(isJsonObject(message.usage) ? message.usage : undefined);
        const stopReason = str(message.stop_reason);
        if (stopReason !== undefined) pending.stopReason = stopReason;
        return [];
      }
      case "user": {
        const out = flush();
        const message = isJsonObject(event.message) ? event.message : {};
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const raw of blocks) {
          if (!isJsonObject(raw) || raw.type !== "tool_result") continue;
          out.push(
            JSON.stringify({
              type: "tool_execution_end",
              toolCallId: str(raw.tool_use_id) ?? "",
              isError: raw.is_error === true,
            }),
          );
        }
        return out;
      }
      case "rate_limit_event": {
        const info = isJsonObject(event.rate_limit_info) ? event.rate_limit_info : {};
        const rateLimitType = str(info.rateLimitType);
        const status = str(info.status);
        const resetsAt = finiteNumber(info.resetsAt);
        const out: Json = { type: "rate_limit" };
        if (rateLimitType !== undefined) out.rateLimitType = rateLimitType;
        if (status !== undefined) out.status = status;
        if (resetsAt !== undefined) out.resetsAt = resetsAt;
        const utilization = finiteNumber(info.utilization);
        if (utilization !== undefined) out.utilization = utilization;
        const overageStatus = str(info.overageStatus);
        if (overageStatus !== undefined) out.overageStatus = overageStatus;
        if (info.isUsingOverage === true) out.isUsingOverage = true;
        if (status === "rejected" && resetsAt !== undefined) {
          // resetsAt is a unix-seconds stamp; retryAfterSeconds is the wait the loop honors.
          out.retryAfterSeconds = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
        }
        return [JSON.stringify(out)];
      }
      case "result": {
        sawActivity = true;
        const out = flush();
        const total = finiteNumber(event.total_cost_usd);
        if (total !== undefined) {
          sawRunCost = true;
          out.push(JSON.stringify({ type: "run_cost", total }));
        } else {
          warnings.add("cost_unknown");
        }
        if (event.is_error === true) {
          const { kind, backendKind } = classifyResult(event);
          const message: Json = {
            role: "assistant",
            content: [],
            stopReason: "error",
          };
          const errorMessage = str(event.result) ?? str(event.error);
          if (errorMessage !== undefined) message.errorMessage = errorMessage;
          // tumwaterKind/backendKind ride the canonical EVENT (not its message): the parser
          // reads event.tumwaterKind and trusts it before its text regexes.
          out.push(
            JSON.stringify({
              type: "message_end",
              message,
              ...(kind !== undefined ? { tumwaterKind: kind } : {}),
              ...(backendKind !== undefined ? { backendKind } : {}),
            }),
          );
        }
        return out;
      }
      default:
        record(type ?? "unknown");
        return [];
    }
  };

  return {
    translate,
    warnings(): string[] {
      // A claude run's authoritative cost is the result's total_cost_usd; a stream that did
      // real work yet never produced that total has no trustworthy cost. Recorded lazily so a
      // killed run's translator still reports it.
      if (!sawRunCost && sawActivity) warnings.add("cost_unknown");
      return [...warnings];
    },
  };
}

/** The run's billing, from `system/init.apiKeySource`: claude.ai OAuth reports `"none"`, an
 * environment key reports `ANTHROPIC_API_KEY`, a helper reports `apiKeyHelper`. A
 * third-party provider overrides both — it is API billing even when the init omitted a
 * source. Undefined when the init named no source and no third-party flag applied. */
function billingOf(apiKeySource: string | undefined, thirdPartyProvider: boolean): "subscription" | "api" | undefined {
  if (thirdPartyProvider) return "api";
  if (apiKeySource === undefined || apiKeySource === "") return undefined;
  return apiKeySource === "none" ? "subscription" : "api";
}
