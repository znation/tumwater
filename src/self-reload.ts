import { spawn } from "node:child_process";
import path from "node:path";
import { type BuildInfo, isSelfHosted, readBuildInfo } from "./build-info.js";
import { RESTART_EXIT_CODE } from "./redeploy-policy.js";

/** Auto-reload for the user-launched dashboards (`tumwater tui`, `tumwater gui`).
 *
 * Unlike the orchestrator — which the supervisor respawns onto a fresh build — a dashboard is
 * started by hand and, without this, keeps serving its startup code until the operator
 * restarts it. When the fleet redeploys itself (redeploy.ts swaps `dist/`) the TUI keeps
 * rendering old modules and the GUI keeps serving old page JS. This module watches for a
 * newer compiled tree on disk and hands itself to a fresh copy of the same command (a supervised
 * respawn, not a nested wrapper), so both surfaces come back on the new code within a poll.
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
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
) => ReloadChild;

/** Marks a dashboard process as the reload supervisor's child: on its own reload trigger it
 * exits RESTART_EXIT_CODE instead of spawning a grandchild, so the supervisor can respawn a
 * sibling and the chain stays two deep however many redeploys land (BUGS.md 2026-09-30). */
export const DASHBOARD_CHILD_ENV = "TUMWATER_DASHBOARD_CHILD";

/** Hand this process's dashboard duty to a fresh copy of itself (`process.argv.slice(1)` re-runs
 * the same CLI entry point, e.g. `dist/src/cli.js tui`) and stay alive as its thin supervisor,
 * respawning a sibling each time the child exits RESTART_EXIT_CODE — the run supervisor's shape.
 * Node has no exec(), so spawning a child and waiting would leave this process as a wrapper on
 * the chain, and the child (which arms the same watch) would wrap another on its own reload:
 * one idle process per redeploy, for the life of the dashboard. A child that exits with anything
 * else, cannot start, or dies by signal ends the dashboard with that code; the operator re-runs
 * manually. */
export function reexecSelf(spawnImpl: ReloadSpawn = spawn): void {
  // A supervised child must not nest: it asks its supervisor for a fresh generation instead.
  if (process.env[DASHBOARD_CHILD_ENV] !== undefined) process.exit(RESTART_EXIT_CODE);
  const options = {
    stdio: "inherit" as const,
    env: { ...process.env, [DASHBOARD_CHILD_ENV]: "1" },
  };
  const startChild = (): ReloadChild => spawnImpl(process.execPath, process.argv.slice(1), options);
  const supervise = (): void => {
    const child = startChild();
    child.on("exit", (code) => {
      // The child closed its own server/terminal before asking; a sibling picks up on the new
      // build with the port (or tty) free.
      if (code === RESTART_EXIT_CODE) supervise();
      else process.exit(code ?? 1);
    });
    child.on("error", () => process.exit(1));
  };
  supervise();
}

/** Everything createReloadWatch needs; all seams injectable so tests need no real timers, git,
 * or dist. `readDisk` defaults to this process's own dist (`readBuildInfo`), which a redeploy
 * swap or a manual `npm run build` replaces in place. `isSelfHostedImpl` answers both of the
 * watch's provenance questions: is the startup build this checkout's own, and does a changed
 * disk stamp name a real commit of it. */
interface ReloadWatchOptions {
  root: string;
  startupInfo: BuildInfo | null;
  readDisk?: () => BuildInfo | null;
  isSelfHostedImpl?: (root: string, info: BuildInfo) => Promise<boolean>;
  intervalMs?: number;
  onTrigger: () => void;
}

interface ReloadWatch {
  /** Resolves once the one-time gate settles: a stampless startup or a build compiled from
   * another root never starts the interval (and `stop` is then a no-op); only this checkout's
   * own build polls. */
  start(): Promise<void>;
  stop(): void;
}

/** The watch's injectable seams, re-exported as one type: a dashboard embedding the watch
 * (gui.ts's startGui) accepts them plus its own re-exec seam so tests can drive the wiring
 * without real timers, dist stamps, or spawned processes. */
export type ReloadWatchSeams = Pick<ReloadWatchOptions, "readDisk" | "isSelfHostedImpl" | "intervalMs">;

/** Watch for a newer compiled tree on disk and fire `onTrigger` at most once. The gate: null
 * `startupInfo` ⇒ never reload (checked before `isSelfHosted`, which takes a non-null
 * BuildInfo); a build compiled from another root ⇒ never reload. A startup build compiled
 * from THIS root still watches when the repo cannot resolve its commit (a hand-written or test
 * stamp, rewritten history): the code running is this checkout's all the same, and the next
 * real build must reach it — on 2026-09-29 a dashboard re-exec'd onto a test's fake stamp and,
 * refused a watch, served its old page through every redeploy after (BUGS.md).
 *
 * The interval re-reads the disk stamp and fires only onto a changed stamp that names a real
 * commit of this repo (isSelfHosted): re-exec'ing onto a bogus one would hand the new process
 * exactly that unknown provenance. The check is one git call, made once per new stamp — at
 * most one in flight, and a stamp found bogus is not asked about again while it stays. */
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
  let checking = false;
  let rejectedSha: string | null = null;

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function check(): void {
    if (stopped || fired || checking) return;
    const disk = readDisk();
    if (disk === null || !shouldReload(startupInfo, disk) || disk.sha === rejectedSha) return;
    checking = true;
    void isSelfHostedImpl(root, disk).then(
      (real) => {
        checking = false;
        if (stopped || fired) return;
        if (!real) {
          rejectedSha = disk.sha;
          return;
        }
        fired = true;
        stop();
        onTrigger();
      },
      () => {
        checking = false; // The check could not run: ask again on the next poll.
      },
    );
  }

  return {
    async start(): Promise<void> {
      if (startupInfo === null) return;
      // Self-hosted, or at least compiled from this root (the unresolvable-commit case above).
      if (!(await isSelfHostedImpl(root, startupInfo)) && path.resolve(root) !== startupInfo.root) return;
      if (stopped || fired) return;
      timer = setInterval(check, intervalMs);
    },
    stop,
  };
}
