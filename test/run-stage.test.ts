import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stageRunMerge } from "../src/run/run-stage.js";
import { stageCheckFindings } from "../src/run/stage-check.js";
import { assembleRunPrompt } from "../src/run/run-prompt.js";
import { commitIn, initializedRepo, initializedWorktree, sh, twoPlansDoc } from "./fixtures/repo-fixtures.js";
import { unwritableEvents } from "./fixtures/log-fixtures.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { defaultConfig } from "../src/config/config.js";
import { readQaCoverage } from "../src/run/qa-coverage.js";
import { queueDepth, queuedMerges } from "../src/merge/merge-queue.js";
import type { RunOutcome } from "../src/run/run-outcome.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { truncate } from "../src/text/text.js";
import { piRunResult } from "./fakes/fake-pi.js";

/** A fresh initialized repo plus the improve role's worktree with one changed file — the
 * staged change stageRunMerge commits in these tests. */
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
  runTurns?: number;
  piStartedAt?: number;
  userPrompt?: string | null;
  revisionRound?: number;
  modelLine?: string;
  mainBranch?: string;
  /** The role id the stage runs as; defaults to the improve role. */
  role?: string;
  finalText?: string;
  flow?: { flow: string; result: "passed" | "bug" } | null;
  followUp?: PiRunResult | null;
  /** When true, requestSummary commits every change in the worktree before it replies. */
  followUpCommits?: boolean;
  /** Successive stageCheck results; the last one repeats. Defaults to a clean check. */
  stageChecks?: string[][];
  stageFix?: PiRunResult | null;
  /** When true, requestStageFix deletes the run's only changed file, so the fix-up leaves a
   * clean worktree. */
  stageFixDrops?: boolean;
  /** When true, stageCheck runs the real stageCheckFindings (which stages the change and
   * restores the index) instead of returning canned findings. */
  realStageCheck?: boolean;
  pinResult?: boolean;
  abortedOutcome?: RunOutcome;
}

interface CtxCalls {
  warnings: string[];
  summaryRequests: string[];
  summaryOverLengths: (number | undefined)[];
  stageChecks: string[];
  stageFixRequests: { wt: string; findings: string[] }[];
  pins: { wt: string; sha: string }[];
  abortedFinalized: number;
}

/** A RunStageContext for role "improve" over `state`, recording every callback call and
 * defaulting to: no follow-up, pins succeed, friction thresholds unreachable. */
function makeCtx(
  root: string,
  wt: string,
  state: RunnerState,
  over: CtxOverrides = {},
): { ctx: ReturnType<typeof buildCtx>; calls: CtxCalls } {
  const calls: CtxCalls = {
    warnings: [],
    summaryRequests: [],
    summaryOverLengths: [],
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
  state: RunnerState,
  config: TumwaterConfig,
  calls: CtxCalls,
  over: CtxOverrides,
) {
  return {
    root,
    role: over.role ?? "improve",
    state,
    config,
    runTurns: over.runTurns ?? 4,
    userPrompt: over.userPrompt ?? null,
    revisionRound: over.revisionRound,
    modelLine: over.modelLine,
    mainBranch: over.mainBranch ?? "main",
    wt,
    finalText: over.finalText ?? "",
    piStartedAt: over.piStartedAt ?? Date.now(),
    flow: over.flow ?? null,
    warn: (message: string) => calls.warnings.push(message),
    requestSummary: async (requestWt: string, overLength?: number) => {
      calls.summaryRequests.push(requestWt);
      calls.summaryOverLengths.push(overLength);
      if (over.followUpCommits) {
        sh(requestWt, "git", "add", "-A");
        sh(requestWt, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pi commit");
      }
      return over.followUp ?? null;
    },
    stageCheck: async (checkWt: string) => {
      calls.stageChecks.push(checkWt);
      if (over.realStageCheck) {
        return stageCheckFindings(checkWt, "main", config.review.exemptPaths, "feature");
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
    finishAbortedRun: async () => {
      calls.abortedFinalized++;
      return over.abortedOutcome ?? { result: "aborted", summary: "aborted by the user" };
    },
  };
}

const STAGE_PLANS = twoPlansDoc();

test("an unassigned run that moves a plan records a staged claim", async () => {
  const root = await initializedRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), STAGE_PLANS);
  commitIn(root, "plans");
  const wt = await ensureWorktree(root, "improve", "main");
  // The run implements Alpha and moves it into Done, and leaves its code change too.
  const moved = STAGE_PLANS.replace(/### Alpha[^\n]*\n\nBody\.\n\n/, "").replace(
    "## Done",
    "## Done\n\n### Alpha (planned 2026-01-01 by operator; done 2026-01-02 by improve)",
  );
  fs.writeFileSync(path.join(wt, "PLANS.md"), moved);
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = freshRunnerState("feature-2");
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

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(state.claim?.source, "staged");
  assert.equal(state.claim?.key, "alpha");
  assert.equal(state.claim?.file, "PLANS.md");
});

test("an unassigned run still records its staged claim when the events feed is unwritable", async () => {
  const root = await initializedRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), STAGE_PLANS);
  commitIn(root, "plans");
  const wt = await ensureWorktree(root, "improve", "main");
  const moved = STAGE_PLANS.replace(/### Alpha[^\n]*\n\nBody\.\n\n/, "").replace(
    "## Done",
    "## Done\n\n### Alpha (planned 2026-01-01 by operator; done 2026-01-02 by improve)",
  );
  fs.writeFileSync(path.join(wt, "PLANS.md"), moved);
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = freshRunnerState("feature-2");
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
  // Put a directory where the append-only events log belongs: the claim event throws EISDIR
  // while every other file under the root still writes.
  unwritableEvents(root);

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(state.claim?.key, "alpha", "the claim is assigned despite the unwritable feed");
});

