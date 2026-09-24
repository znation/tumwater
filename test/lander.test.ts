import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  landChange,
  type LandRequest,
  type LanderContext,
} from "../src/lander.js";
import {
  BATCH_RESTACK_ATTEMPTS,
  landBatch,
  PHASE_A_CONCURRENCY,
  type BatchContext,
  type BatchRoleWiring,
} from "../src/land-batch.js";
import { aheadOfMain, refSha, setRef } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { eventsLogPath, landingRefName, landingStatePath, landWorktreePath, statePath } from "../src/paths.js";
import { readLandingMarker, setLandingChangeStatus, writeBatchLandingMarker } from "../src/landing-slot.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { REVIEW_FAILURE_LIMIT } from "../src/review.js";
import { readEvents } from "../src/events.js";
import { noteGreenBaseline } from "../src/main-baseline.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import type { LoopState, PiRunResult, TickResult } from "../src/types.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir, waitForFile } from "./util.js";

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
// A gate pre-check failure that survives its one re-run is attributed through main's own
// baseline verdict (src/review.ts), and the landing's ref lifecycle follows the two outcomes: a
// green main's reject deletes the pin, a red main's no-strike failure keeps it for the next
// re-land. Neither spends a pi run. makeRepo's seed commit is byte-identical across tests run in
// the same second and the baseline cache is keyed by SHA, so the red case moves main to a commit
// of its own before asking.

test("a failing pre-check on a green main rejects the landing and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  noteGreenBaseline(sh(root, "git", "rev-parse", "main")); // what the last landing left behind
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\n${reviewerPi("VERDICT: approve")}`);
  try {
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);
    assert.equal(await landChange(ctx, request(sha)), "rejected");
    assert.equal(await refSha(root, REF), null, "rejected: the pin is gone");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
    assert.equal(folded.length, 0, "nothing to fold");
    assert.equal(state.lastReview?.verdict, "reject");
  } finally {
    restore();
  }
});

test("a failing pre-check on a red main keeps the pin, records no rejection, and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  const unique = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, unique), "main moved\n");
  sh(root, "git", "add", unique);
  sh(root, "git", "commit", "-m", "main moves on its own");
  const mainSha = sh(root, "git", "rev-parse", "main");
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\n${reviewerPi("VERDICT: approve")}`);
  try {
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);
    assert.equal(await landChange(ctx, request(sha)), "main_red", "not a reviewer failure");
    const pinned = await refSha(root, REF);
    assert.ok(pinned, "the pin survives a red main");
    // The pre-gate sync rebased the pin onto the moved main; the gate left it exactly there.
    assert.equal(sh(root, "git", "rev-parse", `${pinned}~1`), mainSha);
    assert.ok(sh(root, "git", "show", `${pinned}:seed.txt`).includes("the work"), "the pin still names the work");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.equal(folded.length, 0);
    assert.equal(state.unreviewFailures ?? 0, 0, "no strike");
    assert.equal(state.lastReview?.verdict, "failed", "no rejection recorded against the author");
    assert.match(state.lastError ?? "", /^gate check failed: main [0-9a-f]+ is red — not this change's failure$/);
    assert.ok(!readEvents(root).some((e) => e.type === "review_rejected"));
  } finally {
    restore();
  }
});

/** Shell that numbers this check run into `$n`, atomically: `mkdir` either creates
 * `<base>.<n>` or fails, so two gate pre-checks running at once (Phase A runs gates
 * concurrently) can never both read the same count the way a read-increment-write counter
 * file does. Runs number 1, 2, … in start order. */
const checkRunNumber = (base: string): string =>
  `n=1\nwhile ! mkdir '${base}'.$n 2>/dev/null; do n=$((n+1)); done\n`;

// ── landBatch (merge queue 5/5) ─────────────────────────────────────────────────────────
// The batch lander: N roles' queued landings stacked into one worktree, one shared build
// check, one fast-forward. The reviewer runs are real pi subprocesses behind the fake shim;
// the fallback landings' conflict resolver goes through the wiring's runPi stub.

/** A repo where every listed role has a single-commit pin based on main — the queue shape
 * the batch drain reads. One separate file per role by default so cherry-picks apply
 * cleanly; `edit` overrides the per-role change (the conflict test rewrites one line). */
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

/** A batch test's whole fixture in one call: one pinned change per role (the queue shape the
 * drain reads), a live state per role, and the per-role wiring to land them — the setup every
 * batch test below otherwise spells out as batchPinnedFixture + states + makeWiring. `edit`
 * and `resolve` pass through to the fixture and wiring. */
async function batchFixture<R extends string>(
  roles: R[],
  opts: { edit?: (root: string, role: string) => void; resolve?: (wt: string) => void } = {},
): Promise<{
  root: string;
  shas: Record<string, string>;
  states: Record<R, LoopState>;
  wiringFor: (role: string) => BatchRoleWiring;
  folded: Map<string, PiRunResult[]>;
  calls: PiCall[];
}> {
  const { root, shas } = await batchPinnedFixture(roles, opts.edit);
  const states = Object.fromEntries(roles.map((role) => [role, freshLoopState(role)])) as Record<R, LoopState>;
  return { root, shas, states, ...makeWiring(states, opts.resolve) };
}

/** The standard batch drain over a fixture's pinned changes, in `roles` order — the
 * makeBatchCtx + one-request-per-role call every batch test otherwise spells out. */
function runBatch(
  root: string,
  shas: Record<string, string>,
  roles: string[],
  wiringFor: (role: string) => BatchRoleWiring,
  controller?: AbortController,
) {
  return landBatch(
    makeBatchCtx(root, undefined, controller),
    roles.map((role) => request(shas[role]!, { role })),
    wiringFor,
  );
}

// Phase A runs its gates concurrently, so a batch test that cares WHICH gate does what keys
// its reviewer on the change under review, and one that cares about order waits on an event
// rather than guessing a sleep long enough for a loaded host.

/** The shell that prints `reply` as a review run's one assistant turn. */
const replyLine = (reply: string): string => `printf '%s\\n' '${assistantLine(reply)}'`;

/** A reviewer shim whose review run behaves per change: pi's cwd is the gate's
 * `_land-<role>` worktree, so `$PWD` names the change under review. `byRole` maps a role to
 * the shell its review run executes; every other role runs `otherwise` (approve at once). */
function reviewerByRole(byRole: Record<string, string>, otherwise = replyLine("VERDICT: approve")): string {
  return [
    `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
    `case "$PWD" in`,
    ...Object.entries(byRole).map(([role, body]) => `*_land-${role}) ${body} ;;`),
    `*) ${otherwise} ;;`,
    `esac; exit 0;;`,
    `esac; done`,
  ].join("\n");
}

/** Shell that holds a review run until the events log records `loop`'s `type` event — bounded
 * at ~30 s, so a regression fails the assertions instead of hanging the suite. */
const awaitEvent = (root: string, loop: string, type: string): string =>
  `i=0; until grep -q '"loop":"${loop}","type":"${type}"' '${eventsLogPath(root)}' 2>/dev/null || [ $i -ge 300 ]; do sleep 0.1; i=$((i+1)); done; `;

/** A review run that records how many review runs are in flight as it starts (one line per
 * run in `<dir>/samples.log`), holds `seconds`, then approves. */
const countedReview = (dir: string, seconds: number): string =>
  `d='${dir}/runs'; mkdir -p "$d"; f=$(mktemp "$d/run.XXXXXX"); ` +
  `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${dir}/samples.log'; ` +
  `sleep ${seconds}; rm -f "$f"; ${replyLine("VERDICT: approve")}`;

