import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stageTickLanding } from "../src/tick-stage.js";
import { initProject } from "../src/init.js";
import { ensureWorktree } from "../src/worktree.js";
import { freshLoopState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { readQaCoverage } from "../src/qa-coverage.js";
import { queueDepth, queuedLandings } from "../src/land-queue.js";
import type { LoopState, PiRunResult, TickOutcome } from "../src/types.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import { makeRepo, sh } from "./util.js";

/** A successful pi run result; tests override only what they exercise. */
function okPi(over: Partial<PiRunResult> = {}): PiRunResult {
  return {
    ok: true,
    finalText: "",
    nothingToDo: false,
    refused: false,
    outputTokens: 0,
    peakContextTokens: 0,
    turns: 3,
    costUsd: 0,
    timedOut: false,
    quietKilled: false,
    aborted: false,
    contextExceeded: false,
    transientServerTimeout: false,
    transientRateLimit: false,
    transientPiCrash: false,
    finalMessageContentless: false,
    compacted: false,
    ...over,
  };
}

interface CtxOverrides {
  config?: (config: TumwaterConfig) => void;
  tickTurns?: number;
  piStartedAt?: number;
  userPrompt?: string | null;
  finalText?: string;
  flow?: { flow: string; result: "passed" | "bug" } | null;
  followUp?: PiRunResult | null;
  pinResult?: boolean;
  abortedOutcome?: TickOutcome;
}

interface CtxCalls {
  warnings: string[];
  summaryRequests: string[];
  pins: { wt: string; sha: string }[];
  abortedFinalized: number;
}

/** A TickStageContext for role "improve" over `state`, recording every callback call and
 * defaulting to: no follow-up, pins succeed, friction thresholds unreachable. */
function makeCtx(
  root: string,
  wt: string,
  state: LoopState,
  over: CtxOverrides = {},
): { ctx: ReturnType<typeof buildCtx>; calls: CtxCalls } {
  const calls: CtxCalls = { warnings: [], summaryRequests: [], pins: [], abortedFinalized: 0 };
  const config = defaultConfig();
  config.thrashTurns = 100;
  config.thrashMinutes = 1_000;
  if (over.config) over.config(config);
  const ctx = buildCtx(root, wt, state, config, calls, over);
  return { ctx, calls };
}

function buildCtx(
  root: string,
  wt: string,
  state: LoopState,
  config: TumwaterConfig,
  calls: CtxCalls,
  over: CtxOverrides,
) {
  return {
    root,
    role: "improve",
    state,
    config,
    tickTurns: over.tickTurns ?? 4,
    userPrompt: over.userPrompt ?? null,
    wt,
    finalText: over.finalText ?? "",
    piStartedAt: over.piStartedAt ?? Date.now(),
    flow: over.flow ?? null,
    warn: (message: string) => calls.warnings.push(message),
    requestSummary: async (requestWt: string) => {
      calls.summaryRequests.push(requestWt);
      return over.followUp ?? null;
    },
    pinAndReset: async (pinWt: string, sha: string) => {
      calls.pins.push({ wt: pinWt, sha });
      return over.pinResult ?? true;
    },
    finishAbortedTick: async () => {
      calls.abortedFinalized++;
      return over.abortedOutcome ?? { result: "aborted", summary: "aborted by the user" };
    },
  };
}

/** A fresh initialized repo plus the improve role's worktree with one changed file. */
async function setup(): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  await initProject(root, "A test project.");
  const wt = await ensureWorktree(root, "improve", "main");
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  return { root, wt };
}

test("a tick with a SUMMARY commits, pins, and enqueues the landing", async () => {
  const { root, wt } = await setup();
  const state: LoopState = { ...freshLoopState("improve"), ticks: 3 };
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "Work done.\nSUMMARY: add the feature\nWHY: it was missing\nVERIFIED: npm test\n",
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(outcome.summary, "add the feature");
  assert.ok(outcome.commit, "the commit sha is reported");
  assert.equal(calls.summaryRequests.length, 0, "no follow-up when the reply carries a SUMMARY");
  assert.deepEqual(calls.warnings, [], "no warnings on the happy path");

  // The commit carries the derived subject and the harness-stamped trailer.
  const log = sh(wt, "git", "log", "-1", "--format=%s%n%b");
  assert.equal(log.split("\n")[0], "tumwater(improve): add the feature");
  assert.match(log, /Tick: improve #3 · turns 4/);

  // The commit was pinned by the landing ref before the worktree was freed.
  assert.equal(calls.pins.length, 1);
  assert.equal(calls.pins[0]!.wt, wt);
  assert.equal(calls.pins[0]!.sha, outcome.commit);

  // Exactly one landing sits in the queue, pointing at the pinned commit.
  assert.equal(queueDepth(root), 1);
  const queued = queuedLandings(root);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.role, "improve");
  assert.equal(queued[0]!.sha, outcome.commit);
  assert.equal(queued[0]!.tick, 3);
  assert.equal(queued[0]!.summary, "add the feature");
  assert.equal(queued[0]!.highFriction, undefined);
});

