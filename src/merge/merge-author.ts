import { gateRoleConfig } from "../gates/budget-gates.js";
import { RoleRunner } from "../runner/runner.js";
import type { MergePipelineContext } from "./merge-pipeline.js";

/** The semaphore tier a verification waits at, below every roleTier (0/1): committed work whose
 * author the interlock has already blocked jumps ahead of parked role waiters rather than starving
 * behind them (BUGS.md 2026-09-18). Exported for merge-drain.ts, whose merge tier sits one
 * below it. */
export const VERIFY_TIER = -1;

/** The tier the merge's conflict-resolution runs wait at, one below VERIFY_TIER: ahead of any
 * verification parked for a permit, because the merge is the one serial step every queued change
 * waits on. (Nothing that holds a permit ever waits on the merge: no verification takes the merge
 * lock, and the resolver runs outside it — merge-to-main.ts's mergeToMain — so this cannot
 * deadlock.) Shared by merge-drain.ts's merge slot and merge-post-review-drain.ts's fix
 * landing, so the reviewer's fix-merge resolver rides the same tier and the two cannot
 * drift. */
export const MERGE_TIER = VERIFY_TIER - 1;

/** Resolve a merge entry's authoring runner: the live runner when the role is enabled
 * (runners are never removed from the array on disable — only a warning event fires); a role
 * disabled before this process started has no runner, so a throwaway one supplies the same
 * wiring (runner-pi.ts, runMergePi, foldMergeUsage) and a disk-loaded state to fold and save
 * on. Both share the live config, like every runner — the director takes directorConfig (the live
 * config, its budget-gate exemption, unless a used-up window moved it), every other role takes
 * roleConfig (gateRoleConfig's single home for the rule; the scheduler assigns the live runners
 * by it every poll). */
export function resolveAuthor(ctx: MergePipelineContext, role: string): RoleRunner {
  const { root, mainBranch, signal, runners, liveConfig, roleConfig, directorConfig } = ctx;
  return (
    runners.find((r) => r.role === role) ??
    new RoleRunner(root, role, gateRoleConfig(role, liveConfig, roleConfig, directorConfig), mainBranch, signal)
  );
}
