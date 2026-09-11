import fs from "node:fs";
import path from "node:path";
import type { LoopState, TumwaterConfig } from "./types.js";
import type { OrchestratorInfo } from "./state.js";
import { configForRole, enabledRoleIds, loadConfigCached } from "./config.js";
import { budgetPaused, fleetDailyCost, isFleetPaused } from "./state.js";
import { DEFERRABLE_ROLES, DIRECTOR_ROLE, roleTier } from "./roles.js";
import { LoopRunner } from "./loop.js";
import { branchHead, subjectsBetween } from "./git.js";
import { logEvent } from "./events.js";
import { pruneOldFiles, removeQuiet } from "./files.js";
import { readJsonFile, writeJsonFile } from "./json-files.js";
import { inboxSize } from "./inbox.js";
import { Semaphore } from "./semaphore.js";
import { abortRequestPath, orchestratorStatePath, resetRequestPath, sessionsRootDir, STATE_DIR } from "./paths.js";
import type { Redeployer } from "./redeploy.js";

const POLL_MS = 2000;

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
}

/** How runOrchestrator ended: `restart` means dist/ now holds a newer build and the caller should
 * exit RESTART_EXIT_CODE so the supervisor respawns onto it; otherwise the stop signal fired. */
interface OrchestratorExit {
  restart: boolean;
}

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

/** Should a due maintenance tick be deferred? (Need-based prioritization.) All four must hold:
 * the role is one of the nine deferrable built-ins — work roles and unknown/custom never defer,
 * the harness cannot judge what an arbitrary custom role needs; its last tick did nothing;
 * it has seen main before (a never-ticked role always runs its first tick); and no feature/
 * bugfix/director/human commit landed since that head. Only `no_change` defers: every other
 * outcome carries pending business (retry an error, address recorded review-rejection reasons,
 * recover a merge failure) that must not stall until unrelated work lands.
 */
export function deferTick(s: LoopState, role: string, workLandedSinceLast: boolean): boolean {
  return (
    DEFERRABLE_ROLES.has(role) && s.lastResult === "no_change" && s.lastMainHead !== "" && !workLandedSinceLast
  );
}

/** Is a once-per-day session prune due? Due when retention is enabled (> 0) and a full day
 * has passed since the last prune (or no prune has run yet). */
export function dueForPrune(lastPruneAt: number | null, now: number, retentionDays: number): boolean {
  if (retentionDays <= 0) return false; // 0 disables pruning — never due.
  if (lastPruneAt === null) return true; // Never pruned yet — due immediately.
  return now - lastPruneAt >= 24 * 3600 * 1000;
}

/** Consume a pending reset request from `tumwater reset-counters`, if any: the CLI already
 * zeroed the state files; this also zeroes the affected runners' in-memory copies (which then
 * re-save), or their next tick's save would resurrect the pre-reset values. A corrupt marker
 * resets every runner (a superset — the operation is idempotent). */
function consumeResetRequest(root: string, runners: LoopRunner[]): void {
  const markerFile = resetRequestPath(root);
  if (!fs.existsSync(markerFile)) return;
  let requested: string[] | null = null;
  const marker = readJsonFile<{ roles?: unknown }>(markerFile);
  if (marker && Array.isArray(marker.roles) && marker.roles.every((r) => typeof r === "string"))
    requested = marker.roles as string[];
  // Corrupt or missing marker: fall through and reset every runner below.
  const affected = requested ? runners.filter((r) => requested.includes(r.role)) : [...runners];
  for (const r of affected) r.resetCounters();
  if (affected.length > 0) {
    const [only] = affected;
    // One role → filed under that loop; several → one harness-level event listing them.
    if (affected.length === 1 && only) logEvent(root, { loop: only.role, type: "counters_reset" });
    else
      logEvent(root, {
        loop: "harness",
        type: "counters_reset",
        roles: affected.map((r) => r.role),
      });
  }
  removeQuiet(markerFile);
}

/** Consume per-role abort requests from `tumwater abort --role <id>`: one marker file per
 * role (no parsing needed), so a request for an idle OR disabled loop is still cleaned up. A
 * running tick gets killed and logs exactly one event; anything else is a silent no-op — the
 * marker's presence IS the request, removing it acknowledges. */
function consumeAbortRequests(root: string, runners: LoopRunner[]): void {
  try {
    const markers = fs.readdirSync(path.join(root, STATE_DIR));
    for (const name of markers) {
      const m = /^abort-(.+)\.json$/.exec(name);
      if (!m) continue;
      const role = m[1]!;
      const runner = runners.find((r) => r.role === role);
      if (runner?.state.running) {
        runner.abortTick();
        logEvent(root, { loop: role, type: "tick_aborted" });
      }
      removeQuiet(abortRequestPath(root, role));
    }
  } catch {
    // .tumwater/ missing — nothing to consume (a fresh repo before the first tick).
  }
}

/** Run all enabled loops until the signal aborts — or until a pending self-redeploy has drained
 * the fleet and swapped the new build into dist/ (then `restart` is true). */
