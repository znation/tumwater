// The codex rollout reader (plans/codex-backend.md "The rollout read that completes it",
// PLANS.md "Codex backend, part 6/9"). Every case runs on the real H1 capture
// test/fixtures/codex-captures/edit-run-and-resume-rollout.jsonl (two runs in one file: the
// first and its resume), so the per-turn (never thread-total) figures, the window types, the
// billing and the model-switch rule are pinned to what Codex actually wrote.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findRollout, rolloutLines, type RolloutLines } from "../src/agent/codex/codex-rollout.js";
import { codexCaptures, codexTurnContext } from "./fixtures/codex-events.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const FIXTURE = codexCaptures.editRunAndResumeRollout;
const FIRST = "01a15c9d-6abc-70f1-acc6-6a78fd6c0971";
const RESUME = "01a15c9d-d6ac-7330-9f02-9191aff4ecb1";

const read = (lines: RolloutLines): Array<Record<string, unknown>> => lines.lines.map((l) => JSON.parse(l) as Record<string, unknown>);

test("each turn's run_usage is its own last figure, not the thread total", () => {
  const first = read(rolloutLines(FIXTURE, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" }));
  const firstUsage = first.find((e) => e.type === "run_usage")!;
  assert.equal(firstUsage.input, 32957 - 15872, "input excludes cached tokens");
  assert.equal(firstUsage.cacheRead, 15872);
  assert.equal(firstUsage.cacheWrite, 0);
  assert.equal(firstUsage.output, 298);

  // A resume reads only its own turn's records: the resume's full -m figure (8497 input,
  // 8064 cached), not the thread total the stream's turn.completed would report (finding 4).
  const resumed = read(rolloutLines(FIXTURE, { sinceTurnStart: RESUME, requestedModel: "gpt-6-luna" }));
  const resumedUsage = resumed.find((e) => e.type === "run_usage")!;
  assert.equal(resumedUsage.input, 8497 - 8064, "the resume counts its own turn, not the whole thread");
  assert.equal(resumedUsage.output, 10);
});

test("a requested model other than the one that ran reports the switch, requested model matches reports none", () => {
  assert.equal(rolloutLines(FIXTURE, { sinceTurnStart: FIRST, requestedModel: "gpt-6.1-sol" }).switchedTo, "gpt-6-luna");
  assert.equal(rolloutLines(FIXTURE, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" }).switchedTo, undefined);
});

test("the two usage windows map to five_hour and seven_day with the capture's resets and zero utilization", () => {
  const lines = read(rolloutLines(FIXTURE, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" }));
  const windows = lines.filter((e) => e.type === "rate_limit");
  assert.equal(windows.length, 2, "both windows are reported");
  const fiveHour = windows.find((w) => w.rateLimitType === "five_hour")!;
  assert.equal(fiveHour.status, "allowed");
  assert.equal(fiveHour.utilization, 0);
  assert.equal(fiveHour.resetsAt, 1792555493, "resets_at is carried through");
  const sevenDay = windows.find((w) => w.rateLimitType === "seven_day")!;
  assert.equal(sevenDay.status, "allowed");
  assert.equal(sevenDay.utilization, 0);
  assert.equal(sevenDay.resetsAt, 1793142293);
});

// Build a single-turn rollout whose token_count carries the given rate_limits (and an
// optional rate_limit_reached_type), so windowStatus's non-allowed branches are pinned.
function rolloutWith(rateLimits: Record<string, unknown>, reached: string | null): Array<Record<string, unknown>> {
  const text = [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: FIRST } }),
    JSON.stringify({
      type: "token_usage_record",
      payload: { turn_id: FIRST, turn_token_usage: { input_tokens: 1000, cached_input_tokens: 300, cache_write_input_tokens: 0, output_tokens: 40 } },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", rate_limits: { ...rateLimits, rate_limit_reached_type: reached } },
    }),
  ].join("\n");
  return read(rolloutLines(text, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" }));
}

test("a window at or past 90% reports allowed_warning, one the account hit outright reports rejected", () => {
  // seven_day sits well below 100% but is named by rate_limit_reached_type, so its
  // rejection can only come from the reached-type arm, never from the utilization arm.
  const windows = rolloutWith(
    {
      plan_type: "plus",
      primary: { used_percent: 95, window_minutes: 300, resets_at: 1792555493 },
      secondary: { used_percent: 50, window_minutes: 10080, resets_at: 1793142293 },
    },
    "seven_day",
  ).filter((e) => e.type === "rate_limit");
  assert.equal(windows.length, 2);
  const fiveHour = windows.find((w) => w.rateLimitType === "five_hour")!;
  const sevenDay = windows.find((w) => w.rateLimitType === "seven_day")!;
  assert.equal(fiveHour.status, "allowed_warning", "95% utilization warns");
  assert.equal(fiveHour.utilization, 0.95);
  assert.equal(sevenDay.status, "rejected", "a window the account hit outright is rejected");
});

test("a fully-used window is rejected even without rate_limit_reached_type", () => {
  const windows = rolloutWith(
    {
      plan_type: "plus",
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1792555493 },
      secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1793142293 },
    },
    null,
  ).filter((e) => e.type === "rate_limit");
  const fiveHour = windows.find((w) => w.rateLimitType === "five_hour")!;
  const sevenDay = windows.find((w) => w.rateLimitType === "seven_day")!;
  assert.equal(fiveHour.status, "allowed", "a 0% window stays allowed");
  assert.equal(sevenDay.status, "rejected", "100% utilization rejects even without a reached type");
  assert.equal(sevenDay.utilization, 1);
});

test("billing is subscription from the plus plan_type", () => {
  const lines = read(rolloutLines(FIXTURE, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" }));
  assert.deepEqual(lines.find((e) => e.type === "billing"), { type: "billing", billing: "subscription" });
});

test("a turn with no token_count yields run_usage with no rate_limit (a killed run)", () => {
  // Finding 23: a killed run's rollout has a token_usage_record but no token_count.
  const text = [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: FIRST } }),
    codexTurnContext("gpt-6-luna"),
    JSON.stringify({
      type: "token_usage_record",
      payload: { turn_id: FIRST, turn_token_usage: { input_tokens: 1000, cached_input_tokens: 300, cache_write_input_tokens: 0, output_tokens: 40 } },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: FIRST } }),
  ].join("\n");
  const lines = read(rolloutLines(text, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" }));
  assert.equal(lines.find((e) => e.type === "run_usage")!.input, 700);
  assert.equal(lines.some((e) => e.type === "rate_limit"), false, "no rate_limit without a token_count");
});

test("a truncated file yields an empty reading", () => {
  // The turn's token_usage_record line is torn off mid-record, so there is no usable figure.
  const truncated =
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: FIRST } }) + "\n" +
    '{"type":"token_usage_record","payload":{"turn_token_usage":{"input_tokens":';
  assert.deepEqual(rolloutLines(truncated, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" }), { lines: [] });
});

test("findRollout finds the rollout from home and id alone and returns null for an unknown id", () => {
  const home = tmpdir();
  try {
    const id = "01a15c9d-6762-7931-814e-a3e6e64c1b51";
    const dir = path.join(home, "sessions", "2026", "10", "21");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-10-21T03-59-42-123-${id}.jsonl`), "");
    const found = findRollout(home, id);
    assert.ok(found !== null, "the rollout is found");
    assert.equal(path.basename(found), `rollout-2026-10-21T03-59-42-123-${id}.jsonl`);
    assert.equal(findRollout(home, "00000000-0000-0000-0000-000000000000"), null, "an unknown id is not found");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the reading never surfaces the account fields", () => {
  const result = rolloutLines(FIXTURE, { sinceTurnStart: FIRST, requestedModel: "gpt-6-luna" });
  for (const line of result.lines) {
    assert.ok(!line.includes("creator_user_id"), "no creator_user_id value leaks");
    assert.ok(!line.includes("creator_account_id"), "no creator_account_id value leaks");
  }
});
