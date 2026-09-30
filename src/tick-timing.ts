import { BUILD_CHECK_TIMEOUT_MS } from "./build-check-detect.js";
import { errorStorm, errorStormKnob, type ErrorStorm } from "./error-storm.js";
import { logEvent, warnEvent } from "./events.js";
import { removeQuiet } from "./files.js";
import type { LoopState } from "./loop-state.js";
import type { InFlightLanding } from "./landing-pipeline.js";
import { landingStatePath } from "./paths.js";
import { fleetHold, type FleetHold, type HoldObservation } from "./fleet-hold.js";
import type { BackendFailureKind } from "./pi.js";
import type { TickOutcome } from "./tick-outcome.js";

/** The orchestrator's tick-timing and scheduling seams (src/orchestrator.ts keeps the poll loop
 * itself — the control flow that calls these). Each is exported as a unit-test seam
 * (test/orchestrator-seams.test.ts): timing a semaphore-gated tick, an abort-interruptible
 * sleep, one poll of the fleet-wide hold, and the restart hand-off's bounded wait on the
 * in-flight landing. Split out of orchestrator.ts — which had grown into both the poll loop and
 * the timing helpers it schedules with — so the loop reads as control flow over these named
 * steps. */
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

/** How long a restart's hand-off waits on an in-flight landing, per phase: one window for it to
 * finish on its own, then — having aborted it — one more for the step it was in to end
 * (awaitLandingForHandoff; BUGS.md 2026-09-23). By the time a restart reaches its `finally` the
 * new build is already in dist/ and every role tick is done or aborted, so the landing is all
 * the fleet is still running: each minute spent on it is a minute nothing else ticks. A
 * landing's unbounded part is model work — its reviewer run (and, until 2026-09-24, a gate
 * build-fix run: the 2026-09-23 one held the slot for 4 h 35 m and that day's hand-off sat
 * through 97 minutes of it). Its deterministic part is bounded: at most one build check (BUILD_CHECK_TIMEOUT_MS) plus
 * git steps. So a check's bound plus a minute lets a landing already past its model runs — in
 * its last check and fast-forward — land, and gives an aborted landing's current step (a check,
 * which no abort reaches) time to end, so the hand-off does not leave a check running in a
 * lander worktree the next generation is about to reset. Not the drain's window: that is the
 * p75 of whole role ticks (over an hour on this fleet) — the very lag this bounds. */
export const HANDOFF_LANDING_WINDOW_MS = BUILD_CHECK_TIMEOUT_MS + 60_000;

/** Run one role tick under the concurrency semaphore and return how long the tick itself ran,
 * in ms — null when it never started (the harness is already stopping, or `held`) or was cut
 * off by an abort. This is the restart drain's p75 sample (BUGS.md 2026-09-18). The clock starts
 * only once the permit is granted, so time a tick spends parked in the semaphore queue is not
 * counted as work: the drain waits on ticks that are already running, and folding queue wait
 * into the window would overstate how long they have left (the `tick_start`..`tick_end` span
 * the window was sized against excludes it too). Aborted ticks return null so their short
 * cut-off lengths cannot drag the window down. `now` is a test seam.
 *
 * `held` is the fleet-wide hold on new ticks (today the restart drain's), re-checked at the one
 * moment a reserved tick actually begins: when its permit is granted. A tick scheduled before
 * the hold may have parked in the semaphore queue long before it; checking the hold only at
 * scheduling let every such waiter start a fresh pi run mid-drain as slots freed — the very
 * ticks the restart then aborted (BUGS.md 2026-09-23). A held tick releases its permit without
 * calling `tick`, so it writes no state and logs no tick_start/tick_end; the caller hands its
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
    return now() - startedAt;
  } finally {
    release();
  }
}

/** Sleep up to ms, but wake immediately when `signal` aborts — so shutdown (SIGTERM →
 * abort) is prompt instead of waiting out the current poll cycle. The listener is removed
 * on either exit path so long-running orchestrators don't accumulate one per poll. An
 * ALREADY-aborted signal returns synchronously: addEventListener alone would never fire
 * (the abort event has come and gone), leaving shutdown to wait out a full poll. Exported
 * as a unit-test seam, like runTimedRoleTick above. */
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
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One poll of the fleet-wide backend-failure hold (src/fleet-hold.ts): gather each
 * runner's latest run that ended on a provider failure — LoopRunner.lastRateLimit (429s,
 * stamped with the "rate-limit" kind) and LoopRunner.lastBackendFailure (the connection,
 * timeout, server, and model-load kinds) — every role's, the director's included, since its
 * failures are the same provider's evidence — step the pure gate, and log exactly one event
 * per crossing, like the budget gate's: `rate_limit_hold` on the way in (which kind, which
 * roles tripped it, for how long, and how many relapses deep it is) and `rate_limit_resumed`
 * when it re-opens at its own deadline. Returns the new hold for the caller to keep. Exported
 * as a unit-test seam, like runTimedRoleTick above. */
