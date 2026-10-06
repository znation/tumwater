/** The loop e2e suite's leftover-recovery slice — how a committed-but-unlanded change (the
 * landing pin) is recovered by a later tick: re-landed through the gate, dropped with an
 * author-facing reason once it exhausts the merge-conflict cap, or failed closed so a
 * shutdown mid-landing survives for next-start recovery. Extracted from loop-3.test.ts
 * (2026-09-29) so the topic has a name instead of nine rows in a numbered grab-bag. The
 * suite's slices run one test FILE per process (each file gets its own process and PATH,
 * which fakePi's global PATH swap requires — see loop-3.test.ts's header), so this file
 * runs in parallel with the numbered ones; the header's keep-them-equal balance rule applies
 * to moves between the existing slices, not to a new topic file. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MERGE_CONFLICT_LIMIT } from "../src/leftover.js";
import { defaultConfig } from "../src/config/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox/inbox.js";
import { readEvents } from "../src/event-read.js";
import { setRef } from "../src/git.js";
import { loadLoopState } from "../src/loop-state.js";
import { ERROR_STREAK_WARN } from "../src/tick/tick-apply.js";
import { landingRefName, worktreePath } from "../src/paths.js";
import { ensureWorktree } from "../src/worktree.js";
import { headLanding, queueDepth } from "../src/landing/landing-queue.js";
import { loopPhase } from "../src/ui/status-model.js";
import { eventsOfType } from "./log-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { landHead, landingRefExists } from "./orchestrator-fixtures.js";
import { assertClean, initializedRepo, mainSha, sh, tmpdir } from "./repo-fixtures.js";

/** Simulate an interrupted tick's leftover — the crash state every test in this file starts
 * from: detach, commit work main does not contain, return to main, and pin the commit with the
 * role's landing ref — the on-disk state a shutdown between the tick's commitAll and its
 * landing leaves. Returns the pinned sha. */
async function pinLeftover(
  repo: string,
  file: string,
  content: string,
  message: string,
  role = "improve",
): Promise<string> {
  sh(repo, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(repo, file), content);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", message);
  const sha = sh(repo, "git", "rev-parse", "HEAD").trim();
  sh(repo, "git", "checkout", "main");
  await setRef(repo, landingRefName(role), sha);
  return sha;
}
import { conflictingMainEdit, fakePi, firstRunThenIdle, seedBranchEdit } from "./fake-pi.js";
import { waitForFile } from "./wait.js";
import { APPROVE_PI, assistantLine, reviewerPi } from "./pi-events.js";
// The crash path of plans/merge-queue.md invariant 7: a shutdown between the tick's commitAll
// and its landing leaves the pin on disk (the branch is already reset to main). The next tick
// must re-land that sha through the SAME gate — reviewed, never smuggled in unreviewed.
test("a landing pin left behind by an interrupted tick is re-landed through the gate on the next tick", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a commit not contained in main, pinned by the landing ref, with the
  // role branch back at main.
  const sha = await pinLeftover(repo, "crash.txt", "interrupted work\n", "interrupted tick's commit");

  // The next tick's recovery puts the pin on the land queue; the landing slot re-lands it
  // through the full gate: approve → land. The authoring branch would make a change, so a tick
  // that authored instead of ending on the recovery would show up as a second queued entry.
  const authored = path.join(tmpdir(), "authored");
  const restore = fakePi(
    [
      APPROVE_PI,
      `touch "${authored}"`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: new work")}'`,
      `echo new > new.txt`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();

    // Land-queue speed 3c — main has one writer: the tick QUEUES the leftover like a fresh
    // changed tick and never lands it itself.
    assert.equal(outcome.result, "queued");
    assert.equal(outcome.commit, sha);
    assert.equal(outcome.summary, "recovered leftover work from improve: interrupted tick's commit");
    assert.ok(!fs.existsSync(authored), "the recovery tick ran no authoring pass");
    assert.notEqual(mainSha(repo), sha, "nothing landed inside the tick");
    const tickEvents = readEvents(repo);
    assert.deepEqual(
      tickEvents.filter((e) => e.type === "land_queued").map((e) => e.commit),
      [sha],
      "the tick logged exactly one land_queued, for the pin",
    );
    assert.equal(tickEvents.filter((e) => e.type === "merged").length, 0, "no in-tick merged");
    assert.equal(queueDepth(repo), 1);
    assert.equal(headLanding(repo)?.entry.sha, sha);
    // The interlock state the orchestrator reads: the queued summary waits for the landing.
    assert.equal(runner.state.queuedSummary?.sha, sha);

    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    // The interrupted work landed on main via recovery — reviewed, not smuggled in.
    assert.equal(mainSha(repo), sha);
    assert.ok(fs.existsSync(path.join(repo, "crash.txt")), "the recovered file is on main");
    const merged = eventsOfType(repo, "merged");
    assert.ok(
      merged.some(
        (e) => String(e.summary) === "recovered leftover work from improve: interrupted tick's commit",
      ),
      "recovery is recorded as a merge of the leftover work, naming its subject",
    );
    assert.ok(!landingRefExists(repo, "improve"), "the pin was deleted once the work landed");
  } finally {
    restore();
  }
});

