/** The backlog team alerts, in emission order: open questions, refused entries, stalled
 * entries, a broken plan-dependency clause, stranded plans, duplicated backlog
 * headings, finished history still in the live backlog files, and Fixed records with a bad
 * Validation gap trace. One of the per-domain builders split out of src/ui/team-alerts.ts; the
 * shared types and wording helpers live in team-alert-shared.ts. */

import { entryListDetail, firstAndMore, openBacklogAction, type TeamAlert, type StaleQuestion, type PlanDependencyProblem, type BacklogHeadingDuplicate, type LiveFinishedEntry } from "./team-alert-shared.js";
import { entryKindLabel, type RefusedEntry, type StalledEntry } from "../backlog/backlog-eligibility.js";
import type { StrandedPlanEntry } from "../backlog/backlog-structure.js";
import type { FixClaimProblem, ValidationGapProblem } from "../doctor/doctor-backlog-plans.js";
import { missingSymbolNames } from "../verdict/fix-claim.js";
import { joinWithMore } from "../text/text.js";
import { plural } from "../text/phrases.js";
import { liveFinishedRowList } from "../backlog/backlog-archive.js";

interface BacklogAlertsInput {
  questions: readonly string[];
  staleQuestions: readonly StaleQuestion[];
  refused: readonly RefusedEntry[];
  stalledEntries: readonly StalledEntry[];
  planDependency: PlanDependencyProblem | null;
  strandedPlans: readonly StrandedPlanEntry[];
  duplicatedHeadings: readonly BacklogHeadingDuplicate[];
  liveFinished: readonly LiveFinishedEntry[];
  validationGaps: readonly ValidationGapProblem[];
  fixClaims: readonly FixClaimProblem[];
}

function pushQuestionsAlert(out: TeamAlert[], questions: readonly string[]): void {
  if (questions.length) {
    out.push({
      key: "questions",
      tone: "indigo",
      title: `${plural(questions.length, "question needs", "questions need")} your answer`,
      detail: entryListDetail(questions),
      actions: [{ label: "Answer", act: "questions" }],
    });
  }
}

// A stale question (doctor's STALE_QUESTION_DAYS rule, src/doctor/doctor-backlog-bugs.ts
// checkStaleQuestions) has waited a week without an answer — a role is stuck behind a decision,
// the exact class every other backlog row raises as an amber alert — so it asks (amber), naming
// the oldest question, its age, and the `tumwater questions
// answer` fix. Its callers pass it oldest-first (alert-feeds.ts staleOpenQuestions sorts
// most-days-waited first), so the first element is the most-stale question and is named with its
// position and days; the rest are folded through entryListDetail like the questions and refused
// alerts, so the wording and counts cannot drift. The `questions` action opens the Questions tab,
// so the alert carries no row address.
function pushStaleQuestionsAlert(out: TeamAlert[], staleQuestions: readonly StaleQuestion[]): void {
  if (staleQuestions.length) {
    const { first, more } = firstAndMore(staleQuestions, (q) => q.title);
    out.push({
      key: "stale-questions", // vocabulary-ok: the stale-questions amber alert's key
      tone: "amber",
      title: `${plural(staleQuestions.length, "open question waited", "open questions waited")} 7+ days for an answer`,
      detail:
        `#${first.position} "${first.title}" has waited ${first.days}d for an answer` +
        more +
        ` · answer it with \`tumwater questions answer ${first.position} "<decision>"\`, or close it in QUESTIONS.md`,
      actions: [{ label: "Answer", act: "questions" }],
    });
  }
}

// Refused entries hold until a human decides; amber because the operator has to act.
function pushRefusedAlert(out: TeamAlert[], refused: readonly RefusedEntry[]): void {
  if (refused.length) {
    const first = refused[0]!;
    out.push({
      key: "refused",
      tone: "amber",
      title: `${plural(refused.length, "refused entry waits", "refused entries wait")} on your decision`,
      detail: `Refused ${entryKindLabel(first.file).toLowerCase()}: ${entryListDetail(refused.map((r) => r.title))} · no role takes it until you release it (tumwater plan|bug --release <n>, or the entry's drawer) or cancel it`,
      actions: openBacklogAction(first),
    });
  }
}

