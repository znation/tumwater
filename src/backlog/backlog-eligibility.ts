// vocabulary: plain
/** Backlog eligibility: which PLANS.md / BUGS.md entries a work role may take now (plans,
 * parallel-work-instances, part 2/7). An entry is held when its body carries a **Refused …**,
 * **Needs review …**, **Needs replan …** or **Waiting for the next failure …** note, or when
 * its heading's trailing parenthetical
 * (or a parenthetical left open by a wrapped heading) names a prerequisite (`requires parts
 * 1/5–3/5 landed`) that is itself still listed under `## Planned`. The parsers are pure over
 * markdown text; `eligibleEntries` is the stat-backed reader for a caller that wants the list.
 * The backlog index marks every held entry so a role
 * skips it without re-deriving the rule. */

import path from "node:path";
import { statOrNull } from "../files/files.js";
import { allLiveClaims } from "../runner/runner-state.js";
import { collapseWhitespace } from "../text/text.js";
import { NEEDS_REPLAN_PREFIX, NEEDS_REVIEW_PREFIX, WAITING_FOR_FAILURE_PREFIX } from "../roles/role-guidance.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { roleLabel } from "../roles/role-labels.js";
import { openParenthetical, trailingParenthetical, type BacklogEntry } from "./backlog-md.js";
import { actionableEntryRangesFor, stripEntryStamp } from "./backlog-structure.js";
import { finishedFiles, openBugEntries, plannedPlanEntries } from "./backlog.js";

/** Why an entry is held, or null when it is eligible. `blockedBy` names the unmerged
 * prerequisites in the form `Series i/n` so a renderer can show `requires …`. */
export type EntryHold = "refused" | "needs-review" | "needs-replan" | "waiting-for-failure" | { blockedBy: string[] } | null;

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

/** A `series, part i/n` pair: the series name, the part token (`5`, or `2a` for the historical
 * lettered sub-plans) and the total. One shape for both an entry's own series (seriesPart) and
 * a prerequisite ref (requiredParts), so matching them is a field compare. */
export interface PartRef {
  series: string;
  part: string;
  of: number;
}

/** The `**Refused …` note prefix a refusing tick writes. Every hold note — this one and the
 * imported Needs-review and Needs-replan prefixes — is matched as a line prefix (hasNoteLine)
 * so a mention in prose never holds an entry. */
const REFUSED_PREFIX = "**Refused ";

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
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.startsWith(prefix));
  return line === undefined ? null : line.replace(/^\*\*/, "").replace("**", "");
}

/** The text of `body`'s Refused note, or null when it has none (entryHold's "refused" hold). */
export function refusalNote(body: string): string | null {
  return noteText(body, REFUSED_PREFIX);
}

