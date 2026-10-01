import test from "node:test";
import assert from "node:assert/strict";
import { finalizeTick } from "../src/tick-finalize.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState, loadLoopState, zeroCounters } from "../src/loop-state.js";
import { TickUsage } from "../src/tick-usage.js";
import type { TickOutcome } from "../src/tick-outcome.js";
import {
  applyLandingOutcome,
  ERROR_STREAK_WARN,
  QUIET_KILL_RESUME_LIMIT,
} from "../src/tick-outcome.js";
import type { LoopState } from "../src/loop-state.js";
import { initializedRepo } from "./repo-fixtures.js";
import { eventsOfType } from "./log-fixtures.js";

/** Run finalizeTick with the standard shape: an initialized repo, a fresh-ish loop state
 * reserved for a tick that started 50ms ago, and the project's default config. Tests override
 * only what they exercise. */
async function run(
  root: string,
  role: string,
  state: LoopState,
  outcome: TickOutcome,
  opts: { tick?: number; usage?: TickUsage; recoveryFailure?: string; mainBranch?: string } = {},
): Promise<TickOutcome> {
  const tick = opts.tick ?? 1;
  state.lastTickStartedAt = Date.now() - 50;
  state.running = true;
  return finalizeTick({
    root,
    role,
    mainBranch: opts.mainBranch ?? "main",
    config: defaultConfig(),
    state,
    outcome,
    tick,
    tickStartedAt: state.lastTickStartedAt,
    usage: opts.usage ?? new TickUsage(),
    ...(opts.recoveryFailure !== undefined ? { recoveryFailure: opts.recoveryFailure } : {}),
  });
}

test("finalizeTick folds the outcome onto the state, persists it, and logs tick_end", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  const returned = await run(root, "organize", s, {
    result: "no_change",
    summary: "nothing to do",
  });
  assert.equal(returned.result, "no_change");
  // The state was folded and saved: the tick is no longer running, the main head the
  // finalize read while the tick was reserved is persisted, and the completed pair is set.
  const saved = loadLoopState(root, "organize");
  assert.equal(saved.running, false);
  assert.notEqual(saved.lastMainHead, "");
  assert.equal(saved.lastResult, "no_change");
  assert.equal(saved.lastSummary, "nothing to do");
  assert.equal(saved.phase, undefined);
  // tick_end carries the tick's own span.
  const ends = eventsOfType(root, "tick_end");
  assert.equal(ends.length, 1);
  const end = ends[0]!;
  assert.equal(end.loop, "organize");
  assert.equal(end.result, "no_change");
  assert.equal(end.summary, "nothing to do");
  assert.equal(typeof end.durationMs, "number");
  assert.ok((end.durationMs as number) >= 50);
  // Zero usage rides on nothing: the fields are omitted, not zero.
  assert.equal(end.tokens, undefined);
  assert.equal(end.costUsd, undefined);
});

test("finalizeTick logs the tick number it was handed, not a re-read of state.ticks", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  // resetCounters zeroes state.ticks in place mid-tick; finalize must still announce the
  // tick number tick_start announced (deps.tick), never the zeroed counter.
  Object.assign(s, zeroCounters(s));
  await run(root, "organize", s, { result: "no_change" }, { tick: 7 });
  assert.equal(eventsOfType(root, "tick_end")[0]!.tick, 7);
});

test("finalizeTick rides nonzero per-tick usage on tick_end", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  s.generatedTokens = 4321;
  const usage = new TickUsage();
  usage.costUsd = 0.0125;
  await run(root, "organize", s, { result: "no_change" }, { usage });
  const end = eventsOfType(root, "tick_end")[0]!;
  assert.equal(end.tokens, 4321);
  assert.equal(end.costUsd, 0.0125);
});

test("finalizeTick warns once at the error-streak crossing and re-arms after a healthy tick", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  const error = (n: number): TickOutcome => ({ result: "error", summary: `fail ${n}`, error: `boom ${n}` });
  for (let n = 1; n < ERROR_STREAK_WARN; n++) {
    await run(root, "organize", s, error(n));
    assert.equal(eventsOfType(root, "warning").length, 0, `no warning at streak ${n}`);
  }
  // The crossing: streak === ERROR_STREAK_WARN exactly once per episode, naming lastError.
  await run(root, "organize", s, error(ERROR_STREAK_WARN));
  const warnings = eventsOfType(root, "warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.loop, "organize");
  assert.match(warnings[0]!.message as string, /^3 consecutive tick failures: boom 3$/);
  // Past the crossing the streak keeps counting without re-warning.
  await run(root, "organize", s, error(ERROR_STREAK_WARN + 1));
  assert.equal(eventsOfType(root, "warning").length, 1);
  // A healthy tick resets the streak, re-arming the episode.
  await run(root, "organize", s, { result: "no_change" });
  await run(root, "organize", s, error(1));
  await run(root, "organize", s, error(2));
  await run(root, "organize", s, error(3));
  assert.equal(eventsOfType(root, "warning").length, 2);
});

