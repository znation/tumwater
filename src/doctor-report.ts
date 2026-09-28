/** The doctor report contract and its terminal renderer, split out of doctor.ts so the
 * sibling check modules (doctor-orphans.ts, launchservices.ts) can depend on the shared
 * CheckOutcome shape directly instead of type-importing it from the aggregator that runs
 * them. doctor.ts composes the checks into a DoctorReport; this module owns the shape of
 * that report and how it prints. */

/** One line of the doctor report: a check's verdict plus what it found. "ok" and "warn" never
 * affect the exit code; only "fail" does (the CLI sets process.exitCode = 1 on any fail). The
 * orphan check lives in doctor-orphans.ts and returns this shape too. */
export interface CheckOutcome {
  level: "ok" | "warn" | "fail";
  detail: string;
}

/** The full pre-flight report: a header carrying harness state, one entry per check in fixed
 * order, and the verdict line. */
export interface DoctorReport {
  header: string;
  checks: Array<{ name: string } & CheckOutcome>;
  verdict: string;
}

/** Render the report: a header line, one line per check (level, name, detail), and the
 * verdict. Warnings never affect the exit code — only fails do. */
export function renderDoctor(report: DoctorReport): string {
  const lines = [report.header];
  for (const c of report.checks) lines.push(`${c.level.padEnd(5)} ${c.name.padEnd(12)} ${c.detail}`);
  lines.push(report.verdict);
  return lines.join("\n");
}
