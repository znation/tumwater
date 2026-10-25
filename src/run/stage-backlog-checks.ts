/** The staging self-check's findings about backlog records (PLANS.md, BUGS.md, QUESTIONS.md and
 * the finished-entry archives), split from stage-check.ts, which gathers them with the git-level
 * path checks. Each takes the edited text (`head`) and its merge-base text (`base`), so only a
 * problem this change adds is reported. All are staging-only: the review gate does not run
 * them (see stage-check.ts for why each is left out of the gate). */

import { finishedTitle, readdedHeadings } from "../backlog/backlog-structure.js";
import {
  fenceAwareHeadingLines,
  headingTitle,
  parseEntryDetails,
  sectionBodyLines,
  type FinishedArchive,
} from "../backlog/backlog-md.js";
import { DONE_DATE_RE, FIXED_DATE_RE } from "../backlog/backlog.js";
import { refusalNote, waitingNote } from "../backlog/backlog-eligibility.js";
import { entryKey, partKey, planDependencyProblems, seriesPart, type PartRef } from "../backlog/backlog-parts.js";
import { WAITING_FOR_FAILURE_NOTE } from "../roles/role-guidance.js";
import { moreSuffix, plural } from "../text/phrases.js";
import { collapseWhitespace, truncate } from "../text/text.js";

/** The finding for the heading `requires` clause problems that `head` (the edited PLANS.md)
 * adds over `base` (its text at the merge-base), or undefined when it adds none; `archivedTitles`
 * (PLANS-DONE.md's headings) count as existing headings on both sides. Only new
 * problems count: one already on main is not this run's fault and stays doctor's to report, so
 * the author is never asked to fix another run's heading. The most serious new problem is named
 * — cycle, then dangling, unparsed, then misworded — with a count of the rest. */
export function planDependencyFinding(head: string, base: string, archivedTitles: readonly string[] = []): string | undefined {
  const problems = (text: string) =>
    planDependencyProblems(
      parseEntryDetails(text, "Planned"),
      [...parseEntryDetails(text, "Done").map((e) => e.title), ...archivedTitles],
    );
  const was = problems(base);
  const now = problems(head);
  const newCycle = now.cycle !== null && was.cycle === null ? now.cycle : null;
  const newDangling = now.dangling.filter((d) => !was.dangling.some((b) => b.title === d.title && b.ref === d.ref));
  const newUnparsed = now.unparsed.filter((t) => !was.unparsed.includes(t));
  const newMisworded = now.misworded.filter((m) => !was.misworded.some((b) => b.title === m.title && b.ref === m.ref));
  const total = (newCycle !== null ? 1 : 0) + newDangling.length + newUnparsed.length + newMisworded.length;
  if (total === 0) return undefined;
  let first: string;
  if (newCycle !== null) {
    first = `PLANS.md's requires clauses now form a cycle: ${newCycle.join(" → ")} — every part on it stays blocked forever; ` + // vocabulary-ok: PLANS.md heading syntax
      "edit one heading's `requires … landed` clause to break it"; // vocabulary-ok: PLANS.md heading syntax
  } else if (newDangling.length > 0) {
    const d = newDangling[0]!;
    first = `PLANS.md plan "${d.title}" requires ${d.ref}, which no PLANS.md heading carries — the claim allocator ` +
      "ignores the clause and hands the plan out now; fix the series name or part number to match the prerequisite's heading";
  } else if (newUnparsed.length > 0) {
    first = `PLANS.md plan "${newUnparsed[0]!}" has a \`requires … landed\` clause that names no part the claim allocator can read — ` + // vocabulary-ok: PLANS.md heading syntax
      "it holds nothing; write each ref as `<Series> i/n` or `part i/n` after a `<Series>, part i/n:` heading prefix";
  } else {
    const w = newMisworded[0]!;
    first = `PLANS.md plan "${w.title}" names ${w.ref} as a prerequisite without a \`requires … landed\` clause — ` + // vocabulary-ok: PLANS.md heading syntax
      "the claim allocator ignores that wording and hands the part out now; write it as `requires part i/n landed` — fix it before this change commits"; // vocabulary-ok: PLANS.md heading syntax
  }
  return `${first}${moreSuffix(total - 1)}`;
}

