import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recoverLeftover, type LeftoverContext } from "../src/leftover.js";
import { aheadOfMain, ensureWorktree, resetWorktreeToMain } from "../src/git.js";
import { readEvents } from "../src/events.js";
import type { GateResult } from "../src/review.js";
import type { PiRunResult, TickResult } from "../src/types.js";
import { makeRepo, sh } from "./util.js";

// Unit coverage for src/leftover.ts's recoverLeftover — the salvage path that re-reviews and
// re-merges commits a previous run left on the branch. The loop e2e tests (test/loop.test.ts)
// exercise only two of its branches end-to-end (approved → merged, unmergeable → warned); the
// aborted / rejected / failed-at-cap decisions and the usage-folding wiring are covered here
// against a real git worktree with the gate, merge, and foldUsage seams faked.

const ROLE = "improve";

/** A minimal PiRunResult for asserting foldUsage received the reviewer's run. */
function fakeRun(overrides: Partial<PiRunResult> = {}): PiRunResult {
  return {
    ok: true,
    finalText: "",
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
    ...overrides,
  };
}

/** A LeftoverContext whose gate/merge/foldUsage are recording stubs. `gate` may be a fixed
 * GateResult or an async function (for gates that mutate the worktree, like reject/discard). */
function fakeCtx(
  root: string,
  gate: GateResult | ((wt: string) => Promise<GateResult>),
  mergeResult: TickResult = "changed",
): { ctx: LeftoverContext; calls: { gates: number; merges: [string, string][]; folded: PiRunResult[] } } {
  const calls = { gates: 0, merges: [] as [string, string][], folded: [] as PiRunResult[] };
  const ctx: LeftoverContext = {
    root,
    role: ROLE,
    mainBranch: "main",
    reviewGate: async (w) => {
      calls.gates++;
      return typeof gate === "function" ? await gate(w) : gate;
    },
    foldUsage: (run) => calls.folded.push(run),
    merge: async (w, summary) => {
      calls.merges.push([w, summary]);
      return mergeResult;
    },
  };
  return { ctx, calls };
}

/** Repo with a worktree one commit ahead of main — the leftover to salvage. */
async function leftoverFixture(): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "leftover change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "stranded work");
  return { root, wt };
}

test("no leftover: returns false without running the gate or merging", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main"); // nothing ahead of main
  const { ctx, calls } = fakeCtx(root, { decision: "approved" });

  assert.equal(await recoverLeftover(ctx, wt), false);
  assert.equal(calls.gates, 0, "the gate never runs when the branch is not ahead");
  assert.equal(calls.merges.length, 0);
});

test("approved leftover merges; reviewer usage folds in and the summary names the role", async () => {
  const { root, wt } = await leftoverFixture();
  const run = fakeRun({ outputTokens: 42 });
  const { ctx, calls } = fakeCtx(root, { decision: "approved", run });

  assert.equal(await recoverLeftover(ctx, wt), false); // merged: caller resets as usual
  assert.equal(calls.gates, 1);
  assert.deepEqual(calls.merges, [[wt, `recovered leftover work from ${ROLE}`]]);
  assert.equal(calls.folded.length, 1, "the recovery review's usage folds into the tick counters");
  assert.equal(calls.folded[0], run);
});

test("exempt diff merges without a reviewer run and folds no usage", async () => {
  const { root, wt } = await leftoverFixture();
  const { ctx, calls } = fakeCtx(root, { decision: "exempt" }); // no `run` in the result

  assert.equal(await recoverLeftover(ctx, wt), false);
  assert.equal(calls.merges.length, 1);
  assert.equal(calls.folded.length, 0, "no pi run was consumed, so nothing folds");
});

test("unmergeable leftover is warned about and left to the caller's reset", async () => {
  const { root, wt } = await leftoverFixture();
  const { ctx, calls } = fakeCtx(root, { decision: "approved" }, "merge_conflict");

  assert.equal(await recoverLeftover(ctx, wt), false); // not kept for retry — it is gone after reset
  assert.equal(calls.merges.length, 1);
  const warnings = readEvents(root).filter((e) => e.type === "warning").map((e) => String(e.message));
  assert.ok(
    warnings.some((w) => /discarding 1 unmergeable leftover commit\(s\) \(merge_conflict\)/.test(w)),
    `expected a discard warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("shutdown mid-recovery-review fails closed: kept for retry, nothing merged", async () => {
  const { root, wt } = await leftoverFixture();
  const run = fakeRun({ aborted: true });
  const { ctx, calls } = fakeCtx(root, { decision: "failed", aborted: true, run });

  assert.equal(await recoverLeftover(ctx, wt), true); // caller keeps the commit for re-review
  assert.equal(calls.merges.length, 0, "an aborted review never reaches the merge");
  assert.equal(calls.folded.length, 1, "the killed reviewer's partial usage still folds in");
  assert.equal(await aheadOfMain(wt, "main"), 1); // the commit is untouched on the branch
});

test("rejected leftover: the gate already reset to main and recovery does not re-merge", async () => {
  const { root, wt } = await leftoverFixture();
  // The real reject path resets the branch inside the gate; simulate that side effect.
  const { ctx, calls } = fakeCtx(root, async (w) => {
    await resetWorktreeToMain(w, "main");
    return { decision: "rejected", detail: "breaks the zero-dep rule" };
  });

  assert.equal(await recoverLeftover(ctx, wt), false); // discarded: caller resets as usual (no-op)
  assert.equal(calls.merges.length, 0, "a rejected leftover must never reach the merge");
  assert.equal(await aheadOfMain(wt, "main"), 0);
});

test("failed review under the strike cap keeps the commit for re-review", async () => {
  const { root, wt } = await leftoverFixture();
  const run = fakeRun({ errorMessage: "no parseable VERDICT line in the reviewer's reply" });
  const { ctx, calls } = fakeCtx(root, { decision: "failed", detail: "no verdict", run });

  assert.equal(await recoverLeftover(ctx, wt), true); // under the cap the gate left it on purpose
  assert.equal(calls.merges.length, 0);
  assert.equal(await aheadOfMain(wt, "main"), 1);
});

test("failed review at the strike cap: the gate discarded it, so nothing is kept", async () => {
  const { root, wt } = await leftoverFixture();
  // At/over REVIEW_FAILURE_LIMIT the real gate resets to main and warns; simulate that.
  const { ctx, calls } = fakeCtx(root, async (w) => {
    await resetWorktreeToMain(w, "main");
    return { decision: "failed", detail: "no verdict" };
  });

  assert.equal(await recoverLeftover(ctx, wt), false); // re-check finds nothing ahead
  assert.equal(calls.merges.length, 0);
  assert.equal(await aheadOfMain(wt, "main"), 0);
});
