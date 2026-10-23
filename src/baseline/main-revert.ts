import { queueCulpritHeal } from "./main-red.js";
import { gateCommandOf } from "../build/build-check-detect.js";
import { runScopedBuildCheck } from "../build/build-check-scoped.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { withLock } from "../concurrency/lock.js";
import { logEventBestEffort, TUMWATER_SOURCE, warnEventBestEffort } from "../events/events.js";
import { branchHead, patchId, subjectOfCommit } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { stampedSubject } from "../git/commit-message.js";
import { ensureDetachedWorktree } from "../git/worktree.js";
import { useWorktree } from "../git/worktree-use.js";
import { ffMainToOrWhy } from "../merge/merge-git.js";
import { revertCommitIn } from "../operator/revert.js";
import { mergeLockDir, mergeWorktreePath } from "../paths.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { errorMessage } from "../text/text.js";
import { shortSha } from "../text/format.js";

/** The automatic revert of a red main's culprit (plans/fast-merge.md, Lever 2, part 4b): the main
 * watch names the commit (a `main_culprit` event) and hands it here; the merge slot (drainMerge,
 * src/merge/merge-drain.ts) runs the revert serialized with merges. Anything that cannot be
 * reverted — or whose revert fails — falls back to bugfix's heal prompt naming the culprit. */

/** What the main watch hands over for a named culprit. `tip` is the red head it was found at. */
export interface MainCulprit {
  commit: string;
  runner?: string;
  failingTests: string[];
  tip: string;
  /** Set when a post-merge review rejected the commit (review.afterMerge) instead of main
   * turning red: the reviewer's reasons. A revert that fails goes to `onFailed`, not to bugfix. */
  postReview?: { reasons: string[] };
}

const REVERT_PREFIXES = ["tumwater(operator): Revert", "tumwater(tumwater): Revert"]; // vocabulary-ok: commit prefixes are machine strings

/** Why the culprit is not reverted automatically, or null when it should be: no runner (an
 * operator or hand commit), a director's merge, a revert itself, or a commit whose revert
 * already merged. */
export async function revertSkipReason(root: string, mainBranch: string, c: MainCulprit): Promise<string | null> {
  if (c.runner === undefined) return "no role runner merged it";
  if (baseRoleOf(c.runner) === DIRECTOR_ROLE) return "the director merged it";
  const subject = await subjectOfCommit(root, c.commit);
  if (REVERT_PREFIXES.some((p) => subject.startsWith(p))) return "it is itself a revert";
  const merged = (await gitTry(root, "log", mainBranch, "--format=%s", "--fixed-strings", `--grep=Revert ${shortSha(c.commit)}`)) ?? "";
  if (merged.split("\n").some((s) => REVERT_PREFIXES.some((p) => s === `${p} ${shortSha(c.commit)}`)))
    return "a revert of it already merged";
  return null;
}

/** The main watch's culprit hand-off: starts the automatic revert, or falls back to bugfix's heal
 * prompt when the revert is skipped. Never rejects, because its caller discards the promise and an
 * unhandled rejection would end the orchestrator: a heal prompt that cannot be queued is warned. */
export async function routeMainCulprit(
  root: string,
  mainBranch: string,
  c: MainCulprit,
  startRevert: (c: MainCulprit) => void,
): Promise<void> {
  const skip = await revertSkipReason(root, mainBranch, c);
  if (skip === null) {
    startRevert(c);
    return;
  }
  try {
    queueCulpritHeal(root, c.tip, { culprit: c.commit, failingTests: c.failingTests });
  } catch (err) {
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `not reverting ${shortSha(c.commit)} (${skip}) and could not queue the heal prompt for bugfix: ${errorMessage(err)}`,
    );
  }
}

/** Run one revert task on main's current tip in the shared `_merge` checkout: revert the culprit,
 * run `check.gateCommand` on the result when one is set (red aborts), and fast-forward main under
 * the merge lock. Logs `main_revert` on success and calls `onReverted` (the hand-back to a role);
 * every failure queues the heal prompt instead. Never throws: a hand-off that cannot be queued is
 * warned, not thrown. */