function readSamples(dir: string): number[] {
  return fs.readFileSync(path.join(dir, "samples.log"), "utf8").trim().split("\n").map(Number);
}

test("an all-rejected batch returns a defined result for every request without throwing", async () => {
  // The review re-audit found this exact shape crashing: |S| == 0 made the lander index the
  // empty stack and throw, and the drain's catch kept every entry — a queue leak. Now the
  // batch simply returns: every request terminal, nothing to land, refs gone.
  const restore = fakePi(
    reviewerPi("VERDICT: reject\n1. no"),
  );
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

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
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

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

test("a batch stacks every commit of a multi-commit pin, not its head alone", async () => {
  // The regression this pins: picking a pin's single head would land only its last diff and
  // orphan the work beneath it — the stack must pick the whole range from main to that head.
  const { root, shas, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
  sh(root, "git", "checkout", "--detach", shas.alpha!);
  fs.writeFileSync(path.join(root, "more.txt"), "more by alpha\n");
  sh(root, "git", "add", "more.txt");
  sh(root, "git", "commit", "-m", "more alpha work");
  shas.alpha = sh(root, "git", "rev-parse", "HEAD");
  await setRef(root, landingRefName("alpha"), shas.alpha);
  sh(root, "git", "checkout", "main");
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);
    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    // THREE commits on main: both of alpha's, then beta's — none orphaned.
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "3");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"), "the work beneath the head landed");
    assert.ok(sh(root, "git", "show", "main:more.txt").includes("more by alpha"));
    assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
    assert.equal(await refSha(root, landingRefName("alpha")), null);
    assert.equal(await refSha(root, landingRefName("beta")), null);
    assert.equal(folded.get("alpha")!.length, 1);
    assert.equal(folded.get("beta")!.length, 1);
  } finally {
    restore();
  }
});

// ── A fast-forward lost to a moved main: re-stack, not merge_blocked (BUGS.md 2026-09-23) ──
// Main moves while the batch's shared check runs — the window is the whole check, and a role's
// in-tick leftover-recovery landing still writes main outside the land queue. The stack was
// assembled on the old tip, so its single ff fails; the batch must re-stack on the new tip
// and go round again rather than send every approved change back through recovery.

/** A counting build check: `$n` is the invocation's 1-based number (checkRunNumber — the two
 * Phase A gate pre-checks run concurrently) — runs 1 and 2 are the two Phase A gate
 * pre-checks, run 3 is the batch's first shared check — and `body` runs before the check
 * passes (or fails, if `body` exits nonzero). */
function countingCheck(root: string, body: string): void {
  const count = path.join(root, ".checkcount");
  declareCheck(root, `#!/bin/sh\n${checkRunNumber(count)}${body}\necho ok\n`);
}

/** Shell that lands one commit on main from inside a running check — the primary checkout
 * sits on main, so a commit there is main moving under the batch. `line` is single-quoted
 * into the script, so it must not contain a quote itself. */
const commitOnMain = (root: string, file: string, line: string): string =>
  `echo '${line}' >> ${path.join(root, file)} && git -C ${root} add ${file} && git -C ${root} commit -q -m 'concurrent ${file}'`;

/** Shell that parks the check until the test drops `release` (bounded at 60 s, so a broken
 * test can never hang the suite), after first announcing itself through `started`. */
const parkUntil = (started: string, release: string): string =>
  `touch ${started}; i=0; while [ ! -f ${release} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`;

const batchChecks = (root: string) =>
  readEvents(root).filter((e) => e.type === "build_check" && e.scope === "batch");

test("a batch whose base main moves mid-check through a tick-path landing re-stacks and lands", async () => {
  // The Repro exactly: a slow batch check, and while it runs another role's leftover recovery
  // lands through the tick path's landChange. The ff loses, the batch re-stacks on the new tip,
  // re-checks it (the racer is code, not docs), and lands both changes on top of the racer.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"]);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const started = path.join(root, ".batch-started");
  const release = path.join(root, ".batch-release");
  countingCheck(root, `if [ "$n" = "3" ]; then ${parkUntil(started, release)}; fi`);
  const restore = fakePi(APPROVE_PI);
  try {
    const batch = runBatch(root, shas, ["alpha", "beta"], wiringFor);
    await waitForFile(started); // the batch's shared check is running on the old tip
    const { ctx } = makeCtx(root, freshLoopState("gamma"));
    assert.equal(await landChange(ctx, request(shas.gamma!, { role: "gamma" })), "changed", "the racer landed");
    fs.writeFileSync(release, "");

    const results = await batch;

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "re-stacked, not merge_blocked");
    assert.deepEqual(
      sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by beta", "work by alpha", "work by gamma"],
      "the stack landed on top of the racer, in queue order",
    );
    const merged = readEvents(root).filter((e) => e.type === "merged");
    assert.deepEqual(merged.map((e) => e.loop), ["gamma", "alpha", "beta"]);
    assert.equal(merged[2]!.commit, sh(root, "git", "rev-parse", "main"), "the re-stacked tip is main's head");
    assert.deepEqual(
      batchChecks(root).map((e) => e.status),
      ["passed", "passed"],
      "the first check, then one re-check of the re-stacked tree",
    );
    assert.equal(await refSha(root, landingRefName("alpha")), null, "landed: the head's ref is gone");
    assert.equal(await refSha(root, landingRefName("beta")), null, "and the stacked change's");
  } finally {
    fs.writeFileSync(release, ""); // never leave the parked check waiting out its bound
    restore();
  }
});

test("a fast-forward lost to a doc-only commit re-stacks without a second batch check", async () => {
  // The exempt case: the tree the re-stack builds is the checked tree plus doc-only bytes —
  // the gate's own exemption test says that cannot break the build, so no second check runs.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  countingCheck(root, `if [ "$n" = "3" ]; then ${commitOnMain(root, "NOTES.md", "a doc edit")}; fi`);
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.deepEqual(
      sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by beta", "work by alpha", "concurrent NOTES.md"],
    );
    assert.equal(batchChecks(root).length, 1, "the doc-only re-stack reused the first check's verdict");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 2);
  } finally {
    restore();
  }
});

