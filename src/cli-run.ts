/** The fleet-booting commands' implementations: `tumwater init` and `tumwater run` — the latter
 * with its supervisor half (src/supervisor.ts). cli.ts stays the pure dispatcher; every other
 * command it dispatches already delegates to a module (operator-commands.ts, prompt-commands.ts,
 * config-commands.ts, ui/log-commands.ts,
 * doctor.ts, …), and these three were the only implementations living in the dispatcher itself. */
import { enabledRoleIds } from "./config.js";
import { fail, say } from "./cli-output.js";
import { parseBranchFlag, parseRoleFlag } from "./cli-args.js";
import { parseInitArgs } from "./cli-command-args.js";
import { isFleetPaused, orchestratorAlive, pausedRoles } from "./fleet-state.js";
import { runStartupCheck, runStartupProblem } from "./startup-gate.js";
import { initProject } from "./init.js";
import { logEvent, subscribeEvents } from "./events.js";
import { LaunchServicesWatch } from "./launch-services.js";
import { formatEvent } from "./event-format.js";
import { runOrchestrator } from "./orchestrator.js";
import { RESTART_EXIT_CODE } from "./redeploy-policy.js";
import { createRedeployer } from "./redeploy.js";
import { loadLoopState } from "./loop-state.js";
import { plural } from "./phrases.js";
import { fleetDownEvent, spawnRunChild, startParentDeathWatch, SUPERVISED_ENV, superviseRun } from "./supervisor.js";
import { shortSha } from "./text.js";

/** `tumwater init`: seed a project directory from the operator's brief (src/init.ts does the
 * work; this prints the report). --dry-run prints the would-be actions without writing
 * anything; an already-initialized repo is reported as a no-op, never an error. */
export async function cmdInit(root: string, args: string[]): Promise<void> {
  const { prompt, branch, adopt, dryRun } = parseInitArgs(args);
  const result = await initProject(root, prompt, branch ?? undefined, { adopt, dryRun });
  if (result.adopted) {
    say(
      `${result.dryRun ? "would adopt" : "adopting"} an existing repo: the project brief goes in TUMWATER.md and README.md is left untouched`,
    );
  }
  if (result.dryRun) {
    if (result.repoInitialized && result.branch) {
      say(`dry run — would initialize a new git repository on branch ${result.branch}`);
    }
    const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "nothing");
    say(`dry run — would create: ${list(result.created)}`);
    say(`would leave alone: ${list(result.leftAlone)}`);
    say("nothing written; re-run without --dry-run to apply");
    return;
  }
  if (result.created.length === 0) {
    say("already initialized; nothing to do");
    return;
  }
  if (result.repoInitialized && result.branch) {
    say(`initialized a new git repository on branch ${result.branch}`);
  }
  say(`created ${result.created.join(", ")}${result.committed ? " (committed)" : ""}`);
  say("next: `tumwater run` in one terminal, `tumwater tui` in another");
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
  // A scoped once round: `--role <id>` names the one loop that runs. Parsed here, where the
  // live config is readable, and validated against the ENABLED ids — not the full catalog —
  // so an unknown id and a disabled one fail fast with the same wording (a scoped round that
  // booted a disabled role's runner would run nothing while claiming to serve the operator
  // who just queued that loop a prompt). Custom loops are valid targets: knownRoleIds
  // accepts them, and an enabled custom passes this check like any built-in. Daemon
  // `run --role` stays an error: scoping is a once-round concept.
  const roleFilter = parseRoleFlag(args, enabledRoleIds(config));
  if (roleFilter !== null && !once) fail("--role is only valid with --once");
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
    say("\nstopping — waiting for in-flight ticks (Ctrl+C again to force)");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A supervisor that dies without forwarding — SIGKILL (the OOM killer, `kill -9`) cannot be
  // trapped or forwarded, and an uncaught supervisor crash forwards nothing either — leaves this
  // generation reparented and ticking the fleet unattended. The parent-death watch polls for the
  // reparent and runs the same graceful stop a forwarded SIGTERM would have run, so a killed
  // supervisor takes its fleet down with it (BUGS.md 2026-09-30). Everything below runs only in
  // the supervised generation: an unsupervised `run` became the supervisor above and returned.
  startParentDeathWatch(stop);
  const enabled = enabledRoleIds(config);
  // A scoped round's role list is exactly the filter; otherwise every enabled role runs.
  const roles = roleFilter !== null ? [roleFilter] : enabled;
  // A once round never self-redeploys: it runs one round on the build it booted and exits,
  // so the hand-off machinery (and its build stamp) stays daemon-only.
  const redeploy = once
    ? null
    : await createRedeployer(root, (e) => logEvent(root, e), () => runStartupProblem(root, branchArg));
  const build = redeploy ? ` · build ${shortSha(redeploy.build.sha)}` : "";
  // A long-running fleet watches launchservicesd's port count (a no-op off macOS); a once round
  // is over long before a leak could matter.
  const launchServicesWatch = once ? null : new LaunchServicesWatch(root);
  // Name the resolved root when it differs from the cwd: an operator who started the fleet
  // from a subdirectory must see where .tumwater/ actually lives.
  const rootNote = root !== process.cwd() ? ` · root ${root}` : "";
  say(
    once
      ? `tumwater once on branch ${mainBranch}${rootNote} — one round, then exit`
      : `tumwater running on branch ${mainBranch}${build}${rootNote} — Ctrl+C to stop`,
  );
  say(`loops: ${roles.join(", ")}`);
  say("watch: `tumwater tui` or `tumwater logs -f` in another terminal; events stream below\n");
  const unsubscribe = subscribeEvents((e) => say(formatEvent(e)));
  // Snapshot each role's tick counter so the once summary can tell this round's ticks from
  // the persisted history (the state file accumulates across rounds).
  const ticksBefore = new Map(roles.map((role) => [role, loadLoopState(root, role).ticks] as const));
  let exit;
  try {
    exit = await runOrchestrator({
      root,
      config,
      mainBranch,
      signal: controller.signal,
      redeploy,
      launchServicesWatch,
      once,
      roleFilter: roleFilter ?? undefined,
    });
  } finally {
    unsubscribe();
  }
  if (once) say(onceSummary(root, roles, ticksBefore, exit.settled, exit.ticksRun));
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
 * the same conflation settleSkipped itself carried).
 *
 * `ticksRun`, when the caller hands it back (the orchestrator's OnceRound snapshot deltas),
 * is the tick count's source of truth and also names roles the pre-round list never had —
 * a role enabled mid-round joins the runners array after `ticksBefore` was taken, so its
 * whole persisted history must not be counted as this round's work. Without it the old
 * `ticksBefore` delta path runs, for callers (and tests) without a round object. */
export function onceSummary(
  root: string,
  roles: string[],
  ticksBefore: Map<string, number>,
  settled: ReadonlyMap<string, string> | undefined,
  ticksRun?: ReadonlyMap<string, number>,
): string {
  let ticks = 0;
  const outcomes = new Map<string, number>();
  const skipped: string[] = [];
  const extra = ticksRun ? [...ticksRun.keys()].filter((r) => !roles.includes(r)) : [];
  for (const role of [...roles, ...extra]) {
    const s = loadLoopState(root, role);
    const ran = ticksRun ? (ticksRun.get(role) ?? 0) : s.ticks - (ticksBefore.get(role) ?? 0);
    if (ran > 0) {
      ticks += ran;
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
  return `once: ${plural(ticks, "tick")} — ${counts || "nothing ran"}${skipNote}`;
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
        say(`\nrestarting on the new build (generation ${generation})\n`),
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
