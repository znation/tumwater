import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { defaultConfig } from "../src/config/config.js";
import { nativeLogPath } from "../src/paths.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { todayStamp } from "../src/budget/budget.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { readRunBlocks, withClaudeReplay } from "./fakes/fake-claude.js";
import { claudeInit, claudeRateLimit, claudeResult, claudeUnknown } from "./fixtures/claude-events.js";
import { makeHost, flagValue } from "./fixtures/loop-pi-fixtures.js";

// The claude backend's LoopPi behavior (plans/agent-backends.md): the native log and
// unmapped-event warnings, no within-run retry for a subscription usage-window rejection,
// and the caller-computed --max-budget-usd cap for an API-billed non-director authoring run.
test("a claude run keeps its native log and surfaces unmapped-event warnings", async () => {
  const root = tmpdir();
  await withClaudeReplay([
    claudeUnknown("mystery_event"),
    claudeResult({ totalCostUsd: 0.01 }),
  ], async () => {
    const config = defaultConfig();
    config.agent = "claude";
    config.model = "claude-sonnet-5-5";
    const { loopPi, warns } = makeHost(root, config);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.ok(
      warns.includes("agent_unknown_event: mystery_event"),
      `the unmapped type reaches the event feed: ${warns.join("; ")}`,
    );
    const native = fs.readFileSync(nativeLogPath(root, "feature", "claude"), "utf8");
    assert.match(native, /"type":"mystery_event"/, "the native log lands at the role.agent path");
    assert.match(native, /"type":"result"/);
  });
});

test("a subscription claude rejected window earns no within-run retry", async () => {
  const root = tmpdir();
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  await withClaudeReplay([
    claudeInit({ sessionId: "c1", apiKeySource: "none" }),
    claudeRateLimit({ type: "five_hour", status: "rejected", resetsAt }),
    claudeResult({ isError: true, apiErrorStatus: 429, text: "Claude usage limit reached" }),
  ], async (fake) => {
    const config = defaultConfig();
    config.agent = "claude";
    config.model = "claude-sonnet-5-5";
    const { loopPi, usage, sleeps } = makeHost(root, config);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, false);
    assert.equal(result.billing, "subscription");
    assert.equal(result.transientRateLimit, true);
    // The retry's bounded wait cannot outlast the window hold, so the tick ends after one
    // attempt and the kept session resumes once the hold lifts (plans/agent-backends.md part 6e).
    assert.equal(readRunBlocks(fake.argvFile).length, 1, "one attempt, no retry");
    assert.deepEqual(sleeps, [], "no wait is spent on a retry the window would reject anyway");
    assert.equal(usage.length, 1, "one foldUsage for the one attempt");
  });
});

// PLANS.md "Agent backends, part 7a/7": the caller computes `--max-budget-usd` from the
// remaining team budget and the role's own remaining cap, and only for an API-billed
// non-director claude authoring run. These tests pin the argv the real adapter builds.
test("an API-billed claude authoring run carries the remaining team budget as --max-budget-usd", async () => {
  const root = tmpdir();
  await withClaudeReplay([claudeInit({ sessionId: "c1" }), claudeResult({ totalCostUsd: 0.01 })], async (fake) => {
    writeClaudeAccount(root, { billing: "api", observedAt: Date.now(), windows: {} });
    saveLoopState(root, { ...freshLoopState("feature"), dayStamp: todayStamp(), dayCostUsd: 12 });
    const config = defaultConfig();
    config.agent = "claude";
    config.model = "claude-sonnet-5-5";
    config.maxDailyCostUsd = 15;
    const { loopPi } = makeHost(root, config);
    const result = await loopPi.runAuthoringPi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(flagValue(readRunBlocks(fake.argvFile)[0]!, "--max-budget-usd"), "3");
  });
});

test("a per-role cap lowers the claude run's --max-budget-usd below the team's remaining", async () => {
  const root = tmpdir();
  await withClaudeReplay([claudeInit({ sessionId: "c1" }), claudeResult({ totalCostUsd: 0.01 })], async (fake) => {
    writeClaudeAccount(root, { billing: "api", observedAt: Date.now(), windows: {} });
    saveLoopState(root, { ...freshLoopState("feature"), dayStamp: todayStamp(), dayCostUsd: 1.5 });
    const config = defaultConfig();
    config.agent = "claude";
    config.model = "claude-sonnet-5-5";
    config.maxDailyCostUsd = 15;
    config.maxDailyCostUsdPerRole = { feature: 2 };
    const { loopPi } = makeHost(root, config);
    const result = await loopPi.runAuthoringPi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(flagValue(readRunBlocks(fake.argvFile)[0]!, "--max-budget-usd"), "0.5");
  });
});

