/** Renders the `<backlog-index>` prompt block every role prompt carries — each actionable
 * entry (PLANS.md ## Planned, BUGS.md ## Open, QUESTIONS.md ## Open) plus the newest closed
 * ones, each with the 1-based line range it occupies in its file — the bounded replacement for
 * the per-run `grep -n '^##'` heading map. The entry-range parsing (actionableEntryRanges) and
 * series collapsing (groupBlockedSeries, partsLabel) it builds on live in backlog-structure.ts
 * alongside the stranded-plan checks; this module holds only the block's rendering and its
 * per-file stat caches. Extracted from backlog-structure.ts (organized 2026-10-19) so that
 * module no longer carries a second responsibility. */
import path from "node:path";
import { cachedTextByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { FINISHED_ARCHIVES } from "./backlog-md.js";
import { allLiveClaims } from "../runner/runner-state-load.js";
import { collapseWhitespace, truncate } from "../text/text.js";
import {
  actionableEntryRanges,
  groupBlockedSeries,
  partsLabel,
  stripEntryStamp,
  type ActionableEntryRange,
  type SeriesRow,
} from "./backlog-structure.js";
import { entryHoldAgainst, holdMark, plannedPartKeys } from "./backlog-eligibility.js";
import { plannedPlanEntries } from "./backlog.js";

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

/** The files and sections the actionable index covers, in the order roles read them: PLANS.md's
 * planned features, BUGS.md's open bugs, QUESTIONS.md's open questions. */
const INDEX_SECTIONS: readonly { file: string; section: string }[] = [
  { file: "PLANS.md", section: "Planned" },
  { file: "BUGS.md", section: "Open" },
  { file: "QUESTIONS.md", section: "Open" },
];

/** How many closed entries per closed section the index lists. */
const RECENT_CLOSED_MAX = 5;

/** The closed sections whose newest entries the index also lists, each read from the live file
 * and then its archive (FINISHED_ARCHIVES, plans/backlog-archive.md); every one keeps its entries
 * newest first, so the first entries in file order are the recent ones. */
const CLOSED_SECTIONS: readonly { files: readonly string[]; section: string }[] = FINISHED_ARCHIVES.map((a) => ({
  files: [a.file, a.archive],
  section: a.section,
}));

/** One actionable entry as the index renders it: the 1-based range the role reads, the verbatim
 * heading, and the body a hold note is read from. Cached per file stat
 * (stat-cache.cachedTextByStat): both branches of every run prompt render this block, and the
 * backlog files — BUGS.md above all, since its closed history grows without bound — change only at
 * a merge. An unchanged file then costs one stat per run instead of a full read, a split into
 * lines, and a section walk proportional to the whole file. The eligibility mark is applied after
 * the cache, against the section-independent prerequisite set; the cache is keyed by the file path
 * so distinct roots never collide, and bounded inside cachedTextByStat. */
interface IndexEntry {
  start: number;
  end: number;
  title: string;
  body: string;
}

/** Per-file cache of the parsed actionable entries (indexSectionCache). */
const indexSectionCache = new Map<string, StatKeyedValue<IndexEntry[]>>();

/** Per-file cache of the newest closed entries' ranges; separate from indexSectionCache, which is
 * keyed by the file path alone and PLANS.md would collide. */
const closedSectionCache = new Map<string, StatKeyedValue<ActionableEntryRange[]>>();

/** One actionable entry as the index renders it into a line before series-collapsing: the
 * 1-based range, the verbatim heading, its eligibility hold, and the live claimer (if any).
 * collapseBlockedSeries groups these; renderIndexRow turns one into a buffer line. */
interface IndexRow extends SeriesRow {
  start: number;
  end: number;
  mark: string;
}


/** One `IndexRow` as an ordinary index line: range, truncated stamp-free title, hold mark, and
 * the in-flight suffix when a live claim names it. The collapsed-series line is built by
 * collapseBlockedSeries, returned alongside these. */
function renderIndexRow(row: IndexRow): string {
  return `- ${row.start}-${row.end}: ${indexTitle(row.title)}${row.mark}${row.claimer ? ` [in flight by ${row.claimer}]` : ""}`;
}


function collapseBlockedSeries(rows: readonly IndexRow[]): string[] {
  return groupBlockedSeries(rows).map((g) => {
    if (g.kind === "row") return renderIndexRow(g.row);
    const first = g.rows[0]!;
    const last = g.rows[g.rows.length - 1]!;
    return (
      `- ${first.start}-${last.end}: ${indexTitle(g.series)}, ${g.rows.length} blocked parts ` +
      `(${partsLabel(g.rows)}) [blocked: each waits on an earlier part]`
    );
  });
}


/** The `<backlog-index>` prompt block: each actionable entry (PLANS.md ## Planned, BUGS.md
 * ## Open, QUESTIONS.md ## Open) with its 1-based line range, rendered from the primary
 * checkout `root`. Replaces the per-run `grep -n '^##'` heading map, whose pattern also matched
 * every `###` title in BUGS.md's closed history and so re-sent ~108 KB on every turn (BUGS.md
 * 2026-10-06). A missing or unreadable file contributes no sections; undefined when no section
 * has entries, so an empty backlog leaves the prompt unchanged. The per-file actionable entries
 * are stat-cached (indexSectionCache), so an unchanged backlog file is not re-read or re-walked. */
export function renderBacklogIndexBlock(root: string): string | undefined {
  // The still-planned set every section's holds are judged against. A prerequisite clause rides
  // in the entry heading, and the eligibility gate (backlog-eligibility.ts's eligibleEntries)
  // and `tumwater backlog`'s holds read it for BUGS.md's Open entries too, so the same set must
  // reach this block's Open section as well — otherwise a held bug reads as eligible here while
  // the gate skips it. plannedPlanEntries is stat-cached by sectionEntries, so an unchanged
  // PLANS.md costs one stat per call.
  const planned = plannedPlanEntries(root);
  const plannedParts = plannedPartKeys(planned);
  // The cross-role in-flight hold (BUGS.md 2026-10-09): every role's prompts share this one
  // section-agnostic index, and the role it is assembled for is not available here, so an entry
  // claimed by ANY role is marked in flight — the owner's own index marks it too, which is harmless
  // (its assignment note is the instruction), and every other role reads it as taken instead of
  // re-implementing a change someone's merge is already carrying to main.
  const claimed = allLiveClaims(root);
  const listed: string[] = [];
  for (const { file, section } of INDEX_SECTIONS) {
    const full = path.join(root, file);
    const entries = cachedTextByStat(
      indexSectionCache,
      full,
      full,
      (md) => {
        const ranges = actionableEntryRanges(md, section);
        if (ranges.length === 0) return [];
        const lines = md.split(/\r?\n/);
        // The body slice is the lines after the heading through the last body line, so a note
        // is found whether it sits first or last (the heading is at 1-based line e.start).
        return ranges.map((e) => ({
          start: e.start,
          end: e.end,
          title: e.title,
          body: lines.slice(e.start, e.end).join("\n"),
        }));
      },
      (v) => v.slice(), // A copy: callers may treat the result as their own.
    );
    if (entries === null || entries.length === 0) continue;
    listed.push(`${file} ## ${section}`);
    // Build the rows once per section, then collapse a PLANS.md series' blocked parts (this
    // plan) — BUGS.md and QUESTIONS.md sections keep every entry on its own line.
    const rows: IndexRow[] = entries.map((e) => {
      const hold = entryHoldAgainst({ title: e.title, body: e.body }, plannedParts);
      const key = collapseWhitespace(stripEntryStamp(e.title)).toLowerCase();
      return {
        start: e.start,
        end: e.end,
        title: e.title,
        hold,
        mark: holdMark(hold),
        claimer: claimed.get(key),
      };
    });
    const isPlans = file === "PLANS.md" && section === "Planned";
    listed.push(...(isPlans ? collapseBlockedSeries(rows) : rows.map(renderIndexRow)));
  }
  for (const { files, section } of CLOSED_SECTIONS) {
    // The newest RECENT_CLOSED_MAX across the live section (normally empty) and the archive.
    let room = RECENT_CLOSED_MAX;
    for (const file of files) {
      if (room <= 0) break;
      const full = path.join(root, file);
      const entries = cachedTextByStat(
        closedSectionCache,
        full,
        full,
        (md) => actionableEntryRanges(md, section).slice(0, RECENT_CLOSED_MAX),
        (v) => v.slice(),
      )?.slice(0, room);
      if (entries === undefined || entries.length === 0) continue;
      room -= entries.length;
      listed.push(`${file} ## ${section} (newest ${entries.length})`);
      for (const e of entries) listed.push(`- ${e.start}-${e.end}: ${indexTitle(e.title)}`);
    }
  }
  if (listed.length === 0) return undefined;
  return `Backlog index — each actionable entry, then the newest closed ones, with the 1-based line range it occupies in its file.
Read the entries you need by those ranges; the archive files (PLANS-DONE.md, BUGS-FIXED.md) grow
with every merge, so search them rather than reading them. Blocked parts of a multi-part series are
shown as one line per series.
<backlog-index>
${listed.join("\n")}
</backlog-index>`;
}