export async function runOrchestrator(opts: RunOptions): Promise<OrchestratorExit> {
  const { root, config, mainBranch, signal: externalSignal } = opts;
  const pollMs = opts.pollMs ?? POLL_MS;
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
  // self-redeploy (BUGS.md 2026-09-08).
  const roleInFlight = new Set<Promise<void>>();
  const directorInFlight = new Set<Promise<void>>();
  // Live-reload bookkeeping: the last config error already warned about (a broken file must
  // warn once per distinct text, not every poll), and the previous cycle's enabled set (for
  // one-shot enable/disable transition warnings).
  let lastConfigError: string | null = null;
  let prevEnabled = new Set<string>(enabled);
  // The previous poll's budget-paused state, for one-shot pause/resume transition events.
  let prevBudgetPaused = false;
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

  // Need-based deferral (PLANS.md "Prioritize loops by need"): TRUE work-landed verdicts are
  // cached per base head — a true verdict is monotone under fast-forward-only main movement, so
  // it never needs re-evaluation; falses re-check each poll at one local `git log` per due
  // deferred role (main advancing can flip them). Bounded, so a long-running fleet cannot grow
  // the set unbounded.
  const workLandedHeads = new Set<string>();
  async function workLandedSince(sinceHead: string): Promise<boolean> {
    if (workLandedHeads.has(sinceHead)) return true;
    const subjects = await subjectsBetween(root, sinceHead, mainBranch);
    // A range that cannot be evaluated is treated as work landed — conservative: run the tick.
    const verdict = subjects === null ? true : workLanded(subjects);
    if (verdict) {
      if (workLandedHeads.size >= 200) workLandedHeads.clear();
      workLandedHeads.add(sinceHead);
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
      const retention = (runners[0]?.config ?? config).sessionRetentionDays;
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

      // Consume CLI request markers: a reset-counters request and per-role abort requests.
      consumeResetRequest(root, runners);
      consumeAbortRequests(root, runners);

      // branchHead reads the ref files first (microsecond-scale; this runs every poll) and
      // spawns `git rev-parse` only when they cannot resolve it. "" means main does not exist
      // yet — isEligible treats an empty head as "no wake".
      const mainHead = (await branchHead(root, mainBranch)) ?? "";
      const inboxCount = inboxSize(root);
      const now = Date.now();

      // Daily cost budget gate (plans/daily-cost-budget.md): while the fleet's spend for the
      // local day has reached maxDailyCostUsd, role loops start no new ticks — scheduled,
      // main-moved wake, or startup. The director is exempt: an explicit human prompt outranks
      // the autonomous-spend cap. In-flight ticks finish; only NEW ticks are blocked. Resume is
      // live and stateless — raising/disabling the cap (live-reloaded above) or crossing local
      // midnight flips this on the next poll, so nothing can get stuck. All runners share one
      // config object (the initial one until a reload replaces it), so any runner's copy is
      // the live config.
      const states = runners.map((r) => r.state);
      const budgetPausedNow = budgetPaused(states, runners[0]?.config ?? config, now);
      if (budgetPausedNow !== prevBudgetPaused) {
        logEvent(root, {
          loop: "harness",
          type: budgetPausedNow ? "budget_paused" : "budget_resumed",
          spentUsd: fleetDailyCost(states, now),
          capUsd: (runners[0]?.config ?? config).maxDailyCostUsd,
        });
        prevBudgetPaused = budgetPausedNow;
      }

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
          { roleInFlight: roleInFlight.size, directorInFlight: directorInFlight.size },
          (runners[0]?.config ?? config).autoRestart,
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

      const reasons = new Map<LoopRunner, string | undefined>();
      for (const runner of runners) {
        if (holdForRestart) continue; // a restart is pending: nothing new starts, on any loop
        if ((budgetPausedNow || userPaused) && runner.role !== DIRECTOR_ROLE)
          continue; // no new role ticks while either gate holds
        const { run, reason } = isEligible(runner, now, mainHead, inboxCount);
        if (!run) {
          // Not due this poll: any deferral episode has ended (or never started). No event —
          // the tick's own events cover it.
          if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false);
          continue;
        }
        // Need-based deferral: a due maintenance tick (scheduled or main-moved wake) whose last
        // tick did nothing and has no new work to react to stays deferred — nextRunAt is left
        // untouched, so it re-checks every poll until qualifying work lands. Resume wakes
        // precede this check in isEligible, the director's "inbox" reason skips it, and work
        // roles are not in DEFERRABLE_ROLES. Sitting before reasons.set also keeps a deferred
        // role out of the wake-event pass below.
        if (reason === "scheduled" || reason === "main moved") {
          const s = runner.state;
          // The git range is only consulted when the other three conditions already hold — a
          // never-ticked role or a tick with pending business runs without paying for it.
          const landed = s.lastMainHead !== "" ? await workLandedSince(s.lastMainHead) : true;
          const deferredNow = deferTick(s, runner.role, landed);
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
        // even when maxConcurrent slots are busy.
        const usesSlot = runner.role !== DIRECTOR_ROLE;
        const task = (async () => {
          if (usesSlot) await semaphore.acquire();
          try {
            if (signal.aborted) return;
            await runner.tick();
          } finally {
            if (usesSlot) semaphore.release();
          }
        })();
        const bucket = runner.role === DIRECTOR_ROLE ? directorInFlight : roleInFlight;
        bucket.add(task);
        void task.finally(() => bucket.delete(task));
      }

      await sleepInterruptible(pollMs, signal);
    }
  } finally {
    await Promise.allSettled([...roleInFlight, ...directorInFlight]);
    logEvent(root, { loop: "harness", type: "orchestrator_stop" });
    removeQuiet(infoFile);
  }
  return { restart };
}
