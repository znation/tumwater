import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  landBatch,
  landChange,
  type BatchContext,
  type BatchRoleWiring,
  type LandRequest,
  type LanderContext,
} from "../src/lander.js";
import { aheadOfMain, refSha, setRef } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { landingRefName, landWorktreePath, statePath } from "../src/paths.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { readEvents } from "../src/events.js";
import type { LoopState, PiRunResult, TumwaterConfig } from "../src/types.js";
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
    transientRateLimit: false,
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

/** The reviewer's fake-pi shim: match the review run (the only run whose args carry a
 * VERDICT-bearing prompt), print `reply` as its one assistant turn, exit 0 — the gate reads
 * the verdict out of `reply`. Author-run shims live in test/util.ts. */
const reviewerPi = (reply: string): string =>
  `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine(reply)}'; exit 0;; esac; done`;

function request(sha: string, overrides: Partial<LandRequest> = {}): LandRequest {
  return { role: ROLE, sha, tick: 7, summary: "the work", ...overrides };
}

test("an approved landing lands on main and deletes the ref", async () => {
  const restore = fakePi(
    reviewerPi("VERDICT: approve"),
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
    reviewerPi("VERDICT: approve"),
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
    reviewerPi("VERDICT: reject\n1. breaks the zero-dep rule"),
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
    reviewerPi("I think this is fine overall."),
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
    reviewerPi("I think this is fine overall."),
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
    reviewerPi("VERDICT: approve"),
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

test("a landing pinned behind main's advance is rebased onto main BEFORE the gate and lands both", async () => {
  // PLANS.md 2026-09-21: the gate must review main's CURRENT tree. Advance main after the
  // pin with a non-conflicting commit, then check the reviewer saw the rebased tree — if the
  // gate ran on the stale pin, main's fix would not be under review and a red main would
  // cascade through every queued landing.
  const rec = path.join(tmpdir("lander-rec-"), "seen");
  const restore = fakePi(
    `git rev-parse HEAD >> ${rec}\n` +
      reviewerPi("VERDICT: approve"),
  );
  try {
    const { root, sha } = await pinnedFixture();
    fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", "fix main");
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);

    assert.equal(await landChange(ctx, request(sha)), "changed");

    // main holds both: main's fix underneath, the rebased change on top (linear, no merge).
    const mainHead = sh(root, "git", "rev-parse", "main").trim();
    assert.notEqual(mainHead, sha, "main moved past the pin: the change was rebased onto the fix");
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "seed\nthe work\n");
    assert.equal(fs.readFileSync(path.join(root, "fix.txt"), "utf8"), "main fix\n");
    assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
    // The reviewer ran in the lander worktree at the SYNCED head — the pre-check/review tree
    // is exactly what became main, and the landing ref tracked it (deleted on landing here).
    const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
    assert.equal(seen[0], mainHead, "the gate reviewed the rebased tree, not the stale pin");
    assert.equal(await refSha(root, REF), null, "the pin was deleted on landing");
  } finally {
    restore();
  }
});

test("a synced rebase moves the landing ref so a failed gate keeps the tree that can land", async () => {
  // The strike-cap tell compares the lander worktree's HEAD against req.sha: when the
  // pre-gate rebase rewrote the pin, the request (and the ref) must name the synced head, or
  // an under-cap failure would look like a strike-cap discard and delete the pinned work.
  const restore = fakePi(
    reviewerPi("I think this is fine overall."),
  );
  try {
    const { root, sha } = await pinnedFixture();
    fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", "fix main");
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);

    assert.equal(await landChange(ctx, request(sha)), "review_error");

    // Nothing landed (main still holds the fix commit), so the synced head is not main's
    // head — it is the rebased commit the lander worktree sits at.
    const syncedHead = sh(landWorktreePath(root, ROLE), "git", "rev-parse", "HEAD").trim();
    assert.notEqual(syncedHead, sha, "the rebase rewrote the pin onto main's fix");
    assert.equal(
      await refSha(root, REF),
      syncedHead,
      "the ref tracks the rebased commit, not the stale pin",
    );
  } finally {
    restore();
  }
});

