import type { BuildStaleness } from "../build/build-info.js";
import type { CompileResult } from "../build/build-stage.js";

/** Self-redeploy for a self-hosting fleet (see build/build-info.ts for why): when main's build inputs
 * have moved past the running build, verify that main is green, compile it into a staging dir,
 * drain the fleet (no new ticks; in-flight ones finish or are aborted resumably after
 * RESTART_DRAIN_MAX_MS), swap the compiled tree into dist/, and ask the supervisor
 * (supervisor.ts) to respawn the harness onto it by exiting RESTART_EXIT_CODE. Every step is
 * non-blocking from the orchestrator's poll: the green check and the compile run in the
 * background and are consulted on later polls, so a slow `npm test` never stalls scheduling.
 * Completed restarts are rate-limited to one per RESTART_COOLDOWN_MS (BUGS.md 2026-09-11), so
 * sustained main churn cannot halt the fleet for a drain over and over.
 *
 * This module is the POLICY — the injectable effects interface (RedeployDeps), the
 * cooldown/escalation knobs the state machine decides with, and the RESTART_EXIT_CODE handshake
 * the supervisor respawns on. Pure policy: every effect arrives through RedeployDeps, so the
 * tests drive it with scripted fakes. The state machine that consumes this policy is Redeployer
 * in redeployer.ts; the production wiring — the mirror worktree, the baseline check, the staged
 * compile, the dist swap, the state-file record — lives beside it in redeploy.ts. The behavior
 * contract both halves serve:
 *
 * Nothing here is fail-open: a red main, a failed compile, or a swap error blocks the restart for
 * that head and the fleet keeps running the old build until main moves again. A green check that
 * REJECTS is the one non-verdict — it could not run, so it says nothing about the tree: the
 * pending head is dropped, one warning is logged per episode, and the next poll re-runs the
 * check (BUGS.md 2026-09-16). A block says so out loud — one warning event, and the reason in
 * BuildStatus.restartBlocked, which the dashboards and doctor render — because a stale build that
 * is about to be replaced and one that never will be look identical otherwise (BUGS.md
 * 2026-09-08). A green, compiled build can still be unable to START here — the environment, not
 * the code, fails `tumwater run`'s startup gate — so that gate is asked before the fleet is held
 * and again right before the swap, and a failure refuses the restart with a `restart_refused`
 * event instead of trading a running fleet for a child that exits on its first line (BUGS.md
 * 2026-09-23). Every tick a restart interrupts resumes on the new build through the same resume
 * machinery a Ctrl+C uses, so a restart loses no work. */

/** The exit code a supervised `tumwater run` child uses to say "rebuilt; respawn me" — EX_TEMPFAIL,
 * distinct from success (0), fail() (1) and a forced Ctrl+C (130). */
export const RESTART_EXIT_CODE = 75;

/** The COLD-START drain window: how long a pending restart waits for in-flight ROLE ticks before
 * aborting them (they resume on the new build) when the orchestrator has too few completed-tick
 * samples to derive one. Measured across the whole unbroken hold, not per head — see
 * Redeployer.drainSince. Director ticks are exempt: an in-flight human prompt extends the hold
 * without any cap (see poll).
 *
 * The live window tracks the fleet's real tick duration: the orchestrator passes the p75 of
 * recent completed work-bearing role ticks (InFlightCounts.roleTickP75Ms) and poll uses it in place of this
 * constant once it has enough samples (BUGS.md 2026-09-18). The hand-set 30 minutes had not been
 * re-derived since an earlier backend; measured p50 was 46 min and p75 82 min, so the drain
 * timed out on 60% of ticks — paying the full idle cost of waiting plus the interruption cost of
 * not waiting. */
export const RESTART_DRAIN_MAX_MS = 30 * 60_000;

/** How often a COMPLETED auto-restart may land — at most once per this window (BUGS.md
 * 2026-09-11): under sustained main churn every stale head would otherwise drive a full
 * hold+drain+swap episode back to back, halting the fleet for a drain over and over. Bounds
 * frequency across episodes; RESTART_DRAIN_MAX_MS bounds the drain within one. */
export const RESTART_COOLDOWN_MS = 12 * 60 * 60_000;

/** The cooldown's urgency carve-out (BUGS.md 2026-09-30): when the RUNNING build's own commit
 * carries a red baseline verdict, the deferral is cut to this window instead of the full 12 h —
 * a red running build is not churn but the exact predicament the self-redeploy exists to end,
 * and the rate limit protects against storms, not against a fleet knowingly executing code its
 * own tree fails. Still a real delay, so consecutive reds cannot storm: one episode per this
 * window at most, each swap giving the fleet a chance to land on green. */
export const RESTART_URGENT_COOLDOWN_MS = 15 * 60_000;

/** The urgent carve-out in whole minutes — the one home of that ms→min division, beside the
 * constant it derives from, so the three redeployer.ts warnings that restate the length in
 * their operator-facing text cannot disagree with the ms value if either is ever retuned. */
