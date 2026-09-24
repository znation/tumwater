import type { HarnessEventInput } from "./events.js";
import {
  type BuildInfo,
  type BuildStaleness,
  type BuildStatus,
  BUILD_INPUTS,
  buildStaleness,
  distDir,
  isSelfHosted,
  readBuildInfo,
} from "./build-info.js";
import { type BuildCheckOutcome, buildCheckRunFields } from "./build-check.js";
import { defaultConfig, loadConfigCached } from "./config.js";
import { checkMainBaseline } from "./main-baseline.js";
import { compileStaged, swapDist } from "./build-stage.js";
import { readJsonFile, writeJsonFile } from "./json-files.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { autoRestartStampPath, mirrorWorktreePath } from "./paths.js";
import { errorMessage, shortSha } from "./text.js";

/** Self-redeploy for a self-hosting fleet (see build-info.ts for why): when main's build inputs
 * have moved past the running build, verify that main is green, compile it into a staging dir,
 * drain the fleet (no new ticks; in-flight ones finish or are aborted resumably after
 * RESTART_DRAIN_MAX_MS), swap the compiled tree into dist/, and ask the supervisor (cli.ts,
 * supervisor.ts) to respawn the harness onto it by exiting RESTART_EXIT_CODE. Every step is
 * non-blocking from the orchestrator's poll: the green check and the compile run in the
 * background and are consulted on later polls, so a slow `npm test` never stalls scheduling.
 * Completed restarts are rate-limited to one per RESTART_COOLDOWN_MS (BUGS.md 2026-09-11), so
 * sustained main churn cannot halt the fleet for a drain over and over.
 *
 * Nothing here is fail-open: a red main, a failed compile, or a swap error blocks the restart for
 * that head and the fleet keeps running the old build until main moves again. A green check that
 * REJECTS is the one non-verdict — it could not run, so it says nothing about the tree: the
 * pending head is dropped, one warning is logged per episode, and the next poll re-runs the
 * check (BUGS.md 2026-09-16). A block says so
 * out loud — one warning event, and the reason in BuildStatus.restartBlocked, which the
 * dashboards and doctor render — because a stale build that is about to be replaced and one
 * that never will be look identical otherwise (BUGS.md, 2026-09-08). A green, compiled build
 * can still be unable to START here — the environment, not the code, fails `tumwater run`'s
 * startup gate — so that gate is asked before the fleet is held and again right before the
 * swap, and a failure refuses the restart with a `restart_refused` event instead of trading a
 * running fleet for a child that exits on its first line (BUGS.md 2026-09-23). Every tick a restart
 * interrupts resumes on the new build through the same resume machinery a Ctrl+C uses, so a
 * restart loses no work. */

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
 * recent completed role ticks (InFlightCounts.roleTickP75Ms) and poll uses it in place of this
 * constant once it has enough samples (BUGS.md 2026-09-18). The hand-set 30 minutes had not been
 * re-derived since an earlier backend; measured p50 was 46 min and p75 82 min, so the drain
 * timed out on 60% of ticks — paying the full idle cost of waiting plus the interruption cost of
 * not waiting. */
const RESTART_DRAIN_MAX_MS = 30 * 60_000;

/** How many completed role-tick samples the p75 needs before it is trusted as the drain window.
 * Below this the orchestrator reports no p75 and poll keeps the cold-start constant. */
const DRAIN_P75_MIN_SAMPLES = 10;

/** The p75 of completed role-tick durations (ms), or null when there are too few samples to
 * trust. The orchestrator's half of the adaptive drain window (BUGS.md 2026-09-18): a tick that
 * finishes inside it is waited for, a longer one is aborted resumably. Exported for its unit
 * test; the p75 is the statistic the bug's expected fix names. */
export function p75TickDurationMs(durations: readonly number[]): number | null {
  if (durations.length < DRAIN_P75_MIN_SAMPLES) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] ?? null;
}

/** How often a COMPLETED auto-restart may land — at most once per this window (BUGS.md
 * 2026-09-11): under sustained main churn every stale head would otherwise drive a full
 * hold+drain+swap episode back to back, halting the fleet for a drain over and over. Bounds
 * frequency across episodes; RESTART_DRAIN_MAX_MS bounds the drain within one. */
