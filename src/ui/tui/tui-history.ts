/** The TUI's History pane body: the completed-tick rows `tumwater history` prints (and the
 * dashboard's History view renders), one line each, newest first. history-data.ts already
 * builds the rows (`readTickRows`); this only renders them for the pane, so the TUI, the CLI,
 * and the GUI cannot disagree about what a tick's row says. Deliberately unaligned — the pane
 * has no full terminal width to measure columns against — so the parity with `history` is the
 * rows and their fields, not the CLI table's padding. Pure: a function of the rows it is
 * handed. */
import { tickRowCells, type TickRow } from "../../history/history-data.js";

/** The pane body for a set of tick rows: `time  loop #tick  result  duration`, then `usage`
 * and `detail` when they carry anything, joined newest-first by newlines. The cells come from
 * history-data.ts's tickRowCells, the one home the CLI's table builds on too, so a null
 * `durationMs` (the tick's start sits outside the scanned window) shows the em dash here the
 * same way; an empty `usage` (neither tokens nor cost) and an empty
 * `detail` are omitted rather than leaving a gap. No rows renders `""`, which the pane's
 * `emptyNote` replaces. `row.result` is the string history-data.ts resolved (including a
 * joined landing verdict), never reclassified here. */
export function historyPaneText(rows: readonly TickRow[]): string {
  return rows
    .map((row) => {
      const { duration } = tickRowCells(row);
      const parts = [row.time, `${row.loop} #${row.tick}`, row.result, duration];
      if (row.usage) parts.push(row.usage);
      if (row.detail) parts.push(row.detail);
      return parts.join("  ");
    })
    .join("\n");
}
