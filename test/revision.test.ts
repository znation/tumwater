import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyRevision, REVISION_LIMIT } from "../src/loop/revision.js";
import { buildRevisionNote, buildRejectedReviewNote } from "../src/gates/gate-prompts.js";
import { vetRequest, type BatchRoleWiring } from "../src/landing/landing-batch.js";
import { refSha, isDirty, setRef } from "../src/git/git.js";
import { rejectedRefName, landingRefName } from "../src/paths.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import { assembleTickPrompt } from "../src/tick/tick-prompt.js";
import { defaultConfig } from "../src/config/config.js";
import { resolveTickVerdict } from "../src/tick/tick-verdict.js";
import { stageTickLanding } from "../src/tick/tick-stage.js";
import { queuedLandings } from "../src/landing/landing-queue.js";
import { settleLandingOutcome } from "../src/landing/landing-pipeline.js";
import { recoverLeftover } from "../src/loop/leftover.js";
import { buildCommitMessage, commitTrailer, stampedSubject } from "../src/git/commit-message.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { NOTHING_TO_DO } from "../src/verdict/reply-contract.js";
import { readmeTemplate } from "../src/brief.js";
import { eventsOfType } from "./log-fixtures.js";
import { fakePi, piRunResult } from "./fake-pi.js";
import { commitIn, initializedWorktree, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { makeCtx, pinnedFixture, request, reviewerPi, ROLE } from "./lander-fixtures.js";

/** Unit coverage for the revise-rejected feature (plans/revise-rejected.md part 1/2): the
 * rejected commit is kept alive under its own ref, re-applied to current main as uncommitted
 * edits on the author's next tick, and dropped/conflicted/exhausted with its own event. */

test("applyRevision re-applies a rejected change onto moved main as uncommitted edits", async () => {
  const root = makeRepo();
  sh(root, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(root, "feature.ts"), "export const feature = true;\n");
  commitIn(root, "the rejected work");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  // main moves in a file the rejected change does not touch.
  fs.writeFileSync(path.join(root, "other.ts"), "export const other = true;\n");
  commitIn(root, "move main");
  const mainSha = sh(root, "git", "rev-parse", "HEAD").trim();

  assert.equal(await applyRevision(root, "main", sha), true);
  assert.equal(fs.readFileSync(path.join(root, "feature.ts"), "utf8"), "export const feature = true;\n");
  assert.equal(await isDirty(root), true, "the re-applied diff is uncommitted");
  assert.equal(sh(root, "git", "rev-parse", "HEAD").trim(), mainSha, "HEAD is still main");
});

test("applyRevision on a conflict resets to clean main and returns false", async () => {
  const root = makeRepo();
  sh(root, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(root, "seed.txt"), "theirs\n");
  commitIn(root, "the rejected work");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  fs.writeFileSync(path.join(root, "seed.txt"), "main version\n");
  commitIn(root, "main moved the same line");

  assert.equal(await applyRevision(root, "main", sha), false);
  assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "main version\n");
  assert.equal(await isDirty(root), false, "the worktree is clean main after a conflict");
});

test("a gate rejection points the rejected ref at the judged head and records round 1", async () => {
  const restore = fakePi(reviewerPi("VERDICT: reject\n1. breaks the rules"));
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w: BatchRoleWiring = {
      state,
      foldUsage: ctx.foldUsage,
      runPi: ctx.runPi,
      runGatePi: (opts) => ctx.runGatePi(opts),
    };
    const verdict = await vetRequest(ctx, request(sha), w);
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision?.round, 1, "a fresh rejection owes one revision");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), state.revision?.sha, "the rejected head stays reachable");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), state.lastReview?.head);
  } finally {
    restore();
  }
});

test("a rejection of the last allowed revision exhausts it and deletes the rejected ref", async () => {
  const restore = fakePi(reviewerPi("VERDICT: reject\n1. still wrong"));
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w: BatchRoleWiring = {
      state,
      foldUsage: ctx.foldUsage,
      runPi: ctx.runPi,
      runGatePi: (opts) => ctx.runGatePi(opts),
    };
    // The rejected ref exists from the earlier rounds; a rejection at the limit clears it.
    await setRef(root, rejectedRefName(ROLE), sha);
    const verdict = await vetRequest(ctx, request(sha, { revisionRound: REVISION_LIMIT }), w);
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision, undefined, "no more rounds are recorded");
    assert.equal(state.lastReview?.exhausted, true, "the next rejected note says it was final");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), null, "the rejected ref is deleted");
    assert.equal(eventsOfType(root, "revision").length, 1, "the exhaustion is logged");
  } finally {
    restore();
  }
});