test("a queued tick preserving the streak at the bar does not re-warn — the landing resolves the episode", async () => {
  // BUGS.md 2026-09-30: with review rejections feeding the streak, an authoring tick ends
  // `queued` while the streak stands at the bar — the old `=== ERROR_STREAK_WARN` gate would
  // re-warn on every such tick's end. The warn belongs to the outcome that did the
  // incrementing; the rejection's own crossing warns from the landing side
  // (writeLandingOutcome, pinned in the landing-slot tests).
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  const error = (n: number): TickOutcome => ({ result: "error", summary: `fail ${n}`, error: `boom ${n}` });
  await run(root, "organize", s, error(1));
  await run(root, "organize", s, error(2));
  await run(root, "organize", s, error(3));
  assert.equal(eventsOfType(root, "warning").length, 1);
  // The authoring run succeeds and enqueues: the streak stands preserved at the bar, and the
  // queued tick's end must not re-warn on it.
  await run(root, "organize", s, { result: "queued", commit: "a".repeat(40) });
  assert.equal(s.consecutiveErrors, ERROR_STREAK_WARN, "the queued tick preserves the streak");
  assert.equal(eventsOfType(root, "warning").length, 1, "no re-warn from the preserved streak");
  // The landing rejects: the streak climbs past the bar, still one episode, one warning.
  applyLandingOutcome(s, "rejected", { sha: "a".repeat(40), summary: "x" });
  assert.equal(s.consecutiveErrors, ERROR_STREAK_WARN + 1);
  assert.equal(eventsOfType(root, "warning").length, 1);
  // A landed change ends the episode (the landing is its clean verdict); the next one
  // re-arms from scratch and warns again at its own crossing.
  applyLandingOutcome(s, "changed", { sha: "b".repeat(40), summary: "y" });
  assert.equal(s.consecutiveErrors, 0);
  await run(root, "organize", s, error(1));
  await run(root, "organize", s, error(2));
  await run(root, "organize", s, error(3));
  assert.equal(eventsOfType(root, "warning").length, 2, "the next episode warns again");
});

test("finalizeTick warns once at the quiet-kill streak crossing", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  const killed = (n: number): TickOutcome => ({ result: "quiet_killed", summary: `kill ${n}` });
  for (let n = 1; n < QUIET_KILL_RESUME_LIMIT; n++) {
    await run(root, "organize", s, killed(n));
    assert.equal(eventsOfType(root, "warning").length, 0, `no warning at streak ${n}`);
  }
  await run(root, "organize", s, killed(QUIET_KILL_RESUME_LIMIT));
  const warnings = eventsOfType(root, "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message as string, /^3 consecutive quiet kills \(no progress\): /);
  // Past the crossing: no re-warning while the episode continues.
  await run(root, "organize", s, killed(QUIET_KILL_RESUME_LIMIT + 1));
  assert.equal(eventsOfType(root, "warning").length, 1);
});

test("a leftover recovery failure feeds the error streak but never rides the tick's tick_end", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  // The tick itself ends `queued`; the re-queued pin's landing failure rides recoveryFailure.
  await run(root, "organize", s, { result: "queued", summary: "retried the pin" }, {
    recoveryFailure: "review gate errored",
  });
  const end = eventsOfType(root, "tick_end")[0]!;
  // The failure must not latch onto lastError: runTick cleared it so tick_end carries no
  // foreign error, yet the streak still counts the failure.
  assert.equal(end.error, undefined);
  assert.equal(end.result, "queued");
  const saved = loadLoopState(root, "organize");
  assert.equal(saved.consecutiveErrors, 1);
  // And the episode's warning, when the streak crosses, names the recovery failure.
  await run(root, "organize", s, { result: "queued" }, { recoveryFailure: "review gate errored" });
  await run(root, "organize", s, { result: "queued" }, { recoveryFailure: "review gate errored" });
  const warnings = eventsOfType(root, "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message as string, /3 consecutive tick failures: review gate errored$/);
});

