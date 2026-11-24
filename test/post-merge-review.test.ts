import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { FALLBACK_REVIEW_TIMEOUT_S, REVIEW_TIMEOUT_S } from "../src/config/config-views.js";
import { validateConfig } from "../src/config/config-validation.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { drainPostReviews, reviewBackoffMs } from "../src/merge/merge-post-review-drain.js";
import { newMergePipeline, type MergePipelineContext } from "../src/merge/merge-pipeline.js";
import { addPostReview, readPostReviews, POST_REVIEW_FAILURE_LIMIT, postMergeRejectionCounts, reviewMergedCommit } from "../src/review/post-merge-review.js";
import { logEvent, subscribeEvents, type HarnessEvent } from "../src/events/events.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { RunUsage } from "../src/run/run-usage.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { postReviewPath, reviewFixRef } from "../src/paths.js";
import { HOLD_BASE_MS, HOLD_CAP_MS } from "../src/team/team-hold.js";
import { shortSha } from "../src/text/format.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { gateFixture, reviewGate } from "./fixtures/gate-fixtures.js";
import { headSha, makeRepo, pinOffMain, sh } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { piRanMarker, piRunResult, withPi, withReviewerStub } from "./fakes/fake-pi.js";
import { APPROVE, makePipeline, pinDrained, pinnedCommit, pumpUntil, runnersFor } from "./fixtures/merge-fixtures.js";
import { mergeRefName } from "../src/paths.js";
import { isMergedInto, setRef } from "../src/git/git.js";
import { sleep } from "./helpers/wait.js";
import { UNSTARTABLE_GIT_ARG } from "./helpers/git-faults.js";
import { entryHold } from "../src/backlog/backlog-eligibility.js";
import { openBugEntries } from "../src/backlog/backlog.js";

test("review.afterMerge is removed: the default carries no list and a config naming it is refused", () => {
  // The retired key is gone from the default: every merged commit is now reviewed (part 3d/3).
  assert.equal("afterMerge" in defaultConfig().review, false);
  // A hand-written config that still names it is refused by name, exactly as the retired
  // maxConcurrentPerProvider key was — it is gone, not tolerated.
  assert.throws(() => validateConfig({ review: { afterMerge: ["bugfix"] } }), /unknown key "afterMerge" in review/);
});

test("the tracked tumwater.example.json carries no afterMerge", () => {
  const example = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tumwater.example.json"), "utf8")) as {
    review?: Record<string, unknown>;
  };
  assert.equal("afterMerge" in (example.review ?? {}), false, "the example never names the retired key");
});

test("all roles pass the gate with no reviewer run before the merge", async () => {
  // The pre-merge gate is deterministic (part 3h/3): with the reviewer gone before the merge,
  // every role passes the gate with the pi-run marker absent and no `review_start`; the
  // post-merge review that follows is covered below.
  const { root, wt } = await gateFixture();
  const marker = piRanMarker();
  await withReviewerStub(marker, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "approved");
    assert.ok(!fs.existsSync(marker), "the reviewer must not run before the merge");
    assert.equal(eventsOfType(root, "review_start").length, 0);
    const second = await reviewGate(root, wt);
    assert.equal(second.result.decision, "approved");
    assert.ok(!fs.existsSync(marker), "a second role's change also passes with no reviewer run");
    assert.equal(eventsOfType(root, "review_start").length, 0);
  });
});

function fakeRunner(role: string, verdict: string): RoleRunner {
  return {
    role,
    baseRole: role,
    state: freshRunnerState(role),
    runGatePi: async () => ({ ok: true, verdictText: verdict }),
    // No-op fold: a minimal fake stands in for the author, and startPostReview folds the
    // reviewer's final run into it (BUGS.md 2026-11-16) — the no-op keeps the fold a no-op for
    // these verdict-shape tests, which assert nothing about the author's usage.
    foldMergeUsage: () => {},
  } as unknown as RoleRunner;
}

function setup(verdict: string, initialFile = "x") {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "x.txt"), initialFile);
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

test("a post-merge review's final run is folded into the author's usage and failure stamps (regression, BUGS.md 2026-11-16)", async () => {
  // The post-merge review's final run was never folded into the authoring role: runGatePi folds
  // only a RETRIED first attempt, and the pre-merge gate folds its final run (merge-core)
  // while the post-merge path did not. So a review that ended on a 429 left the author's
  // lastRateLimit unset and its cost unchanged — maxDailyCostUsd undercounted review spend, and
  // a quota wall on the reviewer never fed the team failure hold. A real RunUsage (the
  // production accounting) makes the fold observable: the run's cost lands in usage.costUsd and
  // the 429 stamps lastRateLimit, the two things the drain leaves behind.
  const { root, ctx } = setup("VERDICT: approve\n1. fine");
  const usage = new RunUsage();
  const state = freshRunnerState("improve");
  const author = {
    role: "improve",
    baseRole: "improve",
    state,
    // The reviewer's final run ends on a 429 with a known cost (a failed, verdict-less run).
    runGatePi: async () => piRunResult({ ok: false, transientRateLimit: true, costUsd: 1.5, retryAfterSeconds: 300 }),
    foldMergeUsage: (run: PiRunResult, provider?: string, pair?: string) => usage.fold(state, run, false, provider, pair),
  } as unknown as RoleRunner;
  (ctx as { runners: RoleRunner[] }).runners = [author];
  // A distinct reviewer seam (provider "prov") so the stamp's provider is a known, non-top-level
  // value — proof the fold ran on the reviewer's own seam, not a coincident one.
  ctx.liveConfig.review = { enabled: true, exemptPaths: ["*.md"], provider: "prov", model: "prov/reviewer" };
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  // The review ran and ended on the 429; the drain keeps the entry uncounted (BUGS.md 2026-11-09).
  assert.equal(eventsOfType(root, "review_start").length, 1, "the post-merge review ran");
  assert.equal(readPostReviews(root)[0]?.failures ?? 0, 0, "the transient failure is not counted (existing guarantee)");
  // The final run's usage reached the author: its cost, and the 429 stamp under the reviewer seam.
  assert.equal(usage.costUsd, 1.5, "the review's cost reached the author's usage counters");
  assert.equal(usage.lastRateLimit?.provider, "prov", "the 429 stamps the author under the reviewer's seam");
  assert.equal(usage.lastRateLimit?.retryAfterSeconds, 300, "the 429's retry-after hint rides the stamp");
});

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
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
    await pumpUntil(
      ctx,
      pipeline,
      () => pinDrained(root, pipeline, ["improve"])() && pipeline.postReview === null && eventsOfType(root, "review_verdict").length > 0,
      "the merge and its post-merge review",
    );
    assert.equal(eventsOfType(root, "merged").length, 1);
    const verdict = eventsOfType(root, "review_verdict")[0]!;
    assert.equal(verdict.afterMerge, true);
    assert.equal(verdict.head, sh(root, "git", "rev-parse", "main").trim());
    assert.equal(readPostReviews(root).length, 0);
  });
});

/** Merges a commit from `improve` that touches `file`; returns the root once the merge
 * drained. Part 3g/3 makes review-after-landing a property of every change rather than of an
 * afterMerge list, so the exempt and disabled gates are what these cases hold against,
 * whatever the role. */
