/** Rendering half of the failure digest: turn a collected `FailureReportData` (failure-data.ts)
 * into the bounded Markdown the CLI's `--failures` report, the GUI/TUI failures tabs, and the
 * telemetry role's tick evidence all print. Pure function of the data — no I/O, no clock
 * reads — so the byte bound argued at collection holds here unchanged. The telemetry role's
 * evidence wrapper (telemetryDigest, TELEMETRY_DIGEST_DAYS) lives in tick/telemetry-digest.ts. */
import type { TickResult } from "../tick/tick-outcome.js";
import type { ClusterSection, FailureReportData, OutcomeRow } from "./failure-data.js";
import type { SpendCell } from "./time-spend.js";
import { plural } from "../text/phrases.js";
import { shortSha, usd } from "../text/format.js";
import { dayKey, dayLabel, formatTime, reportWindow } from "../text/datetime.js";
import { eventsRotationLabel } from "../events/events.js";

/** A cluster's role list shows at most this many names before a "+N more" remainder. */
const ROLES_SHOWN = 4;

/** Every `TickResult`, mapped to its display/column rank. Typed as a `Record<TickResult, …>`,
 * so adding a result to src/tick/tick-outcome.ts and forgetting it here is a compile error — the
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

/** The digest table's columns: every TickResult that at least one role logged in the window,
 * ranked by RESULT_ORDER (ties alphabetical), so the table's shape follows the window's
 * evidence instead of the whole fixed vocabulary — a fleet with no errors gets no error column. */
function columns(outcomes: OutcomeRow[]): TickResult[] {
  const present = new Set<TickResult>();
  for (const row of outcomes) {
    for (const k of Object.keys(row.counts)) present.add(k as TickResult);
  }
  return [...present].sort((a, b) => RESULT_ORDER[a] - RESULT_ORDER[b] || a.localeCompare(b));
}

/** A delta cell: `prev → cur`, with "—" on a side where the role had no ticks (the "new role"
 * case for the preceding window), so an absence is never rendered as an infinite increase.
 * The displayed halves may be raw counts (stringified here) or pre-rendered rate strings —
 * the tick-count halves exist only to decide the "—", not to be printed. */
