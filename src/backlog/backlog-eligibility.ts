/** Backlog eligibility: which PLANS.md / BUGS.md entries a work role may take now (plans,
 * parallel-work-instances, part 2/7). An entry is held when its body carries a **Refused …**
 * or **Needs review …** note, or when
 * its heading's trailing parenthetical
 * (or a parenthetical left open by a wrapped heading) names a prerequisite (`requires parts
 * 1/5–3/5 landed`) that is itself still listed under `## Planned`. The parsers are pure over
 * markdown text; `eligibleEntries` is the stat-backed reader for a caller that wants the list.
 * The backlog index marks every held entry so a role
 * skips it without re-deriving the rule. */

import path from "node:path";
import { statOrNull } from "../files/files.js";
import { allLiveClaims } from "../runner/runner-state-load.js";
import { firstTrimmedLineStartingWith } from "../text/text.js";
import { NEEDS_REVIEW_PREFIX } from "../roles/role-guidance.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { roleLabel } from "../roles/role-labels.js";
import type { BacklogEntry } from "./backlog-md.js";
import { actionableEntryRangesFor } from "./backlog-index-data.js";
import { entryKey, partKey, plannedPartKeys, plansWaitingOn, requiredParts, seriesPart } from "./backlog-parts.js";
import { finishedFiles, openBugEntries, plannedPlanEntries } from "./backlog.js";

/** Why an entry is held, or null when it is eligible. `blockedBy` names the unmerged
 * prerequisites in the form `Series i/n` so a renderer can show `requires …`. */
export type EntryHold = "refused" | "needs-review" | { blockedBy: string[] } | null;

/** One entry the reader may take: `key` is the stamp-free identity a claim can match on
 * (entryKey), `title` the verbatim heading, and `start`/`end` the 1-based line range the role
 * reads by, exactly as the `<backlog-index>` block shows it. */
export interface EligibleEntry {
  key: string;
  title: string;
  start: number;
  end: number;
  /** The file the range is in, when it is not the entry's own backlog file — a merged
   * prerequisite's Done entry, read from PLANS.md or PLANS-DONE.md (mergedPrerequisiteRanges). */
  file?: string;
}

/** The `**Refused …` note prefix a refusing run writes. Every hold note — this one and the
 * imported Needs-review prefix — is matched as a line prefix (hasNoteLine)
 * so a mention in prose never holds an entry. */
const REFUSED_PREFIX = "**Refused ";

/** The legacy marker the old increment rule left beside a Needs-review note's prior held count
 * (`**Previously held N−1**` beside the live `(held N)`), dropped by withoutNeedsReviewNotes so
 * a release leaves no orphan. No writer emits it anymore; only survives on live notes. */
const PRIOR_HELD_PREFIX = "**Previously held ";

/** True when `body` carries a line (ignoring leading indentation) that begins with `prefix`.
 * The one home of the hold-note rule: a note holds its entry only when written as its own
 * line, never when its prefix is quoted inside prose. */
function hasNoteLine(body: string, prefix: string): boolean {
  return body.split("\n").some((line) => line.trimStart().startsWith(prefix));
}

/** The text of `body`'s note for `prefix`: the first line (ignoring leading indentation) that
 * begins with it, trimmed, with the leading `**` and the first closing `**` removed. Null when
 * no line matches — the same line-prefix rule entryHold uses. */
function noteText(body: string, prefix: string): string | null {
  const line = firstTrimmedLineStartingWith(body, prefix);
  return line === undefined ? null : line.replace(/^\*\*/, "").replace("**", "");
}

/** The text of `body`'s Refused note, or null when it has none (entryHold's "refused" hold). */
export function refusalNote(body: string): string | null {
  return noteText(body, REFUSED_PREFIX);
}

/** The text of `body`'s Needs-review note, or null when it has none (entryHold's
 * "needs-review" hold). A needs-review note parks the entry (an unreproducible bug, a plan
 * judged too large, a rejected plan), so the stale-bug checks skip it like a refused one. */
