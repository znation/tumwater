/** Collection half of the failure digest: read the harness's event log over a 2×-day window
 * and distill it into a `FailureReportData` — outcome tallies, window deltas, clustered
 * failure messages, landed commits, and the harness's own state transitions, each bounded at
 * collection time. The Markdown rendering of this data lives in failure-report.ts, a pure
 * function of it; the split keeps "what happened" (clustering rules, window math, bounds)
 * apart from "how it prints" (column layout, cell wording), which change for different
 * reasons. The cluster-key rules themselves — normalization, timeout pooling, grouping — live
 * in failure-cluster.ts, shared with the error-storm reducer. */
import type { TickResult } from "./tick-outcome.js";
import { readWindowEvents } from "./event-window.js";
import { eventDayKey, eventRole, eventUsage, tickSpanMs, tickStartMap } from "./event-read.js";
import type { HarnessEvent } from "./events.js";
import { dayAt, dayWindow, formatDate } from "./datetime.js";
import { describeStateChange, STATE_CHANGE_TOP, STATE_CHANGE_TYPES } from "./failure-state-change.js";
import { clusterMessages, normalizeClusterKey, poolTimeoutKey, EXAMPLE_MAX, type Cluster } from "./failure-cluster.js";

/** Caps that keep the digest bounded regardless of how bad the window was — the top-N
 * clusters, one trimmed example each, and the newest N landed commits. See the render-doc
 * byte bound below for what these buy. */
const ERROR_TOP = 7;
const WARNING_TOP = 7;
const REVIEW_FAILURE_TOP = 5;
const REJECTION_TOP = 5;
const LANDED_TOP = 10;
const SUMMARY_MAX = 100;

/** One clustered section of the digest: the top-N clusters it itemizes, plus what the cut
 * hides — `total` counts every event the section owns in the current window (for rejections,
 * every `review_rejected`, matching the Deltas column even when an event carries no reasons),
 * and `hiddenClusters` is how many distinct clusters the top-N slice dropped. The render uses
 * both to print a remainder line, so a capped section says so instead of reading as a full
 * itemization (BUGS.md 2026-09-22). */
export interface ClusterSection {
  clusters: Cluster[];
  total: number;
  hiddenClusters: number;
}

/** One `tick_end` result tally, per role. */
export interface OutcomeRow {
  role: string;
  counts: Partial<Record<TickResult, number>>;
}

/** How the Outcome table's results collapse for costing (PLANS.md, time-and-spend plan):
 * "landed" made progress, "no_change" spent a tick and landed nothing, and every remaining
 * result is "error-class" — it burned agent time without landing, whether the cause was a
 * hard failure or the review gate. Typed as a full Record so a result added to
 * src/tick-outcome.ts and forgotten here is a compile error, like RESULT_ORDER in
 * failure-report.ts. */
const OUTCOME_CLASS: Record<TickResult, "landed" | "no_change" | "error"> = {
  changed: "landed",
  queued: "landed",
  no_change: "no_change",
  refused: "no_change",
  skipped: "no_change",
  rejected: "error",
  review_error: "error",
  merge_conflict: "error",
  merge_blocked: "error",
  main_red: "error",
  error: "error",
  quiet_killed: "error",
  aborted: "error",
  user_aborted: "error",
};

/** One cell of the time-and-spend table: the ticks that ended on one outcome class, their
 * summed wall-clock span (start→end) and cost. `ms` is 0 when no duration is known — an old
 * `tick_end` whose `tick_start` rotated out of the retained log — so the cell still counts
 * the tick but prices no time it cannot attest. */
export interface SpendCell {
  ticks: number;
  ms: number;
  costUsd: number;
}

/** One role's row of the time-and-spend table: a SpendCell per outcome class, present even
 * when empty so the render's columns never shift per row. */
interface TimeSpendRow {
  role: string;
  classes: Record<"landed" | "no_change" | "error", SpendCell>;
}

/** One ranked loss cause (PLANS.md, time-and-spend plan): either an error cluster — the
 * digest's own clustering, applied to the ticks that burned time — or a role's total
 * "no_change" spend, the quiet loss no cluster names. `example` is the newest verbatim
 * occurrence for a cluster (the one at lastSeen, BUGS.md 2026-09-30), "" for a no_change
 * cause. */
