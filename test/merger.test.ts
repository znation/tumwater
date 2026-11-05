import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MERGE_FLAKY_WARNING_PREFIX } from "../src/review/known-flakes.js";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { aheadOfMain, refSha, setRef } from "../src/git/git.js";
import { mergeRefName, mergeWorktreePath, rejectedRefName, statePath } from "../src/paths.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { withdrawnPinReason } from "../src/merge/merge-withdrawn.js";
import { assertClean, mainSha, pinOffMain, sh, tmpdir, makeRepo } from "./fixtures/repo-fixtures.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { withPi } from "./fakes/fake-pi.js";
import { waitForFile } from "./helpers/wait.js";
import {
  ROLE,
  REF,
  makeCtx,
  pinnedFixture,
  reviewerPi,
  request,
  verifyAndMerge,
  declareCheck,
  advanceMain,
  parkUntil,
} from "./fixtures/merger-fixtures.js";

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

// Unit coverage for a queued change's gate and its merge — both now owned by one
// mergeApprovedChange call (the withdrawal check, the review gate, and the rebase-and-fast-forward
// merge; part 3b/6), driven here in queue order exactly as the merge pipeline runs it
// (merge-drain.ts, with the verify stage's path handing approved changes down marked alreadyGated).
// The gate's check and, when it runs, its reviewer, go through the wiring; merge-to-main.ts's
// conflict resolver goes through the wiring's runPi, which is stubbed.
//
// Split so node --test runs the slices in parallel processes and each fits the gate's 30 s
// budget: this file holds the verify and single-change merges (approval, rejection, abort,
// conflict resolution, the rebase onto main); merger-check.test.ts the pre-check verdicts
// (retries, flakes, false-fix md-only changes). Shared fixtures live in
// test/fixtures/merger-fixtures.ts. Keep each slice well under the budget in measured duration
// when moving tests between them.

test("an approved merge merges on main and deletes the ref", async () => {
  // The merge's bookkeeping rides the deterministic gate, not the pre-merge reviewer: a passing
  // declared check is the approval that survives part 3h/3's removal of the model reviewer, so
  // no assertion here pins the reviewer's verdict or usage fold (part 3p/3).
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha, wt } = await pinnedFixture();
      declareCheck(root, "#!/bin/sh\necho ok\n");
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      assert.equal(mainSha(root), sha, "the pinned commit is main's head");
      assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 0, "never red, no flake");
      assert.equal(await refSha(root, REF), null, "the pin was deleted on merge");
      assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree stayed clean at main");
    },
  );
});

test("an unmarked request runs the gate before it merges, and a marked one skips it", async () => {
  // Part 3b/6: mergeApprovedChange owns the queued change's one gate. An unmarked request (no
  // `alreadyGated`) checks for withdrawal and runs reviewQueuedChange in the merge worktree before
  // anything touches main — a passing gate merges and deletes the pin. A marked request (the verify
  // stage's path) carries `alreadyGated` and fast-forwards with no second gate: no second check
  // run, so the declared check's log sees exactly one entry.
  const rec = path.join(tmpdir("merger-gate-"), "seen");
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha } = await pinnedFixture();
      declareCheck(root, `#!/bin/sh\ngit rev-parse HEAD >> ${rec}\necho ok\n`);
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);

      assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "the unmarked request merges");
      assert.equal(await refSha(root, REF), null, "the gate cleared it: the pin is gone");
      const afterFirst = fs.readFileSync(rec, "utf8").trim();
      assert.notEqual(afterFirst, "", "the gate's pre-check ran");

      // A second, unmarked change merges the same way — but a marked one (the verify stage's path)
      // fast-forwards with no second check run, so the log grows by no line.
      const sha2 = pinOffMain(
        root,
        (d) => fs.appendFileSync(path.join(d, "seed.txt"), "more work\n"),
        "more work",
      );
      await setRef(root, REF, sha2);
      assert.equal(await mergeApprovedChange(ctx, request(sha2, { alreadyGated: true })), "changed", "the marked request merges");
      assert.equal(fs.readFileSync(rec, "utf8").trim(), afterFirst, "no second gate: the marked request ran no check");
      assert.equal(await refSha(root, REF), null, "the second pin is gone too");
    },
  );
});

