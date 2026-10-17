// vocabulary: plain
import { BUILD_CHECK_TIMEOUT_MS } from "../build/build-check-detect.js";
import { warnEvent, TUMWATER_SOURCE } from "../events/events.js";
import { removeQuiet } from "../files/files.js";
import type { InFlightMerge } from "../merge/merge-pipeline.js";
import { mergeStatePath } from "../paths.js";
import { runOnAbort } from "../process/process.js";
import type { TickOutcome } from "./tick-outcome.js";

/** The orchestrator's tick-timing and scheduling seams (src/orchestrator/orchestrator.ts
 * keeps the poll loop itself — the control flow that calls these). Each is exported as a
 * unit-test seam (test/orchestrator-seams.test.ts): timing a semaphore-gated tick, an
 * abort-interruptible sleep, and the restart hand-off's bounded wait on the in-flight merge.
 * Split out of orchestrator.ts — which had grown into both the poll loop and the timing helpers
 * it schedules with — so the loop reads as control flow over these named steps. The team-health
 * polls (the team hold, the error-storm warning, the failure-spread alarm) are their own family
 * in src/team/team-polls.ts. */

/** How many completed role-tick samples the p75 needs before it is trusted as the drain window.
 * Below this the orchestrator reports no p75 and poll keeps the cold-start constant. */
const DRAIN_P75_MIN_SAMPLES = 10;

/** The p75 of completed role-tick durations (ms), or null when there are too few samples to
 * trust. The orchestrator's half of the adaptive drain window (BUGS.md 2026-09-18): a tick that
 * finishes inside it is waited for, a longer one is aborted resumably. The samples come from
 * runTimedRoleTick above; the consumer is the redeploy policy's InFlightCounts.roleTickP75Ms.
 * Exported for its unit test; the p75 is the statistic the bug's expected fix names. */
export function p75TickDurationMs(durations: readonly number[]): number | null {
  if (durations.length < DRAIN_P75_MIN_SAMPLES) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] ?? null;
}

/** How long a restart's hand-off waits on an in-flight merge, per phase: one window for it to
 * finish on its own, then — having aborted it — one more for the step it was in to end
 * (awaitMergeForHandoff; BUGS.md 2026-09-23). By the time a restart reaches its `finally` the new
 * build is already in dist/ and every role tick is done or aborted, so the merge is all the team
 * is still running: each minute spent on it is a minute nothing else ticks. A merge's unbounded
 * part is model work — its reviewer run (and, until 2026-09-24, a gate build-fix run: the
 * 2026-09-23 one held the slot for 4 h 35 m and that day's hand-off sat through 97 minutes of it).
 * Its deterministic part is bounded: at most one build check (BUILD_CHECK_TIMEOUT_MS) plus git
 * steps. So a check's bound plus a minute lets a merge already past its model runs — in its
 * last check and fast-forward — merge, and gives an aborted merge's current step (a check, which
 * no abort reaches) time to end, so the hand-off does not leave a check running in a merger
 * worktree the next generation is about to reset. Not the drain's window: that is the p75 of whole
 * role ticks (over an hour on this team) — the very lag this bounds. */
export const HANDOFF_MERGE_WINDOW_MS = BUILD_CHECK_TIMEOUT_MS + 60_000;

/** Run one role tick under the concurrency semaphore and return how long the tick itself ran,
 * in ms — null when it never started (the harness is already stopping, or `held`) or was cut
 * off by an abort. This is the restart drain's p75 sample (BUGS.md 2026-09-18). The clock starts
 * only once the permit is granted, so time a tick spends parked in the semaphore queue is not
 * counted as work: the drain waits on ticks that are already running, and folding queue wait
 * into the window would overstate how long they have left (the `run_start`..`run_end` span
 * the window was sized against excludes it too). Aborted ticks return null so their short
 * cut-off lengths cannot drag the window down. So do ticks that ended with nothing to show
 * (`no_change`, `skipped`): a `main moved` re-check runs the model and still finishes in
 * seconds, and sampling it equally let a team's window collapse to the re-check scale and
 * cut real work off minutes into its run (BUGS.md 2026-09-30) — only a work-bearing outcome
 * says how long the work the drain waits on takes. `now` is a test seam.
 *
 * `held` is the team-wide hold on new ticks (today the restart drain's), re-checked at the one
 * moment a reserved tick actually begins: when its permit is granted. A tick scheduled before
 * the hold may have parked in the semaphore queue long before it; checking the hold only at
 * scheduling let every such waiter start a fresh pi run mid-drain as slots freed — the very
 * ticks the restart then aborted (BUGS.md 2026-09-23). A held tick releases its permit without
 * calling `tick`, so it writes no state and logs no run_start/run_end; the caller hands its
 * reservation back. */
