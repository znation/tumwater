import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { landChange, type LandRequest, type LanderContext } from "../src/lander.js";
import { aheadOfMain, refSha, setRef } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { landingRefName, landWorktreePath, statePath } from "../src/paths.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import type { LoopState, PiRunResult } from "../src/types.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir } from "./util.js";

// Unit coverage for src/lander.ts's landChange — the harness-owned review-and-land of a pinned
// commit in _land-<role> (merge queue 2/5). The reviewer run is a real pi subprocess behind the
// fake shim; merge.ts's conflict resolver goes through LanderContext.runPi, which is stubbed.

const ROLE = "improve";
const REF = landingRefName(ROLE);

/** A compliant pi run result for the stubbed conflict-resolution runs. */
function piResult(): PiRunResult {
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
    quietKilled: false,
    aborted: false,
    contextExceeded: false,
    transientServerTimeout: false,
    transientPiCrash: false,
    finalMessageContentless: false,
    compacted: false,
  };
}

interface PiCall {
  wt: string;
  prompt: string;
  session: string;
}

/** A LanderContext wired like loop.ts does: real config/state, a recording runPi stub for the
 * conflict resolver (which may also mutate the worktree via `resolve`), and an abortable signal. */
function makeCtx(
  root: string,
  state: LoopState,
  resolve?: (wt: string) => void,
): { ctx: LanderContext; calls: PiCall[]; folded: PiRunResult[]; controller: AbortController } {
  const calls: PiCall[] = [];
  const folded: PiRunResult[] = [];
  const controller = new AbortController();
  const ctx: LanderContext = {
    root,
    mainBranch: "main",
    config: defaultConfig(),
    state,
    runPi: async (wt, prompt, session) => {
      calls.push({ wt, prompt, session });
      resolve?.(wt);
      return piResult();
    },
    foldUsage: (run) => folded.push(run),
    signal: () => controller.signal,
  };
  return { ctx, calls, folded, controller };
}

/** A repo with one commit NOT contained in main, pinned by the landing ref — exactly what
 * loop.ts leaves behind after pinAndReset. The role worktree is created at main (clean), as the
 * reset left it. */
async function pinnedFixture(): Promise<{ root: string; sha: string; wt: string }> {
  const root = makeRepo();
  sh(root, "git", "checkout", "--detach");
  fs.appendFileSync(path.join(root, "seed.txt"), "the work\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "the work");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  await setRef(root, REF, sha);
  const wt = await ensureWorktree(root, ROLE, "main"); // the role worktree: clean at main
  return { root, sha, wt };
}

function request(sha: string, overrides: Partial<LandRequest> = {}): LandRequest {
  return { role: ROLE, sha, tick: 7, summary: "the work", ...overrides };
}

test("an approved landing lands on main and deletes the ref", async () => {
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
  );
  try {
    const { root, sha, wt } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);

    assert.equal(await landChange(ctx, request(sha)), "changed");

    assert.equal(sh(root, "git", "rev-parse", "main"), sha, "the pinned commit is main's head");
    assert.equal(await refSha(root, REF), null, "the pin was deleted on landing");
    assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree stayed clean at main");
    assert.equal(folded.length, 1, "the reviewer run's usage folds into the tick counters");
    assert.equal(state.lastReview?.verdict, "approve");
  } finally {
    restore();
  }
});

test("the gate's verdict is durable on disk before the tick's end save", async () => {
  // Regression (2026-09-14): state was written to disk only at tick boundaries, so a
  // sudden death after the gate's verdict (power loss, kill -9) left the last
  // tick-boundary snapshot on disk — a stale "reject" for work already superseded —
  // and every later tick got a "your previous change was rejected" note about work
  // that was already on main. The verdict must be durable before the tick's tail
  // (the landing plus the still-to-come authoring run) can die unsaved.
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    // What disk holds at tick start: the superseded rejection's verdict.
    state.lastReview = {
      verdict: "reject",
      reasons: ["build check failed (test): stale"],
      head: "0".repeat(40),
      at: Date.now() - 3_600_000,
    };
    saveLoopState(root, state);
    const { ctx } = makeCtx(root, state);

    assert.equal(await landChange(ctx, request(sha)), "changed");

    // Read back from disk, not the in-memory object: without an immediate persist the
    // file still holds the seeded reject and the stale note would survive the crash.
    const onDisk = JSON.parse(fs.readFileSync(statePath(root, ROLE), "utf8")) as LoopState;
    assert.equal(onDisk.lastReview?.verdict, "approve", "the approve is durable on disk, not just in memory");
    assert.equal(onDisk.lastApprovedHead, sha, "the approved head is durable");
  } finally {
    restore();
  }
});

