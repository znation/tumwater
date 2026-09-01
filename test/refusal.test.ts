import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleRefusal, type RefusalContext } from "../src/refusal.js";
import { initProject } from "../src/init.js";
import { ensureWorktree } from "../src/git.js";
import { freshLoopState } from "../src/state.js";
import type { LoopState, PiRunResult, TickResult } from "../src/types.js";
import { makeRepo, sh } from "./util.js";

/** A refused pi run result; tests override only what they exercise. */
function refusedPi(over: Partial<PiRunResult> = {}): PiRunResult {
  return {
    ok: true,
    finalText: "TUMWATER_REFUSED",
    nothingToDo: false,
    refused: true,
    outputTokens: 0,
    peakContextTokens: 0,
    turns: 3,
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

interface MergeCall {
  wt: string;
  summary: string;
}

/** A RefusalContext for role "improve" whose merge records every call and returns `result`. */
function makeCtx(result: TickResult = "changed"): { ctx: RefusalContext; merges: MergeCall[] } {
  const merges: MergeCall[] = [];
  return {
    ctx: {
      role: "improve",
      mainBranch: "main",
      turns: 3,
      merge: async (wt, summary) => {
        merges.push({ wt, summary });
        return result;
      },
    },
    merges,
  };
}

/** A fresh initialized repo plus the improve role's worktree. */
async function setup(): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  await initProject(root, "A test project.");
  const wt = await ensureWorktree(root, "improve", "main");
  return { root, wt };
}

test("a refusal with a markdown note commits only the note and merges it directly", async () => {
  const { wt } = await setup();
  // The refusing run's leftovers: an objection note (md), a half-done tracked edit, and junk.
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** it would delete user data\n");
  fs.appendFileSync(path.join(wt, "seed.txt"), "bad\n");
  fs.writeFileSync(path.join(wt, "broken.ts"), "export const broken = true;\n");

  const state: LoopState = { ...freshLoopState("improve"), ticks: 7 };
  const { ctx, merges } = makeCtx();
  const outcome = await handleRefusal(ctx, state, wt, refusedPi({ refusedReason: "it would delete user data" }));

  assert.equal(outcome.result, "refused");
  assert.equal(outcome.summary, "it would delete user data");
  assert.ok(outcome.commit, "the note commit is reported");

  // The note commit sits on the branch with the refusal subject and the harness-stamped
  // trailer (landing it on main is the merge wiring's job — recorded above, not faked here)...
  const log = sh(wt, "git", "log", "-1", "--format=%s%n%b");
  assert.match(log, /tumwater\(improve\): refuse — it would delete user data/);
  assert.match(log, /Tick: improve #7 · turns 3/);
  // ...and nothing else did: the tracked edit was reset and the untracked file cleaned.
  assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), "seed\n", "the code change was discarded");
  assert.ok(!fs.existsSync(path.join(wt, "broken.ts")), "untracked half-work is cleaned");

  // The note commit merges directly — through the loop's shared merge wiring, once.
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.summary, "refused: it would delete user data");
});

test("a refusal with no note resets the worktree and never merges", async () => {
  const { root, wt } = await setup();
  fs.writeFileSync(path.join(wt, "broken.ts"), "export const broken = true;\n");

  const state: LoopState = freshLoopState("improve");
  const before = sh(root, "git", "rev-parse", "main");
  const { ctx, merges } = makeCtx();
  const outcome = await handleRefusal(ctx, state, wt, refusedPi({ refusedReason: "half-baked" }));

  assert.equal(outcome.result, "refused");
  assert.equal(outcome.summary, "half-baked");
  assert.equal(outcome.commit, undefined, "no commit without a note");
  assert.equal(merges.length, 0, "nothing to merge");
  assert.equal(sh(root, "git", "rev-parse", "main"), before, "main is untouched");
  assert.ok(!fs.existsSync(path.join(wt, "broken.ts")), "the half-work was discarded");
  assert.equal(sh(wt, "git", "status", "--porcelain"), "", "the worktree is clean after the reset");
});

test("a bare sentinel falls back to a generic reason", async () => {
  const { wt } = await setup();
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** no reason written\n");

  const state: LoopState = freshLoopState("improve");
  const { ctx } = makeCtx();
  const outcome = await handleRefusal(ctx, state, wt, refusedPi());

  assert.equal(outcome.result, "refused");
  assert.equal(outcome.summary, "no reason given", "a bare sentinel falls back to a generic reason");
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): refuse — no reason given/);
});

test("a failed note merge records lastError and still reports the commit", async () => {
  const { wt } = await setup();
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** it would delete user data\n");

  const state: LoopState = freshLoopState("improve");
  const { ctx, merges } = makeCtx("merge_conflict");
  const outcome = await handleRefusal(ctx, state, wt, refusedPi({ refusedReason: "it would delete user data" }));

  assert.equal(outcome.result, "refused", "the refusal itself still stands");
  assert.ok(outcome.commit, "the note commit exists on the branch even though it did not land");
  assert.equal(merges.length, 1);
  assert.equal(state.lastError, "refusal note merge failed: merge_conflict");
});
