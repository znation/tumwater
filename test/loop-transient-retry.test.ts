/** The loop's transient-retry topic: when a tick's pi run dies on a retriable backend
 * failure (a predict-stream timeout, a provider 429), the harness retries the run once
 * and the retry's verdict stands in for the tick. Split out of loop-3.test.ts
 * (2026-09-30) so the file name says what it pins, like loop-refusal.test.ts and
 * loop-quiet-watchdog.test.ts before it — each test FILE gets its own process (and its
 * own PATH, which fakePi's global PATH swap requires), so a topic file is also its own
 * slice. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { landHead } from "./orchestrator-fixtures.js";
import { initializedRepo, sh, tmpdir } from "./repo-fixtures.js";
import { firstRunThenIdle, withPi } from "./fake-pi.js";
import { eventsOfType } from "./log-fixtures.js";
import { APPROVE_PI, assistantLine, errorLine } from "./pi-events.js";

test("a transient model-server timeout is retried once and the tick succeeds (regression)", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Attempt 1 (the tick's pi run): LM Studio kills an idle predict stream after a machine
  // sleep. Attempt 2 (the harness retry, detected by the phase file): a fresh request
  // succeeds within seconds of the wake.
  const script = [
    ...firstRunThenIdle(marker, [
      `printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'`,
      `exit 1`,
    ]),
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the retry's verdict stands in for the tick");
    assert.ok(!runner.state.lastError);
    const warnings = eventsOfType(repo, "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) => /retrying the pi run once/.test(w)),
      `expected a retry warning, got: ${JSON.stringify(warnings)}`,
    );
    // A predict-stream timeout is a transient failure of the local backend, not the provider
    // rate-limiting the fleet: it must never feed the fleet-wide 429 hold.
    assert.equal(runner.lastRateLimit, undefined);
  });
});

test("a provider 429 rate-limit rejection is retried once and the tick succeeds (regression, BUGS.md 2026-09-21)", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase-429");
  // Attempt 1 (the tick's pi run): the provider rejects the request with 429 — the fleet's
  // single largest error source, and by definition retryable. Attempt 2 (the harness retry,
  // detected by the phase file): the limit has passed and the request succeeds.
  const script = [
    ...firstRunThenIdle(marker, [
      `printf '%s\\n' '${errorLine('429 "Rate limit exceeded"')}'`,
      `exit 1`,
    ]),
  ].join("\n");
  await withPi(script, async () => {
    // The hint-less 429 now defaults its retry wait to the minute-scale refill pause (BUGS.md
    // 2026-09-25); this end-to-end test injects an instant sleep and asserts the recorded wait
    // instead of living through the minute.
    const sleeps: number[] = [];
    const runner = makeLoopRunner(repo, "clean", defaultConfig(), "main", undefined, async (ms) => {
      sleeps.push(ms);
    });
    const before = Date.now();
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the retry's verdict stands in for the tick");
    assert.ok(!runner.state.lastError);
    const warnings = eventsOfType(repo, "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) => /rate-limited the request \(429/.test(w)),
      `expected a rate-limit retry warning, got: ${JSON.stringify(warnings)}`,
    );
    // The run that ended on the 429 is this role's input to the orchestrator's fleet-wide hold
    // (BUGS.md 2026-09-21 "A 429 storm still has no fleet-wide hold"), even though the tick's
    // retry went on to succeed: it is evidence the provider was limiting the fleet at that time.
    assert.ok(runner.lastRateLimit, "the 429 is recorded on the runner");
    assert.ok(runner.lastRateLimit.at >= before && runner.lastRateLimit.at <= Date.now());
    assert.equal(runner.lastRateLimit.retryAfterSeconds, undefined, "no hint in the fleet's error text");
    assert.deepEqual(sleeps, [60_000], "a hint-less 429 waits the minute-scale refill pause before its retry");
  });
});

// Self-explaining commit bodies (plans/commit-bodies.md item b): the trailer's turn count is
// the sum over this tick's PRE-COMMIT runs — main attempt plus, on a transient model-server
// timeout, the one resumed retry. runRolePi folds both into tickTurns via foldUsage before
// buildCommitMessage assembles the trailer, so a retried CHANGED tick's commit must read the
// combined count (the no_change regression above never commits, so its trailer is unobservable).
test("a transient-retry changed tick's trailer sums both runs' turns", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Attempt 1 (the tick's pi run): two assistant turns of work, then LM Studio kills the
  // idle predict stream — a failed run with transientServerTimeout set. The errored final
  // message is itself an assistant message_end, so attempt 1 counts as THREE turns. Attempt
  // 2 (the harness retry, detected by the phase file): one more turn that finishes the work.
  const script = [
    APPROVE_PI,
    // The retry branch finishes the work rather than idling — this is not the
    // firstRunThenIdle shape (its else must emit nothing-to-do), so it stays hand-rolled.
    `if [ ! -f "${marker}" ]; then`,
    `  touch "${marker}"`,
    `  printf '%s\\n' '${assistantLine("first turn of work")}'`,
    `  printf '%s\\n' '${assistantLine("second turn, still working")}'`,
    `  printf '%s\\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'`,
    `  exit 1`,
    `else`,
    `  printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
    `  echo hello > hello.txt`,
    `fi`,
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the retry's work is committed and enqueued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    // The trailer sums both runs' turns (3 + 1) — and only them: the reviewer run folds
    // after the commit. Peak ctx is the retry run's 42; attempt 1 carried no usage.
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 4 · ctx 42$/m);
  });
});
