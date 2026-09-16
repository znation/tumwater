import fs from "node:fs";
import path from "node:path";
import type { LandingEntry, TickResult, TumwaterConfig } from "./types.js";
import type { OrchestratorInfo } from "./state.js";
import { enabledRoleIds, loadConfigCached } from "./config.js";
import {
  deferTick,
  dueForPrune,
  fairOrder,
  isEligible,
  workLanded,
} from "./scheduling.js";
import {
  budgetPaused,
  fleetDailyCost,
  isFleetPaused,
  readLandingMarker,
} from "./state.js";
import { applyLandingOutcome, saveLoopState } from "./state.js";
import { DIRECTOR_ROLE, roleTier } from "./roles.js";
import { openBugs, plannedPlans } from "./backlog.js";
import { LoopRunner } from "./loop.js";
import { branchHead, deleteRef, isMergedInto, subjectsBetween } from "./git.js";
import { landChange } from "./lander.js";
import { dropLanding, headLanding, landingFor } from "./land-queue.js";
import { logEvent } from "./events.js";
import { pruneOldFiles, removeQuiet } from "./files.js";
import { readJsonFile, writeJsonFile } from "./json-files.js";
import { inboxSize } from "./inbox.js";
import { Semaphore } from "./semaphore.js";
import {
  abortRequestPath,
  landingRefName,
  landingStatePath,
  orchestratorStatePath,
  resetRequestPath,
  wakeRequestPath,
  sessionsRootDir,
  STATE_DIR,
} from "./paths.js";
import { errorMessage } from "./text.js";
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

/** Read the optional `roles` request marker the `reset-counters` and `wake` CLI commands drop
 * (both share the convention): null when no marker exists (nothing to consume this poll), the
 * listed roles' runners when the marker is a well-formed string array, and every runner when
 * the marker is corrupt or its list missing (a superset — both operations are idempotent, so
 * applying the same one to extra roles is safe). */
function roleRequestTargets(markerFile: string, runners: LoopRunner[]): LoopRunner[] | null {
  if (!fs.existsSync(markerFile)) return null;
  const marker = readJsonFile<{ roles?: unknown }>(markerFile);
  const requested =
    marker && Array.isArray(marker.roles) && marker.roles.every((r) => typeof r === "string")
      ? (marker.roles as string[])
      : null;
  return requested ? runners.filter((r) => requested.includes(r.role)) : [...runners];
}

/** Consume a pending reset request from `tumwater reset-counters`, if any: the CLI already
 * zeroed the state files; this also zeroes the affected runners' in-memory copies (which then
 * re-save), or their next tick's save would resurrect the pre-reset values. */
