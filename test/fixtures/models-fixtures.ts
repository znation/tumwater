/** The pi models.json content the pricing-sensitive gate tests fake: one all-zero-cost
 * provider (free) and a priced one (paid) — the shape the budget gate's free/paid decision
 * (pollBudgetGate reading pi's models.json through fleetModelsFree) resolves against.
 * budget-gates.test.ts and gate-polls.test.ts each staged this file inline before; owning
 * it here keeps the two tests' pricing fixtures from drifting. */
import fs from "node:fs";
import path from "node:path";

/** The one priced model both fixtures name — the exact cost the free/paid split turns on. */
const PAID_MODEL = { id: "gpt-x", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.4 } };

/** A models.json with one all-zero-cost provider (free) and a priced one (paid). */
export const MODELS_JSON = JSON.stringify({
  providers: {
    free: {
      models: [
        { id: "qwen-free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { id: "llama-free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    paid: { models: [PAID_MODEL] },
  },
});

/** A models.json whose free provider is `local` (model `local-free`) with a `paid` provider
 * beside it: the fallback-model tests configure that exact pair, so the pricing gate resolves
 * it. */
export const LOCAL_FREE_MODELS_JSON = JSON.stringify({
  providers: {
    local: { models: [{ id: "local-free", cost: { input: 0, output: 0 } }] },
    paid: { models: [{ id: "gpt-x", cost: { input: 1, output: 2 } }] },
  },
});

/** Only priced models: the configured fallback cannot resolve to a free one. */
export const PAID_ONLY_JSON = JSON.stringify({
  providers: { paid: { models: [PAID_MODEL] } },
});

/** Stage `content` as `<dir>/models.json` (creating `dir`) and return the file's path — the
 * write step budget-gates.test.ts, gate-polls.test.ts, and gate-event-best-effort.test.ts
 * each hand-rolled before. */
export function writeModelsFile(dir: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, content);
  return file;
}
