import assert from "node:assert/strict";
import { test } from "node:test";
// Side-effect imports: both modules hold only shared types, so no value import anywhere
// reaches their compiled JS and the suite's coverage table shows them as never loaded. The
// imports here load the modules, and the registry below pins the vocabulary they name.
import "../src/tick/tick-outcome.js";
import "../src/pi/pi-run-result.js";
import type { TickResult } from "../src/tick/tick-outcome.js";

// The TickResult vocabulary (tick-outcome.ts), one human meaning each. `Record<TickResult, …>`
// makes this a two-way exhaustive pin at compile time: adding a TickResult without a row here
// fails the gate's tsc pass, and removing or renaming one fails the same way — exactly the
// nudge the shared vocabulary deserves, since the dashboards, tick-apply's state machine, and
// the landing wiring all branch on these literals.
const MEANING: Record<TickResult, string> = {
  changed: "a landing completed: the change is merged to main",
  queued: "the tick's change is committed and pinned for the landing slot",
  refused: "pi declined the work (TUMWATER_REFUSED)",
  no_change: "pi decided there was nothing to do",
  merge_conflict: "change made but unmergeable; the pin is re-queued, then discarded",
  merge_blocked: "fast-forward into main failed",
  rejected: "the review gate rejected the change",
  review_error: "the review gate produced no parseable verdict; commit left for retry",
  error: "pi errored or timed out",
  aborted: "harness shutdown killed the run mid-tick",
  quiet_killed: "the quiet watchdog killed a stalled tool call mid-run",
  user_aborted: "a user-initiated abort killed the run mid-tick",
  main_red: "main's build/test suite is red",
  skipped: "nothing to run",
};

test("the TickResult vocabulary registry names every result exactly once", () => {
  const names = Object.keys(MEANING);
  assert.equal(new Set(names).size, names.length, "a result is named twice");
  for (const name of names) {
    assert.match(name, /^[a-z_]+$/, "results are lowercase snake_case tokens");
    assert.match(MEANING[name as TickResult], /\S/, "each result carries a human meaning");
  }
  // The registry is the union, not a superset: 14 results, and the compile-time Record above
  // is what keeps this list in lockstep with the type.
  assert.equal(names.length, 14);
});