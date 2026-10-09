import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyRevision, applyWithConflicts, REVISION_LIMIT } from "../src/loop/revision.js";
import { buildRevisionNote, buildRejectedReviewNote } from "../src/gates/gate-prompts.js";
import { vetRequest } from "../src/landing/landing-batch.js";
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
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { fakePi, piRunResult } from "./fakes/fake-pi.js";
import { commitIn, headSha, initializedWorktree, makeRepo, pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { batchWiring, makeCtx, pinnedFixture, request, reviewerPi, ROLE } from "./fixtures/lander-fixtures.js";
import { makeLoopRunner } from "./fixtures/loop-fixtures.js";
import { initializedRepo } from "./fixtures/repo-fixtures.js";
import { assistantLine } from "./fixtures/pi-events.js";

/** Unit coverage for the revise-rejected feature (plans/revise-rejected.md part 1/2): the
 * rejected commit is kept alive under its own ref, re-applied to current main as uncommitted
 * edits on the author's next tick, and dropped/conflicted/exhausted with its own event. */

/** A makeRepo'd repo with `content` written to `file` and committed off main (detached), the
 * commit's sha returned with main checked out clean again — the unreviewed-commit base the
 * applyRevision/applyWithConflicts and revision/rejection tests stand on. Callers that need
 * main moved after the commit make that commit on main themselves (the conflict cases do).
 * The default `message` is the suite's rejected-work vocabulary. */
function commitOffMain(file: string, content: string, message = "the rejected work"): { root: string; sha: string } {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, file), content), message);
  return { root, sha };
}

test("applyRevision re-applies a rejected change onto moved main as uncommitted edits", async () => {
  const { root, sha } = commitOffMain("feature.ts", "export const feature = true;\n");
  // main moves in a file the rejected change does not touch.
  fs.writeFileSync(path.join(root, "other.ts"), "export const other = true;\n");
  commitIn(root, "move main");
  const mainSha = headSha(root);

  assert.equal(await applyRevision(root, "main", sha), true);
  assert.equal(fs.readFileSync(path.join(root, "feature.ts"), "utf8"), "export const feature = true;\n");
  assert.equal(await isDirty(root), true, "the re-applied diff is uncommitted");
  assert.equal(headSha(root), mainSha, "HEAD is still main");
});

test("applyRevision on a conflict resets to clean main and returns false", async () => {
  const { root, sha } = commitOffMain("seed.txt", "theirs\n");
  fs.writeFileSync(path.join(root, "seed.txt"), "main version\n");
  commitIn(root, "main moved the same line");

  assert.equal(await applyRevision(root, "main", sha), false);
  assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "main version\n");
  assert.equal(await isDirty(root), false, "the worktree is clean main after a conflict");
});

test("applyWithConflicts applies a clean diff as uncommitted edits with no conflicted paths", async () => {
  const { root, sha } = commitOffMain("feature.ts", "export const feature = true;\n", "the handed-back work");
  fs.writeFileSync(path.join(root, "other.ts"), "export const other = true;\n");
  commitIn(root, "move main");

  const result = await applyWithConflicts(root, "main", sha);
  assert.deepEqual(result, { applied: true, conflicted: [] });
  assert.equal(fs.readFileSync(path.join(root, "feature.ts"), "utf8"), "export const feature = true;\n");
  assert.equal(await isDirty(root), true, "the diff is uncommitted");
});

test("applyWithConflicts leaves the conflict markers as ordinary uncommitted edits", async () => {
  const { root, sha } = commitOffMain("seed.txt", "theirs\n", "the handed-back work");
  fs.writeFileSync(path.join(root, "seed.txt"), "main version\n");
  commitIn(root, "main moved the same line");

  const result = await applyWithConflicts(root, "main", sha);
  assert.deepEqual(result, { applied: true, conflicted: ["seed.txt"] });
  const text = fs.readFileSync(path.join(root, "seed.txt"), "utf8");
  assert.match(text, /<<<<<<</);
  assert.match(text, />>>>>>>/);
  assert.equal(await isDirty(root), true, "the marker-bearing file is an ordinary edit");
  // The index is back at HEAD with no unmerged entries, so the tick can commit normally.
  assert.equal(sh(root, "git", "diff", "--name-only", "--diff-filter=U").trim(), "");
});

