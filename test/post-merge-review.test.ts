import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { drainPostReviews } from "../src/merge/merge-post-review-drain.js";
import { newMergePipeline, type MergePipelineContext } from "../src/merge/merge-pipeline.js";
import { addPostReview, readPostReviews, POST_REVIEW_FAILURE_LIMIT, postMergeRejectionCounts } from "../src/review/post-merge-review.js";
import type { HarnessEvent } from "../src/events/events.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { postReviewPath, reviewFixRef } from "../src/paths.js";
import { shortSha } from "../src/text/format.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { gateFixture, reviewGate } from "./fixtures/gate-fixtures.js";
import { headSha, makeRepo, pinOffMain, sh } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { piRanMarker, piRunResult, withPi, withReviewerStub } from "./fakes/fake-pi.js";
import { APPROVE, drained, entry, makePipeline, pinnedCommit, pumpUntil, runnersFor } from "./fixtures/merge-fixtures.js";
import { enqueueMerge } from "../src/merge/merge-queue.js";
import { mergeRefName } from "../src/paths.js";
import { isMergedInto, setRef } from "../src/git/git.js";
import { sleep } from "./helpers/wait.js";
import { UNSTARTABLE_GIT_ARG } from "./helpers/git-faults.js";

test("review.afterMerge accepts known base role ids and rejects the director and unknown ids", () => {
  // The widened default (reviewer-as-regular-role part 1/4): the post-merge list now carries
  // the low-blast-radius maintenance roles alongside the original trio, so a fresh project
  // (and the gitignored live config, which inherits the default) gets the tiering.
  assert.deepEqual(defaultConfig().review.afterMerge, ["bugfix", "clean", "coverage", "dedupe", "organize", "readme"]);
  assert.doesNotThrow(() => validateConfig({ review: { afterMerge: ["bugfix", "clean", "coverage", "dedupe", "organize", "readme"] } }));
  assert.throws(() => validateConfig({ review: { afterMerge: ["director"] } }), /review\.afterMerge\[0\] must not be "director"/);
  assert.throws(() => validateConfig({ review: { afterMerge: ["cleen"] } }), /review\.afterMerge\.cleen is not a known role/);
  assert.throws(() => validateConfig({ review: { afterMerge: [""] } }), /review\.afterMerge\[0\] must not be blank/);
});

test("the tracked tumwater.example.json carries the widened afterMerge default", () => {
  // The example (not defaultConfig() alone) is what seedConfig overlays onto a fresh project, so
  // it must not drift from the widened default: a fresh project inherits the tiering from BOTH.
  const example = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tumwater.example.json"), "utf8")) as {
    review?: { afterMerge?: string[] };
  };
  assert.deepEqual(example.review?.afterMerge, defaultConfig().review.afterMerge);
});

test("all roles pass the gate with no reviewer run before the merge", async () => {
  // The pre-merge gate is deterministic (part 3h/3): with the reviewer gone before the merge,
  // both a listed and an unlisted role pass the gate with the pi-run marker absent and no
  // `review_start`; the post-review queueing the afterMerge list feeds is covered below.
  const { root, wt } = await gateFixture();
  const config = { ...defaultConfig(), review: { ...defaultConfig().review, afterMerge: ["improve"] } };
  const marker = piRanMarker();
  await withReviewerStub(marker, async () => {
    const { result } = await reviewGate(root, wt, { config });
    assert.equal(result.decision, "approved");
    assert.ok(!fs.existsSync(marker), "the reviewer must not run before the merge");
    assert.equal(eventsOfType(root, "review_start").length, 0);
    const second = await reviewGate(root, wt); // an unlisted role, too
    assert.equal(second.result.decision, "approved");
    assert.ok(!fs.existsSync(marker), "an unlisted role's change also passes with no reviewer run");
    assert.equal(eventsOfType(root, "review_start").length, 0);
  });
});

function fakeRunner(role: string, verdict: string): RoleRunner {
  return {
    role,
    baseRole: role,
    state: freshRunnerState(role),
    runGatePi: async () => ({ ok: true, verdictText: verdict }),
  } as unknown as RoleRunner;
}

function setup(verdict: string) {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "x.txt"), "x");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "add x");
  const commit = headSha(root);
  const runner = fakeRunner("improve", verdict);
  const ctx = {
    root,
    mainBranch: "main",
    liveConfig: defaultConfig(),
    runners: [runner],
    semaphore: new Semaphore(2),
    signal: new AbortController().signal,
    startHeld: () => false,
  } as unknown as MergePipelineContext;
  addPostReview(root, { commit, role: "improve", summary: "add x" });
  return { root, commit, runner, ctx };
}

