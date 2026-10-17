/** Loaders for opencode's `run --format json` event streams (plans/opencode-backend.md §6,
 * "The stream translator"). These are the REAL 2.0.32 captures in
 * test/fixtures/opencode-captures/ (hand step H1, taken 2026-10-17), read verbatim so the
 * translator is exercised against the exact shapes the live probe produced — the lossy event
 * boundaries, `part.tool`/`part.id`, `state.input`, the `provider.auth` / `provider.no-route`
 * / `unknown` error types, and the missing final `step_start`. The opencode twin of
 * test/fixtures/claude-events.ts.
 *
 * Builders are kept ONLY for the cases the probe never produced — a 429, a 5xx, and a context
 * overflow — each shaped like the captured `error` events it is synthetic for. Everything else
 * comes from the real captures. */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of the directory holding the raw captures. They are source assets tsc does
 * not copy into dist, so resolve them from the test source tree: from the compiled module
 * (dist/test/fixtures) that is four levels up to the repo root, and from the source module
 * (test/fixtures) two levels. Other fixtures reach repo-root files (docs/, PLANS.md) the
 * same upward way. */
function capturesDir(): string {
  const fromDist = fileURLToPath(new URL("../../../test/fixtures/opencode-captures/", import.meta.url));
  if (existsSync(fromDist)) return fromDist;
  return fileURLToPath(new URL("./opencode-captures/", import.meta.url));
}

const CAPTURES = capturesDir();

function loadLines(name: string): string[] {
  return readFileSync(CAPTURES + name, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** The real captures, keyed by the README's file name. */
export const opencodeCaptures = {
  /** read → edit → shell → a final text with no `step_start` after the last `step_finish`; the
   * run whose export reconcilers the stream. */
  editRun: loadLines("edit-run.jsonl"),
  /** `opencode session export` of edit-run: `info.cost` 0, `info.tokens` input 3223 / output
   * 433 / cache.read 7680. */
  editRunExport: readFileSync(CAPTURES + "edit-run-export.json", "utf8"),
  /** Two tool calls in one step, arriving in completion order, no final `step_finish`. */
  parallelTools: loadLines("parallel-tools.jsonl"),
  /** `seq 1 200000`: the `bash` call carries the canonical command `seq 1 200000`. */
  oversizedOutput: loadLines("oversized-output.jsonl"),
  /** Both 403 `provider.auth` / FreeTierError refusals (a `ses_` id; a denied `read`). */
  freeTierRefused: loadLines("free-tier-refused.jsonl"),
  freeTierRefusedReadDenied: loadLines("free-tier-refused-read-denied.jsonl"),
  /** `provider.no-route` "Model unavailable" and "Variant unavailable …"; the `unknown`
   * "Expected a string starting with \"ses\"" raised before any session exists. */
  unknownModel: loadLines("unknown-model.jsonl"),
  unavailableVariant: loadLines("unavailable-variant.jsonl"),
  malformedSessionId: loadLines("malformed-session-id.jsonl"),
  /** The role-notes MCP tool appearing mid-run and working as `tumwater_role_notes`, plus a
   * final `text "DONE"` with no open `step_start` buffer. */
  mcpToolLate: loadLines("mcp-tool-late.jsonl"),
  /** The end-of-run notes pattern (follow-up probe, finding 21): read, shell, then a final
   * `tumwater_role_notes` call saving the note — the shape that worked 6 of 6. */
  mcpNotesEndOfRun: loadLines("mcp-notes-end-of-run.jsonl"),
  /** A resumed session that did get its final `step_finish`; the streamed-only counterpoint. */
  resume: loadLines("resume.jsonl"),
};

/** A synthetic error line folding to `transientRateLimit`: the probe never produced a 429, so
 * this is hand-built in the captured `{type: "error", error: {type, message, status?}}` shape.
 * The translator echoes a Retry-After hint the message spells out. */
export function opencodeRateLimit(message = "Rate limit exceeded (status 429). retry after 30 seconds"): string {
  return JSON.stringify({ type: "error", error: { type: "error", message, status: 429 } });
}

/** A synthetic 5xx error line folding to `transientBackend` / `server` — the probe never
 * produced a server fault. */
export function opencodeServerError(message = "internal server error (status 500)"): string {
  return JSON.stringify({ type: "error", error: { type: "error", message, status: 500 } });
}

/** A synthetic context-overflow error line folding to `contextExceeded` — the probe never
 * exercised one. */
export function opencodeContextOverflow(message = "context window exceeded"): string {
  return JSON.stringify({ type: "error", error: { type: "error", message } });
}

/** A torn / non-JSON stdout line, for the malformed-line warning test. */
export function opencodeMalformed(tail: string): string {
  return `not json ${tail}`;
}
