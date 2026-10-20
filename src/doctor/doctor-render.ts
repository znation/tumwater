/** Terminal rendering of `tumwater doctor`'s report: a header line, one line per check (level,
 * name, detail), the routing table of every seam the config can spawn, and the verdict. Lives
 * in the CLI output layer beside the other terminal renderers (src/report/report-render.ts,
 * backlog-render.ts); the report's shape is the core contract in doctor-checks.ts. Pure
 * function of the report — no I/O. */
import type { DoctorReport } from "./doctor-checks.js";
import { plural } from "../text/phrases.js";

/** One line per check (level, name, detail), the name column as wide as the longest name, at
 * least 12. */
function checkLines(checks: DoctorReport["checks"]): string[] {
  const nameWidth = checks.reduce((w, c) => Math.max(w, c.name.length), 12);
  return checks.map((c) => `${c.level.padEnd(5)} ${c.name.padEnd(nameWidth)} ${c.detail}`);
}

/** Render the report: a header line, one line per check (level, name, detail), the routing
 * table (each seam's label, its agent-qualified selector, and its backend), and the verdict.
 * The name column is one width for every row — 12 columns by default, widened to the longest
 * name in this report ("backlog headings" is 16) so no row's detail starts a few columns early
 * — which keeps a report of short-named checks byte-identical to the fixed-width output.
 * Warnings never affect the exit code — only fails do. */
export function renderDoctor(report: DoctorReport): string {
  const lines = [report.header, ...checkLines(report.checks)];
  if (report.routing.length > 0) {
    const width = report.routing.reduce((w, s) => Math.max(w, s.label.length), "job".length);
    lines.push("routing: job · model · backend");
    for (const s of report.routing)
      lines.push(`  ${s.label.padEnd(width)}  ${s.selector}  (${s.backend})`);
  }
  lines.push(report.verdict);
  return lines.join("\n");
}

/** The report with only its warn and fail checks; header, routing, and verdict stay. */
export function problemsOnly(report: DoctorReport): DoctorReport {
  return { ...report, checks: report.checks.filter((c) => c.level !== "ok") };
}

/** `--problems`: the header, the warn and fail rows (name column sized over those rows alone), a
 * line counting the hidden ok rows (left out when none), and the verdict — never the routing
 * table. Takes the full report so it can count what it hides. */
export function renderDoctorProblems(report: DoctorReport): string {
  const shown = problemsOnly(report).checks;
  const hidden = report.checks.length - shown.length;
  const lines = [report.header, ...checkLines(shown)];
  if (hidden > 0)
    lines.push(`${plural(hidden, "ok check")} hidden — run tumwater doctor for the full report`);
  lines.push(report.verdict);
  return lines.join("\n");
}
