/** Tick-scheduling POLICY, split out of orchestrator.ts (the poll-loop runtime that calls it):
 * pure decisions over a runner's state and the world — when a loop may tick, in what order
 * eligible loops take slots, whether landed work or an open backlog defers idle maintenance,
 * and when the once-per-day session prune is due. No I/O, no process state: every function
 * takes plain data (a LoopRunner's observable fields, timestamps, commit subjects) so the
 * policy is unit-tested without running an orchestrator, and a future change to how ticks are
 * driven (e.g. the merge queue's async landing, PLANS.md 3/5) reuses these decisions instead of
 * re-deriving them inside the loop. Dependency direction: orchestrator → scheduling; this
 * module only reads LoopRunner through its public fields and imports no runtime from it. */

import type { LoopRunner } from "./loop.js";
import type { LoopState } from "./types.js";
import { configForRole } from "./config.js";
import { DEFERRABLE_ROLES, DIRECTOR_ROLE, roleTier } from "./roles.js";

/** Should this loop tick now? Exported for tests. */
export function isEligible(
  runner: LoopRunner,
  now: number,
  mainHead: string,
  inboxCount: number,
): { run: boolean; reason?: string } {
  const s = runner.state;
  // A role disabled in tumwater.json stops ticking immediately (live-reload); re-enabling
  // resumes within one poll cycle because the runner and its persisted state survive.
  if (!runner.config.roles[runner.role]?.enabled) return { run: false };
  if (s.running) return { run: false };

  // The director carries the user's own requests: no min-gap, no backoff — a queued
  // prompt runs as soon as the previous one finishes.
  if (runner.role === DIRECTOR_ROLE) {
    return inboxCount > 0 ? { run: true, reason: "inbox" } : { run: false };
  }

  // An interrupted tick (graceful abort or crash) leaves half-finished work in its pi
  // session and worktree: resume it promptly on restart instead of holding it for a full
  // interval — the min gap below throttles scheduled ticks, not recovery. nextRunAt still
  // gates cut-off resumes, which deliberately wait one interval from their compacted context.
  if (s.resumePending) {
    return now >= s.nextRunAt ? { run: true, reason: "resume" } : { run: false };
  }

  // The per-role interval (a slow clock, e.g. the steward's ~6 h) gates both scheduled
  // ticks and "main moved" early wakes — resolved here so a live-reloaded config applies.
  const minGap = configForRole(runner.config, runner.role).minTickIntervalSeconds * 1000;
  const sinceLast = now - (s.lastTickEndedAt ?? 0);
  if (sinceLast < minGap) return { run: false };
  if (now >= s.nextRunAt) {
    return { run: true, reason: s.ticks === 0 ? "startup" : "scheduled" };
  }
  // The world changed under a sleeping loop: main moved since its last tick.
  if (s.lastMainHead && mainHead && mainHead !== s.lastMainHead) {
    return { run: true, reason: "main moved" };
  }
  return { run: false };
}

/** Fair scheduling order for one poll's eligible loops: the director always leads (it runs
 * the user's prompts), then the work tier (feature/bugfix/plan) before maintenance — a stale-
 * ticked feature takes a slot over a fresh-ticked steward, because shipping work is what the
 * fleet exists to do — and within a tier least-recently-ticked first, so loops alternate
 * instead of the same ones re-claiming freed slots. Never-run loops tie at zero and the stable
 * sort keeps them in role-catalog (priority) order. */
export function fairOrder(runners: LoopRunner[]): LoopRunner[] {
  return [...runners].sort((a, b) => {
    if ((a.role === DIRECTOR_ROLE) !== (b.role === DIRECTOR_ROLE)) {
      return a.role === DIRECTOR_ROLE ? -1 : 1;
    }
    const tier = roleTier(a.role) - roleTier(b.role);
    if (tier !== 0) return tier;
    return (a.state.lastTickEndedAt ?? 0) - (b.state.lastTickEndedAt ?? 0);
  });
}

