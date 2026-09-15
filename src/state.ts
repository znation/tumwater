import fs from "node:fs";
import type { TumwaterConfig, LoopState, TickOutcome, TickResult, BackoffConfig } from "./types.js";
import type { BuildStatus } from "./build-info.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { pidAlive } from "./process.js";
import { formatDate } from "./text.js";
import { orchestratorStatePath, pausedPath, statePath } from "./paths.js";

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

/** The local calendar day as YYYY-MM-DD — the same local-time convention as every other
 * wall-clock display in the harness (lastTickCell). */
export function todayStamp(now = Date.now()): string {
  return formatDate(new Date(now));
}

/** This loop's spend for the local day (the daily cost budget window): $0 when its stamp is
 * stale or missing — a loop that hasn't ticked since yesterday reads as $0 today with no save
 * required, and spend recorded before this field existed is unknown. Reads never mutate.
 * See plans/daily-cost-budget.md. */
export function dailyCost(s: LoopState, now = Date.now()): number {
  return s.dayStamp === todayStamp(now) ? (s.dayCostUsd ?? 0) : 0;
}

/** Record a pi run's cost into the loop's daily window, rolling over at local midnight:
 * when `now` is on a different day than the recorded stamp the window resets first, so a tick
 * that crosses midnight attributes its spend to the correct day. Mutates `s` in place — like
 * applyTickOutcome and foldUsage's other counter updates, the caller's state object is
 * authoritative across an in-flight tick; the value persists at tick end with the rest of the
 * state. */
export function recordDailyCost(s: LoopState, usd: number, now = Date.now()): void {
  const stamp = todayStamp(now);
  if (s.dayStamp !== stamp) {
    s.dayStamp = stamp;
    s.dayCostUsd = 0;
  }
  s.dayCostUsd = (s.dayCostUsd ?? 0) + usd;
}

/** The fleet's spend for the local day: every loop's daily window summed. */
export function fleetDailyCost(states: LoopState[], now = Date.now()): number {
  return states.reduce((sum, s) => sum + dailyCost(s, now), 0);
}

/** True when today's spend has reached the daily cost budget — the view is non-null, its
 * cap is enabled (capUsd > 0; a cap of 0 disables the gate regardless of spend), and spend
 * sits at or above it. The single definition of "the budget gate is on": the orchestrator
 * evaluates it from live loop states via budgetPaused, and both dashboards evaluate it from
 * the snapshot's materialized budget field (status.ts) — which carries the object even while
 * disabled, so the capUsd > 0 term is what keeps a disabled fleet out of "budget paused".
 * The comparison cannot drift between what the scheduler enforces and what users see. */
export function budgetReached(budget: { spentUsd: number; capUsd: number } | null): boolean {
  return budget !== null && budget.capUsd > 0 && budget.spentUsd >= budget.capUsd;
}

/** True while the fleet's spend for the local day has reached `maxDailyCostUsd` (a cap of 0
 * disables the budget). The orchestrator re-evaluates this every poll from its runners' live
 * states and the freshly reloaded config — resume is stateless, so raising/disabling the cap
 * or crossing midnight flips it on the next cycle and nothing can get stuck. Lives here (not
 * in orchestrator.ts) because observers must not depend on the scheduler module. */
export function budgetPaused(states: LoopState[], config: TumwaterConfig, now = Date.now()): boolean {
  const cap = config.maxDailyCostUsd;
  return budgetReached(cap > 0 ? { spentUsd: fleetDailyCost(states, now), capUsd: cap } : null);
}

/** True while the operator has paused the fleet (`tumwater pause` wrote its marker). The
 * marker is persistent state, not a one-shot request: presence means paused until `resume`
 * removes it — pausing before startup starts an already-paused fleet. Never throws (a missing
 * .tumwater/ reads false). Lives here next to budgetPaused because both the scheduler and every
 * observer must evaluate it from disk without importing each other's modules — the same "single
 * definition" rule that put budgetPaused in state.ts. */
