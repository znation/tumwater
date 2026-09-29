/** Tick-scheduling POLICY, split out of orchestrator.ts (the poll-loop runtime that calls it):
 * pure decisions over a runner's state and the world — when a loop may tick, in what order
 * eligible loops take slots, and whether landed work or an open backlog defers idle
 * maintenance. No I/O, no process state: every function
 * takes plain data (a LoopRunner's observable fields, timestamps, commit subjects) so the
 * policy is unit-tested without running an orchestrator, and a future change to how ticks are
 * driven (e.g. the merge queue's async landing, PLANS.md 3/5) reuses these decisions instead of
 * re-deriving them inside the loop. Dependency direction: orchestrator → scheduling; this
 * module only reads LoopRunner through its public fields and imports no runtime from it. */

import type { LoopRunner } from "./loop.js";
import type { LoopState } from "./loop-state.js";
import { configForRole } from "./config-views.js";
import { DEFERRABLE_ROLES, DIRECTOR_ROLE, roleTier } from "./roles.js";

/** Options that vary isEligible's gates without changing their shape. */
interface EligibilityOptions {
  /** Once mode (`tumwater run --once`): the min-tick-interval clock is overridden — a
   * one-shot is an explicit demand for a round now, and without this a round started
   * shortly after a daemon run does nothing because every role's clock is still fresh.
   * The clock lives in two fields that must be overridden together: the gap check
   * (`lastTickEndedAt`) and `nextRunAt`, which scheduleAtMinInterval also writes after a
   * productive tick. Error and idle backoff share `nextRunAt` with the clock, so the
   * override keys on `backoffSeconds === 0` — only scheduleAtMinInterval leaves it at
   * zero; every backoff ladder leaves it raised. Resume gating, `s.running`, and
   * per-role enablement are kept as-is. */
  once?: boolean;
}

/** Should this loop tick now? `inboxCount` is the calling loop's own queued-prompt count
 * (the director's queue for the director, the per-role queue for everyone else) — see the
 * inbox check below. Exported for tests. */
export function isEligible(
  runner: LoopRunner,
  now: number,
  mainHead: string,
  inboxCount: number,
  opts: EligibilityOptions = {},
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
  // A queued prompt never preempts this gate: a resuming tick assembles buildResumePrompt
  // and does not dequeue the per-role queue, so an early run would only resume sooner than
  // its deliberate wait — the prompt is consumed by the fresh tick the inbox check below
  // makes due the moment the resume finishes.
  if (s.resumePending) {
    return now >= s.nextRunAt ? { run: true, reason: "resume" } : { run: false };
  }

  // A queued per-role prompt is due on its own existence, exactly like the director's inbox:
  // no min-gap, no backoff, no scheduled clock. The queue is the durable record of the
  // demand, so it survives every race a wake marker cannot — a wake consumed while a tick
  // is in flight is overwritten by that tick's end-save (loop.ts's wake() contract), but the
  // prompt file it enqueued is not, and this check picks the demand up on the first poll
  // after the tick ends.
  if (inboxCount > 0) return { run: true, reason: "inbox" };

  // The per-role interval (a slow clock, e.g. the steward's ~6 h) gates scheduled ticks and
  // "main moved" early wakes — resolved here so a live-reloaded config applies. An operator
  // wake overrides it (the woken check below): it is an explicit demand, the same class of
  // request the director's inbox runs without any gap.
  const minGap = opts.once
    ? 0
    : configForRole(runner.config, runner.role).minTickIntervalSeconds * 1000;
  const sinceLast = now - (s.lastTickEndedAt ?? 0);
  // An operator wake newer than the gap window's opening tick overrides the interval
  // (LoopState.wokenAt): an explicit "try again now" with an empty queue must not silently
  // wait out the remaining slow clock it ticked inside — a queued prompt carries its own
  // due-ness in the inbox check above, so it never depends on this stamp surviving.
  const woken = s.wokenAt !== undefined && s.wokenAt > (s.lastTickEndedAt ?? 0);
  if (sinceLast < minGap && !woken) return { run: false };
  // Once mode's clock override, second half: a raised backoffSeconds means nextRunAt is a
  // backoff deadline, not the scheduled clock, and is honored; at zero it is the clock a
  // productive tick scheduled, and the explicit round demand overrides it.
  if (now >= s.nextRunAt || (opts.once && s.backoffSeconds === 0)) {
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
 * A fresh operator wake overrides all of it: `wokenAt` newer than the gap window's opening
 * tick (the same demand predicate isEligible's min-gap exemption keys on) is an explicit "try
 * again now", not idle maintenance — the demand runs even with the backlog open, and a wake
 * older than the last tick's end was already consumed by the tick that ran after it.
 */
export function deferTick(
  s: LoopState,
  role: string,
  workLandedSinceLast: boolean,
  workBacklogOpen: boolean,
  now: number,
): boolean {
  return (
    !(s.wokenAt !== undefined && s.wokenAt > (s.lastTickEndedAt ?? 0)) &&
    DEFERRABLE_ROLES.has(role) &&
    s.lastResult === "no_change" &&
    s.lastMainHead !== "" &&
    (workBacklogOpen || !workLandedSinceLast) &&
    !deferralExpired(s, now)
  );
}
