// vocabulary: plain
/** The fleet-booting commands' implementations: `tumwater init` and `tumwater run` — the latter
 * with its supervisor half (src/process/supervisor.ts). cli.ts stays the pure dispatcher; every
 * other command it dispatches already delegates to a module (operator/operator-commands.ts,
 * prompt-commands.ts, config-commands.ts, log-commands.ts, doctor.ts, …), and these three were
 * the only implementations living in the dispatcher itself. */
import type { StdioOptions } from "node:child_process";
import { compareCodeUnits, increment } from "../collections.js";
import { loopIds } from "../roles/loop-ids.js";
import { fail, say } from "./cli-output.js";
import {
  durationLabel,
  failOverDurationCap,
  failRivalShapes,
  flagValue,
  parseBranchFlag,
  parseDurationFlag,
  parseRoleFlag,
} from "./cli-args.js";
import { PAUSE_FOR_MAX_MS } from "../operator/operator-intent.js";
import { parseInitArgs } from "./cli-command-args.js";
import { cancelScheduledStop, isFleetPaused, pausedRoles, scheduledStopAt } from "../fleet/fleet-state.js";
import { orchestratorAlive, readOrchestratorInfo } from "../fleet/orchestrator-info.js";
import { runStartupCheck, runStartupProblem } from "../gates/startup-gate.js";
import { initProject } from "../init/init.js";
import { templateCatalog } from "../init/init-templates.js";
import { repairInterruptedSwap } from "../build/build-stage.js";
import { logEvent, subscribeEvents } from "../events/events.js";
import { notifyFleetDown } from "../events/notify.js";
import { formatEvent } from "../events/event-format.js";
import { RESTART_EXIT_CODE } from "../redeploy/redeploy-policy.js";
import type { TickResult } from "../tick/tick-outcome.js";
import { loadLoopState, stateSkipReason } from "../loop/loop-state.js";
import { plural } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { readTickRowsSince, summarizeTickRows, type HistorySummaryRow } from "../history/history-data.js";
import { renderSummary } from "../history/history-render.js";
import { SPARSE_WINDOW_NOTE } from "../events/event-window.js";

/** `tumwater init`: seed a project directory from the operator's brief (src/init/init.ts does the
 * work; this prints the report). --dry-run prints the would-be actions without writing
 * anything; an already-initialized repo is reported as a no-op, never an error. */
export async function cmdInit(root: string, args: string[]): Promise<void> {
  const { prompt, branch, template, listTemplates, adopt, dryRun } = parseInitArgs(args);
  if (listTemplates) {
    for (const { id, description } of templateCatalog()) say(`${id} — ${description}`);
    return;
  }
  const result = await initProject(root, prompt, branch ?? undefined, {
    adopt,
    dryRun,
    template: template ?? undefined,
  });
  if (result.template !== "blank") say(`template: ${result.template}`);
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
  if (result.bootstrap !== null) {
    say(
      `fresh project — maintenance roles wait until ${result.bootstrap} plans are done; remove "bootstrap" from tumwater.json to end that early`,
    );
  }
  say("next: `tumwater start` in one terminal, `tumwater tui` in another");
}

/** `tumwater run`: boot the fleet and stream its event feed to this terminal until it stops.
 * Three layers cooperate here: without SUPERVISED_ENV this process becomes the supervisor
 * (superviseRunCommand below), spawning the real orchestrator as a child generation; the child
 * runs runOrchestrator to completion, handing the terminal back via RESTART_EXIT_CODE after a
 * self-redeploy so the supervisor respawns on the new build; --once collapses the whole thing
 * into one round of ticks and a summary line (onceSummary below), for cron-style invocations.
 * `--for <duration>` keeps the daemon shape (redeployer, LaunchServicesWatch, supervisor hand-off
 * all stay) but arms a deadline: at the deadline the same graceful stop a Ctrl+C runs fires, and
 * the process exits after printing the summary. A mid-run self-redeploy hands the same args
 * (including `--for`) to the supervisor's next child, and the supervisor hands every generation
 * the same window start (RUN_WINDOW_START_ENV), so the deadline and the summary span the whole
 * window; only the final exit prints the summary. */
