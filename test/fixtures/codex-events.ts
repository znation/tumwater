/** Loaders and small builders for the codex translator and rollout reader
 * (plans/codex-backend.md, PLANS.md "Codex backend, part 6/9"). The real 0.163.0 captures in
 * test/fixtures/codex-captures/ (hand step H1, taken 2026-10-20) are read verbatim — its
 * README.md maps each file to its finding — while the builders synthesize the two shapes no
 * capture holds: a used-up usage window (the binary's message + a `usage_limit_reached` code,
 * finding 11) and a rollout `turn_context` whose model differs from the requested one
 * (finding 24). Pure string shaping, the codex twin of test/fixtures/claude-events.ts. */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of the directory holding the raw captures. They are source assets tsc does
 * not copy into dist, so resolve them from the test source tree: from the compiled module
 * (dist/test/fixtures) that is three levels up to the repo root, and from the source module
 * (test/fixtures) one. Other fixtures reach repo-root files (docs/, PLANS.md) the same way. */
function capturesDir(): string {
  const fromDist = fileURLToPath(new URL("../../../test/fixtures/codex-captures/", import.meta.url));
  if (existsSync(fromDist)) return fromDist;
  return fileURLToPath(new URL("./codex-captures/", import.meta.url));
}

const CAPTURES = capturesDir();

function loadLines(name: string): string[] {
  return readFileSync(CAPTURES + name, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** The real captures, keyed by the README's file name. */
export const codexCaptures = {
  /** production flags: the model lists its tools, edits through apply_patch (a `file_change`
   * with an absolute path), then runs one command (findings 3, 7, 15). */
  editRun: loadLines("edit-run.jsonl"),
  /** `seq 1 200000`: `aggregated_output` held everything, cut to 4,000 chars here (finding 18). */
  oversizedOutput: loadLines("oversized-output.jsonl"),
  /** the model told not to poll: `exec_command` returned after 30 s, Codex killed the command,
   * and the item never completed (finding 19). */
  abandonedCommand: loadLines("abandoned-command.jsonl"),
  /** `sleep 600`: one `command_execution` item open for the whole ten minutes, then completed
   * with exit code 0 (finding 19). */
  longCommand: loadLines("long-command.jsonl"),
  /** an empty `CODEX_HOME`: the reconnect lines, then `turn.failed` with the 401 (finding 11). */
  notLoggedIn: loadLines("not-logged-in.jsonl"),
  /** `-m no-such-model`: status 400 `invalid_request_error` (finding 11). */
  unknownModel: loadLines("unknown-model.jsonl"),
  /** production flags, SIGTERM mid-command: the stream stops after `item.started` (finding 12). */
  sigtermMidCommand: loadLines("sigterm-mid-command.jsonl"),
  /** the rollout of the two runs (first + resume): per-turn `token_usage_record`, `token_count`
   * rate limits, one `task_started` / `task_complete` per run (findings 4, 5, 7). */
  editRunAndResumeRollout: readFileSync(CAPTURES + "edit-run-and-resume-rollout.jsonl", "utf8"),
};

/** One `turn.failed` error line holding the inner JSON message. The builders below shape it
 * for the cases no capture holds; the inner fields mirror what finding 11's binary strings and
 * finding 4/5's rollout (`resets_at`, `rate_limit_reached_type`) carry. */
function codexTurnFailed(opts: {
  status: number;
  errorType: string;
  errorMessage: string;
  code?: string;
  resetsAt?: number;
  rateLimitReachedType?: string;
}): string {
  const inner: Record<string, unknown> = {
    type: "error",
    status: opts.status,
    error: { type: opts.errorType, ...(opts.code !== undefined ? { code: opts.code } : {}), message: opts.errorMessage },
  };
  if (opts.resetsAt !== undefined) inner.resets_at = opts.resetsAt;
  if (opts.rateLimitReachedType !== undefined) inner.rate_limit_reached_type = opts.rateLimitReachedType;
  return JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify(inner) } });
}

/** The used-up usage window the binary's message describes (finding 11): a 429 with the
 * `usage_limit_reached` code, naming the five-hour window and when it resets. */
export function codexUsedUpWindow(resetsAt: number): string {
  return codexTurnFailed({
    status: 429,
    errorType: "invalid_request_error",
    code: "usage_limit_reached",
    errorMessage: "You've hit your usage limit. Upgrade to Plus …\nTry again at 10:00 PM PST.",
    resetsAt,
    rateLimitReachedType: "five_hour",
  });
}

/** A 400 `invalid_request_error` whose code (or message) names the context window — the
 * classifier must read it as `contextExceeded`, never the generic 400 `configError`. */
export function codexContextWindow400(opts: { code?: string; message?: string } = {}): string {
  return codexTurnFailed({
    status: 400,
    errorType: "invalid_request_error",
    code: opts.code !== undefined ? opts.code : "context_window_exceeded",
    errorMessage: opts.message ?? "The requested context window 258400 tokens was exceeded",
  });
}

/** A single rollout `turn_context` record naming the model that actually ran — for a synthetic
 * rollout that switches models mid-thread (finding 24). */
export function codexTurnContext(model: string): string {
  return JSON.stringify({
    timestamp: "2026-10-21T00:00:00.000Z",
    type: "turn_context",
    payload: { type: "turn_context", turn_id: "t-1", model },
  });
}

/** A synthetic `item.started` / `item.completed` line for a dropped item type (`todo_list`,
 * `web_search`) or an unknown one — what the stream tests feed to pin the silent-drop and
 * once-warning rules. */
export function codexItem(mode: "started" | "completed", item: Record<string, unknown>): string {
  return JSON.stringify({ type: `item.${mode}`, item });
}
