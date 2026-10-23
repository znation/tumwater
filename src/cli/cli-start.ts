/** `tumwater start`'s implementation, with its supervisor half (src/process/supervisor.ts).
 * cli.ts stays the pure dispatcher; `tumwater init` lives in cli/cli-init.ts and every other
 * command it dispatches delegates to its own module (operator/operator-commands.ts,
 * prompt-commands.ts, config-commands.ts, log-commands.ts, doctor.ts, …). */
import type { StdioOptions } from "node:child_process";
import { compareCodeUnits } from "../collections.js";
import { baseRoleOf, runnerIds, runnerPaused } from "../roles/runner-ids.js";
import { knownRoleIds } from "../config/config.js";
import { unknownRoleMessage } from "../roles/roles.js";
import { fail, say, sayJson } from "./cli-output.js";
import {
  durationLabel,
  failOverDurationCap,
  failRivalShapes,
  flagValue,
  parseBranchFlag,
  parseDurationFlag,
  parsePortFlag,
  parseRoleListFlag,
  tokenValueProblem,
} from "./cli-args.js";
import { PAUSE_FOR_MAX_MS } from "../operator/operator-intent.js";
import { cancelScheduledStop, isTeamPaused, pausedRoles, scheduledStopAt } from "../team/team-state.js";
import { orchestratorAlive, readOrchestratorInfo } from "../team/orchestrator-info.js";
import { runStartupCheck, runStartupProblem } from "../gates/startup-gate.js";
import { repairInterruptedSwap } from "../build/build-stage.js";
import { logEvent, subscribeEvents } from "../events/events.js";
import { notifyTeamDown } from "../events/notify.js";
import { formatEvent } from "../events/event-format.js";
import { RESTART_EXIT_CODE } from "../redeploy/redeploy-policy.js";
import type { RunResult } from "../run/run-outcome.js";
import { runStartupMigrations } from "../orchestrator/startup-migration-steps.js";
import { stateSkipReason, type RunnerState } from "../runner/runner-state.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { plural } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { readRunRowsSince, summarizeRunRows, type HistorySummaryRow } from "../history/history-data.js";
import { renderSummary } from "../history/history-render.js";
import { SPARSE_WINDOW_NOTE } from "../events/event-window.js";

