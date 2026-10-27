/** Backlog series parts: the `Series, part i/n` identity of a plan heading and the dependency
 * graph the `requires parts … landed` clauses form among the planned entries. Pure over heading
 * text and entry lists; the hold rules built on them live in backlog-eligibility.ts. */

import { collapseWhitespace } from "../text/text.js";
import { openParenthetical, trailingParenthetical, type BacklogEntry } from "./backlog-md.js";
import { stripEntryStamp } from "./backlog-structure.js";

/** A `series, part i/n` pair: the series name, the part token (`5`, or `2a` for the historical
 * lettered sub-plans) and the total. One shape for both an entry's own series (seriesPart) and
 * a prerequisite ref (requiredParts), so matching them is a field compare. */
export interface PartRef {
  series: string;
  part: string;
  of: number;
}

/** One prerequisite chunk: its refs resolved against `fallbackSeries` (the last series the clause
 * named, or the entry's own when it named none), and the series this chunk names — null when it
 * names none (a bare `parts a/n` inherits the surrounding clause's series). The series keyword
 * `parts`/`part` belongs to neither a named series nor the bare ref, so a trailing one is dropped
 * from a captured name. */
function parseRef(chunk: string, fallbackSeries: string | null): { refs: PartRef[]; named: string | null } {
  const text = chunk.trim().replace(/^parts?\s+/i, "");
  if (text === "") return { refs: [], named: null };
  const m = /^(?:([\s\S]+?)\s+)?([0-9]+[a-z]?)\/(\d+)(?:\s*[–-]\s*(\d+)\/(\d+))?$/i.exec(text);
  if (m === null) return { refs: [], named: null };
  const { named, series } = resolveRefSeries(m[1], fallbackSeries);
  const of = Number(m[3]);
  if (series === null || !Number.isInteger(of) || of < 1) return { refs: [], named };
  return { refs: refsFromMatch(series, of, m[2]!, m[4] ?? null), named };
}

/** Whichever series a ref chunk resolves to: a captured name with any trailing `parts`/`part`
 * keyword dropped, or — for a bare `parts a/n` — the clause's last-named series (null when it
 * named none, so a bare ref there resolves to nothing). */
function resolveRefSeries(matchName: string | undefined, fallbackSeries: string | null): { named: string | null; series: string | null } {
  const named = (matchName?.trim() ?? "").replace(/\s+parts?$/i, "");
  if (named !== "") return { named, series: named };
  return { named: null, series: fallbackSeries === "" ? null : fallbackSeries };
}

/** Build the resolved refs for a chunk whose regex matched: the one part, or an inclusive
 * numeric range. The part token arrives verbatim (so `2a` survives); a range is numeric on
 * both ends (the lettered parts never range) and expands to that many single refs. */
function refsFromMatch(series: string, of: number, startText: string, toText: string | null): PartRef[] {
  const start = startText.toLowerCase();
  if (toText === null) return [{ series, part: start, of }];
  // A range is numeric on both ends (the lettered parts never range); expand it inclusively.
  const from = Number(start);
  const to = Number(toText);
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
export function partKey(series: string, part: string): string {
  return `${series.toLowerCase()}\u0000${part}`;
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

/** The planned parts a cancel released: the 1-based positions and stamp-free titles of the entries
 * in `planned` (read after the cancel) whose requiredParts name the cancelled title's part, by
 * partKey. Only direct dependents count — a part further down the chain is still held by its own
 * prerequisite. [] when the title has no series part, or when another planned entry still carries
 * the same part key, because the dependents are then still held. */
export function plansReleasedBy(planned: readonly BacklogEntry[], cancelledTitle: string): { position: number; title: string }[] {
  const own = seriesPart(cancelledTitle);
  if (own === null) return [];
  const key = partKey(own.series, own.part);
  if (plannedPartKeys(planned).has(key)) return [];
  const released: { position: number; title: string }[] = [];
  planned.forEach((entry, i) => {
    if (requiredParts(entry.title).some((ref) => partKey(ref.series, ref.part) === key)) {
      released.push({ position: i + 1, title: stripEntryStamp(entry.title) });
    }
  });
  return released;
}

/** The note a plan cancel adds for plansReleasedBy's result: "" for none, else the positions and
 * titles of the parts that no longer wait, and the command that cancels one. */
export function releasedPartsNote(parts: readonly { position: number; title: string }[]): string {
  if (parts.length === 0) return "";
  const tail = " — cancel what cannot stand alone with `tumwater plan --cancel <n>`";
  const titles = parts.map((p) => p.title).join("; ");
  if (parts.length === 1) return `plan #${parts[0]!.position} required it and no longer waits on it: ${titles}${tail}`;
  return `plans ${parts.map((p) => `#${p.position}`).join(", ")} required it and no longer wait on them: ${titles}${tail}`;
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
  let lastNamed: string | null = null;
  for (const chunk of clause.split(/\s*,\s*|\s+and\s+/i)) {
    const { refs: chunkRefs, named } = parseRef(chunk, lastNamed ?? ownSeries);
    if (named !== null) lastNamed = named;
    refs.push(...chunkRefs);
  }
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
      for (const ref of parseRef(m[1]!, own.series).refs) {
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
