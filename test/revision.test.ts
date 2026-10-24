import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyRevision, applyWithConflicts, REVISION_BACKSTOP } from "../src/runner/revision.js";
import { CONVERGENCE_HOLD_MARKER } from "../src/roles/role-guidance.js";
import { buildRevisionNote, buildRejectedReviewNote } from "../src/prompt/gate-notes.js";
import { verifyRequest } from "../src/merge/merge-batch.js";
import { recordForwardedChange, recordRevertedChange } from "../src/merge/merge-core.js";
import { refSha, isDirty, setRef } from "../src/git/git.js";
import { rejectedRefName, mergeRefName } from "../src/paths.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { entryKey } from "../src/backlog/backlog-parts.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { assembleRunPrompt } from "../src/run/run-prompt.js";
import { defaultConfig } from "../src/config/config.js";
import { resolveRunVerdict } from "../src/run/run-verdict.js";
import { stageRunMerge } from "../src/run/run-stage.js";
import { queuedMerges } from "../src/merge/merge-queue.js";
import { settleMergeOutcome } from "../src/merge/merge-pipeline.js";
import { recoverLeftover } from "../src/runner/leftover.js";
import { buildCommitMessage, commitTrailer, stampedSubject } from "../src/git/commit-message.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { NOTHING_TO_DO } from "../src/verdict/reply-contract.js";
import { readmeTemplate } from "../src/brief/brief.js";
import { eventsOfType, unwritableEvents } from "./fixtures/log-fixtures.js";
import { piRunResult, withPi } from "./fakes/fake-pi.js";
import { commitIn, headSha, initializedWorktree, makeRepo, pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { batchWiring, makeCtx, pinnedFixture, request, reviewerPi, ROLE } from "./fixtures/merger-fixtures.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { initializedRepo } from "./fixtures/repo-fixtures.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { UNSTARTABLE_GIT_ARG } from "./helpers/git-faults.js";
import { gitCouldNotStart } from "../src/git/git-run.js";

/** Unit coverage for the revise-rejected feature (plans/revise-rejected.md part 1/2): the
 * rejected commit is kept alive under its own ref, re-applied to current main as uncommitted
 * edits on the author's next run, and dropped/conflicted/exhausted with its own event. */

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

/** The resolveRunVerdict context the three nothing-to-do tests share: an "improve" run whose
 * fake pi declares NOTHING_TO_DO, with the state, worktree, user prompt, and revision round
 * the verdict turns on supplied by the caller. */
function verdictCtx(
  root: string,
  wt: string,
  state: ReturnType<typeof freshRunnerState>,
  userPrompt: string | null,
  revisionRound?: number,
): Parameters<typeof resolveRunVerdict>[0] {
  return {
    root,
    wt,
    role: "improve",
    mainBranch: "main",
    state,
    pending: new PendingPrompt(root, "improve"),
    turns: 1,
    userPrompt,
    ...(revisionRound === undefined ? {} : { revisionRound }),
    pi: piRunResult({ nothingToDo: true }),
    flow: null,
    filed: null,
    warn: () => {},
    merge: async () => "changed" as const,
    finishAbortedRun: async () => ({ result: "aborted" as const }),
  };
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
  // The index is back at HEAD with no unmerged entries, so the run can commit normally.
  assert.equal(sh(root, "git", "diff", "--name-only", "--diff-filter=U").trim(), "");
});

