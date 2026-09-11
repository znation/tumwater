import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ffMainTo, mergeToMain, type MergeContext } from "../src/merge.js";
import { checkMainBaseline } from "../src/build-check.js";
import { branchName } from "../src/paths.js";
import { initProject } from "../src/init.js";
import { aheadOfMain } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { readEvents } from "../src/events.js";
import type { PiRunResult } from "../src/types.js";
import { makeRepo, sh } from "./util.js";

/** A compliant pi run result; tests override only what they exercise. */
function piResult(over: Partial<PiRunResult> = {}): PiRunResult {
  return {
    ok: true,
    finalText: "resolved",
    nothingToDo: false,
    refused: false,
    outputTokens: 0,
    peakContextTokens: 0,
    turns: 1,
    costUsd: 0,
    timedOut: false,
    aborted: false,
    contextExceeded: false,
    transientServerTimeout: false,
    transientPiCrash: false,
    finalMessageContentless: false,
    compacted: false,
    ...over,
  };
}

interface PiCall {
  wt: string;
  prompt: string;
  session: string;
}

/** A MergeContext for role "improve" on tick 7 whose runPi records every call and then
 * defers to `resolve` (or returns a plain ok result when none is given). The ref is the role's
 * own branch — exactly what loop.ts passes. exemptPaths carries the config defaults, as
 * loop.ts does. */
function makeCtx(
  root: string,
  resolve?: (wt: string, prompt: string, session: string) => Promise<PiRunResult>,
): { ctx: MergeContext; calls: PiCall[] } {
  const calls: PiCall[] = [];
  return {
    ctx: {
      root,
      ref: branchName("improve"),
      role: "improve",
      mainBranch: "main",
      exemptPaths: ["*.md", "docs/**"],
      tick: 7,
      runPi: async (wt, prompt, session) => {
        calls.push({ wt, prompt, session });
        return resolve ? await resolve(wt, prompt, session) : piResult();
      },
    },
    calls,
  };
}

/** A fresh initialized repo (seed.txt on main, .tumwater gitignored) — the same base every
 * other test builds on, so `git add -A` never sweeps in the worktree dir. */
async function initializedRoot(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "A test project.");
  return repo;
}

/** A fresh repo plus the improve role's worktree. */
async function setup(): Promise<{ root: string; wt: string }> {
  const root = await initializedRoot();
  const wt = await ensureWorktree(root, "improve", "main");
  return { root, wt };
}

function commitIn(dir: string, msg: string): void {
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-m", msg);
}

/** No merge or rebase left in progress and the worktree back on its committed branch state. */
function assertWorktreeSettled(wt: string): void {
  assert.equal(sh(wt, "git", "status", "--porcelain"), "", "worktree clean, no rebase in progress");
}

test("a clean rebase lands as changed with a merged event and linear history", async () => {
  const { root, wt } = await setup();
  fs.writeFileSync(path.join(wt, "hello.txt"), "hi\n");
  commitIn(wt, "branch work");
  const { ctx, calls } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "changed");
  assert.equal(calls.length, 0, "no conflict — pi is never invoked");
  assert.equal(sh(root, "git", "rev-parse", "main"), sh(wt, "git", "rev-parse", "HEAD"));
  assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "hi\n");
  assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "", "history stays linear");
  const merged = readEvents(root).filter((e) => e.type === "merged");
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.commit, sh(root, "git", "rev-parse", "main"));
  assert.equal(merged[0]!.summary, "branch work");
});

test("a rebase conflict is resolved by one pi run and lands with linear history", async () => {
  const { root, wt } = await setup();
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch\n");
  commitIn(wt, "branch edit");
  // Advance main with a conflicting edit while the tick's work is unmerged.
  fs.writeFileSync(path.join(root, "seed.txt"), "main\n");
  commitIn(root, "main edit");
  const { ctx, calls } = makeCtx(root, async (w) => {
    fs.writeFileSync(path.join(w, "seed.txt"), "combined\n"); // resolve the markers
    return piResult();
  });

  const result = await mergeToMain(ctx, wt, "branch edit");

  assert.equal(result, "changed");
  assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "combined\n");
  assert.equal(calls.length, 1, "exactly one resolution attempt per tick");
  assert.equal(calls[0]!.session, "tumwater-improve-7-conflict", "named after the role and tick");
  assert.match(calls[0]!.prompt, /seed\.txt/, "the prompt names the conflicted file");
  assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "", "history stays linear");
});

test("a conflict pi leaves unresolved aborts and reports merge_conflict", async () => {
  const { root, wt } = await setup();
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch\n");
  commitIn(wt, "branch edit");
  fs.writeFileSync(path.join(root, "seed.txt"), "main\n");
  commitIn(root, "main edit");
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const { ctx } = makeCtx(root); // runPi does nothing: markers stay

  const result = await mergeToMain(ctx, wt, "branch edit");

  assert.equal(result, "merge_conflict");
  assertWorktreeSettled(wt);
  assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), "branch\n", "branch state restored");
  assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "main is untouched");
  assert.equal(await aheadOfMain(wt, "main"), 1, "the tick's commit survives for the next attempt");
  assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 0);
});