export async function runTimedRoleTick(
  signal: AbortSignal,
  acquire: () => Promise<void>,
  release: () => void,
  tick: () => Promise<TickOutcome>,
  now: () => number = Date.now,
  held: () => boolean = () => false,
): Promise<number | null> {
  await acquire();
  try {
    if (signal.aborted || held()) return null;
    const startedAt = now();
    const outcome = await tick();
    if (outcome.result === "aborted" || outcome.result === "user_aborted") return null;
    if (outcome.result === "no_change" || outcome.result === "skipped") return null;
    return now() - startedAt;
  } finally {
    release();
  }
}

/** Sleep up to ms, but wake immediately when `signal` aborts — so shutdown (SIGTERM →
 * abort) is prompt instead of waiting out the current poll cycle. The listener is removed
 * on either exit path so long-running orchestrators don't accumulate one per poll, and an
 * already-aborted signal returns synchronously through runOnAbort. Exported as a unit-test
 * seam, like runTimedRoleTick above. */
export function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    runOnAbort(signal, onAbort);
  });
}

/** A one-shot deadline scheduler: run `fn` once after `ms`, returning a cancel that clears it if
 * it has not fired yet. The hand-off's window timers go through this seam, so a test can fire a
 * window by hand and reach the deadline without living through it; the production default is the
 * real `setTimeout`. (`armDeadlineTimer` in src/cli/cli-run.ts is the chunked sibling for the
 * multi-day `run --for` window; a hand-off window is always sub-32-bit.) */
export type AfterDelay = (ms: number, fn: () => void) => () => void;

const realAfterDelay: AfterDelay = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** Wait for `promise` to settle, for at most `ms`: true when it settled in time (fulfilled or
 * rejected alike — the caller only needs to know it is over), false when the deadline lapsed
 * first. The deadline is cleared on settle, so a prompt settle leaves nothing behind to hold the
 * process open. Never rejects. `after` is the deadline seam (real `setTimeout` by default): a
 * test hands one it fires itself, so the verdict is the injected deadline, not host load. */
function settlesWithin(promise: Promise<unknown>, ms: number, after: AfterDelay): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let cancel = () => {};
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(value);
    };
    cancel = after(ms, () => done(false));
    promise.then(() => done(true), () => done(true));
  });
}

/** How the restart hand-off's wait on the in-flight merge ended: it finished inside the first
 * window, it settled once aborted, or it was still running a window after the abort and the
 * hand-off went ahead without it. */
type HandoffMergeOutcome = "finished" | "aborted" | "abandoned";

/** The restart hand-off's bounded wait on the in-flight merge (BUGS.md 2026-09-23): the shutdown
 * `finally`'s merge await when this process is about to exit for the next generation. The
 * merges run a reviewer and a build check per change and a merge's check after them, so an
 * unbounded await here is a team-wide drain in disguise — the 2026-09-23 hand-off lagged its own
 * swap by 97 minutes, in silence. The wait is announced as it starts (one warning naming the
 * merge's roles), so the feed says why `restarting onto build …` is not yet followed by
 * `orchestrator stopped`. Past `windowMs` the merge is stopped the way the drain gives up on role
 * ticks: `abort` fires the harness's internal stop, which kills its pi runs at once and makes it
 * stop at its next step boundary (merge-core.ts, merge-batch.ts, and merge-stack.ts check the
 * signal before every gate, every approved merge, and each of a stack's check attempts), and a
 * warning names what was still awaited. An aborted merge records `aborted` like any shutdown
 * abort — pins kept, entries dropped, marker removed — for its roles' leftover recovery on the
 * new build. One still running a window after the abort (a step wedged past its own bound) is left
 * behind: its 4/5 marker is cleared here, since this process exits the moment the hand-off returns,
 * and its entries and pins survive exactly as a crash leaves them — the next generation's first
 * drain re-merges them. Exported as a unit-test seam, like runTimedRoleTick. */