test("applyWithConflicts decodes the C-quoted name of a non-ASCII conflicted file", async () => {
  // core.quotePath is on by default: a raw `diff --diff-filter=U` renders the conflicted
  // name as `"h\303\251llo.md"`, which does not exist on disk. Undecoded, the hand-back
  // prompt listed a bogus path and its "what main changed" block found nothing; the fix is
  // the same conflictedFiles decode merge-git.ts uses (review objection).
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

test("a re-apply git could not start throws, rather than reporting a diff that no longer applies", async () => {
  // Reported as not applied, the caller drops the revision or hand-back and deletes its ref.
  const root = makeRepo();
  const before = headSha(root);
  await assert.rejects(applyRevision(root, "main", UNSTARTABLE_GIT_ARG), (err) => gitCouldNotStart(err));
  await assert.rejects(applyWithConflicts(root, "main", UNSTARTABLE_GIT_ARG), (err) => gitCouldNotStart(err));
  assert.equal(headSha(root), before);
  assert.equal(await isDirty(root), false);
});

test("applyWithConflicts resets to main when the cherry-pick fails without conflicts", async () => {
  const { root, sha } = commitOffMain("merged.ts", "export const merged = true;\n", "work main already has");
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

// A rejected or handed-back diff that prepends to an archive file conflicts with every entry main
// archived since — the insert-only shape the merge settles without a model run. The re-apply
// settles it the same way (2026-10-19: feature-5 was handed markers in the 1.9 MB PLANS-DONE.md).

const doneArchive = (body: string): string => `# Done plans\n\nIntro.\n\n## Done\n\n${body}`;
const archivedOld = "### Old (planned 2026-09-01, done 2026-09-02)\n\nOld.\n";

/** A repo whose PLANS-DONE.md holds one archived entry, a change off main whose commits are
 * `commits` (each writes its edits into the dir), and a main that has since archived an entry of
 * its own (plus `mainAlso`'s edits) at the same top-of-archive spot. */
function archiveTopRepo(
  commits: ((dir: string) => void)[],
  mainAlso: (dir: string) => void = () => {},
): { root: string; sha: string } {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "PLANS-DONE.md"), doneArchive(archivedOld));
  commitIn(root, "seed archive");
  sh(root, "git", "checkout", "--detach");
  commits.forEach((write, i) => {
    write(root);
    commitIn(root, `the rejected work ${i + 1}`);
  });
  const sha = headSha(root);
  sh(root, "git", "checkout", "main");
  fs.writeFileSync(path.join(root, "PLANS-DONE.md"), doneArchive(`### Main's (planned 2026-10-01, done 2026-10-19)\n\nMain's.\n\n${archivedOld}`));
  mainAlso(root);
  commitIn(root, "main archives another entry");
  return { root, sha };
}

/** The change's own finished entry, prepended to the archive. */
const archiveMine = (dir: string): void =>
  fs.writeFileSync(path.join(dir, "PLANS-DONE.md"), doneArchive(`### Mine (planned 2026-09-30, done 2026-10-19)\n\nMine.\n\n${archivedOld}`));

/** The settled archive: the change's entry above main's, nothing lost, no markers. */
function assertSettledArchive(root: string): void {
  const archive = fs.readFileSync(path.join(root, "PLANS-DONE.md"), "utf8");
  assert.match(archive, /## Done\n\n### Mine [^]*Mine\.\n\n### Main's [^]*Main's\.\n\n### Old [^]*Old\.\n$/);
  assert.doesNotMatch(archive, /^(<{7}|\|{7}|={7}|>{7})/m);
}

/** True when `root` still carries cherry-pick sequencer state, which would make its next
 * cherry-pick fail as "already in progress". */
function sequencerLeft(root: string): boolean {
  return fs.existsSync(path.resolve(root, sh(root, "git", "rev-parse", "--git-path", "sequencer")));
}

test("applyRevision settles an archive-top conflict and applies the rest of the diff", async () => {
  const { root, sha } = archiveTopRepo([
    (d) => {
      archiveMine(d);
      fs.writeFileSync(path.join(d, "feature.ts"), "export const feature = true;\n");
    },
  ]);
  assert.equal(await applyRevision(root, "main", sha), true);
  assertSettledArchive(root);
  assert.equal(fs.readFileSync(path.join(root, "feature.ts"), "utf8"), "export const feature = true;\n");
  assert.equal(sh(root, "git", "diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(await isDirty(root), true, "the diff is uncommitted");
  assert.equal(sequencerLeft(root), false);
});

test("applyRevision settles a stop part-way through a multi-commit change and applies the commits after it", async () => {
  const { root, sha } = archiveTopRepo([
    archiveMine,
    (d) => fs.writeFileSync(path.join(d, "feature.ts"), "export const feature = true;\n"),
  ]);
  assert.equal(await applyRevision(root, "main", sha), true);
  assertSettledArchive(root);
  assert.equal(fs.readFileSync(path.join(root, "feature.ts"), "utf8"), "export const feature = true;\n", "the second commit is applied");
  assert.equal(sequencerLeft(root), false);
});

test("applyWithConflicts settles the archive and hands back markers only in the files it cannot settle", async () => {
  const { root, sha } = archiveTopRepo(
    [
      (d) => {
        archiveMine(d);
        fs.writeFileSync(path.join(d, "seed.txt"), "theirs\n");
      },
    ],
    (d) => fs.writeFileSync(path.join(d, "seed.txt"), "main version\n"),
  );
  // The clean re-apply cannot settle a code conflict: it resets to main for the hand-back.
  assert.equal(await applyRevision(root, "main", sha), false);
  assert.equal(await isDirty(root), false);
  assert.equal(sequencerLeft(root), false);

  const result = await applyWithConflicts(root, "main", sha);
  assert.deepEqual(result, { applied: true, conflicted: ["seed.txt"] });
  assertSettledArchive(root);
  assert.match(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), /<<<<<<<[^]*>>>>>>>/);
  assert.equal(sh(root, "git", "diff", "--name-only", "--diff-filter=U"), "", "no unmerged index entries");
  assert.equal(sequencerLeft(root), false, "a later cherry-pick in this worktree is not refused as in progress");
});

test("a gate rejection points the rejected ref at the judged head and records round 1", async () => {
  await withPi(reviewerPi("VERDICT: reject\n1. breaks the rules"), async () => {
    const { root, sha } = await pinnedFixture();
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
    const verdict = await verifyRequest(ctx, request(sha), w);
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision?.round, 1, "a fresh rejection owes one revision");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), state.revision?.sha, "the rejected head stays reachable");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), state.lastReview?.head);
  });
});