test("stageTickLanding carries the revision round onto the entry and clears state.revision", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = {
    ...freshLoopState("improve"),
    ticks: 5,
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const ctx = {
    root,
    role: "improve",
    state,
    config: defaultConfig(),
    tickTurns: 4,
    userPrompt: null,
    revisionRound: 1,
    wt,
    finalText: "SUMMARY: revise the change\nWHY: the objection\n",
    piStartedAt: Date.now(),
    flow: null,
    warn: () => {},
    requestSummary: async () => null,
    stageCheck: async () => [],
    requestStageFix: async () => null,
    pinAndReset: async () => true,
    finishAbortedTick: async () => ({ result: "aborted" as const }),
  };

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(state.revision, undefined, "staging consumes the revision");
  assert.equal(queuedLandings(root)[0]?.revisionRound, 1, "the round rides the queued landing");
});

test("a user-request tick that leaves a pending revision stages no round and keeps the revision", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "user-change.ts"), "export const userChange = true;\n");
  const revision = { sha: "a".repeat(40), round: 1, at: Date.now() };
  const state = { ...freshLoopState("improve"), ticks: 5, revision };
  const ctx = {
    root,
    role: "improve",
    state,
    config: defaultConfig(),
    tickTurns: 4,
    userPrompt: "please do the user thing",
    wt,
    finalText: "SUMMARY: do the user thing\nWHY: asked\n",
    piStartedAt: Date.now(),
    flow: null,
    warn: () => {},
    requestSummary: async () => null,
    stageCheck: async () => [],
    requestStageFix: async () => null,
    pinAndReset: async () => true,
    finishAbortedTick: async () => ({ result: "aborted" as const }),
  };

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(queuedLandings(root)[0]?.revisionRound, undefined, "a user change is not a revision");
  assert.deepEqual(state.revision, revision, "the pending revision is left untouched");
});

test("a non-revision dirty nothing-to-do tick does not drop a pending revision", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "user-change.ts"), "export const userChange = true;\n");
  const state = {
    ...freshLoopState("improve"),
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const pending = new PendingPrompt(root, "improve");
  const ctx = {
    root,
    wt,
    role: "improve",
    mainBranch: "main",
    state,
    pending,
    turns: 1,
    userPrompt: "please do the user thing",
    pi: piRunResult({ nothingToDo: true }),
    flow: null,
    warn: () => {},
    merge: async () => "changed" as const,
    finishAbortedTick: async () => ({ result: "aborted" as const }),
  };

  const outcome = await resolveTickVerdict(ctx);

  assert.equal(outcome, null, "the run is fulfillable and staging takes over");
  assert.notEqual(state.revision, undefined, "the pending revision is not dropped");
});

test("a revision tick that declares nothing-to-do drops the change and ends no_change", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = {
    ...freshLoopState("improve"),
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const pending = new PendingPrompt(root, "improve");
  const ctx = {
    root,
    wt,
    role: "improve",
    mainBranch: "main",
    state,
    pending,
    turns: 1,
    userPrompt: null,
    revisionRound: 1,
    pi: piRunResult({ nothingToDo: true }),
    flow: null,
    warn: () => {},
    merge: async () => "changed" as const,
    finishAbortedTick: async () => ({ result: "aborted" as const }),
  };

  const outcome = await resolveTickVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(state.revision, undefined);
  assert.equal(await isDirty(wt), false, "the re-applied diff is reset away");
  assert.equal(eventsOfType(root, "revision").length, 1, "the drop is logged");
});

test("a revision tick that declares nothing-to-do drops the change with a clean worktree", async () => {
  const { root, wt } = await initializedWorktree("improve");
  // A revision tick need not leave the re-applied diff dirty: the cherry-pick can be an empty
  // range, or the author can revert the edits while deciding the change should not exist. The
  // author's NOTHING_TO_DO must still end the rejected change, or every later tick re-applies
  // the same rejected diff and the change loops without ever reaching its limit.
  await setRef(root, rejectedRefName("improve"), "a".repeat(40));
  const state = {
    ...freshLoopState("improve"),
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const pending = new PendingPrompt(root, "improve");
  const ctx = {
    root,
    wt,
    role: "improve",
    mainBranch: "main",
    state,
    pending,
    turns: 1,
    userPrompt: null,
    revisionRound: 1,
    pi: piRunResult({ nothingToDo: true }),
    flow: null,
    warn: () => {},
    merge: async () => "changed" as const,
    finishAbortedTick: async () => ({ result: "aborted" as const }),
  };

  const outcome = await resolveTickVerdict(ctx);

  assert.equal(await isDirty(wt), false, "the worktree is already clean");
  assert.equal(outcome?.result, "no_change");
  assert.equal(state.revision, undefined, "the rejected change is dropped");
  assert.equal(await refSha(root, rejectedRefName("improve")), null, "the rejected ref is deleted");
  assert.equal(eventsOfType(root, "revision").length, 1, "the drop is logged");
});

test("the tick prompt skips the plain rejection note while a revision is due", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), readmeTemplate("proj", "Build a tiny thing.\n"));
  const lastReview = { verdict: "reject", reasons: ["fix the bug"], head: "b".repeat(40), at: Date.now() };
  const withRevision = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: { ...freshLoopState("coverage"), lastReview, revision: { sha: "b".repeat(40), round: 1, at: Date.now() } },
  });
  assert.ok(withRevision);
  assert.doesNotMatch(withRevision.prompt, /previous change was rejected/);

  const withoutRevision = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: { ...freshLoopState("coverage"), lastReview },
  });
  assert.ok(withoutRevision);
  assert.match(withoutRevision.prompt, /previous change was rejected/);
});