test("an unmarked request main has withdrawn returns withdrawn without a gate run", async () => {
  // Part 3b/6: the withdrawal check precedes the gate, so a change main no longer lists is dropped
  // unmerged (its pin deleted, the reason recorded) and its gate never starts. Withdrawal is judged
  // only for the work roles (feature, bugfix — merge-withdrawn.ts), so this case runs as a feature
  // role with a claim for an entry main does not list. A passing check is declared; its log would
  // gain a line only if the gate ran, so its emptiness is the proof of "no gate run".
  const rec = path.join(tmpdir("merger-withdrawn-"), "seen");
  const WROLE = "feature";
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      // Main lists only "Alpha"; the pin's claim names "Gone", which main does not list. The pin's
      // tree inherits main's PLANS.md, so both the base and the head read it.
      const root = makeRepo();
      fs.writeFileSync(
        path.join(root, "PLANS.md"),
        "# Plans\n\n## Planned\n\n### Alpha (planned 2026-01-01 by operator)\n\nBody Alpha.\n\n## Done\n",
      );
      sh(root, "git", "add", "PLANS.md");
      sh(root, "git", "commit", "-q", "-m", "plans");
      const mainBefore = mainSha(root);
      const sha = pinOffMain(
        root,
        (d) => fs.writeFileSync(path.join(d, "seed.txt"), "the work\n"),
        "the work",
      );
      await setRef(root, mergeRefName(WROLE), sha); // the pinned change, under the feature role's ref
      await ensureWorktree(root, WROLE, "main");
      declareCheck(root, `#!/bin/sh\ngit rev-parse HEAD >> ${rec}\necho ok\n`);
      const state = freshRunnerState(WROLE);
      const { ctx } = makeCtx(root, state);
      const req = request(sha, {
        role: WROLE,
        claim: { file: "PLANS.md", key: "gone", title: "Gone (planned 2026-01-01 by operator)" },
      });
      // The same check the new path runs, asked here, confirms the fixture reads withdrawn before
      // the merge starts — so a "changed" below would mean the gate ran on an unwithdrawn pin.
      assert.ok(await withdrawnPinReason(root, "main", req, sha), "the fixture reads withdrawn");

      assert.equal(await mergeApprovedChange(ctx, req), "withdrawn");

      assert.equal(mainSha(root), mainBefore, "main did not move");
      assert.equal(await refSha(root, mergeRefName(WROLE)), null, "the withdrawn pin is gone");
      assert.ok(!fs.existsSync(rec), "no gate run: the check never logged a head");
    },
  );
});

test("the gate's verdict is durable on disk before the run's end save", async () => {
  // Regression (2026-09-14): state was written to disk only at run boundaries, so a
  // sudden death after the gate's verdict (power loss, kill -9) left the last
  // run-boundary snapshot on disk — a stale verdict for work already superseded —
  // and every later run acted on it. The verdict must be durable before the run's tail
  // (the merge plus the still-to-come authoring run) can die unsaved. Part 3p/3 asserts the
  // durable approval record (the approved head), not the reviewer's verdict, so the case
  // survives part 3h/3's removal of the pre-merge reviewer; the deterministic gate approval
  // is a passing declared check.
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha } = await pinnedFixture();
      declareCheck(root, "#!/bin/sh\necho ok\n");
      const state = freshRunnerState(ROLE);
      // What disk holds at run start: a stale approval for a superseded head. The verify must
      // overwrite it with the current approval before the run's tail can die unsaved.
      state.lastApprovedHead = "0".repeat(40);
      saveRunnerState(root, state);
      const { ctx } = makeCtx(root, state);

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      // Read back from disk, not the in-memory object: without an immediate persist the file
      // still holds the seeded stale approval and the new verdict would be lost to the crash.
      const onDisk = readJson(statePath(root, ROLE)) as RunnerState;
      assert.equal(onDisk.lastApprovedHead, sha, "the approval is durable on disk, not just in memory");
    },
  );
});

