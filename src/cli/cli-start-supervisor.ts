/** `tumwater start`'s supervisor half: the process that boots the team as a child generation
 * and respawns it on every self-redeploy (`superviseStartCommand`), keeping a `--gui` dashboard
 * child alive beside it (`superviseDashboard`), and the `--gui` child-arg plan and dashboard
 * child-env wiring (`guiChildPlan`, `dashboardChildEnv`). `src/cli/cli-start.ts`
 * keeps `cmdStart` (the boot and the run loop), the invocation guards, the window's deadline
 * and scheduled-stop watchdogs, and the exit-summary half lives in `src/cli/cli-start-summary.ts`;
 * this module holds only the supervisor's child control, so the largest command module is no
 * longer also the home of every way a run is supervised and reported. The supervisor machinery
 * loads lazily (see `superviseStartCommand`), so a command that never boots the team never
 * compiles the orchestrator/merge pipeline it pulls. */
import type { StdioOptions } from "node:child_process";
import { say } from "../terminal.js";
import { GUI_TOKEN_ENV, parsePortFlag } from "./cli-args.js";
import { runStartupProblem } from "../gates/startup-gates.js";
import { repairInterruptedSwap } from "../build/build-stage.js";
import { logEvent } from "../events/events.js";
import { notifyTeamDown } from "../events/event-notify.js";
import { RESTART_EXIT_CODE } from "../redeploy/redeploy-policy.js";

/** Split `run`'s args for `run --gui`: whether the supervisor should also start the dashboard,
 * and the args the supervised orchestrator generation gets with the dashboard flags stripped so
 * the generation's own cmdStart never tries to supervise a second dashboard (a self-redeploy
 * spawns a fresh generation each time). Exported so the unit tests pin the stripping that
 * removing the spawn wiring would otherwise silently drop. */
export function guiChildPlan(runArgs: string[]): {
  spawnGui: boolean;
  /** The dashboard flags the child gets (`["--port", N]` then `["--all-interfaces"]` when
   * given), threaded into spawnGuiChild so a one-command `run --gui` serves the dashboard
   * exactly as a direct `tumwater gui` invocation would. The port is parsed here (parsePortFlag
   * has already run its shape gate on the dispatcher, so this is the same value re-typed for
   * the child).
   *
   * The gate token is deliberately NOT here — it would land on the child's argv, which the
   * OS process table exposes to every local user and which the child's reload re-runs. It
   * travels in `guiToken` to the child's env instead (see superviseDashboard). */
  guiArgs: string[];
  /** The gate token, when the operator gave one, for the dashboard child's env — never argv. */
  guiToken?: string;
  orchestratorArgs: string[];
} {
  const portIdx = runArgs.indexOf("--port");
  const portRaw = portIdx >= 0 ? runArgs[portIdx + 1] : undefined;
  const port = portRaw !== undefined ? parsePortFlag(portRaw) : null;
  const tokenIdx = runArgs.indexOf("--token");
  const tokenRaw = tokenIdx >= 0 ? runArgs[tokenIdx + 1] : undefined;
  // Drop --port/--token and their value tokens from the supervized orchestrator generation
  // along with --gui (and --all-interfaces by name): the child's own cmdStart would
  // otherwise hit the dashboard-only-flag refusals (its args no longer carry --gui) or supervise
  // a second dashboard, and a self-redeploy hand-off must never forward a dashboard flag it is
  // not serving itself. --all-interfaces and --token have no value token to skip, so the name
  // filter below drops them; the valued pair is skipped by index like --port's.
  const skip = new Set<number>();
  if (portIdx >= 0) {
    skip.add(portIdx);
    if (portIdx + 1 < runArgs.length) skip.add(portIdx + 1);
  }
  if (tokenIdx >= 0) {
    skip.add(tokenIdx);
    if (tokenIdx + 1 < runArgs.length) skip.add(tokenIdx + 1);
  }
  const guiArgs: string[] = [];
  if (port !== null) guiArgs.push("--port", String(port));
  if (runArgs.includes("--all-interfaces")) guiArgs.push("--all-interfaces");
  // The token is returned separately (guiToken) and reaches the child through its env, never
  // guiArgs/argv: a secret on the command line is world-readable (/proc/<pid>/cmdline) and is
  // re-run verbatim by a self-reload onto each new generation. The skip set still drops the
  // operator's --token pair from the orchestrator generation (its cmdStart would refuse a
  // dashboard flag without --gui, and a self-redeploy hand-off must never forward it).
  return {
    spawnGui: runArgs.includes("--gui"),
    guiArgs,
    guiToken: tokenRaw,
    orchestratorArgs: runArgs.filter(
      (arg, i) => arg !== "--gui" && arg !== "--all-interfaces" && !skip.has(i),
    ),
  };
}

/** The env a supervised dashboard child is spawned with: it marks the child as owned by this
 * supervisor (`childMarkerEnv`, DASHBOARD_CHILD_ENV, names the host pid so the child's reload
 * watch at src/redeploy/self-reload.ts exits RESTART_EXIT_CODE / dies with the supervisor) and,
 * when the operator gave a gate token, carries it under GUI_TOKEN_ENV. The token deliberately
 * never reaches the child's argv: /proc/<pid>/cmdline is world-readable, and the child's own
 * self-reload (reexecSelf, which propagates env via childEnv) would re-run a command-line secret
 * onto each fresh generation. Kept out of superviseDashboard so this env wiring is unit-testable
 * without spawning a live dashboard child (BUGS-FIXED.md's dashboard gate-token fix). */
