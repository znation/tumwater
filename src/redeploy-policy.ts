import type { HarnessEventInput } from "./events.js";
import type { BuildInfo, BuildStaleness, BuildStatus } from "./build-info.js";
import type { CompileResult } from "./build-stage.js";
import { errorMessage, shortSha } from "./text.js";

/** Self-redeploy for a self-hosting fleet (see build-info.ts for why): when main's build inputs
 * have moved past the running build, verify that main is green, compile it into a staging dir,
 * drain the fleet (no new ticks; in-flight ones finish or are aborted resumably after
 * RESTART_DRAIN_MAX_MS), swap the compiled tree into dist/, and ask the supervisor
 * (supervisor.ts) to respawn the harness onto it by exiting RESTART_EXIT_CODE. Every step is
 * non-blocking from the orchestrator's poll: the green check and the compile run in the
 * background and are consulted on later polls, so a slow `npm test` never stalls scheduling.
 * Completed restarts are rate-limited to one per RESTART_COOLDOWN_MS (BUGS.md 2026-09-11), so
 * sustained main churn cannot halt the fleet for a drain over and over.
 *
 * This module is the POLICY — the Redeployer state machine, its injectable effects interface
 * (RedeployDeps), the cooldown/escalation knobs it decides with, and the RESTART_EXIT_CODE
 * handshake the supervisor respawns on. Pure policy: every effect arrives through RedeployDeps,
 * so the tests drive it with scripted fakes. The production wiring — the mirror worktree, the
 * baseline check, the staged compile, the dist swap, the state-file record — lives beside it in
 * redeploy.ts. The behavior contract both halves serve:
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
 * recent completed role ticks (InFlightCounts.roleTickP75Ms) and poll uses it in place of this
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

/** How long a build may stay CONTINUOUSLY stale before the pin itself — not any one head's
 * failure — is warned about (BUGS.md 2026-09-29): under churn each per-head warning names a
 * different commit, so the aggregate — hours pinned on a stale build while every rebuild dies —
 * raised no alarm anywhere the operator reads. One warning at this age, then at most one per
 * STALE_ESCALATE_EVERY_MS for as long as the episode lasts. */
const STALE_ESCALATE_AFTER_MS = 6 * 60 * 60_000;