export function needsReviewNote(body: string): string | null {
  return noteText(body, NEEDS_REVIEW_PREFIX);
}

/** `lines` without any line starting with `prefix` (the same line-prefix rule hasNoteLine
 * applies). When a dropped note sat between two blank lines, the blank line after it goes too,
 * so releasing leaves one blank line where the note was. Every other line is kept. */
function withoutNoteLines(lines: string[], prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trimStart().startsWith(prefix)) {
      out.push(line);
      continue;
    }
    if ((lines[i - 1] ?? "x").trim() === "" && (lines[i + 1] ?? "x").trim() === "") i++;
  }
  return out;
}

/** `lines` without any Refused note line. Every other line, Needs-review notes included, is
 * kept, so refusal lifting never lifts another hold. */
export function withoutRefusalNotes(lines: string[]): string[] {
  return withoutNoteLines(lines, REFUSED_PREFIX);
}

/** `lines` without its Needs-review note lines, the release's lift when the entry has no
 * Refused note: a `--release` that finds no Refused note drops every Needs-review note line so
 * the entry becomes eligible. A Needs-review note that still carries the legacy `(held N)` tag
 * also drops its `**Previously held N−1**` marker (the old increment rule's prior count), so the
 * lift leaves no surviving marker orphaned behind it. Every other line, Refused notes included,
 * is kept, so the Needs-review lift never lifts a refusal. */
export function withoutNeedsReviewNotes(lines: string[]): string[] {
  // The count the old increment rule recorded for a note's prior hold, keyed from the `(held N)`
  // tags still surviving on live Needs-review notes; the marker at N−1 goes only with its note.
  const priorHeld = new Set<number>();
  lines.forEach((raw) => {
    const tag = /\(held\s+(\d+)\)/.exec(raw.trimStart());
    if (tag !== null) priorHeld.add(Number(tag[1]) - 1);
  });
  if (priorHeld.size === 0) return withoutNoteLines(lines, NEEDS_REVIEW_PREFIX);
  const drop = new Set<number>();
  lines.forEach((raw, i) => {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith(NEEDS_REVIEW_PREFIX)) drop.add(i);
    else if (trimmed.startsWith(PRIOR_HELD_PREFIX)) {
      const n = /\d+/.exec(trimmed.slice(PRIOR_HELD_PREFIX.length));
      if (n !== null && priorHeld.has(Number(n[0]))) drop.add(i);
    }
  });
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!drop.has(i)) {
      out.push(lines[i] as string);
      continue;
    }
    let j = i;
    while (j < lines.length && drop.has(j)) j++;
    // A dropped run between two blank lines drops the blank after it too, so the lift leaves
    // one blank line where the note was (the same rule withoutNoteLines applies to one note).
    if (j < lines.length && (lines[i - 1] ?? "x").trim() === "" && (lines[j] ?? "x").trim() === "") j++;
    i = j - 1;
  }
  return out;
}

/** The Done entries of the parts `title` requires, in the order its requires clause names them:
 * for each requiredParts ref, the first `## Done` entry whose seriesPart has the same partKey,
 * searching PLANS.md's live section and then PLANS-DONE.md (plans/backlog-archive.md), each
 * carrying the file it was found in. Done is newest-first, so the first match is the most recent
 * merge. A ref with no Done match (still planned, or renamed) adds nothing, so a title with no
 * requires clause, or missing files, gives []. Lets the assignment prompt point at the exact
 * range to read instead of leaving the implementer to search a history that runs to thousands of
 * lines. */
