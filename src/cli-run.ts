/** The fleet-booting commands' implementations: `tumwater init` and `tumwater run` — the latter
 * with its supervisor half (src/supervisor.ts). cli.ts stays the pure dispatcher; every other
 * command it dispatches already delegates to a module (operator-commands.ts, ui/log-commands.ts,
 * doctor.ts, …), and these three were the only implementations living in the dispatcher itself. */
import { enabledRoleIds } from "./config.js";
import { fail, parseBranchFlag, parseInitArgs } from "./cli-args.js";
import { isFleetPaused, orchestratorAlive, pausedRoles } from "./fleet-state.js";
import { runStartupCheck, runStartupProblem } from "./startup-gate.js";
import { initProject } from "./init.js";
import { logEvent, subscribeEvents } from "./events.js";
import { formatEvent } from "./ui/event-format.js";
import { runOrchestrator } from "./orchestrator.js";
import { createRedeployer, RESTART_EXIT_CODE } from "./redeploy.js";
import { loadLoopState } from "./state.js";
import { fleetDownEvent, spawnRunChild, SUPERVISED_ENV, superviseRun } from "./supervisor.js";
import { shortSha } from "./text.js";

/** `tumwater init`: seed a project directory from the operator's brief (src/init.ts does the
 * work; this prints the report). --dry-run prints the would-be actions without writing
 * anything; an already-initialized repo is reported as a no-op, never an error. */
export async function cmdInit(root: string, args: string[]): Promise<void> {
  const { prompt, branch, adopt, dryRun } = parseInitArgs(args);
  const result = await initProject(root, prompt, branch ?? undefined, { adopt, dryRun });
  if (result.adopted) {
    process.stdout.write(
      `${result.dryRun ? "would adopt" : "adopting"} an existing repo: the project brief goes in TUMWATER.md and README.md is left untouched\n`,
    );
  }
  if (result.dryRun) {
    if (result.repoInitialized && result.branch) {
      process.stdout.write(`dry run — would initialize a new git repository on branch ${result.branch}\n`);
    }
    const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "nothing");
    process.stdout.write(`dry run — would create: ${list(result.created)}\n`);
    process.stdout.write(`would leave alone: ${list(result.leftAlone)}\n`);
    process.stdout.write("nothing written; re-run without --dry-run to apply\n");
    return;
  }
  if (result.created.length === 0) {
    process.stdout.write("already initialized; nothing to do\n");
    return;
  }
  if (result.repoInitialized && result.branch) {
    process.stdout.write(`initialized a new git repository on branch ${result.branch}\n`);
  }
  process.stdout.write(`created ${result.created.join(", ")}${result.committed ? " (committed)" : ""}\n`);
  process.stdout.write("next: `tumwater run` in one terminal, `tumwater tui` in another\n");
}

/** `tumwater run`: boot the fleet and stream its event feed to this terminal until it stops.
 * Three layers cooperate here: without SUPERVISED_ENV this process becomes the supervisor
 * (superviseRunCommand below), spawning the real orchestrator as a child generation; the child
 * runs runOrchestrator to completion, handing the terminal back via RESTART_EXIT_CODE after a
 * self-redeploy so the supervisor respawns on the new build; --once collapses the whole thing
 * into one round of ticks and a summary line (onceSummary below), for cron-style invocations.
 */
export async function cmdRun(root: string, args: string[]): Promise<void> {
  // The one function the self-redeploy asks before swapping onto a successor and the supervisor
  // asks when a generation dies, so the three cannot disagree about what boots. The supervisor
  // half runs it too, so a start that cannot boot fails before any child spawns. The flag
  // vocabulary is validated by the dispatcher (cli.ts, from the same RUN_FLAG_SPECS).
  const once = args.includes("--once");
  const branchArg = parseBranchFlag(args);
  const startup = await runStartupCheck(root, branchArg);
  if ("problem" in startup) fail(startup.problem);
  const { config, mainBranch } = startup;
  if (orchestratorAlive(root)) fail("an orchestrator is already running for this repo");
  if (!process.env[SUPERVISED_ENV]) {
    // `args` are the flags after the command token — forward them so the child generation
    // targets the same branch (or whatever else the invocation named).
    await superviseRunCommand(root, args, branchArg);
    return;
  }
  const controller = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stdout.write("\nstopping — waiting for in-flight ticks (Ctrl+C again to force)\n");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const enabled = enabledRoleIds(config);
  // A once round never self-redeploys: it runs one round on the build it booted and exits,
  // so the hand-off machinery (and its build stamp) stays daemon-only.
  const redeploy = once
    ? null
    : await createRedeployer(root, (e) => logEvent(root, e), () => runStartupProblem(root, branchArg));
  const build = redeploy ? ` · build ${shortSha(redeploy.build.sha)}` : "";
  // Name the resolved root when it differs from the cwd: an operator who started the fleet
  // from a subdirectory must see where .tumwater/ actually lives.
  const rootNote = root !== process.cwd() ? ` · root ${root}` : "";
  process.stdout.write(
    once
      ? `tumwater once on branch ${mainBranch}${rootNote} — one round, then exit\n`
      : `tumwater running on branch ${mainBranch}${build}${rootNote} — Ctrl+C to stop\n`,
  );
  process.stdout.write(`loops: ${enabled.join(", ")}\n`);
  process.stdout.write("watch: `tumwater tui` or `tumwater logs -f` in another terminal; events stream below\n\n");
  const unsubscribe = subscribeEvents((e) => process.stdout.write(formatEvent(e) + "\n"));
  // Snapshot each role's tick counter so the once summary can tell this round's ticks from
  // the persisted history (the state file accumulates across rounds).
  const ticksBefore = new Map(enabled.map((role) => [role, loadLoopState(root, role).ticks] as const));
  let exit;
  try {
    exit = await runOrchestrator({ root, config, mainBranch, signal: controller.signal, redeploy, once });
  } finally {
    unsubscribe();
  }
  if (once) process.stdout.write(onceSummary(root, enabled, ticksBefore, exit.settled) + "\n");
  // A self-redeploy swapped the new build into dist/: hand the terminal back to the supervisor,
  // which respawns this same script — now the new code — as the next generation.
  if (exit.restart) process.exit(RESTART_EXIT_CODE);
}

