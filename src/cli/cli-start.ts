/** `tumwater start`'s implementation, with its supervisor half
 * (src/cli/cli-start-supervisor.ts) and its exit-summary half (src/cli/cli-start-summary.ts).
 * cli.ts stays the pure dispatcher; `tumwater init` lives in cli/cli-init.ts and every other
 * command it dispatches delegates to its own module (operator/operator-commands.ts,
 * prompt-commands.ts, cli-config-commands.ts, cli-log-commands.ts, doctor.ts, …). */
import type { TumwaterConfig } from "../config/config-schema.js";
import { baseRoleOf, runnerIds } from "../roles/runner-ids.js";
import { knownRoleIds } from "../config/config.js";
import { unknownRoleMessage } from "../roles/roles.js";
import { fail, say, sayJson } from "./cli-output.js";
import {
  durationLabel,
  failRivalShapes,
  parseBranchFlag,
  parseRoleListFlag,
  tokenValueProblem,
} from "./cli-args.js";
import { cancelScheduledStop, scheduledStopAt } from "../team/team-state.js";
import { orchestratorAlive, readOrchestratorInfo } from "../team/team-orchestrator-info.js";
import { runStartupCheck, runStartupProblem } from "../gates/startup-gates.js";
import { logEvent, subscribeEvents } from "../events/events.js";
import { formatEvent } from "../events/event-format.js";
import { RESTART_EXIT_CODE } from "../redeploy/redeploy-policy.js";
import { runStartupMigrations } from "../orchestrator/startup-migration-steps.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { shortSha } from "../text/format.js";
import { readRunRowsSince, summarizeRunRows } from "../history/history-data.js";
import {
  ONCE_FAILURE_RESULTS,
  inheritedWindowStart,
  onceFailures,
  onceReport,
  onceSummary,
  parseRunWindow,
  renderOnceSummary,
  windowReport,
  windowSummary,
  type WindowReport,
} from "./cli-start-summary.js";

export {
  ONCE_FAILURE_RESULTS,
  inheritedWindowStart,
  onceFailures,
  onceReport,
  onceSummary,
  parseRunWindow,
  renderOnceSummary,
  windowReport,
  windowSummary,
  type WindowReport,
};

import { GUI_TOKEN_ENV, superviseStartCommand } from "./cli-start-supervisor.js";

interface StartInvocation {
  once: boolean;
  json: boolean;
  forMs: number | null;
  branchArg: string | null;
  roleFilter: string[] | null;
  config: TumwaterConfig;
  mainBranch: string;
}

interface SupervisedGenerationInput {
  root: string;
  config: TumwaterConfig;
  mainBranch: string;
  branchArg: string | null;
  once: boolean;
  json: boolean;
  forMs: number | null;
  roleFilter: string[] | null;
}

/** Refuse the --once run-mode rivals: a TUI and a dashboard each cannot be hosted by a run that
 * is about to stop, so both are refused together before any boot. --for stays allowed — both
 * serve for the window. Owns the run-mode rival refusals. */
function assertOnceRivalFlags(args: string[], once: boolean): void {
  // The TUI cannot be hosted by a run that is about to stop, like the dashboard: a --once round
  // drains and exits within the same invocation, so the two shapes are refused together before
  // any boot. --for stays allowed — the TUI runs for the window, like the dashboard.
  if (once && args.includes("--tui"))
    failRivalShapes("--tui", "--once", "a one-round run cannot hold a TUI it is about to kill");
  // The dashboard cannot serve a run that is about to stop: a --once round drains and exits
  // within the same invocation, so the two shapes are refused together before any boot. --for
  // stays allowed — the dashboard serves for the window.
  if (once && args.includes("--gui"))
    failRivalShapes("--gui", "--once", "a one-round run cannot serve a dashboard it is about to kill");
}

/** Refuse the dashboard-only flags that name nothing without --gui. Owns the dashboard-only
 * refusals. */
