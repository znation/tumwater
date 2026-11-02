# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Hourly full check, part 1/4: A twice-failed gate check asks main's tip about its own failing tests at once, so the gate never waits on the main watch and never keeps a change as `main_red` (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; replaces 7344a68d8's wait for a watch verdict covering the change's base (INV-CY1/CY2), which an hourly full check would turn into a 15-minute hold on nearly every such change; touches src/review/review-precheck.ts src/review/review.ts src/baseline/main-red.ts src/baseline/main-baseline.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts src/merge/merge-pipeline.ts src/merge/merge-queue.ts src/merge/merge-requeue.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/text/phrases.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-green.test.ts test/review-precheck-watch.test.ts test/merge-requeue-watch.test.ts test/merge-pipeline-watch.test.ts test/merger-check.test.ts)

**Goal.** The pre-merge gate keeps its build check (user, 2026-11-01: "it should gate each commit"; Subtract part 3b/7, which deleted it, is withdrawn). When that check fails twice, `gateBuildPrecheck` decides on the spot whose failure it is. It asks main's tip, in `_gate-main`, about exactly what failed, and never waits for the main watch's verdict to cover the change's base:
- **Named failing tests** are re-run alone on main's tip (`rerunAtMainTip`). Tests that fail there too are main's; any other is the change's, and the change is rejected naming those tests. When all of them are main's, the change goes on to review (`knownMainFailures`).
- **A failure that names no test** (a compile or lint error, a crash) runs the gate command on main's tip. A pass there makes the failure the change's (rejected). A fail there too makes it main's, and the change goes on to review: a red main blocks nobody (user, 2026-10-31).
- **No re-run verdict** (no re-run command, or a skipped run) falls back to main's full check run fresh, as `mainTipFailures` does today.

No path sets `GateResult.mainRed` or `awaitingWatch` any more, so no merge settles `main_red`.

**Approach.**
- In src/review/review-precheck.ts, always take the `mainTipFailures` path. Add the gate-command-on-tip question for a failure that names no test, and drop `attributeOnRedMain`'s `unknown` keep branch (both sides are now named or decided).
- Delete the watch-wait machinery 7344a68d8 added:
  - `watchedMainVerdict`, `watchVerdictCovering` and `WatchWait` (src/baseline/main-red.ts);
  - `newestObservedBaseline`, if nothing else reads it (src/baseline/main-baseline.ts);
  - `ReviewContext.watchWait`, `MergeRequest.watchWait` and `MergeEntry.watchWait`, with its queue-file validation;
  - the `awaitingWatch` hand-off through merge-core/merge-batch/merge-verify/merge-pipeline;
  - `mainRedRetry.awaitingWatch` and its load validation;
  - `requeueAwaitingWatch` and `requeueMainRedPin`'s `awaitingWatch` branch (src/merge/merge-requeue.ts). Keep `MAIN_RED_VERDICT_WAIT_MS`: `requeueMainRedPin` still waits on it for a pin kept as `main_red` before this part lands, until Every commit is verified on main part 4k/3 removes the `mainRedRetry` record;
  - `mainUncheckedNotJudged` (src/text/phrases.ts).
- Leave the now-unset `GateResult.mainRed` field and merge-core's `main_red` branch for Every commit is verified on main part 4j/3, which is re-pointed to this part.
- docs/invariants.md: replace INV-CY1/CY2 with INV-DA1: a twice-failed gate check is attributed by asking main's tip about exactly its failures (its named tests re-run alone, else the gate command), never by waiting on the watch, and never keeps a change as `main_red`. Re-word INV-CZ1, whose "kept as `main_red`" case goes. docs/how-it-works.md's gate paragraph says the same.

**Files touched.** src/review/review-precheck.ts src/review/review.ts src/baseline/main-red.ts src/baseline/main-baseline.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts src/merge/merge-pipeline.ts src/merge/merge-queue.ts src/merge/merge-requeue.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/text/phrases.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-green.test.ts test/review-precheck-watch.test.ts test/merge-requeue-watch.test.ts test/merge-pipeline-watch.test.ts test/merger-check.test.ts

**Acceptance criteria.**
- A change whose gate check fails twice on test X, where X passes on main's tip, is rejected after one `rerun`-scope check of X. There is no `baseline`-scope run and no wait, whether or not the watch has a verdict for the change's base.
- If X fails on main's tip too, the change goes on to review.
- A gate failure that names no test is rejected when main's tip passes the gate command, and goes on to review when main's tip fails it too.
- No merge settles `main_red`. `grep -rn 'awaitingWatch\|watchWait\|watchedMainVerdict\|watchVerdictCovering' src/` prints nothing.
- `npm run test:gate` passes.

**Tests.**
- test/review-precheck-watch.test.ts: keep it for the cases above, using its TOOL marker-file fixture; its awaiting-the-watch cases are deleted.
- Delete test/merge-requeue-watch.test.ts and test/merge-pipeline-watch.test.ts, whose whole subject is gone.
- test/merger-check.test.ts: the green-main case asserts one targeted re-run on main's tip instead of a seeded watch verdict.
- test/review-precheck.test.ts: its red-main case (a failure naming no test, on a main that fails too) goes on to review after one gate-command run on main's tip, instead of being kept as `main_red`; and the nameless-failure cases.
- test/review-precheck-green.test.ts: the no-verdict and repeat-failure cases, whose failures name no test, ask main's tip with the gate command first. The repeat failure's red main sends the change to review, not `main_red`.
- Run those files and the gate.

### Hourly full check, part 2/4: The main watch runs the full check on main's latest tip at most once an hour, in a mirror of its own (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 1/4 landed, since until then a twice-failed gate waits for a watch verdict covering its base, which an hourly cadence leaves missing for up to an hour; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/paths.ts src/config/config-schema.ts src/config/config-validation.ts docs/how-it-works.md docs/config.md docs/invariants.md tumwater.example.json test/main-watch.test.ts test/main-watch-rules.test.ts test/main-baseline-persist.test.ts test/config-validation-check.test.ts)

**Goal.** The full check (`check.command`) stops running on every new main head (user, 2026-11-01: "relax the once per main commit (for non-gate tests) and make it more like once per hour on latest main"). Each change is still checked once, by the pre-merge gate's build check. The full check runs on main's latest tip at most once per `check.fullIntervalMinutes` (default 60), and only when main has a code commit its newest full verdict does not cover. It runs in a mirror of its own, so it never holds `_gate-main`, where the watch's per-head diff rules and the gate's re-runs on main's tip run. The diff rules still judge every new head.

**Approach.**
- Split `createMainWatch` (src/baseline/main-watch.ts) into a per-head pass and a due full check, each with its own in-flight promise. `poll` starts each independently, and `idle()` waits for both.
  - The per-head pass keeps `watchRules` in `_gate-main` on every new head, exactly as today.
  - The full check runs `checkMainBaseline` in a new mirror worktree, `_main-full` (a `fullMainWorktreePath` beside `gateMainWorktreePath` in src/paths.ts), at the check-permit tier the watch uses today. It confirms a red, records the verdict and reports the culprit as today.
