/** Tests for src/review/review-followup.ts — the review gate's bounded follow-up turns on the
 * reviewer's own session. The gate-level tests (review.test.ts) exercise requestVerdict
 * through the whole review pipeline with a fake pi; these unit tests pin the seam directly
 * with a fake runGatePi: the no-session bail-out, the budget caps, the --continue wiring,
 * and requestNoRerun's tool-call collection, none of which the fake-pi shim can observe. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { requestNoRerun, requestVerdict } from "../src/review/review-followup.js";
import { buildNoRerunPrompt, buildVerdictRequestPrompt } from "../src/gates/gate-prompts.js";
import { piLogPath, reviewSessionDir } from "../src/paths.js";
import { defaultConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { ToolCallStart } from "../src/review/suite-rerun.js";
import { hasResumableSession} from "../src/pi/pi.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import type { ReviewContext } from "../src/review/review.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

import type { PiRunOptions } from "../src/pi/pi.js";

interface Captured {
  opts: PiRunOptions | null;
  result: { ok: boolean; finalText: string };
}

const RESULT = {
  ok: true,
  finalText: "VERDICT: approve",
} as PiRunResult;

function captureRun() {
  const captured: Captured = { opts: null, result: RESULT };
  return {
    captured,
    runGatePi: async (opts: PiRunOptions): Promise<PiRunResult> => {
      captured.opts = opts;
      return RESULT;
    },
  };
}

function makeCtx(config: TumwaterConfig = defaultConfig()) {
  const root = tmpdir("review-followup-");
  const { captured, runGatePi } = captureRun();
  const ctx: ReviewContext = {
    root,
    role: "feature",
    wt: root,
    mainBranch: "main",
    config,
    tick: 7,
    runGatePi,
  };
  return { ctx, root, captured };
}

/** Give the reviewer session dir one session file, as a just-finished review would. */
function touchSession(root: string): string {
  const dir = reviewSessionDir(root, "feature");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session-1.jsonl");
  fs.writeFileSync(file, "");
  return dir;
}

test("requestVerdict returns null when there is no session to continue", async () => {
  const { ctx, root, captured } = makeCtx();
  assert.equal(hasResumableSession(reviewSessionDir(root, "feature")), false);
  assert.equal(await requestVerdict(ctx), null);
  assert.equal(captured.opts, null); // the gate never ran: the caller counts the strike as before
});

test("requestVerdict continues the reviewer's session with capped budgets and the verdict prompt", async () => {
  // Generous budgets: the follow-up turn must be capped at its own hard limits, never the
  // review run's budget.
  const config = defaultConfig();
  config.tickTimeoutSeconds = 100_000;
  config.quietTimeoutSeconds = 100_000;
  const { ctx, root, captured } = makeCtx(config);
  const dir = touchSession(root);
  const run = await requestVerdict(ctx);
  assert.equal(run, captured.result); // the run rides back even on success, for spend folding
  const opts = captured.opts!;
  assert.equal(opts.sessionDir, dir);
  assert.equal(opts.continueSession, true);
  assert.equal(opts.sessionName, "tumwater-review-feature-7-verdict");
  assert.equal(opts.prompt, buildVerdictRequestPrompt());
  assert.equal(opts.kind, "gate", "a review follow-up demuxes as a gate run");
  assert.equal(opts.label, "review-verdict");
  assert.equal(opts.rawLogFile, piLogPath(root, "feature"));
  assert.equal(opts.config.tickTimeoutSeconds, 900);
  assert.equal(opts.config.quietTimeoutSeconds, 300);
});

test("requestVerdict honors a smaller configured budget and a disabled quiet timeout", async () => {
  const config = defaultConfig();
  config.tickTimeoutSeconds = 120; // below the cap: stands as configured
  config.quietTimeoutSeconds = 0; // disabled: the follow-up still gets its own cap
  const { ctx, root, captured } = makeCtx(config);
  touchSession(root);
  await requestVerdict(ctx);
  assert.equal(captured.opts!.config.tickTimeoutSeconds, 120);
  assert.equal(captured.opts!.config.quietTimeoutSeconds, 300);
});

test("requestNoRerun returns null when there is no session to continue", async () => {
  const { ctx, captured } = makeCtx();
  const calls: ToolCallStart[] = [];
  assert.equal(await requestNoRerun(ctx, "bash: npm test", calls), null);
  assert.equal(captured.opts, null);
  assert.deepEqual(calls, []);
});

test("requestNoRerun names the repeated call, collects its own tool calls, and caps budgets", async () => {
  const config = defaultConfig();
  config.tickTimeoutSeconds = 100_000;
  config.quietTimeoutSeconds = 100_000;
  const { ctx, root, captured } = makeCtx(config);
  const dir = touchSession(root);
  const calls: ToolCallStart[] = [];

  const run = await requestNoRerun(ctx, "bash: npm test", calls);
  assert.equal(run, captured.result);
  const opts = captured.opts!;
  assert.equal(opts.sessionDir, dir);
  assert.equal(opts.continueSession, true);
  assert.equal(opts.sessionName, "tumwater-review-feature-7-rerun");
  assert.equal(opts.prompt, buildNoRerunPrompt("bash: npm test"));
  assert.ok(opts.prompt.includes("bash: npm test")); // the nudge names the exact call
  assert.equal(opts.label, "review-rerun");
  assert.equal(opts.config.tickTimeoutSeconds, 900);
  assert.equal(opts.config.quietTimeoutSeconds, 300);

  // The nudge turn's own started tool calls land in `calls` — the caller's repeat check
  // needs every one, so the hook collects unconditionally, before any verdict.
  opts.onToolCallStart!("bash", { command: "npm test" });
  opts.onToolCallStart!("read", "src/x.ts");
  assert.deepEqual(calls, [
    { toolName: "bash", args: { command: "npm test" } },
    { toolName: "read", args: "src/x.ts" },
  ]);
});