// A single-runner base has no sibling to hold the entry from, so its unassigned run stages
// no claim — and the next run's prompt is the same as before claims existed (part 4/7's
// "Single runner: prompts and scheduling are unchanged").
test("a bare feature run that moves a plan stages no claim and leaves the next prompt unchanged", async () => {
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
  const state = freshRunnerState("feature");
  const { ctx } = makeCtx(root, wt, state, {
    role: "feature",
    mainBranch: "main",
    finalText: "Done.\nSUMMARY: implement alpha\nVERIFIED: npm test\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(state.claim, undefined, "a single-runner base is never assigned a claim");
  const next = assembleRunPrompt({ root, config: defaultConfig(), role: "feature", state });
  assert.ok(next);
  assert.doesNotMatch(next.prompt, /<assigned-entry>/, "the next prompt carries no assignment note");
});

test("a run's finished plan is archived in its own commit: PLANS-DONE.md gains it, PLANS.md keeps open work", async () => {
  // plans/backlog-archive.md: the commit-time sweep runs right before the commit, so the commit
  // the review and the merge see carries the archived form.
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
  const { ctx } = makeCtx(root, wt, freshRunnerState("feature"), {
    role: "feature",
    mainBranch: "main",
    finalText: "Done.\nSUMMARY: implement alpha\nVERIFIED: npm test\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  const plans = sh(wt, "git", "show", `${outcome.commit}:PLANS.md`);
  assert.doesNotMatch(plans, /### Alpha/, "the live file holds only open work");
  assert.match(plans, /## Done$/, "the live file keeps its finished heading");
  assert.match(sh(wt, "git", "show", `${outcome.commit}:PLANS-DONE.md`), /## Done\n\n### Alpha \(planned 2026-01-01 by operator; done 2026-01-02 by feature\)/);
});

test("an assigned run that moves a different plan gets a stage-check finding", async () => {
  const root = await initializedRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), STAGE_PLANS);
  commitIn(root, "plans");
  const wt = await ensureWorktree(root, "feature-2", "main");
  // The run was assigned Alpha but moved Beta out of Planned instead.
  const moved = STAGE_PLANS.replace(/### Beta[^\n]*\n\nBody\.\n\n/, "").replace(
    "## Done",
    "## Done\n\n### Beta (planned 2026-01-01 by operator; done 2026-01-02 by feature-2)",
  );
  fs.writeFileSync(path.join(wt, "PLANS.md"), moved);
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  const state = freshRunnerState("feature-2");
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

  await stageRunMerge(ctx);

  assert.equal(calls.stageFixRequests.length, 1, "the move costs one fix-up turn");
  assert.match(calls.stageFixRequests[0]!.findings.join("\n"), /moved a different one/);
});

/** A feature-2 worktree over STAGE_PLANS whose uncommitted change moved `names` into Done and
 * wrote feature.ts — the shape of an unassigned primary's run at staging. */
async function movedPlansRun(names: string[]): Promise<{ root: string; wt: string }> {
  const root = await initializedRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), STAGE_PLANS);
  commitIn(root, "plans");
  const wt = await ensureWorktree(root, "feature-2", "main");
  let doc = STAGE_PLANS;
  for (const name of names) {
    doc = doc
      .replace(new RegExp(`### ${name}[^\\n]*\\n\\nBody\\.\\n\\n`), "")
      .replace("## Done", `## Done\n\n### ${name} (planned 2026-01-01 by operator; done 2026-01-02 by feature-2)`);
  }
  fs.writeFileSync(path.join(wt, "PLANS.md"), doc);
  fs.writeFileSync(path.join(wt, "feature.ts"), "export const feature = true;\n");
  return { root, wt };
}

const twoFeatureInstances = (c: TumwaterConfig): void => {
  (c.roles as Record<string, { enabled?: boolean; instances?: number }>).feature = { enabled: true, instances: 2 };
};

// BUGS.md 2026-10-12: an unassigned primary re-authored the entries its siblings held (24 of 29
// staged claims). The held titles ride its prompt; staging is the deterministic backstop.
test("an unassigned run that moves a plan a sibling holds gets a finding, not a second claim", async () => {
  const { root, wt } = await movedPlansRun(["Alpha"]);
  const state = freshRunnerState("feature-2");
  state.heldElsewhere = ["Alpha (planned 2026-01-01 by operator)"];
  const { ctx, calls } = makeCtx(root, wt, state, {
    role: "feature-2",
    config: twoFeatureInstances,
    finalText: "Done.\nSUMMARY: implement alpha\nVERIFIED: npm test\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(state.claim, undefined, "the sibling's entry is not claimed a second time");
  assert.equal(calls.stageFixRequests.length, 1, "the duplicate costs one fix-up turn");
  assert.match(calls.stageFixRequests[0]!.findings.join("\n"), /another instance of this role is working on: "Alpha/);
  // The fix-up turn left the change as it was: it still queues, and the gate has the final say.
  assert.equal(outcome.result, "queued");
});

test("a fix-up that drops a sibling's held entry leaves nothing to merge", async () => {
  const { root, wt } = await movedPlansRun(["Alpha"]);
  const state = freshRunnerState("feature-2");
  state.heldElsewhere = ["Alpha (planned 2026-01-01 by operator)"];
  const { ctx, calls } = makeCtx(root, wt, state, {
    role: "feature-2",
    config: twoFeatureInstances,
    finalText: "Done.\nSUMMARY: implement alpha\nVERIFIED: npm test\n",
  });
  // The author takes the finding: it reverts the entry's move and the work done for it.
  ctx.requestStageFix = async (fixWt: string, findings: string[]) => {
    calls.stageFixRequests.push({ wt: fixWt, findings });
    sh(fixWt, "git", "checkout", "--", "PLANS.md");
    fs.rmSync(path.join(fixWt, "feature.ts"));
    return null;
  };

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "no_change", "no duplicate reaches the gate, the review, or the merge slot");
  assert.equal(calls.pins.length, 0, "nothing was pinned");
  assert.ok(calls.warnings.some((w) => w.includes('nothing to land')), calls.warnings.join("\n"));
});

test("an unassigned run that moves a held plan and a free one claims the free one", async () => {
  const { root, wt } = await movedPlansRun(["Alpha", "Beta"]);
  const state = freshRunnerState("feature-2");
  state.heldElsewhere = ["Alpha (planned 2026-01-01 by operator)"];
  const { ctx, calls } = makeCtx(root, wt, state, {
    role: "feature-2",
    config: twoFeatureInstances,
    finalText: "Done.\nSUMMARY: implement both\nVERIFIED: npm test\n",
  });

  await stageRunMerge(ctx);

  assert.equal(state.claim?.key, "beta", "the free entry is this run's claim");
  assert.equal(state.claim?.source, "staged");
  const findings = calls.stageFixRequests[0]?.findings.join("\n") ?? "";
  assert.match(findings, /another instance of this role is working on: "Alpha/);
  assert.doesNotMatch(findings, /moved a different one/, "the staged claim's own move is not a finding");
});

test("a run with a SUMMARY commits, pins, and enqueues the merge", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = { ...freshRunnerState("improve"), runs: 3 };
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "Work done.\nSUMMARY: add the feature\nWHY: it was missing\nVERIFIED: npm test\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(outcome.summary, "add the feature");
  assert.ok(outcome.commit, "the commit sha is reported");
  assert.equal(calls.summaryRequests.length, 0, "no follow-up when the reply carries a SUMMARY");
  assert.deepEqual(calls.warnings, [], "no warnings on the happy path");

  // The commit carries the derived subject and the harness-stamped trailer.
  const log = sh(wt, "git", "log", "-1", "--format=%s%n%b");
  assert.equal(log.split("\n")[0], "tumwater(improve): add the feature");
  assert.match(log, /Run: improve #3 · turns 4/);

  // The commit was pinned by the merge ref before the worktree was freed.
  assert.equal(calls.pins.length, 1);
  assert.equal(calls.pins[0]!.wt, wt);
  assert.equal(calls.pins[0]!.sha, outcome.commit);

  // Exactly one merge sits in the queue, pointing at the pinned commit.
  assert.equal(queueDepth(root), 1);
  const queued = queuedMerges(root);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.role, "improve");
  assert.equal(queued[0]!.sha, outcome.commit);
  assert.equal(queued[0]!.run, 3);
  assert.equal(queued[0]!.summary, "add the feature");
  assert.equal(queued[0]!.highFriction, undefined);
  assert.equal(queued[0]!.priorReview, undefined, "a fresh run carries no prior review");
});

test("a run with a SUMMARY still enqueues its merge when the events feed is unwritable", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = { ...freshRunnerState("improve"), runs: 3 };
  const { ctx } = makeCtx(root, wt, state, {
    finalText: "Work done.\nSUMMARY: add the feature\nWHY: it was missing\nVERIFIED: npm test\n",
  });
  // Put a directory where the append-only events log belongs: the merge_queued event throws
  // EISDIR while every other file under the root still writes.
  unwritableEvents(root);

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(queueDepth(root), 1, "the merge is durably queued despite the unwritable feed");
  assert.equal(queuedMerges(root)[0]!.sha, outcome.commit);
});

test("a revision run's queued merge carries the prior review's objections", async () => {
  const { root, wt } = await setup();
  const rejected = "a".repeat(40);
  const state: RunnerState = {
    ...freshRunnerState("improve"),
    lastReview: { verdict: "reject", reasons: ["fix the bug", "add a test"], head: rejected, at: Date.now() },
    revision: { sha: rejected, round: 1, at: Date.now() },
  };
  const { ctx } = makeCtx(root, wt, state, {
    revisionRound: 1,
    finalText: "SUMMARY: revise the feature\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  const queued = queuedMerges(root);
  assert.equal(queued[0]!.revisionRound, 1);
  assert.deepEqual(queued[0]!.priorReview, { sha: rejected, reasons: ["fix the bug", "add a test"] });
  assert.equal(state.revision, undefined, "the revision is now in flight");
});

test("a missing SUMMARY is recovered with one follow-up turn", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "changed some files but the message was cut off",
    followUp: okPi({ finalText: "SUMMARY: recovered summary\n" }),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(outcome.summary, "recovered summary");
  assert.equal(calls.summaryRequests.length, 1);
  assert.equal(calls.summaryRequests[0], wt, "the follow-up runs in the run's worktree");
  assert.match(calls.warnings[0]!, /recovered it with a follow-up turn/);
  assert.equal(queuedMerges(root)[0]!.summary, "recovered summary");
});

test("an over-long SUMMARY is shortened with one follow-up turn", async () => {
  const { root, wt } = await setup();
  const { ctx, calls } = makeCtx(root, wt, freshRunnerState("improve"), {
    finalText: `SUMMARY: ${"x".repeat(140)}\nWHY: because\n`,
    followUp: okPi({ finalText: "SUMMARY: short form\n" }),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(outcome.summary, "short form");
  assert.deepEqual(calls.summaryOverLengths, [140]);
  assert.equal(queuedMerges(root)[0]!.summary, "short form");
  assert.ok(calls.warnings.some((w) => w.includes("shortened with a follow-up turn")));
});

test("a follow-up that stays over the cap keeps the truncated subject", async () => {
  for (const followUp of [okPi({ finalText: `SUMMARY: ${"y".repeat(150)}\n` }), null]) {
    const { root, wt } = await setup();
    const original = "x".repeat(140);
    const { ctx, calls } = makeCtx(root, wt, freshRunnerState("improve"), {
      finalText: `SUMMARY: ${original}\n`,
      followUp,
    });

    const outcome = await stageRunMerge(ctx);

    assert.equal(outcome.summary, truncate(original, 100));
    assert.ok(outcome.summary!.endsWith("…"));
    assert.ok(calls.warnings.some((w) => w.includes("subject truncated")));
  }
});

test("a SUMMARY within the cap asks no follow-up", async () => {
  const { root, wt } = await setup();
  const { ctx, calls } = makeCtx(root, wt, freshRunnerState("improve"), {
    finalText: `SUMMARY: ${"z".repeat(80)}\n`,
  });
  await stageRunMerge(ctx);
  assert.equal(calls.summaryRequests.length, 0);
});

test("a follow-up that yields no SUMMARY falls back to the changed files", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "no summary anywhere",
    followUp: okPi({ finalText: "still nothing" }),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.match(outcome.summary!, /feature\.ts/, "the subject names what actually changed");
  assert.match(calls.warnings[0]!, /follow-up gave none; subject derived from the changed files/);
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /feature\.ts/);
});

test("a follow-up that failed names its error instead of claiming 'gave none'", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "no summary anywhere",
    followUp: okPi({
      ok: false,
      errorMessage: "400 model_not_supported: the provider or policy is not valid",
    }),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued", "the run still commits with a derived subject");
  assert.match(outcome.summary!, /feature\.ts/);
  assert.match(calls.warnings[0]!, /the follow-up run failed/);
  assert.match(calls.warnings[0]!, /400 model_not_supported/);
  assert.doesNotMatch(calls.warnings[0]!, /gave none/, "the failure is not reported as an empty reply");
});

test("a missing SUMMARY with no follow-up session says so", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "no summary anywhere",
    followUp: null,
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.match(outcome.summary!, /feature\.ts/);
  assert.match(calls.warnings[0]!, /no follow-up session was available/);
});

test("an aborted follow-up finalizes through the role and queues nothing", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "cut off",
    followUp: okPi({ aborted: true }),
    abortedOutcome: { result: "aborted", summary: "aborted mid-summary" },
  });

  const outcome = await stageRunMerge(ctx);

  assert.deepEqual(outcome, { result: "aborted", summary: "aborted mid-summary" });
  assert.equal(calls.abortedFinalized, 1, "the runner's abort finalizer ran");
  assert.equal(calls.pins.length, 0, "nothing was pinned");
  assert.equal(queueDepth(root), 0);
  assert.equal(sh(wt, "git", "log", "-1", "--format=%s").includes("tumwater(improve)"), false,
    "no commit was made");
});