async function mergeListed(file: string, review: { enabled: boolean }): Promise<string> {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, file), "work\n"), "work by improve", { reset: true });
  await setRef(root, mergeRefName("improve"), sha);
  const base = defaultConfig();
  const config = { ...base, review: { ...base.review, ...review } };
  await withPi(APPROVE(), async () => {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"], undefined, config), { config });
    await pumpUntil(ctx, pipeline, pinDrained(root, pipeline, ["improve"]), "the merge");
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

test("a post-merge review of a large diff runs under a larger budget than a small one", async () => {
  // The recurring verdict-less-by-timeout gap: a progressing review of a large diff was killed
  // at the load-only 2× cap. The reviewer's wall-clock budget now tracks the diff's size as
  // well as host load (reviewRunConfig's diffBytes), so a large diff's run receives a larger
  // runTimeoutSeconds than a small one's. Asserted through the config the reviewer run is
  // handed, offline — no real run, no host load.
  const root = makeRepo();
  // A diff well above REVIEW_DIFF_REFERENCE_BYTES.
  const big = "x".repeat(500_000);
  fs.writeFileSync(path.join(root, "big.txt"), big);
  sh(root, "git", "add", "--", "big.txt");
  sh(root, "git", "commit", "-m", "add big");
  const commit = headSha(root);
  const captured: { runTimeoutSeconds?: number }[] = [];
  const runner = fakeRunner("improve", "VERDICT: approve\n1. fine");
  const orig = runner.runGatePi;
  runner.runGatePi = (opts) => {
    captured.push({ runTimeoutSeconds: opts.config?.runTimeoutSeconds });
    return orig.call(runner, opts);
  };
  const ctx = {
    root,
    mainBranch: "main",
    liveConfig: defaultConfig(),
    runners: [runner],
    semaphore: new Semaphore(2),
    signal: new AbortController().signal,
    startHeld: () => false,
  } as unknown as MergePipelineContext;
  addPostReview(root, { commit, role: "improve", summary: "add big" });
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(captured.length, 1, "the reviewer ran once");
  const budget = captured[0]!.runTimeoutSeconds;
  assert.ok(budget !== undefined, "the run was handed a reviewer budget");
  assert.ok(budget > REVIEW_TIMEOUT_S, "a large diff's budget exceeds the reference budget");
  assert.ok(budget <= REVIEW_TIMEOUT_S * 4, "load and diff stretches stay within the 4x ceiling");
  // The entry still settles on the approving verdict, so the larger budget changed nothing else.
  assert.equal(readPostReviews(root).length, 0);
});

// A capturing reviewer run: records the config the review hands the run and answers approve.
type CapturingRun = (opts: { config?: { runTimeoutSeconds?: number } }) => Promise<ReturnType<typeof piRunResult>>;

test("a post-merge review's budget stretches with the reviewed diff's size", async () => {
  // makeRepo seeds one committed file, so a second commit has a parent and `git diff C^ C`
  // succeeds. The reviewer's budget is read from the runGatePi config the review hands the
  // run, so this pins that reviewMergedCommit feeds the actual reviewed diff's byte size
  // into reviewRunConfig — load-robust: it holds whatever the host's load is, since a
  // diff large enough to stretch beats the load-only 2x cap on any load.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "big.txt"), "x\n".repeat(25_000));
  sh(root, "git", "add", "--", "big.txt");
  sh(root, "git", "commit", "-m", "add a large file");
  const commit = headSha(root);
  const seen: { config?: { runTimeoutSeconds?: number } } = {};
  const runGatePi: CapturingRun = async (opts) => {
    seen.config = opts.config;
    return piRunResult({ verdictText: "VERDICT: approve\n1. fine" });
  };
  await reviewMergedCommit(
    root,
    defaultConfig(),
    { commit, role: "improve", summary: "add a large file" },
    runGatePi as Parameters<typeof reviewMergedCommit>[3],
    undefined,
  );
  const budget = seen.config?.runTimeoutSeconds;
  assert.ok(budget !== undefined, "the reviewer run received a resolved budget");
  assert.ok(budget! > REVIEW_TIMEOUT_S, `a large diff's budget beats the 900 s wall, got ${budget}`);
  assert.ok(budget! <= 4 * REVIEW_TIMEOUT_S, `the budget stays within the 4x ceiling, got ${budget}`);
});

test("a post-merge review of a small diff keeps the load-only budget", async () => {
  // The same wiring with a diff small enough not to stretch: the budget is the load-only
  // stretch, at most the 2x cap. A quiet host gives exactly today's value; on a loaded host
  // it stays within the 2x cap either way.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "tiny.txt"), "one line\n");
  sh(root, "git", "add", "--", "tiny.txt");
  sh(root, "git", "commit", "-m", "add a small file");
  const commit = headSha(root);
  const seen: { config?: { runTimeoutSeconds?: number } } = {};
  const runGatePi: CapturingRun = async (opts) => {
    seen.config = opts.config;
    return piRunResult({ verdictText: "VERDICT: approve\n1. fine" });
  };
  await reviewMergedCommit(
    root,
    defaultConfig(),
    { commit, role: "improve", summary: "add a small file" },
    runGatePi as Parameters<typeof reviewMergedCommit>[3],
    undefined,
  );
  const budget = seen.config?.runTimeoutSeconds;
  assert.ok(budget !== undefined, "the reviewer run received a resolved budget");
  assert.ok(budget! <= 2 * REVIEW_TIMEOUT_S, `a small diff's budget stays within the load-only 2x cap, got ${budget}`);
});

test("a free post-merge reviewer's budget is floored at the fallback floor, whatever the host load is", async () => {
  // Option B's remaining close: a reviewer whose own resolved seam is free (slowReviewer forced
  // true for the offline test) gets the 3600 s floor as the base the load and diff stretch from,
  // so a slow local default is not killed mid-run and re-queued. The diff is large enough to
  // stretch, and the load is sampled live, so the assertion is load-robust: the stretched
  // budget is at most 2× (load) × 2× (diff) = 4× the floor, and at least the floor itself.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "big.txt"), "x\n".repeat(25_000));
  sh(root, "git", "add", "--", "big.txt");
  sh(root, "git", "commit", "-m", "add a large file");
  const commit = headSha(root);
  const seen: { config?: { runTimeoutSeconds?: number } } = {};
  const runGatePi: CapturingRun = async (opts) => {
    seen.config = opts.config;
    return piRunResult({ verdictText: "VERDICT: approve\n1. fine" });
  };
  const outcome = await reviewMergedCommit(
    root,
    defaultConfig(),
    { commit, role: "improve", summary: "add a large file" },
    runGatePi as Parameters<typeof reviewMergedCommit>[3],
    undefined,
    true,
  );
  const budget = seen.config?.runTimeoutSeconds;
  assert.ok(budget !== undefined, "the reviewer run received a resolved budget");
  assert.ok(budget! >= FALLBACK_REVIEW_TIMEOUT_S, `a free reviewer's budget is floored at the fallback floor, got ${budget}`);
  assert.ok(budget! <= 4 * FALLBACK_REVIEW_TIMEOUT_S, `the floor's load × diff stretches stay within the 4x ceiling, got ${budget}`);
  assert.equal(outcome.kind, "approve", "the review still settles on the approving verdict");
});

test("a not-free post-merge reviewer keeps the pre-floor budget, below the fallback floor, whatever the host load is", async () => {
  // The floor's other direction: a reviewer whose seam is not free (slowReviewer forced false)
  // keeps today's budget — the 900 s base stretched by load and diff — which never reaches the
  // 3600 s floor, so a paid reviewer's wall is byte-identical to before the floor. The tiny
  // diff does not stretch, so the budget is the load-only stretch, at most the 2× cap; both
  // bounds hold on any host load.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "tiny.txt"), "one line\n");
  sh(root, "git", "add", "--", "tiny.txt");
  sh(root, "git", "commit", "-m", "add a small file");
  const commit = headSha(root);
  const seen: { config?: { runTimeoutSeconds?: number } } = {};
  const runGatePi: CapturingRun = async (opts) => {
    seen.config = opts.config;
    return piRunResult({ verdictText: "VERDICT: approve\n1. fine" });
  };
  const outcome = await reviewMergedCommit(
    root,
    defaultConfig(),
    { commit, role: "improve", summary: "add a small file" },
    runGatePi as Parameters<typeof reviewMergedCommit>[3],
    undefined,
    false,
  );
  const budget = seen.config?.runTimeoutSeconds;
  assert.ok(budget !== undefined, "the reviewer run received a resolved budget");
  assert.ok(budget! <= 2 * REVIEW_TIMEOUT_S, `a not-free reviewer's budget stays within the load-only 2x cap, got ${budget}`);
  assert.ok(budget! < FALLBACK_REVIEW_TIMEOUT_S, `a not-free reviewer's budget never reaches the fallback floor, got ${budget}`);
  assert.equal(outcome.kind, "approve", "the review still settles on the approving verdict");
});

test("a post-merge review that timed out while still making progress resumes its session on the next run (regression, BUGS.md 2026-11-18)", async () => {
  // The 2026-11-17 waste: every progressing timeout restarted the review in a fresh session, so the
  // next run re-read the same files and timed out again until the drop limit. The kept session is
  // continued instead, so the progress of one attempt carries into the next.
  const { root, ctx, runner } = setup("VERDICT: approve\n1. fine");
  const continued: boolean[] = [];
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async (opts) => {
    continued.push(opts.continueSession === true);
    return piRunResult({
      ok: false,
      timedOut: true,
      timedOutProgressing: true,
      errorMessage: "timed out after 7200s while still making progress — session and worktree edits preserved for resume",
    });
  };
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const after = readPostReviews(root)[0];
  assert.equal(after?.failures, 1, "the timed-out run still counts toward the drop limit");
  assert.equal(after?.resume, true, "the entry records that its session is kept");
  assert.equal(after?.lastFailure?.includes("worktree edits preserved"), false, "the message no longer claims the worktree edits are kept");
  const p2 = newMergePipeline();
  drainPostReviews(ctx, p2);
  await p2.postReview!.promise;
  assert.deepEqual(continued, [false, true], "the second run continues the first run's session");
});

test("a post-merge review that timed out without progress does not mark its entry for resume", async () => {
  const { root, ctx, runner } = setup("VERDICT: approve\n1. fine");
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async () =>
    piRunResult({ ok: false, timedOut: true, timedOutProgressing: false, errorMessage: "timed out after 7200s" });
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(readPostReviews(root)[0]?.resume, undefined, "a timeout with no progress keeps no session");
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

test("a post-merge review that ended on a transient provider failure keeps its entry without counting or filing (regression, BUGS.md 2026-11-09)", async () => {
  // The 2026-11-09 cascade: a Codex subscription quota wall made every review verdict-less and
  // the drain counted each run as a failure, dropping entries at the limit and filing one fake
  // BUGS.md entry per commit. A transient provider failure is a world failure, not a review
  // content failure: the entry stays queued, uncounted, unfiled.
  const { root, commit, ctx, runner } = setup("VERDICT: approve\n1. fine");
  // The reviewer's run ends on a transient rate limit with no verdict (no assistant text).
  // Install the stub first, then the counter, so the counter wraps it.
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async () =>
    piRunResult({ ok: true, transientRateLimit: true });
  const reviews = countReviews(runner);
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit, role: "improve", summary: "add x" }] }));
  // Drain repeatedly, past the old failure limit: a transient failure must never count, so the
  // entry stays queued every time (the old bug dropped it at the limit and filed a product bug).
  // The first run stamps a backoff deadline, so later polls skip the entry rather than re-run it
  // (BUGS.md 2026-11-16) — the loop awaits a started review only when one started.
  for (let i = 0; i < POST_REVIEW_FAILURE_LIMIT + 2; i++) {
    const p = newMergePipeline();
    drainPostReviews(ctx, p);
    if (p.postReview) await p.postReview.promise;
  }
  const after = readPostReviews(root);
  assert.equal(after.length, 1, "the entry stays queued — a transient failure is never dropped");
  assert.equal(after[0]?.failures ?? 0, 0, "a transient provider failure is never counted toward the drop limit");
  assert.ok(reviews.count > 0, "the reviewer did run; it was the transient outcome that was not counted");
  const bugs = fs.existsSync(path.join(root, "BUGS.md")) ? fs.readFileSync(path.join(root, "BUGS.md"), "utf8") : "";
  if (bugs) {
    const openSection = bugs.split("## Open")[1]?.split("## Fixed")[0] ?? "";
    assert.equal(/###\s/.test(openSection), false, "a transient failure never files a product bug");
  }
});

