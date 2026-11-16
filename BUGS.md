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

### Roles spin through ~0.2 s "recovered leftover work" runs while their own change waits to merge: a fresh run's pin has no queue file, so `recoverLeftover` re-pins the role's own pending change on every run

Filed 2026-11-15 by an operator session from the live team's logs (build 72a0b257; the code path is unchanged on main).

**Symptom.** About 800 runs from 11-12 to 11-15 ended `queued` after 0.1–0.3 s with the summary "recovered leftover work from <role>: …". Nearly all of them re-pinned that role's own change while it was already waiting to merge. The worst cases:
- plan: 327 runs, one every ~2 s, on 11-14 from 23:31:28 to 23:53:03, while its pin 0f89dc7a waited behind feature's merge.
- feature: 34 runs at its 20 s interval (11-14 23:32–23:44) and 35 runs (11-15 07:04–07:49).
- dedupe: 28 runs (11-15 07:19–07:30).
- director: 67 runs every 20 s (11-12 17:45–18:07).

Each of these runs is a no-op. It writes run_start and run_end, inflates the role's run counter, and crowds real events out of the log views.

**How to reproduce.** In `.tumwater/log/events.jsonl`, select the `run_end` events whose summary starts with "recovered leftover work" and whose `durationMs` is under 1000, then group them by role. They cluster between that role's `merge_queued` and its `merge_done`, which is the time its merge-ref pin is pending.

**Suspected cause.** The cause is a chain of four steps:
1. Since part 3e/7, a fresh run records its waiting change only as the merge-ref pin, without a queue-file entry.
2. `recoverLeftover` (src/runner/runner-leftover.ts) decides whether the role's change is already queued from `queuedMerges(ctx.root)`. That list is always empty for pin-only changes, so the role's own pending branch is classified as leftover work and re-pinned (`return { kind: "pinned", entry }`). The `ctx.queuedSummary?.sha !== sha` test only suppresses a duplicate `merge_queued` log; it does not stop the run.
3. `finishRecoveryRunPhase` (src/runner/runner-recovery.ts) ends the run `queued`.
4. `scheduleCompletedOutcome` then resets the role to its minimum interval. That interval is 0 s for plan whenever its backlog is open (`scheduleConfigForRole`, src/config/config-views.ts) and 20 s for the other roles. The role wakes again and repeats until the merge settles.

The 11-04 and 11-09 director fixes (`directorPinOwedRun` in src/scheduling/scope.ts, and `leftoverPending`/`inboxSelfRequeued` in src/scheduling/skip.ts) cover the director only.

**Required behavior.** A role's own pending pin (the merge ref exists and points at the worktree's tip) is not leftover work: no run re-pins it, and no run ends `queued` for it. Do NOT fix this by deferring the role until its merge settles. The merge queue is not a scheduling gate (docs/how-it-works.md "No merge interlock"): a role whose change is waiting still authors on its normal schedule. Make one role-agnostic check that generalizes the director's fix rather than adding another per-role case, most likely in `recoverLeftover`, so the run goes on to real work (or ends no-change) and keeps the role's normal interval.

**Reverted attempt (2026-11-16).** be6c22efd added a `drainingGate` (src/scheduling/scheduling.ts) that deferred every non-director role while its pin was draining. Every changed run leaves a pin, so this restored the merge interlock. Two e2e tests in test/orchestrator-3.e2e.test.ts failed deterministically: `a role with a queued or in-flight merge keeps running: the queue is not a scheduling gate` and `a role rejected in its verify runs again while another queued change is still in review`. The gate's `--affected` selection never runs the e2e tier, so the change merged green and turned GitHub CI red. An operator session reverted it, together with its docs sync e478de6b6. Run `npm run test:e2e` before landing a fix for this entry.

### post-merge review of 7bbda7b0 never reached a verdict (found by the review role 2026-11-16)