/** The sustained-pin warning's repeat cadence: daily, not per poll and not per head. */
const STALE_ESCALATE_EVERY_MS = 24 * 60 * 60_000;

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
export type RedeployEvent = HarnessEventInput;

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
  private compiled: Tracked<CompileResult> | null = null;
  /** The head whose compile already warned that it could not run (a rejection or a thrown
   * compile — neither is a verdict about the tree) — one warning per episode, mirroring
   * checkFailedHead. */
  private compileFailedHead: string | null = null;
  /** The head whose compile start already logged `restart_pending` — one in-progress state
   * event per head, not one per doomed retry: a rejection drops the episode and the next poll
   * starts a fresh one, which would otherwise re-emit "compiling" on every poll while the
   * environment stays broken (BUGS.md 2026-09-28). Cleared when an episode ends in a state
   * other than compiling (a refusal or a completed restart), so a later episode for the same
   * head is a real transition again. */
  private pendingLoggedHead: string | null = null;
  /** A head whose restart was blocked (red main, compile failure, swap error): no retry until
   * main moves — the warning was logged once. */
  private blockedHead: string | null = null;
  /** Why, in a few words, for status() to publish alongside the staleness verdict. */
  private blockedReason: string | null = null;
  /** When the last completed auto-restart landed (epoch ms), or null when none yet — copied from
   * restartRecord at construction and updated when this process completes one. The cooldown is
   * measured from here on every poll (BUGS.md 2026-09-11). */
  private lastAutoRestartAt: number | null = null;
  /** The operator's forced-restart request (the dashboard's build-stale alert's refresh
   * button): one armed flag, consumed by the next poll that reaches the cooldown check. */
  private forcedRestart = false;
  /** When the current unbroken stale episode began (epoch ms), or null while the build is fresh.
   * Deliberately head-independent: main moving under a stale build CONTINUES the episode rather
   * than restarting the clock, because the fleet's predicament — running code main has left
   * behind — is the same whatever the head, and a per-head clock is exactly what let the
   * 2026-09-29 pin produce 109 warnings without ever saying the pin was the story. In-memory,
   * per process: a completed restart (and the process exit that follows it) is a new world. */
  private staleSince: number | null = null;
  /** When a restart attempt last failed during the current stale episode, or null. The
   * escalation's second condition: a stale build with NO failed attempt is a cooldown deferral
   * or an intentional off switch, not a pin. Set by noteFailure from every dead-end shape
   * EXCEPT a red-main verdict, which is a correct deferral rather than a failure. */
  private lastRestartFailureAt: number | null = null;
  /** When the sustained-pin warning last fired, or null — spaces the repeats (see
   * escalateIfSustained). Cleared with the episode. */
  private lastEscalationAt: number | null = null;
  /** The cooldown deadline the current episode's deferral was last warned about — one warning
   * per distinct deadline, not one per poll and not one per head: the cooldown condition is
   * head-independent, so a landing mid-cooldown adds no new information (BUGS.md 2026-09-19).
   * Keyed to the deadline rather than a bare flag so an urgency onset mid-episode — the running
   * build's red verdict arriving after the ordinary warning (BUGS.md 2026-09-30) — is a real
   * transition and warns once more with the earlier deadline. Cleared when the deadline lapses,
   * so the next episode warns once. */
  private cooldownWarnedUntil: number | null = null;
  /** The RUNNING build's own red verdict (the urgency carve-out's input), tracked in the
   * background — poll must never await a suite run. Keyed to the SHA it was asked about: a
   * verdict belongs to one immutable tree, and the SHA changes only when a swap (and with it a
   * new process) replaces the build. A rejected check latches as unknown — never red — so a
   * broken environment leaves the ordinary cooldown standing instead of retrying a doomed git
   * call on every poll. */
  private buildRed: Tracked<boolean | null> | null = null;
  private buildRedSha: string | null = null;
  /** Pre-warm during a cooldown (BUGS.md 2026-09-30): the head whose restart the cooldown defers
   * still gets its green check and staged compile — once per SHA — so the lapse reaches the swap
   * directly instead of paying green-check + compile + drain from zero while the fleet sits on a
   * build it already knows is stale. The check and compile are the same side-effect-free effects
   * the episode itself runs (mirror worktree, staging dir under .tumwater/build); what the
   * episode adopts is decided by the adopt helpers, not by the pre-warm. */
  private prewarmHead: string | null = null;
  private prewarmedGreen: Tracked<boolean> | null = null;
  private prewarmedCompiled: Tracked<CompileResult> | null = null;
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
        const { until, urgent } = this.effectiveCooldownUntil(now);
        if (now < until)
          s.restartBlocked =
            `cooldown until ${new Date(until).toISOString()}` +
            (urgent ? ` (the running build's own commit is red — cut to ${RESTART_URGENT_COOLDOWN_MS / 60_000} min)` : "");
        else if (this.refusedReason !== null) s.restartBlocked = `the new build could not start: ${this.refusedReason}`;
      }
    }
    return s;
  }

  /** When the current post-restart cooldown expires (epoch ms), or 0 when none is running. */
  private cooldownUntil(): number {
    return this.lastAutoRestartAt !== null ? this.lastAutoRestartAt + RESTART_COOLDOWN_MS : 0;
  }

  /** Arm the operator's forced restart (the dashboard's build-stale alert's refresh button):
   * the next poll that reaches the cooldown check waives the deferral — it nulls the cooldown's
   * start, so the whole episode proceeds now and later polls of it stay un-deferred. It clears
   * ONLY the cooldown — a red main verdict, a failed compile, a swap error, or a boot refusal
   * still blocks through the ordinary paths, and in-flight ticks still drain through the
   * ordinary window. One `restart_forced` event records the operator's hand, so the feed shows
   * why an episode started mid-cooldown. */
  forceRestart(): void {
    this.forcedRestart = true;
    this.log({ loop: "harness", type: "restart_forced", build: this.build.sha });
  }

  /** Read and clear the forced flag — one-shot: the poll that consumes it acts on it. */
  private consumeForcedRestart(): boolean {
    if (!this.forcedRestart) return false;
    this.forcedRestart = false;
    return true;
  }

  /** Start the RUNNING build's own baseline check in the background when the cooldown is
   * deferring a restart and this process has no verdict for the build SHA yet (BUGS.md
   * 2026-09-30). This is the cold-cache recovery the fleet-shared cache cannot give by itself:
   * checkMainBaseline only ever runs at main's tip, so a stale build's SHA gains an entry no
   * other way. The witness check costs at most one suite run per process per build SHA — the
   * cache answers every later consult — and its result can only shorten the wait safely: a
   * false red brings forward a restart the episode still gates on the new head's own green
   * check, staged compile, and boot gate; anything but a settled red leaves the ordinary
   * deadline standing. */
  private ensureBuildRedCheck(): void {
    if (this.buildRed !== null && this.buildRedSha === this.build.sha) return;
    this.buildRedSha = this.build.sha;
    this.buildRed = track(this.deps.buildRed(this.build.sha));
  }

  /** The deadline this deferral holds to: the ordinary 12 h rate limit, cut to the urgent
   * window when the RUNNING build's own commit carries a settled red verdict (BUGS.md
   * 2026-09-30). The verdict is whatever the background check has produced so far — an
   * unsettled or unknown verdict reads as not-red, so a cold cache leaves the ordinary
   * deadline standing until the check lands — and it is re-consulted on every poll, so a red
   * arriving mid-cooldown shortens the remaining wait immediately. */
  private effectiveCooldownUntil(now: number): { until: number; urgent: boolean } {
    const until = this.cooldownUntil();
    const red =
      this.buildRed !== null &&
      this.buildRedSha === this.build.sha &&
      this.buildRed.done === true &&
      this.buildRed.result === true;
    if (until === 0 || now >= until || !red) return { until, urgent: false };
    return { until: Math.min(until, (this.lastAutoRestartAt ?? 0) + RESTART_URGENT_COOLDOWN_MS), urgent: true };
  }

  /** Run the deferred head's green check, then — only after a green verdict — its staged compile,
   * once per SHA, while the cooldown defers the restart (BUGS.md 2026-09-30). These are the same
   * effects the episode itself runs, so their cost lands inside the dead window instead of
   * stretching it; the 12 h rate limit keeps protecting against churn, and this keeps it from
   * also idling away verification work a known-stale build owes. A red verdict or a "could not
   * run" shape prewarms nothing further — there is no point staging a compile for a tree the
   * check condemned — and is simply not adopted (the episode re-runs it under its own rules).
   * Skipped while an episode is pending: its own steps are the warm-up, and the mirror worktree
   * both run in must not serve two checks at once. */
  private prewarm(head: string): void {
    if (this.pendingHead !== null) return;
    if (this.prewarmHead !== head) {
      this.prewarmHead = head;
      this.prewarmedGreen = null;
      this.prewarmedCompiled = null;
    }
    if (this.prewarmedGreen === null) {
      this.prewarmedGreen = track(this.deps.mainGreen(head));
      return;
    }
    if (!this.prewarmedGreen.done) return;
    if (this.prewarmedGreen.error || this.prewarmedGreen.result !== true) return;
    if (this.prewarmedCompiled === null) this.prewarmedCompiled = track(this.deps.compile(head));
  }

  /** The pre-warm's green check for `head`, when the episode can adopt it: still running (adopt
   * and keep waiting — the lapse caught the check mid-flight) or finished with a real verdict
   * (green or red). A check that finished WITHOUT a verdict — a rejection, "could not run" — is
   * never adopted: the episode's rejection rules drop the pending head and re-run the check
   * fresh, and adopting it would replay the same dead end on every retry (BUGS.md 2026-09-16). */
  private adoptPrewarmedGreen(head: string): Tracked<boolean> {
    const g = this.prewarmHead === head ? this.prewarmedGreen : null;
    return g !== null && (!g.done || !g.error) ? g : track(this.deps.mainGreen(head));
  }

  /** The pre-warm's staged compile for `head`, when the episode can adopt it: still running (a
   * compile in flight when the lapse lands — adopt and keep waiting, never start a second one
   * against the same mirror and staging dir) or finished ok (its staged tree is exactly the
   * artifact the swap consumes). A compile that finished without a usable verdict — a rejected
   * spawn or a thrown promise — is never adopted, like the green check above. A finished FAILED
   * compiler verdict is also not adopted: the episode recompiles, so every block decision rests
   * on a verdict its own step produced, at the cost of one bounded recompile. */
  private adoptPrewarmedCompile(head: string): Tracked<CompileResult> | null {
    const c = this.prewarmHead === head ? this.prewarmedCompiled : null;
    return c !== null && (!c.done || c.result?.ok === true) ? c : null;
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
      // The sustained-pin clock (see staleSince): a moved main under a stale build continues the
      // episode rather than restarting it, and the episode's end clears the escalation schedule.
      if (stale && this.staleSince === null) this.staleSince = now;
      else if (!stale) {
        this.staleSince = null;
        this.lastEscalationAt = null;
      }
      // A moved main supersedes any restart in progress for the previous head: its compile
      // (if running) finishes into its own staging dir and is simply never swapped in.
      if (this.pendingHead !== null && this.pendingHead !== mainHead) this.clearPending();
    }
    // The sustained-pin escalation runs BEFORE the early returns below: a latched block on a
    // frozen main never re-enters the episode logic, and that pinned-and-stuck state is exactly
    // what must escalate (BUGS.md 2026-09-29).
    if (this.staleness?.stale && autoRestart) this.escalateIfSustained(now);
    if (!this.staleness?.stale || !autoRestart || this.blockedHead === mainHead) return this.endDrain();

    // Completed auto-restarts are rate-limited to one per RESTART_COOLDOWN_MS (BUGS.md 2026-09-11):
    // under sustained churn every stale head would otherwise drive a full hold+drain+swap episode
    // back to back. Inside the cooldown the fleet keeps ticking on the stale build exactly as when
    // a restart is blocked — no pendingHead, no hold, no drain, no new-tick block — but the
    // deferred head's green check and staged compile still run (prewarm, BUGS.md 2026-09-30), so
    // the lapse reaches the swap directly instead of paying green-check + compile + drain from
    // zero. This is re-evaluated on every poll rather than latched like blockedHead: once the
    // deadline passes, the same head proceeds even if main never moves again.
    //
    // The deferral has one urgency carve-out (BUGS.md 2026-09-30): when the RUNNING build's own
    // commit carries a red baseline verdict, the deadline is cut to RESTART_URGENT_COOLDOWN_MS —
    // a red running build is the exact predicament the self-redeploy exists to end, not churn.
    // Its verdict is established in the background (ensureBuildRedCheck) and consulted fresh on
    // every poll, so a red observed mid-cooldown shortens the remaining wait at once.
    if (now < this.cooldownUntil()) this.ensureBuildRedCheck();
    // A forced restart (forceRestart) consumes its one-shot flag here by nulling the cooldown's
    // start — the deferral is waived for the whole episode, not one poll, since every later
    // poll of a pending episode re-enters this check. Only the deferral is waived: the episode
    // below — verify-green, compile, drain, swap, and every refusal — runs exactly as an
    // unforced lapse would.
    if (this.consumeForcedRestart()) this.lastAutoRestartAt = null;
    const { until: cooldownUntil, urgent } = this.effectiveCooldownUntil(now);
    if (now < cooldownUntil) {
      if (this.cooldownWarnedUntil !== cooldownUntil) {
        this.cooldownWarnedUntil = cooldownUntil;
        this.warn(
          `auto-restart of ${shortSha(mainHead)} deferred — cooldown until ${new Date(cooldownUntil).toISOString()}` +
            (urgent
              ? ` (the running build ${shortSha(this.build.sha)} is red — the cooldown is cut to ${RESTART_URGENT_COOLDOWN_MS / 60_000} min)`
              : " (at most one completed restart per 12 h)"),
        );
      }
      this.prewarm(mainHead);
      return this.endDrain();
    }
    // The cooldown has lapsed (or never started): the next episode warns once more.
    this.cooldownWarnedUntil = null;

    if (this.pendingHead === null) {
      // Before holding anything: could a new generation even boot here? A refusal here costs
      // nothing — no hold, no green check, no compile — so asking again every poll is how a
      // repaired environment (the config restored, pi back on PATH) lets the restart proceed.
      const problem = await this.bootProblem();
      if (problem !== null) return this.refuse(mainHead, problem, now);
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
      // Adopt the cooldown's pre-warm (BUGS.md 2026-09-30): verdicts already in hand mean the
      // lapse reaches the swap directly instead of paying green-check + compile from zero.
      this.green = this.adoptPrewarmedGreen(mainHead);
      this.compiled = this.adoptPrewarmedCompile(mainHead);
      return "hold";
    }
    if (!this.green?.done) return "hold";
    // A REJECTED check is not a verdict: it could not run (git broke inside the mirror worktree,
    // or the check itself threw), so it says nothing about the tree. Drop the pending head — no
    // blockedHead, no latched "main is red" — warn once per episode, and let the next poll
    // re-run the check on the same head; a fleet whose toolchain recovers redeploys itself
    // without main ever moving (BUGS.md 2026-09-16). A red VERDICT below still blocks.
    if (this.green.error) {
      this.noteFailure(now);
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
      this.compiled = this.adoptPrewarmedCompile(mainHead) ?? track(this.deps.compile(mainHead));
      // Once per head, not once per episode: a rejected compile drops the episode and the next
      // poll starts a fresh one, and a state stream that re-enters "compiling" it never left
      // is noise on top of the missing terminal event (BUGS.md 2026-09-28).
      if (this.pendingLoggedHead !== mainHead) {
        this.pendingLoggedHead = mainHead;
        this.log({
          loop: "harness",
          type: "restart_pending",
          build: this.build.sha,
          head: mainHead,
          aheadCommits: this.staleness.aheadCommits,
        });
      }
      return "hold";
    }
    if (!this.compiled.done) return "hold";
    const c = this.compiled.result;
    if (!c?.ok) {
      const detail = c?.detail ?? this.compiled.error ?? "compile threw";
      this.noteFailure(now);
      // A compile that never produced a verdict is not a verdict about the tree, in either shape
      // it arrives in: an explicit rejection (ENOENT-class spawn failure — the environment is
      // broken, not the commit) and a promise that rejected without a CompileResult (the
      // production wrapper throws when the mirror worktree cannot be checked out or staging hits
      // a disk error — a compiler verdict always returns, because compileStaged's catch converts
      // every tsc exit into a result). Like the REJECTED green check above, no blockedHead —
      // warn once per head, drop the pending head, and re-attempt on the next poll, so
      // repairing the mirror or the toolchain redeploys the current head without main moving
      // (BUGS.md 2026-09-28). A real compiler exit below still blocks.
      if (c === undefined || c.rejected) {
        this.noteFailure(now);
        if (this.compileFailedHead !== mainHead) {
          this.compileFailedHead = mainHead;
          this.warn(
            c === undefined
              ? `rebuild of ${shortSha(mainHead)} could not run: ${detail} — retrying on the next poll`
              : `could not start the rebuild of ${shortSha(mainHead)}: ${detail} — retrying on the next poll`,
          );
        }
        this.clearPending();
        return this.endDrain();
      }
      const reason = `rebuild of ${shortSha(mainHead)} failed`;
      this.block(
        mainHead,
        reason,
        `${reason} — staying on build ${shortSha(this.build.sha)}: ${detail}`,
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
      return this.refuse(mainHead, problem, now);
    }
    try {
      this.deps.swap(mainHead);
    } catch (err) {
      this.noteFailure(now);
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
    // A completed restart ends the stale episode; the next one (a fresh build going stale again)
    // starts its own clock and its own escalation schedule.
    this.staleSince = null;
    this.lastEscalationAt = null;
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
    // The state stream left "compiling"; a later episode for this same head is a new transition.
    this.pendingLoggedHead = null;
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
  private refuse(head: string, reason: string, now: number): "none" {
    this.noteFailure(now);
    if (reason !== this.refusedReason) {
      this.refusedReason = reason;
      this.log({ loop: "harness", type: "restart_refused", from: this.build.sha, to: head, reason });
    }
    // The state stream left "compiling" via the refusal event; a later episode for the same
    // head — the gate re-asked after the environment was repaired — is a new transition.
    this.pendingLoggedHead = null;
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
    // A typed transition, not only a warning: the digest's Fleet state changes section replays
    // the decisions, and a stream that entered "compiling" must leave it when the compile dies
    // — its two other endings (restart, restart_refused) each have an event, so the third does
    // too (BUGS.md 2026-09-28). Logged before the warning, so the warning is never the state
    // stream's only trace of the episode's end.
    this.log({ loop: "harness", type: "restart_blocked", from: this.build.sha, to: head, reason });
    this.warn(message);
  }

  /** A restart attempt just failed — record when, so sustained staleness WITH failures can
   * escalate (see escalateIfSustained). Every dead-end shape feeds this: a refused boot gate
   * (both asks — before the hold and before the swap — share refuse(), so neither can be
   * forgotten), a green check or compile that could not run, a failed compile verdict, a swap
   * error. A red main is a correct deferral, not a failure, and never feeds the escalation. */
  private noteFailure(now: number): void {
    this.lastRestartFailureAt = now;
  }

  /** The sustained-pin warning (BUGS.md 2026-09-29): once the build has stayed stale past
   * STALE_ESCALATE_AFTER_MS and a restart attempt has failed within this same stale episode,
   * say the aggregate out loud — at most once per STALE_ESCALATE_EVERY_MS while it lasts.
   * Healthy churn never feeds it: a landing restart clears the episode, and a cooldown
   * deferral or red main produces no failed attempt, so no warning. */
  private escalateIfSustained(now: number): void {
    const since = this.staleSince;
    if (since === null || now - since < STALE_ESCALATE_AFTER_MS) return;
    if (this.lastRestartFailureAt === null || this.lastRestartFailureAt < since) return;
    if (this.lastEscalationAt !== null && now - this.lastEscalationAt < STALE_ESCALATE_EVERY_MS) return;
    this.lastEscalationAt = now;
    const hours = Math.max(1, Math.round((now - since) / 3_600_000));
    this.warn(
      `build ${shortSha(this.build.sha)} has stayed stale for ~${hours} h (${this.staleness?.aheadCommits ?? 0} commits behind main) while rebuild attempts keep failing — the sustained pin itself is the problem, not any one head`,
    );
  }

  /** Log one warning event for the harness loop — the shape the class's warn sites share. */
  private warn(message: string): void {
    this.log({ loop: "harness", type: "warning", message });
  }
}
