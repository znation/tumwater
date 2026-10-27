/** The live backlog state a role's notes are checked against, so a note cannot keep a belief the
 * backlog has lifted. Role notes are free text carried into every later run and rewritten from
 * the previous note; when a note states something about the backlog (an entry is refused, a
 * series is dead, a part is done) nothing used to check that claim again — on 2026-10-21 a plan
 * run wrote "Codex 2b/9 carry Refused — never re-add or re-author them; the Codex theme is dead",
 * then both Refused notes became Needs-review notes the plan role exists to act on, but its own
 * notes kept telling it to skip them and the series stalled. This module renders, from the notes
 * and the live backlog, a short block saying what is currently true of each entry and series the
 * notes name, so the live state wins without anyone editing a notes file.
 *
 * Naming is a pure function of the notes text, case-insensitive on word boundaries:
 *  - a series among the planned entries is named by its full name, or by its first word when no
 *    other live series shares that first word;
 *  - a line holding a series token and a `i/n` part ref of that series names that part;
 *  - a line holding a series token and no part ref names the series;
 *  - a line holding, in order, the first six words of a planned entry's or Open bug's title
 *    names that entry.
 * Each named planned part carries its eligibility hold (entryHoldAgainst); a part in
 * PLANS-DONE.md reads `done`, a part found nowhere reads `not in the backlog`. Each named series
 * gets one summary line of its planned-part state. The block is at most 12 lines and, when the
 * notes name more items than fit, its last line says how many were dropped (`… and N more named
 * items`) so a dropped item cannot read as a complete answer; it returns undefined when the notes
 * name nothing live. */

import { entryHoldAgainst, type EntryHold } from "../backlog/backlog-eligibility.js";
import type { BacklogEntry } from "../backlog/backlog-md.js";
import { entryKey, partKey, plannedPartKeys, seriesPart } from "../backlog/backlog-parts.js";
import { plural } from "../text/phrases.js";
import { collapseWhitespace, escapeRegExp } from "../text/text.js";

/** The live backlog a note's claims are checked against: the planned entries in file order, the
 * Open bugs in file order, and the done plan titles (PLANS.md plus PLANS-DONE.md). */
export interface NotesBacklog {
  planned: BacklogEntry[];
  openBugs: BacklogEntry[];
  donePlanTitles: string[];
}

/** One live series' state and its known parts, keyed by lowercased series name. */
interface SeriesInfo {
  name: string;
  of: number;
  plannedCount: number;
  review: number;
  waiting: number;
  refused: number;
  /** partKeys of the still-planned parts, each to its hold. */
  holds: Map<string, EntryHold>;
  /** partKeys of the parts found in donePlanTitles. */
  done: Set<string>;
}

/** The per-part state a named part renders: its planned hold, `done`, or `not in the backlog`. */
type PartState = EntryHold | "done" | "not-in-backlog";

/** A part the notes name, with the live state it renders. */
interface NamedPart {
  seriesLower: string;
  part: string;
  of: number;
  state: PartState;
}

/** A planned entry or bug the notes name, with the live state it renders. */
interface NamedEntry {
  title: string;
  file: "plans" | "bugs";
  state: PartState;
}

const MAX_BLOCK_LINES = 12;
const HEADER =
  "What the backlog says now about entries your notes name (PLANS.md and BUGS.md as of this run; where your notes disagree, this is current):";

/** Build the per-series state maps from the planned entries and done titles. Holds are judged
 * against all planned parts (cross-series prerequisites count too), exactly as entryHoldAgainst
 * does, so a part that waits on another series reads `waits on …`. */
