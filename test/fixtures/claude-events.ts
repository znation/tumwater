/** Builders for claude's `--output-format stream-json` event lines (plans/agent-backends.md
 * "Canonical event stream"), trimmed to the shapes the translator maps: the split-block
 * assistant message, `system/init`, `system/api_retry`, `system/compact_boundary`, user
 * tool results, `rate_limit_event` readings, and the final `result` in its success, API-error,
 * not-logged-in and SIGTERM spellings. Every builder is pure string shaping, the claude twin
 * of test/fixtures/pi-events.ts. */

/** A claude content block. */
export const claudeText = (text: string): Record<string, unknown> => ({ type: "text", text });
export const claudeThinking = (thinking: string): Record<string, unknown> => ({ type: "thinking", thinking });
export const claudeToolUse = (id: string, name: string, input: Record<string, unknown>): Record<string, unknown> => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** A `system/init` line: the run's cwd, session id and how it was authenticated. */
export function claudeInit(
  opts: { cwd?: string; sessionId?: string; apiKeySource?: string | null } = {},
): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: opts.cwd ?? "/work",
    session_id: opts.sessionId ?? "sess-1",
    ...(opts.apiKeySource !== undefined ? { apiKeySource: opts.apiKeySource } : {}),
  });
}

/** One `assistant` event. claude emits one per content block with the SAME `message.id` and
 * its usage repeated on each (finding 5), so a text+tool_use turn is two calls with one id. */
export function claudeAssistant(opts: {
  id?: string;
  blocks: Record<string, unknown>[];
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
  stopReason?: string | null;
}): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: opts.id ?? "msg-1",
      role: "assistant",
      content: opts.blocks,
      usage: {
        input_tokens: opts.usage?.input ?? 0,
        cache_read_input_tokens: opts.usage?.cacheRead ?? 0,
        cache_creation_input_tokens: opts.usage?.cacheWrite ?? 0,
        output_tokens: opts.usage?.output ?? 0,
      },
      ...(opts.stopReason !== undefined ? { stop_reason: opts.stopReason } : {}),
    },
  });
}

/** A `user` line carrying tool results (claude's only `user` shape this translator acts on). */
export function claudeToolResult(toolUseId: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
  });
}

/** A `system/api_retry` line. */
export function claudeApiRetry(opts: { attempt?: number; maxRetries?: number; errorStatus?: number; error?: string } = {}): string {
  return JSON.stringify({
    type: "system",
    subtype: "api_retry",
    attempt: opts.attempt ?? 1,
    max_retries: opts.maxRetries ?? 5,
    ...(opts.errorStatus !== undefined ? { error_status: opts.errorStatus } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  });
}

/** A `system/compact_boundary` line. */
export function claudeCompactBoundary(): string {
  return JSON.stringify({ type: "system", subtype: "compact_boundary" });
}

/** A `rate_limit_event` line carrying one account-window reading. */
export function claudeRateLimit(opts: {
  type?: string;
  status?: string;
  resetsAt?: number;
  utilization?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  /** claude 2.1.295's per-window readings: `unifiedWindows.<type> = {utilization, resetsAt}`. */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
} = {}): string {
  return JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      ...(opts.unifiedWindows !== undefined ? { unifiedWindows: opts.unifiedWindows } : {}),
      rateLimitType: opts.type ?? "five_hour",
      status: opts.status ?? "allowed",
      ...(opts.resetsAt !== undefined ? { resetsAt: opts.resetsAt } : {}),
      ...(opts.utilization !== undefined ? { utilization: opts.utilization } : {}),
      ...(opts.overageStatus !== undefined ? { overageStatus: opts.overageStatus } : {}),
      ...(opts.isUsingOverage !== undefined ? { isUsingOverage: opts.isUsingOverage } : {}),
    },
  });
}

/** The final `result` line. `total_cost_usd` is the run's authoritative cost; an API error
 * arrives as `subtype: "success"` with `is_error: true` (finding 9), so no builder here trusts
 * the subtype. */
export function claudeResult(opts: {
  totalCostUsd?: number;
  isError?: boolean;
  apiErrorStatus?: number | null;
  terminalReason?: string;
  text?: string;
} = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: opts.isError ?? false,
    ...(opts.totalCostUsd !== undefined ? { total_cost_usd: opts.totalCostUsd } : {}),
    ...(opts.apiErrorStatus !== undefined ? { api_error_status: opts.apiErrorStatus } : {}),
    ...(opts.terminalReason !== undefined ? { terminal_reason: opts.terminalReason } : {}),
    ...(opts.text !== undefined ? { result: opts.text } : {}),
  });
}

/** A native event type the translator has no mapping for, for the unknown-event warning test. */
export function claudeUnknown(type: string): string {
  return JSON.stringify({ type });
}