export const RESTART_COOLDOWN_MS = 12 * 60 * 60_000;

/** What the orchestrator should do this poll: `hold` starts no new ticks (a restart is pending),
 * `restart` means dist/ now holds the new build — stop and exit RESTART_EXIT_CODE. */
type RedeployAction = "none" | "hold" | "restart";

/** How many ticks are running, split by who requested them: role ticks get one drain window,
 * a director tick (an explicit human prompt) holds the restart open without any cap. */
interface InFlightCounts {
  /** Role ticks holding a maxConcurrent permit — the ones with a pi run to wait for or abort,
   * and what `abortedTicks` reports. A tick reserved but still parked in the semaphore queue is
   * not counted: the orchestrator's start gate keeps it from starting while a restart is
   * pending, so there is nothing of it to drain (BUGS.md 2026-09-23). */
  roleInFlight: number;
  directorInFlight: number;
  /** p75 of recent completed role-tick durations (ms), or null/absent when too few samples: the
   * drain window tracks the fleet's real tick duration instead of the cold-start constant
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
  /** Compile `mainHead` into its staging dir and stamp it; `detail` explains a failure. */
  compile(mainHead: string): Promise<{ ok: boolean; detail: string }>;
  /** Move `mainHead`'s staged build into place as the live dist/. Throws on failure. */
  swap(mainHead: string): void;
  /** Would a new generation pass `tumwater run`'s startup gate in this repo right now? The
   * problem it would exit on, or null when it would boot — production asks startup-gate.ts's
   * runStartupProblem, the same function the child's own cmdRun runs (BUGS.md 2026-09-23). */
  bootProblem(): Promise<string | null>;
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

/** The production AutoRestartRecord: one JSON file under .tumwater/state/. A missing or torn
 * file reads as "no completed restart yet" — the same no-data policy as every other state reader. */
export function autoRestartRecord(root: string): AutoRestartRecord {
  const file = autoRestartStampPath(root);
  const stored = readJsonFile<{ at?: unknown }>(file)?.at;
  return {
    lastAt: typeof stored === "number" && Number.isFinite(stored) ? stored : null,
    record: (at) => writeJsonFile(file, { at }),
  };
}

/** A background task the poll consults without awaiting: settled flag plus result. */
interface Tracked<T> {
  done: boolean;
  result?: T;
  error?: string;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { done: false };
  promise.then(
    (r) => {
      t.result = r;
      t.done = true;
    },
    (err: unknown) => {
      t.error = errorMessage(err);
      t.done = true;
    },
  );
  return t;
}

/** Event input as the orchestrator logs it (logEvent stamps ts). */
type RedeployEvent = HarnessEventInput;

/** The redeploy state machine — one per orchestrator process. `poll` is called every scheduler
 * cycle with main's current head and how many role/director ticks are in flight, and returns what
 * to do; it never throws and never awaits anything slower than a git query. */
export class Redeployer {
  private lastHead: string | null = null;
  private staleness: BuildStaleness | null = null;
  /** The head a restart is pending for. */
  private pendingHead: string | null = null;
  /** When the fleet's current unbroken hold began — 0 when it is not being held. The drain
   * deadline is measured from here and NOT from when the current head became pending: a busy
   * self-hosting fleet merges while it drains, and giving each new head its own full window
   * handed the same in-flight ticks another 30 minutes every time main moved. On 2026-09-08 that
   * held the fleet for 38 minutes under a 30-minute cap and reported the last 30 (BUGS.md).
   * Nothing new starts during a hold, so the ticks a drain waits on can only be the ones it
   * began with — one window is all they are owed. */
  private drainSince = 0;
  /** The drain window captured when the current hold began: the fleet's observed p75 tick
   * duration when the orchestrator has enough samples, else the cold-start RESTART_DRAIN_MAX_MS.
   * Captured once per unbroken hold so a sample change mid-episode cannot move a deadline that
   * is already running (see drainSince). */
  private drainWindowMs = 0;
  private green: Tracked<boolean> | null = null;
  private compiled: Tracked<{ ok: boolean; detail: string }> | null = null;
  /** A head whose restart was blocked (red main, compile failure, swap error): no retry until
   * main moves — the warning was logged once. */
  private blockedHead: string | null = null;
  /** Why, in a few words, for status() to publish alongside the staleness verdict. */
  private blockedReason: string | null = null;
  /** When the last completed auto-restart landed (epoch ms), or null when none yet — copied from
   * restartRecord at construction and updated when this process completes one. The cooldown is
   * measured from here on every poll (BUGS.md 2026-09-11). */
  private lastAutoRestartAt: number | null = null;
  /** Whether the current cooldown episode's deferral was already warned about — one warning per
   * episode, not one per poll and not one per head: the cooldown condition is head-independent,
   * so a landing mid-cooldown adds no new information (BUGS.md 2026-09-19). Cleared when the
   * deadline lapses, so the next episode warns once. */
  private cooldownWarned = false;
  /** The head whose green check already warned that it could not run (a rejection, not a red
   * verdict) — one warning per episode. */
  private checkFailedHead: string | null = null;
  /** Why the last restart attempt was refused because a new generation could not boot here
   * (see refuse), or null when the startup gate last passed. Not latched to a head like
   * blockedHead: the gate is asked again on every poll, so repairing the environment lets the
   * same head proceed without main moving. Also the dedupe key — one `restart_refused` per
   * distinct reason, not one per poll, and head-independent like the cooldown warning: a
   * landing mid-refusal adds no new information. */
  private refusedReason: string | null = null;
  /** The live autoRestart flag as last seen by poll — status() publishes the cooldown reason only
   * while it is on (off means no restart will ever be attempted, so a deadline would mislead). */
  private autoRestartOn = true;