interface LossCause {
  kind: "error-cluster" | "no_change";
  roles: string[]; // unique, sorted
  example: string;
  ticks: number;
  ms: number;
  costUsd: number;
}

/** A row's summed wall-clock span across its outcome classes — the sort key that puts the
 * burning role first, the way the usage report ranks its cost lines. */
function sumMs(classes: TimeSpendRow["classes"]): number {
  return classes.landed.ms + classes.no_change.ms + classes.error.ms;
}

/** The loss-cause cut, like ERROR_TOP above: the five most expensive causes by time. */
const LOSS_TOP = 5;

/** The results whose loss attributes to a cluster — exactly the results the plan names:
 * an error, an abort, or a quiet kill. Other error-class results (review_error,
 * merge_conflict, …) price into the table's error-class column but have no message the
 * clustering can own, so they stay out of the loss ranking rather than impersonating one. */
const CLUSTERED_RESULTS: ReadonlySet<string> = new Set(["error", "aborted", "quiet_killed"]);

/** A loss cause while collecting; `roles` is a set until the final sort. */
interface LossDraft {
  kind: "error-cluster" | "no_change";
  roles: Set<string>;
  lastSeen: number;
  example: string;
  ticks: number;
  ms: number;
  costUsd: number;
}

/** One role's current-vs-preceding-window metrics. A zero side means the role had no ticks
 * there ("new" for a role absent from the preceding window). */
interface DeltaRow {
  role: string;
  prevTicks: number;
  ticks: number;
  prevErrors: number;
  errors: number;
  prevQuietKills: number;
  quietKills: number;
  prevRejections: number;
  rejections: number;
}

/** A commit that landed (a `merged` event) inside the window. */
interface LandedCommit {
  ts: number;
  commit: string;
  summary: string;
}

/** One harness decision (a transition event) in the window, pre-described for the digest's
 * Fleet state changes section. */
interface StateChange {
  ts: number;
  role: string;
  description: string;
}

/** The digest's collected evidence — a pure function of the event log plus a clock; the
 * render step below is a pure function of this. */
export interface FailureReportData {
  days: number;
  from: string; // current window start, local day key
  to: string; // today
  ticks: number; // tick_end events in the current window
  hasEvents: boolean; // any event at all in the read (2× window)
  emptyLog: boolean; // the retained log holds no parseable events reaching the window
  partial: boolean; // the read window (both halves) starts before the retained log does
  oldestEventDate: string | null; // when partial/empty: the oldest retained event's local date
  outcomes: OutcomeRow[];
  deltas: DeltaRow[];
  timeSpend: TimeSpendRow[]; // per role × outcome class: ticks, summed wall-clock ms, cost
  lossCauses: LossCause[]; // top LOSS_TOP causes by time: error clusters and no_change roles
  errors: ClusterSection;
  warnings: ClusterSection;
  reviewFailures: ClusterSection;
  rejections: ClusterSection;
  landed: LandedCommit[];
  landedTotal: number; // all merges in the window, before the newest-LANDED_TOP cut
  stateChanges: StateChange[];
  stateChangesTotal: number; // all transitions in the window, before the newest-N cut
}

/** Attach a section's window total (events the section owns, counted before any filter the
 * clustering applies — for rejections, the reasons-less ones too) to the clustered result. */
function section(
  clustered: { clusters: Cluster[]; hiddenClusters: number },
  total: number,
): ClusterSection {
  return { ...clustered, total };
}

/** One role's window metrics, used for the delta row: ticks/errors/quiet kills from
 * `tick_end`, rejections from `review_rejected` (the landing slot logs it after the tick). */
interface RoleStats {
  ticks: number;
  errors: number;
  quietKills: number;
  rejections: number;
}

function roleStats(events: HarnessEvent[]): Map<string, RoleStats> {
  const byRole = new Map<string, RoleStats>();
  const statsFor = (role: string): RoleStats => {
    const stats = byRole.get(role) ?? { ticks: 0, errors: 0, quietKills: 0, rejections: 0 };
    byRole.set(role, stats);
    return stats;
  };
  for (const ev of events) {
    // Ticks are tick_end events; a rejection is now recorded by the landing slot, AFTER the
    // authoring tick has already ended `queued` (plans/merge-queue.md 3/5). review_rejected is
    // the one event every reject path logs exactly once (src/review.ts), so it — not a
    // tick_end result no production path emits — is the rejection source.
    if (ev.type === "tick_end") {
      const stats = statsFor(eventRole(ev));
      stats.ticks++;
      if (ev.result === "error") stats.errors++;
      else if (ev.result === "quiet_killed") stats.quietKills++;
    } else if (ev.type === "review_rejected") {
      statsFor(eventRole(ev)).rejections++;
    }
  }
  return byRole;
}

