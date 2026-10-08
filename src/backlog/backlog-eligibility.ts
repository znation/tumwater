/** Backlog eligibility: which PLANS.md / BUGS.md entries a work loop may take now (plans,
 * parallel-work-instances, part 2/7). An entry is held when its body carries a **Refused …**,
 * **Needs review …** or **Needs replan …** note, or when its heading's trailing parenthetical
 * names a prerequisite (`requires parts 1/5–3/5 landed`) that is itself still listed under
 * `## Planned`. The parsers are pure over markdown text; `eligibleEntries` is the stat-backed
 * reader for a caller that wants the list. The backlog index marks every held entry so a loop
 * skips it without re-deriving the rule. */

import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import { collapseWhitespace } from "../text/text.js";
import { NEEDS_REPLAN_PREFIX, NEEDS_REVIEW_PREFIX } from "../roles/role-guidance.js";
import { trailingParenthetical, type BacklogEntry } from "./backlog-md.js";
import { actionableEntryRanges, stripEntryStamp } from "./backlog-structure.js";
import { openBugEntries, plannedPlanEntries } from "./backlog.js";

/** Why an entry is held, or null when it is eligible. `blockedBy` names the unlanded
 * prerequisites in the form `Series i/n` so a renderer can show `requires …`. */
export type EntryHold = "refused" | "needs-review" | "needs-replan" | { blockedBy: string[] } | null;

/** One entry the reader may take: `key` is the stamp-free identity a claim can match on
 * (entryKey), `title` the verbatim heading, and `start`/`end` the 1-based line range the loop
 * reads by, exactly as the `<backlog-index>` block shows it. */
export interface EligibleEntry {
  key: string;
  title: string;
  start: number;
  end: number;
}

/** A `series, part i/n` pair: the series name, the part token (`5`, or `2a` for the historical
 * lettered sub-plans) and the total. One shape for both an entry's own series (seriesPart) and
 * a prerequisite ref (requiredParts), so matching them is a field compare. */
export interface PartRef {
  series: string;
  part: string;
  of: number;
}

/** The markdown note prefix the feature loop writes for a plan too large for one run, and the
 * `**Refused …` note prefix a refusing tick writes — matched as line prefixes so a mention in
 * prose never holds an entry. */
const REFUSED_PREFIX = "**Refused ";

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

/** The prerequisite parts a plan heading's trailing parenthetical names through the clause
 * `requires <ref>((, | and )<ref>)* landed`, with each range (e.g. `parts 1/5–3/5`) expanded.
 * Returns [] when the heading has no such clause or the clause does not parse — an agent judges
 * an unparseable clause, exactly as it does today. Only the heading is read, never the body. */
export function requiredParts(title: string): PartRef[] {
  const meta = trailingParenthetical(title);
  if (meta === "") return [];
  const m = /requires\s+(.+?)\s+landed\b/i.exec(meta);
  if (m === null) return [];
  const ownSeries = seriesPart(title)?.series ?? null;
  const refs: PartRef[] = [];
  for (const chunk of m[1]!.split(/\s*,\s*|\s+and\s+/i)) refs.push(...parseRef(chunk, ownSeries));
  return refs;
}

/** Why `entry` is held against the still-`planned` entries, or null when it may be taken:
 * a `**Refused …` line (refused), a Needs-review prefix (needs-review), a Needs-replan prefix
 * (needs-replan — the plan loop owns it), or a prerequisite `(series, part)` still among
 * `planned` ({ blockedBy }). Series compare case-insensitively; part tokens compare verbatim.
 * Bodies mentioning "requires" are never consulted — only the heading's trailing parenthetical. */
export function entryHold(entry: BacklogEntry, planned: readonly BacklogEntry[]): EntryHold {
  if (entry.body.split("\n").some((line) => line.trimStart().startsWith(REFUSED_PREFIX))) {
    return "refused";
  }
  if (entry.body.includes(NEEDS_REVIEW_PREFIX)) return "needs-review";
  if (entry.body.includes(NEEDS_REPLAN_PREFIX)) return "needs-replan";
  const refs = requiredParts(entry.title);
  if (refs.length === 0) return null;
  const parts = planned
    .map((p) => seriesPart(p.title))
    .filter((p): p is PartRef => p !== null);
  const blocked = refs.filter((ref) =>
    parts.some(
      (p) => p.series.toLowerCase() === ref.series.toLowerCase() && p.part === ref.part,
    ),
  );
  return blocked.length === 0
    ? null
    : { blockedBy: blocked.map((ref) => `${ref.series} ${ref.part}/${ref.of}`) };
}

/** The entries a `role` loop may take now, in file order: PLANS.md's `## Planned` entries for
 * feature, BUGS.md's `## Open` entries for bugfix, minus every entry entryHold holds, each with
 * its stamp-free key, verbatim title and 1-based line range. Reads the primary checkout through
 * the same stat-cached readers the index uses; a missing or unreadable file yields []. */
export function eligibleEntries(root: string, role: string): EligibleEntry[] {
  const bugfix = role === "bugfix";
  const file = bugfix ? "BUGS.md" : "PLANS.md";
  const section = bugfix ? "Open" : "Planned";
  const md = readTextOrNull(path.join(root, file));
  if (md === null) return [];
  const entries = bugfix ? openBugEntries(root) : plannedPlanEntries(root);
  const ranges = actionableEntryRanges(md, section);
  const planned = plannedPlanEntries(root);
  const out: EligibleEntry[] = [];
  for (let i = 0; i < entries.length && i < ranges.length; i++) {
    const entry = entries[i]!;
    if (entryHold(entry, planned) !== null) continue;
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
