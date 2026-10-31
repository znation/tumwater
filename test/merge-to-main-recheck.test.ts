/** The merge flow since part 4l/3: a merge is a rebase and a fast-forward — no in-lock build
 * re-check runs. The pre-merge verify gate judged the tree, and the main watch verifies every
 * new tip after it lands, so the merge slot's own check is redundant and gone. What remains on
 * the merge side is the conflict resolver and the re-review of a diverged resolution (which are
 * not build checks). Shared helpers live in fixtures/merge-to-main-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeToMain } from "../src/merge/merge-to-main.js";
import { readEvents } from "../src/events/event-read.js";
import { advanceMain } from "./fixtures/merger-fixtures.js";
import { projManifest, writeScript } from "./fakes/fake-commands.js";
import { assertWorktreeSettled, commitIn, initializedWorktree, mainSha, sh } from "./fixtures/repo-fixtures.js";
import { makeCtx, piResult, seedFeatureAPlannedToDone } from "./fixtures/merge-to-main-fixtures.js";

/** Give the project a declared build check. The tool runs only if the merge slot were to invoke
 * it — the point of these tests is that since part 4l/3 it never does. `toolBody` is the script's
 * body; tests use it to make the check sensitive to WHICH tree runs. */
function declareBuildCheck(root: string, wt: string, toolBody = "exit 0", commitManifestToMain = true): void {
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const manifest = projManifest({ test: "buildcheck-tool" });
  fs.writeFileSync(path.join(root, "package.json"), manifest);
  if (commitManifestToMain) {
    sh(root, "git", "add", "package.json"); // targeted — never sweeps in node_modules
    sh(root, "git", "commit", "-m", "declare build check");
  }
  writeScript(path.join(binDir, "buildcheck-tool"), toolBody);
  fs.writeFileSync(path.join(wt, "package.json"), manifest);
}

test("a merge runs no in-lock gate command — the rebased head fast-forwards with no build check", async () => {
  // Even a declared check that is red in the lock never runs there since part 4l/3: the gate
  // judged the tree before it reached the merge slot, and the main watch verifies the tip after
  // it lands. A broken commit then sits on main between its landing and the watch's fix.
  const { root, wt } = await initializedWorktree();
  declareBuildCheck(root, wt, "exit 1"); // would block any in-lock check that actually ran
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  advanceMain(root, "mainfile.txt", "from main\n"); // main moves → the rebase rewrites the head
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "changed");
  assert.ok(!readEvents(root).some((e) => e.type === "build_check"), "no in-lock build check ran");
  assert.ok(fs.existsSync(path.join(root, "app.js")), "the change merged on main");
  assert.equal(fs.readFileSync(path.join(root, "mainfile.txt"), "utf8"), "from main\n");
});

test("a conflict resolution that duplicates ## Done now merges, for the main watch to report", async () => {
  // The 2026-09-25 shape (PLANS.md 9eaae5ac): main moves the only planned entry to Done by
  // ADDING a ## Done heading; the branch adds a new plan under ## Planned; the rebase
  // conflicts and a resolver that keeps both sides puts the new plan under a second
  // ## Done. Since part 3m/3 a duplicated heading is repairable by a later commit, so the
  // resolution merges (the in-lock build check that once judged it is gone since 4l/3) and the
  // main watch reports it on main's tip.
  const { root, wt } = await initializedWorktree();
  seedFeatureAPlannedToDone(root, wt);
  const mainBefore = mainSha(root);
  const { ctx } = makeCtx(root, async (w) => {
    // "Keeps both sides": main's Done section plus the branch's plan under its own ## Done.
    fs.writeFileSync(
      path.join(w, "PLANS.md"),
      "## Done\n\n### Feature A (planned 2026-09-25, done 2026-09-26)\n\n**Goal.** Landed.\n\n" +
        "## Done\n\n### Feature B (planned 2026-09-26)\n\n**Goal.** New work.\n",
    );
    return piResult();
  });

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "changed", "the repairable duplicate-heading resolution merges");
  assert.notEqual(mainSha(root), mainBefore);
  assertWorktreeSettled(wt);
});

test("a conflict resolution that files a new plan under a single ## Done now merges", async () => {
  // The other 2026-09-25 shape (plans part 4/4): ONE ## Done on main, so the duplicate-heading
  // rule could not see it. A resolver that keeps main's Done section and places the branch's new
  // plan below it strands the plan where no Planned reader looks. Since part 3m/3 this broken
  // structure is repairable, so the resolution merges (with no in-lock check since 4l/3) and the
  // main watch reports it.
  const { root, wt } = await initializedWorktree();
  seedFeatureAPlannedToDone(root, wt);
  const mainBefore = mainSha(root);
  const { ctx } = makeCtx(root, async (w) => {
    // The resolver keeps a Planned section (so the heading set is sound) but files the
    // branch's new plan below the ## Done heading, with no done date.
    fs.writeFileSync(
      path.join(w, "PLANS.md"),
      "## Planned\n\n_Nothing yet._\n\n## Done\n\n" +
        "### Feature A (planned 2026-09-25, done 2026-09-26)\n\n**Goal.** Landed.\n\n" +
        "### Feature B (planned 2026-09-26)\n\n**Goal.** New work.\n",
    );
    return piResult();
  });

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "changed", "the misfiled-plan resolution merges for the main watch");
  assert.notEqual(mainSha(root), mainBefore, "main moved");
  assertWorktreeSettled(wt);
});