  constructor(
    readonly build: BuildInfo,
    /** False when this project is not the harness itself: the build is then never stale with
     * respect to this main, and poll is a no-op (see isSelfHosted). */
    readonly selfHosted: boolean,
    private readonly deps: RedeployDeps,
    private readonly log: (event: RedeployEvent) => void,
    /** Cold-start drain window (default RESTART_DRAIN_MAX_MS): the fallback poll uses until the
     * orchestrator supplies enough observed tick durations; a test seam. */
    private readonly drainMaxMs: number = RESTART_DRAIN_MAX_MS,
    /** The completed-auto-restart record (see AutoRestartRecord) — production reads it from its
     * state file at construction via autoRestartRecord(root), tests inject one. */
    private readonly restartRecord: AutoRestartRecord = { lastAt: null, record: () => {} },
  ) {
    this.lastAutoRestartAt = restartRecord.lastAt;
  }

  /** What orchestrator.json publishes (see BuildStatus). `now` is the same clock poll was given
   * — a test seam, since the cooldown deadline is only meaningful against it. */
  status(now = Date.now()): BuildStatus {
    const s: BuildStatus = { sha: this.build.sha, builtAt: this.build.builtAt };
    if (this.lastHead !== null && this.staleness) {
      s.stale = this.staleness.stale;
      s.aheadCommits = this.staleness.aheadCommits;
      s.checkedHead = this.lastHead;
      // Why a stale build is still the one running. Staleness alone cannot say: a restart that
      // is minutes away and one that was refused hours ago look identical, and on 2026-09-08
      // that gap is what let a blocked restart sit unnoticed while the fleet ticked on stale
      // code (BUGS.md). Mutually exclusive by construction — block() clears the pending head,
      // and an episode cannot start inside the cooldown, so no two branches can hold at once.
      if (this.pendingHead === this.lastHead) s.restartPending = true;
      else if (this.blockedHead === this.lastHead && this.blockedReason) s.restartBlocked = this.blockedReason;
      // Inside the post-restart cooldown the fleet deliberately keeps ticking on the stale build
      // — say so with a deadline, through the same channel as a refused restart (BUGS.md 2026-09-11).
      // Past it, a startup gate that keeps failing holds the fleet on the stale build just as
      // surely, and says why the same way (BUGS.md 2026-09-23).
      else if (s.stale && this.autoRestartOn) {
        const until = this.cooldownUntil();
        if (now < until) s.restartBlocked = `cooldown until ${new Date(until).toISOString()}`;
        else if (this.refusedReason !== null) s.restartBlocked = `the new build could not start: ${this.refusedReason}`;
      }
    }
    return s;
  }