test("a rejected merge merges nothing: role worktree clean at main, ref deleted, reasons recorded", async () => {
  // Re-pointed (part 3p/3): the rejection is deterministic — the change rewrites the brief block,
  // which briefEditReason rejects before any check runs (part 3h/3 removed the pre-merge
  // reviewer). A brief-block edit is one of the three findings part 3m/3 keeps in the gate's
  // narrowed scope, so unlike a conflict marker this trigger survives that narrowing. The
  // bookkeeping is unchanged; the recorded reason is the diff rule's own finding, asserted only
  // to be present, not pinned to its wording.
  const root = makeRepo();
  const prompt = (body: string) =>
    `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
  // main carries a README.md with a brief block, which the change then rewrites.
  fs.writeFileSync(path.join(root, "README.md"), prompt("original"));
  sh(root, "git", "add", "README.md");
  sh(root, "git", "commit", "-q", "-m", "seed the brief");
  const mainBefore = mainSha(root);
  // The change is one commit on main's tip that adds the code work and rewrites the brief,
  // pinned by the merge ref so main stays at the seed commit (a fresh single-commit pin makes
  // the verify's rebase a no-op, so the gate judges the brief edit directly).
  sh(root, "git", "checkout", "-q", mainBefore);
  fs.writeFileSync(path.join(root, "seed.txt"), "the work\n");
  fs.writeFileSync(path.join(root, "README.md"), prompt("rewritten"));
  sh(root, "git", "add", "seed.txt", "README.md");
  sh(root, "git", "commit", "-q", "-m", "the work");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "-q", "main");
  await setRef(root, REF, sha);
  const wt = await ensureWorktree(root, ROLE, "main");
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);

  assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");

  assert.equal(mainSha(root), mainBefore, "nothing merged on main");
  assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree is clean at main");
  assertClean(wt, "no stray edits in the role worktree");
  assert.equal(await refSha(root, REF), null, "a rejection is terminal: the pin goes too");
  assert.equal(state.lastReview?.verdict, "reject", "the deterministic gate's rejection is recorded");
  assert.ok(state.lastReview?.reasons?.length, "the diff rule's reason is recorded");
});

test("an abort before the gate returns aborted and keeps the ref", async () => {
  // Re-pointed (part 3z/3): the abort is observed before the gate ever starts, so it is fully
  // deterministic — no fake pi run is needed and none survived part 3h/3's removal of the
  // pre-merge reviewer. The abort bookkeeping (nothing merged, pin kept for the next run's
  // recovery) is unchanged.
  const { root, sha } = await pinnedFixture();
  const state = freshRunnerState(ROLE);
  const mainBefore = mainSha(root);
  const { ctx, controller } = makeCtx(root, state);
  controller.abort(); // a shutdown that arrives before the merge's gate starts

  assert.equal(await verifyAndMerge(ctx, request(sha)), "aborted");

  assert.equal(mainSha(root), mainBefore, "nothing merged on main");
  assert.equal(await refSha(root, REF), sha, "an aborted merge keeps its pin for recovery");
});

test("a conflicting merge gets one resolution run and then merges", async () => {
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha } = await pinnedFixture();
      // A passing declared check is the deterministic approval that survives part 3h/3's
      // removal of the pre-merge reviewer (part 3p/3); the resolution flow is unchanged.
      declareCheck(root, "#!/bin/sh\necho ok\n");
      // Advance main with a conflicting edit after the pin — the common concurrent case.
      advanceMain(root, "seed.txt", "main\n");

      const state = freshRunnerState(ROLE);
      const { ctx, calls } = makeCtx(root, state, (wt) => {
        fs.writeFileSync(path.join(wt, "seed.txt"), "combined\n"); // resolve the markers
      });

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "combined\n");
      assert.equal(calls.length, 1, "exactly one resolution attempt per merge");
      assert.match(calls[0]!.session, /tumwater-improve-7-conflict/, "named after the role and run");
      assert.equal(await refSha(root, REF), null, "the pin was deleted on merge");
      // The rebase rewrote the pinned commit onto main's advance: linear history, no merge commits.
      assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
    },
  );
});

// The re-review gate over a diverging resolution (merge-core.ts's recheckResolved) has one
// non-approval outcome these cases reach deterministically: a REJECT (the verdict is final —
// the pin is deleted, nothing merges). Re-pointed (part 4a/3): the rejection is now the
// deterministic gate's — the resolution rewrites the brief block, which briefEditReason rejects
// before any reviewer run — so the cases drive no model reviewer and survived the reviewer's
// removal in part 3h/3 (a brief-block edit is one of the three findings the part 3m/3
// narrowing keeps in the gate's scope). The reviewer's no-parseable-verdict retry path dies
// with the reviewer and is retired.

test("a resolution the re-review rejects deletes the pin and merges nothing", async () => {
  // Re-pointed (part 4a/3): the re-review now rejects on a deterministic diff-rule finding —
  // the resolution rewrites the brief block, which briefEditReason rejects before any reviewer
  // run (part 3h/3 removed the reviewer). A brief-block edit is one of the three findings the
  // part 3m/3 narrowing keeps in the gate's scope, so the trigger survives it. The re-review
  // bookkeeping is unchanged: the pin is deleted, review_rejected is logged, the resolved
  // change owes one revision and its rejected ref keeps the head the re-review judged.
  await withPi(
    reviewerPi("VERDICT: approve"), // the verify's approve; the re-review rejects on the diff rule
    async () => {
      const root = makeRepo();
      const prompt = (body: string) =>
        `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
      // main carries a seed commit with a brief block and the file the pin will conflict on, so
      // the pin's own diff (seed.txt only) leaves the brief untouched and the verify approves.
      fs.writeFileSync(path.join(root, "README.md"), prompt("original"));
      fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
      sh(root, "git", "add", "README.md", "seed.txt");
      sh(root, "git", "commit", "-q", "-m", "seed the brief and seed");
      const sha = pinOffMain(
        root,
        (d) => fs.writeFileSync(path.join(d, "seed.txt"), "seed\nthe work\n"),
        "the work",
      );
      await setRef(root, REF, sha);
      await ensureWorktree(root, ROLE, "main");
      // Advance main with a conflicting edit to seed.txt after the pin — the common concurrent
      // case (the brief on main is unchanged, so the verify still approves).
      advanceMain(root, "seed.txt", "seed\nmain\n");
      const state = freshRunnerState(ROLE);
      const mainBefore = mainSha(root);
      const { ctx, calls } = makeCtx(root, state, (wt) => {
        // The resolver edits seed.txt to resolve the conflict AND rewrites the brief — the re-
        // review's deterministic gate rejects the resolution on briefEditReason.
        fs.writeFileSync(path.join(wt, "seed.txt"), "seed\ncombined\n");
        fs.writeFileSync(path.join(wt, "README.md"), prompt("rewritten"));
      });

      assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");

      assert.equal(mainSha(root), mainBefore, "nothing merged on main");
      assert.equal(await refSha(root, REF), null, "a rejected re-review is final: the pin is deleted");
      assert.equal(state.lastError, "merge failed: conflict resolution rejected on re-review");
      assert.equal(eventsOfType(root, "review_rejected").length, 1, "the rejection is logged");
      // A re-review rejection sends the resolved change back for revision too (plans/revise-
      // rejected.md): round 1 is recorded and the rejected ref keeps the head the re-review judged
      // alive, even though the merge pin itself is deleted.
      assert.equal(state.revision?.round, 1, "a re-review rejection owes one revision");
      assert.equal(await refSha(root, rejectedRefName(ROLE)), state.lastReview?.head);
      // The resolution run went through the wiring stub.
      assert.equal(calls.length, 1);
      // Terminal rejection deletes the pin; the shared `_merge` checkout persists (plans/
      // worktree-pool.md, part 2c) — the resolution is discarded by dropping the pin, not the
      // checkout, so the next merge reuses it.
      assert.equal(fs.existsSync(mergeWorktreePath(root)), true, "the shared _merge checkout persists on rejection");
    },
  );
});