test("a rejection whose objection has survived two revisions is final and deletes the rejected ref", async () => {
  await withPi(reviewerPi("VERDICT: reject\n1. (prior 1) still wrong"), async () => {
    const { root, sha } = await pinnedFixture();
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
    // The rejected ref exists from the earlier rounds; a repeated objection clears it. This is
    // rejection 2 (round 2): the prior rejection's objection 1 had already survived one revision
    // (count 1), and the re-review re-states it `(prior 1)`, so its count reaches 2 — the change
    // has stopped converging and the rejection is final, well before the backstop.
    await setRef(root, rejectedRefName(ROLE), sha);
    const verdict = await verifyRequest(
      ctx,
      request(sha, { revisionRound: 1, priorReview: { sha, reasons: ["the bug"], counts: [1] } }),
      w,
    );
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision, undefined, "no more rounds are recorded");
    assert.equal(state.lastReview?.exhausted, true, "the next rejected note says it was final");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), null, "the rejected ref is deleted");
    assert.equal(eventsOfType(root, "revision").length, 1, "the exhaustion is logged");
  });
});

test("an exhausted chain holds the entry with the surviving objections, not a fresh pick", async () => {
  await withPi(reviewerPi("VERDICT: reject\n1. (prior 1) still wrong"), async () => {
    const { root, sha } = await pinnedFixture();
    // A backend entry the author is revising, still under ## Planned.
    fs.writeFileSync(
      path.join(root, "PLANS.md"),
      "# Plans\n\nIntro.\n\n## Planned\n\n### The convergence plan (planned 2026-10-01)\n\nBody.\n",
    );
    const state = freshRunnerState(ROLE);
    state.claim = {
      file: "PLANS.md",
      key: entryKey("The convergence plan (planned 2026-10-01)"),
      title: "The convergence plan (planned 2026-10-01)",
      at: Date.now(),
      source: "assigned",
    };
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
    await setRef(root, rejectedRefName(ROLE), sha);
    const verdict = await verifyRequest(
      ctx,
      request(sha, { revisionRound: 1, priorReview: { sha, reasons: ["the bug"], counts: [1] } }),
      w,
    );
    assert.equal(verdict.kind, "result");
    assert.equal(state.lastReview?.exhausted, true, "the rejection is final");
    // The surviving objection is now a needs-review hold under the entry's heading, so no role
    // re-picks it "fresh"; the note text carries the objection verbatim for the operator/plan role.
    const md = fs.readFileSync(path.join(root, "PLANS.md"), "utf8");
    // The surviving objection is now a needs-review hold under the entry's heading, so no role
    // re-picks it "fresh"; the note text carries the objection verbatim for the operator/plan role.
    const noteLine = md.split("\n").find((l) => l.startsWith("**Needs review"));
    assert.ok(noteLine?.includes(CONVERGENCE_HOLD_MARKER), "the hold note carries the shared convergence marker");
    const holdsObjection = noteLine?.includes("still wrong") === true;
    if (!holdsObjection) {
      assert.fail("the needs-review hold note is missing or lacks the surviving objection:\n" + (noteLine ?? md));
    }
  });
});