test("a run past both friction thresholds is flagged, warned, and marked in the merge", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = { ...freshRunnerState("improve"), runs: 5 };
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: hard work\n",
    config: (c) => {
      c.thrashTurns = 2;
      c.thrashMinutes = 5;
    },
    runTurns: 5,
    piStartedAt: Date.now() - 6.5 * 60_000,
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(outcome.highFriction, true);
  assert.match(outcome.summary!, /\(high friction: 5 turns \/ \d+m\)/);
  assert.match(calls.warnings[0]!, /high-friction run: 5 turns in \d+ min/);
  assert.match(sh(wt, "git", "log", "-1", "--format=%b"), /^Friction: high \(5 turns \/ \d+m\)$/m);
  assert.equal(queuedMerges(root)[0]!.highFriction, true);
});

test("burning turns alone is not friction — the wall clock must pass too", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: fast work\n",
    config: (c) => {
      c.thrashTurns = 2;
      c.thrashMinutes = 5;
    },
    runTurns: 5,
    piStartedAt: Date.now(),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.highFriction, false, "a fast high-turn run is ordinary work");
  assert.deepEqual(calls.warnings, []);
  assert.doesNotMatch(sh(wt, "git", "log", "-1", "--format=%b"), /Friction:/);
  assert.equal(queuedMerges(root)[0]!.highFriction, undefined, "the merge is not marked");
});