test("a batch that loses the fast-forward race on every attempt keeps every ref as merge_blocked", async () => {
  // Main moves (with code) during EVERY batch check — the first and each re-stack's re-check.
  // Past BATCH_RESTACK_ATTEMPTS the batch gives up to leftover recovery: every approved change
  // keeps its ref and nothing merges.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  countingCheck(root, `if [ "$n" -ge 3 ]; then ${commitOnMain(root, "race.txt", "main moved")}; fi`);
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["merge_blocked", "merge_blocked"]);
    assert.equal(batchChecks(root).length, 1 + BATCH_RESTACK_ATTEMPTS, "the first check plus one per re-stack");
    assert.equal(
      sh(root, "git", "rev-list", "--count", `${mainBefore}..main`),
      String(1 + BATCH_RESTACK_ATTEMPTS),
      "only the concurrent commits are new on main",
    );
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the head keeps its ref");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!, "and the stacked change keeps its");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 0, "nothing merged");
  } finally {
    restore();
  }
});

test("a re-stack that conflicts with what main gained falls back to one-at-a-time", async () => {
  // Main gains a beta.txt of its own mid-check: the re-stack's pick of beta's change conflicts,
  // so the batch abandons to the per-change path exactly as a first-assembly conflict does —
  // alpha lands singly, beta resolves through the single path's conflict resolver.
  const { root, shas, wiringFor, calls } = await batchFixture(["alpha", "beta"], {
    resolve: (wt) => fs.writeFileSync(path.join(wt, "beta.txt"), "both\n"),
  });
  countingCheck(root, `if [ "$n" = "3" ]; then ${commitOnMain(root, "beta.txt", "main beta")}; fi`);
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "both landed one at a time");
    assert.equal(batchChecks(root).length, 1, "the conflicting re-stack never reached a second batch check");
    assert.equal(calls.length, 1, "one resolution run, for the conflicting change");
    assert.equal(sh(root, "git", "show", "main:beta.txt"), "both", "the resolution landed on main");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"));
    assert.equal(await refSha(root, landingRefName("beta")), null, "the fallback deleted its ref");
  } finally {
    restore();
  }
});

test("an abort between re-stack attempts stops the batch: aborted, refs kept, nothing lands", async () => {
  // A shutdown that arrives while the first batch check runs must not start a re-stack (and
  // its possible second full check) after the lost race.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const started = path.join(root, ".batch-started");
  const release = path.join(root, ".batch-release");
  countingCheck(
    root,
    `if [ "$n" = "3" ]; then ${commitOnMain(root, "race.txt", "main moved")}; ${parkUntil(started, release)}; fi`,
  );
  const restore = fakePi(APPROVE_PI);
  try {
    const controller = new AbortController();
    const batch = runBatch(root, shas, ["alpha", "beta"], wiringFor, controller);
    await waitForFile(started);
    const mainMid = sh(root, "git", "rev-parse", "main");
    controller.abort();
    fs.writeFileSync(release, "");

    const results = await batch;

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"]);
    assert.equal(batchChecks(root).length, 1, "no re-stack check after the abort");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainMid, "nothing landed after the racer");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "an abort keeps the refs for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!);
  } finally {
    fs.writeFileSync(release, "");
    restore();
  }
});

test("a one-change batch is the single landing path: one ff, one merged event", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha"]);

    const results = await runBatch(root, shas, ["alpha"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed"]);
    assert.equal(sh(root, "git", "rev-parse", "main"), shas.alpha!, "landed through landChange, exactly as today");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 1);
  } finally {
    restore();
  }
});

test("a red stack check that does not reproduce bisects: both changes land, neither is re-reviewed or rejected", async () => {
  const { root, shas, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
  // The check fails on its THIRD run only: the two gate pre-checks pass, the batch's one
  // shared check fails, and every bisect step's check passes again — a flake. One red run
  // never rejects a change: beta's own prefix is checked, not inferred red.
  const count = path.join(root, ".checkcount");
  declareCheck(
    root,
    `#!/bin/sh\n${checkRunNumber(count)}[ "$n" = "3" ] && { echo "planted batch failure"; exit 1; }\necho ok\n`,
  );
  const restore = fakePi(APPROVE_PI);
  try {

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "each prefix lands on its own green check");
    const checks = readEvents(root).filter((e) => e.type === "build_check");
    assert.deepEqual(
      checks.map((e) => [e.scope, e.status]),
      [
        ["gate", "passed"],
        ["gate", "passed"],
        ["batch", "failed"],
        ["batch", "passed"],
        ["batch", "passed"],
      ],
      "two gate pre-checks, the red stack check, then alpha's prefix and beta on top of it",
    );
    assert.equal(folded.get("alpha")!.length, 1, "no reviewer re-run for alpha: its prefix lands its approved head");
    assert.equal(folded.get("beta")!.length, 1, "nor for beta");
    assert.equal(readEvents(root).filter((e) => e.type === "review_rejected").length, 0, "nobody rejected");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 2);
  } finally {
    restore();
  }
});

// ── A red stack check lands the largest passing prefix (PLANS.md land-queue 3d) ─────────
// Not N more gates: the batch bisects in queue order, lands each green prefix with one ff,
// and attributes the one change a check ran red over alone through main's own baseline.

/** A check that passes its first `gates` runs (the Phase-A gate pre-checks, which all start
 * before any batch check) and afterwards runs `after` — which sees `$n`, and the invoking
 * worktree as `$INIT_CWD` (npm runs the script at the package root). */
function checkAfterGates(root: string, gates: number, after: string): void {
  const count = path.join(root, ".checkcount");
  declareCheck(root, `#!/bin/sh\n${checkRunNumber(count)}if [ "$n" -gt ${gates} ]; then ${after}; fi\necho ok\n`);
}

test("a stack of three whose second change breaks the check lands the first, rejects the second, re-queues the third", async () => {
  const roles = ["alpha", "beta", "gamma"];
  const { root, shas, states, wiringFor, folded } = await batchFixture(roles);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  // beta breaks the suite — but only on the stacked tree (its own gate passed: an
  // interaction the stack check exists to catch).
  checkAfterGates(root, 3, `[ -f "$INIT_CWD/beta.txt" ] && { echo "planted failure: beta breaks the suite"; exit 1; }`);
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "rejected", undefined]);
    assert.deepEqual(
      batchChecks(root).map((e) => e.status),
      ["failed", "passed", "failed"],
      "three batch checks: the whole stack, alpha's prefix, then beta alone on top of it",
    );
    assert.deepEqual(
      sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by alpha"],
      "only the passing prefix landed",
    );
    // beta: rejected deterministically with the check's own output, no pi run.
    assert.equal(states.beta!.lastReview?.verdict, "reject");
    assert.match(states.beta!.lastReview!.reasons[0]!, /^build check failed \(.*\): planted failure: beta breaks the suite$/);
    assert.equal(states.beta!.unreviewFailures, 0);
    const rejected = readEvents(root).filter((e) => e.type === "review_rejected");
    assert.deepEqual(rejected.map((e) => e.loop), ["beta"], "one review_rejected, for beta");
    assert.equal(await refSha(root, landingRefName("beta")), null, "the rejection deleted beta's ref");
    // gamma: unattempted — entry and ref kept for the next drain.
    assert.equal(await refSha(root, landingRefName("gamma")), shas.gamma!, "gamma keeps its pin for the next drain");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "alpha landed: its ref is gone");
    // No model run past Phase A, and main's baseline was a cache hit (alpha's prefix seeded it).
    assert.equal(readEvents(root).filter((e) => e.type === "review_start").length, 3, "one review per change, Phase A only");
    for (const role of roles) assert.equal(folded.get(role)!.length, 1, `${role}: only its Phase-A reviewer run`);
    assert.equal(
      readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline").length,
      0,
      "the prefix landing seeded main green, so attribution ran no baseline check",
    );
  } finally {
    restore();
  }
});

