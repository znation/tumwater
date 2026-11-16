# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A checkpoint-caused abort is indistinguishable from a context-ceiling cut-off to the no-change warning, and its resume bridge lies: the "In any case" half of the 2026-11-15 checkpoint bug the gate-side fix closed on 2026-11-16

Filed 2026-11-16 by the review role as the review of c1c5e4d0. The gate-side fix (BUGS-FIXED.md, "A `checkpoint` call ends the run instead of compacting it") closes the bug's review half — gate runs no longer offer `checkpoint`, so a review keeps its verdict. Two author-run requirements from that same entry stay open and untracked here:

**1. The cut-off warning blames the wrong cause.** When an accepted `checkpoint` aborts the turn (pi 1.5.2), the run ends `stopReason: "aborted"` with a contentless final message and no `compaction` written. `diagnoseNoChange` (src/verdict/no-change.ts) classifies any contentless-final, sentinel-less run as `cutOff` and its note reads "likely cut off at the context ceiling" — blaming the ceiling for what was a checkpoint abort. The bug entry's "In any case, the cut-off warning should not blame the context ceiling when the run actually ended on a checkpoint" is unmet. The run result (src/pi/pi-run-result.ts) carries `stopReason` and `compacted`; whether it can tell a checkpoint abort apart from a ceiling cut-off — or whether that distinction is worth the machinery — needs a real run to settle (offline the fake-pi shim cannot model pi's own abort).

**2. The resume bridge lies (the commit's RISK names this as deferred).** `buildResumePrompt` (src/prompt/prompt-followup.ts) tells a resumed author run its work "is summarized above", but a checkpoint abort leaves no summary — the resume runs on the full, uncompacted context. The fix needs a real run: confirm pi 1.5.2 ever writes the compaction, and if not, make the bridge honest (or have the runner run the compaction itself before resuming).

Both are the author-run side of one bug whose review side c1c5e4d0 closed; the gate fix is the harm-with-no-recovery, this is the resumable-but-misled half. Neither is recorded in BUGS-FIXED.md's Fixed entry, which scopes its closure to the review side — so this entry is the live record keeping the rest from being archived away.

### post-merge review of 7bbda7b0 never reached a verdict (found by the review role 2026-11-16)

The post-merge review of commit `7bbda7b0fffc1bfd591a71d19d61bf8188e2d07c` (Anchor the stranded-plan done-stamp to the entry's own trailing clause) never reached a verdict: This operation was aborted. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

### Five root-walk tests fail on a shared host once a stale `.tumwater` dir sits at the system temp root (found by the bugfix role 2026-11-16)

Found while verifying a fix: a full `npm test` reded on exactly five tests, all in the `.tumwater`-root-walk family — `findTeamRoot` / `nearestTumwaterRoot` / `writeFullOutput` (test/check-slots.test.ts, test/paths.test.ts, test/full-output.test.ts) — and they pass in isolation on a clean host. The five are `findTeamRoot finds the ancestor holding .tumwater/state`, `writeFullOutput returns null when no ancestor has .tumwater/`, `findTumwaterRoot walks up to the harness root`, and the two `nearestTumwaterRoot` cases.

**Reproduce.** `npm test` on a host whose `os.tmpdir()` is a directory that already holds a `.tumwater` dir with a `state` subdirectory. On this shared host the system temp root is `/tmp` and a leaked `/tmp/.tumwater/state` (from an earlier run) sat there, so the tests walked up from their per-test temp dir into `/tmp/.tumwater/state` and returned `/tmp` (or the wrong root) instead of `null`, failing the assertion "a dir with no `.tumwater`/`state` ancestor has no team root." The same tests pass in isolation on a host whose `os.tmpdir()` is a clean per-user dir, and the suite's `--affected` gate is green.

**Suspected cause.** The root-walk tests create per-test dirs under `os.tmpdir()` (the `tmpdir()` fixture, test/fixtures/repo-fixtures.ts) and assert "no ancestor has `.tumwater`/`state`", but they have no quiet-host skip and no guard against a `.tumwater` dir at the temp root. On a shared host that already holds a stale `.tumwater` (leaked by an earlier run — the same `$TMPDIR/.tumwater` poisoning recorded in BUGS-FIXED, the `runAgent` notes-shim fallback), those assertions fail. A full suite that runs with the system temp root as `os.tmpdir()` can also write its own `.tumwater` there (it creates `<tmp>/.tumwater/{bin,log}`), so the poison is self-perpetuating run-to-run on such a host.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
