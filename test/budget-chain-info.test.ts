import test from "node:test";
import assert from "node:assert/strict";
import { chainInfo } from "../src/gates/budget-gates.js";
import { defaultConfig } from "../src/config/config.js";
import { IDLE_FALLBACK_BREAKER } from "../src/budget/fallback-breaker.js";
import { todayStamp } from "../src/budget/budget.js";
import type { TierFallbackMap } from "../src/config/config-fallbacks.js";
import type { ClaudeAccount } from "../src/agent/claude/claude-account.js";

type Args = Parameters<typeof chainInfo>[0];
type Resolution = TierFallbackMap["default"];

const now = new Date(2026, 9, 20, 12).getTime();
const midnight = new Date(2026, 9, 21).getTime();

/** A pi primary with a capped free step then an uncapped one. */
function piTwoStep(): { config: Args["config"]; resolution: Resolution } {
  const config = defaultConfig();
  config.provider = "paid";
  config.model = "gpt-x";
  config.fallback = [{ model: "free/qwen-free", maxDailyCostUsd: 1 }, "free/llama-free"];
  return { config, resolution: { pair: { provider: "free", model: "llama-free" }, from: null, step: 1 } };
}

/** A claude primary, a claude extra-usage step, then a capped free step. */
function claudePrimary(): { config: Args["config"]; resolution: Resolution } {
  const config = defaultConfig();
  config.provider = undefined;
  config.backend = "claude";
  config.model = "claude-sonnet-5-5";
  config.fallback = [{ backend: "claude", model: "claude-opus-5-5" }, { model: "free/qwen-free", maxDailyCostUsd: 3 }];
  return {
    config,
    resolution: { pair: { provider: "free", model: "qwen-free", maxDailyCostUsd: 3 }, from: null, step: 1 },
  };
}

function info(
  c: { config: Args["config"]; resolution: Resolution },
  over: Partial<Args> & {
    spend?: Record<string, number>;
    account?: ClaudeAccount;
  } = {},
) {
  const { spend, account, ...rest } = over;
  const none = { pair: null, from: null };
  // The default account makes the claude fallback pair a subscription seam; the overage reason
  // below reads it through the per-backend `accounts` lookup.
  const acct = account ?? ({ billing: "subscription", observedAt: now, windows: {} } as ClaudeAccount);
  return chainInfo({
    config: c.config,
    resolved: { default: c.resolution, small: none, strong: none },
    moved: new Set(["default"]),
    breakers: {},
    states: spend ? [{ dayStamp: todayStamp(now), dayCostByPair: spend }] : [],
    now,
    accounts: (b) => (b === "claude" ? acct : null),
    isPriced: () => true,
    ...rest,
  });
}

test("chainInfo names a demoted prior step, ahead of its spent step cap", () => {
  const out = info(piTwoStep(), {
    breakers: { "free/qwen-free": { ...IDLE_FALLBACK_BREAKER, pair: "free/qwen-free", probeAt: now + 1000 } },
    spend: { "free/qwen-free": 2 },
  });
  assert.deepEqual(out.default, { pair: "free/llama-free", step: 2, of: 2, reason: "demoted" });
});

test("chainInfo names a prior step whose own cap is spent as step-cap, back at local midnight; under it the reason is cap", () => {
  const atCap = info(piTwoStep(), { spend: { "free/qwen-free": 1 } });
  assert.equal(atCap.default?.reason, "step-cap");
  assert.equal(atCap.default?.returnsAt, midnight);
  const under = info(piTwoStep(), { spend: { "free/qwen-free": 0.5 } });
  assert.equal(under.default?.reason, "cap");
  assert.equal(under.default?.returnsAt, midnight);
});

test("chainInfo names overage only for an extra-usage Claude step on an account that refuses it", () => {
  const account = (overageStatus: string): ClaudeAccount => ({
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "allowed_warning", overageStatus, observedAt: now } },
  });
  const refused = info(claudePrimary(), { account: account("rejected") });
  assert.equal(refused.default?.reason, "overage");
  assert.equal("returnsAt" in (refused.default ?? {}), false);
  assert.equal(info(claudePrimary(), { account: account("allowed") }).default?.reason, "cap");
  // A pi primary's first Claude step is not extra usage, so the refusal does not apply.
  const pi = claudePrimary();
  pi.config.provider = "paid";
  pi.config.backend = undefined;
  pi.config.model = "gpt-x";
  assert.equal(info(pi, { account: account("rejected") }).default?.reason, "cap");
});

test("chainInfo lists only moved tiers, and prices a step only when it is priced", () => {
  const unpriced = info(claudePrimary(), { isPriced: () => false }).default;
  assert.ok(unpriced);
  assert.equal("spentUsd" in unpriced, false);
  assert.equal("capUsd" in unpriced, false);
  assert.deepEqual(info(claudePrimary(), { moved: new Set() }), {});
});
