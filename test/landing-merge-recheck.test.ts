/** The landing flow's in-lock post-rebase verification (BUGS.md 2026-09-08: the gate checked
 * the pre-rebase tree, so the bytes that landed on main were never run through a check): the
 * declared check re-runs the rebased tree, a red one blocks, an environmental skip warns and
 * lands, a no-op rebase seeds the baseline, and the duplicate-`## Done` structure gate it
 * consults. Extracted from landing-merge.test.ts (2026-10-11); shared helpers live in
 * fixtures/landing-merge-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkMainBaseline } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { mergeToMain } from "../src/landing/landing-merge.js";
import { aheadOfMain } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType, warningMessages, warningMessagesOf } from "./fixtures/log-fixtures.js";
import { advanceMain } from "./fixtures/lander-fixtures.js";
import { pathReplace, projManifest, writeScript } from "./fakes/fake-commands.js";
import { assertWorktreeSettled, commitIn, gitOnlyBinDir, headSha, initializedWorktree, mainSha, sh } from "./fixtures/repo-fixtures.js";
import { makeCtx, piResult, seedFeatureAPlannedToDone } from "./fixtures/landing-merge-fixtures.js";

// ── In-lock post-rebase verification (BUGS.md 2026-09-08: the gate checks the pre-rebase tree,
// so the bytes that land on main were never run through a check) ────────────────────────────

/** Give the project a declared build check, laid out exactly like dogfood: root has
 * package.json + the fake toolchain in node_modules/.bin (the install — node_modules stays
 * untracked; only the manifest is committed to main, so a branch that carries the same
 * manifest rebases and ff-merges cleanly), and `wt` gets its own copy of the manifest but no
 * install — npm's run-script resolves the ancestor's .bin only when the worktree carries a
 * manifest of its own. Call it BEFORE commitIn(wt) to have the manifest ride in the branch
 * commit (keeps the worktree clean), or after, to keep it out of the diff. `toolBody` is the
 * script's body — tests use it to make the check sensitive to WHICH tree runs.
 * `commitManifestToMain` (default true) commits the manifest to main so a branch carrying the
 * same blob rebases and ff-merges cleanly; pass false when NOTHING tracks it, because git
 * refuses any rebase/ff whose target would turn an untracked worktree file into a tracked one. */
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

test("a rebase that rewrote the commits re-runs the declared check on the rebased tree before landing", async () => {
  const { root, wt } = await initializedWorktree();
  // The tool passes only when BOTH files exist — true of the post-rebase tree, false of the
  // pre-rebase head (which lacks main's file). A check of the wrong tree would block the merge.
  declareBuildCheck(root, wt, "test -f app.js && test -f mainfile.txt");
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  advanceMain(root, "mainfile.txt", "from main\n"); // main moves while the change is under review
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "changed");
  const landingChecks = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "landing");
  assert.equal(landingChecks.length, 1, "the rebased tree was re-verified inside the merge lock");
  assert.equal(landingChecks[0]!.status, "passed");
  assert.ok(fs.existsSync(path.join(root, "app.js")), "both changes landed on main");
  assert.equal(fs.readFileSync(path.join(root, "mainfile.txt"), "utf8"), "from main\n");
});

test("a red post-rebase check blocks the landing and keeps the commit for recovery", async () => {
  const { root, wt } = await initializedWorktree();
  declareBuildCheck(root, wt, "exit 1"); // fails on every tree — a deterministic red
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  advanceMain(root, "mainfile.txt", "from main\n");
  const { ctx } = makeCtx(root);
  const mainBefore = mainSha(root);

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "merge_blocked");
  assert.equal(mainSha(root), mainBefore, "nothing lands on a red tree");
  assert.ok(
    readEvents(root).some((e) => e.type === "build_check" && e.scope === "landing" && e.status === "failed"),
    "the failed re-check is priced in the feed",
  );
  assert.equal(eventsOfType(root, "merged").length, 0);
  // The commit stays on the branch: next tick's recovery routes it through the gate, whose
  // pre-check rejects it deterministically and injects the build tail into the author's prompt.
  assert.equal(await aheadOfMain(wt, "main"), 1);
  assertWorktreeSettled(wt); // no rebase left in progress
});

