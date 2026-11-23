# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A red check's reasons number node:assert's own dump, the test runner's frames, and lint's
status line, so one rejection asks the author to answer ten lines of plumbing
(found by the selfcheck role 2026-11-22)

**Symptom.** When `npm run test:gate` goes red, the author's next run is told to answer each
numbered objection (src/prompt/gate-notes.ts:73 numbers them, :82 demands "Add one Objection N:
<done|dropped|unchanged-by-design because …>" for each) and the reviewer is told to "Check each of
the prior review's numbered objections FIRST — an unresolved one is a rejection on its own"
(src/prompt/gate-prompts.ts:202). Most of those objections name nothing the author can act on: they
are node:assert's own dump, the test runner's frames, and the lint runner's status line. On
`c4b6505b` (merged 2026-11-22, the digest's top loss cluster) the queued change's `Prior-review:`
trailer carried 11 reasons with `counts: [0,0,0,0,0,0,0,0,0,0,0]`, and the merged commit body spends
ten `Objection N:` lines answering them — six of them (2, 3, 4, 8, 9, 10) say things like
`done — same failure's stack frame; resolved by the fix above`, `unchanged-by-design because
`deepEqual` is the check's own pre-existing operator, which I did not touch`, and
`unchanged-by-design because lint was already clean`. Those turns bought nothing: the change was one
doc-command fix plus an invariant renumber.

**Reproduce.** Read `git log -1 --format='%b' c4b6505b`'s `Prior-review:` trailer: reasons 2-3 are
`at TestContext.<anonymous> (file:///…/dist/test/…)` and
`at Test.runInAsyncScope (node:async_hooks:226:14)`; 4-10 are `generatedMessage: true,`,
`code: 'ERR_ASSERTION',`, `actual: …`, `expected: []`, `operator: 'deepStrictEqual',`,
`diff: 'simple'`, `}`; 11 is `lint: clean`. The same shape is quoted verbatim in
PLANS-DONE.md:2445 "Remove the TUI, part 1/5" under `**Needs review 2026-11-20 by feature: rejected
after 6 review rounds**` (its "Objections that survived the final round" list at :2473, same
numbers 2-11) and in BUGS-FIXED.md:282's `invariants-doc` quarantine block: each carries the same
plumbing lines — the runner's `at Test.runInAsyncScope (node:async_hooks:226:14)` frame,
`generatedMessage:`, `code: 'ERR_ASSERTION',`, `operator: …`, `diff: 'simple'`, `}` and
`lint: clean` — whatever the failing test was. Which lines of the dump survive depends on what
precedes them in the 10-line window: `c4b6505b`'s list carries both runner frames, the offline repro
below kept only one.

Offline reproduction, no model and no gate: build the tree, then pass node:test's own output for one
failed `deepStrictEqual` through `clipBuildTail` and `checkFailureReasons`. On this worktree's tip
(`30fde732`) that printed 11 reasons for the single failing test: the headline, then
`at Test.runInAsyncScope (node:async_hooks:226:14)`, `{`, `generatedMessage: true,`,
`code: 'ERR_ASSERTION',`, `actual: [ 'docs/invariants.md:5598 run' ]`, `expected: []`,
`operator: 'deepStrictEqual',`, `diff: 'simple'`, `}`, `lint: clean` — 8 of the 11 lines say nothing
about the diff.

**Suspected cause.** `checkFailureReasons` (src/build/build-check-report.ts:246) returns the
headline plus every surviving `clipBuildTail` line, one reason per line. The 2026-10-20 fix
(PLANS-DONE.md:28404 "A red check's reasons drop Node's own `node:internal` stack frames…") dropped
only what `NODE_INTERNAL_FRAME` matches, and its doc comment says so explicitly: a frame in
`node:async_hooks` or a `dist/test/` file is kept. So these still become numbered objections: the
runner's non-`node:internal` frames, node:assert's mechanics keys (`generatedMessage`, `code`,
`operator`, `diff`, the closing `}`), and `lint: clean` — `test:gate` runs
`scripts/lint-changed.mjs --alongside`, which prints that line last
(scripts/lint-changed.mjs:71, pinned by test/lint-changed.test.ts), landing it inside the tail
window (`clipBuildTail`, src/build/build-check-report.ts:164-168).

This also mis-prices finality: `recordRejectedChange` counts each reason's persistence
(src/merge/merge-core.ts:395-399) and ends the reject→revise chain when one objection survives two
revisions (`REVISION_FINAL_ON_REPEAT = 2`, src/runner/runner-revision.ts:34) or the chain hits
`REVISION_BACKSTOP` (6); `holdEntryAfterExhaustion` then parks the entry on those reasons verbatim
(:413). A plumbing line cannot be fixed, so a revision that re-runs the same red check restates it:
the TUI removal part reached the backstop and its Needs-review note lists all eleven surviving
objections, of which only reason 1 and the `actual:` line name a finding.

**Fix direction.** In `checkFailureReasons`' verified branch, drop the lines that describe the
checking machinery rather than the finding — the runner frames `at Test.runInAsyncScope (…)` and
`at TestContext.<anonymous> (…/dist/test/…)`, node:assert's mechanics keys (`generatedMessage:`,
`code: 'ERR_ASSERTION'`, `operator:`, `diff:`, a bare `{`/`}`), and `lint-changed`'s own status
lines — while keeping `actual:` and `expected:`, which are the assertion's diff and are why the
2026-10-20 fix widened the window. `c4b6505b`'s 11 reasons become 3. Keep the `unverified` branch
unchanged.

**Cost that makes it fileable.** The digest's top loss cause: 2.3 h · $0.46 across 4 runs on
"review-rejected authoring on bugfix — check failed (`npm run test:gate`): ✖ every command the
docs quote is a command `tumwater help` lists", plus 1.5 h · $0.00 across 3 robustness runs on the
comment-column scan — the same one-line finding, ten lines of objections each time.

### The merge gate's red-main exemption can fail to fire, so a change that adds no new failures is rejected while main is red (mirrors GitHub issue #5; found by the director role 2026-11-22)

With main red on the no-repro count guard (`test_the record count does not grow`: the no-repro tag grew past its baseline), an operator watched role merges rejected citing that same test - the one main already fails - and 16 merge pins sat undrained until the fleet spun. The gate's own note (`describeMainRed` in src/baseline/main-red.ts) promises "changes that add no new failures still merge"; the note and the behavior disagree.

**Reproduce.** Declare `check.command` with no `check.rerunCommand` and no `test:rerun` script, make main red on one named test, and queue a role branch that touches no test that main fails: the gate's `merge_failed result=rejected` reason quotes main's failing check line rather than merging. Reproduce the restart half by restarting the harness while main is red (the watch's `main_settle` red event does not re-run before the next merge) and merging a red-main-clean branch. Observed on the operator's machine 2026-11-22 (`events.jsonl` span 1795284892088-1795286461245, `main_check` events red on the guard test, then `merge_failed result=rejected` citing it).

**Cause.** The gate asks `mainTipFailures` (src/baseline/main-red.ts) whether the change's failing tests are main's own, and `gateBuildPrecheck` (src/review/review-precheck.ts) rejects with `knownMainFailure` false on three paths that all contradict the note:

- `onlyKnownMainFailures` reads the in-memory named/id sets in src/baseline/main-known-failures.ts, filled only by the main watch (`setKnownMainFailures` in src/baseline/main-settle.ts on a fresh red verdict). A restart into a red main restores the red *verdict* (`restoreRedVerdict` in src/baseline/main-baseline.ts fills `mainRedState.baselineCache`) and leaves those sets empty, so the watch knows main's named failures and the gate's comparison arm does not.
- `mainTipFailures` returns `unavailable` - also a rejection - whenever it cannot compare. With no `rerunCommandOf` (src/build/build-check-detect.ts) the `canRerun` arm is off, so the comparison needs a fresh *full* check of main's tip (`mainTipVerdict` with `forceFresh`), which yields `unavailable` on every skip or timeout and starves the merge slot besides.
- The `unavailable` and `own` rejections put the raw check line first in `reasons` (`rejectionReasons` in src/review/review-precheck.ts), and `mergeFailureReason` (src/merge/merge-slot.ts) reports only `reasons[0]` - so the event named the guard test and never said which arm decided, which is why this reads as "the gate rejects red-main-clean changes" rather than as a failed comparison.

**Notes for the fixer.** Seed the named/id sets from the restored red verdict - a `main-known-failures.ts` setter called from `restoreRedVerdict` with `baseline.named` / `baseline.ids` - and stop rejecting a change whose failing test main's red verdict already names by name when the comparison is `unavailable` (`namedFailureResult` can compare `namedFailuresOf` against `mainRedState.baselineCache.verdict.baseline.named`). Name the deciding arm in `reasons` (a `main red: known failure` / `main red: comparison unavailable` prefix from `gateBuildPrecheck`) so `mergeFailureReason` says what decided. Extend `restores a red baseline` and `a named failure is confirmed red at main's tip` in test/test-main-baseline.test.ts and `merge red-main named failures` / `merge red-main guard failures` in test/test-merge-pipeline.test.ts with a restart-into-a-red-main case, and assert the arm prefix where `merge red-main guard failures` asserts the guard line is reported. Update the red-main guarantees in docs/invariants.md (INV-CZ1) in the same change. Out of scope: the `aborted` (red-main requeue) path the issue also mentions is INV-CZ1's designed behaviour - leave it.

### The gate's red-main exemption can fail to fire, so a change that adds no new failures is rejected while main is red (mirrors GitHub issue #5; found by the director role 2026-11-22)

With main red on one guard test (the reporter's `test_the record count does not grow`: the no-repro tag grew past its baseline, red on main itself per their `main_check` events), an operator watched role merges rejected citing that same test — the one main already fails — and 16 merge pins sat undrained until the fleet spun. The harness's own red-main note promises otherwise: `warnMainRedOnce`'s `main_red_hold` message (src/baseline/main-red.ts) ends "changes that add no new failures still merge", and INV-CZ1 (docs/invariants.md) says a red main excuses only its own failures. The note and the behavior disagree.

**Reproduce.** Declare `check.command` with no `check.rerunCommand` and no `test:rerun` script (so `rerunCommandOf` finds nothing and `canRerun` is false), leave main red on one named test, and queue a role branch that touches none of main's failing tests: the merge ends `review_rejected` and `merge_failed result=rejected` quotes main's failing assertion line, not any attribution. Reproduce the restart half by restarting the harness while main is red, so the watch has not settled a verdict yet in this process, then merging a red-main-clean branch. As of 2026-11-22 no test covers either case: `grep -rn "restart\|reload" test/review-precheck-red-main-rerun.test.ts` finds none, and test/main-baseline-persist.test.ts (`a restart reloads a saved red with its failing tests, and a new run keeps them`) asserts only the verdict, never the gate's read of it.

**Cause.** The gate asks whose failure it is and rejects on paths that do not match the note:

- `knownFailureResult` (src/review/review-precheck.ts) excuses a failure through `onlyKnownMainFailures` (src/baseline/main-known-failures.ts), which reads the module-private known set — written only by `setKnownFailures` in src/baseline/main-settle.ts when the main watch settles a verdict in this process. A restart into a red main restores the red *verdict* (`restoreRedVerdict` in src/baseline/main-baseline.ts fills `baselineCache`) and leaves that set empty, so the watch's state knows main's named failures and the gate's first excuse arm does not.
- `attributeOnRedMain` only runs when `mainVerdictForFailure` returned `red`. Its `red` arm comes from `rerunAtMainTip` when `canRerun` holds; with no re-run command in effect, `mainTipFailures` falls back to `mainTipVerdict` with `forceFresh` — a full check of main's tip — which returns `unavailable` on a skip or timeout, and a skipped attribution check is common under load. `unavailable` makes `namedFailureResult` convict the change (its `own` arm is the whole `outcome.failingTests`), so a comparison that could not be made reads as main-clean.
- The reported reason hides which arm decided: `rejectionReasons` puts the raw check lines first and the attribution last (on red, `mainRedNotTheseFailures`; on unavailable, "main's baseline was unavailable"), and `mergeFailureReason` (src/merge/merge-slot.ts) reports `review.reasons[0]` only — so the event quoted the guard assertion and never said whether the change was convicted or the comparison failed. The `aborted` merges in the same window carry no reason because `mergeFailureReason` returns undefined for `aborted` by design (INV-CZ1's red-main requeue keeps the pin) — that half of the report is the designed path, not this bug.

**Notes for the fixer.** Two seams carry the exemption; make both read main's *recorded* failure set, not only the live watch state. (a) Seed the known set on restore — `restoreRedVerdict` (or the read in `knownFailuresFor`) must supply the restored red's `failingTests`, so a restart into a red main keeps the excuse INV-CZ1 promises. (b) With main's verdict `unavailable`, a named failure that main's newest recorded red already names must not be convicted as the change's own; keep convicting tests main's red does not name. Name the deciding arm in `reasons` (a red-main prefix from `rejectionReasons`, alongside `mainRedNotTheseFailures`) so `mergeFailureReason`'s `reasons[0]` says whether the change was convicted or main's verdict was unobtainable. Tests to extend: `a named failure that the re-run finds failing at main's tip goes on to review` in test/review-precheck-red-main-rerun.test.ts and `a named failure that still fails at main's tip stays red with the names that fail there` in test/main-red-tip-failures.test.ts — both need a restart-into-a-red-main case; `merge_failed carries the reason mergeFailureReason derives, and omits it otherwise` in test/merge-slot.test.ts covers the reason arm. Update the red-main guarantee in docs/invariants.md (INV-CZ1) in the same change.

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

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
