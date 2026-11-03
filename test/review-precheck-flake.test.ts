/** Hourly full check part 1a/4 — the gate pre-check's flake handling: a failure that does not
 * reproduce on the gate's own immediate re-run is a flake, not a red tree (approve, warn,
 * quarantine the named tests, never wait on main's watch); and a failure naming only main's known
 * failures short-circuits before any re-run. */
import test from "node:test";
import assert from "node:assert/strict";
import { reviewAheadOfMain } from "../src/review/review.js";
import { readEvents } from "../src/events/event-read.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { warningMessagesOf } from "./fixtures/log-fixtures.js";
import { FLAKY_WARNING_PREFIX, quarantinedTests, quarantineTests } from "../src/review/known-flakes.js";
import { gateCtx } from "./fixtures/gate-fixtures.js";
import { flakeGateFixture, knownFailureFixture } from "./fixtures/precheck-attr-fixtures.js";

const gateChecks = (root: string): [unknown, unknown][] =>
  readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => [e.scope, e.status] as [unknown, unknown]);

test("a first failure that passes on the immediate re-run approves, warns as flaky, quarantines", async () => {
  const { root, wt } = await flakeGateFixture();
  const result = await reviewAheadOfMain(gateCtx(root, wt), freshRunnerState(root));
  assert.equal(result.decision, "approved");
  // One gate failure, then the gate's own immediate re-run passes: no full baseline, no main
  // watch. The re-run is a second gate-scope check, not a named-test re-run.
  assert.deepEqual(gateChecks(root), [
    ["gate", "failed"],
    ["gate", "passed"],
  ]);
  const warnings = warningMessagesOf(readEvents(root));
  assert.equal(warnings.some((m) => m.includes(FLAKY_WARNING_PREFIX)), true, warnings.join(" | "));
  // The flaky test is quarantined for the window so a later run can short-circuit on it.
  assert.equal(quarantinedTests(root).includes("X"), true);
});

test("a failure naming only main's known failures approves without a re-run", async () => {
  const { root, wt } = await knownFailureFixture();
  // Seed X into the known-failure store (the quarantine list `knownMainFailures` reads), as main's
  // watch would have: the change's failure names only X, so the pre-check short-circuits.
  quarantineTests(root, ["X"], "gate check: ✖ X");
  const result = await reviewAheadOfMain(gateCtx(root, wt), freshRunnerState(root));
  assert.equal(result.decision, "approved");
  // The gate ran once and failed; the failure naming only X (a known main failure) is excused
  // before the re-run, so there is no second gate-scope check.
  assert.deepEqual(gateChecks(root), [["gate", "failed"]]);
});