test("a stack whose every change passes still takes exactly one batch check", async () => {
  const roles = ["alpha", "beta", "gamma"];
  const { root, shas, wiringFor } = await batchFixture(roles);
  checkAfterGates(root, 3, "true");
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed", "changed"]);
    assert.deepEqual(batchChecks(root).map((e) => e.status), ["passed"], "one check over the whole stack");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 3);
  } finally {
    restore();
  }
});

// The head change fails alone on main's tip, so main's own baseline decides who owns the red:
// a red main keeps the pin (not the author's failure), an unavailable baseline rejects.
for (const baseline of ["red", "unavailable"] as const) {
  test(`a change red alone on a main whose baseline is ${baseline} ${baseline === "red" ? "keeps its pin as main_red" : "is rejected, saying so"}`, async () => {
    const { root, shas, states, wiringFor } = await batchFixture(["alpha", "beta"]);
    // A main tip no other test's cache can know: the baseline check must actually run.
    const tip = advanceMain(root, "main.txt", `${root}\n`);
    // Runs 1-2: the gates. Runs 3-4: the whole stack, then alpha alone — both red. Run 5: main's
    // own baseline, red or broken-toolchain (an environmental skip: no verdict).
    const baselineRun =
      baseline === "red" ? `echo "main is broken too"; exit 1` : `echo "xcrun: error: planted toolchain"; exit 1`;
    checkAfterGates(root, 2, `if [ "$n" -le 4 ]; then echo "planted failure"; exit 1; else ${baselineRun}; fi`);
    const restore = fakePi(APPROVE_PI);
    try {
      const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

      assert.deepEqual(batchChecks(root).map((e) => e.status), ["failed", "failed"]);
      const baselineChecks = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline");
      assert.deepEqual(baselineChecks.map((e) => e.status), [baseline === "red" ? "failed" : "skipped"]);
      assert.equal(sh(root, "git", "rev-parse", "main"), tip, "nothing landed");
      assert.equal(results[1]!.result, undefined, "beta is unattempted: entry and ref kept");
      assert.ok(await refSha(root, landingRefName("beta")));
      if (baseline === "red") {
        assert.equal(results[0]!.result, "main_red");
        assert.ok(await refSha(root, landingRefName("alpha")), "the pin is kept for a re-land once main is green");
        assert.equal(states.alpha.lastReview?.verdict, "approve", "no rejection recorded against the author");
        assert.equal(states.alpha.unreviewFailures, 0, "and no strike");
        assert.match(states.alpha.lastError ?? "", /main \S+ is red — not this change's failure/);
        assert.equal(readEvents(root).filter((e) => e.type === "review_rejected").length, 0);
      } else {
        assert.equal(results[0]!.result, "rejected");
        assert.equal(await refSha(root, landingRefName("alpha")), null);
        const reasons = states.alpha.lastReview!.reasons;
        assert.match(reasons[0]!, /: planted failure$/);
        assert.match(reasons.at(-1)!, /baseline was unavailable \(its check was skipped: toolchain\)/);
      }
    } finally {
      restore();
    }
  });
}

/** Advance main past the fixture's pins with one commit touching only `file` — the "pins
 * based on an older main" shape: the queue's pins were taken before other landings moved
 * main. Only `file` is staged, so an untracked declared check at the root stays untracked. */
function advanceMain(root: string, file: string, content: string): string {
  fs.writeFileSync(path.join(root, file), content);
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", `main moves: ${file}`);
  return sh(root, "git", "rev-parse", "main").trim();
}

test("an un-assemblable stack's fallback lands pins from an older main with one review per change, not two", async () => {
  // BUGS.md 2026-09-23 (the Repro): the fallback's landChange rebased each approved head
  // before its gate — main had moved (the entries before it landed, and here main was ahead
  // of every pin to begin with) — so the exact-sha approved short-circuit never hit and each
  // change paid a second full gate: the reviewer count ended at 2N. It must end at N. (A red
  // stack check bisects instead; a cherry-pick conflict is what abandons to the fallback.)
  const { root, shas, wiringFor, folded } = await batchFixture(["alpha", "beta"], {
    edit: (root, role) => {
      fs.writeFileSync(path.join(root, `${role}.txt`), `work by ${role}\n`);
      fs.writeFileSync(path.join(root, "shared.txt"), `${role}\n`); // the stack's pick of beta conflicts
    },
    resolve: (wt) => fs.writeFileSync(path.join(wt, "shared.txt"), "both\n"),
  });
  advanceMain(root, "main.txt", "landed after the pins\n");
  declareCheck(root, "#!/bin/sh\necho ok\n");
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "the fallback lands both");
    const reviews = readEvents(root).filter((e) => e.type === "review_start");
    assert.equal(reviews.length, 2, "one model review per change (N), not a second one in the fallback (2N)");
    assert.equal(folded.get("alpha")!.length, 1);
    assert.equal(folded.get("beta")!.length, 1);
    assert.deepEqual(
      readEvents(root)
        .filter((e) => e.type === "build_check")
        .map((e) => [e.scope, e.status]),
      [
        ["gate", "passed"],
        ["gate", "passed"],
        ["landing", "passed"],
      ],
      "no stack check (the assembly conflicted); alpha's approved head lands as judged; beta's resolved rebase onto alpha is re-checked in-lock",
    );
    for (const f of ["main.txt", "alpha.txt", "beta.txt"]) {
      assert.ok(fs.existsSync(path.join(root, f)), `main holds ${f}`);
    }
  } finally {
    restore();
  }
});

test("Phase A reviews each pin rebased onto main's current tip, so no reviewer's checkout is behind main", async () => {
  // BUGS.md 2026-09-23: d13cf2e was reviewed as its bare pin, five main commits behind; the
  // reviewer's checks against current main read those commits as the change deleting them
  // and rejected sound work as "reverts landed main work". Phase A must run landChange's
  // pre-gate rebase: every review_start names a synced head, and the reviewer's own checkout
  // contains main's tip.
  const rec = path.join(tmpdir("batch-rec-"), "seen");
  const restore = fakePi(
    `if git merge-base --is-ancestor main HEAD; then echo synced >> ${rec}; else echo behind >> ${rec}; fi\n` +
      APPROVE_PI,
  );
  try {
    const { root, shas, states, wiringFor } = await batchFixture(["alpha", "beta"]);
    const mainTip = advanceMain(root, "main.txt", "landed after the pins\n");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.deepEqual(fs.readFileSync(rec, "utf8").trim().split("\n"), ["synced", "synced"], "no reviewer sat behind main");
    // Keyed by role: the two gates run concurrently, so their review_start order is a race.
    const starts = readEvents(root).filter((e) => e.type === "review_start");
    assert.equal(starts.length, 2);
    const heads = new Map(starts.map((e) => [e.loop, String(e.head)]));
    for (const role of ["alpha", "beta"] as const) {
      const head = heads.get(role)!;
      assert.notEqual(head, shas[role], `${role} was reviewed rebased, not as its stale pin`);
      assert.equal(sh(root, "git", "rev-parse", `${head}~1`).trim(), mainTip, `${role} sits directly on main's tip`);
      assert.equal(states[role].lastApprovedHead, head, "the verdict names the head it judged");
    }
    assert.ok(fs.existsSync(path.join(root, "main.txt")), "main's own commit survived the landing");
  } finally {
    restore();
  }
});

