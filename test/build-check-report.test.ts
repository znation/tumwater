import test from "node:test";
import assert from "node:assert/strict";
import type { BuildCheck } from "../src/build-check-detect.js";
import type { BuildCheckOutcome } from "../src/build-check.js";
import { checkFailureReasons } from "../src/build-check-report.js";

// build-check-report.ts's checkFailureReasons turns a red check's outcome into the machine
// text every rejecting gate hands its author — the reason lines injected into the next-tick
// note by main-red, the review gate, the landing path and build-stage alike. Its unverified
// passthrough is pinned in build-check.test.ts, but the MAIN path — a genuine red whose
// reason is the headline joined to the rest of the clipped tail — had no coverage at all:
// a regression there (wrong headline, the headline kept twice, the tail dropped, a missing
// fallback) would silently degrade every red's diagnosis without failing a single test.
// These tests pin that path on synthetic outcomes: headline selection and dedup, the npm vs
// command wording of describeCheck, the empty-tail fallback, the all-framing fallback, and
// the unverified empty-tail branch the integration test never reaches.

const NPM_CHECK: BuildCheck = { kind: "npm", rootDir: "/tmp/proj", script: "test" };

function outcome(overrides: Partial<BuildCheckOutcome>): BuildCheckOutcome {
  return { status: "failed", script: "test", ...overrides };
}

test("a red check's reasons lead with the headline and drop it from the tail", () => {
  const tail = [
    "at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "AssertionError [ERR_ASSERTION]: expected 1 to equal 2",
    "actual: 1,",
    "expected: 2,",
  ];
  const reasons = checkFailureReasons(NPM_CHECK, outcome({ outputTail: tail }));
  assert.deepEqual(reasons, [
    "build check failed (`npm run test`): AssertionError [ERR_ASSERTION]: expected 1 to equal 2",
    "at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "actual: 1,",
    "expected: 2,",
  ]);
});

test("a command check names the command, not an npm script", () => {
  const check: BuildCheck = {
    kind: "command",
    command: "cargo fmt --check && cargo test",
    cwd: ".",
    timeoutMs: 300_000,
  };
  const reasons = checkFailureReasons(
    check,
    outcome({ outputTail: ["error[E0308]: mismatched types"] }),
  );
  assert.deepEqual(reasons, [
    "build check failed (`cargo fmt --check && cargo test`): error[E0308]: mismatched types",
    // The headline IS the tail's only line here — the dedup must not leave an empty rest.
  ]);
});

test("a red check with no output tail falls back to a bare build-check-failed reason", () => {
  assert.deepEqual(
    checkFailureReasons(NPM_CHECK, outcome({})),
    ["build check failed (`npm run test`)"],
  );
  assert.deepEqual(
    checkFailureReasons(NPM_CHECK, outcome({ outputTail: [] })),
    ["build check failed (`npm run test`)"],
  );
});

test("a tail that is all framing still names its first line as the headline", () => {
  const tail = ["✖ failing tests:", "test at dist/test/some.test.js:12:3"];
  const reasons = checkFailureReasons(NPM_CHECK, outcome({ outputTail: tail }));
  assert.equal(reasons.length, 2, "the dedup keeps the non-headline framing line");
  assert.equal(reasons[0], "build check failed (`npm run test`): ✖ failing tests:");
  assert.deepEqual(reasons.slice(1), ["test at dist/test/some.test.js:12:3"]);
});

test("an unverified red with an empty tail still says why the tree is unverified", () => {
  // The passthrough's empty-tail arm: a verdict-less remap that somehow lost its reason
  // lines must not degrade to an empty reason list — the safe default names the check.
  const reasons = checkFailureReasons(NPM_CHECK, outcome({ unverified: true, outputTail: [] }));
  assert.deepEqual(reasons, ["build check failed (`npm run test`)"]);
});
