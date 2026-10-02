import type { TumwaterConfig } from "./config-schema.js";
import type { OrchestratorInfo } from "./fleet-state.js";
import { enabledRoleIds } from "./config.js";
import { newLiveConfigReload } from "./config-live.js";
import { deferTick, isEligible } from "./scheduling.js";
import {
  FALLBACK_BREAKER_POLICY,
  type FallbackBreakerPolicy,
  fallbackProbeDue,
} from "./fallback-breaker.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE } from "./roles.js";
import { launchDueTicks } from "./orchestrator-launch.js";
import { openBugs, plannedPlans } from "./backlog.js";
import { LoopRunner } from "./loop.js";
import { branchHead, currentBranch } from "./git.js";
import { queuedLandingFiles } from "./landing-queue.js";
import { drainLandings, settleAbortedVetted } from "./landing-drain.js";
import { abortableLandings, landingTasks, newLandingPipeline } from "./landing-pipeline.js";
import { logEvent, warnEvent } from "./events.js";
import { removeQuiet } from "./files.js";
import { writeJsonFile } from "./json-files.js";
import { inboxSize } from "./inbox.js";
import { OnceRound } from "./once-round.js";
import { newNotifier } from "./notify.js";
import {
  consumeAbortRequests,
  consumeRestartRequest,
  consumeResetRequest,
  consumeWakeRequest,
} from "./operator-requests.js";
import { piModelsPath } from "./pi-models.js";
import { Semaphore } from "./semaphore.js";
import { orchestratorStatePath } from "./paths.js";
import { type Redeployer } from "./redeployer.js";
import type { LaunchServicesWatch } from "./launch-services.js";
import { RetentionPruner } from "./retention.js";
import { WorkLandedCache } from "./work-landed-cache.js";
import {
  drainInFlightWork,
  HANDOFF_LANDING_WINDOW_MS,
  p75TickDurationMs,
  sleepInterruptible,
} from "./tick-timing.js";
import { newFleetGateStates, pollFleetGates, type FleetGateStates } from "./gate-polls.js";

const POLL_MS = 2000;

interface RunOptions {
  root: string;
  config: TumwaterConfig;
  mainBranch: string;
  signal: AbortSignal;
  /** Poll interval in ms (default POLL_MS). Tests pass a short value so multi-cycle behavior
   * resolves quickly; production callers omit it and keep the real cadence. */
  pollMs?: number;
  /** Self-redeploy state machine (src/redeployer.ts; the policy it decides with lives in src/redeploy-policy.ts) for a self-hosting fleet; null/absent when the
   * running dist carries no build stamp. Consulted every poll with main's head. */
  redeploy?: Redeployer | null;
  /** launchservicesd's port watch (src/launch-services.ts), stepped every poll; null/absent runs
   * without one — a `--once` round, and every in-process test, so none reads the real Mac. */
  launchServicesWatch?: LaunchServicesWatch | null;
  /** pi's model definitions (default ~/.pi/agent/models.json), read to decide whether the
   * configured fallback model is actually cost-free — a test seam, like status-data.ts's
   * snapshot(). */
  modelsPath?: string;
  /** The fallback breaker's thresholds (src/fallback-breaker.ts, default
   * FALLBACK_BREAKER_POLICY) — a
   * test seam, like pollMs: e2e tests shrink the cool-down so a probe fits in a test. */
  fallbackBreakerPolicy?: FallbackBreakerPolicy;
  /** The restart hand-off's per-phase wait on an in-flight landing (default
   * HANDOFF_LANDING_WINDOW_MS) — a test seam, like pollMs: tests pass a short window so the
   * deadline path resolves quickly. */
  handoffLandingWindowMs?: number;
  /** Once mode (`tumwater run --once`): give every enabled role at most one tick, wait for
   * every landing that round produced to merge, then fire the internal stop — the same
   * graceful-shutdown path an operator's Ctrl+C takes, so drainInFlightWork drains exactly
   * as it always does. Never self-redeploys: the hand-off machinery stays daemon-only. */
  once?: boolean;
  /** Scope the whole round to this one role (`run --once --role <id>`): the runners map
   * starts with just it, the director never runs, and a mid-round config edit that enables
   * another role does not widen the round (config-live skips runners past the filter). The
   * land queue still drains fully before exit. cmdRun validates the id against the enabled
   * set before booting, so an unreachable-without-filter guard upstream is not re-checked. */
  roleFilter?: string;
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
  /** Per-role ticks this round ran (OnceRound's own snapshot deltas): a role enabled
   * mid-round is in no caller-side snapshot, so the summary counts it from here instead of
   * mistaking its whole persisted history for this round's work. Once mode only. */
  ticksRun?: ReadonlyMap<string, number>;
}

