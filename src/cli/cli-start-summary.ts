/** `tumwater start`'s exit-summary half: the machinery that turns a finished round or window
 * into its summary — the `--once` one-line report and its `--json` document, and the `--for`
 * window summary table and report. `src/cli/cli-start.ts` keeps `cmdStart` (the boot and the
 * run loop), the window's deadline and scheduled-stop watchdogs, and the invocation guards;
 * the supervisor half lives in `src/cli/cli-start-supervisor.ts`; this module holds only the
 * reporting that a `start`'s exit prints, so the largest command module is no longer also the
 * home of every way a run's tally is shaped.
 * `parseRunWindow` keeps `--for`'s shape and ceiling rules together with the window summary
 * they feed. */
import { compareCodeUnits } from "../collections.js";
import { plural } from "../text/phrases.js";
import { SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { renderSummary } from "../history/history-render.js";
import type { HistorySummaryRow } from "../history/history-data.js";
import type { RunResult } from "../run/run-outcome.js";
import {
  failOverDurationCap,
  failRivalShapes,
  flagValue,
  parseDurationFlag,
} from "./cli-args.js";
import { parsePositiveInt } from "../text/text.js";
import { PAUSE_FOR_MAX_MS } from "../operator/operator-intent.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { stateSkipReason, type RunnerState } from "../runner/runner-state.js";
import { isTeamPaused, pausedRoles } from "../team/team-state.js";
import { runnerPaused } from "../roles/runner-ids.js";

/** The window start a generation adopts: the supervisor's RUN_WINDOW_START_ENV mark when it is a
 * positive integer no later than `now`, else `now` (absent, malformed, or in the future). The
 * mark is read through the shared plain-decimal rule (parsePositiveInt) rather than bare
 * Number(), which would silently coerce a hex/exponent/signed spelling ("0x10" → 16, "1e3" →
 * 1000) into a window start the supervisor never wrote — the same plain-decimal discipline the
 * CLI count/position flags apply to every other string boundary. */
export function inheritedWindowStart(raw: string | undefined, now: number): number {
  if (raw === undefined) return now;
  const n = parsePositiveInt(raw);
  return n !== null && n <= now ? n : now;
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