- The full check is due when the newest observed full verdict's `checkedAt` plus the interval is in the past and main has a first-parent code commit above that verdict's SHA. A doc-only range still inherits green with no run.
  - `checkedAt` is a new field on `MainBaseline`, persisted in baseline-verdicts.json; an entry without it reads as due now.
  - So a restart within the hour starts no extra run.
- Add `check.fullIntervalMinutes` (an integer ≥ 0, default 60) to `CheckConfig`, `CHECK_KEYS`, config-validation, docs/config.md and tumwater.example.json. `0` restores a full run per new head.
- The redeployer is unchanged: `redeployTarget`'s watched branch already targets only commits with a cached green full verdict, so the team's build follows the hourly greens.
- docs/how-it-works.md's main watch bullet describes the cadence. In docs/invariants.md, INV-CZ2's "at most once per main commit" becomes "at most once per `fullIntervalMinutes`", and a new INV-DA2 says: the full check runs at most once per interval, on the latest tip, in its own mirror, and never while no code commit is uncovered.

**Files touched.** src/baseline/main-watch.ts src/baseline/main-baseline.ts src/paths.ts src/config/config-schema.ts src/config/config-validation.ts docs/how-it-works.md docs/config.md docs/invariants.md tumwater.example.json test/main-watch.test.ts test/main-watch-rules.test.ts test/main-baseline-persist.test.ts test/config-validation-check.test.ts

**Acceptance criteria.**
- Code commits landing within an hour of the newest full verdict start no full run. The first poll past the hour with an uncovered code commit starts one, on the latest tip only.
- Every new head still gets the diff rules, and a gate's re-run on main's tip never waits for a `_main-full` run in flight.
- A full verdict persisted 20 minutes before a restart starts no full run in the first 40 minutes after it.
- `check.fullIntervalMinutes: 0` restores one full run per head.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts:
  - the within-the-hour and past-the-hour cases with a fake clock;
  - a restart with a persisted `checkedAt`;
  - `fullIntervalMinutes: 0`.
- test/main-watch-rules.test.ts:
  - diff rules on every head, including heads the full check skips;
  - a `_gate-main` step that does not wait behind a slow full check.
- test/main-baseline-persist.test.ts: `checkedAt` survives a restart through baseline-verdicts.json, and an entry saved without it reads as due now.
- test/config-validation-check.test.ts: the new key's type and bounds.
- Run those files and the gate.

### Hourly full check, part 3/4: Main's failures are narrowed and cleared by re-running only the failing tests — the watch bisects a red's opener, re-runs only the open failures on each new head, and confirms a cleared red with one full run at once (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 2/4 landed; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts)

**Goal.** With the full check hourly, one red verdict covers up to an hour of commits. Narrowing it and closing it must not cost more full runs (user, 2026-11-01: "when fixing failures, re-run only the failed tests"):
- A confirmed red's opener is found by bisection that re-runs only the failing tests, so `main_culprit` and ci's heal prompt name one commit.
- While the red is open, each new head re-runs only the open failures.
- When none fail any more, the red closes as cleared, and one full run starts on that head at once to confirm it, so a healed main becomes deployable without waiting out the hour.

**Approach.**
- After a red is confirmed at tip T, bisect in `_gate-main` with `rerunTests`. The code lives in main-watch.ts, beside `reportCulprit`.
  - The range is the first-parent code commits above the newest observed full green G, found by walking down from T.
  - The opener C is the first commit at which any of the confirmed failing tests fails. Before naming C, confirm once that they fail at C and pass at C's parent.
  - A failing test not accounted for at C (it passes there) gets its own bisect over C..T, up to `FAILING_TESTS_MAX` tests.
  - With no G on the walk, a one-commit range, or a confirmation that does not reproduce, name T as today.
- `reportCulprit` names C everywhere: `main_culprit.commit`, its merging runner, `redSpellOpeners` and the `onCulprit` hand-off (`commit` C, `tip` T).
- While a red spell is open, the per-head pass also re-runs the spell's open failing tests on each new head (one `rerun`-scope check). Tests that pass leave the open set. An empty set:
  - logs `main_check` `{ status: "passed", cleared: true }`, which writes no full green;
  - calls `clearHealKeyOnGreen` and closes the spell;
  - starts a full run on that head at once, once per cleared red.
- `knownMainFailures` and the `<main-known-red>` note read the open set, so a role's prompt stops naming a test ci already fixed.
- docs/how-it-works.md describes bisection and clearing. docs/invariants.md gains:
  - INV-DA3: a red's culprit is the first commit at which its failing tests fail, found by re-running only them.
  - INV-DA4: an open red is narrowed and cleared by re-running only its failing tests, and a clearing starts one confirming full run.

**Files touched.** src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts

**Acceptance criteria.**
- An hourly red at T covering eight code commits, whose failing test breaks at the third, logs one `main_culprit` naming the third. That takes at most five `rerun`-scope checks and no second `baseline`-scope run.
- A red whose bisect confirmation does not reproduce names T, as today.
- While red, a new head runs one `rerun` of the open failures and no full run. When they all pass, `main_check` is `cleared` and a full run starts though the hour has not passed. `redeployTarget` does not target the cleared head until that full run is green.
- The heal prompt and the `<main-red>` note name C and the re-run command for its failing tests.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts:
  - the eight-commit bisect against a fake check whose failure starts at one commit;
  - the non-reproducing bisect;
  - "a red whose breaking commit is intermediate" now names that commit, not the tip;
  - a cleared head that is not deployable.
- test/main-watch-failures.test.ts: per-head narrowing — a new head re-runs only the open failures, and `knownMainFailures` drops a test that passes there.
- test/main-watch-spells.test.ts: the bisected opener is the spell's culprit; clearing closes the spell with `cleared: true` and starts the confirming full run though the hour has not passed.
- test/main-red-heal.test.ts: the heal prompt names the bisected opener.
- Run those files and the gate.

### Hourly full check, part 4/4: Status, doctor and the dashboard say how old main's full verdict is and when the next is due (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 3/4 landed; touches src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts)

**Goal.** Main's badge stops implying the newest commit was fully checked. With the full check hourly, `mainCheckForPoll`'s status reads up to an hour behind main. Every surface that shows it says which SHA it covers, how long ago it ran, and when the next run is due (or "due now" after a cleared red).

**Approach.**
- `MainCheckStatus` (src/status/status-polls.ts) gains the full verdict's `checkedAt` and `nextDueAt`. `nextDueAt` comes from part 2/4's interval and part 3/4's cleared-red start.
- `mainCheckBadge` (src/ui/badges.ts) renders "full check green at abc1234, 23 min ago · next in 37 min". A cleared red reads "cleared at def5678 · full check running".
- The TUI line (status-render.ts) and the dashboard card (gui-client-team.ts) use the same payload fields (status-payload.ts). No new alert or doctor row: the existing main-check row carries the text.
- docs/how-it-works.md names what the badge shows.

