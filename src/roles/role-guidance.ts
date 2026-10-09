/** Shared instruction fragments role prompts and prompt assembly embed verbatim. Pure
 * data: this module imports nothing, so prompt assembly can depend on it without a cycle.
 * Split from roles.ts, whose catalog (now role-catalog.ts) find texts embed these fragments
 * while prompt.ts embeds them too — the wording is one concern, the catalog another. */

/** Shared guidance for any loop about to record a plan or bug: split independent parts
 * into their own entries. Defined once so the director and role prompts cannot drift.
 * Lives here (not in prompt.ts) because two role `find` texts embed it — keeping this
 * module import-free, with the dependency running one way: prompt assembly → roles,
 * and the catalog → here. */
export const DECOMPOSITION_GUIDANCE = `Before recording a plan or bug, check whether it decomposes
into independent subparts (separate features, or separate bugs). If it does, record each part as
its own PLANS.md/BUGS.md entry that cross-references its siblings, so loops can pick them up
independently; if the parts are not truly independent, keep a single entry.`;

/** Shared instruction for closing a backlog entry (the feature loop moving a plan to Done,
 * the bugfix loop moving a bug to Fixed). Written against the observed failure (PLANS.md
 * 2026-09-30, part 1/3): "move it to a Done section" reads as "create a section", and five
 * commits left PLANS.md with two `## Done` headings — so the wording names the file's EXISTING
 * resolved heading, forbids touching `## ` structure, and gives the verifiable invariant
 * (the same headings before and after). Lettered sub-steps, because the callers embed it as one
 * numbered step of their task. Takes the file and section names so the feature and bugfix texts
 * cannot drift apart; lives here with the other shared fragments. */
export function backlogMoveGuidance(file: string, openSection: string, resolvedSection: string): string {
  return `move the entry, step by step:
      a. cut the entry out of \`${openSection}\`;
      b. add the closing date to its \`### \` heading;
      c. paste it as the first entry under the file's existing \`${resolvedSection}\` heading;
      d. if it was the last entry under \`${openSection}\`, leave a \`_None yet._\` placeholder
         there.
      Never add, remove, or rename a \`## \` heading: \`grep -n '^## ' ${file}\` must list the
      same headings before and after the edit.`;
}

/** Shared sizing rule for anyone writing a plan (the plan role and the director): the feature
 * loop is one mid-sized local model working alone in one run, and the review gate rejects a
 * change that lands less than its entry promises — so a plan must fit that run. Oversized plans
 * were the pattern behind "half-done against its own plan" rejections. The last sentence is the
 * self-hosting build lag (BUGS.md 2026-09-23): plan 4b bundled "the merge preserves the live
 * tumwater.json" with the `git rm` that needed it, the running build predated the preservation,
 * and its own fast-forward deleted the config. */
export const PLAN_SIZING = `Size every plan to ONE implementation run by a mid-sized model working
alone: a handful of files, at most a few hundred lines of change including tests, and no design
question left open for the implementer. Anything larger is split into independently landable
sub-plans that cross-reference each other, each with its own acceptance criteria. Anchor plans on
file paths and symbol names — functions, types, constants, test names — never on line numbers or
ranges, because line anchors go stale with every landing. When the project is the harness running
the fleet, every commit lands under the build that predates it, so a
change to how landings behave and any step that depends on it are separate sub-plans, the second
landing only once the first is the running build.`;

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
   - unclear-invariant — had to reconstruct what the code was supposed to guarantee first
When nothing fits exactly, use the closest tag and say so in the sentence — never invent a
tag. \`none\` is written, never omitted, so a tally has an honest denominator.`;

/** The one query that tallies validation-gap tags across BUGS.md, counting both the verbatim
 * \`**Validation gap:**\` line bugfix writes and the steward's compressed \`gap: <tag>\` suffix.
 * Split from VALIDATION_GAP_GUIDANCE so only the steward — the one role that aggregates the
 * tags — carries it; a bugfix run writes one line and never needs the tally. */
export const VALIDATION_GAP_TALLY = `One query counts both the verbatim line and the compressed
\`gap: <tag>\` suffix: \`grep -oE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c\`.`;

/** The literal prefix every Needs-review note starts with. Exported so a reader that only has
 * to recognize one (the backlog index's ` [needs review]` mark) can match on it instead of
 * parsing the date or the wording out of the full template — the same split as
 * NEEDS_REPLAN_PREFIX. */
export const NEEDS_REVIEW_PREFIX = `**Needs review `;

/** The markdown note the feature loop appends to a plan it cannot finish in one run, so the plan
 * loop can split it. Mirrors the **Refused …** note convention: a note the next fresh tick reads,
 * with no code parsing it. Defined once so the feature and plan texts and the director's routing
 * clause cannot drift. */
export const NEEDS_REVIEW_NOTE = `${NEEDS_REVIEW_PREFIX}<YYYY-MM-DD> by feature: too large for one run**`;

/** The literal prefix every Needs-replan note starts with. Exported so a reader that only has to
 * recognize one (the backlog index's ` [needs replan]` mark) can match on it instead of parsing
 * the date or the round count out of the full template. */
export const NEEDS_REPLAN_PREFIX = `**Needs replan `;

/** The markdown note the feature loop appends under a plan whose change was rejected after its
 * final revision round, carrying the reviewer's objections back to the strong-tier plan loop
 * instead of letting feature re-author the same plan. Same convention as NEEDS_REVIEW_NOTE: a
 * note a later fresh tick reads, with no code parsing it. */
export const NEEDS_REPLAN_NOTE = `${NEEDS_REPLAN_PREFIX}<YYYY-MM-DD> by feature: rejected after <N> review rounds**`;

/** How a role with no backlog (organize, clean, dry, perf, security, robustness, improve) finds its
 * one task, as numbered steps. Written against the observed failure: with nothing to point at, a
 * local model reads the codebase file by file — thirty whole-file reads, ~300 KB of tool output
 * — and then either fills its window or declares nothing-to-do (improve: 41 of 44 ticks in the
 * first week of September landed nothing). Cheap signals shortlist candidates; a decision deadline
 * ends the search; the harness's own commit subjects (`tumwater(<role>): …`) are the only
 * cross-tick memory of what the role did lately, so the text names them. Takes the role id so the
 * git command is literal, not a placeholder the model has to fill in. */
export function searchGuidance(roleId: string): string {
  return `How to search — do not read the codebase file by file: a whole-tree survey costs most of
the run and rarely finds anything a targeted look would not.
   1. Start from cheap signals, as sibling tool calls in one turn — turns, not tool calls, are
      the expensive unit: \`git log --stat -15\` (recent churn is where problems accumulate),
      \`wc -l\` over the source files (size outliers), and \`grep -rn\` for the specific pattern
      you are after.
   2. Skip what your own role handled lately: \`git log --oneline -15 --grep="tumwater(${roleId})"\`
      lists it — the harness's commit subjects say what each loop did.
   3. Vary the slice you look at across runs (a different directory, module, or recency window)
      so successive ticks do not all converge on the same files.
   4. Shortlist at most five candidate files and inspect them with \`grep -n\` and ranged reads;
      open a file whole only when it is under ~300 lines.
   5. Decide within ~15 tool calls, in a handful of turns: if no candidate clearly clears the bar
      by then, there is nothing to do — searching longer rarely changes the answer. The bar is
      real value, not size: a small change that is clearly correct and useful clears it.`;
}