export function mergedPrerequisiteRanges(root: string, title: string): EligibleEntry[] {
  const refs = requiredParts(title);
  if (refs.length === 0) return [];
  const done = finishedFiles("PLANS.md").flatMap((file) =>
    actionableEntryRangesFor(root, file, "Done").map((e) => ({ ...e, file })),
  );
  const out: EligibleEntry[] = [];
  for (const ref of refs) {
    const want = partKey(ref.series, ref.part);
    const hit = done.find((e) => {
      const part = seriesPart(e.title);
      return part !== null && partKey(part.series, part.part) === want;
    });
    if (hit !== undefined) {
      out.push({ key: entryKey(hit.title), title: hit.title, start: hit.start, end: hit.end, file: hit.file });
    }
  }
  return out;
}

/** The still-planned parts that wait on the planned entry titled `title`, with their line ranges,
 * in file order: plansWaitingOn's indexes (transitive, so a part waiting through a chain is
 * listed) paired by index with the Planned ranges, as eligibleEntries pairs them. [] when no
 * planned entry has that title, the entry has no series part, or PLANS.md is missing. Lets the
 * assignment prompt name the work a series part must leave to the parts after it. */
export function waitingPartRanges(root: string, title: string): EligibleEntry[] {
  const planned = plannedPlanEntries(root);
  const ranges = actionableEntryRangesFor(root, "PLANS.md", "Planned");
  const want = entryKey(title);
  const index = planned.findIndex((e) => entryKey(e.title) === want);
  if (index < 0 || seriesPart(planned[index]!.title) === null) return [];
  const out: EligibleEntry[] = [];
  for (const i of plansWaitingOn(planned, index)) {
    const range = ranges[i];
    if (range === undefined) continue;
    out.push({ key: entryKey(planned[i]!.title), title: planned[i]!.title, start: range.start, end: range.end });
  }
  return out;
}

/** Why `entry` is held against the still-`planned` entries, or null when it may be taken: a
 * `**Refused …` line (refused), a Needs-review line (needs-review), or a prerequisite
 * `(series, part)` still among `planned` ({ blockedBy }). Series compare case-insensitively;
 * part tokens compare verbatim.
 * Bodies mentioning "requires" are never consulted — only the heading's trailing or
 * still-open parenthetical. */
export function entryHold(entry: BacklogEntry, planned: readonly BacklogEntry[]): EntryHold {
  return entryHoldAgainst(entry, plannedPartKeys(planned));
}

/** `entryHold` against a prerequisite set already built by `plannedPartKeys`: the batch form, so
 * a caller judging many entries parses the planned titles once for the whole batch instead of
 * once per entry. */
export function entryHoldAgainst(
  entry: BacklogEntry,
  plannedParts: ReadonlySet<string>,
): EntryHold {
  if (hasNoteLine(entry.body, REFUSED_PREFIX)) return "refused";
  // A Needs-review note — the feature role's too-large note or the convergence hold's — parks the
  // entry for the plan role to split or replan, at any count: nothing escalates to the operator.
  if (hasNoteLine(entry.body, NEEDS_REVIEW_PREFIX)) return "needs-review";
  const refs = requiredParts(entry.title);
  if (refs.length === 0) return null;
  const blocked = refs.filter((ref) => plannedParts.has(partKey(ref.series, ref.part)));
  return blocked.length === 0
    ? null
    : { blockedBy: blocked.map((ref) => `${ref.series} ${ref.part}/${ref.of}`) };
}

/** The index mark for an entry's eligibility hold (entryHold): empty when eligible, a
 * bracketed tag for the note holds, and the named prerequisites for a blocked plan so the
 * reader sees why. Shared by the prompt's backlog index and `tumwater backlog`, so both
 * surfaces word a hold identically. */
export function holdMark(hold: EntryHold): string {
  if (hold === null) return "";
  if (hold === "refused") return " [blocked: refused]";
  if (hold === "needs-review") return " [blocked: needs review]";
  return ` [blocked: requires ${hold.blockedBy.join(", ")}]`;
}

/** The line `plan|bug --release` and `--top` print when the entry they touched is still held:
 * empty for no hold, else the hold in holdMark wording and that no role takes the entry until it
 * clears. */