test("a post-merge review that ended on a transient provider failure is not re-run on the next poll (regression, BUGS.md 2026-11-16)", async () => {
  // Before the backoff, the infrastructure arm kept the entry exactly as it was, so the next
  // poll (a couple of seconds later) selected the same unchanged entry again and ran the review,
  // opening a fresh agent session every poll for as long as the wall held. The entry now carries
  // a backoff deadline, so the next poll skips it and picks the next due entry instead.
  const { root, ctx, runner } = setup("VERDICT: approve\n1. fine");
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async () =>
    piRunResult({ ok: true, transientRateLimit: true });
  const p = newMergePipeline();
  const t0 = Date.now();
  // First poll: the review starts and ends on the wall, stamping a backoff deadline.
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_start").length, 1, "the first poll ran the review");
  const afterFirst = readPostReviews(root)[0]!;
  assert.ok(
    afterFirst.notBeforeMs !== undefined && afterFirst.notBeforeMs > t0,
    "the transient failure stamps a future backoff deadline",
  );
  // Second poll a few seconds later, still inside the backoff: the entry is skipped and nothing
  // runs — no second review_start. Pre-fix this ran again and opened a second session.
  const p2 = newMergePipeline();
  drainPostReviews(ctx, p2);
  assert.equal(p2.postReview, null, "the second poll does not re-run a review still inside its backoff");
  await sleep(50);
  assert.equal(eventsOfType(root, "review_start").length, 1, "the transient failure is not retried on the next poll");
  const afterSecond = readPostReviews(root)[0]!;
  assert.equal(afterSecond.notBeforeMs, afterFirst.notBeforeMs, "the skipped poll leaves the deadline unchanged");
  assert.equal(afterSecond.failures ?? 0, 0, "and never counts toward the drop limit");
});

test("a 429 that carries a retry-after hint longer than the base sets the backoff from the hint", async () => {
  // The backoff is the LONGEST of the escalated base and the run's retry-after, floored to the
  // team-hold cap — the same rule the team hold uses. A 429 that says "retry after Ns" with N
  // past the base waits that long (capped); a short hint is instead floored up to the escalating
  // base so it never re-probes faster than the backoff would. Hint-less (the prior test) is just
  // the escalated base.
  const { root, ctx, runner } = setup("VERDICT: approve\n1. fine");
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async () =>
    piRunResult({ ok: true, transientRateLimit: true, retryAfterSeconds: 300 });
  const t0 = Date.now();
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const entry = readPostReviews(root)[0]!;
  assert.ok(entry.notBeforeMs !== undefined, "the 429 stamps a backoff deadline");
  const waitMs = entry.notBeforeMs! - t0;
  assert.ok(waitMs >= 290 * 1000, `the deadline is the 5-minute hint, not the 60s base, got ${waitMs}ms`);
  assert.ok(waitMs <= 310 * 1000, `the deadline is the 5-minute hint, not longer, got ${waitMs}ms`);
});

test("a later queue entry is reviewed while an entry inside its transient-failure backoff waits", async () => {
  // The skip must cost only the wall-fed entry: the drain picks the NEXT due entry, so a commit
  // queued behind a backed-off one still gets its review. Without the skip in `unreviewed`, the
  // head entry is selected again on every poll and the later commit waits behind it forever.
  const { root, commit, ctx, runner } = setup("VERDICT: approve\n1. fine");
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async () =>
    piRunResult({ ok: true, transientRateLimit: true });
  // Poll 1: the hint-less 429 takes the head entry and stamps its backoff.
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(eventsOfType(root, "review_start").length, 1, "the first poll reviewed the head entry");
  const firstStamp = readPostReviews(root).find((e) => e.commit === commit)!.notBeforeMs;
  // A second commit queues behind it (which re-writes the file, spread and all), then poll 2.
  fs.appendFileSync(path.join(root, "x.txt"), "later\n");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "later change");
  const later = headSha(root);
  addPostReview(root, { commit: later, role: "improve", summary: "later" });
  const p2 = newMergePipeline();
  drainPostReviews(ctx, p2);
  assert.ok(p2.postReview, "the drain starts a review despite the head entry being backed off");
  await p2.postReview!.promise;
  const started = eventsOfType(root, "review_start");
  assert.equal(started.length, 2, "one more review started on the second poll");
  assert.equal(started[1]?.head, later, "it is the later entry's, not the backed-off head's");
  const after = readPostReviews(root);
  assert.equal(after.length, 2, "both entries stay queued — a transient failure is never dropped or counted");
  const stillWaiting = after.find((e) => e.commit === commit)!;
  assert.equal(stillWaiting.notBeforeMs, firstStamp, "the re-run of the other entry left this entry's deadline alone");
  assert.equal(stillWaiting.failures ?? 0, 0, "and it is still never counted");
});

