import path from "node:path";
import { increment } from "../collections.js";
import { readTextOrNull } from "../files/files.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { BACKLOG_FILES, fenceTracker, headingMetadata, parseEntryDetails, sectionBodyLines, fenceAwareHeadingLines } from "./backlog-md.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { collapseWhitespace, truncate } from "../text/text.js";
import { entryHold, type EntryHold } from "./backlog-eligibility.js";

/** Deterministic structural checks on the backlog markdown (PLANS.md, BUGS.md, QUESTIONS.md) —
 * the same files loops edit and readers parse, but read here for states no reader wants: an
 * entry filed under the wrong `## ` section. This module holds PLANS.md's stranding rules
 * (plans: "Stranded-plan detection", part 3/4): a `(planned …)` heading sitting under `## Done`
 * never entered a reader's section, and a `done`-dated heading still sitting under
 * `## Planned` invites re-implementation. It also holds the gate-side companion (part 4/4):
 * a change that ADDS a new plan directly under `## Done` is rejected before it can land.
 * Detection is pure markdown reading — no pi, no git — so the clean loop's tick prompt,
 * `tumwater doctor`, and every landing check can all afford it every time. It also renders the
 * compact actionable backlog index every loop prompt carries (renderBacklogIndexBlock below),
 * the bounded replacement for the per-tick heading map. */

/** A `### ` heading the detector found filed under the wrong `## ` section of PLANS.md:
 * `title` is the full heading text (verbatim, dates and all), `section` the section it sits
 * in now — which tells the repairer where it does NOT belong, since a heading's own dates
 * say where it does. */
export interface StrandedPlanEntry {
  title: string;
  section: "Planned" | "Done";
}

/** The stamp verbs a backlog heading's trailing `(planned 2026-09-29)`-style parenthetical
 * opens with — the same list the backlog writers stamp and the dashboards parse. One home
 * for the verb list: the TUI's fleet alerts strip the suffix (stripEntryStamp) and the
 * dashboard's browser view model splits it off as metadata (splitTitle), and a new stamp
 * verb must reach both renders.
 * Kept as pattern SOURCE rather than a RegExp so the browser twin (a String.raw template
 * that cannot import runtime code) can interpolate it into its own compiled regex. */
export const ENTRY_STAMP_META_SOURCE = String.raw`\s*\(((?:planned|reported|found|refined|asked|posted|filed|opened|done)\b[^)]*)\)\s*$`;

/** ENTRY_STAMP_META_SOURCE compiled: the one server-side home of the stamp-suffix match
 * (case-insensitive, note captured), read through stripEntryStamp below. */
const ENTRY_STAMP_META_RE = new RegExp(ENTRY_STAMP_META_SOURCE, "i");

/** A heading or title with its trailing `(planned 2026-09-29)`-style stamp suffix removed,
 * whitespace otherwise untouched — the shared span of this module's indexTitle, eligibility's
 * entryKey and seriesPart, and the TUI fleet alerts, which all read a heading stamp-free. */
export function stripEntryStamp(title: string): string {
  return title.replace(ENTRY_STAMP_META_RE, "");
}

/** A heading's parenthetical dates: `(planned YYYY-MM-DD` opens a plan entry; `done
 * YYYY-MM-DD` records its completion. Matched against the JOINED heading metadata
 * (headingMetadata), never the bare first line — many headings wrap their dates onto a
 * second line (`(planned 2026-09-02, done` / `2026-09-03)`). */
