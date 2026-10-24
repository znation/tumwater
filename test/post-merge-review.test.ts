import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { drainPostReviews } from "../src/merge/merge-post-review.js";
import { drainMerge } from "../src/merge/merge-drain.js";
import { newMergePipeline, type MergePipelineContext } from "../src/merge/merge-pipeline.js";
import { addPostReview, readPostReviews, POST_REVIEW_FAILURE_LIMIT, postMergeRejectionCounts } from "../src/review/post-merge-review.js";
import type { HarnessEvent } from "../src/events/events.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { postReviewPath, rejectedRefName } from "../src/paths.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { gateFixture, reviewGate } from "./fixtures/gate-fixtures.js";
import { headSha, makeRepo, pinOffMain, sh } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { piRanMarker, reviewerStub, withPi } from "./fakes/fake-pi.js";
import { APPROVE, drained, entry, makePipeline, pinnedCommit, pumpUntil, runnersFor } from "./fixtures/merge-fixtures.js";
import { enqueueMerge } from "../src/merge/merge-queue.js";
import { mergeRefName } from "../src/paths.js";
import { setRef } from "../src/git/git.js";
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

test("a listed role's change passes the gate with no reviewer run; an unlisted role's is reviewed", async () => {
  const { root, wt } = await gateFixture();
  const config = { ...defaultConfig(), review: { ...defaultConfig().review, afterMerge: ["improve"] } };
  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const { result } = await reviewGate(root, wt, { config });
    assert.equal(result.decision, "approved");
    assert.ok(!fs.existsSync(marker), "the reviewer must not run before the merge");
    assert.equal(eventsOfType(root, "review_start").length, 0);
    await reviewGate(root, wt);
    assert.ok(fs.existsSync(marker));
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

/** Polls until the async revert skip check has filled the revert slot. */
async function drainUntilRevert(ctx: MergePipelineContext, p: ReturnType<typeof newMergePipeline>): Promise<void> {
  for (let i = 0; i < 200 && p.revert === null; i++) {
    drainPostReviews(ctx, p);
    await sleep(10);
  }
}

test("an approving post-merge review ends the entry and logs afterMerge events", async () => {
  const { root, ctx } = setup("VERDICT: approve\n1. fine");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(readPostReviews(root).length, 0);
  assert.equal(eventsOfType(root, "review_verdict")[0]?.afterMerge, true);
});

test("a rejecting post-merge review reverts the commit and hands it back as a revision", async () => {
  const { root, commit, runner, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_rejected")[0]?.afterMerge, true);
  await drainUntilRevert(ctx, p); // the rejection moves to the revert slot
  assert.equal(p.revert?.commit, commit);
  drainMerge(ctx, p);
  await p.merge!.promise;
  assert.equal(readPostReviews(root).length, 0);
  assert.ok(!fs.existsSync(path.join(root, "x.txt")));
  assert.equal(runner.state.revision?.sha, commit);
  assert.match(runner.state.lastReview?.reasons[0] ?? "", /breaks the contract/);
  assert.equal(sh(root, "git", "rev-parse", rejectedRefName("improve")).trim(), commit);
});

test("a post-merge rejection of an already-archived entry restores the live entry and fetches the revision", async () => {
  // The commit-time archive sweep (archiveNewFinishedEntries, src/backlog/backlog-archive.ts) moves
  // a finished `## Planned` entry out of the live file and into the archive on merge. A post-merge
  // rejection must not strand that change: reverting the merged commit restores the live entry, and
  // handBackReverted gives the author a revision carrying the reviewer's reasons.
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
  await drainUntilRevert(ctx, p); // the rejection moves to the revert slot
  assert.equal(p.revert?.commit, commit);
  drainMerge(ctx, p);
  await p.merge!.promise;
  assert.equal(readPostReviews(root).length, 0);
  // The live entry is back under `## Planned`, not stranded in the finished section, and the
  // archive file the merged commit created is gone with the revert.
  const plans = fs.readFileSync(path.join(root, "PLANS.md"), "utf8");
  assert.match(plans, /## Planned\n\n### The archived entry/);
  assert.ok(plans.includes("## Done\n\n_None yet._"), "the archived entry is not stranded in the finished section");
  assert.ok(!fs.existsSync(path.join(root, "PLANS-DONE.md")), "the archive file the merged commit created is gone with the revert");
  assert.equal(runner.state.revision?.sha, commit);
  assert.match(runner.state.lastReview?.reasons[0] ?? "", /the change must not land/);
  assert.equal(sh(root, "git", "rev-parse", rejectedRefName("improve")).trim(), commit);
});

test("a rejected entry stays queued until its revert ran: a replaced revert slot is refilled next poll", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  await drainUntilRevert(ctx, p);
  assert.equal(p.revert?.commit, commit);
  assert.equal(readPostReviews(root).length, 1, "the rejection is kept while the slot holds it");
  p.revert = null as typeof p.revert; // the main-red watch replaced the slot, or a shutdown dropped it
  await drainUntilRevert(ctx, p);
  assert.equal(p.revert?.commit, commit, "the next poll puts it back");
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

/** Merges a listed role's commit that touches `file`; returns the root once the merge drained. */
async function mergeListed(file: string, review: { enabled: boolean }): Promise<string> {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, file), "work\n"), "work by improve", { reset: true });
  await setRef(root, mergeRefName("improve"), sha);
  enqueueMerge(root, entry("improve", sha));
  const base = defaultConfig();
  const config = { ...base, review: { ...base.review, ...review, afterMerge: ["improve"] } };
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

test("a failed post-review.json write after a revert warns and still frees the merge slot", async () => {
  const { root, ctx } = setup("VERDICT: reject\n1. bad");
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  await drainUntilRevert(ctx, p);
  assert.ok(p.revert);
  const undo = failRenameSyncOn(postReviewPath(root), "pr write refused");
  try {
    drainMerge(ctx, p);
    await p.merge!.promise;
  } finally {
    undo();
  }
  assert.equal(p.merge, null);
  assert.equal(readPostReviews(root).length, 1);
  const warnings = eventsOfType(root, "warning").filter((e) => e.source === "tumwater");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]!.message), /pr write refused/);
});

