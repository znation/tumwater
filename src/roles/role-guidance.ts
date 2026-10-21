/** Shared instruction fragments role prompts and prompt assembly embed verbatim. Pure
 * data: this module imports only the dependency-free legacy-role-ids, so prompt assembly
 * can depend on it without a cycle.
 * Split from roles.ts, whose catalog (now role-catalog.ts) find texts embed these fragments
 * while prompt.ts embeds them too — the wording is one concern, the catalog another. */
import { roleCommitGrep } from "./legacy-role-ids.js";

/** Shared guidance for any role about to record a plan or bug: split independent parts
 * into their own entries. Defined once so the director and role prompts cannot drift.
 * Lives here (not in prompt.ts) because two role `find` texts embed it — keeping this
 * module import-free, with the dependency running one way: prompt assembly → roles,
 * and the catalog → here. */
export const DECOMPOSITION_GUIDANCE = `Before recording a plan or bug, check whether it decomposes
into independent subparts (separate features, or separate bugs). If it does, record each part as
its own PLANS.md/BUGS.md entry that cross-references its siblings, so roles can pick them up
independently; if the parts are not truly independent, keep a single entry.`;

/** Shared instruction for closing a backlog entry (the feature role moving a plan to Done,
 * the bugfix role moving a bug to Fixed). Written against the observed failure (PLANS.md
 * 2026-09-30, part 1/3): "move it to a Done section" reads as "create a section", and five
 * commits left PLANS.md with two `## Done` headings — so the wording names the file's EXISTING
 * resolved heading, forbids touching `## ` structure, and gives the verifiable invariant
 * (the same headings before and after). Lettered sub-steps, because the callers embed it as one
 * numbered step of their task. The pasted entry does not stay there: tumwater moves it to the top
 * of `archive` when the change commits (plans/backlog-archive.md), which the last line says so no
 * run opens the archive to do it by hand. Takes the file, section and archive names so the feature
 * and bugfix texts cannot drift apart; lives here with the other shared fragments. Also takes
 * the closing token ("done" for a finished plan, "fixed" for a BUGS.md record) chosen by the
 * caller, so the verb and the heading-key rule are named instead of left for the role to guess. */
export function backlogMoveGuidance(file: string, openSection: string, resolvedSection: string, archive: string, token: string): string {
  return `move the entry, step by step:
      a. cut the entry out of \`${openSection}\`;
      b. add the closing stamp to its \`### \` heading, at the end — \`— ${token} YYYY-MM-DD by the <role> role\`
         (a finished plan appends it after its existing \`(planned …)\` parenthetical; the heading
         text before its first \` (\` must not change, or the gate reads it as a brand-new entry
         under \`${resolvedSection}\` rather than a move);
      c. paste it as the first entry under the file's existing \`${resolvedSection}\` heading;
      d. if it was the last entry under \`${openSection}\`, leave a \`_None yet._\` placeholder
         there.
      Never add, remove, or rename a \`## \` heading: \`grep -n '^## ' ${file}\` must list the
      same headings before and after the edit. When your change commits, tumwater moves the
      pasted entry to the top of ${archive}; do not open or edit ${archive} yourself.`;
}

/** The heading clause requiredParts parses, spelled as the parser reads it. Interpolated because
 * a comment inside the template would become prompt text. */
const REQUIRES_PART_FORM = "requires part N/M landed"; // vocabulary-ok: requiredParts parses this heading syntax

/** Shared sizing rule for anyone writing a plan (the plan role and the director): the feature
 * role is one mid-sized local model working alone in one run, and the review gate rejects a
 * change that lands less than its entry promises — so a plan must fit that run. Oversized plans
 * were the pattern behind "half-done against its own plan" rejections. The last sentence is the
 * self-hosting build lag (BUGS.md 2026-09-23): plan 4b bundled "the merge preserves the live
 * tumwater.json" with the `git rm` that needed it, the running build predated the preservation,
 * and its own fast-forward deleted the config. */
export const PLAN_SIZING = `Size every plan to ONE implementation run by a mid-sized model working
alone: a handful of files, at most a few hundred lines of change including tests, and no design
question left open for the implementer. Anything larger is split into independently mergeable
sub-plans that cross-reference each other, each with its own acceptance criteria. A sub-plan that
depends on a sibling spells that dependency as ${REQUIRES_PART_FORM}, in quotes, in its
heading's trailing parenthetical; it is the only form the claim allocator reads, so a dependency
worded any other way (such as blocked by part 1/2, after part 1/2, or follows part 1/2) does not
hold the part until its prerequisite leaves ## Planned. Anchor plans on
file paths and symbol names — functions, types, constants, test names — never on line numbers or
ranges, because line anchors go stale with every merge. When tumwater is building itself,
every commit merges under the build that predates it, so a
change to how merges behave and any step that depends on it are separate sub-plans, the second
merge only once the first is the running build.`;