test("a re-probe that ends on the wall again doubles the pause: the consecutive-failure counter rides the record the drain writes", async () => {
  // The escalation lives on the persisted record, not in memory: the drain reads the entry's
  // stored streak, sets the next deadline from the PRIOR count (so the streak of 2 here re-arms
  // from 4 minutes, not 1), and writes the incremented count back. A settle that dropped the
  // counter would re-probe at the base forever.
  const { root, commit, ctx, runner } = setup("VERDICT: approve\n1. fine");
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async () =>
    piRunResult({ ok: true, transientRateLimit: true });
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({ pending: [{ commit, role: "improve", summary: "add x", consecutiveTransientFailures: 2, notBeforeMs: 1 }] }),
  );
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const t1 = Date.now();
  const kept = readPostReviews(root)[0]!;
  assert.equal(kept.consecutiveTransientFailures, 3, "the streak rides into the record the drain writes");
  const waitMs = (kept.notBeforeMs ?? 0) - t1;
  const ladderMs = 4 * HOLD_BASE_MS; // the streak of 2 re-arms from 60s x 2^2
  assert.ok(waitMs >= ladderMs - 10_000 && waitMs <= ladderMs, `the third re-probe waits the prior count's ${ladderMs / 1000}s, got ${waitMs}ms`);
  // A content failure means the provider served the model, so that streak restarts: the counted
  // arm writes 0, and a later transient failure would re-arm from the base.
  const second = setup("VERDICT: approve\n1. fine");
  const first = sh(second.root, "git", "rev-list", "--max-parents=0", "HEAD");
  fs.writeFileSync(postReviewPath(second.root), JSON.stringify({ pending: [{ commit: first, role: "improve", summary: "seed", consecutiveTransientFailures: 2 }] }));
  const p2 = newMergePipeline();
  drainPostReviews(second.ctx, p2);
  await p2.postReview!.promise;
  const afterContent = readPostReviews(second.root)[0]!;
  assert.equal(afterContent.consecutiveTransientFailures, 0, "a content failure resets the streak");
  assert.equal(afterContent.notBeforeMs, undefined, "and the reset arm stamps no deadline");
});

test("a post-merge review that ended on a content failure is re-run on the next poll, without a backoff deadline", async () => {
  // The backoff is for transient (infrastructure) failures only: a plain content failure keeps
  // the today behavior — the entry stays queued with an incremented failure count and the next
  // poll re-runs it (that path already has the POST_REVIEW_FAILURE_LIMIT brake). No deadline is
  // stamped, so the skipped-poll branch above never applies to it. A no-parent commit forces a
  // content failure deterministically (git cannot produce its diff): no transient flag, counted.
  const { root, ctx } = setup("VERDICT: approve\n1. fine");
  const first = sh(root, "git", "rev-list", "--max-parents=0", "HEAD");
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit: first, role: "improve", summary: "seed" }] }));
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const kept = readPostReviews(root)[0]!;
  assert.equal(kept.failures ?? 0, 1, "the content failure is counted");
  assert.equal(kept.notBeforeMs, undefined, "a content failure stamps no backoff deadline");
  // Next poll re-runs it (the pre-existing limit-braked retry): a second review starts, and the
  // counted failure increments again — the content path never gains a backoff deadline.
  const p2 = newMergePipeline();
  drainPostReviews(ctx, p2);
  assert.ok(p2.postReview, "the content failure is re-run on the next poll");
  await p2.postReview!.promise;
  assert.equal(readPostReviews(root)[0]!.failures, 2, "the re-run counted the failure again");
  assert.equal(readPostReviews(root)[0]!.notBeforeMs, undefined, "still no backoff deadline after the re-run");
});

test("the transient-failure backoff doubles with the consecutive-failure count and caps at the team-hold cap", () => {
  // The escalation is the whole point of the counter (BUGS.md 2026-11-16): a wall that outlasts
  // every re-probe must re-probe "a few times an hour" (HOLD_CAP_MS), not at a steady rate. The
  // base doubles per repeat and floors at the cap — the same ladder the team hold uses, where the
  // fourth relapse reaches the cap (1, 2, 4, 8, 15 min). A dead doubling (one that never grows)
  // would fail this: it would answer 60s on every repeat instead of climbing to the cap.
  assert.equal(reviewBackoffMs(0, undefined), HOLD_BASE_MS, "the first failure rests the team-hold base");
  assert.equal(reviewBackoffMs(1, undefined), 2 * HOLD_BASE_MS, "the second doubles it");
  assert.equal(reviewBackoffMs(3, undefined), 8 * HOLD_BASE_MS, "it keeps doubling");
  assert.equal(reviewBackoffMs(4, undefined), HOLD_CAP_MS, "it floors at the cap on the fifth");
  assert.equal(reviewBackoffMs(99, undefined), HOLD_CAP_MS, "it never exceeds the cap, however many repeats");
  // A retry-after hint longer than the escalated base is honored; a short one is floored to it.
  assert.equal(reviewBackoffMs(0, 300), 300 * 1000, "a long 429 hint wins over the base");
  assert.equal(reviewBackoffMs(0, 5), HOLD_BASE_MS, "a short 429 hint is floored to the base");
  assert.equal(reviewBackoffMs(4, 300), HOLD_CAP_MS, "the cap still bounds an even longer hint");
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
  assert.match(bugs, /Do not park it with a Needs review note: the review never runs again/,
    "the filed entry says to settle it by reading the diff, since no recurrence can lift a wait note");
  const filed = openBugEntries(root).find((e) => e.title.startsWith("post-merge review of"))!;
  assert.equal(entryHold(filed, []), null, "the instruction itself does not read as a hold note");
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
  // One base role's churn is one row, matching the base-role keys and the
  // alert's "narrow the noisy role" remedy, instead of splitting `bugfix`/`bugfix #2`/`bugfix #5`.
  assert.deepEqual(postMergeRejectionCounts(events), [
    { role: "bugfix", count: 3 },
    { role: "clean", count: 1 },
  ]);
});

/** A post-merge reviewer that repairs what it found: writes `x.txt` into the review worktree
 * and replies with `reply`, by default a `FIX:` line alongside a rejecting verdict (Forward never
 * back 1a/6). */