/** The once round's one-line summary, read from the runners' persisted loop state plus the
 * orchestrator's own settle reasons — a cron job's log shows what the round did without parsing
 * events. Roles whose tick counter advanced bucket by their last completed result; the rest are
 * skipped with the reason the orchestrator settled them for (`paused`, `resume pending`,
 * `backoff`, `deferred`, `disabled`, `idle` — handed back on OrchestratorExit.settled, so a
 * deferred role reads as set aside, not as "nothing was due"); a role the map lacks (defensively
 * — the round only exits once every role is settled) falls back to deriving the reason from
 * state: a pause marker when one is held, a pending resume when one is flagged, backoff when
 * `backoffSeconds` is raised, otherwise idle — the same classification settleSkipped draws,
 * and keyed on the same signal: backoffSeconds is the backoff indicator, while nextRunAt is
 * shared with the scheduled clock a productive tick also writes (with backoffSeconds 0), so a
 * future nextRunAt alone reads as a not-yet-due role, not as backoff (BUGS.md 2026-09-25,
 * the same conflation settleSkipped itself carried). */
export function onceSummary(
  root: string,
  roles: string[],
  ticksBefore: Map<string, number>,
  settled: ReadonlyMap<string, string> | undefined,
): string {
  let ticks = 0;
  const outcomes = new Map<string, number>();
  const skipped: string[] = [];
  for (const role of roles) {
    const s = loadLoopState(root, role);
    if (s.ticks > (ticksBefore.get(role) ?? 0)) {
      ticks += s.ticks - (ticksBefore.get(role) ?? 0);
      const key = s.lastResult ?? "no_change";
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    } else {
      const reason =
        settled?.get(role) ??
        (isFleetPaused(root) || pausedRoles(root).includes(role)
          ? "paused"
          : s.resumePending
            ? "resume pending"
            : s.backoffSeconds > 0
              ? "backoff"
              : "idle");
      skipped.push(reason);
    }
  }
  const counts = [...outcomes.entries()].sort().map(([k, n]) => `${n} ${k}`).join(", ");
  const skipNote = skipped.length === 0 ? "" : `, ${skipped.length} skipped (${skipped.join(", ")})`;
  return `once: ${ticks} tick${ticks === 1 ? "" : "s"} — ${counts || "nothing ran"}${skipNote}`;
}

/** The supervisor half of `tumwater run` (src/supervisor.ts): spawn the orchestrator as a child
 * generation and respawn it whenever it exits RESTART_EXIT_CODE after redeploying itself. Ctrl+C
 * reaches the child directly from the terminal, so only SIGTERM is forwarded; the supervisor's
 * own exit code is whatever the last generation's was. A fleet that goes down without the
 * operator asking leaves a `supervisor_exit` event behind (BUGS.md 2026-09-23): the dead
 * generation's stderr reached only this terminal, which nobody may be watching. */
async function superviseRunCommand(root: string, runArgs: string[], branchArg: string | null): Promise<void> {
  const controller = new AbortController();
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true; // The child got the same SIGINT from the terminal and stops on its own.
  });
  process.on("SIGTERM", () => {
    stopping = true;
    controller.abort(); // Not delivered to the child by the kernel — forward it.
  });
  const code = await superviseRun(
    {
      spawnChild: (signal) => spawnRunChild(signal, runArgs),
      stopping: () => stopping,
      onRespawn: (generation) =>
        process.stdout.write(`\nrestarting on the new build (generation ${generation})\n\n`),
      onCrashLoop: () =>
        process.stderr.write("tumwater: the harness restarted itself too many times in a minute — giving up\n"),
      // Re-ask the startup gate for the reason: a generation that dies right after a respawn
      // most likely met an environment that no longer boots (the 2026-09-22 child found
      // tumwater.json gone). A crash loop's generations all asked for restarts, so the gate
      // has nothing to say about it.
      onFleetDown: async (down) => {
        logEvent(root, fleetDownEvent(down, down.crashLoop ? null : await runStartupProblem(root, branchArg)));
      },
    },
    controller.signal,
  );
  process.exit(code);
}