/** The text of `body`'s Waiting-for-the-next-failure note, or null when it has none. */
export function waitingNote(body: string): string | null {
  return noteText(body, WAITING_FOR_FAILURE_PREFIX);
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

/** `lines` without any Refused note line. Every other line, Needs-review, needs-replan and
 * waiting notes included, is kept, so refusal lifting never lifts another hold. */
export function withoutRefusalNotes(lines: string[]): string[] {
  return withoutNoteLines(lines, REFUSED_PREFIX);
}

/** `lines` without any Waiting-for-the-next-failure note line, collapsing blank lines as
 * withoutRefusalNotes does. */
export function withoutWaitingNotes(lines: string[]): string[] {
  return withoutNoteLines(lines, WAITING_FOR_FAILURE_PREFIX);
}

/** One prerequisite ref, resolved against the entry's own series when it names none. */
function parseRef(chunk: string, ownSeries: string | null): PartRef[] {
  const text = chunk.trim().replace(/^parts?\s+/i, "");
  if (text === "") return [];
  const m = /^(?:([\s\S]+?)\s+)?([0-9]+[a-z]?)\/(\d+)(?:\s*[–-]\s*(\d+)\/(\d+))?$/i.exec(text);
  if (m === null) return [];
  const series = (m[1]?.trim() ?? "") || ownSeries;
  if (series === null || series === "") return [];
  const of = Number(m[3]);
  const start = m[2]!.toLowerCase();
  if (!Number.isInteger(of) || of < 1) return [];
  if (m[4] === undefined) return [{ series, part: start, of }];
  // A range is numeric on both ends (the lettered parts never range); expand it inclusively.
  const from = Number(start);
  const to = Number(m[4]);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return [];
  const parts: PartRef[] = [];
  for (let p = from; p <= to; p++) parts.push({ series, part: String(p), of });
  return parts;
}

/** The stable identity of an entry heading: its `(planned …)`/`(done …)` stamp suffix
 * removed through the shared stripEntryStamp, whitespace collapsed, lowercased. Adding a
 * done stamp or a Refused note therefore leaves the key unchanged. */
export function entryKey(title: string): string {
  return collapseWhitespace(stripEntryStamp(title)).toLowerCase();
}

/** An entry's own series and part from its heading, or null when the heading is not a
 * `<Series>, part i/n: …` title. The series is the text before `, part i/n:`. */
export function seriesPart(title: string): PartRef | null {
  const m = /^(.+?),\s*part\s+([0-9]+[a-z]?)\/(\d+)\s*:/i.exec(
    stripEntryStamp(title),
  );
  if (m === null) return null;
  const series = m[1]!.trim();
  if (series === "") return null;
  return { series, part: m[2]!.toLowerCase(), of: Number(m[3]) };
}

/** The one identity a PartRef matches by: lowercased series, verbatim part token. */
function partKey(series: string, part: string): string {
  return `${series.toLowerCase()}\u0000${part}`;
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

/** The prerequisite-set identities of the still-planned entries — seriesPart(title) of each,
 * keyed by partKey — built once for a batch and reused across every entry judged against it, so
 * judging n entries is n seriesPart parses rather than n² (entryHold rebuilt the set per entry).
 * Series compare case-insensitively and part tokens verbatim, exactly as entryHoldAgainst
 * matches them. */
export function plannedPartKeys(planned: readonly BacklogEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const p of planned) {
    const part = seriesPart(p.title);
    if (part !== null) keys.add(partKey(part.series, part.part));
  }
  return keys;
}

/** The doctor's count of a refusal's stranded dependents: the ascending indexes into `planned` of
 * the entries that require `planned[index]`'s own part, directly or through a chain of parts.
 * Matching is by partKey, as entryHoldAgainst matches. [] when that entry has no series part. A
 * dependency cycle ends the walk, and `index` itself is never listed. */
export function plansWaitingOn(planned: readonly BacklogEntry[], index: number): number[] {
  const root = planned[index];
  const own = root === undefined ? null : seriesPart(root.title);
  if (own === null) return [];
  const dependents = new Map<string, number[]>();
  planned.forEach((entry, i) => {
    if (seriesPart(entry.title) === null) return;
    for (const ref of requiredParts(entry.title)) {
      const key = partKey(ref.series, ref.part);
      dependents.set(key, [...(dependents.get(key) ?? []), i]);
    }
  });
  const seen = new Set<number>([index]);
  const queue = [partKey(own.series, own.part)];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    for (const i of dependents.get(key) ?? []) {
      if (seen.has(i)) continue;
      seen.add(i);
      const part = seriesPart(planned[i]!.title)!;
      queue.push(partKey(part.series, part.part));
    }
  }
  seen.delete(index);
  return [...seen].sort((a, b) => a - b);
}

/** The prerequisite parts a plan heading's trailing parenthetical (or, when the heading wraps
 * and the parenthetical stays open past the line, its open parenthetical) names through the clause
 * `requires <ref>((, | and )<ref>)* landed`, with each range (e.g. `parts 1/5–3/5`) expanded.
 * Returns [] when the heading has no such clause or the clause does not parse — an agent judges
 * an unparseable clause, exactly as it does today. Only the heading is read, never the body. */
