import type { HarnessEvent, TickResult } from "./types.js";
import { readWindowEvents } from "./event-window.js";
import { eventDayKey, eventRole } from "./events.js";
import { budgetPhrase, dayAt, dayLabel, formatDate, formatTime, reportWindow, shortSha } from "./text.js";

/** The `telemetry` role's own digest window, in local calendar days (plans/telemetry-role.md).
 * The CLI keeps the usage report's 14-day default; the role reads one day so a cluster
 * re-surfaces only while it is live. The 2×-window read below still spans two days, which is
 * what makes the delta line meaningful. Kept here, not in the role, so 2/2 can import it. */
export const TELEMETRY_DIGEST_DAYS = 1;

/** The `telemetry` role's tick-time evidence: the failure digest rendered over its own
 * one-day window. A missing or corrupt log omits the block (undefined) and never fails the
 * tick — an observer must not break on bookkeeping (plans/telemetry-role.md). The window and
 * the swallow-errors policy live with the digest, not in the tick lifecycle that injects it. */
export function telemetryDigest(root: string): string | undefined {
  try {
    return renderFailureMarkdown(collectFailureReport(root, TELEMETRY_DIGEST_DAYS));
  } catch {
    return undefined;
  }
}

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
const ROLES_SHOWN = 4;

/** The transition events the digest replays: the decisions the harness made about itself (the
 * cap/fleet gate, live-config edits, self-hosted redeploys, need-based deferrals, orchestrator
 * lifecycle). They are the evidence the telemetry role's load-bearing rule asks it to judge —
 * whether the harness's RESPONSE to a failure was wrong (plans/telemetry-role.md) — so they sit
 * beside the outcomes rather than being dropped. */
const STATE_CHANGE_TYPES = new Set<string>([
  "budget_paused",
  "budget_fallback",
  "budget_resumed",
  "fleet_paused",
  "fleet_resumed",
  "max_concurrent_changed",
  "retention_changed",
  "config_changed",
  "build_stale",
  "restart_pending",
  "restart",
  "tick_deferred",
  "orchestrator_start",
  "orchestrator_stop",
]);
/** The Fleet state changes section's caps: newest N transitions, each line's payload capped at
 * STATE_CHANGE_MAX, each free field within it at STATE_CHANGE_FIELD_MAX. Together with the
 * fixed timestamp/role cells these make the section's bytes a constant, so the digest's ~6 KB
 * bound holds no matter how many transitions the window holds or how long a field is. */
const STATE_CHANGE_TOP = 6;
const STATE_CHANGE_MAX = 72;
const STATE_CHANGE_FIELD_MAX = 24;

/** Every `TickResult`, mapped to its display/column rank. Typed as a `Record<TickResult, …>`,
 * so adding a result to src/types.ts and forgetting it here is a compile error — the
 * vocabulary is closed by the type checker, not by a comment. Order runs from "made progress"
 * through "did not" to the operator/shutdown outcomes. */
const RESULT_ORDER: Record<TickResult, number> = {
  changed: 0,
  queued: 1,
  no_change: 2,
  refused: 3,
  skipped: 4,
  rejected: 5,
  review_error: 6,
  merge_conflict: 7,
  merge_blocked: 8,
  main_red: 9,
  error: 10,
  quiet_killed: 11,
  aborted: 12,
  user_aborted: 13,
};

/** A normalized cluster of like error/warning/rejection strings. */
interface Cluster {
  key: string; // the normalized form, the grouping key
  count: number;
  roles: string[]; // unique, sorted
  firstSeen: number; // epoch ms
  lastSeen: number;
  example: string; // the first verbatim occurrence, trimmed for display
}

