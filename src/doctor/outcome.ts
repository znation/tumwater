/** The doctor report's one-line outcome contract, in its own module so every check module
 * shares the shape and its constructors without a runtime import cycle: doctor-checks.ts
 * value-imports claudeSeamsInUse from doctor-model-checks.ts, so that pair cannot value-import
 * each other. doctor-checks.ts, doctor-model-checks.ts, doctor-orphans.ts, doctor-backlog.ts,
 * and doctor-launch-services.ts all import from here. */

/** One line of the doctor report: a check's verdict plus what it found. "ok" and "warn" never
 * affect the exit code; only "fail" does (the CLI sets process.exitCode = 1 on any fail). */
export interface CheckOutcome {
  level: "ok" | "warn" | "fail";
  detail: string;
}

/** Constructors for the one CheckOutcome shape, so each check names its verdict (`okOutcome(detail)`)
 * instead of repeating the two-field literal. */
export function okOutcome(detail: string): CheckOutcome {
  return { level: "ok", detail };
}

export function warnOutcome(detail: string): CheckOutcome {
  return { level: "warn", detail };
}

export function failOutcome(detail: string): CheckOutcome {
  return { level: "fail", detail };
}
