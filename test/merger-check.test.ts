import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { refSha, setRef } from "../src/git/git.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { headSha, mainSha, sh } from "./fixtures/repo-fixtures.js";
import {
  ROLE,
  REF,
  makeCtx,
  pinnedFixture,
  request,
  advanceMain,
} from "./fixtures/merger-fixtures.js";

// The merge-check slice of the merge tests (see merger.test.ts for the split and what each file
// holds). Since part 4l/3 there is no in-lock merge check — a merge is a rebase and a
// fast-forward — and since Subtract part 3b/7 the pre-merge verify gate runs no build check
// either, so what remains here is the single-change merge running no in-lock check: a change
// whose deterministic diff-rule gate passed merges outright even on a project whose declared
// check is red — the broken commit sits on main for the main watch to fix.
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