test("a converging chain whose revisions raise only new objections keeps revising", async () => {
  await withPi(reviewerPi("VERDICT: reject\n1. a brand-new concern"), async () => {
    const { root, sha } = await pinnedFixture();
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
    // This is the chain's third rejection (revisionRound 2 → round 3), where the old
    // REVISION_LIMIT of 2 used to abandon even a converging change. The re-review raises a
    // NEW untagged objection, so no count reaches the finality threshold and the chain keeps
    // revising instead.
    const verdict = await verifyRequest(
      ctx,
      request(sha, { revisionRound: 2, priorReview: { sha, reasons: ["the old bug"], counts: [1] } }),
      w,
    );
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision?.round, 3, "a converging chain is not abandoned");
    assert.equal(state.lastReview?.exhausted, undefined, "not final — the change still revises");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), state.revision?.sha, "the rejected head stays reachable");
  });
});

test("a chain whose objections never repeat ends at the backstop", async () => {
  await withPi(reviewerPi("VERDICT: reject\n1. a brand-new concern"), async () => {
    const { root, sha } = await pinnedFixture();
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
    await setRef(root, rejectedRefName(ROLE), sha);
    // REVISION_BACKSTOP - 1 revisions have been granted; this is the 6th (cap) rejection, and
    // even with every objection untagged the chain ends.
    const verdict = await verifyRequest(ctx, request(sha, { revisionRound: REVISION_BACKSTOP - 1 }), w);
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision, undefined, "no more rounds are recorded");
    assert.equal(state.lastReview?.exhausted, true, "the next rejected note says it was final");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), null, "the rejected ref is deleted");
  });
});

test("exhausting a revision still records the outcome when the events feed is unwritable", async () => {
  // recordRejectedChange (merge-core.ts) deletes the rejected ref and clears the round, then
  // logs the exhaustion LAST. An EISDIR on that append must not turn the terminal exhaustion
  // into a thrown verification error after the ref is already gone.
  await withPi(reviewerPi("VERDICT: reject\n1. (prior 1) still wrong"), async () => {
    const { root, sha } = await pinnedFixture();
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
    await setRef(root, rejectedRefName(ROLE), sha);
    unwritableEvents(root);

    const verdict = await verifyRequest(
      ctx,
      request(sha, { revisionRound: 1, priorReview: { sha, reasons: ["the bug"], counts: [1] } }),
      w,
    );

    assert.equal(verdict.kind, "result");
    assert.equal(state.revision, undefined, "the round is still cleared");
    assert.equal(state.lastReview?.exhausted, true, "the final rejection is still marked");
    assert.equal(await refSha(root, rejectedRefName(ROLE)), null, "the rejected ref is deleted");
  });
});

test("a permanent reviewer config error still holds the pin when the events feed is unwritable", async () => {
  // reviewPinnedChange's configError branch records the hold and then warns; an EISDIR on that
  // warning must not turn the designed held-pin "review_error" into a thrown verification error.
  const configErrorPi = `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '400 model_not_supported' >&2; exit 1;; esac; done`;
  await withPi(configErrorPi, async () => {
    const { root, sha } = await pinnedFixture();
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    ctx.config.review.model = "bad/model";
    const w = batchWiring(ctx);
    unwritableEvents(root);

    const verdict = await verifyRequest(ctx, request(sha), w);

    assert.equal(verdict.kind, "result");
    if (verdict.kind !== "result") return;
    assert.equal(verdict.result, "review_error", "the held pin reports review_error, not a throw");
    assert.equal(state.mergeReviewError?.selector, "bad/model", "the hold still names the selector");
    assert.equal(await refSha(root, mergeRefName(ROLE)), sha, "the pin is kept for a config change");
  });
});

/** The `stageRunMerge` context the two staging tests share: the runner wiring every run
 * supplies, with `overrides` layered on for per-test state, prompt, and reply text. */
function stageCtx(
  root: string,
  wt: string,
  overrides: Partial<Parameters<typeof stageRunMerge>[0]> = {},
): Parameters<typeof stageRunMerge>[0] {
  return {
    root,
    role: "improve",
    state: freshRunnerState("improve"),
    config: defaultConfig(),
    runTurns: 4,
    userPrompt: null,
    wt,
    finalText: "",
    piStartedAt: Date.now(),
    flow: null,
    filed: null,
    warn: () => {},
    requestSummary: async () => null,
    stageCheck: async () => [],
    requestStageFix: async () => null,
    pinAndReset: async () => true,
    finishAbortedRun: async () => ({ result: "aborted" as const }),
    ...overrides,
  };
}

