import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isKnownFlake, MERGE_FLAKY_WARNING_PREFIX, quarantinedTests } from "../src/review/known-flakes.js";
import { MERGE_CHECK_FAILURE_LIMIT } from "../src/merge/merge-check-failures.js";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { refSha, setRef } from "../src/git/git.js";
import { statePath } from "../src/paths.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { noteGreenBaseline } from "../src/baseline/main-baseline.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { headSha, mainSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import {
  ROLE,
  REF,
  makeCtx,
  pinnedFixture,
  request,
  verifyAndMerge,
  declareCheck,
  advanceMain,
} from "./fixtures/merger-fixtures.js";

// The merge-check slice of the merge tests (see merger.test.ts for the split and what each file
// holds): the gate's pre-check and the in-lock merge check on a green or red main — the retry,
// the flake warning and quarantine, a check run that timed out — and the false-fix md-only
// changes that merge for the main watch to report. The reviewer run is a real pi subprocess
// behind the fake shim.

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

// A gate pre-check failure that survives its one re-run is attributed through main's own baseline
// verdict (src/review/review.ts), and the merge's ref lifecycle follows the two outcomes: a green
// main's reject deletes the pin, a red main's no-strike failure keeps it for the next re-merge.
// Neither spends a pi run. makeRepo's seed commit is byte-identical across tests run in the same
// second and the baseline cache is keyed by SHA, so the red case moves main to a commit of its own
// before asking.

test("a failing pre-check on a green main rejects the merge and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  // The gate scope fails while the declared check — what main's fresh re-check runs — passes:
  // main is green, so the change's failure is its own.
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the rejection is
  // the deterministic gate's, so pi never runs and the marker's absence is the meaningful proof of
  // "no pi run" (part 3p/3; no reviewer drives the rejection).
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    ctx.config = { ...ctx.config, check: { command: "echo ok", gateCommand: "echo 'error TS2345: boom' >&2; exit 1" } };
    assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");
    assert.equal(await refSha(root, REF), null, "rejected: the pin is gone");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
  });
});

// A change whose gate passes but whose in-lock merge check goes red (a cheaper
// check.gateCommand, say) used to come back merge_blocked on every re-merge, its role never
// authoring again. The first red keeps the pin for one retry; at MERGE_CHECK_FAILURE_LIMIT the
// red is judged by main's own verdict, like a red gate check.
for (const main of ["green", "red"] as const) {
  test(`a single merge's red in-lock check retries once, then ${main === "green" ? "rejects on a green main" : "keeps its pin as main_red"}`, async () => {
    assert.equal(MERGE_CHECK_FAILURE_LIMIT, 2);
    const { root, sha } = await pinnedFixture();
    // Main moves after the pin, so the in-lock rebase rewrites it and the merge check runs.
    const tip = advanceMain(root, `main-${main}-${process.pid}-${Date.now()}.txt`, "main moves on\n");
    if (main === "green") noteGreenBaseline(tip); // what main's own last merge left behind
    const state = freshRunnerState(ROLE);
    const { ctx, calls } = makeCtx(root, state);
    ctx.config = { ...ctx.config, check: { command: "echo 'error: planted merge failure'; exit 1" } };

    assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "the first red keeps the pin for one retry");
    assert.equal(await refSha(root, REF), sha);
    assert.equal(state.mergeCheckFailures?.count, 1);
    assert.match(state.lastError ?? "", /^merge failed: merge_blocked — check failed .*planted merge failure/);

    const second = await mergeApprovedChange(ctx, request(sha));
    if (main === "green") {
      assert.equal(second, "rejected", "the change broke the check: rejected with its output");
      assert.equal(await refSha(root, REF), null, "the pin is gone");
      assert.equal(state.lastReview?.verdict, "reject");
      assert.match(state.lastReview!.reasons[0]!, /planted merge failure/);
      assert.equal(eventsOfType(root, "review_rejected").length, 1);
    } else {
      assert.equal(second, "main_red", "main fails too: not this change's failure");
      assert.equal(await refSha(root, REF), sha, "the pin is kept for a re-merge once main is green");
      assert.match(state.lastError ?? "", /^merge check failed: main \S+ is red — not this change's failure$/);
      assert.equal(eventsOfType(root, "review_rejected").length, 0);
    }
    assert.equal(state.mergeCheckFailures, undefined, "the streak ends at the attribution");
    assert.equal(calls.length, 0, "no model run");
    assert.equal(mainSha(root), tip, "nothing merged");
  });
}

