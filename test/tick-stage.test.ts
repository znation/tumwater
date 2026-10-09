import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stageTickLanding } from "../src/tick/tick-stage.js";
import { stageCheckFindings } from "../src/tick/stage-check.js";
import { assembleTickPrompt } from "../src/tick/tick-prompt.js";
import { commitIn, initializedRepo, initializedWorktree, sh, twoPlansDoc } from "./fixtures/repo-fixtures.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import { defaultConfig } from "../src/config/config.js";
import { readQaCoverage } from "../src/tick/qa-coverage.js";
import { queueDepth, queuedLandings } from "../src/landing/landing-queue.js";
import type { TickOutcome } from "../src/tick/tick-outcome.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import type { LoopState } from "../src/loop/loop-state.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { piRunResult } from "./fakes/fake-pi.js";

/** A fresh initialized repo plus the improve role's worktree with one changed file — the
 * staged change stageTickLanding commits in these tests. */
async function setup(): Promise<{ root: string; wt: string }> {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  return { root, wt };
}

/** A successful pi run result; tests override only what they exercise. */
function okPi(over: Partial<PiRunResult> = {}): PiRunResult {
  return piRunResult({ turns: 3, ...over });
}

interface CtxOverrides {
  config?: (config: TumwaterConfig) => void;
  tickTurns?: number;
  piStartedAt?: number;
  userPrompt?: string | null;
  revisionRound?: number;
  mainBranch?: string;
  /** The loop id the stage runs as; defaults to the improve role. */
  role?: string;
  finalText?: string;
  flow?: { flow: string; result: "passed" | "bug" } | null;
  followUp?: PiRunResult | null;
  /** Successive stageCheck results; the last one repeats. Defaults to a clean check. */
  stageChecks?: string[][];
  stageFix?: PiRunResult | null;
  /** When true, requestStageFix deletes the tick's only changed file, so the fix-up leaves a
   * clean worktree. */
  stageFixDrops?: boolean;
  /** When true, stageCheck runs the real stageCheckFindings (which stages the change and
   * restores the index) instead of returning canned findings. */
  realStageCheck?: boolean;
  pinResult?: boolean;
  abortedOutcome?: TickOutcome;
}

