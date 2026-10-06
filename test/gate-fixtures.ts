import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import { reviewAheadOfMain } from "../src/review/review.js";
import { runPi } from "../src/pi/pi.js";
import { headOf } from "../src/git/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { makeRepo, sh } from "./repo-fixtures.js";

/** Shared scaffolding for the review-gate orchestration tests — the "Gate orchestration"
 * sections of review.test.ts and fix-claim.test.ts, which both drive reviewAheadOfMain
 * end-to-end over a real repo with a fake pi reviewer. Owning the role constant, the gate
 * context, and the fresh-state call here keeps the two files' fixtures from drifting. */

/** The role the gate fixtures run as — a code-change role, so its diffs are NOT exempt. */
export const ROLE = "improve";

/** The reviewAheadOfMain context over a repo: tick 1 unless overridden. The gate's pi runs
 * go through the bare runPi here (no transient retry): the tests drive the reviewer with a
 * fake-pi shim and never need the retry, which the LoopPi-level tests pin. */
export function gateCtx(root: string, wt: string, tick = 1) {
  return {
    root,
    role: ROLE,
    wt,
    mainBranch: "main",
    config: defaultConfig(),
    tick,
    runGatePi: (opts: Parameters<typeof runPi>[0]) => runPi(opts),
  };
}

/** Repo with a worktree one commit ahead of main — a code change, so NOT exempt. */
export async function gateFixture(): Promise<{ root: string; wt: string; head: string }> {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  return { root, wt, head: await headOf(wt, "HEAD") };
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