/** Shared guidance for anyone writing a plan (the plan role, the organize role, and the
 * director): a new plan joins the BACK of the `## Planned` queue, never the top. Part of the
 * define-once pattern of DECOMPOSITION_GUIDANCE/PLAN_SIZING — file order under `## Planned` IS
 * the work queue: claim assignment takes the first free entry in file order (`assignNext`,
 * src/scheduling/claims.ts), so an entry set at the top jumps ahead of work already waiting.
 * Lives here because three role `find` texts and the director's routing bullet embed it. */
export const PLAN_QUEUE_GUIDANCE = `A new plan joins the queue at the BACK: append the entry at the
END of \`## Planned\`, after every existing entry, never at the top. File order under
\`## Planned\` is the work queue — claim assignment takes the first free entry in that order
(\`assignNext\`, src/scheduling/claims.ts) — so an entry inserted at the top jumps ahead of work
already waiting.`;

/** The closed vocabulary for the validation-gap trace (plans/repair-traces.md): what made a bug
 * hard to *confirm*, which is the only evidence of where this project's test infrastructure is
 * weakest. Closed on purpose so the traces aggregate, and `none` is a written value rather than an
 * omitted line so a tally's denominator stays honest. Defined once so the bugfix and steward find
 * texts embed the same list; one query counts both the verbatim line and the compressed suffix. */
export const VALIDATION_GAP_TAGS: readonly string[] = [
  "none",
  "no-repro",
  "no-fake",
  "real-run-needed",
  "no-observability",
  "slow-check",
  "unclear-invariant",
];

/** Shared rendering of the validation-gap trace, embedded verbatim by the bugfix and steward find
 * texts (the define-once pattern of DECOMPOSITION_GUIDANCE/PLAN_SIZING). It carries the write form
 * and the meaning of every tag, one tag per line; the tally query lives in VALIDATION_GAP_TALLY. */
export const VALIDATION_GAP_GUIDANCE = `The validation-gap trace: every Fixed entry records what
made the bug hard to CONFIRM — not to fix — as one line, \`**Validation gap:** <tag> — <one sentence>\`.
<tag> is exactly one of:
   - none — the existing suite reproduced and confirmed it; nothing was missing
   - no-repro — could not reproduce it deterministically
   - no-fake — needed a fake or shim that did not exist
   - real-run-needed — no offline path covered it; a real bounded run was required
   - no-observability — the failure left no trace
   - slow-check — the only verification was slow enough to shape the fix
   - unclear-invariant — had to reconstruct what the code was supposed to guarantee first; record the reconstructed invariant in docs/invariants.md in the same commit so a later bug in that area does not reconstruct it again
When nothing fits exactly, use the closest tag and say so in the sentence — never invent a
tag. \`none\` is written, never omitted, so a tally has an honest denominator.`;

/** The one query that tallies validation-gap tags across BUGS.md and BUGS-FIXED.md (where fixed
 * bugs are archived), counting both the verbatim \`**Validation gap:**\` line bugfix writes and
 * the \`gap: <tag>\` suffix of the one-line records the steward used to compress older entries to.
 * Split from VALIDATION_GAP_GUIDANCE so only the steward — the one role that aggregates the
 * tags — carries it; a bugfix run writes one line and never needs the tally. */
export const VALIDATION_GAP_TALLY = `One query counts both the verbatim line and the older compressed
\`gap: <tag>\` suffix across BUGS.md and its archive: \`grep -sohE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md BUGS-FIXED.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c\`.`;

/** The one query a *consumer* of the validation-gap traces — a role like coverage that picks its
 * next target from the record of what made past bugs hard to confirm — runs to pull the
 * recent, still-full-body entries. Split from VALIDATION_GAP_TALLY (the steward's aggregate
 * count) because this one lists the *entries*, newest-first: \`head\` not \`tail\`, since
 * \`## Fixed\` is newest-first, so the recent full-body entries sit at the top, for a role to
 * read each hit's free text. It reads BUGS.md's own section first, then BUGS-FIXED.md, where
 * fixed bugs are archived (plans/backlog-archive.md); \`-s\` keeps a missing archive quiet, and
 * each hit names its file and line. Built from the closed vocabulary (minus \`none\`, which
 * names nothing to build) so it cannot drift. */