test("finalizeTick folds a main_red cause onto lastError so tick_end logs it", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  await run(root, "organize", s, {
    result: "main_red",
    summary: "main is red",
    error: "build failed on main",
  });
  const end = eventsOfType(root, "tick_end")[0]!;
  assert.equal(end.error, "build failed on main");
  assert.equal(loadLoopState(root, "organize").lastError, "build failed on main");
});

test("finalizeTick restores a mid-tick wake instead of making it wait out the interval", async () => {
  const root = await initializedRepo();
  // Control: no mid-tick wake — the outcome schedules the next run an interval out.
  const plain = freshLoopState("organize");
  await run(root, "organize", plain, { result: "no_change" });
  assert.ok(plain.nextRunAt > Date.now(), "a plain tick schedules an interval out");
  // A wake consumed while the tick ran stamped wokenAt past the tick's start; the outcome
  // schedule overwrote it, so finalize must re-apply the demand: next run now, no backoff.
  const woken = freshLoopState("organize");
  woken.wokenAt = Date.now() + 1; // stamped after lastTickStartedAt, which run() sets to now-50
  await run(root, "organize", woken, { result: "no_change" });
  assert.equal(woken.backoffSeconds, 0);
  // The restore floors nextRunAt just past the end-save's stamp (a same-millisecond tie
  // would swallow the demand), so it can read one ms past the end stamp — but never an
  // interval out: that is the silent-wait the restore exists to prevent.
  assert.ok(woken.nextRunAt <= (woken.lastTickEndedAt ?? 0) + 1, "the wake was restored to now");
  // The restored wake persists with the state.
  assert.equal(loadLoopState(root, "organize").nextRunAt, woken.nextRunAt);
});

test("finalizeTick keeps the previous main head when main's head cannot be resolved", async () => {
  // The contract the ?? fallback encodes: branchHead returning null (a branch name that
  // resolves nowhere) must NOT wake the loop on "main moved" to nowhere — the previous head
  // stands. Driven with a mainBranch that resolves to nothing.
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  s.lastMainHead = "0123456789abcdef0123456789abcdef01234567";
  await run(root, "organize", s, { result: "no_change", summary: "nothing to do" }, {
    mainBranch: "no-such-branch",
  });
  assert.equal(loadLoopState(root, "organize").lastMainHead, "0123456789abcdef0123456789abcdef01234567",
    "the unresolvable head must not overwrite the previous one");
  // The tick still ended normally — the missing head is not an error.
  assert.equal(eventsOfType(root, "tick_end").length, 1);
});

test("the error-streak warning falls back to 'unknown error' when no cause is recorded", async () => {
  // An error outcome whose own error field is empty (and no leftover recovery failure riding
  // it): the crossing warning still fires, naming the fallback rather than printing blank.
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  for (let n = 1; n <= ERROR_STREAK_WARN; n++)
    await run(root, "organize", s, { result: "error", summary: `fail ${n}` });
  const warnings = eventsOfType(root, "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message as string, /^3 consecutive tick failures: unknown error$/);
});

test("the quiet-kill warning names the recorded error when the crossing tick carries one", async () => {
  // The quiet-kill message prefers the state's lastError (folded from this tick's outcome)
  // over the 'unknown hang' fallback: a kill whose outcome says why reports that reason.
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  const killed = (n: number): TickOutcome => ({ result: "quiet_killed", summary: `kill ${n}` });
  await run(root, "organize", s, killed(1));
  await run(root, "organize", s, killed(2));
  await run(root, "organize", s, { ...killed(3), error: "watchdog killed the session" });
  const warnings = eventsOfType(root, "warning");
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0]!.message as string,
    /^3 consecutive quiet kills \(no progress\): watchdog killed the session$/,
  );
});

test("a cut-off outcome keeps resumePending's delay against a mid-tick wake", async () => {
  const root = await initializedRepo();
  const s = freshLoopState("organize");
  s.wokenAt = Date.now() + 1;
  await run(root, "organize", s, { result: "no_change", cutOff: true });
  // restoreMidTickWake deliberately does not restore under resumePending: the next run waits
  // one interval from the compacted context, so nextRunAt stays an interval out.
  assert.ok(s.nextRunAt > Date.now());
});