test("a failed pin reports an error, records lastError, and queues nothing", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    pinResult: false,
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "error");
  assert.equal(outcome.summary, "failed to pin the merge ref; left for the next run's recovery");
  assert.equal(state.lastError, "failed to pin the merge ref; left for the next run's recovery");
  assert.equal(queueDepth(root), 0);
  assert.equal(calls.pins.length, 1, "the pin was attempted once");
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add the feature/,
    "the commit itself still exists on the branch");
});

test("a qa flow record from the reply is written into the coverage file", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: fixed the bug\n",
    flow: { flow: "unit tests", result: "bug" },
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  const coverage = readQaCoverage(root);
  assert.deepEqual(coverage["unit tests"], {
    lastRunAt: coverage["unit tests"]!.lastRunAt,
    result: "bug",
    summary: "fixed the bug",
  }, "a bug flow records the run's summary");
});

test("a passed qa flow records no summary", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: green suite\n",
    flow: { flow: "unit tests", result: "passed" },
  });

  await stageRunMerge(ctx);

  const coverage = readQaCoverage(root);
  assert.deepEqual(coverage["unit tests"], {
    lastRunAt: coverage["unit tests"]!.lastRunAt,
    result: "passed",
  });
});

// ── The pre-queue self-check follow-up (PLANS.md "Pre-queue self-check, part 1/2") ──
// A changed run's deterministic gate faults get one bounded follow-up turn on the author's
// own session before the commit; the change commits and queues either way.