test("an unwritable state file mid-review still folds the reviewer runs and settles a rejected re-review", async () => {
  // Re-pointed (part 4a/3): the rejection is the deterministic gate's — the resolution rewrites
  // the brief block, a finding that survives the part 3m/3 narrowing — as in the rejection case
  // above. The case's own subject survives too: an unwritable state file does not derail the
  // rejected re-review (the pin is deleted and the rejection is logged) and the failed save
  // warns. The reviewer-run folding this case used to assert dies with the reviewer; the title
  // is kept because docs/invariants.md (INV-CL1) pins this case for the recheckResolved saves.
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const root = makeRepo();
      const prompt = (body: string) =>
        `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
      fs.writeFileSync(path.join(root, "README.md"), prompt("original"));
      fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
      sh(root, "git", "add", "README.md", "seed.txt");
      sh(root, "git", "commit", "-q", "-m", "seed the brief and seed");
      const sha = pinOffMain(
        root,
        (d) => fs.writeFileSync(path.join(d, "seed.txt"), "seed\nthe work\n"),
        "the work",
      );
      await setRef(root, REF, sha);
      await ensureWorktree(root, ROLE, "main");
      advanceMain(root, "seed.txt", "seed\nmain\n");

      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state, (wt) => {
        fs.writeFileSync(path.join(wt, "seed.txt"), "seed\ncombined\n");
        fs.writeFileSync(path.join(wt, "README.md"), prompt("rewritten"));
      });
      const stateTmp = `${statePath(root, ROLE)}.tmp-`;
      const undo = patchFsMethod("writeFileSync", (orig) => (...args) => {
        const file = args[0];
        if (typeof file === "string" && file.startsWith(stateTmp)) throw errnoError("ENOSPC");
        return orig(...args);
      });
      try {
        assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");
      } finally {
        undo();
      }

      assert.equal(await refSha(root, REF), null, "the rejected pin is deleted");
      assert.equal(eventsOfType(root, "review_rejected").length, 1, "the rejection is logged");
      assert.ok(
        warningMessages(root).some((m) => m.startsWith("could not save the role's state")),
        "a failed save warns",
      );
    },
  );
});

test("a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both", async () => {
  // PLANS.md 2026-09-21: the gate must review main's CURRENT tree. Advance main after the
  // pin with a non-conflicting commit, then check the gate saw the rebased tree — if the
  // gate ran on the stale pin, main's fix would not be under review and a red main would
  // cascade through every queued merge.
  const rec = path.join(tmpdir("merger-rec-"), "seen");
  await withPi(
    reviewerPi("VERDICT: approve"), // the verify's approve; the passing declared check is the deterministic gate
    async () => {
      const { root, sha } = await pinnedFixture();
      // A passing declared check is the deterministic gate that survives part 3h/3's removal of
      // the pre-merge reviewer, and it records the HEAD it ran at, so the "gate reviewed the
      // rebased tree" assertion rides the gate, not the reviewer (part 3p/3).
      declareCheck(root, `#!/bin/sh\ngit rev-parse HEAD >> ${rec}\necho ok\n`);
      // Land the declared check as its own commit separate from the "fix main" commit below, so
      // the gate's `npm run` resolves the check inside the merger worktree (the change's tree
      // inherits it from main) instead of climbing to the bare repo — and the "fix main" commit
      // stages only the intended fix file.
      sh(root, "git", "add", "package.json", "node_modules");
      sh(root, "git", "commit", "-m", "declare the project check");
      fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
      sh(root, "git", "add", "fix.txt");
      sh(root, "git", "commit", "-m", "fix main");
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      // main holds both: main's fix underneath, the rebased change on top (linear, no merge).
      const mainHead = mainSha(root);
      assert.notEqual(mainHead, sha, "main moved past the pin: the change was rebased onto the fix");
      assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "seed\nthe work\n");
      assert.equal(fs.readFileSync(path.join(root, "fix.txt"), "utf8"), "main fix\n");
      assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
      // The declared check ran in the merger worktree at the SYNCED head — the pre-check tree is
      // exactly what became main, and the merge ref tracked it (deleted on merge here).
      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      assert.equal(seen[0], mainHead, "the gate reviewed the rebased tree, not the stale pin");
      assert.equal(await refSha(root, REF), null, "the pin was deleted on merge");
    },
  );
});