/** `tumwater start`: boot the team and stream its event feed to this terminal until it stops.
 * Three layers cooperate here: without SUPERVISED_ENV this process becomes the supervisor
 * (superviseStartCommand below), spawning the real orchestrator as a child generation; the child
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
  const once = args.includes("--once");
  const json = args.includes("--json");
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
  // A malformed --token (valueless, empty, or flag-looking) must fail here before any boot, so
  // a bad secret never leaves the team running behind a dashboard that exited. The same
  // tokenValueProblem `tumwater gui` runs, named for the one-command form the operator typed.
  const tokenProblem = tokenValueProblem(args, "tumwater start --gui");
  if (tokenProblem) fail(tokenProblem);
  const forMs = parseRunWindow(args, once);
  const branchArg = parseBranchFlag(args);
  const startup = await runStartupCheck(root, branchArg);
  if ("problem" in startup) fail(startup.problem);
  const { config, mainBranch } = startup;
  // A scoped once round: `--role <id>[,<id>...]` names the runners that run. Parsed here, where the
  // live config is readable. The parser accepts every known id (custom roles included, enabled
  // or not) so a typo still fails with the did-you-mean hint; an id that is known but has no
  // runner is then named as disabled rather than read as unknown — a scoped round that booted
  // a disabled role's runner would run nothing while claiming to serve the operator who just
  // queued that role a prompt. Daemon `run --role` stays an error: scoping is a once-round concept.
  const roleFilter = parseRoleListFlag(args, knownRoleIds(config));
  if (roleFilter !== null && !once) fail("--role is only valid with --once");
  if (json && !once && forMs === null) fail("--json is only valid with --once or --for");
  // Both interactive modes write their own banner to the stdout a JSON document must own, so a
  // --json round/window refuses them before any boot.
  if (json && args.includes("--gui"))
    failRivalShapes("--json", "--gui", "the dashboard writes its banner to the stdout a JSON document must own");
  if (json && args.includes("--tui"))
    failRivalShapes("--json", "--tui", "a TUI owns the terminal");
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
  // The refusal an operator hits by trying to start a second team in one repo: name the
  // running pid and the two ways to stop it, so the fix is in the message instead of a
  // separate `tumwater status`/help lookup. The info file is read once and reused for the
  // liveness check, like snapshot's own poll.
  const running = readOrchestratorInfo(root);
  if (running !== null && orchestratorAlive(root, running))
    fail(
      `an orchestrator is already running for this repo (pid ${running.pid}) — stop it with \`tumwater stop\` from another terminal, or press Ctrl+C in the terminal that started it`,
    );
  // The team-booting machinery loads only once a run actually boots: the orchestrator's
  // module graph (with its merge pipeline, review gate, and scheduler) is the CLI's heaviest
  // compile, and the supervisor/redeploy/launch-services pieces ride beside it. Loading them
  // dynamically, after the fail-fast gates above, keeps every other command's spawn — and
  // `run`'s fail-fast paths — off that cost (see cli.ts's matching lazy dispatch).
  const { SUPERVISED_ENV, RUN_WINDOW_START_ENV, ONCE_FAILED_EXIT_CODE, startParentDeathWatch, expectedSupervisorPid } = await import("../process/supervisor.js");
  if (!process.env[SUPERVISED_ENV]) {
    // `args` are the flags after the command token — forward them so the child generation
    // targets the same branch (or whatever else the invocation named).
    // A stop marker left by a team that died before its deadline must not stop this run.
    cancelScheduledStop(root);
    await superviseStartCommand(root, args, branchArg, forMs);
    return;
  }
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
    if (!stopping) stop(); // A drain already under way must not be turned into a force-kill.
  }, json);
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
  // Main's green verdicts outlive this generation: the redeployer and the roles' red-main gate
  // start from the ones the previous generation verified instead of re-running the suite.
  (await import("../baseline/main-baseline.js")).persistBaselineVerdicts(root);
  // A once round never self-redeploys: it runs one round on the build it booted and exits,
  // so the hand-off machinery (and its build stamp) stays daemon-only.
  const redeploy = once
    ? null
    : await (await import("../redeploy/redeploy.js")).createRedeployer(root, (e) => logEvent(root, e), () => runStartupProblem(root, branchArg));
  const build = redeploy ? ` · build ${shortSha(redeploy.build.sha)}` : "";
  // A long-running team watches launchservicesd's port count (a no-op off macOS); a once round
  // is over long before a leak could matter.
  const launchServicesWatch = once ? null : new (await import("../process/launch-services.js")).LaunchServicesWatch(root);
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
  const unsubscribe = json ? () => {} : subscribeEvents((e) => say(formatEvent(e)));
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
  if (once) {
    if (json) sayJson(onceReport(root, roles, runsBefore, exit.settled, exit.runsDone));
    else say(onceSummary(root, roles, runsBefore, exit.settled, exit.runsDone));
  } else if (forMs !== null && !exit.restart) {
    const { rows, covered } = readRunRowsSince(root, Date.now() - windowStart, null);
    const summary = summarizeRunRows(rows);
    if (json) sayJson(windowReport(durationLabel(forMs), summary, covered));
    else say(windowSummary(durationLabel(forMs), summary, covered));
  }
  if (once) {
    const failures = onceFailures(root, roles, runsBefore, exit.runsDone);
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
    if (json && stopping) process.exitCode = ONCE_FAILED_EXIT_CODE;
  }
  // A self-redeploy swapped the new build into dist/: hand the terminal back to the supervisor,
  // which respawns this same script — now the new code — as the next generation.
  if (exit.restart) process.exit(RESTART_EXIT_CODE);
}

/** The window start a generation adopts: the supervisor's RUN_WINDOW_START_ENV mark when it is a
 * positive integer no later than `now`, else `now` (absent, malformed, or in the future). */
export function inheritedWindowStart(raw: string | undefined, now: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 && n <= now ? n : now;
}

/** The `run --for` exit summary: a window line, then the `history --summary` table for the runs
 * that ended since the window opened — every run counted once by its outcome class. Only the
 * final exit prints it; a mid-window self-redeploy hands off silently and the next generation
 * inherits the window start, so the table spans every generation. */
