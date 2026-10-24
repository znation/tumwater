/** The renderer behind `tumwater reviews` — the operator-facing text for the post-merge review
 * queue (.tumwater/state/post-review.json): one line per well-formed entry in the given order,
 * plus a `post-merge review queue (N):` header. Pure function of the entry list — the optional
 * `now` is the only clock input, and when it is a number and an entry carries `enqueuedAt` the
 * line names the wait since the entry was first queued, exactly as the merge queue names its
 * age — so a test can pin its output exactly. The `merge queue empty` convention
 * (src/merge/merge-queue-render.ts) is reused for the empty case. */

import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";
import { squash } from "../text/text.js";
import { filterKeepPositions } from "../collections.js";
import { plural } from "../text/phrases.js";
import { humanAgo } from "../text/datetime.js";
import type { PostReview } from "./post-merge-review.js";

/** The one state every observer surface narrows on: `fixed` when the repair already merged
 * (the terminal Forward-never-back 1a/6 record — naming both shas, it is not pending anything),
 * `rejected` when the reviewer turned the commit back (empty `rejected` array still counts),
 * `failing` when the review runs keep ending without a verdict (`failures` positive), else
 * `waiting`. The precedence matches what postReviewStatusLabel already printed — an entry can
 * never be both — so the status label and `tumwater reviews --status` share this one definition
 * and cannot drift. */
export function postReviewState(entry: PostReview): PostReviewState {
  if (entry.fixed !== undefined) return "fixed";
  if (entry.rejected !== undefined) return "rejected";
  if (typeof entry.failures === "number" && entry.failures > 0) return "failing";
  return "waiting";
}

/** The states `tumwater reviews --status` accepts, in the order the filter's error message
 * lists them (the terminal `fixed` last). `postReviewState` is the definition; this only names
 * the vocabulary. */
export const POST_REVIEW_STATES = ["waiting", "failing", "rejected", "fixed"] as const;
export type PostReviewState = (typeof POST_REVIEW_STATES)[number];

/** The bracketed status suffix one post-merge review entry carries on every observer surface
 * (`tumwater reviews`, the dashboard's Post-merge reviews card, and the TUI Pending pane's
 * review block): the reviewer's rejected reasons when `rejected` is set; else the number of
 * verdict-less review runs when `failures` is positive, naming the
 * last failure's reason beside the count when `lastFailure` is a non-empty string; else `""`.
 * Reasons are squashed to 60 as `tumwater reviews` has always printed them, and the failure
 * detail to 80. Branches on `postReviewState` so the label and the `--status` filter share one
 * state definition; extracted so the
 * CLI, the dashboard and the TUI share one status wording and cannot drift. */
export function postReviewStatusLabel(entry: PostReview): string {
  switch (postReviewState(entry)) {
    case "fixed":
      return `[fixed — the repair ${shortSha(entry.fixed!)} already merged on main]`;
    case "rejected":
      return `[rejected: ${entry.rejected!.map((r) => squash(r, 60)).join("; ")}]`;
    case "failing": {
      const failures = entry.failures as number; // postReviewState only says "failing" when failures > 0
      if (typeof entry.lastFailure === "string" && entry.lastFailure.length > 0) {
        return `[${plural(failures, "failed review run")} — last: ${squash(entry.lastFailure, 80)}]`;
      }
      return `[${plural(failures, "failed review run")}]`;
    }
    default:
      return "";
  }
}

/** Narrows a whole post-merge review list to the entries `keep` accepts, and returns
 * the `scope` renderPostReviews takes: the kept roles, each kept entry's 1-based place in the
 * whole list, and the whole list's entry count — plus, when a status filter is active, the
 * `filter` text the header and no-match line print. The filtering-and-positioning step is the
 * shared `filterKeepPositions` (src/collections.ts) that `scopeMergeQueue` (src/merge/
 * merge-queue-render.ts) also uses, so `tumwater reviews --role` keeps the same whole-queue
 * positions `--accept <n>` still addresses. */
export function scopePostReviews(
  entries: readonly PostReview[],
  roles: readonly string[],
  keep: (entry: PostReview) => boolean,
  filter?: string,
): { entries: PostReview[]; scope: { roles: readonly string[]; positions: number[]; total: number; filter?: string } } {
  const { kept, positions } = filterKeepPositions(entries, keep);
  return {
    entries: kept,
    scope: { roles, positions, total: entries.length, ...(filter !== undefined ? { filter } : {}) },
  };
}

/** The text `tumwater reviews` prints. A totally empty queue renders `post-merge review queue
 * empty`; otherwise a header and one line per entry — position, role, short commit, and, when
 * `now` and the entry's `enqueuedAt` are both numbers, the wait since the commit was queued
 * (`<age> ago`, between the short commit and the summary) — then the squashed summary and the
 * status suffix from `postReviewStatusLabel`, appended as `" · " + label` only when it is
 * non-empty. Without a `now`, or for an entry with no `enqueuedAt`, the line is byte-identical
 * to before, so an older `post-review.json` and every existing renderer test read unchanged.
 * With the optional `scope` (`reviews --role`/`--status`: `entries` already holds only the kept
 * entries', `positions` their 1-based places in the whole queue, `total` the whole queue's
 * entry count, and `filter` the `--role`/`--status` filter text when one is active) each line
 * keeps its whole-queue number and the header reads
 * `post-merge review queue (<kept> of <total>, <filter>):`, where `<filter>` is `scope.filter`
 * when set else `--role <ids>`. A scope that keeps nothing of a non-empty queue prints
 * `no post-merge reviews matching <filter> (post-merge review queue holds <total>)` when a
 * filter is set, else `no post-merge reviews for <ids> (…)`. Without `scope` and `now` the
 * output is byte-identical to before. */
export function renderPostReviews(
  entries: readonly PostReview[],
  scope?: { roles: readonly string[]; positions: readonly number[]; total: number; filter?: string },
  now?: number,
): string {
  const total = scope ? scope.total : entries.length;
  if (total === 0) return "post-merge review queue empty";
  if (scope && entries.length === 0) {
    const reason = scope.filter !== undefined ? `matching ${scope.filter}` : `for ${scope.roles.join(",")}`;
    return `no post-merge reviews ${reason} (post-merge review queue holds ${total})`;
  }
  const lines: string[] = [
    scope
      ? `post-merge review queue (${entries.length} of ${total}, ${scope.filter ?? `--role ${scope.roles.join(",")}`}):`
      : `post-merge review queue (${plural(total, "entry", "entries")}):`,
  ];
  entries.forEach((entry, i) => {
    const label = postReviewStatusLabel(entry);
    const suffix = label === "" ? "" : ` · ${label}`;
    const age =
      typeof now === "number" && typeof entry.enqueuedAt === "number"
        ? ` · ${humanAgo(entry.enqueuedAt, now)}`
        : "";
    lines.push(`  ${scope ? scope.positions[i] : i + 1}. ${roleLabel(entry.role)} ${shortSha(entry.commit)}${age} · ${squash(entry.summary, 80)}${suffix}`);
  });
  return lines.join("\n");
}