function assertDashboardOnlyFlags(args: string[]): void {
  // `--port` chooses the `--gui` dashboard's port; without `--gui` it names no port for this
  // command, so refuse it (a valid value already passed the spec's shape gate) before any boot.
  if (args.includes("--port") && !args.includes("--gui"))
    fail(
      "--port is only valid with --gui (e.g. `tumwater start --gui --port 8080`); the standalone dashboard is `tumwater gui --port <n>`",
    );
  // `--all-interfaces` and `--token` are dashboard-only flags too: without `--gui` each names
  // nothing this command starts, so refuse them (valid values already passed the spec's shape
  // gate) before any boot, with the same shape as the --port refusal above and fixing the
  // copyable one-command form in the message.
  if (args.includes("--all-interfaces") && !args.includes("--gui"))
    fail(
      "--all-interfaces is only valid with --gui (e.g. `tumwater start --gui --all-interfaces`); the standalone dashboard is `tumwater gui --all-interfaces`",
    );
  if (args.includes("--token") && !args.includes("--gui"))
    fail(
      "--token is only valid with --gui (e.g. `tumwater start --gui --token s3cret`); the standalone dashboard is `tumwater gui --token <secret>`",
    );
}

/** Check the --token value and scrub `--token <value>` off this process's argv. Owns the --token
 * value check and the argv scrub. */
function handleTokenFlag(args: string[]): void {
  // A malformed --token (valueless, empty, or flag-looking) must fail here before any boot, so
  // a bad secret never leaves the team running behind a dashboard that exited. The same
  // tokenValueProblem `tumwater gui` runs, named for the one-command form the operator typed.
  const tokenProblem = tokenValueProblem(args, "tumwater start --gui");
  if (tokenProblem) fail(tokenProblem);
  // The supervisor (this process, when run without SUPERVISED_ENV) is long-lived and the OS
  // process table (ps, /proc/<pid>/cmdline) is world-readable, so an operator-typed secret must
  // not sit in this process's argv for the whole run. guiChildPlan has already extracted the
  // token into `plan.guiToken` for the dashboard child's env (see superviseDashboard), so take
  // `--token <value>` off the command line here — the env rides every spawn and reexecSelf
  // re-run, so no dashboard child or reloaded generation loses the gate — and say it is gone.
  const argvToken = process.argv.indexOf("--token");
  if (argvToken >= 0) {
    process.argv.splice(argvToken, 2);
    say(`removed --token from this process's command line; prefer the ${GUI_TOKEN_ENV} env var`);
  }
}

/** Parse the --role filter against the live config and guard it to --once rounds. Owns the
 * --role parse and its --once guard; the disabled/unknown guards stay separate (see below). */
function resolveRoleFilter(args: string[], config: TumwaterConfig, once: boolean): string[] | null {
  // A scoped once round: `--role <id>[,<id>...]` names the runners that run. Parsed here, where the
  // live config is readable. The parser accepts every known id (custom roles included, enabled
  // or not) so a typo still fails with the did-you-mean hint; an id that is known but has no
  // runner is then named as disabled rather than read as unknown — a scoped round that booted
  // a disabled role's runner would run nothing while claiming to serve the operator who just
  // queued that role a prompt. Daemon `run --role` stays an error: scoping is a once-round concept.
  const roleFilter = parseRoleListFlag(args, knownRoleIds(config));
  if (roleFilter !== null && !once) fail("--role is only valid with --once");
  return roleFilter;
}

/** Refuse --json without --once or --for, and the --gui/--tui rivals of a --json round/window.
 * Owns the --json mode refusals. */
function assertJsonMode(args: string[], json: boolean, once: boolean, forMs: number | null): void {
  if (json && !once && forMs === null) fail("--json is only valid with --once or --for");
  // Both interactive modes write their own banner to the stdout a JSON document must own, so a
  // --json round/window refuses them before any boot.
  if (json && args.includes("--gui"))
    failRivalShapes("--json", "--gui", "the dashboard writes its banner to the stdout a JSON document must own");
  if (json && args.includes("--tui"))
    failRivalShapes("--json", "--tui", "a TUI owns the terminal");
}

/** Guard a non-null --role filter against a disabled or unknown id. Owns the disabled/unknown
 * --role guards, firing after the --json mode refusals so the fire order upstream is unchanged. */
function assertRoleFilterRunnable(roleFilter: string[] | null, config: TumwaterConfig): void {
  if (roleFilter !== null) {
    const runners = runnerIds(config);
    const missing = roleFilter.find((id) => !runners.includes(id));
    if (missing !== undefined) {
      const base = baseRoleOf(missing);
      if (config.roles[base]?.enabled === false)
        fail(`${missing} is disabled, so a --once round cannot run it — enable it with \`tumwater role ${base} --enable\``);
      fail(unknownRoleMessage(missing, runners));
    }
  }
}

/** Refuse a second team in one repo by naming the running pid and the two ways to stop it. Owns
 * the already-running-orchestrator refusal. */
