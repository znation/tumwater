/** The TUI's History pane body: the completed-run rows `tumwater history` prints (and the
 * dashboard's History view renders), one line each, newest first. history-data.ts already
 * builds the rows (`readRunRows`); this only renders them for the pane, so the TUI, the CLI,
 * and the GUI cannot disagree about what a run's row says. Deliberately unaligned — the pane
 * has no full terminal width to measure columns against — so the parity with `history` is the
 * rows and their fields, not the CLI table's padding. Pure: a function of the rows it is
 * handed. */
import { runRowCells, type RunRow } from "../../history/history-data.js";

/** The pane body for a set of run rows: `time  role #run  result  duration`, then `model`
 * (between the result and the duration), and `usage` and `detail` when they carry anything,
 * joined newest-first by newlines. Both the result and the duration cells come from
 * history-data.ts's runRowCells, the one home the CLI's table builds on too, so a run cut
 * off at its model's context ceiling reads `no change (cut off)` here the way it does in
 * `history`, and a null `durationMs` (the run's start sits outside the scanned window)
 * shows the em dash the same way; an empty `model` (the start named none or sat outside
 * the window), an empty `usage` (neither tokens nor cost), and an empty `detail` are
 * omitted rather than leaving a gap. No rows renders `""`, which the pane's `emptyNote`
 * replaces. The result cell goes through eventTypeLabel exactly as the CLI table's does,
 * so a merged run's resolved verdict and a `no_change` read the same label in both. */
export function historyPaneText(rows: readonly RunRow[]): string {
  return rows
    .map((row) => {
      const cells = runRowCells(row);
      const parts = [row.time, `${row.role} #${row.run}`, cells.result];
      if (row.model) parts.push(row.model);
      parts.push(cells.duration);
      if (row.usage) parts.push(row.usage);
      if (row.detail) parts.push(row.detail);
      return parts.join("  ");
    })
    .join("\n");
}