test("an environmental skip of the re-check warns and still lands — never fail-closed", async () => {
  const { root, wt } = await initializedWorktree();
  declareBuildCheck(root, wt); // would pass if it could run at all
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  advanceMain(root, "mainfile.txt", "from main\n"); // rebase is not a no-op → the re-check runs
  const { ctx } = makeCtx(root);

  // Drop npm from PATH for the merge: runBuildCheck's spawn then fails with ENOENT — an
  // environmental skip, not a red build. git alone is symlinked into the restricted bin dir,
  // so every other step of the landing resolves exactly as usual.
  const binDir = gitOnlyBinDir("no-npm-bin-");
  const restorePath = pathReplace(binDir);
  let result: string;
  try {
    result = await mergeToMain(ctx, wt, "branch work");
  } finally {
    restorePath();
  }

  assert.equal(result, "changed", "a skip is environmental — the landing proceeds (fail-open)");
  const events = readEvents(root);
  assert.ok(
    events.some((e) => e.type === "build_check" && e.scope === "landing" && e.status === "skipped"),
    "the skipped re-check is priced in the feed",
  );
  const warnings = warningMessagesOf(events);
  assert.ok(
    warnings.includes("no npm on PATH; skipping merge check"),
    `the operator sees why the check did not run: ${JSON.stringify(warnings)}`,
  );
  assert.equal(events.filter((e) => e.type === "merged").length, 1);
  assert.ok(fs.existsSync(path.join(root, "app.js")), "both changes landed on main");
});

test("a no-op rebase skips the re-check and seeds the baseline for the landed SHA", async () => {
  const { root, wt } = await initializedWorktree();
  declareBuildCheck(root, wt); // would pass if run — but must NOT run (no landing event)
  sh(wt, "git", "reset", "--hard", "main"); // tick-start reset: author on top of CURRENT main
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  const head = headSha(wt);
  const { ctx } = makeCtx(root);

  // The gate's pre-check just ran green on exactly this head (GateResult.verifiedHead).
  const result = await mergeToMain(ctx, wt, "branch work", head);

  assert.equal(result, "changed");
  assert.ok(
    !readEvents(root).some((e) => e.type === "build_check"),
    "no-op rebase: the gate's run is trusted — no second suite run",
  );
  // The landed SHA (== main now) must be a baseline cache hit: checkMainBaseline runs nothing.
  const runs: unknown[] = [];
  await checkMainBaseline(root, defaultConfig(), (run) => runs.push(run));
  assert.equal(runs.length, 0, "the landing path seeded the green verdict for the SHA that became main");
});

test("a no-op rebase with no verified head still runs the landing check and fails closed", async () => {
  // The gate's build pre-check timing out leaves GateResult.verifiedHead undefined while the
  // landing rebase stays a no-op (main did not move under review). Trusting the no-op alone
  // would land a tree no check ever judged; the landing-scope check must run and reject.
  const { root, wt } = await initializedWorktree();
  declareBuildCheck(root, wt, "exit 1"); // a deterministic red the gate never ran
  sh(wt, "git", "reset", "--hard", "main"); // the branch sits on current main → no-op rebase
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  const { ctx } = makeCtx(root);
  const mainBefore = mainSha(root);

  // No fourth argument: the gate made no green observation of this tree (a skipped pre-check).
  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "merge_blocked", "an unverified no-op rebase must not land unchecked");
  assert.equal(mainSha(root), mainBefore, "nothing lands on the unverified tree");
  assert.deepEqual(
    eventsOfType(root, "build_check").map((e) => [e.scope, e.status]),
    [["landing", "failed"]],
    "the landing-scope check ran and rejected the tree",
  );
  assert.equal(eventsOfType(root, "merged").length, 0);
  assertWorktreeSettled(wt); // no rebase left in progress
});

test("with check.gateCommand set, a no-op rebase still runs the full check before landing", async () => {
  // PLANS.md Land-queue speed 3e: the gate ran only the cheaper gateCommand, so its green says
  // nothing about check.command — the no-op skip would land a tree the full suite never saw.
  const { root, wt } = await initializedWorktree();
  sh(wt, "git", "reset", "--hard", "main");
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  const head = headSha(wt);
  const { ctx } = makeCtx(root);
  ctx.config = { ...ctx.config, check: { command: "exit 1", gateCommand: "true" } };
  const mainBefore = mainSha(root);

  // The gate's pre-check (the gateCommand) ran green on exactly this head.
  const result = await mergeToMain(ctx, wt, "branch work", head);

  assert.equal(result, "merge_blocked", "the red full check blocks the landing");
  assert.equal(mainSha(root), mainBefore);
  const checks = eventsOfType(root, "build_check");
  assert.deepEqual(
    checks.map((e) => [e.scope, e.status, (e as { script?: string }).script]),
    [["landing", "failed", "exit 1"]],
    "one landing-scope run of check.command, never the gate command",
  );
});

