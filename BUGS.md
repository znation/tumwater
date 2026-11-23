# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open


### The merge gate's red-main exemption can fail to fire, so a change that adds no new failures is rejected while main is red (mirrors GitHub issue #5; found by the director role 2026-11-22)

With main red on the no-repro count guard (`test_the record count does not grow`: the no-repro tag grew past its baseline), an operator watched role merges rejected citing that same test - the one main already fails - and 16 merge pins sat undrained until the fleet spun. The gate's own note (`describeMainRed` in src/baseline/main-red.ts) promises "changes that add no new failures still merge"; the note and the behavior disagree.

**Reproduce.** Declare `check.command` with no `check.rerunCommand` and no `test:rerun` script, make main red on one named test, and queue a role branch that touches no test that main fails: the gate's `merge_failed result=rejected` reason quotes main's failing check line rather than merging. Reproduce the restart half by restarting the harness while main is red (the watch's `main_settle` red event does not re-run before the next merge) and merging a red-main-clean branch. Observed on the operator's machine 2026-11-22 (`events.jsonl` span 1795284892088-1795286461245, `main_check` events red on the guard test, then `merge_failed result=rejected` citing it).

**Cause.** The gate asks `mainTipFailures` (src/baseline/main-red.ts) whether the change's failing tests are main's own, and `gateBuildPrecheck` (src/review/review-precheck.ts) rejects with `knownMainFailure` false on three paths that all contradict the note:

- `onlyKnownMainFailures` reads the in-memory named/id sets in src/baseline/main-known-failures.ts, filled only by the main watch (`setKnownMainFailures` in src/baseline/main-settle.ts on a fresh red verdict). A restart into a red main restores the red *verdict* (`restoreRedVerdict` in src/baseline/main-baseline.ts fills `mainRedState.baselineCache`) and leaves those sets empty, so the watch knows main's named failures and the gate's comparison arm does not.
- `mainTipFailures` returns `unavailable` - also a rejection - whenever it cannot compare. With no `rerunCommandOf` (src/build/build-check-detect.ts) the `canRerun` arm is off, so the comparison needs a fresh *full* check of main's tip (`mainTipVerdict` with `forceFresh`), which yields `unavailable` on every skip or timeout and starves the merge slot besides.
- The `unavailable` and `own` rejections put the raw check line first in `reasons` (`rejectionReasons` in src/review/review-precheck.ts), and `mergeFailureReason` (src/merge/merge-slot.ts) reports only `reasons[0]` - so the event named the guard test and never said which arm decided, which is why this reads as "the gate rejects red-main-clean changes" rather than as a failed comparison.

**Notes for the fixer.** Seed the named/id sets from the restored red verdict - a `main-known-failures.ts` setter called from `restoreRedVerdict` with `baseline.named` / `baseline.ids` - and stop rejecting a change whose failing test main's red verdict already names by name when the comparison is `unavailable` (`namedFailureResult` can compare `namedFailuresOf` against `mainRedState.baselineCache.verdict.baseline.named`). Name the deciding arm in `reasons` (a `main red: known failure` / `main red: comparison unavailable` prefix from `gateBuildPrecheck`) so `mergeFailureReason` says what decided. Extend `restores a red baseline` and `a named failure is confirmed red at main's tip` in test/test-main-baseline.test.ts and `merge red-main named failures` / `merge red-main guard failures` in test/test-merge-pipeline.test.ts with a restart-into-a-red-main case, and assert the arm prefix where `merge red-main guard failures` asserts the guard line is reported. Update the red-main guarantees in docs/invariants.md (INV-CZ1) in the same change. Out of scope: the `aborted` (red-main requeue) path the issue also mentions is INV-CZ1's designed behaviour - leave it.

### The bugfix-wait auto-close commits its archive to main without running the check, so a `no-repro` record that breaks the ledger guards reds main and freezes the fleet (mirrors GitHub issue #4; found by the director role 2026-11-22)

The operator auto-close path ("bugfix wait saw no recurrence in 7 days") archived a bug from `BUGS.md` into `BUGS-FIXED.md` tagged `no-repro` with no reproduction, and the checked project's ledger guard tests went red on main immediately: `test_every_record_names_a_reproduction` (the new record names no reproduction) and `test_the_record_count_does_not_grow` (7 `no-repro` records against the ledger's baseline of 6), in that project's `tests/test_validation_gaps.py` (tumwater 0.9.0, Linux x64). The guards worked as intended; the commit that tripped them — `tumwater(operator): Close 1 bug whose bugfix wait saw no recurrence in 7 days` (reporter's `856baac9b`) — was authored by tumwater's own tooling and left a state the merge gate could never pass: every later role merge was rejected citing the same failing check (the red-main consequences are the two entries above, mirroring issue #5; this entry is the commit that made main red). No in-fleet path returned that main to green.

**Reproduce.** In any project whose declared check contains such ledger guards, give `BUGS.md` one open entry with an exactly-7-day-old `**Needs review <date> by bugfix: …**` wait note and no matching quarantine flake, and hold the project's `no-repro` tag at its baseline count. `closeQuietWaits` (src/baseline/main-watch-quarantine.ts) → `closeQuietBugWaitsOnMain` (src/backlog/backlog-bug-waits.ts) returns `{status:"closed"}`, writes `BUGS-FIXED.md` with `**Validation gap:** no-repro — the failure never came back to show its cause, so the bug closes unexplained.`, and commits it on the base branch; the next check run fails the two guards above. No test asserts the shipped archive is checkable — `grep -rn "runScopedBuildCheck|runBuildCheck" src/backlog/*.ts src/baseline/main-watch-quarantine.ts` prints nothing, and test/bug-waits.test.ts (`closeQuietBugWaitsOnMain commits the close on main, does nothing while every wait is young, and skips a dirty BUGS.md`) asserts only that the close commits.

**Cause.** The path commits directly on the base branch with no check at any point. `closingLines` writes the record: a `**Fix:**` paragraph naming no code (the false-fix rule reads only that paragraph, via `fixSymbols` in src/verdict/fix-claim.js) and the hardcoded `**Validation gap:** no-repro — …` line. `closeQuietWaitsText` moves the entry and `closeQuietBugWaitsOnMain` stages both backlog files and commits (`commitOnlyArgs`) under the merge lock plus the primary-worktree lock — a commit of the *primary* worktree's tree, which is never checked. That function never builds and never consults `check.command` (`grep -n "runScopedBuildCheck\|runBuildCheck\|check\.command" src/backlog/backlog-bug-waits.ts` prints nothing), so a record that violates the project's own guard tests is on main before anything notices. There is no back-out: the fleet is frozen behind the red main the guard tests report.

**Notes for the fixer.** Land the close only if main would still pass its check afterwards — the same contract the post-merge reviewer's fix was fixed to honour (BUGS-FIXED.md "A post-merge reviewer's fix lands on main with no check, so a broken repair turns main red", fixed 2026-11-04: `mergeReviewerFix` calls `gateBuildPrecheck` in src/review/review-precheck.ts before landing). In `closeQuietBugWaitsOnMain`, after both files are written and before the commit, run `runScopedBuildCheck(root, "operator", "gate", …)` against a detached worktree at `base` carrying the two written files (`ensureDetachedWorktree` in src/git/worktree.ts, then write the files into it; `mainTipGateVerdict` in src/baseline/main-red.ts and `cachedBaselineVerdict` in src/baseline/main-baseline.ts are the existing mirrors of this shape, and `CHECK_TIER.merge` in src/concurrency/check-permit.ts is the permit tier a merge-window run takes). On a red verdict, run the existing `restore` closure to roll the primary worktree back, release the locks, and return `{status:"skipped", reason}` naming the check's failing line; `closeQuietWaits` already turns a `skipped` outcome into one warning through `state.lastCloseWarning` (src/baseline/main-watch-quarantine.ts), and the entry stays open in `BUGS.md` for the operator, which is the issue's second remedy — do not also raise a UI warning beyond that one event. If the check errors (`status: "error"`) or is skipped for budget, keep the close (INV-BI8's "a failure to close must not stall the watch") and say so in the reason. A second remedy the issue offers — retagging the record to a tag with ledger headroom so the close succeeds — is a product decision about what the ledger should count; it needs the `Validation gap` tag vocabulary and the baseline counts chosen explicitly, so keep it out of this fix and let the operator plan it separately. Update INV-BI8 (docs/invariants.md) in the same change: it currently promises the archive row keeps that exact `no-repro` sentence and never says a close must keep main green. Tests: in test/bug-waits.test.ts, a close whose check goes red leaves `BUGS.md` untouched, `BUGS-FIXED.md` uncreated, and no new commit on the base branch (assert the base branch's `git log --oneline | wc -l` is unchanged and the `{status:"skipped"}` reason names the failing check), and a close whose check is green still commits as today — drive the verdict the way the existing check tests do, by declaring `check.command` in the fixture config as a script that exits 1 (or 0), not by running this repo's real suite.

### `tumwater logs --since` and `history --since` refuse any window over 7 days, but neither command's docs/cli.md entry names the cap (found by the qa role 2026-11-22)

**Symptom.** docs/cli.md presents the two trailing-window reads unbounded — its Watch-state row spells
```
tumwater logs --since <duration> [--until <duration>]
```
and says only that `--until` "ends the window that long ago … it requires `--since`, must be shorter than it" (line 61); its Watch-run-history row likewise lists `[--since <duration> [--until <duration>]]` with the same "requires `--since`, must be shorter than it" prose and no bound (line 59). An operator who follows that literally is refused: `tumwater logs --since 30d` exits 1 with `tumwater: logs --since is capped at 7d (got 30d)`, and `--until` is capped too (`logs --since 3d --until 8d` → `tumwater: logs --until is capped at 7d (got 8d)`), so the docs' own worked example space widens into refusals just past a week. the cap is documented for the sibling command and in the built-in help but not on these two rows: `grep -o "capped at 7d" docs/cli.md` counts 2 occurrences, both on line 70 (the `report --since` rows), and `grep -o 7d` counts 0 on lines 59 and 61; `tumwater help` does print the bound for both (`logs … --since shows the events of the past window (capped at 7d)`, `history … --since <duration> shows the window's runs instead of the last N (capped at 7d, like logs --since)`). So only an operator who reads `--help` learns the bound; the reference doc the README sends them to ("Every command and flag is in docs/cli.md") does not carry it.

**Reproduce.** Offline, no model and no `gh`. `mktemp -d`, `git init -b main`, `node <dist>/src/cli.js init "x"`, then seed `.tumwater/log/events.jsonl` with one `run_end` per day for the 16 days back (`{"ts":<now − N×86400000>,"loop":"feature","type":"run_end","run":N,"result":"merged","summary":"dN"}`, N = 1..16) and `.tumwater/log/events.jsonl.1` with the same shape for N = 17..40 (observed 2026-11-22 on a worktree at main's tip, dist built from the tree):

```
$ tumwater logs --since 7d --count     6 × run finished (run_end)            exit 0
$ tumwater logs --since 30d            tumwater: logs --since is capped at 7d (got 30d)   exit 1
$ tumwater logs --since 3d --until 8d  tumwater: logs --until is capped at 7d (got 8d)    exit 1
$ tumwater history --since 30d         tumwater: history --since is capped at 7d (got 30d) exit 1
$ tumwater history --since 4d --until 8d  tumwater: history --until is capped at 7d (got 8d) exit 1
$ tumwater report --since 30d --failures tumwater: report --since is capped at 7d (got 30d) exit 1
```

The bound is unit-scale too, not just a day spelling: `--since 168h` reads the window, `--since 169h` is refused. `--until` alone still fails its documented precondition first (`logs --until 2d`, `history --until 2d` and `report --until 2d` each exit 1 with `--until requires --since`), so the cap only bites a well-formed window. The cap is intentional, not a defect in the bound: it lives in one place (`LOGS_SINCE_MAX_MS` and `REPORT_SINCE_MAX_MS`, both `7 * DAY_MS`, src/events/event-window.ts:28 and :34, whose comments give the rationale — a longer window re-reads more log without adding signal because the log rotates at 16 MB) and is pinned by tests (`test/cli-logs-filtering.test.ts:92` asserts `/capped at 7d/`, `test/cli-history-filtering.test.ts:108` asserts the exact `history --since is capped at 7d (got 8d)`). Consistent with that rationale, the same seeded log shows a 30-day read could not be served from disk anyway: `tumwater logs --count` and `tumwater logs -n 1000 --count` printed only the 16 events in `events.jsonl`, never the 24 older ones in the rotated `events.jsonl.1`.

**Cause.** The 7-day bound was added on the CLI's flag validation and the report rows' prose at the same time, but the logs and history rows of docs/cli.md were never given the matching clause: the doc file states the cap in exactly one place (line 70, the `report --since` and `report --failures --since` rows) and the logs and history rows keep their pre-cap wording. The help text — generated separately in src/cli/cli-help-text.ts — carries it for all three, so the gap is docs/cli.md alone.

**Fix.** Two clauses, no code change: name the cap on each row the way line 70 already names it — the line-61 phrase becomes `tumwater logs --since <duration> [--until <duration>]` (`--since` shows a trailing window capped at 7d, like `report --since`; …), and the line-59 history row's `[--since <duration> [--until <duration>]]` prose gains the same "capped at 7d, like `logs --since`" clause the help text already uses for history. The invariants doc names no window bound today (`grep -n "since.*cap" docs/invariants.md` finds nothing), so nothing there needs amending; the two tests above already pin the enforced wording.

**Notes for the fixer.** docs/cli.md's rows are single very long table lines — line 59 (history), line 61 (status/logs/brief/reviews) and line 70 (doctor/report) — so patch by phrase, not by line rewrite, and confirm the exact anchor strings first: `` tumwater logs --since <duration> [--until <duration>]`` `` occurs once, on line 61, and history's flag list `[--since <duration> [--until <duration>]]` and its prose `` `--until` ends the `--since` window that long ago`` `` each occur once, on line 59 (grep -on for each). Do not widen the bound: the report's cap, the dashboard feed and history clients (`src/ui/gui/gui-client-feed.ts`, `src/ui/gui/gui-client-history.ts`, which comment that they mirror `LOGS_SINCE_MAX_MS`) and the pinned test wording all read the same 7 days.

### A Codex home's multi-hundred-MB rollout files are read whole into the heap, so `tumwater run --gui` OOMs within seconds of startup (mirrors GitHub issue #1; found by the director role 2026-11-22)

**Symptom.** `tumwater run --gui --port 7181` on 0.9.0 (build `9efbd3df`, node v24.19.0, Linux x86_64)
prints the two startup lines and the `tumwater started` event, then dies on its own ~12 s later with
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, exit code 1. The
gc log shows the heap already at 4047 MB on the first scavenge it prints (default ~4 GB limit), and the
native trace's last V8 frame is `v8::String::NewFromUtf8(isolate, char const*, NewStringType, int)` — a
single very large UTF-8 string being materialized, not a slow leak (reporter's trace, GitHub issue #1).

**Reproduce.** Not reproduced locally: the reporter's 0.9.0 build is not runnable here and this machine's
`~/.codex` is too small to trip it — measured today, 844 MB overall but only 8.6 MB under `sessions/`, 38
`rollout-*.jsonl` files and none over 20 MB — so everything below is code reading plus the reporter's
trace, and a repro must synthesize the file. The shape a fix run
can build offline: point the team's codex home at a scratch directory whose `sessions/`
hierarchy holds one `rollout-<time>-<uuid>.jsonl` of a few hundred MB of plausible jsonl, with a codex
seam configured, and watch the reader's RSS / heap — `node --max-old-space-size=256` turns the same read
into a fast, cheap OOM that pins the site. BUGS-FIXED.md's entry "Codex runs default to the operator's
own `~/.codex`, filling it with team sessions, part 1/2" measured that very home at 2.9 GB with 701 MB
under `sessions/`, so these files are routinely tens-to-hundreds of MB on a real operator machine.

**Cause.** Unbounded whole-file reads of Codex rollouts. Two survive on main's tip:
`afterRun`'s usage fallback in `src/agent/codex/codex-backend.ts` (`text = fs.readFileSync(rollout,
"utf8")`, then `rolloutLines(text, …)`, whose `text.split("\n")` at `src/agent/codex/codex-rollout.ts`
makes a second full copy plus one string per line — several times the file's bytes in heap at once), and
`codexSessionCredits` in `src/doctor/doctor-codex-checks.ts`, which `walkFiles` over `<home>/sessions`,
then `readTextOrNull(r.file)` every `rollout-*.jsonl` whole, newest-mtime first, until one matches the
`"has_credits"` regex (the same newest-by-mtime order its own test pins). Neither statures the file or
bounds the read. A third site — and the one the
reporter's build actually had uncapped — is the Codex hook-trust lookup: at `9efbd3df`
`lookupCodexHookTrust` and `codexHookTrust` in `src/agent/codex/codex-hook-trust.ts` accumulated the
child's stdout with `buffer += chunk` and `out += chunk` with no cap; `5409d5e9b` bound them
(`TRUST_PROBE_MAX_OUTPUT_BYTES` 1 MiB + `captureCappedOutput`) and that commit is **not** an ancestor of
`9efbd3df` (`git merge-base --is-ancestor 5409d5e9b 9efbd3df` → false), so the reporter's build was
missing it. `grep -n "+= chunk"` over that build names those two as its only accumulating sites with no
cap of any kind; every other one already carried a byte ceiling or kept only a re-sliced tail, then and at
main's tip — `EXEC_MAX_BUFFER` in
`src/git/git-run.ts`, `opts.maxBuffer` in `src/process/process-group.ts`, `maxOutputBytes` in
`src/process/bounded-probe.ts` (`src/doctor/doctor-probe.ts` in that build), `captureCappedOutput` in
`src/process/process.ts`, `MAX_NATIVE_LINE_CHARS` (16 MiB per line) + a 64 KB stderr tail in
`src/agent/agent-stream.ts`, the body cap in `src/gui/gui-http-body.ts`, and the line-framed
`this.buffer` in `src/pi/pi-stream.ts`, which keeps only the trailing partial line. `indexRollouts` in `src/agent/codex/codex-rollout.ts` walks names
only — it never reads a rollout. Which site fired on the reporter's machine is not established: all three
are on the Codex path and the reporter did not say whether any seam routes to codex. The trust lookup is
the best fit for the timing — it runs in the backend's `prepare`, i.e. at the start of the first codex
run, where `afterRun` needs a finished run and `codexSessionCredits` runs only from doctor
(`checkCodexAccount` in `src/doctor/doctor.ts`, not a startup gate: the dashboard's Settings view is what
fetches `/api/doctor`). The startup gate does touch Codex's home (`seedCodexAccount` → `probeLoginStatus`
in `src/agent/codex/codex-account.ts`, `spawnSync codex login status`), but `spawnSync` carries its own
1 MiB default `maxBuffer` and a `null` return, so it cannot balloon the heap.

**Notes for the fixer.** One theme: no Codex rollout is ever materialized whole. (a) `afterRun` already
documents that the reader "selects the last block, this run's" from the file, so a tail read is
semantically correct — `readTailText` / `readTailTextWithEnd` in `src/files/tail.ts` is the existing
bounded reader, or gate on `statOrNull(rollout)` size and fall through to the existing `fallback()` above
a ceiling. (b) `codexSessionCredits` needs one regex hit, not the file: scan incrementally with
`forEachTailChunk` / `readCompleteLines` (same module), or skip a rollout above a stated byte ceiling and
keep the loop's "newest match wins" order; state the chosen bound in the function's doc comment. (c)
Keep the fix to those two reads. The reporter's last V8 frame is `NewFromUtf8` on a whole-file decode, and
the `+= chunk` sites `grep -rn "+= chunk" src` finds on main are all bounded or not buffers at all — the
trust probe's `buffer += chunk` behind a byte-count check against `TRUST_PROBE_MAX_OUTPUT_BYTES`,
`captured[stream] += chunk` behind `captureCappedOutput`'s `maxBuffer` in `src/process/process.ts`, and the
three `+= chunk.length` counters in `src/gui/gui-http-body.ts` that append nothing. `src/agent/agent-stream.ts`'s
two `+= text` buffers are re-sliced in place too (the 16 MiB `MAX_NATIVE_LINE_CHARS` native line and the
64 KB stderr tail). The one accumulation with no byte
cap is `this.buffer += chunk` in `src/pi/pi-stream.ts`'s `feed`, which keeps only the trailing partial line
(it has no newline); leave it alone unless the repro lands there, and if it does, say so and raise it as its
own entry rather than widening this fix. If a scratch `CODEX_HOME` with a huge rollout does not reproduce the crash, say so in the
record rather than guessing: the reporter's stack would then need a heap snapshot
(`--heapsnapshot-signal=SIGUSR2`) follow-up, which is a question for the operator, not a guess here.
Tests go where these readers are tested today: `test/codex-rollout.test.ts`
(`reading without a turn id takes the last block — the just-finished run`), `test/codex-run.test.ts` for
the `afterRun` fallback, and `test/doctor-checks.test.ts`
(`checkCodexAccount warns when the account has credits and reads ok otherwise`, whose fixture home already
writes rollout files and orders them by mtime). Drive them with a fixture rollout a few KB and an injected
byte ceiling, never a real multi-hundred-MB file, and never a real model.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