test("a self-check finding triggers one follow-up and queues with the fixed warning", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["md-only BUGS.md edit moves X to Fixed, but none of its symbols exist"], []],
    stageFix: okPi({ finalText: "SUMMARY: add the feature\nWHY: fixed the symbol claim\n" }),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageChecks.length, 2, "the check runs before and after the fix-up");
  assert.equal(calls.stageFixRequests.length, 1, "exactly one follow-up run");
  assert.equal(calls.stageFixRequests[0]!.wt, wt);
  assert.deepEqual(calls.stageFixRequests[0]!.findings, [
    "md-only BUGS.md edit moves X to Fixed, but none of its symbols exist",
  ]);
  assert.deepEqual(calls.warnings, ["stage self-check: 1 finding — fixed by the follow-up turn"]);
  assert.equal(queuedMerges(root)[0]!.summary, "add the feature");
});

test("a partial fix-up body keeps the fields it did not restate", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx } = makeCtx(root, wt, state, {
    finalText:
      "SUMMARY: add the feature\nWHY: original why\nRISK: original risk\nVERIFIED: original verified\n",
    stageChecks: [["a finding"], []],
    stageFix: okPi({ finalText: "WHY: revised why\n" }),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  const body = sh(wt, "git", "log", "-1", "--format=%b");
  assert.match(body, /WHY: revised why/);
  assert.match(body, /RISK: original risk/, "the authoring run's RISK survives a partial reply");
  assert.match(body, /VERIFIED: original verified/, "the authoring run's VERIFIED survives too");
});

