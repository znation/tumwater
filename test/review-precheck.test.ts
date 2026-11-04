/** The review gate's attribution on a red main when the main watch does not verify main (the full
 * check in the merge lock): a pre-check failure that survives its one re-run is attributed
 * through main's own verdict at its tip (main-red.ts's mainTipVerdict), never handed to a model
 * run. When neither the change's failure nor main's red names a test, the change is not to blame:
 * the gate fails without a strike and the commit stays. A red main excuses only its own
 * failures, so a change that also fails another test, or fails outside the tests main's red
 * names, is rejected as on a green main. Extracted from review.test.ts (2026-09-29); its sibling
 * slices are review-precheck-verdict.test.ts (the gate deciding alone),
 * review-precheck-green.test.ts (a green main or none), review-precheck-closed.test.ts (a
 * pre-check with no verdict about the tree fails closed) and review-precheck-watch.test.ts (the
 * attribution when the main watch verifies main). The check's own unit tests live in
 * build-check.test.ts; the shared scaffolding lives in fixtures/gate-fixtures.ts and
 * fixtures/precheck-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain } from "../src/review/review.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { projManifest } from "./fakes/fake-commands.js";
import { commitIn, mainSha } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { gateCtx, ROLE } from "./fixtures/gate-fixtures.js";
import { buildCheckEvents, gateBuildFixture, uniqueMain } from "./fixtures/precheck-fixtures.js";

// A nameless failure (a compile error) is decided at once by running the gate command at main's
// tip: a red tip means the failure is main's too, so the change goes on to review instead of
// waiting on the main watch or keeping the pin.
test("a nameless pre-check failure that also fails main's tip goes on to review", async () => {
  // The tool fails everywhere — on the change's tree AND on main's, which the attribution check
  // runs in its own worktree because this unique main SHA has no cached verdict.
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  uniqueMain(root);
  await withPi('true', async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    // The change's check ran twice; main's gate command ran once, in the attribution worktree.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "gate:failed"]);
    assert.ok(
      warningMessages(root).some((m) => m.includes("with no test named; going on to review")),
      "the role's warning says main's tip fails the same check",
    );
  });
});

// A gate failure that names only tests main already fails (the main watch's newest red verdict)
// goes on to review with no fresh run on main; any other failing test keeps the attribution path.

const KNOWN_FAILURE_TOOL =
  "#!/bin/sh\necho '✖ X (1ms)'\n[ -f y.txt ] && echo '✖ Y (1ms)'\nexit 1\n";

/** A gate fixture whose check fails test X on main and on the change; `alsoY` makes the change
 * fail Y too. The main watch has recorded main's red verdict, so X is a known failure. */
async function knownRedFixture(alsoY: boolean): Promise<{ root: string; wt: string }> {
  const { root, wt } = await gateBuildFixture("buildcheck-tool", KNOWN_FAILURE_TOOL);
  uniqueMain(root);
  const watch = createMainWatch(root, "main");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  if (alsoY) {
    fs.writeFileSync(path.join(wt, "y.txt"), "y\n");
    commitIn(wt, "add y");
  }
  return { root, wt };
}

// A red main excuses only its own failures: a change that fails one more test is the author's to
// fix, rejected as on a green main, instead of kept until main turns green.
test("a gate failure of a known failure plus another test is rejected for the other test", async () => {
  const { root, wt } = await knownRedFixture(true);
  await withPi('true', async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.ok(!warningMessages(root).some((m) => m.includes("known failures")));
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons.at(-1) ?? "", /^main [0-9a-f]{8} is red too, but these failures are this change's own: Y$/);
  });
});

// A gate that names no test while main's red names some of its own is still decided by the gate
// command at main's tip: if that command fails there too, the nameless failure is main's.
test("a gate failure naming no test goes on to review when main's gate command fails too", async () => {
  const { root, wt } = await knownRedFixture(false);
  fs.writeFileSync(path.join(wt, "package.json"), projManifest({ build: "echo 'error TS2345: boom' >&2; exit 1" }));
  commitIn(wt, "break the compile");
  await withPi('true', async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
  });
});
