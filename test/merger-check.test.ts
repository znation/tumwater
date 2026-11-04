import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { refSha, setRef } from "../src/git/git.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { noteGreenBaseline } from "../src/baseline/main-baseline.js";
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

// A gate pre-check failure that survives its one re-run is attributed through main's own baseline
// verdict (src/review/review.ts), and the merge's ref lifecycle follows the two outcomes: a green
// main's reject deletes the pin, a red main's no-strike failure keeps it for the next re-merge.
// Neither spends a pi run. makeRepo's seed commit is byte-identical across tests run in the same
// second and the baseline cache is keyed by SHA, so the red case moves main to a commit of its own
// before asking.

test("a failing pre-check on a green main rejects the merge and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  // A nameless gate failure is attributed through main's own tip: main's tip passes the gate
  // command, so the failure is the change's own and the gate rejects it without a pi run or a
  // re-run of main's check (the gate command is the change's own, so it is the attribution).
  const tip = advanceMain(root, `main-green-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  noteGreenBaseline(tip);
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the rejection is
  // the deterministic gate's, so pi never runs and the marker's absence is the meaningful proof of
  // "no pi run" (part 3p/3; no reviewer drives the rejection).
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    // The gate command is change-specific: it fails on the change's tree (seed.txt carries
    // "the work") and passes on main's tip (seed.txt does not), so a nameless failure is the
    // change's own — not main's — and the gate rejects it.
    ctx.config = { ...ctx.config, check: { command: "echo ok", gateCommand: "! grep -q 'the work' seed.txt" } };
    assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");
    assert.equal(await refSha(root, REF), null, "rejected: the pin is gone");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
    const baselineRuns = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline");
    assert.equal(baselineRuns.length, 0, "the gate command answered: main's check did not run");
  });
});

// A single-change merge runs no in-lock build check: the pre-merge verify gate judged the tree
// before it reached the merge slot, and the main watch verifies the tip after it lands. A merge
// whose gate passed but whose in-lock check would now run nothing fast-forwards the change even
// on a project whose declared check is red — the broken commit sits on main for the watch to fix.
test("a single merge with a red declared check still fast-forwards — no in-lock check runs", async () => {
  const { root, sha } = await pinnedFixture();
  // Main moves after the pin, so the in-lock rebase rewrites it.
  const tip = advanceMain(root, `main-nocheck-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  const state = freshRunnerState(ROLE);
  const { ctx, calls } = makeCtx(root, state);
  // The declared check is red: if any in-lock check ran it would block. None does.
  ctx.config = { ...ctx.config, check: { command: "echo 'error: planted failure'; exit 1" } };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "no in-lock check: the change merges");
  assert.equal(await refSha(root, REF), null, "the pin is gone — the change merged");
  assert.equal(calls.length, 0, "no model run");
  assert.notEqual(mainSha(root), tip, "the change reached main for the main watch");
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

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "the false-fix md-only change merges");
  assert.notEqual(mainSha(root), mainBefore, "the change reached main for the main watch");
  assert.equal(await refSha(root, REF), null, "the pin is gone — the change merged");
  assert.equal(calls.length, 0, "no model run — no resolver, no reviewer");
});

test("a nameless pre-check failure that also fails main's tip is main's: the change merges and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  // The declared gate command fails wherever x-broken.txt is present; main moves to a commit that
  // adds it, so the gate command fails on main's tip too — a nameless failure is main's, not the
  // change's, so the gate goes on and the change merges (no main_red keep: the gate now judges
  // every twice-failed nameless check at main's tip and never holds the pin for a watch verdict).
  declareCheck(root, "#!/bin/sh\ntest -f x-broken.txt\n");
  fs.writeFileSync(path.join(root, "x-broken.txt"), "main moved\n");
  sh(root, "git", "add", "x-broken.txt");
  sh(root, "git", "commit", "-m", "main moves on its own");
  const newMainSha = mainSha(root);
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the gate's
  // main-tip verdict (the gate command failing at main's tip) decides the change merges, so pi
  // never runs and the marker's absence is the meaningful proof of "no pi run".
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    assert.equal(await verifyAndMerge(ctx, request(sha)), "changed", "a nameless failure main's tip also fails is main's: the change merges");
    assert.equal(await refSha(root, REF), null, "the pin is gone — the change merged");
    assert.notEqual(mainSha(root), newMainSha, "the change reached main for the main watch");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.ok(!readEvents(root).some((e) => e.type === "review_rejected"), "no rejection: the gate went on to merge");
  });
});
