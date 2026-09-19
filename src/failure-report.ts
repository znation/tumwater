import type { HarnessEvent, TickResult } from "./types.js";
import { readWindowEvents } from "./event-window.js";
import { eventDayKey, eventRole } from "./events.js";
import { formatDate, shortSha } from "./text.js";

/** The `telemetry` role's own digest window, in local calendar days (plans/telemetry-role.md).
 * The CLI keeps the usage report's 14-day default; the role reads one day so a cluster
 * re-surfaces only while it is live. The 2×-window read below still spans two days, which is
 * what makes the delta line meaningful. Kept here, not in the role, so 2/2 can import it. */
export const TELEMETRY_DIGEST_DAYS = 1;

/** Caps that keep the digest bounded regardless of how bad the window was — the top-N
 * clusters, one trimmed example each, and the newest N landed commits. See the render-doc
 * byte bound below for what these buy. */
const ERROR_TOP = 7;
const WARNING_TOP = 7;
const REJECTION_TOP = 5;
const LANDED_TOP = 10;
const EXAMPLE_MAX = 120;
const SUMMARY_MAX = 100;
const ROLES_SHOWN = 4;

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
export interface Cluster {
  key: string; // the normalized form, the grouping key
  count: number;
  roles: string[]; // unique, sorted
  firstSeen: number; // epoch ms
  lastSeen: number;
  example: string; // the first verbatim occurrence, trimmed for display
}

/** One `tick_end` result tally, per role. */
export interface OutcomeRow {
  role: string;
  counts: Partial<Record<TickResult, number>>;
}

/** One role's current-vs-preceding-window metrics. A zero side means the role had no ticks
 * there ("new" for a role absent from the preceding window). */
export interface DeltaRow {
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
export interface LandedCommit {
  ts: number;
  commit: string;
  summary: string;
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
  errorClusters: Cluster[];
  warningClusters: Cluster[];
  rejectionClusters: Cluster[];
  landed: LandedCommit[];
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

/** One role's tick-end metrics, used for the delta row. */
interface RoleStats {
  ticks: number;
  errors: number;
  quietKills: number;
  rejections: number;
}

function roleStats(events: HarnessEvent[]): Map<string, RoleStats> {
  const byRole = new Map<string, RoleStats>();
  for (const ev of events) {
    if (ev.type !== "tick_end") continue;
    const role = eventRole(ev);
    const stats = byRole.get(role) ?? { ticks: 0, errors: 0, quietKills: 0, rejections: 0 };
    stats.ticks++;
    if (ev.result === "error") stats.errors++;
    else if (ev.result === "quiet_killed") stats.quietKills++;
    else if (ev.result === "rejected") stats.rejections++;
    byRole.set(role, stats);
  }
  return byRole;
}

/** Collect the digest over the last `days` local calendar days, reading a 2×-long window once
 * and partitioning it in memory so the delta against the preceding equal window costs no
 * second tail read. */
export function collectFailureReport(root: string, days: number): FailureReportData {
  const now = new Date();
  const dayAt = (offsetFromToday: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetFromToday);
  const from = formatDate(dayAt(days - 1));
  const to = formatDate(dayAt(0));
  const priorFrom = formatDate(dayAt(days * 2 - 1));

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

  const errorClusters = clusterMessages(
    tickEvents
      .filter((ev) => typeof ev.error === "string" && ev.error !== "")
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

  const landed: LandedCommit[] = current
    .filter((ev) => ev.type === "merged")
    .map((ev) => ({
      ts: ev.ts,
      commit: typeof ev.commit === "string" ? ev.commit : "?",
      summary: (typeof ev.summary === "string" ? ev.summary : "").trim().slice(0, SUMMARY_MAX),
    }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, LANDED_TOP);

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
    rejectionClusters,
    landed,
  };
}

function total(counts: Partial<Record<TickResult, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v ?? 0;
  return n;
}

/** `N days`, singular at 1 — the digest is read at both the CLI's 14 and the role's 1. */
function dayLabel(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
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

function rate(errors: number, ticks: number): string {
  if (ticks === 0) return "—";
  return `${Math.round((100 * errors) / ticks)}%`;
}

/** Render the digest as bounded Markdown. Byte bound: for a given fleet the tables grow only
 * with the number of configured roles (fixed by config) and the RESULT_ORDER vocabulary (fixed
 * by src/types.ts), and every free string is capped — cluster examples at 120 chars, landed
 * summaries at 100, a cluster's role list at 4 names plus a remainder count, and any loop id
 * sliced to 32 chars (config validation already refuses longer custom-loop ids, so the slice is
 * a guard rather than the real bound). Cluster counts are capped at top-N. Nothing here grows
 * with how bad the window was: measured 5,554 bytes at the CLI's default 14 days on the live
 * fleet, so it stays a rounding error against the tick prompt. Pure function of
 * FailureReportData: no I/O, no clock reads. */
export function renderFailureMarkdown(data: FailureReportData): string {
  const lines: string[] = [];
  lines.push("# tumwater failure digest");
  lines.push("");
  lines.push(
    `Window: ${data.from} → ${data.to} (${dayLabel(data.days)}) · source: events.jsonl (rotated at 16 MB) · ${data.ticks} ticks`,
  );
  if (data.emptyLog) lines.push("no events retained");
  else if (!data.hasEvents) lines.push(`no events in the last ${dayLabel(data.days)}`);
  else if (data.partial) lines.push(`partial: retained log starts ${data.oldestEventDate ?? "?"}`);

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
        `| ${roleCell(d.role)} | ${deltaCell(d.prevTicks, String(d.prevTicks), d.ticks, String(d.ticks))} | ${deltaCell(d.prevTicks, rate(d.prevErrors, d.prevTicks), d.ticks, rate(d.errors, d.ticks))} | ${deltaCell(d.prevTicks, String(d.prevQuietKills), d.ticks, String(d.quietKills))} | ${deltaCell(d.prevTicks, String(d.prevRejections), d.ticks, String(d.rejections))} |`,
      );
    }
  }

  renderClusters(lines, "Top error clusters", data.errorClusters, "no tick errors in the window");
  renderClusters(lines, "Top warning clusters", data.warningClusters, "no warnings in the window");
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

/** The month-day half of a day key. Every cluster date lies inside the digest's window (at
 * most REPORT_MAX_DAYS), so the year is redundant on the line and the bytes are better spent
 * on the top-N budget. */
function dayShort(ts: number): string {
  return formatDate(new Date(ts)).slice(5);
}
