import path from "node:path";
import { increment } from "../collections.js";
import { readTextOrNull } from "../files/files.js";
import { cachedTextByStat, type StatKeyedValue } from "../files/stat-cache.js";
import {
  BACKLOG_FILES,
  FINISHED_ARCHIVES,
  fenceTracker,
  headingMetadata,
  parseEntryDetails,
  sectionBodyLines,
  fenceAwareHeadingLines,
  headingTitle,
} from "./backlog-md.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { plural } from "../text/phrases.js";
import { collapseWhitespace, truncate } from "../text/text.js";
import {
  seriesPart,
  type EntryHold,
  type PartRef,
} from "./backlog-eligibility.js";

/** The archive files of PLANS.md and BUGS.md (FINISHED_ARCHIVES). */
const PLANS_ARCHIVE = FINISHED_ARCHIVES[0].archive;
const BUGS_ARCHIVE = FINISHED_ARCHIVES[1].archive;

/** Deterministic structural checks on the backlog markdown (PLANS.md, BUGS.md, QUESTIONS.md) — the
 * same files roles edit and readers parse, but read here for states no reader wants: an entry filed
 * under the wrong `## ` section. This module holds PLANS.md's stranding rules (plans:
 * "Stranded-plan detection", part 3/4): a `(planned …)` heading sitting under `## Done` never
 * entered a reader's section, and a `done`-dated heading still sitting under `## Planned` invites
 * re-implementation. It also holds the gate-side companion (part 4/4): a change that ADDS a new
 * plan directly under `## Done` is rejected before it can merge. Detection is pure markdown reading
 * — no pi, no git — so the clean role's run prompt, `tumwater doctor`, and every merge check can
 * all afford it every time. This module also parses actionable entry ranges
 * (actionableEntryRanges/actionableEntryRangesFor) and collapses a series' blocked parts
 * (groupBlockedSeries/partsLabel) for the backlog-index block, which the text of the index block
 * itself renders (src/backlog/backlog-index.ts). */

/** A `### ` heading the detector found filed under the wrong `## ` section of PLANS.md:
 * `title` is the full heading text (verbatim, dates and all), `section` the section it sits
 * in now — which tells the repairer where it does NOT belong, since a heading's own dates
 * say where it does. */
export interface StrandedPlanEntry {
  title: string;
  section: "Planned" | "Done";
  /** The file it sits in, when a reader scanned more than PLANS.md: PLANS-DONE.md's `## Done`
   * can hold one too (strandedPlanEntriesFor). */
  file?: string;
}

/** The stamp verbs a backlog heading's trailing `(planned 2026-09-29)`-style parenthetical
 * opens with — the same list the backlog writers stamp and the dashboards parse. One home
 * for the verb list: the TUI's team alerts strip the suffix (stripEntryStamp) and the
 * dashboard's browser view model splits it off as metadata (splitTitle), and a new stamp
 * verb must reach both renders.
 * Kept as pattern SOURCE rather than a RegExp so the browser twin (a String.raw template
 * that cannot import runtime code) can interpolate it into its own compiled regex. */
export const ENTRY_STAMP_META_SOURCE = String.raw`\s*\(((?:planned|reported|found|refined|asked|posted|filed|opened|done)\b[^)]*)\)\s*$`;

/** ENTRY_STAMP_META_SOURCE compiled: the one server-side home of the stamp-suffix match
 * (case-insensitive, note captured), read through stripEntryStamp below. */
const ENTRY_STAMP_META_RE = new RegExp(ENTRY_STAMP_META_SOURCE, "i");

/** A heading or title with its trailing `(planned 2026-09-29)`-style stamp suffix removed,
 * whitespace otherwise untouched — the shared span of backlog-index's indexTitle, eligibility's
 * entryKey and seriesPart, and the TUI team alerts, which all read a heading stamp-free. */
export function stripEntryStamp(title: string): string {
  return title.replace(ENTRY_STAMP_META_RE, "");
}

/** The heading of a `## Done`/`## Fixed` entry with its completion stamp removed. Cuts at the
 * first `dateRe` match, drops a parenthetical the cut left open (`(found by … 2026-10-01; `,
 * `(planned …; `), ignores a stray `)` (`… now under ## Fixed); fixed 2026-10-04 …)`), trims
 * trailing separators, then strips a closed `(planned …)`/`(found …)` stamp suffix. `dateRe`
 * matches nothing in the result. */
