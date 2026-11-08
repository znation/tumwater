/** `tumwater reviews` — the operator-facing twin of `tumwater queue` for the post-merge review
 * queue (.tumwater/state/post-review.json): list every well-formed entry in FIFO order, or the
 * same list as JSON (`--json`). It does not require a ready repo (the `cmdBacklog` rationale):
 * `readPostReviews` reads a missing, torn or hand-edited file as the well-formed subset (or `[]`),
 * so the command prints the empty line in any directory. Read-only except the one destructive
 * `--accept <n>` mode, which removes the Nth entry the operator deliberately accepts unreviewed
 * (the action the doctor's at-risk post-review row's advice names); that mode adds no new
 * ready-repo requirement to
 * the read path and gates the write with `requireReadyRepo`. Unlike `cmdQueue`'s `--cancel`, the
 * read case still writes no file. */

import { FOLLOW_FLAG, hasFollowFlag, JSON_FLAG, ROLE_FLAG, rejectUnknownArgs, grepFlagSpec, statusFlagSpec } from "./cli-flag-specs.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import { sayJsonOrRender, say, sayJson, fail } from "./cli-output.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { failFollowJsonRival, parseGrepFlag, parseRoleListScope, parseStatusFlag, scanPositionArgs } from "./cli-args.js";
import { readPostReviews, type PostReview } from "../review/post-merge-review.js";
import { acceptPostReview, type AcceptPostReviewOutcome } from "../review/post-merge-review-accept.js";
import {
  POST_REVIEW_STATES,
  postReviewMatchesGrep,
  postReviewState,
  renderPostReviewDetail,
  renderPostReviews,
  scopePostReviews,
  type PostReviewState,
} from "../review/post-merge-review-render.js";
import { roleInScope } from "../roles/runner-ids.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";
import { splitCommaList } from "../text/text.js";
import { oneOfMessage } from "../text/suggest.js";

/** The missing-value wording of `reviews --status` (shared by the gate's statusFlagSpec and
 * parseStatusFlag's own fail, so the two cannot drift). */
const REVIEWS_STATUS_VALUE_ERROR = "reviews --status needs a value";

/** The missing-value wording of `reviews --grep` (shared by the gate's grepFlagSpec and
 * parseGrepFlag's own fail, so the two cannot drift). */
const REVIEWS_GREP_VALUE_ERROR = "reviews --grep needs text (usage: tumwater reviews --grep <text>)";

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
      fail(`reviews --status ${oneOfMessage(spellings)(piece)}`);
    if (!out.includes(piece as PostReviewState)) out.push(piece as PostReviewState);
  }
  return out;
}

/** `tumwater reviews [-f/--follow] [--json]`: the post-merge review queue, oldest first.
 * `-f/--follow` repaints the queue every couple of seconds until Ctrl+C or the process that
 * started it exits, so a backgrounded follow does not outlive its parent (the same rule
 * `queue -f` uses). */