export async function runMainRevert(
  root: string,
  mainBranch: string,
  config: TumwaterConfig,
  c: MainCulprit,
  onReverted?: (c: MainCulprit) => Promise<void>,
  onFailed?: (c: MainCulprit, reason: string) => void,
): Promise<void> {
  /** Hand the failure to a role and return the warning's suffix saying truthfully what happened. */
  const heal = (reason: string, outputTail?: string[]): string => {
    const toReviewer = c.postReview && onFailed;
    try {
      if (toReviewer) onFailed(c, reason);
      else queueCulpritHeal(root, c.tip, { culprit: c.commit, failingTests: c.failingTests, outputTail });
      return toReviewer ? "sent the reviewer's reasons to its role" : "queued the heal prompt for bugfix";
    } catch (err) {
      return toReviewer
        ? `could not send the reviewer's reasons to its role: ${errorMessage(err)}`
        : `could not queue the heal prompt for bugfix: ${errorMessage(err)}`;
    }
  };
  try {
    const failure = await useWorktree(root, mergeWorktreePath(root), async () => {
      const tip = await branchHead(root, mainBranch);
      if (tip === null) return { reason: `${mainBranch} is unreadable` };
      const wt = await ensureDetachedWorktree(root, mergeWorktreePath(root), tip);
      const subject = await subjectOfCommit(wt, c.commit);
      const tests = c.failingTests.length > 0 ? `\n\nFailing tests: ${c.failingTests.join("; ")}` : "";
      const why = c.postReview
        ? `which a post-merge review rejected.\n\nReasons: ${c.postReview.reasons.join("; ")}`
        : `which turned main red.${tests}`;
      const message = `${stampedSubject("tumwater", `Revert ${shortSha(c.commit)}`)}\n\nReverts ${c.commit} (${subject}), ${why}`;
      const reverted = await revertCommitIn(wt, c.commit, message);
      if (!reverted.ok) return { reason: reverted.error };
      if (gateCommandOf(config) !== undefined) {
        const gate = await runScopedBuildCheck(root, TUMWATER_SOURCE, "gate", wt, config);
        if (gate && gate.outcome.status !== "passed")
          return { reason: `the gate command was ${gate.outcome.status} on the revert`, tail: gate.outcome.outputTail };
      }
      const ffFailure = await withLock(mergeLockDir(root), () => ffMainToOrWhy(root, reverted.sha, mainBranch));
      if (ffFailure !== null) return { reason: ffFailure };
      // The culprit's patch-id (`C^...C`, src/git/git.ts patchId, -U0 so a re-landing onto a
      // moved main keeps the id): the fast-merge guardrail G2 matches a later `merged`
      // event against it to spot a change that came back unchanged (plans/fast-merge.md).
      const culpritPatch = await patchId(wt, `${c.commit}^`, c.commit).catch(() => null);
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "main_revert",
        commit: c.commit,
        revert: reverted.sha,
        runner: c.runner,
        failingTests: c.failingTests,
        ...(culpritPatch ? { patchId: culpritPatch } : {}),
      });
      await onReverted?.(c).catch((err: unknown) =>
        logEventBestEffort(root, {
          source: TUMWATER_SOURCE,
          type: "warning",
          message: `could not hand ${shortSha(c.commit)} back to its role: ${errorMessage(err)}`,
        }),
      );
      return null;
    });
    if (failure !== null) {
      const suffix = heal(failure.reason, failure.tail);
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "warning",
        message: `could not revert ${shortSha(c.commit)}: ${failure.reason} — ${suffix}`,
      });
    }
  } catch (err) {
    const suffix = heal(errorMessage(err));
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "warning",
      message: `revert of ${shortSha(c.commit)} failed: ${errorMessage(err)} — ${suffix}`,
    });
  }
}