**Files touched.** src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts

**Acceptance criteria.**
- With a full green 23 min old and a 60 min interval, `tumwater status`, the TUI and the dashboard show the covered SHA, "23 min ago" and "next in 37 min".
- After a cleared red, they show the clearing head until its full run settles.
- No new alert builder or doctor row exists.
- `npm run test:gate` passes.

**Tests.** test/status-polls.test.ts: `nextDueAt` from the interval and from a cleared red. test/status-render.test.ts and test/gui-client.test.ts: the badge text for green, red and cleared. Run those files and the gate.

### Subtract, part 6/6: The sweep — the rows, keys and docs the five parts left behind (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes" and "How we will know it worked"; requires Subtract part 1e/6, Subtract part 5v/6 and Subtract part 5x/6 landed, the ends of every remaining Subtract chain — a clause the operator added 2026-10-28 after feature refused this part for running ahead of them, re-pointed from part 5q/6 to part 5d/6 the same day when the user withdrew the budget-fallback removal and the tier map, and re-pointed again 2026-10-31 by the director when Subtract part 4/6 was withdrawn (the Settings concurrency controls keep `roles.<role>.instances` and the pool); touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts)

**Goal.** The deletion reads as one system. Every name parts 1/6–5/6 removed is gone from the live docs, the example config, the doctor's row list, the alerts and the tests that assert them; the archive keeps the record.

**Approach.**
- Sweep the deleted names out of the live prose and the example config: `check_wait`, `maxConcurrentChecks`, `mergeBatchMax`, `mergeCommand`, `review.afterMerge`, `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `merge queue`, `interlock`, `held-for-operator`, `Needs replan`, `Waiting for the next failure`, `(held N)`. `instances`, `slotCount`, `slot_wait` and `slot salvage` stay: the Settings concurrency controls keep `roles.<role>.instances` and the worktree pool (director, 2026-10-31).
- Delete the rows and tests rather than re-pointing them: a case whose whole subject is a deleted mechanism goes (the existing wording/implementation tests rule: never re-pin), and test/doctor-checks.test.ts's row list, test/event-format.test.ts's deleted event types (`check_wait`, the merge-stage events), test/retention.test.ts's deleted artifacts and test/config.test.ts's deleted keys are updated to the surviving row/key set.
- Re-check the parts 1a–1e/6 rule end to end: for every condition that used to have a banner and no longer does, the doctor row exists; for every row this series deleted, the mechanism is gone.
- docs/invariants.md drops or re-scopes the invariants of deleted subsystems (merge-slot, permit, provider caps, subscription-window holds) in the same commit, per the standing rule; the tiers, the budget fallback and the image reroute stay (user, 2026-10-28), so their invariants stay too, and so does the subscription usage-window display (`subscriptionWindows`, the window badge and spend card — user, 2026-10-30, plans/subtract.md stroke 5).
- Record in the part's PLANS-DONE entry: the doctor row count and the config key count before and after the series, and the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts PLANS.md test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts

**Acceptance criteria.**
- `grep -rnE 'maxConcurrentChecks|maxConcurrentPerProvider|mergeBatchMax|mergeCommand|check_wait|claudeWindowReserve|review\.afterMerge|held-for-operator' src/ docs/ README.md DEVELOPMENT.md tumwater.example.json` finds no live reference (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every doctor row name in doctor-check-names.ts resolves to a check that reads a mechanism that still exists; no row reports a path nothing writes.
- The before/after row and key counts are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

### Every commit is verified on main, part 4j/3: the `main_red` run-result verdict is removed from the status, doctor, UI and report surfaces (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires Hourly full check part 1/4 landed, so no merge produces the verdict (re-pointed 2026-11-01 by the operator from the withdrawn Subtract part 3b/7: the gate keeps its build check, and that part makes it decide every twice-failed check at once); touches src/merge/merge-core.ts src/ui/tone.ts src/events/event-labels.ts src/ui/gui/gui-client-model.ts src/failure/failure-data.ts src/failure/failure-time-spend.ts src/failure/failure-render.ts src/cli/cli-start-summary.ts src/status/status-polls.ts src/ui/status-model.ts src/doctor/doctor-holds.ts src/inbox/pending-prompt.ts src/review/review.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/runner/runner-state.ts src/budget/fallback-breaker.ts src/events/event-notify.ts src/baseline/main-red.ts test/attribute-red-check.test.ts test/budget.test.ts test/doctor-holds.test.ts test/failure-render.test.ts test/failure-time-spend.test.ts test/gui-client.test.ts test/status-model.test.ts test/status-render-cells.test.ts test/status-render.test.ts test/team-alerts.test.ts)

**Goal.** With Hourly full check part 1/4 deciding every twice-failed gate check at once (and deleting `awaitingWatch`), the merge gate has no path that sets `mainRed`, so no merge produces a `main_red` run result. Remove the dead merge branch and the fields it read, then delete the surfaces that read or render the verdict. Leave the `RunResult` member and the recovered-pin plumbing for part 4k/3 to remove last, so this part can merge on its own without a compile-forced sweep of the run/runner plumbing.

**Approach.**
- Delete the now-unreachable producer: the `mainRed` and `awaitingWatch` fields and their comments in src/review/review.ts's `GateResult` (only `gateBuildPrecheck` set them), and src/merge/merge-core.ts's `if (gate.decision === "failed" && gate.mainRed)` branch that returns `result: "main_red"` (with its comment and the `awaitingWatch` spread). The plain `gate.decision === "failed"` branch stays.
- Remove the verdict from the display tables: `resultTone`'s `case "main_red"` and `"main_red"` in `PROBLEM_RESULTS` (src/ui/tone.ts), `main_red: "main's check is failing"` from `RUN_RESULT_LABELS` (src/events/event-labels.ts), `main_red: "red"` from the dashboard's `RESULT_TONES` (src/ui/gui/gui-client-model.ts), `main_red: 9` from `RESULT_ORDER` (src/failure/failure-render.ts), `"main_red"` from `CLUSTERED_RESULTS` (src/failure/failure-time-spend.ts), the `ev.result === "main_red"` clause (src/failure/failure-data.ts) and `"main_red"` from the start-summary list (src/cli/cli-start-summary.ts).
- Delete the status/doctor readers: `heldByMainRed` and `mainCheckRecovered` (src/status/status-polls.ts), the `main red` label branch and its import (`src/ui/status-model.ts`), and the held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`). The unheld red-main warning (`redMainWarning`) and the `main_red_hold` event machinery stay.
- The `RunResult` member `main_red` (`src/run/run-outcome.ts`) stays, as do `runner-recovery.ts`'s recovered-pin producer, `merge-requeue.ts`'s `result === "main_red"` branch and the run/runner/review plumbing — part 4k/3 removes them.
- Refresh comments that name the verdict as a live status: `src/ui/status-model.ts`, `src/inbox/pending-prompt.ts`, `src/review/review.ts`, `src/run/run-finalize.ts`, `src/run/run-prompt.ts`, `src/orchestrator/orchestrator-poll.ts`, `src/merge/merge-verify.ts`, `src/merge/merge-queue.ts`, `src/runner/runner-state.ts`, `src/budget/fallback-breaker.ts`, `src/events/event-notify.ts`, `src/baseline/main-red.ts`.

