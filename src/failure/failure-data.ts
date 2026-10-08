/** Collection half of the failure digest: read the harness's event log over a 2×-day window
 * and distill it into a `FailureReportData` — outcome tallies, window deltas, clustered
 * failure messages, landed commits, and the harness's own state transitions, each bounded at
 * collection time. The Markdown rendering of this data lives in failure-render.ts, a pure
 * function of it; the split keeps "what happened" (clustering rules, window math, bounds)
 * apart from "how it prints" (column layout, cell wording), which change for different
 * reasons. The cluster-key rules themselves — normalization, timeout pooling, grouping — live
 * in failure-cluster.ts, shared with the error-storm reducer. The time-and-spend fold —
 * the per-role × outcome-class pricing and the loss ranking — lives in time-spend.ts.
 */
import type { TickResult } from "../tick/tick-outcome.js";
import { readWindowEvents } from "../events/event-window.js";
import { eventDayKey, eventRole } from "../events/event-read.js";
import { timeAndSpend, type LossCause, type TimeSpendRow } from "./time-spend.js";
import type { HarnessEvent } from "../events/events.js";
import { dayAt, dayWindow, formatDate } from "../text/datetime.js";
import { describeStateChange, STATE_CHANGE_TOP, STATE_CHANGE_TYPES } from "./failure-state-change.js";
import { clusterMessages, errorTextOrPlaceholder, truncateExample, type Cluster } from "./failure-cluster.js";
import { rankByCount } from "./rank.js";
import { addTo, getOrCreate } from "../collections.js";
import { firstReason } from "../text/phrases.js";

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

/** One role's prompt-token telemetry over the window (PLANS.md, per-tick prompt-token plan):
 * the median prompt tokens a tick sent, and the share of those sent before the tick's first
 * edit. Built only from tick_end events that carry `promptTokens`; a log written before the
 * field existed yields no rows, so old digests render unchanged. */
