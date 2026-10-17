/** Shared helpers for the landing-merge suites (merge-to-main.test.ts,
 * merge-to-main-recheck.test.ts): a compliant pi result, the recording MergeContext, and the
 * conflict worktree both groups build on. The seedFeatureAPlannedToDone backlog shape is shared
 * by the re-check suite and the structure/events suite. */
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../src/config/config.js";
import type { ResolvedModelConfig } from "../../src/config/config-views.js";
import type { MergeContext } from "../../src/merge/merge-to-main.js";
import type { PiRunResult } from "../../src/pi/pi-run-result.js";
import { piRunResult } from "../fakes/fake-pi.js";
import { advanceMain } from "./merger-fixtures.js";
import { commitIn, initializedWorktree } from "./repo-fixtures.js";

/** A compliant pi run result; tests override only what they exercise. */
export function piResult(over: Partial<PiRunResult> = {}): PiRunResult {
  return piRunResult({ finalText: "resolved", ...over });
}

interface PiCall {
  wt: string;
  prompt: string;
  session: string;
  /** The config the run was handed (the conflict resolver's strong-tier one, plans/
   * model-tiers.md part 4/8) — undefined when the caller passed none. */
  config?: ResolvedModelConfig;
}

/** A MergeContext for role "improve" on tick 7 whose runPi records every call and then
 * defers to `resolve` (or returns a plain ok result when none is given). The landing target is
 * derived from the worktree's post-rebase HEAD inside mergeToMain (merge queue 2/5), so there is
 * no ref field. exemptPaths carries the config defaults, as loop-tick.ts does. */
export function makeCtx(
  root: string,
  resolve?: (wt: string, prompt: string, session: string) => Promise<PiRunResult>,
): { ctx: MergeContext; calls: PiCall[] } {
  const calls: PiCall[] = [];
  return {
    ctx: {
      root,
      role: "improve",
      mainBranch: "main",
      exemptPaths: ["*.md", "docs/**"],
      config: defaultConfig(),
      tick: 7,
      runPi: async (wt, prompt, session, config) => {
        calls.push({ wt, prompt, session, config });
        return resolve ? resolve(wt, prompt, session) : piResult();
      },
    },
    calls,
  };
}

/** A worktree and main that both edit seed.txt, so rebasing the branch onto main conflicts.
 * The messages parameterize the branch and main commits for tests that read intent from them. */
export async function conflictedWorktree(
  branchMsg = "branch edit",
  mainMsg = "main edit",
): Promise<{ root: string; wt: string }> {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch\n");
  commitIn(wt, branchMsg);
  fs.writeFileSync(path.join(root, "seed.txt"), "main\n");
  commitIn(root, mainMsg);
  return { root, wt };
}

/** Seed the 2026-09-25 duplicate-`## Done` conflict shape: the worktree commits a Planned
 * Feature A, then main moves that entry to Done (the file's `## Planned` replaced by one
 * `## Done` heading), so the branch's backlog commit rebases against a fully rewritten
 * PLANS.md and a resolver's choice of where Feature B lands is what the gate judges. The
 * exact bytes both sibling conflict tests stand on — the twin seed blocks they used to
 * hand-roll — so the gate sees the document it always did. */
export function seedFeatureAPlannedToDone(root: string, wt: string): void {
  fs.writeFileSync(
    path.join(wt, "PLANS.md"),
    "## Planned\n\n### Feature A (planned 2026-09-25)\n\n**Goal.** Work in progress.\n",
  );
  commitIn(wt, "seed the backlog");
  // Main moves Feature A to Done: one new ## Done heading, ## Planned gone.
  advanceMain(
    root,
    "PLANS.md",
    "## Done\n\n### Feature A (planned 2026-09-25, done 2026-09-26)\n\n**Goal.** Landed.\n",
  );
}
