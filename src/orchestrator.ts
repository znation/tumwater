import fs from "node:fs";
import path from "node:path";
import type { TumwaterConfig } from "./types.js";
import { enabledRoleIds, loadConfigSafe } from "./config.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { LoopRunner } from "./loop.js";
import { gitTry, readBranchHead } from "./git.js";
import { logEvent } from "./events.js";
import { pruneOldFiles, readJsonFile } from "./files.js";
import { inboxSize } from "./inbox.js";
import { Semaphore } from "./semaphore.js";
import { orchestratorStatePath, resetRequestPath, sessionsRootDir } from "./paths.js";

const POLL_MS = 2000;

export interface OrchestratorInfo {
  pid: number;
  startedAt: number;
  roles: string[];
}

/** Read the running orchestrator's info file; null when it is missing or unreadable.
 * Never throws — a torn write (e.g. a crash mid-write) must not take down observers
 * that poll this every second (TUI, GUI, status). */
export function readOrchestratorInfo(root: string): OrchestratorInfo | null {
  return readJsonFile<OrchestratorInfo>(orchestratorStatePath(root));
}

/** True when the recorded orchestrator's pid is still alive (signal-0 probe). */
export function orchestratorAlive(root: string): boolean {
  const info = readOrchestratorInfo(root);
  if (!info) return false;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RunOptions {
  root: string;
  config: TumwaterConfig;
  mainBranch: string;
  signal: AbortSignal;
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

  const minGap = runner.config.minTickIntervalSeconds * 1000;
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
 * the user's prompts), then least-recently-ticked first, so loops alternate instead of the
 * same ones re-claiming freed slots. Never-run loops tie at zero and the stable sort keeps
 * them in role-catalog (priority) order. */
export function fairOrder(runners: LoopRunner[]): LoopRunner[] {
  return [...runners].sort((a, b) => {
    if ((a.role === DIRECTOR_ROLE) !== (b.role === DIRECTOR_ROLE)) {
      return a.role === DIRECTOR_ROLE ? -1 : 1;
    }
    return (a.state.lastTickEndedAt ?? 0) - (b.state.lastTickEndedAt ?? 0);
  });
}

/** Run all enabled loops until the signal aborts. */
export async function runOrchestrator(opts: RunOptions): Promise<void> {
  const { root, config, mainBranch, signal } = opts;
  const enabled = enabledRoleIds(config);
  if (enabled.length === 0) throw new Error("no roles enabled in tumwater.json");

  let runners = enabled.map((role) => new LoopRunner(root, role, config, mainBranch, signal));
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrent));

  const infoFile = orchestratorStatePath(root);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: enabled };
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2));
  logEvent(root, { loop: "harness", type: "orchestrator_start", pid: process.pid, roles: enabled });

  const pruned = pruneOldFiles(sessionsRootDir(root), config.sessionRetentionDays);
  if (pruned > 0) {
    logEvent(root, { loop: "harness", type: "warning", message: `pruned ${pruned} old pi session file(s)` });
  }

  const inFlight = new Set<Promise<void>>();
  // Live-reload bookkeeping: the last config error already warned about (a broken file must
  // warn once per distinct text, not every poll), and the previous cycle's enabled set (for
  // one-shot enable/disable transition warnings).
  let lastConfigError: string | null = null;
  let prevEnabled = new Set<string>(enabled);

  try {
    while (!signal.aborted) {
      // Live-reload tumwater.json — the single reload point shared by all loops. A broken
      // file keeps the last-known-good config and warns once per distinct error text.
      const reloaded = loadConfigSafe(root);
      if (reloaded.config) {
        for (const r of runners) r.config = reloaded.config;
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

      // Consume a reset request from `tumwater reset-counters`: the CLI already zeroed the
      // state files; here we also zero the affected runners' in-memory copies and re-save,
      // or their next tick's save would resurrect the pre-reset values. A corrupt marker
      // resets every runner (a superset — the operation is idempotent).
      const markerFile = resetRequestPath(root);
      if (fs.existsSync(markerFile)) {
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
        try {
          fs.rmSync(markerFile);
        } catch {
          // Best-effort cleanup.
        }
      }

      // Reading the ref file is microsecond-scale; spawning `git rev-parse` costs ~10ms and
      // this runs every poll. The spawn fallback covers what file reads cannot (a worktree-
      // pointer .git, anything unusual).
      const mainHead = readBranchHead(root, mainBranch) ?? (await gitTry(root, "rev-parse", mainBranch)) ?? "";
      const inboxCount = inboxSize(root);
      const now = Date.now();

      const reasons = new Map<LoopRunner, string | undefined>();
      for (const runner of runners) {
        const { run, reason } = isEligible(runner, now, mainHead, inboxCount);
        if (run) reasons.set(runner, reason);
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
        inFlight.add(task);
        void task.finally(() => inFlight.delete(task));
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    await Promise.allSettled([...inFlight]);
    logEvent(root, { loop: "harness", type: "orchestrator_stop" });
    try {
      fs.rmSync(infoFile);
    } catch {
      // Best-effort cleanup.
    }
  }
}