test("a missing SUMMARY is recovered with one follow-up turn", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "changed some files but the message was cut off",
    followUp: okPi({ finalText: "SUMMARY: recovered summary\n" }),
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(outcome.summary, "recovered summary");
  assert.equal(calls.summaryRequests.length, 1);
  assert.equal(calls.summaryRequests[0], wt, "the follow-up runs in the tick's worktree");
  assert.match(calls.warnings[0]!, /recovered it with a follow-up turn/);
  assert.equal(queuedLandings(root)[0]!.summary, "recovered summary");
});

test("a follow-up that yields no SUMMARY falls back to the changed files", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "no summary anywhere",
    followUp: okPi({ finalText: "still nothing" }),
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.match(outcome.summary!, /feature\.ts/, "the subject names what actually changed");
  assert.match(calls.warnings[0]!, /follow-up gave none; subject derived from the changed files/);
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /feature\.ts/);
});

test("an aborted follow-up finalizes through the loop and queues nothing", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "cut off",
    followUp: okPi({ aborted: true }),
    abortedOutcome: { result: "aborted", summary: "aborted mid-summary" },
  });

  const outcome = await stageTickLanding(ctx);

  assert.deepEqual(outcome, { result: "aborted", summary: "aborted mid-summary" });
  assert.equal(calls.abortedFinalized, 1, "the loop's abort finalizer ran");
  assert.equal(calls.pins.length, 0, "nothing was pinned");
  assert.equal(queueDepth(root), 0);
  assert.equal(sh(wt, "git", "log", "-1", "--format=%s").includes("tumwater(improve)"), false,
    "no commit was made");
});

test("a tick past both friction thresholds is flagged, warned, and marked in the landing", async () => {
  const { root, wt } = await setup();
  const state: LoopState = { ...freshLoopState("improve"), ticks: 5 };
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: hard work\n",
    config: (c) => {
      c.thrashTurns = 2;
      c.thrashMinutes = 5;
    },
    tickTurns: 5,
    piStartedAt: Date.now() - 6.5 * 60_000,
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(outcome.highFriction, true);
  assert.match(outcome.summary!, /\(high friction: 5 turns \/ \d+m\)/);
  assert.match(calls.warnings[0]!, /high-friction tick: 5 turns in \d+ min/);
  assert.match(sh(wt, "git", "log", "-1", "--format=%b"), /^Friction: high \(5 turns \/ \d+m\)$/m);
  assert.equal(queuedLandings(root)[0]!.highFriction, true);
});

test("burning turns alone is not friction — the wall clock must pass too", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: fast work\n",
    config: (c) => {
      c.thrashTurns = 2;
      c.thrashMinutes = 5;
    },
    tickTurns: 5,
    piStartedAt: Date.now(),
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.highFriction, false, "a fast high-turn tick is ordinary work");
  assert.deepEqual(calls.warnings, []);
  assert.doesNotMatch(sh(wt, "git", "log", "-1", "--format=%b"), /Friction:/);
  assert.equal(queuedLandings(root)[0]!.highFriction, undefined, "the landing is not marked");
});

test("a failed pin reports an error, records lastError, and queues nothing", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    pinResult: false,
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "error");
  assert.equal(outcome.summary, "failed to pin the landing ref; left for next-tick recovery");
  assert.equal(state.lastError, "failed to pin the landing ref; left for next-tick recovery");
  assert.equal(queueDepth(root), 0);
  assert.equal(calls.pins.length, 1, "the pin was attempted once");
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add the feature/,
    "the commit itself still exists on the branch");
});

test("a qa flow record from the reply is written into the coverage file", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: fixed the bug\n",
    flow: { flow: "unit tests", result: "bug" },
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  const coverage = readQaCoverage(root);
  assert.deepEqual(coverage["unit tests"], {
    lastRunAt: coverage["unit tests"]!.lastRunAt,
    result: "bug",
    summary: "fixed the bug",
  }, "a bug flow records the tick's summary");
});

test("a passed qa flow records no summary", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: green suite\n",
    flow: { flow: "unit tests", result: "passed" },
  });

  await stageTickLanding(ctx);

  const coverage = readQaCoverage(root);
  assert.deepEqual(coverage["unit tests"], {
    lastRunAt: coverage["unit tests"]!.lastRunAt,
    result: "passed",
  });
});