  /** When the current post-restart cooldown expires (epoch ms), or 0 when none is running. */
  private cooldownUntil(): number {
    return this.lastAutoRestartAt !== null ? this.lastAutoRestartAt + RESTART_COOLDOWN_MS : 0;
  }

  /** Decide this poll's action. `autoRestart` is the live config flag: off keeps the staleness
   * verdict (dashboards still show it) but never drains or restarts. */
  async poll(
    mainHead: string,
    inFlight: InFlightCounts,
    autoRestart: boolean,
    now = Date.now(),
  ): Promise<RedeployAction> {
    this.autoRestartOn = autoRestart;
    if (!this.selfHosted || !mainHead) return this.endDrain();
    if (mainHead !== this.lastHead) {
      const wasStale = this.staleness?.stale ?? false;
      this.lastHead = mainHead;
      this.staleness = await this.deps.staleness(mainHead);
      const stale = this.staleness?.stale ?? false;
      if (stale && !wasStale) {
        this.log({
          loop: "harness",
          type: "build_stale",
          build: this.build.sha,
          head: mainHead,
          aheadCommits: this.staleness?.aheadCommits ?? 0,
        });
      }
      // A moved main supersedes any restart in progress for the previous head: its compile
      // (if running) finishes into its own staging dir and is simply never swapped in.
      if (this.pendingHead !== null && this.pendingHead !== mainHead) this.clearPending();
    }
    if (!this.staleness?.stale || !autoRestart || this.blockedHead === mainHead) return this.endDrain();

    // Completed auto-restarts are rate-limited to one per RESTART_COOLDOWN_MS (BUGS.md 2026-09-11):
    // under sustained churn every stale head would otherwise drive a full hold+drain+swap episode
    // back to back. Inside the cooldown the fleet keeps ticking on the stale build exactly as when
    // a restart is blocked — no pendingHead, no green check, no drain, no new-tick block. This is
    // re-evaluated on every poll rather than latched like blockedHead: once the deadline passes,
    // the same head proceeds even if main never moves again.
    const cooldownUntil = this.cooldownUntil();
    if (now < cooldownUntil) {
      if (!this.cooldownWarned) {
        this.cooldownWarned = true;
        this.warn(
          `auto-restart of ${shortSha(mainHead)} deferred — cooldown until ${new Date(cooldownUntil).toISOString()} (at most one completed restart per 12 h)`,
        );
      }
      return this.endDrain();
    }
    // The cooldown has lapsed (or never started): the next episode warns once more.
    this.cooldownWarned = false;

    if (this.pendingHead === null) {
      // Before holding anything: could a new generation even boot here? A refusal here costs
      // nothing — no hold, no green check, no compile — so asking again every poll is how a
      // repaired environment (the config restored, pi back on PATH) lets the restart proceed.
      const problem = await this.bootProblem();
      if (problem !== null) return this.refuse(mainHead, problem);
      this.refusedReason = null;
      this.pendingHead = mainHead;
      // Only when the fleet was not already being held: a superseded head hands its drain over
      // to the new one rather than starting a fresh window (see drainSince).
      if (!this.drainSince) {
        this.drainSince = now;
        // Capture the window with the hold: the observed p75 when the orchestrator has it,
        // otherwise the cold-start constant.
        const p75 = inFlight.roleTickP75Ms;
        this.drainWindowMs = typeof p75 === "number" && p75 > 0 ? p75 : this.drainMaxMs;
      }
      this.green = track(this.deps.mainGreen(mainHead));
      this.compiled = null;
      return "hold";
    }
    if (!this.green?.done) return "hold";
    // A REJECTED check is not a verdict: it could not run (git broke inside the mirror worktree,
    // or the check itself threw), so it says nothing about the tree. Drop the pending head — no
    // blockedHead, no latched "main is red" — warn once per episode, and let the next poll
    // re-run the check on the same head; a fleet whose toolchain recovers redeploys itself
    // without main ever moving (BUGS.md 2026-09-16). A red VERDICT below still blocks.
    if (this.green.error) {
      if (this.checkFailedHead !== mainHead) {
        this.checkFailedHead = mainHead;
        this.warn(`green check of ${shortSha(mainHead)} could not run: ${this.green.error} — retrying on the next poll`);
      }
      this.clearPending();
      return this.endDrain();
    }
    if (this.green.result !== true) {
      const reason = `main ${shortSha(mainHead)} is red`;
      this.block(mainHead, reason, `${reason} — holding the restart until main is green`);
      return this.endDrain();
    }
    if (!this.compiled) {
      this.compiled = track(this.deps.compile(mainHead));
      this.log({
        loop: "harness",
        type: "restart_pending",
        build: this.build.sha,
        head: mainHead,
        aheadCommits: this.staleness.aheadCommits,
      });
      return "hold";
    }
    if (!this.compiled.done) return "hold";
    const c = this.compiled.result;
    if (!c?.ok) {
      const reason = `rebuild of ${shortSha(mainHead)} failed`;
      this.block(
        mainHead,
        reason,
        `${reason} — staying on build ${shortSha(this.build.sha)}: ${c?.detail ?? this.compiled.error ?? "compile threw"}`,
      );
      return this.endDrain();
    }
    // The drain rule, split by who requested the work (BUGS.md 2026-09-08): a director tick is
    // an explicit human prompt and outranks the redeploy — while one is in flight the hold has no
    // time cap: no swap and no abort until it finishes. The per-tick watchdogs already bound how
    // long one run can take, so this cannot hang the fleet beyond what a single tick can do.
    if (inFlight.directorInFlight > 0) return "hold";
    if (inFlight.roleInFlight > 0 && now - this.drainSince < this.drainWindowMs) return "hold";
    // Ask the startup gate once more, right before the point of no return: the environment can
    // change during a long drain — a landing already in flight when the hold began can still
    // delete tumwater.json (the 2026-09-22 incident's own cause). Refused, the episode is
    // dropped rather than latched, so the next poll starts over at the gate above: nothing is
    // held while it keeps failing, and a fixed environment gets a full episode with its own drain.
    const problem = await this.bootProblem();
    if (problem !== null) {
      this.clearPending();
      return this.refuse(mainHead, problem);
    }
    try {
      this.deps.swap(mainHead);
    } catch (err) {
      const reason = "swapping the new build into place failed";
      this.block(mainHead, reason, `${reason}: ${errorMessage(err)}`);
      return this.endDrain();
    }
    // Record the completion BEFORE returning "restart": the process exits right after (the
    // supervisor respawns it), so nothing later could persist this — and the respawned process
    // must see it to honor the cooldown (BUGS.md 2026-09-11). A failed write costs at most one
    // extra restart next time; the swap itself already succeeded.
    try {
      this.restartRecord.record(now);
    } catch {
      // An unpersistable timestamp degrades to no cooldown rather than failing the restart.
    }
    this.lastAutoRestartAt = now;
    // The director is guaranteed finished by here (poll only reaches the swap with
    // directorInFlight === 0), so what gets aborted — and counted — are role ticks only, and
    // only those holding a permit (see InFlightCounts). A director-extended hold reports
    // drainedMs past the window: correct and informative.
    this.log({
      loop: "harness",
      type: "restart",
      from: this.build.sha,
      to: mainHead,
      drainedMs: now - this.drainSince,
      abortedTicks: inFlight.roleInFlight,
      drainWindowMs: this.drainWindowMs,
    });
    return "restart";
  }