**Files touched.** src/review/review.ts src/merge/merge-core.ts src/ui/tone.ts src/events/event-labels.ts src/ui/gui/gui-client-model.ts src/failure/failure-data.ts src/failure/failure-time-spend.ts src/failure/failure-render.ts src/cli/cli-start-summary.ts src/status/status-polls.ts src/ui/status-model.ts src/doctor/doctor-holds.ts src/inbox/pending-prompt.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/runner/runner-state.ts src/budget/fallback-breaker.ts src/events/event-notify.ts src/baseline/main-red.ts test/attribute-red-check.test.ts test/budget.test.ts test/doctor-holds.test.ts test/failure-render.test.ts test/failure-time-spend.test.ts test/gui-client.test.ts test/status-model.test.ts test/status-render-cells.test.ts test/status-render.test.ts test/team-alerts.test.ts test/merger.test.ts

**Acceptance criteria.**
- No status, doctor, UI, failure or CLI surface reads or renders the `main_red` verdict: `heldByMainRed` and `mainCheckRecovered` are gone, and `grep -rnE '\bmain_red\b' src/ui src/status src/doctor src/failure src/cli src/events src/inbox src/budget` finds no verdict reference (`main_red_hold` still matches nothing under `\bmain_red\b` and stays).
- The merge gate no longer returns `main_red`: `grep -rn 'result: "main_red"' src/merge` prints nothing, and `GateResult` declares neither `mainRed` nor `awaitingWatch`.
- The `RunResult` member `main_red` still exists (part 4k/3 removes it), so the tree compiles without the run/runner sweep.
- `npm run test:gate` passes.

**Tests.**
- test/doctor-holds.test.ts / test/status-model.test.ts / test/status-render.test.ts / test/status-render-cells.test.ts / test/team-alerts.test.ts: the held-by-main-red cases go; the unheld red-main warning cases stay.
- test/attribute-red-check.test.ts / test/budget.test.ts / test/failure-render.test.ts / test/failure-time-spend.test.ts / test/gui-client.test.ts: the `main_red` rows/labels/tone cases go; the surviving result cases stay.
- test/merger.test.ts: the `verifyAndMerge` `main_red` case goes; the surviving merge cases stay.

### Every commit is verified on main, part 4k/3: the `main_red` union member and the run/runner plumbing that names it are removed (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires part 4j/3 landed, so no merge produces the verdict and no surface reads it; touches src/run/run-outcome.ts src/runner/runner-recovery.ts src/merge/merge-requeue.ts src/runner/runner-leftover.ts src/runner/runner-state-load.ts src/runner/runner-run.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/runner-leftover.test.ts test/merge-requeue.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts)

