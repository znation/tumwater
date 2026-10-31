import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { refSha, setRef } from "../src/git/git.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
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