/** A runner as the hold poll reads it: the role and its two episodic observations, both
 * optional (a runner with neither simply contributes nothing). Structural, so tests stand in
 * plain objects for the runner — its real getters are readonly, and only these fields are
 * ever read. */
export type HoldInputs = {
  role: string;
  lastRateLimit?: { at: number; retryAfterSeconds?: number };
  lastBackendFailure?: { at: number; kind: BackendFailureKind };
};

export function pollFleetHold(
  root: string,
  prev: FleetHold,
  runners: readonly HoldInputs[],
  now: number,
): FleetHold {
  const observations: HoldObservation[] = runners.flatMap((r) => [
    ...(r.lastRateLimit
      ? [{ role: r.role, kind: "rate-limit" as const, at: r.lastRateLimit.at, retryAfterSeconds: r.lastRateLimit.retryAfterSeconds }]
      : []),
    ...(r.lastBackendFailure
      ? [{ role: r.role, kind: r.lastBackendFailure.kind, at: r.lastBackendFailure.at }]
      : []),
  ]);
  const next = fleetHold(prev, observations, now);
  if (prev.until === null && next.until !== null) {
    logEvent(root, {
      loop: "harness",
      type: "rate_limit_hold",
      kind: next.kind,
      roles: next.roles,
      holdMs: next.until - now,
      escalation: next.escalation,
    });
  } else if (prev.until !== null && next.until === null) {
    // The ended hold's kind rides the resumed event: the hold's own event names its kind, so
    // the lift must be able to name what actually ended too — "429 hold lifted" after a
    // connection-error hold is the same lie the hold line's kind split removed
    // (BUGS.md 2026-09-29).
    logEvent(root, { loop: "harness", type: "rate_limit_resumed", kind: next.kind });
  }
  return next;
}

/** One poll of the fleet-wide error-storm warning (src/error-storm.ts): gather each runner's
 * current error streak (LoopState.consecutiveErrors/lastError — the same fields the per-role
 * "consecutive tick failures" warning reads, the director's included, since its failures are
 * the fleet's evidence too), step the pure reducer, and log exactly one warning per episode,
 * like the per-role warning's once-per-streak-crossing shape: on the quiet→storm crossing,
 * naming the roles, the shared normalized cause, and the config knob when the cause has one
 * (a fleet timing out together means tickTimeoutSeconds does not fit the serving model).
 * Storms clear silently — the members' own recoveries already tell that story — and the
 * reducer's `prev` pass-through keeps a held storm event-free. Returns the new storm for the
 * caller to keep. Exported as a unit-test seam, like pollFleetHold above. */
export function pollErrorStorm(
  root: string,
  prev: ErrorStorm,
  runners: readonly { role: string; state: Pick<LoopState, "consecutiveErrors" | "lastError"> }[],
): ErrorStorm {
  const observations = runners.map((r) => ({
    role: r.role,
    consecutiveErrors: r.state.consecutiveErrors ?? 0,
    lastError: r.state.lastError,
  }));
  const next = errorStorm(prev, observations);
  if (next.key !== null && next.key !== prev.key) {
    const knob = errorStormKnob(next.key);
    logEvent(root, {
      loop: "harness",
      type: "warning",
      message:
        `error storm — ${next.roles.length} roles failing consecutively on one shared cause ` +
        `(${next.key})${knob ? ` — ${knob} likely does not fit the serving model` : ""}: ` +
        next.roles.join(", "),
      roles: next.roles,
      cause: next.key,
      ...(knob ? { knob } : {}),
    });
  }
  return next;
}

/** Wait for `promise` to settle, for at most `ms`: true when it settled in time (fulfilled or
 * rejected alike — the caller only needs to know it is over), false when the deadline lapsed
 * first. The timer is cleared on settle, so a prompt settle leaves nothing behind to hold the
 * process open. Never rejects. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

/** How the restart hand-off's wait on the in-flight landing ended: it finished inside the first
 * window, it settled once aborted, or it was still running a window after the abort and the
 * hand-off went ahead without it. */
type HandoffLandingOutcome = "finished" | "aborted" | "abandoned";

