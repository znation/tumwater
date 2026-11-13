# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### The since-last-run block never marks a numbered instance's own merges, blocks the orchestrator on two sync git spawns per run start, and can hide dropped commits under its size cap (found by operator session 2026-11-13 from a review of a4d55b7d5)

**Symptom.** Three defects in src/prompt/since-last-run.ts (plans/since-last-run.md, landed a4d55b7d5):
1. **Own merges unmarked for instances.** `renderBlock` (line 175) marks a subject as "(your own merge)" when it starts with `tumwater(${role}):`. `run-prompt.ts` passes the runner's instance id (`feature-2`), but every instance commits as `tumwater(feature):`; `git log main --since=2026-11-10 --format=%s` shows no `tumwater(feature-N)` or `tumwater(bugfix-N)` subject. So feature-2…7 and bugfix-2…4 never see their own merges marked. test/since-last-run.test.ts only uses the plain `feature` id.
2. **Two blocking git spawns per run start.** `collectSinceLastRun` runs `git merge-base --is-ancestor` and then `git log` through `spawnSync`, each bounded at 15 s (lines 80–94, 236–237); the plan asked for one spawn. `runner.ts:264` (`runPrompt` → `assembleRunPrompt`) runs inside the orchestrator process, and so does the dashboard's /api/role (`role-view.ts:612` `previewRun`), so both spawns block the event loop that schedules every role. Every other prompt input is a stat-cached file read. Each spawn costs tens of milliseconds on a quiet host; under the loads seen 10-19 and 10-21 it can be seconds per run start, and a wedged git holds the loop for up to 30 s.
3. **The size cap can hide dropped commits.** When the block exceeds 4,000 characters, `renderBlock` (line 200) drops subjects from the end, and the first line dropped is the `+N older` marker, so the block lists fewer commits than landed without saying so. The test "the block is capped at 4000 characters" never reaches this path: 60 short subjects stay under 4,000 characters after the 30-subject cap.

**How to reproduce.**
1. In a temp repo, call `collectSinceLastRun(root, "feature-2", config, state)` with a commit `tumwater(feature): x` after the anchor: the line has no "(your own merge)".
2. Count spawns: wrap `spawnSync` (or run under `dtruss`/a git shim that logs argv) around one `assembleRunPrompt` call with a non-empty `lastMainHead`: two git processes.
3. In a temp repo, make 40 commits with ~200-character subjects after the anchor: the rendered block has under 30 subjects and no `+N older` line.

**Suspected cause.** (1) The role id used for the prefix is the instance id, not the base role (`baseRoleOf(role)`, which run-prompt.ts already computes as `base`). (2) The ancestor check is a separate spawn; `lastMainHead` is only ever written from main's head (run-finalize.ts:79), so the check guards only against rewritten history. (3) The trim loop treats the `+N older` marker as an ordinary subject line.

**Required behavior.**
- Mark a subject whose prefix is the runner's base role (`tumwater(feature):` for `feature-2`) as merged by the role, worded "(merged by your role)", since all instances share the prefix.
- At most one git spawn per prompt assembly, with a bound of about 3 s. Dropping the ancestor check is acceptable: on rewritten history `anchor..main` still lists the commits main gained. Moving the read off the event loop is better if the prompt path can await.
- After cap trimming, the block still states how many commits it does not list (recompute the `+N older` line from the subjects actually shown).
- Tests with literal expected output, as the plan's acceptance criteria asked: an instance id, a cap-trimmed block, files ranked by touch count, and more than 20 files (`+N more`).
- Minor, same change: remove the unused `order` array in `rankedFiles`; correct the run-prompt.ts comment ("A run holding a claim … is the one that gets it": every run gets the block, only the file ordering depends on the claim); use the entry's touched files only for an assigned run (claim and no queued request); name the target branch, not "main", in the nothing-changed line.

### The backlog range reader (actionableEntryRanges) reads only `### ` headings, so `- `-bullet entries are invisible to the closed-entries index, the archive dedupe, and the bug wait-close

**Refused 2026-11-12 by bugfix: the entry's premise is false and its real symptom is a phantom-`##` archive split that no bugfix may repair — on the real archive `parseEntryDetails` and `actionableEntryRanges` both read `###`-only and return the identical 2 entries (verified offline, 2-vs-2, titles 8-133 and 134-145), so the range reader is *consistent* with the canonical reader, not blind to it, and the `-` one-line records are body content by the invariant-pinned INV-AX2 (src/verdict/fix-claim.ts `fixedSection`/`isOneLineRecord`); the ~2391 closed entries no reader walks all sit in a phantom-`##`-split section (BUGS-FIXED.md:146, a twin at PLANS-DONE.md:201) that an operator/director archive repair — not a bugfix, which may not edit archive files — must fix, and either of the entry's own "required behavior" branches rewrites that cross-cutting guarantee across twelve shared consumers in one tick, which grows complexity without justifying it.**

**Symptom.** `actionableEntryRanges` (src/backlog/backlog-index-data.ts, `line.startsWith("### ")` is the only entry-start test) is the shared entry reader for twelve modules, yet it recognizes only `### ` headings. The canonical reader `parseEntryDetails` (src/backlog/backlog-md.ts) and the date reader `eachEntryStart` (backlog-md.ts:359) both read `### ` headings AND `- ` bullets as entry-starts, and the team's roles compress most closed bugs into single-line `- ` bullets — BUGS-FIXED.md's `## Fixed` holds 1914 `-` bullets against 491 `###` headings. So the range reader is blind to the archive's majority shape.

**How to reproduce (offline, deterministic).** A scratch import over this tree: `actionableEntryRanges(BUGS-FIXED.md, "Fixed")` returns 1 range (a single `###` entry at line 43) out of 1914 bullets + 491 headings; the real newest closed entries (the `-` bullets at lines 8/20/30/…) are all skipped. Consequence 1 — the `<backlog-index>` block's `BUGS-FIXED.md ## Fixed (newest N)` (backlog-index.ts renderClosedSections, RECENT_CLOSED_MAX 5) lists stale `###` entries and never the actual newest closed bugs, in every role prompt. Consequence 2 — the archive dedupe (backlog-archive.ts entryFates, via entriesIn→actionableEntryRanges) matches selected entries against the archive's `###` entries only, so it cannot recognize a closed bug the archive already holds as a `-` bullet and will re-move it (duplicate). The same reader powers recordRecurrence (backlog-file-bugs.ts) and closeQuietWaitsText (backlog-bug-waits.ts).

**Suspected cause.** The `-` bullet is a valid one-line entry shape (parseEntryDetails and eachEntryStart read it; the team uses it for compressed closed entries), but the range walk was written for `###` headings only and never extended to the bullet shape, so every consumer of the range reader inherits the blind spot.

**Required behavior.** Decide the canonical entry shape for one-line entries and make the range reader match it. The fork: (a) make `actionableEntryRanges` read a top-level `- ` bullet as an entry-start (matching parseEntryDetails/eachEntryStart) so the closed index, archive dedupe, and bug wait-close all see the majority archive shape — the open `## Open` shape then needs a guard so a `- ` repro step inside an entry body is not misread as a sibling entry, or (b) canonicalize one-line entries to `### ` in the archive and close paths so the `###`-only reader is never blind. This is a plan-role design call (it touches twelve call sites and the entry-shape contract); the bugfix role records it, not force-picks a shape.

## Fixed