// A pin whose every landing ended in a conflict the resolver could not settle used to re-queue
// forever once recovery stopped landing in-tick (3c): the role never authored again. At
// MERGE_CONFLICT_LIMIT recovery drops the pin and the tick authors on fresh main, told why.
test("a pin at the merge-conflict cap is discarded and the tick authors, told what was dropped", async () => {
  const repo = await initializedRepo();
  const sha = await pinLeftover(repo, "stuck.txt", "unmergeable work\n", "work main outgrew");

  const prompts = path.join(tmpdir(), "prompts.log");
  const restore = fakePi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: fresh work")}'`,
      `echo new > new.txt`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    runner.state.mergeConflicts = { sha, count: MERGE_CONFLICT_LIMIT };
    const outcome = await runner.tick();

    assert.equal(outcome.result, "queued", "the tick authored and queued its own change");
    assert.notEqual(outcome.commit, sha);
    assert.equal(outcome.recoveredLeftover, undefined, "not a recovery tick");
    const prompt = fs.readFileSync(prompts, "utf8");
    assert.match(prompt, /Your previous change \("work main outgrew"\) was discarded without landing/);
    assert.match(prompt, new RegExp(`conflicted with main ${MERGE_CONFLICT_LIMIT} times`));
    const queued = eventsOfType(repo, "land_queued").map((e) => e.commit);
    assert.deepEqual(queued, [outcome.commit], "only the fresh change was queued, never the discarded pin");
    assert.equal(headLanding(repo)?.entry.sha, outcome.commit);
    assert.equal(runner.state.mergeConflicts, undefined, "the streak ended with the pin");
    assert.equal(runner.state.conflictDiscard, undefined, "the note was delivered with the queued change");
  } finally {
    restore();
  }
});

// BUGS.md 2026-09-19: recovery re-landed a high-friction commit without its flag (and its body),
// so the reviewer skipped the extra scrutiny the flag exists to trigger. Both are already stamped
// into the pinned commit's message; recovery must read them back and present them to the same
// gate a fresh tick uses.
test("a recovered high-friction commit reaches the reviewer with its flag and body", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a pinned commit whose message carries the harness's Friction trailer and
  // the author's WHY/RISK/VERIFIED, with the role branch back at main.
  const sha = await pinLeftover(
    repo,
    "recovered.txt",
    "work\n",
    [
      "tumwater(improve): slow but worthwhile",
      "",
      "WHY: the fix was fiddly",
      "RISK: touches the landing path",
      "VERIFIED: npm test, all pass",
      "",
      "Tick: improve #3 · turns 44 · ctx 20.0k",
      "Friction: high (44 turns / 4m)",
    ].join("\n"),
  );

  const reviewArgs = path.join(tmpdir(), "recovery-review-args");
  const restore = fakePi(
    [
      reviewerPi("VERDICT: approve", reviewArgs),
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "recovery queued the pin");
    assert.equal(outcome.highFriction, true, "the queued outcome keeps the recovered flag");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");

    // The re-review carried both the flag and the author's reasoning, reconstructed from the pin.
    const prompt = fs.readFileSync(reviewArgs, "utf8");
    assert.match(prompt, /HIGH-FRICTION/, "the recovered commit is flagged for extra scrutiny");
    assert.match(prompt, /WHY: the fix was fiddly/, "the recovered body rides into the gate");
    assert.equal(mainSha(repo), sha, "the recovered commit landed");
  } finally {
    restore();
  }
});

