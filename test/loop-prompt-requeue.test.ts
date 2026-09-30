/** The prompt-requeue survival cluster: a queued request must outlive every tick that
 * dequeues it but cannot fulfill — a red-main gate, a failed resume, and a crash after the
 * dequeue all hand the prompt back to its queue. This exercises the durable-copy policy
 * src/pending-prompt.ts implements. Split from the numbered loop-2.test.ts grab-bag so the
 * concern has a topic-named file like its siblings. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dequeuePrompt, dequeueRolePrompt, enqueueRolePrompt, queuedRolePrompts } from "../src/inbox.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { initializedRepo, makeMainRed, tmpdir } from "./repo-fixtures.js";
import { fakePi, logPromptsTo, readPromptRuns, TOUCH_SESSION } from "./fake-pi.js";
import { assistantLine, errorLine, thinkingOnlyLine } from "./pi-events.js";

// PLANS.md "Per-role prompts 1/2" criterion (b), red-gate arm: a per-role prompt is dequeued
// before the red-main gate runs (the gate needs the assembled prompt), so a blocked tick MUST
// put it back — the pending field is memory-only, and a prompt lost here never runs.
test("a role prompt queued while main is red survives the blocked tick", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs-role-prompt");
  makeMainRed(repo, counter);
  enqueueRolePrompt(repo, "feature", "check the flow");
  const marker = path.join(tmpdir(), "pi-invoked-role-prompt");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const runner = makeLoopRunner(repo, "feature");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "main_red");
    assert.ok(!fs.existsSync(marker), "no pi run starts while main is red");

    // The dequeued prompt is back in the feature queue — not the director's — ready for the
    // next tick once main is green.
    assert.deepEqual(dequeueRolePrompt(repo, "feature"), "check the flow");
    assert.equal(dequeueRolePrompt(repo, "feature"), null);
    assert.equal(dequeuePrompt(repo), null);
  } finally {
    restore();
  }
});

// A resume-owning tick (cut-off, quiet-kill, shutdown) re-queues its user prompt as the durable
// copy, but the resumed session still owns that request in its context: the resume must reclaim
// exactly that copy as its own user prompt, or a fulfilling resume leaves it queued and a later
// fresh tick runs the same request a second time (BUGS.md 2026-09-25).
test("a cut-off tick's requeued role prompt is reclaimed by the resume, not run twice", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts-reclaim.log");
  const counter = path.join(tmpdir(), "reclaim-count");
  // Run 1 (fresh, carrying the queued prompt) is cut off contentless; run 2 (the resume) is a
  // fulfilled nothing-to-do — the outcome that must consume the reclaimed prompt.
  const restore = fakePi(
    [
      logPromptsTo(promptsFile),
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
      `if [ "$n" = 1 ]; then ${TOUCH_SESSION}; printf '%s\\n' '${thinkingOnlyLine("cut off mid-task", { output: 16 })}'; else printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
    ].join("\n"),
  );
  try {
    enqueueRolePrompt(repo, "perf", "fix the flubbernator");
    const runner = makeLoopRunner(repo, "perf");
    const first = await runner.tick();
    assert.equal(first.result, "no_change");
    assert.equal(first.cutOff, true, "run 1 was cut off at the context ceiling");
    assert.equal(runner.state.resumePending, true, "the next tick resumes the compacted session");
    assert.match(fs.readFileSync(promptsFile, "utf8"), /flubbernator/, "tick 1 ran the queued prompt");
    assert.deepEqual(queuedRolePrompts(repo, "perf"), ["fix the flubbernator"], "the durable copy is queued");

    const second = await runner.tick();
    assert.equal(second.result, "no_change");
    const runs = readPromptRuns(promptsFile);
    assert.equal(runs.length, 2);
    assert.match(runs[1]!, /--continue/, "tick 2 resumed the cut-off session");
    // The fulfilling resume consumed the requeued copy: nothing is left for a fresh tick to run
    // again. Pre-fix the copy stayed queued and tick 3 re-ran the same request.
    assert.deepEqual(queuedRolePrompts(repo, "perf"), [], "the resume consumed the requeued prompt");
    assert.equal(runner.state.resumePromptFile, undefined, "the reclaim record is consumed");

    const third = await runner.tick();
    assert.equal(third.result, "no_change");
    const runs3 = readPromptRuns(promptsFile);
    assert.equal(runs3.length, 3);
    assert.doesNotMatch(runs3[2]!, /--continue/, "tick 3 is fresh again");
    assert.doesNotMatch(runs3[2]!, /flubbernator/, "tick 3 does not re-run the fulfilled request");
  } finally {
    restore();
  }
});

test("a failed resume re-queues the reclaimed prompt, so the request is not lost", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts-reclaim-fail.log");
  const counter = path.join(tmpdir(), "reclaim-fail-count");
  // Run 1 (fresh) is cut off; run 2 (the resume) fails without changes; run 3 (fresh) retries.
  const restore = fakePi(
    [
      logPromptsTo(promptsFile),
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
      `if [ "$n" = 1 ]; then ${TOUCH_SESSION}; printf '%s\\n' '${thinkingOnlyLine("cut off mid-task", { output: 16 })}'; elif [ "$n" = 2 ]; then printf '%s\\n' '${errorLine("backend exploded")}'; else printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
    ].join("\n"),
  );
  try {
    enqueueRolePrompt(repo, "perf", "fix the flubbernator");
    const runner = makeLoopRunner(repo, "perf");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal((await runner.tick()).result, "error", "the resume failed");
    // The reclaim took the queue copy and the failed resume put it back: the request survives.
    assert.deepEqual(queuedRolePrompts(repo, "perf"), ["fix the flubbernator"], "the failed resume re-queued the prompt");
    assert.equal((await runner.tick()).result, "no_change");
    const runs = readPromptRuns(promptsFile);
    assert.equal(runs.length, 3);
    assert.doesNotMatch(runs[1]!, /flubbernator/, "the resume bridge does not re-send the request text");
    assert.match(runs[2]!, /flubbernator/, "the fresh tick after the failed resume retries the request");
  } finally {
    restore();
  }
});

// The prompt is dequeued (or reclaimed) into memory before the tick's environment work starts,
// so an exception between the dequeue and the pi run leaves the request only in the pending
// field — memory the failed tick drops. The queue is the durable store, so the catch must
// re-queue whatever is still pending, like every unfulfilled outcome does.
test("a tick that throws after dequeuing the prompt re-queues it instead of losing it", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "pi-invoked-crash");
  const restore = fakePi(`touch '${marker}'`);
  try {
    enqueueRolePrompt(repo, "perf", "fix the flubbernator");
    const runner = makeLoopRunner(repo, "perf");
    // Corrupt the repo's HEAD so ensureWorktree throws after the dequeue — an environment
    // failure, not a pi outcome the outcome handlers could re-queue from.
    fs.rmSync(path.join(repo, ".git", "HEAD"));
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.ok(!fs.existsSync(marker), "no pi run starts before the crash");
    // The dequeued prompt survived the crash in its queue, ready for the next tick.
    assert.deepEqual(
      queuedRolePrompts(repo, "perf"),
      ["fix the flubbernator"],
      "the dequeued prompt is back in the queue, not lost",
    );
  } finally {
    restore();
  }
});
