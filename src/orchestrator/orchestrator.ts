// vocabulary: plain
import type { TumwaterConfig } from "../config/config-schema.js";
import { readOrchestratorInfo, writeOrchestratorInfo, type OrchestratorInfo } from "../team/orchestrator-info.js";
import { runnerIds } from "../roles/runner-ids.js";
import { newLiveConfigReload } from "../config/config-live.js";
import {
  FALLBACK_BREAKER_POLICY,
  type FallbackBreakerPolicy,
} from "../budget/fallback-breaker.js";
import {
  newPollState,
  pollGatesAndHolds,
  pollMergeDrain,
  pollRedeploy,
  pollRequestsAndWatch,
  pollReserveAndExit,
  pollSchedule,
  type PollContext,
} from "./orchestrator-poll.js";
import { RoleRunner } from "../runner/runner.js";
import { dropDanglingTumwaterPins, removeLegacyLandWorktrees } from "../git/worktree.js";
import { retireLegacyRoleWorktrees } from "../git/worktree-pool.js";
import { mergeTasks, newMergePipeline } from "../merge/merge-pipeline.js";
import { bestEffortEventLogger, logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { removeQuiet } from "../files/files.js";
import { OnceRound } from "../scheduling/once-round.js";
import { newNotifier } from "../events/notify.js";
import { piModelsPath } from "../pi/pi-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { Semaphore } from "../concurrency/semaphore.js";
import { orchestratorStatePath } from "../paths.js";
import { createMainWatch } from "../baseline/main-watch.js";
import { revertSkipReason } from "../baseline/main-revert.js";
import { queueCulpritHeal } from "../baseline/main-red.js";
import type { Redeployer } from "../redeploy/redeployer.js";
import type { LaunchServicesWatch } from "../process/launch-services.js";
import { RetentionPruner } from "./retention.js";
import { WorkMergedCache } from "../scheduling/work-merged-cache.js";
import {
  drainInFlightWork,
  HANDOFF_MERGE_WINDOW_MS,
  sleepInterruptible,
} from "../run/run-timing.js";
import { newTeamGateStates, type TeamGateStates } from "../gates/gate-polls.js";
import { loggedWindowKeys } from "../team/team-polls.js";
import { ReclaimController } from "../team/reclaim.js";
import { reapPreviousTeamOrphans } from "../doctor/doctor-orphans.js";
import { runStartupMigrations } from "./startup-migration-steps.js";
import { archiveAtTeamStart } from "../backlog/backlog-archive.js";

const POLL_MS = 2000;

interface RunOptions {
  root: string;
  config: TumwaterConfig;
  mainBranch: string;
  signal: AbortSignal;
  /** Poll interval in ms (default POLL_MS). Tests pass a short value so multi-cycle behavior
   * resolves quickly; production callers omit it and keep the real cadence. */
  pollMs?: number;
  /** Self-redeploy state machine (src/redeploy/redeployer.ts; the policy it decides with
   * lives in src/redeploy/redeploy-policy.ts) for a self-hosting team; null/absent when the
   * running dist carries no build stamp. Consulted every poll with main's head. */
  redeploy?: Redeployer | null;
  /** launchservicesd's port watch (src/process/launch-services.ts), stepped every poll;
   * null/absent runs without one — a `--once` round, and every in-process test, so none
   * reads the real Mac. */
  launchServicesWatch?: LaunchServicesWatch | null;
  /** pi's model definitions (default ~/.pi/agent/models.json), read to decide whether the
   * configured fallback model is actually cost-free — a test seam, like status/status-data.ts's
   * snapshot(). */
  modelsPath?: string;
  /** The fallback breaker's thresholds (src/budget/fallback-breaker.ts, default
   * FALLBACK_BREAKER_POLICY) — a test seam, like pollMs: e2e tests shrink the cool-down so a
   * probe fits in a test. */
  fallbackBreakerPolicy?: FallbackBreakerPolicy;
  /** The fallback breaker's clock (default Date.now) — a test seam, like pollMs: the cool-down
   * deadline and its elapsed check both read it, so a test can elapse a cool-down by advancing
   * this clock instead of sleeping through the real one. Scheduling, run timing, and gate
   * polling keep the wall clock; only the breaker's probe deadlines move with it. */
  breakerNow?: () => number;
  /** The restart hand-off's per-phase wait on an in-flight merge (default
   * HANDOFF_MERGE_WINDOW_MS) — a test seam, like pollMs: tests pass a short window so the
   * deadline path resolves quickly. */
  handoffMergeWindowMs?: number;
  /** Once mode (`tumwater start --once`): give every enabled role at most one run, wait for
   * every merge that round produced to finish, then fire the internal stop — the same
   * graceful-shutdown path an operator's Ctrl+C takes, so drainInFlightWork drains exactly
   * as it always does. Never self-redeploys: the hand-off machinery stays daemon-only. */
  once?: boolean;
  /** Scope the whole round to these roles (`run --once --role <id>[,<id>...]`): the runners map
   * starts with just them, the director never runs, and a mid-round config edit that enables
   * another role does not widen the round (config-live skips runners past the filter). The
   * merge queue still drains fully before exit. cmdStart validates the id against the enabled
   * set before booting, so an unreachable-without-filter guard upstream is not re-checked. */
  roleFilter?: readonly string[];
  /** The `run --for` window's deadline (epoch ms), published in the info file so observers can
   * show when the team stops. The deadline timer itself lives in cmdStart. */
  stopsAt?: number;
}

/** How runOrchestrator ended: `restart` means dist/ now holds a newer build and the caller should
 * exit RESTART_EXIT_CODE so the supervisor respawns onto it; otherwise the stop signal fired.
 * Once mode (`run --once`) also hands back the per-role settle reasons it recorded — the skip
 * half of the round's answer, which the caller's summary reports verbatim instead of re-deriving
 * a lookalike from persisted state (a deferred role's nextRunAt is untouched, so state says
 * "idle" exactly when the truth is "due and set aside"). Undefined outside once mode. */
interface OrchestratorExit {
  restart: boolean;
  settled?: ReadonlyMap<string, string>;
  /** Per-role run counts for this round (OnceRound's own snapshot deltas): a role enabled
   * mid-round is in no caller-side snapshot, so the summary counts it from here instead of
   * mistaking its whole persisted history for this round's work. Once mode only. */
  runsDone?: ReadonlyMap<string, number>;
}

/** Run all enabled roles until the signal aborts — or until a pending self-redeploy has drained
 * the team and swapped the new build into dist/ (then `restart` is true). */
export async function runOrchestrator(opts: RunOptions): Promise<OrchestratorExit> {
  const { root, config, mainBranch, signal: externalSignal } = opts;
  const pollMs = opts.pollMs ?? POLL_MS;
  const modelsPath = opts.modelsPath ?? piModelsPath();
  // pi's saved default model — the same stat-cached read status-roles.ts makes — used as the
  // fallback provider key for a pi seam that names no model (plans/provider-concurrency.md §2).
  const piDefault = readPiDefaultModel(piSettingsPath(modelsPath), root);
  const breakerPolicy = opts.fallbackBreakerPolicy ?? FALLBACK_BREAKER_POLICY;
  const breakerNow = opts.breakerNow ?? Date.now;
  // Parallel work instances (part 5b/7): the runner list is every runner id the config enables
  // (`feature`, `feature-2`, …), so `instances` creates real runners. A `--once --role` filter
  // targets exactly that runner id.
  const enabled = opts.roleFilter !== undefined ? [...opts.roleFilter] : runnerIds(config);
  // Name the fix, not just the failure: an operator who disabled the last role (or hand-edited
  // a roles map to all-false) gets the exact edit that unblocks `tumwater start`, and the
  // defaults they can fall back to. With a role filter this is unreachable — cmdStart validated
  // the id against the enabled set before booting — but the guard stays for in-process callers.
  if (enabled.length === 0)
    throw new Error(
      'no roles enabled in tumwater.json — enable at least one role in its "roles" section (e.g. `"feature": { "enabled": true }`), or remove that section to restore every role\'s default',
    );

  // Two internal stop controllers ride beside the caller's (Ctrl+C/SIGTERM): internalStop, the
  // graceful shutdown the once-mode exit and the hand-off's deadline abort fire — it cuts role
  // runs and merges alike — and internalRoleStop, which ONLY the restart drain fires when it
  // gives up on its permit-holding ROLE runs (they then end as `aborted`, resumable on the new
  // build, exactly like a shutdown). The split is the point: the drain's abort must not cut off
  // an in-flight merge, which then never reaches the hand-off window the wait announces
  // (BUGS.md 2026-09-30: the merge died 13 ms after the warning). So the runners and the timed
  // run wrapper watch roleSignal — the full signal PLUS the role-only stop — while the merge
  // tasks keep wiring the full signal alone. A director run is never aborted by either
  // controller: poll holds for it without a cap, so by the time `restart` takes effect only
  // role runs and the merge can remain.
  const internalStop = new AbortController();
  const internalRoleStop = new AbortController();
  const signal = AbortSignal.any([externalSignal, internalStop.signal]);
  const roleSignal = AbortSignal.any([signal, internalRoleStop.signal]);
  // A once round is a one-shot by definition: it never self-redeploys, and the hand-off
  // machinery stays daemon-only. Forcing null here keeps the whole poll loop's redeploy
  // branches inert no matter what a caller passes.
  const redeploy = opts.once ? null : (opts.redeploy ?? null);
  const launchServicesWatch = opts.once ? null : (opts.launchServicesWatch ?? null);
  // Pressure reclaim (plans/disk-floor.md, part 2/4): one background pass at a time, driven by
  // the disk gate's poll below. In-process state (the use registry) is enough, because this
  // process is the one that starts runs and merges.
  const reclaim = new ReclaimController(root);

  // The shared concurrency cap: role runs and the merges (each verify, and the merge's conflict
  // resolver — merge-drain.ts) all hold a permit; see its MergePipelineContext for why a
  // merge is not exempt.
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrent));
  // Seed the pool's per-provider caps from the startup config (plans/provider-concurrency.md
  // §7): a role run's lease is bounded by its provider key from the first launch onward, not
  // just after a live edit. A config without the key passes an empty map, the no-change case.
  semaphore.setKeyCaps(config.maxConcurrentPerProvider ?? {});

  const infoFile = orchestratorStatePath(root);
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: enabled };
  if (redeploy) info.build = redeploy.status();
  if (opts.stopsAt !== undefined) info.stopsAt = opts.stopsAt;
  const previous = readOrchestratorInfo(root);
  writeOrchestratorInfo(root, info);
  // Best-effort, like every other event write in this function (see `emit` below): this runs
  // BEFORE the try/finally and its cleanup, so a raw logEvent throw here would not just stop
  // the team from starting over an informational event — it would also skip the finally that
  // disposes the notifier and removes the info file just written. An unwritable feed
  // (ENOSPC, EACCES, the path replaced by a directory) must not turn a team that can run
  // into one that refuses to start; logEventBestEffort reports the write failure on stderr so
  // it stays visible, and startup proceeds to the poll loop, which is already best-effort.
  logEventBestEffort(root, {
    source: TUMWATER_SOURCE,
    type: "orchestrator_start",
    pid: process.pid,
    roles: enabled,
    ...(redeploy ? { build: redeploy.build.sha } : {}),
  });

  // The first per-runner state read is each RoleRunner constructor's loadRunnerState, so the
  // persisted-name migrations run before it. (After the info write and start event above, which
  // an in-process test or a second `tumwater start` probe reads synchronously.)
  await runStartupMigrations(root);
  // The mergeRefs migration moved legacy landing pins but keeps a dangling one (setRef refuses a
  // missing object); this drops what is left before any run.
  await dropDanglingTumwaterPins(root);
  // A clean stop removes the info file, so only a crashed predecessor leaves a pid to reap for.
  if (previous !== null && previous.pid !== process.pid) void reapPreviousTeamOrphans(root, previous.pid);
  // Finished backlog entries still in the live files move to the archives now
  // (plans/backlog-archive.md), while no merge is in progress and no run is in flight: a
  // repository migrates on its first start with this build, and an entry a hand commit moved is
  // swept. One commit on main, or a warning; the team starts either way.
  await archiveAtTeamStart(root);
  const runners = enabled.map((role) => new RoleRunner(root, role, config, mainBranch, roleSignal));
  // Legacy merger checkouts (`_land-<role>`) from a pre-pool build hold nothing now that verifies
  // and merges lease pooled slots: remove them once, before any run, so the retired layout
  // never lingers on disk. (After the info write and start event above, so startup's published
  // state is on disk synchronously for an in-process test or a second `tumwater start` probe.)
  await removeLegacyLandWorktrees(root);
  // Legacy role checkouts (`<role>` from a pre-pool build) are retired in the same startup
  // window, right after the RoleRunners above: a role with a pending resume keeps its dir as a
  // pinned slot, every other legacy dir goes. Pass every configured runner id, not `enabled` (a
  // `--once --role` filter): a scoped run must not retire or unpin the other roles, whose
  // pending resumes the next full-team start still owns. See retireLegacyRoleWorktrees.
  await retireLegacyRoleWorktrees(root, runnerIds(config));

  // Session retention (src/orchestrator/retention.ts owns the whole concern): construction runs the
  // startup prune, seeding the once-per-day gate so an unchanged team prunes at most once
  // per day — and 0 disables pruning, the same convention as quietTimeoutSeconds.
  const retentionPruner = new RetentionPruner(root, config.sessionRetentionDays);

  // In-flight tasks, split by who requested them: the redeploy drain caps role runs at its
  // window but waits for a director run without one — an explicit human prompt outranks the
  // self-redeploy (BUGS.md 2026-09-08). The merge tasks are deliberately OUTSIDE this split:
  // in-process tasks (the verifies and the one merge, since 2026-09-18 under the same maxConcurrent
  // permits as role runs) that shutdown still awaits — to the end on an operator stop, and for a
  // bounded hand-off on a restart (drainInFlightWork) — an aborted merge keeps its ref and
  // drops its entry, recovering on next start. roleInFlight holds every RESERVED role run
  // (permit holders and waiters parked in the semaphore queue alike), since shutdown awaits
  // both; what the restart drain waits on, aborts, and reports as abortedRuns is only
  // rolePermitHolders, the role runs actually holding a permit. A parked waiter has nothing to
  // drain — the start gate (runStartHeld below) keeps it from starting while a restart is
  // pending — and counting it held drains open for runs that had not begun and inflated
  // abortedRuns (12 reported against 3 aborted run_ends on 2026-09-21; BUGS.md 2026-09-23).
  const roleInFlight = new Set<Promise<void>>();
  const rolePermitHolders = new Set<RoleRunner>();
  const directorInFlight = new Set<Promise<void>>();
  // The restart drain's window tracks the team's real run duration (BUGS.md 2026-09-18): the
  // durations of recent COMPLETED role runs feed a p75 that poll uses in place of the
  // cold-start constant. Bounded (orchestrator-launch.ts's ROLE_RUN_DURATION_SAMPLES) so a
  // long-running team's memory stays flat; aborted runs are
  // excluded — their short cut-off durations would drag the window down and cause more aborts.
  const roleRunDurationsMs: number[] = [];
  // Every merge task (merge-drain.ts's MergePipeline): the verification stage's tasks, the
  // changes they approved, and the merge slot.
  const merges = newMergePipeline();

  // Once-mode bookkeeping (`tumwater start --once`) — the run-count snapshot, the per-role
  // settle reasons, and the quiet-poll exit rule — lives in src/scheduling/once-round.ts.
  const once = new OnceRound(runners, opts.once === true);

  // The team-wide gates' and alarms' cross-poll memory (src/gates/gate-polls.ts owns the family's
  // wiring — budget, pause, quiet hours, failure hold, and the two storm alarms): the gates'
  // previous values for the edge-triggered events, the fallback breaker, and the hold's own
  // memory (deadline, kind, relapse count). In memory only — a restart re-trusts the
  // fallback, starts with the hold open, and can re-log at most one event per gate. The
  // budget gate's breaker is also the fallback runs' evidence sink: the start pass below
  // records every run's outcome into it and runs its probe (src/budget/fallback-breaker.ts), and
  // the start gate reads gateStates.teamHold at permit time, so its closures always see
  // the latest poll's hold verdict rather than the poll that created them.
  const gateStates: TeamGateStates = newTeamGateStates(config);
  // A restart must not re-announce a window that is still open.
  gateStates.claudeWindowWarned = loggedWindowKeys(root, "claude_window_warning", Date.now());
  gateStates.claudeWindowReserved = loggedWindowKeys(root, "claude_window_reserved", Date.now());
  // The live config the last successful reload produced (last-known-good while the file is
  // broken or missing). The reload bookkeeping itself lives in src/config/config-live.ts.
  const liveReload = newLiveConfigReload({ root, config, mainBranch, runnerSignal: roleSignal, runners, semaphore, roleFilter: opts.roleFilter });

  // Need-based deferral: whether qualifying work has merged
  // since a role's last-seen main head, cached per head (see scheduling/work-merged-cache.ts).
  const workMergedSince = new WorkMergedCache(root, mainBranch);
  const mainWatch = createMainWatch(root, mainBranch, (culprit) => {
    void revertSkipReason(root, mainBranch, culprit).then((skip) => {
      if (skip === null) merges.revert = culprit;
      else queueCulpritHeal(root, culprit.tip, { culprit: culprit.commit, failingTests: culprit.failingTests });
    });
  });
  // Per-role deferred-due state for one-shot tick_deferred events: the previous poll's
  // deferral per role (like prevBudgetPaused/prevUserPaused, but per role), so each episode
  // logs exactly once — on the transition in, never while merely not-due and never on exit.
  // In-memory only: a restart mid-episode can re-log at most one event.
  const deferredDue = new Map<string, boolean>();

  // The operator notify hook (src/events/notify.ts owns the whole concern): one configured shell
  // command run on notable events (budget_paused, role_streak_paused, merge_failed,
  // restart_blocked). Subscribed here so it sees every event this process logs from start;
  // disposed beside the orchestrator_stop event below.
  const notifier = newNotifier(root);

  // Best-effort event logging in the poll loop (bestEffortEventLogger, events.ts): this loop
  // and its finally run with no catch, so an unwritable feed (ENOSPC, EACCES, the path replaced
  // by a directory) must not end the team — and, in the finally, must not skip the
  // notifier/quiet-file cleanup or mask an in-flight error. The feed is the failure; the poll
  // and the shutdown still run.
  const { emit, warn } = bestEffortEventLogger(root);

  const ctx: PollContext = {
    root,
    mainBranch,
    onceMode: opts.once === true,
    signal,
    roleSignal,
    internalStop,
    internalRoleStop,
    runners,
    semaphore,
    merges,
    gateStates,
    once,
    info,
    modelsPath,
    piDefault,
    redeploy,
    launchServicesWatch,
    reclaim,
    liveReload,
    notifier,
    retentionPruner,
    mainWatch,
    workMergedSince,
    deferredDue,
    breakerPolicy,
    breakerNow,
    roleInFlight,
    rolePermitHolders,
    directorInFlight,
    roleRunDurationsMs,
    emit,
    warn,
  };
  // The flags that outlive one poll (orchestrator-poll.ts's PollState).
  const state = newPollState();

  // Why the poll loop ended, for the orchestrator_stop event: a throw leaves "error".
  let stopCause: "restart" | "once" | "signal" | "error" = "error";
  try {
    while (!signal.aborted) {
      const inputs = await pollRequestsAndWatch(ctx, state);
      const gates = pollGatesAndHolds(ctx, state, inputs);
      if (await pollRedeploy(ctx, state, inputs)) {
        stopCause = "restart";
        break;
      }
      await pollMergeDrain(ctx, state, inputs, gates);
      await pollSchedule(ctx, state, inputs, gates);
      if (pollReserveAndExit(ctx, state, inputs)) {
        stopCause = "once";
        break;
      }
      await sleepInterruptible(pollMs, signal);
    }
    if (stopCause === "error") stopCause = "signal";
  } finally {
    await drainInFlightWork(
      root,
      roleInFlight,
      directorInFlight,
      mergeTasks(merges),
      state.restart,
      opts.handoffMergeWindowMs ?? HANDOFF_MERGE_WINDOW_MS,
      () => internalStop.abort(),
    );
    emit({ source: TUMWATER_SOURCE, type: "orchestrator_stop", cause: stopCause });
    notifier.dispose();
    removeQuiet(infoFile);
  }
  // Only once mode carries the settle reasons and the per-role run counts: the daemon return
  // keeps its exact shape (an e2e test deep-equals it), and a daemon caller has no summary to
  // feed.
  return once.active
    ? {
        restart: state.restart,
        settled: once.reasons,
        runsDone: new Map(runners.map((r) => [r.role, once.runsDone(r)] as const)),
      }
    : { restart: state.restart };
}
