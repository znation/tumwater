/** Which GitHub issues the backlog already mirrors (plans/github-issues.md, decision 3). An entry
 * mirrors an issue when its `### ` heading carries `mirrors GitHub issue #<n>` (or the plural
 * `mirrors GitHub issues #4, #9`). Only headings count, so a body that quotes the phrase mirrors
 * nothing. The finished sections count too: an issue whose fix already landed is still mirrored,
 * so the scan never queues it again. */

import { isRetiredTitle } from "../backlog/backlog.js";
import { actionableEntryRangesBySections } from "../backlog/backlog-index-data.js";
import { branchHead, fileContentAt } from "../git/git.js";

/** The `## ` sections a mirror can sit in, open lists and finished archives alike. */
const MIRROR_SECTIONS = ["Planned", "Open", "Done", "Fixed", "Verified"];

/** The backlog files a mirror can sit in: the open lists and their finished archives. */
const MIRROR_FILES = ["BUGS.md", "PLANS.md", "BUGS-FIXED.md", "PLANS-DONE.md"];

/** Where one mirroring entry sits: its backlog file, its `## ` section, its heading, and whether it
 * carries a retired stamp (a retired entry never closes its issue; part 5). */
export interface MirrorEntry {
  file: string;
  section: string;
  heading: string;
  retired: boolean;
}

/** Whether a mirroring entry is finished: in a `## Done`, `## Fixed` or `## Verified` section. */
export function isFinishedMirror(entry: MirrorEntry): boolean {
  return ["Done", "Fixed", "Verified"].includes(entry.section);
}

/** The issue numbers one heading mirrors, from its text after `### `. Numbers are compared as
 * integers, so `#1` never matches `#12`. */
function mirroredNumbersOf(heading: string): number[] {
  const list = /mirrors GitHub issues? ((?:#\d+)(?:,\s*#\d+)*)/.exec(heading);
  if (!list) return [];
  return [...(list[1] ?? "").matchAll(/#(\d+)/g)].map((ref) => Number(ref[1]));
}

/** The issue numbers the `### ` headings of one markdown document mirror. */
export function mirroredIssueNumbers(markdown: string): Set<number> {
  const numbers = new Set<number>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("### ")) continue;
    for (const n of mirroredNumbersOf(line.slice("### ".length))) numbers.add(n);
  }
  return numbers;
}

/** Every mirroring entry in the given backlog files, keyed by issue number. `files` maps a file
 * name (BUGS.md, PLANS.md, BUGS-FIXED.md, PLANS-DONE.md) to its text; the scan reads each at the
 * base branch's tip. Entries are located by actionableEntryRangesBySections, the same walk the
 * backlog index uses, so a heading inside a fenced block is never a mirror. One walk per file
 * harvests every mirror section at once — the finished archives run to megabytes, so walking
 * each file once per section (the old loop) read the same lines five times. Sections are still
 * visited in MIRROR_SECTIONS order, so an issue's entries keep the order the close pass reads. */
export function mirrorStates(files: Readonly<Record<string, string>>): Map<number, MirrorEntry[]> {
  const byIssue = new Map<number, MirrorEntry[]>();
  for (const [file, markdown] of Object.entries(files)) {
    const ranges = actionableEntryRangesBySections(markdown, MIRROR_SECTIONS);
    for (const section of MIRROR_SECTIONS) {
      for (const entry of ranges.get(section) ?? []) {
        for (const n of mirroredNumbersOf(entry.title)) {
          const found = byIssue.get(n) ?? [];
          found.push({ file, section, heading: entry.title, retired: isRetiredTitle(entry.title) });
          byIssue.set(n, found);
        }
      }
    }
  }
  return byIssue;
}

/** How many (root, branch) mirror reads the cache holds: the orchestrator polls one or two
 * projects, so any list this long is stale entries from other roots, and clearing it wholesale
 * keeps the cache from growing for the life of the process. */
const MIRROR_CACHE_MAX = 32;

/** One branch tip's mirror read: the tip SHA the states were built at, and the states. */
interface MirrorCacheEntry {
  head: string;
  states: Map<number, MirrorEntry[]>;
}

/** The mirror read of each (root, branch) at the tip it was last read at. The orchestrator's
 * queue step (`queueOneIssue`) asks this on every poll — every 2 s — and the read is four
 * `git show` of the backlog files, whose finished archives grow with every merge (11 MB, 51 k
 * lines on this repo as of 2026-11-21). Keyed on the tip SHA, a poll that changes nothing costs
 * one ref read. The entries are never mutated by callers, so a hit hands out a shallow Map copy
 * over the same entry arrays. */
const mirrorCache = new Map<string, MirrorCacheEntry>();

/** The mirror entries of the backlog at the base branch's tip, keyed by issue number. Served from
 * the cache while the branch tip is unchanged: the tip is resolved file-first (`branchHead`), and
 * only a tip this process has not already read pays for the four `git show` reads. When the tip
 * cannot be resolved at all the read runs uncached, exactly as before, so a branch git cannot name
 * still reads empty files rather than a cached answer. */
export async function mirrorsAtTip(root: string, branch: string): Promise<Map<number, MirrorEntry[]>> {
  const head = await branchHead(root, branch);
  if (head === null) return mirrorStates(await mirrorFiles(root, branch));
  const key = `${root}\u0000${branch}`;
  const cached = mirrorCache.get(key);
  if (cached?.head === head) return new Map(cached.states);
  const states = mirrorStates(await mirrorFiles(root, branch));
  if (mirrorCache.size >= MIRROR_CACHE_MAX) mirrorCache.clear();
  mirrorCache.set(key, { head, states });
  return new Map(states);
}

/** The four backlog files as they stand at the branch tip, missing files as empty strings. The
 * four `git show` reads run concurrently: each is independent, and serially they cost the whole
 * poll step (~55 ms measured on this repo's backlog), while overlapping them costs the slowest. */
async function mirrorFiles(root: string, branch: string): Promise<Record<string, string>> {
  const read = async (file: string): Promise<[string, string]> => [
    file,
    await fileContentAt(root, branch, file),
  ];
  return Object.fromEntries(await Promise.all(MIRROR_FILES.map(read)));
}
