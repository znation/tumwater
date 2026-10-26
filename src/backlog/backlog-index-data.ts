/** The data half of the `<backlog-index>` block every role prompt carries: the 1-based line
 * ranges each actionable entry occupies in its file (actionableEntryRanges/
 * actionableEntryRangesFor) and the collapsed blocked-series rows
 * (groupBlockedSeries/partsLabel) that back it. Extracted from backlog-structure.ts
 * (organized 2026-10-25) so that module keeps only the backlog's structural-correctness checks
 * (stranded plans, duplicate and readded headings, the new-plan-under-Done gate) and this one
 * holds what the multiple index readers share — the role prompt's index block
 * (backlog-index.ts), the eligibility and claims readers, the archive, write and release
 * paths, and the status/tui surfaces all ask for the same section walk of the same file, so
 * the stat-cached range walk (actionableEntryRangesFor) is the one shared helper. The walk
 * and series grouping are pure markdown reading — no pi, no git. Rendering of the block
 * lives in backlog-index.ts; this module holds only the data the surfaces share. */
import path from "node:path";
import { cachedTextByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { fenceTracker, headingTitle } from "./backlog-md.js";
import type { EntryHold } from "./backlog-eligibility.js";
import { seriesPart, type PartRef } from "./backlog-parts.js";
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
 * unmerged prerequisite (`{ blockedBy }`, not a Refused/needs-review note) and no live
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
 * (Refused/needs-review) part and a claimed part keep their ordinary lines, so the
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

