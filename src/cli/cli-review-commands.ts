/** `tumwater reviews` — the operator-facing twin of `tumwater queue` for the post-merge review
 * queue (.tumwater/state/post-review.json): list every well-formed entry in FIFO order, or the
 * same list as JSON (`--json`). It does not require a ready repo (the `cmdBacklog` rationale):
 * `readPostReviews` reads a missing, torn or hand-edited file as the well-formed subset (or `[]`),
 * so the command prints the empty line in any directory. Read-only except the one destructive
 * `--accept <n>` mode, which removes the Nth entry the operator deliberately accepts unreviewed
 * (the action the at-risk alert's advice names); that mode adds no new ready-repo requirement to
 * the read path and gates the write with `requireReadyRepo`. Unlike `cmdQueue`'s `--cancel`, the
 * read case still writes no file. */

import { JSON_FLAG, ROLE_FLAG, rejectUnknownArgs, statusFlagSpec } from "./cli-flag-specs.js";
import { sayJsonOrRender, say, sayJson, fail } from "./cli-output.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { parseRoleListScope, parseStatusFlag, scanPositionArgs } from "./cli-args.js";
import { readPostReviews, type PostReview } from "../review/post-merge-review.js";
import { acceptPostReview, type AcceptPostReviewOutcome } from "../review/post-merge-review-accept.js";
import {
  POST_REVIEW_STATES,
  postReviewState,
  renderPostReviews,
  scopePostReviews,
  type PostReviewState,
} from "../review/post-merge-review-render.js";
import { roleInScope } from "../roles/runner-ids.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";
import { gotSuffix, splitCommaList } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";

/** The missing-value wording of `reviews --status` (shared by the gate's statusFlagSpec and
 * parseStatusFlag's own fail, so the two cannot drift). */
const REVIEWS_STATUS_VALUE_ERROR = "reviews --status needs a value";

/** Parse a `--status` value: a comma list of post-merge review states, deduplicated in
 * first-seen order, accepting only `POST_REVIEW_STATES` members. The first unknown piece fails
 * naming the accepted states, mirroring parseHistoryResultList's gotSuffix/typoSuffix shape. */
function parseReviewStatusList(raw: string): PostReviewState[] {
  if (raw === "") fail(REVIEWS_STATUS_VALUE_ERROR);
  const pieces = splitCommaList(raw);
  if (pieces.length === 0) fail(REVIEWS_STATUS_VALUE_ERROR);
  const spellings = [...POST_REVIEW_STATES];
  const out: PostReviewState[] = [];
  for (const piece of pieces) {
    if (!(POST_REVIEW_STATES as readonly string[]).includes(piece))
      fail(`reviews --status must be one of ${spellings.join(", ")}${gotSuffix(piece)}${typoSuffix(piece, spellings)}`);
    if (!out.includes(piece as PostReviewState)) out.push(piece as PostReviewState);
  }
  return out;
}

/** `tumwater reviews [--json]`: the post-merge review queue, oldest first.*/
export async function cmdReviews(root: string, args: string[]): Promise<void> {
  // `tumwater reviews --accept <n>` is the read-only command's one destructive mode: route it
  // to its own branch before the read gate, so --accept never leaks into the view parsing.
  if (args.includes("--accept")) {
    await cmdReviewsAccept(root, args);
    return;
  }
  rejectUnknownArgs("reviews", args, [ROLE_FLAG, statusFlagSpec(REVIEWS_STATUS_VALUE_ERROR), JSON_FLAG]);
  refuseTeamWorkspace(root);
  // `--role` keeps only the listed roles' entries (a base id taking its instances too) under
  // their whole-queue positions, so `--accept <n>` still addresses the position the unscoped
  // read prints. Absent a ready config `parseRoleListScope` falls back to the built-in catalog.
  const roles = parseRoleListScope(root, args);
  const { raw: statusRaw } = parseStatusFlag(args, REVIEWS_STATUS_VALUE_ERROR);
  const whole = readPostReviews(root);
  let entries: PostReview[] = whole;
  let scope: { roles: readonly string[]; positions: readonly number[]; total: number; filter?: string } | undefined;
  if (statusRaw === null) {
    const scoped = roles ? scopePostReviews(whole, roles, (e) => roleInScope(e.role, roles)) : undefined;
    entries = scoped ? scoped.entries : whole;
    scope = scoped?.scope;
  } else {
    // `--status <state>[,...]` keeps only the listed states (the same precedence
    // postReviewStatusLabel prints: a rejected-and-failing entry is rejected) under their
    // whole-queue positions, composing with `--role`. roles=[] when unscoped.
    const states = parseReviewStatusList(statusRaw);
    const keep = (e: PostReview) => (!roles || roleInScope(e.role, roles)) && states.includes(postReviewState(e));
    const filterText = [roles ? `--role ${roles.join(",")}` : "", `--status ${states.join(",")}`]
      .filter(Boolean)
      .join(" ");
    const scoped = scopePostReviews(whole, roles ?? [], keep, filterText);
    entries = scoped.entries;
    scope = scoped.scope;
  }
  sayJsonOrRender(args, { pending: entries }, () => renderPostReviews(entries, scope, Date.now()));
}

/** The `tumwater reviews --accept <n>` branch (PLANS.md): remove the Nth pending post-merge
 * review `tumwater reviews` lists, accepting the commit unreviewed at the operator's request.
 * Parsed the way `cmdQueueCancel` parses `--cancel`: `--accept <n>` the one valued flag,
 * `--json` the one boolean (at most once), `--help`/`-h` tolerated, anything else refused. An
 * out-of-range position fails naming the current depth; an entry already rejected is refused
 * (the reviewer's rejection stands on main — nothing to accept). */
async function cmdReviewsAccept(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--accept", "--accept 2");
  // The vocabulary an accept invocation accepts is exactly --accept and --json, both consumed
  // above; --role is refused by name (as cmdQueueCancel refuses it): accept addresses a
  // whole-queue position `tumwater reviews` printed, and a scoped read must never renumber it.
  if (rest.includes("--role") || rest.includes("--status")) fail("reviews --accept accepts by whole-queue position from `tumwater reviews`; --role and --status scope a read only — drop them");
  // Everything else is refused with the generic wording, so `--bogus` is named.
  rejectUnknownArgs("reviews", rest, []);
  if (position === null) fail("--accept needs a position (usage: tumwater reviews --accept <n>)");
  await requireReadyRepo(root);
  const outcome: AcceptPostReviewOutcome = acceptPostReview(root, position);
  if (outcome.status === "out-of-range") {
    fail(`no post-merge review at position ${position} (post-merge review queue holds ${outcome.depth})`);
  }
  if (outcome.status === "rejected") {
    fail(`post-merge review ${position} is rejected — it stays on main with the reviewer's reasons, so there is nothing to accept`);
  }
  if (outcome.status === "settled") {
    fail(`post-merge review ${position} already merged its fix on main — nothing to accept`);
  }
  if (json) {
    sayJson({ accepted: { role: outcome.role, commit: outcome.commit, summary: outcome.summary } });
  } else {
    say(`accepted post-merge review entry ${position} unreviewed: ${roleLabel(outcome.role)} ${shortSha(outcome.commit)} — ${outcome.summary}`);
  }
}