  /** Nothing is being waited for any more — the fleet schedules normally again, so whatever
   * drain was running is over and the next one starts its clock from scratch. Every path out of
   * poll that is not a `hold` goes through here. */
  private endDrain(): "none" {
    this.drainSince = 0;
    return "none";
  }

  /** deps.bootProblem, fail-closed: a gate that throws cannot vouch for the successor, so its
   * error is the refusal's reason (and, like any refusal, it is asked again next poll). */
  private async bootProblem(): Promise<string | null> {
    try {
      return await this.deps.bootProblem();
    } catch (err) {
      return `the startup check could not run: ${errorMessage(err)}`;
    }
  }

  /** Refuse to swap onto a generation that could not boot here: keep the running one, end any
   * drain, and log `restart_refused` once per distinct reason (see refusedReason). */
  private refuse(head: string, reason: string): "none" {
    if (reason !== this.refusedReason) {
      this.refusedReason = reason;
      this.log({ loop: "harness", type: "restart_refused", from: this.build.sha, to: head, reason });
    }
    return this.endDrain();
  }

  private clearPending(): void {
    this.pendingHead = null;
    this.green = null;
    this.compiled = null;
  }

  /** Refuse the restart for `head` until main moves: `reason` is the short form status()
   * publishes, `message` the full sentence the one warning event carries. */
  private block(head: string, reason: string, message: string): void {
    this.blockedHead = head;
    this.blockedReason = reason;
    this.clearPending();
    this.warn(message);
  }