/** A finished heading's identity across done dates: the title without its completion stamp and
 * its `(planned …)`/`(found …)` parenthetical, whitespace-collapsed. */
export function finishedKey(title: string, dateRe: RegExp): string {
  return collapseWhitespace(finishedTitle(title, dateRe));
}

/** The findings for a finished entry that the change leaves in the archive too: a live
 * `## Done`/`## Fixed` entry the head archive already holds under another stamp (the sweep would
 * move it as a new entry, or leave it beside an edited copy), and an archive entry the change
 * added a second time under a new stamp. At most one finding per rule. An exact copy of an
 * archived entry (same heading and body) is skipped: the sweep drops it. A second copy under an
 * identical heading is skipped too: `backlogStructureReason` reports it. */
export function finishedDuplicateFindings(
  spec: FinishedArchive,
  live: { head: string; base: string },
  archive: { head: string; base: string },
): string[] {
  const dateRe = spec.file === "PLANS.md" ? DONE_DATE_RE : FIXED_DATE_RE;
  const keyed = (md: string) =>
    parseEntryDetails(md, spec.section).map((e) => ({ ...e, key: finishedKey(e.title, dateRe) }));
  const findings: string[] = [];
  const liveBase = new Set(keyed(live.base).map((e) => e.key));
  const archived = keyed(archive.head);
  const copy = keyed(live.head).find((e) => {
    if (liveBase.has(e.key)) return false;
    const held = archived.filter((a) => a.key === e.key);
    if (held.length === 0) return false;
    const heading = collapseWhitespace(e.title);
    return !held.some((a) => collapseWhitespace(a.title) === heading && a.body === e.body);
  });
  if (copy !== undefined) {
    findings.push(
      `${spec.file}'s "## ${spec.section}" entry "${truncate(copy.title, 160)}" is already archived in ${spec.archive} — ` +
        "the commit-time sweep would leave two copies; edit the archived entry in place (its text and its stamp) and delete this copy",
    );
  }
  if (readdedHeadings(archive.base, archive.head).length === 0) {
    const count = (entries: { key: string }[], key: string) => entries.filter((e) => e.key === key).length;
    const was = keyed(archive.base);
    const twice = archived.find((e) => count(archived, e.key) > 1 && count(archived, e.key) > count(was, e.key));
    if (twice !== undefined) {
      findings.push(
        `${spec.archive} holds "${truncate(twice.title, 160)}" ${count(archived, twice.key)} times — this change added a copy under a different heading or stamp; ` +
          "keep the archived entry once, edited in place, and delete the other copies",
      );
    }
  }
  return findings;
}

/** The number of `- **Progress …` lines in an entry body. */
function progressCount(body: string): number {
  return body.split("\n").filter((l) => /^-\s+\*\*Progress\b/.test(l.trim())).length;
}

/** The finding for a BUGS.md bug that `head` (the edited file) shows with more Progress notes
 * than `base` (its text at the merge-base) while it stays under `## Open` with neither a Waiting
 * note nor a Refused note — bugfix's step 2 asks a run that cannot reproduce a bug to write the
 * Waiting note, and runs that skip it leave the bug open to re-investigation. A newly filed bug
 * is not a re-investigation. Names the first such bug in file order, with a count of the rest. */
export function waitingNoteFinding(head: string, base: string): string | undefined {
  const was = new Map(parseEntryDetails(base, "Open").map((e) => [entryKey(e.title), e.body]));
  const counting = parseEntryDetails(head, "Open").filter((e) => {
    const before = was.get(entryKey(e.title));
    return (
      before !== undefined &&
      progressCount(e.body) > progressCount(before) &&
      waitingNote(e.body) === null &&
      refusalNote(e.body) === null
    );
  });
  if (counting.length === 0) return undefined;
  return (
    `BUGS.md bug "${counting[0]!.title}" gained a Progress note but stays open with no Waiting for the next ` +
    `failure note — if this run could not reproduce it, add ${WAITING_FOR_FAILURE_NOTE} as its own line under ` +
    `the heading so later runs wait for new evidence (bugfix's step 2); if it did reproduce, leave the entry ` +
    `as it is${moreSuffix(counting.length - 1)}`
  );
}