test("stageRunMerge carries the revision round onto the entry and clears state.revision", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = {
    ...freshRunnerState("improve"),
    runs: 5,
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const ctx = stageCtx(root, wt, {
    state,
    revisionRound: 1,
    finalText: "SUMMARY: revise the change\nWHY: the objection\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(state.revision, undefined, "staging consumes the revision");
  assert.equal(queuedMerges(root)[0]?.revisionRound, 1, "the round rides the queued merge");
});

test("a user-request run that leaves a pending revision stages no round and keeps the revision", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "user-change.ts"), "export const userChange = true;\n");
  const revision = { sha: "a".repeat(40), round: 1, at: Date.now() };
  const state = { ...freshRunnerState("improve"), runs: 5, revision };
  const ctx = stageCtx(root, wt, {
    state,
    userPrompt: "please do the user thing",
    finalText: "SUMMARY: do the user thing\nWHY: asked\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(queuedMerges(root)[0]?.revisionRound, undefined, "a user change is not a revision");
  assert.deepEqual(state.revision, revision, "the pending revision is left untouched");
});

test("a non-revision dirty nothing-to-do run does not drop a pending revision", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "user-change.ts"), "export const userChange = true;\n");
  const state = {
    ...freshRunnerState("improve"),
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const ctx = verdictCtx(root, wt, state, "please do the user thing");

  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome, null, "the run is fulfillable and staging takes over");
  assert.notEqual(state.revision, undefined, "the pending revision is not dropped");
});

test("a revision run that declares nothing-to-do drops the change and ends no_change", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = {
    ...freshRunnerState("improve"),
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const ctx = verdictCtx(root, wt, state, null, 1);

  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(state.revision, undefined);
  assert.equal(await isDirty(wt), false, "the re-applied diff is reset away");
  assert.equal(eventsOfType(root, "revision").length, 1, "the drop is logged");
});

test("a revision run drops the change when the events feed is unwritable", async () => {
  const { root, wt } = await initializedWorktree("improve");
  await setRef(root, rejectedRefName("improve"), "a".repeat(40));
  const state = {
    ...freshRunnerState("improve"),
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const ctx = verdictCtx(root, wt, state, null, 1);
  // Put a directory where the append-only events log belongs: the drop event throws EISDIR
  // while every other file under the root still writes, exactly as on a full disk.
  unwritableEvents(root);

  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(state.revision, undefined, "the rejected change is dropped");
  assert.equal(await refSha(root, rejectedRefName("improve")), null, "the rejected ref is deleted");
});

test("a revision run that declares nothing-to-do drops the change with a clean worktree", async () => {
  const { root, wt } = await initializedWorktree("improve");
  // A revision run need not leave the re-applied diff dirty: the cherry-pick can be an empty
  // range, or the author can revert the edits while deciding the change should not exist. The
  // author's NOTHING_TO_DO must still end the rejected change, or every later run re-applies
  // the same rejected diff and the change loops without ever reaching its limit.
  await setRef(root, rejectedRefName("improve"), "a".repeat(40));
  const state = {
    ...freshRunnerState("improve"),
    revision: { sha: "a".repeat(40), round: 1, at: Date.now() },
  };
  const ctx = verdictCtx(root, wt, state, null, 1);

  const outcome = await resolveRunVerdict(ctx);

  assert.equal(await isDirty(wt), false, "the worktree is already clean");
  assert.equal(outcome?.result, "no_change");
  assert.equal(state.revision, undefined, "the rejected change is dropped");
  assert.equal(await refSha(root, rejectedRefName("improve")), null, "the rejected ref is deleted");
  assert.equal(eventsOfType(root, "revision").length, 1, "the drop is logged");
});

test("the run prompt skips the plain rejection note while a revision is due", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), readmeTemplate("proj", "Build a tiny thing.\n"));
  const lastReview = { verdict: "reject", reasons: ["fix the bug"], head: "b".repeat(40), at: Date.now() };
  const withRevision = assembleRunPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: { ...freshRunnerState("coverage"), lastReview, revision: { sha: "b".repeat(40), round: 1, at: Date.now() } },
  });
  assert.ok(withRevision);
  assert.doesNotMatch(withRevision.prompt, /previous change was rejected/);

  const withoutRevision = assembleRunPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: { ...freshRunnerState("coverage"), lastReview },
  });
  assert.ok(withoutRevision);
  assert.match(withoutRevision.prompt, /previous change was rejected/);
});