test("a finding the follow-up leaves unfixed still queues, with the still-open warning", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"], ["a finding"]],
    stageFix: okPi({ finalText: "RISK: the finding is wrong\n" }),
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageChecks.length, 2);
  assert.equal(calls.stageFixRequests.length, 1);
  assert.deepEqual(calls.warnings, ["stage self-check: 1 finding; 1 still open, queued for the gate"]);
  assert.equal(queueDepth(root), 1, "the change queues regardless");
});

test("a clean self-check runs no follow-up turn", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageChecks.length, 1);
  assert.equal(calls.stageFixRequests.length, 0);
  assert.deepEqual(calls.warnings, []);
});

test("no follow-up session leaves the finding for the gate and still queues", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"], ["a finding"]],
    stageFix: null,
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  assert.equal(calls.stageFixRequests.length, 1, "the fix-up was attempted once");
  assert.deepEqual(calls.warnings, ["stage self-check: 1 finding; 1 still open, queued for the gate"]);
});

test("an aborted self-check follow-up finalizes through the role and queues nothing", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"]],
    stageFix: okPi({ aborted: true }),
    abortedOutcome: { result: "aborted", summary: "aborted mid-fix" },
  });

  const outcome = await stageRunMerge(ctx);

  assert.deepEqual(outcome, { result: "aborted", summary: "aborted mid-fix" });
  assert.equal(calls.abortedFinalized, 1, "the runner's abort finalizer ran");
  assert.equal(calls.pins.length, 0, "nothing was pinned");
  assert.equal(queueDepth(root), 0);
});