/** The skeleton placeholder that marks an empty backlog section. */
const PLACEHOLDER_LINE = "_None yet._";
/** The live backlog files; the archives have no placeholder sections. */
export const PLACEHOLDER_FILES = ["PLANS.md", "BUGS.md", "QUESTIONS.md"] as const;

/** Each `## ` section of `md` that holds the placeholder line outside a fence while also holding
 * entries, mapped to its entry count. */
function placeholderSections(md: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const title of fenceAwareHeadingLines(md, "## ").map((l) => headingTitle(l, "## "))) {
    if (!sectionBodyLines(md, title).some((l) => l.trim() === PLACEHOLDER_LINE)) continue;
    const count = parseEntryDetails(md, title).length;
    if (count > 0) found.set(title, count);
  }
  return found;
}

/** The finding for a section of `head` (the edited backlog file `file`) that holds entries and the
 * empty-section placeholder while `base` (its text at the merge-base) did not, so damage already
 * on main is not blamed on this change. Names the first such section in file order, with a count
 * of the rest. */
export function strayPlaceholderFinding(file: string, head: string, base: string): string | undefined {
  const was = placeholderSections(base);
  const stray = [...placeholderSections(head)].filter(([title]) => !was.has(title));
  if (stray.length === 0) return undefined;
  const [title, n] = stray[0]!;
  return (
    `${file}'s "## ${title}" section holds ${plural(n, "entry", "entries")}, but this change left the ` +
    `empty-section placeholder ${PLACEHOLDER_LINE} in it — delete that line: it marks a section with no ` +
    `entries${moreSuffix(stray.length - 1)}`
  );
}

/** The staging finding for a run that holds a claim but moved a different backlog entry
 * (plans/parallel-work-instances.md "Claims", part 4/7): the assigned entry is the instance's
 * one task, so moving another is the same class of mistake `backlogStructureReason` catches
 * and costs one fix-up turn before the change commits. undefined when nothing moved or the
 * claimed entry itself moved — a merged entry is the expected way to release a claim. */
export function assignedMovedFinding(
  claimKey: string,
  moved: readonly { key: string; title: string }[],
): string | undefined {
  if (moved.length === 0 || moved.some((m) => m.key === claimKey)) return undefined;
  return `this run is assigned one backlog entry but moved a different one: "${moved[0]!.title}"`;
}

/** The staging finding for an unassigned run that moved a backlog entry a sibling instance
 * holds — one the poll listed in the run's `<held-entries>` note (RunnerState.heldElsewhere).
 * The note is advice the model can ignore; this is the deterministic backstop at the same
 * point as assignedMovedFinding (BUGS.md 2026-10-12: 24 of 29 staged claims duplicated a
 * sibling's held entry, and each duplicate cost a gate check, a review, and a conflict
 * resolver run holding the merge slot). The fix-up turn is asked to drop the duplicate work.
 * A change that held nothing else then ends with no change to merge. undefined when no moved
 * entry is held. */
export function heldMovedFinding(
  heldKeys: ReadonlySet<string>,
  moved: readonly { key: string; title: string }[],
): string | undefined {
  const dup = moved.find((m) => heldKeys.has(m.key));
  if (dup === undefined) return undefined;
  return (
    `this run moved a backlog entry another instance of this role is working on: "${dup.title}" — it is that ` +
    `instance's task (see <held-entries>), so revert every edit made for it, including the ` +
    `entry's move, and leave nothing behind if that was the whole change`
  );
}

/** The reason clause of a Refused note — everything after its leading `Refused … by <role>:` —
 * or the whole note when it has no such prefix. This is what the refusal rule lets a run write
 * freely, and what the ungrounded-refusal finding judges. */
