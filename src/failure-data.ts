/** Collection half of the failure digest: read the harness's event log over a 2×-day window
 * and distill it into a `FailureReportData` — outcome tallies, window deltas, clustered
 * failure messages, landed commits, and the harness's own state transitions, each bounded at
 * collection time. The Markdown rendering of this data lives in failure-report.ts, a pure
 * function of it; the split keeps "what happened" (clustering rules, window math, bounds)
 * apart from "how it prints" (column layout, cell wording), which change for different
 * reasons. */
import type { HarnessEvent, TickResult } from "./types.js";
import { readWindowEvents } from "./event-window.js";
import { eventDayKey, eventRole } from "./events.js";
import { budgetPhrase, dayAt, formatDate, rateLimitHoldPhrase, shortSha } from "./text.js";

/** Caps that keep the digest bounded regardless of how bad the window was — the top-N
 * clusters, one trimmed example each, and the newest N landed commits. See the render-doc
 * byte bound below for what these buy. */
const ERROR_TOP = 7;
const WARNING_TOP = 7;
const REVIEW_FAILURE_TOP = 5;
const REJECTION_TOP = 5;
const LANDED_TOP = 10;
const EXAMPLE_MAX = 120;
const SUMMARY_MAX = 100;

/** The transition events the digest replays: the decisions the harness made about itself (the
 * cap/fleet gates and the 429 hold, live-config edits, self-hosted redeploys, need-based
 * deferrals, orchestrator lifecycle). They are the evidence the telemetry role's load-bearing
 * rule asks it to judge — whether the harness's RESPONSE to a failure was wrong
 * (plans/telemetry-role.md) — so they sit beside the outcomes rather than being dropped. */
const STATE_CHANGE_TYPES = new Set<string>([
  "budget_paused",
  "budget_fallback",
  "budget_resumed",
  "fleet_paused",
  "fleet_resumed",
  "rate_limit_hold",
  "rate_limit_resumed",
  "max_concurrent_changed",
  "retention_changed",
  "config_changed",
  "build_stale",
  "restart_pending",
  "restart",
  "restart_refused",
  "tick_deferred",
  "orchestrator_start",
  "orchestrator_stop",
  "supervisor_exit",
]);
/** The Fleet state changes section's caps: newest N transitions, each line's payload capped at
 * STATE_CHANGE_MAX, each free field within it at STATE_CHANGE_FIELD_MAX. Together with the
 * fixed timestamp/role cells these make the section's bytes a constant, so the digest's ~6 KB
 * bound holds no matter how many transitions the window holds or how long a field is. */
const STATE_CHANGE_TOP = 6;
const STATE_CHANGE_MAX = 72;
const STATE_CHANGE_FIELD_MAX = 24;

/** A normalized cluster of like error/warning/rejection strings. */
export interface Cluster {
  key: string; // the normalized form, the grouping key
  count: number;
  roles: string[]; // unique, sorted
  firstSeen: number; // epoch ms
  lastSeen: number;
  example: string; // the first verbatim occurrence, trimmed for display
}

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
  partial: boolean; // the current window starts before the retained log does
  oldestEventDate: string | null; // when partial/empty: the oldest retained event's local date
  outcomes: OutcomeRow[];
  deltas: DeltaRow[];
  errors: ClusterSection;
  warnings: ClusterSection;
  reviewFailures: ClusterSection;
  rejections: ClusterSection;
  landed: LandedCommit[];
  stateChanges: StateChange[];
  stateChangesTotal: number; // all transitions in the window, before the newest-N cut
}

/** A cluster key is the message with the volatile parts replaced, rules applied in this order:

 * rule carries a negative lookbehind so the exit status after `exited ` survives — `pi exited
 * 1` and `pi exited null` must stay distinct; the code is semantic. The result is trimmed to
 * 120 chars. Deliberately conservative: over-clustering hides a real second failure mode,
 * while under-clustering merely costs a row. Exported for its own unit tests. */
export function normalizeClusterKey(message: string): string {
  const normalized = message
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\/(?:[\w.@+-]+\/)+[\w.@+-]+/g, "<path>")
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, "<ts>")
    .replace(/\d+(?:\.\d+)?(?:ms|s|m)\b/g, "<dur>")
    .replace(/(?<!exited\s)\b\d+\b/g, "<n>");
  return normalized.trim().slice(0, EXAMPLE_MAX);
}

/** A live cluster while collecting; `roles` is a set until the final sort. */
interface ClusterDraft {
  key: string;
  count: number;
  roles: Set<string>;
  firstSeen: number;
  lastSeen: number;
  example: string;
}

/** Group messages by their normalized key, newest/oldest tracked per cluster. `keyPrefix`
 * scopes a cluster to something the message itself omits (rejections key on role too) without
 * polluting the verbatim example. Returns the top-N clusters plus how many fell past the cut,
 * so the render can mark the truncation instead of presenting the survivors as the whole. */