// A director tick dequeues its user prompt before recovery runs; a tick that ends on the
// recovery never ran that prompt, so it must go back to the inbox — the same policy as every
// other unfulfilled director outcome. (A user abort of the queued recovery landing is the
// landing slot's to handle now: landing-drain.test.ts pins that it discards the pin.)
test("a director tick that ends on leftover recovery puts its user prompt back", async () => {
  const repo = await initializedRepo();
  const sha = await pinLeftover(repo, "crash.txt", "interrupted work\n", "interrupted director commit", "director");
  const ran = path.join(tmpdir(), "ran");
  const restore = fakePi(`touch "${ran}"; printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  try {
    enqueuePrompt(repo, "important request");
    const runner = makeLoopRunner(repo, "director");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the director's leftover went on the land queue");
    assert.equal(headLanding(repo)?.entry.sha, sha);
    assert.ok(!fs.existsSync(ran), "no pi run: the prompt was never executed");
    assert.equal(inboxSize(repo), 1, "the prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
  } finally {
    restore();
  }
});

// The no-pin crash window: a shutdown between the tick's commitAll and its pin write leaves the
// commit on the role branch with NO landing ref. Recovery must fall back to the branch tip so
// invariant 1 (a shutdown between commit and landing loses nothing) holds whether or not the
// pin survived.
test("an unpinned commit ahead of main is recovered from the branch tip", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a commit on the role branch, no landing ref written.
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "unpinned.txt"), "committed but unpinned\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "the pin write never happened");
  const sha = sh(wt, "git", "rev-parse", "HEAD").trim();

  // The next tick's recovery finds no ref but a branch ahead of main: it re-lands the tip.
  const restore = fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    assert.equal((await runner.tick()).result, "queued", "recovery adopted and queued the tip");
    // The role worktree is freed as soon as the adopted pin holds the commit.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");

    // The unpinned work landed on main via recovery — reviewed, not smuggled in.
    assert.equal(mainSha(repo), sha);
    assert.ok(fs.existsSync(path.join(repo, "unpinned.txt")), "the recovered file is on main");
    const merged = eventsOfType(repo, "merged");
    assert.ok(
      merged.some(
        (e) => String(e.summary) === "recovered leftover work from improve: the pin write never happened",
      ),
      "recovery is recorded as a merge of the leftover work, naming its subject",
    );
    // The role worktree is clean at main whatever recovery did.
    assertClean(wt);
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("an unmergeable leftover is retried on the next tick and keeps its landing pin", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // routes through): approve, so recovery reaches the merge and can fail there. Phase
  // 1 (tick 1): branch edit + conflicting main advance. Every conflict-resolution run
  // (detected by markers in seed.txt) leaves the markers: unresolvable, both ticks.
  const restore = fakePi(
    [
      reviewerPi(`VERDICT: approve\n1. checked the diff; it holds`),
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      ...seedBranchEdit(),
      ...conflictingMainEdit(repo),
      `elif grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  : # leave the markers in place (unresolvable)`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");

    // Tick 2: recovery re-queues the pin, and its landing goes through the same gate (the early
    // approved return — no reviewer run — since the first landing's gate already signed off on
    // this HEAD) and hits the same unresolvable conflict.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");

    // merge_conflict is non-terminal: a fresh-context retry may resolve what two consecutive
    // attempts could not (a bounded attempt count lands with merge queue 3/5; review failures
    // have their own strike cap). The pin survives for the next tick's retry, and main keeps
    // its version either way.
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the unmergeable commit is kept for the next tick's retry");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n");
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("a failed recovery review keeps its pinned commit for re-review", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate): reply without a
  // VERDICT line, failing closed under the strike cap both times. The FIRST review run only
  // leaves an untracked stray file in the worktree it runs in (_land-improve) — guarded so the
  // recovery review does not recreate it and mask the cleanup assertion below. Phase 1 (tick
  // 1): edit seed.txt on the branch — its commit is pinned when the tick's own review fails.
  const strayOnce = path.join(tmpdir(), "stray-once");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      `  [ -f "${strayOnce}" ] || touch "${strayOnce}" stray.txt`,
      `  printf '%s\n' '${assistantLine("I think this is fine overall.")}'`,
      `  exit 0;; esac; done`,
      ...firstRunThenIdle(m1, seedBranchEdit()),
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "review_error");
    // The landing's commit is pinned for recovery; the role worktree is clean at main.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the failed review's commit is pinned for re-review");

    assert.equal((await runner.tick()).result, "queued", "tick 2 re-queued the pin");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "review_error");

    // The failed recovery review (under the strike cap) deliberately kept its pin for
    // re-review — a plain ref deletion would have discarded it. The role worktree stays
    // clean at main whatever recovery does, and the reviewer's stray file in _land-improve
    // is cleaned by the next landing's ensureDetachedWorktree.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const wt = worktreePath(repo, "improve");
    assert.ok(!fs.existsSync(path.join(wt, "stray.txt")), "no stray file in the role worktree");
    assertClean(wt, "no uncommitted edits remain");
    const landWt = path.join(repo, ".tumwater/worktrees/_land-improve");
    assert.ok(!fs.existsSync(path.join(landWt, "stray.txt")), "the reviewer's stray file is cleaned on re-landing");
    const failed = eventsOfType(repo, "review_failed");
    assert.equal(failed.length, 2, "both the tick's review and its recovery review failed");
    assert.ok(
      failed.some((e) => /no parseable VERDICT/.test(String(e.message))),
      `expected a verdict-less review failure, got: ${JSON.stringify(failed)}`,
    );
    // Tick 2's own result was `queued`; the first landing's review failure (still in the shared
    // `lastError` when tick 2 started) must not latch onto its `tick_end` as the tick's error
    // (BUGS.md 2026-09-21). The review_failed events above are where the landing failures live.
    const tickEnds = eventsOfType(repo, "tick_end");
    const tick2End = tickEnds[tickEnds.length - 1]!;
    assert.equal(tick2End.result, "queued");
    assert.equal(tick2End.error, undefined, "a healthy tick's tick_end carries no stale landing error");
  } finally {
    restore();
  }
});