test("the director never gets a revision: a rejection leaves no revision state", async () => {
  const restore = fakePi(reviewerPi("VERDICT: reject\n1. no good"));
  try {
    const root = makeRepo();
    sh(root, "git", "checkout", "--detach");
    fs.writeFileSync(path.join(root, "seed.txt"), "director work\n");
    commitIn(root, "director work");
    const sha = sh(root, "git", "rev-parse", "HEAD").trim();
    sh(root, "git", "checkout", "main");
    await setRef(root, landingRefName(DIRECTOR_ROLE), sha);
    const state = freshLoopState(DIRECTOR_ROLE);
    const { ctx } = makeCtx(root, state);
    const w: BatchRoleWiring = {
      state,
      foldUsage: ctx.foldUsage,
      runPi: ctx.runPi,
      runGatePi: (opts) => ctx.runGatePi(opts),
    };
    const verdict = await vetRequest(ctx, request(sha, { role: DIRECTOR_ROLE }), w);
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision, undefined, "the director never revises");
    assert.equal(await refSha(root, rejectedRefName(DIRECTOR_ROLE)), null);
  } finally {
    restore();
  }
});

test("an exhausted rejection's plain note says the rejected diff is gone", () => {
  const note = buildRejectedReviewNote({ reasons: ["still wrong"], at: Date.now(), exhausted: true });
  assert.match(note, /final revision round/);
  assert.match(note, /re-author it from current main/);
  assert.doesNotMatch(buildRejectedReviewNote({ reasons: ["still wrong"] }), /final revision round/);
});

test("buildRevisionNote names the objections, the round, and the nothing-to-do escape", () => {
  const note = buildRevisionNote({ reasons: ["first", "second"] }, 1, REVISION_LIMIT);
  assert.match(note, /revision 1 of 2/);
  assert.match(note, /1\. first/);
  assert.match(note, /2\. second/);
  assert.match(note, new RegExp(NOTHING_TO_DO));
  assert.match(note, /SUMMARY:/);
});

test("leftover recovery rebuilds a revision's round from its commit trailer", async () => {
  const root = makeRepo();
  const role = "improve";
  sh(root, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(root, "feature.ts"), "export const feature = true;\n");
  commitIn(
    root,
    buildCommitMessage(
      stampedSubject(role, "the revision"),
      null,
      commitTrailer(role, 7, 3, 100, undefined, 1),
    ),
  );
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  await setRef(root, landingRefName(role), sha);

  const recovered = await recoverLeftover({ root, role, mainBranch: "main", tick: 8, wt: root });

  assert.equal(recovered?.kind, "enqueued");
  assert.equal(recovered?.kind === "enqueued" ? recovered.entry.revisionRound : undefined, 1);
});

test("a landed revision deletes the rejected ref", async () => {
  const root = makeRepo();
  const role = "improve";
  const rejected = sh(root, "git", "rev-parse", "HEAD").trim();
  assert.equal(await setRef(root, rejectedRefName(role), rejected), true, "the rejected ref is set");
  const state = freshLoopState(role);
  const revision = {
    role,
    sha: "b".repeat(40),
    tick: 3,
    summary: "the revision",
    revisionRound: 2,
    enqueuedAt: Date.now(),
  };

  await settleLandingOutcome(root, revision, state, "changed", 1, { tokens: 0, cost: 0 }, path.join(root, "no-such-queue-file.json"));

  assert.equal(await refSha(root, rejectedRefName(role)), null, "the rejected ref is gone");
});

test("a fresh landing leaves a pending revision's rejected ref alone", async () => {
  const root = makeRepo();
  const role = "improve";
  const rejected = sh(root, "git", "rev-parse", "HEAD").trim();
  assert.equal(await setRef(root, rejectedRefName(role), rejected), true, "the rejected ref is set");
  const state = freshLoopState(role);
  const fresh = { role, sha: "b".repeat(40), tick: 3, summary: "fresh work", enqueuedAt: Date.now() };

  await settleLandingOutcome(root, fresh, state, "changed", 1, { tokens: 0, cost: 0 }, path.join(root, "no-such-queue-file.json"));

  assert.equal(await refSha(root, rejectedRefName(role)), rejected, "the pending revision's ref survives");
});