/** A code change whose gate verified `head`, on a project whose declared check is red if it ever
 * runs: what each doc-drift test below lands. */
async function verifiedCodeChange(): Promise<{ root: string; wt: string; head: string }> {
  const { root, wt } = await initializedWorktree();
  declareBuildCheck(root, wt, "exit 1");
  sh(wt, "git", "reset", "--hard", "main"); // tick-start reset: author on top of CURRENT main
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  return { root, wt, head: headSha(wt) };
}

test("main moving under the verified head by doc commits alone skips the re-check", async () => {
  const { root, wt, head } = await verifiedCodeChange();
  advanceMain(root, "NOTES.md", "plans moved on\n");
  advanceMain(root, "GUIDE.md", "and the guide\n");
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "branch work", head);

  assert.equal(result, "changed", "the red check never ran: the tree is the verified one plus docs");
  assert.equal(eventsOfType(root, "build_check").length, 0);
  assert.ok(fs.existsSync(path.join(root, "app.js")) && fs.existsSync(path.join(root, "NOTES.md")));
  // The landed SHA carries a green inherited from the verified head: the red-main gate trusts it
  // without a run, and attribution (observedOnly) would still run the suite itself.
  const runs: unknown[] = [];
  const baseline = await checkMainBaseline(root, defaultConfig(), (run) => runs.push(run));
  assert.equal(runs.length, 0);
  assert.equal(baseline.baseline?.inheritedFrom, head);
});

test("a rebase that only rewrote SHAs lands the verified bytes unchecked and seeds an observed green", async () => {
  const { root, wt, head } = await verifiedCodeChange();
  sh(root, "git", "commit", "-q", "--allow-empty", "-m", "main moves without changing a byte");
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "branch work", head);

  assert.equal(result, "changed");
  assert.notEqual(mainSha(root), head, "the rebase rewrote the commit");
  assert.equal(eventsOfType(root, "build_check").length, 0, "the tree is byte-identical to the verified one");
  const baseline = await checkMainBaseline(root, defaultConfig());
  assert.equal(baseline.baseline?.status, "green");
  assert.equal(baseline.baseline?.inheritedFrom, undefined, "the same bytes ran green: an observed verdict");
});

test("a code commit under the verified head still re-runs the check", async () => {
  const { root, wt, head } = await verifiedCodeChange();
  advanceMain(root, "NOTES.md", "docs\n");
  advanceMain(root, "mainfile.txt", "code\n");
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "branch work", head);

  assert.equal(result, "merge_blocked");
  assert.deepEqual(eventsOfType(root, "build_check").map((e) => [e.scope, e.status]), [["landing", "failed"]]);
});

test("with check.gateCommand set, doc-only drift still runs the full check", async () => {
  const { root, wt, head } = await verifiedCodeChange();
  advanceMain(root, "NOTES.md", "docs\n");
  const { ctx } = makeCtx(root);
  ctx.config = { ...ctx.config, check: { command: "exit 1", gateCommand: "true" } };

  const result = await mergeToMain(ctx, wt, "branch work", head);

  assert.equal(result, "merge_blocked", "the gate ran only the gate command, so its green proves nothing here");
  assert.deepEqual(eventsOfType(root, "build_check").map((e) => [e.scope, e.status]), [["landing", "failed"]]);
});

test("a doc-only delta skips the re-check even when main moved under it", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "NOTES.md"), "notes\n");
  commitIn(wt, "doc work");
  // Declared AFTER the commit and tracked NOWHERE: the manifest stays out of every diff so
  // the delta is exempt, while detectBuildCheck still finds a check that would block if run —
  // proving the exemption. (Nothing may track it: git refuses a rebase whose target would
  // turn an untracked worktree file into a tracked one.)
  declareBuildCheck(root, wt, "exit 1", false);
  advanceMain(root, "mainfile.txt", "from main\n");
  const { ctx } = makeCtx(root);

  // No verifiedHead: the gate would have exempted this diff before running any check.
  const result = await mergeToMain(ctx, wt, "doc work");

  assert.equal(result, "changed");
  assert.ok(
    !readEvents(root).some((e) => e.type === "build_check"),
    "an md-only delta cannot break the build — same exemption as the gate",
  );
});

