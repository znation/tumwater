/** `tumwater reviews` — the operator-facing twin of `tumwater queue` for the post-merge review
 * queue (.tumwater/state/post-review.json): list every well-formed entry in FIFO order, or the
 * same list as JSON (`--json`). It does not require a ready repo (the `cmdBacklog` rationale):
 * `readPostReviews` reads a missing, torn or hand-edited file as the well-formed subset (or `[]`),
 * so the command prints the empty line in any directory. Read-only except the one destructive
 * `--accept <n>` mode, which removes the Nth entry the operator deliberately accepts unreviewed
 * (the action the at-risk alert's advice names); that mode adds no new ready-repo requirement to
 * the read path and gates the write with `requireReadyRepo`. Unlike `cmdQueue`'s `--cancel`, the
 * read case still writes no file. */

import { JSON_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { sayJsonOrRender, say, sayJson, fail } from "./cli-output.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { parsePositionFlag, rejectRepeatFlag } from "./cli-args.js";
import { readPostReviews } from "../review/post-merge-review.js";
import { acceptPostReview, type AcceptPostReviewOutcome } from "../review/post-review-accept.js";
import { renderPostReviews } from "../review/post-review-render.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";

/** `tumwater reviews [--json]`: the post-merge review queue, oldest first.*/
export async function cmdReviews(root: string, args: string[]): Promise<void> {
  // `tumwater reviews --accept <n>` is the read-only command's one destructive mode: route it
  // to its own branch before the read gate, so --accept never leaks into the view parsing.
  if (args.includes("--accept")) {
    await cmdReviewsAccept(root, args);
    return;
  }
  rejectUnknownArgs("reviews", args, [JSON_FLAG]);
  refuseTeamWorkspace(root);
  const entries = readPostReviews(root);
  sayJsonOrRender(args, { pending: entries }, () => renderPostReviews(entries));
}

/** The `tumwater reviews --accept <n>` branch (PLANS.md): remove the Nth pending post-merge
 * review `tumwater reviews` lists, accepting the commit unreviewed at the operator's request.
 * Parsed the way `cmdQueueCancel` parses `--cancel`: `--accept <n>` the one valued flag,
 * `--json` the one boolean (at most once), `--help`/`-h` tolerated, anything else refused. An
 * out-of-range position fails naming the current depth; an entry already rejected and waiting
 * on its revert is refused (the revert must run first, then the revision can be reviewed). */
async function cmdReviewsAccept(root: string, args: string[]): Promise<void> {
  let position: number | null = null;
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (arg === "--accept") {
      rejectRepeatFlag(position !== null, "--accept");
      position = parsePositionFlag("--accept", args[i + 1], "--accept 2");
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg as string);
  }
  // The vocabulary an accept invocation accepts is exactly --accept and --json, both consumed
  // above; anything else is refused with the generic wording, so `--bogus` is named.
  rejectUnknownArgs("reviews", rest, []);
  if (position === null) fail("--accept needs a position (usage: tumwater reviews --accept <n>)");
  await requireReadyRepo(root);
  const outcome: AcceptPostReviewOutcome = acceptPostReview(root, position);
  if (outcome.status === "out-of-range") {
    fail(`no post-merge review at position ${position} (post-merge review queue holds ${outcome.depth})`);
  }
  if (outcome.status === "rejected") {
    fail(`post-merge review ${position} is rejected and waiting on its revert — let the revert run, then review the revision`);
  }
  if (json) {
    sayJson({ accepted: { role: outcome.role, commit: outcome.commit, summary: outcome.summary } });
  } else {
    say(`accepted post-merge review entry ${position} unreviewed: ${roleLabel(outcome.role)} ${shortSha(outcome.commit)} — ${outcome.summary}`);
  }
}
