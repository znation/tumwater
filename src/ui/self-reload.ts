import { spawn } from "node:child_process";
import { type BuildInfo, isSelfHosted, readBuildInfo } from "../build-info.js";

/** Auto-reload for the user-launched dashboards (`tumwater tui`, `tumwater gui`).
 *
 * Unlike the orchestrator — which the supervisor respawns onto a fresh build — a dashboard is
 * started by hand and, without this, keeps serving its startup code until the operator
 * restarts it. When the fleet redeploys itself (redeploy.ts swaps `dist/`) the TUI keeps
 * rendering old modules and the GUI keeps serving old page JS. This module watches for a
 * newer compiled tree on disk and re-execs the same command once, so both surfaces come back
 * on the new code within a poll.
 *
 * The in-memory startup stamp is the only correct reference for "am I stale": after a redeploy
 * swap the on-disk stamp already reads as fresh and the new orchestrator's BuildStatus flips
 * `stale: false` — both would tell an old UI process it is fine while it still executes old
 * modules. */

/** The process's own build stamp, captured exactly once at startup. */
export function captureStartupBuild(): BuildInfo | null {
  return readBuildInfo();
}

/** True when both stamps exist and the on-disk stamp names a different commit than the
 * process's startup stamp — a newer compiled tree is available and re-exec will load it.
 * Deliberately not git-based: while main is merely ahead with no new dist yet (restart
 * pending, blocked, or inside the cooldown) there is nothing to reload onto, and the STALE
 * header already covers that state. */
export function shouldReload(startup: BuildInfo | null, disk: BuildInfo | null): boolean {
  return startup !== null && disk !== null && disk.sha !== startup.sha;
}

/** The minimal child surface reexecSelf needs — injectable so tests assert the spawn without
 * launching a process. */
export interface ReloadChild {
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** A spawner returning a ReloadChild; `node:child_process.spawn` satisfies it. */
export type ReloadSpawn = (
  command: string,
  args: string[],
  options: { stdio: "inherit" },
) => ReloadChild;

/** Replace this process with a fresh copy of itself (`process.argv.slice(1)` re-runs the same
 * CLI entry point, e.g. `dist/src/cli.js tui`) and exit with the child's code. A child that
 * cannot start or exits non-zero surfaces as this process's exit code; the operator re-runs
 * manually. TUI/GUI are user-launched, not supervisor children, so RESTART_EXIT_CODE is never
 * involved. */
export function reexecSelf(spawnImpl: ReloadSpawn = spawn): void {
  const child = spawnImpl(process.execPath, process.argv.slice(1), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", () => process.exit(1));
}

/** Everything createReloadWatch needs; all seams injectable so tests need no real timers, git,
 * or dist. `readDisk` defaults to this process's own dist (`readBuildInfo`), which a redeploy
 * swap or a manual `npm run build` replaces in place. */
interface ReloadWatchOptions {
  root: string;
  startupInfo: BuildInfo | null;
  readDisk?: () => BuildInfo | null;
  isSelfHostedImpl?: (root: string, info: BuildInfo) => Promise<boolean>;
  intervalMs?: number;
  onTrigger: () => void;
}

interface ReloadWatch {
  /** Resolves once the one-time gate settles: a stampless startup or a non-self-hosted install
   * never starts the interval (and `stop` is then a no-op); only a self-hosted process polls. */
  start(): Promise<void>;
  stop(): void;
}

/** Watch for a newer compiled tree on disk and fire `onTrigger` at most once. The gate: null
 * `startupInfo` ⇒ never reload (checked before `isSelfHosted`, which takes a non-null
 * BuildInfo); not self-hosted ⇒ never reload. Only then does the interval re-read the disk
 * stamp and call `onTrigger` when `shouldReload` holds. */
export function createReloadWatch(opts: ReloadWatchOptions): ReloadWatch {
  const {
    root,
    startupInfo,
    readDisk = () => readBuildInfo(),
    isSelfHostedImpl = isSelfHosted,
    intervalMs = 1000,
    onTrigger,
  } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let fired = false;

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function check(): void {
    if (stopped || fired) return;
    if (!shouldReload(startupInfo, readDisk())) return;
    fired = true;
    stop();
    onTrigger();
  }

  return {
    async start(): Promise<void> {
      if (startupInfo === null) return;
      if (!(await isSelfHostedImpl(root, startupInfo))) return;
      if (stopped || fired) return;
      timer = setInterval(check, intervalMs);
    },
    stop,
  };
}