// An entry parked by a Needs-review note (the doctor's `stalled entries` row)
// sits until the plan role splits or replans it — amber because the plan role is the only
// one that can clear it, naming the first such entry in file order, its file, its note kind,
// and the fix. Same `entryHold` classification as `stalledEntries` and
// `checkStalledEntries`, so the always-on alert and the doctor cannot disagree on which
// holds are role-resolvable.
function pushStalledEntriesAlert(out: TeamAlert[], stalledEntries: readonly StalledEntry[]): void {
  if (stalledEntries.length) {
    const first = stalledEntries[0]!;
    out.push({
      key: "stalled-entries",
      tone: "amber",
      title: `${plural(stalledEntries.length, "backlog entry is stalled", "backlog entries are stalled")} in review`,
      detail: `${entryKindLabel(first.file)} ${entryListDetail(stalledEntries.map((p) => p.title))} — a Needs review note parks it; the plan role splits or replans the entry, so one that keeps sitting here means the plan role is not running or keeps deferring`,
      actions: openBacklogAction(first),
    });
  }
}

// A broken plan-dependency clause (the doctor's `plan dependencies` rule,
// src/doctor/doctor-backlog-plans.ts planDependencyProblem, via alert-feeds.ts's
// planDependencyAlert) is invisible in the backlog listings — the claim allocator keeps
// acting on the misread clause — so it asks (amber), named by type
// and carrying the doctor's exact message. One alert at most (the problem set is the single
// most serious rule), and the fix is editing PLANS.md's heading, so there are no actions.
function pushPlanDependencyAlert(out: TeamAlert[], planDependency: PlanDependencyProblem | null): void {
  if (planDependency !== null) {
    const titles: Record<PlanDependencyProblem["kind"], string> = {
      cycle: "Plan dependency cycle blocks a whole series",
      dangling: "A plan requires a part no heading carries",
      unparsed: "A plan's requires clause names no readable part",
      misworded: "A plan's dependency wording holds nothing",
    };
    out.push({
      key: "plan-dependencies",
      tone: "amber",
      title: titles[planDependency.kind],
      detail: planDependency.message,
      // The fix is editing PLANS.md, and the message names the heading and ref.
      actions: [],
    });
  }
}

// A plan heading filed under the wrong ## section (the doctor's `plans stuck in Planned`
// rule, checkStrandedPlans, src/doctor/doctor-backlog-plans.ts, via the shared
// strandedPlanEntriesFor) sits invisible to every reader that scans the right section: a
// `(planned …)` heading under ## Done never enters a Planned reader, and a done-dated heading
// still under ## Planned invites a second implementation. The clean role repairs it only when
// it happens to run and the doctor warns only on request, so it asks (amber) the way the
// plan-dependency alert does, naming the first stranded heading, its file, its section, and
// the section it belongs under; the rest are folded through joinWithMore.
function pushStrandedPlansAlert(out: TeamAlert[], strandedPlans: readonly StrandedPlanEntry[]): void {
  if (strandedPlans.length) {
    const { first, more } = firstAndMore(
      strandedPlans,
      (e) => `"${e.title}" in ${e.file ?? "PLANS.md"} ## ${e.section}`,
      (labels) => joinWithMore(labels, 3),
    );
    out.push({
      key: "stranded-plans",
      tone: "amber",
      title: `${strandedPlans.length === 1 ? "A plan sits" : "Plans sit"} under the wrong backlog section`,
      detail:
        `${first.file ?? "PLANS.md"} has a plan stranded under ## ${first.section}: "${first.title}"${more} — move it under ## ${first.section === "Done" ? "Planned" : "Done"}${first.file === undefined || first.file === "PLANS.md" ? "" : " in PLANS.md"} (the clean role repairs these)`,
      // The fix is editing a backlog file, and a PLANS-DONE.md entry has no PLANS.md drawer index.
      actions: [],
    });
  }
}