export function finishedTitle(title: string, dateRe: RegExp): string {
  const match = dateRe.exec(title);
  let t = match ? title.slice(0, match.index) : title;
  const open: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") open.push(i);
    else if (t[i] === ")" && open.length) open.pop();
  }
  if (open.length) t = t.slice(0, open[0]);
  t = t.replace(/[\s,;:—–-]+$/, "");
  return stripEntryStamp(t).trimEnd();
}

/** A heading's parenthetical dates: `(planned YYYY-MM-DD` opens a plan entry; `done
 * YYYY-MM-DD` records its completion. Matched against the JOINED heading metadata
 * (headingMetadata), never the bare first line — many headings wrap their dates onto a
 * second line (`(planned 2026-09-02, done` / `2026-09-03)`). */
const PLANNED_DATE = /\(planned \d{4}-\d{2}-\d{2}/;
const DONE_DATE = /\bdone \d{4}-\d{2}-\d{2}/;
/** A completion stamp: `done YYYY-MM-DD` introduced by a structural delimiter (`— done`,
 * `, done`, `; done`, `(done`) rather than by an English subject in prose. Every entry-own done
 * record in PLANS.md is delimiter-introduced (`…planned …, done …`, `…planned …; done …`,
 * `…) — done …`, `…) (done …)`); a "done DATE" that merely names PRIOR merged work is a
 * participle ("…part 2/2 … both done 2026-10-16, …") whose `done` follows a word, so this
 * narrower regex does not match it and a mention inside a heading's own `(planned …)` prose
 * cannot strand the entry. */
const DONE_STAMP = /[—,(;]\s*done \d{4}-\d{2}-\d{2}/;

/** The `### ` headings of `md`'s PLANS.md that sit under the wrong section, in file order:
 * (a) entries under `## Done` whose heading carries a `(planned YYYY-MM-DD…)` parenthetical
 * but no `done YYYY-MM-DD` — written as plans, never stamped done, and invisible to every
 * Planned reader (`plannedPlanEntries` reads only `## Planned`); and (b) entries under
 * `## Planned` whose heading already carries `done YYYY-MM-DD` — finished and never moved,
 * so the feature role may implement them again. Fence-aware through backlog-md.ts's shared
 * machinery: a `### `/`## ` line inside a fenced code block is quoted content, not structure,
 * and heading dates are matched against the same joined metadata entryDates matches against.
 * BUGS.md and QUESTIONS.md are deliberately out of scope — their Fixed-section headings do
 * not all carry a date suffix, so the same rule would misfire there. */
export function strandedPlanEntries(md: string): StrandedPlanEntry[] {
  const stranded: StrandedPlanEntry[] = [];
  // Each `## ` section's body is read through backlog-md.ts's sectionBodyLines — which walks
  // sectionLines, the single home of "where a section starts and ends", shared with
  // entryDates' readers — so this scanner and the entry readers can never disagree about the
  // boundary. Walking the section titles in file order (each occurrence once) keeps the output
  // in document order, the same order the whole-document walk it replaced produced.
  for (const section of sectionTitles(md)) {
    if (section !== "Planned" && section !== "Done") continue;
    // The shared sectionBodyLines walk (backlog-md.ts) drops fenced lines, matching
    // entryDates': a fenced `### ` line is quoted content, never an entry.
    const lines = sectionBodyLines(md, section);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.startsWith("### ")) continue;
      const { text } = headingMetadata(lines, i);
      // A `## Done` entry is stranded when it carries the `(planned …)` opener but no done
      // stamp of its own. An entry still under `## Planned` is stranded only when its heading
      // carries a completion stamp — a `done YYYY-MM-DD` introduced by a structural delimiter
      // (`— done`, `, done`, `; done`, `(done`), the repo's completion shapes. A "done DATE" that
      // merely describes PRIOR merged work ("…both done 2026-10-16, …") follows an English word,
      // not a delimiter, so DONE_STAMP does not match it and the entry is not stranded.
      const misplaced = section === "Done"
        ? PLANNED_DATE.test(text) && !DONE_DATE.test(text)
        : DONE_STAMP.test(text);
      if (misplaced)
        stranded.push({ title: headingTitle(line, "### "), section });
    }
  }
  return stranded;
}