function assertNoRunningOrchestrator(root: string): void {
  // The refusal an operator hits by trying to start a second team in one repo: name the
  // running pid and the two ways to stop it, so the fix is in the message instead of a
  // separate `tumwater status`/help lookup. The info file is read once and reused for the
  // liveness check, like snapshot's own poll.
  const running = readOrchestratorInfo(root);
  if (running !== null && orchestratorAlive(root, running))
    fail(
      `an orchestrator is already running for this repo (pid ${running.pid}) — stop it with \`tumwater stop\` from another terminal, or press Ctrl+C in the terminal that started it`,
    );
}

/** Parse and validate the invocation before any team boots: the --tui/--gui/--json/--port/
 * --all-interfaces/--token/--role/--for/--branch guards, the --token argv scrub, runStartupCheck,
 * and the already-running-orchestrator refusal. Returns the resolved invocation. The per-job
 * guard groups each live in a named helper — assertOnceRivalFlags, assertDashboardOnlyFlags,
 * handleTokenFlag, resolveRoleFilter, assertJsonMode, assertRoleFilterRunnable and
 * assertNoRunningOrchestrator — called here in fire order. */
async function parseStartInvocation(root: string, args: string[]): Promise<StartInvocation> {
  const once = args.includes("--once");
  const json = args.includes("--json");
  assertOnceRivalFlags(args, once);
  assertDashboardOnlyFlags(args);
  handleTokenFlag(args);
  const forMs = parseRunWindow(args, once);
  const branchArg = parseBranchFlag(args);
  const startup = await runStartupCheck(root, branchArg);
  if ("problem" in startup) fail(startup.problem);
  const { config, mainBranch } = startup;
  const roleFilter = resolveRoleFilter(args, config, once);
  assertJsonMode(args, json, once, forMs);
  assertRoleFilterRunnable(roleFilter, config);
  assertNoRunningOrchestrator(root);
  return { once, json, forMs, branchArg, roleFilter, config, mainBranch };
}

/** Create the abort handle and the graceful-stop closure a supervised generation passes to
 * every watchdog, and register the SIGINT/SIGTERM handlers that trigger it. Returns an
 * `isStopping` query so the later once-exit check reads the live flag instead of a captured
 * boolean. */
function installStopHandlers(json: boolean): {
  controller: AbortController;
  stop: () => void;
  isStopping: () => boolean;
} {
  const controller = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    // A --once --json round's stdout must hold exactly its one JSON document, so a signal,
    // parent death, or scheduled stop quietens the stop prose too; the non-zero exit below
    // is what a cron/CI caller sees instead of the words. Non-json runs keep the prose.
    if (!json) say("\nstopping — finishing current runs (Ctrl+C again to force)");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { controller, stop, isStopping: () => stopping };
}

/** Arm the windowed run's deadline timer and the scheduled-stop watch, both of which run the
 * same graceful `stop` a Ctrl+C runs. Returns the window start and the two clearable handles. */
async function armRunWatchdogs(
  root: string,
  json: boolean,
  forMs: number | null,
  stop: () => void,
  isStopping: () => boolean,
): Promise<{ windowStart: number; deadlineTimer: { clear(): void } | null; scheduledStopWatch: { clear(): void } }> {
  const { RUN_WINDOW_START_ENV } = await import("../process/supervisor.js");
  // A windowed run's deadline arms the same graceful stop a Ctrl+C runs — the identical `stop`
  // closure, so the drain path is one code path either way. clearTimeout in the finally below
  // retracts it when the run ends first (an early Ctrl+C), so no stray timer outlives the run.
  const windowStart = inheritedWindowStart(process.env[RUN_WINDOW_START_ENV], Date.now());
  const deadlineTimer = forMs !== null ? armDeadlineTimer(Math.max(0, windowStart + forMs - Date.now()), () => {
    // A --for --json window's stdout must hold exactly its one JSON document, so the deadline
    // prose is suppressed too; the document's non-zero-absent facts carry the window.
    if (!json) say("deadline reached — stopping");
    stop();
  }) : null;
  const scheduledStopWatch = armScheduledStopWatch(root, () => {
    if (!isStopping()) stop(); // A drain already under way must not be turned into a force-kill.
  }, json);
  return { windowStart, deadlineTimer, scheduledStopWatch };
}

