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
 * is set; else the number of verdict-less review runs when `failures` is positive; else `""`.
 * Reasons are squashed to 60 as `tumwater reviews` has always printed them. Extracted so the
 * CLI, the dashboard and the TUI share one status wording and cannot drift. */
export function postReviewStatusLabel(entry: PostReview): string {
  if (entry.rejected !== undefined) {
    return `[rejected — waiting to revert: ${entry.rejected.map((r) => squash(r, 60)).join("; ")}]`;
  }
  if (typeof entry.failures === "number" && entry.failures > 0) {
    return `[${plural(entry.failures, "failed review run")}]`;
  }
  return "";
}

/** The text `tumwater reviews` prints. Empty renders `post-merge review queue empty`; otherwise
 * a header and one line per entry — position, role, short commit, squashed summary, and the
 * status suffix from `postReviewStatusLabel`, appended as `" · " + label` only when it is
 * non-empty. */
export function renderPostReviews(entries: readonly PostReview[]): string {
  if (entries.length === 0) return "post-merge review queue empty";
  const lines: string[] = [`post-merge review queue (${plural(entries.length, "entry", "entries")}):`];
  entries.forEach((entry, i) => {
    const label = postReviewStatusLabel(entry);
    const suffix = label === "" ? "" : ` · ${label}`;
    lines.push(`  ${i + 1}. ${roleLabel(entry.role)} ${shortSha(entry.commit)} · ${squash(entry.summary, 80)}${suffix}`);
  });
  return lines.join("\n");
}
