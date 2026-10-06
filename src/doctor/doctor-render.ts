/** Terminal rendering of `tumwater doctor`'s report: a header line, one line per check
 * (level, name, detail), and the verdict. Lives in the CLI output layer beside the other
 * terminal renderers (report-render.ts, backlog-render.ts); the report's shape is the core
 * contract in doctor-checks.ts. Pure function of the report — no I/O. */
import type { DoctorReport } from "./doctor-checks.js";

/** Render the report: a header line, one line per check (level, name, detail), and the
 * verdict. Warnings never affect the exit code — only fails do. */
export function renderDoctor(report: DoctorReport): string {
  const lines = [report.header];
  for (const c of report.checks) lines.push(`${c.level.padEnd(5)} ${c.name.padEnd(12)} ${c.detail}`);
  lines.push(report.verdict);
  return lines.join("\n");
}