function seriesInfos(planned: readonly BacklogEntry[], doneTitles: readonly string[]): Map<string, SeriesInfo> {
  const allParts = plannedPartKeys(planned);
  const map = new Map<string, SeriesInfo>();
  for (const entry of planned) {
    const part = seriesPart(entry.title);
    if (part === null) continue;
    const key = partKey(part.series, part.part);
    let info = map.get(part.series.toLowerCase());
    if (info === undefined) {
      info = { name: part.series, of: part.of, plannedCount: 0, review: 0, waiting: 0, refused: 0, holds: new Map(), done: new Set() };
      map.set(part.series.toLowerCase(), info);
    }
    info.plannedCount++;
    const hold = entryHoldAgainst(entry, allParts);
    info.holds.set(key, hold);
    if (hold === "needs-review") info.review++;
    else if (hold === "refused") info.refused++;
    else if (typeof hold === "object" && hold !== null) info.waiting++;
  }
  for (const title of doneTitles) {
    const part = seriesPart(title);
    if (part === null) continue;
    const info = map.get(part.series.toLowerCase());
    if (info !== undefined) info.done.add(partKey(part.series, part.part));
  }
  return map;
}

/** The first word of a series name, lowercased. */
function firstWord(name: string): string {
  return name.toLowerCase().split(/\s+/)[0]!;
}

/** Whether `lowerLine` contains `token` on word boundaries (both already lowercased). */
function lineHas(lowerLine: string, token: string): boolean {
  const quoted = escapeRegExp(token);
  return new RegExp(`\\b${quoted}\\b`).test(lowerLine);
}

/** The `i/n` part refs in a line, numerators lowercased. */
function partRefsInLine(line: string): Array<{ part: string; of: number }> {
  const out: Array<{ part: string; of: number }> = [];
  const re = /\b([0-9]+[a-z]?)\/([0-9]+)\b/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    out.push({ part: m[1]!.toLowerCase(), of: Number(m[2]) });
  }
  return out;
}

/** The first six words of an entry title, entryKey-normalized (stamp stripped, whitespace
 * collapsed, lowercased). */
function firstSixWords(normalizedKey: string): string {
  return normalizedKey.split(/\s+/).slice(0, 6).join(" ");
}

/** The wording of one named item's state: an eligibility hold, `done`, or `not in the backlog`. */
function holdWording(state: PartState): string {
  if (state === "done") return "done";
  if (state === "not-in-backlog") return "not in the backlog";
  if (state === null) return "eligible";
  if (state === "refused") return "refused (only the operator clears it)"; // vocabulary-ok: the plan-mandated refused hold wording refers to the tumwater operator
  if (state === "needs-review") return "needs review";
  return `waits on ${state.blockedBy.join(", ")}`;
}

/** The one summary line of a named series' planned-part state. */
function seriesSummary(info: SeriesInfo): string {
  const counts: string[] = [];
  if (info.review > 0) counts.push(plural(info.review, "needs review", "need review"));
  if (info.waiting > 0) counts.push(`${plural(info.waiting, "waits", "wait")} on an earlier part`);
  counts.push(info.refused === 0 ? "none refused" : `${info.refused} refused`);
  return `${plural(info.plannedCount, "part")} planned: ${counts.join(", ")}`;
}

/** Index each live series' first word to its count, so a bare first word names a series only
 * when no other live series shares it. */
function firstWordCountsOf(series: Map<string, SeriesInfo>): Map<string, number> {
  const firstWordCounts = new Map<string, number>();
  for (const info of series.values()) {
    const w = firstWord(info.name);
    firstWordCounts.set(w, (firstWordCounts.get(w) ?? 0) + 1);
  }
  return firstWordCounts;
}

/** The state a named part renders for one part key: its planned hold, `done`, or `not in the
 * backlog`. */
function partStateOf(info: SeriesInfo, key: string): PartState {
  return info.holds.has(key) ? info.holds.get(key)! : info.done.has(key) ? "done" : "not-in-backlog";
}

/** Name the live series a line mentions: by full name, or by its sole-shared first word; the
 * `i/n` part refs of that series fill `namedParts` (under a `\u0000`-joined key) and a line with
 * a series token but no part ref names the series. */
