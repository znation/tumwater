// vocabulary: plain
import path from "node:path";
import { cachedTextByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { truncate } from "../text/text.js";
import { refusalNote } from "./backlog-eligibility.js";
import { actionableEntryRanges, type ActionableEntryRange } from "./backlog-structure.js";

/** How many of a closed section's newest entries the steward's compression policy keeps in full. */
const RECORDS_KEPT_FULL = 10;

/** How many of the oldest full entries the steward prompt lists by line range. */
const OLDEST_LISTED = 10;

/** One closed section's count of full entries past the policy's kept ten. */
interface RecordsOverflow {
  file: string;
  section: string;
  /** Every `### ` entry the section holds. */
  full: number;
  /** Entries past the kept ten that carry a Refused note and so stay full. */
  refused: number;
  /** The bottom `OLDEST_LISTED` compressible entries, in file order. */
  oldest: ActionableEntryRange[];
  /** Entries past the kept ten that compression applies to. */
  over: number;
}

/** The overflow of `section` in `md`, or null when no compressible entry lies past the newest
 * ten. Entries sit newest first, so the first `RECORDS_KEPT_FULL` are kept; older ones with a
 * Refused note in their body stay full and are only counted. */
export function recordsOverflow(md: string, file: string, section: string): RecordsOverflow | null {
  const entries = actionableEntryRanges(md, section);
  const lines = md.split("\n");
  const candidates: ActionableEntryRange[] = [];
  let refused = 0;
  for (const entry of entries.slice(RECORDS_KEPT_FULL)) {
    const body = lines.slice(entry.start, entry.end).join("\n");
    if (refusalNote(body) !== null) refused++;
    else candidates.push(entry);
  }
  if (candidates.length === 0) return null;
  return {
    file,
    section,
    full: entries.length,
    refused,
    oldest: candidates.slice(-OLDEST_LISTED),
    over: candidates.length,
  };
}

/** Per-file-and-section cache of the overflow (renderRecordsOverflowBlock). */
const overflowCache = new Map<string, StatKeyedValue<RecordsOverflow | null>>();

function paragraph(o: RecordsOverflow): string {
  const stays = o.refused > 0 ? ` (${o.refused} more carries a Refused note and stays full)` : "";
  const rows = o.oldest.map((e) => `- ${e.start}-${e.end}: ${truncate(e.title, 120)}`);
  return [
    `${o.file} ## ${o.section}: ${o.full} full entries, ${o.over} past the ${RECORDS_KEPT_FULL} kept${stays}. Oldest, by line range:`,
    ...rows,
  ].join("\n");
}

/** The steward's `<records-overflow>` prompt block for the checkout at `root`: PLANS.md `## Done`
 * then BUGS.md `## Fixed`, each present only when entries lie past the compression policy.
 * Stat-cached per file, so an unchanged file costs one stat. Undefined when neither file
 * contributes (including missing or unreadable files). */
export function renderRecordsOverflowBlock(root: string): string | undefined {
  const paragraphs: string[] = [];
  for (const [file, section] of [["PLANS.md", "Done"], ["BUGS.md", "Fixed"]] as const) {
    const filePath = path.join(root, file);
    const overflow = cachedTextByStat(
      overflowCache,
      `${filePath}#${section}`,
      filePath,
      (md) => recordsOverflow(md, file, section),
      (o) => (o === null ? null : { ...o, oldest: o.oldest.slice() }),
    );
    if (overflow) paragraphs.push(paragraph(overflow));
  }
  if (paragraphs.length === 0) return undefined;
  return [
    `Closed backlog sections holding more full entries than the ${RECORDS_KEPT_FULL} most recent your compression policy keeps:`,
    "<records-overflow>",
    paragraphs.join("\n\n"),
    "</records-overflow>",
  ].join("\n");
}