/** Persist the baseline verdicts and boot the once-gated redeployer and launch-services watch. */
async function bootGenerationParts(root: string, branchArg: string | null, once: boolean) {
  // Main's green verdicts outlive this generation: the redeployer and baseline's surviving readers
  // (`mainTipVerdict`, the ci hand-off's `mainRedHealNote`) start from the ones the previous
  // generation verified instead of re-running the suite.
  (await import("../baseline/main-baseline.js")).persistBaselineVerdicts(root);
  // A once round never self-redeploys: it runs one round on the build it booted and exits,
  // so the hand-off machinery (and its build stamp) stays daemon-only.
  const redeploy = once
    ? null
    : await (await import("../redeploy/redeploy.js")).createRedeployer(root, (e) => logEvent(root, e), () => runStartupProblem(root, branchArg));
  // A long-running team watches launchservicesd's port count (a no-op off macOS); a once round
  // is over long before a leak could matter.
  const launchServicesWatch = once ? null : new (await import("../process/launch-services.js")).LaunchServicesWatch(root);
  return { redeploy, launchServicesWatch };
}

/** Print the supervised generation's banner and subscribe to its event stream on non-json runs. */
function announceGeneration(
  roles: string[],
  mainBranch: string,
  once: boolean,
  json: boolean,
  forMs: number | null,
  root: string,
  build: string,
): () => void {
  // Name the resolved root when it differs from the cwd: an operator who started the team
  // from a subdirectory must see where .tumwater/ actually lives.
  const rootNote = root !== process.cwd() ? ` · root ${root}` : "";
  const forNote = forMs !== null ? ` · for ${durationLabel(forMs)}` : "";
  // A --once --json round's stdout must hold exactly its one JSON document, so its banner
  // and event stream are suppressed: the caller parses the round's facts directly instead
  // of the prose, and the orchestrator/merge pipeline logs events through logEvent (file
  // plus subscription), not stdout, with nothing else printed on stdout for a once round.
  if (!json) {
    say(
      once
        ? `tumwater once on branch ${mainBranch}${rootNote} — one round, then exit`
        : `tumwater running on branch ${mainBranch}${forNote}${build}${rootNote} — Ctrl+C to stop`,
    );
    say(`roles: ${roles.join(", ")}`);
    say("watch: `tumwater tui` or `tumwater logs -f` in another terminal; events stream below\n");
  }
  return json ? () => {} : subscribeEvents((e) => say(formatEvent(e)));
}

/** Print the round summary: the once report/summary, or a windowed run's window report. */
function printRoundSummary(
  root: string,
  roles: string[],
  runsBefore: Map<string, number>,
  once: boolean,
  json: boolean,
  forMs: number | null,
  windowStart: number,
  settled: ReadonlyMap<string, string> | undefined,
  runsDone: ReadonlyMap<string, number> | undefined,
  restart: boolean,
): void {
  if (once) {
    if (json) sayJson(onceReport(root, roles, runsBefore, settled, runsDone));
    else say(onceSummary(root, roles, runsBefore, settled, runsDone));
  } else if (forMs !== null && !restart) {
    const { rows, covered } = readRunRowsSince(root, Date.now() - windowStart, null);
    const summary = summarizeRunRows(rows);
    if (json) sayJson(windowReport(durationLabel(forMs), summary, covered));
    else say(windowSummary(durationLabel(forMs), summary, covered));
  }
}

/** Set the process exit code for a once round that failed or was cut short before completion. */
async function applyOnceExitCode(
  root: string,
  roles: string[],
  runsBefore: Map<string, number>,
  runsDone: ReadonlyMap<string, number> | undefined,
  once: boolean,
  json: boolean,
  isStopping: () => boolean,
): Promise<void> {
  const { ONCE_FAILED_EXIT_CODE } = await import("../process/supervisor.js");
  if (once) {
    const failures = onceFailures(root, roles, runsBefore, runsDone);
    if (failures.length > 0) {
      // In --json mode the failure facts already ride in the report's `failures`; the exit
      // code is the contract a CI caller needs, so only the prose line is suppressed.
      if (!json) say(`once: failed — ${failures.map((f) => `${f.role} ${f.result}`).join(", ")}`);
      process.exitCode = ONCE_FAILED_EXIT_CODE;
    }
    // A round a signal, parent death, or scheduled stop cut short before it completed must
    // not read as success (0) to the CI caller parsing the JSON: the document still carries
    // the round's partial facts, but the truncated round exits non-zero. Non-json once keeps
    // its historical behavior (prose + 0 unless a role failed).
    if (json && isStopping()) process.exitCode = ONCE_FAILED_EXIT_CODE;
  }
}