function nameSeriesInLine(
  line: string,
  series: Map<string, SeriesInfo>,
  firstWordCounts: Map<string, number>,
  namedSeries: Set<string>,
  namedParts: Map<string, NamedPart>,
): void {
  for (const [sLower, info] of series) {
    const hasFull = lineHas(line, info.name.toLowerCase());
    const fw = firstWord(info.name);
    const hasFirst = firstWordCounts.get(fw) === 1 && lineHas(line, fw);
    if (!hasFull && !hasFirst) continue;
    const refs = partRefsInLine(line).filter((r) => r.of === info.of);
    if (refs.length === 0) {
      namedSeries.add(sLower);
    } else {
      for (const r of refs) {
        const state = partStateOf(info, partKey(info.name, r.part));
        namedParts.set(`${sLower}\u0000${r.part}\u0000${r.of}`, { seriesLower: sLower, part: r.part, of: r.of, state });
      }
    }
  }
}

/** Name a planned entry or Open bug whose first six words (entryKey-normalized) appear in the
 * line. */
function nameEntriesInLine(
  line: string,
  allEntries: readonly BacklogEntry[],
  allParts: ReadonlySet<string>,
  plannedCount: number,
  namedEntries: Map<string, NamedEntry>,
): void {
  for (const [i, entry] of allEntries.entries()) {
    const phrase = firstSixWords(entryKey(entry.title));
    if (phrase !== "" && line.includes(phrase)) {
      namedEntries.set(entryKey(entry.title), { title: entry.title, file: i < plannedCount ? "plans" : "bugs", state: entryHoldAgainst(entry, allParts) });
    }
  }
}

/** Render the named series summaries, part lines and entry lines, truncating to `MAX_BLOCK_LINES`
 * with a remainder line naming the dropped items; undefined when nothing live was named. */
function renderNamedItems(
  namedSeries: Set<string>,
  namedParts: Map<string, NamedPart>,
  namedEntries: Map<string, NamedEntry>,
  series: Map<string, SeriesInfo>,
): string | undefined {
  const lines: string[] = [];
  for (const sLower of namedSeries) {
    const info = series.get(sLower);
    if (info !== undefined) lines.push(`- ${info.name} — ${seriesSummary(info)}`);
  }
  for (const p of namedParts.values()) {
    const info = series.get(p.seriesLower);
    if (info === undefined) continue;
    lines.push(`- ${info.name}, part ${p.part}/${p.of} — ${holdWording(p.state)}`);
  }
  for (const entry of namedEntries.values()) lines.push(`- ${entry.title} — ${holdWording(entry.state)}`);
  if (lines.length === 0) return undefined;
  const cap = MAX_BLOCK_LINES - 1; // the item lines; the header is the twelfth line
  if (lines.length <= cap) return [HEADER, ...lines].join("\n");
  const shown = lines.slice(0, cap - 1);
  return [HEADER, ...shown, `… and ${plural(lines.length - shown.length, "more named item")}`].join("\n");
}

/** Build the live backlog block: index each series' first word (`firstWordCountsOf`), read every
 * notes line naming the series, parts and entries it mentions (`nameSeriesInLine`/
 * `nameEntriesInLine`), then render and truncate the names (`renderNamedItems`). Returns undefined
 * when the notes name nothing live. */
export function notesBacklogBlock(notes: string, backlog: NotesBacklog): string | undefined {
  const { planned, openBugs, donePlanTitles } = backlog;
  const series = seriesInfos(planned, donePlanTitles);
  const allParts = plannedPartKeys(planned);
  const firstWordCounts = firstWordCountsOf(series);
  const allEntries = [...planned, ...openBugs];
  const namedSeries = new Set<string>();
  const namedParts = new Map<string, NamedPart>();
  const namedEntries = new Map<string, NamedEntry>();

  for (const rawLine of notes.split("\n")) {
    const line = collapseWhitespace(rawLine).toLowerCase();
    if (line === "") continue;
    nameSeriesInLine(line, series, firstWordCounts, namedSeries, namedParts);
    nameEntriesInLine(line, allEntries, allParts, planned.length, namedEntries);
  }
  return renderNamedItems(namedSeries, namedParts, namedEntries, series);
}