export function requiredParts(title: string): PartRef[] {
  const clause = requiresClause(title);
  if (clause === null) return [];
  const ownSeries = seriesPart(title)?.series ?? null;
  const refs: PartRef[] = [];
  for (const chunk of clause.split(/\s*,\s*|\s+and\s+/i)) refs.push(...parseRef(chunk, ownSeries));
  return refs;
}

/** The ref text a heading's `requires <refs> landed` clause captures — read from the trailing
 * parenthetical, or the open one of a wrapped heading — or null when the heading has no such
 * clause. requiredParts parses it; planDependencyProblems uses it to spot a clause that parses to
 * nothing. */
function requiresClause(title: string): string | null {
  let meta = trailingParenthetical(title);
  if (meta === "") meta = openParenthetical(title);
  if (meta === "") return null;
  const m = /requires\s+(.+?)\s+landed\b/i.exec(meta); // vocabulary-ok: parses the requires … landed heading syntax
  return m === null ? null : m[1]!;
}

/** A dependency verb followed by a series part ref in a heading's parenthetical — the wording the
 * claim allocator ignores (BUGS.md 2026-10-14: a part headed "blocked by part 1/2 above" was handed
 * out six times while part 1/2 was in flight). planDependencyProblems reports each such ref. */
const MISWORDED_DEPENDENCY_RE = /\b(?:blocked by|blocked on|after|follows|depends on|waits on|waits for|once)\s+(?:the\s+)?(parts?\s+[0-9]+[a-z]?\/[0-9]+)/gi;

/** The mistakes in the planned entries' `requires … landed` clauses that the claim allocator
 * cannot see: `dangling` — a ref naming a part no planned or done heading carries (its hold is
 * void), `unparsed` — titles whose clause yields no refs, and `cycle` — the first dependency cycle
 * among planned `Series, part i/n:` entries as `Series i/n` names in walk order, first name
 * repeated last (a self-reference is a one-hop cycle), or null — and `misworded`: a series part
 * whose heading parenthetical names a still-planned part through a dependency verb ("blocked by
 * part 1/2") with no requires clause holding that part, so the allocator hands it out now.
 * Refused and needs-review entries count like the rest, since their clauses still decide when
 * they unblock. */