export async function awaitMergeForHandoff(
  root: string,
  merge: Pick<InFlightMerge, "promise" | "roles">,
  windowMs: number,
  abort: () => void,
  after: AfterDelay = realAfterDelay,
): Promise<HandoffMergeOutcome> {
  const roles = merge.roles.join(", ");
  const deadline = `${windowMs / 1000}s`;
  warnEvent(
    root,
    TUMWATER_SOURCE,
    `restart waiting on the merge in progress for ${roles} (deadline ${deadline})`,
  );
  if (await settlesWithin(merge.promise, windowMs, after)) return "finished";
  abort();
  warnEvent(
    root,
    TUMWATER_SOURCE,
    `restart: the merge for ${roles} outlived its ${deadline} deadline — aborted; its pinned commits survive for the next restart`,
  );
  if (await settlesWithin(merge.promise, windowMs, after)) return "aborted";
  removeQuiet(mergeStatePath(root));
  warnEvent(
    root,
    TUMWATER_SOURCE,
    `restart: the aborted merge for ${roles} was still running ${deadline} later — restarting without it; its queue entries and pinned commits survive for the next restart`,
  );
  return "abandoned";
}

/**
 * Drain the orchestrator's in-flight work at shutdown: wait out the reserved role and director
 * ticks, and await the merge pipeline's tasks beside them — and how depends on what comes
 * next. On an operator stop the harness signal has already aborted the merge — its pi runs die
 * and it stops at its next step boundary, ending "aborted" with its ref kept and its entry
 * dropped for next-start recovery — and it is waited out: returning early would remove
 * orchestrator.json while the process is still merging, letting a second `tumwater run` start a
 * concurrent merger (a second Ctrl+C still forces the exit). On a restart the caller exits for
 * the next generation the moment this returns, and a merge is not bounded by one reviewer run
 * — a merge's check follows the verifications' — so the wait is a bounded hand-off that
 * announces itself (awaitMergeForHandoff; BUGS.md 2026-09-23). "The merge" is every merge task
 * at once — each verification holding a permit, and the merge — waited on (and, past the hand-off's
 * window, aborted) together under the roles of them all. The approved changes waiting for the
 * merge have no task, and a verification still parked for its permit has started nothing (a
 * shutdown settles it at once; a restart's closed start gate at its grant): all of them keep their
 * entries and pins for the next start.
 */
export async function drainInFlightWork(
  root: string,
  roleInFlight: ReadonlySet<Promise<void>>,
  directorInFlight: ReadonlySet<Promise<void>>,
  inFlight: readonly InFlightMerge[],
  restart: boolean,
  handoffWindowMs: number,
  abort: () => void,
  after: AfterDelay = realAfterDelay,
): Promise<void> {
  const ticks = Promise.allSettled([...roleInFlight, ...directorInFlight]);
  const merge =
    inFlight.length === 0
      ? null
      : {
          promise: Promise.allSettled(inFlight.map((t) => t.promise)).then(() => {}),
          roles: inFlight.flatMap((t) => t.roles),
        };
  if (merge && restart) {
    // The abort is the caller's internal stop, not just the merge's own controller: each task
    // wires the harness signal to its controller, and a conflict-resolution run watches the
    // harness signal alone (runLandingPi). Nothing else it reaches can start work here — the
    // director has finished, permit holders were aborted at the restart, and a parked waiter
    // meets the closed start gate (tickStartHeld) whenever it is granted a permit.
    const outcome = await awaitMergeForHandoff(root, merge, handoffWindowMs, abort, after);
    // An abandoned merge still holds its permit, so a waiter parked behind it would never be
    // granted one and never settle. The ticks have had both windows beside the hand-off, so
    // whatever is still reserved then started nothing (or is wedged like the merge): the
    // hand-off goes ahead without it too.
    if (outcome !== "abandoned") await ticks;
  } else {
    if (merge) warnEvent(root, TUMWATER_SOURCE, `shutdown waiting on the merge in progress for ${merge.roles.join(", ")}`);
    await Promise.allSettled([ticks, merge?.promise]);
  }
}