test("a failed post-review.json write in the revert skip check still logs why it does not revert", async () => {
  const { root, commit, ctx } = setup("VERDICT: approve\n1. fine");
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({ pending: [{ commit, role: "director", summary: "s", rejected: ["r"] }] }),
  );
  const p = newMergePipeline();
  const undo = failRenameSyncOn(postReviewPath(root), "pr write refused");
  try {
    drainPostReviews(ctx, p);
    const messages = () => eventsOfType(root, "warning").map((e) => String(e.message));
    for (let i = 0; i < 200 && !messages().some((m) => m.includes("not reverting")); i++) await sleep(10);
    assert.ok(messages().some((m) => m.includes("not reverting")));
    assert.ok(messages().some((m) => m.includes("pr write refused")));
  } finally {
    undo();
  }
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

test("a queued rejection fills the revert slot while the poll reviews the first unreviewed commit", async () => {
  // The rejected-first branch of drainPostReviews: with an unreviewed entry both ahead of and
  // behind a rejected one, the rejected commit routes to the revert slot (checked first) and the
  // review picks the first UNREVIEWED entry in queue order, so it is neither re-reviewed nor
  // reordered.
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
  await drainUntilRevert(ctx, p);
  assert.equal(p.revert?.commit, rejectedB, "the rejected entry fills the revert slot");
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
  assert.equal(p.revert, null, "dropping a review starts no revert");
  assert.ok(
    eventsOfType(root, "warning")
      .map((e) => String(e.message))
      .some((m) => m.includes("stays on main unreviewed")),
    "the drop warns that the commit stays on main unreviewed",
  );
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
