# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Subtract, part 4/6: One runner per role — the instance claims and the worktree pool go (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 4, and its measurement gate; requires Subtract part 3g/7 landed; touches src/config/config-schema.ts src/config/config.ts src/config/config-validation.ts src/roles/runner-ids.ts src/scheduling/claims.ts src/scheduling/claim-entries.ts src/backlog/backlog-index.ts src/git/worktree-pool.ts src/git/worktree-pool-startup.ts src/git/slots-state.ts src/git/worktree-use.ts src/git/slot-salvage.ts src/doctor/doctor-contention-checks.ts src/ui/status-payload.ts docs/config.md test/worktree-pool.test.ts test/retention.test.ts)

**Needs review 2026-10-31 by the director:** the 2026-10-31 request to expose feature and bugfix concurrency under Settings keeps the `roles.<role>.instances` mechanism — its runners, claims and multiple worktrees — that this part deletes; re-plan only the worktree-pool work that can land without removing that instance mechanism, or withdraw this part.

**Goal.** One runner id per role and one persistent checkout per role. `instances`, the instance claims and the slot pool existed to keep a role authoring while its own change merged (fast-merge measured 60% of role time waiting); with landing in minutes that wait is not the constraint, and the pool's own costs — slot waits, pins, stale claims, salvage — go with it.

**Approach.**
- **Measure first, and record it.** Before changing code, read the day report and the log for the week after Subtract parts 3a/7–3g/7 landed: end-of-run → on main p50/mean/p90 (`merge_done`), `slot_wait` count and total, and red-main minutes (`main_check`/`main_red_hold`). If p90 is at or under ~15 minutes with one runner per role, proceed; if not, hold this part with a `**Needs review …**` note quoting the numbers instead of deleting capacity on a prediction.
- Delete the `instances` key (config-schema.ts, config.ts, docs/config.md) and `INSTANCE_ROLES`; `runnerIds` (src/roles/runner-ids.ts) returns the configured roles, one runner each.
- Delete the claims (src/scheduling/claims.ts, src/scheduling/claim-entries.ts) and their readers (backlog-index.ts's live-claim marks, status-payload.ts's instance pool, the `parallel instances` doctor row); a role claims an entry by working on it in the run that picked it up.
- Delete the pool (src/git/worktree-pool.ts, worktree-pool-startup.ts, slots-state.ts, worktree-use.ts, slot-salvage.ts) and the `slot_wait` event; a role keeps one worktree through src/git/worktree.ts's ensureWorktree, which already self-heals a dead registration.
- Delete the pool rows and their inputs: doctor's `workspaces` (pool half), `parallel instances`, `tumwater pins`' pool wording, and `slotCount`.

**Files touched.** src/config/config-schema.ts src/config/config.ts src/config/config-validation.ts src/roles/runner-ids.ts src/scheduling/claims.ts src/scheduling/claim-entries.ts src/backlog/backlog-index.ts src/git/worktree-pool.ts src/git/worktree-pool-startup.ts src/git/slots-state.ts src/git/worktree-use.ts src/git/slot-salvage.ts src/doctor/doctor-contention-checks.ts src/doctor/doctor-check-names.ts src/ui/status-payload.ts docs/config.md docs/how-it-works.md test/worktree-pool.test.ts test/retention.test.ts

**Acceptance criteria.**
- One runner id per configured role; `tumwater status --json` carries no instance-pool or slot fields, and a run leases no slot.
- `tumwater.json` with `instances` set is refused by validation naming the deleted key (the same treatment the other deleted keys get in parts 5a/6–5h/6), not silently ignored.
- The measured p90 end-of-run → on main from the gate above is quoted in the part's PLANS-DONE entry, so the deletion's premise is on the record.
- `npm run test:gate` passes.

### Subtract, part 6/6: The sweep — the rows, keys and docs the five parts left behind (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes" and "How we will know it worked"; requires Subtract part 1e/6, Subtract part 4/6, Subtract part 5v/6 and Subtract part 5x/6 landed, the ends of every remaining Subtract chain — a clause the operator added 2026-10-28 after feature refused this part for running ahead of them, re-pointed from part 5q/6 to part 5d/6 the same day when the user withdrew the budget-fallback removal and the tier map; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts)

**Goal.** The deletion reads as one system. Every name parts 1/6–5/6 removed is gone from the live docs, the example config, the doctor's row list, the alerts and the tests that assert them; the archive keeps the record.