export function dashboardChildEnv(
  childMarkerEnv: string,
  guiToken: string | undefined,
  hostPid: number,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { [childMarkerEnv]: String(hostPid) };
  if (guiToken !== undefined) env[GUI_TOKEN_ENV] = guiToken;
  return env;
}

/** The dashboard half of `run --gui`: keep a `tumwater gui` child alive across its own
 * self-reloads. The child is marked with DASHBOARD_CHILD_ENV naming this supervisor, so its
 * reload watch (src/redeploy/self-reload.ts) exits RESTART_EXIT_CODE for a fresh sibling on a
 * redeploy and exits on its own if this supervisor dies outright (SIGKILL, a crash) — a killed
 * supervisor never leaves a dashboard holding its port. Any other dashboard exit (a failed bind
 * prints its own message and exits) ends this loop and leaves the team running. */
async function superviseDashboard(
  signal: AbortSignal,
  guiToken: string | undefined,
  stdio: StdioOptions = "inherit",
  guiArgs: string[] = [],
): Promise<void> {
  const { DASHBOARD_CHILD_ENV } = await import("../redeploy/self-reload.js");
  const { spawnGuiChild } = await import("../process/supervisor.js");
  const env = dashboardChildEnv(DASHBOARD_CHILD_ENV, guiToken, process.pid);
  for (;;) {
    const exit = await spawnGuiChild(signal, env, stdio, guiArgs);
    if (signal.aborted || exit.code !== RESTART_EXIT_CODE) return;
  }
}

/** The supervisor half of `tumwater start` (src/process/supervisor.ts): spawn the orchestrator as a
 * child generation and respawn it whenever it exits RESTART_EXIT_CODE after redeploying itself.
 * Ctrl+C reaches the child directly from the terminal, so only SIGTERM is forwarded; the
 * supervisor's own exit code is whatever the last generation's was. A team that goes down without
 * the operator asking leaves a `supervisor_exit` event behind (BUGS.md 2026-09-23): the dead
 * generation's stderr reached only this terminal, which nobody may be watching. */
export async function superviseStartCommand(root: string, runArgs: string[], branchArg: string | null, forMs: number | null): Promise<void> {
  // The supervisor machinery loads lazily, like cmdStart's orchestrator import above: a command
  // that never boots the team never compiles it.
  const { RUN_WINDOW_START_ENV, teamDownEvent, spawnStartChild, superviseStart } = await import("../process/supervisor.js");
  const plan = guiChildPlan(runArgs);
  const windowEnv = forMs !== null ? { [RUN_WINDOW_START_ENV]: String(Date.now()) } : {};
  const controller = new AbortController();
  // The dashboard lives beside the orchestrator generations rather than inside one: it must
  // outlive every generation a redeploy swaps out. Its own abort stops the current dashboard
  // child, which spawnGuiChild's abort wiring SIGTERMs.
  const guiController = new AbortController();
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true; // The child got the same SIGINT from the terminal and stops on its own.
  });
  process.on("SIGTERM", () => {
    stopping = true;
    controller.abort(); // Not delivered to the child by the kernel — forward it.
    guiController.abort();
  });
  const gui = plan.spawnGui ? superviseDashboard(guiController.signal, plan.guiToken, "inherit", plan.guiArgs) : Promise.resolve();
  const code = await superviseStart(
    {
      spawnChild: (signal) =>
        spawnStartChild(signal, plan.orchestratorArgs, windowEnv, "inherit"),
      stopping: () => stopping,
      onRespawn: (generation) => {
        if (!runArgs.includes("--json")) say(`\nrestarting onto the update (restart ${generation})\n`);
      },
      onCrashLoop: () =>
        process.stderr.write("tumwater restarted itself too many times in a minute — giving up\n"),
      // Re-ask the startup gate for the reason: a generation that dies right after a respawn
      // most likely met an environment that no longer boots (the 2026-09-22 child found
      // tumwater.json gone). A crash loop's generations all asked for restarts, so the gate
      // has nothing to say about it.
      onTeamDown: async (down) => {
        const event = logEvent(root, teamDownEvent(down, down.crashLoop ? null : await runStartupProblem(root, branchArg)));
        notifyTeamDown(root, event);
      },
      // The end-of-supervision build repair (see build-stage.repairInterruptedSwap): a swap
      // killed between its two renames leaves dist/ missing, and this process is the only one
      // still able to rename the preserved old build back before it exits — the next `tumwater
      // run` would otherwise fail to load its own dist/src/cli.js. repairInterruptedSwap is a
      // static import, so its code is in memory before any swap can move dist/ away: an import
      // at call time would fail ERR_MODULE_NOT_FOUND exactly when it is needed. The repair
      // reports its own outcome, so it can never change the exit code.
      onDone: () => repairInterruptedSwap(root),
    },
    controller.signal,
  );
  // The orchestrator is gone; take the dashboard with it so a stopped team never leaves a
  // dashboard holding its port. abort() SIGTERMs the current gui child; await lets the spawn
  // loop observe the abort before this process exits.
  guiController.abort();
  await gui;
  process.exit(code);
}