test("a Phase-A rebase conflict reviews the bare pin and the fallback's resolver lands it, like landChange", async () => {
  // landChange's rule for a pin whose pre-gate rebase conflicts: rebaseOntoMain aborts and
  // restores the pin, the gate reviews the pinned tree, and mergeToMain's resolver lands it.
  // Phase A must follow the same rule — and the fallback, landing an approved head, must
  // neither re-review the resolved change nor the one behind it.
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas, wiringFor, calls } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) =>
        role === "alpha"
          ? fs.writeFileSync(path.join(root, "seed.txt"), "alpha\n")
          : fs.appendFileSync(path.join(root, "beta.txt"), "work by beta\n"),
      resolve: (wt) => fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"),
    });
    advanceMain(root, "seed.txt", "main\n"); // conflicts with alpha's rewrite of the same line

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    // Keyed by role: the two gates run concurrently, so their review_start order is a race.
    const starts = readEvents(root).filter((e) => e.type === "review_start");
    assert.equal(starts.length, 2, "one review per change: the fallback re-reviewed neither");
    const heads = new Map(starts.map((e) => [e.loop, e.head]));
    assert.equal(heads.get("alpha"), shas.alpha!, "alpha's rebase conflicted: its gate judged the restored pin");
    assert.notEqual(heads.get("beta"), shas.beta!, "beta's clean rebase was reviewed synced");
    assert.equal(calls.length, 1, "one resolution run, for alpha's conflict with main");
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "both\n", "the resolution landed");
    assert.ok(fs.existsSync(path.join(root, "beta.txt")), "and beta on top of it");
  } finally {
    restore();
  }
});

test("a cherry-pick conflict abandons to one-at-a-time and the conflicting change resolves as a single landing", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    // Both roles rewrite the same line: the cherry-pick of the second onto the first conflicts.
    const { root, shas, wiringFor, calls } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) => fs.writeFileSync(path.join(root, "seed.txt"), `${role}\n`),
      resolve: (wt) => {
        fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"); // resolve the rebase conflict
      },
    });

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "both\n", "the resolution landed on main");
    assert.equal(calls.length, 1, "one resolution run — only the conflicting change needs it");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 2);
    assert.equal(await refSha(root, landingRefName("beta")), null, "the fallback deleted its ref");
  } finally {
    restore();
  }
});

test("a failed gate stops LAUNCHING: the gate in flight beside it still stacks, the unlaunched stay unattempted", async () => {
  // The concurrent early-stop rule: alpha's reviewer replies without a verdict (an under-cap
  // review_error), beta's gate is already in flight beside it and runs to its approval, and
  // gamma — not yet launched when alpha failed — is never attempted (entry + ref intact).
  // beta's review holds until alpha's failure is on record, so the order is fixed.
  const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta", "gamma"]);
  const restore = fakePi(
    reviewerByRole({
      alpha: replyLine("I think this is fine."),
      beta: `${awaitEvent(root, "alpha", "review_failed")}${replyLine("VERDICT: approve")}`,
    }),
  );
  try {
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, ["alpha", "beta", "gamma"], wiringFor);

    assert.deepEqual(
      results.map((r) => r.result),
      ["review_error", "changed", undefined],
      "the failed gate is terminal, its in-flight neighbour lands, the rest were never launched",
    );
    assert.ok(states.alpha.lastError?.startsWith("review failed:"), `lastError names the failure: ${states.alpha.lastError}`);
    assert.equal(folded.get("gamma"), undefined, "no reviewer run for the unattempted request");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "under the strike cap the head's ref stays");
    assert.equal(await refSha(root, landingRefName("beta")), null, "the in-flight approval landed");
    assert.equal(await refSha(root, landingRefName("gamma")), shas.gamma!, "the unattempted request's ref stays");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "beta alone landed");
    assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
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
  // beta's gate runs beside the lost pin's and outlasts its failed checkout (a lost pin logs
  // no event to wait on; a checkout failure is two git calls, beta holds 3 s after its own).
  const restore = fakePi(reviewerByRole({ beta: `sleep 3; ${replyLine("VERDICT: approve")}` }));
  try {
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta", "gamma"]);
    sh(root, "git", "update-ref", "-d", landingRefName("alpha")); // the pin is gone
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const lost = "0".repeat(40); // a sha git cannot check out

    const results = await landBatch(
      makeBatchCtx(root),
      [
        request(lost, { role: "alpha" }),
        request(shas.beta!, { role: "beta" }),
        request(shas.gamma!, { role: "gamma" }),
      ],
      wiringFor,
    );

    assert.equal(results[0]!.result, "error", "the uncheckable pin is terminal, so the drain drops its entry");
    assert.ok(states.alpha.lastError, "the git failure is recorded where the next tick's prompt reads it");
    assert.equal(results[1]!.result, "changed", "the gate already in flight beside it ran on and landed");
    assert.equal(results[2]!.result, undefined, "the unlaunched sibling stays queued with its ref intact");
    assert.equal(await refSha(root, landingRefName("gamma")), shas.gamma!);
    assert.equal(folded.get("gamma"), undefined, "no reviewer run for the unattempted request");
    assert.equal(folded.get("alpha"), undefined, "and none for the uncheckable pin");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "beta alone landed");
    assert.deepEqual(readEvents(root).filter((e) => e.type === "merged").map((e) => e.loop), ["beta"]);

    // The next drain now sees the healthy head alone and lands it — the queue advanced.
    const next = await runBatch(root, shas, ["gamma"], wiringFor);
    assert.deepEqual(next.map((r) => r.result), ["changed"], "the previously starved head lands on the next drain");
    assert.equal(await refSha(root, landingRefName("gamma")), null, "and its ref is gone after landing");
  } finally {
    restore();
  }
});