test("an approving post-merge review ends the entry and logs afterMerge events", async () => {
  const { root, ctx } = setup("VERDICT: approve\n1. fine");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(readPostReviews(root).length, 0);
  assert.equal(eventsOfType(root, "review_verdict")[0]?.afterMerge, true);
});

test("a rejecting post-merge review never fills the revert slot and keeps the commit on main", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_rejected")[0]?.afterMerge, true);
  // Several more polls with an idle merge slot: the rejection must never route to a revert.
  for (let i = 0; i < 5; i++) {
    drainPostReviews(ctx, p);
    await sleep(10);
  }
  assert.equal(headSha(root), commit, "the rejected commit stays on main");
  // The rejection is recorded in post-review.json, answered only by the reviewer's own fix
  // (part 1a/6), and never re-reviewed.
  const entries = readPostReviews(root);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.rejected, ["breaks the contract"]);
});

test("a post-merge rejection leaves an archived entry archived: nothing walks the change back", async () => {
  // The commit-time archive sweep (archiveNewFinishedEntries, src/backlog/backlog-archive.ts) moves
  // a finished `## Planned` entry out of the live file and into the archive on merge. Under
  // Forward, never back (part 1/6) a post-merge rejection is answered by the reviewer's own fix,
  // never a revert, so the merged commit's archive is NOT walked back: the entry stays archived,
  // the archive file stays, and the commit stays on main.
  const root = makeRepo();
  const planned = `# Plans\n\n## Planned\n\n### The archived entry (planned 2026-10-23 by user)\n\nSome body.\n\n## Done\n\n_None yet._\n`;
  fs.writeFileSync(path.join(root, "PLANS.md"), planned);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "baseline plans");
  // The merged commit archives the entry: moved to `## Done` and swept into PLANS-DONE.md, the
  // archiveNewFinishedEntries shape a role run leaves wired to its commit.
  const archived = `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### The archived entry (planned 2026-10-23 by user — done 2026-10-23 by the improve role)\n\nSome body.\n`;
  fs.writeFileSync(path.join(root, "PLANS.md"), archived);
  fs.writeFileSync(
    path.join(root, "PLANS-DONE.md"),
    `# Done\n\n## Done\n\n### The archived entry (planned 2026-10-23 by user — done 2026-10-23 by the improve role)\n\nSome body.\n`,
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "archive the finished entry");
  const commit = headSha(root);
  const runner = fakeRunner("improve", "VERDICT: reject\n1. the change must not land");
  const ctx = {
    root,
    mainBranch: "main",
    liveConfig: defaultConfig(),
    runners: [runner],
    semaphore: new Semaphore(2),
    signal: new AbortController().signal,
    startHeld: () => false,
  } as unknown as MergePipelineContext;
  addPostReview(root, { commit, role: "improve", summary: "archive the finished entry" });
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(headSha(root), commit, "the rejected commit stays on main");
  const plans = fs.readFileSync(path.join(root, "PLANS.md"), "utf8");
  assert.ok(plans.includes("## Planned\n\n_None yet._"), "the archived entry stays archived — no revert restores it");
  assert.ok(fs.existsSync(path.join(root, "PLANS-DONE.md")), "the archive file the merged commit created stays");
});

test("a rejected entry stays recorded in post-review.json and never takes the revert slot", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.ok(readPostReviews(root).some((e) => e.commit === commit && e.rejected !== undefined), "the rejection is kept as the record");
  // Whatever the slot state, further polls never route the rejection to a revert.
  for (let i = 0; i < 5; i++) {
    drainPostReviews(ctx, p);
    await sleep(10);
  }
});

test("a listed role's change merges with no review before it, then is queued and reviewed after", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, mergeRefName("improve"), sha);
  enqueueMerge(root, entry("improve", sha));
  const config = { ...defaultConfig(), review: { ...defaultConfig().review, afterMerge: ["improve"] } };
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"], undefined, config), { config });
    await pumpUntil(
      ctx,
      pipeline,
      () => drained(root, pipeline)() && pipeline.postReview === null && eventsOfType(root, "review_verdict").length > 0,
      "the merge and its post-merge review",
    );
    assert.equal(eventsOfType(root, "merged").length, 1);
    const verdict = eventsOfType(root, "review_verdict")[0]!;
    assert.equal(verdict.afterMerge, true);
    assert.equal(verdict.head, sh(root, "git", "rev-parse", "main").trim());
    assert.equal(readPostReviews(root).length, 0);
  });
});