export function planDependencyProblems(
  planned: readonly BacklogEntry[],
  doneTitles: readonly string[],
): {
  cycle: string[] | null;
  dangling: Array<{ title: string; ref: string }>;
  unparsed: string[];
  misworded: Array<{ title: string; ref: string }>;
} {
  const known = plannedPartKeys(planned);
  for (const t of doneTitles) {
    const part = seriesPart(t);
    if (part !== null) known.add(partKey(part.series, part.part));
  }
  const dangling: Array<{ title: string; ref: string }> = [];
  const unparsed: string[] = [];
  const misworded: Array<{ title: string; ref: string }> = [];
  const plannedKeys = plannedPartKeys(planned);
  const nodes = new Map<string, { name: string; deps: string[] }>();
  for (const entry of planned) {
    const refs = requiredParts(entry.title);
    if (refs.length === 0 && requiresClause(entry.title) !== null) unparsed.push(entry.title);
    for (const ref of refs) {
      if (!known.has(partKey(ref.series, ref.part)))
        dangling.push({ title: entry.title, ref: `${ref.series} ${ref.part}/${ref.of}` });
    }
    const own = seriesPart(entry.title);
    if (own === null) continue;
    let meta = trailingParenthetical(entry.title);
    if (meta === "") meta = openParenthetical(entry.title);
    const held = new Set(refs.map((ref) => partKey(ref.series, ref.part)));
    for (const m of meta.matchAll(MISWORDED_DEPENDENCY_RE)) {
      for (const ref of parseRef(m[1]!, own.series)) {
        const key = partKey(ref.series, ref.part);
        if (!plannedKeys.has(key) || held.has(key)) continue;
        const name = `${ref.series} ${ref.part}/${ref.of}`;
        if (!misworded.some((w) => w.title === entry.title && w.ref === name)) misworded.push({ title: entry.title, ref: name });
      }
    }
    nodes.set(partKey(own.series, own.part), {
      name: `${own.series} ${own.part}/${own.of}`,
      deps: refs.map((ref) => partKey(ref.series, ref.part)),
    });
  }
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    state.set(key, "open");
    stack.push(key);
    for (const dep of nodes.get(key)!.deps) {
      if (!nodes.has(dep)) continue;
      const seen = state.get(dep);
      if (seen === "open") {
        return [...stack.slice(stack.indexOf(dep)), dep].map((k) => nodes.get(k)!.name);
      }
      if (seen === undefined) {
        const found = visit(dep);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(key, "done");
    return null;
  };
  let cycle: string[] | null = null;
  for (const key of nodes.keys()) {
    if (state.has(key)) continue;
    cycle = visit(key);
    if (cycle !== null) break;
  }
  return { cycle, dangling, unparsed, misworded };
}

/** The prerequisite refs of `title`'s `requires … landed` clause when none of them is still in
 * `plannedParts` (built by plannedPartKeys), else []. A heading with no parseable clause is never
 * reported, so only a refusal whose named prerequisites have all left `## Planned` reads as
 * possibly stale. */
export function prerequisitesMerged(title: string, plannedParts: ReadonlySet<string>): PartRef[] {
  const refs = requiredParts(title);
  return refs.some((ref) => plannedParts.has(partKey(ref.series, ref.part))) ? [] : refs;
}

/** Why `entry` is held against the still-`planned` entries, or null when it may be taken: a
 * `**Refused …` line (refused), a Needs-review line (needs-review), a Needs-replan line
 * (needs-replan — the plan role owns it), or a prerequisite `(series, part)` still among
 * `planned` ({ blockedBy }). Series compare case-insensitively; part tokens compare verbatim.
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
  if (hasNoteLine(entry.body, NEEDS_REVIEW_PREFIX)) return "needs-review";
  if (hasNoteLine(entry.body, NEEDS_REPLAN_PREFIX)) return "needs-replan";
  if (hasNoteLine(entry.body, WAITING_FOR_FAILURE_PREFIX)) return "waiting-for-failure";
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
  if (hold === "needs-replan") return " [blocked: needs replan]";
  if (hold === "waiting-for-failure") return " [blocked: waiting for the next failure]";
  return ` [blocked: requires ${hold.blockedBy.join(", ")}]`;
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

/** The verbatim titles of the planned plans, then the open bugs, whose hold is `"refused"`, in
 * file order: the entries that wait on an operator decision (the `refused` team alert's
 * input). Pairs backlogHolds' arrays with the entries the same readers return, like
 * backlogInProgress. A missing file yields `[]`. */
export function refusedEntryTitles(root: string): string[] {
  const holds = backlogHolds(root);
  const titlesOf = (entries: readonly BacklogEntry[], held: readonly (EntryHold | null)[]): string[] =>
    entries.filter((_, i) => held[i] === "refused").map((e) => e.title);
  return [
    ...titlesOf(plannedPlanEntries(root), holds.plans),
    ...titlesOf(openBugEntries(root), holds.bugs),
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

/** The entries `role` may take now, in file order: PLANS.md's `## Planned` entries for
 * feature, BUGS.md's `## Open` entries for bugfix, minus every entry entryHold holds, each with
 * its stamp-free key, verbatim title and 1-based line range. Reads the primary checkout through
 * the same stat-cached readers the index uses; a missing or unreadable file yields []. */
export function eligibleEntries(root: string, role: string): EligibleEntry[] {
  // An instance id (`bugfix-2`) resolves through its base role, exactly as claims.ts's
  // roleSection does, so a claim's line range is read from the right file.
  const bugfix = baseRoleOf(role) === "bugfix";
  const file = bugfix ? "BUGS.md" : "PLANS.md";
  const section = bugfix ? "Open" : "Planned";
  const entries = bugfix ? openBugEntries(root) : plannedPlanEntries(root);
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