/** Did work land on main since a head? (Need-based prioritization, PLANS.md "Prioritize loops
 * by need".) A commit counts when its subject starts with `tumwater(feature):`,
 * `tumwater(bugfix):`, or `tumwater(director):` — the harness stamps that prefix itself
 * (buildCommitMessage), so attribution needs no new metadata; a director commit is user-directed
 * work, and after a pure-director burst the maintenance roles must resync. Or the subject
 * carries no `tumwater(` prefix at all: a human commit, where the world changed in a way the
 * fleet cannot generate itself. Every other role's landing is markdown or hygiene; waking
 * maintenance roles on it is exactly the cascade deferral removes.
 */
export function workLanded(subjects: string[]): boolean {
  return subjects.some(
    (subject) => /^tumwater\((feature|bugfix|director)\):/.test(subject) || !/^tumwater\(/.test(subject),
  );
}

/** How long a due maintenance tick may stay deferred before it is forced to run anyway. The
 * deferral predicate keys off `lastResult`, which only a completed tick updates, so without a
 * bound an open backlog (permanently true for a healthy project) plus one `no_change` tick
 * defers a role forever — the predicate's precondition is frozen by its own effect. This cap
 * breaks that latch: a deferred role ticks at least once per window, which refreshes
 * `lastResult` and lets the next deferral episode start. Three hours is a compromise between
 * the backlog-aware intent (queued feature/bugfix work outranks idle maintenance) and
 * liveness (five roles had been off for days; BUGS.md 2026-09-17). */
export const DEFER_MAX_MS = 3 * 3600 * 1000;

/** Has a due tick been deferred past DEFER_MAX_MS? `nextRunAt` is the reference: a deferred
 * tick leaves it untouched, so `now - nextRunAt` measures how long the tick has been waiting
 * past its scheduled time, survives an orchestrator restart (it is persisted state), and does
 * not fire for a `main moved` wake that arrives before the role's own clock (nextRunAt is
 * still in the future). A never-scheduled role (nextRunAt 0) is never expired. */
function deferralExpired(s: LoopState, now: number): boolean {
  return s.nextRunAt > 0 && now - s.nextRunAt >= DEFER_MAX_MS;
}

/** Should a due maintenance tick be deferred? (Need-based prioritization.) All must hold: the
 * role is one of the eight deferrable built-ins — work roles and unknown/custom never defer, the
 * harness cannot judge what an arbitrary custom role needs; its last tick did nothing; it has
 * seen main before (a never-ticked role always runs its first tick); either the backlog is
 * open — PLANS.md `## Planned` or BUGS.md `## Open` non-empty, so queued feature/bugfix work
 * outranks idle maintenance regardless of what landed — or no feature/bugfix/director/human
 * commit landed since that head; and the deferral has not outlasted DEFER_MAX_MS. Only
 * `no_change` defers: every other outcome carries pending business (retry an error, address
 * recorded review-rejection reasons, recover a merge failure) that must not stall until
 * unrelated work lands. A blocked backlog keeps maintenance deferred until the cap, then a
 * forced tick resets the episode; clearing or revising the entry lifts it on the next poll.
 */
export function deferTick(
  s: LoopState,
  role: string,
  workLandedSinceLast: boolean,
  workBacklogOpen: boolean,
  now: number,
): boolean {
  return (
    DEFERRABLE_ROLES.has(role) &&
    s.lastResult === "no_change" &&
    s.lastMainHead !== "" &&
    (workBacklogOpen || !workLandedSinceLast) &&
    !deferralExpired(s, now)
  );
}

/** Is a once-per-day session prune due? Due when retention is enabled (> 0) and a full day
 * has passed since the last prune (or no prune has run yet). */
export function dueForPrune(lastPruneAt: number | null, now: number, retentionDays: number): boolean {
  if (retentionDays <= 0) return false; // 0 disables pruning — never due.
  if (lastPruneAt === null) return true; // Never pruned yet — due immediately.
  return now - lastPruneAt >= 24 * 3600 * 1000;
}