/** Merges a commit from a role absent from `review.afterMerge` (improve) that touches `file`;
 * returns the root once the merge drained. Part 3g/3 makes review-after-landing a property of
 * every change rather than of the afterMerge list, so the exempt and disabled gates are what
 * these cases hold against, whatever the role. */
async function mergeListed(file: string, review: { enabled: boolean }): Promise<string> {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, file), "work\n"), "work by improve", { reset: true });
  await setRef(root, mergeRefName("improve"), sha);
  enqueueMerge(root, entry("improve", sha));
  const base = defaultConfig();
  const config = { ...base, review: { ...base.review, ...review, afterMerge: [] } };
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"], undefined, config), { config });
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the merge");
  });
  return root;
}

test("no post-merge review is queued when review is disabled or the merged diff is exempt", async () => {
  const disabled = await mergeListed("code.txt", { enabled: false });
  assert.equal(eventsOfType(disabled, "merged").length, 1);
  assert.equal(readPostReviews(disabled).length, 0);
  const exempt = await mergeListed("NOTES.md", { enabled: true });
  assert.equal(eventsOfType(exempt, "merged").length, 1);
  assert.equal(readPostReviews(exempt).length, 0);
});

/** Count the reviewer runs `runner` makes from here on. */
function countReviews(runner: RoleRunner): { count: number } {
  const counted = { count: 0 };
  const run = runner.runGatePi;
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = (opts) => {
    counted.count++;
    return run(opts);
  };
  return counted;
}

test("a merged commit whose diff git cannot produce fails its review, never approving an empty diff", async () => {
  const { root, runner, ctx } = setup("VERDICT: approve\n1. fine");
  const reviews = countReviews(runner);
  // The repository's first commit has no parent, so `git diff C^ C` fails for real.
  const first = sh(root, "git", "rev-list", "--max-parents=0", "HEAD");
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit: first, role: "improve", summary: "seed" }] }));
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(reviews.count, 0, "no reviewer ran over an empty diff");
  assert.equal(eventsOfType(root, "review_verdict").length, 0);
  const keptEntries = readPostReviews(root);
  assert.equal(keptEntries.length, 1);
  const kept = keptEntries[0]!;
  assert.deepEqual(
    { commit: kept.commit, role: kept.role, summary: kept.summary, failures: kept.failures },
    { commit: first, role: "improve", summary: "seed", failures: 1 },
  );
  assert.match(kept.lastFailure ?? "", /^git diff .* failed/, "the run's failure detail is recorded beside the count");
});

test("a later failed run replaces the recorded last failure reason", async () => {
  const { root, runner, ctx } = setup("VERDICT: approve\n1. fine");
  const reviews = countReviews(runner);
  // The repository's first commit has no parent, so `git diff C^ C` fails for real each run.
  const first = sh(root, "git", "rev-list", "--max-parents=0", "HEAD");
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit: first, role: "improve", summary: "seed", failures: 1, lastFailure: "old detail" }] }));
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(reviews.count, 0, "no reviewer ran over an empty diff");
  const kept = readPostReviews(root).at(0)!;
  assert.equal(kept.failures, 2);
  assert.match(kept.lastFailure ?? "", /^git diff .* failed/, "the later run's reason replaces the old detail");
});

test("a post-merge review git could not start keeps its entry without counting a failed run", async () => {
  // A spawn failure says nothing about the commit: counted, a wedge as long as 2026-10-21's
  // reached POST_REVIEW_FAILURE_LIMIT and dropped the review, leaving the commit unreviewed.
  const { root, runner, ctx } = setup("VERDICT: approve\n1. fine");
  const reviews = countReviews(runner);
  const entry = { commit: UNSTARTABLE_GIT_ARG, role: "improve", summary: "s" };
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [entry] }));
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(reviews.count, 0);
  assert.deepEqual(readPostReviews(root), [entry], "kept as it was, for the next poll");
});

test("a torn post-review.json entry is dropped and the well-formed one is still reviewed", async () => {
  const { root, commit, ctx } = setup("VERDICT: approve\n1. fine");
  const torn = [
    null,
    { commit: 7 },
    { commit, role: "improve", summary: "s", rejected: "x" },
    { commit, role: "improve", summary: "add x", failures: "2", rejected: ["r", 3] },
  ];
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: torn }));
  assert.deepEqual(readPostReviews(root), [{ commit, role: "improve", summary: "add x", rejected: ["r"] }]);
  const good = { commit, role: "improve", summary: "add x" };
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [...torn.slice(0, 3), good] }));
  const p = newMergePipeline();
  assert.doesNotThrow(() => drainPostReviews(ctx, p));
  assert.ok(p.postReview);
  await p.postReview.promise;
  assert.equal(readPostReviews(root).length, 0);
});