/** A `### ` heading's comparison key: the heading text before its first ` (`, whitespace-
 * normalized (text.ts's collapseWhitespace — the one home for this, shared with
 * normalizeFixedHeading's BUGS.md counterpart below), so an entry that moved between
 * sections with its dates intact keys equal on both sides of a diff. */
function planHeadingKey(title: string): string {
  const cut = title.indexOf(" (");
  return collapseWhitespace(cut === -1 ? title : title.slice(0, cut));
}

/** The comparison keys of every `### ` heading in `md`, in ANY `## ` section, fence-aware
 * (backlog-md.ts's shared tracker). The base-side set for the new-plan-under-Done rule: an entry
 * whose key the base already carried is a move between sections, never a stranding. */
function planHeadingKeys(md: string): Set<string> {
  const keys = new Set<string>();
  for (const line of fenceAwareHeadingLines(md, "### ")) {
    keys.add(planHeadingKey(headingTitle(line, "### ")));
  }
  return keys;
}

/** The `## ` section titles of `md`, in file order, fence-aware (backlog-md.ts's shared tracker:
 * a `## Done` quoted inside a fenced code block is body text, not structure). */
function sectionTitles(md: string): string[] {
  return fenceAwareHeadingLines(md, "## ").map((line) => headingTitle(line, "## "));
}

/** How many times each `## ` title appears in `md` — the tally `duplicateHeadings` reports
 * repeats from and `backlogStructureReason` compares head against base for both backlog
 * files, so the three sites count sections through one helper and cannot drift apart. */
function sectionTitleCounts(md: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of sectionTitles(md)) increment(counts, title);
  return counts;
}

/** The `## ` titles of `md` that appear more than once, in first-appearance order — the
 * duplicate-heading signal `checkBacklogHeadings` reports for main and `backlogStructureReason`
 * checks on a tree being merged. */
export function duplicateHeadings(md: string): string[] {
  return [...sectionTitleCounts(md)].filter(([, n]) => n > 1).map(([title]) => title);
}

/** The `### ` headings `head` adds that `base` already carries, as extra copies: for each
 * heading (whitespace-collapsed, every `## ` section, fence-aware) present in `base` and more
 * often in `head`, one entry per added copy, in the head's first-appearance order. The archive
 * files' re-pasted-history signal: on 2026-10-19 a conflict hand-back re-pasted 383 + 310 archived
 * entries, and the commit-time sweep prepended them to PLANS-DONE.md and BUGS-FIXED.md again. A
 * heading the base already duplicates never counts unless the head adds yet another copy. */
export function readdedHeadings(base: string, head: string): string[] {
  const count = (md: string): Map<string, { n: number; title: string }> => {
    const out = new Map<string, { n: number; title: string }>();
    for (const line of fenceAwareHeadingLines(md, "### ")) {
      const title = headingTitle(line, "### ");
      const key = collapseWhitespace(title);
      const seen = out.get(key);
      if (seen) seen.n++;
      else out.set(key, { n: 1, title });
    }
    return out;
  };
  const baseCounts = count(base);
  const readded: string[] = [];
  for (const [key, { n, title }] of count(head)) {
    const had = baseCounts.get(key)?.n ?? 0;
    if (had > 0 && n > had) for (let i = had; i < n; i++) readded.push(title);
  }
  return readded;
}

/** The `## Fixed` entry headings whose body holds more than one `**Symptom:**` or
 * `**Fix:**` block — the shape a record with no `### ` heading leaves when parseEntryDetails
 * absorbs it into the entry above (an entry opens only at a `### ` line, so the headingless
 * record becomes body text). A legitimate Fixed body holds exactly one Symptom/Fix pair; a
 * second block is a record merged in from a lost heading, where no section reader lists it and
 * the false-fix guard's symbol check reads it as part of its neighbor. Fenced lines are
 * quoted content, never blocks, through backlog-md.ts's shared fenceTracker (an entry may
 * quote a template carrying both markers). */