test("the lander worktree is per-role and detached at the pinned sha", async () => {
  const restore = fakePi(
    reviewerPi("VERDICT: approve"),
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

// ── landBatch (merge queue 5/5) ─────────────────────────────────────────────────────────
// The batch lander: N roles' queued landings stacked into one worktree, one shared build
// check, one fast-forward. The reviewer runs are real pi subprocesses behind the fake shim;
// the fallback landings' conflict resolver goes through the wiring's runPi stub.

/** A repo where every listed role has a single-commit pin based on main — the queue shape
 * the batch drain reads. One separate file per role by default so cherry-picks apply
 * cleanly; `edit` overrides the per-role change (the conflict test rewrites one line). */
// The gate's bounded build-fix run (a red deterministic pre-check gets one model run to turn
// the check green): the pin, the landing tree, and the usage accounting must all track the
// fixed tree, whichever way the gate then decides. The fake shim tells its runs apart by the
// session name pi is handed (`-n tumwater-buildfix-<role>-…` vs `…review…`).
const FIX_PI = (fix: string, review: string) =>
  // Match the session-name argument exactly — the prompt itself may quote the word.
  `b=review\nfor a in "$@"; do case "$a" in tumwater-buildfix-*) b=fix ;; esac; done\nif [ "$b" = fix ]; then ${fix}; else ${review}; fi`;

/** A fail-once build check: the first invocation fails (the pre-check), every later one
 * passes — as if the fix run's edit had made it green. */
function failOnceCheck(root: string, flag: string): void {
  declareCheck(
    root,
    `if [ -f '${flag}' ]; then exit 0; fi\ntouch '${flag}'\necho 'error TS2345: boom' >&2\nexit 1\n`,
  );
}

test("a gate fix run commits the fix and the landing carries work AND fix to main", async () => {
  const flag = path.join(tmpdir(), "lander-fix-green");
  fs.rmSync(flag, { force: true });
  const { root, sha, wt } = await pinnedFixture();
  failOnceCheck(root, flag);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const restore = fakePi(FIX_PI(`echo 'fixed' >> seed.txt`, `printf '%s\n' '${assistantLine("VERDICT: approve")}'`));
  try {
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);
    const result = await landChange(ctx, request(sha));
    assert.equal(result, "changed");
    // BOTH commits reached main — the fix alone would be a landing of nothing.
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2");
    const tree = sh(root, "git", "show", "main:seed.txt");
    assert.ok(tree.includes("the work") && tree.includes("fixed"), `main has work + fix: ${tree}`);
    assert.equal(await refSha(root, REF), null, "landed: the pin is gone");
    // Two pi runs were consumed (fix + reviewer) and both folded into the tick's totals.
    assert.equal(folded.length, 2);
  } finally {
    restore();
  }
  void wt;
});

test("a fix followed by an under-cap reviewer failure keeps the pin on the fixed head", async () => {
  // The regression this pins: the fix commit moves the worktree head past the pinned sha —
  // which the old strike-cap tell read as "the gate discarded the commit", deleting the pin
  // on strike 1 and orphaning the author's work. An under-cap failure must keep the pin,
  // moved to the fixed head, so the next re-land reviews the fixed tree.
  const flag = path.join(tmpdir(), "lander-fix-red-review");
  fs.rmSync(flag, { force: true });
  const { root, sha } = await pinnedFixture();
  failOnceCheck(root, flag);
  const restore = fakePi(
    FIX_PI(`echo 'fixed' >> seed.txt`, `printf '%s\n' '${assistantLine("still no verdict here")}'`),
  );
  try {
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);
    const result = await landChange(ctx, request(sha));
    assert.equal(result, "review_error");
    const pinned = await refSha(root, REF);
    assert.ok(pinned, "the pin survives an under-cap failure");
    assert.notEqual(pinned, sha, "the pin moved to the fixed head");
    const tree = sh(root, "git", "show", `${pinned}:seed.txt`);
    assert.ok(tree.includes("the work") && tree.includes("fixed"), `the pin names the fixed tree: ${tree}`);
    assert.equal(folded.length, 2, "fix run + reviewer both folded despite the failure");
    assert.match(state.lastError ?? "", /review failed/);
  } finally {
    restore();
  }
});

test("a fix run's spend folds even when the landing is rejected", async () => {
  // The no-change fix path: the check stays red, the run made no edits, the landing rejects —
  // the consumed run still folds (never only on the happy path).
  const { root, sha } = await pinnedFixture();
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  const restore = fakePi(FIX_PI(`true`, `printf '%s\n' '${assistantLine("VERDICT: approve")}'`));
  try {
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);
    const result = await landChange(ctx, request(sha));
    assert.equal(result, "rejected");
    assert.equal(await refSha(root, REF), null, "rejected: the pin is gone");
    assert.equal(folded.length, 1, "exactly the fix run folded — the reviewer never ran");
  } finally {
    restore();
  }
});