function fixingRunner(role: string, reply = "VERDICT: reject\n1. breaks the contract\nFIX: x.txt"): RoleRunner {
  return {
    role,
    baseRole: role,
    state: freshRunnerState(role),
    runGatePi: async (opts: { cwd: string }) => {
      fs.writeFileSync(path.join(opts.cwd, "x.txt"), "fixed\n");
      return { ok: true, verdictText: reply };
    },
    // No-op fold: startPostReview folds the reviewer's final run into the author (BUGS.md
    // 2026-11-16); these fix tests assert nothing about the author's usage, so the fold is a no-op.
    foldMergeUsage: () => {},
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

test("an approving review that repaired a finding still lands its repair as one fix", async () => {
  // The live reviewer's usual shape (600749317, 2026-11-02): it repairs what it found, judges the
  // repaired change sound, and approves with a FIX line. The FIX line plus the edit is the repair,
  // whatever the verdict, so it lands exactly as a rejecting reviewer's does.
  const { root, commit, ctx } = setup("VERDICT: approve\n1. fine");
  (ctx as { runners: RoleRunner[] }).runners = [
    fixingRunner("improve", "VERDICT: approve\n1. x.txt held a stale value; I rewrote it\n2. the rest matches the summary\nFIX: x.txt"),
  ];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const tip = headSha(root);
  assert.equal(sh(root, "git", "rev-parse", `${tip}^`).trim(), commit, "the fix's parent is the reviewed commit");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "fixed\n", "the repair landed on main");
  assert.equal(
    sh(root, "git", "log", "-1", "--format=%B", tip).trim(),
    `tumwater(reviewer): Fix ${commit.slice(0, 8)} — x.txt held a stale value; I rewrote it\n\n` +
      "1. x.txt held a stale value; I rewrote it\n2. the rest matches the summary\nRevision: 1",
  );
  // The reviewed commit's own record is the approval the reviewer gave, not a rejection.
  assert.deepEqual(
    eventsOfType(root, "review_verdict").map((e) => [e.head, e.afterMerge]),
    [[commit, true]],
  );
  assert.equal(eventsOfType(root, "review_rejected").length, 0);
  const settled = readPostReviews(root);
  assert.equal(settled.find((e) => e.commit === commit)?.fixed, tip, "the reviewed entry settles fixed");
  assert.ok(settled.some((e) => e.commit === tip && e.fixed === undefined), "the landed fix is queued for its own review");
});

test("a reviewer's fix that fails its pre-check is withheld from main (BUGS.md 2026-11-04)", async () => {
  // Since part 4l/3 mergeToMain is a bare rebase-and-fast-forward with no check of its own, a
  // reviewer's fix — reviewer-authored bytes main has never checked — landed unchecked. The
  // fix tree now runs the same deterministic gate check a queued change gets before the write
  // path touches main: a reproduced failure that is the fix's (a green main here) withholds it
  // instead of landing it, so a broken repair never turns main red.
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  // A declared check that fails exactly when the reviewer's repair is present: the reviewed
  // tree (x.txt = "x") passes, the fix tree (x.txt = "fixed") fails. main is green, so the
  // failure reproduces on its flake re-run and is attributed to the fix, not to main.
  const config = (ctx as { liveConfig: unknown }).liveConfig as Record<string, unknown>;
  config.check = { command: "[ \"$(cat x.txt 2>/dev/null)\" != \"fixed\" ]" };
  const fixer = fixingRunner("improve");
  (ctx as { runners: RoleRunner[] }).runners = [fixer];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  // main never moved past the reviewed commit: the broken repair did not land.
  assert.equal(headSha(root), commit, "the withheld fix never fast-forwards main");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "x", "main keeps the reviewed tree, not the broken fix");
  // The fix ref survives so the withheld commit remains reachable, and the reviewed commit is
  // settled rejected with the pre-check's reasons. `fixed` stays unset: no repair landed on main,
  // so it must not read as the landed-fix record PostReview.fixed names.
  assert.ok(sh(root, "git", "for-each-ref", reviewFixRef(commit)).trim(), "the withheld fix ref survives");
  const settled = readPostReviews(root);
  const reviewed = settled.find((e) => e.commit === commit)!;
  assert.equal(reviewed.fixed, undefined, "no fix is recorded as landed on main");
  // The pre-check's reasons are the FIX's problem, not the reviewed change's verdict: they are
  // recorded as this entry's failure, and the reviewed entry keeps its finding instead of being
  // settled `rejected` — a settlement is terminal, so the withheld fix would be the review's last
  // word and the finding itself would be overwritten and lost.
  assert.equal(reviewed.rejected, undefined, "the reviewed change is not settled rejected by its fix's pre-check");
  assert.equal(reviewed.failures, 1, "the withheld fix counts as one failure of the review");
  assert.match(reviewed.lastFailure ?? "", /fix pre-check/, "the failure names the fix pre-check as the cause");
  assert.deepEqual(reviewed.finding, ["breaks the contract"], "the reviewer's finding survives the withheld fix");
  const rejected = eventsOfType(root, "review_rejected");
  assert.deepEqual(
    rejected.map((e) => e.head),
    [commit, commit],
    "the reviewer's own verdict on the reviewed commit stays logged, and the withholding names the SAME reviewed commit — not the reviewer's own fix sha — so no observer reads it as a verdict on a commit the author can revise (BUGS.md 2026-11-22)",
  );
  assert.deepEqual(rejected[0]!.reasons, ["breaks the contract"], "the reviewer's finding is recorded against the reviewed commit");
  // The withholding event carries its own discriminator and the finding, so the digest and the
  // doctor can tell a reviewer fix held back from a post-merge rejection of the author, and can
  // name what the reviewer found instead of only the lint line its repair tripped on.
  const withheld = rejected[1]!;
  assert.equal(withheld.withheldFix, sh(root, "git", "rev-parse", reviewFixRef(commit)).trim(), "the withheld fix sha rides on the event");
  assert.deepEqual(withheld.finding, ["breaks the contract"], "the event carries the reviewer's finding, not only the pre-check's reasons");
  assert.ok((withheld.reasons as string[]).length > 0 && !(withheld.reasons as string[]).includes("breaks the contract"), "the event's reasons stay the pre-check's own lines");
  // The author's own rejection record (the one its next run's prompt reads) must name the finding,
  // not only the lint line the fix tripped on — a role cannot revise the withheld fix commit.
  const lastReview = (fixer as unknown as { state: { lastReview?: { verdict: string; reasons: string[] } } }).state.lastReview;
  assert.equal(lastReview?.verdict, "reject");
  assert.ok(lastReview?.reasons.includes("breaks the contract"), "the author's rejection names the finding too");
  assert.ok((lastReview?.reasons.length ?? 0) > 1, "and it still names the pre-check failure that withheld the fix");
});

test("a reviewer's fix is pre-checked on the tree its rebase onto a moved main composes (BUGS.md 2026-11-23)", async () => {
  // main went red for 82 min on a duplicate import no parent commit carried: the fix's pre-check
  // judged the fix AS PINNED (green against the reviewed base) while mergeToMain's in-lock rebase
  // composed it onto a main that had moved — and nobody checked THOSE bytes. The fixture is the
  // incident's shape: main adds its own `SHARED` line and the fix appends one, in disjoint hunks,
  // so the rebase auto-merges a duplicate. Each tree alone passes the one-`SHARED` check; only the
  // tree that lands fails it.
  const { root, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  const config = (ctx as { liveConfig: unknown }).liveConfig as Record<string, unknown>;
  config.check = {
    command:
      "[ \"$(grep -c '^SHARED$' f.txt 2>/dev/null)\" = \"1\" ] || { echo 'check: the shared line is duplicated' >&2; exit 1; }",
  };
  const base = `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`;
  let mainMoved = "";
  fs.writeFileSync(path.join(root, "f.txt"), base);
  sh(root, "git", "add", "--", "f.txt");
  sh(root, "git", "commit", "-m", "add f");
  const reviewed = headSha(root);
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit: reviewed, role: "improve", summary: "add f" }] }));
  // The reviewer edits in its worktree and, in the same turn, main moves under the review: a
  // separate change lands a `SHARED` line of its own, in a hunk far from the reviewer's.
  const fixer = {
    role: "improve",
    baseRole: "improve",
    state: freshRunnerState("improve"),
    runGatePi: async (opts: { cwd: string }) => {
      fs.writeFileSync(path.join(opts.cwd, "f.txt"), `${base}SHARED\n`);
      const lines = base.trimEnd().split("\n");
      lines.splice(2, 0, "SHARED");
      fs.writeFileSync(path.join(root, "f.txt"), `${lines.join("\n")}\n`);
      sh(root, "git", "add", "--", "f.txt");
      sh(root, "git", "commit", "-m", "main adds its own shared line");
      mainMoved = headSha(root);
      return { ok: true, verdictText: "VERDICT: reject\n1. breaks the contract\nFIX: f.txt" };
    },
    foldMergeUsage: () => {},
  } as unknown as RoleRunner;
  (ctx as { runners: RoleRunner[] }).runners = [fixer];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const mainTip = headSha(root);
  // The landing tree fails the check, so the fix is withheld: main keeps only its own new commit.
  assert.equal(mainTip, mainMoved, "main keeps the commit that moved under the review and takes no fix");
  assert.equal(fs.readFileSync(path.join(root, "f.txt"), "utf8").split("\n").filter((l) => l === "SHARED").length, 1, "main keeps one shared line");
  // The withheld commit is the ONE that would have landed — the fix rebased onto main's tip — so a
  // reader picking the ref up sees the tree the check judged, not the stale pinned base.
  const withheldSha = sh(root, "git", "rev-parse", reviewFixRef(reviewed)).trim();
  assert.ok(withheldSha, "the withheld fix ref survives");
  assert.equal(
    sh(root, "git", "rev-parse", `${withheldSha}^`).trim(),
    mainTip,
    "the ref names the fix rebased onto main's current tip, not the pinned pre-rebase commit",
  );
  assert.equal(
    sh(root, "git", "show", `${withheldSha}:f.txt`).trim().split("\n").filter((l) => l === "SHARED").length,
    2,
    "the withheld commit IS the landing tree — it carries both SHARED lines, the failure the check named",
  );
  const rejected = eventsOfType(root, "review_rejected");
  const withheld = rejected[rejected.length - 1]!;
  assert.equal(withheld.withheldFix, withheldSha, "the event names the same post-rebase sha the ref holds");
  assert.ok(
    (withheld.reasons as string[]).join("\n").includes("shared line is duplicated"),
    "the pre-check's own reasons name the landing tree's failure",
  );
  assert.equal(readPostReviews(root).find((e) => e.commit === reviewed)?.failures, 1, "the withheld fix counts as one failure of the review");
});