**Approach.**
- Sweep the deleted names out of the live prose and the example config: `instances`, `slotCount`, `slot_wait`, `check_wait`, `maxConcurrentChecks`, `mergeBatchMax`, `mergeCommand`, `review.afterMerge`, `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `slot salvage`, `merge queue`, `interlock`, `held-for-operator`, `Needs replan`, `Waiting for the next failure`, `(held N)`.
- Delete the rows and tests rather than re-pointing them: a case whose whole subject is a deleted mechanism goes (the existing wording/implementation tests rule: never re-pin), and test/doctor-checks.test.ts's row list, test/event-format.test.ts's deleted event types (`slot_wait`, `check_wait`, the merge-stage events), test/retention.test.ts's pool artifacts and test/config.test.ts's deleted keys are updated to the surviving row/key set.
- Re-check the parts 1a–1e/6 rule end to end: for every condition that used to have a banner and no longer does, the doctor row exists; for every row this series deleted, the mechanism is gone.
- docs/invariants.md drops or re-scopes the invariants of deleted subsystems (merge-slot, pool, permit, instance claims, provider caps, subscription-window holds) in the same commit, per the standing rule; the tiers, the budget fallback and the image reroute stay (user, 2026-10-28), so their invariants stay too, and so does the subscription usage-window display (`subscriptionWindows`, the window badge and spend card — user, 2026-10-30, plans/subtract.md stroke 5).
- Record in the part's PLANS-DONE entry: the doctor row count and the config key count before and after the series, and the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts PLANS.md test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts

**Acceptance criteria.**
- `grep -rnE 'maxConcurrentChecks|maxConcurrentPerProvider|mergeBatchMax|mergeCommand|instances|slot_wait|check_wait|claudeWindowReserve|review\.afterMerge|held-for-operator' src/ docs/ README.md DEVELOPMENT.md tumwater.example.json` finds no live reference (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every doctor row name in doctor-check-names.ts resolves to a check that reads a mechanism that still exists; no row reports a path nothing writes.
- The before/after row and key counts, and the deletions' measurement premise, are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

### Every commit is verified on main, part 4j/3: the `main_red` run-result verdict is removed from the status, doctor, UI and report surfaces (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires part 3f/3 landed, so no merge produces the verdict; touches src/ui/tone.ts src/events/event-labels.ts src/ui/gui/gui-client-model.ts src/failure/failure-data.ts src/failure/failure-time-spend.ts src/failure/failure-render.ts src/cli/cli-start-summary.ts src/status/status-polls.ts src/ui/status-model.ts src/doctor/doctor-holds.ts src/inbox/pending-prompt.ts src/review/review.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/runner/runner-state.ts src/budget/fallback-breaker.ts src/events/event-notify.ts src/baseline/main-red.ts test/attribute-red-check.test.ts test/budget.test.ts test/doctor-holds.test.ts test/failure-render.test.ts test/failure-time-spend.test.ts test/gui-client.test.ts test/status-model.test.ts test/status-render-cells.test.ts test/status-render.test.ts test/team-alerts.test.ts)

**Goal.** With part 3f/3 removing every merge that could produce a `main_red` run result, the surfaces that read or render it describe a state that cannot occur. Delete them, leaving the `RunResult` member for part 4k/3 to remove last, so this part can merge on its own without a compile-forced sweep of the run/runner plumbing.

**Approach.**
- Remove the verdict from the display tables: `resultTone`'s `case "main_red"` and `"main_red"` in `PROBLEM_RESULTS` (src/ui/tone.ts), `main_red: "main's check is failing"` from `RUN_RESULT_LABELS` (src/events/event-labels.ts), `main_red: "red"` from the dashboard's `RESULT_TONES` (src/ui/gui/gui-client-model.ts), `main_red: 9` from `RESULT_ORDER` (src/failure/failure-render.ts), `"main_red"` from `CLUSTERED_RESULTS` (src/failure/failure-time-spend.ts), the `ev.result === "main_red"` clause (src/failure/failure-data.ts) and `"main_red"` from the start-summary list (src/cli/cli-start-summary.ts).
- Delete the status/doctor readers: `heldByMainRed` and `mainCheckRecovered` (src/status/status-polls.ts), the `main red` label branch and its import (`src/ui/status-model.ts`), and the held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`). The unheld red-main warning (`redMainWarning`) and the `main_red_hold` event machinery stay.
- The `RunResult` member `main_red` (`src/run/run-outcome.ts`) stays, as do `runner-recovery.ts`'s producer and the run/runner/review plumbing — part 4k/3 removes them.
- Refresh comments that name the verdict as a live status: `src/ui/status-model.ts`, `src/inbox/pending-prompt.ts`, `src/review/review.ts`, `src/run/run-finalize.ts`, `src/run/run-prompt.ts`, `src/orchestrator/orchestrator-poll.ts`, `src/merge/merge-verify.ts`, `src/merge/merge-queue.ts`, `src/runner/runner-state.ts`, `src/budget/fallback-breaker.ts`, `src/events/event-notify.ts`, `src/baseline/main-red.ts`.

**Files touched.** src/ui/tone.ts src/events/event-labels.ts src/ui/gui/gui-client-model.ts src/failure/failure-data.ts src/failure/failure-time-spend.ts src/failure/failure-render.ts src/cli/cli-start-summary.ts src/status/status-polls.ts src/ui/status-model.ts src/doctor/doctor-holds.ts src/inbox/pending-prompt.ts src/review/review.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/runner/runner-state.ts src/budget/fallback-breaker.ts src/events/event-notify.ts src/baseline/main-red.ts test/attribute-red-check.test.ts test/budget.test.ts test/doctor-holds.test.ts test/failure-render.test.ts test/failure-time-spend.test.ts test/gui-client.test.ts test/status-model.test.ts test/status-render-cells.test.ts test/status-render.test.ts test/team-alerts.test.ts

**Acceptance criteria.**
- No status, doctor, UI, failure or CLI surface reads or renders the `main_red` verdict: `heldByMainRed` and `mainCheckRecovered` are gone, and `grep -rnE '\bmain_red\b' src/ui src/status src/doctor src/failure src/cli src/events src/inbox src/budget` finds no verdict reference (`main_red_hold` still matches nothing under `\bmain_red\b` and stays).
- The `RunResult` member `main_red` still exists (part 4k/3 removes it), so the tree compiles without the run/runner sweep.
- `npm run test:gate` passes.