async function batchPinnedFixture(
  roles: string[],
  edit?: (root: string, role: string) => void,
): Promise<{ root: string; shas: Record<string, string> }> {
  const root = makeRepo();
  sh(root, "git", "checkout", "--detach");
  const shas: Record<string, string> = {};
  for (const role of roles) {
    // Each pin stands alone on main (independent branches, not a stack): the batch's
    // cherry-pick and the fallback's rebase then actually rewrite the second change.
    sh(root, "git", "reset", "--hard", "main");
    if (edit) edit(root, role);
    else fs.appendFileSync(path.join(root, `${role}.txt`), `work by ${role}\n`);
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", `work by ${role}`);
    const sha = sh(root, "git", "rev-parse", "HEAD").trim();
    shas[role] = sha;
    await setRef(root, landingRefName(role), sha);
  }
  sh(root, "git", "checkout", "main");
  return { root, shas };
}

/** Declare the project's build check the way detectBuildCheck finds it: an install
 * signature (package.json + node_modules) at the root, the tool in node_modules/.bin. The
 * worktree resolves the toolchain from the installed root, as in the dogfood layout. */
function declareCheck(root: string, toolBody: string): void {
  const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, toolBody);
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool" } }),
  );
}

const APPROVE_PI = reviewerPi("VERDICT: approve");

function makeBatchCtx(root: string, config?: TumwaterConfig, controller?: AbortController): BatchContext {
  return {
    root,
    mainBranch: "main",
    config: config ?? defaultConfig(),
    signal: () => (controller ?? new AbortController()).signal,
  };
}

/** Per-role wiring resolved the way the drain resolves its authors: a live state object per
 * role, usage recorded per role, and the shared runPi stub (with an optional resolver) for
 * the one-at-a-time fallback landings. */
function makeWiring(
  states: Record<string, LoopState>,
  resolve?: (wt: string) => void,
): { wiringFor: (role: string) => BatchRoleWiring; folded: Map<string, PiRunResult[]>; calls: PiCall[] } {
  const folded = new Map<string, PiRunResult[]>();
  const calls: PiCall[] = [];
  const wiringFor = (role: string): BatchRoleWiring => ({
    state: states[role]!,
    foldUsage: (run) => folded.set(role, [...(folded.get(role) ?? []), run]),
    runPi: async (wt, prompt, session) => {
      calls.push({ wt, prompt, session });
      resolve?.(wt);
      return piResult();
    },
  });
  return { wiringFor, folded, calls };
}

test("an all-rejected batch returns a defined result for every request without throwing", async () => {
  // The review re-audit found this exact shape crashing: |S| == 0 made the lander index the
  // empty stack and throw, and the drain's catch kept every entry — a queue leak. Now the
  // batch simply returns: every request terminal, nothing to land, refs gone.
  const restore = fakePi(
    reviewerPi("VERDICT: reject\n1. no"),
  );
  try {
    const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor } = makeWiring(states);

    const results = await landBatch(
      makeBatchCtx(root),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.deepEqual(results.map((r) => r.result), ["rejected", "rejected"], "every request has a terminal result");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "a rejection deletes its ref");
    assert.equal(await refSha(root, landingRefName("beta")), null, "and the next request's too — the batch lands nothing");
  } finally {
    restore();
  }
});

test("a green batch stacks every approved change, fast-forwards main once, and logs per-change events", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor, folded } = makeWiring(states);

    const results = await landBatch(
      makeBatchCtx(root),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes landed on main");
    const merged = readEvents(root).filter((e) => e.type === "merged");
    assert.equal(merged.length, 2, "one merged event per change, in queue order");
    assert.equal(merged[0]!.commit, sh(root, "git", "rev-parse", "main~1"), "the head is the first new commit on main");
    assert.notEqual(merged[0]!.commit, shas.alpha!, "the head re-committed onto the fresh main base");
    assert.equal(merged[1]!.commit, sh(root, "git", "rev-parse", "main"), "the stacked tip is main's head");
    assert.notEqual(merged[1]!.commit, shas.beta!, "the second change re-committed on top of the first");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "the ff deleted the head's ref");
    assert.equal(await refSha(root, landingRefName("beta")), null, "and the stacked one's");
    assert.equal(folded.get("alpha")!.length, 1, "the gate's reviewer run folded into its own role");
    assert.equal(folded.get("beta")!.length, 1);
    assert.equal(states.alpha.lastApprovedHead, shas.alpha!, "the verdict persisted per role");
    assert.equal(states.beta.lastApprovedHead, shas.beta!);
  } finally {
    restore();
  }
});