export function stillHeldNote(hold: EntryHold): string {
  if (hold === null) return "";
  return `still held ${holdMark(hold).trim()}: no role takes it until that clears`;
}

/** Why each entry the operator's `tumwater backlog` surfaces list is held, as two arrays
 * parallel to backlogPayload's `plans` and `bugs`: the same entryHold decision the prompt's
 * backlog index carries, so a hold is observable rather than inferred. The planned entries
 * are read once and reused as the prerequisite set. Questions carry no holds. */
/** The holds' shape, derived from two files so it needs a stat key spanning both. */
interface BacklogHolds { plans: EntryHold[]; bugs: EntryHold[] }

/** `/api/status` polls the holds on the 1-second dashboard poll and the TUI recomputes them each
 * frame while PLANS.md/BUGS.md change only when a role merges an edit. The file reads beneath are
 * already stat-cached (plannedPlanEntries/openBugEntries), but the per-entry eligibility walk
 * (entryHoldAgainst's body scan + heading clause) is pure CPU re-derived on every call, growing
 * with the append-only backlog. Cache the derived holds keyed on both files' stat identities — the
 * same dev/ino/mtimeMs/size freshness check stat-cache.ts applies — so an unchanged backlog costs
 * two stat syscalls per poll instead of the walk. Bounded (like sectionCache) so many short-lived
 * roots in tests cannot grow it unbounded. */
const HOLDS_CACHE_MAX = 64;
const holdsCache = new Map<string, BacklogHolds>();

function holdsStatKey(root: string): string {
  const statId = (file: string): string => {
    const st = statOrNull(file);
    return st === null ? "-" : `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`;
  };
  return `${statId(path.join(root, "PLANS.md"))}\u0000${statId(path.join(root, "BUGS.md"))}`;
}

const cloneHold = (hold: EntryHold): EntryHold =>
  hold !== null && typeof hold === "object" ? { blockedBy: [...hold.blockedBy] } : hold;

/** A copy of the holds so each caller owns its data, matching stat-cache's contract (mutating
 * one result must not poison later polls). */
function cloneHolds(holds: BacklogHolds): BacklogHolds {
  return { plans: holds.plans.map(cloneHold), bugs: holds.bugs.map(cloneHold) };
}

/** The two reader calls computeBacklogHolds derives from, grouped in one object — the one
 * deliberate mock seam in this module. Both readers are themselves stat-cached, so a repeat
 * poll's only cost is this per-entry walk; exposing them on an object lets a test count whether
 * a poll re-runs the walk at all, which is the holds cache's observable win (a hit serves the
 * cached derives without calling these). */
export const holdsBacklogReaders = {
  plannedPlanEntries,
  openBugEntries,
};

/** The uncached derivation, shared by backlogHolds' miss path. */
function computeBacklogHolds(root: string): BacklogHolds {
  const planned = holdsBacklogReaders.plannedPlanEntries(root);
  const parts = plannedPartKeys(planned);
  return {
    plans: planned.map((entry) => entryHoldAgainst(entry, parts)),
    bugs: holdsBacklogReaders.openBugEntries(root).map((entry) => entryHoldAgainst(entry, parts)),
  };
}

export function backlogHolds(root: string): BacklogHolds {
  const key = holdsStatKey(root);
  const hit = holdsCache.get(key);
  if (hit !== undefined) return cloneHolds(hit);
  const value = computeBacklogHolds(root);
  if (holdsCache.size >= HOLDS_CACHE_MAX) holdsCache.clear();
  holdsCache.set(key, value);
  return cloneHolds(value);
}

/** The mark for each planned plan and open bug, two arrays parallel to the entries the
 * observer surfaces list (backlogPayload's `plans`/`bugs`, the TUI's list and entry modes):
 * the eligibility hold (holdMark) then the working-on-it mark (inProgressMark), the order
 * `tumwater backlog` prints. A surface derives its marks from the one hold decision and the
 * one claim lookup rather than re-walking the entries. An eligible entry nobody is working on
 * renders as the empty string, so a client can append the mark without a separate check.
 * Questions carry no holds. backlogHolds alone still drives the allocator. */
