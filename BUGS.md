# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### The backlog range reader (actionableEntryRanges) reads only `### ` headings, so `- `-bullet entries are invisible to the closed-entries index, the archive dedupe, and the bug wait-close

**Symptom.** `actionableEntryRanges` (src/backlog/backlog-index-data.ts, `line.startsWith("### ")` is the only entry-start test) is the shared entry reader for twelve modules, yet it recognizes only `### ` headings. The canonical reader `parseEntryDetails` (src/backlog/backlog-md.ts) and the date reader `eachEntryStart` (backlog-md.ts:359) both read `### ` headings AND `- ` bullets as entry-starts, and the team's roles compress most closed bugs into single-line `- ` bullets — BUGS-FIXED.md's `## Fixed` holds 1914 `-` bullets against 491 `###` headings. So the range reader is blind to the archive's majority shape.

**How to reproduce (offline, deterministic).** A scratch import over this tree: `actionableEntryRanges(BUGS-FIXED.md, "Fixed")` returns 1 range (a single `###` entry at line 43) out of 1914 bullets + 491 headings; the real newest closed entries (the `-` bullets at lines 8/20/30/…) are all skipped. Consequence 1 — the `<backlog-index>` block's `BUGS-FIXED.md ## Fixed (newest N)` (backlog-index.ts renderClosedSections, RECENT_CLOSED_MAX 5) lists stale `###` entries and never the actual newest closed bugs, in every role prompt. Consequence 2 — the archive dedupe (backlog-archive.ts entryFates, via entriesIn→actionableEntryRanges) matches selected entries against the archive's `###` entries only, so it cannot recognize a closed bug the archive already holds as a `-` bullet and will re-move it (duplicate). The same reader powers recordRecurrence (backlog-file-bugs.ts) and closeQuietWaitsText (backlog-bug-waits.ts).

**Suspected cause.** The `-` bullet is a valid one-line entry shape (parseEntryDetails and eachEntryStart read it; the team uses it for compressed closed entries), but the range walk was written for `###` headings only and never extended to the bullet shape, so every consumer of the range reader inherits the blind spot.

**Required behavior.** Decide the canonical entry shape for one-line entries and make the range reader match it. The fork: (a) make `actionableEntryRanges` read a top-level `- ` bullet as an entry-start (matching parseEntryDetails/eachEntryStart) so the closed index, archive dedupe, and bug wait-close all see the majority archive shape — the open `## Open` shape then needs a guard so a `- ` repro step inside an entry body is not misread as a sibling entry, or (b) canonicalize one-line entries to `### ` in the archive and close paths so the `###`-only reader is never blind. This is a plan-role design call (it touches twelve call sites and the entry-shape contract); the bugfix role records it, not force-picks a shape.

## Fixed
