/** The operator's deliberate acceptance of a pending post-merge review without running it
 * (src/cli/cli-review-commands.ts `tumwater reviews --accept <n>`), split out of the CLI so
 * the review queue stays a pure reader/editor and this module owns the destructive half —
 * removing an unattempted entry on purpose. It is the sibling of `tumwater queue --cancel
 * <n>` (src/merge/merge-cancel.ts): the queue's no-third-path gap that the at-risk alert's
 * shared sentence names ("…or accept the commit unreviewed deliberately"). It reads the same
 * FIFO list `readPostReviews` numbers 1..N and settles the entry by its commit, so the removed
 * entry is the very one the printed position named. */
import { readPostReviews, settlePostReview } from "./post-merge-review.js";
import { warnEventBestEffort } from "../events/events.js";
import { shortSha } from "../text/format.js";

/** What accepting an un-reviewed post-merge review entry did: `accepted` names the retired
 * entry's role, commit and summary (what one `warning` event logged); `out-of-range` carries
 * the current readable depth so the caller's failure can name it as the valid range;
 * `rejected` names the commit the operator must not accept — that entry is waiting on its
 * revert, and removing it would skip the revert. */
export type AcceptPostReviewOutcome =
  | { status: "accepted"; role: string; commit: string; summary: string }
  | { status: "out-of-range"; depth: number }
  | { status: "rejected"; commit: string };

/** Retire the Nth pending post-merge review — 1-based, as `tumwater reviews` numbers it —
 * accepting the commit unreviewed at the operator's request. `position` is resolved against
 * `readPostReviews` (the same readable FIFO list the command renders), so the position matches
 * the line `tumwater reviews` printed. The write goes through `settlePostReview` (whose failed
 * write already warns and never throws, INV-BT2), and the warning through
 * `warnEventBestEffort`, so this can never throw out of the command. An out-of-range position
 * writes nothing and returns the current readable depth; an entry carrying `rejected` writes
 * nothing and returns `rejected` — it is waiting on its revert, so removing it would skip the
 * revert (the revert must run first, then the revision can be reviewed). On success it removes
 * exactly that one entry, logging one `warning` under the entry's role. */
export function acceptPostReview(root: string, position: number): AcceptPostReviewOutcome {
  const entries = readPostReviews(root);
  if (position < 1 || position > entries.length) return { status: "out-of-range", depth: entries.length };
  const entry = entries[position - 1]!;
  if (entry.rejected) return { status: "rejected", commit: entry.commit };
  settlePostReview(root, entry.commit, null);
  const message = `post-merge review of ${shortSha(entry.commit)} accepted unreviewed at the operator's request — the commit stays on main unreviewed`; // vocabulary-ok: the accepted-unreviewed wording those reasons it is the operator's choice
  warnEventBestEffort(root, entry.role, message);
  return { status: "accepted", role: entry.role, commit: entry.commit, summary: entry.summary };
}