export function backlogMarks(root: string): { plans: string[]; bugs: string[] } {
  const holds = backlogHolds(root);
  const working = backlogInProgress(root);
  const mark = (hold: EntryHold, runner: string | null | undefined): string =>
    holdMark(hold) + inProgressMark(runner ?? null);
  return {
    plans: holds.plans.map((h, i) => mark(h, working.plans[i])),
    bugs: holds.bugs.map((h, i) => mark(h, working.bugs[i])),
  };
}

/** A refused entry the operator must release or cancel, with its backlog file and 0-based
 * position so a surface can open exactly that row (the `refused` team alert's target). */
export interface RefusedEntry {
  file: "plans" | "bugs";
  index: number;
  title: string;
}

/** A planned plan or open bug held by a Needs-review note, plus the 0-based
 * index within its backlog file and hold that let a surface land on its row
 * (`plans:<index>`/`bugs:<index>`). */
export interface StalledEntry {
  file: "plans" | "bugs";
  index: number;
  title: string;
  hold: "needs-review";
}

/** The display noun for a backlog-file discriminator — the `"plans" | "bugs"` `file` on
 * RefusedEntry and StalledEntry (and the same discriminator the prompt's named-hold wording
 * and the doctor's Stalled row take): BUGS.md is a "Bug" and PLANS.md a "Plan", and the
 * lowercase form is the `Refused plan|bug:` label and the `tumwater plan|bug --release`
 * command noun. */
export function entryKindLabel(file: "plans" | "bugs"): "Bug" | "Plan" {
  return file === "bugs" ? "Bug" : "Plan";
}

/** The planned plans and open bugs whose hold is exactly `"needs-review"`, in file order: the
 * entries parked by a Needs-review note until the plan role splits or replans them (the
 * `stalled-entries` team alert's input), each carrying its backlog file, 0-based index and the
 * hold. Same `backlogHolds(root)` + the planned/`openBugEntries` readers `refusedEntries`
 * uses, so the alert and the doctor's `stalled entries` row classify through the same
 * `entryHold` and cannot disagree on which holds are role-resolvable. A missing
 * file yields `[]`. */
export function stalledEntries(root: string): StalledEntry[] {
  const holds = backlogHolds(root);
  const out: StalledEntry[] = [];
  const entriesOf = (entries: readonly BacklogEntry[], held: readonly (EntryHold | null)[], file: "plans" | "bugs"): void => {
    entries.forEach((e, i) => {
      const hold = held[i];
      if (hold === "needs-review") out.push({ file, index: i, title: e.title, hold });
    });
  };
  entriesOf(plannedPlanEntries(root), holds.plans, "plans");
  entriesOf(openBugEntries(root), holds.bugs, "bugs");
  return out;
}

/** The planned plans, then the open bugs, whose hold is `"refused"`, in file order: the
 * entries that wait on an operator decision (the `refused` team alert's input), each carrying
 * the backlog file and its 0-based position so a surface opening the row can land on it.
 * Pairs backlogHolds' arrays with the entries the same readers return, like
 * backlogInProgress. A missing file yields `[]`. */
export function refusedEntries(root: string): RefusedEntry[] {
  const holds = backlogHolds(root);
  const entriesOf = (entries: readonly BacklogEntry[], held: readonly (EntryHold | null)[], file: "plans" | "bugs"): RefusedEntry[] => {
    const out: RefusedEntry[] = [];
    entries.forEach((e, i) => {
      if (held[i] === "refused") out.push({ file, index: i, title: e.title });
    });
    return out;
  };
  return [
    ...entriesOf(plannedPlanEntries(root), holds.plans, "plans"),
    ...entriesOf(openBugEntries(root), holds.bugs, "bugs"),
  ];
}

