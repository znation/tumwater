/** Terminal rendering of `tumwater doctor`'s report: a header line, one line per check
 * (level, name, detail), and the verdict. Lives in the CLI output layer beside the other
 * terminal renderers (src/report/report-render.ts, backlog-render.ts); the report's shape is the core
 * contract in doctor-checks.ts. Pure function of the report — no I/O. */
import type { DoctorReport } from "./doctor-checks.js";

/** Render the report: a header line, one line per check (level, name, detail), and the
 * verdict. The name column is one width for every row — 12 columns by default, widened to
 * the longest name in this report ("backlog headings" is 16) so no row's detail starts a
 * few columns early — which keeps a report of short-named checks byte-identical to the
 * fixed-width output. Warnings never affect the exit code — only fails do. */
export function renderDoctor(report: DoctorReport): string {
  const nameWidth = report.checks.reduce((w, c) => Math.max(w, c.name.length), 12);
  const lines = [report.header];
  for (const c of report.checks) lines.push(`${c.level.padEnd(5)} ${c.name.padEnd(nameWidth)} ${c.detail}`);
  lines.push(report.verdict);
  return lines.join("\n");
}