/** One `tick_end` result tally, per role. */
interface OutcomeRow {
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
interface FailureReportData {
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
  errorClusters: Cluster[];
  warningClusters: Cluster[];
  reviewFailureClusters: Cluster[];
  rejectionClusters: Cluster[];
  landed: LandedCommit[];
  stateChanges: StateChange[];
}

/** A cluster key is the message with the volatile parts replaced, rules applied in this order:
 * hex shas, absolute paths, ISO timestamps, durations, then standalone integers. The integer
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
 * polluting the verbatim example. */
function clusterMessages(
  messages: Array<{ message: string; role: string; ts: number; keyPrefix?: string }>,
  top: number,
): Cluster[] {
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
  return [...drafts.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, top)
    .map((d) => ({
      key: d.key,
      count: d.count,
      roles: [...d.roles].sort((a, b) => a.localeCompare(b)),
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      example: d.example,
    }));
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
  const errorClusters = clusterMessages(
    tickEvents
      .filter((ev) => ev.result === "error" && typeof ev.error === "string" && ev.error !== "")
      .map((ev) => ({ message: ev.error as string, role: eventRole(ev), ts: ev.ts })),
    ERROR_TOP,
  );
  const warningClusters = clusterMessages(
    current
      .filter((ev) => ev.type === "warning" && typeof ev.message === "string" && ev.message !== "")
      .map((ev) => ({ message: ev.message as string, role: eventRole(ev), ts: ev.ts })),
    WARNING_TOP,
  );
  // Rejections cluster on (role, reasons[0]) — the field the event feed renders — so two
  // different rejection reasons from the same role stay separate rows.
  const rejectionClusters = clusterMessages(
    current
      .filter((ev) => ev.type === "review_rejected" && Array.isArray(ev.reasons))
      .map((ev) => {
        const reasons = ev.reasons as unknown[];
        const first = typeof reasons[0] === "string" ? (reasons[0] as string) : "no reasons given";
        return { message: first, role: eventRole(ev), ts: ev.ts, keyPrefix: `${eventRole(ev)}\u0000` };
      }),
    REJECTION_TOP,
  );

  // Landing review failures: a reviewer that could not return a parseable verdict (a dead
  // backend, a transport error) fails closed and keeps the commit, but its authoring tick ends
  // `queued`/`no_change` — so the failure lives on the `review_failed` event, never on
  // `tick_end.error`. Clustered on their own so the telemetry role can see a gate that keeps
  // failing without misreading it as a tick error (BUGS.md 2026-09-21).
  const reviewFailureClusters = clusterMessages(
    current
      .filter((ev) => ev.type === "review_failed" && typeof ev.message === "string" && ev.message !== "")
      .map((ev) => ({ message: ev.message as string, role: eventRole(ev), ts: ev.ts })),
    REVIEW_FAILURE_TOP,
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
  // description is bounded at collection so render stays a pure function of this data.
  const stateChanges: StateChange[] = current
    .filter((ev) => STATE_CHANGE_TYPES.has(ev.type))
    .map((ev) => ({ ts: ev.ts, role: eventRole(ev), description: describeStateChange(ev) }))
    .sort((a, b) => a.ts - b.ts)
    .slice(-STATE_CHANGE_TOP);

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
    errorClusters,
    warningClusters,
    reviewFailureClusters,
    rejectionClusters,
    landed,
    stateChanges,
  };
}

function total(counts: Partial<Record<TickResult, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v ?? 0;
  return n;
}

/** The result columns that occurred, in RESULT_ORDER. */
function columns(outcomes: OutcomeRow[]): TickResult[] {
  const present = new Set<TickResult>();
  for (const row of outcomes) {
    for (const k of Object.keys(row.counts)) present.add(k as TickResult);
  }
  return [...present].sort((a, b) => RESULT_ORDER[a] - RESULT_ORDER[b] || a.localeCompare(b));
}

/** A delta cell: `prev → cur`, with "—" on a side where the role had no ticks (the "new role"
 * case for the preceding window), so an absence is never rendered as an infinite increase. */
function deltaCell(prevTicks: number, prev: string, ticks: number, cur: string): string {
  return `${prevTicks === 0 ? "—" : prev} → ${ticks === 0 ? "—" : cur}`;
}

/** The rejections column's cell. It cannot reuse deltaCell: a rejection is logged by the
 * landing slot, so its authoring tick_end can fall in the other window — a role with a
 * rejection must show it even when its tick count is 0. Presence is judged on the rejection
 * count itself (the role is "absent" from the column only with neither ticks nor rejections). */
function rejectionCell(prevTicks: number, prevRejections: number, ticks: number, rejections: number): string {
  const prev = prevTicks === 0 && prevRejections === 0 ? "—" : String(prevRejections);
  const cur = ticks === 0 && rejections === 0 ? "—" : String(rejections);
  return `${prev} → ${cur}`;
}

function rate(errors: number, ticks: number): string {
  if (ticks === 0) return "—";
  return `${Math.round((100 * errors) / ticks)}%`;
}

/** Render the digest as bounded Markdown. Byte bound: for a given fleet the tables grow only
 * with the number of configured roles (fixed by config) and the RESULT_ORDER vocabulary (fixed
 * by src/types.ts), and every free string is capped — cluster examples at 120 chars, landed
 * summaries at 100, a cluster's role list at 4 names plus a remainder count, and any loop id
 * sliced to 32 chars (config validation already refuses longer custom-loop ids, so the slice is
 * a guard rather than the real bound). Cluster counts are capped at top-N, and the Fleet state
 * changes section is capped at STATE_CHANGE_TOP lines with each payload at STATE_CHANGE_MAX and
 * each free field at STATE_CHANGE_FIELD_MAX. Nothing here grows with how bad the window was:
 * measured 6,017 bytes at the CLI's default 14 days on the live fleet, and the worst-case
 * byte-bound fixture in test/failure-report.test.ts covers transition events too. Pure function
 * of FailureReportData: no I/O, no clock reads. */
export function renderFailureMarkdown(data: FailureReportData): string {
  const lines: string[] = [];
  lines.push("# tumwater failure digest");
  lines.push("");
  lines.push(
    `${reportWindow(data.from, data.to, data.days)} · ${data.ticks} ticks`,
  );
  if (data.emptyLog) lines.push("no events retained");
  else if (!data.hasEvents) lines.push(`no events in the last ${dayLabel(data.days)}`);
  else if (data.partial) lines.push(`partial: retained log starts ${data.oldestEventDate ?? "?"}`);

  // The causal frame before the counts: what the fleet DID in the window, so the reader can ask
  // whether the harness's response was right. Omitted entirely when the window held none.
  if (data.stateChanges.length > 0) {
    lines.push("");
    lines.push("## Fleet state changes");
    for (const s of data.stateChanges) {
      lines.push(`- ${stateChangeStamp(s.ts)} ${roleCell(s.role)} — ${s.description}`);
    }
  }

  const cols = columns(data.outcomes);
  lines.push("");
  lines.push("## Outcome by role");
  if (data.outcomes.length === 0) {
    lines.push("_no tick_end events in the window_");
  } else {
    lines.push(`| role | ${cols.join(" | ")} |`);
    lines.push(`| --- |${cols.map(() => " ---:").join("")} |`);
    for (const row of data.outcomes) {
      lines.push(
        `| ${roleCell(row.role)} | ${cols.map((c) => row.counts[c] ?? 0).join(" | ")} |`,
      );
    }
  }

  lines.push("");
  lines.push(`## Deltas vs the preceding ${dayLabel(data.days)}`);
  if (data.deltas.length === 0) {
    lines.push("_no ticks in either window_");
  } else {
    lines.push("| role | ticks | error rate | quiet kills | rejections |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const d of data.deltas) {
      lines.push(
        `| ${roleCell(d.role)} | ${deltaCell(d.prevTicks, String(d.prevTicks), d.ticks, String(d.ticks))} | ${deltaCell(d.prevTicks, rate(d.prevErrors, d.prevTicks), d.ticks, rate(d.errors, d.ticks))} | ${deltaCell(d.prevTicks, String(d.prevQuietKills), d.ticks, String(d.quietKills))} | ${rejectionCell(d.prevTicks, d.prevRejections, d.ticks, d.rejections)} |`,
      );
    }
  }

  renderClusters(lines, "Top error clusters", data.errorClusters, "no tick errors in the window");
  renderClusters(lines, "Top warning clusters", data.warningClusters, "no warnings in the window");
  renderClusters(lines, "Review failures", data.reviewFailureClusters, "no landing review failures in the window");
  renderClusters(lines, "Review rejections", data.rejectionClusters, "no review rejections in the window");

  lines.push("");
  lines.push("## Landed in the window");
  if (data.landed.length === 0) {
    lines.push("_nothing merged in the window_");
  } else {
    for (const c of data.landed) lines.push(`- ${shortSha(c.commit)} — ${c.summary}`);
  }

  return lines.join("\n");
}

function renderClusters(lines: string[], title: string, clusters: Cluster[], empty: string): void {
  lines.push("");
  lines.push(`## ${title}`);
  if (clusters.length === 0) {
    lines.push(`_${empty}_`);
    return;
  }
  for (const c of clusters) {
    lines.push(
      `- **${c.count}×** ${roleList(c.roles)} · ${dayShort(c.firstSeen)} → ${dayShort(c.lastSeen)} — ${c.example}`,
    );
  }
}

/** The cluster's roles, capped so a fleet-wide cluster cannot blow the byte bound; the count of
 * the omitted remainder is kept so the cluster's reach stays legible. */
function roleList(roles: string[]): string {
  const shown = roles.slice(0, ROLES_SHOWN).map(roleCell).join(", ");
  const rest = roles.length - ROLES_SHOWN;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/** Config validation caps custom-loop ids at 32 chars; this slice keeps the render's byte bound
 * true even for a hand-edited state file or a future catalog id. */
function roleCell(role: string): string {
  return role.slice(0, 32);
}

/** A transition line's local `MM-DD HH:MM` stamp — the year is redundant inside the window and
 * the seconds add bytes without adding causality. */
function stateChangeStamp(ts: number): string {
  return `${dayShort(ts)} ${formatTime(new Date(ts)).slice(0, 5)}`;
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
    case "tick_deferred":
      text = "deferred — no work landed since last tick";
      break;
    case "orchestrator_start":
      text = `orchestrator started (pid ${field(ev.pid)}${ev.build ? `, build ${shortSha(ev.build)}` : ""})`;
      break;
    case "orchestrator_stop":
      text = "orchestrator stopped";
      break;
    default:
      text = ev.type;
  }
  return text.slice(0, STATE_CHANGE_MAX);
}

/** The month-day half of a day key. Every cluster date lies inside the digest's window (at
 * most REPORT_MAX_DAYS), so the year is redundant on the line and the bytes are better spent
 * on the top-N budget. */
function dayShort(ts: number): string {
  return formatDate(new Date(ts)).slice(5);
}