The post-merge review of commit `7bbda7b0fffc1bfd591a71d19d61bf8188e2d07c` (Anchor the stranded-plan done-stamp to the entry's own trailing clause) never reached a verdict: This operation was aborted. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

### Five root-walk tests fail on a shared host once a stale `.tumwater` dir sits at the system temp root (found by the bugfix role 2026-11-16)

Found while verifying a fix: a full `npm test` reded on exactly five tests, all in the `.tumwater`-root-walk family — `findTeamRoot` / `nearestTumwaterRoot` / `writeFullOutput` (test/check-slots.test.ts, test/paths.test.ts, test/full-output.test.ts) — and they pass in isolation on a clean host. The five are `findTeamRoot finds the ancestor holding .tumwater/state`, `writeFullOutput returns null when no ancestor has .tumwater/`, `findTumwaterRoot walks up to the harness root`, and the two `nearestTumwaterRoot` cases.

**Reproduce.** `npm test` on a host whose `os.tmpdir()` is a directory that already holds a `.tumwater` dir with a `state` subdirectory. On this shared host the system temp root is `/tmp` and a leaked `/tmp/.tumwater/state` (from an earlier run) sat there, so the tests walked up from their per-test temp dir into `/tmp/.tumwater/state` and returned `/tmp` (or the wrong root) instead of `null`, failing the assertion "a dir with no `.tumwater`/`state` ancestor has no team root." The same tests pass in isolation on a host whose `os.tmpdir()` is a clean per-user dir, and the suite's `--affected` gate is green.

**Suspected cause.** The root-walk tests create per-test dirs under `os.tmpdir()` (the `tmpdir()` fixture, test/fixtures/repo-fixtures.ts) and assert "no ancestor has `.tumwater`/`state`", but they have no quiet-host skip and no guard against a `.tumwater` dir at the temp root. On a shared host that already holds a stale `.tumwater` (leaked by an earlier run — the same `$TMPDIR/.tumwater` poisoning recorded in BUGS-FIXED, the `runAgent` notes-shim fallback), those assertions fail. A full suite that runs with the system temp root as `os.tmpdir()` can also write its own `.tumwater` there (it creates `<tmp>/.tumwater/{bin,log}`), so the poison is self-perpetuating run-to-run on such a host.

## Fixed

### `an aborted run releases its pipe handles, so an escaped separate-group daemon adds no harness handle` failed, then passed on the same tree (quarantined by tumwater 2026-11-16) — fixed 2026-11-16 by the review role

The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves `## Open`. Find why it is unstable and fix it.

**Fix.** The flake was the test's own wait, not a release regression: after the settle released the harness's pipe read-ends, the assertion slept a fixed 500 ms and then read `process.getActiveResourcesInfo()`, so on a loaded host the destroy/close — which lands on a later event-loop tick — had not landed yet and the `PipeWrap`/`ProcessWrap` count still read above baseline (the 2026-11-16 fail-then-pass on the same tree is that race). The change (test/process-group.test.ts) replaces that fixed sleep with `waitFor(() => handles() <= baseline, …, 5_000)`: a bounded deadline that resolves the instant the released handles actually close, and for a settle that never releases them fails deterministically at the 5 s bound instead of flaking — the risk the commit names. The release side the wait exercises is `releaseChildHandles` at settle in src/process/process-group.ts, which destroys both read-ends and unrefs the child, so the `handles()` baseline (counted before the run) is the value the released handles return to. I rebuilt `dist/test/process-group.test.js` and ran it three consecutive times: 6 pass / 0 fail each, the fixed test green without a fixed sleep. The `## Open`→`## Fixed` move is guardrail-safe: `strandedPlanEntries` is PLANS.md-only, and `hiddenFixedRecordReason` flags only a newly merged multi-block `## Fixed` body (this entry carries a single `**Fix:**` block).

**Validation gap:** no-repro — the flake fires only on a loaded host (the 2026-11-16 "failed, then passed on a re-run of the same tree"), which no offline path can summon on demand; the regression it pins is deterministic in the opposite direction — a settle that does not release the handles now fails at the 5 s deadline rather than flaking.

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
