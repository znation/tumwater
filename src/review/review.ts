import type { TumwaterConfig } from "../config/config-schema.js";
import type { RunnerState } from "../runner/runner-state.js";
import { logEventBestEffort } from "../events/events.js";
import { changeBaseRev, headOf } from "../git/git.js";
import { aheadOfMainFiles } from "../git/git-diff.js";
import type { PriorReview } from "../merge/merge-queue.js";
import type { WatchWait } from "../baseline/main-red.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import type { GateRunsPi } from "../runner/runner-pi.js";
import { recordReview } from "../run/run-apply.js";
import { firstReason } from "../text/phrases.js";
import { isExemptDiff } from "./exemptions.js";
import { diffRuleReasons } from "./diff-rules.js";

/** Everything reviewAheadOfMain needs from its caller (a RoleRunner run or recovery). The gate
 * is deterministic (Subtract part 3b/7): it runs the diff rules and approves — it runs no build
 * check and no model reviewer. */
export interface ReviewContext {
  root: string;
  role: string;
  /** The author's worktree, post-commit — the reviewer reads the full tree there. */
  wt: string;
  mainBranch: string;
  config: TumwaterConfig;
  /** Current run number, for the unique per-run session name. */
  runNumber: number;
  /** This review's own per-run directory (reviewRunSessionDir in paths.ts). */
  sessionDir: string;
  signal?: AbortSignal;
  /** The revision round this merge is, absent for a fresh change — labeled on `review_start`
   * and paired with `priorReview` (plans/revise-rejected.md part 2/2). */
  revisionRound?: number;
  /** The rejected change's head and objections when this merge is a revision, absent
   * otherwise: built from the merge entry's PriorReview. A recovery merge carries none. */
  priorReview?: PriorReview;
  /** How this change came back after it was kept for the main watch's verdict
   * (MergeEntry.watchWait), absent otherwise. Carried to the merge entry's re-queue; the gate
   * no longer reads it (the build pre-check that attributed on it is gone — Subtract part 3b/7). */
  watchWait?: WatchWait;
  /** The reviewer's pi wiring, carried for interface compatibility — the deterministic gate
   * (Subtract part 3b/7) runs no model reviewer, so the gate consumes no pi here. */
  runGatePi: GateRunsPi["runGatePi"];
}

/** What the gate decided. "approved"/"exempt": safe to merge (the diff passed the rules, or
 * needed no review). "rejected": a deterministic diff-rule rejection — the branch is reset to
 * main and the reasons are recorded for the author's next run. Never "failed" or a reviewer
 * outcome: since Subtract part 3b/7 the gate runs no build check and no model reviewer, so it
 * can only approve, exempt or reject. */
export interface GateResult {
  decision: "approved" | "exempt" | "rejected";
  /** Failure message ("rejected") or abort detail, for lastSummary. */
  detail?: string;
  /** The gate's pi run was killed by harness shutdown — currently unreachable: the gate runs
   * no pi (Subtract part 3b/7). Kept for interface compatibility with the merge path's abort
   * handling. */
  aborted?: boolean;
}

/** Run the deterministic review gate over everything ahead of main in `wt` and update `state`
 * accordingly. Shared by the run path (after commitAll) and leftover recovery
 * (runner-leftover.ts's recoverLeftover) — every path that can move a commit into main routes
 * through here, so no crash or abort path smuggles unreviewed work in. Since Subtract part 3b/7
 * the gate is the three deterministic diff rules and nothing else: an md-only diff is exempt, a
 * diff that edits the brief prompt block, PRINCIPLES.md or leaks a credential is rejected
 * without any run, and a healthy change approves with no build check and no model reviewer —
 * main is judged exactly once per merged commit, by the main watch's post-landing check. Never
 * throws. */
export async function reviewAheadOfMain(
  ctx: ReviewContext,
  state: RunnerState,
  _summary?: string,
  _commitBody?: string,
  _highFriction?: boolean,
): Promise<GateResult> {
  const { root, role, wt, mainBranch, config } = ctx;
  if (!config.review.enabled) {
    return { decision: "exempt" };
  }

  const head = await headOf(wt, "HEAD");

  // The one reject path: record the rejection (injected into the role's next run prompt), reset
  // the failure count, discard the branch by resetting it to main, and log review_rejected.
  const reject = async (reasons: string[]): Promise<GateResult> => {
    recordReview(state, "reject", reasons, head);
    state.unreviewFailures = 0;
    await resetWorktreeToMain(wt, mainBranch);
    logEventBestEffort(root, { source: role, type: "review_rejected", head, reasons });
    return { decision: "rejected", detail: firstReason(reasons) };
  };

  // Already reviewed this exact HEAD (e.g. a merge_blocked retry): do not re-judge it.
  if (state.lastApprovedHead === head) {
    return { decision: "approved" };
  }

  const files = await aheadOfMainFiles(wt, mainBranch);
  // The three deterministic diff rules the gate rejects on (a brief-block edit, a protected
  // edit and a secret leak) are judged by diffRuleReasons in the "gate" scope. A rejection is a
  // hard stop: no run consumed, reasons injected into the author's next run. A brief edit or a
  // leaked credential must not merge raw (PLANS.md "Robust conflict landing, part 2/2"), and an
  // md-only diff is exempt, so each rule is what catches a change that would otherwise land.
  const baseRev = await changeBaseRev(wt, mainBranch);
  const exempt = isExemptDiff(files, config.review.exemptPaths);
  const [firstFinding] = await diffRuleReasons(wt, baseRev, files, role, exempt, "gate");
  if (firstFinding !== undefined) return reject([firstFinding]);
  if (exempt) {
    return { decision: "exempt" };
  }

  // No build pre-check and no model reviewer (Subtract part 3b/7): a diff that passes the rules
  // approves. Main carries exactly one full check per merged commit — the main watch's
  // post-landing one — so the merge gate runs none of its own.
  state.lastApprovedHead = head;
  return { decision: "approved" };
}
