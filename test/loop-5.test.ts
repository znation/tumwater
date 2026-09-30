/** Fifth slice of the loop e2e suite (after loop.test.ts, loop-2.test.ts, loop-3.test.ts and
 * loop-4.test.ts) — split so node --test runs the slices in parallel processes: top-level
 * tests within one file run sequentially, while each test FILE gets its own process (and its
 * own PATH, which fakePi's global PATH swap requires). The slices are balanced by measured
 * per-test duration (~51 s and ~43 s at 2026-09-25); keep them roughly equal when moving
 * tests between the files. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox.js";
import { refSha } from "../src/git.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/loop-state.js";
import { landingRefName, worktreePath } from "../src/paths.js";
import { ensureWorktree } from "../src/worktree.js";
import { headLanding, queueDepth } from "../src/landing-queue.js";
import { eventsOfType } from "./log-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { landHead } from "./orchestrator-fixtures.js";
import { initializedRepo, mainSha, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi, logFlagsTo } from "./fake-pi.js";
import { waitForFile } from "./wait.js";
import { APPROVE_PI, assistantLine, reviewerPi } from "./pi-events.js";

// The pin write can fail too: a stale lock file (a crash between lock and rename) blocks
// update-ref, so adoption cannot pin the tip. Recovery must fail the tick naming the commit,
// leave the work on the branch for the next tick, and run no model — a bookkeeping failure is
// no evidence about the backend.
test("a leftover whose pin cannot be written ends the tick in error and stays on the branch", async () => {
  const repo = await initializedRepo();
  // Same crash shape as above: a commit on the role branch, no landing ref written.
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "unpinned.txt"), "committed but unpinned\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "the pin write fails");
  const sha = sh(wt, "git", "rev-parse", "HEAD").trim();

  // Block the adoption: a leftover lock file makes update-ref fail without touching the ref.
  const lockDir = path.join(repo, ".git", "refs", "tumwater", "landing");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "improve.lock"), "");

  const ran = path.join(tmpdir(), "ran-pin");
  const restore = fakePi(`touch "${ran}"`);
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error", "a failed pin adoption fails the tick");
    assert.match(
      String(outcome.summary),
      new RegExp(`failed to pin leftover ${sha.slice(0, 8)}`),
      "the error names the commit it could not pin",
    );
    assert.equal(outcome.recoveredLeftover, true, "the error is recovery bookkeeping, not the model's");
    assert.ok(!fs.existsSync(ran), "no pi run: the tick ended before any authoring run");
    // The commit stays on the branch (invariant 1: nothing lost) and nothing was queued —
    // the pin never took, so no landing entry can hold it.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "1");
    assert.equal(await refSha(repo, landingRefName("improve")), null, "no pin was written");
    assert.equal(queueDepth(repo), 0, "nothing was queued without a pin");
  } finally {
    restore();
  }
});


test("resume falls back to a fresh tick when there is no session to continue", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = fakePi(
    [logFlagsTo(argsFile), `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    runner.state.resumePending = true; // e.g. the sessions were pruned since the abort
    assert.equal((await runner.tick()).result, "no_change");
    const run = fs.readFileSync(argsFile, "utf8").trim();
    assert.ok(!run.includes("--continue"), "nothing to resume: a fresh session is started");
    assert.ok(run.includes(" -n"));
    assert.equal(runner.state.resumePending, false, "the flag is still consumed");
    assert.equal(eventsOfType(repo, "resume").length, 0);
  } finally {
    restore();
  }
});

test("a crashed process (stale running flag) resumes like a graceful abort", async () => {
  const repo = await initializedRepo();
  const s = freshLoopState("improve");
  s.running = true; // Persisted at tick start; a crash never cleared it.
  saveLoopState(repo, s);
  const runner = makeLoopRunner(repo, "improve");
  assert.equal(runner.state.resumePending, true, "a crash mid-tick is resumed too");
  assert.equal(runner.state.running, false);

  // The director never resumes: its recovery is re-queuing the user prompt.
  const d = freshLoopState("director");
  d.running = true;
  saveLoopState(repo, d);
  const director = makeLoopRunner(repo, "director");
  assert.ok(!director.state.resumePending);
});

test("an aborted director tick re-queues the user prompt", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    assert.equal(inboxSize(repo), 1);
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "director", defaultConfig(), "main", controller.signal);
    setTimeout(() => controller.abort(), 300);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted");
    assert.equal(inboxSize(repo), 1, "prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
    assert.ok(!runner.state.resumePending, "the director recovers via the re-queued prompt, not a resume");
  } finally {
    restore();
  }
});

// User-initiated abort (tumwater abort --role <id>) vs harness shutdown: both kill the pi
// child, but a deliberate stop discards the half-done work and backs off like an unproductive
// tick instead of leaving it resumable. The marker-file plumbing that reaches here is covered
// by the orchestrator tests; these pin LoopRunner's own contract (the abort plan's loop e2e
// acceptance criterion).
test("a user-aborted tick discards work, backs off, and does not resume", async () => {
  const repo = await initializedRepo();
  // Writes a half-done change, then hangs until killed. `exec` so SIGTERM reaches sleep.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const config = defaultConfig();
    const runner = makeLoopRunner(repo, "improve", config);
    const before = mainSha(repo);
    const tick = runner.tick();
    // Abort only once the half-done edit has landed: a fixed timer can fire before the
    // fake pi even starts under parallel load.
    try {
      await waitForFile(path.join(worktreePath(repo, "improve"), "partial.txt"));
    } catch (err) {
      runner.abortTick(); // don't leave the hung fake pi running after a wait timeout
      throw err;
    }
    runner.abortTick();
    const outcome = await tick;
    assert.equal(outcome.result, "user_aborted");

    // The work is discarded: nothing lands on main and the planted dirty file is gone from
    // the worktree (reset --hard + clean -fd), so the next tick's leftover recovery finds
    // nothing to salvage.
    assert.equal(mainSha(repo), before, "nothing lands on main");
    const wt = worktreePath(repo, "improve");
    assert.ok(!fs.existsSync(path.join(wt, "partial.txt")), "the half-done edit is discarded");
    assert.equal(sh(wt, "git", "status", "--porcelain"), "", "no uncommitted edits remain");

    // A deliberate stop is not an interruption: no resume flag, and the loop backs off like
    // an unproductive tick instead of retrying immediately.
    const s = loadLoopState(repo, "improve");
    assert.ok(!s.resumePending, "nothing to resume — the work was discarded");
    assert.equal(s.backoffSeconds, config.idleBackoff.initialSeconds);
    assert.ok(s.nextRunAt > Date.now(), "backed off, not immediate");

    // The outcome is observable in the event feed.
    const ends = eventsOfType(repo, "tick_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.result, "user_aborted");
  } finally {
    restore();
  }
});

test("a user-aborted director tick drops the prompt instead of re-queueing it", async () => {
  const repo = await initializedRepo();
  // Hangs until killed; writes a marker first so the test can wait for the run to be in flight.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    assert.equal(inboxSize(repo), 1);
    const runner = makeLoopRunner(repo, "director");
    const tick = runner.tick();
    try {
      await waitForFile(path.join(worktreePath(repo, "director"), "partial.txt"));
    } catch (err) {
      runner.abortTick(); // don't leave the hung fake pi running after a wait timeout
      throw err;
    }
    runner.abortTick();
    const outcome = await tick;
    assert.equal(outcome.result, "user_aborted");

    // Contrast with a shutdown abort (which re-queues): an explicit stop IS the answer to
    // that request — the prompt is deliberately dropped, not retried.
    assert.equal(inboxSize(repo), 0, "the aborted prompt was not re-queued");
    const s = loadLoopState(repo, "director");
    assert.ok(!s.resumePending, "the director never resumes an author session");

    // The discard is explicit, not accidental: the dequeued prompt is cleared on the live
    // runner (item (a)) rather than left to be overwritten by the next tick's dequeue.
    assert.equal(
      (runner as unknown as { pending: { get(): string | null } }).pending.get(),
      null,
      "the dequeued prompt was discarded from the runner",
    );
  } finally {
    restore();
  }
});

test("a user-abort mid-review discards the committed work too", async () => {
  const repo = await initializedRepo();
  // Author run (the tick prompt): make a change and finish. Review run (its prompt contains
  // VERDICT): hang until the abort kills it — simulating `tumwater abort` while under review.
  // Since merge queue 3/5 the gate runs in the LANDING, not the tick: the abort below hits
  // the landing's signal (the same wiring the orchestrator's pipeline hands its vets). At the
  // loop level an aborted landing KEEPS the pin — the drain adds the deliberate-stop ref
  // deletion on top (pinned in the orchestrator tests). The queue entry itself is dropped:
  // retry rides the pin, never the queue.
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
    assert.equal(outcome.result, "queued", "the tick ends at the pin; the review is the landing's");
    const head = headLanding(repo);
    assert.ok(head, "the landing is queued");
    const landing = landHead(repo, runner, defaultConfig(), "director", "main", controller.signal);
    // Abort only once the lander worktree exists: an earlier abort would hit nothing.
    await waitForFile(path.join(repo, ".tumwater/worktrees/_land-director"));
    controller.abort();
    assert.equal(await landing, "aborted", "a mid-review abort is an abort, not a failed review");

    // Fail closed: nothing merged — the role worktree is clean at main AND the pin survives
    // the abort at this level for next-start recovery; a deliberate user stop discards the
    // ref, and that deletion is the DRAIN's job (pinned in the orchestrator tests, which run
    // the full loop with its userAborted flag). The queue entry is dropped either way.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/director"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("director")).trim();
    assert.ok(pinned.length === 40, "the pin survived the aborted landing");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "the entry is dropped after the aborted landing");

    // The tick COMPLETED (it committed and enqueued), so the prompt is consumed, not
    // re-queued — the work's recovery is the pin, not a fresh prompt run.
    assert.equal(inboxSize(repo), 0);
    const s = loadLoopState(repo, "director");
    assert.equal(s.lastResult, "aborted");
    assert.ok(!s.resumePending, "the director never resumes an author session");
    assert.ok(s.nextRunAt > Date.now(), "recovery runs at the role's normal cadence");
  } finally {
    controller.abort(); // kill the hung reviewer before PATH is restored
    restore();
  }
});

test("a failing director tick re-queues the user prompt (regression)", async () => {
  const repo = await initializedRepo();
  // pi fails hard: non-zero exit, no assistant text, and no file changes.
  const restore = fakePi(`echo 'pi exploded' >&2\nexit 1`);
  try {
    enqueuePrompt(repo, "please do the thing");
    const runner = makeLoopRunner(repo, "director");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.equal(inboxSize(repo), 1, "the unfulfilled prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "please do the thing");
  } finally {
    restore();
  }
});

test("a timed-out director tick re-queues the user prompt (regression)", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = makeLoopRunner(repo, "director", config);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /timed out/);
    assert.equal(inboxSize(repo), 1, "the unfulfilled prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
  } finally {
    restore();
  }
});

test("a director tick that handles a prompt with no file changes does not re-queue it", async () => {
  const repo = await initializedRepo();
  // pi answers the question in its reply and changes nothing: that IS fulfillment.
  const restore = fakePi(`printf '%s\n' '${assistantLine("The answer is 42.")}'`);
  try {
    enqueuePrompt(repo, "what is the answer?");
    const runner = makeLoopRunner(repo, "director");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal(inboxSize(repo), 0, "a handled prompt must not loop back into the inbox");
  } finally {
    restore();
  }
});

test("a timed-out tick reports an error and never commits partial work", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = makeLoopRunner(repo, "improve", config);
    const before = mainSha(repo);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /timed out/);
    assert.equal(mainSha(repo), before);
    assert.ok(runner.state.backoffSeconds > 0);
  } finally {
    restore();
  }
});

// A deadline that fires on a run still making progress killed a slow run, not a hung one —
// the case where discarding costs the most (BUGS.md 2026-09-29: 97 timeouts in 8 hours,
// ~55 agent-hours discarded). It is handled the way a quiet kill is handled.

test("a tick timeout that fires on a run still making progress is resumed like a quiet kill (regression)", async () => {
  const repo = await initializedRepo();
  // Speaks one real progress event, writes an edit, then runs on silently past the deadline:
  // a slow run. Contrast the zero-byte fixture above, whose timeout still discards.
  const restore = fakePi(
    [`printf '%s\\n' '${assistantLine("still working")}'`, `echo partial > partial.txt`, `exec sleep 30`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = makeLoopRunner(repo, "improve", config);
    const before = mainSha(repo);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "quiet_killed");
    assert.match(runner.state.lastError ?? "", /timed out .* making progress/);
    assert.equal(mainSha(repo), before, "nothing landed on main");
    assert.equal(runner.state.resumePending, true, "the slow run's session is resumed, not discarded");
    assert.equal(runner.state.resumeCause, "timeout");
    assert.ok(
      fs.existsSync(path.join(worktreePath(repo, "improve"), "partial.txt")),
      "the slow run's half-done edit survives for its resume",
    );
  } finally {
    restore();
  }
});

test("a timed-out run that emitted bytes but no progress event still discards (regression)", async () => {
  const repo = await initializedRepo();
  // Plain text on stdout: bytes without a single structured event are not progress (the same
  // rule that keeps zombie-stream keepalives from feeding the quiet watchdog), so the run has
  // not demonstrably begun and keeps today's discard path.
  const restore = fakePi(`echo just bytes\nexec sleep 30`);
  try {
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = makeLoopRunner(repo, "improve", config);
    const before = mainSha(repo);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /^timed out after 1s$/);
    assert.equal(mainSha(repo), before);
    assert.ok(runner.state.backoffSeconds > 0);
  } finally {
    restore();
  }
});

test("a rebase conflict is resolved by a second pi run and lands with linear history", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Phase 1 (the tick): edit seed.txt on the branch AND advance main with a conflicting
  // edit. Phase 2 (the resolution run): replace the conflict markers with a resolution.
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      APPROVE_PI,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `else`,
      // The resolution run emits two assistant turns on purpose (plans/commit-bodies.md
      // item c): if it leaked into the trailer's count, the Tick line below would read
      // turns 3 instead of turns 1.
      `  printf '%s\\n' '${assistantLine("looking at the conflict markers")}'`,
      `  printf '%s\\n' '${assistantLine("resolved\nSUMMARY: merged both sides")}'`,
      `  echo resolved > seed.txt`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    // The tick commits and enqueues; the LANDING is where the conflict is resolved now —
    // phase 2 (the resolution run) runs inside landHead.
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    // The resolution landed as a plain rebased commit: no merge commits on main.
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
    // Self-explaining commit bodies (plans/commit-bodies.md item c): the trailer counts
    // only the authoring run's turns — the reviewer and conflict-resolution runs fold into
    // tickTurns after the trailer string is already assembled.
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 1 · ctx 0$/m);
    // Routine conflict → pi-resolve → land is normal operation, not something to warn
    // about: the merged event and tick_end already cover observability.
    const warnings = eventsOfType(repo, "warning");
    assert.equal(
      warnings.length,
      0,
      `expected no warning events, got: ${JSON.stringify(warnings.map((w) => w.message))}`,
    );
  } finally {
    restore();
  }
});

test("an unresolvable conflict aborts cleanly and reports merge_conflict", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      APPROVE_PI,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `fi`, // Phase 2 does nothing: the conflict markers stay.
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    const wt = path.join(repo, ".tumwater/worktrees/improve");
    assert.ok(!sh(wt, "git", "status", "--porcelain").includes("UU"));
    // No rebase is left in progress: the branch ref is checked out again (mid-rebase HEAD
    // would be detached).
    assert.equal(sh(wt, "git", "symbolic-ref", "--short", "HEAD"), "tumwater/improve");
  } finally {
    restore();
  }
});

// A pi that commits during the tick (forbidden by the prompt, but a confused pi might do it)
// leaves an extra commit under the harness's own commit. When the merge's rebase stops on
// the stray one and the resolution run ALSO commits its resolution, `rebase --continue`
// replays the remaining authoring commit onto that stray commit, hits a SECOND conflict,
// and throws — landing-merge.ts's catch must abort cleanly and report merge_conflict instead of
// crashing or landing broken work (the only path that reaches it; see continueRebase's doc
// comment). Phase detection in the shim: reviewer runs carry VERDICT:, resolution runs find
// conflict markers in seed.txt, everything else is the authoring run.
test("a stray pi commit makes rebase --continue stop a second time: aborted, merge_conflict", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      APPROVE_PI,
      // Phase 2 (the resolution run): seed.txt carries conflict markers — resolve them, then
      // commit anyway. That stray commit is what `rebase --continue` replays the remaining
      // authoring commit onto.
      `if grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  echo resolved > seed.txt`,
      `  git add -A && git commit -m "stray resolver commit"`,
      `else`,
      // Phase 1 (the tick): pi commits its first edit itself (a stray commit the harness
      // never reviewed as such), then leaves a second edit uncommitted — the harness's
      // commitAll lands it on top, so the branch is two commits ahead of main. Main advances
      // with an edit that conflicts with the STRAY one, so the rebase stops there first.
      `  echo branch change 1 > seed.txt`,
      `  git add -A && git commit -m "stray authoring commit"`,
      `  echo branch change 2 > seed.txt`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the tick commits and enqueues; the conflict is the landing's");
    assert.equal(
      await landHead(repo, runner, defaultConfig(), "improve"),
      "merge_conflict",
      "the second conflict is reported, not crashed on",
    );
    // Nothing landed: main keeps its version…
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    // …and both of the tick's commits are kept for recovery — pinned by the landing ref (the
    // pin names the top commit, which contains the stray one below it).
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the tick's commits are kept for recovery via the pin");
    const wt = path.join(repo, ".tumwater/worktrees/improve");
    // No rebase is left in progress: the branch ref is checked out again (mid-rebase HEAD
    // would be detached), and no conflict markers survive.
    assert.equal(sh(wt, "git", "symbolic-ref", "--short", "HEAD"), "tumwater/improve");
    assert.ok(!sh(wt, "git", "status", "--porcelain").includes("UU"));
  } finally {
    restore();
  }
});

test("a dirty primary checkout blocks the fast-forward: merge_blocked, commit kept for recovery", async () => {
  const repo = await initializedRepo();
  // The user has uncommitted edits to seed.txt in the PRIMARY checkout (on main). The tick's
  // branch changes the same file, so `git merge --ff-only` must refuse to overwrite the local
  // edit — the one way ffMainTo fails after a clean rebase. A broken failure path here
  // would either clobber the user's work or report "changed" for work that never landed.
  const restore = fakePi(
    [
      // The review gate (any run whose prompt asks for a VERDICT) approves, so the tick reaches
      // the merge and can be blocked there.
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `echo branch change > seed.txt`,
    ].join("\n"),
  );
  try {
    fs.writeFileSync(path.join(repo, "seed.txt"), "user's uncommitted edit\n");
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_blocked");
    // The user's local edit survives — the blocked merge must not touch it.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "user's uncommitted edit\n");
    // main did not move; the tick's commit is kept in its landing pin for the next tick's
    // recovery — and the role worktree is clean at main whatever the landing outcome.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the blocked commit is pinned for recovery");
    assert.equal(sh(worktreePath(repo, "improve"), "git", "status", "--porcelain"), "", "role worktree clean at main");
    assert.match(sh(repo, "git", "show", "main:seed.txt"), /^seed$/);
    // The failure is recorded on the state; the retry rides the next tick's leftover recovery
    // at the role's NORMAL cadence — the tick itself was productive (it committed), so no
    // idle backoff applies to a landing failure.
    assert.equal(runner.state.lastError, "merge failed: merge_blocked");
    assert.ok(runner.state.nextRunAt > Date.now());
  } finally {
    restore();
  }
});

test("leftover commits from a failed merge are recovered on the next tick", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  const m2 = path.join(tmpdir(), "phase2");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // now routes through): approve, so the leftover may land. Phase 1 (tick 1): edit
  // seed.txt on the branch AND advance main with a conflicting edit. Phase 2 (tick 1's
  // resolution run): leave the markers — the merge fails and the tick's commit is left
  // stranded on the branch. Phase 3 (the re-queued landing's resolution run): resolve them
  // this time.
  const restore = fakePi(
    [
      reviewerPi(`VERDICT: approve\n1. checked the diff; it holds`),
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `elif [ ! -f "${m2}" ]; then`,
      `  touch "${m2}"`, // Unresolvable on the first attempt.
      `else`,
      `  if grep -q '<<<<<<<' seed.txt 2>/dev/null; then echo resolved > seed.txt`,
      `  else printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    // Tick 1 commits and enqueues; its landing hits the conflict and fails (the m2 phase
    // leaves the markers): that conflict state is what tick 2's recovery must salvage.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");
    // The landing's commit is pinned by its landing ref: that is what recovery must salvage.
    // (The role branch itself is clean at main — the pin is the leftover now.)
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the failed merge's commit is pinned for recovery");

    // Tick 2's recovery puts the pin back on the land queue and ends the tick there; the
    // landing slot then lands it.
    assert.equal((await runner.tick()).result, "queued", "tick 2 re-queued the leftover instead of authoring");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    // The stranded work landed on main via recovery.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    const merged = eventsOfType(repo, "merged");
    assert.ok(
      merged.some((e) => String(e.summary) === "recovered leftover work from improve: branch edit of seed"),
      "recovery is recorded as a merge of the leftover work, naming its subject",
    );
    // The branch is reset to main afterwards, so nothing is stranded twice.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});