test("a failed post-review.json write on a rejection warns and does not wedge the pipeline", async () => {
  const { root, ctx } = setup("VERDICT: reject\n1. bad");
  const p = newMergePipeline();
  const undo = failRenameSyncOn(postReviewPath(root), "pr write refused");
  try {
    drainPostReviews(ctx, p);
    await p.postReview!.promise;
  } finally {
    undo();
  }
  assert.equal(p.postReview, null, "the review task freed the slot");
  const warnings = eventsOfType(root, "warning").filter((e) => e.source === "tumwater");
  assert.ok(warnings.some((e) => String(e.message).includes("pr write refused")), "the failed write warns");
});

test("readPostReviews drops a non-numeric enqueuedAt and omits the field when absent", () => {
  const root = makeRepo();
  fs.mkdirSync(path.dirname(postReviewPath(root)), { recursive: true });
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({
      pending: [
        { commit: "a".repeat(40), role: "improve", summary: "s", enqueuedAt: 42 },
        { commit: "b".repeat(40), role: "improve", summary: "t", enqueuedAt: "yesterday" },
        { commit: "c".repeat(40), role: "improve", summary: "u" },
      ],
    }),
  );
  assert.deepEqual(readPostReviews(root), [
    { commit: "a".repeat(40), role: "improve", summary: "s", enqueuedAt: 42 },
    { commit: "b".repeat(40), role: "improve", summary: "t" },
    { commit: "c".repeat(40), role: "improve", summary: "u" },
  ]);
});

test("addPostReview stamps enqueuedAt and a re-queued entry and a failed run keep it", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "x.txt"), "x");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "add x");
  const commit = headSha(root);
  // A first add with a fixed now stamps that instant; a re-add of the same commit keeps it.
  addPostReview(root, { commit, role: "improve", summary: "add x" }, 1_000);
  assert.deepEqual(readPostReviews(root), [{ commit, role: "improve", summary: "add x", enqueuedAt: 1_000 }]);
  addPostReview(root, { commit, role: "improve", summary: "add x" }, 5_000);
  assert.deepEqual(readPostReviews(root), [{ commit, role: "improve", summary: "add x", enqueuedAt: 1_000 }]);
  // A verdict-less run through drainPostReviews preserves the original stamp on the kept entry.
  const ctx = {
    root,
    mainBranch: "main",
    liveConfig: defaultConfig(),
    runners: [fakeRunner("improve", "")],
    semaphore: new Semaphore(2),
    signal: new AbortController().signal,
    startHeld: () => false,
  } as unknown as MergePipelineContext;
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const kept = readPostReviews(root);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.enqueuedAt, 1_000);
});



test("the poll drains a fleet-scale queue in FIFO order, reviewing each commit exactly once", async () => {
  // reviewer-as-regular-role part 2a/4: post-merge review was built for three slow maintenance
  // roles; bugfix/readme/organize (part 1/4) raise its volume. The one-at-a-time poll must
  // review every queued commit exactly once, oldest first, and empty the file.
  const root = makeRepo(); // already has a root "seed" commit
  const roles = ["bugfix", "readme", "organize", "clean"];
  const queued: { commit: string; role: string; summary: string }[] = [];
  for (let i = 0; i < 10; i++) {
    fs.appendFileSync(path.join(root, "seed.txt"), `change ${i}\n`);
    sh(root, "git", "add", "--", "seed.txt");
    sh(root, "git", "commit", "-m", `change ${i}`);
    queued.push({ commit: headSha(root), role: roles[i % roles.length]!, summary: `change ${i}` });
  }
  // seed postReviewPath directly so the queue order is exactly the array order
  fs.mkdirSync(path.dirname(postReviewPath(root)), { recursive: true });
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: queued }));
  const runners = roles.map((role) => fakeRunner(role, "VERDICT: approve\n1. fine"));
  const ctx = {
    root,
    mainBranch: "main",
    liveConfig: defaultConfig(),
    runners,
    semaphore: new Semaphore(2),
    signal: new AbortController().signal,
    startHeld: () => false,
  } as unknown as MergePipelineContext;
  // Drive the poll, one review at a time, until the queue empties; a permit is free right now
  // so each poll starts the next review.
  const p = newMergePipeline();
  for (let i = 0; i < 100 && readPostReviews(root).length > 0; i++) {
    drainPostReviews(ctx, p);
    if (p.postReview) await p.postReview.promise;
    else await sleep(5);
  }
  assert.equal(readPostReviews(root).length, 0, "the queue drains");
  const started = eventsOfType(root, "review_start").map((e) => e.head);
  assert.deepEqual(started, queued.map((q) => q.commit), "reviews run in queue (FIFO) order");
  assert.equal(new Set(started).size, 10, "no queued commit is reviewed twice");
  assert.equal(eventsOfType(root, "review_verdict").length, 10, "every reviewed commit got a verdict");
});