// A duplicated `## ` section heading already on main (the doctor's `backlog headings` row,
// checkBacklogHeadings, src/doctor/doctor-backlog-plans.ts, via the shared
// duplicatedBacklogHeadings) sits until a deliberate removal edit — the merge gate blocks
// only a merge that ADDS another copy, so a duplicate already on main persists and hides
// every later entry under its name from the `## ` section readers. It asks (amber) the way
// the stranded-plan alert does, naming the first file-heading pair and folding the rest
// through joinWithMore; the fix is editing a backlog file, so there are no actions.
function pushBacklogHeadingsAlert(out: TeamAlert[], duplicatedHeadings: readonly BacklogHeadingDuplicate[]): void {
  if (duplicatedHeadings.length) {
    const { first, more } = firstAndMore(
      duplicatedHeadings,
      (d) => `"## ${d.heading}" in ${d.file}`,
      (labels) => joinWithMore(labels, 3),
    );
    out.push({
      key: "backlog-headings",
      tone: "amber",
      title: plural(duplicatedHeadings.length, "duplicated backlog heading", "duplicated backlog headings"),
      detail:
        `${first.file} "## ${first.heading}" appears more than once${more} — readers take the first section of a name, so later entries are invisible; remove the duplicate in a deliberate edit`,
      actions: [],
    });
  }
}

// Finished history still in the live backlog files (the doctor's `backlog archive` rule,
// checkLiveFinished, src/doctor/doctor-backlog-plans.ts, via the shared liveFinishedEntriesFor)
// is a backlog-hygiene rule the doctor warned but no always-on alert surfaced — stranded
// plans, duplicated headings, validation gaps, plan dependencies and questions each have one,
// so an operator watching `tumwater status` or the dashboard never sees the growing finished
// sections until they run `tumwater doctor`. It asks (amber) the way
// the duplicated-heading alert does, naming each live file, its finished section, its entry
// count, and its size in KB; the fix is the `tumwater archive` command, so there are no actions.
function pushBacklogArchiveAlert(out: TeamAlert[], liveFinished: readonly LiveFinishedEntry[]): void {
  if (liveFinished.length) {
    out.push({
      key: "backlog-archive",
      tone: "amber",
      title: `${plural(liveFinished.length, "live backlog file still holds", "live backlog files still hold")} finished history`,
      detail:
        liveFinishedRowList(liveFinished) +
        " — every run that reads the file pays for them; `tumwater archive` moves them to the archive files",
      // The fix is a command, not a drawer row.
      actions: [],
    });
  }
}

// A Fixed record with a bad Validation gap trace (the doctor's `validation gaps` check,
// src/doctor/doctor-backlog-plans.ts checkValidationGaps) is the always-on twin of that
// doctor row: a newest Fixed record that omits its **Validation gap:** line, names a tag
// outside the closed vocabulary, or declares `unclear-invariant` without pinning a
// docs/invariants.md section is invisible or misleading to every closed-vocabulary consumer,
// so it asks (amber) the way the stranded-plan alert does, naming the first offending record
// and the fix. It is fed from the same scan (validationGapProblems over validationGapRecords)
// the doctor's check uses, so the alert and the doctor cannot drift on the problem set, and
// that scan runs no sourceHaystack walk, so it adds only the same two backlog-file reads the
// doctor's check already makes to the poll path. The fix is editing BUGS.md, so it has no
// buttons.
function pushValidationGapsAlert(out: TeamAlert[], validationGaps: readonly ValidationGapProblem[]): void {
  if (validationGaps.length) {
    const { first, more } = firstAndMore(
      validationGaps,
      (v) => `"${v.title}"`,
      (labels) => joinWithMore(labels, 3),
    );
    const reason =
      first.kind === "missing"
        ? "has no **Validation gap:** line"
        : first.kind === "unrecognized"
          ? `names unrecognized Validation gap tag "${first.tag}"`
          : "is an unclear-invariant fix but names no docs/invariants.md section";
    out.push({
      key: "validation-gaps",
      tone: "amber",
      title: plural(validationGaps.length, "Fixed record has a validation-gap problem", "Fixed records have validation-gap problems"),
      detail:
        `BUGS.md "${first.title}" ${reason}${more} — every Fixed entry writes exactly one known **Validation gap:** tag (write \`none\` rather than omitting it), and an unclear-invariant fix pins its reconstructed guarantee in docs/invariants.md`,
      // The fix is editing BUGS.md.
      actions: [],
    });
  }
}

