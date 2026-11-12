# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### post-merge review of 23b74d9d never reached a verdict (found by the review role 2026-11-12)

The post-merge review of commit `23b74d9df29ac480db05bbfda92eeb65f757ed2e` (Update BUGS.md, test/orchestrator-3.e2e.test.ts) never reached a verdict: timed out after 1800s while still making progress — session and worktree edits preserved for resume. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

## Fixed
