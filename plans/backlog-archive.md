# Backlog archive: finished entries leave the live backlog files

Status: designed 2026-10-18 by an operator session; implementation and migration land with it.

## Why

A role run reads PLANS.md and BUGS.md to find work, but both files are mostly finished history.
On 2026-10-18, PLANS.md was 2.09 MB, and 1.88 MB of it (378 entries) sat under `## Done`.
BUGS.md was 951 KB, and 938 KB of it sat under `## Fixed`. From 10-17 00:00 to 10-18 02:40 PDT,
team runs' reads and greps of PLANS.md returned 21.4M characters. Backlog and docs reads made up
about 26% of the prompt tokens role runs re-send. The steward's compression (ten full entries,
older ones cut to one line) never kept up: it cost a model run per pass and destroyed detail.

## The layout

- **PLANS-DONE.md** (repo root) holds finished plans, newest first, under the same `## Done`
  heading that PLANS.md uses. **BUGS-FIXED.md** holds fixed bugs under `## Fixed`. Each archive
  file opens with a two-line header saying what it is and how to read it (search it, or read an
  entry by line range; never read it whole).
- PLANS.md keeps `## Planned` and an empty `## Done` heading. BUGS.md keeps `## Open`, an empty
  `## Fixed` heading, and `## Verified` (9 KB of qa run notes the qa role reads; it stays).
  The headings stay so the move step roles already follow, and the heading-set structure check,
  are unchanged.
- QUESTIONS.md is out of scope (4.6 KB in total).

## Who moves an entry

The harness moves it, at commit time. Roles keep today's move step: cut the entry out of
`## Planned` or `## Open`, then paste it under `## Done` or `## Fixed`. Right before the run's
commit, after the stage self-check and its fix-up turn, tumwater moves every entry that this
change added under the live finished section into the top of the archive file. The commit, the
review and the merge all see the entry in the archive.

- The move covers only entries new relative to the change's merge-base. An entry that was
  already in the live section stays where it is, so a role's diff never carries someone else's
  move.
- The move runs only when the archive file exists, or when the live section would be left
  empty. A repository that still has legacy entries and no archive keeps today's behavior until
  it is archived (see below), so the archive never sits above older live entries.
- An entry whose heading the archive already holds never moves (added 2026-10-19). With the
  same text it is dropped from the live section; with other text it stays there for the author
  and the reviewer. The bulk archive below follows the same rule. A conflict hand-back of a change
  written before the archive had re-pasted the old history under the live headings, and the sweep
  prepended all 383 + 310 entries to the archives again (rejected 04ab808ca). The structure check
  also rejects a change that adds a `### ` heading the base archive already carries.
- Concurrent merges insert at the same spot (the top of the archive) exactly as they insert at
  the top of `## Done` today. The deterministic insert-only conflict pass already settles that
  shape. The archive files join `BACKLOG_FILES`, so that pass, the heading-set check and doctor's
  duplicate-heading check cover them.

Rejected alternatives:
- Roles edit the archive themselves. That puts a second, huge file in front of every model and
  invites whole-file reads, which is the cost being removed.
- The harness archives at merge time, under the merge lock. That avoids even the archive's
  insert conflicts, but it rewrites trees after review on three merge paths (single merge, stack
  batch, merger), and it breaks the verified-head and red-main baseline seeding that skip
  redundant checks.

## Bulk archiving: `tumwater archive`, also run at team start