test("a reviewer's fix rebased onto a main that moved still lands when the landing tree is green (BUGS.md 2026-11-23)", async () => {
  // The pre-check now runs on the post-rebase tree, so a fix main moved under must still land on
  // top of main's new commit: the re-pin must not block a sound repair or land the stale base.
  const { root, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  const config = (ctx as { liveConfig: unknown }).liveConfig as Record<string, unknown>;
  config.check = { command: "[ -f x.txt ]" };
  fs.writeFileSync(path.join(root, "x.txt"), "x\nbase\n");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "grow x");
  const reviewed = headSha(root);
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit: reviewed, role: "improve", summary: "grow x" }] }));
  const fixer = {
    role: "improve",
    baseRole: "improve",
    state: freshRunnerState("improve"),
    runGatePi: async (opts: { cwd: string }) => {
      fs.writeFileSync(path.join(opts.cwd, "x.txt"), "x\nbase\nfixed\n");
      fs.writeFileSync(path.join(root, "x.txt"), "main moved\nbefore\nx\nbase\n");
      sh(root, "git", "add", "--", "x.txt");
      sh(root, "git", "commit", "-m", "main moves under the review");
      return { ok: true, verdictText: "VERDICT: reject\n1. breaks the contract\nFIX: x.txt" };
    },
    foldMergeUsage: () => {},
  } as unknown as RoleRunner;
  (ctx as { runners: RoleRunner[] }).runners = [fixer];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const tip = headSha(root);
  const mainMoved = sh(root, "git", "rev-parse", "main~1").trim();
  assert.notEqual(tip, reviewed, "the fix landed on top of main's new commit");
  assert.equal(sh(root, "git", "rev-parse", `${tip}^`).trim(), mainMoved, "the landed fix's parent is main's new commit, not the reviewed one");
  assert.match(fs.readFileSync(path.join(root, "x.txt"), "utf8"), /main moved/, "main's concurrent edit survives the rebase");
  assert.match(fs.readFileSync(path.join(root, "x.txt"), "utf8"), /fixed/, "the reviewer's repair landed");
  assert.equal(readPostReviews(root).find((e) => e.commit === reviewed)?.fixed, tip, "the entry settles fixed naming the landed sha");
});

test("a withheld fix at the failure limit files both the reviewer's finding and the pre-check's reason", async () => {
  // The entry is dropped at POST_REVIEW_FAILURE_LIMIT and filed to BUGS.md; the filed body must
  // carry what the reviewer found and why its repair never landed — losing either makes the filed
  // entry a duplicate of the reviewed commit's subject, which is what the 6c05d278 filing was.
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  const config = (ctx as { liveConfig: unknown }).liveConfig as Record<string, unknown>;
  config.check = { command: "[ \"$(cat x.txt 2>/dev/null)\" != \"fixed\" ]" };
  const fixer = fixingRunner("improve");
  (ctx as { runners: RoleRunner[] }).runners = [fixer];
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({
      pending: [{ commit, role: "improve", summary: "seed", failures: POST_REVIEW_FAILURE_LIMIT - 1 }],
    }),
  );
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(readPostReviews(root).length, 0, "the entry is dropped at the limit");
  const bugs = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  assert.match(bugs, /breaks the contract/, "the filed entry names the reviewer's finding");
  assert.match(bugs, /fix pre-check/, "the filed entry names the withheld fix's pre-check reason");
  // main carries only the BUGS.md filing commit on top of the reviewed commit: the withheld repair
  // never landed on it.
  const tip = headSha(root);
  assert.equal(sh(root, "git", "rev-parse", `${tip}^`).trim(), commit, "the reviewed commit stays main's tip's parent");
  assert.match(sh(root, "git", "log", "-1", "--format=%s", tip).trim(), /^tumwater\(operator\): File an unreviewed post-merge commit/);
  assert.equal(
    sh(root, "git", "for-each-ref", reviewFixRef(commit)).trim(),
    "",
    "the fix ref is deleted once the entry is dropped, so it pins nothing forever",
  );
});

test("a fix commit's subject and recorded reasons name the finding, never the FIX line", async () => {
  // The live 38887ca4 reply's shape (7375d2cc4, 2026-11-02): the finding sits above the verdict
  // and only the FIX line follows it, which once made the subject "— FIX: x.txt".
  const { root, commit, ctx } = setup("VERDICT: approve\n1. fine");
  (ctx as { runners: RoleRunner[] }).runners = [
    fixingRunner("improve", "1. x.txt held a stale value; I rewrote it\n\nVERDICT: reject\nFIX: x.txt"),
  ];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const tip = headSha(root);
  assert.equal(sh(root, "git", "rev-parse", `${tip}^`).trim(), commit, "the fix's parent is the reviewed commit");
  assert.equal(
    sh(root, "git", "log", "-1", "--format=%B", tip).trim(),
    `tumwater(reviewer): Fix ${commit.slice(0, 8)} — x.txt held a stale value; I rewrote it\n\n` +
      "1. x.txt held a stale value; I rewrote it\nRevision: 1",
  );
  assert.deepEqual(
    eventsOfType(root, "review_rejected").map((e) => e.reasons),
    [["x.txt held a stale value; I rewrote it"]],
  );
});

test("a fix whose reply carries no reason besides its FIX line names the reviewed change", async () => {
  const { root, commit, ctx } = setup("VERDICT: approve\n1. fine");
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve", "VERDICT: approve\nFIX: x.txt")];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const tip = headSha(root);
  assert.equal(sh(root, "git", "rev-parse", `${tip}^`).trim(), commit, "the fix's parent is the reviewed commit");
  assert.equal(
    sh(root, "git", "log", "-1", "--format=%B", tip).trim(),
    `tumwater(reviewer): Fix ${commit.slice(0, 8)} — the reviewed change\n\nRevision: 1`,
  );
  assert.deepEqual(
    eventsOfType(root, "review_verdict").map((e) => [e.head, e.reason]),
    [[commit, undefined]],
  );
});