export function isFleetPaused(root: string): boolean {
  return fs.existsSync(pausedPath(root));
}

/** Next step of a backoff ladder: initial (capped) on the first step, then multiplied, capped. */
export function nextBackoffSeconds(current: number, ladder: BackoffConfig): number {
  const { initialSeconds, factor, maxSeconds } = ladder;
  if (current <= 0) return Math.min(initialSeconds, maxSeconds);
  return Math.min(current * factor, maxSeconds);
}

/** Backoff ladder for failed ticks (`error` results). The idle ladder prices hour-long model
 * runs — its cap exists so a loop that keeps finding nothing stops burning model time. A tick
 * that fails (a broken toolchain, a dead pi subprocess) often never reaches the model, so it
 * climbs this short ladder, capped in minutes: one broken `git` must not park a fleet for the
 * idle ladder's 10-hour sleep (BUGS.md, the 2026-09-15 outage). One ladder, one sensible
 * default, no knob: the cap is the point. */
export const ERROR_BACKOFF: BackoffConfig = { initialSeconds: 30, factor: 2, maxSeconds: 600 };

/** Resumes granted to one context-ceiling cut-off streak before the loop stops resuming the
 * task and falls back to a fresh tick: a task that outruns the ceiling on every attempt (even
 * from a freshly compacted context) is too big to converge, and each cycle costs an hour-plus
 * of model time on local hardware. The streak itself keeps counting (LoopState.cutOffStreak). */
const CUT_OFF_RESUME_LIMIT = 3;