**Goal.** The `main_red` run result no longer has a producer (Hourly full check part 1/4 removed the gate's `mainRed` path, whose dead branch part 4j/3 deletes; the recovered-pin return removed here is the last one) or a reader (part 4j/3), so the union member itself is dead vocabulary. Remove it and let the compiler name any site still constructing or narrowing it.

**Approach.**
- Remove `| "main_red"` and its doc comment from `RunResult` (src/run/run-outcome.ts). Deleting the member makes every remaining construction or `result === "main_red"` narrowing a compile error, which is the work list.
- Remove the last producer: `runner-recovery.ts`'s recovered-`main_red` return, with the `main_red_wait` result in src/runner/runner-leftover.ts and the `mainRedRetry` record in src/merge/merge-requeue.ts, src/runner/runner-state.ts and src/runner/runner-state-load.ts that feed it. With merge-requeue.ts's `result === "main_red"` branch gone, nothing sets the record any more, so the pin's wait/recovery path, its state key, the orchestrator poll's `requeueMainRedPin` call and the leftover's `mainRedWait` return go with it; keep the stale/dangling pin cleanup and conflict hand-back. Fix any surviving switch/type-narrowing the compiler flags (run-apply, run-finalize and the run prompt), keeping each site's non-`main_red` behavior.
- Refresh the comments that still name the verdict as a live outcome in `src/runner/runner-state.ts`, `src/runner/runner-recovery.ts`, `src/run/run-finalize.ts`, `src/run/run-prompt.ts`, `src/orchestrator/orchestrator-poll.ts`, `src/events/event-notify.ts`, `src/inbox/pending-prompt.ts`, `src/review/review.ts`, `src/merge/merge-verify.ts`, `src/merge/merge-queue.ts`, `src/budget/fallback-breaker.ts` and `src/baseline/main-red.ts`.

**Files touched.** src/run/run-outcome.ts src/runner/runner-recovery.ts src/merge/merge-requeue.ts src/runner/runner-leftover.ts src/runner/runner-state-load.ts src/runner/runner-run.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/runner-leftover.test.ts test/merge-requeue.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts

**Acceptance criteria.**
- `RunResult` has no `main_red` member, and `grep -rnE '\bmain_red\b' src/` prints nothing (the `main_red_hold` event and its machinery stay; `\bmain_red\b` does not match `main_red_hold`).
- No code path returns or narrows on a `main_red` run result; the compiler is clean.
- `npm run test:gate` passes.

**Tests.**
- test/run-outcome.test.ts: the `main_red` membership case goes; the surviving `RunResult` cases stay.
- test/runner-recovery.test.ts / test/runner-red-main.test.ts: the recovered-`main_red` cases go; the surviving recovery cases stay.
- test/run-apply.test.ts / test/run-finalize.test.ts / test/merge-pipeline-2.test.ts / test/merger.test.ts: drop the `main_red` assertions; the surviving cases stay.

_None yet._

### Subtract, part 3c/7: The queue's verify stage collapses into the merge step (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Hourly full check part 1/4 landed (re-pointed 2026-11-01 by the operator: Subtract part 3b/7 is withdrawn, since the user keeps the gate's build check, so the merge step carries that check); touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/merge/merge-slot.ts docs/how-it-works.md docs/invariants.md test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts)

**Goal.** A queued entry goes straight from the queue to the merge step: no separate verify task, no `approved`/`verifying` map, no stage events. `drainMerge` takes the head entry, runs the gate in the merge worktree — the deterministic diff rules and the gate's build check (`gateBuildPrecheck`, the declared gate command; user, 2026-11-01: "it should gate each commit") — and calls `mergeApprovedChange`; a rejected entry is settled as today. The durable queue still orders entries and the pin still carries the commit.

**Approach.**
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts; move the tier constants still needed by merge-drain/merge-post-review-drain (`MERGE_TIER`, `resolveAuthor`) beside the drain.
- In merge-core.ts, keep `reviewPinnedChange`'s gate (the diff rules and `gateBuildPrecheck`) as a small `reviewQueuedChange(ctx, req, wt, state)` without the approval/stage bookkeeping; call it from `mergeApprovedChangeIn` before `mergeToMain`, outside the merge lock. A rejected result deletes the pin and returns `rejected`; an approval proceeds to the merge.
- In merge-drain.ts, delete `drainMergeQueue`'s `drainVerify` leg and the `p.approved`/`p.verifying` handling; `drainMerge` starts the next queued entry directly. In merge-pipeline.ts, remove `verifying`/`approved` and their types; keep `InFlightMerge`, abort, guard and outcome plumbing. In merge-slot.ts, remove the verify stage records and `checkWaitStage`/`resolveWaitStage` hooks, keeping the merge in-flight marker the operator surfaces read.
- Keep `drainPostReviews` and the post-merge review path untouched.
- docs/how-it-works.md's Parallel approval and Merge sections describe the one-step drain; docs/invariants.md re-points the verify-stage bindings to the merge step.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/merge/merge-slot.ts docs/how-it-works.md docs/invariants.md test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start/approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential, or whose gate check fails for a test of its own, is rejected before it merges; every other queued diff merges without a second review.
- `grep -rn 'drainVerify\|startVerify\|verifyRequest\|MERGE_TIER\|VERIFY_TIER' src/merge` prints only the moved constants if any, never a verify stage.
- test/merge-drain-verify.test.ts is deleted with its subject; the surviving merge-drain/pipeline tests assert the one-step drain.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Update test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts and test/merger.test.ts to drive an entry from queue to merge without the verify/approved map; update the fixtures' `mergeHead` to the same path. Run those files and the gate.

### Subtract, part 3d/7: `tumwater queue`, its cancel/top keys and the browser queue controls go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3c/7 landed; touches src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts)

**Goal.** The operator stops steering a queue that becomes a lock and a fast-forward: delete the `tumwater queue` command, its `--cancel` and `--top` flags, the GUI Merge queue card's Cancel/Move-to-top handlers, the TUI pending pane's queue rows and keys, and the three modules that implement cancel/top/queue rendering. The queue reader itself stays for status, doctor and the CLI surfaces this part does not own until part 3f.

**Approach.**
- Delete src/merge/merge-cancel.ts, src/merge/merge-top.ts and src/merge/merge-queue-render.ts; remove `cmdQueue`, `cmdQueueCancel`, `cmdQueueTop` and the queue view from src/cli/cli-query-commands.ts and their command/help/completion entries.
- Remove `handleQueueCancel`/`handleQueueTop` and their `/api/queue-cancel`/`/api/queue-top` routes from src/gui/gui-operator-commands.ts and gui-server.ts; delete the dashboard Merge queue card's Cancel/Move-to-top controls.
- Remove the merge-queue rows, labels and Ctrl keys from tui-pane-pending.ts, tui-pane-pending-selection.ts and tui-pane-transcript.ts; keep the post-merge-review rows, which are a separate mechanism.
- docs/cli.md drops `queue`, `queue --cancel` and `queue --top`; no other docs change here.

**Files touched.** src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts

**Acceptance criteria.**
- `tumwater queue` and its `--cancel`/`--top` flags are gone from the parser, help, completion and docs; `grep -rn 'moveQueuedMergeToTop\|cancelQueuedMerge\|renderMergeQueue' src/` prints nothing.
- Neither dashboard nor TUI offers a queue cancel/top control, and no TUI key binds one.
- The queue reader (`readMergeQueue`), the post-merge-review views and the doctor/status queue reads still work.
- `npm run test:gate` passes.

**Tests.** Delete test/cli-queue.test.ts, test/cli-queue-follow.test.ts, test/gui-queue-cancel.test.ts, test/gui-queue-top.test.ts, test/merge-cancel.test.ts and test/merge-top.test.ts with their subjects; trim test/tui-pane-pending.test.ts and test/tui-operator-keys.test.ts to the surviving post-review rows and keys. Run the surviving touched files and the gate.

### Subtract, part 3e/7: A run's merge pin is merged directly, without a queue entry (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3d/7 landed; touches src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts)

**Goal.** New work stops writing a durable queue entry: a run pins its commit by `refs/tumwater/landing/<role>` and the orchestrator merges that pin on a poll. The queue reader still drains files an older build left, so the two paths coexist until part 3f deletes the queue.

**Approach.**
- In run-stage.ts, replace the `enqueueMerge` block with the pin only: after `pinAndReset`, log `merge_queued` with the commit and summary and end the run `queued` exactly as today; `heldOnBranch` still checks an existing pin. Remove the queue-entry construction from the fresh path; keep the revision trailer on the commit so a recovered pin still carries its round.
- In runner-leftover.ts, replace the `enqueueMerge` call with the same pin-only return (`{ kind: "pinned", sha, summary }`): adopt an unpinned branch tip into the merge ref as today, but write no queue file. Keep stale/dangling pin cleanup, the conflict hand-back and `MERGE_CONFLICT_LIMIT`.
- Add the pin merge to orchestrator-poll.ts: for each runner with `hasUnmergedPin` and no in-flight merge, read `recoveredMetadata` for the pinned sha and call the merge path (`mergeApprovedChange`) under the existing merge lock; a merged pin is deleted, a conflicting pin is kept for the existing leftover/conflict hand-back path, and a pin main already contains is dropped.
- docs/how-it-works.md's Merge section says a pin is the waiting state; the durable queue is legacy input only.

**Files touched.** src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts

**Acceptance criteria.**
- A fresh run that commits writes a pin and no `.tumwater/merge-queue/` file; its log path is still `merge_queued → merged` and its change reaches main after its one gate check, with no second check.
- A pin left by a crash or an earlier build is merged on the next poll; a pin whose commit main already contains is deleted without merging.
- A conflicting pin is kept once and hands back to its author at `MERGE_CONFLICT_LIMIT`, not retried forever.
- Old queue files still drain through the pre-3e path until part 3f removes it.
- `npm run test:gate` passes.

**Tests.** New test/orchestrator-merge-pin.test.ts: a pin is merged on a poll, a stale pin is dropped, a conflict keeps the pin and records the streak. test/run-stage.test.ts: a committed run pins and enqueues nothing. test/runner-leftover.test.ts: recovery adopts a tip into the pin and writes no queue file. Run those files and the gate.

### Subtract, part 3f/7: The durable merge queue and its status/doctor readers go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3e/7 landed; touches src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts)

**Goal.** With part 3e writing no queue file, the queue, its pipeline, slot and requeue modules are dead state. Delete them and re-point every reader at the pin/in-flight marker: status shows a role's waiting pin, the doctor drops the two merge-queue rows, and `once --once` waits on no in-flight merge instead of an empty queue directory.

**Approach.**
- Delete src/merge/merge-queue.ts, merge-drain.ts, merge-pipeline.ts, merge-slot.ts and merge-requeue.ts; move the one in-flight marker type/reader the new pin path and post-review drain still need into a small module beside merge-core.ts, and delete `.tumwater/merge-queue/` handling (`mergeQueueDir`, `legacyLandQueueDir`, the startup migration step) from src/paths.ts and startup-migration-steps.ts.
- status-data.ts's `readMergeQueue` block and `queuedRoles` become the pin/in-flight set; status-roles.ts and status-polls.ts read that set. Delete the queue header badge, the queue depth and the per-role queued row that name a now-nonexistent directory.
- doctor-backlog.ts loses `checkStaleQueuedMerges` and `checkMergeQueueFiles`; doctor-check-names.ts drops `stale merge-queue entries` and `merge-queue files`; doctor-holds.ts reads the in-flight/pin set instead of the queue.
- gate-polls.ts and scheduling/once-round.ts read the in-flight/pin state for their `queued` counts instead of `queuedMergeRoles`/`queuedMerges`; once-round's `queuedMerges: number` becomes the pin count.
- events/event-notify.ts drops notifications that name queue files (`unreadable queue files`, `merge-queue file`), keeping `merge_queued`/`merged`.
- docs/how-it-works.md removes the queue directory, stages and queue doctor rows, describing pins and the in-flight marker instead.

**Files touched.** src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts src/paths.ts src/orchestrator/startup-migration-steps.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts

**Acceptance criteria.**
- `grep -rn 'merge-queue\|mergeQueue\|queuedMerges\|readMergeQueue\|mergeQueueDir' src/` finds no live queue path; `docs/how-it-works.md` names no queue directory or stage.
- `tumwater status` shows each waiting role's pin and in-flight merge; the doctor's `stale merge-queue entries` and `merge-queue files` rows are gone rather than warning about a path nothing writes.
- `once --once` treats a waiting pin as unsettled work and exits only after its merge settles, the same way it treated a non-empty queue.
- No module imports a deleted merge-queue/merge-drain/merge-slot/merge-requeue file; the compiler is clean.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-queue.test.ts, test/merge-requeue.test.ts, test/merge-slot.test.ts and the queue-specific cases in test/merge-pipeline*.test.ts; update test/status-data.test.ts, test/status-roles.test.ts, test/doctor-checks.test.ts and test/once-round.test.ts to pins/in-flight. Run those files and the gate.

### Subtract, part 3g/7: Docs and invariants say one lock, linear history and a post-landing check (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3f/7 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts)

**Goal.** The live prose and the invariant bindings describe the landing that exists after parts 3a–3f: a pin, a rebase under the merge lock, a fast-forward, and the main watch's post-landing full check. No sentence promises queue stages or an approval step; the pre-merge gate keeps its build check (user, 2026-11-01), so the docs keep saying so.

**Approach.**
- Sweep the queue vocabulary out of docs/how-it-works.md, docs/invariants.md and docs/glossary.md: merge queue, queue stage, verify/approval stage, batch/bisect (already gone), retry/requeue, queue depth and queue cancel/top.
- In docs/invariants.md, drop or re-scope every binding to a deleted module (`merge-queue`, `merge-verify`, `merge-batch`, `merge-slot` stages, `merge-requeue`) and state the surviving guarantees: one merge writer under one lock, linear history, a deleted pin on merge and the main watch's post-landing checks as docs/how-it-works.md states their cadence at the time (amended 2026-11-01 by the operator: the pre-merge gate keeps its build check, and the Hourly full check series moves main's full check to at most hourly on the latest tip, so this part must not restate "a full check per commit"). Keep the conflict-hand-back and review-gate bindings that still have code.
- README's status line stays as is; remove any queue wording elsewhere in README.
- Re-check docs/invariants.md's file-to-test bindings: every remaining binding names a file and a test that still exist; the invariants-doc test enforces it.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts

**Acceptance criteria.**
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` finds no claim about a mechanism parts 3a–3f deleted (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every docs/invariants.md binding that names a merge module names a file and a test that still exist; deleted-module INVs are gone, not re-pointed.
- The surviving prose says: a change is pinned, gated (the diff rules and the declared gate command), merged by rebase and fast-forward under the merge lock, and covered on main by the main watch's full check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/merge-backlog-conflicts.test.ts whole, then the project's gate, and confirm green.

### `skipRunner`'s complexity-56 gate ladder in src/scheduling/skip.ts is split into five named module-private helpers — once-mode settlement, the holds before `isEligible`, the post-due admission holds, the deferral episode, and the maintenance admission — so a reader asking "what holds this runner before it is due?" or "what settles a deferred once-round?" finds one named function instead of scanning a 200-line body (planned 2026-10-31 by the plan role; continues the landed split-large-function family — the 2026-10-23 pollRunnerReasons 2/3 split lifted `skipRunner` itself out of orchestrator-scheduling.ts, and this split only divides its body; independent in file of every `## Planned` entry — `grep -n 'scheduling/skip.ts' PLANS.md` prints nothing before this entry, `grep -c 'skipRunner' PLANS.md` prints 0, and PLANS-DONE.md's two `src/scheduling/skip.ts` mentions are the landed 3a/7 queued-merge interlock removal and the 2026-10-23 lift, neither of which splits this ladder; docs/invariants.md binds only `skipRunner`'s `noteSkip` calls for INV-BR1, not its internal control flow; touches src/scheduling/skip.ts)

**Goal.** `skipRunner` (src/scheduling/skip.ts) carries every scheduling gate in one body: the once-mode paused settlement, the restart/disk/pause/cap/quota/bootstrap/operator/provider holds, `isEligible`, the not-due settlement, the model-check and `instances` admission holds, the need-based deferral episode, and the maintenance quota admission. eslint reports it at complexity 56, the highest function in `src/` today. Each of those concerns is already a comment-led block with its own side effects; lifting them into named helpers makes "why did this runner not start?" answerable by reading one helper, with no behavior change and no new file.