test("landBatch reports a rejection to onFinal at its own verdict, while the gate beside it still reviews; an approval never", async () => {
  // BUGS.md 2026-09-23: a final Phase-A verdict must reach the drain the moment it is
  // persisted, so its entry drops and its author ticks while the batch runs on — not after
  // every later review, the stack check, and the ff. An approved change stays unreported: its
  // author must not tick on top of an unlanded change. The two gates run concurrently, so
  // beta's review holds until the report has arrived (a file onFinal drops) — the report
  // provably fires at alpha's own verdict, not when Phase A as a whole is done.
  const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
  const reported = path.join(tmpdir(), "on-final-fired");
  const restore = fakePi(
    reviewerByRole({
      alpha: replyLine("VERDICT: reject\n1. no"),
      beta: `i=0; until [ -f '${reported}' ] || [ $i -ge 300 ]; do sleep 0.1; i=$((i+1)); done; ${replyLine("VERDICT: approve")}`,
    }),
  );
  try {
    const finals: { index: number; result: string; betaReviewed: boolean; saved: string | undefined }[] = [];
    const ctx: BatchContext = {
      ...makeBatchCtx(root),
      onFinal: (index, result) => {
        finals.push({ index, result, betaReviewed: folded.has("beta"), saved: states.alpha.lastReview?.verdict });
        fs.writeFileSync(reported, "");
      },
    };

    const results = await landBatch(ctx, ["alpha", "beta"].map((role) => request(shas[role]!, { role })), wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["rejected", "changed"], "the returned array still carries the rejection");
    assert.deepEqual(
      finals,
      [{ index: 0, result: "rejected", betaReviewed: false, saved: "reject" }],
      "one report, for the rejection only, after its verdict persisted and while beta was still in review",
    );
  } finally {
    restore();
  }
});

test("a strike-cap discard and an uncheckable pin are final for onFinal; an under-cap review_error is not", async () => {
  // Final means nothing later in the batch — or in leftover recovery — can change the
  // outcome. An under-cap review_error keeps its ref for the next tick's recovery, so its
  // author must stay interlocked until the batch's own write-back: ticking now would race
  // that recovery landing against this batch's fast-forward.
  const restore = fakePi(reviewerPi("I think this is fine."));
  try {
    const finalsOf = (root: string) => {
      const finals: { index: number; result: string }[] = [];
      return { finals, ctx: { ...makeBatchCtx(root), onFinal: (index: number, result: string) => finals.push({ index, result }) } };
    };

    const under = await batchFixture(["alpha", "beta"]);
    const u = finalsOf(under.root);
    const underResults = await landBatch(u.ctx, [request(under.shas.alpha!, { role: "alpha" }), request(under.shas.beta!, { role: "beta" })], under.wiringFor);
    assert.equal(underResults[0]!.result, "review_error");
    assert.equal(await refSha(under.root, landingRefName("alpha")), under.shas.alpha!, "under the cap the ref stays");
    assert.deepEqual(u.finals, [], "an under-cap failure is not final: its entry waits for the batch's write-back");

    // Two strikes already against alpha's head: this third verdict-less reply discards it.
    const cap = await batchFixture(["alpha", "beta"]);
    cap.states.alpha.unreviewFailures = REVIEW_FAILURE_LIMIT - 1;
    cap.states.alpha.lastReview = { verdict: "failed", reasons: ["no verdict"], head: cap.shas.alpha!, at: Date.now() };
    const c = finalsOf(cap.root);
    await landBatch(c.ctx, [request(cap.shas.alpha!, { role: "alpha" }), request(cap.shas.beta!, { role: "beta" })], cap.wiringFor);
    assert.equal(await refSha(cap.root, landingRefName("alpha")), null, "the strike cap discarded the ref");
    assert.deepEqual(c.finals, [{ index: 0, result: "review_error" }], "a strike-cap discard is final");

    const lost = await batchFixture(["alpha", "beta"]);
    const l = finalsOf(lost.root);
    let errorOnState: string | undefined;
    const lostCtx: BatchContext = {
      ...l.ctx,
      onFinal: (index, result) => {
        errorOnState = lost.states.alpha.lastError;
        l.ctx.onFinal(index, result);
      },
    };
    await landBatch(lostCtx, [request("0".repeat(40), { role: "alpha" }), request(lost.shas.beta!, { role: "beta" })], lost.wiringFor);
    assert.deepEqual(l.finals, [{ index: 0, result: "error" }], "an uncheckable pin is final");
    assert.ok(errorOnState, "the git failure is on the state before the drain writes it back");
  } finally {
    restore();
  }
});

test("an unlandable first bisect step after a red stack check degrades to error and leaves the rest unattempted", async () => {
  // A red stack check bisects; past the first stack attempt the fallback's throw contract
  // applies to every step: the throw is a terminal error for the change at the step's front,
  // and the batch stops so the rest stay unattempted (entry + ref intact) for the next drain.
  const { root, shas, wiringFor, states } = await batchFixture(["alpha", "beta"]);
  // Runs 1-2 are the gate pre-checks (pass); run 3 is the batch's one shared check: make it
  // fail AND make every later worktree recreate fail, so the bisect's first prefix cannot
  // even be assembled. npm runs the script at the package root, so the
  // worktrees dir is named by absolute path — the test's own sandbox, nothing above it.
  const count = path.join(root, ".checkcount");
  const worktrees = path.join(root, ".tumwater", "worktrees");
  declareCheck(
    root,
    `#!/bin/sh\n${checkRunNumber(count)}if [ "$n" = "3" ]; then rm -rf ${worktrees}; touch ${worktrees}; echo "error TS2345: boom" >&2; exit 1; fi\necho ok\n`,
  );
  const restore = fakePi(APPROVE_PI);
  try {
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.equal(results[0]!.result, "error", "the first fallback entry's throw is a terminal error");
    assert.ok(states.alpha!.lastError, "the failure is visible in the role's state");
    assert.equal(results[1]!.result, undefined, "the rest stay unattempted for the next drain");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "an error keeps its ref for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!, "and so does the unattempted one");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
  } finally {
    restore();
  }
});

