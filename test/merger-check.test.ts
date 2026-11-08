import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { refSha, setRef } from "../src/git/git.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { headSha, mainSha, sh } from "./fixtures/repo-fixtures.js";
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
// holds). Since part 4l/3 there is no in-lock merge check — a merge is a rebase and a fast-forward
// (the main watch verifies every new tip after it lands) — so what remains here is the pre-merge
// verify gate's deterministic attribution on a green or red main, and the single-change merge
// running no in-lock check. The gate's reviewer run is a real pi subprocess behind the fake shim.

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

// A gate pre-check failure that survives its one re-run is attributed at main's tip at once,
// never by waiting on the main watch (src/review/review-precheck.ts): a failure that names no
// test runs the gate command itself on main's tip. A green tip makes the failure the change's,
// so the change is rejected and its pin deleted; a red tip makes it main's, so the change goes
// on and merges. Neither spends a pi run.

test("a failing pre-check on a green main rejects the merge and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  advanceMain(root, `main-green-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the rejection is
  // the deterministic gate's, so pi never runs and the marker's absence is the meaningful proof of
  // "no pi run" (part 3p/3; no reviewer drives the rejection).
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    // The gate command fails, naming no test, only where the change's line is in seed.txt: on
    // the change's tree, never on main's tip. So the tip passes it and the failure is the change's.
    const gateCommand = "if grep -q 'the work' seed.txt; then echo 'error TS2345: boom' >&2; exit 1; fi";
    ctx.config = { ...ctx.config, check: { command: "echo ok", gateCommand } };
    assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");
    assert.equal(await refSha(root, REF), null, "rejected: the pin is gone");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's tip decided alone");
    const baselineRuns = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline");
    assert.equal(baselineRuns.length, 0, "the gate command at main's tip answered: no full check of main");
  });
});

// A false-fix md-only change (a BUGS.md fix that names a symbol nowhere on the tree) used to
// block the merge — five resolver sessions for one pin on 2026-10-01. Since part 3m/3 a false
// fix claim is repairable by a later commit, so it no longer blocks: the change merges and the
// main watch reports it on main's tip after it lands. With the in-lock check gone (4l/3) it
// merges with no gate command run in the lock either.
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
  // Main moves after the pin, so the merge rebases the head onto it.
  advanceMain(root, `main-unrelated-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  return { root, sha };
}

test("a repairable false-fix md-only change merges through the real merge flow", async () => {
  const { root, sha } = await fixClaimFixture();
  const state = freshRunnerState(ROLE);
  const { ctx, calls } = makeCtx(root, state);
  const mainBefore = mainSha(root);

  // Part 4/4: the change's one gate runs inside this merge call — an md-only diff is exempt, so
  // the gate approves without a check or a reviewer run, and the merge runs no in-lock check and
  // no resolver.
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "the false-fix md-only change merges");
  assert.notEqual(mainSha(root), mainBefore, "the change reached main for the main watch");
  assert.equal(await refSha(root, REF), null, "the pin is gone — the change merged");
  assert.equal(calls.length, 0, "no model run — no resolver, no reviewer");
});

test("a failing pre-check that fails at main's tip too is main's: the change merges, unrejected, with no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  // The declared check fails everywhere, naming no test: on the change's tree and on main's tip.
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  const unique = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, unique), "main moved\n");
  sh(root, "git", "add", unique);
  sh(root, "git", "commit", "-m", "main moves on its own");
  const newMainSha = mainSha(root);
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the main-tip
  // attribution is the deterministic gate's, so pi never runs and the marker's absence is the
  // meaningful proof of "no pi run" (part 3p/3; no reviewer drives it).
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    assert.equal(await verifyAndMerge(ctx, request(sha)), "changed", "main's own failure holds nothing back");
    assert.equal(await refSha(root, REF), null, "the pin is gone — the change merged");
    // The change landed on the moved main: main's own commit underneath, the work on top.
    assert.equal(sh(root, "git", "rev-parse", "main~1"), newMainSha);
    assert.ok(sh(root, "git", "show", "main:seed.txt").includes("the work"), "main holds the work");
    assert.ok(!fs.existsSync(marker), "no pi run");
    // The gate command's red verdict at main's tip decided it, not a pass or a skip.
    const tipWarning = new RegExp(`^gate check fails on main ${newMainSha.slice(0, 7)}[0-9a-f]* too, with no test named; going on to review$`);
    assert.ok(warningMessages(root).some((m) => tipWarning.test(m)), "main's tip failed the gate command too");
    assert.ok(!readEvents(root).some((e) => e.type === "review_rejected"), "no rejection recorded");
  });
});