test("a persistent recovery review failure feeds the error streak and reads failing", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "streak-phase1");
  // Phase 0 (a run whose prompt asks for a VERDICT — the review gate): the backend is down, so
  // pi exits nonzero with no reply. That is a FAILED run, not a strike against the HEAD, so the
  // pin is kept indefinitely (src/review.ts) — the "dead reviewer backend" of the bug. Phase 1
  // (tick 1): commit and pin. Every later tick ends on leftover recovery, which re-queues the
  // pin. Before the fix the streak reset on each recovery tick and nothing ever named the
  // wedged pin (BUGS.md 2026-09-21).
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) echo "reviewer backend down" >&2; exit 1;; esac; done`,
      ...firstRunThenIdle(m1, seedBranchEdit()),
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "review_error");

    // Each following tick re-queues the still-pinned commit, and its landing's review fails
    // again. The ticks themselves end `queued` — healthy on their face — so only the re-queued
    // landing failure they carry can grow the streak.
    for (let i = 0; i < ERROR_STREAK_WARN; i++) {
      assert.equal((await runner.tick()).result, "queued", "the tick re-queued the leftover");
      assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "review_error");
    }
    assert.equal(runner.state.consecutiveErrors, ERROR_STREAK_WARN, "the landing failures fed the error streak");

    // One warning names the stuck gate, carrying the review failure's own reason (the detail
    // is not in lastError, which the sibling mislabel fix clears before tick_end).
    const warnings = eventsOfType(repo, "warning");
    assert.ok(
      warnings.some(
        (e) =>
          /3 consecutive tick failures/.test(String(e.message)) &&
          /review failed: reviewer backend down/.test(String(e.message)),
      ),
      `expected one warning naming the review failure, got: ${JSON.stringify(warnings)}`,
    );
    // Both dashboards read their phase from loopPhase.
    assert.equal(loopPhase(runner.state, true), "failing", "the dashboards read failing, not sleeping");
    // The failure kept the pin for another attempt.
    assert.equal(
      sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim().length,
      40,
      "the pinned leftover survives the persistent review failure",
    );
  } finally {
    restore();
  }
});

test("a shutdown mid-landing fails closed: the pinned commit survives for next-start recovery", async () => {
  const repo = await initializedRepo();
  // Author run (the tick prompt): make a change and finish. Review run (its prompt contains
  // VERDICT): hang until the abort kills it — simulating Ctrl+C while the LANDING is under
  // review. Since merge queue 3/5 the gate runs in the landing, not the tick, so the
  // shutdown hits the landing's signal — the same wiring the orchestrator's pipeline uses.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) exec sleep 30;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const controller = new AbortController();
  try {
    enqueuePrompt(repo, "ship the hello file");
    const runner = makeLoopRunner(repo, "director");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the tick ends at the pin; the landing runs after");
    const head = headLanding(repo);
    assert.ok(head, "the landing is queued");
    const landing = landHead(repo, runner, defaultConfig(), "director", "main", controller.signal);
    // Abort only once the lander worktree exists: an earlier abort would hit nothing.
    await waitForFile(path.join(repo, ".tumwater/worktrees/_land-director"));
    controller.abort();
    assert.equal(await landing, "aborted", "a mid-review shutdown is an abort, not a failed review");

    // Fail closed: nothing merged — the role worktree is clean at main and the commit survives
    // in its landing pin for the next start's leftover recovery. The queue entry itself is
    // dropped after the outcome: recovery rides the pin, never the queue.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/director"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("director")).trim();
    assert.ok(pinned.length === 40, "the pin survived the abort");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "the entry is dropped after the aborted landing");

    // The prompt was consumed by the COMPLETED tick (it committed and enqueued) — the work's
    // recovery is the pin, not a re-queued prompt. The state shows the aborted landing.
    assert.equal(inboxSize(repo), 0);
    const s = loadLoopState(repo, "director");
    assert.equal(s.lastResult, "aborted");
    assert.ok(!s.resumePending, "the director does not resume an author session");
    assert.ok(s.nextRunAt > Date.now(), "recovery runs at the role's normal cadence");
  } finally {
    // Kill any in-flight fake pi BEFORE PATH is restored: an orphaned run spawned after
    // restore would resolve `pi` to a later test's fake (or the real one) and corrupt it.
    controller.abort();
    restore();
  }
});

