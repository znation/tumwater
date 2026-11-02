# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Hourly full check, part 1a/4: The gate restores its pre-merge build check and attributes a twice-failed run on main's tip at once (planned 2026-11-02 by the plan role, splitting the too-large part 1 entry; design in plans/main-check-cadence.md; user direction 2026-11-01: the gate keeps its build check, and a twice-failed check is decided on the spot, never by waiting on the main watch; the check was removed by 8ed0d3eec after the withdrawal decision, so this part restores it from that commit's parent; touches src/review/review-precheck.ts src/review/review.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-main-tip.test.ts test/review-precheck-flake.test.ts)

**Goal.** `reviewAheadOfMain` runs the project's gate command again before it approves a code change (user, 2026-11-01: "it should gate each commit"). The gate's deterministic pre-check is the module Subtract part 3b/7 deleted (`8ed0d3eec^:src/review/review-precheck.ts`), kept as it was for the flake re-run, quarantine, known-main-failure pass-through and stale-base cases, but its attribution no longer waits on the watch. When the gate check fails twice, `gateBuildPrecheck` asks main's tip in `_gate-main` about exactly what failed:
- **Named failing tests** are re-run alone on main's tip (`mainTipFailures`, via `rerunAtMainTip`). A test that fails there too is main's; any other names the change's failure, and the change is rejected with it. When every named test fails on main too, the change goes on to approve/merge.
- **A failure that names no test** (a compile or lint error, a crash) runs the gate command on main's tip through a new `mainTipGateVerdict`. A pass there makes the failure the change's (rejected); a fail there too makes it main's, and the change goes on to approve/merge.
- **No re-run verdict** (no re-run command, or a skipped run) falls back to main's full check run fresh, exactly as `mainTipFailures` does.
- The old `unknown` keep-the-pin branch is gone: named tests are always re-run on the tip, and a nameless failure is always decided by the gate command there. No `awaitingWatch`, `mainRed` or `failed` gate outcome is reintroduced.

**Approach.**
- Add `src/review/review-precheck.ts` from `git show 8ed0d3eec^:src/review/review-precheck.ts`, keeping `gateBuildPrecheck`, `staleBaseFailures`, the one flake re-run with `quarantineTests`, the `onlyKnownMainFailures` early return and the host-sleep warning. Replace the `watchVerifiesMain` choice with an unconditional `mainTipFailures`, delete the `main.status === "awaiting"` branch, and drop `attributeOnRedMain`'s `unknown` arm. A tree whose every attempt spanned a host sleep stays non-attributable: warn as the old code did and approve with the sleep detail (no `GateResult` member is added for it); the merge gate no longer has a keep-the-pin outcome.
- `ReviewContext` (src/review/review.ts) regains the optional `buildCheckTimeoutMs` and `sampleSleep` test seams from that parent commit. After the diff rules and before `state.lastApprovedHead = head`, call `gateBuildPrecheck(ctx, state, head, reject)` and return its resolved result when set; otherwise continue to the current approve path.
- src/baseline/main-red.ts: add `mainTipGateVerdict(root, role, mainBranch, config, options?)`, built like `rerunAtMainTip` on `withMainTipWorktree`, which runs `runScopedBuildCheck(root, role, "gate", mirror, config)` at main's tip and maps `outcome.status` to the existing `MainTipVerdict` (passed → green, failed → red with `failingTests`, null/skipped → unavailable). It is queued behind the shared `_gate-main` work by `withMainTipWorktree`, so it never overlaps a watch or gate run in that mirror.
- Delete the now-unused `watchVerdictCovering`/`watchedMainVerdict` imports from the restored module; part 1b removes their definitions.
- docs/how-it-works.md's Review section says the pre-merge gate runs the diff rules and then the gate command, deciding a twice-failed check by asking main's tip at once. docs/invariants.md replaces the gate-wait wording with INV-DA1: a twice-failed gate check is attributed by asking main's tip about exactly its failures (named tests re-run alone, else the gate command), never by waiting on the watch.

**Files touched.** src/review/review-precheck.ts src/review/review.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-main-tip.test.ts test/review-precheck-flake.test.ts

**Acceptance criteria.**
- A code change that fails the gate twice on named test X and now passes nothing else, where X passes on main's tip, is rejected after the change's two gate attempts and one `rerun`-scope run of X on main's tip. It starts no `baseline`-scope run of main and waits on no watch verdict.
- If X fails on main's tip too, the change approves without a second full check of main.
- A failure that names no test is rejected when main's tip passes the gate command, and approves when main's tip fails it too.
- A clean code change runs the gate once and approves; a repo with no declared check still approves as today, and an md-only diff still short-circuits before the check.
- No watch-wait or `awaitingWatch` path is added: the restored module has no `watchedMainVerdict`, `watchVerdictCovering` or `status === "awaiting"` reference.
- `npm run test:gate` passes.

**Tests.**
- Add test/review-precheck.test.ts driving `reviewAheadOfMain` over a repo whose config declares a gate command, with the fake check writing marker files: twice-failed named test rejected against a green tip; twice-failed named test that also fails on the tip approves; nameless failure decided by the gate command on the tip both ways; a clean run approves after one gate attempt; no declared check approves.
- Add test/review-precheck-flake.test.ts: a first failure that passes on the immediate re-run approves, warns as flaky and quarantines the named test; a failure naming only main's known failures approves without a re-run.
- Add test/review-precheck-main-tip.test.ts for `mainTipGateVerdict` itself: green when the gate command passes at main's tip, red with the failing tests when it fails, unavailable when the check is skipped.
- Run those files and the gate.

