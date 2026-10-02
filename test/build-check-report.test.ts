import test from "node:test";
import assert from "node:assert/strict";
import type { BuildCheck } from "../src/build-check-detect.js";
import type { BuildCheckOutcome } from "../src/build-check.js";
import { checkFailureReasons, clipBuildTail, failureHeadline } from "../src/build-check-report.js";

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

// --- The clipBuildTail/failureHeadline unit coverage, moved here from build-check.test.ts
// (2026-09-30) so each build-check module's tests live in its own topic-named file:
// build-check.test.ts keeps only src/build-check.ts's own run/classification tests.
// --- clipBuildTail: what of a chatty build's output survives into persisted state and the
// reviewer-injected note — blanks and npm's own banners must not count against the ten-line cap.

test("clipBuildTail keeps only the last ten meaningful lines, dropping blanks and npm banners", () => {
  const noise = Array.from({ length: 30 }, (_, i) => `error line ${i}`);
  const output = ["> proj@1.0.0 build", "> tsc --noEmit", "", ...noise.slice(0, 5), "   ", ...noise.slice(5)].join("\n");
  const tail = clipBuildTail(output);
  assert.equal(tail.length, 10, "capped at ten lines");
  assert.deepEqual(tail, noise.slice(-10), "the LAST ten meaningful lines survive");
});

test("clipBuildTail clips each surviving line to the reason cap with an ellipsis", () => {
  const long = "x".repeat(400);
  const tail = clipBuildTail(`ok\n${long}\nshort`);
  assert.equal(tail.length, 3);
  const clipped = tail[1] ?? "";
  assert.equal(clipped.length, 300, "clipped to MAX_REASON_CHARS");
  assert.ok(clipped.endsWith("…"), "marked with the ellipsis");
  assert.equal(tail[2], "short", "lines that fit are unchanged");
});

test("clipBuildTail yields no lines for empty or whitespace-only output", () => {
  assert.deepEqual(clipBuildTail(""), []);
  assert.deepEqual(clipBuildTail("\n   \n\t\n"), []);
});

test("clipBuildTail keeps the error message when the ten-line window cuts it off above a long stack", () => {
  // Node prints an unhandled error's message ABOVE its stack and property dump (verified
  // against node 26): a deep stack pushes the message out of the last-ten window, so without
  // this it is lost and the headline becomes a frame or `errno: -2,` (BUGS.md 2026-09-19).
  const frames = Array.from({ length: 12 }, (_, i) => `at f${i} (file:///w/x.ts:${i}:1)`);
  const output = [
    "Error: ENOENT: no such file or directory, open '/nope'",
    ...frames,
    "{",
    "errno: -2,",
    "code: 'ENOENT',",
    "syscall: 'open',",
    "path: '/nope'",
    "}",
  ].join("\n");
  const tail = clipBuildTail(output);
  assert.equal(tail[0], "Error: ENOENT: no such file or directory, open '/nope'", "the naming line, not a frame");
  assert.equal(tail.length, 11, "the ten-line window plus the rescued message");
});

test("clipBuildTail never mistakes an error property for the message", () => {
  // `actual:`/`expected:`/`diff:` are real assertion-diff content, not noise to skip: with no
  // message shape in the prefix, the plain ten-line window is returned unchanged.
  const lines = [
    "actual: 1,",
    "expected: 2,",
    "operator: '==',",
    "diff: 'simple'",
    ...Array.from({ length: 8 }, (_, i) => `at f${i} (x:1:1)`),
  ];
  assert.deepEqual(clipBuildTail(lines.join("\n")), lines.slice(-10));
});

// --- failureHeadline: which line of a clipped tail becomes the one-line headline, so a red
// names what broke rather than the stack frame it broke in.

test("failureHeadline names what broke, not the frame it broke in", () => {
  // clipBuildTail keeps the LAST ten lines, so an unhandled rejection's tail opens mid-stack.
  assert.equal(
    failureHeadline([
      "at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      "at async Promise.all (index 0)",
      "AssertionError [ERR_ASSERTION]: actual: 'quiet_killed', expected: 'no_change'",
    ]),
    "AssertionError [ERR_ASSERTION]: actual: 'quiet_killed', expected: 'no_change'",
  );
  assert.equal(failureHeadline(["at a (f:1:1)", "at b (f:2:2)"]), "at a (f:1:1)", "all frames: print something");
  assert.equal(failureHeadline([]), undefined);
  assert.equal(failureHeadline(undefined), undefined);
});