test("a queued rejection is neither re-reviewed nor reverted while the poll reviews the first unreviewed commit", async () => {
  // With an unreviewed entry both ahead of and behind a rejected one, the review picks the first
  // UNREVIEWED entry in queue order, so the rejected one is neither re-reviewed nor reordered — and
  // (Forward, never back 1/6) it never fills the revert slot either.
  const root = makeRepo(); // already has a root "seed" commit
  const commits: string[] = [];
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(path.join(root, "seed.txt"), `change ${i}\n`);
    sh(root, "git", "add", "--", "seed.txt");
    sh(root, "git", "commit", "-m", `change ${i}`);
    commits.push(headSha(root));
  }
  const [a, rejectedB, c] = commits;
  fs.mkdirSync(path.dirname(postReviewPath(root)), { recursive: true });
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({
      pending: [
        { commit: a, role: "improve", summary: "a" },
        { commit: rejectedB, role: "improve", summary: "b", rejected: ["breaks the contract"] },
        { commit: c, role: "improve", summary: "c" },
      ],
    }),
  );
  const runner = fakeRunner("improve", "VERDICT: approve\n1. fine");
  const ctx = {
    root,
    mainBranch: "main",
    liveConfig: defaultConfig(),
    runners: [runner],
    semaphore: new Semaphore(2),
    signal: new AbortController().signal,
    startHeld: () => false,
  } as unknown as MergePipelineContext;
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_start")[0]?.head, a, "FIFO: the first unreviewed commit is picked, skipping the rejected one");
  const kept = readPostReviews(root);
  const b = kept.find((e) => e.commit === rejectedB)!;
  assert.deepEqual(b.rejected, ["breaks the contract"], "the rejected entry stays recorded, never re-reviewed");
});

test("a verdict-less review past the failure limit drops the entry, warns, and starts no revert", async () => {
  // POST_REVIEW_FAILURE_LIMIT runs with no verdict drop the review; the failure is the
  // reviewer's, not the change's, so the commit stays on main unreviewed and nothing reverts.
  const { root, runner, ctx } = setup(""); // a reviewer that runs but returns no verdict
  // setup's commit is the repo's root (no parent), whose diff fails; give the review a real
  // commit with a parent so the reviewer genuinely runs and just returns no verdict.
  fs.appendFileSync(path.join(root, "x.txt"), "more\n");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "more");
  const commit = headSha(root);
  const reviews = countReviews(runner);
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({ pending: [{ commit, role: "improve", summary: "more", failures: POST_REVIEW_FAILURE_LIMIT - 1 }] }),
  );
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(reviews.count, 1, "one verdict-less review ran");
  assert.equal(readPostReviews(root).length, 0, "the entry is dropped");
  assert.ok(
    eventsOfType(root, "warning")
      .map((e) => String(e.message))
      .some((m) => m.includes("stays on main unreviewed")),
    "the drop warns that the commit stays on main unreviewed",
  );
  const bugs = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  assert.equal(bugs.split("### post-merge review of").length - 1, 1, "exactly one BUGS.md Open entry is filed for the dropped review");
  assert.match(bugs, new RegExp(`post-merge review of ${shortSha(commit)} never reached a verdict`), "the filed entry names the dropped commit's short sha");
  assert.match(bugs, /more/, "the filed entry's body names the reviewed commit's summary");
});

test("a dirty BUGS.md skips the dropped-review filing but still drops the review", async () => {
  // A filing problem (here a BUGS.md with uncommitted changes) never prevents the entry from
  // being dropped and never throws out of the drain.
  const { root, ctx } = setup(""); // a reviewer that runs but returns no verdict
  fs.appendFileSync(path.join(root, "x.txt"), "more\n");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "more");
  const commit = headSha(root);
  const seeded = "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n";
  fs.writeFileSync(path.join(root, "BUGS.md"), seeded);
  sh(root, "git", "add", "--", "BUGS.md");
  sh(root, "git", "commit", "-m", "seed bugs");
  fs.appendFileSync(path.join(root, "BUGS.md"), "\nstray edit\n"); // BUGS.md is now dirty
  const dirty = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({ pending: [{ commit, role: "improve", summary: "more", failures: POST_REVIEW_FAILURE_LIMIT - 1 }] }),
  );
  const commitsBefore = sh(root, "git", "rev-list", "--count", "HEAD");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(readPostReviews(root).length, 0, "the entry is dropped despite the skipped filing");
  assert.equal(sh(root, "git", "rev-list", "--count", "HEAD"), commitsBefore, "no filing commit was made");
  assert.equal(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), dirty, "the dirty BUGS.md is left untouched");
});