/** The restart hand-off's bounded wait on the in-flight landing (BUGS.md 2026-09-23): the
 * shutdown `finally`'s landing await when this process is about to exit for the next
 * generation. The landings run a reviewer and a build check per change and a merge's check
 * after them, so an unbounded await here is a fleet-wide drain in disguise — the 2026-09-23
 * hand-off lagged its own swap by 97 minutes, in silence. The wait is announced as it starts (one warning naming
 * the landing's roles), so the feed says why `restarting onto build …` is not yet followed by
 * `orchestrator stopped`. Past `windowMs` the landing is stopped the way the drain gives up on
 * role ticks: `abort` fires the harness's internal stop, which kills its pi runs at once and
 * makes it stop at its next step boundary (lander.ts and landing-batch.ts check the signal before
 * every gate, every approved landing, and each of a stack's check attempts), and a warning
 * names what was still awaited.
 * An aborted landing records `aborted` like any shutdown abort — pins kept, entries dropped,
 * marker removed — for its roles' leftover recovery on the new build. One still running a
 * window after the abort (a step wedged past its own bound) is left behind: its 4/5 marker is
 * cleared here, since this process exits the moment the hand-off returns, and its entries and
 * pins survive exactly as a crash leaves them — the next generation's first drain re-lands
 * them. Exported as a unit-test seam, like runTimedRoleTick. */
export async function awaitLandingForHandoff(
  root: string,
  landing: Pick<InFlightLanding, "promise" | "roles">,
  windowMs: number,
  abort: () => void,
): Promise<HandoffLandingOutcome> {
  const roles = landing.roles.join(", ");
  const deadline = `${windowMs / 1000}s`;
  warnEvent(
    root,
    "harness",
    `restart hand-off waiting on the in-flight landing of ${roles} (deadline ${deadline})`,
  );
  if (await settlesWithin(landing.promise, windowMs)) return "finished";
  abort();
  warnEvent(
    root,
    "harness",
    `restart hand-off: the landing of ${roles} outlived its ${deadline} deadline — aborted; its pinned commits survive for the next generation`,
  );
  if (await settlesWithin(landing.promise, windowMs)) return "aborted";
  removeQuiet(landingStatePath(root));
  warnEvent(
    root,
    "harness",
    `restart hand-off: the aborted landing of ${roles} was still running ${deadline} later — handing off without it; its queue entries and pinned commits survive for the next generation`,
  );
  return "abandoned";
}

/**
 * Drain the orchestrator's in-flight work at shutdown: wait out the reserved role and director
 * ticks, and await the landing pipeline's tasks beside them — and how depends on what comes
 * next. On an operator stop the harness signal has already aborted the landing — its pi runs die
 * and it stops at its next step boundary, ending "aborted" with its ref kept and its entry
 * dropped for next-start recovery — and it is waited out: returning early would remove
 * orchestrator.json while the process still lands, letting a second `tumwater run` start a
 * concurrent lander (a second Ctrl+C still forces the exit). On a restart the caller exits for
 * the next generation the moment this returns, and a landing is not bounded by one reviewer run
 * — a merge's check follows the vets' — so the wait is a bounded hand-off that announces itself
 * (awaitLandingForHandoff; BUGS.md 2026-09-23). "The landing" is every landing task at once —
 * each vet holding a permit, and the merge — waited on (and, past the hand-off's window,
 * aborted) together under the roles of them all. The vetted changes waiting for the merge have
 * no task, and a vet still parked for its permit has started nothing (a shutdown settles it at
 * once; a restart's closed start gate at its grant): all of them keep their entries and pins
 * for the next start.
 */
export async function drainInFlightWork(
  root: string,
  roleInFlight: ReadonlySet<Promise<void>>,
  directorInFlight: ReadonlySet<Promise<void>>,
  inFlight: readonly InFlightLanding[],
  restart: boolean,
  handoffWindowMs: number,
  abort: () => void,
): Promise<void> {
  const ticks = Promise.allSettled([...roleInFlight, ...directorInFlight]);
  const landing =
    inFlight.length === 0
      ? null
      : {
          promise: Promise.allSettled(inFlight.map((t) => t.promise)).then(() => {}),
          roles: inFlight.flatMap((t) => t.roles),
        };
  if (landing && restart) {
    // The abort is the caller's internal stop, not just the landing's own controller: each task
    // wires the harness signal to its controller, and a conflict-resolution run watches the
    // harness signal alone (runLandingPi). Nothing else it reaches can start work here — the
    // director has finished, permit holders were aborted at the restart, and a parked waiter
    // meets the closed start gate (tickStartHeld) whenever it is granted a permit.
    const outcome = await awaitLandingForHandoff(root, landing, handoffWindowMs, abort);
    // An abandoned landing still holds its permit, so a waiter parked behind it would never be
    // granted one and never settle. The ticks have had both windows beside the hand-off, so
    // whatever is still reserved then started nothing (or is wedged like the landing): the
    // hand-off goes ahead without it too.
    if (outcome !== "abandoned") await ticks;
  } else {
    if (landing) warnEvent(root, "harness", `shutdown waiting on the in-flight landing of ${landing.roles.join(", ")}`);
    await Promise.allSettled([ticks, landing?.promise]);
  }
}
