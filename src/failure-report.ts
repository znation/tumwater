/** Rendering half of the failure digest: turn a collected `FailureReportData` (failure-data.ts)
 * into the bounded Markdown the CLI's `--failures` report, the GUI/TUI failures tabs, and the
 * telemetry role's tick evidence all print. Pure function of the data — no I/O, no clock
 * reads — so the byte bound argued at collection holds here unchanged. */
import type { TickResult } from "./types.js";
import { collectFailureReport, type Cluster, type FailureReportData, type OutcomeRow } from "./failure-data.js";
import { dayLabel, formatTime, reportWindow, shortSha, formatDate } from "./text.js";

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


/** A cluster's role list shows at most this many names before a "+N more" remainder. */
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

/** The month-day half of a day key. Every cluster date lies inside the digest's window (at
 * most REPORT_MAX_DAYS), so the year is redundant on the line and the bytes are better spent
 * on the top-N budget. */
function dayShort(ts: number): string {
  return formatDate(new Date(ts)).slice(5);
}