**Tests.**
- test/doctor-holds.test.ts / test/status-model.test.ts / test/status-render.test.ts / test/status-render-cells.test.ts / test/team-alerts.test.ts: the held-by-main-red cases go; the unheld red-main warning cases stay.
- test/attribute-red-check.test.ts / test/budget.test.ts / test/failure-render.test.ts / test/failure-time-spend.test.ts / test/gui-client.test.ts: the `main_red` rows/labels/tone cases go; the surviving result cases stay.

### Every commit is verified on main, part 4k/3: the `main_red` union member and the run/runner plumbing that names it are removed (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires part 4j/3 landed, so no surface still reads the verdict; touches src/run/run-outcome.ts src/runner/runner-recovery.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts)

**Goal.** The `main_red` run result no longer has a producer (part 3f/3) or a reader (part 4j/3), so the union member itself is dead vocabulary. Remove it and let the compiler name any site still constructing or narrowing it.

**Approach.**
- Remove `| "main_red"` and its doc comment from `RunResult` (src/run/run-outcome.ts). Deleting the member makes every remaining construction or `result === "main_red"` narrowing a compile error, which is the work list.
- Remove the last producer: `runner-recovery.ts`'s recovered-`main_red` return, now that part 3f/3 deleted the `main_red_wait` leftover it served. Fix any surviving switch/type-narrowing the compiler flags (run-apply, run-finalize and the run prompt), keeping each site's non-`main_red` behavior.
- Refresh the comments that still name the verdict as a live outcome in `src/runner/runner-state.ts`, `src/runner/runner-recovery.ts`, `src/run/run-finalize.ts`, `src/run/run-prompt.ts`, `src/orchestrator/orchestrator-poll.ts`, `src/events/event-notify.ts`, `src/inbox/pending-prompt.ts`, `src/review/review.ts`, `src/merge/merge-verify.ts`, `src/merge/merge-queue.ts`, `src/budget/fallback-breaker.ts` and `src/baseline/main-red.ts`.

**Files touched.** src/run/run-outcome.ts src/runner/runner-recovery.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts

**Acceptance criteria.**
- `RunResult` has no `main_red` member, and `grep -rnE '\bmain_red\b' src/` prints nothing (the `main_red_hold` event and its machinery stay; `\bmain_red\b` does not match `main_red_hold`).
- No code path returns or narrows on a `main_red` run result; the compiler is clean.
- `npm run test:gate` passes.

**Tests.**
- test/run-outcome.test.ts: the `main_red` membership case goes; the surviving `RunResult` cases stay.
- test/runner-recovery.test.ts / test/runner-red-main.test.ts: the recovered-`main_red` cases go; the surviving recovery cases stay.
- test/run-apply.test.ts / test/run-finalize.test.ts / test/merge-pipeline-2.test.ts / test/merger.test.ts: drop the `main_red` assertions; the surviving cases stay.

_None yet._

### `eventMessage`'s complexity-85 flat dispatch switch in src/events/event-format.ts becomes an `EVENT_MESSAGE_FAMILY` lookup table typed by the event union, so every event type's family is data the compiler checks instead of one hand-listed `case` per type (planned 2026-10-30 by the plan role; continues the landed data-table conversion family — the 2026-10-29 `describeStateChange` plan turned its 36-case switch into `STATE_CHANGE_FAMILY`, typed `Record<HarnessEvent["type"], …>` and read with a fallback (src/failure/failure-state-change.ts), and this applies the identical pattern to the event dispatcher whose per-family builders the landed `eventMessage` split already extracted; independent in file of every `## Planned` entry — `grep -n 'event-format' PLANS.md` names only the blocked `Subtract part 6/6` heading's touch list (`test/event-format.test.ts`, never the source module), `grep -n 'eventMessage\|EVENT_MESSAGE_FAMILY' PLANS.md` prints nothing before this entry, and the blocked `Every commit is verified on main` parts 4j/3 and 4k/3 edit `src/events/event-labels.ts` and `src/events/event-notify.ts` rather than this module, so no open heading or touches list names `src/events/event-format.ts`; the archived `eventMessage` headings in PLANS-DONE.md are the per-family builder split, never a lookup-table conversion (`grep -c 'EVENT_MESSAGE_FAMILY' PLANS-DONE.md` prints 0); docs/invariants.md binds this file only through `eventFeedItem`, `eventMatchesGrep` and specific event lines, naming neither `eventMessage` nor its dispatch body, so a behavior-preserving conversion leaves every binding intact; touches src/events/event-format.ts)

**Goal.** `eventMessage` is the one event-to-line dispatcher behind the CLI, TUI and GUI. Its body is a single switch with one `case` per event type (about eighty labels) grouped into eleven family builders (`runEventMessage`, `mergeEventMessage`, `reviewEventMessage`, `inboxEventMessage`, `budgetEventMessage`, `holdEventMessage`, `resourceEventMessage`, `configEventMessage`, `imageRestartEventMessage`, `checkWaitEventMessage`, `warningEventMessage`) and a `default` that renders an unknown type. The label list duplicates the `HarnessEvent["type"]` union by hand, the eslint one-shot reports the function at complexity 85, and a newly added event type is routed only if someone remembers to add a `case` — the union and the dispatch can drift. Make the type-to-family routing data in one table typed by the union, so adding a type without routing it is a compile error and `eventMessage` itself is a lookup plus the existing fallback.