test("postMergeRejectionCounts groups a day's post-merge rejections and ignores pre-merge ones", () => {
  const events: HarnessEvent[] = [
    { ts: 1, source: "bugfix", type: "review_rejected", afterMerge: true }, // 1 of 2 bugfix
    { ts: 2, source: "bugfix", type: "review_rejected", afterMerge: true }, // 2 of 2 bugfix
    { ts: 3, source: "clean", type: "review_rejected", afterMerge: true }, // 1 of 1 clean
    { ts: 4, source: "coverage", type: "review_rejected" }, // pre-merge: afterMerge absent
    { ts: 5, source: "coverage", type: "review_rejected", afterMerge: false }, // pre-merge: afterMerge false
    { ts: 6, source: "bugfix", type: "review_verdict", afterMerge: true }, // a verdict, not a rejection
  ];
  assert.deepEqual(postMergeRejectionCounts(events), [
    { role: "bugfix", count: 2 },
    { role: "clean", count: 1 },
  ]);
});

test("postMergeRejectionCounts folds instance runner ids into their base role", () => {
  const events: HarnessEvent[] = [
    { ts: 1, source: "bugfix", type: "review_rejected", afterMerge: true },
    { ts: 2, source: "bugfix-2", type: "review_rejected", afterMerge: true },
    { ts: 3, source: "bugfix-5", type: "review_rejected", afterMerge: true },
    { ts: 4, source: "clean", type: "review_rejected", afterMerge: true },
  ];
  // One base role's churn is one row, matching `review.afterMerge`'s base-role keys and the
  // alert's "narrow the noisy role" remedy, instead of splitting `bugfix`/`bugfix #2`/`bugfix #5`.
  assert.deepEqual(postMergeRejectionCounts(events), [
    { role: "bugfix", count: 3 },
    { role: "clean", count: 1 },
  ]);
});

/** A post-merge reviewer that repairs what it rejected: writes `x.txt` into the review worktree
 * and replies with a `FIX:` line alongside a rejecting verdict (Forward never back 1a/6). */
function fixingRunner(role: string): RoleRunner {
  return {
    role,
    baseRole: role,
    state: freshRunnerState(role),
    runGatePi: async (opts: { cwd: string }) => {
      fs.writeFileSync(path.join(opts.cwd, "x.txt"), "fixed\n");
      return { ok: true, verdictText: "VERDICT: reject\n1. breaks the contract\nFIX: x.txt" };
    },
  } as unknown as RoleRunner;
}

test("the harness commits and lands a reviewer's edit as one fix", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve")];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  // main fast-forwarded to exactly one new commit whose parent is the reviewed commit.
  const tip = headSha(root);
  assert.equal(sh(root, "git", "rev-parse", `${tip}^`).trim(), commit, "the fix's parent is the reviewed commit");
  const subject = sh(root, "git", "log", "-1", "--format=%s", tip).trim();
  assert.match(subject, new RegExp(`^tumwater\\(reviewer\\): Fix ${commit.slice(0, 8)}`));
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "fixed\n", "the repair landed on main");
  // The reviewed commit's verdict is still recorded before the fix-forward.
  assert.equal(eventsOfType(root, "review_rejected").length, 1);
  assert.equal(eventsOfType(root, "review_rejected")[0]!.head, commit);
  // The entry settles `fixed` naming both shas, the landed fix is re-queued as a new post-review
  // entry so the next iteration reviews it (Forward never back 2/6); the review-fix ref is gone.
  const settled = readPostReviews(root);
  assert.equal(settled.length, 2, "the reviewed entry settles fixed and the landed fix is a new post-review entry");
  const fixedRec = settled.find((e) => e.commit === commit)!;
  assert.equal(fixedRec.fixed, tip);
  const fixEntry = settled.find((e) => e.commit === tip)!;
  assert.ok(fixEntry, "the landed fix is re-queued as its own entry");
  assert.equal(fixEntry.rejected, undefined, "the re-queued fix is pending (not rejected)");
  assert.equal(fixEntry.fixed, undefined, "the re-queued fix is pending (not yet settled)");
  assert.equal(fixEntry.summary, "add x", "the re-queued fix entry keeps the reviewed change's summary");
  // The fix commit carries the reviewed commit's round + 1: no Revision trailer on the reviewed
  // commit (round 0), so the fix is round 1.
  assert.match(sh(root, "git", "log", "-1", "--format=%B", tip).trim(), /^Revision: 1$/m, "the fix carries the next revision round");
  assert.equal(sh(root, "git", "for-each-ref", reviewFixRef(commit)).trim(), "", "the review-fix ref is deleted once the merge settles");
});