/** Boot the supervised generation: the stop closure and SIGINT/SIGTERM handlers, the --for
 * deadline timer and scheduled-stop watch, the parent-death watch, the baseline/redeploy/
 * launch-services imports, the banner, the event subscription, runOrchestrator, and the
 * once/window summaries and exit codes. */
async function runSupervisedGeneration(input: SupervisedGenerationInput): Promise<void> {
  const { root, once, json, forMs, branchArg, roleFilter, config, mainBranch } = input;
  const { startParentDeathWatch, expectedSupervisorPid } = await import("../process/supervisor.js");
  const { controller, stop, isStopping } = installStopHandlers(json);
  const { windowStart, deadlineTimer, scheduledStopWatch } = await armRunWatchdogs(root, json, forMs, stop, isStopping);
  // A supervisor that dies without forwarding — SIGKILL (the OOM killer, `kill -9`) cannot be
  // trapped or forwarded, and an uncaught supervisor crash forwards nothing either — leaves this
  // generation reparented and running the team unattended. The parent-death watch polls for the
  // reparent and runs the same graceful stop a forwarded SIGTERM would have run, so a killed
  // supervisor takes its team down with it (BUGS.md 2026-09-30). The spawner hands its pid
  // down (SUPERVISOR_PID_ENV), so a supervisor killed during this child's startup — before the
  // watch's first ppid read — still counts as gone. Everything below runs only in
  // the supervised generation: an unsupervised `run` became the supervisor above and returned.
  const expectedPpid = expectedSupervisorPid();
  startParentDeathWatch(stop, expectedPpid !== undefined ? { expectedPpid } : {});
  const enabled = runnerIds(config);
  // A scoped round's role list is exactly the filter; otherwise every enabled role runs.
  const roles = roleFilter ?? enabled;
  const { redeploy, launchServicesWatch } = await bootGenerationParts(root, branchArg, once);
  const build = redeploy ? ` · build ${shortSha(redeploy.build.sha)}` : "";
  const unsubscribe = announceGeneration(roles, mainBranch, once, json, forMs, root, build);
  // Snapshot each role's run counter so the once summary can tell this round's runs from
  // the persisted history (the state file accumulates across rounds).
  await runStartupMigrations(root); // so the snapshot reads a migrated state/<new>.json
  const runsBefore = new Map(roles.map((role) => [role, loadRunnerState(root, role).runs] as const));
  let exit;
  try {
    exit = await (await import("../orchestrator/orchestrator.js")).runOrchestrator({
      root,
      config,
      mainBranch,
      signal: controller.signal,
      redeploy,
      launchServicesWatch,
      once,
      roleFilter: roleFilter ?? undefined,
      stopsAt: forMs !== null ? windowStart + forMs : undefined,
    });
  } finally {
    if (deadlineTimer) deadlineTimer.clear();
    scheduledStopWatch.clear();
    unsubscribe();
  }
  printRoundSummary(root, roles, runsBefore, once, json, forMs, windowStart, exit.settled, exit.runsDone, exit.restart);
  await applyOnceExitCode(root, roles, runsBefore, exit.runsDone, once, json, isStopping);
  // A self-redeploy swapped the new build into dist/: hand the terminal back to the supervisor,
  // which respawns this same script — now the new code — as the next generation.
  if (exit.restart) process.exit(RESTART_EXIT_CODE);
  // A windowed (--for) run that did not self-redeploy is done the moment its summary is out:
  // exit deterministically instead of trusting the event loop to drain. This supervised
  // generation runs a whole team, and any ref'd handle a shutdown missed (a watcher, marker,
  // or notifier handle a join missed) would otherwise pin this process's loop open, so the
  // supervisor — which waits on this child's exit — never exits and the run reads as a hang:
  // summary printed, exit code null (BUGS.md 2026-10-26). The summary above was the last
  // output and nothing after depends on this loop, so an explicit exit is equivalent to the
  // natural exit 0 this replaces, just guaranteed.
  if (forMs !== null) process.exit(0);
}