### Hourly full check, part 1b/4: The dead watch-wait and `awaitingWatch` plumbing is removed from the merge queue, runner state and phrases (planned 2026-11-02 by the plan role, splitting the too-large part 1 entry; requires Hourly full check part 1a/4 landed, so no gate sets `awaitingWatch` and no merge produces `main_red`; touches src/baseline/main-red.ts src/baseline/main-baseline.ts src/review/review.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts src/merge/merge-pipeline.ts src/merge/merge-queue.ts src/merge/merge-requeue.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/text/phrases.ts docs/how-it-works.md docs/invariants.md test/merge-requeue-watch.test.ts test/merger-check.test.ts)

**Goal.** With the gate deciding every twice-failed check at once (part 1a/4) and `GateResult` already carrying neither `mainRed` nor `awaitingWatch`, the watch-wait hand-off is dead vocabulary: `awaitingWatch` is set nowhere, `WatchWait` is never produced, and `requeueAwaitingWatch` can never find a kept pin. Remove it so the merge path has one re-queue rule (Every commit is verified on main part 4j/3 and 4k/3 can then delete the rest of `main_red`).

**Approach.**
- src/baseline/main-red.ts: delete `WatchWait`, `watchVerdictCovering` and `watchedMainVerdict`. Keep `MAIN_RED_VERDICT_WAIT_MS` and `mainTipFailures`/`rerunAtMainTip`/`namedFailures`: `requeueMainRedPin` still uses the timeout for a pin kept as `main_red` before this part lands, until part 4k/3 removes the `mainRedRetry` record.
- src/baseline/main-baseline.ts: delete `newestObservedBaseline` if this removal leaves it with no reader; grep first and keep it only if another module still reads it.
- src/review/review.ts: drop `ReviewContext.watchWait` and the `WatchWait` import.
- src/merge/merge-core.ts: drop `MergeRequest.watchWait`, its spread into the review context, and `GateOutcome`'s `awaitingWatch`.
- src/merge/merge-batch.ts and src/merge/merge-verify.ts: drop `verifyRequestIn`'s `watchWait` spread, `VerifyVerdict.awaitingWatch`, and the `awaitingWatch` computation passed to `settleMergeOutcome`.
- src/merge/merge-pipeline.ts: drop `settleMergeOutcome`'s `awaitingWatch` parameter and its pass to `requeueKeptChange`.
- src/merge/merge-queue.ts: drop `MergeEntry.watchWait` and the queue-file validation of it.
- src/merge/merge-requeue.ts: drop `requeueAwaitingWatch`, `requeueMainRedPin`'s `awaitingWatch` branch, `requeueKeptPin`'s `watchWait` parameter and the `watchWait` spread in `enqueueRetry`, and the destructured `watchWait` in the plain re-queue.
- src/runner/runner-state.ts and src/runner/runner-state-load.ts: drop `mainRedRetry.awaitingWatch` and its load validation; keep `head`, `entry` and `waitingSince`.
- src/text/phrases.ts: delete `mainUncheckedNotJudged`.
- docs/invariants.md: delete the INV-CY watch-wait entries that have no mechanism left (INV-CY2's re-queue timing stays only as the plain `MAIN_RED_VERDICT_WAIT_MS` rule for the pre-existing pin until 4k/3); docs/how-it-works.md drops any sentence saying a gate keeps a change for the watch's verdict.

**Files touched.** src/baseline/main-red.ts src/baseline/main-baseline.ts src/review/review.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts src/merge/merge-pipeline.ts src/merge/merge-queue.ts src/merge/merge-requeue.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/text/phrases.ts docs/how-it-works.md docs/invariants.md test/merge-requeue-watch.test.ts test/merger-check.test.ts

**Acceptance criteria.**
- `grep -rn 'awaitingWatch\|watchWait\|WatchWait\|watchedMainVerdict\|watchVerdictCovering' src/` prints nothing.
- `grep -rn 'mainUncheckedNotJudged' src/` prints nothing.
- `requeueMainRedPin` still re-queues a `main_red` pin after `MAIN_RED_VERDICT_WAIT_MS` and `requeueKeptChange` still re-queues an under-cap review failure; their existing non-watch tests pass unchanged.
- The tree compiles and `npm run test:gate` passes.

**Tests.**
- Delete test/merge-requeue-watch.test.ts, whose whole subject is the removed watch wait.
- test/merger-check.test.ts: drop any seeded `watchWait`/watch-verdict setup; keep its gate-attribution cases, which part 1a/4 re-pointed at main's tip.
- Run those files and the gate.

### Hourly full check, part 2/4: The main watch runs the full check on main's latest tip at most once an hour, in a mirror of its own (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 1b/4 landed, since until then a twice-failed gate waits for a watch verdict covering its base, which an hourly cadence leaves missing for up to an hour; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/paths.ts src/config/config-schema.ts src/config/config-validation.ts docs/how-it-works.md docs/config.md docs/invariants.md tumwater.example.json test/main-watch.test.ts test/main-watch-rules.test.ts test/main-baseline-persist.test.ts test/config-validation-check.test.ts)

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

### Every commit is verified on main, part 4j/3: the `main_red` run-result verdict is removed from the status, doctor, UI and report surfaces (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires Hourly full check part 1b/4 landed, so no merge produces the verdict (re-pointed 2026-11-01 by the operator from the withdrawn Subtract part 3b/7: the gate keeps its build check, and that part makes it decide every twice-failed check at once); touches src/merge/merge-core.ts src/ui/tone.ts src/events/event-labels.ts src/ui/gui/gui-client-model.ts src/failure/failure-data.ts src/failure/failure-time-spend.ts src/failure/failure-render.ts src/cli/cli-start-summary.ts src/status/status-polls.ts src/ui/status-model.ts src/doctor/doctor-holds.ts src/inbox/pending-prompt.ts src/review/review.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/runner/runner-state.ts src/budget/fallback-breaker.ts src/events/event-notify.ts src/baseline/main-red.ts test/attribute-red-check.test.ts test/budget.test.ts test/doctor-holds.test.ts test/failure-render.test.ts test/failure-time-spend.test.ts test/gui-client.test.ts test/status-model.test.ts test/status-render-cells.test.ts test/status-render.test.ts test/team-alerts.test.ts)

**Goal.** With Hourly full check part 1b/4 deciding every twice-failed gate check at once (and deleting `awaitingWatch`), the merge gate has no path that sets `mainRed`, so no merge produces a `main_red` run result. Remove the dead merge branch and the fields it read, then delete the surfaces that read or render the verdict. Leave the `RunResult` member and the recovered-pin plumbing for part 4k/3 to remove last, so this part can merge on its own without a compile-forced sweep of the run/runner plumbing.

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

**Goal.** The `main_red` run result no longer has a producer (Hourly full check part 1b/4 removed the gate's `mainRed` path, whose dead branch part 4j/3 deletes; the recovered-pin return removed here is the last one) or a reader (part 4j/3), so the union member itself is dead vocabulary. Remove it and let the compiler name any site still constructing or narrowing it.

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

### Subtract, part 3c/7: The queue's verify stage collapses into the merge step (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Hourly full check part 1b/4 landed (re-pointed 2026-11-01 by the operator: Subtract part 3b/7 is withdrawn, since the user keeps the gate's build check, so the merge step carries that check); touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/merge/merge-slot.ts docs/how-it-works.md docs/invariants.md test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts)

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

### `resolveRoleConfig`'s complexity-21 identity/billing/chain resolver in src/roles/role-view.ts is split into three named module-private helpers — `resolveRoleIdentity`, `resolveBillingSeam` and `resolveChainStep` — so "which id resolves, and which id is unknown?", "whose subscription pays for this role?" and "is this role's tier moved on the orchestrator's chain?" are each read from one name instead of one ~50-line helper body (planned 2026-11-02 by the plan role; continues the landed split-large-function family — the 2026-10-30 `rolePayload` split introduced `resolveRoleConfig` as its identity/config helper, and the 2026-10-31 `assemblePayload`, `skipRunner`, `readPostReviews` and `mergeEventMessage` entries each extract one named helper per concern the same way; independent in file of every `## Planned` entry — `awk '/^## Planned/,/^## Done/' PLANS.md | grep -c 'role-view\|resolveRoleConfig'` prints 0, so no heading or touches list names this file or symbol (the blocked `Subtract` part 4/6 names `src/roles/runner-ids.ts`, a different file), and `grep -cE '^### .*resolveRoleConfig' PLANS-DONE.md` prints 0: the archive's only `resolveRoleConfig` mentions are the landed `rolePayload` split that created the helper, never a split of it; docs/invariants.md binds src/roles/role-view.ts only through INV-G3's symlink-note reader, which sits in `notesAndWindowsOf` and not in this function, so no invariant edit is needed; touches src/roles/role-view.ts)

**Goal.** `rolePayload` now delegates to named helpers, but `resolveRoleConfig` (src/roles/role-view.ts) still mixes three unrelated questions in one body: the id resolution (canonical id, catalog/custom/DIRECTOR lookup and the one `unknownRoleMessage` throw), the subscription billing seam (the role's own non-pi backend, else the review gate's, plus that backend's account and its primary window), and the orchestrator chain position (`readOrchestratorInfo` + `orchestratorAlive` + `roleSeamTier`). eslint's complexity one-shot reports it at 21, most of it the nested billing ternaries; each block is already comment-led, so lifting them into named helpers makes each question answerable by name with no behavior change and no new file.

**Approach.** All edits in src/roles/role-view.ts; move code, do not rewrite it, and keep every `//` comment with the block it annotates. No exported name changes and no new import.
- `function resolveRoleIdentity(typedRole: string, cfg: TumwaterConfig): { role: string; resolved: { title: string; find: string } }` holds the current first block verbatim: `canonicalRoleId`, `roleById`, the `customRoles.find`, the catalog/custom/DIRECTOR fallback (with its empty `find`), and the `if (!resolved || !knownRoleIds(cfg).includes(role))` `unknownRoleMessage` throw. Return `{ role, resolved }`.
- `function resolveBillingSeam(root: string, cfg: TumwaterConfig, effective: ResolvedModelConfig): { billingBackend?: string; account: { billing: ClaudeBilling } | null; billingWindow?: string }` holds the current billing block verbatim: `roleBackend` from `effective.agent`, `reviewAgent`/`reviewBackend` from `reviewRunConfig(cfg)`, `billingBackend = roleBackend ?? reviewBackend`, the `readAccount` read, and `billingWindow` from `windowEntries(account)[0]?.type` only when `account?.billing === "subscription"`. Return all three; leave `billingWindow` `undefined` when absent so the caller's conditional spread is unchanged.
- `function resolveChainStep(root: string, cfg: TumwaterConfig, role: string): ChainTierInfo | null` holds the current chain block verbatim: `readOrchestratorInfo(root)`, `orchestratorAlive(root, info) && info?.chain?.[roleSeamTier(cfg, role)] || null`.
- Shrink `resolveRoleConfig` to: `const { role, resolved } = resolveRoleIdentity(typedRole, cfg);` then `const effective = configForRole(cfg, role);` then `const { billingBackend, account, billingWindow } = resolveBillingSeam(root, cfg, effective);` then `const chainStep = resolveChainStep(root, cfg, role);` then the same return object with `base: baseRoleOf(role)` and the same `...(billingWindow !== undefined ? { billingWindow } : {})` spread. Keep its signature and declared return type as they are.

The read order stays today's: identity (and its throw) before `configForRole`, then the account reads, then the orchestrator-info read, then `baseRoleOf`. The throw still fires before any account or info read.

**Files touched.** src/roles/role-view.ts

**Acceptance criteria.**
- `rolePayload(root, typedRole, modelsPath, now)`'s exported signature, `RoleViewPayload`, and `resolveRoleConfig`'s module-private signature and declared return are unchanged; `grep -n 'function resolveRoleConfig' src/roles/role-view.ts` still matches the `resolveRoleConfig(root: string, typedRole: string, cfg: TumwaterConfig)`, and `grep -nE '^export .*(resolveRoleIdentity|resolveBillingSeam|resolveChainStep)' src/roles/role-view.ts` prints nothing (all three helpers module-private).
- The unknown-role path is unchanged: an id that `roleById`/`customRoles`/`DIRECTOR_ROLE` cannot answer still throws `unknownRoleMessage(role, knownRoleIds(cfg))` from `resolveRoleIdentity` BEFORE `configForRole` or any account/info read runs, and a known instance id (`feature-5` with `instances` configured) still resolves.
- The billing seam still answers exactly as today: a non-pi `effective.agent` wins over the review backend, a pi author under a non-pi reviewer names the reviewer's backend, a subscription account yields `billingWindow` from its first window entry, an API account omits it, and a pi seam with no backend yields `billingBackend: undefined`/`account: null`/`billingWindow: undefined`.
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/roles/role-view.ts` reports `resolveRoleConfig` at 5 or below (it reports 21 today), no new helper above 10, and no other function in the file higher than it reports today.
- test/role-view.test.ts passes unedited — including "an unknown role throws the shared unknownRoleMessage wording", "a claude model job's role view names its billing and subscription window", "a codex subscription account renders Codex window labels" and the `chainStep`/orchestrator-chain cases — and the `--json` payload and `renderRoleMarkdown` output are byte-identical.
- No edit lands outside src/roles/role-view.ts; docs/invariants.md is unchanged because INV-G3's role-view.ts binding (the symlink-guarded notes read) is neither moved nor reworded.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behavior-preserving and test/role-view.test.ts is the regression net. Run test/role-view.test.ts whole, then the project's gate, and confirm green. If a payload or wording case fails, a field read or the conditional `billingWindow` spread moved with the wrong guard; fix the move, do not change a test to make it pass.

### `exponentRefusal`'s complexity-24 integer/duration key screen in src/config/config-write.ts is lifted out of `setConfigKey` and split into named module-private predicates — `isPlainIntegerKey` and `isPlainDurationKey` — so "which keys take a plain integer or a plain second count, and why is an exponent spelling refused?" is read from the key families instead of two inline OR chains (planned 2026-11-02 by the plan role; continues the landed split-large-function family, and is the next step in this file after the 2026-10-25 `setConfigKey` split that first extracted `exponentRefusal` as one helper — that move left its two key-shape tests inline, and they have since grown to a measured complexity of 24; independent in files of every `## Planned` entry — `grep -n 'config-write' PLANS.md` prints no match, so no open heading or touches list names src/config/config-write.ts (the blocked `Every commit is verified on main` parts touch src/config/config-schema.ts, config-validation.ts, config-views.ts and config.ts, never config-write.ts, and `Subtract` part 6/6 touches docs and tests only); PLANS-DONE.md records no split of `exponentRefusal` itself (`grep -n 'exponentRefusal' PLANS-DONE.md` matches the 2026-10-25 `setConfigKey` split's Approach, which created the helper, and one deletion that removed a map arm from it, never a split of its integer/duration tests); docs/invariants.md's INV-B3 binds `setConfigKey`/`unsetConfigKey`/`setDailyBudgetUsd` on this file, and a behavior-preserving private move leaves every export's name, signature and refusal text unchanged, so the binding and its pinned `test/config-write.test.ts` cases stay; touches src/config/config-write.ts)

**Goal.** `exponentRefusal` (declared as a local arrow inside `setConfigKey` in src/config/config-write.ts) is the shape screen that stops `config set` from silently writing an exponent spelling (`4e1` parses as 40) to a plain-integer key or a plain-second-count key. Its body is one long `if` per key family, each holding a multi-line OR chain over `parsed.kind`, `PLAIN_INTEGER_TOP_LEVEL_KEYS`/`PLAIN_DURATION_KEYS`, `roles.<id>.instances`, `bootstrap.untilPlansDone`, the `review`/`check` `timeoutSeconds` fields, `idleBackoff.initialSeconds`/`maxSeconds` and `roles.<id>.minRunIntervalSeconds`; eslint reports the arrow at complexity 24. A reader asking "is this key an integer key or a duration key?" has to evaluate both chains against `parsed`, and a new key family is added by editing a boolean expression in the middle of the screen. Extract each family's test into a named predicate so `exponentRefusal` is only the two ordered refusals and their exact messages.

**Approach.** All edits in src/config/config-write.ts; move the existing conditions and comments, do not rewrite them, and add no import.
- Lift `exponentRefusal` from a closure inside `setConfigKey` to a module-private function beside it. It reads only its arguments and the two existing key sets, never `root`, so the move needs no parameter change.
- Add `function isPlainIntegerKey(parsed: ReturnType<typeof parseConfigKey>, key: string): boolean` above it, moving the `isPlainIntegerKey` initializer's three OR branches verbatim (the `top`/`PLAIN_INTEGER_TOP_LEVEL_KEYS` branch, the `role`/`instances` branch and the `section`/`bootstrap.untilPlansDone` branch).
- Add `function isPlainDurationKey(parsed: ReturnType<typeof parseConfigKey>): boolean` above it, moving the `isPlainDurationKey` initializer's branches and its "duration-typed team keys" comment verbatim (the `top`/`PLAIN_DURATION_KEYS` branch, the `section` branch for `review`/`check` `timeoutSeconds` and `idleBackoff` `initialSeconds`/`maxSeconds`, and the `role`/`minRunIntervalSeconds` branch).
- Leave `exponentRefusal(parsed, key, trimmed)` as `if (isPlainIntegerKey(parsed, key) && trimmed !== "" && isExponentSpelling(trimmed)) return <the existing plain-integer message>;` then `if (isPlainDurationKey(parsed) && trimmed !== "" && isExponentSpelling(trimmed)) return <the existing plain-second-count message>;` then `return null;`. `setConfigKey` keeps its call site (`const refusal = exponentRefusal(parsed, key, trimmed);`) and every other helper unchanged.

**Files touched.** src/config/config-write.ts

**Acceptance criteria.**
- `grep -nE '^(export )?function (isPlainIntegerKey|isPlainDurationKey|exponentRefusal)' src/config/config-write.ts` matches those three declarations and none is exported; no `const exponentRefusal` or inline `isPlainIntegerKey`/`isPlainDurationKey` initializer remains in `setConfigKey`.
- The memberships and messages are unchanged: `maxConcurrent`, `worktreeSlots`, `maxConcurrentChecks`, `roles.<id>.instances` and `bootstrap.untilPlansDone` still refuse an exponent spelling with `<key> must be a plain integer — no exponent notation`; the top-level second counts, `roles.<id>.minRunIntervalSeconds`, `review.timeoutSeconds`, `check.timeoutSeconds`, `idleBackoff.initialSeconds` and `idleBackoff.maxSeconds` still refuse with `<key> must be a plain second count like 300, 0.5, or .5 — no +/-, exponent, or hex notation`; a blank value and a non-exponent spelling still pass through to the existing parse, and `idleBackoff.factor` stays outside both sets.
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/config/config-write.ts` reports `exponentRefusal` below 10 (it reports 24 today), each new predicate below 15, and no function in the file above 15.
- No edit lands outside src/config/config-write.ts; docs/invariants.md and the tests are unchanged because the move preserves every export, refusal string and key membership.
- `npm run test:gate` passes.

**Tests.** No new test module: the split is behavior-preserving. Run test/cli-config-commands.test.ts whole — including "set of an exponent spelling of a plain-integer key fails without writing" and "set of an exponent spelling of a plain-second-count key fails without writing", which pin both families and the byte-identical file after each refusal — and test/config-write.test.ts whole, then the project's gate, and confirm green. If a key stops refusing or starts refusing, a branch moved into the wrong predicate; fix the move, do not relax the test.

### `runOrchestrator`'s complexity-24 setup-and-shutdown body in src/orchestrator/orchestrator.ts is split into three named module-private helpers — `prepareOrchestratorRun` for option normalization, the enabled-roles guard, the two internal stop controllers and the startup migrations/info/pins, `buildOrchestratorRuntime` for the long-lived collaborator wiring into the existing `PollContext`, and `shutDownOrchestrator` for the `finally` drain — leaving `runOrchestrator` as prepare → build → poll loop (planned 2026-11-02 by the plan role; continues the landed split-large-function family — the 2026-10-19 organize entry already lifted the poll steps into src/orchestrator/orchestrator-poll.ts, leaving only setup, the loop skeleton, the shutdown drain and the once-mode return in this body, and the 2026-10-31 `skipRunner`, `readPostReviews`, `resolveRoleConfig` and `workReserveCount` entries each extract named helpers the same way; independent in file of every `## Planned` entry — `awk '/^## Planned/,/^## Done/' PLANS.md | grep -c 'src/orchestrator/orchestrator\.ts'` and the same command for `runOrchestrator` both print 0, and no other open heading or touches list names this file (the blocked `Subtract` parts name src/orchestrator/orchestrator-poll.ts, orchestrator-scheduling.ts and scheduling-skip.ts, different files); PLANS-DONE.md's two `^### .*runOrchestrator` headings are the 2026-10-19 poll-closure split, which left this setup body behind, and the 2026-10-20 orphan-kill entry that added one startup call — neither splits the setup or shutdown — while its plain mentions record later behavior additions (the stop cause, the best-effort start event, the crash pin); docs/invariants.md binds src/orchestrator/orchestrator.ts only for INV-CU3's "startup, after `retireLegacyRoleWorktrees`" order, which this move preserves; touches src/orchestrator/orchestrator.ts)

**Goal.** `runOrchestrator` (src/orchestrator/orchestrator.ts) is a ~270-line body at complexity 24, the project's highest remaining function. Three concerns share one scope, so a reader asking "which option default is applied, and what refuses an empty enabled set?", "which collaborators does a poll step see?", and "what does shutdown drain and close?" has to read the whole body: the setup (option defaults, the enabled-roles guard and its message, the two internal stop controllers around the caller's signal, once-mode's nulling of redeploy/launch-services, reclaim, the info-file write, the start event, the startup migrations/archive/pins/worktree retirement, the `RoleRunner`s and the retention pruner); the runtime construction (the in-flight sets, merge pipeline, `OnceRound`, gate states, live config reload, `WorkMergedCache`, main watch with its culprit-heal callback, deferral map, notifier, best-effort logger, catalog refresh, model check, the `PollContext` and `newPollState()`); and the poll loop, `finally` drain and once-mode return. Split each concern into one named module-private helper so each question is answered by a name. No behavior change: the same values are built in the same order, the same startup awaits run in the same sequence, and the same objects reach the same poll steps.

**Approach.** All edits in src/orchestrator/orchestrator.ts; move code, do not rewrite it, and keep every `//` and `/** */` comment with the block it annotates. Add type imports for `PollState` and `OnceRound`/`ModelCheckGate` as needed from the modules already imported (no new dependency, no new file, no new export).
- Add a module-private `interface OrchestratorSetup` holding exactly: `root`, `config`, `mainBranch`, `pollMs`, `modelsPath`, `breakerPolicy`, `breakerNow`, `enabled`, `internalStop`, `internalRoleStop`, `signal`, `roleSignal`, `redeploy`, `launchServicesWatch`, `reclaim`, `infoFile`, `info`, `runners` and `retentionPruner`.
- Add `async function prepareOrchestratorRun(opts: RunOptions): Promise<OrchestratorSetup>`, holding today's body from the destructure/defaults through the `RetentionPruner` construction: the `enabled` resolution and the empty-set throw, the two `AbortController`s and the `AbortSignal.any` pair, the once-mode nulling of `redeploy`/`launchServicesWatch`, `new ReclaimController`, the info-file read/write and start event, `runStartupMigrations`, `dropDanglingTumwaterPins`, the previous-pid orphan reap, `archiveAtTeamStart`, the `RoleRunner` map, `removeLegacyLandWorktrees`, `retireLegacyRoleWorktrees(root, runnerIds(config))`, `pinCrashedRuns` and `new RetentionPruner`, in that exact order and with the same awaits. `previous` stays local: only the orphan-reap branch reads it.
- Add `function buildOrchestratorRuntime(setup: OrchestratorSetup, opts: RunOptions): OrchestratorRuntime`, holding today's body from the in-flight sets through `const state = newPollState()`: the sets and duration array, `newMergePipeline`, `new OnceRound(runners, opts.once === true)`, `newTeamGateStates`, `newLiveConfigReload` (reading `opts.roleFilter`), `new WorkMergedCache`, `createMainWatch` with the unchanged `queueCulpritHeal` callback, the deferral map, `newNotifier`, `bestEffortEventLogger`, `newOpencodeCatalogRefresh`, the `ModelCheckGate` (`opts.modelCheck`/`opts.modelCheckPolicy`), the `PollContext` literal and `newPollState()`. Return a module-private `interface OrchestratorRuntime { setup: OrchestratorSetup; ctx: PollContext; state: PollState; once: OnceRound; modelCheck: ModelCheckGate | null }`.
- Add `async function shutDownOrchestrator(runtime: OrchestratorRuntime, opts: RunOptions, stopCause: "restart" | "once" | "signal" | "error"): Promise<void>`, holding today's `finally` body: `drainInFlightWork` with `runtime.setup.root`, `ctx.roleInFlight`, `ctx.directorInFlight`, `mergeTasks(ctx.merges)`, `state.restart`, `opts.handoffMergeWindowMs ?? HANDOFF_MERGE_WINDOW_MS` and the `internalStop.abort` callback; `modelCheck?.close()`; the `orchestrator_stop` emit; `notifier.dispose()`; `removeQuiet(setup.infoFile)`.
- `runOrchestrator` keeps its `export`, signature and doc comment, and its body becomes: `const setup = await prepareOrchestratorRun(opts);` `const runtime = buildOrchestratorRuntime(setup, opts);` the unchanged `while (!signal.aborted)` loop reading `runtime.ctx`/`runtime.state`, a `try`/`finally` calling `shutDownOrchestrator(runtime, opts, stopCause)`, and the unchanged once-mode return reading `runtime.once`/`runtime.state.restart`/`runtime.setup.runners`.

**Files touched.** src/orchestrator/orchestrator.ts

**Acceptance criteria.**
- The exported surface is unchanged: `grep -nE '^export ' src/orchestrator/orchestrator.ts` still matches only `runOrchestrator`, and every new interface and helper is module-private (no `export`).
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/orchestrator/orchestrator.ts` reports `runOrchestrator` at 10 or below (it reports 24 today), no new helper above 10, and no other function in the file above 2 (today's highest after `runOrchestrator` is 2).
- Startup order is byte-for-byte the same sequence: info read then write, start event, `runStartupMigrations`, `dropDanglingTumwaterPins`, the previous-pid reap, `archiveAtTeamStart`, `RoleRunner` construction, `removeLegacyLandWorktrees`, `retireLegacyRoleWorktrees`, `pinCrashedRuns`, `RetentionPruner` — each still awaited where it is today — so INV-CU3's "startup, after `retireLegacyRoleWorktrees`" stays true.
- The poll loop, the shutdown drain and the once-mode return are unchanged in behavior: the same stop causes, the same `state.restart`, and the same `{ restart, settled, runsDone }` shape a daemon or once-mode caller reads.
- No edit lands outside src/orchestrator/orchestrator.ts; docs/invariants.md, README.md and the test files are unchanged because the move preserves every pinned startup and shutdown guarantee.
- `npm run test:gate` passes.

**Tests.** No new test module: the split is behavior-preserving. Run test/orchestrator.e2e.test.ts (its shutdown/stop-event case and the deep-equal daemon return), test/orchestrator-once.e2e.test.ts and test/orchestrator-once.test.ts (the once return's `settled`/`runsDone`), test/orchestrator-start-event-best-effort.test.ts (an unwritable feed still starts the team), test/orchestrator-launch.test.ts and test/orchestrator-seams.test.ts (the startup and stop seams), then the project's gate. If a startup step changes order or an e2e return shape changes, a block moved to the wrong helper; fix the move, do not relax an assertion to make it pass.

### `Redeployer.status`'s complexity-18 body in src/redeploy/redeployer.ts is split into two named private methods — `applyRestartStatus` for the pending/blocked/cooldown explanation of a stale build and `applyWaitingForCheck` for the uncovered-tip verdict — so "why is this stale build not restarting?" and "is main's tip still waiting on a check?" are each read from one name (planned 2026-11-02 by the plan role; continues the landed split-large-function family — the 2026-10-25 `Redeployer.poll` split extracted one named private stage method per decision from the poll state machine in this same class, and the 2026-10-31 `skipRunner`, `readPostReviews`, `resolveRoleConfig` and `workReserveCount` entries each extract named helpers the same way; independent in file of every `## Planned` entry — `awk '/^## Planned/,/^## Done/' PLANS.md | grep -c 'redeployer\.ts'` prints 0 and the same command for `status()` prints 0, so no waiting heading or Files-touched list names this file, and no other `## Planned` entry's Files-touched list names `src/redeploy`; PLANS-DONE.md records the `Redeployer.poll` split, while `grep -cE '^### .*Redeployer\.status' PLANS-DONE.md` prints 0 — no archived plan is a split of this method; docs/invariants.md binds no symbol of this method, so no invariant edit is needed; touches src/redeploy/redeployer.ts)

**Goal.** `Redeployer.status` (src/redeploy/redeployer.ts) is a complexity-18 method that answers three unrelated questions inline: what the running build is (`sha`, `builtAt`, and the `stale`/`aheadCommits`/`checkedHead` triple), why a stale build is still the one running (a pending restart with its hold stage, a blocked head with its reason, or the cooldown/refusal phrase), and whether main's tip has code no passing commit covers yet (`waitingForCheck`). The last two blocks are already comment-led and independent of each other, but a reader must read the whole method to find either. Lift each into a named private method, leaving `status` as the guard plus two calls, with no behavior change.

**Approach.** All edits in src/redeploy/redeployer.ts; move code, do not rewrite it, and keep every `//` and `/** */` comment with the block it annotates. No exported name, signature, return type or new import changes.
- Add `private applyRestartStatus(s: BuildStatus, now: number): void`, holding today's `if (this.pendingHead === this.lastHead) { ... } else if (this.blockedHead === this.lastHead && this.blockedReason) ... else if (s.stale && this.autoRestartOn) { ... }` chain verbatim, including the comment above it, the `effectiveCooldownUntil(now)` destructure, the `cooldownPhrase(until)` + urgent suffix, and the `refusedReason` branch. It mutates the same `s` fields (`restartPending`, `restartHold`, `restartBlocked`) in the same precedence order.
- Add `private applyWaitingForCheck(s: BuildStatus): void`, holding today's `if (!s.stale && this.lastTip !== null && this.lastTip !== this.lastHead && this.tipStaleness?.stale) s.waitingForCheck = { head: this.lastTip, aheadCommits: this.tipStaleness.aheadCommits };` verbatim with its comment (the truthiness narrowing that lets `this.tipStaleness.aheadCommits` type-check must survive the move — keep the same condition expression, not a precomputed boolean).
- Reduce `status(now = Date.now()): BuildStatus` to: build `s`; inside the unchanged `if (this.lastHead !== null && this.staleness)` block set `s.stale`/`s.aheadCommits`/`s.checkedHead` as today, then call `this.applyRestartStatus(s, now);` then `this.applyWaitingForCheck(s);`; return `s`. Keep the method private/public modifiers and doc comment unchanged, and keep the guard and field order exactly as today (the restart explanation before the waiting verdict).

**Files touched.** src/redeploy/redeployer.ts

**Acceptance criteria.**
- `status`'s signature, doc comment and `BuildStatus` return are unchanged (it stays the public method the orchestrator and dashboards call, with the same `now` test seam), and both new methods are `private` on `Redeployer`.
- `npx --no-install eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/redeploy/redeployer.ts` reports `status` at 8 or below (it reports 18 today), neither new method above 12, and no other method's reported complexity moves.
- The published object is field-for-field and precedence-for-precedence identical: `restartPending`/`restartHold` beat `restartBlocked`; the cooldown phrase keeps its literal `cooldown until ` prefix (the ui/badges.ts contract) and its urgent suffix; `waitingForCheck` appears only when the target is not stale, the tip differs from the target and the tip's own staleness says stale.
- No edit lands outside src/redeploy/redeployer.ts; docs/invariants.md and the test files are unchanged because the move preserves every pinned status guarantee.
- `npm run test:gate` passes.

**Tests.** No new test module: the split is behavior-preserving. Run test/redeployer.test.ts whole — it pins the bare status object, `waitingForCheck` present/absent, `restartPending` vs `restartBlocked` precedence, `restartHold` stages and the blocked/reason cases — plus test/redeploy-wiring.test.ts, test/redeploy-escalation.test.ts, test/redeploy-rejected.test.ts and test/redeploy-startup-gates.test.ts, then the project's gate. If a status field changes, moves to the wrong helper or loses its precedence, fix the move; do not relax an assertion to make it pass.

### `Redeployer.status`'s complexity-18 build-status assembly in src/redeploy/redeployer.ts is split into two named private helpers — `applyRestartStatus` for the pending/blocked/cooldown branches and `applyWaitingForCheck` for the uncovered-tip branch — leaving `status` reading as the build identity, the staleness fields and two named calls (planned 2026-11-02 by the plan role; continues the landed split-large-function family — the 2026-10-25 `Redeployer.poll` split extracted the state-machine stages but left `status` whole, and the 2026-10-31 `skipRunner`, `readPostReviews`, `resolveRoleConfig` and `workReserveCount` entries each extract one named helper per concern the same way; independent in file of every `## Planned` entry — `awk '/^## Planned/,/^## Done/' PLANS.md | grep -c 'src/redeploy/redeployer\.ts'` prints 0 and the same command for `Redeployer\.status` prints 0, so no open heading or touches list names this file or function (the two `redeploy` prose matches in the Hourly full check parts say only that `redeployTarget` is unchanged, and neither names this file); PLANS-DONE.md records the 2026-10-25 `Redeployer.poll` stage split and later behavior changes to self-redeploy, but `grep -cE '^### .*Redeployer\.status' PLANS-DONE.md` prints 0 — no split of `status`; docs/invariants.md binds src/redeploy/redeployer.ts through INV-K1's `pollRedeploy`/redeploy target and INV-K2's mirror serialization, neither of which the `status` body computes, so a behavior-preserving private split leaves both bindings and their pinned test cases unchanged; touches src/redeploy/redeployer.ts)

**Goal.** `status(now = Date.now()): BuildStatus` is the highest-complexity function in src/redeploy/redeployer.ts at 18 (verified with the project's eslint complexity config). It answers four different questions in one body: "is a restart pending, and which step is it holding in?", "why is a stale build not updating yet?" (a latched block, the running version's own red check, a post-restart cooldown, or a boot refusal), and "is main's tip ahead of the verified target waiting for a check?". A reader of the published `BuildStatus` has to trace mutually exclusive branches to learn which reason a field carries. Give each branch family a name so `status` reads as the build identity, the staleness fields and two calls.

**Approach.** All edits in src/redeploy/redeployer.ts; move code and its comments, do not rewrite the wording or reorder the branches.
- `status` keeps its signature, doc comment and early identity-only return: `const s: BuildStatus = { sha: this.build.sha, builtAt: this.build.builtAt };` then the same `this.lastHead !== null && this.staleness` guard. Inside it, assign `s.stale`, `s.aheadCommits` and `s.checkedHead` exactly as today, call `this.applyRestartStatus(s, now)`, then `this.applyWaitingForCheck(s)`, and return `s`.
- Add `private applyRestartStatus(s: BuildStatus, now: number): void`, holding today's three restart branches in their existing precedence: the `pendingHead === lastHead` case setting `restartPending` and copying `restartHold` from `holdStage`; the `blockedHead === lastHead && blockedReason` case setting `restartBlocked`; and the `stale && autoRestartOn` case computing `effectiveCooldownUntil(now)` and choosing the `cooldownPhrase(until)` line with its urgent suffix, or the `refusedReason` line. Keep every comment with the branch it explains.
- Add `private applyWaitingForCheck(s: BuildStatus): void`, holding today's final condition unchanged: when the target is not stale, `lastTip` is set and differs from `lastHead`, and `tipStaleness?.stale`, set `s.waitingForCheck = { head: this.lastTip, aheadCommits: this.tipStaleness.aheadCommits }`.
- No new export, no new file, no dependency, and no edit to the `Redeployer` constructor, `poll`, `noteTip`, `forceRestart` or the status helpers `cooldownUntil`/`cooldownPhrase`/`effectiveCooldownUntil`.

**Files touched.** src/redeploy/redeployer.ts

**Acceptance criteria.**
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/redeploy/redeployer.ts` reports `status` at 10 or below (it reports 18 today), each new helper at 10 or below, and no other function's reported complexity rises above today's numbers in that file (`poll` 15, `observeHead` 15, `compileStage` 13 are the next highest).
- The published `BuildStatus` carries exactly the same fields and precedence as today: a pending restart wins over a block and a cooldown, `restartHold` is copied only for the pending head, the cooldown/refusal wording is unchanged, and `waitingForCheck` is set only when the target is not stale while the tip differs and has its own stale verdict.
- The exported surface is unchanged (`bestEffortLog` and the `Redeployer` class only); both new helpers are `private`.
- No edit lands outside src/redeploy/redeployer.ts; docs/invariants.md, README.md and the test files are unchanged because the move preserves INV-K1 and INV-K2's guarantees.
- `npm run test:gate` passes.

**Tests.** No new test module: the split is behavior-preserving. Run test/redeployer.test.ts (its deep-equal status cases and the pending-vs-blocked, cooldown, hold-step and waitingForCheck assertions), test/redeploy-prewarm.test.ts and test/redeploy-startup-gates.test.ts (prewarm hold stages and boot-refusal status), test/redeploy-rejected.test.ts (refused restarts), and test/orchestrator-redeploy.test.ts (status published into orchestrator.json), then the project's gate. If a status field or its precedence changes, a block moved to the wrong helper; fix the move, do not relax an assertion to make it pass.

## Done

### Subtract, part 3b/7: The pre-merge verify stops running the project's build check (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3a/7 landed; touches src/review/review.ts src/review/review-precheck.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts docs/how-it-works.md docs/invariants.md test/review.test.ts test/review-precheck.test.ts test/review-precheck-watch.test.ts test/merge-pipeline-watch.test.ts)

**Goal.** A merge's verify judges the diff's deterministic rules and nothing else: it runs no build check, so main has exactly one full check per merged commit, the main watch's post-landing one. Remove `gateBuildPrecheck` and the `verifiedHead`/`knownMainFailures` hand-off it carries; keep `diffRuleReasons`'s three hard rejects (brief block, PRINCIPLES edit, secret leak) and the md-only exempt path.

**Approach.**
- Delete src/review/review-precheck.ts in whole — its only export is `gateBuildPrecheck` and its only caller is review.ts. `reviewAttempt` in review.ts returns `{ decision: "approved" }` after the diff rules and before any build run; remove its `pre`/`retry.pre` fields, its check-slot lease, its flake/quarantine branches and its `verifiedHead` result field.
- Remove `verifiedHead` from `MergeRequest` (merge-core.ts), `VerifyVerdict`/`verifyRequestIn` (merge-batch.ts), `ApprovedMerge` (merge-pipeline.ts), `startVerify` (merge-verify.ts) and the red-baseline seed it feeds.
- The `merge_red`/`main_red` attribution paths that read the pre-check's result stay for the Every commit is verified on main 4j/3–4k/3 parts to remove; this part deletes only the pre-check call and its result field.
- docs/how-it-works.md's Review section says the pre-merge gate is the deterministic diff rules only; docs/invariants.md re-points the build-check bindings from the verify to the main watch.

**Files touched.** src/review/review.ts src/review/review-precheck.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts docs/how-it-works.md docs/invariants.md test/review.test.ts test/review-precheck.test.ts test/review-precheck-watch.test.ts test/merge-pipeline-watch.test.ts

**Acceptance criteria.**
- A verify of an ordinary change emits no `build_check` event and starts no pi/check run; it approves on the diff rules alone. A diff editing the brief block, PRINCIPLES.md or a credential is still rejected before it merges.
- `grep -rn 'gateBuildPrecheck\|verifiedHead' src/` prints nothing.
- The main watch's post-landing `build_check` still runs for every merged tip; the pre-check's tests are deleted or re-pointed to the watch, never left asserting a mechanism that is gone.
- `npm run test:gate` passes.

**Tests.** test/review.test.ts: the approved path approves without a check, the three diff-rule rejects stay. test/review-precheck.test.ts and test/review-precheck-watch.test.ts: delete the pre-check cases (the whole subject is gone) and keep the watch cases that now own build verification. test/merge-pipeline-watch.test.ts: drop the `verifiedHead` seeding assertions. Run those files and the gate.
— done 2026-11-01 by the feature role