interface PromptStatRow {
  role: string;
  ticks: number; // tick_end events with a promptTokens reading
  medianPromptTokens: number;
  preEditShare: number; // sum(preEditPromptTokens) / sum(promptTokens), in [0, 1]
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
  lossCauses: LossCause[]; // top LOSS_TOP causes by time: error clusters, no_change and review-rejected roles
  lossCausesHidden: number; // distinct causes the LOSS_TOP cut dropped — the render marks the cut
  promptStats: PromptStatRow[]; // per-role prompt-token medians, empty when no tick_end carries them
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

/** Cluster one type's message-bearing events on (role, message), as a section whose total
 * counts the selected events. The one home of the filter-then-cluster shape the warnings and
 * review-failure sections share, and of the guard that skips an event whose `message` is
 * missing, non-string, or empty instead of crashing the digest on a torn line. The errors
 * section does not render through it — its text lives on `error`, not `message`, with a
 * fallback phrase — and rejections key on reasons[0] and prefix their cluster keys, so both
 * keep their own blocks. */
function messageSection(
  events: HarnessEvent[],
  type: HarnessEvent["type"],
  top: number,
): ClusterSection {
  const selected = events.filter(
    (ev) => ev.type === type && typeof ev.message === "string" && ev.message !== "",
  );
  return section(
    clusterMessages(
      selected.map((ev) => ({ message: ev.message as string, role: eventRole(ev), ts: ev.ts })),
      top,
    ),
    selected.length,
  );
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
  const statsFor = (role: string): RoleStats =>
    getOrCreate(byRole, role, () => ({ ticks: 0, errors: 0, quietKills: 0, rejections: 0 }));
  for (const ev of events) {
    // Ticks are tick_end events; a rejection is now recorded by the landing slot, AFTER the
    // authoring tick has already ended `queued` (plans/merge-queue.md 3/5). review_rejected is
    // the one event every reject path logs exactly once (src/review/review.ts), so it — not a
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
    const counts = getOrCreate(outcomeMap, role, () => ({}));
    const result = ev.result as TickResult;
    addTo(counts, result, 1);
  }
  // rankByCount orders strongest role first with the ascending-key tiebreak. The old
  // sort-ascending-then-reverse idiom accidentally flipped equal-total ties into
  // reverse-alphabetical order; equal-total roles now follow the stated deterministic rule
  // (pinned by the tie test in test/failure-render.test.ts).
  const outcomes: OutcomeRow[] = rankByCount(
    [...outcomeMap.entries()].map(([role, counts]) => ({ role, counts })),
    (row) => total(row.counts),
    (row) => row.role,
  );

  // Time and spend: the same ticks priced by wall-clock span and cost, per role × outcome
  // class, plus the loss ranking that weighs causes by agent-hours rather than tick counts.
  const { timeSpend, lossCauses, lossCausesHidden } = timeAndSpend(tickEvents, events);

  // Prompt-token telemetry: per role, the median prompt tokens a tick sent and how much of
  // the prompt budget went out before the first edit. Only ticks carrying the field count, so
  // a pre-feature log leaves the section off entirely.
  const promptStats = promptStatsFor(tickEvents);

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
  // result — the baseline gate's own text (src/baseline/main-red.ts), never a leftover — so the section
  // itemizes the outcome that blocks every merge instead of leaving it a bare count (BUGS.md
  // 2026-09-28). The total therefore equals the Outcome table's error column PLUS its main_red
  // cells; the render's section title says so, and landing failures still surface below.
  // The selection predicate is the Outcome table's own — raw `error`/`main_red` results, no
  // error-text test — so a malformed tick_end that skipped the text can never be counted above
  // but itemized nowhere: those events cluster under a placeholder cause, keeping the section's
  // total equal to the tables it cross-checks against (BUGS.md 2026-09-30).
  const errorEvents = tickEvents.filter(
    (ev) => ev.result === "error" || ev.result === "main_red",
  );
  const errors = section(
    clusterMessages(
      errorEvents.map((ev) => ({
        message: errorTextOrPlaceholder(ev.error),
        role: eventRole(ev),
        ts: ev.ts,
      })),
      ERROR_TOP,
    ),
    errorEvents.length,
  );
  const warnings = messageSection(current, "warning", WARNING_TOP);
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
          return { message: firstReason(reasons), role: eventRole(ev), ts: ev.ts, keyPrefix: `${eventRole(ev)}\u0000` };
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
  const reviewFailures = messageSection(current, "review_failed", REVIEW_FAILURE_TOP);

  // The newest LANDED_TOP merges, newest first. The pre-slice count rides along, as it does for
  // the state changes below, so the render can name what the cut left out — a busy window must
  // not read as a LANDED_TOP-merge day (BUGS.md 2026-09-23).
  const allLanded: LandedCommit[] = current
    .filter((ev) => ev.type === "merged")
    .map((ev) => ({
      ts: ev.ts,
      commit: typeof ev.commit === "string" ? ev.commit : "?",
      summary:
        typeof ev.summary === "string" ? truncateExample(ev.summary, SUMMARY_MAX) : "",
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
    lossCausesHidden,
    promptStats,
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

/** Median of a non-empty numeric list (the mean of the two middles for an even count). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Per-role prompt-token stats from the window's tick_end events. Ticks without a
 * `promptTokens` reading contribute nothing (and skip a role entirely), so the section only
 * appears once some tick ran on a build that records the field. */
function promptStatsFor(ticks: HarnessEvent[]): PromptStatRow[] {
  interface Acc {
    prompts: number[];
    promptSum: number;
    preEditSum: number;
  }
  const byRole = new Map<string, Acc>();
  for (const ev of ticks) {
    const prompt = typeof ev.promptTokens === "number" && ev.promptTokens > 0 ? ev.promptTokens : 0;
    const preEdit =
      typeof ev.preEditPromptTokens === "number" && ev.preEditPromptTokens > 0
        ? ev.preEditPromptTokens
        : 0;
    if (prompt === 0 && preEdit === 0) continue;
    const role = eventRole(ev);
    const acc = getOrCreate(byRole, role, () => ({ prompts: [], promptSum: 0, preEditSum: 0 }));
    if (prompt > 0) {
      acc.prompts.push(prompt);
      acc.promptSum += prompt;
    }
    acc.preEditSum += preEdit;
  }
  return [...byRole.entries()]
    .filter(([, acc]) => acc.promptSum > 0)
    .map(([role, acc]) => ({
      role,
      ticks: acc.prompts.length,
      medianPromptTokens: median(acc.prompts),
      preEditShare: acc.preEditSum / acc.promptSum,
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

function total(counts: Partial<Record<TickResult, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v ?? 0;
  return n;
}