test("an approving review that edits the worktree without a FIX line lands nothing", async () => {
  // The FIX line is the repair's declaration: an edit the reply never names (a scratch write)
  // is not committed, and the approval ends the entry.
  const { root, commit, ctx } = setup("VERDICT: approve\n1. fine");
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve", "VERDICT: approve\n1. fine")];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(headSha(root), commit, "main stays at the reviewed commit");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "x");
  assert.equal(readPostReviews(root).length, 0);
  assert.equal(sh(root, "git", "for-each-ref", reviewFixRef(commit)).trim(), "", "no review-fix ref is left");
});

test("a fix whose rebase onto a main that moved mid-precheck breaks the build is withheld (BUGS.md 2026-11-23)", async () => {
  // The pre-check syncs the fix pin onto main and checks the synced tree — but it runs OUTSIDE the
  // merge lock. When main moves between that check and mergeToMain's own in-lock rebase, the rebase
  // builds a DIFFERENT tree, and git resolves a line both sides added without a conflict, keeping
  // both copies. The recorded case is main's tip 1706a712: a duplicated import, TS2300, on a
  // tree no check ever saw. The merge itself must check the tree it fast-forwards onto.
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract", "x\n");
  // The check fails exactly when the import line appears twice: green on the fix (one copy) and on
  // main's new commit (one copy), red on the rebase's output (two copies). Its first run also
  // stands in for the concurrent merge that moves main DURING the pre-check — guarded on main's
  // old tip, so it fires exactly once, on the pre-check's run and not on any later one.
  const initial = headSha(root);
  const config = (ctx as { liveConfig: unknown }).liveConfig as Record<string, unknown>;
  config.check = {
    command:
      `if [ "$(git -C '${root}' rev-parse main)" = '${initial}' ]; then ` +
      `printf 'import x\\nx\\n' > '${root}/x.txt'; git -C '${root}' add -- x.txt; ` +
      `git -C '${root}' commit -m 'another role adds the same line concurrently'; fi; ` +
      `[ "$(grep -c '^import x$' x.txt)" -le 1 ]`,
  };
  (ctx as { runners: RoleRunner[] }).runners = [
    {
      role: "improve",
      baseRole: "improve",
      state: freshRunnerState("improve"),
      // The fix adds the SAME line main's concurrent commit adds, at a nearby position: git
      // auto-merges that pair and keeps both copies.
      runGatePi: async (opts: { cwd: string }) => {
        fs.writeFileSync(path.join(opts.cwd, "x.txt"), "x\nimport x\n");
        return { ok: true, verdictText: "VERDICT: reject\n1. breaks the contract\nFIX: x.txt" };
      },
      foldMergeUsage: () => {},
    } as unknown as RoleRunner,
  ];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  // The fix passed its pre-check on the synced tree, and main moved under that check. The merge's
  // own gate over the rebase's output convicted the doubled tree before main moved onto it.
  const movedMain = sh(root, "git", "rev-list", "--grep=concurrently", "--max-count=1", "main").trim();
  assert.ok(movedMain, "the pre-check's run recorded a concurrent commit on main");
  assert.equal(headSha(root), movedMain, "the rebased fix never fast-forwards main");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "import x\nx\n", "main keeps one copy of the line");
  assert.equal(eventsOfType(root, "merged").length, 0, "no merge of the fix is recorded");
  // The withheld tree, not the pinned fix, is what the record names: the rebased head is a child of
  // the moved main and holds the doubled line, so a reader can see the bytes that were held back.
  const pinnedFix = sh(root, "git", "rev-parse", reviewFixRef(commit)).trim();
  const rejected = eventsOfType(root, "review_rejected");
  assert.equal(rejected.length, 2, "the reviewer's verdict and the withheld merge are both recorded");
  const withheld = rejected[1]!;
  assert.equal(withheld.head, commit, "the event stays a record about the reviewed commit");
  const withheldFix = String(withheld.withheldFix);
  assert.notEqual(withheldFix, pinnedFix, "withheldFix names the rebased tree, not the pinned fix commit");
  assert.equal(sh(root, "git", "rev-parse", `${withheldFix}^`).trim(), movedMain, "the withheld tree sits on the moved main");
  assert.equal(sh(root, "git", "show", `${withheldFix}:x.txt`).trim().split("\n").filter((l) => l === "import x").length, 2, "the withheld tree is the doubled-line tree that would have landed");
  // The fix ref survives so the fix stays reachable for the next poll's retry, and the entry counts
  // the withholding exactly ONCE: the merged-tree check settled it, so the failed-merge settle must
  // not spend the drop limit a second time for one attempt.
  assert.ok(pinnedFix, "the review-fix ref survives the withheld merge");
  const reviewed = readPostReviews(root).find((e) => e.commit === commit)!;
  assert.equal(reviewed.fixed, undefined, "no fix is recorded as landed");
  assert.equal(reviewed.failures, 1, "the withheld merge counts one failure, not two");
  assert.match(reviewed.lastFailure ?? "", /fix pre-check/, "the failure names the pre-check as the cause");
  assert.deepEqual(reviewed.finding, ["breaks the contract"], "the reviewer's finding survives");
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
      foldMergeUsage: () => {},
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

test("another same-role merge's event does not stand in for the reviewer fix's landed sha", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  // A role's queued change can land through mergeToMain under the same role while its earlier
  // commit's post-merge fix is finishing; that event must not be recorded as this fix's landing.
  const other = "f".repeat(40);
  let injected = false;
  let unsubscribeInjected: (() => void) | undefined;
  (ctx as { runners: RoleRunner[] }).runners = [
    {
      role: "improve",
      baseRole: "improve",
      state: freshRunnerState("improve"),
      runGatePi: async (opts: { cwd: string }) => {
        // A concurrent main commit conflicts with the fix, so the resolver hook below runs
        // after this fix's merge subscription is live but before its merged event.
        fs.writeFileSync(path.join(root, "x.txt"), "main\n");
        sh(root, "git", "add", "--", "x.txt");
        sh(root, "git", "commit", "-m", "main lands a conflicting edit");
        fs.writeFileSync(path.join(opts.cwd, "x.txt"), "fixed\n");
        return { ok: true, verdictText: "VERDICT: reject\n1. breaks the contract\nFIX: x.txt" };
      },
      runMergePi: async (wt: string) => {
        fs.writeFileSync(path.join(wt, "x.txt"), "main and fixed\n");
        // Subscribed after the post-review task's own listener: on the fix's real merged event
        // this runs second and logs another same-role landing, the event that must not win.
        unsubscribeInjected = subscribeEvents((e) => {
          if (injected || e.type !== "merged" || e.source !== "improve") return;
          injected = true;
          logEvent(root, { source: "improve", type: "merged", commit: other, summary: "an earlier fix" });
        });
        return piRunResult({ finalText: "resolved" });
      },
      foldMergeUsage: () => {},
    } as unknown as RoleRunner,
  ];
  try {
    const p = newMergePipeline();
    drainPostReviews(ctx, p);
    await p.postReview!.promise;
    const tip = headSha(root);
    assert.equal(injected, true, "another same-role merge landed while the fix's merge finished");
    const settled = readPostReviews(root);
    assert.equal(settled.find((e) => e.commit === commit)?.fixed, tip, "fixed names the fix's own landed commit");
    assert.equal(settled.some((e) => e.commit === other), false, "the unrelated merge is not queued as this fix's landing");
  } finally {
    unsubscribeInjected?.();
  }
});

test("a fix whose landing fails keeps the entry and leaves main unmoved", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve")];
  // Dirty the primary checkout's x.txt so the fix's fast-forward is refused: main stays put and
  // the entry is kept (failure recorded) for the next poll's retry.
  fs.writeFileSync(path.join(root, "x.txt"), "local\n");
  // The entry carries a kept session from an earlier progressing timeout: this run reached a
  // verdict, so the retry must start a fresh review, not continue the finished session.
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit, role: "improve", summary: "add x", resume: true }] }));
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(headSha(root), commit, "main stays at the reviewed commit");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "local\n");
  const kept = readPostReviews(root);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.fixed, undefined, "no fix is recorded on a failed landing");
  assert.match(kept[0]!.lastFailure ?? "", /fix did not merge/);
  assert.equal(kept[0]!.resume, undefined, "a verdict-reaching run drops the kept session");
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

