import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeToMain, type MergeContext } from "../src/merge.js";
import { initProject } from "../src/init.js";
import { aheadOfMain, ensureWorktree } from "../src/git.js";
import { readEvents } from "../src/events.js";
import type { PiRunResult } from "../src/types.js";
import { makeRepo, sh, tmpdir } from "./util.js";

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
 * defers to `resolve` (or returns a plain ok result when none is given). */
function makeCtx(
  root: string,
  resolve?: (wt: string, prompt: string, session: string) => Promise<PiRunResult>,
): { ctx: MergeContext; calls: PiCall[] } {
  const calls: PiCall[] = [];
  return {
    ctx: {
      root,
      role: "improve",
      mainBranch: "main",
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
