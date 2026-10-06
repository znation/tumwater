/** Reading a node:test-style runner's summary counts out of check output — the harness's own
 * attestation of how a declared check fared (PLANS.md 2026-09-29), so no model has to restate
 * the numbers. Split out of build-check.ts: pure parsing, no process execution, with its own
 * importers (the build_check event's shape in build-check-events.ts, the status snapshot's
 * mainCheck readers, and the UI's main-count badge). */

/** What a node:test-style runner's summary block reports, as parseTestCounts read it. The
 * build_check event carries it verbatim (build-check-events.ts spreads the outcome's counts
 * through), so the event's readers — the status snapshot's mainCheck (src/status/status-data.ts) — import
 * this shape instead of re-declaring it. */
export interface TestCounts {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
}

/** One `ℹ <key> <number>` line of the runner's summary block whose key we carry. */
const TEST_COUNT_LINE = /^ℹ\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/;
/** Any other `ℹ <key> <number>` line of the summary block (suites, cancelled, todo,
 * duration_ms) — it belongs to the block in progress but carries nothing we attest. */
const TEST_SUMMARY_LINE = /^ℹ\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d/;

/** Read the runner's summary counts out of combined check output. Blocks are runs of
 * consecutive `ℹ` summary lines; the last complete block wins (nested or repeated runs each
 * print one). Returns undefined when no block carries all four counts. */
export function parseTestCounts(output: string): TestCounts | undefined {
  let block: Partial<TestCounts> | undefined;
  let best: TestCounts | undefined;
  const close = () => {
    const { tests, pass, fail, skipped } = block ?? {};
    if (typeof tests === "number" && typeof pass === "number" && typeof fail === "number" && typeof skipped === "number") {
      best = { tests, pass, fail, skipped };
    }
    block = undefined;
  };
  for (const line of output.split("\n")) {
    const m = TEST_COUNT_LINE.exec(line);
    if (m) {
      block ??= {};
      block[m[1] as keyof TestCounts] = Number(m[2]);
    } else if (!TEST_SUMMARY_LINE.test(line)) {
      close();
    }
  }
  close();
  return best;
}