# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Hourly full check, part 2a/4: Every full verdict records when it was checked, persisted so an hourly cadence can survive a restart (planned 2026-11-03 by the plan role, splitting the 2026-11-01 part 2/4 after feature held it too large for one run; behavior-preserving groundwork for part 2b/4, independent in files of it — this part touches no config or watch scheduling — and of every `## Planned` entry; touches src/baseline/main-baseline.ts test/main-baseline-persist.test.ts)

**Goal.** A verdict a full check actually produced records when it was produced (`checkedAt`, epoch ms), and that time survives `persistBaselineVerdicts` and `baseline-verdicts.json`. An hourly cadence (part 2b/4) can then tell how old the newest full verdict is after a restart. Run counts do not change: the watch still runs the full check on each new code head.

**Approach.**
- Add `checkedAt?: number` to `MainBaseline` (src/baseline/main-baseline.ts). Stamp it with `Date.now()` in `baselineFromOutcome`, which every full run's fresh green or red is built from.
- `settleRedByRerun` is not a full run: carry the prior red's `checkedAt` through both the narrowed red and the green a rerun promotes, so a confirmation never extends the hour.
- Do not stamp `noteInheritedGreen`/`inheritedGreen` or the merge-seeded `noteGreenBaseline`: those are green facts about a tree no full check ran on, and part 2b/4's due rule must ignore them.
- Mirror the field in `saveGreens` for both greens and reds, and read it back in `restoreGreenVerdict`/`restoreRedVerdict`. A saved entry without the field loads with it absent (an older file, and a verdict from before this part), not as 0.
- Keep `checkMainBaseline`'s signature unchanged: the stamp is unconditional on an observed verdict, so no caller grows a parameter.

**Files touched.** src/baseline/main-baseline.ts test/main-baseline-persist.test.ts

**Acceptance criteria.**
- After the watch runs a check and records a green or a red, both the cached entry for that SHA and the saved `baseline-verdicts.json` entry carry the same `checkedAt` epoch-ms value.
- `persistBaselineVerdicts` on a file whose entries lack `checkedAt` loads them without error and without inventing a timestamp.
- Entries written by `noteInheritedGreen` and `noteGreenBaseline` still carry no `checkedAt`.
- The existing main-watch run counts are unchanged: every new code head still runs the check once.
- `npm run test:gate` passes.

**Tests.**
- test/main-baseline-persist.test.ts: a fresh observed green and a fresh red each save `checkedAt`, and a reload keeps it; a hand-written file without `checkedAt` loads with the field absent; an inherited green saves without it.
- Run that file and test/main-watch.test.ts, then the project's gate.

### Hourly full check, part 2b/4: The watch runs the full check at most once per `check.fullIntervalMinutes` on main's latest tip, and still runs the diff rules on every new head (planned 2026-11-03 by the plan role, splitting the 2026-11-01 part 2/4 after feature held it too large for one run; requires Hourly full check part 2a/4 landed, so the newest full verdict carries its `checkedAt`; the mirror/concurrency move is part 2c/4, not this entry; touches src/baseline/main-watch.ts src/config/config-schema.ts src/config/config-validation.ts docs/config.md docs/how-it-works.md docs/invariants.md tumwater.example.json test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-watch-rules.test.ts test/config-validation-check.test.ts)

**Goal.** Each change is still checked once before landing by the gate's build check. The full check on main runs at most once per `check.fullIntervalMinutes` (default 60), only when main has a first-parent code commit the newest full verdict does not cover. Every new head still gets the diff rules, which judge each head and never wait for a full run in this part.

**Approach.**
- Add `fullIntervalMinutes?: number` to `CheckConfig` and `CHECK_KEYS` (src/config/config-schema.ts), and validate it in src/config/config-validation.ts as a non-negative integer. `0` restores one full run per new code head.
- Add a clock seam: `createMainWatch(root, mainBranch, onCulprit?, now = Date.now)`. The due decision reads `now()`; the `checkedAt` stamp stays real time as part 2a/4 wrote it.
- Add a module-private due rule in src/baseline/main-watch.ts: find the newest first-parent commit whose cached observed verdict carries `checkedAt`; it is due when that time plus `fullIntervalMinutes` is not in the future and main has a non-exempt code commit above that commit. A doc-only range still inherits green and starts no run. A verdict without `checkedAt` reads as due now.
- In `watchOnce`, when the full check is not due, still enter the mirror and run `watchRules` on the tip, advance `lastWatched`, and record no `main_check` and no run. When due, run `runBaselineCheck`, `recordMainCheck`, the heal/culprit path and `watchRules` as today.
- Docs: docs/config.md and tumwater.example.json name the key; docs/how-it-works.md's main-watch bullet describes the cadence; docs/invariants.md's INV-CZ2 changes "at most once per main commit" to "at most once per `fullIntervalMinutes`" and states the uncovered-code and doc-only-inheritance clauses.

**Files touched.** src/baseline/main-watch.ts src/config/config-schema.ts src/config/config-validation.ts docs/config.md docs/how-it-works.md docs/invariants.md tumwater.example.json test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-watch-rules.test.ts test/config-validation-check.test.ts

**Acceptance criteria.**
- Two code heads whose range sits within the interval of the newest full verdict start one full run between them: the second starts none, yet its diff rules still run and a rule failure is still logged.
- The first poll after the interval with an uncovered code commit starts exactly one full run, on the latest tip, covering every uncovered commit.
- A full verdict saved 20 minutes before a restart starts no full run in the first 40 minutes after it, and the first poll past the hour starts one.
- A doc-only head above the newest verdict starts no run and records an inherited green as today.
- `check.fullIntervalMinutes: 0` restores one full run per new code head.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts, test/main-watch-failures.test.ts and test/main-watch-spells.test.ts: re-point the existing once-per-head `runsOf` assertions to the hourly model with the injected clock (advance past the interval where a run is expected), and add the within-the-hour, past-the-hour, restart-with-saved-`checkedAt`, doc-only and `fullIntervalMinutes: 0` cases.
- test/main-watch-rules.test.ts: the diff rules run on a head the full check skips.
- test/config-validation-check.test.ts: the key's integer bounds (0 accepted, negative and fraction rejected) and the unknown-key list.
- Run those files and the project's gate.

### Hourly full check, part 2c/4: The full check runs in its own `_main-full` mirror with its own in-flight pass, so a suite run never holds `_gate-main` (planned 2026-11-03 by the plan role, splitting the 2026-11-01 part 2/4 after feature held it too large for one run; requires Hourly full check part 2b/4 landed, so the full check is due-gated before it moves mirrors; touches src/paths.ts src/baseline/main-red.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-rules.test.ts test/main-watch-mirror.test.ts)

**Goal.** A full suite run, which can take 3–20 minutes, no longer holds the `_gate-main` mirror the per-head diff rules and the gate's main-tip attribution use. The full check runs in a detached mirror of its own, `_main-full`, with its own in-flight promise; `poll` starts each pass independently and `idle()` waits for both.