export async function cmdRun(root: string, args: string[]): Promise<void> {
  // The one function the self-redeploy asks before swapping onto a successor and the supervisor
  // asks when a generation dies, so the three cannot disagree about what boots. The supervisor
  // half runs it too, so a start that cannot boot fails before any child spawns. The flag
  // vocabulary is validated by the dispatcher (cli.ts, from the same RUN_FLAG_SPECS).
  const once = args.includes("--once");
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
  const forMs = parseRunWindow(args, once);
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
  const roleFilter = parseRoleFlag(args, loopIds(config));
  if (roleFilter !== null && !once) fail("--role is only valid with --once");
  // The refusal an operator hits by trying to start a second fleet in one repo: name the
  // running pid and the two ways to stop it, so the fix is in the message instead of a
  // separate `tumwater status`/help lookup. The info file is read once and reused for the
  // liveness check, like snapshot's own poll.
  const running = readOrchestratorInfo(root);
  if (running !== null && orchestratorAlive(root, running))
    fail(
      `an orchestrator is already running for this repo (pid ${running.pid}) — stop it with \`tumwater stop\` from another terminal, or press Ctrl+C in the terminal that started it`,
    );
  // The fleet-booting machinery loads only once a run actually boots: the orchestrator's
  // module graph (with its landing pipeline, review gate, and scheduler) is the CLI's heaviest
  // compile, and the supervisor/redeploy/launch-services pieces ride beside it. Loading them
  // dynamically, after the fail-fast gates above, keeps every other command's spawn — and
  // `run`'s fail-fast paths — off that cost (see cli.ts's matching lazy dispatch).
  const { SUPERVISED_ENV, RUN_WINDOW_START_ENV, ONCE_FAILED_EXIT_CODE, startParentDeathWatch, expectedSupervisorPid } = await import("../process/supervisor.js");
  if (!process.env[SUPERVISED_ENV]) {
    // `args` are the flags after the command token — forward them so the child generation
    // targets the same branch (or whatever else the invocation named).
    // A stop marker left by a fleet that died before its deadline must not stop this run.
    cancelScheduledStop(root);
    await superviseRunCommand(root, args, branchArg, forMs);
    return;
  }
  const controller = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    say("\nstopping — finishing current runs (Ctrl+C again to force)");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A windowed run's deadline arms the same graceful stop a Ctrl+C runs — the identical `stop`
  // closure, so the drain path is one code path either way. clearTimeout in the finally below
  // retracts it when the run ends first (an early Ctrl+C), so no stray timer outlives the run.
  const windowStart = inheritedWindowStart(process.env[RUN_WINDOW_START_ENV], Date.now());
  const deadlineTimer = forMs !== null ? armDeadlineTimer(Math.max(0, windowStart + forMs - Date.now()), () => {
    say("deadline reached — stopping");
    stop();
  }) : null;
  const scheduledStopWatch = armScheduledStopWatch(root, () => {
    if (!stopping) stop(); // A drain already under way must not be turned into a force-kill.
  });
  // A supervisor that dies without forwarding — SIGKILL (the OOM killer, `kill -9`) cannot be
  // trapped or forwarded, and an uncaught supervisor crash forwards nothing either — leaves this
  // generation reparented and ticking the fleet unattended. The parent-death watch polls for the
  // reparent and runs the same graceful stop a forwarded SIGTERM would have run, so a killed
  // supervisor takes its fleet down with it (BUGS.md 2026-09-30). The spawner hands its pid
  // down (SUPERVISOR_PID_ENV), so a supervisor killed during this child's startup — before the
  // watch's first ppid read — still counts as gone. Everything below runs only in
  // the supervised generation: an unsupervised `run` became the supervisor above and returned.
  const expectedPpid = expectedSupervisorPid();
  startParentDeathWatch(stop, expectedPpid !== undefined ? { expectedPpid } : {});
  const enabled = loopIds(config);
  // A scoped round's loop list is exactly the filter; otherwise every enabled loop runs.
  const roles = roleFilter !== null ? [roleFilter] : enabled;
  // Main's green verdicts outlive this generation: the redeployer and the loops' red-main gate
  // start from the ones the previous generation verified instead of re-running the suite.
  (await import("../baseline/main-baseline.js")).persistBaselineVerdicts(root);
  // A once round never self-redeploys: it runs one round on the build it booted and exits,
  // so the hand-off machinery (and its build stamp) stays daemon-only.
  const redeploy = once
    ? null
    : await (await import("../redeploy/redeploy.js")).createRedeployer(root, (e) => logEvent(root, e), () => runStartupProblem(root, branchArg));
  const build = redeploy ? ` · build ${shortSha(redeploy.build.sha)}` : "";
  // A long-running fleet watches launchservicesd's port count (a no-op off macOS); a once round
  // is over long before a leak could matter.
  const launchServicesWatch = once ? null : new (await import("../process/launch-services.js")).LaunchServicesWatch(root);
  // Name the resolved root when it differs from the cwd: an operator who started the fleet
  // from a subdirectory must see where .tumwater/ actually lives.
  const rootNote = root !== process.cwd() ? ` · root ${root}` : "";
  const forNote = forMs !== null ? ` · for ${durationLabel(forMs)}` : "";
  say(
    once
      ? `tumwater once on branch ${mainBranch}${rootNote} — one round, then exit`
      : `tumwater running on branch ${mainBranch}${forNote}${build}${rootNote} — Ctrl+C to stop`,
  );
  say(`roles: ${roles.join(", ")}`);
  say("watch: `tumwater tui` or `tumwater logs -f` in another terminal; events stream below\n");
  const unsubscribe = subscribeEvents((e) => say(formatEvent(e)));
  // Snapshot each role's tick counter so the once summary can tell this round's ticks from
  // the persisted history (the state file accumulates across rounds).
  const ticksBefore = new Map(roles.map((role) => [role, loadLoopState(root, role).ticks] as const));
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
  if (once) say(onceSummary(root, roles, ticksBefore, exit.settled, exit.ticksRun));
  else if (forMs !== null && !exit.restart) {
    const { rows, covered } = readTickRowsSince(root, Date.now() - windowStart, null);
    say(windowSummary(durationLabel(forMs), summarizeTickRows(rows), covered));
  }
  if (once) {
    const failures = onceFailures(root, roles, ticksBefore, exit.ticksRun);
    if (failures.length > 0) {
      say(`once: failed — ${failures.map((f) => `${f.role} ${f.result}`).join(", ")}`);
      process.exitCode = ONCE_FAILED_EXIT_CODE;
    }
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

/** The `run --for` exit summary: a window line, then the `history --summary` table for the ticks
 * that ended since the window opened — every tick counted once by its outcome class. Only the
 * final exit prints it; a mid-window self-redeploy hands off silently and the next generation
 * inherits the window start, so the table spans every generation. */
export function windowSummary(label: string, summary: { loops: HistorySummaryRow[]; total: HistorySummaryRow }, covered: boolean): string {
  const { total } = summary;
  const lines = [
    total.ticks === 0
      ? `for ${label}: 0 runs — nothing ran`
      : `for ${label}: ${plural(total.ticks, "run")} — ${total.changes} changes, ${total.none} none, ${total.problems} problems`,
  ];
  if (total.ticks > 0) lines.push(renderSummary(summary));
  if (!covered) lines.push(SPARSE_WINDOW_NOTE);
  return lines.join("\n");
}

/** Arm the windowed run's deadline timer: the one home of the arming `cmdRun` does for
 * `run --for <duration>`. A duration over setTimeout's own 32-bit signed ceiling
 * (2_147_483_647 ms ≈ 24.8 days) is clamped by Node to 1ms with a TimeoutOverflowWarning, so
 * a raw setTimeout would fire the deadline the instant the run booted — and `run --for`
 * accepts durations up to the 90-day pause cap (PAUSE_FOR_MAX_MS), so overflow is an ordinary
 * input, not an error. The timer is therefore armed in ≤32-bit chunks: each setTimeout covers
 * at most the ceiling, and a chunk that expires with time still left re-arms for the
 * remainder, so the callback runs exactly once, after the full duration, whatever its size.
 * Returns a clear() handle (the finally in cmdRun retracts the timer when the run ends first —
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
 * stop polling, and call `onStop` (cmdRun's Ctrl+C closure) exactly once. The interval is
 * unref'd; clear() retracts it. Exported for tests. */
export function armScheduledStopWatch(root: string, onStop: () => void): { clear(): void } {
  const timer = setInterval(() => {
    const at = scheduledStopAt(root);
    if (at === undefined || at > Date.now()) return;
    clearInterval(timer);
    cancelScheduledStop(root);
    say("scheduled stop reached — stopping");
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
 * land: a `--once` round with a role ending in one exits ONCE_FAILED_EXIT_CODE. `rejected` and
 * `refused` are the review gate and the agent working as designed; `aborted`, `quiet_killed`, and
 * `user_aborted` only reach a once round on a shutdown or operator abort, which exit
 * their own way. */
export const ONCE_FAILURE_RESULTS: ReadonlySet<TickResult> = new Set<TickResult>([
  "error",
  "review_error",
  "merge_conflict",
  "merge_blocked",
  "main_red",
]);

function ticksThisRound(
  s: { ticks: number },
  role: string,
  ticksBefore: Map<string, number>,
  ticksRun?: ReadonlyMap<string, number>,
): number {
  return ticksRun ? (ticksRun.get(role) ?? 0) : s.ticks - (ticksBefore.get(role) ?? 0);
}

/** The roles that ticked this round and whose last result is in ONCE_FAILURE_RESULTS. */
export function onceFailures(
  root: string,
  roles: string[],
  ticksBefore: Map<string, number>,
  ticksRun?: ReadonlyMap<string, number>,
): { role: string; result: TickResult }[] {
  const out: { role: string; result: TickResult }[] = [];
  const extra = ticksRun ? [...ticksRun.keys()].filter((r) => !roles.includes(r)) : [];
  for (const role of [...roles, ...extra]) {
    const s = loadLoopState(root, role);
    if (ticksThisRound(s, role, ticksBefore, ticksRun) > 0 && s.lastResult && ONCE_FAILURE_RESULTS.has(s.lastResult)) {
      out.push({ role, result: s.lastResult });
    }
  }
  return out;
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
    const ran = ticksThisRound(s, role, ticksBefore, ticksRun);
    if (ran > 0) {
      ticks += ran;
      const key = s.lastResult ?? "no_change";
      increment(outcomes, key);
    } else {
      const reason =
        settled?.get(role) ??
        (isFleetPaused(root) || pausedRoles(root).includes(role)
          ? "paused"
          : stateSkipReason(s));
      skipped.push(reason);
    }
  }
  // Sort by result key only. The comparator makes that explicit: a comparator-less sort
  // would order `[key, count]` tuples by their "key,count" string form, which happens to
  // agree only while each key is unique.
  const counts = [...outcomes.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  const skipNote = skipped.length === 0 ? "" : `, ${skipped.length} skipped (${skipped.join(", ")})`;
  return `once: ${plural(ticks, "run")} — ${counts || "nothing ran"}${skipNote}`;
}

/** Split `run`'s args for `run --gui` and `run --tui`: whether the supervisor should also start
 * the dashboard and/or host the observer TUI, and the args the supervised orchestrator
 * generation gets with both stripped so the generation's own cmdRun never tries to supervise a
 * second dashboard or re-attach a TUI in a terminal the parent owns (a self-redeploy spawns a
 * fresh generation each time). Exported so the unit tests pin the stripping that removing the
 * spawn wiring would otherwise silently drop. */
export function guiChildPlan(runArgs: string[]): {
  spawnGui: boolean;
  spawnTui: boolean;
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
  return {
    spawnGui: runArgs.includes("--gui"),
    spawnTui: runArgs.includes("--tui"),
    orchestratorArgs: runArgs.filter((arg) => arg !== "--gui" && arg !== "--tui"),
    childStdio: runArgs.includes("--tui") ? ["ignore", "ignore", "ignore"] : "inherit",
  };
}

/** The dashboard half of `run --gui`: keep a `tumwater gui` child alive across its own
 * self-reloads. The child is marked with DASHBOARD_CHILD_ENV naming this supervisor, so its
 * reload watch (src/redeploy/self-reload.ts) exits RESTART_EXIT_CODE for a fresh sibling on a
 * redeploy and exits on its own if this supervisor dies outright (SIGKILL, a crash) — a killed
 * supervisor never leaves a dashboard holding its port. Any other dashboard exit (a failed bind
 * prints its own message and exits) ends this loop and leaves the fleet running. */
async function superviseDashboard(signal: AbortSignal, stdio: StdioOptions = "inherit"): Promise<void> {
  const { DASHBOARD_CHILD_ENV } = await import("../redeploy/self-reload.js");
  const { spawnGuiChild } = await import("../process/supervisor.js");
  for (;;) {
    const exit = await spawnGuiChild(signal, { [DASHBOARD_CHILD_ENV]: String(process.pid) }, stdio);
    if (signal.aborted || exit.code !== RESTART_EXIT_CODE) return;
  }
}

/** The supervisor half of `tumwater run` (src/process/supervisor.ts): spawn the orchestrator as a
 * child generation and respawn it whenever it exits RESTART_EXIT_CODE after redeploying itself.
 * Ctrl+C reaches the child directly from the terminal, so only SIGTERM is forwarded; the
 * supervisor's own exit code is whatever the last generation's was. A fleet that goes down without
 * the operator asking leaves a `supervisor_exit` event behind (BUGS.md 2026-09-23): the dead
 * generation's stderr reached only this terminal, which nobody may be watching. */
async function superviseRunCommand(root: string, runArgs: string[], branchArg: string | null, forMs: number | null): Promise<void> {
  // The supervisor machinery loads lazily, like cmdRun's orchestrator import above: a command
  // that never boots the fleet never compiles it.
  const { RUN_WINDOW_START_ENV, fleetDownEvent, spawnRunChild, superviseRun } = await import("../process/supervisor.js");
  const plan = guiChildPlan(runArgs);
  // A TUI owns the terminal, so it can only be hosted when this supervisor's own stdin and
  // stdout are a TTY — the same guard runTui enforces. Check before booting a fleet a TUI
  // could never drive, surfacing the actionable tuiTerminalError instead of letting runTui's
  // rejection sit unhandled until superviseRun settles and then crash the supervisor after
  // the fleet has (pointlessly) started.
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
  // runTui resolves and the .then sets `stopping` and aborts the controller, so superviseRun
  // drains in-flight ticks and the fleet shuts down exactly as Ctrl+C on a plain `run` does;
  // the fleet-down teardown (dashboard abort, onDone, terminal restore) is unchanged.
  // reloadDisabled keeps the hosted TUI off its self-reload watch: the fleet's own first
  // self-redeploy dist swap must not resolve runTui (which would read as a quit and abort
  // this run's controller) or spawn a re-exec replacement; the host supervisor survives a
  // redeploy by respawning its fleet children, and the hosted TUI — like the supervisor
  // itself — stays on the build it started, getting fresh code on the next run. The abort
  // signal is how this process ends the TUI when the run ends on its own (a `--for` window
  // closes, or the fleet stops): runTui resolves on abort and takes its quit teardown, so the
  // `await tui` below cannot hang on a TUI nothing else would ever close.
  const tuiController = new AbortController();
  const tui = plan.spawnTui
    ? (await import("../ui/tui/tui.js")).runTui(root, { abortSignal: tuiController.signal, reloadDisabled: true }).then(() => {
        stopping = true; // the TUI quit = the run's Ctrl+C
        controller.abort();
        guiController.abort();
      })
    : Promise.resolve();
  const gui = plan.spawnGui ? superviseDashboard(guiController.signal, plan.childStdio) : Promise.resolve();
  const code = await superviseRun(
    {
      spawnChild: (signal) =>
        spawnRunChild(signal, plan.orchestratorArgs, windowEnv, plan.childStdio),
      stopping: () => stopping,
      onRespawn: (generation) => {
        // With a hosted TUI the supervisor owns no free stdout: its own say() would paint the
        // restart line over the ink full-screen render and corrupt it — the same interleaving
        // childStdio silences for the children. The TUI renders status from on-disk state, so
        // the redeploy is visible there as the fleet coming back.
        if (!plan.spawnTui) say(`\nrestarting onto the update (restart ${generation})\n`);
      },
      onCrashLoop: () =>
        process.stderr.write("tumwater restarted itself too many times in a minute — giving up\n"),
      // Re-ask the startup gate for the reason: a generation that dies right after a respawn
      // most likely met an environment that no longer boots (the 2026-09-22 child found
      // tumwater.json gone). A crash loop's generations all asked for restarts, so the gate
      // has nothing to say about it.
      onFleetDown: async (down) => {
        const event = logEvent(root, fleetDownEvent(down, down.crashLoop ? null : await runStartupProblem(root, branchArg)));
        notifyFleetDown(root, event);
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
  // The orchestrator is gone; take the dashboard and the TUI with it so a stopped fleet never
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