test("a failed pi run aborts even when it resolved every marker", async () => {
  const { root, wt } = await setup();
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch\n");
  commitIn(wt, "branch edit");
  fs.writeFileSync(path.join(root, "seed.txt"), "main\n");
  commitIn(root, "main edit");
  const mainBefore = sh(root, "git", "rev-parse", "main");
  // The run resolves the file but reports failure (e.g. it timed out): merge must not
  // conclude a rebase on work pi did not stand behind.
  const { ctx } = makeCtx(root, async (w) => {
    fs.writeFileSync(path.join(w, "seed.txt"), "combined\n");
    return piResult({ ok: false, errorMessage: "boom" });
  });

  const result = await mergeToMain(ctx, wt, "branch edit");

  assert.equal(result, "merge_conflict");
  assertWorktreeSettled(wt);
  assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "the rebase was never continued");
});

test("a second conflict on replay aborts after one resolution attempt", async () => {
  const { root, wt } = await setup();
  // Two branch commits both rewriting seed.txt: resolving the first still leaves the
  // second conflicting when git replays it.
  fs.writeFileSync(path.join(wt, "seed.txt"), "one\n");
  commitIn(wt, "first edit");
  fs.writeFileSync(path.join(wt, "seed.txt"), "two\n");
  commitIn(wt, "second edit");
  const branchHead = sh(wt, "git", "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "seed.txt"), "main\n");
  commitIn(root, "main edit");
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const { ctx } = makeCtx(root, async (w) => {
    fs.writeFileSync(path.join(w, "seed.txt"), "resolved\n"); // resolves only the first stop
    return piResult();
  });

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "merge_conflict", "one resolution attempt per tick — no retry loop");
  assertWorktreeSettled(wt);
  assert.equal(sh(wt, "git", "rev-parse", "HEAD"), branchHead, "abort restored the branch");
  assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), "two\n");
  assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore);
  assert.equal(await aheadOfMain(wt, "main"), 2, "both commits survive for the next attempt");
});

test("a fast-forward that git refuses reports merge_blocked without landing", async () => {
  const { root, wt } = await setup();
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch\n");
  commitIn(wt, "branch edit");
  // The primary checkout sits on main with a local edit to the same file: the working-tree
  // ff-merge would overwrite it, so git refuses.
  fs.writeFileSync(path.join(root, "seed.txt"), "local\n");
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "branch edit");

  assert.equal(result, "merge_blocked");
  assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "main never moved");
  assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "local\n", "the local edit survives");
  assert.equal(await aheadOfMain(wt, "main"), 1, "the branch keeps its commit for a later landing");
  assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 0);
});

test("the landing-flow git helpers are exported from merge.js (regression)", async () => {
  // Organize tick 78 deleted these six functions from src/git.ts intending to move them
  // here, but never added them — main's build broke with TS2305 in this file and in
  // test/git.test.ts until the bugfix completed the move. Pin the placement at runtime so a
  // half-finished re-move fails loudly instead of silently stranding the landing flow.
  const merge = await import("../src/merge.js");
  for (const name of [
    "conflictedFiles",
    "rebaseOntoMain",
    "rebaseOntoMainLeaveConflicts",
    "hasConflictMarkers",
    "continueRebase",
    "ffMainTo",
  ] as const) {
    assert.equal(typeof merge[name], "function", `merge.js exports ${name}`);
  }
  // And one of them actually works from its new home: a real rebase onto an advanced main.
  const { root, wt } = await setup();
  fs.writeFileSync(path.join(wt, "hello.txt"), "hi\n");
  commitIn(wt, "branch work");
  fs.writeFileSync(path.join(root, "seed.txt"), "main advanced\n");
  commitIn(root, "main edit");
  assert.equal(await merge.rebaseOntoMain(wt, "main"), true);
  assert.equal(await merge.ffMainTo(root, branchName("improve"), "main"), true);
  assert.equal(sh(root, "git", "rev-parse", "main"), sh(wt, "git", "rev-parse", "HEAD"));
});

/** A detached worktree (no branch) with one commit ahead of main; returns its head sha.
 * The seam merge queue 2/5 builds on: landing takes a ref from any worktree. */