/** Run all enabled loops until the signal aborts — or until a pending self-redeploy has drained
 * the fleet and swapped the new build into dist/ (then `restart` is true). */
export async function runOrchestrator(opts: RunOptions): Promise<OrchestratorExit> {
  const { root, config, mainBranch, signal: externalSignal } = opts;
  const pollMs = opts.pollMs ?? POLL_MS;
  const modelsPath = opts.modelsPath ?? piModelsPath();
  const breakerPolicy = opts.fallbackBreakerPolicy ?? FALLBACK_BREAKER_POLICY;
  const enabled = opts.roleFilter !== undefined ? [opts.roleFilter] : enabledRoleIds(config);
  // Name the fix, not just the failure: an operator who disabled the last role (or hand-edited
  // a roles map to all-false) gets the exact edit that unblocks `tumwater run`, and the
  // defaults they can fall back to. With a role filter this is unreachable — cmdRun validated
  // the id against the enabled set before booting — but the guard stays for in-process callers.
  if (enabled.length === 0)
    throw new Error(
      'no roles enabled in tumwater.json — enable at least one role in its "roles" section (e.g. `"feature": { "enabled": true }`), or remove that section to restore every role\'s default',
    );

  // Two internal stop controllers ride beside the caller's (Ctrl+C/SIGTERM): internalStop, the
  // graceful shutdown the once-mode exit and the hand-off's deadline abort fire — it cuts role
  // ticks and landings alike — and internalRoleStop, which ONLY the restart drain fires when it
  // gives up on its permit-holding ROLE ticks (they then end as `aborted`, resumable on the new
  // build, exactly like a shutdown). The split is the point: the drain's abort must not cut off
  // an in-flight landing, which then never reaches the hand-off window the wait announces
  // (BUGS.md 2026-09-30: the landing died 13 ms after the warning). So the runners and the timed
  // tick wrapper watch roleSignal — the full signal PLUS the role-only stop — while the landing
  // tasks keep wiring the full signal alone. A director tick is never aborted by either
  // controller: poll holds for it without a cap, so by the time `restart` lands only role ticks
  // and the landing can remain.
  const internalStop = new AbortController();
  const internalRoleStop = new AbortController();
  const signal = AbortSignal.any([externalSignal, internalStop.signal]);
  const roleSignal = AbortSignal.any([signal, internalRoleStop.signal]);
  // A once round is a one-shot by definition: it never self-redeploys, and the hand-off
  // machinery stays daemon-only. Forcing null here keeps the whole poll loop's redeploy
  // branches inert no matter what a caller passes.
  const redeploy = opts.once ? null : (opts.redeploy ?? null);
  const launchServicesWatch = opts.once ? null : (opts.launchServicesWatch ?? null);
  let restart = false;

  const runners = enabled.map((role) => new LoopRunner(root, role, config, mainBranch, roleSignal));
  // The shared concurrency cap: role ticks and the landings (each vet, and the merge's conflict
  // resolver — landing-drain.ts) all hold a permit; see its LandingPipelineContext for why a
  // landing is not exempt.
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrent));

  const infoFile = orchestratorStatePath(root);
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: enabled };
  if (redeploy) info.build = redeploy.status();
  writeJsonFile(infoFile, info);
  logEvent(root, {
    loop: "harness",
    type: "orchestrator_start",
    pid: process.pid,
    roles: enabled,
    ...(redeploy ? { build: redeploy.build.sha } : {}),
  });

  // Session retention (src/retention.ts owns the whole concern): construction runs the
  // startup prune, seeding the once-per-day gate so an unchanged fleet prunes at most once
  // per day — and 0 disables pruning, the same convention as quietTimeoutSeconds.
  const retentionPruner = new RetentionPruner(root, config.sessionRetentionDays);

  // In-flight tasks, split by who requested them: the redeploy drain caps role ticks at its
  // window but waits for a director tick without one — an explicit human prompt outranks the
  // self-redeploy (BUGS.md 2026-09-08). The landing tasks are deliberately OUTSIDE this split:
  // in-process tasks (the vets and the one merge, since 2026-09-18 under the same maxConcurrent
  // permits as role ticks) that shutdown still awaits — to the end on an operator stop, and for a
  // bounded hand-off on a restart (drainInFlightWork) — an aborted landing keeps its ref and
  // drops its entry, recovering on next start. roleInFlight holds every RESERVED role tick
  // (permit holders and waiters parked in the semaphore queue alike), since shutdown awaits
  // both; what the restart drain waits on, aborts, and reports as abortedTicks is only
  // rolePermitHolders, the role ticks actually holding a permit. A parked waiter has nothing to
  // drain — the start gate (tickStartHeld below) keeps it from starting while a restart is
  // pending — and counting it held drains open for ticks that had not begun and inflated
  // abortedTicks (12 reported against 3 aborted tick_ends on 2026-09-21; BUGS.md 2026-09-23).
  const roleInFlight = new Set<Promise<void>>();
  const rolePermitHolders = new Set<LoopRunner>();
  const directorInFlight = new Set<Promise<void>>();
  // The restart drain's window tracks the fleet's real tick duration (BUGS.md 2026-09-18): the
  // durations of recent COMPLETED role ticks feed a p75 that poll uses in place of the
  // cold-start constant. Bounded (orchestrator-launch.ts's ROLE_TICK_DURATION_SAMPLES) so a
  // long-running fleet's memory stays flat; aborted ticks are
  // excluded — their short cut-off durations would drag the window down and cause more aborts.
  const roleTickDurationsMs: number[] = [];
  // Every landing task (landing-drain.ts's LandingPipeline): the vetting stage's tasks, the
  // changes they vetted, and the merge slot.
  const landings = newLandingPipeline();

  // Once-mode bookkeeping (`tumwater run --once`) — the tick-count snapshot, the per-role
  // settle reasons, and the quiet-poll exit rule — lives in src/once-round.ts.
  const once = new OnceRound(runners, opts.once === true);

  // The fleet-wide gates' and alarms' cross-poll memory (src/gate-polls.ts owns the family's
  // wiring — budget, pause, quiet hours, failure hold, and the two storm alarms): the gates'
  // previous values for the edge-triggered events, the fallback breaker, and the hold's own
  // memory (deadline, kind, relapse count). In memory only — a restart re-trusts the
  // fallback, starts with the hold open, and can re-log at most one event per gate. The
  // budget gate's breaker is also the fallback ticks' evidence sink: the start pass below
  // records every tick's outcome into it and runs its probe (src/fallback-breaker.ts), and
  // the start gate reads gateStates.fleetHold at permit time, so its closures always see
  // the latest poll's hold verdict rather than the poll that created them.
  const gateStates: FleetGateStates = newFleetGateStates(config);
  // The live config the last successful reload produced (last-known-good while the file is
  // broken or missing). The reload bookkeeping itself lives in src/config-live.ts.
  const liveReload = newLiveConfigReload({ root, config, mainBranch, runnerSignal: roleSignal, runners, semaphore, roleFilter: opts.roleFilter });
  // The pause gates (src/pause-gates.ts owns the concern): the operator pause's and the
  // per-role pause's cross-poll bookkeeping, so each pause/resume crossing logs exactly one
  // event instead of once per ~2s poll.
  // The primary checkout's branch, for the edge-triggered divergence warning: the fleet
  // resolved its target branch at startup, and a human checking out something else mid-run
  // must not silently change what the fleet merges into — every role worktree is based on
  // the resolved branch. One warning per episode, re-armed when the checkout returns.
  let warnedBranchDivergence = false;

  // Need-based deferral (PLANS.md "Prioritize loops by need"): whether qualifying work has
  // landed since a role's last-seen main head, cached per head (see work-landed-cache.ts).
  const workLandedSince = new WorkLandedCache(root, mainBranch);
  // Per-role deferred-due state for one-shot tick_deferred events: the previous poll's
  // deferral per role (like prevBudgetPaused/prevUserPaused, but per role), so each episode
  // logs exactly once — on the transition in, never while merely not-due and never on exit.
  // In-memory only: a restart mid-episode can re-log at most one event.
  const deferredDue = new Map<string, boolean>();

  // Whether the last poll found a self-redeploy pending (`hold`). Hoisted out of the poll loop
  // because it is read at two points: at scheduling (no new tick is reserved) and — through
  // tickStartHeld — whenever a parked waiter is granted its permit, which happens between polls.
  let holdForRestart = false;
  // The start gate every reserved tick passes the moment its permit is granted
  // (runTimedRoleTick's `held`): closed while a restart is pending, and after one is decided so
  // no waiter the shutdown hands a permit to starts on the build being replaced. One predicate,
  // so another fleet-wide hold on new ticks can close the same gate point.
  const tickStartHeld = () => holdForRestart || restart;

  // The operator notify hook (src/notify.ts owns the whole concern): one configured shell
  // command run on notable events (budget_paused, role_streak_paused, land_failed,
  // restart_blocked). Subscribed here so it sees every event this process logs from start;
  // disposed beside the orchestrator_stop event below.
  const notifier = newNotifier(root);

  try {
    while (!signal.aborted) {
      // Live-reload tumwater.json — the single reload point shared by all loops (src/config-live.ts
      // owns the last-known-good retention and the edge-triggered warnings/events around it).
      const liveConfig = liveReload.poll();
      // The notify command rides the same last-known-good reload (src/notify.ts): a live
      // `config set notify` edit takes effect on the next poll, no restart.
      notifier.update(liveConfig);

      // Live session retention (the last restart-only setting): the edge-triggered
      // retention_changed event, the once-per-day gate, and the prune itself live in
      // src/retention.ts. The live config (last-known-good while the file is broken or
      // missing) drives the check, like the budget gate.
      retentionPruner.poll(root, liveConfig.sessionRetentionDays);

      // launchservicesd's Mach-port budget (src/launch-services.ts owns it): a background sample
      // at most every 15 minutes, and a warning days before the kernel kills the daemon and
      // wedges the Mac's GUI session. Never awaited — a poll does not wait on `top`.
      void launchServicesWatch?.poll();

      // Consume CLI request markers: a reset-counters request, a wake request, a forced-restart
      // request, and per-role abort requests.
      consumeResetRequest(root, runners);
      consumeWakeRequest(root, runners);
      consumeRestartRequest(root, redeploy);
      consumeAbortRequests(root, runners, abortableLandings(landings));
      await settleAbortedVetted(root, landings);

      // branchHead reads the ref files first (microsecond-scale; this runs every poll) and
      // spawns `git rev-parse` only when they cannot resolve it. "" means main does not exist
      // yet — isEligible treats an empty head as "no wake".
      const mainHead = (await branchHead(root, mainBranch)) ?? "";
      // Branch-divergence watch, once per poll (see warnedBranchDivergence above): the
      // fleet keeps fast-forwarding the branch it resolved at startup — the safe behavior,
      // since role worktrees are based on it — and one warning names the divergence
      // instead of leaving it mysterious. Back on the target branch re-arms the check.
      const liveBranch = await currentBranch(root);
      if (liveBranch !== null && liveBranch !== mainBranch) {
        if (!warnedBranchDivergence) {
          warnedBranchDivergence = true;
          warnEvent(
            root,
            "harness",
            `primary checkout moved to ${liveBranch} — the fleet keeps merging into ${mainBranch}`,
          );
        }
      } else {
        warnedBranchDivergence = false;
      }
      const now = Date.now();

      // The fleet's gates and alarms, one poll of the family (src/gate-polls.ts): the daily
      // budget gate — with its derived-state publish and the fallback handback to the
      // primary — the operator and per-role pause gates, quiet hours, the fleet-wide failure
      // hold, and the two observational storm alarms. The family's cross-poll memory lives
      // in gateStates, advanced in place; this returns this poll's verdicts for the
      // scheduling and start passes. The failure hold is deliberately not among them — the
      // start gate and the landings' startHeld read the LATEST poll's verdict at permit
      // time from gateStates.fleetHold, so a waiter granted its permit after later polls
      // ran meets the hold as it stands then, not as this poll left it.
      const { gate, roleConfig, userPaused, pausedRoles: pausedRolesSet, capPaused, quietNow } =
        pollFleetGates(gateStates, {
        root,
        runners,
        liveConfig,
        modelsPath,
        now,
        info,
        infoFile,
      });
      const held = gateStates.fleetHold.until !== null;

      // Self-redeploy (src/redeployer.ts): with main's head in hand, let the state machine observe it.
      // `hold` starts no new ticks at all — director included; a restart lands within the drain's
      // window plus a bounded landing hand-off, and its prompt waits in the inbox for the new
      // build — while the green check/compile/drain run in the background. That covers ticks
      // reserved before the hold too: a waiter parked in the semaphore queue that is granted a
      // permit mid-drain meets the closed start gate (tickStartHeld), releases the permit, and
      // hands its reservation back so it re-schedules once the hold lifts or on the new build.
      // `restart` means dist/ already holds the new
      // build: stop scheduling, abort whatever role ticks the drain gave up waiting for — the
      // permit holders; they resume on the new build — and return. A director tick can never be
      // in flight here — poll only returns `restart` once it has finished. (holdForRestart keeps
      // the previous poll's verdict until this one's is in: resetting it before the await
      // would open the gate for a waiter granted a permit while poll runs.)
      if (redeploy) {
        const action = await redeploy.poll(
          mainHead,
          {
            roleInFlight: rolePermitHolders.size,
            directorInFlight: directorInFlight.size,
            roleTickP75Ms: p75TickDurationMs(roleTickDurationsMs),
          },
          liveConfig.autoRestart,
          now,
        );
        const build = redeploy.status(now);
        if (JSON.stringify(build) !== JSON.stringify(info.build)) {
          info.build = build;
          writeJsonFile(infoFile, info);
        }
        if (action === "restart") {
          restart = true;
          // Only permit holders have a pi run to cut off (the director is guaranteed finished by
          // then): a parked waiter meets the closed start gate whenever the shutdown hands it a
          // permit, so it needs no abort — and aborting for it alone would also cut off an
          // in-flight landing that no permit-holding tick put at stake. The role-only controller
          // keeps that promise: the landing, wired to the full signal, runs on into the hand-off
          // window the wait announces (BUGS.md 2026-09-30).
          if (rolePermitHolders.size > 0) internalRoleStop.abort();
          break;
        }
        holdForRestart = action === "hold";
      }

      // Merge queue 3/5 — drain the durable land queue while neither a restart nor a failure
      // hold is pending (the scheduler's WHEN; landing-drain.ts owns the HOW — the vetting stage, its
      // merge slot, and the dedupe against main). A held poll starts no vet and no merge,
      // exactly as it starts no tick; what is already in flight runs on, and a vet parked for
      // its permit meets the same start gate as a parked tick when the permit comes.
      if (!holdForRestart && !held) {
        await drainLandings(
          {
            root,
            mainBranch,
            signal,
            semaphore,
            runners,
            liveConfig,
            roleConfig,
            startHeld: () => tickStartHeld() || gateStates.fleetHold.until !== null,
          },
          landings,
        );
      }

      // Backlog-aware deferral: while PLANS.md `## Planned` or BUGS.md `## Open` on main is
      // non-empty, idle maintenance ticks stay deferred — queued feature/bugfix work outranks
      // them regardless of what landed. Stat-cached reads (backlog.ts): one stat per file per
      // poll while the files are unchanged. bugfix is not a maintenance role, but while BUGS.md
      // `## Open` is empty it defers like one (deferTick) — openBugsNow is that emptiness, read
      // once here and reused for both predicates.
      const openBugsNow = openBugs(root).length > 0;
      const workBacklogOpen = plannedPlans(root).length > 0 || openBugsNow;

      const reasons = new Map<LoopRunner, string | undefined>();
      // Merge-queue interlock data, listed ONCE per poll (was once per runner per poll — each
      // queuedLandingFiles() re-lists the land-queue directory and re-stats every queued entry): the
      // check below only asks whether the runner's role has a queued entry. The queue changes
      // only when a landing completes or a tick enqueues — both asynchronous events this pass
      // observes on its next poll — so one snapshot is as fresh as per-runner reads, and a
      // landing that completes mid-pass just keeps its role blocked one extra poll (conservative).
      const queuedLandingRoles = new Set(queuedLandingFiles(root).map((q) => q.entry.role));
      // A demoted fallback's half-open window: its role ticks may pass the `paused` budget gate
      // here, and the start pass below admits exactly one of them as the probe. Never past an
      // operator pause — human intent outranks the breaker's curiosity.
      const probeDue = fallbackProbeDue(gateStates.budget.breaker, now);
      // The fleet gates' block predicate (the director exempt — an explicit human prompt
      // outranks any autonomous gate, quiet hours included): the once-mode settle below and
      // the start gate must agree on exactly when a fleet gate holds, so the compound lives
      // here once. Quiet hours fold in beside the operator pause and the budget gate — the
      // schedule is not probe-worthy the way a paused budget is, so no probeDue exception.
      const operatorPauseBlocks = (role: string): boolean =>
        (userPaused || quietNow || (gate === "paused" && !probeDue)) && role !== DIRECTOR_ROLE;
      for (const runner of runners) {
        // Once mode: a paused role runs no tick this round and must be reported as skipped,
        // so it settles here — before the gates that would otherwise skip it silently (a
        // once round has to end even when a pause marker is left over; a later resume within
        // the same round cannot un-settle it, which is the at-most-one-tick contract).
        if (
          once.active &&
          !once.isSettled(runner) &&
          !runner.state.running &&
          (pausedRolesSet.has(runner.role) || capPaused.has(runner.role) || operatorPauseBlocks(runner.role))
        ) {
          once.settle(runner.role, "paused");
        }
        // Once mode's at-most-one-tick contract (src/once-round.ts): a role that already ran
        // its tick — or was settled with a skip reason — runs nothing further this round, even
        // when its backoff has expired or the clock override would admit it again. Without this
        // gate the one-tick guarantee held only for deferrable built-ins (their deferral
        // settles them); a custom loop or work role with a short backoff re-qualified every
        // poll and the round never ended.
        if (once.active && !runner.state.running && once.isSettled(runner)) continue;
        if (holdForRestart) continue; // a restart is pending: nothing new starts, on any loop
        // The per-role pause gates BEFORE the fleet check and exempts nothing — the director
        // included (the operator named that one loop deliberately).
        if (pausedRolesSet.has(runner.role)) continue;
        // The role's own daily cost cap (src/role-cap-gates.ts): no start-gate change — a
        // parked waiter finishes (in-flight ticks finish, NEW ticks are gated at scheduling,
        // exactly like every per-role pause), and there is no fallback-probe exception: the
        // stop is about spend, and probing it adds noise, not signal. The lift is a live
        // config edit or local midnight — no marker exists for `resume --role` to touch.
        if (capPaused.has(runner.role)) continue;
        if (operatorPauseBlocks(runner.role))
          continue; // no new role ticks while either gate holds
        if (held && runner.role !== DIRECTOR_ROLE) continue; // nor while a failure storm holds
        // The loop's OWN queue decides inbox due-ness: the director counts its historical
        // inbox, every other loop its per-role queue (tumwater prompt --role <id>) — so a
        // queued prompt makes its loop due by itself, no wake marker needed (isEligible).
        const { run, reason } = isEligible(runner, now, mainHead, inboxSize(root, runner.role), {
          once: once.active,
        });
        if (!run) {
          // Not due this poll: any deferral episode has ended (or never started). No event —
          // the tick's own events cover it.
          if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false);
          // Once mode: idle and not due — settleSkipped records the skip reason (the caller's
          // summary reports it).
          if (once.active && !runner.state.running) once.settleSkipped(runner);
          continue;
        }
        // Merge queue 3/5 interlock (invariant 3): a role with a QUEUED or IN-FLIGHT landing
        // never starts a tick — the entry stays in the queue until its landing completes, so
        // one check covers both. Uniform over every role, director included: its prompt is not
        // finished until it lands. Placed before the need-based deferral block on purpose —
        // no episode bookkeeping is needed (the tick that queued the landing ran, which closed
        // any deferral episode; its `queued` can leave a prior no_change in lastResult — loop-state.ts
        // records only completed results — but the landing's outcome replaces it before the
        // interlock lets the role back into this pass), and skipping here saves that branch's
        // workLandedSince git-range query for the skipped role.
        if (queuedLandingRoles.has(runner.role)) continue;
        // Need-based deferral: a due maintenance tick (scheduled or main-moved wake) whose last
        // tick did nothing stays deferred while the feature/bugfix backlog is open or no new
        // work has landed to react to — nextRunAt is left untouched, so it re-checks every poll
        // until the backlog drains and qualifying work lands. Resume wakes precede this check in
        // isEligible, the director's "inbox" reason skips it, work roles are not in
        // DEFERRABLE_ROLES (bugfix is the exception while its backlog is empty — deferTick), and
        // a fresh operator wake overrides it (deferTick's woken check — an explicit "try again
        // now" is a demand, not idle maintenance). Sitting before reasons.set also keeps a
        // deferred role out of the wake-event pass below.
        if (reason === "scheduled" || reason === "main moved") {
          const s = runner.state;
          // The git range is only consulted when the other conditions already hold — a
          // never-ticked role or a tick with pending business runs without paying for it, and an
          // open backlog defers regardless of what landed. bugfix in search mode is the
          // exception: its deferral keys on the work-landed verdict alone, so the backlog-open
          // shortcut must not stand in for the query.
          const searchBugfix = runner.role === BUGFIX_ROLE && !openBugsNow;
          const landed =
            (!workBacklogOpen || searchBugfix) && s.lastMainHead !== ""
              ? await workLandedSince.since(s.lastMainHead, mainHead)
              : true;
          const deferredNow = deferTick(s, runner.role, landed, workBacklogOpen, openBugsNow, now);
          if (deferredNow !== (deferredDue.get(runner.role) ?? false)) {
            if (deferredNow)
              logEvent(root, { loop: runner.role, type: "tick_deferred" });
            deferredDue.set(runner.role, deferredNow);
          }
          if (deferredNow) {
            // Once mode: a deferred maintenance tick decided not to run — its once-round
            // answer, so it settles instead of holding the round open for DEFER_MAX_MS.
            if (once.active) once.settle(runner.role, "deferred");
            continue;
          }
        } else if (deferredDue.get(runner.role)) {
          deferredDue.set(runner.role, false); // an inbox/resume run ends the episode
        }
        reasons.set(runner, reason);
      }
      launchDueTicks({
        root,
        reasons,
        signal,
        gateStates,
        breakerPolicy,
        probeDue,
        semaphore,
        rolePermitHolders,
        roleInFlight,
        directorInFlight,
        roleTickDurationsMs,
        startHeld: (role) => tickStartHeld() || (role !== DIRECTOR_ROLE && gateStates.fleetHold.until !== null),
      });

      // Once mode's exit: every enabled role settled, no tick in flight, and the land queue
      // empty with no landing in flight for one full poll cycle — then fire the internal
      // stop, the same graceful shutdown the restart drain uses (the `finally` awaits
      // in-flight landing tasks to the end). The one-poll-cycle requirement is the guard
      // against dropping a queued-but-not-yet-started landing: a stop that lands during the
      // shutdown drain drops the queue entry, so the slot gets its poll to pick the entry up
      // before the stop is trusted.
      if (
        once.exitReady({
          roleTicks: roleInFlight.size,
          directorTicks: directorInFlight.size,
          landings: landingTasks(landings).length,
          queuedLandings: queuedLandingFiles(root).length,
        })
      ) {
        internalStop.abort();
        break;
      }

      await sleepInterruptible(pollMs, signal);
    }
  } finally {
    await drainInFlightWork(
      root,
      roleInFlight,
      directorInFlight,
      landingTasks(landings),
      restart,
      opts.handoffLandingWindowMs ?? HANDOFF_LANDING_WINDOW_MS,
      () => internalStop.abort(),
    );
    logEvent(root, { loop: "harness", type: "orchestrator_stop" });
    notifier.dispose();
    removeQuiet(infoFile);
  }
  // Only once mode carries the settle reasons and the per-role ticks-run: the daemon return
  // keeps its exact shape (an e2e test deep-equals it), and a daemon caller has no summary to
  // feed.
  return once.active
    ? {
        restart,
        settled: once.reasons,
        ticksRun: new Map(runners.map((r) => [r.role, once.ticksRun(r)] as const)),
      }
    : { restart };
}
