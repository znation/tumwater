// vocabulary: plain
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { postReviewPath, postReviewWorktreePath, nativeLogPath, piLogPath, reviewRunSessionDir } from "../paths.js";
import { reviewRunConfig } from "../config/config-views.js";
import { logEventBestEffort } from "../events/events.js";
import { gitTry } from "../git/git-run.js";
import { ensureDetachedWorktree } from "../git/worktree.js";
import { useWorktree } from "../git/worktree-use.js";
import { readPrinciples } from "../prompt/principles.js";
import { buildReviewPrompt } from "../prompt/gate-prompts.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { shortSha } from "../text/format.js";
import { errorMessage } from "../text/text.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { GateRunsPi } from "../runner/runner-pi.js";
import { parseVerdict } from "./review-verdict.js";

/** A merged commit of a role listed in `review.afterMerge`, waiting for its review
 * (.tumwater/state/post-review.json). `rejected` holds the reviewer's reasons once it rejected the
 * commit and its revert has not been started yet (the revert slot was busy). */
export interface PostReview {
  commit: string;
  role: string;
  summary: string;
  body?: string;
  /** Review runs that ended without a verdict. */
  failures?: number;
  rejected?: string[];
}

/** A commit's review is dropped, with a warning, after this many runs with no verdict. */
export const POST_REVIEW_FAILURE_LIMIT = 3;

/** Whether `role`'s changes are reviewed after merging instead of before. */
export function isAfterMergeRole(config: TumwaterConfig, role: string): boolean {
  return (config.review.afterMerge ?? []).includes(baseRoleOf(role));
}

export function readPostReviews(root: string): PostReview[] {
  const saved = readJsonFile<{ pending?: PostReview[] }>(postReviewPath(root));
  return Array.isArray(saved?.pending) ? saved.pending : [];
}

function writePostReviews(root: string, pending: PostReview[]): void {
  writeJsonAtomic(postReviewPath(root), { pending });
}

/** Queue the merged commit for its review. */
export function addPostReview(root: string, entry: PostReview): void {
  writePostReviews(root, [...readPostReviews(root).filter((e) => e.commit !== entry.commit), entry]);
}

/** Replace the entry for `commit` with `next`, or drop it when `next` is null. */
export function settlePostReview(root: string, commit: string, next: PostReview | null): void {
  const rest = readPostReviews(root).filter((e) => e.commit !== commit);
  writePostReviews(root, next ? [...rest, next] : rest);
}

type PostReviewOutcome =
  | { kind: "approve"; reasons: string[] }
  | { kind: "reject"; reasons: string[] }
  | { kind: "failed"; detail: string };

/** Review the merged commit C: the usual reviewer prompt over `git diff C^ C`, run in a detached
 * checkout of C. Logs `review_start` and `review_verdict` / `review_rejected` with
 * `afterMerge: true`. Never throws. */
export async function reviewMergedCommit(
  root: string,
  config: TumwaterConfig,
  entry: PostReview,
  runGatePi: GateRunsPi["runGatePi"],
  signal: AbortSignal | undefined,
): Promise<PostReviewOutcome> {
  const { commit, role } = entry;
  try {
    const reviewCfg = reviewRunConfig(config);
    const startedAt = Date.now();
    const pi = await useWorktree(root, postReviewWorktreePath(root), async () => {
      const wt = await ensureDetachedWorktree(root, postReviewWorktreePath(root), commit);
      await gitTry(wt, "checkout", "--detach", "--force", commit);
      const diff = (await gitTry(wt, "diff", `${commit}^`, commit)) ?? "";
      logEventBestEffort(root, { source: role, type: "review_start", head: commit, afterMerge: true });
      return runGatePi({
        cwd: wt,
        kind: "gate",
        prompt: buildReviewPrompt(diff, entry.summary, entry.body, readPrinciples(root), undefined, `${commit}^`),
        config: reviewCfg,
        sessionDir: reviewRunSessionDir(root, role, `post-${shortSha(commit)}`),
        sessionName: `tumwater-review-${role}-post-${shortSha(commit)}`,
        rawLogFile: piLogPath(root, role),
        nativeLogFile: nativeLogPath(root, role, reviewCfg.agent ?? "pi"),
        label: "review",
        signal,
      });
    });
    const verdict = pi.ok && !pi.aborted ? parseVerdict(pi.verdictText ?? "") : null;
    if (!verdict) return { kind: "failed", detail: pi.errorMessage ?? "no parseable VERDICT line in the reviewer's reply" };
    const durationMs = Date.now() - startedAt;
    if (verdict.verdict === "reject") {
      logEventBestEffort(root, { source: role, type: "review_rejected", head: commit, reasons: verdict.reasons, durationMs, afterMerge: true });
      return { kind: "reject", reasons: verdict.reasons };
    }
    logEventBestEffort(root, { source: role, type: "review_verdict", head: commit, reason: verdict.reasons[0], durationMs, afterMerge: true });
    return { kind: "approve", reasons: verdict.reasons };
  } catch (err) {
    return { kind: "failed", detail: errorMessage(err) };
  }
}