interface CtxCalls {
  warnings: string[];
  summaryRequests: string[];
  stageChecks: string[];
  stageFixRequests: { wt: string; findings: string[] }[];
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
  const calls: CtxCalls = {
    warnings: [],
    summaryRequests: [],
    stageChecks: [],
    stageFixRequests: [],
    pins: [],
    abortedFinalized: 0,
  };
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
    role: over.role ?? "improve",
    state,
    config,
    tickTurns: over.tickTurns ?? 4,
    userPrompt: over.userPrompt ?? null,
    revisionRound: over.revisionRound,
    mainBranch: over.mainBranch ?? "main",
    wt,
    finalText: over.finalText ?? "",
    piStartedAt: over.piStartedAt ?? Date.now(),
    flow: over.flow ?? null,
    warn: (message: string) => calls.warnings.push(message),
    requestSummary: async (requestWt: string) => {
      calls.summaryRequests.push(requestWt);
      return over.followUp ?? null;
    },
    stageCheck: async (checkWt: string) => {
      calls.stageChecks.push(checkWt);
      if (over.realStageCheck) {
        return stageCheckFindings(checkWt, "main", config.review.exemptPaths);
      }
      const results = over.stageChecks ?? [[]];
      const result = results[Math.min(calls.stageChecks.length - 1, results.length - 1)] ?? [];
      return result;
    },
    requestStageFix: async (fixWt: string, findings: string[]) => {
      calls.stageFixRequests.push({ wt: fixWt, findings });
      if (over.stageFixDrops) {
        fs.rmSync(path.join(fixWt, "feature.ts"), { force: true });
      }
      return over.stageFix ?? null;
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

const STAGE_PLANS = twoPlansDoc();

test("an unassigned tick that moves a plan records a staged claim", async () => {
  const root = await initializedRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), STAGE_PLANS);
  commitIn(root, "plans");
  const wt = await ensureWorktree(root, "improve", "main");
  // The tick implements Alpha and moves it into Done, and leaves its code change too.
  const moved = STAGE_PLANS.replace(/### Alpha[^\n]*\n\nBody\.\n\n/, "").replace(
    "## Done",
    "## Done\n\n### Alpha (planned 2026-01-01 by operator; done 2026-01-02 by improve)",
  );
  fs.writeFileSync(path.join(wt, "PLANS.md"), moved);
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = freshLoopState("feature-2");
  const { ctx } = makeCtx(root, wt, state, {
    role: "feature-2",
    mainBranch: "main",
    config: (c) => {
      (c.roles as Record<string, { enabled?: boolean; instances?: number }>).feature = {
        enabled: true,
        instances: 2,
      };
    },
    finalText: "Done.\nSUMMARY: implement alpha\nVERIFIED: npm test\n",
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(state.claim?.source, "staged");
  assert.equal(state.claim?.key, "alpha");
  assert.equal(state.claim?.file, "PLANS.md");
});

// A single-runner base has no sibling to hold the entry from, so its unassigned tick stages
// no claim — and the next tick's prompt is the same as before claims existed (part 4/7's
// "Single runner: prompts and scheduling are unchanged").
test("a bare feature tick that moves a plan stages no claim and leaves the next prompt unchanged", async () => {
  const root = await initializedRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), STAGE_PLANS);
  commitIn(root, "plans");
  const wt = await ensureWorktree(root, "feature", "main");
  const moved = STAGE_PLANS.replace(/### Alpha[^\n]*\n\nBody\.\n\n/, "").replace(
    "## Done",
    "## Done\n\n### Alpha (planned 2026-01-01 by operator; done 2026-01-02 by feature)",
  );
  fs.writeFileSync(path.join(wt, "PLANS.md"), moved);
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = freshLoopState("feature");
  const { ctx } = makeCtx(root, wt, state, {
    role: "feature",
    mainBranch: "main",
    finalText: "Done.\nSUMMARY: implement alpha\nVERIFIED: npm test\n",
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(state.claim, undefined, "a single-runner base is never assigned a claim");
  const next = assembleTickPrompt({ root, config: defaultConfig(), role: "feature", state });
  assert.ok(next);
  assert.doesNotMatch(next.prompt, /<assigned-entry>/, "the next prompt carries no assignment note");
});

test("an assigned tick that moves a different plan gets a stage-check finding", async () => {
  const root = await initializedRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), STAGE_PLANS);
  commitIn(root, "plans");
  const wt = await ensureWorktree(root, "feature-2", "main");
  // The tick was assigned Alpha but moved Beta out of Planned instead.
  const moved = STAGE_PLANS.replace(/### Beta[^\n]*\n\nBody\.\n\n/, "").replace(
    "## Done",
    "## Done\n\n### Beta (planned 2026-01-01 by operator; done 2026-01-02 by feature-2)",
  );
  fs.writeFileSync(path.join(wt, "PLANS.md"), moved);
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = freshLoopState("feature-2");
  state.claim = {
    file: "PLANS.md",
    key: "alpha",
    title: "Alpha (planned 2026-01-01 by operator)",
    at: Date.now(),
    source: "assigned",
  };
  const { ctx, calls } = makeCtx(root, wt, state, {
    role: "feature-2",
    mainBranch: "main",
    config: (c) => {
      (c.roles as Record<string, { enabled?: boolean; instances?: number }>).feature = {
        enabled: true,
        instances: 2,
      };
    },
    finalText: "Done.\nSUMMARY: implement\nVERIFIED: npm test\n",
  });

  await stageTickLanding(ctx);

  assert.equal(calls.stageFixRequests.length, 1, "the move costs one fix-up turn");
  assert.match(calls.stageFixRequests[0]!.findings.join("\n"), /moved a different one/);
});

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
  assert.equal(queued[0]!.priorReview, undefined, "a fresh tick carries no prior review");
});

