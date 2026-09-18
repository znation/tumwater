import path from "node:path";
import type { TickOutcome, TumwaterConfig } from "./types.js";
import type { OrchestratorInfo } from "./state.js";
import { applyFallbackModel, enabledRoleIds, fallbackPair, loadConfigCached } from "./config.js";
import {
  deferTick,
  dueForPrune,
  fairOrder,
  isEligible,
  workLanded,
} from "./scheduling.js";
import {
  isFleetPaused,
  readLandingMarker,
} from "./state.js";
import { budgetGate, budgetPaused, type BudgetGate, fleetDailyCost } from "./budget.js";
import { saveLoopState } from "./state.js";
import { DIRECTOR_ROLE, roleTier } from "./roles.js";
import { openBugs, plannedPlans } from "./backlog.js";
import { LoopRunner } from "./loop.js";
import { branchHead, deleteRef, isMergedInto, subjectsBetween } from "./git.js";
import { landBatch } from "./lander.js";
import { landQueuedEntry, landingUsage, writeLandingOutcome } from "./landing-slot.js";
import { dropLanding, headLanding, landingFor, queuedLandingFiles, staleHeadFile } from "./land-queue.js";
import { logEvent } from "./events.js";
import { pruneOldFiles, removeQuiet } from "./files.js";
import { writeJsonFile } from "./json-files.js";
import { inboxSize } from "./inbox.js";
import {
  consumeAbortRequests,
  consumeResetRequest,
  consumeWakeRequest,
} from "./operator-requests.js";
import { fallbackModelFree, piModelsPath } from "./pi-models.js";
import { Semaphore } from "./semaphore.js";
import {
  landingRefName,
  landingStatePath,
  orchestratorStatePath,
  sessionsRootDir,
} from "./paths.js";
import { errorMessage } from "./text.js";
import { p75TickDurationMs, type Redeployer } from "./redeploy.js";

const POLL_MS = 2000;

/** The semaphore tier a landing's pi runs acquire at, below every roleTier (0/1): committed
 * work whose author the interlock has already blocked jumps ahead of parked role waiters
 * rather than starving behind them (BUGS.md 2026-09-18). */
const LANDING_TIER = -1;

/** Run one role tick under the concurrency semaphore and return how long the tick itself ran,
 * in ms — null when it never started (the harness is already stopping) or was cut off by an
 * abort. This is the restart drain's p75 sample (BUGS.md 2026-09-18). The clock starts only
 * once the permit is granted, so time a tick spends parked in the semaphore queue is not
 * counted as work: the drain waits on ticks that are already running, and folding queue wait
 * into the window would overstate how long they have left (the `tick_start`..`tick_end` span
 * the window was sized against excludes it too). Aborted ticks return null so their short
 * cut-off lengths cannot drag the window down. `now` is a test seam. */