test("applyWithConflicts decodes the C-quoted name of a non-ASCII conflicted file", async () => {
  // core.quotePath is on by default: a raw `diff --diff-filter=U` renders the conflicted
  // name as `"h\303\251llo.md"`, which does not exist on disk. Undecoded, the hand-back
  // prompt listed a bogus path and its "what main changed" block found nothing; the fix is
  // the same conflictedFiles decode landing-git.ts uses (review objection).
  const { root, sha } = commitOffMain("héllo.md", "theirs\n", "the handed-back work");
  fs.writeFileSync(path.join(root, "héllo.md"), "main version\n");
  commitIn(root, "main moved the same line");

  const result = await applyWithConflicts(root, "main", sha);
  assert.deepEqual(result, { applied: true, conflicted: ["héllo.md"] });
  assert.match(fs.readFileSync(path.join(root, "héllo.md"), "utf8"), /<<<<<<</);
});

test("applyWithConflicts on a non-conflict failure resets to main and reports not applied", async () => {
  const root = makeRepo();
  const before = headSha(root);
  const result = await applyWithConflicts(root, "main", "0".repeat(40));
  assert.deepEqual(result, { applied: false, conflicted: [] });
  assert.equal(headSha(root), before);
  assert.equal(await isDirty(root), false, "clean main after a failed apply");
});

test("applyRevision resets to clean main when the rejected commit no longer exists", async () => {
  const root = makeRepo();
  const before = headSha(root);
  // A missing object makes `git merge-base main <sha>` fail, the first failure mode the
  // function names: the worktree must be left at clean main, not part-way into a pick.
  assert.equal(await applyRevision(root, "main", "0".repeat(40)), false);
  assert.equal(headSha(root), before);
  assert.equal(await isDirty(root), false, "clean main after a missing object");
});

test("applyWithConflicts resets to main when the cherry-pick fails without conflicts", async () => {
  const { root, sha } = commitOffMain("landed.ts", "export const landed = true;\n", "work main already has");
  // main fast-forwards onto the same commit, so merge-base is the commit itself and the
  // `base..sha` range is empty: cherry-pick fails with no unmerged paths. Unlike the
  // bogus-sha case above (which fails at merge-base), this reaches the picked===null arm.
  sh(root, "git", "merge", "--ff-only", sha);
  const before = headSha(root);

  const result = await applyWithConflicts(root, "main", sha);
  assert.deepEqual(result, { applied: false, conflicted: [] });
  assert.equal(headSha(root), before);
  assert.equal(await isDirty(root), false, "clean main after a failed apply");
});

