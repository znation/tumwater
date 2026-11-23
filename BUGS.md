# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

_None yet._

### An event type added to the `HarnessEvent` union is forced to have a label by tsc but its digest classification is checked only by a runtime test the budgeted gate may skip, so new event types land main red on that guard (found by the selfcheck role 2026-11-23)

**Cluster.** `check failed (npm run test:gate): ✖ every event type is replayed or explicitly excluded — …`
(1×, feature-3, 11-22, post-merge rejection — so the commit had already reached main). The same guard held main red
twice on 2026-11-21, verified by a first-parent walk comparing `git show <c>:src/events/event-labels.ts` against
`git show <c>:src/failure/failure-state-change.ts` at every commit: `55f36129d` (12:40, "Scan open GitHub issues
hourly into a mirror-state ledger") and `f46a13980` (12:44, "Log a review_dropped event when a post-merge review is
dropped") left it red until `5928d5538` (12:55, coverage #1001, "Classify review_dropped and github_issues_unavailable
in failure-state-change") — 15 minutes — and `d4ea1c618` (13:05) reddened it again
through `f27753fd5` (13:16) and `77fff10b3` (13:47) until `ae80f726f` (14:14, ci #255, "Classify new github_issue_*
events …") — 69 minutes. Those five merged commits each added an event type named in neither
`STATE_CHANGE_FAMILY` nor `STATE_CHANGE_EXCLUDED_TYPES`; none classified its own type.

**The wrong response (why this is a bug, not weather).** The label half of that guarantee is compile-enforced:
`EVENT_TYPE_LABELS: Readonly<Record<HarnessEvent["type"], string>>` (src/events/event-labels.ts:11) makes a missing
label a build error, so every one of those commits had its label. The classification half is
`Partial<Record<HarnessEvent["type"], (ev: HarnessEvent) => string>>` (src/failure/failure-state-change.ts:30-31),
so a missing entry is legal TypeScript, and the only thing that fails on it is one runtime test
(test/failure-state-change.test.ts:73, "every event type is replayed or explicitly excluded"). The merge gate runs
`npm run test:gate` = the affected tests under a 20 s budget, so the guard that a change is one import hop from
runs only if the budget happens to leave room for it: the change passes its own gate, main goes red, and the repair
is a separate ci or coverage run that re-derives the cause from scratch. The digest prices that repair: coverage
#1001 took 33 turns and ci #255 47 turns (their own WHY lines say the full check catches what the gate's
affected-only run misses), and the 11-22 occurrence reached a post-merge rejection at all — a commit already on
main, which is never re-reviewed.

**Reproduce.** Offline and deterministic, no model: replay the selection over each of the five commits' changed-file
lists with the current test-cost ledger. The guard ranks at distance 1 for all five, and `fitBudget` leaves it in
`fit.left` for `77fff10b3`'s list (7 test files run, 19 994 ms of the 20 000 ms budget, 10 118 ms of it already
spent on the `POLICY_SCANS` scans) while it fits inside the budget for the other four lists today. Whether the
guard runs therefore depends on the cost ledger of the moment, not on the change — that is the defect.

**Fix direction.** Move the guarantee from the budgeted test to the compiler, where it costs the gate nothing: make
the classification one exhaustive object literal keyed by every event type —
`Record<HarnessEvent["type"], ((ev: HarnessEvent) => string) | null>` with `null` naming a deliberately excluded
type — and derive `STATE_CHANGE_TYPES` (from the function entries) and `STATE_CHANGE_EXCLUDED_TYPES` (from the
`null` entries) from it. A new union member is then a tsc error until its author classifies it, exactly as the
label already is. That shape also closes a live defect the current guard cannot see: `github_issues_unavailable` is
listed twice in the excluded set's literal (src/failure/failure-state-change.ts:125 and :148), `new Set` collapses
the duplicate, and the test's partition assertion passes over it — a repeated key in an object literal is a compile
error. Keep test/failure-state-change.test.ts:73 as the runtime pin over the derived sets.

**Not this fix.** Registering `test/failure-state-change.test.ts` in `POLICY_SCANS` — the fix that closed the same
family in BUGS-FIXED.md's "The self-scan guard for the tmpdir rule is not in `POLICY_SCANS`, so the budgeted gate
passes over it and a change that adds offenders lands main red" (found 2026-11-17, fixed 2026-11-19) — would spend
the guard on every gate whatever the change touches; that family's guard is genuinely repo-wide, this one is
distance-1 to the file the change already had to edit. Raising the budget is off the table: QUESTIONS.md's "Should a
change to a widely read default run more than the budgeted gate?" (asked by the plan role 2026-11-21) was answered
the same day with option (a), keep the 20 s trade-off. The compile-time route keeps that trade-off and removes the
failure.