test("a fix that lands on a main which moved under the review records the actually-merged sha", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  // The reviewer advances main (another role's commit lands) while the review is in flight, then
  // returns its fix: mergeToMain rebases the fix onto the moved tip, so the landed commit is a
  // different sha than the pre-rebase fix — and `fixed` must name that actually-merged commit
  // (from the landed merge's `merged` event), not the fix commit the review created.
  (ctx as { runners: RoleRunner[] }).runners = [
    {
      role: "improve",
      baseRole: "improve",
      state: freshRunnerState("improve"),
      runGatePi: async (opts: { cwd: string }) => {
        fs.writeFileSync(path.join(root, "y.txt"), "other\n");
        sh(root, "git", "add", "-A");
        sh(root, "git", "commit", "-m", "another role lands concurrently");
        fs.writeFileSync(path.join(opts.cwd, "x.txt"), "fixed\n");
        return { ok: true, verdictText: "VERDICT: reject\n1. breaks the contract\nFIX: x.txt" };
      },
    } as unknown as RoleRunner,
  ];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const tip = headSha(root);
  // The fix rebased onto the concurrent commit, not the reviewed commit: main moved under the
  // review, so the landed sha differs from the pre-rebase fix sha.
  assert.notEqual(sh(root, "git", "rev-parse", `${tip}^`).trim(), commit, "the fix rebased onto the moved main");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "fixed\n", "the repair landed on main");
  assert.equal(fs.readFileSync(path.join(root, "y.txt"), "utf8"), "other\n", "the concurrent commit is preserved under the fix");
  const settled = readPostReviews(root);
  assert.equal(settled.length, 2, "the landed fix is also re-queued as a new post-review entry");
  const fixedRec = settled.find((e) => e.fixed !== undefined)!;
  assert.equal(fixedRec.fixed, tip, "fixed names the actually-rebased landed commit, not the pre-rebase fix");
  const merged = eventsOfType(root, "merged").slice(-1)[0]!;
  assert.equal(merged.commit, tip, "the landed merge's event recorded the merged sha");
});

test("a fix whose landing fails keeps the entry and leaves main unmoved", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve")];
  // Dirty the primary checkout's x.txt so the fix's fast-forward is refused: main stays put and
  // the entry is kept (failure recorded) for the next poll's retry.
  fs.writeFileSync(path.join(root, "x.txt"), "local\n");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(headSha(root), commit, "main stays at the reviewed commit");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "local\n");
  const kept = readPostReviews(root);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.fixed, undefined, "no fix is recorded on a failed landing");
  assert.match(kept[0]!.lastFailure ?? "", /fix did not merge/);
  assert.ok(eventsOfType(root, "warning").some((e) => String(e.message).includes("could not merge")), "the failed landing warns");
});

test("a reviewer's fix commit carries the next revision round", async () => {
  const { root, ctx } = setup("VERDICT: reject\n1. still broken");
  // The reviewed commit is itself a round-1 fix whose body carries `Revision: 1`; the next fix
  // the reviewer makes must carry `Revision: 2` — one past the reviewed commit's round — so the
  // self-fix chain counts toward the shared REVISION_BACKSTOP (Forward never back 2/6).
  fs.appendFileSync(path.join(root, "x.txt"), "more\n");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "the fix\n\nRevision: 1");
  const commit = headSha(root);
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit, role: "improve", summary: "add x" }] }));
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve")];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const tip = headSha(root);
  assert.notEqual(tip, commit, "a new fix landed on top of the round-1 fix");
  assert.match(sh(root, "git", "log", "-1", "--format=%B", tip).trim(), /^Revision: 2$/m, "the next fix carries one past the reviewed commit's round");
});