/** `tumwater start`: boot the team and stream its event feed to this terminal until it stops.
 * Three layers cooperate here: without SUPERVISED_ENV this process becomes the supervisor
 * (src/cli/cli-start-supervisor.ts's superviseStartCommand), spawning the real orchestrator as a
 * child generation; the child
 * runs runOrchestrator to completion, handing the terminal back via RESTART_EXIT_CODE after a
 * self-redeploy so the supervisor respawns on the new build; --once collapses the whole thing
 * into one round of runs and a summary line (onceSummary below), for cron-style invocations.
 * `--for <duration>` keeps the daemon shape (redeployer, LaunchServicesWatch, supervisor hand-off
 * all stay) but arms a deadline: at the deadline the same graceful stop a Ctrl+C runs fires, and
 * the process exits after printing the summary. A mid-run self-redeploy hands the same args
 * (including `--for`) to the supervisor's next child, and the supervisor hands every generation
 * the same window start (RUN_WINDOW_START_ENV), so the deadline and the summary span the whole
 * window; only the final exit prints the summary. */
export async function cmdStart(root: string, args: string[]): Promise<void> {
  // The one function the self-redeploy asks before swapping onto a successor and the supervisor
  // asks when a generation dies, so the three cannot disagree about what boots. The supervisor
  // half runs it too, so a start that cannot boot fails before any child spawns. The flag
  // vocabulary is validated by the dispatcher (cli.ts, from the same START_FLAG_SPECS).
  const { once, json, forMs, branchArg, roleFilter, config, mainBranch } = await parseStartInvocation(root, args);
  // The team-booting machinery loads only once a run actually boots: the orchestrator's
  // module graph (with its merge pipeline, review gate, and scheduler) is the CLI's heaviest
  // compile, and the supervisor/redeploy/launch-services pieces ride beside it. Loading them
  // dynamically, after the fail-fast gates above, keeps every other command's spawn — and
  // `run`'s fail-fast paths — off that cost (see cli.ts's matching lazy dispatch).
  const supervisor = await import("../process/supervisor.js");
  if (!process.env[supervisor.SUPERVISED_ENV]) {
    // `args` are the flags after the command token — forward them so the child generation
    // targets the same branch (or whatever else the invocation named).
    // A stop marker left by a team that died before its deadline must not stop this run.
    cancelScheduledStop(root);
    await superviseStartCommand(root, args, branchArg, forMs);
    return;
  }
  await runSupervisedGeneration({ root, config, mainBranch, branchArg, once, json, forMs, roleFilter });
}

/** Arm the windowed run's deadline timer: the one home of the arming `cmdStart` does for
 * `run --for <duration>`. A duration over setTimeout's own 32-bit signed ceiling
 * (2_147_483_647 ms ≈ 24.8 days) is clamped by Node to 1ms with a TimeoutOverflowWarning, so
 * a raw setTimeout would fire the deadline the instant the run booted — and `run --for`
 * accepts durations up to the 90-day pause cap (PAUSE_FOR_MAX_MS), so overflow is an ordinary
 * input, not an error. The timer is therefore armed in ≤32-bit chunks: each setTimeout covers
 * at most the ceiling, and a chunk that expires with time still left re-arms for the
 * remainder, so the callback runs exactly once, after the full duration, whatever its size.
 * Returns a clear() handle (the finally in cmdStart retracts the timer when the run ends first —
 * an early Ctrl+C — so no stray timer outlives the run); clear() is safe after the callback
 * has run. Exported for tests. */
export function armDeadlineTimer(ms: number, onFired: () => void): { clear(): void } {
  const MAX_TIMEOUT_MS = 2_147_483_647;
  let timer: NodeJS.Timeout;
  const arm = (remaining: number): void => {
    const slice = Math.min(remaining, MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      if (remaining > slice) arm(remaining - slice);
      else onFired();
    }, slice);
  };
  arm(ms);
  return { clear: () => clearTimeout(timer) };
}

const SCHEDULED_STOP_POLL_MS = 5000;

/** Poll for a `tumwater stop --in` marker: once its `until` has passed, consume the marker,
 * stop polling, and call `onStop` (cmdStart's Ctrl+C closure) exactly once. The interval is
 * unref'd; clear() retracts it. Exported for tests. */
export function armScheduledStopWatch(root: string, onStop: () => void, quiet = false): { clear(): void } {
  const timer = setInterval(() => {
    const at = scheduledStopAt(root);
    if (at === undefined || at > Date.now()) return;
    clearInterval(timer);
    cancelScheduledStop(root);
    // quiet suppresses the "scheduled stop reached" prose for a --once --json round so its
    // stdout holds exactly the one JSON document; the non-zero exit carries the interruption.
    if (!quiet) say("scheduled stop reached — stopping");
    onStop();
  }, SCHEDULED_STOP_POLL_MS);
  timer.unref();
  return { clear: () => clearInterval(timer) };
}