test("a revision tick's queued landing carries the prior review's objections", async () => {
  const { root, wt } = await setup();
  const rejected = "a".repeat(40);
  const state: LoopState = {
    ...freshLoopState("improve"),
    lastReview: { verdict: "reject", reasons: ["fix the bug", "add a test"], head: rejected, at: Date.now() },
    revision: { sha: rejected, round: 1, at: Date.now() },
  };
  const { ctx } = makeCtx(root, wt, state, {
    revisionRound: 1,
    finalText: "SUMMARY: revise the feature\n",
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  const queued = queuedLandings(root);
  assert.equal(queued[0]!.revisionRound, 1);
  assert.deepEqual(queued[0]!.priorReview, { sha: rejected, reasons: ["fix the bug", "add a test"] });
  assert.equal(state.revision, undefined, "the revision is now in flight");
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

test("a follow-up that failed names its error instead of claiming 'gave none'", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "no summary anywhere",
    followUp: okPi({
      ok: false,
      errorMessage: "400 model_not_supported: the provider or policy is not valid",
    }),
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued", "the tick still commits with a derived subject");
  assert.match(outcome.summary!, /feature\.ts/);
  assert.match(calls.warnings[0]!, /the follow-up run failed/);
  assert.match(calls.warnings[0]!, /400 model_not_supported/);
  assert.doesNotMatch(calls.warnings[0]!, /gave none/, "the failure is not reported as an empty reply");
});

test("a missing SUMMARY with no follow-up session says so", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "no summary anywhere",
    followUp: null,
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.match(outcome.summary!, /feature\.ts/);
  assert.match(calls.warnings[0]!, /no follow-up session was available/);
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

// ── The pre-queue self-check follow-up (PLANS.md "Pre-queue self-check, part 1/2") ──
// A changed tick's deterministic gate faults get one bounded follow-up turn on the author's
// own session before the commit; the change commits and queues either way.

test("a self-check finding triggers one follow-up and queues with the fixed warning", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["md-only BUGS.md edit moves X to Fixed, but none of its symbols exist"], []],
    stageFix: okPi({ finalText: "SUMMARY: add the feature\nWHY: fixed the symbol claim\n" }),
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageChecks.length, 2, "the check runs before and after the fix-up");
  assert.equal(calls.stageFixRequests.length, 1, "exactly one follow-up run");
  assert.equal(calls.stageFixRequests[0]!.wt, wt);
  assert.deepEqual(calls.stageFixRequests[0]!.findings, [
    "md-only BUGS.md edit moves X to Fixed, but none of its symbols exist",
  ]);
  assert.deepEqual(calls.warnings, ["stage self-check: 1 finding — fixed by the follow-up turn"]);
  assert.equal(queuedLandings(root)[0]!.summary, "add the feature");
});

test("a partial fix-up body keeps the fields it did not restate", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx } = makeCtx(root, wt, state, {
    finalText:
      "SUMMARY: add the feature\nWHY: original why\nRISK: original risk\nVERIFIED: original verified\n",
    stageChecks: [["a finding"], []],
    stageFix: okPi({ finalText: "WHY: revised why\n" }),
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  const body = sh(wt, "git", "log", "-1", "--format=%b");
  assert.match(body, /WHY: revised why/);
  assert.match(body, /RISK: original risk/, "the authoring run's RISK survives a partial reply");
  assert.match(body, /VERIFIED: original verified/, "the authoring run's VERIFIED survives too");
});

test("a finding the follow-up leaves unfixed still queues, with the still-open warning", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"], ["a finding"]],
    stageFix: okPi({ finalText: "RISK: the finding is wrong\n" }),
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageChecks.length, 2);
  assert.equal(calls.stageFixRequests.length, 1);
  assert.deepEqual(calls.warnings, ["stage self-check: 1 finding; 1 still open, queued for the gate"]);
  assert.equal(queueDepth(root), 1, "the change queues regardless");
});

test("a clean self-check runs no follow-up turn", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageChecks.length, 1);
  assert.equal(calls.stageFixRequests.length, 0);
  assert.deepEqual(calls.warnings, []);
});

test("no follow-up session leaves the finding for the gate and still queues", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"], ["a finding"]],
    stageFix: null,
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageFixRequests.length, 1, "the fix-up was attempted once");
  assert.deepEqual(calls.warnings, ["stage self-check: 1 finding; 1 still open, queued for the gate"]);
});

test("an aborted self-check follow-up finalizes through the loop and queues nothing", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"]],
    stageFix: okPi({ aborted: true }),
    abortedOutcome: { result: "aborted", summary: "aborted mid-fix" },
  });

  const outcome = await stageTickLanding(ctx);

  assert.deepEqual(outcome, { result: "aborted", summary: "aborted mid-fix" });
  assert.equal(calls.abortedFinalized, 1, "the loop's abort finalizer ran");
  assert.equal(calls.pins.length, 0, "nothing was pinned");
  assert.equal(queueDepth(root), 0);
});

test("a fix-up that reverts the whole change ends no_change with nothing queued", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"]],
    stageFix: okPi({ finalText: "RISK: the change should not exist; reverted\n" }),
    stageFixDrops: true,
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "no_change");
  assert.equal(calls.stageFixRequests.length, 1);
  assert.equal(calls.pins.length, 0, "a clean worktree is never pinned");
  assert.equal(queueDepth(root), 0, "nothing is queued");
  assert.deepEqual(calls.warnings, [
    "stage self-check: the follow-up turn left no change; nothing to land",
  ]);
});

test("the real staging self-check leaves the index clean, so a full revert still ends no_change", async () => {
  const { root, wt } = await setup();
  const state: LoopState = freshLoopState("improve");
  // Drop the tick's only change's final newline so the real git-level self-check raises a
  // finding and the follow-up turn runs. Unlike the canned-findings case above, this exercises
  // stageCheckFindings' own `git add -A`, whose staging must not survive into the guard's
  // changedFiles read: a stale staged addition would make the revert look like a live change.
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    realStageCheck: true,
    stageFix: okPi({ finalText: "RISK: the change should not exist; reverted\n" }),
    stageFixDrops: true,
  });

  const outcome = await stageTickLanding(ctx);

  assert.equal(outcome.result, "no_change");
  assert.equal(calls.stageFixRequests.length, 1, "the real finding triggered the fix-up");
  assert.equal(calls.pins.length, 0, "a clean worktree is never pinned");
  assert.equal(queueDepth(root), 0, "nothing is queued");
  assert.deepEqual(calls.warnings, [
    "stage self-check: the follow-up turn left no change; nothing to land",
  ]);
});
