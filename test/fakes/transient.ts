/** A transient-failure fake for the pi boundary, under the shared test-fake catalog
 * (test/fakes/, PLANS.md 2026-10-04): a fake-pi script that fails the run's first N
 * attempts with a chosen retriable class (a predict-stream timeout, a provider 429, a
 * 5xx, a connection error) and then succeeds, so retry-policy tests stop hand-rolling
 * failure sequences through phase-file if/else skeletons. It composes with the fake-pi
 * shim on PATH (fake-pi.ts installs it; this module only writes the script): the shim
 * stays the pi boundary, this fake scripts what pi answers. Node built-ins only.
 */
import { errorLine, assistantLine } from "../pi-events.js";

/** The retriable failure classes the retry policy distinguishes, each with the error text
 * the real backend (LM Studio, a provider, a proxy) produces — the single home of the
 * strings the retry tests repeated verbatim. `retryAfterSeconds` attaches pi's Retry-After
 * hint rendering to the 429 class. */
export type TransientFailure = "timeout" | "rateLimit" | "backend" | "connection";

/** The error line a real backend prints for each class. `hint` renders the provider's
 * Retry-After hint (` — retry after 3s`), as pi shows it, when given. */
export function transientErrorText(kind: TransientFailure, hint?: number): string {
  switch (kind) {
    case "timeout":
      return "Engine protocol predict stream timed out after 600000ms without receiving data.";
    case "rateLimit":
      return hint === undefined ? '429 "Rate limit exceeded"' : `429 "Rate limit exceeded" — retry after ${hint}s`;
    case "backend":
      return "HTTP 503 Service Unavailable.";
    case "connection":
      return "Connection error.";
  }
}

/** A shell fragment list for fake-pi scripts: the phase gate the retry tests use, counted
 * instead of two-armed — attempt i (i counts from 1) emits `transientErrorText(kind)` and
 * exits 1 while i <= `fails`; every later run emits `then`'s lines (default: the standard
 * TUMWATER_NOTHING_TO_DO line, like firstRunThenIdle's else). The counter lives in
 * `marker`, so the whole sequence survives across the harness's one transient retry. Pair
 * with `withPi` (fake-pi.ts), which installs the joined script. */
export function failingThenIdle(
  marker: string,
  fails: number,
  kind: TransientFailure,
  then: readonly string[] = [`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`],
  opts: { hint?: number } = {},
): string[] {
  const error = transientErrorText(kind, opts.hint);
  return [
    `attempt_file="${marker}"`,
    `if [ -f "$attempt_file" ]; then n=$(cat "$attempt_file"); else n=0; fi`,
    `n=$((n + 1)); echo "$n" > "$attempt_file"`,
    `if [ "$n" -le ${fails} ]; then`,
    `  printf '%s\\n' '${errorLine(error)}'`,
    `  exit 1`,
    `else`,
    ...then.map((line) => `  ${line}`),
    `fi`,
  ];
}
