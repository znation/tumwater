import type { LoopState } from "./types.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { statePath } from "./paths.js";

/** The loop's persisted state file — one JSON object per role under .tumwater/ — and the
 * observation-window counter reset: fresh-state defaults, the tolerant load, the atomic
 * save, and zeroCounters. The scheduling POLICY that mutates this state from tick outcomes
 * and operator wakes — backoff ladders, resume limits, applyTickOutcome/applyLandingOutcome —
 * lives in tick-outcome.ts; the generic file helpers are files.ts and the JSON convention
 * itself is json-files.ts. */

/** A new LoopState for one role, before its first tick. */
export function freshLoopState(role: string): LoopState {
  return {
    role,
    ticks: 0,
    commits: 0,
    nextRunAt: 0,
    backoffSeconds: 0,
    lastMainHead: "",
    generatedTokens: 0,
    peakContextTokens: 0,
    totalCostUsd: 0,
    dayStamp: "",
    dayCostUsd: 0,
  };
}

/** Load the loop's persisted state; never throws — a missing or unreadable file yields a
 * fresh state, and fields absent from an older file fall back to defaults. */
export function loadLoopState(root: string, role: string): LoopState {
  const saved = readJsonFile<Partial<LoopState>>(statePath(root, role));
  return { ...freshLoopState(role), ...(saved ?? {}) };
}

/** Persist the loop's state atomically via writeJsonAtomic, so a crash mid-write cannot
 * leave a torn file behind. Its per-pid tmp name matters here: two processes can write one
 * role's state concurrently — the orchestrator saves at tick end and around its review gate
 * while `tumwater reset-counters` rewrites the same file from the CLI process — and per-pid
 * names give each writer its own tmp with a clean last-writer-wins. */
export function saveLoopState(root: string, state: LoopState): void {
  writeJsonAtomic(statePath(root, state.role), state);
}

/** Zero the accumulated counters (ticks, commits, tokens, cost) so a fresh observation
 * window can begin. Pure: returns a new state and preserves everything else — scheduling
 * fields (nextRunAt, backoffSeconds), wake tracking (lastMainHead), and the last-result
 * fields. peakContextTokens is zeroed too: under per-tick semantics it holds the loop's
 * last completed tick's peak, so a fresh window must clear it or sleeping loops keep
 * showing their old value until they next tick. The daily cost budget window (dayStamp/
 * dayCostUsd) is deliberately NOT zeroed: the budget is a safety valve, not an observation
 * window — zeroing today's spend would let the cap be bypassed by running reset-counters.
 */
export function zeroCounters(s: LoopState): LoopState {
  return { ...s, ticks: 0, commits: 0, generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0 };
}