test("a gate rejection points the rejected ref at the judged head and records round 1", async () => {
  const restore = fakePi(reviewerPi("VERDICT: reject\n1. breaks the rules"));
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
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
    const w = batchWiring(ctx);
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
    const { root, sha } = commitOffMain("seed.txt", "director work\n", "director work");
    await setRef(root, landingRefName(DIRECTOR_ROLE), sha);
    const state = freshLoopState(DIRECTOR_ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
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
  const sha = headSha(root);
  await setRef(root, landingRefName(role), sha);

  const recovered = await recoverLeftover({ root, role, mainBranch: "main", tick: 8, wt: root });

  assert.equal(recovered?.kind, "enqueued");
  assert.equal(recovered?.kind === "enqueued" ? recovered.entry.revisionRound : undefined, 1);
  // A recovery landing carries no prior review: the re-review sees it like a fresh change
  // (plans/revise-rejected.md part 2/2).
  assert.equal(recovered?.kind === "enqueued" ? recovered.entry.priorReview : undefined, undefined);
});

test("a revision whose re-apply conflicts reaches the author with markers, not a plain rejection", async () => {
  const repo = await initializedRepo();
  // A rejected change edits seed.txt; main then moves the same line, so the clean re-apply
  // conflicts and the fallback must leave the markers for the author.
  const sha = pinOffMain(
    repo,
    (d) => fs.writeFileSync(path.join(d, "seed.txt"), "rejected version\n"),
    "the rejected work",
  );
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "commit", "-am", "main moved the same line");
  await setRef(repo, rejectedRefName("improve"), sha);

  const prompts = path.join(tmpdir(), "revision-prompts.log");
  const restore = fakePi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `echo resolved > seed.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: revised with markers resolved")}'`,
      `echo new > new.txt`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    runner.state.revision = { sha, round: 1, at: Date.now() };
    runner.state.lastReview = { verdict: "reject", reasons: ["fix it"], head: sha, at: Date.now() };
    const outcome = await runner.tick();

    assert.equal(outcome.result, "queued");
    const prompt = fs.readFileSync(prompts, "utf8");
    assert.match(prompt, /revision 1 of 2/);
    assert.match(prompt, /conflict-handback/);
    assert.match(prompt, /Conflicted files:\n- seed\.txt/);
    assert.doesNotMatch(prompt, /The rejected diff no longer applies to current main/);
    assert.equal(runner.state.revision, undefined, "the revision is consumed by staging");
    assert.equal(runner.state.conflictHandback?.reason, "revision");
    assert.equal(runner.state.conflictHandback?.applied, true);
    assert.equal(queuedLandings(repo)[0]?.revisionRound, 1, "it still rides as revision round 1");
    assert.deepEqual(eventsOfType(repo, "conflict_handback").map((e) => e.reason), ["revision"]);
  } finally {
    restore();
  }
});

// The other side of the conflict fallback: when the rejected diff cannot be re-applied at all
// (its object is gone), the markers fallback fails too, so the tick drops the revision and the
// ref and tells the author the plain rejection stands — it must not leave a stale revision
// queued to be retried every tick.
test("a revision whose diff no longer applies falls back to the plain rejection", async () => {
  const repo = await initializedRepo();
  const rejected = headSha(repo);
  await setRef(repo, rejectedRefName("improve"), rejected);

  const prompts = path.join(tmpdir(), "revision-gone-prompts.log");
  const restore = fakePi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `echo fresh > fresh.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: redid the change")}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    runner.state.revision = { sha: "0".repeat(40), round: 1, at: Date.now() };
    runner.state.lastReview = { verdict: "reject", reasons: ["fix it"], head: rejected, at: Date.now() };
    const outcome = await runner.tick();

    assert.equal(outcome.result, "queued", "the tick authored a fresh change and queued it");
    const prompt = fs.readFileSync(prompts, "utf8");
    assert.match(prompt, /The rejected diff no longer applies to current main/);
    assert.doesNotMatch(prompt, /conflict-handback/);
    assert.equal(runner.state.revision, undefined, "the unappliable revision is dropped");
    assert.ok(
      eventsOfType(repo, "revision").some((e) => e.action === "conflict"),
      "the failed re-apply is logged as a revision conflict",
    );
    assert.equal(await refSha(repo, rejectedRefName("improve")), null, "the rejected ref is gone");
  } finally {
    restore();
  }
});

test("a landed revision deletes the rejected ref", async () => {
  const root = makeRepo();
  const role = "improve";
  const rejected = headSha(root);
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
  const rejected = headSha(root);
  assert.equal(await setRef(root, rejectedRefName(role), rejected), true, "the rejected ref is set");
  const state = freshLoopState(role);
  const fresh = { role, sha: "b".repeat(40), tick: 3, summary: "fresh work", enqueuedAt: Date.now() };

  await settleLandingOutcome(root, fresh, state, "changed", 1, { tokens: 0, cost: 0 }, path.join(root, "no-such-queue-file.json"));

  assert.equal(await refSha(root, rejectedRefName(role)), rejected, "the pending revision's ref survives");
});