test("the director never gets a revision: a rejection leaves no revision state", async () => {
  await withPi(reviewerPi("VERDICT: reject\n1. no good"), async () => {
    const { root, sha } = commitOffMain("seed.txt", "director work\n", "director work");
    await setRef(root, mergeRefName(DIRECTOR_ROLE), sha);
    const state = freshRunnerState(DIRECTOR_ROLE);
    const { ctx } = makeCtx(root, state);
    const w = batchWiring(ctx);
    const verdict = await verifyRequest(ctx, request(sha, { role: DIRECTOR_ROLE }), w);
    assert.equal(verdict.kind, "result");
    assert.equal(state.revision, undefined, "the director never revises");
    assert.equal(await refSha(root, rejectedRefName(DIRECTOR_ROLE)), null);
  });
});

test("an exhausted rejection's plain note sends a plan-less role to its notes", () => {
  const note = buildRejectedReviewNote({ reasons: ["still wrong"], at: Date.now(), exhausted: true });
  assert.match(note, /final revision round/);
  assert.match(note, /[Dd]o not re-author it/);
  assert.match(note, /abandoned purpose/);
  assert.match(note, /notes/);
  assert.match(note, /different theme/);
  assert.doesNotMatch(note, /re-author it from current main/);
  assert.doesNotMatch(buildRejectedReviewNote({ reasons: ["still wrong"] }), /final revision round/);
});

test("buildRevisionNote names the objections, the round, and the nothing-to-do escape", () => {
  const note = buildRevisionNote({ reasons: ["first", "second"] }, 1);
  assert.match(note, /revision 1\b/);
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
  await setRef(root, mergeRefName(role), sha);

  const recovered = await recoverLeftover({ root, role, mainBranch: "main", runNumber: 8, wt: root });

  assert.equal(recovered?.kind, "enqueued");
  assert.equal(recovered?.kind === "enqueued" ? recovered.entry.revisionRound : undefined, 1);
  // A recovery merge carries no prior review: the re-review sees it like a fresh change
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
  await withPi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `echo resolved > seed.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: revised with markers resolved")}'`,
      `echo new > new.txt`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      runner.state.revision = { sha, round: 1, at: Date.now() };
      runner.state.lastReview = { verdict: "reject", reasons: ["fix it"], head: sha, at: Date.now() };
      const outcome = await runner.run();

      assert.equal(outcome.result, "queued");
      const prompt = fs.readFileSync(prompts, "utf8");
      assert.match(prompt, /revision 1\b/);
      assert.match(prompt, /conflict-handback/);
      assert.match(prompt, /Conflicted files:\n- seed\.txt/);
      assert.doesNotMatch(prompt, /The rejected diff no longer applies to current main/);
      assert.equal(runner.state.revision, undefined, "the revision is consumed by staging");
      assert.equal(runner.state.conflictHandback?.reason, "revision");
      assert.equal(runner.state.conflictHandback?.applied, true);
      assert.equal(queuedMerges(repo)[0]?.revisionRound, 1, "it still rides as revision round 1");
      assert.deepEqual(eventsOfType(repo, "conflict_handback").map((e) => e.reason), ["revision"]);
    },
  );
});

