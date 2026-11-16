# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

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

### post-merge review of a88d62b4 never reached a verdict (found by the review role 2026-11-16)

The post-merge review of commit `a88d62b4bce0f5b19a22e0944fd170b7d4c6ad42` (Pin secretLeakReason's two untested changed-file guards in test/secret-leaks.test.ts) never reached a verdict: This operation was aborted. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

### `an aborted run releases its pipe handles, so an escaped separate-group daemon adds no harness handle` failed, then passed on the same tree (quarantined by tumwater 2026-11-16)

The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves `## Open`. Find why it is unstable and fix it.

~~~~
an aborted run releases its pipe handles, so an escaped separate-group daemon adds no harness handle
~~~~

### post-merge review of 7bbda7b0 never reached a verdict (found by the review role 2026-11-16)

The post-merge review of commit `7bbda7b0fffc1bfd591a71d19d61bf8188e2d07c` (Anchor the stranded-plan done-stamp to the entry's own trailing clause) never reached a verdict: This operation was aborted. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
