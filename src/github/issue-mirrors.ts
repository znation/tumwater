/** Which GitHub issues the backlog already mirrors (plans/github-issues.md, decision 3). An entry
 * mirrors an issue when its `### ` heading carries `mirrors GitHub issue #<n>` (or the plural
 * `mirrors GitHub issues #4, #9`). Only headings count, so a body that quotes the phrase mirrors
 * nothing. The finished sections count too: an issue whose fix already landed is still mirrored,
 * so the scan never queues it again. */

import { isRetiredTitle } from "../backlog/backlog.js";
import { actionableEntryRanges } from "../backlog/backlog-index-data.js";

/** The `## ` sections a mirror can sit in, open lists and finished archives alike. */
const MIRROR_SECTIONS = ["Planned", "Open", "Done", "Fixed"];

/** Where one mirroring entry sits: its backlog file, its `## ` section, its heading, and whether it
 * carries a retired stamp (a retired entry never closes its issue; part 5). */
interface MirrorEntry {
  file: string;
  section: string;
  heading: string;
  retired: boolean;
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
 * base branch's tip. Entries are located by actionableEntryRanges, the same walk the backlog
 * index uses, so a heading inside a fenced block is never a mirror. */
export function mirrorStates(files: Readonly<Record<string, string>>): Map<number, MirrorEntry[]> {
  const byIssue = new Map<number, MirrorEntry[]>();
  for (const [file, markdown] of Object.entries(files)) {
    for (const section of MIRROR_SECTIONS) {
      for (const entry of actionableEntryRanges(markdown, section)) {
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