  /** Log one warning event for the harness loop — the shape the class's warn sites share. */
  private warn(message: string): void {
    this.log({ loop: "harness", type: "warning", message });
  }
}

/** Is main green at the mirror worktree's HEAD? The landing path seeds a green verdict for
 * every merged code SHA (noteGreenBaseline — its in-lock post-rebase re-check, or the gate's
 * pre-check when the rebase was a no-op), so the common case is a cache hit; otherwise the
 * project's declared check runs once in the mirror. No declared check or an
 * environmental skip reads as green — the gates' warn-and-proceed policy.
 *
 * A cached RED, though, is re-verified here (checkMainBaseline's `reverifyRed`) instead of
 * being taken as given. A red verdict can belong to the worktree that produced it rather than
 * to the tree, and this gate is the one place where believing a wrong red is expensive: it
 * strands the whole fleet on a stale build with no retry until main moves. One extra suite run
 * per red head buys that, and a green from it promotes the SHA for every other gate too. */
export async function mainIsGreen(
  mirrorWt: string,
  /** The live config — the declared check is detected through it (plans/portability.md
   * §6/7), so a configured command makes the green check run on a non-npm repo too. */
  config: { check?: { command: string; cwd?: string; timeoutSeconds?: number } },
  /** Hook for the build_check event — this run is a minute of the fleet's time and belongs in
   * the feed like the role loops' own baseline checks. */
  onRun?: (run: { outcome: BuildCheckOutcome; durationMs: number }) => void,
): Promise<boolean> {
  const check = await checkMainBaseline(mirrorWt, config, onRun, true);
  return check.baseline ? check.baseline.status === "green" : true;
}

/** The production Redeployer for `root`, or null when the running dist carries no build stamp
 * (compiled with a bare tsc): then provenance is unknown and there is nothing to compare. */
export async function createRedeployer(
  root: string,
  log: (event: RedeployEvent) => void,
  /** The successor's startup gate (RedeployDeps.bootProblem) — cli.ts binds runStartupProblem
   * to the invocation's own flags, the ones the supervisor forwards to every generation. */
  bootProblem: () => Promise<string | null>,
): Promise<Redeployer | null> {
  const build = readBuildInfo();
  if (!build) return null;
  const selfHosted = await isSelfHosted(root, build);
  const dist = distDir();
  // The mirror worktree — main checked out detached at the pending head — serves both the green
  // check and the compile; it is (re)pointed at each head before use.
  const mirror = async (mainHead: string) => ensureDetachedWorktree(root, mirrorWorktreePath(root), mainHead);
  const deps: RedeployDeps = {
    staleness: (mainHead) => buildStaleness(root, build.sha, mainHead),
    mainGreen: async (mainHead) =>
      // The live config per call (a mid-run edit applies to the next green check like it
      // does everywhere else); a broken file degrades to defaults — no declared check.
      mainIsGreen(
        await mirror(mainHead),
        loadConfigCached(root).config ?? defaultConfig(),
        ({ outcome, durationMs }) =>
          log({
            loop: "harness",
            type: "build_check",
            scope: "baseline",
            status: outcome.status,
            script: outcome.script,
            durationMs,
            ...buildCheckRunFields(outcome),
          }),
      ),
    compile: async (mainHead) => compileStaged(root, await mirror(mainHead), mainHead),
    swap: (mainHead) => swapDist(root, dist, mainHead),
    bootProblem,
  };
  return new Redeployer(build, selfHosted, deps, log, RESTART_DRAIN_MAX_MS, autoRestartRecord(root));
}

/** The inputs whose change stales a build — re-exported so operator-facing text (doctor, the
 * stale warning) names them from one definition. */
export const STALE_INPUTS_LABEL = BUILD_INPUTS.join(", ");