**Approach.** All edits in src/events/event-format.ts; no builder's wording or body changes.
- Add a module-private family type beside the builders, e.g. `type EventMessageFamily = (e: HarnessEvent) => string`.
- Add `const EVENT_MESSAGE_FAMILY: Record<HarnessEvent["type"], EventMessageFamily>` above `eventMessage`, with one key per event type — exactly the case labels the switch lists today — each mapped to the same family builder it calls today, grouped and commented by family the way `STATE_CHANGE_FAMILY` groups its keys. The `Record` over the union is the exhaustiveness check: a union member without a key is a type error.
- Replace the switch in `eventMessage` with the table lookup and keep the existing default behavior: an unknown or torn type (the union is not a runtime guarantee — `parseEventLine` admits any JSON object) reads `textOr(e.type)`, so a typeless event still renders `?` rather than `undefined`. Use an own-property guard or an equivalent runtime check so an unrecognized type reaches the fallback instead of throwing.
- Rewrite `eventMessage`'s doc comment to say the table is the dispatch and keep naming the family builders; keep every builder and every other export (`formatEvent`, `eventFeedItem`, `eventMatchesGrep`) unchanged.

**Files touched.** src/events/event-format.ts

**Acceptance criteria.**
- `eventMessage` returns the identical line for every event type — no family builder, label or word changes — and an unknown/typeless event still renders `textOr(e.type)` (the existing torn-event cases).
- `EVENT_MESSAGE_FAMILY` is typed `Record<HarnessEvent["type"], …>`, every key the removed switch listed maps to the same builder, and a union member without a table key fails the compile (the case list no longer lives in the function).
- The complexity falls: the eslint one-shot (`npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs 'src/events/event-format.ts'`) no longer reports `eventMessage` at 85; the family builders report the small values they do today.
- No edit lands outside src/events/event-format.ts; docs/invariants.md is untouched because it names `eventFeedItem`/`eventMatchesGrep`, not this dispatch.
- `npm run test:gate` passes.

**Tests.** No new test module: a behavior-preserving conversion guarded by the existing suite. test/event-format.test.ts's "eventMessage gives every event type its own line, never the bare code" iterates `EVENT_TYPE_LABELS`' keys and asserts none renders as its bare code, so it covers every table key; its torn-event case pins the unknown/typeless fallback. Run test/event-format.test.ts and test/event-format-team.test.ts whole, then the project's gate, and confirm green.


### Subtract, part 3a/7: The scheduler stops interlocking a role on its queued merge (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6 into seven independently mergeable parts; design in plans/subtract.md "The six strokes", stroke 3; requires Every commit is verified on main part 3f/3 landed; touches src/orchestrator/orchestrator-poll.ts src/scheduling/skip.ts src/scheduling/scope.ts src/scheduling/claims.ts src/gates/gate-polls.ts src/status/status-polls.ts docs/how-it-works.md test/claims.test.ts test/orchestrator-scheduling.test.ts test/gate-polls.test.ts test/status-polls.test.ts)

**Goal.** A role whose change is queued or pinned is admitted for its next run, so landing never holds authoring. Today `queuedRoles` (from `queuedMergeRoles`) blocks that role in scheduling/skip.ts, scheduling/scope.ts, claims.ts and gate-polls.ts, and `mergeStartHeld`'s merge arm in orchestrator-poll.ts holds role starts while a merge is in flight. Remove that interlock; run-stage's `heldOnBranch` one-pin cap in src/run/run-stage.ts stays, so a role still cannot write a second pin while its first waits.

**Approach.**
- Delete the `queuedRoles` field and every `hasQueuedMerge`/`queuedRoles.has(...)` branch from `SchedulingScope` (scheduling/scope.ts) and scheduling/skip.ts; the merge queue remains a merge-side fact only.
- In claims.ts, stop excluding `queuedMergeRoles` from instance-claim candidates; keep every other admission rule.
- In gate-polls.ts and status-polls.ts, drop the queued-merge roles from their in-flight inputs while keeping their run/in-flight counts.
- In orchestrator-poll.ts, remove the merge half of `mergeStartHeld` (the `reviewHeld`/role arm), leaving the restart/disk `runStartHeld` gate and the post-review hold.
- docs/how-it-works.md's Scheduling section says a role authors while its previous change waits, and the queue is not a scheduling gate.

**Files touched.** src/orchestrator/orchestrator-poll.ts src/scheduling/skip.ts src/scheduling/scope.ts src/scheduling/claims.ts src/gates/gate-polls.ts src/status/status-polls.ts docs/how-it-works.md test/claims.test.ts test/orchestrator-scheduling.test.ts test/gate-polls.test.ts test/status-polls.test.ts

**Acceptance criteria.**
- A role with a queued or pinned change is a candidate in the scheduler and claims path on the next poll; `grep -rn 'hasQueuedMerge\|queuedRoles' src/orchestrator src/scheduling src/gates src/status` finds no scheduling/claim use.
- `mergeStartHeld` no longer takes a role's merge into account; the run start gate and the reviewer hold still do.
- A second commit by a role with a waiting pin still stays on the branch (`heldOnBranch` unchanged).
- The merge pipeline keeps draining queued changes; no merge behavior changes.
- `npm run test:gate` passes.

**Tests.** Update test/orchestrator-scheduling.test.ts (a queued role is admitted), test/claims.test.ts (a queued-merge role remains a claim candidate), test/gate-polls.test.ts and test/status-polls.test.ts (the queued-role input is gone; the surviving counts are unchanged). Run those files and the gate.

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