export async function runTimedRoleTick(
  signal: AbortSignal,
  acquire: () => Promise<void>,
  release: () => void,
  tick: () => Promise<TickOutcome>,
  now: () => number = Date.now,
): Promise<number | null> {
  await acquire();
  try {
    if (signal.aborted) return null;
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
 * on either exit path so long-running orchestrators don't accumulate one per poll. */
function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
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

interface RunOptions {
  root: string;
  config: TumwaterConfig;
  mainBranch: string;
  signal: AbortSignal;
  /** Poll interval in ms (default POLL_MS). Tests pass a short value so multi-cycle behavior
   * resolves quickly; production callers omit it and keep the real cadence. */
  pollMs?: number;
  /** Self-redeploy policy (src/redeploy.ts) for a self-hosting fleet; null/absent when the
   * running dist carries no build stamp. Consulted every poll with main's head. */
  redeploy?: Redeployer | null;
  /** pi's model definitions (default ~/.pi/agent/models.json), read to decide whether the
   * configured fallback model is actually cost-free — a test seam, like status.ts's. */
  modelsPath?: string;
}

/** How runOrchestrator ended: `restart` means dist/ now holds a newer build and the caller should
 * exit RESTART_EXIT_CODE so the supervisor respawns onto it; otherwise the stop signal fired. */
interface OrchestratorExit {
  restart: boolean;
}

/** The single in-flight landing the drain owns (merge queue 3/5): its task, the controller
 * that aborts it (harness shutdown OR `tumwater abort --role` for any of its roles), and
 * whether the abort was a deliberate user stop — which decides what happens to the pinned
 * refs when it ends. Since merge queue 5/5 `roles` is every role the slot is landing: one for
 * the single path, up to landBatchMax for a batch. */
interface InFlightLanding {
  promise: Promise<void>;
  controller: AbortController;
  roles: string[];
  userAborted: boolean;
}

/** Discard the pinned landing refs of every role in a deliberately-aborted landing.
 * `tumwater abort --role` throws the committed work away, and the pin is what would otherwise
 * recover it, so the ref must go; a shutdown abort leaves `userAborted` unset and every ref
 * survives for recovery. Shared by the single-landing and batch-landing finally blocks so
 * their discard semantics cannot drift. A ref that is already gone is not an error. */
async function discardPinnedRefs(root: string, roles: string[]): Promise<void> {
  for (const role of roles) {
    try {
      await deleteRef(root, landingRefName(role));
    } catch {
      /* already gone */
    }
  }
}

/** Run all enabled loops until the signal aborts — or until a pending self-redeploy has drained
 * the fleet and swapped the new build into dist/ (then `restart` is true). */
export async function runOrchestrator(opts: RunOptions): Promise<OrchestratorExit> {
  const { root, config, mainBranch, signal: externalSignal } = opts;
  const pollMs = opts.pollMs ?? POLL_MS;
  const modelsPath = opts.modelsPath ?? piModelsPath();
  const enabled = enabledRoleIds(config);
  if (enabled.length === 0) throw new Error("no roles enabled in tumwater.json");

  // Runners and sleeps watch a combined signal: the caller's (Ctrl+C/SIGTERM) plus an internal
  // one the redeploy path fires when its drain of ROLE ticks runs out of patience — those
  // in-flight role ticks then end as `aborted` (resumable on the new build), exactly like a
  // shutdown. A director tick is never aborted this way: poll holds for it without a cap, so by
  // the time `restart` lands only role ticks can remain.
  const internalStop = new AbortController();
  const signal = AbortSignal.any([externalSignal, internalStop.signal]);
  const redeploy = opts.redeploy ?? null;
  let restart = false;

  let runners = enabled.map((role) => new LoopRunner(root, role, config, mainBranch, signal));
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrent));

  // The landing slot's pi runs — a reviewer, or a batch's per-change gates — cost the backend
  // what an author run costs, so they take the same maxConcurrent permit role ticks do
  // (BUGS.md 2026-09-18). Exempting them let total load float to maxConcurrent + landing +
  // director on a single-GPU backend, where the extra stream is what starves sessions into the
  // quiet watchdog's kills. The landing's wait is bounded by one in-flight tick, and a queued
  // landing that is aborted while parked still aborts (with its ref rules) once a slot frees.
  const withLandingSlot = async <T>(run: () => Promise<T>): Promise<T> => {
    await semaphore.acquire(LANDING_TIER);
    try {
      return await run();
    } finally {
      semaphore.release();
    }
  };

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

  // 0 disables pruning — the same convention as quietTimeoutSeconds. (With a positive N,
  // pruneOldFiles deletes everything older than N days; JSON has no "keep forever" value, so
  // 0 is the off switch rather than "delete all sessions now".)
  if (config.sessionRetentionDays > 0) {
    const pruned = pruneOldFiles(sessionsRootDir(root), config.sessionRetentionDays);
    if (pruned > 0) {
      logEvent(root, { loop: "harness", type: "warning", message: `pruned ${pruned} old pi session file(s)` });
    }
  }

  // In-flight tasks, split by who requested them: the redeploy drain caps role ticks at its
  // window but waits for a director tick without one — an explicit human prompt outranks the
  // self-redeploy (BUGS.md 2026-09-08). The landing slot is deliberately OUTSIDE this split:
  // it is a single in-process task (one at a time, since 2026-09-18 under the same maxConcurrent
  // permit as role ticks) that graceful shutdown still awaits — an aborted landing keeps its ref
  // and drops its entry, recovering on next start.
  const roleInFlight = new Set<Promise<void>>();
  const directorInFlight = new Set<Promise<void>>();
  // The restart drain's window tracks the fleet's real tick duration (BUGS.md 2026-09-18): the
  // durations of recent COMPLETED role ticks feed a p75 that poll uses in place of the
  // cold-start constant. Bounded so a long-running fleet's memory stays flat; aborted ticks are
  // excluded — their short cut-off durations would drag the window down and cause more aborts.
  const ROLE_TICK_DURATION_SAMPLES = 50;
  const roleTickDurationsMs: number[] = [];
  let landingInFlight: InFlightLanding | null = null;
  // Live-reload bookkeeping: the last config error already warned about (a broken file must
  // warn once per distinct text, not every poll), and the previous cycle's enabled set (for
  // one-shot enable/disable transition warnings).
  let lastConfigError: string | null = null;
  let prevEnabled = new Set<string>(enabled);
  // The previous poll's budget gate, for one-shot transition events. Three-valued since
  // plans/fallback-model.md: open → fallback → paused are distinct states, and every crossing
  // between two of them is worth exactly one event.
  let prevGate: BudgetGate = "open";
  // The live config the last successful reload produced (last-known-good while the file is
  // broken) and, derived from it, the view role loops run under while the fallback gate holds
  // — recomputed only when the config object itself changes.
  let liveConfig = config;
  let fallbackFrom: TumwaterConfig | null = null;
  let fallbackConfig: TumwaterConfig = config;
  // Same bookkeeping for the operator pause (the marker file), so each pause/resume logs
  // exactly one event instead of once per ~2s poll.
  let prevUserPaused = false;
  // The cap last applied to the semaphore (live-resized on each reload), so a change logs
  // exactly one event per distinct value — not once per ~2s poll.
  let lastMaxConcurrent = Math.max(1, config.maxConcurrent);
  // Live session-retention bookkeeping: the window last applied and when we last pruned —
  // both seeded from the startup prune above, so a mid-run edit re-prunes immediately while
  // an unchanged fleet prunes at most once per day (dueForPrune).
  let lastRetention = config.sessionRetentionDays;
  let lastPruneAt: number | null = config.sessionRetentionDays > 0 ? Date.now() : null;

  // Need-based deferral (PLANS.md "Prioritize loops by need"): work-landed verdicts are cached
  // per base head so a quiet fleet pays no git cost in steady state. A TRUE verdict is monotone
  // under fast-forward-only main movement — once work has landed in (sinceHead, main] it stays
  // there — so true heads never re-evaluate. A FALSE verdict is valid exactly while main sits at
  // the head it was checked against: the range cannot grow until main moves, so a cached false
  // skips the `git log` entirely and re-checks once when main's head changes (a false can flip to
  // true only on such movement — caching it unconditionally would defer a role forever after the
  // very commit that should wake it). Both caches are bounded, so a long-running fleet cannot
  // grow them unbounded.
  const workLandedHeads = new Set<string>();
  const noWorkAtHead = new Map<string, string>(); // sinceHead -> main head at which "no work" held
  async function workLandedSince(sinceHead: string, mainHeadNow: string): Promise<boolean> {
    if (workLandedHeads.has(sinceHead)) return true;
    const checkedAt = noWorkAtHead.get(sinceHead);
    // Main has not moved since the last check for this head — the range is unchanged. An empty
    // mainHead means the ref could not be resolved: never trust or store a cache against it.
    if (mainHeadNow !== "" && checkedAt === mainHeadNow) return false;
    const subjects = await subjectsBetween(root, sinceHead, mainBranch);
    // A range that cannot be evaluated is treated as work landed — conservative: run the tick.
    const verdict = subjects === null ? true : workLanded(subjects);
    if (verdict) {
      noWorkAtHead.delete(sinceHead);
      if (workLandedHeads.size >= 200) workLandedHeads.clear();
      workLandedHeads.add(sinceHead);
    } else if (mainHeadNow !== "") {
      if (noWorkAtHead.size >= 200) noWorkAtHead.clear();
      noWorkAtHead.set(sinceHead, mainHeadNow);
    }
    return verdict;
  }
  // Per-role deferred-due state for one-shot tick_deferred events: the previous poll's
  // deferral per role (like prevBudgetPaused/prevUserPaused, but per role), so each episode
  // logs exactly once — on the transition in, never while merely not-due and never on exit.
  // In-memory only: a restart mid-episode can re-log at most one event.
  const deferredDue = new Map<string, boolean>();

  try {
    while (!signal.aborted) {
      // Live-reload tumwater.json — the single reload point shared by all loops. A broken
      // file keeps the last-known-good config and warns once per distinct error text.
      // Unchanged files are served from a stat-keyed cache (one stat per poll, no read).
      const reloaded = loadConfigCached(root);
      if (reloaded.config) {
        liveConfig = reloaded.config;
        for (const r of runners) r.config = reloaded.config;
        // Live-resize the concurrency cap: a mid-run edit changes how many pi runs execute
        // concurrently within this poll — no restart. Growing admits already-queued ticks;
        // shrinking never preempts in-flight work, it only caps future grants.
        const newMaxConcurrent = Math.max(1, reloaded.config.maxConcurrent);
        if (newMaxConcurrent !== lastMaxConcurrent) {
          semaphore.setCapacity(newMaxConcurrent);
          logEvent(root, { loop: "harness", type: "max_concurrent_changed", from: lastMaxConcurrent, to: newMaxConcurrent });
          lastMaxConcurrent = newMaxConcurrent;
        }
        const nowEnabled = enabledRoleIds(reloaded.config);
        // Enabling a role mid-run starts it: create its runner (its persisted state survives).
        for (const role of nowEnabled) {
          if (!runners.some((r) => r.role === role))
            runners.push(new LoopRunner(root, role, reloaded.config, mainBranch, signal));
        }
        for (const role of prevEnabled)
          if (!nowEnabled.includes(role))
            logEvent(root, { loop: "harness", type: "warning", message: `role ${role} disabled — stopping ticks` });
        for (const role of nowEnabled)
          if (!prevEnabled.has(role))
            logEvent(root, { loop: "harness", type: "warning", message: `role ${role} enabled — starting ticks` });
        prevEnabled = new Set(nowEnabled);
        lastConfigError = null;
      } else if (reloaded.error && reloaded.error !== lastConfigError) {
        logEvent(root, { loop: "harness", type: "warning", message: `tumwater.json invalid — keeping current config: ${reloaded.error}` });
        lastConfigError = reloaded.error;
      }

      // Live session retention (the last restart-only setting): a mid-run edit to the window
      // re-prunes immediately; independently of edits, an unchanged fleet prunes at most once
      // per day so a never-restarted fleet still honors its window. Both paths log the startup
      // warning shape only when files were actually deleted — quiet polls stay silent. The live
      // config (last-known-good while the file is broken) drives both checks, like the budget gate.
      const retention = liveConfig.sessionRetentionDays;
      if (retention !== lastRetention || dueForPrune(lastPruneAt, Date.now(), retention)) {
        // A change to a positive window prunes immediately even inside the daily window — an
        // operator tightening the window wants it applied now, not at tomorrow's pass. Every
        // distinct value change logs one event (like its maxConcurrent sibling) so live edits
        // are visible in logs/TUI/GUI even when nothing was pruned; pruning itself still runs
        // only for a positive window.
        if (retention !== lastRetention) {
          logEvent(root, { loop: "harness", type: "retention_changed", from: lastRetention, to: retention });
        }
        const pruneNow = Date.now();
        if (retention > 0) {
          const pruned = pruneOldFiles(sessionsRootDir(root), retention);
          if (pruned > 0) logEvent(root, { loop: "harness", type: "warning", message: `pruned ${pruned} old pi session file(s)` });
          lastPruneAt = pruneNow;
        }
        lastRetention = retention;
      }

      // Consume CLI request markers: a reset-counters request, a wake request, and per-role
      // abort requests.
      consumeResetRequest(root, runners);
      consumeWakeRequest(root, runners);
      consumeAbortRequests(root, runners, landingInFlight);

      // branchHead reads the ref files first (microsecond-scale; this runs every poll) and
      // spawns `git rev-parse` only when they cannot resolve it. "" means main does not exist
      // yet — isEligible treats an empty head as "no wake".
      const mainHead = (await branchHead(root, mainBranch)) ?? "";
      const inboxCount = inboxSize(root);
      const now = Date.now();

      // Daily cost budget gate (plans/daily-cost-budget.md, plans/fallback-model.md): once the
      // fleet's spend for the local day has reached maxDailyCostUsd, role loops either switch
      // to the configured cost-free fallback model and keep working, or — with no usable one —
      // start no new ticks at all (scheduled, main-moved wake, or startup). The director is
      // outside both: an explicit human prompt outranks the autonomous-spend cap, so it keeps
      // its budgeted model and keeps ticking. In-flight ticks finish; only NEW ticks are
      // gated. Resume is live and stateless — raising/disabling the cap (live-reloaded above),
      // fixing the fallback, or crossing local midnight re-evaluates this on the next poll, so
      // nothing can get stuck.
      const states = runners.map((r) => r.state);
      // Whether the fallback is usable is a live question too: models.json is stat-cached
      // inside pi-models.ts, so an unchanged catalog costs one stat per poll, and an operator
      // who fixes a mistyped model id sees the fleet switch over within a cycle.
      const gate = budgetGate(budgetPaused(states, liveConfig, now), fallbackModelFree(liveConfig, modelsPath));
      if (gate !== prevGate) {
        const pair = fallbackPair(liveConfig);
        logEvent(root, {
          loop: "harness",
          type: gate === "open" ? "budget_resumed" : gate === "fallback" ? "budget_fallback" : "budget_paused",
          spentUsd: fleetDailyCost(states, now),
          capUsd: liveConfig.maxDailyCostUsd,
          // On the way into a gate the fallback's identity is the operator's answer to "why
          // this and not the other one": which free pair took over, or which configured pair
          // was refused because pi's definitions do not price it at zero.
          ...(gate === "fallback" ? { provider: pair?.provider, model: pair?.model } : {}),
          ...(gate === "paused" && pair
            ? { fallbackRejected: `${pair.provider ?? "?"}/${pair.model ?? "?"}` }
            : {}),
        });
        prevGate = gate;
      }
      // While the fallback holds, every role loop runs under the derived view — the free pair
      // installed top-level and every per-role/reviewer model override dropped, so no seam can
      // reach a priced model. The director keeps the live config. Assigned every poll (not only
      // on transitions) so a runner created mid-gate, or one left behind by a broken-file poll
      // that skipped the reload, can never tick on the wrong model.
      if (gate === "fallback" && fallbackFrom !== liveConfig) {
        fallbackFrom = liveConfig;
        fallbackConfig = applyFallbackModel(liveConfig);
      }
      const roleConfig = gate === "fallback" ? fallbackConfig : liveConfig;
      for (const r of runners) r.config = r.role === DIRECTOR_ROLE ? liveConfig : roleConfig;

      // Operator pause (`tumwater pause`): the budget gate's sibling with a different trigger —
      // human intent instead of spend. The marker is persistent state (presence means paused
      // until `resume` removes it), so one existsSync per cycle reads it fresh: pausing before
      // startup starts an already-paused fleet, and removing the marker mid-run unblocks roles
      // on their next eligibility without a restart. The director is exempt for the same reason
      // as under the budget gate — a human typing prompts outranks an operator gate (queued
      // prompts simply wait in the inbox if full silence is wanted). In-flight ticks finish;
      // only NEW ticks are blocked, because the gate sits before isEligible.
      const userPaused = isFleetPaused(root);
      if (userPaused !== prevUserPaused) {
        logEvent(root, { loop: "harness", type: userPaused ? "fleet_paused" : "fleet_resumed" });
        prevUserPaused = userPaused;
      }

      // Self-redeploy (src/redeploy.ts): with main's head in hand, let the policy observe it.
      // `hold` starts no new ticks at all — director included; a restart lands within minutes
      // and its prompt waits in the inbox — while the green check/compile/drain run in the
      // background. `restart` means dist/ already holds the new build: stop scheduling, abort
      // whatever role ticks the drain gave up waiting for (they resume on the new build), and
      // return. A director tick can never be in flight here — poll only returns `restart` once
      // it has finished.
      let holdForRestart = false;
      if (redeploy) {
        const action = await redeploy.poll(
          mainHead,
          {
            roleInFlight: roleInFlight.size,
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
          if (roleInFlight.size > 0) internalStop.abort(); // the director is guaranteed finished by then
          break;
        }
        holdForRestart = action === "hold";
      }

      // Merge queue 3/5 — drain the durable land queue on the single landing slot. A queued
      // landing is COMMITTED work awaiting completion, not a new tick, so the budget and
      // user-pause gates deliberately do not hold it (pausing it would leave main behind while
      // the interlock below blocks that role's next tick forever); `holdForRestart` DOES
      // suppress it, like ticks — a restart lands within minutes and the entry drains on the
      // next start (a pending-restart break above precedes this). One landing at a time: the
      // promise is stored, never awaited in the poll loop, and cleared on completion — authors
      // keep ticking behind it, which is the entire point. The head is deduped against main
      // first: a crash between the ff-merge and the entry drop leaves an entry whose sha main
      // already holds, and that is dropped without a landing run (leftover.ts's stale-pin
      // idiom); a crash mid-review leaves both entry and ref, so the drain re-runs landChange —
      // re-reviews — the established crash semantics.
      if (!holdForRestart && landingInFlight === null) {
        let head = headLanding(root);
        if (!head) {
          // A torn head (a hard crash mid enqueueLanding write, or a foreign file) makes
          // headLanding read null forever — nothing else drops it, stranding every live entry
          // behind it and pinning their authors' ticks via the interlock. Drop it with one
          // warning; a healthy head surfacing behind it drains in the same poll. The crashed
          // entry's commit, if any, still rides its landing ref into next-tick leftover
          // recovery (BUGS.md 2026-09-17).
          const stale = staleHeadFile(root);
          if (stale) {
            dropLanding(stale);
            logEvent(root, {
              loop: "harness",
              type: "warning",
              message: `land queue head ${path.basename(stale)} is unreadable (torn or foreign) — dropped so the queue can drain`,
            });
            head = headLanding(root);
          }
        }
        if (head) {
          if (await isMergedInto(root, head.entry.sha, mainBranch)) {
            dropLanding(head.file);
            // A crash between the 4/5 marker write and its removal can leave a marker with
            // no live landing — this branch runs only when the slot is free, so a marker
            // naming this entry is stale; clear it so the idle fleet reads clean. (Any
            // marker naming another entry cannot exist: that entry's landing would own the
            // slot, and this one is the queue head.)
            const marker = readLandingMarker(root);
            if (marker && marker.sha === head.entry.sha) removeQuiet(landingStatePath(root));
          } else {
            // Merge queue 5/5 — read the whole batch the slot will land: the queue head plus
            // up to landBatchMax-1 more entries in queue order. Length 1 IS today's single
            // path (the slice agrees with `head` — the only entry dropper is this arm's own
            // write-back, which runs while the slot is busy, and this arm runs only when it
            // is free); length >= 2 is the coalesced batch through landBatch.
            const batch = queuedLandingFiles(root).slice(0, liveConfig.landBatchMax);
            if (batch.length === 0) {
              // The head's file vanished between the two queue reads (no in-process writer
              // does that — defensive): nothing to land this poll.
            } else if (batch.length === 1) {
              // Resolve the authoring runner when it exists (runners are never removed from
              // the array on disable — only a warning event fires); a role disabled before
              // this process started has no runner, so a throwaway one supplies the same
              // wiring (loopPiOpts, runLandingPi, foldLandingUsage) and a disk-loaded state
              // to fold and save on. Both share the live config, like every runner.
              const author =
                runners.find((r) => r.role === head.entry.role) ??
                new LoopRunner(
                  root,
                  head.entry.role,
                  head.entry.role === DIRECTOR_ROLE ? liveConfig : roleConfig,
                  mainBranch,
                  signal,
                );
              const landing: InFlightLanding = {
                promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
                controller: new AbortController(),
                roles: [head.entry.role],
                userAborted: false,
              };
              // Harness shutdown aborts the landing through the per-landing controller (the
              // lander watches it); `tumwater abort --role` for this role aborts it too,
              // flagged userAborted — the two differ only in what happens to the pinned
              // ref after.
              signal.addEventListener("abort", () => landing.controller.abort(), { once: true });
              landing.promise = withLandingSlot(async () => {
                try {
                  await landQueuedEntry(root, head.entry, head.file, author, author.config, mainBranch, landing.controller.signal);
                } finally {
                  if (landing.userAborted) await discardPinnedRefs(root, landing.roles);
                  landingInFlight = null;
                }
              });
              landingInFlight = landing;
            } else {
              // The batch slot: land `batch` as ONE stack through the shared landBatch —
              // per-change review gates, one shared build check over the stacked tree, one
              // fast-forward. The 4/5 marker names the HEAD request (the cross-check needs
              // a queued entry to validate its sha against, and batch[0] stays queued until
              // the batch completes); the other batched roles show their queued state in the
              // queue itself. Per-role wiring is resolved exactly as the single path resolves
              // its author, and usage accumulates per role (a reviewer's run charges to its
              // change's authoring role, like landQueuedEntry).
              const first = batch[0]!;
              const landing: InFlightLanding = {
                promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
                controller: new AbortController(),
                roles: batch.map((b) => b.entry.role),
                userAborted: false,
              };
              // Harness shutdown aborts the batch through the per-landing controller (the
              // lander watches it); `tumwater abort --role` for ANY batched role aborts it
              // too, flagged userAborted — the two differ only in what happens to the
              // pinned refs after.
              signal.addEventListener("abort", () => landing.controller.abort(), { once: true });
              landing.promise = withLandingSlot(async () => {
                const startedAt = Date.now();
                writeJsonFile(landingStatePath(root), {
                  role: first.entry.role,
                  sha: first.entry.sha,
                  summary: first.entry.summary,
                  startedAt,
                });
                const authors = new Map(
                  batch.map((b) => [
                    b.entry.role,
                    runners.find((r) => r.role === b.entry.role) ??
                      new LoopRunner(
                        root,
                        b.entry.role,
                        b.entry.role === DIRECTOR_ROLE ? liveConfig : roleConfig,
                        mainBranch,
                        signal,
                      ),
                  ]),
                );
                const usages = new Map<string, { tokens: number; cost: number }>();
                try {
                  const outcomes = await landBatch(
                    { root, mainBranch, config: roleConfig, signal: () => landing.controller.signal },
                    batch.map((b) => ({
                      role: b.entry.role,
                      sha: b.entry.sha,
                      tick: b.entry.tick,
                      summary: b.entry.summary,
                      body: b.entry.body,
                      highFriction: b.entry.highFriction,
                    })),
                    (role) => {
                      const author = authors.get(role)!;
                      const { usage, foldUsage } = landingUsage(author);
                      usages.set(role, usage);
                      return {
                        state: author.state,
                        foldUsage,
                        runPi: (w, p, s) => author.runLandingPi(w, p, s),
                      };
                    },
                  );
                  // One slot unit landed: the batch's wall time is every change's
                  // durationMs, each change's event carries its own role's spend. A
                  // `result === undefined` means unattempted (an early stop ran before it)
                  // — its entry and ref stay queued, so the write-back skips it.
                  const durationMs = Date.now() - startedAt;
                  outcomes.forEach((outcome, i) => {
                    if (outcome.result === undefined) return;
                    const b = batch[i]!;
                    writeLandingOutcome(
                      root,
                      b.entry,
                      authors.get(b.entry.role)!.state,
                      outcome.result,
                      durationMs,
                      usages.get(b.entry.role) ?? { tokens: 0, cost: 0 },
                      b.file,
                    );
                  });
                } catch (err) {
                  // An unexpected throw escapes the batch (git plumbing — landBatch degrades
                  // failed LANDINGS to results): the 3/5 semantics keep EVERY entry for
                  // re-drain (none was dropped — the write-back runs after landBatch
                  // returns), with the error on the head role's state. Re-drain is bounded
                  // and self-terminating: the gate short-circuits the already-approved
                  // heads (its persisted verdict), and a fast-forward that already happened
                  // re-lands as no-ops through each change's own gate + in-lock check.
                  const author = authors.get(first.entry.role)!;
                  author.state.lastError = errorMessage(err);
                  saveLoopState(root, author.state);
                } finally {
                  removeQuiet(landingStatePath(root));
                  if (landing.userAborted) await discardPinnedRefs(root, landing.roles);
                  landingInFlight = null;
                }
              });
              landingInFlight = landing;
            }
          }
        }
      }

      // Backlog-aware deferral: while PLANS.md `## Planned` or BUGS.md `## Open` on main is
      // non-empty, idle maintenance ticks stay deferred — queued feature/bugfix work outranks
      // them regardless of what landed. Stat-cached reads (backlog.ts): one stat per file per
      // poll while the files are unchanged.
      const workBacklogOpen = plannedPlans(root).length > 0 || openBugs(root).length > 0;

      const reasons = new Map<LoopRunner, string | undefined>();
      for (const runner of runners) {
        if (holdForRestart) continue; // a restart is pending: nothing new starts, on any loop
        if ((gate === "paused" || userPaused) && runner.role !== DIRECTOR_ROLE)
          continue; // no new role ticks while either gate holds
        const { run, reason } = isEligible(runner, now, mainHead, inboxCount);
        if (!run) {
          // Not due this poll: any deferral episode has ended (or never started). No event —
          // the tick's own events cover it.
          if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false);
          continue;
        }
        // Merge queue 3/5 interlock (invariant 3): a role with a QUEUED or IN-FLIGHT landing
        // never starts a tick — the entry stays in the queue until its landing completes, so
        // one check covers both. Uniform over every role, director included: its prompt is not
        // finished until it lands. Placed before the need-based deferral block on purpose —
        // no episode bookkeeping is needed (a landing implies the last result is not
        // no_change, so no deferral episode can be open), and skipping here saves that branch's
        // workLandedSince git-range query for the skipped role.
        if (landingFor(root, runner.role).length > 0) continue;
        // Need-based deferral: a due maintenance tick (scheduled or main-moved wake) whose last
        // tick did nothing stays deferred while the feature/bugfix backlog is open or no new
        // work has landed to react to — nextRunAt is left untouched, so it re-checks every poll
        // until the backlog drains and qualifying work lands. Resume wakes precede this check in
        // isEligible, the director's "inbox" reason skips it, and work roles are not in
        // DEFERRABLE_ROLES. Sitting before reasons.set also keeps a deferred role out of the
        // wake-event pass below.
        if (reason === "scheduled" || reason === "main moved") {
          const s = runner.state;
          // The git range is only consulted when the other conditions already hold — a
          // never-ticked role or a tick with pending business runs without paying for it, and an
          // open backlog defers regardless of what landed.
          const landed =
            !workBacklogOpen && s.lastMainHead !== ""
              ? await workLandedSince(s.lastMainHead, mainHead)
              : true;
          const deferredNow = deferTick(s, runner.role, landed, workBacklogOpen, now);
          if (deferredNow !== (deferredDue.get(runner.role) ?? false)) {
            if (deferredNow)
              logEvent(root, { loop: runner.role, type: "tick_deferred" });
            deferredDue.set(runner.role, deferredNow);
          }
          if (deferredNow) continue;
        } else if (deferredDue.get(runner.role)) {
          deferredDue.set(runner.role, false); // an inbox/resume run ends the episode
        }
        reasons.set(runner, reason);
      }
      for (const runner of fairOrder([...reasons.keys()])) {
        if (signal.aborted) continue;
        const reason = reasons.get(runner);
        if (reason && reason !== "scheduled" && reason !== "startup") {
          logEvent(root, { loop: runner.role, type: "wake", reason });
        }
        runner.state.running = true; // Reserve before the semaphore wait so we don't double-schedule.
        // The director never queues behind role loops: a user prompt starts immediately,
        // even when maxConcurrent slots are busy. Parked waiters keep fairOrder's tier order
        // across polls too: a work-role arrival jumps ahead of maintenance ticks that queued
        // in an earlier poll (in-flight ticks always run to completion).
        const usesSlot = runner.role !== DIRECTOR_ROLE;
        // The tick's own run time (null when it never ran or was cut off): the drain-window
        // sample is taken only for a tick that finished on its own.
        let durationMs: number | null = null;
        const task = (async () => {
          durationMs = await runTimedRoleTick(
            signal,
            usesSlot ? () => semaphore.acquire(roleTier(runner.role)) : async () => {},
            usesSlot ? () => semaphore.release() : () => {},
            () => runner.tick(),
          );
        })();
        const bucket = runner.role === DIRECTOR_ROLE ? directorInFlight : roleInFlight;
        bucket.add(task);
        void task.finally(() => {
          bucket.delete(task);
          if (bucket === roleInFlight && durationMs !== null) {
            roleTickDurationsMs.push(durationMs);
            if (roleTickDurationsMs.length > ROLE_TICK_DURATION_SAMPLES) roleTickDurationsMs.shift();
          }
        });
      }

      await sleepInterruptible(pollMs, signal);
    }
  } finally {
    // The in-flight landing is awaited too: graceful shutdown waits for it, and a shutdown
    // abort reaches its pi runs through the harness signal — the landing then ends "aborted",
    // keeps its ref, and drops its entry for next-start recovery. (The landing is one
    // reviewer run plus a bounded merge, not a fleet-wide drain.)
    await Promise.allSettled(
      landingInFlight ? [...roleInFlight, ...directorInFlight, landingInFlight.promise] : [...roleInFlight, ...directorInFlight],
    );
    logEvent(root, { loop: "harness", type: "orchestrator_stop" });
    removeQuiet(infoFile);
  }
  return { restart };
}