// A newest Fixed record whose Fix paragraph names only code absent from the tree (the
// doctor's `claimed bugs` check, src/doctor/doctor-backlog-plans.ts checkFixClaims) is the
// always-on twin of that doctor row: a fix claim that names no live symbol is invisible to
// every consumer that reads BUGS.md (BUGS-FIXED.md's long fight over an already-fixed entry),
// so it asks (amber) the way the validation-gaps alert does, naming the first record and the
// missing symbols. It is fed from the same scan (fixClaimProblems over fixClaimRecords) the
// doctor's check uses, so the alert and the doctor cannot drift on the problem set, and that
// scan reads the tree only when a file changed (cachedSourceHaystack), so it adds no re-read
// to the 1 Hz poll path. The fix is editing BUGS.md, so it has no buttons.
function pushFalseFixesAlert(out: TeamAlert[], fixClaims: readonly FixClaimProblem[]): void {
  if (fixClaims.length) {
    const { first, more } = firstAndMore(
      fixClaims,
      (p) => `"${p.heading}"`,
      (labels) => joinWithMore(labels, 3),
    );
    out.push({
      key: "false-fixes",
      tone: "amber",
      title: plural(fixClaims.length, "Fixed record names code that is not on this tree", "Fixed records name code that is not on this tree"),
      detail:
        `BUGS.md records "${first.heading}" as Fixed, but none of the symbols its Fix paragraph names exist on this tree: ${missingSymbolNames(first.missing)}${more} — land the fix or keep the bug Open / refresh a stale record`,
      // The fix is editing BUGS.md.
      actions: [],
    });
  }
}

/** The backlog alerts, in emission order: open questions, refused entries, stalled
 * entries, a broken plan-dependency clause, stranded plans, duplicated backlog
 * headings, finished history still in the live backlog files, and Fixed records with a
 * bad Validation gap trace. Extracted from
 * teamAlerts (part 2/5 of the teamAlerts split) so the shared module stays small; the input
 * names exactly the fields this run reads. The caller pushes the returned alerts at the
 * position this run used to occupy, so the emitted key order is unchanged. Each alert arm is a
 * module-private builder named for its alert, in this same emission order, so a backlog alert
 * is found by name. */
export function buildBacklogAlerts(input: BacklogAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const {
    questions,
    staleQuestions,
    refused,
    stalledEntries,
    planDependency,
    strandedPlans,
    duplicatedHeadings,
    liveFinished,
    validationGaps,
    fixClaims,
  } = input;
  pushQuestionsAlert(out, questions);
  pushStaleQuestionsAlert(out, staleQuestions);
  pushRefusedAlert(out, refused);
  pushStalledEntriesAlert(out, stalledEntries);
  pushPlanDependencyAlert(out, planDependency);
  pushStrandedPlansAlert(out, strandedPlans);
  pushBacklogHeadingsAlert(out, duplicatedHeadings);
  pushBacklogArchiveAlert(out, liveFinished);
  pushValidationGapsAlert(out, validationGaps);
  pushFalseFixesAlert(out, fixClaims);
  return out;
}