function clusterMessages(
  messages: Array<{ message: string; role: string; ts: number; keyPrefix?: string }>,
  top: number,
): { clusters: Cluster[]; hiddenClusters: number } {
  const drafts = new Map<string, ClusterDraft>();
  for (const { message, role, ts, keyPrefix } of messages) {
    const key = `${keyPrefix ?? ""}${normalizeClusterKey(message)}`;
    const draft = drafts.get(key);
    if (draft) {
      draft.count++;
      draft.roles.add(role);
      if (ts < draft.firstSeen) draft.firstSeen = ts;
      if (ts > draft.lastSeen) draft.lastSeen = ts;
    } else {
      drafts.set(key, {
        key,
        count: 1,
        roles: new Set([role]),
        firstSeen: ts,
        lastSeen: ts,
        example: message.trim().slice(0, EXAMPLE_MAX),
      });
    }
  }
  const sorted = [...drafts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return {
    clusters: sorted.slice(0, top).map((d) => ({
      key: d.key,
      count: d.count,
      roles: [...d.roles].sort((a, b) => a.localeCompare(b)),
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      example: d.example,
    })),
    hiddenClusters: Math.max(0, sorted.length - top),
  };
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

/** Collect the digest over the last `days` local calendar days, reading a 2×-long window once
 * and partitioning it in memory so the delta against the preceding equal window costs no
 * second tail read. */
export function collectFailureReport(root: string, days: number): FailureReportData {
  const now = new Date();
  const from = formatDate(dayAt(days - 1, now));
  const to = formatDate(dayAt(0, now));
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
  // text (BUGS.md 2026-09-21). Clustering by result keeps this section's total equal to the
  // Outcome table's error column; landing failures surface in their own section below.
  const errorEvents = tickEvents.filter(
    (ev) => ev.result === "error" && typeof ev.error === "string" && ev.error !== "",
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

  const landed: LandedCommit[] = current
    .filter((ev) => ev.type === "merged")
    .map((ev) => ({
      ts: ev.ts,
      commit: typeof ev.commit === "string" ? ev.commit : "?",
      summary: (typeof ev.summary === "string" ? ev.summary : "").trim().slice(0, SUMMARY_MAX),
    }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, LANDED_TOP);

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
  // Complete when the log reaches back before the current window (either the early-stop proved
  // it, or the oldest retained event predates the window start). Only then can a short window be
  // trusted as idle rather than truncated by rotation.
  const windowComplete = coversFullWindow || (oldestEventDate !== null && oldestEventDate < from);

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
    errors,
    warnings,
    reviewFailures,
    rejections,
    landed,
    stateChanges,
    stateChangesTotal: allStateChanges.length,
  };
}

function total(counts: Partial<Record<TickResult, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v ?? 0;
  return n;
}

/** A free event field, sliced so one hand-edited or future payload cannot blow the section's
 * byte budget. Takes unknown because HarnessEvent carries its fields loosely typed. */
function field(v: unknown): string {
  return String(v).slice(0, STATE_CHANGE_FIELD_MAX);
}

/** A compact, bounded one-liner for one harness decision event, for the Fleet state changes
 * section. Every free string is sliced (field) and the whole line is capped again
 * (STATE_CHANGE_MAX) so the digest's byte bound holds for any event shape; the render adds the
 * timestamp and a roleCell-sliced role, so no unbounded field reaches the page. */
function describeStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "budget_paused": {
      const refused = ev.fallbackRejected
        ? ` (fallback ${field(ev.fallbackRejected)} refused)`
        : "";
      text = `budget paused — ${budgetPhrase(ev.spentUsd, ev.capUsd)} daily cost reached${refused}`;
      break;
    }
    case "budget_fallback":
      text = `budget fallback — ${budgetPhrase(ev.spentUsd, ev.capUsd)} daily cost reached; on ${field(ev.provider ?? "pi default")}/${field(ev.model ?? "pi default")} (cost n/a)`;
      break;
    case "budget_resumed":
      text = `budget resumed (${budgetPhrase(ev.spentUsd, ev.capUsd)} today)`;
      break;
    case "fleet_paused":
      text = "fleet paused — role loops stop starting new ticks";
      break;
    case "fleet_resumed":
      text = "fleet resumed — role loops tick again";
      break;
    case "rate_limit_hold":
      text = `429 hold ${rateLimitHoldPhrase(ev.holdMs, ev.escalation)} — ${Array.isArray(ev.roles) ? (ev.roles as unknown[]).slice(0, 4).map(field).join(", ") : "?"}`;
      break;
    case "rate_limit_resumed":
      text = "429 hold lifted — role loops tick again";
      break;
    case "max_concurrent_changed":
      text = `maxConcurrent ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "retention_changed":
      text = `sessionRetentionDays ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "config_changed": {
      const keys = Array.isArray(ev.keys)
        ? (ev.keys as unknown[]).slice(0, 6).map(field)
        : [];
      text = keys.length > 0 ? `config changed: ${keys.join(", ")}` : "config changed";
      break;
    }
    case "build_stale":
      text = `build ${shortSha(ev.build)} stale — main ${shortSha(ev.head)} ${field(ev.aheadCommits)} commit(s) ahead`;
      break;
    case "restart_pending":
      text = `restart pending — main ${shortSha(ev.head)} green; compiling`;
      break;
    case "restart":
      text = `restarting onto build ${shortSha(ev.to)}`;
      break;
    case "restart_refused":
      text = `restart onto ${shortSha(ev.to)} refused: ${field(ev.reason)}`;
      break;
    case "tick_deferred":
      text = "deferred — no work landed since last tick";
      break;
    case "orchestrator_start":
      text = `orchestrator started (pid ${field(ev.pid)}${ev.build ? `, build ${shortSha(ev.build)}` : ""})`;
      break;
    case "orchestrator_stop":
      text = "orchestrator stopped";
      break;
    case "supervisor_exit":
      text = `fleet down — generation ${field(ev.generation)} ${ev.signal ? `killed by ${field(ev.signal)}` : `exited ${field(ev.code)}`}${ev.reason ? `: ${field(ev.reason)}` : ""}`;
      break;
    default:
      text = ev.type;
  }
  return text.slice(0, STATE_CHANGE_MAX);
}
