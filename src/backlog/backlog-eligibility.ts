/** Backlog eligibility: which PLANS.md / BUGS.md entries a work loop may take now (plans,
 * parallel-work-instances, part 2/7). An entry is held when its body carries a **Refused …**,
 * **Needs review …** or **Needs replan …** note, or when its heading's trailing parenthetical
 * names a prerequisite (`requires parts 1/5–3/5 landed`) that is itself still listed under
 * `## Planned`. The parsers are pure over markdown text; `eligibleEntries` is the stat-backed
 * reader for a caller that wants the list. The backlog index marks every held entry so a loop
 * skips it without re-deriving the rule. */

import { collapseWhitespace } from "../text/text.js";
import { NEEDS_REPLAN_PREFIX, NEEDS_REVIEW_PREFIX } from "../roles/role-guidance.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { trailingParenthetical, type BacklogEntry } from "./backlog-md.js";
import { actionableEntryRangesFor, stripEntryStamp } from "./backlog-structure.js";
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

/** The text of `body`'s Refused note: the first line (ignoring leading indentation) that begins
 * with REFUSED_PREFIX, trimmed, with the leading `**` and the first closing `**` removed. Null
 * when no line matches — the same line-prefix rule entryHold's "refused" hold uses. */
export function refusalNote(body: string): string | null {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.startsWith(REFUSED_PREFIX));
  return line === undefined ? null : line.replace(/^\*\*/, "").replace("**", "");
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

/** Why `entry` is held against the still-`planned` entries, or null when it may be taken: a
 * `**Refused …` line (refused), a Needs-review line (needs-review), a Needs-replan line
 * (needs-replan — the plan loop owns it), or a prerequisite `(series, part)` still among
 * `planned` ({ blockedBy }). Series compare case-insensitively; part tokens compare verbatim.
 * Bodies mentioning "requires" are never consulted — only the heading's trailing
 * parenthetical. */
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
  if (hold === "refused") return " [refused]";
  if (hold === "needs-review") return " [needs review]";
  if (hold === "needs-replan") return " [needs replan]";
  return ` [blocked: requires ${hold.blockedBy.join(", ")}]`;
}

/** Why each entry the operator's `tumwater backlog` surfaces list is held, as two arrays
 * parallel to backlogPayload's `plans` and `bugs`: the same entryHold decision the prompt's
 * backlog index carries, so a hold is observable rather than inferred. The planned entries
 * are read once and reused as the prerequisite set. Questions carry no holds. */
export function backlogHolds(root: string): { plans: EntryHold[]; bugs: EntryHold[] } {
  const planned = plannedPlanEntries(root);
  const parts = plannedPartKeys(planned);
  return {
    plans: planned.map((entry) => entryHoldAgainst(entry, parts)),
    bugs: openBugEntries(root).map((entry) => entryHoldAgainst(entry, parts)),
  };
}

/** The eligibility mark (holdMark) for each planned plan and open bug, two arrays parallel
 * to the entries the observer surfaces list (backlogPayload's `plans`/`bugs`, the TUI's list
 * and entry modes): backlogHolds' verdicts projected through holdMark, so a surface derives
 * its marks from the one hold decision rather than re-walking the entries. holdMark renders
 * an eligible entry as the empty string, so a client can append the mark without a separate
 * eligibility check. Questions carry no holds. */
export function backlogMarks(root: string): { plans: string[]; bugs: string[] } {
  const holds = backlogHolds(root);
  return { plans: holds.plans.map(holdMark), bugs: holds.bugs.map(holdMark) };
}

/** The entries a `role` loop may take now, in file order: PLANS.md's `## Planned` entries for
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
  const out: EligibleEntry[] = [];
  for (let i = 0; i < entries.length && i < ranges.length; i++) {
    const entry = entries[i]!;
    if (entryHoldAgainst(entry, parts) !== null) continue;
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