test("a fix whose conflict resolution leaves the reviewer's scope is withheld by the recheck gate", async () => {
  const { root, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  // Seed a brief block in README.md so the deterministic recheck gate has a brief to protect; the
  // fix itself only edits x.txt and leaves the brief untouched, so the fix's own verification is
  // clean. A concurrent main commit rewrites x.txt during the review, so landing the fix rebases
  // onto a conflicting main. The resolver integrates the x.txt conflict but ALSO rewrites the
  // brief block — bytes outside the reviewed fix's scope that a resolution that just merges
  // main's edit and the fix would not carry. mergeReviewerFix's recheckResolved re-runs the
  // deterministic gate over the resolved tree (review.ts's reviewAheadOfMain), which rejects the
  // resolution on the non-repairable brief finding before any build run, so the landing is
  // withheld and main unmoved: a resolution the reviewer never judged must not merge (BUGS.md
  // 2026-10-01).
  const prompt = (body: string) => `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
  fs.writeFileSync(path.join(root, "README.md"), prompt("the project brief"));
  sh(root, "git", "add", "--", "README.md");
  sh(root, "git", "commit", "-m", "seed the brief");
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
        fs.writeFileSync(path.join(wt, "x.txt"), "fixed\n");
        // The resolver over-steps: it rewrites the brief, a non-repairable gate finding.
        fs.writeFileSync(path.join(wt, "README.md"), prompt("rewritten by the resolver"));
        return piRunResult({ finalText: "resolved" });
      },
      foldMergeUsage: () => {},
    } as unknown as RoleRunner,
  ];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(headSha(root), concurrent, "main stays at the concurrent commit — the diverging resolution never lands");
  assert.equal(resolverRuns, 1, "the conflict path ran the resolver exactly once");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "main\n", "the diverging resolution never reaches main");
  const kept = readPostReviews(root);
  assert.equal(kept.length, 1, "one entry stays queued");
  assert.equal(kept[0]!.fixed, undefined, "no fix is recorded on a withheld landing");
  assert.equal(kept[0]!.rejected, undefined, "the gate's rejection is not the fix's own: the entry stays queued for another review");
  assert.match(kept[0]!.lastFailure ?? "", /fix did not merge/);
});

test("a conflicting fix whose resolver soundly merges main's edit now lands (recheck gate approves)", async () => {
  // Regression for BUGS.md 2026-11-05: a post-merge reviewer's fix that conflicts with main
  // could never merge — mergeReviewerFix's recheckResolved always returned retry, so every
  // sound resolution of a fix on a file main also touched was discarded. The resolved tree is
  // now re-reviewed by the deterministic gate; here the resolver integrates main's edit and the
  // fix by reworking the line (which genuinely diverges from the fix-only diff), the gate approves
  // (no declared check, so a clean pass), and the fix lands once instead of being retried and
  // dropped.
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
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
        // A sound but genuinely divergent resolution: both main's new wording and the fix's edit
        // are integrated by REWORDING the line neither side carried verbatim, so the resolved
        // tree's diff leaves the fix-only diff the reviewer judged (BUGS.md 2026-11-05 describes
        // exactly this — "a resolution of lines both sides edited always leaves them"). Under the
        // old code this was discarded by always-retry and the fix could never land; the recheck
        // gate now approves the sound resolution once.
        fs.writeFileSync(path.join(wt, "x.txt"), "main and fixed\n");
        return piRunResult({ finalText: "resolved" });
      },
      foldMergeUsage: () => {},
    } as unknown as RoleRunner,
  ];
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  assert.equal(resolverRuns, 1, "the conflict path ran the resolver exactly once — the resolution is not retried");
  // The fix landed on top of main's moved tip (the resolution rebased the fix onto the concurrent
  // commit), fast-forwarding main past it.
  const tip = headSha(root);
  assert.equal(sh(root, "git", "rev-parse", `${tip}^`).trim(), concurrent, "the fix landed directly on main's moved tip");
  assert.equal(await isMergedInto(root, commit, "main"), true, "the originally reviewed commit stays an ancestor of main");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "main and fixed\n", "the sound resolution is on main");
  const settled = readPostReviews(root);
  assert.equal(settled.find((e) => e.commit === commit)?.fixed, tip, "the reviewed entry settles fixed naming the landed fix");
  assert.ok(settled.some((e) => e.commit === tip), "the landed fix is re-queued for its own review");
});

test("a verdict-less review dropped at the limit logs one review_dropped event naming its full commit", async () => {
  // The warning names the commit by short SHA only; the event carries the full SHA so a reader
  // can select the dropped review (BUGS.md, "A dropped post-merge review leaves only free text").
  const { root, runner, ctx } = setup("");
  fs.appendFileSync(path.join(root, "x.txt"), "more\n");
  sh(root, "git", "add", "--", "x.txt");
  sh(root, "git", "commit", "-m", "more");
  const commit = headSha(root);
  countReviews(runner);
  fs.writeFileSync(
    postReviewPath(root),
    JSON.stringify({ pending: [{ commit, role: "improve", summary: "more", failures: POST_REVIEW_FAILURE_LIMIT - 1 }] }),
  );
  const p = newMergePipeline();
  drainPostReviews(ctx, p);
  await p.postReview!.promise;
  const dropped = eventsOfType(root, "review_dropped");
  assert.equal(dropped.length, 1, "exactly one review_dropped event for the dropped review");
  assert.equal(dropped[0]?.commit, commit, "the event carries the full reviewed SHA");
  assert.equal(dropped[0]?.source, "improve", "the event's source is the entry's role");
  assert.equal(dropped[0]?.summary, "more", "the event carries the entry's summary");
  assert.ok(String(dropped[0]?.reason ?? "").length > 0, "the event carries the failure detail");
  assert.ok(
    eventsOfType(root, "warning").some((e) => String(e.message).includes("dropping the post-merge review of")),
    "the drop warning is still logged",
  );
});

test("a failed fix merge dropped at the limit logs one review_dropped event for its commit", async () => {
  const { root, commit, ctx } = setup("VERDICT: reject\n1. breaks the contract");
  (ctx as { runners: RoleRunner[] }).runners = [fixingRunner("improve")];
  fs.writeFileSync(path.join(root, "x.txt"), "local\n"); // every landing is refused fast-forward
  for (let i = 0; i < POST_REVIEW_FAILURE_LIMIT; i++) {
    const p = newMergePipeline();
    drainPostReviews(ctx, p);
    await p.postReview!.promise;
  }
  const dropped = eventsOfType(root, "review_dropped");
  assert.equal(dropped.length, 1, "exactly one review_dropped event for the dropped fix");
  assert.equal(dropped[0]?.commit, commit);
  assert.equal(dropped[0]?.source, "improve");
  assert.match(String(dropped[0]?.reason), /fix did not merge/);
});

test("a transient provider failure past the limit logs no review_dropped event", async () => {
  const { root, commit, ctx, runner } = setup("VERDICT: approve\n1. fine");
  (runner as { runGatePi: RoleRunner["runGatePi"] }).runGatePi = async () =>
    piRunResult({ ok: true, transientRateLimit: true });
  fs.writeFileSync(postReviewPath(root), JSON.stringify({ pending: [{ commit, role: "improve", summary: "add x" }] }));
  for (let i = 0; i < POST_REVIEW_FAILURE_LIMIT + 1; i++) {
    const p = newMergePipeline();
    drainPostReviews(ctx, p);
    if (p.postReview) await p.postReview.promise;
  }
  assert.equal(eventsOfType(root, "review_dropped").length, 0, "a transient failure never drops, so it logs no drop");
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
