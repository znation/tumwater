/** The review gate's named-failure main-tip attribution driven through the auto-detected npm
 * re-run (`test:rerun`, build-check-detect.ts's rerunCommandOf, auto-detected from the
 * install's manifest). review-precheck.ts's mainVerdictForFailure asks main's tip
 * about the change's failing tests by re-running them alone (main-red.ts): a red re-run that
 * fails the same test excuses the change, a green one convicts it, and a re-run that reaches no
 * verdict (it fails a different test) falls back to main's fresh full check, whose nameless red
 * cannot be subtracted from the change's named failures — the bridge re-asks the re-run, and
 * standing inconclusive, the failure is the change's own against a red main. The direct seam is
 * pinned in main-red-tip-failures.test.ts; these drive it through reviewAheadOfMain, where a
 * bridge that dropped, ignored, or inverted the re-run's verdict could not ship. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain } from "../src/review/review.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { mainRedNotTheseFailures } from "../src/text/phrases.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { warningMessagesOf } from "./fixtures/log-fixtures.js";
import { projManifest, writeScript } from "./fakes/fake-commands.js";
import { commitIn, makeRepo, mainSha } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { gateCtx, ROLE } from "./fixtures/gate-fixtures.js";

/** The gate's one shared change-failure tool, in the dogfood layout: an executable at the root
 * install's node_modules/.bin that the worktree resolves, failing test X wherever the change's
 * marker file sits. */
const CHANGE_TOOL =
  "#!/bin/sh\n[ -f change-broken.txt ] && { echo '✖ X (1ms)'; echo 'test at t.test.js:1:1'; exit 1; }\nexit 0\n";

/** The build_check (scope, status) pairs the run left behind, oldest first: the gate's own
 * attempts are scope "gate", main's full fresh check scope "baseline", the named re-run "rerun". */
const checkScopes = (root: string): [unknown, unknown][] =>
  readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => [e.scope, e.status] as [unknown, unknown]);

/** A repo whose main's tip runs main's own declared check (`npm run build`) — a nameless red,
 * a compile-style error — and declares the auto-detected named re-run (`npm run test:rerun --`),
 * whose body is `rerunBody`; the change worktree's own check fails test X. */
async function fixture(rerunBody: string): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), CHANGE_TOOL);
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({
      build: "echo 'error TS2345: boom' >&2; exit 1", // main's full check: red, names no test
      "test:rerun": rerunBody,
    }),
  );
  commitIn(root, "declare the check and the re-run");
  const wt = await ensureWorktree(root, ROLE, "main");
  // The walk-up stops at the worktree's own install signature, so the worktree's manifest must
  // declare the re-run script too (canRerun reads it there); its body is never run — the
  // re-run executes in the `_gate-main` mirror, where main's committed manifest is in effect.
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "buildcheck-tool", "test:rerun": "true" }),
  );
  fs.writeFileSync(path.join(wt, "change-broken.txt"), "x\n");
  commitIn(wt, "change breaks X");
  return { root, wt };
}

test("a named failure that the re-run finds failing at main's tip goes on to review", async () => {
  const { root, wt } = await fixture('echo "✖ X (1ms)"; echo "test at t.test.js:1:1"; exit 1');
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved", "X fails at main's tip too: the failure is main's, not the change's");
    // The gate failed twice (its own flake re-run), then the named re-run ran at main's tip and
    // failed X: the re-run's verdict decides, so main's full check never runs.
    assert.deepEqual(checkScopes(root), [
      ["gate", "failed"],
      ["gate", "failed"],
      ["rerun", "failed"],
    ]);
    // The change went on to review as a known main failure — the warning names the tip and the
    // tests, exactly the phrasing namedFailureResult promises.
    const warnings = warningMessagesOf(readEvents(root));
    assert.ok(
      warnings.some((m) =>
        /^gate check fails only tests main [0-9a-f]{8} fails too: X; going on to review$/.test(m),
      ),
      JSON.stringify(warnings),
    );
  });
});

test("the same nameless main red, but the re-run finds X passing, convicts the change", async () => {
  // `true` is filter-tolerant: npm appends the `#X` filter args to the script, and `exit 0 X`
  // would fail with "too many arguments".
  const { root, wt } = await fixture("true"); // X passes at main's tip
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.deepEqual(checkScopes(root), [
      ["gate", "failed"],
      ["gate", "failed"],
      ["rerun", "passed"],
    ]);
    // A green main verdict is the only arm whose reasons carry the check's own failure and
    // nothing else: no main-red note, the rejection names X.
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /X/);
    assert.ok(!reasons.some((r) => r.includes("main")), JSON.stringify(reasons));
  });
});

test("a re-run that fails a different test stands inconclusive, and the nameless red main leaves the failure the change's own", async () => {
  const { root, wt } = await fixture(
    'echo "✖ Y (1ms)"; echo "test at y.test.js:1:1"; exit 1', // names none of the asked tests
  );
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    // Gate twice; the re-run fails Y — a verdict about Y is none about X, so the re-run says
    // nothing, main's full check runs fresh and is red without naming a test, and the bridge
    // re-asks the re-run: same output, still inconclusive, so the nameless red stands.
    assert.deepEqual(checkScopes(root), [
      ["gate", "failed"],
      ["gate", "failed"],
      ["rerun", "failed"],
      ["baseline", "failed"],
      ["rerun", "failed"],
    ]);
    // A nameless red main excuses none of the change's named failures: the rejection names X
    // against the tip, in the shared phrasing.
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /X/);
    assert.equal(reasons.at(-1), mainRedNotTheseFailures(mainSha(root), ["X"]));
  });
});