for (const main of ["green", "red"] as const) {
  test(`an unwritable state file during a red merge check's attribution still settles its verdict (${main} main)`, async () => {
    const { root, sha } = await pinnedFixture();
    const tip = advanceMain(root, `main-enospc-${main}-${process.pid}-${Date.now()}.txt`, "main moves on\n");
    if (main === "green") noteGreenBaseline(tip);
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    ctx.config = { ...ctx.config, check: { command: "echo 'error: planted merge failure'; exit 1" } };
    assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked");

    const prefix = `${statePath(root, ROLE)}.tmp-`;
    const restore = patchFsMethod("writeFileSync", (orig) => (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith(prefix)) throw errnoError("ENOSPC");
      return orig(...args);
    });
    let second;
    try {
      second = await mergeApprovedChange(ctx, request(sha));
    } finally {
      restore();
    }
    if (main === "green") {
      assert.equal(second, "rejected");
      assert.equal(await refSha(root, REF), null, "the pin is gone");
      assert.equal(eventsOfType(root, "review_rejected").length, 1);
    } else {
      assert.equal(second, "main_red");
      assert.equal(await refSha(root, REF), sha, "the pin is kept");
      assert.equal(eventsOfType(root, "review_rejected").length, 0);
    }
    assert.ok(warningMessages(root).some((m) => m.startsWith("could not save the role's state")));
  });
}

// The first red of a patch's in-lock merge check is the retry that exists for load flakes — the
// whole point is to re-merge a flaky test green. It is also the one signal that could name the
// flaky test, and until now the reason was written only into lastError, which the leftover-recovery
// run overwrites a second later, so the flaky test could never be identified (BUGS.md 2026-10-14).
// The kept-for-re-merge path now logs a warning naming the failing test, so the digest and a later
// audit can still name it.
test("a kept-for-re-merge red merge check logs a warning naming the failing test", async () => {
  const { root, sha } = await pinnedFixture();
  // Main moves after the pin so the in-lock rebase rewrites the tree and the merge check runs.
  const tip = advanceMain(root, `main-red-warn-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  noteGreenBaseline(tip);
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  ctx.config = { ...ctx.config, check: { command: "echo '✖ the flaky test (1.2ms)'; exit 1" } };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "the first red keeps the pin for one re-merge");
  assert.equal(await refSha(root, REF), sha, "the pin is kept");

  const warning = warningMessages(root).find((m) => m.includes("merge check failed (kept for one retry)"));
  assert.ok(warning, "the kept-for-re-merge red is recorded durably as a warning");
  assert.match(warning!, /the flaky test/, "the warning names the failing test");
  assert.equal(mainSha(root), tip, "nothing merged");
});

test("a red merge check that passes on its kept-pin retry logs a merge-check flake warning", async () => {
  const { root, sha } = await pinnedFixture();
  const tip = advanceMain(root, `main-flake-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  noteGreenBaseline(tip);
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  ctx.config = { ...ctx.config, check: { command: "echo '✖ the flaky test (1.2ms)'; exit 1" } };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked");
  assert.match(state.mergeCheckFailures?.headline ?? "", /the flaky test/);

  ctx.config = { ...ctx.config, check: { command: "true" } };
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed");
  const flaky = warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX));
  assert.equal(flaky.length, 1);
  assert.match(flaky[0]!, /the flaky test/);
  // failureHeadline strips the duration, so the gate looks up the bare headline.
  assert.ok(isKnownFlake(root, "✖ the flaky test"));
});