const PLANNED_DATE = /\(planned \d{4}-\d{2}-\d{2}/;
const DONE_DATE = /\bdone \d{4}-\d{2}-\d{2}/;

/** The `### ` headings of `md`'s PLANS.md that sit under the wrong section, in file order:
 * (a) entries under `## Done` whose heading carries a `(planned YYYY-MM-DD…)` parenthetical
 * but no `done YYYY-MM-DD` — written as plans, never stamped done, and invisible to every
 * Planned reader (`plannedPlanEntries` reads only `## Planned`); and (b) entries under
 * `## Planned` whose heading already carries `done YYYY-MM-DD` — finished and never moved,
 * so the feature loop may implement them again. Fence-aware through backlog-md.ts's shared
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
      if (section === "Done" ? PLANNED_DATE.test(text) && !DONE_DATE.test(text) : DONE_DATE.test(text))
        stranded.push({ title: line.slice(4).trim(), section });
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
    keys.add(planHeadingKey(line.slice(4).trim()));
  }
  return keys;
}

/** The `## ` section titles of `md`, in file order, fence-aware (backlog-md.ts's shared tracker:
 * a `## Done` quoted inside a fenced code block is body text, not structure). */
function sectionTitles(md: string): string[] {
  return fenceAwareHeadingLines(md, "## ").map((line) => line.slice(3).trim());
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
 * duplicate-heading signal `checkBacklogHeadings` reports for main and
 * `backlogStructureReason` checks on a tree being landed. */
export function duplicateHeadings(md: string): string[] {
  return [...sectionTitleCounts(md)].filter(([, n]) => n > 1).map(([title]) => title);
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

/** The first structural fault a diff landing on `mainBranch` leaves in a backlog file, or
 * undefined when none: for each touched backlog file it compares the `## ` heading set of the
 * tree being landed (`wt`) against the diff's merge-base — the same base falseFixReason
 * measures against, so a stacked batch is judged change by change — and rejects when
 * (a) the head carries MORE of a title than the base carried (a duplicate `## Done` added, or
 * a second one where the base had none), or (b) a title present on the base is gone from the
 * head (a whole section dropped). The rule is deliberately about heading sets, not section
 * names: a project whose BUGS.md adds `## Verified` (this repo's does) or a fresh repo seeded
 * from src/init/init.ts's templates passes unchanged. A base that already carries a duplicate never
 * blocks unrelated edits — rule (a) fires only when the head's count EXCEEDS the base's, so a
 * change that removes a duplicate always passes. For PLANS.md there is a third rule
 * (part 4/4): a head that ADDS a `### ` entry directly under `## Done` whose joined heading
 * metadata carries `(planned YYYY-MM-DD` but no `done YYYY-MM-DD`, and whose key the base's
 * PLANS.md never carried in ANY section, is a plan filed into the wrong section — rejected with
 * a reason naming the entry and the one-line fix. Judged against the merge-base (the same base
 * the heading rules use), so a Planned → Done move of an entry the base already had passes, a
 * stacked batch is measured change by change, and a pre-existing stranded entry (whose key the
 * base has) never blocks unrelated landings — the clean loop's repair (part 3/4) owns those.
 * BUGS.md has one more: a head `## Fixed` entry that holds more than one `**Symptom:**` or
 * `**Fix:**` block (doubleBlockFixedEntries) absorbed a headingless record into its body; a
 * base body that already had the shape is never re-flagged, so only a newly merged record is
 * rejected (BUGS.md 2026-10-08). Detection is deterministic markdown reading —
 * no pi — so both the review gate (exempt and code diffs alike) and the in-lock landing
 * re-check can afford it on every landing (plans: "Backlog structure check", part 2/4). */
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
    // Part 4/4's rule, PLANS.md only (see this function's doc comment): a NEW plan filed
    // directly under ## Done with no done date. strandedPlanEntries already does the
    // fence-aware, joined-metadata reading the first two conditions need; the base's key set
    // supplies the third.
    if (file === "PLANS.md") {
      const baseKeys = planHeadingKeys(base);
      const newcomer = strandedPlanEntries(head).find(
        (e) => e.section === "Done" && !baseKeys.has(planHeadingKey(e.title)),
      );
      if (newcomer)
        return (
          `PLANS.md files "${newcomer.title}" directly under "## Done" with no done date — a plan ` +
          `written into the done section is invisible to every Planned reader; file it under ` +
          `"## Planned" instead`
        );
    }
    // A new headingless record cannot hide in a Fixed entry's body: reject a head whose
    // multi-block entries the base did not carry (an existing one never blocks unrelated
    // edits, matching the heading-set rules above). The Fix paragraph is the guard's unit, so
    // a merged second block would otherwise sit inside the neighbor it was symbol-checked
    // against.
    if (file === "BUGS.md") {
      const baseTitles = new Set(doubleBlockFixedEntries(base));
      const newcomer = doubleBlockFixedEntries(head).find((title) => !baseTitles.has(title));
      if (newcomer)
        return (
          `BUGS.md's Fixed entry "${newcomer}" holds more than one **Symptom:**/**Fix:** block — ` +
          `a record with no "### " heading has merged into it, so the hidden record is invisible ` +
          `to every section reader; give it its own "### " heading`
        );
    }
  }
  return undefined;
}

/** The clean loop's `<backlog-structure>` prompt block for the primary checkout at `root`
 * (the same root the telemetry digest and qa coverage blocks read): a rendered block listing
 * each stranded heading with its current section, or undefined when PLANS.md is missing,
 * unreadable, or clean — an unreadable or clean file gives no block, so the prompt is
 * unchanged in the common case. */
export function renderBacklogStructureBlock(root: string): string | undefined {
  // readTextOrNull never throws — an unreadable file arrives as null, its own contract.
  const md = readTextOrNull(path.join(root, "PLANS.md"));
  if (md === null) return undefined;
  const stranded = strandedPlanEntries(md);
  if (stranded.length === 0) return undefined;
  const listed = stranded
    .map((e) => `- (now under ## ${e.section}) ${e.title}`)
    .join("\n");
  // The task wording lives in the clean role's find text (src/roles/role-catalog.ts); the block
  // only carries the evidence, like the digest and coverage blocks do.
  return `Plan headings filed under the wrong section of PLANS.md — invisible to the readers
that scan one section, so no loop sees them as backlog work:
<backlog-structure>
${listed}
</backlog-structure>`;
}

/** One actionable backlog entry with the 1-based line range its text occupies in its file:
 * `start` is its `### ` heading line, `end` the last line before the next heading (or the
 * file's last line). */
interface ActionableEntryRange {
  title: string;
  start: number;
  end: number;
}

/** The entries under one `## <sectionTitle>` section with their 1-based line ranges, in file
 * order: the fence-aware walk sectionLines and parseEntryDetails share, carrying the line
 * numbers neither returns. An entry starts at a `### ` line and ends at the line before the
 * next `### ` or `## ` line (or EOF) — the same boundary parseEntryDetails closes bodies on —
 * so a loop reading lines `start`..`end` sees exactly the entry's heading and body. A `## ` or
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
      inSection = line.slice(3).trim() === sectionTitle;
    } else if (inSection && line.startsWith("### ")) {
      close(i);
      open = { title: line.slice(4).trim(), start: i + 1 };
    }
  }
  // A document ending in a newline splits to a trailing "" element; the last real line is one
  // less, so an entry running to EOF ends there instead of at the phantom line.
  close(md.endsWith("\n") ? lines.length - 1 : lines.length);
  return entries;
}

/** Max characters an index title keeps before a trailing ellipsis, so one very long BUGS.md
 * heading cannot dominate the block. */
const INDEX_TITLE_MAX = 160;

/** The index title for a `### ` heading: its stamp suffix (`(reported … 2026-…)`) removed via
 * the shared stripEntryStamp and whitespace collapsed, then clipped to INDEX_TITLE_MAX
 * through text.ts's truncate — the one ellipsis rule, so the cut cannot drift from the
 * other trimmed labels and never splits a surrogate pair. */
function indexTitle(heading: string): string {
  return truncate(collapseWhitespace(stripEntryStamp(heading)), INDEX_TITLE_MAX);
}

/** The index mark for an entry's eligibility hold (backlog-eligibility.ts's entryHold): empty
 * when eligible, a bracketed tag for the note holds, and the named prerequisites for a blocked
 * plan so the reading loop sees why. */
function holdMark(hold: EntryHold): string {
  if (hold === null) return "";
  if (hold === "refused") return " [refused]";
  if (hold === "needs-review") return " [needs review]";
  if (hold === "needs-replan") return " [needs replan]";
  return ` [blocked: requires ${hold.blockedBy.join(", ")}]`;
}

/** The files and sections the actionable index covers, in the order loops read them: PLANS.md's
 * planned features, BUGS.md's open bugs, QUESTIONS.md's open questions. */
const INDEX_SECTIONS: readonly { file: string; section: string }[] = [
  { file: "PLANS.md", section: "Planned" },
  { file: "BUGS.md", section: "Open" },
  { file: "QUESTIONS.md", section: "Open" },
];

/** One index file's rendered section lines, cached per file stat (stat-cache.cachedByStat):
 * both branches of every tick prompt render this block, and the backlog files — BUGS.md above
 * all, since its closed history grows without bound — change only at a landing. An unchanged
 * file then costs one stat per tick instead of a full read, a split into lines, and a
 * section walk proportional to the whole file. The value is the section's `file ## section`
 * header plus one line per entry, or `[]` when the section holds none; keyed by the file path
 * so distinct roots never collide. Bounded inside cachedByStat. */
const indexSectionCache = new Map<string, StatKeyedValue<string[]>>();

/** The `<backlog-index>` prompt block: each actionable entry (PLANS.md ## Planned, BUGS.md
 * ## Open, QUESTIONS.md ## Open) with its 1-based line range, rendered from the primary
 * checkout `root`. Replaces the per-tick `grep -n '^##'` heading map, whose pattern also matched
 * every `###` title in BUGS.md's closed history and so re-sent ~108 KB on every turn (BUGS.md
 * 2026-10-06). A missing or unreadable file contributes no sections; undefined when no section
 * has entries, so an empty backlog leaves the prompt unchanged. The per-file section lines are
 * stat-cached (indexSectionCache), so an unchanged backlog file is not re-read or re-walked. */
export function renderBacklogIndexBlock(root: string): string | undefined {
  const listed: string[] = [];
  for (const { file, section } of INDEX_SECTIONS) {
    const full = path.join(root, file);
    const lines = cachedByStat(
      indexSectionCache,
      full,
      full,
      () => {
        // readTextOrNull never throws — an unreadable file arrives as null, its own contract.
        const md = readTextOrNull(full);
        if (md === null) return null; // Unreadable: nothing to cache for this stat.
        const entries = actionableEntryRanges(md, section);
        if (entries.length === 0) return [];
        const lines = md.split(/\r?\n/);
        // A prerequisite clause lives in the heading, and only a Planned entry can name one, so
        // the Planned section holds its own reference set; the other sections have no series.
        const planned = section === "Planned" ? parseEntryDetails(md, section) : [];
        return [
          `${file} ## ${section}`,
          // A hold rides in the entry heading or body, not the index; reading both here lets the
          // mark reach both loops without either parsing the file. The body slice is the lines
          // after the heading through the last body line, so a note is found whether it sits
          // first or last (the heading is at 1-based line e.start).
          ...entries.map((e) => {
            const body = lines.slice(e.start, e.end).join("\n");
            const mark = holdMark(entryHold({ title: e.title, body }, planned));
            return `- ${e.start}-${e.end}: ${indexTitle(e.title)}${mark}`;
          }),
        ];
      },
      (v) => v.slice(), // A copy: callers may treat the result as their own.
    );
    if (lines) listed.push(...lines);
  }
  if (listed.length === 0) return undefined;
  return `Actionable backlog — each entry with the 1-based line range it occupies in its file.
Read the entries you need by those ranges; the files' closed sections make a full heading map
grow with every tick.
<backlog-index>
${listed.join("\n")}
</backlog-index>`;
}
