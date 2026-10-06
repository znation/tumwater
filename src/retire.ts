import fs from "node:fs";
import { enabledRoleIds, loadConfigSafe } from "./config/config.js";
import {
  branchExists,
  currentBranch,
  deleteRef,
  isDirty,
  isMergedInto,
  refSha,
  targetBranch,
} from "./git.js";
import { errorMessage } from "./text.js";
import { loadLoopState } from "./loop-state.js";
import { branchName, landingRefName, worktreePath } from "./paths.js";
import { isUsableWorktree, removeWorktree } from "./worktree.js";
import { resumeRole } from "./fleet/fleet-state.js";
import { git } from "./git-run.js";

/** `tumwater retire --role <id>`: remove a disabled loop's persistent worktree and branch, plus
 * the per-role landing ref and paused-state marker that outlive it. The safety rails and the
 * `--force` override live here, so the CLI layer (operator/operator-commands.ts) stays a thin renderer. */

/** What retire sees today for one role — the collect half, exported so a read-only surface can
 * report the same state the removal would act on. */
export interface RetireStatus {
  role: string;
  /** The worktree directory exists on disk (whether or not it is still a usable worktree). */
  worktreePresent: boolean;
  /** The directory passes isUsableWorktree's probe (a real git worktree we can inspect). */
  worktreeUsable: boolean;
  branchPresent: boolean;
  landingRefPresent: boolean;
  /** Commits on the role branch not on main — unlanded work the branch would take with it. */
  aheadOfMain: number;
  /** Uncommitted changes (staged, modified, or untracked) in the worktree. */
  dirty: boolean;
  /** The role is enabled in tumwater.json — retire expects it disabled first. */
  enabledInConfig: boolean;
  /** The loop's persisted state says a tick is in flight (best-effort; cleared on start). */
  midTick: boolean;
}

/** Collect what exists today for `role`, with every probe tolerant of partial state — a retired
 * role's leftovers are exactly the messy half-state this command exists to clean up. */
export async function collectRetire(root: string, role: string): Promise<RetireStatus> {
  const wt = worktreePath(root, role);
  const present = fs.existsSync(wt);
  const usable = present && (await isUsableWorktree(wt));
  const config = loadConfigSafe(root);
  if (config.error !== undefined) {
    throw new Error(`cannot read tumwater.json: ${errorMessage(config.error)}`);
  }
  const mainBranch = targetBranch(config.config.baseBranch, await currentBranch(root));
  // Count unlanded work from the branch ref at root, not from the worktree's HEAD: the worktree
  // may be gone or unusable (the messy half-state this command exists to clean up) while the
  // branch still holds commits — reading HEAD through the worktree would report 0 and let
  // retireRole's `branch -D` delete unlanded work without objection. When the branch is
  // absent, or a usable worktree sits on it, the rev-list range is empty or matches HEAD.
  const branch = branchName(role);
  const branchThere = await branchExists(root, branch);
  const ahead = branchThere
    ? Number.parseInt(await git(root, "rev-list", "--count", `${mainBranch}..${branch}`), 10)
    : 0;
  const dirty = usable ? await isDirty(wt) : false;
  const landing = await refSha(root, landingRefName(role));
  // A landing ref pins a committed-but-unlanded sha (plans/merge-queue.md invariant 4): count
  // it as unlanded work too — the branch can sit at main while the pin holds the crash survivor.
  const pinnedUnlanded =
    landing !== null && !(await isMergedInto(root, landing, mainBranch)) ? 1 : 0;
  return {
    role,
    worktreePresent: present,
    worktreeUsable: usable,
    branchPresent: branchThere,
    landingRefPresent: landing !== null,
    aheadOfMain: ahead + pinnedUnlanded,
    dirty,
    enabledInConfig: enabledRoleIds(config.config).includes(role),
    midTick: loadLoopState(root, role).running === true,
  };
}

/** The outcome of a retire run: the artifacts actually removed, and those that were already
 * gone (reported as skipped so a second run is idempotent, not an error). */
export interface RetireResult {
  status: RetireStatus;
  removed: string[];
  skipped: string[];
}

/** The artifacts retire manages, in removal order. */
const ARTIFACTS = ["worktree", "branch", "landingRef", "pausedMarker"] as const;

/** The safety rails: each returns a one-line objection, or null when the state is clean. */
function objections(status: RetireStatus): string[] {
  const reasons: string[] = [];
  if (status.enabledInConfig)
    reasons.push(`role ${status.role} is still enabled in tumwater.json — disable it first`);
  if (status.aheadOfMain > 0)
    reasons.push(
      `branch ${branchName(status.role)} holds ${status.aheadOfMain} unlanded commit(s) — land or discard them first`,
    );
  if (status.worktreePresent && !status.worktreeUsable)
    reasons.push(
      "the worktree is unusable and cannot be checked for uncommitted changes — remove it manually or use --force",
    );
  if (status.dirty) reasons.push("the worktree has uncommitted changes");
  if (status.midTick) reasons.push("a tick is in flight for this loop");
  return reasons;
}

/** Remove the role's worktree, branch, landing ref, and paused-state marker. Refuses — removing
 * nothing — when any safety rail objects, unless `force` overrides every objection. */
export async function retireRole(root: string, role: string, { force }: { force?: boolean }): Promise<RetireResult> {
  const status = await collectRetire(root, role);
  if (!force) {
    const reasons = objections(status);
    if (reasons.length > 0)
      throw new Error(`refusing to retire role ${status.role}: ${reasons.join("; ")} (override with --force)`);
  }
  const removed: string[] = [];
  const skipped: string[] = [];
  const mark = (name: (typeof ARTIFACTS)[number], wasThere: boolean) =>
    (wasThere ? removed : skipped).push(name);
  // Always prune first: even without a directory, a stale registration may still hold the
  // branch checked out — removeWorktree's absent-dir path clears it before the branch
  // deletion below.
  await removeWorktree(root, status.role);
  mark("worktree", status.worktreePresent);
  if (status.branchPresent) {
    await git(root, "branch", "-D", branchName(status.role));
    mark("branch", true);
  } else mark("branch", false);
  if (status.landingRefPresent) {
    await deleteRef(root, landingRefName(status.role));
    mark("landingRef", true);
  } else mark("landingRef", false);
  mark("pausedMarker", resumeRole(root, status.role));
  return { status, removed, skipped };
}

/** The one-line human description of an artifact name, for the CLI renderer. */
export function artifactPhrase(name: string, role: string): string {
  switch (name) {
    case "worktree":
      return `the worktree (.tumwater/worktrees/${role}/)`;
    case "branch":
      return `the branch (${branchName(role)})`;
    case "landingRef":
      return `the landing ref (${landingRefName(role)})`;
    case "pausedMarker":
      return `the paused-state marker`;
    default:
      return name;
  }
}