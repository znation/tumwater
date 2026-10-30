/** `tumwater start`'s supervisor half: the process that boots the team as a child generation
 * and respawns it on every self-redeploy (`superviseStartCommand`), keeping a `--gui` dashboard
 * child alive beside it (`superviseDashboard`), and the shared `--gui`/`--tui` child-arg plan
 * and dashboard child-env wiring (`guiChildPlan`, `dashboardChildEnv`). `src/cli/cli-start.ts`
 * keeps `cmdStart` (the boot and the run loop), the invocation guards, the window's deadline
 * and scheduled-stop watchdogs, and the exit-summary half lives in `src/cli/cli-start-summary.ts`;
 * this module holds only the supervisor's child control, so the largest command module is no
 * longer also the home of every way a run is supervised and reported. The supervisor machinery
 * loads lazily (see `superviseStartCommand`), so a command that never boots the team never
 * compiles the orchestrator/merge pipeline it pulls. */
import type { StdioOptions } from "node:child_process";
import { fail, say } from "./cli-output.js";
import { parsePortFlag } from "./cli-args.js";
import { runStartupProblem } from "../gates/startup-gates.js";
import { repairInterruptedSwap } from "../build/build-stage.js";
import { logEvent } from "../events/events.js";
import { notifyTeamDown } from "../events/event-notify.js";
import { RESTART_EXIT_CODE } from "../redeploy/redeploy-policy.js";

/** The env var that carries the dashboard gate token between a supervisor and its dashboard
 * child (and across a re-exec'd dashboard generation), for the `run --gui`/`start --gui`
 * supervisor's own use. Defined here rather than imported from gui-command.js so this module
 * (and every `start`/`run` invocation) never pulls the GUI server graph onto the page; it
 * must stay the same literal as gui-command's GUI_TOKEN_ENV, and a merge that renames one
 * renames the other. */
export const GUI_TOKEN_ENV = "TUMWATER_GUI_TOKEN";

/** Split `run`'s args for `run --gui` and `run --tui`: whether the supervisor should also start
 * the dashboard and/or host the observer TUI, and the args the supervised orchestrator
 * generation gets with both stripped so the generation's own cmdStart never tries to supervise a
 * second dashboard or re-attach a TUI in a terminal the parent owns (a self-redeploy spawns a
 * fresh generation each time). Exported so the unit tests pin the stripping that removing the
 * spawn wiring would otherwise silently drop. */
export function guiChildPlan(runArgs: string[]): {
  spawnGui: boolean;
  spawnTui: boolean;
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
  /** The stdio the supervised children (the run child and, when `--gui`, the dashboard child)
   * get: `"inherit"` on a plain `run`/`run --gui`, but silent when a TUI is hosted — the
   * observer TUI owns the terminal (ink paints it), so neither child's `say()` output may share
   * that stdout or its lines would interleave with and corrupt the TUI's full-screen render.
   * The TUI renders status + recent events from on-disk state, so nothing the operator watched
   * for is lost by silencing the feeds; the dashboard's `tumwater gui at http://…` banner is
   * exactly such an interleaving line, so it is silenced with the rest. */
  childStdio: StdioOptions;
} {
  const portIdx = runArgs.indexOf("--port");
  const portRaw = portIdx >= 0 ? runArgs[portIdx + 1] : undefined;
  const port = portRaw !== undefined ? parsePortFlag(portRaw) : null;
  const tokenIdx = runArgs.indexOf("--token");
  const tokenRaw = tokenIdx >= 0 ? runArgs[tokenIdx + 1] : undefined;
  // Drop --port/--token and their value tokens from the supervized orchestrator generation
  // along with --gui/--tui (and --all-interfaces by name): the child's own cmdStart would
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
    spawnTui: runArgs.includes("--tui"),
    guiArgs,
    guiToken: tokenRaw,
    orchestratorArgs: runArgs.filter(
      (arg, i) => arg !== "--gui" && arg !== "--tui" && arg !== "--all-interfaces" && !skip.has(i),
    ),
    childStdio: runArgs.includes("--tui") ? ["ignore", "ignore", "ignore"] : "inherit",
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
  // A TUI owns the terminal, so it can only be hosted when this supervisor's own stdin and
  // stdout are a TTY — the same guard runTui enforces. Check before booting a team a TUI
  // could never drive, surfacing the actionable tuiTerminalError instead of letting runTui's
  // rejection sit unhandled until superviseStart settles and then crash the supervisor after
  // the team has (pointlessly) started.
  if (plan.spawnTui && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    const { tuiTerminalError } = await import("../ui/tui/tui-input.js");
    fail(tuiTerminalError(Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY)));
  }
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
  // The TUI is hosted in the supervisor process, beside the orchestrator generations it must
  // outlive. Quitting it (q or Ctrl+C handled by ink's key handler) is the run's Ctrl+C:
  // runTui resolves and the .then sets `stopping` and aborts the controller, so superviseStart
  // drains in-flight runs and the team shuts down exactly as Ctrl+C on a plain `run` does;
  // the team-down teardown (dashboard abort, onDone, terminal restore) is unchanged.
  // reloadDisabled keeps the hosted TUI off its self-reload watch: the team's own first
  // self-redeploy dist swap must not resolve runTui (which would read as a quit and abort
  // this run's controller) or spawn a re-exec replacement; the host supervisor survives a
  // redeploy by respawning its team children, and the hosted TUI — like the supervisor
  // itself — stays on the build it started, getting fresh code on the next run. The abort
  // signal is how this process ends the TUI when the run ends on its own (a `--for` window
  // closes, or the team stops): runTui resolves on abort and takes its quit teardown, so the
  // `await tui` below cannot hang on a TUI nothing else would ever close.
  const tuiController = new AbortController();
  const tui = plan.spawnTui
    ? (await import("../ui/tui/tui.js")).runTui(root, { abortSignal: tuiController.signal, reloadDisabled: true }).then(() => {
        stopping = true; // the TUI quit = the run's Ctrl+C
        controller.abort();
        guiController.abort();
      })
    : Promise.resolve();
  const gui = plan.spawnGui ? superviseDashboard(guiController.signal, plan.guiToken, plan.childStdio, plan.guiArgs) : Promise.resolve();
  const code = await superviseStart(
    {
      spawnChild: (signal) =>
        spawnStartChild(signal, plan.orchestratorArgs, windowEnv, plan.childStdio),
      stopping: () => stopping,
      onRespawn: (generation) => {
        // With a hosted TUI the supervisor owns no free stdout: its own say() would paint the
        // restart line over the ink full-screen render and corrupt it — the same interleaving
        // childStdio silences for the children. The TUI renders status from on-disk state, so
        // the redeploy is visible there as the team coming back.
        if (!plan.spawnTui && !runArgs.includes("--json")) say(`\nrestarting onto the update (restart ${generation})\n`);
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
  // The orchestrator is gone; take the dashboard and the TUI with it so a stopped team never
  // leaves a dashboard holding its port or a TUI holding the terminal. abort() SIGTERMs the
  // current gui child; await lets the spawn loop observe the abort before this process exits.
  // On a plain run the user's own Ctrl+C already resolved the TUI; on a windowed (--for) run
  // the window just closed with the TUI still up, so it is aborted here and its teardown /
  // terminal restore settle before this process exits.
  tuiController.abort();
  await tui; // let the TUI's promise settle / terminal restore
  guiController.abort();
  await gui;
  process.exit(code);
}