export function doubleBlockFixedEntries(md: string): string[] {
  const found: string[] = [];
  for (const entry of parseEntryDetails(md, "Fixed")) {
    const fenced = fenceTracker();
    let symptom = 0;
    let fix = 0;
    for (const line of entry.body.split("\n")) {
      if (fenced.inside(line)) continue;
      if (line.startsWith("**Symptom:**")) symptom++;
      else if (line.startsWith("**Fix:**")) fix++;
    }
    if (symptom > 1 || fix > 1) found.push(entry.title);
  }
  return found;
}

/** The first structural fault a diff merging into `mainBranch` leaves in a backlog file, or
 * undefined when none: for each touched backlog file it compares the `## ` heading set of the tree
 * being merged (`wt`) against the diff's merge-base — the same base falseFixReason measures
 * against, so a stacked batch is judged change by change — and rejects when (a) the head carries
 * MORE of a title than the base carried (a duplicate `## Done` added, or a second one where the
 * base had none), or (b) a title present on the base is gone from the head (a whole section
 * dropped). The rule is deliberately about heading sets, not section names: a project whose BUGS.md
 * adds `## Verified` (this repo's does) or a fresh repo seeded from src/init/init.ts's templates
 * passes unchanged. A base that already carries a duplicate never blocks unrelated edits — rule (a)
 * fires only when the head's count EXCEEDS the base's, so a change that removes a duplicate always
 * passes. For PLANS.md there is a third rule (part 4/4): a head that ADDS a `### ` entry directly
 * under `## Done` whose joined heading metadata carries `(planned YYYY-MM-DD` but no `done
 * YYYY-MM-DD`, and whose key the base's PLANS.md never carried in ANY section, is a plan filed into
 * the wrong section — rejected with a reason naming the entry and the one-line fix. Judged against
 * the merge-base (the same base the heading rules use), so a Planned → Done move of an entry the
 * base already had passes, a stacked batch is measured change by change, and a pre-existing
 * stranded entry (whose key the base has) never blocks unrelated merges — the clean role's repair
 * (part 3/4) owns those. BUGS.md has one more: a head `## Fixed` entry that holds more than one
 * `**Symptom:**` or `**Fix:**` block (doubleBlockFixedEntries) absorbed a headingless record into
 * its body; a base body that already had the shape is never re-flagged, so only a newly merged
 * record is rejected (BUGS.md 2026-10-08). The archive files (PLANS-DONE.md, BUGS-FIXED.md) have
 * one more: a head that adds a copy of a `### ` heading the base archive already carries
 * (readdedHeadings) is pasting finished history back, rejected with the count and the first
 * heading. Detection is deterministic markdown reading — no pi — so
 * both the review gate (exempt and code diffs alike) and the in-lock merge re-check can afford it
 * on every merge (plans: "Backlog structure check", part 2/4). */
