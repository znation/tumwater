import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { postReviewPath, postReviewWorktreePath, nativeLogPath, piLogPath, reviewRunSessionDir, reviewFixRef } from "../paths.js";
import { reviewedAfterMerge, reviewRunConfig } from "../config/config-views.js";
import { logEventBestEffort, TUMWATER_SOURCE, tryOrWarn } from "../events/events.js";
import { isJsonObject } from "../files/json-object.js";
import { git, gitCouldNotStart, gitTry } from "../git/git-run.js";
import { commitAll, deleteRef, setRef } from "../git/git.js";
import { ensureDetachedWorktree } from "../git/worktree.js";
import { useWorktree } from "../git/worktree-use.js";
import { readPrinciples } from "../prompt/principles.js";
import { buildReviewPrompt } from "../prompt/gate-prompts.js";
import { shortSha } from "../text/format.js";
import { errorMessage } from "../text/text.js";
import { eventRole } from "../events/event-read.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { fixLine } from "../verdict/reply-contract.js";
import type { HarnessEvent } from "../events/events.js";
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
  /** The most recent verdict-less run's detail: replaced on each failed run and cleared when the
   * entry is settled or removed. */
  lastFailure?: string;
  rejected?: string[];
  /** The sha of the reviewer's landed fix commit, when the review repaired what it found instead
   * of rejecting (Forward never back 1a/6). The entry then names both shas: `commit` is the
   * reviewed commit C and `fixed` the one fix commit that merged on top of it. */
  fixed?: string;
  /** When the entry was first queued for review, epoch ms; absent on an entry an older file
   * wrote. `settlePostReview` already spreads `next`, so a failed re-settle and a rejection
   * keep the original stamp. */
  enqueuedAt?: number;
}

/** A commit's review is dropped, with a warning, after this many runs with no verdict. */
export const POST_REVIEW_FAILURE_LIMIT = 3;

/** A role's trailing-day total of post-merge `review_rejected` events, one entry per role with
 * at least one, sorted by count descending then role id ascending so the churn alert's phrase is
 * deterministic. count is how many already-landed commits the role had turned back. */
export interface PostMergeRejection {
  role: string;
  count: number;
}

/** The bar a day's post-merge rejections must reach before the `post-merge-churn` amber alert
 * (src/ui/team-alerts.ts) fires: one post-merge rejection is the tiering's ordinary cost, two in
 * a day is a role whose already-landed changes keep being turned back — an operator's signal
 * to narrow `review.afterMerge` or raise the authoring bar. */
export const POST_MERGE_REJECT_WARN = 2;

/** How far back the post-merge-churn rule looks — one day, the 24 h event-window convention
 * every event-reading alert uses (PRIMARY_OVERWRITE_WINDOW_MS sorts beside it). */
export const POST_MERGE_REJECT_WINDOW_MS = 24 * 60 * 60_000;

/** Group the `afterMerge: true` `review_rejected` events of `events` by base role — the same
 * `e.type === "review_rejected" && e.afterMerge === true` test the report fold
 * (src/report/report-fold.ts `postMergeRejectionsByRole`) applies, so the churn alert and the
 * report cannot disagree on which rejections are post-merge. The key is the event's base role
 * (`baseRoleOf(eventRole(ev))`), not the raw source: an event's `source` is the runner id
 * (`bugfix-2`), and both the alert's remedy ("narrow `review.afterMerge`") and the scoped
 * report are keyed by base role, so one base role's churn must read as one row. Pre-merge
 * rejections and other event types contribute nothing. */
export function postMergeRejectionCounts(events: readonly HarnessEvent[]): PostMergeRejection[] {
  const byRole = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "review_rejected" && ev.afterMerge === true) {
      const role = baseRoleOf(eventRole(ev));
      byRole.set(role, (byRole.get(role) ?? 0) + 1);
    }
  }
  return [...byRole.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
}

/** The one home of the trigger and selection the `post-merge-churn` alert (src/ui/team-alerts.ts)
 * and the doctor's `post-merge churn` row (src/doctor/doctor-project-checks.ts) share: whether
 * the trailing `POST_MERGE_REJECT_WINDOW_MS` holds at least `POST_MERGE_REJECT_WARN` post-merge
 * `review_rejected` events, and, when it does, which roles and how many each. null when the
 * window holds fewer than the bar, or none — so the two surfaces cannot disagree on when churn
 * fires. */
export function postMergeChurn(events: readonly HarnessEvent[]): { count: number; roles: readonly PostMergeRejection[] } | null {
  const roles = postMergeRejectionCounts(events);
  const count = roles.reduce((n, r) => n + r.count, 0);
  return count >= POST_MERGE_REJECT_WARN ? { count, roles } : null;
}