**Approach.** All edits in src/scheduling/skip.ts; move code, do not rewrite it, and keep every `//` comment with the block it annotates. Keep the destructured `scope` fields and the `inboxCount`/`demand` prelude in `skipRunner`; pass `scope`, `runner`, `demand` and `reason` to the helpers as below, and read fields from `scope` inside them.
- `function settleOncePaused(scope: SchedulingScope, runner: RoleRunner, demand: boolean): void` holds the first once-mode block verbatim: when `once.active && !once.isSettled(runner) && !runner.state.running` and any of `runnerPaused`, `capPaused`, `maintenanceQuotaOverLine`, `bootstrapHeldNow`, `operatorPauseBlocks` holds, call `once.settle(runner.role, "paused")`.
- `function heldFromStarting(scope: SchedulingScope, runner: RoleRunner, demand: boolean): boolean` holds the pre-due holds in today's order, returning true at the first: `holdForRestart || diskHeld`, `runnerPaused`, `capPaused`, `maintenanceQuotaOverLine`, `bootstrapHeldNow`, `operatorPauseBlocks`, the director's `windowHeldProviders` hold, and every other role's `heldProviders` hold. Keep the per-gate comments with their gates.
- `function admissionHoldReason(scope: SchedulingScope, runner: RoleRunner): "model-check" | "instances-full" | undefined` holds the two post-due admission holds in today's order: the `modelCheckHeld` gate (including its once-mode `once.settle(runner.role, "paused")`) returns `"model-check"`; the `instances` gate (`claimGroups.has(baseRoleOf(runner.role)) && !runner.state.running` and the configured-instances count reached) returns `"instances-full"`; otherwise `undefined`.
- `async function handleDeferral(scope: SchedulingScope, runner: RoleRunner, reason: string): Promise<boolean>` holds the `reason === "scheduled" || reason === "main moved"` block verbatim — the `workMergedSince` lookup, `deferRunReason`, the `run_deferred` event, the `deferredDue` advance, the once-mode settle and the `noteSkip` reason choice — and returns true when it deferred. It also holds the existing `else if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false)` reset, so the episode ends for an inbox/resume run.
- `function admitMaintenance(scope: SchedulingScope, runner: RoleRunner, demand: boolean): boolean` holds the final maintenance block verbatim: for a `commitTier(...) === "maintenance"` role without demand, return false after `noteSkip(root, runner, "maintenance-due-cap")` when the quota is spent, otherwise increment `scope.quotaAdmitted` and return true.
- Shrink `skipRunner` to the prelude, `settleOncePaused(...)`, the once-settled skip (`once.active && !runner.state.running && once.isSettled(runner)`), `if (heldFromStarting(...)) return { skip: true }`, the `isEligible` call, the not-due settlement block (which stays inline: the `deferredDue` reset, the once-mode `settleSkipped`, and `noteSkip(root, runner, skip)`), `const hold = admissionHoldReason(...); if (hold) { noteSkip(root, runner, hold); return { skip: true }; }`, `if (await handleDeferral(scope, runner, reason)) return { skip: true }`, `if (!admitMaintenance(scope, runner, demand)) return { skip: true }`, and the final `return { skip: false, reason: reason as string }`. Keep the exported signature and `SkipVerdict` as they are; change no other file.

**Files touched.** src/scheduling/skip.ts

**Acceptance criteria.**
- The gates still run in the same order and short-circuit: once-paused settlement, once-settled skip, the pre-due holds (restart/disk, pause, cap, quota, bootstrap, operator pause, provider holds), `isEligible`, the not-due settlement, the model-check hold, the `instances` hold, the deferral episode (and its inbox/resume reset), then the maintenance admission. Every `once.settle`/`once.settleSkipped`/`noteSkip`/`deferredDue`/`quotaAdmitted` side effect happens on the same path and at the same point as today.
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/scheduling/skip.ts` reports `skipRunner` at 15 or below (it reports 56 today), no new helper above 20, and no other function in the file higher than it reports today.
- `grep -n 'export async function skipRunner' src/scheduling/skip.ts` still matches the exported `skipRunner(scope: SchedulingScope, runner: RoleRunner): Promise<SkipVerdict>`, and the helper functions are module-private (no `export`).
- No edit lands outside src/scheduling/skip.ts; docs/invariants.md's INV-BR1 binding is unchanged because the `noteSkip` calls still live in this file.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behavior-preserving. Run the scheduling suites that drive these gates whole — test/orchestrator-scheduling.test.ts (including its "a skip reason that cannot be saved warns and leaves the poll running" INV-BR1 case), test/orchestrator-defer.test.ts, test/orchestrator-model-check.test.ts, test/bootstrap-gates.test.ts, test/maintenance-quota-gates.test.ts, test/orchestrator-once.test.ts and test/team-hold.test.ts — then the project's gate, and confirm green. If a scheduling case fails, a helper's gate order or a moved side effect is wrong; fix the move, do not change a gate to make it pass.

### `readPostReviews`'s complexity-19 saved-entry parser in src/review/post-merge-review.ts is split into a named module-private `parsePostReview`, so "which fields does a saved post-review entry carry, and when is one dropped as torn?" is read from one named function instead of a nested cache callback (planned 2026-11-01 by the plan role; continues the landed split-large-function family — the 2026-10-31 `eventMessage`/`mergeEventMessage` splits each lifted one dispatcher body into named helpers the same way; independent in file of every `## Planned` entry — before this entry `grep -n 'post-merge-review' PLANS.md` matched only Subtract part 3d/7's prose ("keep the post-merge-review rows") and its touches list names no src/review file, so no planned entry edits this file; PLANS-DONE.md's post-merge-review entries are the ones that created and shaped `reviewMergedCommit`/`readPostReviews`, and none splits `readPostReviews`'s parser (`grep -cE '^### .*readPostReviews' PLANS-DONE.md` prints 0); docs/invariants.md binds `readPostReviews` for INV-BT1, whose guarantee this behavior-preserving move keeps, so it stays unchanged; touches src/review/post-merge-review.ts)

**Goal.** `readPostReviews` (src/review/post-merge-review.ts) is a cache wrapper whose callback parses every saved `pending` entry: it skips a non-object, skips an entry whose `commit`/`role`/`summary` is not a string, skips one whose `rejected` is present but not an array, then copies each optional field only when its type and range are valid. The eslint one-shot reports that callback at complexity 19, and "which fields survive a re-read, and what makes an entry torn?" is answerable only by scanning the whole loop. Lift the per-entry parse into one named function so the cache wrapper is a read and a map, with no behavior change.

**Approach.** All edits in src/review/post-merge-review.ts; move the code, do not rewrite it, and add no import (`isJsonObject` stays imported and used).
- Add a module-private `function parsePostReview(raw: unknown): PostReview | null` immediately above `readPostReviews`, holding today's per-entry logic verbatim:
  - return `null` when `!isJsonObject(raw)`; destructure `commit`, `role`, `summary`, `body`, `failures`, `lastFailure`, `rejected`, `enqueuedAt` and `fixed` from it;
  - return `null` when any of `commit`/`role`/`summary` is not a string, or when `rejected` is defined but not an array;
  - build the `PostReview` exactly as today, assigning `body`, `failures`, `lastFailure`, `rejected` (with the same `filter((r): r is string => typeof r === "string")`), `fixed` and `enqueuedAt` under the same type/range guards and in the same order, and return it.
- Shrink `readPostReviews`'s cache callback to: read the file, return `[]` when `saved?.pending` is not an array, else map `saved.pending as unknown[]` through `parsePostReview` and keep the non-null results in order. Keep `cachedByStat`, its stat key and its clone-on-read mapper exactly as they are.
- Keep `readPostReviews`'s export, signature and doc comment; extend the doc comment and the new helper's doc comment to say torn entries are dropped by `parsePostReview` and every optional field is copied only when valid. Change no other function in the file.

**Files touched.** src/review/post-merge-review.ts