test("an abort mid-batch routes every request without a terminal outcome to aborted, refs kept", async () => {
  const restore = fakePi(`exec sleep 30`); // never reached: the signal is already aborted
  try {
    const roles = ["alpha", "beta", "gamma"];
    const { root, shas, wiringFor, folded } = await batchFixture(roles);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    controller.abort(); // a shutdown (or a user stop for any batched role) before the batch starts

    const results = await runBatch(root, shas, roles, wiringFor, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted", "aborted"]);
    for (const role of roles) {
      assert.equal(await refSha(root, landingRefName(role)), shas[role]!, `an abort keeps ${role}'s ref for recovery`);
    }
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    // The first PHASE_A_CONCURRENCY gates launch together; the abort stops the rest.
    assert.equal(folded.get("gamma"), undefined, "no reviewer spend on the unlaunched request");
    assert.ok((folded.get("alpha") ?? []).length <= 1, "the head's killed run at most");
    assert.ok((folded.get("beta") ?? []).length <= 1, "and its concurrent neighbour's");
  } finally {
    restore();
  }
});

test("Phase A runs its gates concurrently, at most PHASE_A_CONCURRENCY at once: three T-long reviews take ~ceil(3/2)·T, not 3T", async () => {
  // BUGS.md 2026-09-23: the batch awaited each gate in turn, so its time in the landing slot
  // was the sum of every review (a 40-minute batch of three) and one slow reviewer held the
  // whole queue. Each review here holds T and records how many reviews were in flight as it
  // started. The wall-clock is read off the harness's own review timeline — first
  // review_start to last review_verdict — and held against the same run's measured review
  // durations, the floor of any one-after-another schedule: the whole landBatch call also
  // pays several seconds of git plumbing on a loaded host, which would swamp a bound on it,
  // while a slowed `sleep` inflates both sides of this comparison alike.
  assert.equal(PHASE_A_CONCURRENCY, 2, "the bound this test's arithmetic assumes");
  const T = 5;
  const dir = tmpdir();
  const restore = fakePi(reviewerByRole({}, countedReview(dir, T)));
  try {
    const roles = ["alpha", "beta", "gamma"];
    const { root, shas, wiringFor } = await batchFixture(roles);

    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed", "changed"]);
    const samples = readSamples(dir);
    assert.equal(samples.length, 3, "one review per change");
    assert.equal(Math.max(...samples), 2, `two reviews overlapped, never three (in flight at each start: ${samples})`);
    const events = readEvents(root);
    const starts = events.filter((e) => e.type === "review_start").map((e) => e.ts);
    const verdicts = events.filter((e) => e.type === "review_verdict");
    const spanMs = Math.max(...verdicts.map((e) => e.ts)) - Math.min(...starts);
    const serialFloorMs = verdicts.reduce((sum, e) => sum + Number(e.durationMs), 0);
    // ~ceil(3/2)·T: the third review waits for a free lane, so the span is at least 2T ...
    assert.ok(spanMs >= 2 * T * 1000, `the concurrency cap held: reviews spanned ${spanMs} ms`);
    // ... and not 3T: one after another, the span could never undercut the reviews' own sum.
    assert.ok(
      spanMs < serialFloorMs,
      `the reviews spanned ${spanMs} ms, no less than their ${serialFloorMs} ms sum — they ran one after another`,
    );
  } finally {
    restore();
  }
});

test("the stack follows queue order however the gates finish: a slow head still lands first", async () => {
  // Concurrent gates finish in any order; stacking must not follow them. The head's review
  // holds until the last change's verdict is on record, so both later changes are judged
  // first — and still land behind it.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"]);
  const restore = fakePi(
    reviewerByRole({ alpha: `${awaitEvent(root, "gamma", "review_verdict")}${replyLine("VERDICT: approve")}` }),
  );
  try {
    const roles = ["alpha", "beta", "gamma"];
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed", "changed"]);
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "review_verdict").map((e) => e.loop),
      ["beta", "gamma", "alpha"],
      "the gates finished out of queue order",
    );
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merged").map((e) => e.loop),
      roles,
      "one merged event per change, in queue order",
    );
    assert.deepEqual(
      sh(root, "git", "log", "--reverse", "--format=%s", `${mainBefore}..main`).trim().split("\n"),
      roles.map((r) => `work by ${r}`),
      "main's history is the queue order",
    );
  } finally {
    restore();
  }
});

// The landing cell's stage (BUGS.md 2026-09-22, re-opened 2026-09-23) through the batch: each
// batched change's own record carries its stage (BUGS.md 2026-09-23 — the marker once named
// only the head), so a change's stage must leave `reviewing` the moment its gate returns —
// otherwise its finished reviewer's last turns sit in the cell, accruing a false `no pi output`
// flag, for as long as the batch reviews and checks the other changes — and one change's gate
// must advance only its own record. The stage sequence below is a single timeline, so these
// runs hold Phase A to one lane with a concurrent-gate permit that never comes (the
// full-semaphore case: the gates then run one after another on the slot's own permit — which
// also pins that it cannot deadlock).
for (const headVerdict of ["reject", "approve"] as const) {
  test(`a batch head ${headVerdict === "reject" ? "rejected" : "approved"} mid-batch leaves reviewing when its gate returns; the stack check names itself`, async () => {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
    // The drain's batch arm opens the marker with a record per batched change and wires the
    // status hook to it.
    writeBatchLandingMarker(
      root,
      ["alpha", "beta"].map((role) => ({ role, sha: shas[role]!, tick: 7, summary: "the work", enqueuedAt: 1 })),
      1,
    );
    const rec = path.join(tmpdir(), "stages");
    // Every record as `role=status/stage`, read from the live marker by whichever run records it.
    const script = path.join(tmpdir(), "stages.mjs");
    fs.writeFileSync(
      script,
      `import fs from "node:fs";\n` +
        `const m = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\n` +
        `process.stdout.write((m.changes ?? []).map((c) => c.role + "=" + c.status + "/" + (c.stage ?? "-")).join(","));\n`,
    );
    const stagesOf = `'${process.execPath}' '${script}' '${landingStatePath(root)}'`;
    const config = { ...defaultConfig(), check: { command: `echo "check:$(${stagesOf})" >> '${rec}'` } };
    const headReply = headVerdict === "reject" ? "VERDICT: reject\n1. no" : "VERDICT: approve";
    const restore = fakePi(
      [
        // Tell the two reviewer runs apart by the session name pi is handed.
        `r=none; for a in "$@"; do case "$a" in tumwater-review-alpha-*) r=alpha ;; tumwater-review-beta-*) r=beta ;; esac; done`,
        `echo "$r:$(${stagesOf})" >> '${rec}'`,
        `if [ "$r" = alpha ]; then printf '%s\\n' '${assistantLine(headReply)}'; else printf '%s\\n' '${assistantLine("VERDICT: approve")}'; fi`,
      ].join("\n"),
    );
    try {
      const results = await landBatch(
        {
          ...makeBatchCtx(root, config),
          gatePermit: () => new Promise<() => void>(() => {}),
          onChangeStatus: (role, status) => setLandingChangeStatus(root, role, status),
        },
        ["alpha", "beta"].map((role) => request(shas[role]!, { role })),
        wiringFor,
      );

      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      // The head's own gate: pre-check, then its reviewer, with beta still waiting. Then beta's
      // gate runs with the head's record already back on merging — beta's transitions advance
      // only beta's own record.
      const alphaAfter = headVerdict === "reject" ? "alpha=done/merging" : "alpha=approved/merging";
      const phaseA = [
        "check:alpha=landing/build-check,beta=waiting/-",
        "alpha:alpha=landing/reviewing,beta=waiting/-",
        `check:${alphaAfter},beta=landing/build-check`,
        `beta:${alphaAfter},beta=landing/reviewing`,
      ];
      if (headVerdict === "reject") {
        assert.deepEqual(results.map((r) => r.result), ["rejected", "changed"]);
        assert.deepEqual(seen, phaseA, "a one-change stack lands through the single path: no stack check");
      } else {
        assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
        assert.deepEqual(
          seen,
          [...phaseA, "check:alpha=landing/build-check,beta=landing/build-check"],
          "the shared stack check runs under build-check on every stacked change",
        );
      }
      const marker = readLandingMarker(root);
      assert.equal(marker?.stage, "merging", "the merge steps close the batch on merging");
      assert.ok(
        marker?.changes?.every((c) => c.status === "done" || c.stage === "merging"),
        `every change still held ends on merging: ${JSON.stringify(marker?.changes)}`,
      );
    } finally {
      restore();
    }
  });
}