test("a fix-up that reverts the whole change ends no_change with nothing queued", async () => {
  const { root, wt } = await setup();
  const state: RunnerState = freshRunnerState("improve");
  const { ctx, calls } = makeCtx(root, wt, state, {
    finalText: "SUMMARY: add the feature\n",
    stageChecks: [["a finding"]],
    stageFix: okPi({ finalText: "RISK: the change should not exist; reverted\n" }),
    stageFixDrops: true,
  });

  const outcome = await stageRunMerge(ctx);

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
  const state: RunnerState = freshRunnerState("improve");
  // Drop the run's only change's final newline so the real git-level self-check raises a
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

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "no_change");
  assert.equal(calls.stageFixRequests.length, 1, "the real finding triggered the fix-up");
  assert.equal(calls.pins.length, 0, "a clean worktree is never pinned");
  assert.equal(queueDepth(root), 0, "nothing is queued");
  assert.deepEqual(calls.warnings, [
    "stage self-check: the follow-up turn left no change; nothing to land",
  ]);
});

for (const [label, finalText] of [
  ["missing-SUMMARY", "changed some files but the message was cut off"],
  ["over-long-SUMMARY", `SUMMARY: ${"x".repeat(140)}\nWHY: because\n`],
] as const) {
  test(`a commit made in the ${label} follow-up folds into the harness commit`, async () => {
    const { root, wt } = await setup();
    const base = sh(wt, "git", "rev-parse", "HEAD");
    const { ctx, calls } = makeCtx(root, wt, freshRunnerState("improve"), {
      finalText,
      followUp: okPi({ finalText: "SUMMARY: short form\n" }),
      followUpCommits: true,
    });

    const outcome = await stageRunMerge(ctx);

    assert.equal(outcome.result, "queued");
    assert.equal(sh(wt, "git", "rev-list", "--count", `${base}..${calls.pins[0]!.sha}`), "1");
    assert.match(sh(wt, "git", "log", "-1", "--format=%s", calls.pins[0]!.sha), /^tumwater\(improve\): /);
    assert.ok(calls.warnings.some((w) => w.includes("folded into tumwater's commit")));
  });
}

test("a staged commit carries the Model line the run started on", async () => {
  const { root, wt } = await setup();
  const modelLine = "Model: claude-opus-5-5 · backend claude";
  const { ctx } = makeCtx(root, wt, freshRunnerState("improve"), {
    modelLine,
    finalText: "Done.\nSUMMARY: add feature\nVERIFIED: npm test\n",
  });

  const outcome = await stageRunMerge(ctx);

  assert.equal(outcome.result, "queued");
  const lines = sh(wt, "git", "log", "-1", "--format=%B").trimEnd().split("\n");
  assert.match(lines[lines.length - 2]!, /^Run: improve #/);
  assert.equal(lines[lines.length - 1], modelLine);
});