test("a conflict resolution is re-verified inside the lock before landing", async () => {
  const { root, wt } = await initializedWorktree();
  // The tool passes only when seed.txt holds the RESOLVED content — true of the post-resolution
  // tree, false of both pre-conflict sides. A check of either original head would block.
  declareBuildCheck(root, wt, "grep -q resolved seed.txt");
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch\n");
  commitIn(wt, "branch edit");
  advanceMain(root, "seed.txt", "main\n"); // same file → rebase conflict
  const { ctx } = makeCtx(root, async (w) => {
    fs.writeFileSync(path.join(w, "seed.txt"), "resolved\n"); // resolve the markers
    return piResult();
  });

  const result = await mergeToMain(ctx, wt, "branch edit");

  assert.equal(result, "changed");
  const landingChecks = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "landing");
  // The second rebase is a no-op, but its bytes (pi's resolution) were never checked — the
  // pre-merge head captured before the FIRST rebase is what makes this run.
  assert.equal(landingChecks.length, 1, "the post-resolution tree was re-verified");
});

test("a conflict resolution that duplicates ## Done is blocked with a warning, main unchanged", async () => {
  // The 2026-09-25 shape (PLANS.md 9eaae5ac): main moves the only planned entry to Done by
  // ADDING a ## Done heading; the branch adds a new plan under ## Planned; the rebase
  // conflicts and a resolver that keeps both sides puts the new plan under a second
  // ## Done. The gate never saw this tree — the resolution happens after it, inside the
  // lock — so the in-lock re-check is the only guard.
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

  assert.equal(result, "merge_blocked", "the duplicated heading blocks the landing");
  assert.equal(mainSha(root), mainBefore, "main is untouched");
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes("PLANS.md") && m.includes("## Done")),
    `the warning names the file and the heading; got: ${JSON.stringify(warnings)}`,
  );
});

test("a conflict resolution that files a new plan under a single ## Done is blocked with a warning", async () => {
  // The other 2026-09-25 shape (plans part 4/4): ONE ## Done on main, so the duplicate-heading
  // rule cannot see it. A resolver that keeps main's Done section and places the branch's new
  // plan below it strands the plan where no Planned reader looks. The in-lock re-check is the
  // site that catches conflict resolutions, so it must catch this one too.
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

  assert.equal(result, "merge_blocked", "the misfiled new plan blocks the landing");
  assert.equal(mainSha(root), mainBefore, "main is untouched");
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes("PLANS.md") && m.includes("## Planned")),
    `the warning names the file and where the plan belongs; got: ${JSON.stringify(warnings)}`,
  );
  assertWorktreeSettled(wt);
});

test("a code diff that duplicates ## Done is blocked by the structure check before any build check", async () => {
  // The exempt path's duplicate-heading block is covered above; this pins the sibling block
  // for CODE diffs, which must fire BEFORE runScopedBuildCheck so a conflict resolution that
  // broke backlog structure reads as an explained block, never as an unexplained red check
  // run on a tree that could never land.
  const { root, wt } = await initializedWorktree();
  // A deterministic red: if the structure block failed to fire, the landing would still be
  // rejected — but as a failed build_check, so the absence of any build_check event below
  // proves the structure block is what blocked this landing.
  declareBuildCheck(root, wt, "exit 1");
  // A code file makes the delta non-exempt (an .md-only delta would take the exempt block).
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  // initProject's template ships exactly one ## Done; a second one trips rule (a) — head
  // count 2 exceeds the base's 1.
  fs.appendFileSync(path.join(wt, "PLANS.md"), "## Done\n");
  commitIn(wt, "code work");
  // Advance main so the rebase is a real rebase: a no-op rebase with no gateCommand
  // short-circuits before any structure check runs.
  advanceMain(root, "mainfile.txt", "from main\n");
  const mainBefore = mainSha(root);
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "code work");

  assert.equal(result, "merge_blocked", "the duplicated heading blocks the landing");
  assert.equal(mainSha(root), mainBefore, "main is untouched");
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes("PLANS.md") && m.includes('## Done')),
    `the warning is the structure reason, not a check failure; got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    !readEvents(root).some((e) => e.type === "build_check" && e.scope === "landing"),
    "no landing build check ran — the structure block fires first",
  );
  assertWorktreeSettled(wt);
});