export const RESTART_URGENT_COOLDOWN_MIN = RESTART_URGENT_COOLDOWN_MS / 60_000;

/** How long a build may stay CONTINUOUSLY stale before the pin itself — not any one head's
 * failure — is warned about (BUGS.md 2026-09-29): under churn each per-head warning names a
 * different commit, so the aggregate — hours pinned on a stale build while every rebuild dies —
 * raised no alarm anywhere the operator reads. One warning at this age, then at most one per
 * STALE_ESCALATE_EVERY_MS for as long as the episode lasts. */
export const STALE_ESCALATE_AFTER_MS = 6 * 60 * 60_000;

/** The sustained-pin warning's repeat cadence: daily, not per poll and not per head. */
export const STALE_ESCALATE_EVERY_MS = 24 * 60 * 60_000;

/** What the orchestrator should do this poll: `hold` starts no new ticks (a restart is pending),
 * `restart` means dist/ now holds the new build — stop and exit RESTART_EXIT_CODE. */
export type RedeployAction = "none" | "hold" | "restart";

/** How many ticks are running, split by who requested them: role ticks get one drain window,
 * a director tick (an explicit human prompt) holds the restart open without any cap. */
export interface InFlightCounts {
  /** Role ticks holding a maxConcurrent permit — the ones with a pi run to wait for or abort,
   * and what `abortedTicks` reports. A tick reserved but still parked in the semaphore queue is
   * not counted: the orchestrator's start gate keeps it from starting while a restart is
   * pending, so there is nothing of it to drain (BUGS.md 2026-09-23). */
  roleInFlight: number;
  directorInFlight: number;
  /** p75 of recent completed work-bearing role-tick durations (ms) — ticks that ended with
   * something to show, never a seconds-long `no_change` re-check (runTimedRoleTick filters
   * them out; BUGS.md 2026-09-30) — or null/absent when too few samples: the drain window
   * tracks the fleet's real tick duration instead of the cold-start constant
   * (BUGS.md 2026-09-18). */
  roleTickP75Ms?: number | null;
}

/** The effects the redeploy policy drives, injectable so the policy is testable without git,
 * tsc, or a real fleet. Production wiring is createRedeployer below. */
export interface RedeployDeps {
  /** How far the running build is behind `mainHead` (null: not this repo's build). */
  staleness(mainHead: string): Promise<BuildStaleness | null>;
  /** Is main's own build/test suite green at `mainHead`? A project with no declared check (or
   * an environmental skip) reads as green — the same warn-and-proceed the gates use. */
  mainGreen(mainHead: string): Promise<boolean>;
  /** Compile `mainHead` into its staging dir and stamp it; `detail` explains a failure, and
   * `rejected` marks a compile that never ran (a spawn failure — a rejection, not a verdict).
   * A rejected promise says the same — the environment failed before a verdict could be
   * produced — and is retried on the next poll rather than latched. */
  compile(mainHead: string): Promise<CompileResult>;
  /** Move `mainHead`'s staged build into place as the live dist/. Throws on failure. */
  swap(mainHead: string): void;
  /** Would a new generation pass `tumwater run`'s startup gate in this repo right now? The
   * problem it would exit on, or null when it would boot — production asks startup-gate.ts's
   * runStartupProblem, the same function the child's own cmdRun runs (BUGS.md 2026-09-23). */
  bootProblem(): Promise<string | null>;
  /** Does `buildSha` — the RUNNING build's own commit — carry a red baseline verdict? The
   * cooldown's urgency carve-out asks this (BUGS.md 2026-09-30): a red running build cuts the
   * 12 h deferral to RESTART_URGENT_COOLDOWN_MS. A verdict already in the fleet-shared cache
   * answers free; a cold cache — no worktree has baselined this SHA in this process, which is
   * the standing state for a stale build since checkMainBaseline only ever runs at main's tip
   * — is recovered by running the baseline check ONCE on the build SHA itself, in a dedicated
   * witness worktree, which fills the same cache for every later consult. null means no
   * verdict was obtainable (no declared check, or an environmental skip) — never read as red. */
  buildRed(buildSha: string): Promise<boolean | null>;
}

/** The record of COMPLETED auto-restarts — where poll reads the cooldown's start from and
 * writes a new completion right before it returns "restart" (BUGS.md 2026-09-11). It must
 * survive the process exit that IS the restart: orchestrator.json is per-process-lifetime, so
 * production keeps this in its own small file under .tumwater/state/; tests inject their own. */
export interface AutoRestartRecord {
  /** When the last completed auto-restart landed (epoch ms) — null when none yet. Read once at
   * construction. */
  readonly lastAt: number | null;
  /** Persist a completion at `at` (epoch ms). Called inside poll immediately before it returns
   * "restart": the process exits right after, so no later cleanup could write it. */
  record(at: number): void;
}

