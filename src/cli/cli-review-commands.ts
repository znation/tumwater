/** `tumwater reviews` — the operator-facing twin of `tumwater queue` for the post-merge review
 * queue (.tumwater/state/post-review.json): list every well-formed entry in FIFO order, or the
 * same list as JSON (`--json`). It does not require a ready repo (the `cmdBacklog` rationale):
 * `readPostReviews` reads a missing, torn or hand-edited file as the well-formed subset (or `[]`),
 * so the command prints the empty line in any directory. Read-only except the one destructive
 * `--accept <n>` mode, which removes the Nth entry the operator deliberately accepts unreviewed
 * (the action the at-risk alert's advice names); that mode adds no new ready-repo requirement to
 * the read path and gates the write with `requireReadyRepo`. Unlike `cmdQueue`'s `--cancel`, the
 * read case still writes no file. */

import { JSON_FLAG, ROLE_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { sayJsonOrRender, say, sayJson, fail } from "./cli-output.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { parseRoleListScope, scanPositionArgs } from "./cli-args.js";
import { readPostReviews } from "../review/post-merge-review.js";
import { acceptPostReview, type AcceptPostReviewOutcome } from "../review/post-merge-review-accept.js";
import { renderPostReviews, scopePostReviews } from "../review/post-merge-review-render.js";
import { roleInScope } from "../roles/runner-ids.js";
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
  rejectUnknownArgs("reviews", args, [ROLE_FLAG, JSON_FLAG]);
  refuseTeamWorkspace(root);
  // `--role` keeps only the listed roles' entries (a base id taking its instances too) under
  // their whole-queue positions, so `--accept <n>` still addresses the position the unscoped
  // read prints. Absent a ready config `parseRoleListScope` falls back to the built-in catalog.
  const roles = parseRoleListScope(root, args);
  const whole = readPostReviews(root);
  const scoped = roles ? scopePostReviews(whole, roles, (r) => roleInScope(r, roles)) : undefined;
  const entries = scoped ? scoped.entries : whole;
  sayJsonOrRender(args, { pending: entries }, () => renderPostReviews(entries, scoped?.scope));
}

/** The `tumwater reviews --accept <n>` branch (PLANS.md): remove the Nth pending post-merge
 * review `tumwater reviews` lists, accepting the commit unreviewed at the operator's request.
 * Parsed the way `cmdQueueCancel` parses `--cancel`: `--accept <n>` the one valued flag,
 * `--json` the one boolean (at most once), `--help`/`-h` tolerated, anything else refused. An
 * out-of-range position fails naming the current depth; an entry already rejected and waiting
 * on its revert is refused (the revert must run first, then the revision can be reviewed). */
async function cmdReviewsAccept(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--accept", "--accept 2");
  // The vocabulary an accept invocation accepts is exactly --accept and --json, both consumed
  // above; --role is refused by name (as cmdQueueCancel refuses it): accept addresses a
  // whole-queue position `tumwater reviews` printed, and a scoped read must never renumber it.
  if (rest.includes("--role")) fail("reviews --accept accepts by whole-queue position from `tumwater reviews`; --role scopes a read only — drop it");
  // Everything else is refused with the generic wording, so `--bogus` is named.
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