test("a red in-lock merge check whose immediate re-run passes merges and quarantines the failing test", async () => {
  const { root, sha } = await pinnedFixture();
  const tip = advanceMain(root, `main-requarantine-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  noteGreenBaseline(tip);
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  const flag = path.join(tmpdir(), "merge-flaky-once");
  ctx.config = {
    ...ctx.config,
    check: { command: `if [ -f '${flag}' ]; then exit 0; fi; touch '${flag}'; echo '✖ the flaky test (1.2ms)'; exit 1` },
  };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "the re-run passed, so the change merges");
  assert.deepEqual(quarantinedTests(root), ["the flaky test"]);
  assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 1);
});

test("a stale red strike of another pin is not recorded as a flake when a different pin merges", async () => {
  const { root, sha } = await pinnedFixture();
  const state = freshRunnerState(ROLE);
  state.mergeCheckFailures = { patchId: "not-this-pin", count: 1, headline: "✖ stale test" };
  const { ctx } = makeCtx(root, state);

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed");
  assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 0);
});

// A false-fix md-only change (a BUGS.md fix that names a symbol nowhere on the tree) used to
// block the merge — five resolver sessions for one pin on 2026-10-01. Since part 3m/3 a false
// fix claim is repairable by a later commit, so it no longer blocks: the change merges and the
// main watch reports it on main's tip after it lands.
async function fixClaimFixture(): Promise<{ root: string; sha: string }> {
  const { root } = await pinnedFixture();
  // Seed BUGS.md on main with the bug Open; the pin's md-only commit moves it to Fixed
  // naming a symbol that exists nowhere on the tree — falseFixReason's block.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-10-02)\n\n**Symptom:** x.\n",
  );
  sh(root, "git", "add", "BUGS.md");
  sh(root, "git", "commit", "-m", "seed bugs");
  sh(root, "git", "checkout", "--detach");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### Another bug (found 2026-10-02)\n\n**Symptom:** y.\n\n" +
      "## Fixed\n\n### A bug (found 2026-10-02, fixed 2026-10-02)\n\n" +
      "**Fix:** `phantomSymbolName` in src/nowhere.ts now holds.\n",
  );
  // BUGS.md only: a `git add -A` here would sweep the role worktree's
  // .tumwater/worktrees/improve entry into the pin and the diff would not be md-only.
  sh(root, "git", "add", "BUGS.md");
  sh(root, "git", "commit", "-m", "fix claim");
  const sha = headSha(root);
  sh(root, "git", "checkout", "main");
  await setRef(root, REF, sha);
  // Main moves after the pin, so the in-lock rebase rewrites the head and verifyMerge's
  // exempt arm runs its cross-checks (a no-op rebase would skip them).
  advanceMain(root, `main-unrelated-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  return { root, sha };
}

test("a repairable false-fix md-only change merges through the real merge flow", async () => {
  const { root, sha } = await fixClaimFixture();
  const state = freshRunnerState(ROLE);
  const { ctx, calls } = makeCtx(root, state);
  const mainBefore = mainSha(root);

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "the false-fix md-only change merges");
  assert.notEqual(mainSha(root), mainBefore, "the change reached main for the main watch");
  assert.equal(await refSha(root, REF), null, "the pin is gone — the change merged");
  assert.equal(state.mergeCheckFailures, undefined, "no strike: nothing blocked");
  assert.equal(calls.length, 0, "no model run — no resolver, no reviewer");
});

test("a false-fix md-only change merges with no merge-check flake", async () => {
  const { root, sha } = await fixClaimFixture();
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed");
  assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 0);
});

test("an unverified red in-lock check — the run timed out — keeps the pin without a strike", async () => {
  // The merge half of BUGS.md 2026-09-30: at the merge scopes a timed-out check made no
  // verdict about the tree, so it is not a strike against the patch (the red-attribution
  // helper's own unverified arm is pinned in attribute-red-check.test.ts — this drives the
  // same weather through a real merge, where the in-lock check's timeout is remapped to
  // unverified before mergeCheckRed ever sees it).
  const { root, sha } = await pinnedFixture();
  const tip = advanceMain(root, `main-unverified-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  const state = freshRunnerState(ROLE);
  const { ctx, calls } = makeCtx(root, state);
  ctx.config = { ...ctx.config, check: { command: "sleep 5", timeoutSeconds: 1 } };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "an unverified red is retriable, like any merge_blocked");
  assert.equal(await refSha(root, REF), sha, "the pin stays for the next attempt");
  assert.equal(state.mergeCheckFailures, undefined, "no strike: the check never judged the tree");
  assert.match(state.lastError ?? "", /the tree is unverified/, "the state names the verdict-less run, not a test failure");
  assert.equal(mainSha(root), tip, "nothing merged");

  // A second attempt is the same weather: still no strike, still recoverable — an unverified
  // check can never accumulate into the strike-cap attribution that deletes the pin.
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked");
  assert.equal(state.mergeCheckFailures, undefined, "the streak never opens on an unverified red");
  assert.equal(await refSha(root, REF), sha);
  assert.equal(calls.length, 0, "no model run");
});

test("a failing pre-check on a red main keeps the pin, records no rejection, and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  const unique = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, unique), "main moved\n");
  sh(root, "git", "add", unique);
  sh(root, "git", "commit", "-m", "main moves on its own");
  const newMainSha = mainSha(root);
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the red-main keep
  // is the deterministic gate's, so pi never runs and the marker's absence is the meaningful proof
  // of "no pi run" (part 3p/3; no reviewer drives it).
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    assert.equal(await verifyAndMerge(ctx, request(sha)), "main_red", "not a reviewer failure");
    const pinned = await refSha(root, REF);
    assert.ok(pinned, "the pin survives a red main");
    // The pre-gate sync rebased the pin onto the moved main; the gate left it exactly there.
    assert.equal(sh(root, "git", "rev-parse", `${pinned}~1`), newMainSha);
    assert.ok(sh(root, "git", "show", `${pinned}:seed.txt`).includes("the work"), "the pin still names the work");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.match(state.lastError ?? "", /^gate check failed: main [0-9a-f]+ is red — not this change's failure$/);
    assert.ok(!readEvents(root).some((e) => e.type === "review_rejected"));
  });
});