**Acceptance criteria.**
- `readPostReviews` returns the identical array in the identical order for every saved file today's code accepts: a torn entry is still dropped (INV-BT1), a well-formed one still keeps its optional `body`/`failures`/`lastFailure`/`rejected`/`fixed`/`enqueuedAt`, and a non-numeric or negative `enqueuedAt` is still omitted rather than copied.
- `parsePostReview` is module-private (`grep -nE '^export .*parsePostReview' src/review/post-merge-review.ts` prints nothing), and `readPostReviews` is still the exported `readPostReviews(root: string): PostReview[]`.
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/review/post-merge-review.ts` reports `readPostReviews` (including its callback) at 10 or below and `parsePostReview` at 15 or below, and no other function in the file higher than it reports today.
- No edit lands outside src/review/post-merge-review.ts; docs/invariants.md and test/post-merge-review.test.ts are unchanged because the move keeps INV-BT1's behavior and the existing cases pin it.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behavior-preserving. Run test/post-merge-review.test.ts whole — including "a torn post-review.json entry is dropped and the well-formed one is still reviewed" (INV-BT1) and "readPostReviews drops a non-numeric enqueuedAt and omits the field when absent" — then the project's gate, and confirm green. If a read case fails, a guard or an optional-field copy moved with the wrong condition; fix the move, do not relax a guard to make it pass.

### `mergeEventMessage`'s complexity-31 merge-family line builder in src/events/event-format.ts is split into one named module-private builder per event concern — the re-queued suffix, the failed-with-reason line, the conflict hand-back, the operator revert, the main full-check verdict and the main culprit — so "what does a merge failure line carry, and when does the covered-count parenthetical appear?" is read from a name instead of one 65-line switch (planned 2026-11-01 by the plan role; continues the landed split-large-function family — the 2026-10-30 `eventMessage` table conversion routed every event type to its family builder and left `mergeEventMessage` the largest family body at complexity 31, and the landed `resolveRunVerdict`, `loadRunnerState`, `assemblePayload`, `parseWriteFlags`, `historyPaneCache` and `skipRunner` plans each extract one named helper per concern the same way; independent in file of every `## Planned` entry — `awk '/^## Planned/,/^## Done/' PLANS.md | grep -c 'event-format'` prints 3 and all three are the blocked `Subtract part 6/6` entry's `test/event-format.test.ts` touch line (its heading's touch list, its approach bullet and its Files-touched line), never the source module; `grep -c 'mergeEventMessage' PLANS.md` prints 0 and `grep -cE '^### .*mergeEventMessage' PLANS-DONE.md` prints 0, so no open heading or touches list names the symbol and no finished plan splits it; docs/invariants.md binds src/events/event-format.ts only through `eventFeedItem`/`eventMatchesGrep` (INV-A3), the `issue_filed` line and the `image_reroute`/image-reroute resume lines, none of which this move touches, so no invariant edit is needed; touches src/events/event-format.ts)

**Goal.** `eventMessage` (src/events/event-format.ts) now routes each event type through `EVENT_MESSAGE_FAMILY` to a family builder, and `mergeEventMessage` is the largest family body: one `switch` over eleven merge/main event types whose readability is buried under nested ternaries and three multi-line `case` blocks. eslint's complexity one-shot reports it at 31 — the highest in the file and the highest unclaimed function in src/ outside the blocked status surfaces. Each arm already computes one line from a small set of fields, so moving each substantial arm into a module-private builder that returns that line makes the family's makeup readable by name, with `mergeEventMessage` left as a flat switch of one-line calls and the short arms inline.

**Approach.** All edits in src/events/event-format.ts; no exported name changes and no new import.
- `function mergeQueuedMessage(e: HarnessEvent): string` holds the current `merge_queued` block verbatim: the `waiting to merge <sha> — <summary>` base and the `retry` suffix ` (re-queued after <retry>)`, with the existing comment.
- `function mergeFailedMessage(e: HarnessEvent): string` holds the current `merge_failed` return verbatim: `merge of <sha> failed (<outcome>[: <reason>])<elapsed><summary suffix>`, including `truncate(e.reason.trim(), 120)`, the `isNonBlankString(e.summary)` guard and `truncate(e.summary, 80)`.
- `function conflictHandbackMessage(e: HarnessEvent): string` holds the current `conflict_handback` block verbatim: `stringList(e.conflicted)`, the `where` suffix, the `revision` why-suffix and the `conflict hand-back <action> <sha>…` line.
- `function operatorRevertMessage(e: HarnessEvent): string` holds the current `operator_revert` block verbatim: the non-blank `runner` `undid` suffix and the `reverted … (by operator) as …` line, keeping its `vocabulary-ok` comment.
- `function mainCheckMessage(e: HarnessEvent): string` holds the current `main_check` block verbatim: `failingTests`/`covered` field reads, the `finiteNumber(e.covered, null)` count rendered only above 1, the verdict, `joinWithMore(failing, 3, "; ")` and the corrupt-field comment.
- `function mainCulpritMessage(e: HarnessEvent): string` holds the current `main_culprit` block verbatim: the non-blank `runner` `merged by` suffix and the `main turned red at …` line.
- `mergeEventMessage` keeps its signature, its `case "merged"`, `merge_cancelled`, `merge_topped`, `merge_done`, `main_red_hold` and `default` arms verbatim, and returns each moved builder's result from its own `case`; every arm stays in today's order (the family table's key order does not change).

**Files touched.** src/events/event-format.ts

**Acceptance criteria.**
- `mergeEventMessage` is a flat switch: `merged`, `merge_cancelled`, `merge_topped`, `merge_done` and `main_red_hold` return inline as today, `merge_queued`/`merge_failed`/`conflict_handback`/`operator_revert`/`main_check`/`main_culprit` each `return` one of the six named builders, and the `default` returns `textOr(e.type)`; no arm is reordered, reworded or made conditional.
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/events/event-format.ts` reports `mergeEventMessage` at 8 or below (it reports 31 today), no helper above 8, and no other function in the file higher than it reports today.
- `grep -nE '^(export )?function (mergeQueuedMessage|mergeFailedMessage|conflictHandbackMessage|operatorRevertMessage|mainCheckMessage|mainCulpritMessage)' src/events/event-format.ts` matches all six, and none carries `export` (all module-private).
- Rendering is byte-identical: test/event-format.test.ts passes unedited, including "formatEvent renders merge_queued, landed, and merge_failed", the `main_check` covered-count cases and the `conflict_handback`/`operator_revert` cases, and `eventMessage`/`EVENT_MESSAGE_FAMILY` keep their exports and values.
- No edit lands outside src/events/event-format.ts; docs/invariants.md is unchanged because its event-format bindings (`eventFeedItem`, `eventMatchesGrep`, the `issue_filed` line, the image-reroute lines) are neither moved nor reworded.
- `npm run test:gate` passes.

**Tests.** No new test module: the split is behavior-preserving and the existing rendering assertions are the regression net. Run test/event-format.test.ts whole (it drives every moved arm through `formatEvent`), then the project's gate, and confirm green. If a line changes, a builder's field read or a moved string is wrong; fix the move, do not change a test to make it pass.

## Done
