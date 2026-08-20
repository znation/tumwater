import fs from "node:fs";
import path from "node:path";
import type { AutomatonConfig } from "./types.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { LoopRunner } from "./loop.js";
import { gitTry } from "./git.js";
import { logEvent } from "./events.js";
import { inboxSize } from "./inbox.js";
import { orchestratorStatePath } from "./paths.js";

const POLL_MS = 2000;

/** Simple counting semaphore bounding concurrent pi runs. */
export class Semaphore {
  private waiters: Array<() => void> = [];
  constructor(private available: number) {}

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}

export interface OrchestratorInfo {
  pid: number;
  startedAt: number;
  roles: string[];
}

export function readOrchestratorInfo(root: string): OrchestratorInfo | null {
  const file = orchestratorStatePath(root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as OrchestratorInfo;
  } catch {
    return null;
  }
}

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
  config: AutomatonConfig;
  mainBranch: string;
  /** Called after every scheduling decision worth narrating (for headless output). */
  onEvent?: (line: string) => void;
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
  const minGap = runner.config.minTickIntervalSeconds * 1000;
  const sinceLast = now - (s.lastTickEndedAt ?? 0);
  if (s.running) return { run: false };
  if (sinceLast < minGap) return { run: false };

  if (runner.role === DIRECTOR_ROLE) {
    return inboxCount > 0 ? { run: true, reason: "inbox" } : { run: false };
  }
  if (now >= s.nextRunAt) {
    return { run: true, reason: s.ticks === 0 ? "startup" : "scheduled" };
  }
  // The world changed under a sleeping loop: main moved since its last tick.
  if (s.lastMainHead && mainHead && mainHead !== s.lastMainHead) {
    return { run: true, reason: "main moved" };
  }
  return { run: false };
}

/** Run all enabled loops until the signal aborts. */
export async function runOrchestrator(opts: RunOptions): Promise<void> {
  const { root, config, mainBranch, signal } = opts;
  const enabled = Object.entries(config.roles)
    .filter(([, rc]) => rc.enabled)
    .map(([id]) => id);
  if (enabled.length === 0) throw new Error("no roles enabled in automaton.json");

  const runners = enabled.map((role) => new LoopRunner(root, role, config, mainBranch, signal));
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrent));

  const infoFile = orchestratorStatePath(root);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: enabled };
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2));
  logEvent(root, { loop: "harness", type: "orchestrator_start", pid: process.pid, roles: enabled });

  const inFlight = new Set<Promise<void>>();

  try {
    while (!signal.aborted) {
      const mainHead = (await gitTry(root, "rev-parse", mainBranch)) ?? "";
      const inboxCount = inboxSize(root);
      const now = Date.now();

      for (const runner of runners) {
        const { run, reason } = isEligible(runner, now, mainHead, inboxCount);
        if (!run || signal.aborted) continue;
        if (reason && reason !== "scheduled" && reason !== "startup") {
          logEvent(root, { loop: runner.role, type: "wake", reason });
        }
        runner.state.running = true; // Reserve before the semaphore wait so we don't double-schedule.
        const task = (async () => {
          await semaphore.acquire();
          try {
            if (signal.aborted) return;
            const outcome = await runner.tick();
            opts.onEvent?.(`${runner.role}: ${outcome.result}${outcome.summary ? ` — ${outcome.summary}` : ""}`);
          } finally {
            semaphore.release();
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