test("a synced rebase moves the merge ref so a gate that keeps the pin keeps the tree that can merge", async () => {
  // The strike-cap tell compares the merger worktree's HEAD against req.sha: when the
  // pre-gate rebase rewrote the pin, the request (and the ref) must name the synced head, or
  // an under-cap failure would look like a strike-cap discard and delete the pinned work. A
  // shutdown mid-check is the gate outcome that keeps the pin (fail closed for the next run's
  // re-merge), so the declared check parks until the test aborts the verify under it.
  const dir = tmpdir("merger-sync-");
  const started = path.join(dir, "started");
  const never = path.join(dir, "never");
  const { root, sha } = await pinnedFixture();
  declareCheck(root, `#!/bin/sh\n${parkUntil(started, never)}\necho ok\n`);
  fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "fix main");
  const fixSha = mainSha(root);
  const state = freshRunnerState(ROLE);
  const { ctx, controller } = makeCtx(root, state);

  const verdict = verifyAndMerge(ctx, request(sha));
  await waitForFile(started); // the gate's check is running, so the pre-gate sync is done
  controller.abort();
  assert.equal(await verdict, "aborted");

  // Nothing merged, and the ref names the rebased commit: main's fix underneath, the work on top.
  assert.equal(mainSha(root), fixSha, "nothing merged on main");
  const pinned = await refSha(root, REF);
  assert.ok(pinned, "an aborted gate keeps the pin");
  assert.notEqual(pinned, sha, "the ref tracks the rebased commit, not the stale pin");
  assert.equal(sh(root, "git", "rev-parse", `${pinned}~1`), fixSha, "rebased onto main's fix");
  assert.ok(sh(root, "git", "show", `${pinned}:seed.txt`).includes("the work"), "the pin still names the work");
});