`tumwater archive` moves the whole body of each live finished section (`### ` entries, the
steward's one-line records, and any other lines) to the top of the archive file. It creates the
archive file if needed, leaves the empty heading, and commits the files on main in the primary
checkout as `tumwater(operator): …`. It holds the merge lock, so a team merge in progress cannot
lose its fast-forward to the commit. It refuses when any of the four files has uncommitted
changes, or when the primary checkout is not on the base branch.

`tumwater start` runs the same step before any role starts. That moment is quiet: no merge is in
progress and no run is in flight. This migrates every repository on its first start with this
build, with no manual step. It also sweeps entries that a hand commit moved into a live
finished section. A start-time archive that cannot run (dirty files, or a primary checkout off
main) logs one warning, and the team starts anyway. `tumwater doctor` warns while a live finished
section still holds entries, and names `tumwater archive` as the fix.

## Readers: live section first, then the archive

Every reader of finished entries reads the live section's entries (newest, normally none), then
the archive's.

- `donePlans`, `donePlanEntries`, `fixedBugEntries`, and the completion and filing date reads
  (src/backlog/backlog.ts). These feed the bootstrap gate's count, the status payload, the TUI
  and GUI done/fixed rows, `/api/backlog`, `plan --list --done`, `bug --list --fixed`, the report's
  done/fixed/filed per day, and doctor's plan-dependency check.
- `mergedPrerequisiteRanges` (eligibility): the `<merged-prerequisites>` note names the file
  each range is in.
- The backlog index's newest-closed lists read the archive and are labelled
  `PLANS-DONE.md ## Done (newest 5)`.
- The false-fix check (src/verdict/fix-claim.ts) compares the union of live and archive Fixed
  entries, head against base, so an entry moved into the archive with its body intact is not a
  new fix claim. It runs when either BUGS.md or BUGS-FIXED.md is touched. Doctor's
  claimed-bugs and regressed-fix checks read the same union.
- Structure checks: the "new plan filed under `## Done` with no done date" rule and the
  double-block Fixed rule also cover the archive files. Stranded-plan detection (the clean role's
  block, and doctor) also scans PLANS-DONE.md and names the file.
- The stage check's plan-dependency finding counts archived titles as existing headings.
- `plans-citations.test.ts` resolves citations against PLANS.md and PLANS-DONE.md.

## Prompts and docs

- Orientation rule: PLANS.md and BUGS.md now hold open work only. Finished entries live in
  PLANS-DONE.md and BUGS-FIXED.md. Search those with grep, or read an entry by the range the
  index or a note gives. Never read them whole.
- The move guidance adds one clause: tumwater moves the pasted entry into the archive when it
  commits.
- Plan role: the duplicate check names PLANS-DONE.md.
- Steward: the compression move, its rules and the `<records-overflow>` block are retired.
  Nothing reads the archive whole, so keeping it bounded saves nothing, and each compression
  pass cost a model run and dropped detail. The validation-gap promotion move greps
  BUGS-FIXED.md.
- docs, README and the init templates are updated to match. New repositories get PLANS.md and
  BUGS.md with an empty finished heading. The archive file appears on the first finished entry.

## Migrating this repository while the team runs

The running team keeps its old build until its next self-redeploy. On 10-18 the 12-hour restart
cooldown put that at about 11:00 PDT at the earliest. Until then, old-build runs paste finished
entries at the top of the live `## Done` and `## Fixed`, and the old build's merge code knows
only the insert-only conflict rule. If the history next to that insertion point were deleted
under it, every old-build branch in flight would hit a conflict that rule cannot settle. Each one
would then go to the model resolver with a 1.9 MB hunk. So the old build must never merge
against an archived main.

1. Land the code on main (by fast-forward under the merge lock). The old build reads the new
   intro lines and nothing else changes for it.
2. Run `tumwater restart`. It waives the cooldown. The team drains (in-flight runs finish, or are
   aborted and resume on the new build), compiles main and respawns. The new build's start
   archives everything in one commit, before any run starts.
3. Old-build commits still queued after that (committed before the drain, merged by the new
   build) meet a deleted live section. For that one shape the conflict pass gains a rule: inside
   a finished section, when the change's side is whole new `### ` entries followed by exactly
   the base lines, keep those entries on top of main's side. The next start sweeps them.
4. A rejected or handed-back change is re-applied onto main by cherry-pick (src/loop/revision.ts).
   When its diff prepends to an archive that main has prepended to since, the same insert-only
   pass settles that conflict first (added 2026-10-19), so only files it cannot settle reach the
   author with markers.

If a restart is unwelcome, step 2 can wait for the self-redeploy. A partial archive by hand in
the meantime is also safe: move everything except the newest entry of each live section
(`archiveFinishedOnMain(root, { keep: 1 })`). An old-build insertion then sits above an
unchanged entry, so git merges it cleanly, and the next start moves the rest.