export async function backlogStructureReason(
  wt: string,
  mainBranch: string,
  files: string[],
): Promise<string | undefined> {
  const touched = files.filter((f) => BACKLOG_FILES.has(f));
  if (touched.length === 0) return undefined;
  const baseRev = await changeBaseRev(wt, mainBranch);
  for (const file of touched) {
    // A deleted file reads as empty: every heading the base had is gone — rule (b).
    const head = readTextOrNull(path.join(wt, file)) ?? "";
    const base = await fileContentAt(wt, baseRev, file);
    const headCounts = sectionTitleCounts(head);
    const baseCounts = sectionTitleCounts(base);
    for (const [title, count] of headCounts)
      if (count > 1 && count > (baseCounts.get(title) ?? 0))
        return (
          `${file} adds another "## ${title}" heading — readers take the first section of a ` +
          `name, so anything under the duplicate is invisible; keep one "## ${title}" per file`
        );
    for (const title of baseCounts.keys())
      if (!headCounts.has(title))
        return (
          `${file} drops the "## ${title}" section the base had — entries filed under it would ` +
          `be invisible to every section reader; restore "## ${title}"`
        );
    // An archive only grows by new headings: a copy of one the base archive already carries is
    // finished history pasted back (readdedHeadings), never a new finished entry.
    if (file === PLANS_ARCHIVE || file === BUGS_ARCHIVE) {
      const readded = readdedHeadings(base, head);
      if (readded.length > 0)
        return (
          `${file} adds ${plural(readded.length, '"### " heading', '"### " headings')} it already carries ` +
          `(first: "${truncate(readded[0]!, 160)}") — the archive holds each finished entry once, so the ` +
          `copies duplicate its history; remove them, and edit an archived entry in place instead`
        );
    }
    // Part 4/4's rule, PLANS.md and its archive (see this function's doc comment): a NEW plan
    // filed directly under ## Done with no done date. strandedPlanEntries already does the
    // fence-aware, joined-metadata reading the first two conditions need; the base's key set —
    // over both files, since tumwater moves a finished plan from one to the other
    // (plans/backlog-archive.md) — supplies the third.
    if (file === "PLANS.md" || file === PLANS_ARCHIVE) {
      const baseKeys = new Set([
        ...planHeadingKeys(file === "PLANS.md" ? base : await fileContentAt(wt, baseRev, "PLANS.md")),
        ...planHeadingKeys(file === PLANS_ARCHIVE ? base : await fileContentAt(wt, baseRev, PLANS_ARCHIVE)),
      ]);
      const newcomer = strandedPlanEntries(head).find(
        (e) => e.section === "Done" && !baseKeys.has(planHeadingKey(e.title)),
      );
      if (newcomer)
        return (
          `${file} files "${newcomer.title}" directly under "## Done" with no done date — a plan ` +
          `written into the done section is invisible to every Planned reader; file it under ` +
          `"## Planned"${file === "PLANS.md" ? "" : " in PLANS.md"} instead`
        );
    }
    // A new headingless record cannot hide in a Fixed entry's body: reject a head whose
    // multi-block entries the base did not carry (an existing one never blocks unrelated
    // edits, matching the heading-set rules above). The Fix paragraph is the guard's unit, so
    // a merged second block would otherwise sit inside the neighbor it was symbol-checked
    // against. BUGS-FIXED.md holds the same entries once archived.
    if (file === "BUGS.md" || file === BUGS_ARCHIVE) {
      const baseTitles = new Set(doubleBlockFixedEntries(base));
      const newcomer = doubleBlockFixedEntries(head).find((title) => !baseTitles.has(title));
      if (newcomer)
        return (
          `${file}'s Fixed entry "${newcomer}" holds more than one **Symptom:**/**Fix:** block — ` +
          `a record with no "### " heading has merged into it, so the hidden record is invisible ` +
          `to every section reader; give it its own "### " heading`
        );
    }
  }
  return undefined;
}

/** Per-file cache of PLANS.md's and PLANS-DONE.md's stranded entries (strandedPlanEntriesFor). */
const strandedPlanCache = new Map<string, StatKeyedValue<StrandedPlanEntry[]>>();

/** `strandedPlanEntries` for the primary checkout's PLANS.md and PLANS-DONE.md (where finished
 * plans are archived, plans/backlog-archive.md), each entry tagged with its file, stat-cached per
 * file path (stat-cache.cachedTextByStat): the clean role asks for it every run, `tumwater role`
 * previews the same block and doctor reports it, and the archive grows without bound, so an
 * unchanged file costs one stat instead of a full read and section walk. A missing or
 * unreadable file reads as no entries. The result is copied out, so each caller owns its
 * data. */
export function strandedPlanEntriesFor(root: string): StrandedPlanEntry[] {
  return ["PLANS.md", PLANS_ARCHIVE].flatMap((file) => {
    const full = path.join(root, file);
    return (
      cachedTextByStat(
        strandedPlanCache,
        full,
        full,
        (md) => strandedPlanEntries(md).map((e) => ({ ...e, file })),
        (entries) => entries.slice(), // A copy: callers may treat the result as their own.
      ) ?? []
    );
  });
}

/** The clean role's `<backlog-structure>` prompt block for the primary checkout at `root`
 * (the same root the selfcheck digest and qa coverage blocks read): a rendered block listing
 * each stranded heading with its current section, or undefined when PLANS.md is missing,
 * unreadable, or clean — an unreadable or clean file gives no block, so the prompt is
 * unchanged in the common case. The stranded entries are stat-cached (strandedPlanEntriesFor),
 * so an unchanged PLANS.md is not re-read or re-walked. */