function refusalReason(note: string): string {
  const i = note.indexOf(": ");
  return i < 0 ? note : note.slice(i + 2);
}

/** True when `reason` grounds the refusal in this entry itself — it names no series part other
 * than the entry's own (`own`), and cites neither another entry's Refused or Needs note nor a
 * role's own notes. Any of those means the refusal rests on another entry's hold or on the
 * role's opinion, not on an objection to this entry, so it should skip the entry instead. A
 * reason that names a part outside its own series, or any part at all for an entry with no
 * part (`own === null`), is a different-series reference — the same class as naming 7/9 from a
 * 6/9 refusal. */
function groundedRefusalReason(reason: string, own: PartRef | null): boolean {
  if (/\brefus(?:al|ed|ing)?\s+of\b/i.test(reason)) return false; // cites another entry's refusal
  if (/\bNeeds-[A-Za-z]/.test(reason)) return false; // cites another entry's Needs note
  if (/\b(?:roles?['’]?s?|my|our|own)\s+notes?\b/i.test(reason)) return false; // rests on a role's own notes
  // A part ref: an optional leading series name before `part N/M`, comma- or space-separated
  // (own series when none is named, or when a space-separated word is not a title-cased series
  // name — bridge words like `until part 7/9` resolve to the entry's own series).
  const re = /(?:([A-Za-z][A-Za-z0-9 ._-]*?)([,\s]\s*))?part[s]?\s+([0-9]+[a-z]?)\/(\d+)\b/gi;
  let m;
  while ((m = re.exec(reason)) !== null) {
    const token = (m[3] ?? "").toLowerCase();
    if (own === null) return false;
    let series = own.series;
    if (m[1] !== undefined) {
      const word = m[1].trim();
      // An explicit comma names the series whatever its case; a space-separated word is a
      // series only when it is the entry's own (any case) or title-cased, so a bridge word
      // like `until` or `behind` still resolves to the entry's own series.
      const comma = (m[2] ?? "").includes(",");
      if (comma || word.toLowerCase() === own.series.toLowerCase() || /^[A-Z]/.test(word)) series = word;
    }
    if (partKey(series, token) !== partKey(own.series, own.part)) return false;
  }
  return true;
}

/** The finding for a Refused note the change adds to `file` (PLANS.md or BUGS.md) whose reason
 * grounds the refusal outside the entry — it quotes another entry's Refused or Needs note, the
 * role's own notes, or a different series part (the `b9664a461` case). `head` is the edited
 * text, `base` its text at the merge-base. A refusal already on main is not this change's and
 * is skipped; only a newly added (or edited) one is judged. Names the first offending entry in
 * file order, with a count of the rest. Stages after `waitingNoteFinding`, sharing its guard.
 * Undefined when the change adds no such refusal. */
export function ungroundedRefusalFinding(
  file: "PLANS.md" | "BUGS.md",
  head: string,
  base: string,
): string | undefined {
  const refusalByKey = (md: string): Map<string, { title: string; note: string; section: string }> => {
    const out = new Map<string, { title: string; note: string; section: string }>();
    for (const sectionLine of fenceAwareHeadingLines(md, "## ")) {
      const section = headingTitle(sectionLine, "## ");
      for (const e of parseEntryDetails(md, section)) {
        const note = refusalNote(e.body);
        if (note !== null) out.set(entryKey(e.title), { title: e.title, note, section });
      }
    }
    return out;
  };
  const was = refusalByKey(base);
  const newlyAdded = [...refusalByKey(head)].filter(
    ([key, e]) => was.get(key)?.note !== e.note && !groundedRefusalReason(refusalReason(e.note), seriesPart(e.title)),
  );
  if (newlyAdded.length === 0) return undefined;
  const first = newlyAdded[0]![1];
  return (
    `${file}'s "${first.section}" entry "${truncate(first.title, 160)}" carries a newly added Refused note ` +
    `whose reason cites another entry's Refused/Needs note, a role's own notes, or a different series part ` +
    `instead of an objection to this entry; implement this entry or pick another, but do not refuse it` +
    moreSuffix(newlyAdded.length - 1)
  );
}