// BUGS.md 2026-09-23 — a stopping batch ends at its next step boundary, not only where a pi
// run notices the abort: the restart hand-off aborts a landing that outlived its deadline, and
// steps that spawn no pi (an approved-head short-circuit, the stack's assembly and shared
// check) must not carry on regardless.

test("an aborted batch lands nothing even when every gate would short-circuit on an approved head", async () => {
  const restore = fakePi(`exec sleep 30`); // never reached: no gate starts
  try {
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
    // Both heads already approved (a re-drained batch): every gate would short-circuit with
    // no pi run, so only the between-steps check can see the abort.
    states.alpha.lastApprovedHead = shas.alpha!;
    states.beta.lastApprovedHead = shas.beta!;
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    controller.abort();

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"]);
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the refs survive for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!);
    assert.equal(folded.size, 0, "no gate ran a pi");
  } finally {
    restore();
  }
});

test("an abort after the last gate approved stops the batch before its shared check", async () => {
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  // beta's approval is the last gate to finish: the two run concurrently, so its review
  // holds until alpha's verdict is on record.
  const restore = fakePi(
    reviewerByRole({ beta: `${awaitEvent(root, "alpha", "review_verdict")}${replyLine("VERDICT: approve")}` }),
  );
  try {
    declareCheck(root, "#!/bin/sh\necho ok\n");
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    // The stop lands the moment beta's gate hands back its approval — after every gate, before
    // the stack is assembled and checked.
    const stopAfterBeta = (role: string): BatchRoleWiring => {
      const w = wiringFor(role);
      return role === "beta"
        ? {
            ...w,
            foldUsage: (run) => {
              w.foldUsage(run);
              controller.abort();
            },
          }
        : w;
    };

    const results = await runBatch(root, shas, ["alpha", "beta"], stopAfterBeta, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"], "both approved changes read aborted");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the refs survive for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!);
    const checks = readEvents(root).filter((e) => e.type === "build_check");
    assert.equal(checks.filter((e) => e.scope === "gate").length, 2, "both gates ran their pre-check");
    assert.equal(checks.filter((e) => e.scope === "batch").length, 0, "the shared check never started");
  } finally {
    restore();
  }
});

test("an abort after the gate stops a one-change batch before it lands", async () => {
  // The one-change (and fallback) landings go through landApprovedChange, which runs no gate
  // of its own — only its own abort check sees a stop that arrived after Phase A.
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    const stopAfterGate = (role: string): BatchRoleWiring => {
      const w = wiringFor(role);
      return {
        ...w,
        foldUsage: (run) => {
          w.foldUsage(run);
          controller.abort();
        },
      };
    };

    const results = await runBatch(root, shas, ["alpha"], stopAfterGate, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted"]);
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the ref survives for recovery");
  } finally {
    restore();
  }
});

// The per-change status hook (BUGS.md 2026-09-23): the drain mirrors these reports into the
// 4/5 marker so each batched role's row reads its own change's state — the batch must report
// every step, or a finished change keeps a live `landing` row (or an in-flight one shows none).

/** A reviewer shim that answers per lander worktree: `replies[role]` for the review running
 * in that role's `_land-<role>` worktree, an approval for every other role. */
const perRoleReviewerPi = (replies: Record<string, string>): string =>
  [
    `r='${assistantLine("VERDICT: approve")}'`,
    ...Object.entries(replies).map(([role, reply]) => `case "$PWD" in *_land-${role}) r='${assistantLine(reply)}';; esac`),
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' "$r"; exit 0;; esac; done`,
  ].join("\n");

/** A batch run with the status hook recorded as `role:status`, in call order. Phase A is held
 * to one lane (a concurrent-gate permit that never comes — the full-semaphore case) so the
 * sequence is a single timeline; the concurrent order is the landing-drain row test's. */
async function runBatchRecorded(
  root: string,
  shas: Record<string, string>,
  roles: string[],
  wiringFor: (role: string) => BatchRoleWiring,
): Promise<{ results: Array<TickResult | undefined>; seen: string[] }> {
  const seen: string[] = [];
  const results = await landBatch(
    {
      ...makeBatchCtx(root),
      gatePermit: () => new Promise<() => void>(() => {}),
      onChangeStatus: (role, status) => seen.push(`${role}:${status}`),
    },
    roles.map((role) => request(shas[role]!, { role })),
    wiringFor,
  );
  return { results: results.map((r) => r.result), seen };
}

test("a batch reports each change as it reaches it: a rejection is done at its verdict, the stack lands together", async () => {
  const restore = fakePi(perRoleReviewerPi({ beta: "VERDICT: reject\n1. no" }));
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"]);
    const { results, seen } = await runBatchRecorded(root, shas, ["alpha", "beta", "gamma"], wiringFor);
    assert.deepEqual(results, ["changed", "rejected", "changed"]);
    assert.deepEqual(seen, [
      "alpha:landing", // its gate
      "alpha:approved", // waits for the rest of Phase A
      "beta:landing",
      "beta:done", // rejected: terminal at the verdict, not at the batch's end
      "gamma:landing",
      "gamma:approved",
      "alpha:landing", // the stack's shared check + ff: every stacked change lands together
      "gamma:landing",
      "alpha:done", // landed: the batch is done with them
      "gamma:done",
    ]);
  } finally {
    restore();
  }
});

test("an early stop reports the unattempted change done before the stack lands without it", async () => {
  const restore = fakePi(perRoleReviewerPi({ beta: "I think this is fine." })); // no verdict: review_error
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"]);
    const { results, seen } = await runBatchRecorded(root, shas, ["alpha", "beta", "gamma"], wiringFor);
    assert.deepEqual(results, ["changed", "review_error", undefined]);
    assert.deepEqual(seen, [
      "alpha:landing",
      "alpha:approved",
      "beta:landing",
      "beta:done",
      "gamma:done", // out of this batch (entry + ref kept for the next drain): no `queued in batch`
      "alpha:landing", // the one-change stack: the single path
    ]);
  } finally {
    restore();
  }
});

test("an abandoned stack reports one change landing at a time, the rest awaiting their turn", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    // Both roles rewrite the same line: the stack's cherry-pick conflicts and the batch
    // abandons to one-at-a-time.
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) => fs.writeFileSync(path.join(root, "seed.txt"), `${role}\n`),
      resolve: (wt) => fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"),
    });
    const { results, seen } = await runBatchRecorded(root, shas, ["alpha", "beta"], wiringFor);
    assert.deepEqual(results, ["changed", "changed"]);
    assert.deepEqual(seen, [
      "alpha:landing",
      "alpha:approved",
      "beta:landing",
      "beta:approved",
      "alpha:landing", // the stack attempt
      "beta:landing",
      "alpha:approved", // abandoned: back to awaiting their turn…
      "beta:approved",
      "alpha:landing", // …and each lands alone, then is done
      "alpha:done",
      "beta:landing",
      "beta:done",
    ]);
  } finally {
    restore();
  }
});
