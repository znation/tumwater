# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A `checkpoint` call ends the run instead of compacting it: pi 1.5.2's `compact()` aborts the running turn first, so the run exits before any compaction is written

Filed 2026-11-15 by an operator session from the live team's logs (build 72a0b257, pi 1.5.2, qwenrunner Qwen3.8-27B).

**Symptom.** Since 11-12 the agent has called `checkpoint` and been accepted 113 times in role and review sessions under `.tumwater/sessions`. Each call returned "Checkpoint recorded; the context is being compacted", and in all 113 cases the next assistant message ended `stopReason: "aborted"`. None of those sessions contains a `compaction` entry. The harm differs by run type:
- **Authoring runs** end as cut off. The warning blames the context ceiling, and the run resumes on the full, uncompacted context. The cut-off bridge in `buildResumePrompt` (src/prompt/prompt-followup.ts) tells the model its work "is summarized above", but no summary exists. The wait before resuming had a median of 0.4 min, a 90th percentile of 54 min, and a maximum of 221 min.
- **Post-merge reviews** have no resume, so the review fails with "This operation was aborted". This happened 7 times on 11-14/15: 990e2906 ×2, 9e8e15e8 ×2, 34850403, 963e9219, and c4f34d74 ×2. Every one of those sessions ends right after a checkpoint tool result. The review of c4f34d74 was dropped after 3 failures (one 1800 s timeout and two of these aborts). By then it had a finished verdict and a PLANS.md repair in its worktree; both were lost, and the commit had to be reviewed by hand (BUGS-FIXED.md, "post-merge review of c4f34d74 never reached a verdict").

**How to reproduce.** Open any session that contains an accepted checkpoint call, for example `.tumwater/sessions/_review/feature/post-c4f34d74/2026-11-15T19-53-53-936Z_*.jsonl` or `_review/bugfix/post-34850403/2026-11-14T22-07-00-619Z_*.jsonl`. The `checkpoint` toolResult is followed by `"stopReason":"aborted"` with `"errorMessage":"This operation was aborted"`, and no `"type":"compaction"` line follows.

**Suspected cause.** `buildCheckpointTool` (src/pi-extension/checkpoint.ts) calls `ctx.compact()` from inside the tool's `execute`. pi 1.5.2 makes two choices that turn this into an abort:
- The extension context's `compact` runs `void (async () => { await this.compact(...) })()`, which starts the compaction without waiting for it (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:2927`).
- `AgentSession.compact()` starts with `await this.abort()` (:2326), which aborts the very turn that is executing the tool.

So the agent loop ends `aborted`. In `--print` mode pi then exits before the background compaction (a summary model call followed by a session write) can finish. 90fd4faef (11-14) changed only what the summary contains, not this ordering.

**Required behavior.** An accepted checkpoint must leave the session compacted. The run should then continue, or end in a resumable state whose resume really is compacted. A checkpoint must never cost a review its verdict. Possible approaches:
- Defer compaction to a turn boundary the extension can await, such as `turn_end` or `agent_end`, if pi's API allows that.
- Have the runner recognize an abort that follows a checkpoint and run the compaction itself before resuming with the bridge.
- Until either exists, leave `checkpoint` out of the tool list for reviews.

In any case, the cut-off warning should not blame the context ceiling when the run actually ended on a checkpoint.

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

**Required behavior.** No role is re-run for leftover recovery while its own pin is still pending, meaning the merge ref exists and points at the worktree's tip. The role should be deferred until its merge settles. Make one role-agnostic check that generalizes the director's fix rather than adding another per-role case.

### post-merge review of a88d62b4 never reached a verdict (found by the review role 2026-11-16)

The post-merge review of commit `a88d62b4bce0f5b19a22e0944fd170b7d4c6ad42` (Pin secretLeakReason's two untested changed-file guards in test/secret-leaks.test.ts) never reached a verdict: This operation was aborted. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

### `an aborted run releases its pipe handles, so an escaped separate-group daemon adds no harness handle` failed, then passed on the same tree (quarantined by tumwater 2026-11-16)

The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves `## Open`. Find why it is unstable and fix it.

~~~~
an aborted run releases its pipe handles, so an escaped separate-group daemon adds no harness handle
~~~~

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
