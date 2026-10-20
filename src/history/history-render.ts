// vocabulary: plain
/** Rendering half of `tumwater history`: format a `TickRow[]`/summary — collected by
 * history-data.ts — into the aligned table or `--summary` text `cmdHistory` (history.ts)
 * prints. The sibling observing view report does the same (src/report/report.ts prints
 * src/report/report-render.ts's Markdown), and this split keeps the same separation
 * "what happened / how it prints" that report and failure draw: the command owns argument
 * parsing and stdout, this module owns column widths and cell wording. The rows themselves
 * live in history-data.ts because the grep haystack shares the row line. */
import { formatTimestamp, humanSeconds } from "../text/datetime.js";
import { roleLabel } from "../roles/role-labels.js";
import { displayWidth, padToWidth } from "../text/text-width.js";
import { compactTokens, usd } from "../text/format.js";
import { tickRowCells, tickRowLine, type HistoryModelSummaryRow, type HistorySummaryRow, type TickRow, type TickRowCells } from "./history-data.js";

/** Each TickRowCells column's measured width in terminal display columns. A mapped type on
 * purpose: adding a column to TickRowCells cannot leave it without a width. */
type RowWidths = { [K in keyof TickRowCells]: number };

/** Each column's width from its unpadded cell. Text cells measure terminal display columns
 * (displayWidth), not UTF-16 code units: a role name holding CJK or emoji renders two columns
 * per code point, and a code-unit padEnd lets that row's later columns drift right of its
 * ASCII neighbors. The tick cell measures before its "#" prefix is added (the prefix rides
 * outside the pad), and duration is ASCII, so both take plain length. */
function widthsOf(cells: TickRowCells): RowWidths {
  return {
    loop: displayWidth(cells.loop),
    tick: cells.tick.length,
    result: displayWidth(cells.result),
    model: displayWidth(cells.model),
    duration: cells.duration.length,
    usage: displayWidth(cells.usage),
  };
}

/** The per-column maxima over every row the table shows — the widths derive from the rows
 * actually shown, so a single-row table has no padding gap. */
export function widestWidths(rows: TickRow[]): RowWidths {
  const widths = { loop: 0, tick: 0, result: 0, model: 0, duration: 0, usage: 0 };
  for (const row of rows) {
    const w = widthsOf(tickRowCells(row));
    widths.loop = Math.max(widths.loop, w.loop);
    widths.tick = Math.max(widths.tick, w.tick);
    widths.result = Math.max(widths.result, w.result);
    widths.model = Math.max(widths.model, w.model);
    widths.duration = Math.max(widths.duration, w.duration);
    widths.usage = Math.max(widths.usage, w.usage);
  }
  return widths;
}

/** One aligned table line: fixed-width columns over the row set, then the free-text detail.
 * Every cell is padded to its column's width even when empty — usage is the one cell that can
 * be empty (a tick with neither tokens nor cost), and dropping it would pull the detail left,
 * misaligning that row against its neighbors; tickRowLine strips only the trailing pad. The
 * row's column order rides history-data.ts's tickRowLine, shared with the grep haystack so the
 * two cannot disagree about which field sits where. */
export function renderRow(row: TickRow, widths: RowWidths): string {
  return tickRowLine(row, (column, value) => padToWidth(value, widths[column]));
}

/** The `--summary` text: a header, one line per role, then the total line. The role column pads to
 * display width; each number column right-aligns under its header; the `time` column is the sum of
 * each role's run spans, `—` when none of the role's rows carried a span; the last column,
 * `last change`, is the newest change's timestamp (`—` when none) and is left-aligned, unpadded. */
export function renderSummary(summary: { roles: HistorySummaryRow[]; total: HistorySummaryRow }): string {
  return renderSummaryTable("role", [...summary.roles, summary.total].map((row) => ({ label: roleLabel(row.role), row })));
}

/** The `--summary --by model` text: renderSummary's table with one line per model (`(unknown)` for
 * the null bucket), then the total line. */
export function renderModelSummary(summary: { models: HistoryModelSummaryRow[]; total: HistorySummaryRow }): string {
  return renderSummaryTable("model", [
    ...summary.models.map((row) => ({ label: row.model ?? "(unknown)", row })),
    { label: "total", row: summary.total },
  ]);
}

function renderSummaryTable(header: string, all: { label: string; row: HistorySummaryRow | HistoryModelSummaryRow }[]): string {
  const roleWidth = Math.max(...[header, ...all.map((r) => r.label)].map(displayWidth));
  const cols = ["runs", "changes", "none", "refused", "problems", "tokens", "cost", "time"] as const;
  const cell = (r: HistorySummaryRow | HistoryModelSummaryRow, c: (typeof cols)[number]): string =>
    c === "tokens"
      ? compactTokens(r.tokens)
      : c === "cost"
        ? usd(r.costUsd)
        : c === "time"
          ? r.durationMs === undefined
            ? "—"
            : humanSeconds(r.durationMs / 1000)
          : String(c === "runs" ? r.runs : r[c]);
  const widths = cols.map((c) => Math.max(c.length, ...all.map((r) => cell(r.row, c).length)));
  const line = (role: string, cells: string[], lastChange: string): string =>
    [padToWidth(role, roleWidth), ...cells.map((c, i) => c.padStart(widths[i] ?? 0)), lastChange].join("  ").trimEnd();
  return [
    line(header, [...cols], "last change"),
    ...all.map(({ label, row }) => line(label, cols.map((c) => cell(row, c)), row.lastChangeTs === null ? "—" : formatTimestamp(row.lastChangeTs))),
  ].join("\n");
}