test("a rejected landing lands nothing: role worktree clean at main, ref deleted, reasons recorded", async () => {
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: reject\n1. breaks the zero-dep rule")}'; exit 0;; esac; done`,
  );
  try {
    const { root, sha, wt } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const { ctx } = makeCtx(root, state);

    assert.equal(await landChange(ctx, request(sha)), "rejected");

    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree is clean at main");
    assert.equal(sh(wt, "git", "status", "--porcelain"), "", "no stray edits in the role worktree");
    assert.equal(await refSha(root, REF), null, "a rejection is terminal: the pin goes too");
    assert.deepEqual(state.lastReview?.reasons, ["breaks the zero-dep rule"]);
  } finally {
    restore();
  }
});

test("a verdict-less failure under the strike cap returns review_error and keeps the ref", async () => {
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("I think this is fine overall.")}'; exit 0;; esac; done`,
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const { ctx } = makeCtx(root, state);

    assert.equal(await landChange(ctx, request(sha)), "review_error");

    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.ok(state.lastError?.startsWith("review failed:"), `lastError names the failure: ${state.lastError}`);
    assert.equal(await refSha(root, REF), sha, "under the cap the pin stays for next-tick recovery");
  } finally {
    restore();
  }
});

test("three verdict-less failures discard the landing and delete the ref", async () => {
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("I think this is fine overall.")}'; exit 0;; esac; done`,
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE); // one state object across all three attempts
    const mainBefore = sh(root, "git", "rev-parse", "main");

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { ctx } = makeCtx(root, state);
      assert.equal(await landChange(ctx, request(sha)), "review_error");
      assert.equal(await refSha(root, REF), sha, `attempt ${attempt} is under the cap: pin kept`);
    }

    const { ctx } = makeCtx(root, state);
    assert.equal(await landChange(ctx, request(sha)), "review_error", "the discard reports like a failure");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.equal(await refSha(root, REF), null, "past the strike cap the pin is deleted with it");
  } finally {
    restore();
  }
});

test("an abort mid-review returns aborted and keeps the ref", async () => {
  const restore = fakePi(`exec sleep 30`); // never reached: the signal is already aborted
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const { ctx, controller } = makeCtx(root, state);
    controller.abort(); // a shutdown that lands before the reviewer starts

    assert.equal(await landChange(ctx, request(sha)), "aborted");

    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.equal(await refSha(root, REF), sha, "an aborted landing keeps its pin for recovery");
  } finally {
    restore();
  }
});

test("a conflicting landing gets one resolution run and then lands", async () => {
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
  );
  try {
    const { root, sha } = await pinnedFixture();
    // Advance main with a conflicting edit after the pin — the common concurrent case.
    fs.writeFileSync(path.join(root, "seed.txt"), "main\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", "conflicting main edit");

    const state = freshLoopState(ROLE);
    const { ctx, calls } = makeCtx(root, state, (wt) => {
      fs.writeFileSync(path.join(wt, "seed.txt"), "combined\n"); // resolve the markers
    });

    assert.equal(await landChange(ctx, request(sha)), "changed");

    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "combined\n");
    assert.equal(calls.length, 1, "exactly one resolution attempt per landing");
    assert.match(calls[0]!.session, /tumwater-improve-7-conflict/, "named after the role and tick");
    assert.equal(await refSha(root, REF), null, "the pin was deleted on landing");
    // The rebase rewrote the pinned commit onto main's advance: linear history, no merge commits.
    assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
  } finally {
    restore();
  }
});

test("the lander worktree is per-role and detached at the pinned sha", async () => {
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);

    assert.equal(await landChange(ctx, request(sha)), "changed");

    const landWt = landWorktreePath(root, ROLE);
    assert.ok(fs.existsSync(landWt), "_land-<role> exists after a landing");
    assert.equal(sh(landWt, "git", "rev-parse", "HEAD"), sha, "it holds the landed tree");
    // Detached: no branch ref is checked out there — rebasing it never moves a role branch.
    let detached = false;
    try {
      sh(landWt, "git", "symbolic-ref", "--short", "HEAD");
    } catch {
      detached = true; // a detached HEAD makes symbolic-ref exit nonzero
    }
    assert.ok(detached, "_land-<role> is detached at the pinned sha");
  } finally {
    restore();
  }
});