/** Whether `role`'s changes are reviewed after merging instead of before. One home for the
 * membership test, config-views.ts's reviewedAfterMerge — the same predicate the review gate,
 * the runner's `already_queued` recovery arm and the role view read. */
export function isAfterMergeRole(config: TumwaterConfig, role: string): boolean {
  return reviewedAfterMerge(config, role);
}

/** The queued entries. A torn or hand-edited entry (not an object with a string commit, role and
 * summary, or a `rejected` that is not an array — a non-string `lastFailure` is dropped like the
 * other fields) is dropped, and the next write leaves it out. */
export function readPostReviews(root: string): PostReview[] {
  const saved = readJsonFile<{ pending?: unknown }>(postReviewPath(root));
  if (!Array.isArray(saved?.pending)) return [];
  const entries: PostReview[] = [];
  for (const raw of saved.pending as unknown[]) {
    if (!isJsonObject(raw)) continue;
    const { commit, role, summary, body, failures, lastFailure, rejected, enqueuedAt, fixed } = raw;
    if (typeof commit !== "string" || typeof role !== "string" || typeof summary !== "string") continue;
    if (rejected !== undefined && !Array.isArray(rejected)) continue;
    const entry: PostReview = { commit, role, summary };
    if (typeof body === "string") entry.body = body;
    if (typeof failures === "number" && Number.isFinite(failures)) entry.failures = failures;
    if (typeof lastFailure === "string") entry.lastFailure = lastFailure;
    if (Array.isArray(rejected)) entry.rejected = rejected.filter((r): r is string => typeof r === "string");
    if (typeof fixed === "string") entry.fixed = fixed;
    if (typeof enqueuedAt === "number" && Number.isFinite(enqueuedAt) && enqueuedAt >= 0) entry.enqueuedAt = enqueuedAt;
    entries.push(entry);
  }
  return entries;
}

function writePostReviews(root: string, pending: PostReview[]): void {
  tryOrWarn(root, TUMWATER_SOURCE, "write post-review.json", () => writeJsonAtomic(postReviewPath(root), { pending }));
}

/** Queue the merged commit for its review. Never throws: a failed write warns and leaves the file
 * as it was, so the commit goes unreviewed. Stamps `enqueuedAt` when the entry carries none —
 * the file's existing stamp on a re-add of a known commit, else `now` (the default clock when the
 * write path drives the drain) — so a re-queued entry keeps its original stamp and tests can pin
 * a fixed instant. */
export function addPostReview(root: string, entry: PostReview, now: number = Date.now()): void {
  const rest = readPostReviews(root);
  const prior = rest.find((e) => e.commit === entry.commit)?.enqueuedAt;
  const stamped: PostReview = { ...entry, enqueuedAt: entry.enqueuedAt ?? prior ?? now };
  writePostReviews(root, [...rest.filter((e) => e.commit !== entry.commit), stamped]);
}

/** Replace the entry for `commit` with `next`, or drop it when `next` is null. Never throws: a
 * failed write warns and leaves the file as it was, so a later poll handles the entry again. */
export function settlePostReview(root: string, commit: string, next: PostReview | null): void {
  const rest = readPostReviews(root).filter((e) => e.commit !== commit);
  writePostReviews(root, next ? [...rest, next] : rest);
}

type PostReviewOutcome =
  | { kind: "approve"; reasons: string[] }
  | { kind: "reject"; reasons: string[] }
  | { kind: "fixed"; fix: string; reasons: string[] }
  | { kind: "failed"; detail: string };

/** Cut a review finding's first reason short enough to ride a commit subject (the
 * `tumwater(reviewer): Fix …` subject names it): trimmed of leading/trailing and repeated
 * whitespace, clipped at a word boundary around 100 chars with an ellipsis. */
function clipFixReason(reason: string): string {
  const trimmed = reason.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 100) return trimmed;
  return `${trimmed.slice(0, 97).replace(/\s+\S*$/, "")}…`;
}

/** Commit the review worktree's edited paths as the one `tumwater(reviewer): Fix <short sha> —
 * <first finding>` fix commit, made by the harness's own git call (never pi) — commitAll stages
 * and commits everything, so however the reviewer edited a path, the single commit captures it
 * on top of the reviewed commit C (the detached HEAD the worktree reset to); the caller advances
 * the review-fix ref to the returned sha. Returns the new commit's full sha. */
