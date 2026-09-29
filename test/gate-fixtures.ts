import { defaultConfig } from "../src/config.js";
import { freshLoopState } from "../src/loop-state.js";
import { reviewAheadOfMain } from "../src/review.js";

/** Shared scaffolding for the review-gate orchestration tests — the "Gate orchestration"
 * sections of review.test.ts and fix-claim.test.ts, which both drive reviewAheadOfMain
 * end-to-end over a real repo with a fake pi reviewer. Owning the role constant, the gate
 * context, and the fresh-state call here keeps the two files' fixtures from drifting. */

/** The role the gate fixtures run as — a code-change role, so its diffs are NOT exempt. */
export const ROLE = "improve";

/** The reviewAheadOfMain context over a repo: tick 1 unless overridden. */
export function gateCtx(root: string, wt: string, tick = 1) {
  return { root, role: ROLE, wt, mainBranch: "main", config: defaultConfig(), tick };
}

/** The common gate-test shape in one call: a brand-new LoopState plus one reviewAheadOfMain
 * run over it. `overrides` replaces whole context fields (`config`, `signal`,
 * `buildCheckTimeoutMs`, ...) the way `{ ...gateCtx(root, wt), x }` did inline. */
export async function reviewGate(
  root: string,
  wt: string,
  overrides: Partial<Parameters<typeof reviewAheadOfMain>[0]> = {},
): Promise<{ state: ReturnType<typeof freshLoopState>; result: Awaited<ReturnType<typeof reviewAheadOfMain>> }> {
  const state = freshLoopState(ROLE);
  const result = await reviewAheadOfMain({ ...gateCtx(root, wt), ...overrides }, state);
  return { state, result };
}