### Subtract, part 3c/7: The queue's verify stage collapses into the merge step (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3b/7 landed; touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/merge/merge-slot.ts docs/how-it-works.md docs/invariants.md test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts)

**Goal.** A queued entry goes straight from the queue to the merge step: no separate verify task, no `approved`/`verifying` map, no stage events. `drainMerge` takes the head entry, runs the deterministic diff-rule gate in the merge worktree, and calls `mergeApprovedChange`; a rejected entry is settled as today. The durable queue still orders entries and the pin still carries the commit.

**Approach.**
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts; move the tier constants still needed by merge-drain/merge-post-review-drain (`MERGE_TIER`, `resolveAuthor`) beside the drain.
- In merge-core.ts, keep `reviewPinnedChange`'s deterministic gate as a small `reviewQueuedChange(ctx, req, wt, state)` without the approval/stage bookkeeping; call it from `mergeApprovedChangeIn` before `mergeToMain`. A rejected result deletes the pin and returns `rejected`; a diff-rule approval proceeds to the merge.
- In merge-drain.ts, delete `drainMergeQueue`'s `drainVerify` leg and the `p.approved`/`p.verifying` handling; `drainMerge` starts the next queued entry directly. In merge-pipeline.ts, remove `verifying`/`approved` and their types; keep `InFlightMerge`, abort, guard and outcome plumbing. In merge-slot.ts, remove the verify stage records and `checkWaitStage`/`resolveWaitStage` hooks, keeping the merge in-flight marker the operator surfaces read.
- Keep `drainPostReviews` and the post-merge review path untouched.
- docs/how-it-works.md's Parallel approval and Merge sections describe the one-step drain; docs/invariants.md re-points the verify-stage bindings to the merge step.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/merge/merge-slot.ts docs/how-it-works.md docs/invariants.md test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start/approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential is rejected before it merges; every other queued diff merges without a second review.
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
- A fresh run that commits writes a pin and no `.tumwater/merge-queue/` file; its log path is still `merge_queued → merged` and its change reaches main without a second check.
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

**Goal.** The live prose and the invariant bindings describe the landing that exists after parts 3a–3f: a pin, a rebase under the merge lock, a fast-forward, and the main watch's post-landing check. No sentence promises queue stages, an approval step or a pre-merge check.

**Approach.**
- Sweep the queue vocabulary out of docs/how-it-works.md, docs/invariants.md and docs/glossary.md: merge queue, queue stage, verify/approval stage, batch/bisect (already gone), retry/requeue, queue depth and queue cancel/top.
- In docs/invariants.md, drop or re-scope every binding to a deleted module (`merge-queue`, `merge-verify`, `merge-batch`, `merge-slot` stages, `merge-requeue`) and state the surviving guarantees: one merge writer under one lock, linear history, a deleted pin on merge and a post-landing check per commit. Keep the conflict-hand-back and review-gate bindings that still have code.
- README's status line stays as is; remove any queue wording elsewhere in README.
- Re-check docs/invariants.md's file-to-test bindings: every remaining binding names a file and a test that still exist; the invariants-doc test enforces it.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts

**Acceptance criteria.**
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` finds no claim about a mechanism parts 3a–3f deleted (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every docs/invariants.md binding that names a merge module names a file and a test that still exist; deleted-module INVs are gone, not re-pointed.
- The surviving prose says: a change is pinned, merged by rebase and fast-forward under the merge lock, and checked on main after it lands.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/merge-backlog-conflicts.test.ts whole, then the project's gate, and confirm green.

### A post-merge review of a large diff reaches a verdict instead of timing out verdict-less — the reviewer's budget tracks the diff's size as well as host load (planned 2026-10-31 by the steward; promotion of the recurring `real-run-needed` validation gap — 38 Fixed entries carry the tag (BUGS.md + BUGS-FIXED.md), the dominant shape being "post-merge review of `<sha>` never reached a verdict", each citing the gap line "the post-merge review run never produced a verdict on the loaded host"; the cluster's own class entry, BUGS-FIXED.md "Post-merge reviews time out at the 900s ceiling as a class", names this as the review path's durable fix; the prior fix for the same class — `Option-2 isolation, part 2/2: the post-merge reviewer's budget stretches on a starved host` (PLANS-DONE.md, done 2026-10-29) — stretched the budget by host load only and did NOT retire the gap: the largest-diff member, `3b682bed` (BUGS-FIXED.md, "timed out after 900s, 21 times … even the 2×-capped budget stretch did not stop this large diff's verdict from timing out"), and the 10-30 members `6407b7d6`/`0f240b57`/`17a2ac4d`/`acf37eb2`/`bf04da3c`/`a3bdcf86` all timed out in the window that fix landed; independent in file of every `## Planned` entry — before this entry `grep -noE 'post-merge-review\.ts|config-views\.ts|build-check-events\.ts' PLANS.md` printed nothing, and the blocked `Subtract` and `Every commit is verified on main` parts touch src/merge, src/config, src/orchestrator, src/status, src/runner, src/doctor, src/budget, src/gates and src/review/review.ts, never these three modules; touches src/config/config-views.ts src/review/post-merge-review.ts src/build/build-check-events.ts docs/config.md test/config-views.test.ts test/post-merge-review.test.ts)