async function commitReviewerFix(wt: string, commit: string, reasons: string[]): Promise<string> {
  const first = reasons[0] ? clipFixReason(reasons[0]) : "the reviewed change";
  const subject = `tumwater(reviewer): Fix ${shortSha(commit)} — ${first}`;
  const body = reasons.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return commitAll(wt, body ? `${subject}\n\n${body}` : subject);
}

/** Review the merged commit C: the usual reviewer prompt over `git diff C^ C`, run in a detached
 * checkout of C. Logs `review_start` and `review_verdict` / `review_rejected` with
 * `afterMerge: true`. A diff git fails to produce is a failed review with no reviewer run: read
 * as empty, the reviewer approved a commit it never saw. Throws only when git could not start
 * (gitCouldNotStart), which says nothing about C, so the caller keeps the entry as it was for
 * the next poll instead of counting a failed run toward dropping it. */
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
    const fixRef = reviewFixRef(commit);
    // The whole review — the detached checkout, the reviewer run, and (on a repair) the status
    // read, the fix commit and its ref — runs under one hold of the post-review worktree
    // (plans/disk-floor.md part 2/4), so nothing can reset or reuse the shared worktree between
    // the reviewer's edit and the commit that captures it.
    return await useWorktree(root, postReviewWorktreePath(root), async () => {
      // The review-fix ref tracks the reviewed commit C (and later the reviewer's fix commit), so
      // a repair survives as a durable reachable ref the pin housekeeping sees. The ref is reset
      // to C at every review and ensureDetachedWorktree hard-resets the worktree to C, so a
      // leftover ref or edit from an earlier review cannot change what is reviewed. Checking the
      // worktree out at C itself (not the ref) keeps the "git could not start" semantics of the
      // detached checkout it replaces: a review whose git cannot start throws gitCouldNotStart.
      const wt = await ensureDetachedWorktree(root, postReviewWorktreePath(root), commit);
      await setRef(root, fixRef, commit);
      const diff = await git(wt, "diff", `${commit}^`, commit);
      logEventBestEffort(root, { source: role, type: "review_start", head: commit, afterMerge: true });
      const pi = await runGatePi({
        cwd: wt,
        kind: "gate",
        prompt: buildReviewPrompt(diff, entry.summary, entry.body, readPrinciples(root), undefined, `${commit}^`, undefined, undefined, undefined, true),
        config: reviewCfg,
        sessionDir: reviewRunSessionDir(root, role, `post-${shortSha(commit)}`),
        sessionName: `tumwater-review-${role}-post-${shortSha(commit)}`,
        rawLogFile: piLogPath(root, role),
        nativeLogFile: nativeLogPath(root, role, reviewCfg.agent ?? "pi"),
        label: "review",
        signal,
      });
      const verdict = pi.ok && !pi.aborted ? parseVerdict(pi.verdictText ?? "") : null;
      if (!verdict) {
        await deleteRef(root, fixRef);
        return { kind: "failed", detail: pi.errorMessage ?? "no parseable VERDICT line in the reviewer's reply" };
      }
      const durationMs = Date.now() - startedAt;
      // One record for the reviewed commit C whatever way the review ends — reject or approve —
      // so the fix-forward landing does not lose the verdict that motivated it.
      if (verdict.verdict === "reject") {
        logEventBestEffort(root, { source: role, type: "review_rejected", head: commit, reasons: verdict.reasons, durationMs, afterMerge: true });
      } else {
        logEventBestEffort(root, { source: role, type: "review_verdict", head: commit, reason: verdict.reasons[0], durationMs, afterMerge: true });
      }
      // A rejecting review whose reply carries a FIX: line and whose worktree holds an edit
      // survives as one fix commit on the review ref, kept for merge-post-review.ts to land on
      // main through the ordinary change path. A clean worktree or a reply with no FIX line keeps
      // today's outcomes and deletes the ref.
      const paths = pi.ok && !pi.aborted ? fixLine(pi.verdictText ?? "") : null;
      if (paths && verdict.verdict === "reject" && (await gitTry(wt, "status", "--porcelain"))?.trim().length) {
        const fix = await commitReviewerFix(wt, commit, verdict.reasons);
        // Advance the review-fix ref from C to the new fix commit, so the repair is reachable and
        // the merge-post-review landing (which checks the fix out by this sha) finds it.
        await setRef(root, fixRef, fix);
        return { kind: "fixed", fix, reasons: verdict.reasons };
      }
      await deleteRef(root, fixRef);
      if (verdict.verdict === "reject") return { kind: "reject", reasons: verdict.reasons };
      return { kind: "approve", reasons: verdict.reasons };
    });
  } catch (err) {
    if (gitCouldNotStart(err)) throw err;
    return { kind: "failed", detail: errorMessage(err) };
  }
}