export function renderBacklogStructureBlock(root: string): string | undefined {
  const stranded = strandedPlanEntriesFor(root);
  if (stranded.length === 0) return undefined;
  const listed = stranded
    .map((e) => `- (now under ${e.file !== undefined && e.file !== "PLANS.md" ? `${e.file} ` : ""}## ${e.section}) ${e.title}`)
    .join("\n");
  // The task wording lives in the clean role's find text (src/roles/role-catalog.ts); the block
  // only carries the evidence, like the digest and coverage blocks do.
  return `Plan headings filed under the wrong section of PLANS.md or PLANS-DONE.md — invisible to
the readers that scan one section, so no role sees them as backlog work:
<backlog-structure>
${listed}
</backlog-structure>`;
}

/** One actionable backlog entry with the 1-based line range its text occupies in its file:
 * `start` is its `### ` heading line, `end` the last line before the next heading (or the
 * file's last line). */
export interface ActionableEntryRange {
  title: string;
  start: number;
  end: number;
}

/** The entries under one `## <sectionTitle>` section with their 1-based line ranges, in file
 * order: the fence-aware walk sectionLines and parseEntryDetails share, carrying the line
 * numbers neither returns. An entry starts at a `### ` line and ends at the line before the
 * next `### ` or `## ` line (or EOF) — the same boundary parseEntryDetails closes bodies on —
 * so a role reading lines `start`..`end` sees exactly the entry's heading and body. A `## ` or
 * `### ` line inside a fenced code block is body content, never a boundary, through
 * backlog-md.ts's shared fenceTracker. */
export function actionableEntryRanges(md: string, sectionTitle: string): ActionableEntryRange[] {
  const lines = md.split("\n");
  const fenced = fenceTracker();
  const entries: ActionableEntryRange[] = [];
  let inSection = false;
  let open: { title: string; start: number } | null = null;
  // `end` is the 1-based number of the entry's last body line, i.e. the 0-based index of the
  // next heading; at EOF it is the line count (the last 1-based line number).
  const close = (end: number): void => {
    if (open !== null) entries.push({ title: open.title, start: open.start, end });
    open = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fenced.inside(line)) continue;
    if (line.startsWith("## ")) {
      close(i);
      inSection = headingTitle(line, "## ") === sectionTitle;
    } else if (inSection && line.startsWith("### ")) {
      close(i);
      open = { title: headingTitle(line, "### "), start: i + 1 };
    }
  }
  // A document ending in a newline splits to a trailing "" element; the last real line is one
  // less, so an entry running to EOF ends there instead of at the phantom line.
  close(md.endsWith("\n") ? lines.length - 1 : lines.length);
  return entries;
}

/** Per-file cache of a section's actionable ranges (actionableEntryRangesFor). */
const actionableRangesCache = new Map<string, StatKeyedValue<ActionableEntryRange[]>>();

/** `actionableEntryRanges` for one backlog file, stat-cached per (file path, section title):
 * the per-poll and per-run readers (eligibility's eligibleEntries, claims' listedKeys) ask for
 * the same section of the same file every couple of seconds, and BUGS.md's closed history —
 * which the whole-file walk reads — grows without bound, so an unchanged file costs one stat
 * instead of a full read, split, and section walk. Keyed by file path so distinct roots never
 * collide, bounded inside cachedTextByStat. A missing or unreadable file reads as no ranges. The
 * result is copied out, so each caller owns its data. */
