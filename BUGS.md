# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

- The live-orchestrator e2e `a reached cap switches roles to the free fallback model instead of stopping them` (test/orchestrator-budget.e2e.test.ts:210) flakes on a near-bar host — it passed the quiet-host gate, then timed out at its 150 s role-run-spawn wait (found by the ci role 2026-11-12).

**Symptom.** At main tip `aa80aa1`, the first full e2e run (`npm run test:e2e`) failed this one test: `timed out waiting for a role run after the cap was reached` at 150406 ms — the `waitFor(..., 150_000)` at test/orchestrator-budget.e2e.test.ts:259. The test's own `awaitQuietHost` gate had passed — the 1-minute load was below the 18-core count, so the gate admitted it — while the host's 5/15-minute averages were still elevated (≈10–14): a near-bar host whose 1-minute value had dipped below the count was still saturated on the longer timescale, and the wall-clock spawn wait stretched past its budget. The single test passed in isolation (889 ms) and a full e2e re-run at the same tip was green (87/87, 0 skipped), so it is a load-sensitive flake, not a regression. `npm test` was fully green (0 fail) at the tip, and the remote CI run it judges (de73863) was already passing, so nothing on the hosted runner is red.

**Required behavior.** The post-cap-switch role-run spawn settles within its wall-clock budget on a host whose 1-minute load is below the core count but whose sustained (5/15-minute) load is still high. The concrete seam: the gate (test/helpers/wait.ts `awaitQuietHost`) treats `load1 <= cpus` as quiet and `load1` is `os.loadavg()[0]` (the 1-minute average); a near-bar host whose 1-minute value dips below the count while its 5/15-minute average is still elevated is admitted and then starves the 150 s spawn wait. Either the gate should sample the longer average (or defer when it is still high), or this wait should be driven on the fake clock like the watchdog tests. The recurrence landed on 2026-11-12 AFTER the per-test quiet-host gate and the 150 s robustification were already in the tree, so it is the documented load-flake class recurring despite those robustifications, not a regression.

**Validation gap:** no-repro — the flake reproduces only under sustained shared-host load; verified the tip green after the load subsided.

### post-merge review of 23b74d9d never reached a verdict (found by the review role 2026-11-12)

The post-merge review of commit `23b74d9df29ac480db05bbfda92eeb65f757ed2e` (Update BUGS.md, test/orchestrator-3.e2e.test.ts) never reached a verdict: timed out after 1800s while still making progress — session and worktree edits preserved for resume. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

## Fixed