function consumeResetRequest(root: string, runners: LoopRunner[]): void {
  const markerFile = resetRequestPath(root);
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
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

/** Consume a pending wake request from `tumwater wake [--role <id>]`, if any: the CLI
 * already cleared the state files; this also clears the affected runners' in-memory
 * schedules (backoffSeconds, nextRunAt), or their next save would resurrect the pre-wake
 * sleep window and the loops would keep sleeping until the original backoff expired. Each
 * woken role logs the existing `wake` event with the operator reason, so the fleet's
 * early ticks read in the feed as deliberate. */
function consumeWakeRequest(root: string, runners: LoopRunner[]): void {
  const markerFile = wakeRequestPath(root);
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
  for (const r of affected) {
    r.wake();
    logEvent(root, { loop: r.role, type: "wake", reason: "operator" });
  }
  removeQuiet(markerFile);
}

/** Consume per-role abort requests from `tumwater abort --role <id>`: one marker file per
 * role (no parsing needed), so a request for an idle OR disabled loop is still cleaned up. A
 * running tick gets killed and logs exactly one event; anything else is a silent no-op — the
 * marker's presence IS the request, removing it acknowledges. Since merge queue 3/5 a role's
 * in-flight work is often a LANDING rather than a tick, so the landing's controller is passed
 * in: an abort for the role landing right now kills that too (the drain's task sees
 * `userAborted` and discards the pinned ref when the landing ends). */
function consumeAbortRequests(
  root: string,
  runners: LoopRunner[],
  landing: Omit<InFlightLanding, "promise"> | null,
): void {
  try {
    const markers = fs.readdirSync(path.join(root, STATE_DIR));
    for (const name of markers) {
      const m = /^abort-(.+)\.json$/.exec(name);
      if (!m) continue;
      const role = m[1]!;
      const runner = runners.find((r) => r.role === role);
      if (landing && landing.role === role) {
        landing.userAborted = true;
        landing.controller.abort();
      }
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

/** Land one queued entry end-to-end — the poll loop's single landing slot, exported so the
 * loop-level tests can drive one landing without standing up the whole orchestrator (the drain
 * calls it exactly once per queue head, per poll): run the pinned sha through the shared
 * lander (review gate, rebase, ff-merge) with the authoring runner's wiring — its live state
 * object, runLandingPi (harness-shutdown signal only), foldLandingUsage (reviewer and
 * conflict-resolution spend charge to the AUTHORING role) — then fold the outcome into that
 * state (applyLandingOutcome), save it, log landed/land_failed with the landing's own
 * duration and usage, and drop the entry: EVERY outcome drops. Non-terminal outcomes keep
 * the landing ref, so the retry is the role's next fresh tick through leftover recovery —
 * normal cadence, same gate, same strike cap — never a queue re-drain. Never rejects:
 * landChange already degrades its own failures to TickResult values; an unexpected throw
 * lands as an "error" outcome (the ref survives for next-tick recovery). */
export async function landQueuedEntry(
  root: string,
  entry: LandingEntry,
  file: string,
  author: LoopRunner,
  config: TumwaterConfig,
  mainBranch: string,
  signal: AbortSignal,
): Promise<TickResult> {
  const startedAt = Date.now();
  // Merge queue 4/5 — publish the in-flight marker the observers read (snapshot cross-checks
  // it with a matching queue entry and the orchestrator's liveness): written before the
  // landing runs, removed on EVERY outcome below (the catch-all turns even an unexpected
  // throw into an outcome, so the removal always runs). A crash in between leaves a stale
  // marker that the cross-check self-heals — no cleanup pass needed.
  writeJsonFile(landingStatePath(root), {
    role: entry.role,
    sha: entry.sha,
    summary: entry.summary,
    startedAt,
  });
  const usage = { tokens: 0, cost: 0 };
  let result: TickResult;
  try {
    result = await landChange(
      {
        root,
        mainBranch,
        config,
        state: author.state,
        runPi: (w, p, s) => author.runLandingPi(w, p, s),
        foldUsage: (run) => {
          author.foldLandingUsage(run);
          usage.tokens += run.outputTokens;
          usage.cost += run.costUsd;
        },
        signal: () => signal,
      },
      {
        role: entry.role,
        sha: entry.sha,
        tick: entry.tick,
        summary: entry.summary,
        body: entry.body,
        highFriction: entry.highFriction,
      },
    );
  } catch (err) {
    result = "error";
    author.state.lastError = errorMessage(err);
  }
  applyLandingOutcome(author.state, result);
  saveLoopState(root, author.state);
  // `merged` still fires from merge.ts itself — these events mark the QUEUE's bookkeeping:
  // the slot picked the entry up (land_queued, logged at enqueue) and finished with or
  // without landing. The usage fields are the landing's own spend (reviewer + conflict
  // resolution), omitted when zero so review-exempt landings render bare.
  logEvent(root, {
    loop: entry.role,
    type: result === "changed" ? "landed" : "land_failed",
    commit: entry.sha,
    result,
    durationMs: Date.now() - startedAt,
    ...(usage.tokens > 0 ? { tokens: usage.tokens } : {}),
    ...(usage.cost > 0 ? { costUsd: usage.cost } : {}),
  });
  dropLanding(root, file);
  // The outcome is fully applied (state saved, event logged, entry dropped): clear the 4/5
  // marker. Between the drop and this removal a poll may briefly see depth 0 with no
  // inFlight — the landing is done, so nothing is misdisplayed.
  removeQuiet(landingStatePath(root));
  return result;
}

/** The single in-flight landing the drain owns (merge queue 3/5): its task, the controller
 * that aborts it (harness shutdown OR `tumwater abort --role`), and whether the abort was a
 * deliberate user stop — which decides what happens to the pinned ref when it ends. */
interface InFlightLanding {
  promise: Promise<void>;
  controller: AbortController;
  role: string;
  userAborted: boolean;
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
  // self-redeploy (BUGS.md 2026-09-08). The landing slot is deliberately OUTSIDE this split:
  // it is a single in-process task (no semaphore, one at a time) that graceful shutdown still
  // awaits — an aborted landing keeps its ref and drops its entry, recovering on next start.
  const roleInFlight = new Set<Promise<void>>();
  const directorInFlight = new Set<Promise<void>>();
  let landingInFlight: InFlightLanding | null = null;
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
        const head = headLanding(root);
        if (head) {
          if (await isMergedInto(root, head.entry.sha, mainBranch)) {
            dropLanding(root, head.file);
            // A crash between the 4/5 marker write and its removal can leave a marker with
            // no live landing — this branch runs only when the slot is free, so a marker
            // naming this entry is stale; clear it so the idle fleet reads clean. (Any
            // marker naming another entry cannot exist: that entry's landing would own the
            // slot, and this one is the queue head.)
            const marker = readLandingMarker(root);
            if (marker && marker.sha === head.entry.sha) removeQuiet(landingStatePath(root));
          } else {
            // Resolve the authoring runner when it exists (runners are never removed from the
            // array on disable — only a warning event fires); a role disabled before this
            // process started has no runner, so a throwaway one supplies the same wiring
            // (loopPiOpts, runLandingPi, foldLandingUsage) and a disk-loaded state to fold and
            // save on. Both share the live config, like every runner.
            const author =
              runners.find((r) => r.role === head.entry.role) ??
              new LoopRunner(root, head.entry.role, config, mainBranch, signal);
            const landing: InFlightLanding = {
              promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
              controller: new AbortController(),
              role: head.entry.role,
              userAborted: false,
            };
            // Harness shutdown aborts the landing through the per-landing controller (the
            // lander watches it); `tumwater abort --role` for this role aborts it too, flagged
            // userAborted — the two differ only in what happens to the pinned ref after.
            signal.addEventListener("abort", () => landing.controller.abort(), { once: true });
            landing.promise = (async () => {
              try {
                await landQueuedEntry(root, head.entry, head.file, author, config, mainBranch, landing.controller.signal);
              } finally {
                if (landing.userAborted) {
                  // A deliberate stop discards the pinned work — the landing's counterpart to
                  // the pre-3/5 mid-review user abort (loop.ts's `this.userAborted` branch);
                  // a shutdown abort leaves the flag unset and the ref survives for recovery.
                  try {
                    await deleteRef(root, landingRefName(landing.role));
                  } catch {
                    /* already gone */
                  }
                }
                landingInFlight = null;
              }
            })();
            landingInFlight = landing;
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
        if ((budgetPausedNow || userPaused) && runner.role !== DIRECTOR_ROLE)
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
          const deferredNow = deferTick(s, runner.role, landed, workBacklogOpen);
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
        const task = (async () => {
          if (usesSlot) await semaphore.acquire(roleTier(runner.role));
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