/** The time a `tick_end` attests: its own `durationMs` when it carries one (every event
 * written since 2026-09-29 does), else the start→end pairing over `starts` — the same
 * fallback history-data.ts renders, so old events read their span the one way it can still be
 * known. 0 when neither source has the start (rotation cut it); the fold prices no time it
 * cannot attest but still counts the tick. */
function tickDurationMs(ev: HarnessEvent, starts: Map<string, number>): number {
  const own = typeof ev.durationMs === "number" && Number.isFinite(ev.durationMs) && ev.durationMs >= 0
    ? ev.durationMs
    : null;
  if (own !== null) return own;
  return tickSpanMs(ev, starts) ?? 0;
}

/** Fold the window's tick_ends into the time-and-spend table and the loss ranking. Pairing
 * runs over BOTH windows' events (the caller passes the whole read), so a tick that opened
 * in the preceding day and ended in the current one still gets its span. */
function timeAndSpend(tickEvents: HarnessEvent[], allEvents: HarnessEvent[]): {
  timeSpend: TimeSpendRow[];
  lossCauses: LossCause[];
} {
  const starts = tickStartMap(allEvents);
  const emptyCell = (): SpendCell => ({ ticks: 0, ms: 0, costUsd: 0 });
  const byRole = new Map<string, Record<"landed" | "no_change" | "error", SpendCell>>();
  const losses = new Map<string, LossDraft>();
  for (const ev of tickEvents) {
    const cls = OUTCOME_CLASS[ev.result as TickResult];
    if (cls === undefined) continue; // An unknown result is tallied in the Outcome table; costing it would need a class first.
    const role = eventRole(ev);
    const row = byRole.get(role) ?? { landed: emptyCell(), no_change: emptyCell(), error: emptyCell() };
    byRole.set(role, row);
    const cell = row[cls];
    cell.ticks++;
    cell.ms += tickDurationMs(ev, starts);
    cell.costUsd += eventUsage(ev).costUsd;

    // Loss causes: a clustered failure's cluster owns its time, a no_change's role does.
    let key: string | null = null;
    let example = "";
    if (cls === "no_change") {
      key = `no_change\u0000${role}`;
    } else if (CLUSTERED_RESULTS.has(String(ev.result)) && typeof ev.error === "string" && ev.error !== "") {
      key = poolTimeoutKey(normalizeClusterKey(ev.error));
      example = ev.error.trim().slice(0, EXAMPLE_MAX);
    }
    if (key === null) continue;
    let draft = losses.get(key);
    if (!draft) {
      draft = {
        kind: cls === "no_change" ? "no_change" : "error-cluster",
        roles: new Set<string>(),
        lastSeen: ev.ts,
        example,
        ticks: 0,
        ms: 0,
        costUsd: 0,
      };
      losses.set(key, draft);
    }
    // The example rides lastSeen, like clusterMessages': the cause as it happens now, not
    // the first-seen value a config change retired (BUGS.md 2026-09-30).
    if (ev.ts >= draft.lastSeen) {
      draft.lastSeen = ev.ts;
      draft.example = example;
    }
    draft.roles.add(role);
    draft.ticks++;
    draft.ms += tickDurationMs(ev, starts);
    draft.costUsd += eventUsage(ev).costUsd;
    losses.set(key, draft);
  }
  const timeSpend: TimeSpendRow[] = [...byRole.entries()]
    .map(([role, classes]) => ({ role, classes }))
    .sort((a, b) => sumMs(b.classes) - sumMs(a.classes) || a.role.localeCompare(b.role));
  const lossCauses: LossCause[] = [...losses.values()]
    .map((d) => ({
      kind: d.kind,
      roles: [...d.roles].sort((a, b) => a.localeCompare(b)),
      example: d.example,
      ticks: d.ticks,
      ms: d.ms,
      costUsd: d.costUsd,
    }))
    .sort((a, b) => b.ms - a.ms || b.ticks - a.ticks || a.example.localeCompare(b.example))
    .slice(0, LOSS_TOP);
  return { timeSpend, lossCauses };
}

