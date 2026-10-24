/** The renderer behind `tumwater reviews` — the operator-facing text for the post-merge review
 * queue (.tumwater/state/post-review.json): one line per well-formed entry in the given order,
 * plus a `post-merge review queue (N):` header. Pure function of the entry list — no I/O and no
 * clock read (an entry carries no timestamp, so there is no age line; a reader wanting the
 * commit's age uses `tumwater history <role>`), so a test can pin its output exactly. The
 * `merge queue empty` convention (src/merge/merge-queue-render.ts) is reused for the empty case. */

import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";
import { squash } from "../text/text.js";
import { plural } from "../text/phrases.js";
import type { PostReview } from "./post-merge-review.js";

/** The bracketed status suffix one post-merge review entry carries on every observer surface
 * (`tumwater reviews`, the dashboard's Post-merge reviews card, and the TUI Pending pane's
 * review block): the reviewer's rejected reasons, still waiting on the revert, when `rejected`
 * is set; else the number of verdict-less review runs when `failures` is positive, naming the
 * last failure's reason beside the count when `lastFailure` is a non-empty string; else `""`.
 * Reasons are squashed to 60 as `tumwater reviews` has always printed them, and the failure
 * detail to 80. Extracted so the
 * CLI, the dashboard and the TUI share one status wording and cannot drift. */
export function postReviewStatusLabel(entry: PostReview): string {
  if (entry.rejected !== undefined) {
    return `[rejected — waiting to revert: ${entry.rejected.map((r) => squash(r, 60)).join("; ")}]`;
  }
  if (typeof entry.failures === "number" && entry.failures > 0) {
    if (typeof entry.lastFailure === "string" && entry.lastFailure.length > 0) {
      return `[${plural(entry.failures, "failed review run")} — last: ${squash(entry.lastFailure, 80)}]`;
    }
    return `[${plural(entry.failures, "failed review run")}]`;
  }
  return "";
}

/** Narrows a whole post-merge review list to the entries whose role `keep` accepts, and returns
 * the `scope` renderPostReviews takes: the kept roles, each kept entry's 1-based place in the
 * whole list, and the whole list's entry count. Mirrors `scopeMergeQueue` (src/merge/
 * merge-queue-render.ts) so `tumwater reviews --role` keeps the same whole-queue positions
 * `--accept <n>` still addresses. */
export function scopePostReviews(
  entries: readonly PostReview[],
  roles: readonly string[],
  keep: (role: string) => boolean,
): { entries: PostReview[]; scope: { roles: readonly string[]; positions: number[]; total: number } } {
  const positions: number[] = [];
  const kept = entries.filter((e, i) => {
    const isKept = keep(e.role);
    if (isKept) positions.push(i + 1);
    return isKept;
  });
  return { entries: kept, scope: { roles, positions, total: entries.length } };
}

/** The text `tumwater reviews` prints. A totally empty queue renders `post-merge review queue
 * empty`; otherwise a header and one line per entry — position, role, short commit, squashed
 * summary, and the status suffix from `postReviewStatusLabel`, appended as `" · " + label` only
 * when it is non-empty. With the optional `scope` (`reviews --role`: `entries` already holds
 * only the listed roles', `positions` their 1-based places in the whole queue, `total` the whole
 * queue's entry count) each line keeps its whole-queue number, the header reads
 * `post-merge review queue (<kept> of <total>, --role <ids>):`, and a scope that keeps nothing
 * of a non-empty queue prints `no post-merge reviews for <ids> (post-merge review queue holds
 * <total>)`. Without `scope` the output is byte-identical to before. */
export function renderPostReviews(
  entries: readonly PostReview[],
  scope?: { roles: readonly string[]; positions: readonly number[]; total: number },
): string {
  const total = scope ? scope.total : entries.length;
  if (total === 0) return "post-merge review queue empty";
  const ids = scope ? scope.roles.join(",") : "";
  if (scope && entries.length === 0) {
    return `no post-merge reviews for ${ids} (post-merge review queue holds ${total})`;
  }
  const lines: string[] = [
    scope
      ? `post-merge review queue (${entries.length} of ${total}, --role ${ids}):`
      : `post-merge review queue (${plural(total, "entry", "entries")}):`,
  ];
  entries.forEach((entry, i) => {
    const label = postReviewStatusLabel(entry);
    const suffix = label === "" ? "" : ` · ${label}`;
    lines.push(`  ${scope ? scope.positions[i] : i + 1}. ${roleLabel(entry.role)} ${shortSha(entry.commit)} · ${squash(entry.summary, 80)}${suffix}`);
  });
  return lines.join("\n");
}
