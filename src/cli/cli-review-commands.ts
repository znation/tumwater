/** `tumwater reviews` — the operator-facing twin of `tumwater queue` for the post-merge review
 * queue (.tumwater/state/post-review.json): list every well-formed entry in FIFO order, or the
 * same list as JSON (`--json`). It does not require a ready repo (the `cmdBacklog` rationale):
 * `readPostReviews` reads a missing, torn or hand-edited file as the well-formed subset (or `[]`),
 * so the command prints the empty line in any directory. It is read-only — unlike `cmdQueue`'s
 * `--cancel`, it writes no file. */

import { JSON_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { sayJsonOrRender } from "./cli-output.js";
import { refuseTeamWorkspace } from "./cli-repo-gate.js";
import { readPostReviews } from "../review/post-merge-review.js";
import { renderPostReviews } from "../review/post-review-render.js";

/** `tumwater reviews [--json]`: the post-merge review queue, oldest first.*/
export async function cmdReviews(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("reviews", args, [JSON_FLAG]);
  refuseTeamWorkspace(root);
  const entries = readPostReviews(root);
  sayJsonOrRender(args, { pending: entries }, () => renderPostReviews(entries));
}