export async function cmdReviews(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // `tumwater reviews --show <n>` and `--accept <n>` are the read-only command's edge modes:
  // route them to their own branches before the read gate, so neither leaks into the view
  // parsing. --show is checked first so an invocation that names both refuses --accept by
  // name (its unconsumed token) rather than letting the destructive branch run.
  if (args.includes("--show")) {
    await cmdReviewsShow(root, args);
    return;
  }
  if (args.includes("--accept")) {
    await cmdReviewsAccept(root, args);
    return;
  }
  rejectUnknownArgs("reviews", args, [ROLE_FLAG, statusFlagSpec(REVIEWS_STATUS_VALUE_ERROR), grepFlagSpec(REVIEWS_GREP_VALUE_ERROR), JSON_FLAG, FOLLOW_FLAG]);
  refuseTeamWorkspace(root);
  // --grep keeps only the entries whose role, role label, commit, summary, body, a rejection
  // reason or the last failure contains the text, case-insensitively. Every later scan goes
  // over `rest` — the args with the --grep value token removed — so a pattern spelled like a
  // flag (`--grep --status`) is searched as text and never read as a flag.
  const { rest, pattern } = parseGrepFlag(args, REVIEWS_GREP_VALUE_ERROR);
  const follow = hasFollowFlag(rest);
  if (follow && rest.includes("--json")) failFollowJsonRival("reviews --json");
  // `--role` keeps only the listed roles' entries (a base id taking its instances too) under
  // their whole-queue positions, so `--accept <n>` still addresses the position the unscoped
  // read prints. Absent a ready config `parseRoleListScope` falls back to the built-in catalog.
  const roles = parseRoleListScope(root, rest);
  const { raw: statusRaw } = parseStatusFlag(rest, REVIEWS_STATUS_VALUE_ERROR);
  // Validate the state list once, before the follow branch: a bad `--status` value must fail
  // like the one-shot read, not become a follow whose every frame throws and is skipped.
  const states = statusRaw === null ? null : parseReviewStatusList(statusRaw);
  // The scoped read shared by the follow and the one-shot branches, so the render's age and
  // the scope text share one clock read and each follow frame re-reads the queue file.
  const readScoped = (): { entries: PostReview[]; scope: { roles: readonly string[]; positions: readonly number[]; total: number; filter?: string } | undefined } => {
    const whole = readPostReviews(root);
    // The active clauses in the fixed order the header prints: --role, --status, --grep.
    const filterText = [
      roles ? `--role ${roles.join(",")}` : "",
      states === null ? "" : `--status ${states.join(",")}`,
      pattern === null ? "" : `--grep ${pattern}`,
    ]
      .filter(Boolean)
      .join(" ");
    const keep = (e: PostReview) =>
      (!roles || roleInScope(e.role, roles)) &&
      (states === null || states.includes(postReviewState(e))) &&
      (pattern === null || postReviewMatchesGrep(e, pattern));
    if (states === null && pattern === null) {
      // No status or grep clause: the pre-grep shape stays byte-identical — --role alone passes
      // no filter text (the renderer synthesizes `--role <ids>` itself), and an unscoped read
      // renders whole.
      if (!roles) return { entries: whole, scope: undefined };
      const scoped = scopePostReviews(whole, roles, keep);
      return { entries: scoped.entries, scope: scoped.scope };
    }
    // A status or grep clause is active: scope even a grep-only read (roles=[]) so the kept
    // entries keep their whole-queue numbers and the renderer's filtered header and no-match
    // line work unchanged, naming every active clause in the filter text.
    const scoped = scopePostReviews(whole, roles ?? [], keep, filterText);
    return { entries: scoped.entries, scope: scoped.scope };
  };
  if (follow) {
    // Each frame re-reads the queue file and reads the clock once, so an entry that appears,
    // ages toward the failure limit, or leaves when its repair merges shows in the next
    // repaint — the same per-frame read `queue -f` uses.
    await followView(() => {
      const { entries, scope } = readScoped();
      return renderPostReviews(entries, scope, Date.now());
    }, seams);
    return;
  }
  const { entries, scope } = readScoped();
  sayJsonOrRender(rest, { pending: entries }, () => renderPostReviews(entries, scope, Date.now()));
}

/** The `tumwater reviews --accept <n>` branch (PLANS.md): remove the Nth pending post-merge
 * review `tumwater reviews` lists, accepting the commit unreviewed at the operator's request.
 * Parsed the way `cmdQueueCancel` parses `--cancel`: `--accept <n>` the one valued flag,
 * `--json` the one boolean (at most once), `--help`/`-h` tolerated, anything else refused. An
 * out-of-range position fails naming the current depth; an entry whose repair already merged
 * (`fixed`) is refused. A rejected entry waits on nothing and is accepted like any pending one. */

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

  if (outcome.status === "settled") {
    fail(`post-merge review ${position} already merged its fix on main — nothing to accept`);
  }
  if (json) {
    sayJson({ accepted: { role: outcome.role, commit: outcome.commit, summary: outcome.summary } });
  } else {
    say(`accepted post-merge review entry ${position} unreviewed: ${roleLabel(outcome.role)} ${shortSha(outcome.commit)} — ${outcome.summary}`);
  }
}

/** The `tumwater reviews --show <n>` branch (PLANS.md): print the Nth pending post-merge
 * review `tumwater reviews` lists, in full — the summary the list squashes to 80 characters
 * and the rejection reasons it squashes to 60, the commit body the list never prints, and the
 * failed-run count with the last failure's whole text — so an operator can read why a landed
 * commit was turned back without opening `post-review.json`. Read-only and needing no ready
 * repo (the list's rationale): `readPostReviews` reads a missing, torn or hand-edited file as
 * the well-formed subset. Parsed the way `cmdReviewsAccept` parses `--accept`: `--show <n>`
 * the one valued flag, `--json` the one boolean (at most once), `--help`/`-h` tolerated,
 * anything else refused through `rejectUnknownArgs` so `--accept`, `-f/--follow`, `--role`
 * and `--status` are named by the refusal. An out-of-range position fails naming the current
 * depth; the entry object `--json` prints is the same normalized shape `reviews --json`
 * carries, so no field is squashed. */
async function cmdReviewsShow(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--show", "--show 2");
  if (position === null) fail("--show needs a position (usage: tumwater reviews --show <n>)");
  // The vocabulary a show invocation accepts is exactly --show and --json, both consumed
  // above; every other token (--accept, -f/--follow, --role, --status, an unknown flag) is
  // refused by name, the same way cmdReviewsAccept's rejectUnknownArgs refuses its rest.
  rejectUnknownArgs("reviews", rest, []);
  refuseTeamWorkspace(root);
  const entries = readPostReviews(root);
  if (position > entries.length) {
    fail(`no post-merge review at position ${position} (post-merge review queue holds ${entries.length})`);
  }
  const entry = entries[position - 1]!;
  if (json) {
    sayJson(entry);
  } else {
    say(renderPostReviewDetail(entry, position, Date.now()));
  }
}