function deltaCell(prevTicks: number, prev: string | number, ticks: number, cur: string | number): string {
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

/** An error rate as a whole percent, or "—" when the role ran no ticks (an absence is not
 * a 0% rate, for the same reason deltaCell says "—"). */
function rate(errors: number, ticks: number): string {
  if (ticks === 0) return "—";
  return `${Math.round((100 * errors) / ticks)}%`;
}

/** One time-and-spend cell: `x.x h · $y.yy`, or "—" when the role ended no tick on that
 * class — an absence is not a zero cost, for the same reason the Deltas cells say "—".
 * Hours carry one decimal: the digest prices agent-hours, and whole-hour rounding would
 * erase the difference between ten 200-ms errors and one 30-minute timeout. */
function spendCell(cell: SpendCell): string {
  if (cell.ticks === 0) return "—";
  return `${hoursPhrase(cell.ms)} · ${usd(cell.costUsd)}`;
}

/** A wall-clock span as agent-hours with one decimal — the digest's own time unit, distinct
 * from shortSpanPhrase's minutes-or-seconds (an event-feed phrase), because a summed 8-hour
 * timeout episode must not read as "480m". */
function hoursPhrase(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** Render the digest as bounded Markdown. Byte bound: for a given fleet the tables grow only
 * with the number of configured roles (fixed by config), the RESULT_ORDER vocabulary (fixed
 * by src/tick/tick-outcome.ts), and the time-and-spend section's LOSS_TOP loss-cause lines (fixed
 * by the cut), and every free string is capped — cluster examples at 120 chars (plus a
 * `… (+N chars)` cut marker when truncated, so a marked cut can never read as a complete
 * message — BUGS.md 2026-09-30), landed summaries at 100 under the same rule, a cluster's role list at 4 names plus a remainder count, and any loop id
 * sliced to 32 chars (config validation already refuses longer custom-loop ids, so the slice is
 * a guard rather than the real bound). Cluster counts are capped at top-N, and the Fleet state
 * changes section is capped at STATE_CHANGE_TOP lines with each payload at STATE_CHANGE_MAX and
 * each free field at STATE_CHANGE_FIELD_MAX; the landed list at LANDED_TOP lines, each capped
 * section closing with one remainder line when its cut dropped anything. Nothing here grows with how bad the window was:
 * measured 6,017 bytes at the CLI's default 14 days on the live fleet, and the worst-case
 * byte-bound fixture in test/failure-render.test.ts covers transition events too. Pure function
 * of FailureReportData: no I/O, no clock reads. */
export function renderFailureMarkdown(data: FailureReportData): string {
  const lines: string[] = [];
  lines.push("# tumwater failure digest");
  lines.push("");
  lines.push(
    `${reportWindow(data.from, data.to, data.days, eventsRotationLabel())} · ${data.ticks} ticks`,
  );
  if (data.emptyLog) lines.push("no events retained");
  else if (!data.hasEvents) lines.push(`no events in the last ${dayLabel(data.days)}`);
  else if (data.partial) lines.push(`partial: retained log starts ${data.oldestEventDate ?? "?"}`);

  // The causal frame before the counts: what the fleet DID in the window, so the reader can ask
  // whether the harness's response was right. Omitted entirely when the window held none. When
  // the newest-N cap cut the window's transitions, the remainder is named — a quiet window (no
  // line) and a truncated one must not look the same.
  if (data.stateChanges.length > 0) {
    lines.push("");
    lines.push("## Fleet state changes");
    for (const s of data.stateChanges) {
      lines.push(`- ${stateChangeStamp(s.ts)} ${roleCell(s.role)} — ${s.description}`);
    }
    const hidden = data.stateChangesTotal - data.stateChanges.length;
    if (hidden > 0) lines.push(`+${hidden} older transitions hidden`);
  }

  const cols = columns(data.outcomes);
  lines.push("");
  lines.push("## Outcome by role");
  if (data.outcomes.length === 0) {
    lines.push("_no tick_end events in the window_");
  } else {
    // The separator is joined exactly like the header: a Markdown table renders only when the
    // two rows hold the same number of cells, and a delimiter-less join collapses every `---:`
    // into one cell — invisible as plain text, where the digest is mostly read (BUGS.md
    // 2026-09-21). `---:` right-aligns the counts.
    lines.push(`| role | ${cols.join(" | ")} |`);
    lines.push(`| --- | ${cols.map(() => "---:").join(" | ")} |`);
    for (const row of data.outcomes) {
      lines.push(
        `| ${roleCell(row.role)} | ${cols.map((c) => row.counts[c] ?? 0).join(" | ")} |`,
      );
    }
  }

  // The same ticks priced by what they cost, so a 30-minute timeout outranks ten 200-ms
  // errors that the Outcome table above weighs equally. Two parts: the role × class table of
  // hours and dollars, then the top loss causes by time (an error cluster, or a role's
  // no_change total — the quiet loss no cluster names). Grows only with the role catalog
  // (fixed by config) and the LOSS_TOP cut, so the byte bound argued above holds.
  lines.push("");
  lines.push("## Time and spend by outcome");
  if (data.timeSpend.length === 0) {
    lines.push("_no tick_end events in the window_");
  } else {
    lines.push("| role | landed | no_change | error-class |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of data.timeSpend) {
      lines.push(
        `| ${roleCell(row.role)} | ${spendCell(row.classes.landed)} | ${spendCell(row.classes.no_change)} | ${spendCell(row.classes.error)} |`,
      );
    }
    lines.push("");
    lines.push("**Top loss causes by time:**");
    if (data.lossCauses.length === 0) {
      lines.push("_no loss to rank_");
    } else {
      for (const c of data.lossCauses) {
        const cause =
          c.kind === "no_change"
            ? `no_change on ${roleCell(c.roles[0] ?? "?")}`
            : c.kind === "review-rejected"
              ? `review-rejected authoring on ${roleCell(c.roles[0] ?? "?")}${c.example ? ` — ${c.example}` : ""}`
              : `${c.example} (${roleList(c.roles)})`;
        lines.push(`- ${hoursPhrase(c.ms)} · ${usd(c.costUsd)} — ${plural(c.ticks, "tick")}: ${cause}`);
      }
      // Mark the top-5 cut the way the cluster sections mark theirs: a capped ranking that
      // stays silent reads as a complete itemization of the window's loss (BUGS.md 2026-10-01).
      if (data.lossCausesHidden > 0) {
        const noun = data.lossCausesHidden === 1 ? "cause" : "causes";
        lines.push(`_+${data.lossCausesHidden} more loss ${noun} by time not listed_`);
      }
    }
  }

  // Prompt-token telemetry (PLANS.md, per-tick prompt-token plan): the per-role median prompt
  // send and how much of the prompt budget goes out before a tick's first edit. Omitted
  // entirely when no tick_end in the window carries the fields, so old logs and their golden
  // digests render unchanged.
  if (data.promptStats.length > 0) {
    lines.push("");
    lines.push("## Prompt tokens by role");
    for (const row of data.promptStats) {
      const share = Math.round(row.preEditShare * 100);
      lines.push(
        `- ${roleCell(row.role)}: median ${row.medianPromptTokens} prompt tokens/tick · ${share}% before first edit`,
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
        `| ${roleCell(d.role)} | ${deltaCell(d.prevTicks, d.prevTicks, d.ticks, d.ticks)} | ${deltaCell(d.prevTicks, rate(d.prevErrors, d.prevTicks), d.ticks, rate(d.errors, d.ticks))} | ${deltaCell(d.prevTicks, d.prevQuietKills, d.ticks, d.quietKills)} | ${rejectionCell(d.prevTicks, d.prevRejections, d.ticks, d.rejections)} |`,
      );
    }
  }

  // The title restates the section's contract: its total now covers the Outcome table's error
  // column AND its main_red cells (the baseline gate's own cause rides the tick, BUGS.md
  // 2026-09-28), so an operator cross-checking counts against the tables above is not misled
  // by a title that reads as the error column alone.
  renderClusters(lines, "Top error clusters (red-main causes included)", data.errors, "tick errors");
  renderClusters(lines, "Top warning clusters", data.warnings, "warnings");
  renderClusters(lines, "Top review failure clusters", data.reviewFailures, "review failures");
  renderClusters(lines, "Top rejection clusters", data.rejections, "rejections");

  lines.push("");
  lines.push("## Landed in the window");
  if (data.landed.length === 0) {
    lines.push("_nothing merged in the window_");
  } else {
    for (const c of data.landed) lines.push(`- ${shortSha(c.commit)} — ${c.summary}`);
    // Like the transitions' remainder line: a cut list says so, so a busy window's newest ten
    // are not mistaken for everything that merged.
    const hidden = data.landedTotal - data.landed.length;
    if (hidden > 0) lines.push(`+${hidden} older merges not listed`);
  }

  return lines.join("\n");
}

/** Push one "Top … clusters" section: each cluster as a `**N×** roles · first → last — example`
 * line (the collector supplies the order and the top-N cut), or a single `no <noun> in the
 * window` placeholder when the section is empty. */
function renderClusters(lines: string[], title: string, section: ClusterSection, noun: string): void {
  lines.push("");
  lines.push(`## ${title}`);
  if (section.clusters.length === 0) {
    lines.push(`_no ${noun} in the window_`);
    return;
  }
  for (const c of section.clusters) {
    lines.push(
      `- **${c.count}×** ${roleList(c.roles)} · ${dayShort(c.firstSeen)} → ${dayShort(c.lastSeen)} — ${c.example}`,
    );
  }
  // Mark the top-N cut the way roleList marks its own: a capped section that stays silent
  // reads as a full itemization, and an operator cross-checking the Deltas table above sees
  // counts this section never shows (BUGS.md 2026-09-22).
  const itemized = section.clusters.reduce((n, c) => n + c.count, 0);
  if (section.total > itemized) {
    const remaining = section.total - itemized;
    const clusters = section.hiddenClusters === 1 ? "cluster" : "clusters";
    const noun1 = remaining === 1 ? noun.replace(/s$/, "") : noun;
    lines.push(`_+${section.hiddenClusters} more ${clusters} holding ${remaining} ${noun1}_`);
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
  return dayKey(ts).slice(5);
}