test("a fallback step's own cap lowers the claude run's --max-budget-usd to the step's remaining budget", async () => {
  const root = tmpdir();
  await withClaudeReplay([claudeInit({ sessionId: "c1" }), claudeResult({ totalCostUsd: 0.01 })], async (fake) => {
    writeClaudeAccount(root, { billing: "api", observedAt: Date.now(), windows: {} });
    saveLoopState(root, {
      ...freshLoopState("feature"),
      dayStamp: todayStamp(),
      dayCostUsd: 4,
      dayCostByPair: { "claude/claude-sonnet-5-5": 3 },
    });
    const config = defaultConfig();
    config.agent = "claude";
    config.model = "claude-sonnet-5-5";
    config.maxDailyCostUsd = 15;
    config.fallbackStepCaps = { "claude/claude-sonnet-5-5": 5 };
    const { loopPi } = makeHost(root, config);
    const result = await loopPi.runAuthoringPi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(flagValue(readRunBlocks(fake.argvFile)[0]!, "--max-budget-usd"), "2");
  });
});

// PLANS.md "Agent backends, part 7a/7", objection 1: the per-role cap is keyed by BASE role
// and sums the whole instance group's spend, matching the scheduler's role-cap gate. A
// `feature-2` run must see `maxDailyCostUsdPerRole.feature`, not a nonexistent `feature-2` key.
test("a per-role cap sums a multi-instance role's spend and keys on the base role", async () => {
  const root = tmpdir();
  await withClaudeReplay([claudeInit({ sessionId: "c1" }), claudeResult({ totalCostUsd: 0.01 })], async (fake) => {
    writeClaudeAccount(root, { billing: "api", observedAt: Date.now(), windows: {} });
    saveLoopState(root, { ...freshLoopState("feature"), dayStamp: todayStamp(), dayCostUsd: 0.6 });
    saveLoopState(root, { ...freshLoopState("feature-2"), dayStamp: todayStamp(), dayCostUsd: 0.6 });
    const config = defaultConfig();
    config.agent = "claude";
    config.model = "claude-sonnet-5-5";
    config.maxDailyCostUsd = 15;
    config.maxDailyCostUsdPerRole = { feature: 2 };
    config.roles.feature = { enabled: true, instances: 2 };
    const { loopPi } = makeHost(root, config, "feature-2");
    const result = await loopPi.runAuthoringPi(root, "work", "tumwater-feature-2-author");
    assert.equal(result.ok, true, `${result.errorMessage}`);
    // 2 − (0.6 + 0.6): the group's summed spend, below the team's remaining 13.8.
    assert.equal(flagValue(readRunBlocks(fake.argvFile)[0]!, "--max-budget-usd"), "0.8");
  });
});

test("a subscription account and the director both pass no --max-budget-usd", async () => {
  const root = tmpdir();
  await withClaudeReplay([
    claudeInit({ sessionId: "c1" }),
    claudeResult({ totalCostUsd: 0.01 }),
    claudeInit({ sessionId: "c2" }),
    claudeResult({ totalCostUsd: 0.01 }),
  ], async (fake) => {
    saveLoopState(root, { ...freshLoopState("feature"), dayStamp: todayStamp(), dayCostUsd: 12 });
    const config = defaultConfig();
    config.agent = "claude";
    config.model = "claude-sonnet-5-5";
    config.maxDailyCostUsd = 15;

    writeClaudeAccount(root, { billing: "subscription", observedAt: Date.now(), windows: {} });
    const { loopPi } = makeHost(root, config);
    const subscriptionRun = await loopPi.runAuthoringPi(root, "work", "tumwater-feature-1-author");
    assert.equal(subscriptionRun.ok, true, `${subscriptionRun.errorMessage}`);

    writeClaudeAccount(root, { billing: "api", observedAt: Date.now(), windows: {} });
    const { loopPi: directorPi } = makeHost(root, config, DIRECTOR_ROLE);
    const directorRun = await directorPi.runAuthoringPi(root, "work", "tumwater-director-1");
    assert.equal(directorRun.ok, true, `${directorRun.errorMessage}`);

    const blocks = readRunBlocks(fake.argvFile);
    assert.equal(blocks.length, 2);
    assert.equal(flagValue(blocks[0]!, "--max-budget-usd"), undefined, "subscription runs are exempt");
    assert.equal(flagValue(blocks[1]!, "--max-budget-usd"), undefined, "the director is exempt");
  });
});
