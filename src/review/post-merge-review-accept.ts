/** The operator's deliberate acceptance of a pending post-merge review without running it
 * (src/cli/cli-review-commands.ts `tumwater reviews --accept <n>`), split out of the CLI so
 * the review queue stays a pure reader/editor and this module owns the destructive half —
 * removing an unattempted entry on purpose. It is the sibling of `tumwater queue --cancel
 * <n>` (src/merge/merge-cancel.ts): the queue's no-third-path gap that the at-risk alert's
 * shared sentence names ("…or accept the commit unreviewed deliberately"). It reads the same
 * FIFO list `readPostReviews` numbers 1..N and settles the entry by its commit, so the removed
 * entry is the very one the printed position named. */
import { readPostReviews, settlePostReview, type PostReview } from "./post-merge-review.js";
import { warnEventBestEffort } from "../events/events.js";
import { shortSha } from "../text/format.js";

/** What accepting an un-reviewed post-merge review entry did: `accepted` names the retired
 * entry's role, commit and summary (what one `warning` event logged); `out-of-range` carries
 * the current readable depth so the caller's failure can name it as the valid range;
 * `settled` names the commit the operator must not accept — a `fixed` entry's repair already
 * merged. */
export type AcceptPostReviewOutcome =
  | { status: "accepted"; role: string; commit: string; summary: string }
  | { status: "out-of-range"; depth: number }
  | { status: "settled"; commit: string };

/** Remove one readable entry the operator accepts unreviewed: refuse it (writing nothing) when
 * it carries `fixed` — the repair already merged, so accepting it unreviewed is meaningless
 * and the false "accepted unreviewed" warning would mislead — otherwise settle it with no
 * verdict (`settlePostReview`; its failed write already warns and never throws, INV-BT2),
 * log one `warning` under the entry's role, and return the `accepted` outcome naming what was
 * retired. A rejected entry waits on nothing, so it is accepted like any other pending entry.
 * The single removal both `acceptPostReview` (by position) and `acceptPostReviewBySha`
 * (by sha) share, so the CLI and the dashboard's post-review-accept cannot drift on what
 * accepting means. */
function removeAcceptedEntry(root: string, entry: PostReview): AcceptPostReviewOutcome {
  if (entry.fixed !== undefined) return { status: "settled", commit: entry.commit };
  settlePostReview(root, entry.commit, null);
  const message = `post-merge review of ${shortSha(entry.commit)} accepted unreviewed at the operator's request — the commit stays on main unreviewed`; // vocabulary-ok: the accepted-unreviewed wording those reasons it is the operator's choice
  warnEventBestEffort(root, entry.role, message);
  return { status: "accepted", role: entry.role, commit: entry.commit, summary: entry.summary };
}

/** Retire the Nth pending post-merge review — 1-based, as `tumwater reviews` numbers it —
 * accepting the commit unreviewed at the operator's request. `position` is resolved against
 * `readPostReviews` (the same readable FIFO list the command renders), so the position matches
 * the line `tumwater reviews` printed. An out-of-range position writes nothing and returns the
 * current readable depth; otherwise it runs the same `removeAcceptedEntry` the sha variant
 * shares, so the two never drift on what accepting means (see `removeAcceptedEntry` for the
 * removal, the fixed-guard, the warning, and the never-throws guarantee). */

export function acceptPostReview(root: string, position: number): AcceptPostReviewOutcome {
  const entries = readPostReviews(root);
  if (position < 1 || position > entries.length) return { status: "out-of-range", depth: entries.length };
  return removeAcceptedEntry(root, entries[position - 1]!);
}

/** What removing a pending post-merge review by its commit did: `accepted`/`out-of-range`/
 * `settled` as `AcceptPostReviewOutcome` does (the sha variant never returns `out-of-range`);
 * `gone` — a concurrent drain already settled the entry, so the client gets data, not an error,
 * in the `/api/queue-cancel` gone idiom. */
export type AcceptPostReviewByShaOutcome = AcceptPostReviewOutcome | { status: "gone" };

/** Remove the pending post-merge review whose entry's commit is `sha` (the browser twin of
 * `tumwater reviews --accept <n>`, resolving by commit because the dashboard rows carry one).
 * A commit that matches none is `{ status: "gone" }` and changes nothing; otherwise it runs the
 * same `removeAcceptedEntry` the position variant shares. */
export function acceptPostReviewBySha(root: string, sha: string): AcceptPostReviewByShaOutcome {
  const entry = readPostReviews(root).find((e) => e.commit.toLowerCase() === sha.toLowerCase());
  if (!entry) return { status: "gone" };
  return removeAcceptedEntry(root, entry);
}