test("a batch stacks a fixed change's work AND fix commits, not the fix alone", async () => {
  // The regression this pins: a gate fix run moves the pin to a head whose own diff is only
  // the fix. Picking that single head would land the fix without the work it fixes and
  // orphan the work commit — the stack must pick the whole range from main to that head.
  const flag = path.join(tmpdir(), "batch-fix-range");
  fs.rmSync(flag, { force: true });
  const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
  failOnceCheck(root, flag);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
  const { wiringFor, folded } = makeWiring(states);
  const restore = fakePi(FIX_PI(`echo 'fixed' >> fix.txt`, `printf '%s\n' '${assistantLine("VERDICT: approve")}'`));
  try {
    const results = await landBatch(
      makeBatchCtx(root),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );
    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    // THREE commits on main: alpha's work, alpha's fix, beta's work — none orphaned.
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "3");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"));
    assert.ok(sh(root, "git", "show", "main:fix.txt").includes("fixed"), "the fix landed with its work");
    assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
    assert.equal(await refSha(root, landingRefName("alpha")), null);
    assert.equal(await refSha(root, landingRefName("beta")), null);
    // alpha consumed a fix run + a reviewer; beta only a reviewer.
    assert.equal(folded.get("alpha")!.length, 2);
    assert.equal(folded.get("beta")!.length, 1);
  } finally {
    restore();
  }
});

test("a fast-forward blocked by a concurrent landing keeps every ref as merge_blocked", async () => {
  // Main moves while the batch's shared check runs — a human commit or a non-batched role's
  // recovery landing. The stack was assembled on the old tip, so its tip is no longer a
  // descendant of main and the single ff fails: every approved change must keep its ref for
  // leftover recovery (which re-lands each through its own gate) and nothing may merge.
  const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  // The check moves main on its THIRD run only: the two gate pre-checks pass, then the batch
  // check passes but commits a concurrent landing, so the batch's ff is no longer fast-forward.
  const count = path.join(root, ".checkcount");
  declareCheck(
    root,
    `#!/bin/sh\nc=$(cat ${count} 2>/dev/null || echo 0)\nn=$((c+1))\necho "$n" > ${count}\n` +
      `if [ "$n" = "3" ]; then git -C ${root} commit --allow-empty -m "concurrent landing"; fi\necho ok\n`,
  );
  const restore = fakePi(APPROVE_PI);
  try {
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor } = makeWiring(states);

    const results = await landBatch(
      makeBatchCtx(root),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.deepEqual(
      results.map((r) => r.result),
      ["merge_blocked", "merge_blocked"],
      "a blocked ff leaves every approved change for recovery",
    );
    assert.notEqual(sh(root, "git", "rev-parse", "main"), shas.beta!, "the stack did not land");
    assert.equal(
      sh(root, "git", "rev-list", "--count", `${mainBefore}..main`),
      "1",
      "only the concurrent landing is new on main",
    );
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the head keeps its ref");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!, "and the stacked change keeps its");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 0, "nothing merged");
  } finally {
    restore();
  }
});

test("a one-change batch is the single landing path: one ff, one merged event", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas } = await batchPinnedFixture(["alpha"]);
    const states = { alpha: freshLoopState("alpha") };
    const { wiringFor } = makeWiring(states);

    const results = await landBatch(makeBatchCtx(root), [request(shas.alpha!, { role: "alpha" })], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed"]);
    assert.equal(sh(root, "git", "rev-parse", "main"), shas.alpha!, "landed through landChange, exactly as today");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 1);
  } finally {
    restore();
  }
});

test("a red stack check abandons to one-at-a-time and both changes still land", async () => {
  const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
  // The check fails on its THIRD run only: the two gate pre-checks pass, the batch's one
  // shared check fails, and the fallback's in-lock re-check passes again.
  const count = path.join(root, ".checkcount");
  declareCheck(
    root,
    `#!/bin/sh\nc=$(cat ${count} 2>/dev/null || echo 0)\nn=$((c+1))\necho "$n" > ${count}\n[ "$n" = "3" ] && { echo "planted batch failure"; exit 1; }\necho ok\n`,
  );
  const restore = fakePi(APPROVE_PI);
  try {
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor, folded } = makeWiring(states);

    const results = await landBatch(
      makeBatchCtx(root),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "the fallback lands both one at a time");
    const checks = readEvents(root).filter((e) => e.type === "build_check");
    assert.deepEqual(
      checks.map((e) => [e.scope, e.status]),
      [
        ["gate", "passed"],
        ["gate", "passed"],
        ["batch", "failed"],
        ["gate", "passed"],
      ],
      "two gate pre-checks, the red batch check, and the fallback's re-check on the synced tree",
    );
    assert.equal(folded.get("alpha")!.length, 1, "no reviewer re-run for alpha: its rebase is a no-op, the gate short-circuits");
    assert.equal(folded.get("beta")!.length, 2, "beta's fallback re-lands on the moved main, so the gate reviews the synced tree");
  } finally {
    restore();
  }
});