/** Record a finished tick on the loop's state and schedule its next run from the outcome.
 * Split out of LoopRunner.tick() (loop.ts) so the scheduling policy — which outcomes retry
 * promptly, which back off and on which ladder, how cut-off resumes are bounded — sits with
 * the other scheduling helpers here instead of inline in the tick lifecycle. Mutates `s` in place:
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
  // The cut-off streak counts EVERY consecutive tick truncated at the context ceiling, past the
  // resume limit too: the next fresh tick's prompt names how many attempts the window has eaten
  // (buildCutOffNote), so the count must not freeze at the limit. Any other outcome resets it.
  s.cutOffStreak = outcome.cutOff ? (s.cutOffStreak ?? 0) + 1 : 0;
  // The review gate persists phase="review" around its run so a dashboard mid-review shows
  // "reviewing". A completed tick clears it so the label never lingers — except an aborted
  // one: there the interruption hit mid-review, and the next launch must recover (and
  // re-review) the committed work fresh instead of resuming an author session whose task is
  // already committed.
  if (outcome.result !== "aborted") s.phase = undefined;
  s.lastTickEndedAt = Date.now();
  s.lastResult = outcome.result;
  if (outcome.summary) s.lastSummary = outcome.summary;
  if (outcome.result === "changed" || outcome.result === "queued") {
    // "queued" schedules exactly like "changed" — the tick committed and enqueued — but the
    // commit count waits for the landing: `commits` keeps meaning "landed on main", and
    // applyLandingOutcome increments it when the change actually lands. The phase-clear above
    // (`result !== "aborted"`) covers both.
    if (outcome.result === "changed") s.commits += 1;
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
  } else if (outcome.result === "quiet_killed") {
    // A hung tool call, not an idle verdict or a shutdown: the kill left the pi session and
    // the worktree's uncommitted edits intact, so resume them promptly like an interruption.
    // The cause is named in state so the bridge prompt tells the resumed session its run died
    // on a stalled tool call (director ticks never resume — their prompt was re-queued fresh).
    if (role !== DIRECTOR_ROLE) {
      s.resumePending = true;
      s.resumeCause = "hung-tool";
    }
    s.nextRunAt = Date.now();
  } else if (outcome.result === "user_aborted") {
    // A deliberate stop, not an interruption: the worktree was already reset to main and a
    // director prompt deliberately dropped, so there is nothing to resume — schedule like an
    // unproductive tick (idle backoff) instead of resuming promptly. phase is cleared by the
    // `result !== "aborted"` check above.
    s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, cfg.idleBackoff);
    s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
  } else if (outcome.result === "error") {
    // A failed tick, not an idle verdict: it often never reached the model, so it retries on
    // the short error ladder (capped in minutes) instead of the idle ladder, whose cap prices
    // hour-long model runs. backoffSeconds is shared: each ladder advances from the current
    // value, so an error streak capped at the error ceiling never sleeps LESS than the loop
    // already was sleeping, and the idle ladder picks up from there if the failures stop.
    s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, ERROR_BACKOFF);
    s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
  } else if (outcome.cutOff && role !== DIRECTOR_ROLE && s.cutOffStreak <= CUT_OFF_RESUME_LIMIT) {
    // Truncated at the context ceiling, not idle: the hour(s) of work survive in the
    // session pi just compacted, so resume it promptly instead of idle-backing-off.
    // Each resume restarts from the compacted (small) context, so repeated cut-offs on
    // one task still converge — but a task that outruns the ceiling every single time
    // would cycle forever, so after CUT_OFF_RESUME_LIMIT resumes the loop gives up on it
    // and falls back to a fresh tick with normal backoff (its prompt carrying the streak).
    s.resumePending = true;
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else {
    s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, cfg.idleBackoff);
    s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
  }
}

/** Record a completed LANDING on the authoring loop's state (plans/merge-queue.md 3/5):
 * the orchestrator calls this on the state object the landing ran against — the runner's live
 * copy when one exists, a disk load otherwise — then saves it, the same in-place discipline
 * applyTickOutcome has (the caller's state object is authoritative; a role with a queued or
 * in-flight landing never ticks, so no other writer holds it meanwhile). Sets `lastResult`
 * to the lander's outcome, increments `commits` only on a success (the "landed on main"
 * counter applyTickOutcome's "queued" branch left to the landing), and clears `phase` — the
 * gate persisted `phase = "review"` on this same state object during the run, exactly as it
 * did inside a tick, so the label must not linger past the landing (mirroring
 * applyTickOutcome's rule: every outcome except "aborted" clears it — an aborted landing
 * keeps it, because the interruption hit mid-review and the next launch must recover and
 * re-review the pinned work). `lastSummary` is left untouched: the tick's summary stays, and
 * the failure detail rides in `lastReview` and the landed/land_failed events. */
export function applyLandingOutcome(s: LoopState, result: TickResult): void {
  s.lastResult = result;
  if (result === "changed") s.commits += 1;
  if (result !== "aborted") s.phase = undefined;
}

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving
 * the fleet, since when, and with which roles. Written by runOrchestrator; read here so
 * observers (status, TUI, GUI) never depend on the scheduler module itself. */
export interface OrchestratorInfo {
  pid: number;
  startedAt: number;
  roles: string[];
  /** The running build's stamp and staleness (src/build-info.ts); absent when dist/ carries no
   * stamp. Written at start and refreshed by the orchestrator whenever main moves, so observers
   * read one file instead of running git themselves. */
  build?: BuildStatus;
}

/** Read the running orchestrator's info file; null when it is missing or unreadable.
 * Never throws — a torn write (e.g. a crash mid-write) must not take down observers
 * that poll this every second (TUI, GUI, status). */
export function readOrchestratorInfo(root: string): OrchestratorInfo | null {
  return readJsonFile<OrchestratorInfo>(orchestratorStatePath(root));
}

/** True when the recorded orchestrator's pid is still alive (see pidAlive). Callers that have
 * already loaded the info file may pass it in to avoid a second read — snapshot() loads it once
 * per poll and uses it for both the displayed pid and this liveness check. */
export function orchestratorAlive(root: string, info?: OrchestratorInfo | null): boolean {
  const i = info ?? readOrchestratorInfo(root);
  if (!i) return false;
  return pidAlive(i.pid);
}