export const VALIDATION_GAP_QUERY = `grep -snE '\\*\\*Validation gap:\\*\\* (${VALIDATION_GAP_TAGS.filter(
  (t) => t !== "none",
).join("|")})' BUGS.md BUGS-FIXED.md | head -20`;

/** The literal prefix every Needs-review note starts with. Exported so a reader that only has
 * to recognize one (the backlog index's ` [blocked: needs review]` mark) can match on it instead of
 * parsing the date or the wording out of the full template — the same split as
 * NEEDS_REPLAN_PREFIX. */
export const NEEDS_REVIEW_PREFIX = `**Needs review `;

/** The markdown note the feature role appends to a plan it cannot finish in one run, so the plan
 * role can split it. Mirrors the **Refused …** note convention: a note the next fresh run reads,
 * with no code parsing it. Defined once so the feature and plan texts and the director's routing
 * clause cannot drift. */
export const NEEDS_REVIEW_NOTE = `${NEEDS_REVIEW_PREFIX}<YYYY-MM-DD> by feature: too large for one run**`;

/** The literal prefix every Needs-replan note starts with. Exported so a reader that only has to
 * recognize one (the backlog index's ` [blocked: needs replan]` mark) can match on it instead of
 * parsing the date or the round count out of the full template. */
export const NEEDS_REPLAN_PREFIX = `**Needs replan `;

/** The markdown note the feature role appends under a plan whose change was rejected after its
 * final revision round, carrying the reviewer's objections back to the strong-tier plan role
 * instead of letting feature re-author the same plan. Same convention as NEEDS_REVIEW_NOTE: a
 * note a later fresh run reads, with no code parsing it. */
export const NEEDS_REPLAN_NOTE = `${NEEDS_REPLAN_PREFIX}<YYYY-MM-DD> by feature: rejected after <N> review rounds**`;

/** The literal prefix every Waiting-for-the-next-failure note starts with. Exported so a reader
 * that only has to recognize one (the backlog index's ` [blocked: waiting for the next failure]`
 * mark) can match on it instead of parsing the date or the wording out of the full template. */
export const WAITING_FOR_FAILURE_PREFIX = `**Waiting for the next failure `;

/** The markdown note the bugfix role writes under an open bug it cannot reproduce once it has made
 * the failure explain itself, so bugfix stops spending runs without new evidence. Same convention
 * as NEEDS_REPLAN_NOTE: a note a later fresh run reads. It lifts when whoever records the next
 * occurrence deletes the line, or by `tumwater bug --release <n>`. */
export const WAITING_FOR_FAILURE_NOTE = `${WAITING_FOR_FAILURE_PREFIX}<YYYY-MM-DD> by bugfix: <what the next failure's message will show>**`;

/** How a role with no backlog (organize, clean, dedupe, perf, security, robustness, improve) finds
 * its one task, as numbered steps. Written against the observed failure: with nothing to point
 * at, a local model reads the codebase file by file — thirty whole-file reads, ~300 KB of tool
 * output — and then either fills its window or declares nothing-to-do (improve: 41 of 44 runs in
 * the first week of September landed nothing). Cheap signals shortlist candidates; a decision
 * deadline ends the search; the harness's own commit subjects (`tumwater(<role>): …`) are the
 * only cross-run memory of what the role did lately, so the text names them. Takes the role id
 * so the git command is literal, not a placeholder the model has to fill in. */
export function searchGuidance(roleId: string): string {
  return `How to search — do not read the codebase file by file: a whole-tree survey costs most of
the run and rarely finds anything a targeted look would not.
   1. Start from cheap signals, as sibling tool calls in one turn — turns, not tool calls, are
      the expensive unit: \`git log --stat -15\` (recent churn is where problems accumulate),
      \`wc -l\` over the source files (size outliers), and \`grep -rn\` for the specific pattern
      you are after.
   2. Skip what your own role handled lately: \`git log --oneline -15 ${roleCommitGrep(roleId)}\`
      lists it — tumwater's commit subjects say what each role did.
   3. Vary the slice you look at across runs (a different directory, module, or recency window)
      so successive runs do not all converge on the same files.
   4. Shortlist at most five candidate files and inspect them with \`grep -n\` and ranged reads;
      open a file whole only when it is under ~300 lines.
   5. Decide within ~15 tool calls, in a handful of turns: if no candidate clearly clears the bar
      by then, there is nothing to do — searching longer rarely changes the answer. The bar is
      real value, not size: a small change that is clearly correct and useful clears it.`;
}
