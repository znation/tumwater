import fs from "node:fs";
import path from "node:path";
import type { TumwaterConfig, LoopState, TickOutcome } from "./types.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { readJsonFile } from "./files.js";
import { pidAlive } from "./process.js";
import { orchestratorStatePath, statePath } from "./paths.js";

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
  };
}

/** Load the loop's persisted state; never throws — a missing or unreadable file yields a
 * fresh state, and fields absent from an older file fall back to defaults. */
export function loadLoopState(root: string, role: string): LoopState {
  const saved = readJsonFile<Partial<LoopState>>(statePath(root, role));
  return { ...freshLoopState(role), ...(saved ?? {}) };
}

/** Persist the loop's state atomically (tmp file + rename), so a crash mid-write cannot
 * leave a torn file behind. */
export function saveLoopState(root: string, state: LoopState): void {
  const file = statePath(root, state.role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Zero the accumulated counters (ticks, commits, tokens, cost) so a fresh observation
 * window can begin. Pure: returns a new state and preserves everything else — scheduling
 * fields (nextRunAt, backoffSeconds), wake tracking (lastMainHead), and the last-result
 * fields. peakContextTokens is zeroed too: under per-tick semantics it holds the loop's
 * last completed tick's peak, so a fresh window must clear it or sleeping loops keep
 * showing their old value until they next tick. */
export function zeroCounters(s: LoopState): LoopState {
  return { ...s, ticks: 0, commits: 0, generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0 };
}

/** Next backoff after a no-change tick: initial on the first, then multiplied, capped. */
export function nextBackoffSeconds(current: number, config: TumwaterConfig): number {
  const { initialSeconds, factor, maxSeconds } = config.idleBackoff;
  if (current <= 0) return Math.min(initialSeconds, maxSeconds);
  return Math.min(current * factor, maxSeconds);
}

/** Consecutive context-ceiling cut-offs after which a loop stops resuming the task and
 * falls back to a fresh tick: a task that outruns the ceiling on every attempt (even from
 * a freshly compacted context) is too big to converge, and each cycle costs an hour-plus
 * of model time on local hardware. */
const CUT_OFF_RESUME_LIMIT = 3;

/** Record a finished tick on the loop's state and schedule its next run from the outcome.
 * Split out of LoopRunner.tick() (loop.ts) so the scheduling policy — which outcomes retry
 * promptly, which back off, how cut-off resumes are bounded — sits with the other
 * scheduling helpers here instead of inline in the tick lifecycle. Mutates `s` in place:
 * the caller's state object is authoritative across an in-flight tick (see resetCounters).
 * `cfg` is the role-resolved config (configForRole): its minTickIntervalSeconds carries any
 * per-role slow clock, and idleBackoff passes through it unchanged from the top level. */
export function applyTickOutcome(
  s: LoopState,
  cfg: TumwaterConfig,
  role: string,
  outcome: TickOutcome,
): void {
  s.running = false;
  // The review gate persists phase="review" around its run so a dashboard mid-review shows
  // "reviewing". A completed tick clears it so the label never lingers — except an aborted
  // one: there the interruption hit mid-review, and the next launch must recover (and
  // re-review) the committed work fresh instead of resuming an author session whose task is
  // already committed.
  if (outcome.result !== "aborted") s.phase = undefined;
  s.lastTickEndedAt = Date.now();
  s.lastResult = outcome.result;
  if (outcome.summary) s.lastSummary = outcome.summary;
  if (outcome.result === "changed") {
    s.commits += 1;
    s.backoffSeconds = 0;
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else if (outcome.result === "rejected") {
    // The reviewer objected and the gate already reset the branch: the author should address
    // the recorded reasons on its next eligible tick, not sleep through them — schedule like
    // a change without counting a commit (nothing landed).
    s.backoffSeconds = 0;
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else if (outcome.result === "skipped") {
    // Director idles until the inbox has work; no backoff bookkeeping.
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else if (outcome.result === "aborted") {
    // Shutdown, not a verdict about the project: resume promptly on restart. The pi
    // session and the worktree's uncommitted edits were left in place, so the next tick
    // picks up exactly where this one was interrupted (director ticks instead re-queue
    // their user prompt, which runs fresh).
    if (role !== DIRECTOR_ROLE) s.resumePending = true;
    s.nextRunAt = Date.now();
  } else if (outcome.cutOff && role !== DIRECTOR_ROLE && (s.cutOffStreak ?? 0) < CUT_OFF_RESUME_LIMIT) {
    // Truncated at the context ceiling, not idle: the hour(s) of work survive in the
    // session pi just compacted, so resume it promptly instead of idle-backing-off.
    // Each resume restarts from the compacted (small) context, so repeated cut-offs on
    // one task still converge — but a task that outruns the ceiling every single time
    // would cycle forever, so after CUT_OFF_RESUME_LIMIT consecutive cut-offs the loop
    // gives up on it and falls back to a fresh tick with normal backoff.
    s.cutOffStreak = (s.cutOffStreak ?? 0) + 1;
    s.resumePending = true;
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else {
    s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, cfg);
    s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
  }
  if (!outcome.cutOff) s.cutOffStreak = 0;
}

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving
 * the fleet, since when, and with which roles. Written by runOrchestrator; read here so
 * observers (status, TUI, GUI) never depend on the scheduler module itself. */
export interface OrchestratorInfo {
  pid: number;
  startedAt: number;
  roles: string[];
}

/** Read the running orchestrator's info file; null when it is missing or unreadable.
 * Never throws — a torn write (e.g. a crash mid-write) must not take down observers
 * that poll this every second (TUI, GUI, status). */
export function readOrchestratorInfo(root: string): OrchestratorInfo | null {
  return readJsonFile<OrchestratorInfo>(orchestratorStatePath(root));
}

/** True when the recorded orchestrator's pid is still alive (see pidAlive). */
export function orchestratorAlive(root: string): boolean {
  const info = readOrchestratorInfo(root);
  if (!info) return false;
  return pidAlive(info.pid);
}