export function windowSummary(label: string, summary: { roles: HistorySummaryRow[]; total: HistorySummaryRow }, covered: boolean): string {
  const { total } = summary;
  const lines = [
    total.runs === 0
      ? `for ${label}: 0 runs — nothing ran`
      : `for ${label}: ${plural(total.runs, "run")} — ${total.changes} changes, ${total.none} none, ${total.refused} refused, ${total.problems} problems`,
  ];
  if (total.runs > 0) lines.push(renderSummary(summary));
  if (!covered) lines.push(SPARSE_WINDOW_NOTE);
  return lines.join("\n");
}

/** The `run --for --json` exit summary: the windowed run's per-role tally as one JSON object a
 * script parses, mirroring `windowSummary`'s rendering of the same rows. Unlike `windowSummary`
 * it never appends `SPARSE_WINDOW_NOTE` — `covered: false` is the fact a caller reads. */
export interface WindowReport {
  window: string;
  covered: boolean;
  roles: HistorySummaryRow[];
  total: HistorySummaryRow;
}

/** Build the `run --for --json` window report from the same summary `windowSummary` renders. */
export function windowReport(label: string, summary: { roles: HistorySummaryRow[]; total: HistorySummaryRow }, covered: boolean): WindowReport {
  return { window: label, covered, roles: summary.roles, total: summary.total };
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

/** Parse `run --for <duration>` (the windowed run): the parsed duration in milliseconds, or null
 * when the flag is absent. The two body-level rules fail fast, before any repo gate or boot: the
 * value must parse as a duration (parseDurationFlag's own wording, the same messages the
 * dispatcher's durationFlagSpec("run --for") gate already ran), and `--for` and `--once` are rivals
 * — a one-round run and a windowed run cannot both apply. The 90-day ceiling is `pause --for`'s
 * (PAUSE_FOR_MAX_MS), the same cap every scheduled window in the harness honors. Exported for
 * tests, exactly as onceSummary below is. */
export function parseRunWindow(args: string[], once: boolean): number | null {
  const raw = flagValue(args, "--for");
  if (raw === null) return null;
  const ms = parseDurationFlag("start --for", raw);
  if (once) failRivalShapes("--for", "--once", "a one-round run and a windowed run cannot both apply");
  failOverDurationCap("--for", ms, PAUSE_FOR_MAX_MS);
  return ms;
}

/** Results that mean the harness or the project's check failed and the round's work did not
 * merge: a `--once` round with a role ending in one exits ONCE_FAILED_EXIT_CODE. `rejected` and
 * `refused` are the review gate and the agent working as designed; `aborted`, `quiet_killed`, and
 * `user_aborted` only reach a once round on a shutdown or operator abort, which exit
 * their own way. */
export const ONCE_FAILURE_RESULTS: ReadonlySet<RunResult> = new Set<RunResult>([
  "error",
  "review_error",
  "merge_conflict",
  "merge_blocked",
  "main_red",
]);

function runsThisRound(
  s: { runs: number },
  role: string,
  runsBefore: Map<string, number>,
  runsDone?: ReadonlyMap<string, number>,
): number {
  return runsDone ? (runsDone.get(role) ?? 0) : s.runs - (runsBefore.get(role) ?? 0);
}

/** Every role that could have run in this once round — `roles` in order plus any role that
 * appears only in `runsDone` (enabled mid-round after `runsBefore` was taken) — paired with
 * its loaded role state and the number of runs it made this round. The same per-role setup
 * onceFailures and onceSummary both repeat, folded here so the two summary passes cannot
 * drift on which roles they visit or how they count a round's work. */
function onceRoundRoles(
  root: string,
  roles: string[],
  runsBefore: Map<string, number>,
  runsDone?: ReadonlyMap<string, number>,
): { role: string; state: RunnerState; ran: number }[] {
  const extra = runsDone ? [...runsDone.keys()].filter((r) => !roles.includes(r)) : [];
  return [...roles, ...extra].map((role) => {
    const state = loadRunnerState(root, role);
    return { role, state, ran: runsThisRound(state, role, runsBefore, runsDone) };
  });
}

/** The roles that ran this round and whose last result is in ONCE_FAILURE_RESULTS. */
export function onceFailures(
  root: string,
  roles: string[],
  runsBefore: Map<string, number>,
  runsDone?: ReadonlyMap<string, number>,
): { role: string; result: RunResult }[] {
  const out: { role: string; result: RunResult }[] = [];
  for (const { role, state, ran } of onceRoundRoles(root, roles, runsBefore, runsDone)) {
    if (ran > 0 && state.lastResult && ONCE_FAILURE_RESULTS.has(state.lastResult)) {
      out.push({ role, result: state.lastResult });
    }
  }
  return out;
}

/** The once round's structured facts — read from the runners' persisted role state plus the
 * orchestrator's own settle reasons — that both the one-line summary and the `--json` document
 * render from, so a cron/CI caller parses the round directly instead of scraping the prose.
 * `runs` is the round's total run count; `outcomes` maps each result a ran role ended on
 * (`lastResult ?? "no_change"`) to how many; `skipped` carries each role that made no run this
 * round with the reason it was settled (`paused`, `resume pending`, `backoff`, `deferred`,
 * `disabled`, `idle` — the same classification onceSummary derives); and `failures` is
 * onceFailures verbatim. */
interface OnceReport {
  runs: number;
  outcomes: Record<string, number>;
  skipped: { role: string; reason: string }[];
  failures: { role: string; result: RunResult }[];
}

/** The once round's one-line summary, read from the runners' persisted role state plus the
 * orchestrator's own settle reasons — a cron job's log shows what the round did without parsing
 * events. Roles whose run counter advanced bucket by their last completed result; the rest are
 * skipped with the reason the orchestrator settled them for (`paused`, `resume pending`,
 * `backoff`, `deferred`, `disabled`, `idle` — handed back on OrchestratorExit.settled, so a
 * deferred role reads as set aside, not as "nothing was due"); a role the map lacks (defensively
 * — the round only exits once every role is settled) falls back to deriving the reason from
 * state: a pause marker when one is held, a pending resume when one is flagged, backoff when
 * `backoffSeconds` is raised, otherwise idle — the same classification settleSkipped draws,
 * and keyed on the same signal: backoffSeconds is the backoff indicator, while nextRunAt is
 * shared with the scheduled clock a productive run also writes (with backoffSeconds 0), so a
 * future nextRunAt alone reads as a not-yet-due role, not as backoff (BUGS.md 2026-09-25,
 * the same conflation settleSkipped itself carried).
 *
 * `runsDone`, when the caller hands it back (the orchestrator's OnceRound snapshot deltas),
 * is the run count's source of truth and also names roles the pre-round list never had —
 * a role enabled mid-round joins the runners array after `runsBefore` was taken, so its
 * whole persisted history must not be counted as this round's work. Without it the old
 * `runsBefore` delta path runs, for callers (and tests) without a round object. */
export function onceReport(
  root: string,
  roles: string[],
  runsBefore: Map<string, number>,
  settled: ReadonlyMap<string, string> | undefined,
  runsDone?: ReadonlyMap<string, number>,
): OnceReport {
  const report: OnceReport = {
    runs: 0,
    outcomes: {},
    skipped: [],
    failures: onceFailures(root, roles, runsBefore, runsDone),
  };
  for (const { role, state, ran } of onceRoundRoles(root, roles, runsBefore, runsDone)) {
    if (ran > 0) {
      report.runs += ran;
      const key = state.lastResult ?? "no_change";
      report.outcomes[key] = (report.outcomes[key] ?? 0) + 1;
    } else {
      const reason =
        settled?.get(role) ??
        (isTeamPaused(root) || runnerPaused(new Set(pausedRoles(root)), role)
          ? "paused"
          : stateSkipReason(state));
      report.skipped.push({ role, reason });
    }
  }
  return report;
}

/** The once round's one-line summary — the composition of onceReport and renderOnceSummary,
 * kept as a single function so its exported signature (and every caller and test) stays
 * unchanged while the `--json` document renders the same facts structurally. */
export function onceSummary(
  root: string,
  roles: string[],
  runsBefore: Map<string, number>,
  settled: ReadonlyMap<string, string> | undefined,
  runsDone?: ReadonlyMap<string, number>,
): string {
  return renderOnceSummary(onceReport(root, roles, runsBefore, settled, runsDone));
}

/** Render a OnceReport back to the once round's one-line prose summary — the exact line a
 * `tumwater start --once` (no `--json`) operator's log keeps. Results are counted in
 * compareCodeUnits-sorted key order. The comparator makes that explicit: a comparator-less
 * sort would order key/value pairs by their "key,count" string form, which happens to agree
 * only while each key is unique. */
export function renderOnceSummary(report: OnceReport): string {
  const counts = Object.entries(report.outcomes)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  const skipNote =
    report.skipped.length === 0 ? "" : `, ${report.skipped.length} skipped (${report.skipped.map((s) => s.reason).join(", ")})`;
  return `once: ${plural(report.runs, "run")} — ${counts || "nothing ran"}${skipNote}`;
}

/** Split `run`'s args for `run --gui` and `run --tui`: whether the supervisor should also start
 * the dashboard and/or host the observer TUI, and the args the supervised orchestrator
 * generation gets with both stripped so the generation's own cmdStart never tries to supervise a
 * second dashboard or re-attach a TUI in a terminal the parent owns (a self-redeploy spawns a
 * fresh generation each time). Exported so the unit tests pin the stripping that removing the
 * spawn wiring would otherwise silently drop. */
export function guiChildPlan(runArgs: string[]): {
  spawnGui: boolean;
  spawnTui: boolean;
  /** The dashboard flags the child gets (`["--port", N]` then `["--all-interfaces"]` then
   * `["--token", <secret>]` when given), threaded into spawnGuiChild so a one-command
   * `run --gui` serves the dashboard exactly as a direct `tumwater gui` invocation would. The
   * port is parsed here (parsePortFlag has already run its shape gate on the dispatcher, so
   * this is the same value re-typed for the child). */
  guiArgs: string[];
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
  if (tokenRaw !== undefined) guiArgs.push("--token", tokenRaw);
  return {
    spawnGui: runArgs.includes("--gui"),
    spawnTui: runArgs.includes("--tui"),
    guiArgs,
    orchestratorArgs: runArgs.filter(
      (arg, i) => arg !== "--gui" && arg !== "--tui" && arg !== "--all-interfaces" && !skip.has(i),
    ),
    childStdio: runArgs.includes("--tui") ? ["ignore", "ignore", "ignore"] : "inherit",
  };
}

/** The dashboard half of `run --gui`: keep a `tumwater gui` child alive across its own
 * self-reloads. The child is marked with DASHBOARD_CHILD_ENV naming this supervisor, so its
 * reload watch (src/redeploy/self-reload.ts) exits RESTART_EXIT_CODE for a fresh sibling on a
 * redeploy and exits on its own if this supervisor dies outright (SIGKILL, a crash) — a killed
 * supervisor never leaves a dashboard holding its port. Any other dashboard exit (a failed bind
 * prints its own message and exits) ends this loop and leaves the team running. */
async function superviseDashboard(signal: AbortSignal, stdio: StdioOptions = "inherit", guiArgs: string[] = []): Promise<void> {
  const { DASHBOARD_CHILD_ENV } = await import("../redeploy/self-reload.js");
  const { spawnGuiChild } = await import("../process/supervisor.js");
  for (;;) {
    const exit = await spawnGuiChild(signal, { [DASHBOARD_CHILD_ENV]: String(process.pid) }, stdio, guiArgs);
    if (signal.aborted || exit.code !== RESTART_EXIT_CODE) return;
  }
}

/** The supervisor half of `tumwater start` (src/process/supervisor.ts): spawn the orchestrator as a
 * child generation and respawn it whenever it exits RESTART_EXIT_CODE after redeploying itself.
 * Ctrl+C reaches the child directly from the terminal, so only SIGTERM is forwarded; the
 * supervisor's own exit code is whatever the last generation's was. A team that goes down without
 * the operator asking leaves a `supervisor_exit` event behind (BUGS.md 2026-09-23): the dead
 * generation's stderr reached only this terminal, which nobody may be watching. */
async function superviseStartCommand(root: string, runArgs: string[], branchArg: string | null, forMs: number | null): Promise<void> {
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
  const gui = plan.spawnGui ? superviseDashboard(guiController.signal, plan.childStdio, plan.guiArgs) : Promise.resolve();
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