function detachedAheadOfMain(repo: string): string {
  const wt = path.join(repo, ".detached");
  sh(repo, "git", "worktree", "add", "-d", wt);
  fs.writeFileSync(path.join(wt, "new.txt"), "hi\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "detached work");
  return sh(wt, "git", "rev-parse", "HEAD");
}

test("ffMainTo lands a bare sha from a detached worktree while root is on main", async () => {
  const repo = makeRepo();
  const sha = detachedAheadOfMain(repo);

  assert.ok(await ffMainTo(repo, sha, "main"));
  assert.equal(sh(repo, "git", "rev-parse", "main"), sha);
  // The working-tree merge updated the primary checkout's files too.
  assert.ok(fs.existsSync(path.join(repo, "new.txt")));
});

test("ffMainTo lands a bare sha via ref push when root is on another branch", async () => {
  const repo = makeRepo();
  sh(repo, "git", "checkout", "-b", "scratch");
  const sha = detachedAheadOfMain(repo);

  assert.ok(await ffMainTo(repo, sha, "main"));
  assert.equal(sh(repo, "git", "rev-parse", "main"), sha);
});

test("a merged diff that posts new Open questions emits one question_posted per entry", async () => {
  const root = await initializedRoot();
  fs.writeFileSync(
    path.join(root, "QUESTIONS.md"),
    "# Questions\n\n## Open\n\n### First question (asked by improve)\n\nBody.\n\n## Answered\n\n_None yet._\n",
  );
  commitIn(root, "seed questions");
  // The branch forks AFTER the seed so its edit modifies an existing file — no add/add conflict.
  const wt = await ensureWorktree(root, "improve", "main");
  fs.writeFileSync(
    path.join(wt, "QUESTIONS.md"),
    "# Questions\n\n## Open\n\n### First question (asked by improve)\n\nBody.\n\n### Second question (asked by improve)\n\nBody.\n\n## Answered\n\n_None yet._\n",
  );
  commitIn(wt, "post a question");
  const { ctx } = makeCtx(root);

  const result = await mergeToMain(ctx, wt, "post a question");

  assert.equal(result, "changed");
  const events = readEvents(root);
  assert.equal(events.filter((e) => e.type === "merged").length, 1);
  const posted = events.filter((e) => e.type === "question_posted");
  assert.deepEqual(
    posted.map((e) => e.question),
    ["Second question (asked by improve)"],
    "exactly one event for the new heading — the pre-existing entry is not re-posted",
  );
});

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
  const manifest = JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "buildcheck-tool" } });
  fs.writeFileSync(path.join(root, "package.json"), manifest);
  if (commitManifestToMain) {
    sh(root, "git", "add", "package.json"); // targeted — never sweeps in node_modules
    sh(root, "git", "commit", "-m", "declare build check");
  }
  const tool = path.join(binDir, "buildcheck-tool");
  fs.writeFileSync(tool, `#!/bin/sh\n${toolBody}\n`);
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(wt, "package.json"), manifest);
}

/** Advance main (the primary checkout) by one commit touching exactly `file` — a targeted add,
 * never `-A`, so the untracked build-check fixture at root is not swept into the commit. */
function advanceMain(root: string, file: string, content: string): void {
  fs.writeFileSync(path.join(root, file), content);
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", `main moves (${file})`);
}

test("a rebase that rewrote the commits re-runs the declared check on the rebased tree before landing", async () => {
  const { root, wt } = await setup();
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
  const { root, wt } = await setup();
  declareBuildCheck(root, wt, "exit 1"); // fails on every tree — a deterministic red
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  advanceMain(root, "mainfile.txt", "from main\n");
  const { ctx } = makeCtx(root);
  const mainBefore = sh(root, "git", "rev-parse", "main");

  const result = await mergeToMain(ctx, wt, "branch work");

  assert.equal(result, "merge_blocked");
  assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing lands on a red tree");
  assert.ok(
    readEvents(root).some((e) => e.type === "build_check" && e.scope === "landing" && e.status === "failed"),
    "the failed re-check is priced in the feed",
  );
  assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 0);
  // The commit stays on the branch: next tick's recovery routes it through the gate, whose
  // pre-check rejects it deterministically and injects the build tail into the author's prompt.
  assert.equal(await aheadOfMain(wt, "main"), 1);
  assertWorktreeSettled(wt); // no rebase left in progress
});

test("a no-op rebase skips the re-check and seeds the baseline for the landed SHA", async () => {
  const { root, wt } = await setup();
  declareBuildCheck(root, wt); // would pass if run — but must NOT run (no landing event)
  sh(wt, "git", "reset", "--hard", "main"); // tick-start reset: author on top of CURRENT main
  fs.writeFileSync(path.join(wt, "app.js"), "branch\n");
  commitIn(wt, "branch work");
  const head = sh(wt, "git", "rev-parse", "HEAD");
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
  await checkMainBaseline(root, (run) => runs.push(run));
  assert.equal(runs.length, 0, "the landing path seeded the green verdict for the SHA that became main");
});

test("a doc-only delta skips the re-check even when main moved under it", async () => {
  const { root, wt } = await setup();
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
  const { root, wt } = await setup();
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