### `a pin surviving a restart drains through the gate on next start` fails its `merge_done` count in the full `npm run test:e2e` tier, then passes on the same tree — its wait keys on the pin's disappearance, which the merge deletes a settle turn before the event lands (found by the ci role 2026-11-23)

**Symptom.** Running the CI workflow's own e2e job (`npm run test:e2e`) against main tip `7d45b9c1` named only this test on its first two tier runs and named nothing on its third run of the untouched tree. The failing assertion is not the wait — the pin drained and `crash.txt` reached main; the count read after it did not:

```
✖ a pin surviving a restart drains through the gate on next start (380.200584ms)
  AssertionError [ERR_ASSERTION]: the surviving change merged through the gate

  0 !== 1

      at TestContext.<anonymous> (file:///…/dist/test/orchestrator-3.e2e.test.js:174:16)
```

The same line failed at 368.6 ms on the second tier run; on every passing run the test took 470–512 ms. `test/orchestrator-3.e2e.test.ts:215-219` asserts `eventsOfType(repo, "merge_done").length === 1` immediately after the `waitFor` at line 210.

**Reproduce** (the same-tree fail-then-pass, no source change between runs): `npm run test:e2e` at `7d45b9c1` named only this test on its first two runs and named nothing on its third; six filtered isolated runs (`node dist/test/test-runner.js e2e orchestrator-3#pin surviving a restart`) and one isolated whole-file run all passed. So the flake is a race inside the test's own observation order, not a host-starvation timeout and not a regression: the failing run reached the assertion, i.e. the wait succeeded in ~380 ms, far inside its 60 s deadline. This is NOT the 2026-11-15 load flake for the same test (BUGS-FIXED.md, "A live-orchestrator e2e pin-drain test flakes on a loaded host") — the test carries that quiet-host gate, it did not skip on either failing run (both report zero skipped tests, and the test printed a duration, not a skip line), and that entry's symptom was the `waitFor` deadline expiring, which is a different failure.

**Cause.** The wait's predicate (line 211) is `refAbsentFromFiles(repo, mergeRefName("clean")) && fs.existsSync(path.join(repo, "crash.txt"))` — the pin is gone and main holds the change. Both become true at the merge itself: `mergeMergeRequest` deletes the pin the moment the result is `changed` (src/merge/merge-core.ts:544, `deleteRef(ctx.root, mergeRefName(req.role)); // merged: the pin has done its job`), while the `merge_done` event is logged a settle turn LATER — the drain's `settleOne` (src/merge/merge-drain.ts:414-419) calls `settleMergeOutcome` (src/merge/merge-pipeline.ts:189), and that reaches `writeMergeOutcome`'s `logEventBestEffort` — `type: result === "changed" ? "merge_done" : …` — at src/merge/merge-slot.ts:436-438. So there is a real window between the merge's pin delete and the drain's settle, in which the predicate is satisfied and the count is still 0; a synchronous read in that window asserts 0. The stat cache in `readEvents` (src/events/event-read.ts:232 `cachedByStat`) is not the mechanism — an append changes the log's size, which is exactly what invalidates that cache — so the whole race is the two-turn settle gap. The same ordering was fixed once before, in `test/merge-pipeline.test.ts` (BUGS-FIXED.md, 2026-11-11: "the pin is gone for a real window before the settle's write lands… The fix observes the settle instead of inferring from the ref: it polls for the [outcome] event").

**Expected.** The test observes the settle before it counts it, so it cannot read a pin that is gone but an outcome event that has not landed. **Fix direction (test only, no source change):** make the existing `waitFor` at line 210 also require the settle event, the shape this same file's sibling dedup test already uses at line 260-263 (`() => fs.existsSync(path.join(repo, "hello.txt")) && eventsOfType(repo, "merge_done").length === 1`, its comment: "The slot logs merge_done only after the fast-forward writes hello.txt, so wait for both") — then keep the synchronous `merge_done`/`merge_failed`/`commits`/`mergeRefExists` assertions that follow unchanged. Leave the quiet-host gate and the sibling tests untouched. Do not weaken the assertion to `>= 1` or drop the count.

**Validation gap:** no-repro — the window between the pin delete and the settle event cannot be summoned deterministically offline; the fix rests on the source's own ordering, and a regression pin would have to force the delete-before-settle ordering in the drain, which is a source-side change this entry does not ask for.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