test("the merge checkout is shared, kept detached, and persists at a terminal outcome", async () => {
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha } = await pinnedFixture();
      // Re-pointed (part 4l/3): there is no in-lock merge check — a merge is a rebase and a
      // fast-forward — so the first call merges outright ("changed", terminal) and the pin
      // goes; what this case pins is the shared `_merge` checkout: kept detached and persisted
      // at the terminal outcome for the next merge to reuse.
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);
      const mergeWt = mergeWorktreePath(root);

      // Terminal: a single merge (no in-lock check) fast-forwards and deletes the pin; the
      // shared checkout persists for the next merge.
      assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "a single merge fast-forwards with no in-lock check");
      assert.equal(await refSha(root, REF), null, "the pin is gone after merging");
      assert.ok(fs.existsSync(mergeWt), "_merge persists at the terminal outcome");
      assert.equal(
        fs.existsSync(path.join(root, ".tumwater", "worktrees", `_land-${ROLE}`)),
        false,
        "no legacy _land-<role> checkout is created for a merge",
      );
      // Detached: no branch ref is checked out there — rebasing it never moves a role branch.
      let detached = false;
      try {
        sh(mergeWt, "git", "symbolic-ref", "--short", "HEAD");
      } catch {
        detached = true; // a detached HEAD makes symbolic-ref exit nonzero
      }
      assert.ok(detached, "_merge is detached (rebasing never moves a role branch)");
    },
  );
});