test("a self-fix chain stops at the backstop and clears the entry", async () => {
  const { root, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  // The reviewed commit is a round-5 fix — one short of REVISION_BACKSTOP (6) — so the next fix
  // would be round 6, where the chain must stop: the reviewer records its surviving reasons
  // instead of another fix landing. The answered plan lives under `## Done` (its implementation
  // landed and was archived before the reviewed commit), not `## Planned`, so there is nothing
  // to hold — the real post-merge flow never has a live `## Planned` entry for a reviewed
  // commit (Forward never back 2/6).
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    "# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### The shipped plan (planned 2026-10-24 by user) — done 2026-10-24 by user\n\nBody.\n",
  );
  fs.appendFileSync(path.join(root, "x.txt"), "more\n");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "fix\n\nRevision: 5");
  const commit = headSha(root);
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({ pending: [{ commit, role: "improve", summary: "add x" }] }),
  );
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve")];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(headSha(root), commit, "no fix commit is created at the backstop — main stays at the reviewed commit");
  assert.equal(sh(root, "git", "for-each-ref", reviewFixRef(commit)).trim(), "", "no review-fix ref points anywhere");
  assert.equal(readPostReviews(root).length, 0, "the exhausted entry is cleared");
  assert.ok(!fs.readFileSync(path.join(root, "PLANS.md"), "utf8").includes("**Needs review"), "no hold note is fabricated: a landed-and-archived plan has nothing to hold");
});

test("a fix whose conflict resolution diverges outside the fix is withheld (recheckResolved retry)", async () => {
  const { root, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  // The fix edits x.txt, and a concurrent main commit also rewrites x.txt during the review, so
  // landing the fix rebases onto a conflicting main. The merge conflict resolver then resolves
  // it with bytes outside the reviewed fix's scope ("sneaky extra" is a line the fix never
  // added), so mergeReviewerFix's recheckResolved ({"verdict":"retry"}) withholds the landing
  // and main stays unmoved: a resolution the reviewer never judged must not merge on the
  // in-lock build check alone (BUGS.md 2026-10-01).
  let concurrent: string | undefined;
  let resolverRuns = 0;
  (ctx as { runners: RoleRunner[] }).runners = [
    {
      role: "improve",
      baseRole: "improve",
      state: freshRunnerState("improve"),
      runGatePi: async (opts: { cwd: string }) => {
        fs.writeFileSync(path.join(root, "x.txt"), "main\n");
        sh(root, "git", "add", "--", "x.txt");
        sh(root, "git", "commit", "-m", "main lands a conflicting edit");
        concurrent = headSha(root);
        fs.writeFileSync(path.join(opts.cwd, "x.txt"), "fixed\n");
        return { ok: true, verdictText: "VERDICT: reject\n1. breaks the contract\nFIX: x.txt" };
      },
      runMergePi: async (wt: string) => {
        resolverRuns++;
        fs.writeFileSync(path.join(wt, "x.txt"), "fixed\nsneaky extra\n");
        return piRunResult({ finalText: "resolved" });
      },
    } as unknown as RoleRunner,
  ];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(headSha(root), concurrent, "main stays at the concurrent commit — the fix never lands");
  assert.equal(resolverRuns, 1, "the conflict path ran the resolver exactly once");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "main\n", "the diverging resolution never reaches main");
  const kept = readPostReviews(root);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.fixed, undefined, "no fix is recorded on a withheld landing");
  assert.match(kept[0]!.lastFailure ?? "", /fix did not merge: merge_conflict/);
});

test("a fix whose landing keeps failing is dropped at POST_REVIEW_FAILURE_LIMIT", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve")];
  fs.writeFileSync(path.join(root, "x.txt"), "local\n"); // every landing is refused fast-forward
  for (let i = 0; i < POST_REVIEW_FAILURE_LIMIT; i++) {
    const p = newMergePipeline();
    drainPostReviews(ctx, p);
    await p.postReview!.promise;
  }
  assert.ok(await isMergedInto(root, commit, "main"), "the reviewed commit stays on main");
  const kept = readPostReviews(root);
  assert.equal(kept.length, 0, "the review is dropped once fix landings hit POST_REVIEW_FAILURE_LIMIT");
  assert.ok(
    eventsOfType(root, "warning").some((e) => String(e.message).includes("dropping the post-merge review of")),
    "the drop warns with the dropped-post-reviews marker",
  );
  assert.ok(await isMergedInto(root, commit, "main"), "the reviewed commit stays on main after the BUGS.md filing");
  assert.equal(
    sh(root, "git", "for-each-ref", reviewFixRef(commit)).trim(),
    "",
    "the review-fix ref is deleted when a fix is dropped at the limit",
  );
  const bugs = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  assert.equal(bugs.split("### post-merge review of").length - 1, 1, "exactly one BUGS.md Open entry is filed for the dropped review");
  assert.match(bugs, new RegExp(`post-merge review of ${shortSha(commit)} never reached a verdict`), "the filed entry names the dropped commit's short sha");
  assert.match(bugs, /add x/, "the filed entry's body names the reviewed commit's summary");
});