test("a cherry-pick conflict abandons to one-at-a-time and the conflicting change resolves as a single landing", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    // Both roles rewrite the same line: the cherry-pick of the second onto the first conflicts.
    const { root, shas } = await batchPinnedFixture(
      ["alpha", "beta"],
      (root, role) => fs.writeFileSync(path.join(root, "seed.txt"), `${role}\n`),
    );
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor, calls } = makeWiring(states, (wt) => {
      fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"); // resolve the rebase conflict
    });

    const results = await landBatch(
      makeBatchCtx(root),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "both\n", "the resolution landed on main");
    assert.equal(calls.length, 1, "one resolution run — only the conflicting change needs it");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 2);
    assert.equal(await refSha(root, landingRefName("beta")), null, "the fallback deleted its ref");
  } finally {
    restore();
  }
});

test("a failed gate stops the batch: the later requests stay unattempted with entry and ref intact", async () => {
  const restore = fakePi(
    reviewerPi("I think this is fine."),
  );
  try {
    const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor, folded } = makeWiring(states);

    const results = await landBatch(
      makeBatchCtx(root),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.equal(results[0]!.result, "review_error", "the failed gate is terminal for its request");
    assert.equal(results[1]!.result, undefined, "the second request was never attempted — the drain keeps its entry");
    assert.ok(states.alpha.lastError?.startsWith("review failed:"), `lastError names the failure: ${states.alpha.lastError}`);
    assert.equal(folded.get("beta"), undefined, "no reviewer run for the unattempted request");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "under the strike cap the head's ref stays");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!, "the unattempted request's ref stays");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
  } finally {
    restore();
  }
});

test("a lost pin degrades its request to a terminal error instead of starving the queue", async () => {
  // The queue entry can outlive its commit (a crash between pin and drop, or an outside gc):
  // its sha no longer resolves, so Phase A's checkout throws. The batch must degrade that
  // request to a terminal "error" — the drain's write-back then drops its entry and the next
  // healthy head advances — rather than let the throw escape: the drain's catch keeps EVERY
  // entry, so a permanently uncheckable head would re-fail on every poll and starve the queue
  // forever. The single path's landQueuedEntry catch-all already self-heals this exact case.
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
    sh(root, "git", "update-ref", "-d", landingRefName("alpha")); // the pin is gone
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor, folded } = makeWiring(states);
    const lost = "0".repeat(40); // a sha git cannot check out

    const results = await landBatch(
      makeBatchCtx(root),
      [request(lost, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.equal(results[0]!.result, "error", "the uncheckable pin is terminal, so the drain drops its entry");
    assert.ok(states.alpha.lastError, "the git failure is recorded where the next tick's prompt reads it");
    assert.equal(results[1]!.result, undefined, "the healthy sibling stays queued with its ref intact");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!);
    assert.equal(folded.get("beta"), undefined, "no reviewer run for the unattempted request");
    assert.equal(folded.get("alpha"), undefined, "and none for the uncheckable pin");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 0);

    // The next drain now sees the healthy head alone and lands it — the queue advanced.
    const next = await landBatch(makeBatchCtx(root), [request(shas.beta!, { role: "beta" })], wiringFor);
    assert.deepEqual(next.map((r) => r.result), ["changed"], "the previously starved head lands on the next drain");
    assert.equal(await refSha(root, landingRefName("beta")), null, "and its ref is gone after landing");
  } finally {
    restore();
  }
});

test("an abort mid-batch routes every request without a terminal outcome to aborted, refs kept", async () => {
  const restore = fakePi(`exec sleep 30`); // never reached: the signal is already aborted
  try {
    const { root, shas } = await batchPinnedFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const states = { alpha: freshLoopState("alpha"), beta: freshLoopState("beta") };
    const { wiringFor, folded } = makeWiring(states);
    const controller = new AbortController();
    controller.abort(); // a shutdown (or a user stop for any batched role) before the batch starts

    const results = await landBatch(
      makeBatchCtx(root, undefined, controller),
      [request(shas.alpha!, { role: "alpha" }), request(shas.beta!, { role: "beta" })],
      wiringFor,
    );

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"]);
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "an abort keeps the refs for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!);
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(folded.get("beta"), undefined, "no reviewer spend on the unattempted request");
    assert.ok((folded.get("alpha") ?? []).length <= 1, "the head's killed run at most");
  } finally {
    restore();
  }
});