// The other side of the conflict fallback: when the rejected diff cannot be re-applied at all
// (its object is gone), the markers fallback fails too, so the run drops the revision and the
// ref and tells the author the plain rejection stands — it must not leave a stale revision
// queued to be retried every run.
test("a revision whose diff no longer applies falls back to the plain rejection", async () => {
  const repo = await initializedRepo();
  const rejected = headSha(repo);
  await setRef(repo, rejectedRefName("improve"), rejected);

  const prompts = path.join(tmpdir(), "revision-gone-prompts.log");
  await withPi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `echo fresh > fresh.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: redid the change")}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      runner.state.revision = { sha: "0".repeat(40), round: 1, at: Date.now() };
      runner.state.lastReview = { verdict: "reject", reasons: ["fix it"], head: rejected, at: Date.now() };
      const outcome = await runner.run();

      assert.equal(outcome.result, "queued", "the run authored a fresh change and queued it");
      const prompt = fs.readFileSync(prompts, "utf8");
      assert.match(prompt, /The rejected diff no longer applies to current main/);
      assert.doesNotMatch(prompt, /conflict-handback/);
      assert.equal(runner.state.revision, undefined, "the unappliable revision is dropped");
      assert.ok(
        eventsOfType(repo, "revision").some((e) => e.action === "conflict"),
        "the failed re-apply is logged as a revision conflict",
      );
      assert.equal(await refSha(repo, rejectedRefName("improve")), null, "the rejected ref is gone");
    },
  );
});

test("a revision whose re-apply git could not start keeps the revision and its ref for the next run", async () => {
  const repo = await initializedRepo();
  const rejected = headSha(repo);
  await setRef(repo, rejectedRefName("improve"), rejected);
  const ran = path.join(tmpdir(), "revision-unstartable-ran");
  await withPi(`touch "${ran}"`, async () => {
    const runner = makeRoleRunner(repo, "improve");
    const revision = { sha: UNSTARTABLE_GIT_ARG, round: 1, at: Date.now() };
    runner.state.revision = revision;
    runner.state.lastReview = { verdict: "reject", reasons: ["fix it"], head: rejected, at: Date.now() };
    const outcome = await runner.run();

    assert.equal(outcome.result, "error");
    assert.ok(!fs.existsSync(ran), "no agent run started without the rejected diff");
    assert.deepEqual(runner.state.revision, revision, "the revision waits for the next run");
    assert.equal(await refSha(repo, rejectedRefName("improve")), rejected, "the rejected ref is kept");
    assert.equal(eventsOfType(repo, "revision").length, 0);
  });
});

test("a merged revision deletes the rejected ref", async () => {
  const root = makeRepo();
  const role = "improve";
  const rejected = headSha(root);
  assert.equal(await setRef(root, rejectedRefName(role), rejected), true, "the rejected ref is set");
  const state = freshRunnerState(role);
  const revision = {
    role,
    sha: "b".repeat(40),
    run: 3,
    summary: "the revision",
    revisionRound: 2,
    enqueuedAt: Date.now(),
  };

  await settleMergeOutcome(root, revision, state, "changed", 1, { tokens: 0, cost: 0, providerCost: {} }, path.join(root, "no-such-queue-file.json"));

  assert.equal(await refSha(root, rejectedRefName(role)), null, "the rejected ref is gone");
});

test("a fresh merge leaves a pending revision's rejected ref alone", async () => {
  const root = makeRepo();
  const role = "improve";
  const rejected = headSha(root);
  assert.equal(await setRef(root, rejectedRefName(role), rejected), true, "the rejected ref is set");
  const state = freshRunnerState(role);
  const fresh = { role, sha: "b".repeat(40), run: 3, summary: "fresh work", enqueuedAt: Date.now() };

  await settleMergeOutcome(root, fresh, state, "changed", 1, { tokens: 0, cost: 0, providerCost: {} }, path.join(root, "no-such-queue-file.json"));

  assert.equal(await refSha(root, rejectedRefName(role)), rejected, "the pending revision's ref survives");
});

test("a forwarded post-merge rejection records the same round as a reverted one", async () => {
  // A forward (the commit is still on main) and a revert hand the author's change back with the
  // SAME one shared counter: a commit's `Revision` trailer plus one, ending at the backstop. The
  // two hand-backs must therefore agree on every round, and at the cap they must end identically.
  const root = makeRepo();
  // Two commits with identical messages (one for the forwarded record, one for the reverted):
  // `tag` distinguishes the working-tree edit each one commits so the second commit is not empty.
  const mk = (msg: string, tag: string): { sha: string; sha2: string } => {
    fs.writeFileSync(path.join(root, "a.txt"), tag);
    commitIn(root, msg);
    const sha = headSha(root);
    fs.writeFileSync(path.join(root, "a.txt"), tag + "b");
    commitIn(root, msg);
    return { sha, sha2: headSha(root) };
  };
  const fwdRole = "feature";
  const revRole = "feature-2";
  const mid = mk("edit a\n\nRevision: 2", "first"); // revisions 2 → round 3, not exhausted
  const fwdState = freshRunnerState(fwdRole);
  const revState = freshRunnerState(revRole);
  // A forward records NO rejected ref (the commit is still on main — nothing to re-apply onto
  // itself), so unlike the reverted side no ref is set up.
  await setRef(root, rejectedRefName(revRole), mid.sha2);
  await recordForwardedChange(root, fwdRole, fwdState, mid.sha, ["still wrong"]);
  await recordRevertedChange(root, revRole, revState, mid.sha2, ["still wrong"]);
  assert.equal(fwdState.forwarded?.round, 3, "the forwarded record counts the same round");
  assert.equal(revState.revision?.round, 3, "the reverted record counts the same round");
  assert.equal(fwdState.revision, undefined, "a forward records no re-apply revision");
  assert.equal(await refSha(root, rejectedRefName(fwdRole)), null, "a forward points no rejected ref");
  assert.equal(fwdState.lastReview?.verdict, "forwarded", "a forward never reads as a revert");
  assert.equal(revState.lastReview?.verdict, "reverted");
  assert.equal(fwdState.lastReview?.head, mid.sha, "the forwarded record names the commit");

  // Identical backstop: a trailer one below the cap ends both chains exactly the same way.
  const cap = mk(`edit b\n\nRevision: ${REVISION_BACKSTOP - 1}`, "cap");
  const fwdEx = freshRunnerState(fwdRole);
  const revEx = freshRunnerState(revRole);
  await setRef(root, rejectedRefName(revRole), cap.sha2);
  await recordForwardedChange(root, fwdRole, fwdEx, cap.sha, ["still wrong"]);
  await recordRevertedChange(root, revRole, revEx, cap.sha2, ["still wrong"]);
  assert.equal(fwdEx.forwarded, undefined, "the forwarded chain is cleared at the backstop");
  assert.equal(fwdEx.revision, undefined, "the forwarded chain records no revision");
  assert.equal(revEx.revision, undefined, "the reverted chain is cleared at the backstop");
  assert.equal(fwdEx.lastReview?.exhausted, true, "the forwarded exhaustion is final");
  assert.equal(revEx.lastReview?.exhausted, true, "the reverted exhaustion is final");
  assert.equal(await refSha(root, rejectedRefName(fwdRole)), null, "the forwarded ref is deleted (never set)");
  assert.equal(await refSha(root, rejectedRefName(revRole)), null, "the reverted ref is deleted");
});

test("a runner consuming a forwarded hand-back carries the round and re-applies nothing", async () => {
  // Objection-2 pin: a forwarded record is consumed by a REAL runner (not just handed off
  // directly). Because the commit is still ON MAIN, the runner must fix forward WITHOUT
  // attempting applyRevision (no rejected ref, no "revision applied" event) — yet the follow-up
  // still carries the round, both on its queued merge entry and in its stamped `Revision:`
  // trailer, so the chain keeps counting toward the same backstop.
  const repo = await initializedRepo();
  fs.writeFileSync(path.join(repo, "seed.txt"), "breaks it\n");
  commitIn(repo, "the change that stayed on main\n\nRevision: 2"); // next forward is round 3
  const sha = headSha(repo);

  const prompts = path.join(tmpdir(), "forward-runs.log");
  await withPi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `echo fixed > seed.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: fix forward\nWHY: the review")}'`,
      `echo followup > followup.txt`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      runner.state.lastReview = { verdict: "forwarded", reasons: ["still wrong"], head: sha, at: Date.now() };
      runner.state.forwarded = { sha, round: 3, at: Date.now() };
      const outcome = await runner.run();

      assert.equal(outcome.result, "queued");
      const prompt = fs.readFileSync(prompts, "utf8");
      assert.match(prompt, /revision 3\b/, "the forward names its round");
      assert.match(prompt, /still wrong/, "the forward carries the objections");
      assert.doesNotMatch(prompt, /already in the worktree as uncommitted edits/, "a forward re-applies nothing");
      const entry = queuedMerges(repo)[0]!;
      assert.equal(entry.revisionRound, 3, "the follow-up's queued merge carries the round");
      assert.match(sh(repo, "git", "show", "-s", "--format=%B", entry.sha), /Revision: 3/, "the follow-up's commit stamps the Revision: 3 trailer");
      assert.deepEqual(eventsOfType(repo, "revision").map((e) => e.action), ["forwarded"], "no applyRevision is attempted");
      assert.equal(await refSha(repo, rejectedRefName("improve")), null, "no rejected ref for an on-main forward");
      assert.equal(runner.state.forwarded, undefined, "the forward is consumed by staging");
      assert.equal(runner.state.revision, undefined, "no re-apply revision is left");
    },
  );
});
