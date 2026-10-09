/** Config fixtures shared by the config-validation and budget/fallback gate tests: run
 * `validateConfig` and return its rejection message, or build the paid-primary/free-fallback
 * fleet the gates resolve against. Topic-named like the other fixture modules; imports only
 * the production config and error renderer. */
import { defaultConfig } from "../../src/config/config.js";
import type { TumwaterConfig } from "../../src/config/config-schema.js";
import { validateConfig } from "../../src/config/config-validation.js";
import { errorMessage } from "../../src/text/text.js";

export function validationError(raw: unknown): string {
  try {
    validateConfig(raw);
  } catch (err) {
    return errorMessage(err);
  }
  throw new Error("validateConfig did not throw");
}

/** A fleet at the paid `gpt-x` primary with the free `qwen-free` fallback pair configured —
 * the base budget-gates.test.ts, gate-polls.test.ts, and gate-event-best-effort.test.ts each
 * built inline. Pass `capUsd` to set the daily cap; omit it to keep defaultConfig's own. */
export function paidFallbackConfig(capUsd?: number): TumwaterConfig {
  const cfg = defaultConfig();
  cfg.provider = "paid";
  cfg.model = "gpt-x";
  cfg.fallbackModel = { provider: "free", model: "qwen-free" };
  if (capUsd !== undefined) cfg.maxDailyCostUsd = capUsd;
  return cfg;
}