/** Collect the digest over the last `days` local calendar days, reading a 2×-long window once
 * and partitioning it in memory so the delta against the preceding equal window costs no
 * second tail read. */
export function collectFailureReport(root: string, days: number): FailureReportData {
  const now = new Date();
  const { from, to } = dayWindow(days, now);
  const priorFrom = formatDate(dayAt(days * 2 - 1, now));

  const { events, coversFullWindow } = readWindowEvents(root, priorFrom);
  const current: HarnessEvent[] = [];
  const prior: HarnessEvent[] = [];
  for (const ev of events) {
    const day = eventDayKey(ev);
    if (day === null) continue; // Unreachable: the reader filters on ts.
    if (day >= from && day <= to) current.push(ev);
    else if (day >= priorFrom) prior.push(ev);
  }

  const tickEvents = current.filter((ev) => ev.type === "tick_end");

  // Outcome table: one row per role, counts per result that occurred.
  const outcomeMap = new Map<string, Partial<Record<TickResult, number>>>();
  for (const ev of tickEvents) {
    const role = eventRole(ev);
    const counts = outcomeMap.get(role) ?? {};
    const result = ev.result as TickResult;
    counts[result] = (counts[result] ?? 0) + 1;
    outcomeMap.set(role, counts);
  }
  const outcomes: OutcomeRow[] = [...outcomeMap.entries()]
    .map(([role, counts]) => ({ role, counts }))
    .sort((a, b) => total(a.counts) - total(b.counts) || a.role.localeCompare(b.role))
    .reverse();

  // Time and spend: the same ticks priced by wall-clock span and cost, per role × outcome
  // class, plus the loss ranking that weighs causes by agent-hours rather than tick counts.
  const { timeSpend, lossCauses } = timeAndSpend(tickEvents, events);

  // Deltas: current vs preceding window, per role.
  const curStats = roleStats(current);
  const prevStats = roleStats(prior);
  const roles = [...new Set([...curStats.keys(), ...prevStats.keys()])];
  const deltas: DeltaRow[] = roles
    .map((role) => {
      const c = curStats.get(role) ?? { ticks: 0, errors: 0, quietKills: 0, rejections: 0 };
      const p = prevStats.get(role) ?? { ticks: 0, errors: 0, quietKills: 0, rejections: 0 };
      return {
        role,
        prevTicks: p.ticks,
        ticks: c.ticks,
        prevErrors: p.errors,
        errors: c.errors,
        prevQuietKills: p.quietKills,
        quietKills: c.quietKills,
        prevRejections: p.rejections,
        rejections: c.rejections,
      };
    })
    .sort(
      (a, b) =>
        b.ticks - a.ticks ||
        b.prevTicks - a.prevTicks ||
        a.role.localeCompare(b.role),
    );

  // Only ticks that ENDED as errors carry a tick error: `state.lastError` is shared state the
  // lander also writes, so a successful tick's `tick_end` can carry a leftover landing failure's
  // text (BUGS.md 2026-09-21). `main_red` joins them because its cause is written for that
  // result — the baseline gate's own text (src/main-red.ts), never a leftover — so the section
  // itemizes the outcome that blocks every merge instead of leaving it a bare count (BUGS.md
  // 2026-09-28). The total therefore equals the Outcome table's error column PLUS its main_red
  // cells; the render's section title says so, and landing failures still surface below.
  const errorEvents = tickEvents.filter(
    (ev) =>
      (ev.result === "error" || ev.result === "main_red") &&
      typeof ev.error === "string" &&
      ev.error !== "",
  );
  const errors = section(
    clusterMessages(
      errorEvents.map((ev) => ({ message: ev.error as string, role: eventRole(ev), ts: ev.ts })),
      ERROR_TOP,
    ),
    errorEvents.length,
  );
  const warningEvents = current.filter(
    (ev) => ev.type === "warning" && typeof ev.message === "string" && ev.message !== "",
  );
  const warnings = section(
    clusterMessages(warningEvents.map((ev) => ({ message: ev.message as string, role: eventRole(ev), ts: ev.ts })), WARNING_TOP),
    warningEvents.length,
  );
  // Rejections cluster on (role, reasons[0]) — the field the event feed renders — so two
  // different rejection reasons from the same role stay separate rows. The section's total
  // counts every `review_rejected` in the window, reasons or not, so it equals the Deltas
  // column and the render's remainder line cross-checks against it.
  const rejectedEvents = current.filter((ev) => ev.type === "review_rejected");
  const rejections = section(
    clusterMessages(
      rejectedEvents
        .filter((ev) => Array.isArray(ev.reasons))
        .map((ev) => {
          const reasons = ev.reasons as unknown[];
          const first = typeof reasons[0] === "string" ? (reasons[0] as string) : "no reasons given";
          return { message: first, role: eventRole(ev), ts: ev.ts, keyPrefix: `${eventRole(ev)}\u0000` };
        }),
      REJECTION_TOP,
    ),
    rejectedEvents.length,
  );

  // Landing review failures: a reviewer that could not return a parseable verdict (a dead
  // backend, a transport error) fails closed and keeps the commit, but its authoring tick ends
  // `queued`/`no_change` — so the failure lives on the `review_failed` event, never on
  // `tick_end.error`. Clustered on their own so the telemetry role can see a gate that keeps
  // failing without misreading it as a tick error (BUGS.md 2026-09-21).
  const reviewFailures = section(
    clusterMessages(
      current
        .filter((ev) => ev.type === "review_failed" && typeof ev.message === "string" && ev.message !== "")
        .map((ev) => ({ message: ev.message as string, role: eventRole(ev), ts: ev.ts })),
      REVIEW_FAILURE_TOP,
    ),
    current.filter((ev) => ev.type === "review_failed" && typeof ev.message === "string" && ev.message !== "")
      .length,
  );

  // The newest LANDED_TOP merges, newest first. The pre-slice count rides along, as it does for
  // the state changes below, so the render can name what the cut left out — a busy window must
  // not read as a LANDED_TOP-merge day (BUGS.md 2026-09-23).
  const allLanded: LandedCommit[] = current
    .filter((ev) => ev.type === "merged")
    .map((ev) => ({
      ts: ev.ts,
      commit: typeof ev.commit === "string" ? ev.commit : "?",
      summary: (typeof ev.summary === "string" ? ev.summary : "").trim().slice(0, SUMMARY_MAX),
    }))
    .sort((a, b) => b.ts - a.ts);
  const landed = allLanded.slice(0, LANDED_TOP);

  // The harness's own decisions, newest STATE_CHANGE_TOP kept in chronological order. The
  // description is bounded at collection so render stays a pure function of this data. The
  // pre-slice count rides along so the render can say when it is showing a cut, not all of them.
  const allStateChanges: StateChange[] = current
    .filter((ev) => STATE_CHANGE_TYPES.has(ev.type))
    .map((ev) => ({ ts: ev.ts, role: eventRole(ev), description: describeStateChange(ev) }))
    .sort((a, b) => a.ts - b.ts);
  const stateChanges: StateChange[] = allStateChanges.slice(-STATE_CHANGE_TOP);

  const hasEvents = events.length > 0;
  const oldestEventDate = hasEvents ? eventDayKey(events[0]!) : null;
  // Complete only when the reader proves the whole read window (priorFrom..to) is covered:
  // coversFullWindow fires when the oldest retained line predates priorFrom, so both the delta
  // baseline and the current window reach their starts. Every retained event's day is >= priorFrom
  // (the reader filters on it), so an event-side comparison can never strengthen that proof — the
  // former `oldestEventDate < from` arm declared the digest complete while the prior half was still
  // truncated, leaving the delta table to present a skewed baseline as a real trend. Only a proven
  // window can be trusted as idle rather than truncated by rotation.
  const windowComplete = coversFullWindow;

  return {
    days,
    from,
    to,
    ticks: tickEvents.length,
    hasEvents,
    emptyLog: !hasEvents && !coversFullWindow,
    partial: hasEvents && !windowComplete,
    oldestEventDate,
    outcomes,
    deltas,
    timeSpend,
    lossCauses,
    errors,
    warnings,
    reviewFailures,
    rejections,
    landed,
    landedTotal: allLanded.length,
    stateChanges,
    stateChangesTotal: allStateChanges.length,
  };
}

function total(counts: Partial<Record<TickResult, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v ?? 0;
  return n;
}