test("failureHeadline carries a file-level ⚠ marker's cause, not the bare marker", () => {
  // A file-level failure (process exits nonzero or async activity outlives the file) ends the
  // spec detail with the file's ⚠ <file> (<file>:1:1) marker followed by the cause; the
  // marker is a location line, not the headline (BUGS.md 2026-10-02).
  assert.equal(
    failureHeadline([
      "✖ failing tests:",
      "test at status-data.test.js:1:1",
      "⚠ /worktrees/_land-dry/dist/test/status-data.test.js (dist/test/status-data.test.js:1:1)",
      "'test failed'",
    ]),
    "⚠ /worktrees/_land-dry/dist/test/status-data.test.js (dist/test/status-data.test.js:1:1) — 'test failed'",
  );
  assert.equal(
    failureHeadline([
      "✖ failing tests:",
      "test at status-data.test.js:1:1",
      "⚠ /worktrees/_land-dry/dist/test/status-data.test.js (dist/test/status-data.test.js:1:1)",
    ]),
    "⚠ /worktrees/_land-dry/dist/test/status-data.test.js (dist/test/status-data.test.js:1:1)",
    "marker alone: print the marker",
  );
  // A ⚠ todo marker (`# TODO` suffix, not a `:1:1` location) is not a file-level failure.
  assert.equal(
    failureHeadline(["⚠ todo fails (0.27ms) # TODO", "Error: boom"]),
    "⚠ todo fails (0.27ms) # TODO",
  );
});

test("failureHeadline names an unhandled error whose message the tail window would otherwise cut", () => {
  const frames = Array.from({ length: 12 }, (_, i) => `at f${i} (file:///w/x.ts:${i}:1)`);
  const tail = clipBuildTail(
    [
      "Error: ENOENT: no such file or directory, open '/nope'",
      ...frames,
      "errno: -2,",
      "code: 'ENOENT',",
      "syscall: 'open',",
      "path: '/nope'",
    ].join("\n"),
  );
  assert.equal(
    failureHeadline(tail),
    "Error: ENOENT: no such file or directory, open '/nope'",
    "the message, not `errno: -2,`",
  );
});

test("failureHeadline skips node:test's summary block, not the failure it frames", () => {
  // node --test's spec reporter ends a failing run with the summary THEN the detail; when both
  // fit in the ten-line window the first non-frame line was `ℹ todo 0` and two real rejections
  // surfaced as `build check failed (test): ℹ todo 0` (BUGS.md 2026-09-22). Output is real
  // spec-reporter shape (reproduced with a test that throws a plain string).
  const tail = clipBuildTail(
    [
      "ℹ pass 0",
      "ℹ fail 1",
      "ℹ cancelled 0",
      "ℹ skipped 0",
      "ℹ todo 0",
      "ℹ duration_ms 73.78325",
      "✖ failing tests:",
      "test at a.test.js:2:1",
      "✖ the interlock held: no tick ever started (0.348625ms)",
      "  'the interlock held: no tick ever started'",
    ].join("\n"),
  );
  assert.equal(
    failureHeadline(tail),
    "✖ the interlock held: no tick ever started — 'the interlock held: no tick ever started'",
    "the failed test and its own message, not `ℹ fail 1` or the `test at` marker",
  );
});

test("failureHeadline names the failed test even when the stack and assertion dump crowd its name out of the window", () => {
  // Real spec-reporter shape for a failed strictEqual (node 26): the failing-tests detail's
  // message is generic and its stack plus property dump fill the ten-line window, so the
  // headline used to be `AssertionError [ERR_ASSERTION]: Expected values to be strictly
  // equal:` — four flakes and a red main on 2026-09-30 named no test at all (BUGS.md).
  const output = [
    "✔ passes (0.47ms)",
    "✖ the wake was restored (0.62ms)",
    "ℹ tests 2",
    "ℹ fail 1",
    "ℹ duration_ms 540.25",
    "",
    "✖ failing tests:",
    "",
    "test at dist/test/f.test.js:3:1",
    "✖ the wake was restored (0.62ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "  ",
    "  1 !== 0",
    "  ",
    "      at TestContext.<anonymous> (file:///w/dist/test/f.test.js:3:64)",
    "      at async Test.run (node:internal/test_runner/test:1409:7)",
    "      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {",
    "    generatedMessage: true,",
    "    code: 'ERR_ASSERTION',",
    "    actual: 1,",
    "    expected: 0,",
    "    operator: 'strictEqual',",
    "    diff: 'simple'",
    "  }",
  ].join("\n");
  const tail = clipBuildTail(output);
  assert.equal(tail[0], "✖ the wake was restored (0.62ms)", "the name line is rescued above the window");
  assert.equal(tail.length, 12, "the window plus the rescued name and message");
  assert.equal(
    failureHeadline(tail),
    "✖ the wake was restored — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "the test's name (duration dropped, so one flake clusters as one) leads the message",
  );
});

test("clipBuildTail rescues no name for output without a failed test", () => {
  const frames = Array.from({ length: 12 }, (_, i) => `at f${i} (x:1:1)`);
  const tail = clipBuildTail(["✖ failing tests:", "Error: boom", ...frames].join("\n"));
  assert.equal(tail[0], "Error: boom", "the section header is not a test name");
  assert.equal(failureHeadline(tail), "Error: boom");
});