**Approach.**
- Add `fullMainWorktreePath(root)` to src/paths.ts: `_main-full` beside `_gate-main`, documented the same way.
- In src/baseline/main-red.ts add `withFullMainTipWorktree`, shaped like `withMainTipWorktree` but pinning `fullMainWorktreePath` and queuing on its own promise, never `gateMainQueue`, so a gate's main-tip re-run and a full check can overlap.
- In `createMainWatch`, replace the single `inFlight` promise with a per-head rules pass in `_gate-main` and a due full-check pass in `_main-full`. `poll` starts the rules pass on every new head and the full-check pass when part 2b/4 says it is due, each behind its own in-flight guard. `idle()` waits for both plus housekeeping.
- Keep one `lastWatched` for the rules pass, so each head's diff is judged once; the full pass derives its own due state from `checkedAt`, so a head already checked starts no second run.
- docs/how-it-works.md says the full check owns its mirror; docs/invariants.md adds INV-DA2: the full check runs at most once per interval, on the latest tip, in `_main-full`, only while a code commit is uncovered, and a `_gate-main` diff-rule or gate step never waits behind it.

**Files touched.** src/paths.ts src/baseline/main-red.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-rules.test.ts test/main-watch-mirror.test.ts

**Acceptance criteria.**
- With a full check that sleeps before exiting, a new head's diff rules finish and a gate's main-tip re-run completes while that full run is still in flight.
- The full check runs in `_main-full`; no full run holds `_gate-main`.
- `idle()` returns only after the rules pass, the full-check pass and housekeeping have all finished.
- A head that moves while a full run is in flight is checked on the latest tip by the next poll, as today.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch-mirror.test.ts: a slow full check and a concurrent `mainTipVerdict` call overlap (the gate's answer arrives before the full run ends), and the two worktree paths differ.
- test/main-watch.test.ts and test/main-watch-rules.test.ts: existing per-head cases pass with the split passes, including `idle()` draining a slow full run.
- Run those files and the project's gate.

### Hourly full check, part 3/4: Main's failures are narrowed and cleared by re-running only the failing tests — the watch bisects a red's opener, re-runs only the open failures on each new head, and confirms a cleared red with one full run at once (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 2c/4 landed; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts)

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

### Subtract, part 6a/6: The live docs and example config keep only the mechanisms that survived the series (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6b/6, independent in files of it; design in plans/subtract.md "The six strokes" and "How we will know it worked"; its original prerequisites Subtract parts 1e/6, 5v/6 and 5x/6 have landed, and it requires Subtract part 3g/7 landed, the last unlanded Subtract part; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json)

**Goal.** The live prose and `tumwater.example.json` describe only mechanisms that still exist after the Subtract series: the names whose producer and reader the earlier parts removed are gone from the config tables, command lists, glossary, architecture prose and example config, while every mechanism the user kept is still documented and its keys still appear. This is the documentation half of the old sweep; the doctor rows, tests and before/after counts are part 6b/6.

**Approach.** All edits are documentation and the example config; no `src/` file changes here.
- Treat the old sweep list as a candidate list, not a mandate: for each name, `grep -rn '<name>' src/` first. A name whose live `src/` reader or writer is gone is removed from the swept docs and the example; a name `src/` still reads or writes stays documented with its tests. The pre-merge gate keeps its build check (user, 2026-11-01), so in particular `check_wait` and `maxConcurrentChecks` stay wherever the check permit still serves that gate or the main watch, and `mergeCommand` stays wherever the merge step still reads it. `mergeBatchMax` is dead after the batch path landed; `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `review.afterMerge`, `held-for-operator`, `Needs replan`, `Waiting for the next failure` and the `(held N)` counter are dead. The queue vocabulary (`merge queue`, `interlock`) belongs to the landed part 3g/7; remove any occurrence this file still carries.
- docs/config.md: drop the dead keys and aliases from the tables, and keep the rows for the keys `src/config/config-schema.ts` still reads — `instances`, `slotCount`, `slot_wait`, `slot salvage`, the tier/fallback keys, the image reroute and the subscription usage-window display (the Settings concurrency controls and those mechanisms were kept: director 2026-10-31, user 2026-10-28 and 2026-10-30).
- docs/cli.md and the TUI-keys table: drop commands, flags and keys whose implementation parts 3d/7–3f/7 removed, and keep the concurrency controls and declared-check editing that remain. docs/glossary.md: remove the terms for deleted mechanisms and keep the kept vocabulary.
- docs/how-it-works.md: remove paragraphs that still promise a deleted stage, queue or alert; keep the gate's pre-merge build check and the Hourly full check's hourly main watch as landed.
- tumwater.example.json: remove only the dead keys; preserve the kept capacity, tier, fallback, image-reroute and subscription-window settings.
- docs/invariants.md: drop or re-scope the invariants of deleted subsystems (merge-slot stages, the permit where its mechanism is gone, per-provider caps, subscription-window holds), keep the invariants of the tiers, budget fallback, image reroute and subscription usage-window display, and leave every remaining file/test binding naming an existing file and test.
- README.md and DEVELOPMENT.md: remove stale references to the deleted mechanisms; do not touch the brief block between the `tumwater:prompt` markers.

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json

**Acceptance criteria.**
- For every candidate name, the part's Done entry records the `grep` evidence: either no live `src/` reader remains and the name is absent from the swept docs and example, or a live reader remains and the name is still documented with that reader.
- `grep -rnE 'maxConcurrentPerProvider|mergeBatchMax|claudeWindowReserve|windowReserve|review\.afterMerge|held-for-operator|Needs replan|Waiting for the next failure' docs/ README.md DEVELOPMENT.md tumwater.example.json` prints nothing.
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` prints no claim about a mechanism the landed parts deleted.
- The kept mechanisms are still documented: the Settings concurrency controls, the tier and budget-fallback settings, the image reroute and the subscription usage-window display, plus any check-permit key `src/` still reads.
- docs/invariants.md keeps no binding to a deleted module and no binding whose named test file is gone; docs/config.md, docs/cli.md and the TUI-keys table agree with the live schema and command set.
- `npm run test:gate` passes.

**Tests.** Run test/config-doc.test.ts (docs/config.md against the live schema), test/cli-doc.test.ts and test/docs-commands.test.ts (command help/docs parity), test/tui-keys-doc.test.ts, test/docs-links.test.ts and test/invariants-doc.test.ts (file and test bindings), then the project's gate. If a kept key is dropped from the docs or a dead key stays, fix the table; do not weaken a doc check.

### Subtract, part 6b/6: The doctor rows, tests and counts the series left behind (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6a/6, requires Subtract part 6a/6 landed so the surviving key and row set is fixed; touches src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md)

**Goal.** The doctor advertises only checks whose mechanism still exists, and the tests assert only surviving rows, events, artifacts and keys. This is the code-and-tests half of the old sweep; the live docs and example config are part 6a/6, whose surviving set this part follows. The part also records the series' before/after row and key counts and its measurement table.

**Approach.** All edits are the doctor row list and the tests that pin it; no production behavior changes.
- src/doctor/doctor-check-names.ts: delete the rows whose check function no longer exists after the series; do not re-point them at another mechanism. Keep every row whose check still reads a live path. Do not add a row.
- Re-check the parts 1a–1e/6 rule end to end: every condition that used to have a banner and now has no banner still has a doctor row, and every row names a mechanism that exists. Record any condition with neither a banner nor a row in the part's Done entry rather than inventing a row here.
- test/doctor-checks.test.ts: update its row list to exactly the surviving rows; delete cases whose only subject is a deleted row. test/event-format.test.ts: delete the cases for event types no live producer emits (including `check_wait` only when part 6a/6 found no live reader, and the merge-stage events the landed parts removed); keep the cases for surviving event families. test/retention.test.ts: delete the cases for artifacts no mechanism writes; keep the surviving ones. test/config.test.ts: update the key cases to the surviving key set part 6a/6 documented; do not delete a case for a key `src/config/config-schema.ts` still reads.
- In the part's PLANS-DONE entry, record the doctor row count and the config key count before this part and after it, and carry the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md

**Acceptance criteria.**
- Every row name in `doctor-check-names.ts` resolves to a check function that exists and reads a mechanism that still exists; no row reports a path nothing writes.
- The row list in test/doctor-checks.test.ts equals the surviving row set; no test asserts a deleted row, event type, artifact or config key, and the surviving cases stay.
- No production module outside `src/doctor/doctor-check-names.ts` changes; that edit only adds or removes row-name strings, and the diff names only the files listed above.
- The before/after doctor row and config key counts and the measurement table are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

**Tests.** Run test/doctor-checks.test.ts, test/doctor.test.ts, test/event-format.test.ts, test/retention.test.ts, test/config.test.ts and test/config-aliases.test.ts, then the project's gate. If a surviving row or key loses its case, restore it; do not weaken an assertion to make the gate pass.

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

### Subtract verify collapse, part 1/5: The torn-head drop, already-merged dedupe, merge tier constants and author resolver move out of merge-verify.ts into modules a one-step drain keeps (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; opens the series Subtract verify collapse parts 1/5–5/5, whose parts 2/5–5/5 each require the part before them landed; requires Hourly full check part 1b/4 landed; touches src/merge/merge-verify.ts src/merge/merge-head.ts src/merge/merge-author.ts src/merge/merge-drain.ts src/merge/merge-post-review-drain.ts test/merge-queue.test.ts src/gates/budget-gates.ts src/runner/runner-leftover.ts src/git/commit-message.ts src/concurrency/check-permit.ts src/concurrency/semaphore.ts)

**Goal.** The queue hygiene and author/tier helpers that outlive the verify stage live in modules the later parts keep, with the same behavior. `dropTornHead` and the already-merged dedupe stay with the queue; `VERIFY_TIER`, `MERGE_TIER` and `resolveAuthor` stay available to the drain and the post-merge review drain after `merge-verify.ts` is deleted.

**Approach.**
- Add src/merge/merge-head.ts with `dropTornHead` and the private `mergedIntoMain` cache/helper moved verbatim from src/merge/merge-verify.ts; `drainVerify` imports `dropTornHead` from it.
- Add src/merge/merge-author.ts with `VERIFY_TIER`, `MERGE_TIER` and `resolveAuthor` moved verbatim; merge-verify.ts, merge-drain.ts and merge-post-review-drain.ts import them from there.
- Re-point the comments that name merge-verify.ts for these symbols in src/gates/budget-gates.ts, src/runner/runner-leftover.ts, src/git/commit-message.ts, src/concurrency/check-permit.ts and src/concurrency/semaphore.ts.
- test/merge-queue.test.ts imports `dropTornHead` from merge-head.ts.

**Files touched.** src/merge/merge-verify.ts src/merge/merge-head.ts src/merge/merge-author.ts src/merge/merge-drain.ts src/merge/merge-post-review-drain.ts test/merge-queue.test.ts src/gates/budget-gates.ts src/runner/runner-leftover.ts src/git/commit-message.ts src/concurrency/check-permit.ts src/concurrency/semaphore.ts

**Acceptance criteria.**
- `grep -n 'export async function dropTornHead\|async function mergedIntoMain\|export const VERIFY_TIER\|export const MERGE_TIER\|export function resolveAuthor' src/merge/merge-verify.ts` prints nothing; the declarations exist in merge-head.ts and merge-author.ts.
- The torn-head, dedupe-cache and post-merge-review tests keep their behavior: no test expectation changes beyond the import path.
- `npm run test:gate` passes.

**Tests.** Run test/merge-queue.test.ts, test/merge-pipeline.test.ts and test/post-merge-review.test.ts, then the gate.

### Subtract verify collapse, part 2/5: The queued change's gate has one named home, `reviewQueuedChange` in merge-core.ts, so the merge step can run it in the merge worktree (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 1/5 landed; touches src/merge/merge-core.ts src/merge/merge-batch.ts)

**Goal.** The gate a queued change runs before merging is one function, `reviewQueuedChange(ctx, req, wt, state, foldUsage)`, in merge-core.ts: it rebases the pinned tree onto main's current head (`syncPinToMain`) and runs `reviewPinnedChange`, returning its `GateOutcome`. `verifyRequestIn` in merge-batch.ts calls it, so the existing verify stage and the later one-step drain run the same code; no behavior changes.

**Approach.**
- Export `GateOutcome` and add `reviewQueuedChange` in merge-core.ts as the composition of `syncPinToMain` and `reviewPinnedChange` with the arguments verifyRequestIn passes today.
- In merge-batch.ts, `verifyRequestIn` calls `reviewQueuedChange(ctx, req, wt, w.state, w.foldUsage)` and keeps only the `VerifyVerdict` shaping (`gate` to `approved`, otherwise `result`).
- No other caller or test expectation changes; the withdrawn pre-check, the pooled slot lease and the lease release stay in verifyRequest.

**Files touched.** src/merge/merge-core.ts src/merge/merge-batch.ts

**Acceptance criteria.**
- `reviewQueuedChange` is declared once in merge-core.ts and called by verifyRequestIn; no second copy of the sync-then-review sequence remains in merge-batch.ts.
- test/merge-drain-verify.test.ts and test/merger.test.ts still pass with their existing expectations: an approved change still reaches the merge at the synced head, and a rejected or failed one still settles as before.
- `npm run test:gate` passes.

**Tests.** Run test/merge-drain-verify.test.ts, test/merger.test.ts and test/merger-check.test.ts, then the gate.

### Subtract verify collapse, part 3/5: The merge queue drains one entry at a time through the gate and the merge in a single task; the verify stage, its maps and its modules are deleted (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 2/5 landed; touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/merge-requeue.test.ts test/fixtures/orchestrator-fixtures.ts)

**Goal.** A queued entry goes from the queue to the gate to the merge in one task: `drainMerge` starts the head entry, `mergeApprovedChange` runs `reviewQueuedChange` in the merge worktree before `mergeToMain`, and a rejected entry settles as today. No `verifying`/`approved` maps, no separate verify task, no second review. The durable queue still orders entries and the pin still carries the commit.

**Approach.**
- merge-core.ts: in `mergeApprovedChangeIn`, check the withdrawn entry (`withdrawnPinReason` plus `dropWithdrawnPin`, as `mergeToMain` does) and run `reviewQueuedChange(ctx, req, wt, ctx.state, ctx.foldUsage)` before `mergeToMain`; return its result when it is not an approval, otherwise merge the approved head. Update `mergeApprovedChange`'s "already passed its own gate" comment.
- merge-drain.ts: `drainMergeQueue` becomes `drainPostReviews` plus `drainMerge`; `drainMerge` takes `headMerge` and starts one single-change `startMerge` task; the task resolves the author, calls `mergeApprovedChange`, settles each outcome through `settleMergeOutcome`, queues the post-merge review on a `merged` event as today, and handles user abort and shutdown as today. Delete `settleAbortedApproved` and the `approved`/`verifying` branches.
- merge-pipeline.ts: `MergePipeline` becomes `{ merge, postReview }`; delete `ApprovedMerge`; `mergeTasks` and `abortableMerges` read those; drop `liveRoles` if no caller remains.
- src/orchestrator/orchestrator-poll.ts: remove the `settleAbortedApproved` import and its per-poll call.
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts; delete test/merge-drain-verify.test.ts.
- test/fixtures/orchestrator-fixtures.ts's `mergeHead` drives the queue head through `drainMergeQueue` (or the one merge task) instead of `startVerify` plus `drainMerge`; update the merge-drain/pipeline/merger tests to assert the one-step path.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/merge-requeue.test.ts test/fixtures/orchestrator-fixtures.ts

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start or approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential, or whose gate check fails for a test of its own, is rejected before it merges; every other queued diff merges without a second review.
- `grep -rn 'drainVerify\|startVerify\|verifyRequest\|ApprovedMerge\|p\.verifying\|p\.approved' src/` prints nothing, and `ls src/merge/merge-verify.ts src/merge/merge-batch.ts` fails.
- test/merge-drain-verify.test.ts is gone with its subject; the surviving merge-drain and pipeline tests drive an entry from queue to merge.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Update test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts, test/merger.test.ts and test/merge-requeue.test.ts to drive an entry from queue to merge without the verify/approved map, and update the fixtures' `mergeHead` to the same path. Run those files and the gate.

### Subtract verify collapse, part 4/5: The `approved` in-flight status and the status, GUI and queue surfaces that wait on it are removed (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 3/5 landed; touches src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/ui/status-model.ts src/ui/gui/gui-client-model.ts src/cli/help.ts test/merge-slot.test.ts test/status-model.test.ts test/status-data-inbox.test.ts test/gui-client.test.ts test/help.test.ts test/team-alerts.test.ts test/merge-queue.test.ts test/status-polls.test.ts)

**Goal.** No operator surface or marker type advertises a change waiting for a merge slot that no longer exists: `MergeChangeStatus` is `"merging" | "done"`, and status, GUI, help and the merge-queue cell render only live states. `checkWaitStage` and `resolveWaitStage` stay because the gate build check (review-precheck.ts) and the conflict resolver still wait on permits.

**Approach.**
- merge-slot.ts: drop `"approved"` from `MergeChangeStatus`, from `isMergeChange`'s accepted statuses and from the comments; keep `setMergeChangeStatus` for merging/done and keep both wait-stage hooks.
- merge-queue-render.ts: drop the `change.status === "approved"` branch (Subtract part 3d/7 later deletes this module; whichever lands first rebases).
- status-model.ts and gui-client-model.ts: remove the `approved, waiting to merge` phase mapping and rank; update the comments that describe the verify-to-approval wait.
- cli/help.ts: remove the `[approved, waiting to merge]` stage example.
- Update the tests above that pin the removed string or status; add no new status.

**Files touched.** src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/ui/status-model.ts src/ui/gui/gui-client-model.ts src/cli/help.ts test/merge-slot.test.ts test/status-model.test.ts test/status-data-inbox.test.ts test/gui-client.test.ts test/help.test.ts test/team-alerts.test.ts test/merge-queue.test.ts test/status-polls.test.ts

**Acceptance criteria.**
- `grep -rn 'approved, waiting to merge\|status === "approved"' src/` prints nothing for the merge marker and operator surfaces; the review gate's own `approved` verdict is out of scope and stays.
- A marker record whose status is `approved` is no longer accepted as a live change; the status, GUI and help tests assert only merging and done states.
- `npm run test:gate` passes.

**Tests.** Run test/merge-slot.test.ts, test/status-model.test.ts, test/status-data-inbox.test.ts, test/gui-client.test.ts, test/help.test.ts, test/merge-queue.test.ts and test/status-polls.test.ts, then the gate.

### Subtract verify collapse, part 5/5: docs/how-it-works.md and docs/invariants.md describe one gate-then-merge step and bind only modules that survive (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 4/5 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md test/invariants-doc.test.ts)

**Goal.** The live prose and invariant bindings describe the landing that exists after parts 1/5–4/5: a queued pin is gated in the merge worktree (the deterministic diff rules plus the declared gate command), then rebased and fast-forwarded under the merge lock; no sentence promises a separate verify stage or an approval wait. The post-landing review and the main watch keep their guarantees.

**Approach.**
- docs/how-it-works.md's merge pipeline section: replace "Queued changes are approved in parallel and one serial merge step merges them" and the Review/Merge paragraphs that describe a separate verify stage with one step per queued head: gate (diff rules plus build check, and the withdrawn check) then merge; keep the post-merge review, the main watch and the permit accounting.
- docs/invariants.md: re-point every binding that names src/merge/merge-verify.ts, src/merge/merge-batch.ts, `verifyRequest`, `dropTornHead`, `ApprovedMerge` or a verify-stage marker to the surviving module and test (merge-head.ts, merge-drain.ts, merge-core.ts, merge-slot.ts); keep the guarantees whose code survives (withdrawn pin drop, torn-head drop, gate build-check abort, post-merge review permit). Do not delete a guarantee just because its binding moves.
- docs/glossary.md's retired-name row for `landing-vetting.ts` names `merge-verify.ts`; point it at the surviving merge-core.ts (Subtract part 3g/7 later re-sweeps the glossary).
- test/invariants-doc.test.ts's expectations follow the re-pointed bindings.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md test/invariants-doc.test.ts

**Acceptance criteria.**
- `grep -rniE 'verify stage|approval stage|approved in parallel|approved, waiting to merge' docs/ README.md` prints no claim that a separate verify stage or approval wait exists.
- Every docs/invariants.md binding names an existing src file and test file; no binding names merge-verify.ts or merge-batch.ts.
- The prose still states the gate's build check, the one merge lock, linear history and the main watch's post-landing check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/docs-links.test.ts, then the gate.

### Subtract verify collapse, part 1/5: The queue-health and tier/author helpers move out of the verify modules, so deleting the verify stage later is a small, behavior-preserving cut (planned 2026-11-03 by the plan role, splitting the 2026-10-31 `Subtract part 3c/7` after feature held it too large for one run; requires Hourly full check part 1b/4 landed; touches src/merge/merge-verify.ts src/merge/merge-queue-health.ts src/merge/merge-tiers.ts src/merge/merge-drain.ts src/merge/merge-post-review-drain.ts src/merge/merge-core.ts test/merge-queue.test.ts test/merge-pipeline.test.ts test/merge-requeue.test.ts)

**Goal.** The helpers the rest of the merge code needs after the verify stage goes live in their own modules, with the same behavior: queue health (torn-head drop and the merged-into-main dedupe) and the merge tiers/author resolution. Nothing is deleted from the running path in this part.

**Approach.**
- Create src/merge/merge-queue-health.ts with `dropTornHead` and the `mergedIntoMain` cache/dedupe helper, moved verbatim from src/merge/merge-verify.ts; keep the exported `dropTornHead` name and its warning text.
- Create src/merge/merge-tiers.ts with `VERIFY_TIER`, `MERGE_TIER`, `verifyLimit` and `resolveAuthor`, moved from merge-verify.ts; `VERIFY_TIER`/`MERGE_TIER` stay because the post-merge review drain uses them.
- Import the moved symbols in merge-verify.ts, merge-drain.ts, merge-post-review-drain.ts and the tests; update the doc comments that name the old home. Do not change any wait tier, cache key, warning or resolution rule.

**Files touched.** src/merge/merge-verify.ts src/merge/merge-queue-health.ts src/merge/merge-tiers.ts src/merge/merge-drain.ts src/merge/merge-post-review-drain.ts src/merge/merge-core.ts test/merge-queue.test.ts test/merge-pipeline.test.ts test/merge-requeue.test.ts

**Acceptance criteria.**
- `dropTornHead` and `resolveAuthor` are defined once, in the new modules; merge-verify.ts imports them rather than redefining them, and the same is true of the tier constants.
- The torn-head warning, the merged-into-main cache invalidation and every permit tier read exactly as before; the tests that pin them pass unchanged in behavior.
- No production call site or test imports a moved symbol from merge-verify.ts after this part.
- `npm run test:gate` passes.

**Tests.** Run test/merge-queue.test.ts, test/merge-pipeline.test.ts and test/merge-requeue.test.ts whole, then the project's gate.

### Subtract verify collapse, part 2/5: The merge queue drains one change at a time, gating the queue head through the existing verify path before it merges (planned 2026-11-03 by the plan role, splitting the 2026-10-31 `Subtract part 3c/7` after feature held it too large for one run; requires Subtract verify collapse part 1/5 landed, so queue health and tiers are importable from their new homes; the verify stage is not yet deleted from the types — part 4/5 removes it — touches src/merge/merge-drain.ts src/merge/merge-pipeline.ts test/merge-drain.test.ts test/merge-requeue.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts)

**Goal.** A poll takes the first queued change, runs the existing gate for that one change inside the merge task, and merges it if the gate clears; the next queued change waits for the next poll. The parallel verify/approve fan-out stops, but the verify modules still exist for part 4/5 to delete.

**Approach.**
- In `drainMergeQueue`, call `dropTornHead` directly, then `drainPostReviews` and `drainMerge`; stop calling `drainVerify`. Keep `settleAbortedApproved` working for any map it still reads in this part.
- In `drainMerge`, take the first queued file whose sha main does not already contain (using the moved `mergedIntoMain`; drop such an entry with a warning as `drainVerify` did), build one `ApprovedMerge`-shaped pick from `resolveAuthor`, and start the merge task. Do not read or populate `p.approved`.
- In `startMerge`, before `mergeApprovedChange`, run `verifyRequest` with the same author wiring the merge uses; an approval proceeds to `mergeApprovedChange` with the verdict's `sha`/`verifiedHead`, and any other verdict settles through `settleMergeOutcome` and drops the entry exactly as the verify stage did. The task still holds the merge slot and still settles `aborted`/`conflict` outcomes through the existing merge path.
- Leave `startVerify`, `drainVerify`, `p.verifying` and `p.approved` in the types for this part; they are now unpopulated by the drain.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-pipeline.ts test/merge-drain.test.ts test/merge-requeue.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts

**Acceptance criteria.**
- A poll with two queued changes starts one merge task: it gates and merges the first change, and the second remains queued (with its pin) until a later poll; no separate verification task is started.
- A queued change whose gate rejects, fails or is withdrawn never reaches `mergeToMain`; its entry is dropped and its outcome written as before.
- A queue entry main already contains is dropped without a gate run; a torn head is still dropped and the healthy entries behind it stay queued.
- A merge that ends in a conflict, block or user abort keeps the existing pin/entry semantics.
- `npm run test:gate` passes.

**Tests.** Update test/merge-drain.test.ts and the pipeline cases that drain the queue to assert one gated merge per poll and no verify task. Keep test/merge-requeue.test.ts's `drainVerify` unit cases for part 4/5, but make its queue-drain cases drive `drainMergeQueue`. Run those files plus test/merge-pipeline.test.ts and test/merge-pipeline-2.test.ts, then the gate.

### Subtract verify collapse, part 3/5: The gate lives in `mergeApprovedChange` as `reviewQueuedChange`, so a merge cannot start without the diff rules and build check (planned 2026-11-03 by the plan role, splitting the 2026-10-31 `Subtract part 3c/7` after feature held it too large for one run; requires Subtract verify collapse part 2/5 landed, so the drain has one inline gate call to replace; touches src/merge/merge-core.ts src/merge/merge-drain.ts test/merger.test.ts test/merge-drain.test.ts)

**Goal.** `mergeApprovedChangeIn` runs the review gate itself before `mergeToMain`, so the gate is part of the only path that writes main. The drain stops calling `verifyRequest` directly; its one task calls `mergeApprovedChange` and gets the rejection/approval outcome from there.

**Approach.**
- In merge-core.ts, extract the gate invocation and its immediate bookkeeping from `reviewPinnedChange` into `reviewQueuedChange(ctx, req, wt, state, foldUsage)`: the diff rules and `gateBuildPrecheck`, the rejection record/pin delete, the review_error/main_red/aborted results, and the synced head. `reviewPinnedChange` calls it until part 4/5 deletes that wrapper.
- Call `reviewQueuedChange` from `mergeApprovedChangeIn` after `ensureDetachedWorktree` and before `mergeToMain`; a gate result other than approval returns that result and keeps or deletes the pin exactly as the verify path did, while an approval proceeds into `mergeToMain` with the gate's synced sha.
- In merge-drain.ts, remove part 2's direct `verifyRequest` call; the merge task calls `mergeApprovedChange` and settles its `RunResult` through `settleMergeOutcome` as every other merge outcome is settled.
- Do not gate a merge twice: the inline verify call is gone, so one `reviewQueuedChange` covers one merge.

**Files touched.** src/merge/merge-core.ts src/merge/merge-drain.ts test/merger.test.ts test/merge-drain.test.ts

**Acceptance criteria.**
- A direct `mergeApprovedChange` on a pinned change whose diff edits the brief block, PRINCIPLES.md or a credential is rejected before `mergeToMain` and its pin is deleted; an approved or exempt change merges once.
- A gate failure under the strike cap keeps the pin and returns the same `review_error` result as before; a failed gate on a red main returns `main_red` with the pin kept.
- The drain path spends one gate per merge: a fake reviewer is invoked once, and the merged head is the one the gate approved.
- `grep -rn 'verifyRequest' src/merge/merge-drain.ts` prints nothing.
- `npm run test:gate` passes.

**Tests.** Update test/merger.test.ts to drive rejection, `review_error`, `main_red` and approval through `mergeApprovedChange` alone (no preceding verify), and the drain case in test/merge-drain.test.ts to assert the same one-gate path. Run those files and the gate.

### Subtract verify collapse, part 4/5: The dead verify stage, its modules, its maps and its tests are deleted (planned 2026-11-03 by the plan role, splitting the 2026-10-31 `Subtract part 3c/7` after feature held it too large for one run; requires Subtract verify collapse part 3/5 landed, so no merge path needs the verify modules; touches src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/orchestrator/orchestrator-poll.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-queue.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts)

**Goal.** With the drain gating inside `mergeApprovedChange`, nothing starts a verification or parks an approved change. Delete those modules and their pipeline/marker plumbing so the merge pipeline holds only the one merge task and the post-merge review task.

**Approach.**
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts; `drainVerify`, `startVerify`, `verifyRequest`, `verifyLimit` and `reviewPinnedChange` go with them (the gate itself already lives in merge-core.ts).
- In merge-pipeline.ts delete `verifying`, `approved`, `ApprovedMerge`, `liveRoles`, the verify branches of `mergeTasks`/`abortableMerges`, and `newMergePipeline`'s empty maps; keep `InFlightMerge`, `postReview`, abort, guard and `settleMergeOutcome`.
- In merge-drain.ts delete `settleAbortedApproved` and the old approved-map handling; in orchestrator-poll.ts drop its call. Remove the verify-only `approved` status from merge-slot.ts and its label from merge-queue-render.ts. Keep `checkWaitStage` (the gate's build-check wait) and `resolveWaitStage` (the merge conflict resolver).
- Update the fixtures: `mergeHead` drives `drainMergeQueue` (or an equivalent one-change drain) instead of `startVerify`, and merger-fixtures' `verifyRequest` helper is replaced by the merge path. Delete test/merge-drain-verify.test.ts.

**Files touched.** src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/orchestrator/orchestrator-poll.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-queue.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts

**Acceptance criteria.**
- `grep -rn 'drainVerify\|startVerify\|verifyRequest\|verifyLimit\|reviewPinnedChange\|ApprovedMerge' src/` prints nothing; the compiler is clean.
- `MergePipeline` has only `merge` and `postReview` as task slots, and no code reads or writes `verifying`/`approved`.
- A queued change still reaches main through one gate and one merge, and a torn head, already-merged entry and conflicted pin still settle as in parts 2–3.
- test/merge-drain-verify.test.ts is deleted with its subject; the surviving pipeline/drain/requeue tests assert the one-change drain, and no test asserts a deleted verify stage.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Update test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts, test/merge-requeue.test.ts, test/merge-slot.test.ts and test/merge-queue.test.ts to the surviving pipeline shape; update both fixtures. Run those files and the gate.

### Subtract verify collapse, part 5/5: The live docs and invariant bindings describe the one-task merge queue, not a verify stage (planned 2026-11-03 by the plan role, splitting the 2026-10-31 `Subtract part 3c/7` after feature held it too large for one run; requires Subtract verify collapse part 4/5 landed; the broad Subtract part 3g/7 sweep still follows this series; touches docs/how-it-works.md docs/invariants.md test/invariants-doc.test.ts)

**Goal.** A reader of the live docs sees the merge the code now runs: one task per poll takes the queue head, gates it (the deterministic diff rules and the declared gate command), and merges it by rebase and fast-forward under the merge lock. No prose or binding names a verify stage, `merge-verify`, `merge-batch`, an approved-and-waiting change or a parallel approval.

**Approach.**
- docs/how-it-works.md: replace the Parallel approval and Merge sections with the one-task drain; keep the facts the series did not change — one merge writer, one lock, linear history, the pre-merge gate keeping its build check, and the main watch's post-landing checks (do not restate a full check per commit).
- docs/invariants.md: re-point every merge-gate binding that names `merge-verify.ts` or `merge-batch.ts` at `src/merge/merge-core.ts` (`reviewQueuedChange`) and the drain; keep `checkWaitStage`/`build-check` bindings, since the gate still waits for its check permit. Drop any guarantee that only the verify stage could keep.
- Leave docs/cli.md, docs/glossary.md and README.md to the broad Subtract part 3g/7 sweep; this part changes only the merge-gate prose and bindings.

**Files touched.** docs/how-it-works.md docs/invariants.md test/invariants-doc.test.ts

**Acceptance criteria.**
- `grep -rniE 'merge-verify|merge-batch|verify stage|parallel approval|approved, waiting to merge' docs/how-it-works.md docs/invariants.md` prints nothing.
- Every docs/invariants.md binding that describes the pre-merge gate names `src/merge/merge-core.ts` and a test that still exists; the invariants-doc test is green.
- The docs say a queued change waits for the one merge task, is gated with the diff rules and the declared gate command, and merges by rebase and fast-forward under the merge lock.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts whole, then the project's gate.

### Subtract, part 3d/7: `tumwater queue`, its cancel/top keys and the browser queue controls go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract verify collapse part 4/5 landed; touches src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts)

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

### `gateBuildPrecheck`'s complexity-42 failure-attribution body in src/review/review-precheck.ts is split into named module-private steps — `retriedGateOutcome`, `unverifiedSleepResult`, `knownFailureResult`, `mainVerdictForFailure`, `namelessFailureResult`, `namedFailureResult` and `rejectionReasons` — so "what does a failed check re-run, and when does the re-run change the verdict?", "when does a host sleep leave the tree unverified?", "which failures go on to review as main's?", "what does main's tip say about the named tests?" and "when is the change rejected instead?" are each read from a name instead of one ~200-line nested body (planned 2026-11-03 by the plan role; continues the landed split-large-function family — the 2026-10-25 `piCredentialValues` and 2026-10-28 `secretLeakReason` splits each extracted one named helper per on-disk source or arm the same way, and the in-flight `detachedDocFindings` split takes its own file; the eslint one-shot over this file reports `gateBuildPrecheck` at 42 while the file's next-highest body is `staleBaseFailures` at 10 and `attributeOnRedMain` at 2; independent in file of every `## Planned` entry — before this entry `grep -c 'review-precheck' PLANS.md`, `grep -c 'gateBuildPrecheck' PLANS.md` and the same for BUGS.md all print 0, so no waiting heading or touches list names this module or the symbol (the in-flight `Hourly full check part 1b/4` takes src/review/review.ts and the merge/runner modules, never review-precheck.ts; the blocked `Subtract` and `Every commit is verified on main` parts name src/review/review.ts where they touch review at all, and the in-flight `detachedDocFindings`, `prepareOrchestratorRun` and wall-clock plans take src/stage, src/orchestrator and test/test-runner.ts); PLANS-DONE.md's 2026-11-02 `Hourly gate restore` entry restored this function's run, flake re-run and outcome plumbing from the withdrawn Subtract part's parent, and no finished heading splits `gateBuildPrecheck` itself (`grep -cE '^### .*gateBuildPrecheck' PLANS-DONE.md` prints 0); docs/invariants.md's INV-CY1 and INV-CZ1 bind `gateBuildPrecheck` and `attributeOnRedMain` for the very attribution rules this move keeps verbatim, so a behavior-preserving private move leaves both sections unchanged; touches src/review/review-precheck.ts)

**Goal.** `gateBuildPrecheck`'s ~200-line failure path currently answers five questions in one nested body: whether a first failure is re-run, when a retry or host sleep changes the verdict, when a failure is main's or a known flake rather than the change's, what main's tip says about the named tests, and when the change is rejected through the shared `reject` path. Lift each into a named module-private step so `gateBuildPrecheck` reads as the sequence — run, settle the retry, stop on an unverified sleep, return a pass, classify known failures, ask main's tip, then reject or hand to review — while every awaited call, warning string, event and return shape stays exactly as it is.

**Approach.** All edits in src/review/review-precheck.ts; move code, do not rewrite it, and keep every `//` and `/** */` comment with the block it annotates. Add a module-private `type GateCheckRun = NonNullable<Awaited<ReturnType<typeof runScopedBuildCheck>>>` (the pre-check result: `{ check, outcome }`). Keep the local `runGateCheck` closure in `gateBuildPrecheck` because it captures `ctx`.
- `retriedGateOutcome(root, role, first: GateCheckRun, runGateCheck: () => Promise<GateCheckRun | null>): Promise<GateCheckRun["outcome"]>` holds today's failed-check retry: `onlyKnownMainFailures` skips the re-run; a passing retry emits the same unverified-sleep warning or `FLAKY_WARNING_PREFIX` warning plus `quarantineTests`, then returns the retry outcome; a failing retry returns its outcome; otherwise the first outcome.
- `unverifiedSleepResult(root, role, outcome: GateCheckRun["outcome"]): GatePrecheckResult | null` holds the `unverifiedTreeOutcome` branch: the same `sleptPhrase("gate check", …, UNVERIFIED_TREE)` detail and `warnEventBestEffort`, returning the same `{ decision: "failed", detail, unverified: true }` result; null when the outcome is not an unverified failure.
- `knownFailureResult(root, role, check: GateCheckRun["check"], outcome: GateCheckRun["outcome"]): GatePrecheckResult | null` holds the `onlyKnownMainFailures` warning/return and the `redCheckHeadline` + `isKnownFlake` warning/`{}` return, in that order; null when neither arm fires.
- `async mainVerdictForFailure(ctx: ReviewContext, failed: { tests: string[]; files: Record<string, string> | undefined })` holds the nameless-versus-named main-tip query and the red-unnamed `rerunAtMainTip` fallback, returning the same main verdict.
- `async namelessFailureResult(root, role, main, reasons: string[], reject)` holds the `failed.tests.length === 0` branch: green tip rejects with `reasons`, red tip warns and returns `{}`, and an unavailable verdict rejects with the same appended "main's baseline was unavailable (…)" reason.
- `async namedFailureResult(ctx, head, failed, outcome, main, reasons: string[], reject)` holds the named-failure branch: `attributeOnRedMain` and its main-only warning/`knownMainFailures`, the `staleBaseFailures` check and its warning/`knownMainFailures`, and the final reject through `rejectionReasons`.
- `rejectionReasons(reasons: string[], main, own: readonly string[] | undefined): string[]` holds the three-arm final reason expansion — `reasons` on a green main, `reasons` plus `mainRedNotTheseFailures(main.sha, own ?? [])` on a red main, and `reasons` plus the baseline-unavailable sentence otherwise — with the same text and order.
- `gateBuildPrecheck` keeps its signature, doc comment, module-private `GatePrecheckResult` shape and export scope, and its body becomes: `setMergeStage`; define `runGateCheck`; await the first run and return the same aborted result for an aborted skip; settle the retry; return the unverified-sleep result; return `{ verifiedHead: head }` on a pass; classify known failures; return the same aborted result when the signal fired; build `failed = { tests: namedFailures(outcome), files: outcome.failingTestFiles }` and `reasons`; ask `mainVerdictForFailure`; return the same aborted result again; then dispatch to `namelessFailureResult` or `namedFailureResult`.

**Files touched.** src/review/review-precheck.ts

**Acceptance criteria.**
- The export surface is unchanged: `grep -n '^export ' src/review/review-precheck.ts` still matches only `export async function gateBuildPrecheck`.
- `npx --no-install eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/review/review-precheck.ts` reports `gateBuildPrecheck` at 5 or below, `retriedGateOutcome` and `namelessFailureResult` at 8 or below, `knownFailureResult` and `rejectionReasons` at 6 or below, `mainVerdictForFailure` and `namedFailureResult` at 12 or below, `unverifiedSleepResult` at 3 or below, and no function in the file above 12 (`staleBaseFailures` stays at 10).
- An abort during the first check, after the retry, and around the main-tip query still returns `{ resolved: { decision: "failed", aborted: true } }` without a warning or a `reject` call, as test/review-precheck-closed.test.ts pins.
- A first failure that passes the re-run still warns the same flake (or host-sleep) wording, quarantines the named tests, and returns `{ verifiedHead: head }`; a twice-failed check that spans a host sleep still returns the same `detail` with `unverified: true` and keeps the commit.
- A check naming only main's known failures still returns `knownMainFailures` with the same warning, a known-flake headline still returns `{}` with the same warning, a nameless failure still rejects on a green main and on an unavailable baseline but warns and goes on to review on a red main, and a named failure on a red main still excuses only main's tests — returning `knownMainFailures` for those and rejecting the others with `mainRedNotTheseFailures` appended.
- A failure whose tests its base already failed and whose main tip is green or red still returns the same `knownMainFailures` list (the change's tests on a red main, the base's tests otherwise) with the same warning.
- No edit lands outside src/review/review-precheck.ts; docs/invariants.md, README.md and the test files are unchanged because INV-CY1 and INV-CZ1's attribution behavior is preserved.

**Tests.** No new test module: the move is behavior-preserving. Build, then run `node dist/test/test-runner.js review-precheck review-precheck-closed review-precheck-flake review-precheck-green review-precheck-main-tip review-precheck-verdict review-precheck-watch` through the project's runner and confirm green. If a warning, reason order, main-tip call or return value changes, a helper was wired out of the original sequence; fix the helper, do not edit a test.

### `tumwater questions` gains `-f/--follow` on both list forms, repainting the open or answered outbox until Ctrl+C or its parent exits, so an operator watching QUESTIONS.md sees a question appear or an answer land without rerunning the command (planned 2026-11-03 by the plan role; continues the landed follow-view family — `status`, `report`, `logs`, `history`, `queue`, `reviews`, `quarantine`, `backlog` and `diff` all follow through `followView` in src/cli/follow-view.ts, and `questions` is the remaining list command with no live form; independent in file of every `## Planned` entry — before this entry, `awk '/^## Planned/,/^## Done/' PLANS.md | grep -c 'cli-question-commands'` and the same for `questions --follow` both print 0, and no waiting heading or touches list names src/cli/cli-question-commands.ts or the `cmdQuestions` body (the in-flight splits take src/review/review-precheck.ts, src/agent/agent-run.ts, src/stage, src/orchestrator and test/report-data.ts plus test/status-model.test.ts; the blocked `Hourly full check`, `Subtract` and `Every commit is verified on main` parts name src/merge, src/runner, src/status, src/doctor, src/config, src/baseline, src/review, src/run, src/ui, src/gui, src/roles and src/orchestrator modules, never this command); PLANS-DONE.md records the `backlog -f`, `reviews -f` and `quarantine -f` additions but `grep -cE '^###.*questions.*follow|^###.*follow.*questions' PLANS-DONE.md` prints 0; docs/invariants.md names no symbol of the command (`grep -c 'cmdQuestions' docs/invariants.md` prints 0), so its bindings stay unchanged; the blocked `Subtract` parts share docs/cli.md and src/cli/help.ts in different rows and lines, so whichever lands second rebases there; touches src/cli/cli-question-commands.ts src/cli/help.ts docs/cli.md test/cli-questions-follow.test.ts test/cli-questions-strictness.test.ts)

**Goal.** `tumwater questions` prints the open outbox once, and `tumwater questions --answered` prints the newest answers once. Both are the human-decision surface: an operator asks a question in the dashboards and later reruns the CLI to see whether a role answered, while every other read-only command (`status`, `report`, `logs`, `history`, `queue`, `reviews`, `quarantine`, `backlog`, `diff`) has a `-f/--follow` live form. Add the same follow to both question list forms, reusing `followView`, so an answer landing in QUESTIONS.md or a new question arriving appears in the next frame; leave the one-shot text and JSON output, `--grep`, `--show` and `questions answer` unchanged.

**Approach.** All edits in src/cli/cli-question-commands.ts, its help text and docs; no `src/backlog` change (the readers already re-read QUESTIONS.md per call).
- `QuestionsInvocation`/`QuestionsScan` gain a `followFlag: boolean`. In `readPreNumberFlag`, recognize `-f`/`--follow` from `FOLLOW_FLAG.names` while `!scan.numbered` (the same position rule as `--answered`/`--grep`), refuse a repeat with `rejectRepeatFlag`, and return the consumed index. Past the question's number positional the token stays prose, so `questions answer 1 -f` still records `-f` as decision text.
- `readAnywhereFlag`'s unknown-`--` gate adds `FOLLOW_FLAG` to its `rejectEqualsForm` list and `-f/--follow` to the valid-flag `spellings` it prints with the typo hint.
- `cmdQuestions` takes an optional `seams: FollowViewSeams = {}` third parameter (the `cmdBacklog`/`cmdStatus` shape; src/cli.ts's two-argument call is unchanged). After `refuseTeamWorkspace`, refuse a follow combined with `--json` (the sibling commands' "prints one document; -f/--follow repaints a live view" wording), with `--show`, and with any subcommand words (the answer form writes one change), naming the conflict and exiting 1 before any output.
- The two list branches route through `followView`: the open list frames on `() => openQuestionList(root, inv.grep)` and the answered list on `() => answeredQuestionList(root, inv.limit ?? 10, inv.grep)`, so each repaint re-reads QUESTIONS.md and reads the clock per frame as the other follow views do. The one-shot branches keep calling `sayQuestionList`/`sayAnsweredQuestions` exactly as today.
- src/cli/help.ts's two questions list rows gain `[-f/--follow]` and one follow clause (repaints until Ctrl+C or the parent exits; composes with `--grep`; refuses `--json`, `--show` and the answer form). docs/cli.md's "Answer open questions" row gains the same flag and clause on both list forms.

**Files touched.** src/cli/cli-question-commands.ts src/cli/help.ts docs/cli.md test/cli-questions-follow.test.ts test/cli-questions-strictness.test.ts

**Acceptance criteria.**
- `tumwater questions -f` and `tumwater questions --follow` repaint the numbered open list every couple of seconds until Ctrl+C or the process that started them exits; a question answered by another process between frames is absent from the next frame. `tumwater questions --answered -f` does the same for the answered list, and a newly answered entry appears in the next frame.
- `-f`/`--follow` composes with `--grep` and `--answered -n`, each frame showing only the matching or limited rows under the unfiltered numbering; the pattern `-f` after `--grep` is text, not a follow flag.
- A follow combined with `--json`, `--show`, or `answer` exits 1 with a message naming the conflict and prints no frame, clear-screen escape or JSON document.
- Without a follow flag, `tumwater questions`, `questions --json`, `questions --answered`, `questions --answered --grep` and `questions --show` print exactly the text or JSON they print today.
- `grep -n 'tumwater questions \[-f/--follow\]\|tumwater questions --answered \[-f/--follow' src/cli/help.ts docs/cli.md` finds both list rows in each file.
- `npm run test:gate` passes.

**Tests.** New test/cli-questions-follow.test.ts, modelled on test/cli-backlog-follow.test.ts: drive the command in-process with `FollowViewSeams` and node:test's mocked `setInterval`, proving the first frame, two repainted frames, a QUESTIONS.md edit visible between ticks, the parent-death exit, the TTY clear-screen versus piped blank-line shape, and the three refused combinations. test/cli-questions-strictness.test.ts updates its valid-flag list and typo-hint expectation to include `-f/--follow`. Run those files and the gate.

## Done