/** The runner id holding a live claim on each planned plan and open bug, two arrays parallel
 * to backlogHolds' (same readers, same order); `null` when no role is working on the entry.
 * Keyed by entryKey alone, exactly as the backlog index's claim lookup is. */
export function backlogInProgress(root: string): { plans: (string | null)[]; bugs: (string | null)[] } {
  const claims = allLiveClaims(root);
  const runnerOf = (entry: BacklogEntry): string | null => claims.get(entryKey(entry.title)) ?? null;
  return {
    plans: plannedPlanEntries(root).map(runnerOf),
    bugs: openBugEntries(root).map(runnerOf),
  };
}

/** The heading mark for an entry a role is working on: empty when nobody is, else
 * ` [working on it: feature #2]` (the runner id through roleLabel). */
export function inProgressMark(runner: string | null): string {
  return runner === null ? "" : ` [working on it: ${roleLabel(runner)}]`;
}

/** The note a cancel surface adds when the cancelled entry was claimed: empty for `null`, else
 * names the role (through roleLabel) and the `abort` that stops its run, which the cancel itself
 * leaves going. */
export function cancelledClaimNote(runner: string | null): string {
  return runner === null
    ? ""
    : `${roleLabel(runner)} is still working on it — its run goes on; \`tumwater abort --role ${runner}\` stops it`;
}

/** The backlog file and section a claim-taking role's entries live under: BUGS.md's `## Open`
 * for bugfix, PLANS.md's `## Planned` for every other base. An instance id resolves through its
 * base role. The one home of the role → (file, section) mapping, so eligibility (eligibleEntries
 * below) and claim staging (scheduling/claims.ts) read a claim's line range from the right file
 * and cannot drift on which section a role owns. */
export function roleSection(role: string): { file: "PLANS.md" | "BUGS.md"; section: string } {
  return baseRoleOf(role) === "bugfix"
    ? { file: "BUGS.md", section: "Open" }
    : { file: "PLANS.md", section: "Planned" };
}

/** The entries `role` may take now, in file order: PLANS.md's `## Planned` entries for
 * feature, BUGS.md's `## Open` entries for bugfix, minus every entry entryHold holds, each with
 * its stamp-free key, verbatim title and 1-based line range. Reads the primary checkout through
 * the same stat-cached readers the index uses; a missing or unreadable file yields []. */
export function eligibleEntries(root: string, role: string): EligibleEntry[] {
  // An instance id (`bugfix-2`) resolves through its base role, as roleSection does, so a
  // claim's line range and the entry list are read from the right file.
  const { file, section } = roleSection(role);
  const entries = section === "Open" ? openBugEntries(root) : plannedPlanEntries(root);
  const ranges = actionableEntryRangesFor(root, file, section);
  const planned = plannedPlanEntries(root);
  const parts = plannedPartKeys(planned);
  // The cross-role in-flight hold (BUGS.md 2026-10-09): an entry another role's base has
  // claimed is not eligible here. Same-base claims are excluded from the hold — the scheduling
  // pass's claim groups and run-stage's staged claims already hold those — so the queried
  // role's own claim (and a sibling instance's) stays eligible and its release rules are
  // unchanged; only a plan another base currently owns is taken off this base's hands.
  const ownBase = baseRoleOf(role);
  const claimedElsewhere = new Set<string>();
  for (const [key, claimer] of allLiveClaims(root)) {
    if (baseRoleOf(claimer) !== ownBase) claimedElsewhere.add(key);
  }
  const out: EligibleEntry[] = [];
  for (let i = 0; i < entries.length && i < ranges.length; i++) {
    const entry = entries[i]!;
    if (entryHoldAgainst(entry, parts) !== null) continue;
    if (claimedElsewhere.has(entryKey(entry.title))) continue;
    const range = ranges[i]!;
    out.push({
      key: entryKey(entry.title),
      title: entry.title,
      start: range.start,
      end: range.end,
    });
  }
  return out;
}