export function actionableEntryRangesFor(
  root: string,
  file: string,
  sectionTitle: string,
): ActionableEntryRange[] {
  const full = path.join(root, file);
  return (
    cachedTextByStat(
      actionableRangesCache,
      `${full}\u0000${sectionTitle}`,
      full,
      (md) => actionableEntryRanges(md, sectionTitle),
      (ranges) => ranges.slice(), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** The fields series-grouping reads from a backlog row: its heading, eligibility hold and live
 * claimer. backlog-index's `IndexRow` and `plan --list`'s numbered rows both extend it. */
export interface SeriesRow {
  title: string;
  hold: EntryHold;
  claimer: string | undefined;
}

/** One place in a grouped list: an ordinary row, or a series' blocked parts (two or more) at
 * the position of the first. */
type SeriesGroup<T extends SeriesRow> =
  | { kind: "row"; row: T }
  | { kind: "series"; series: string; rows: T[] };

/** True when `row` is a candidate for series-collapsing: it is a series part held only by an
 * unmerged prerequisite (`{ blockedBy }`, not a Refused/needs-review/needs-replan note) and no live
 * claim names it. Returns the row's series part when it collapses, else null. */
function collapsibleSeriesPart(row: SeriesRow): PartRef | null {
  if (row.claimer !== undefined) return null;
  if (typeof row.hold !== "object" || row.hold === null) return null;
  return seriesPart(row.title);
}

/** The collapsed part list for a series' blocked parts: each part as `i/n`, with a run of
 * consecutive numeric parts (same total, adjacent values) joined into one en-dash range
 * (`2/5–5/5`) and each lettered part (`2a`) listed singly. */
export function partsLabel(rows: readonly SeriesRow[]): string {
  const refs = rows.map((r) => seriesPart(r.title)!);
  const pieces: string[] = [];
  let start: PartRef | null = null;
  let prev: PartRef | null = null;
  const numeric = (p: string): boolean => /^\d+$/.test(p);
  const flush = (): void => {
    if (start === null || prev === null) return;
    pieces.push(
      start.part === prev.part
        ? `${start.part}/${start.of}`
        : `${start.part}/${start.of}–${prev.part}/${prev.of}`,
    );
    start = null;
    prev = null;
  };
  for (const ref of refs) {
    if (
      prev !== null &&
      numeric(ref.part) &&
      numeric(prev.part) &&
      Number(ref.part) === Number(prev.part) + 1 &&
      ref.of === prev.of
    ) {
      prev = ref;
      continue;
    }
    flush();
    start = ref;
    prev = ref;
  }
  flush();
  return pieces.join(", ");
}

/** Renders `rows` to index lines, collapsing a multi-part series' blocked parts to one line per
 * series (this plan, "Compact backlog index, part 1/1"): a long series' chain of held parts would
 * otherwise fill every role prompt with lines no role can act on. An entry collapses when it is a
 * series part held only by an unmerged prerequisite and no live claim names it; a series with two
 * or more such parts renders as one line at the position of its first collapsed part, spanning from
 * that part's start to the last's end, with the part list (`2/4–4/4`) and a `[blocked: each waits
 * on an earlier part]` mark. A series with a single blocked part, an eligible part, a note-held
 * (Refused/needs-review/needs-replan) part and a claimed part keep their ordinary lines, so the
 * eligibility rules the feature role's charter teaches are unchanged; the collapsed mark keeps the
 * `[blocked: …]` prefix it already skips. */
/** The grouping half of backlog-index's collapseBlockedSeries, on any rows carrying a title,
 * hold and claimer: each series with two or more collapsible blocked parts becomes one `series`
 * group at its first part's place; every other row stays a `row` group in order. */
export function groupBlockedSeries<T extends SeriesRow>(rows: readonly T[]): SeriesGroup<T>[] {
  // Group the collapsible rows by series, keyed on the lowercased series name.
  const bySeries = new Map<string, T[]>();
  for (const row of rows) {
    const part = collapsibleSeriesPart(row);
    if (part === null) continue;
    const key = part.series.toLowerCase();
    const list = bySeries.get(key) ?? [];
    list.push(row);
    bySeries.set(key, list);
  }
  // Only a series with two or more blocked parts collapses; a lone blocked part keeps its
  // exact `requires` line.
  const collapse = new Set<string>();
  for (const [key, list] of bySeries) if (list.length >= 2) collapse.add(key);
  const groups: SeriesGroup<T>[] = [];
  const skipped = new Set<T>();
  for (const row of rows) {
    if (skipped.has(row)) continue;
    const part = collapsibleSeriesPart(row);
    if (part !== null && collapse.has(part.series.toLowerCase())) {
      const group = bySeries.get(part.series.toLowerCase())!;
      groups.push({ kind: "series", series: part.series, rows: group });
      for (const g of group) skipped.add(g);
      continue;
    }
    groups.push({ kind: "row", row });
  }
  return groups;
}

