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
import { aheadOfMain, headOf } from "../src/git/git.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { shortSha } from "../src/text/format.js";
import { eventsOfType, warningMessages, warningMessagesOf } from "./fixtures/log-fixtures.js";
import { projManifest } from "./fakes/fake-commands.js";
import { commitIn, mainSha } from "./fixtures/repo-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import { gateCtx, ROLE } from "./fixtures/gate-fixtures.js";
import { buildCheckEvents, gateBuildFixture, uniqueMain } from "./fixtures/precheck-fixtures.js";

// A red MAIN must not reject every queued change for a failure none of their authors caused —
// the goal the in-slot build-fix run served, now met by attribution: the change keeps its commit
// (and the merger its pin), no strike is counted, and main-red.ts's healer hand-off
// (`mainRedHealNote`) and the bugfix handoff own the repair.
test("a pre-check that fails twice on a red main fails without a strike and keeps the commit", async () => {
  // The tool fails everywhere — on the change's tree AND on main's, which the attribution check
  // runs in its own worktree because this unique main SHA has no cached verdict.
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  const movedMainSha = uniqueMain(root);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    state.unreviewFailures = 1; // an earlier reviewer strike against this head stays exactly as it was
    const head = await headOf(wt, "HEAD");
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "failed");
    assert.equal(result.detail, `main ${shortSha(movedMainSha)} is red — not this change's failure`);
    assert.equal(result.aborted, undefined);
    assert.equal(result.discarded, undefined, "not a discard: the pin must stay");
    assert.equal(result.mainRed, true, "the merge reports main_red, not a reviewer failure");
    assert.ok(!fs.existsSync(marker), "no pi run: nothing was spent on main's failure");
    assert.equal(state.unreviewFailures, 1, "no strike: nothing judged this diff");
    assert.equal(state.lastReview?.verdict, "failed", "no rejection recorded against the author");
    assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-merge");
    assert.equal(await aheadOfMain(wt, "main"), 1);
    const events = readEvents(root);
    assert.ok(!events.some((e) => e.type === "review_rejected"), "no rejection logged");
    // The change's check ran twice; main's once, in the attribution worktree, priced as a baseline
    // run.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:failed"]);
    const warnings = warningMessagesOf(events);
    const holds = eventsOfType(root, "main_red_hold").map((e) => String(e.message));
    assert.ok(
      holds.some((m) => m.startsWith(`main ${shortSha(movedMainSha)} is red (build: error TS2345: boom)`)),
      `the team-wide main_red_hold fires; got: ${JSON.stringify(holds)}`,
    );
    assert.ok(
      warnings.includes(`gate check failed on ${shortSha(head)}, but main ${shortSha(movedMainSha)} is red — not this change's failure; merge kept`),
      `the role's warning names both heads; got: ${JSON.stringify(warnings)}`,
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
    assert.equal(result.mainRed, undefined, "not kept: main's red does not explain Y");
    assert.ok(!warningMessages(root).some((m) => m.includes("known failures")));
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons.at(-1) ?? "", /^main [0-9a-f]{8} is red too, but these failures are this change's own: Y$/);
  });
});

// A gate that names no test while main's red names its own failed outside them — a compile or lint
// error, a crash — so it is the change's, not main's.
test("a gate failure naming no test on a main red with named tests is rejected", async () => {
  const { root, wt } = await knownRedFixture(false);
  fs.writeFileSync(path.join(wt, "package.json"), projManifest({ build: "echo 'error TS2345: boom' >&2; exit 1" }));
  commitIn(wt, "break the compile");
  await withPi('true', async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.equal(result.mainRed, undefined);
    assert.match(
      state.lastReview?.reasons.at(-1) ?? "",
      /^main [0-9a-f]{8} is red too, but this check failed outside the tests main fails, so the failure is this change's own$/,
    );
  });
});