**Goal.** `reviewRunConfig` (src/config/config-views.ts) gives the post-merge reviewer a budget of `Math.min(cfg.runTimeoutSeconds, starvedDeadlineMs(baseMs, load())/1000)`, where `baseMs` is `review.timeoutSeconds ?? REVIEW_TIMEOUT_S` (900 s) and `starvedDeadlineMs` stretches by the host's load-to-cores ratio, capped at double the base. So the reviewer's wall is at most ~1800 s, and it depends on host load but NOT on how much diff the reviewer must read. A large diff — the `3b682bed` member moved ~239 lines; `6407b7d6`/`bf04da3c` are full-file folds — takes a strong-tier reviewer proportionally longer to reach its VERDICT, so even a progressing review dies at the 1800 s wall and the commit lands on main as "ordinary unreviewed backlog work". Scale the budget by the diff's size as well as its host load, so a progressing review of any realistic diff reaches its verdict, while a wedged one is still killed in a bounded wall.

**Approach.** One theme: the reviewer's budget tracks the review's actual cost (host load × diff size), not a fixed 2× cap.
- `src/build/build-check-events.ts`: add a diff-size term beside `starvedDeadlineMs` — e.g. `diffScaledMs(baseMs, diffBytes)` that scales `baseMs` by a factor of `diffBytes` against a reference diff size (the reviewer's own `DIFF_MAX_BYTES` cap, 200,000 bytes in src/git/git-diff.ts, is the natural reference: at or under it the factor is 1; above it it grows, capped at a small multiple such as the existing `STARVED_DEADLINE_MAX_FACTOR`). `starvedDeadlineMs` and its merge-scope caller are left untouched so the merge-scope check's behavior is byte-identical.
- `src/config/config-views.ts` `reviewRunConfig`: gain an optional `diffBytes` input (defaulting to 0 → factor 1, so every existing caller and the offline `load`-seam tests are unchanged) and stretch the term as `starvedDeadlineMs(baseMs, load()) * (diffScaledMs(baseMs, diffBytes) / baseMs)`, keeping the `Math.min(cfg.runTimeoutSeconds, …)` outer cap. Update the `REVIEW_TIMEOUT_S` and `reviewRunConfig` doc comments to say the budget now tracks diff size as well as load, and that a non-progressing run is still killed in a bounded wall.
- `src/review/post-merge-review.ts` `reviewMergedCommit`: it already reads the diff (`const diff = await git(wt, "diff", …)`); pass `diff.length` (bytes) into `reviewRunConfig` so the budget is computed from the actual reviewed diff.
- The watchdog's existing `extendOnProgress` one-extension path already distinguishes a progressing run from a hung one, so the diff-size term only buys wall for a progressing review; a wedged run is killed by the quiet watchdog as today. No change to the verdict-drop cap (`REVISION_BACKSTOP` / the no-verdict run count) — a verdict-less-by-timeout run still records its `review_start` and drops the commit after the cap, exactly as today.
- `docs/config.md`: in the `review.timeoutSeconds` row, say the reviewer's budget stretches with host load and with the reviewed diff's size (both bounded), so a large diff's progressing review is not killed at the 2× cap.

**Files touched.** src/config/config-views.ts src/review/post-merge-review.ts src/build/build-check-events.ts docs/config.md test/config-views.test.ts test/post-merge-review.test.ts

**Acceptance criteria.**
- A progressing review whose diff exceeds the reference size (`DIFF_MAX_BYTES`) is given a budget larger than the load-only 2×-capped stretch for the same load, while a quiet host with a small diff gives exactly today's value — the existing `Option-2 isolation, part 2/2` cases in test/config-views.test.ts (the `starvedDeadlineMs`/`load`-seam cases) pass unedited.
- A non-progressing (wedged) review is NOT given the diff-size extension: with no progress events the quiet watchdog kills it within the same bounded wall as today (asserted via the existing progress-extension seam in the test), so the diff term buys wall only while the run is progressing.
- The `3b682bed`-shaped diff (~517 insertions/deletions, the member that timed out 21×) is assigned a budget large enough for a progressing strong-tier review to reach its VERDICT — asserted offline through the injected `load` + `diffBytes` seam (matching the part-2/2 `load` seam), not a real run.
- `starvedDeadlineMs`'s merge-scope caller is unchanged and its existing tests pass unedited; `REVIEW_TIMEOUT_S` and `FALLBACK_REVIEW_TIMEOUT_S` are unchanged.
- `npm run test:gate` passes.

**Tests.** test/config-views.test.ts: a `reviewRunConfig` case with a diff larger than `DIFF_MAX_BYTES` and an injected high load asserts the budget is larger than the load-only stretch for the same load, and a case with `diffBytes` 0 (or a small diff) and a quiet load asserts the exact today value (the part-2/2 seam cases pass unedited). test/post-merge-review.test.ts: a `reviewMergedCommit` case with a large injected diff and a progressing-run seam asserts the reviewer run received the larger budget (the run's `runTimeoutSeconds`), and a wedged case asserts the budget did not grow. Run those two files whole, then the project's gate, and confirm green. The `real-run-needed` gap's own note (the reviewed commit was "checked by reading its diff against main instead") means the offline seam is the verification; a bounded real run is not required to confirm this change.

### The CLI's `main` command switch becomes a `COMMAND_HANDLERS` table keyed by command token, so each command's dispatch is one table row and `main` reads as the shared prelude, one lookup and the unknown-command fallback (planned 2026-10-31 by the plan role; continues the landed data-table conversion family — the 2026-10-29 `describeStateChange` plan turned its case switch into `STATE_CHANGE_FAMILY`, typed `Record<HarnessEvent["type"], …>` and read with a fallback (src/failure/failure-state-change.ts), and the in-flight `eventMessage` plan applies the same shape to `EVENT_MESSAGE_FAMILY`; `main` (src/cli.ts) is the largest remaining hand-listed dispatcher, an eslint one-shot complexity of 48 today, and every one of its arm bodies is already a one-line call to a `cmd…Case` helper or a lazy import, so the table moves no handler logic; independent in file of every `## Planned` entry — `grep -n 'src/cli\.ts' PLANS.md` prints nothing before this entry, `grep -c 'COMMAND_HANDLERS' PLANS.md PLANS-DONE.md` prints 0 and 0, and the open parts that name a `src/cli` path name `src/cli/cli-start-summary.ts`, `src/cli/cli-query-commands.ts`, `src/cli/help.ts` or `src/cli/completion.ts`, never `src/cli.ts`; PLANS-DONE.md records splits of other functions in `src/cli.ts` (`cmdDoctorCase`, `cmdReportCase`, `cmdRunDetail`) but no conversion of `main`'s dispatch (`grep -c 'COMMAND_HANDLERS' PLANS-DONE.md` prints 0); docs/invariants.md names no symbol in `src/cli.ts` (`grep -c 'src/cli\.ts' docs/invariants.md` prints 0), so a behavior-preserving move changes no pinned guarantee; touches src/cli.ts)

**Goal.** `main` (src/cli.ts) is the CLI's entry point: it runs the Node-floor gate, answers a `--help` topic, resolves the repo root, then dispatches the command token through a switch with 43 case labels plus the default. Every arm is already one line — a `cmd…Case` helper, or a lazy `await import(...)` of the command module — so the switch is routing data written as control flow, and a reader asking "which token reaches `cmdStatus`?", "which aliases share a body?" or "where did `tick` go?" scans all 43 labels. Its complexity is 48; the arms' bodies are not the reason. Make the routing one `COMMAND_HANDLERS` table so each command is one row and `main` holds the prelude, the lookup and the existing unknown-token fallback. No behavior change: the same token reaches the same helper with the same arguments, the lazy imports stay lazy, and the help text and every error wording stay byte-identical.

**Approach.** All edits in src/cli.ts; move each case body verbatim, keep each existing `//` comment with the arm it annotates, and add no import.
- Declare beside `main` a module-private `type CommandHandler = (root: string, command: string, args: string[]) => Promise<void>` and a `const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler>>` above it. One entry per token the switch lists today, in the switch's order: `init`, `start` and `run`, `tui`, `gui`, `status`, `config`, `report`, `doctor`, `logs`, `notify`, `history`, `tick`, `diff`, `queue`, `reviews`, `backlog`, `quarantine`, `archive`, `bug`, `plan`, `questions`, `brief`, `role`, `prompt`, `reset-counters`, `wake`, `abort`, `pause`, `resume`, `reclaim`, `restart`, `retire`, `revert`, `stop`, `completion`, `version`, `--version`, `-v`, `help`, `--help`, `-h`.
- Each value is the body that case runs today, moved verbatim: a bare `cmd…Case` where the case calls one, or an async arrow that performs the case's same lazy `await import(…)` and call. `start`/`run`, `version`/`--version`/`-v` and `help`/`--help`/`-h` map to the same function reference, so an alias pair cannot drift. The seven marker commands map to one arrow that awaits `import("./cli/cli-marker-commands.js")` and calls `runMarkerCommand(root, command, args)`, so each keeps its own token.
- Replace the switch in `main` with the table: keep the Node-floor gate, the `helpTopicForArgs` answer and the `root` resolution exactly as they are. When `command` is undefined, take the `help` row directly (today's `case undefined` arm); otherwise take `COMMAND_HANDLERS[command]` only when `Object.hasOwn(COMMAND_HANDLERS, command)` is true, so a prototype name such as `constructor` falls to the unknown-command path, and leave the existing `default` body — `suggestCommand(command)` plus the same `fail(...)` wording — as the else arm. Await the chosen handler with `command`.
- Rewrite `main`'s doc comment to say the table is the dispatch, that aliases are repeated keys and the marker commands share one arrow, and that a new command must add its row here and its usage stanza in help.ts.
- No other file changes: help.ts, docs/cli.md, docs/how-it-works.md and every command module stay untouched.

**Files touched.** src/cli.ts

**Acceptance criteria.**
- Every token the switch routes today routes through the table to the same helper or the same lazy import with the same `(root, args)`, and each alias group (`start`/`run`, `tick` -> `runTrailCommand`, `version`/`--version`/`-v`, `help`/`--help`/`-h`, `undefined` -> help) lands on the same handler it does today; the seven marker tokens still reach `runMarkerCommand` with their own token.
- `main` still runs the Node-floor gate and `helpTopicForArgs` before dispatch and still resolves `root` the same way, and an unknown token still exits through `fail` with today's exact `unknown command: "<token>"` / `didYouMean` wording — test/cli-help.test.ts's unknown-command, near-miss and `--help does not rescue an unknown command` cases pass unedited.
- The complexity falls: `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs 'src/cli.ts'` reports `main` at 10 or below (it reports 48 today), and reports no other function in the file higher than it does today.
- `grep -nE '^export ' src/cli.ts` matches today's exported lines (the file exports nothing new), and no `switch (command)` remains in `main`.
- No edit lands outside src/cli.ts; docs/invariants.md and src/cli/help.ts are unchanged.
- `npm run test:gate` passes.

**Tests.** No new test module: the conversion is behavior-preserving, and test/cli-help.test.ts already pins the dispatch's user-visible surface through the spawned CLI — the unknown-command failure and hint, the near-miss suggestion, `--help` not rescuing an unknown command, and the per-command help topics; test/help.test.ts pins the help listing itself and test/cli.test.ts drives the command routes. Run test/cli-help.test.ts, test/help.test.ts and test/cli.test.ts whole, then the project's gate, and confirm green. If a command-specific suite fails, the token's row is wrong; do not change a handler to make it pass.

### `assemblePayload`'s complexity-23 optional-spread assembly in src/roles/role-view.ts is split into one named partial builder per field concern — identity, agent seam, overrides, role config/detail and run history — so a reader asking "which fields describe this role's model seam?" finds them in one named function instead of scanning a 30-parameter object literal (planned 2026-10-31 by the plan role; continues the landed split-large-function family — the 2026-10-30 `rolePayload` plan made this same file's collector a thin sequence of named read helpers and left this final assembly as one literal, so this splits that remainder the same way; independent in file of every `## Planned` entry — `grep -c 'src/roles/role-view.ts\|assemblePayload' PLANS.md BUGS.md` prints 0 and 0, so no heading or touches list names the file or the symbol (the blocked `Subtract` part 4/6 names `src/roles/runner-ids.ts`, a different file, and the `Every commit is verified on main` parts name no src/roles path); PLANS-DONE.md records no split of `assemblePayload` itself (`grep -nE '^### .*assemblePayload' PLANS-DONE.md` prints nothing; its two `assemblePayload` mentions are the landed `rolePayload` split naming it as the assembly helper it introduced), and docs/invariants.md binds role-view.ts only through INV-BO3's symlink-guard reader calls, which sit in the read helpers and not in this literal-shaping code; touches src/roles/role-view.ts)

**Goal.** `rolePayload` now delegates its reads to named helpers, but ends by calling `assemblePayload` (src/roles/role-view.ts), a 30-parameter function whose whole body is one returned object literal. The eslint complexity one-shot reports it at 23 — the conditional spreads, not any decision, make it the largest function in the file — and the literal mixes identity, model-seam, override, config/detail and run-history facts, so "which fields belong to the seam?" or "which fields are optional and why?" is answered by scanning all of it. Split the literal into one named partial builder per field concern; no behavior change.

**Approach.** All edits in src/roles/role-view.ts; no exported name changes and no new import.
- Move the inline parameter type to a module-private `interface RolePayloadParts` above `assemblePayload`, with exactly today's fields and optionality; `assemblePayload(parts: RolePayloadParts)` takes it.
- Add five module-private builders, each taking `parts` and returning `Partial<RoleViewPayload>`, each carrying the inline comments that describe its fields, and each preserving the current field order, values and conditional spreads:
  - `identityFields(parts)` → `id`, `title`, `custom`, `enabled`, `paused`, `tier`, `modelTier`, the `...resolvedModelFields(...)` spread, and the `piDefault` conditional.
  - `seamFields(parts)` → `backend`, `fallback`, `fallbackFree`, the `account`/`billing`/`billingBackend` conditional, the `billingWindow` conditional, `chainStep`, and the `...roleImageInfo(...)` spread.
  - `overrideFields(parts)` → `minRunIntervalSeconds` and the five `minRunIntervalOverride`/`providerOverride`/`modelOverride`/`thinkingOverride`/`backendOverride` conditionals.
  - `roleFields(parts)` → the `instances` conditional, `instructions`, `find`, `notes`, `noteSavedAt`, the `flowCoverage` and `filings` conditionals, and `inboxCount`.
  - `runFields(parts)` → `contextWindow`, `nextPrompt`, the `...schedule` spread, and the `quietHours`/`recentOutcomes`/`usage`/`dailyCap`/`dailyCapHitAt` conditionals.
- `assemblePayload` returns one literal that spreads those five builders in today's key order: identity, seam, overrides, role fields, run fields. The builders only shape values already in `parts`; every read stays in `rolePayload`, so the single-load-per-source property the collector's doc comment states is untouched.

**Files touched.** src/roles/role-view.ts

**Acceptance criteria.**
- `rolePayload(root, typedRole, modelsPath = piModelsPath(), now = new Date())` and the exported `RoleViewPayload` interface are unchanged, and `grep -nE '^export ' src/roles/role-view.ts` matches today's exported lines (no new export).
- `assemblePayload`'s body is the five spreads in today's order; `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs 'src/roles/role-view.ts'` reports `assemblePayload` at 5 or below (it reports 23 today) and no new helper higher than today's 23.
- The payload is byte-identical: each field keeps its position, each conditional spread stays conditional (so an absent optional field still leaves no key), and every value comes from the same `parts` field as today. test/role-view.test.ts passes unedited, as do test/gui-endpoints.test.ts and test/gui-client-drawer.test.ts, which drive the same payload through the CLI and the drawer.
- No read is added or removed, so docs/invariants.md is unchanged and its INV-BO3 symlink-guard binding on role-view.ts still resolves to the same reader calls.
- No edit lands outside src/roles/role-view.ts.
- `npm run test:gate` passes.

**Tests.** No new test module: the split is behavior-preserving and the existing payload assertions are the regression net. Run test/role-view.test.ts, test/gui-endpoints.test.ts and test/gui-client-drawer.test.ts whole, then the project's gate, and confirm green. If a payload key moves or disappears, a builder's field order or guard is wrong; do not change a test to make it pass.

_None yet._

## Done
