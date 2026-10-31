# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Subtract, part 3/6: The merge queue becomes a lock and a fast-forward (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 3; requires Every commit is verified on main part 3f/3 landed; touches src/merge src/orchestrator/orchestrator-poll.ts src/orchestrator/orchestrator-scheduling.ts src/scheduling/skip.ts src/scheduling/scope.ts src/runner/runner-run.ts src/status/status-data.ts src/doctor/doctor-contention-checks.ts src/concurrency/check-permit.ts docs/how-it-works.md docs/invariants.md test/merger-restack.test.ts test/merge-backlog-conflicts.test.ts test/worktree-pool.test.ts)

**Goal.** A change lands as `pin → rebase onto main → fast-forward under the merge lock`. The queue, its stage machine, the coalesced batch check with its prefix bisect, the re-queue, the entry drop limits and the scheduling interlock are gone, because nothing about landing can fail any more: verification moved after the merge (part 3f/3), and a break is an ordinary open bug owned by the author.

**Approach.**
- Delete the queue and its stages: src/merge/merge-queue.ts, merge-queue-render.ts, merge-requeue.ts, merge-cancel.ts, merge-pipeline.ts, merge-slot.ts, merge-drain.ts, merge-batch.ts, merge-stack.ts, and the `.tumwater/merge-queue/` directory with its `uncommitted backlog`-style checks.
- `merge-core.ts` and `merge-to-main.ts` keep the pin read, the rebase, the merge lock and the fast-forward; the conflict-resolution pi run stays as the one non-deterministic step. `MERGE_CONFLICT_LIMIT` and the entry attempt/drop limits go: a conflict whose resolution fails comes back as a `**Needs review …**` note naming the conflict (the two surviving holds' vocabulary).
- Delete the scheduling interlock: `queuedRoles` (orchestrator-scheduling.ts), its legs in scheduling/skip.ts and scheduling/scope.ts, and `mergeStartHeld`'s merge half (orchestrator-poll.ts). A role whose change is merging authors its next run, as plans/interlock-relief.md's per-role tiering intended for the low-blast-radius roles only.
- Delete the check permit with the in-lock and batch checks it served (src/concurrency/check-permit.ts) and the three contention rows and the `capacity bottleneck` alert (part 1d/6 removes the alert; doctor-contention-checks.ts keeps `slot_wait`/`provider_wait` only if part 4/6 has not yet removed the pool).
- docs/how-it-works.md's merge-pipeline section and docs/invariants.md's cross-process invariants (INV-CT1 and the merge-slot guarantees) say what replaces the queue: one lock, linear history, and the post-landing check.

**Files touched.** src/merge src/orchestrator/orchestrator-poll.ts src/orchestrator/orchestrator-scheduling.ts src/scheduling/skip.ts src/scheduling/scope.ts src/runner/runner-run.ts src/status/status-data.ts src/doctor/doctor-contention-checks.ts src/doctor/doctor-check-names.ts src/concurrency/check-permit.ts docs/how-it-works.md docs/invariants.md test/merger-restack.test.ts test/merge-backlog-conflicts.test.ts test/worktree-pool.test.ts

**Acceptance criteria.**
- A code change's log path from run end to main is `merge_queued → merged`, with no stage events and no second check run; `build_check` events per merged commit are 1 (the post-landing one).
- Two roles land back to back with no interlock: the second role's run starts while the first's merge is in flight, and neither waits on the other's check.
- A conflicting change comes back to its author as one `**Needs review …**` note; nothing is dropped from a queue, because there is no queue.
- No `.tumwater/merge-queue/` directory is written; the doctor's `stale merge-queue entries` and `merge-queue files` rows are deleted (doctor-check-names.ts) rather than left to warn about a path nothing writes.
- `npm run test:gate` passes.

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

### A bugfix run that cannot reproduce a bug hands it to the director before parking it for the user (planned 2026-10-30 by the plan role; answered by the user 2026-10-30 to "When bugfix cannot make a bug reproduce, which hand-off comes first" — Option 1, shaped as a plan; independent in file of every `## Planned` entry — before this entry `grep -c 'director-request\|director request' PLANS.md` prints 0, `grep -rn 'director-request\|directorRequest' src test` prints nothing, and PLANS-DONE.md's only "director request" hits are the director's config request (`applyConfigRequest`), never a role-to-director prompt handoff; the blocked `Every commit is verified on main` parts edit `src/run/run-apply.ts`, `src/run/run-outcome.ts`, `src/run/run-finalize.ts` and `src/run/run-prompt.ts`, never `src/run/run-verdict.ts`, and the blocked `Subtract` parts edit `src/merge`, `src/config`, `src/orchestrator`, `src/status`, `src/doctor` and `src/concurrency`, none `src/inbox/director-request.ts`, `src/inbox/inbox-submit.ts`, `src/roles/role-catalog.ts`, `src/backlog/backlog-eligibility.ts` or `src/paths.ts` (the blocked `Every commit is verified on main` parts edit `src/inbox/pending-prompt.ts`, never the two inbox files this plan adds or reads); touches src/paths.ts src/inbox/director-request.ts src/run/run-verdict.ts src/roles/role-catalog.ts src/backlog/backlog-eligibility.ts docs/how-it-works.md docs/invariants.md test/director-request.test.ts test/run-verdict.test.ts test/prompt-roles.test.ts test/backlog-eligibility.test.ts)

**Goal.** Today an unreproducible bug is parked by the bugfix role with a `**Needs review <date> by bugfix: …**` note, so the user sees it before a stronger model does. The user asked for director-first review: when bugfix cannot reproduce a bug, it hands the entry, its attempted reproductions and its failure message to the director, and only a director that cannot resolve it parks the entry for the user. Roles cannot write the primary checkout's `.tumwater` directory, so the handoff is a harness-consumed request file in the role's worktree, the same staged-file pattern the director's config request uses.

**Approach.**
- `src/paths.ts`: add `directorRequestPath(wt: string)`, returning `<wt>/.tumwater-director-request.md` beside `configRequestPath`; its doc comment names the bugfix role and that the harness consumes the file before staging.
- New `src/inbox/director-request.ts`: `applyDirectorRequest(root, wt, queue = submitRolePrompt): { queued: true } | { error: string } | null`. Read the path with `readTextOrNull` and return null when it is absent. Trim the body; an empty body is an error. Compose the queued text from a fixed preamble ("The bugfix role could not reproduce this bug and asks you to review it before it is parked for the user:"), the body, and a fixed ask: "Investigate it against the code. If you can explain or reproduce it, add a Progress note under the entry in BUGS.md and leave the entry open. If you cannot resolve it, append `**Needs review <YYYY-MM-DD> by director: <what the user must decide>**` as its own line under the entry's heading and leave the rest of the entry intact." Call `queue(root, DIRECTOR_ROLE, text)` (which logs the `prompt_enqueued` event under director), delete the request file on every path — absent, empty, over-cap, enqueue throw — with the same best-effort unlink `discardConfigRequest` uses, and return the `errorMessage` on failure. The injectable `queue` seam exists only so the throw path is testable without a broken inbox.
- `src/run/run-verdict.ts`: after the existing config-request block and before the arms, when `baseRoleOf(ctx.role) === "bugfix"`, call `applyDirectorRequest(ctx.root, ctx.wt)` and `ctx.warn("director request rejected: …")` on an error. Consuming it before every staging path keeps the file out of the diff, exactly as the config request is kept out.
- `src/roles/role-catalog.ts`, the bugfix find text's cannot-reproduce branch: record the Progress note, write `.tumwater-director-request.md` at the worktree root with the entry's heading, every attempted reproduction and the failure message, then end the run — do not write a needs-review note. Keep the existing `**Needs review <YYYY-MM-DD> by bugfix: <what the next failure's message will show>**` note as the last resort only when the request file cannot be written. Add the skip rule: while the entry's newest Progress note names a director handoff and the entry has no `by director` needs-review note, skip it and pick another bug.
- `src/backlog/backlog-eligibility.ts` `isPlanStalled`: exclude a `by director` needs-review note from the stalled-with-the-plan surface (extend its existing `by bugfix` exclusion), so the director's user fallback is not read as a plan only the plan role can lift.
- `docs/how-it-works.md`: replace the cannot-reproduce paragraph with the director-first flow — the request file, the queued director prompt, the director's two outcomes, and the by-bugfix note only when the file cannot be written.
- `docs/invariants.md`: add `INV-B8: a bugfix run's director request is queued once, before staging, and never committed`, covering the delete-on-every-path and the absent-file null, binding `src/inbox/director-request.ts` (`applyDirectorRequest`), `src/paths.ts` (`directorRequestPath`) and `src/run/run-verdict.ts`'s bugfix call, and pinned by the new test module and the `test/run-verdict.test.ts` case.

**Files touched.** src/paths.ts src/inbox/director-request.ts src/run/run-verdict.ts src/roles/role-catalog.ts src/backlog/backlog-eligibility.ts docs/how-it-works.md docs/invariants.md test/director-request.test.ts test/run-verdict.test.ts test/prompt-roles.test.ts test/backlog-eligibility.test.ts

**Acceptance criteria.**
- A bugfix run that leaves a non-empty `.tumwater-director-request.md` queues exactly one director prompt whose text carries the request body, the fixed preamble and the fixed ask; the file is deleted before staging and never enters the commit's diff; the `prompt_enqueued` event names `director`.
- An absent file returns null; an empty/whitespace body, an over-cap body (rejected by `submitRolePrompt`) and an injected queue throw each return `{ error }`, warn in the run, and still delete the file.
- No role other than a bugfix instance consumes the file; a feature run's file is not queued.
- The bugfix find text names the request file and the director-first order, and names the by-bugfix needs-review note as the last resort; `isPlanStalled` returns false for a `**Needs review … by director: …**` note and keeps every result it returns true for today.
- docs/how-it-works.md no longer says an unreproducible bug is parked by bugfix before any director review.
- `npm run test:gate` passes.

**Tests.** New `test/director-request.test.ts` against temp root/worktree dirs: absent file null; a valid file queues the composed text and deletes the file; empty, over-cap and injected-throw paths return an error and still delete it. `test/run-verdict.test.ts`: a bugfix run with the file consumes it before a dirty/staging outcome and warns nothing, while a feature run with the same file leaves it. `test/prompt-roles.test.ts`: the bugfix find text names `.tumwater-director-request.md`, puts the director handoff before the needs-review note, and keeps the note as the last resort. `test/backlog-eligibility.test.ts`: `isPlanStalled` is false for a by-director note. Run those files, then the project's gate, and confirm green.

### Subtract, part 3a/7: The scheduler stops interlocking a role on its queued merge (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6 into seven independently mergeable parts; design in plans/subtract.md "The six strokes", stroke 3; requires Every commit is verified on main part 3f/3 landed; touches src/orchestrator/orchestrator-poll.ts src/orchestrator/scheduling-skip.ts src/orchestrator/scheduling-scope.ts src/scheduling/claims.ts src/gates/gate-polls.ts src/status/status-polls.ts docs/how-it-works.md test/claims.test.ts test/orchestrator-scheduling.test.ts test/gate-polls.test.ts test/status-polls.test.ts)

**Goal.** A role whose change is queued or pinned is admitted for its next run, so landing never holds authoring. Today `queuedRoles` (from `queuedMergeRoles`) blocks that role in scheduling-skip.ts, scheduling-scope.ts, claims.ts and gate-polls.ts, and `mergeStartHeld`'s merge arm in orchestrator-poll.ts holds role starts while a merge is in flight. Remove that interlock; run-stage's `heldOnBranch` one-pin cap in src/run/run-stage.ts stays, so a role still cannot write a second pin while its first waits.

**Approach.**
- Delete the `queuedRoles` field and every `hasQueuedMerge`/`queuedRoles.has(...)` branch from `SchedulingScope` (scheduling-scope.ts) and scheduling-skip.ts; the merge queue remains a merge-side fact only.
- In claims.ts, stop excluding `queuedMergeRoles` from instance-claim candidates; keep every other admission rule.
- In gate-polls.ts and status-polls.ts, drop the queued-merge roles from their in-flight inputs while keeping their run/in-flight counts.
- In orchestrator-poll.ts, remove the merge half of `mergeStartHeld` (the `reviewHeld`/role arm), leaving the restart/disk `runStartHeld` gate and the post-review hold.
- docs/how-it-works.md's Scheduling section says a role authors while its previous change waits, and the queue is not a scheduling gate.

**Files touched.** src/orchestrator/orchestrator-poll.ts src/orchestrator/scheduling-skip.ts src/orchestrator/scheduling-scope.ts src/scheduling/claims.ts src/gates/gate-polls.ts src/status/status-polls.ts docs/how-it-works.md test/claims.test.ts test/orchestrator-scheduling.test.ts test/gate-polls.test.ts test/status-polls.test.ts

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

### Settings gains controls for how many feature and bugfix runs happen at once, backed by the existing `roles.<role>.instances` (planned 2026-10-31 by the director; the user asked for GUI control over bugfix and feature concurrency under Settings, and this reuses the existing per-role instance mechanism instead of adding a second knob — `roles.feature.instances` and `roles.bugfix.instances` already run 1–8 parallel runners (`runnerIds` in src/roles/runner-ids.ts), the role drawer and TUI already edit them through `POST /api/role-instances`, and the global `maxConcurrent` still caps every run; independent in file of every `## Planned` entry — no open heading touches src/config/config-editable-keys.ts, src/gui/gui-admin-endpoints.ts, src/ui/gui/gui-client-settings.ts, test/gui-endpoints.test.ts or test/gui-client-settings.test.ts, and the Subtract parts touch src/config/config-schema.ts, src/config/config.ts, src/config/config-validation.ts and src/roles/runner-ids.ts, never these files; touches src/config/config-editable-keys.ts src/gui/gui-admin-endpoints.ts src/ui/gui/gui-client-settings.ts docs/config.md test/gui-endpoints.test.ts test/gui-client-settings.test.ts)

**Goal.** The dashboard's Settings view shows two rows, **Feature role instances** and **Bugfix role instances**, reading and writing `roles.feature.instances` and `roles.bugfix.instances` (1–8, default 1). Saving a count changes how many feature/bugfix runners may run at once; clearing it restores the default. This surfaces the existing instance mechanism in Settings rather than inventing new concurrency keys, so the role drawer, TUI, CLI, scheduler and doctor keep reading the same config fields.

**Approach.**
- `src/config/config-editable-keys.ts`: add `"roles.feature.instances"` and `"roles.bugfix.instances"` to `EDITABLE_CONFIG_KEYS`, immediately after `"maxConcurrent"`. Update the constant's doc comment to name this user-directed exception (the two instance roles only); every other per-role map and `customRoles` stays outside the Settings set.
- `src/gui/gui-admin-endpoints.ts` `handleConfig`: keep serving exactly `EDITABLE_CONFIG_KEYS`, but read a dotted role-instance key as `config.roles[role]?.instances ?? 1` (the resolved default) instead of indexing the top-level record; every top-level key keeps `record[key] ?? null`. A small module-private helper (e.g. `settingsValue(config, key)`) owns the branch for the two keys.
- No change to `handleConfigSet`/`handleConfigUnset` or `requireConfigKey`: once the keys are in `EDITABLE_CONFIG_KEYS`, they route through the existing `setConfigKey`/`unsetConfigKey` dotted-role path, whose whole-candidate `validateConfig` already enforces 1–8 and the feature/bugfix-only rule (`INSTANCE_COUNT`, `INSTANCE_ROLES`), and refuses exponent spellings.
- `src/ui/gui/gui-client-settings.ts`: add the two rows to `SETTINGS_KEYS` at the same positions and with those labels, and add both dotted keys to `PLAIN_INTEGER_KEYS` so the browser refuses exponent text before it posts. Keep the existing Save/Clear wiring unchanged.
- `docs/config.md`: in the `instances` paragraph/row, say the dashboard Settings view edits `roles.feature.instances` and `roles.bugfix.instances` as **Feature role instances** and **Bugfix role instances**, and that `maxConcurrent` still caps total runs.

**Files touched.** src/config/config-editable-keys.ts src/gui/gui-admin-endpoints.ts src/ui/gui/gui-client-settings.ts docs/config.md test/gui-endpoints.test.ts test/gui-client-settings.test.ts

**Acceptance criteria.**
- `GET /api/config` serves exactly `EDITABLE_CONFIG_KEYS`, including the two dotted instance keys, with each instance count resolved to its configured value or `1` when the file leaves it unset; every other top-level key is served as before.
- `POST /api/config-set` with `{"key":"roles.feature.instances","value":3}` writes `roles.feature.instances: 3` to `tumwater.json` and the next GET reports `3`; `POST /api/config-unset` removes it and the next GET serves `1`. The same works for `bugfix`.
- A value of `0`, `9`, `1.5`, `"abc"`, or an exponent spelling is refused with the existing validator's 400 message and leaves the file byte-identical; the keys are accepted for no role other than feature and bugfix (Settings does not expose any other role's instances).
- The Settings panel renders both rows with the labels above, Save posts the row's dotted key to `/api/config-set`, and Clear posts it to `/api/config-unset`; the run-concurrency rows still render in their pinned order.
- The role drawer's `/api/role-instances` editor, the TUI's Ctrl+G editor, `tumwater config set roles.<id>.instances`, and scheduler behavior are unchanged; no new config key or scheduler code is added.
- `npm run test:gate` passes.

**Tests.** In `test/gui-endpoints.test.ts`, extend the `handleConfig` case to write `roles.feature.instances: 3` and `roles.bugfix.instances: 2` and assert both served values, and assert both keys default to `1` when absent; add set/GET-on-disk/unset coverage for `roles.feature.instances` through `/api/config-set` and `/api/config-unset`, plus a 400 for `9` that leaves the file byte-identical. In `test/gui-client-settings.test.ts`, extend the render test to assert both labels/keys/fields and values, and add a `saveSetting` case that posts `{ key: "roles.feature.instances", value: 3 }`; keep the existing pin of `SETTINGS_KEYS` to `EDITABLE_CONFIG_KEYS`. Run those two files, then the project's gate, and confirm green.

### At the cap, a tier the cap moves runs its roles on the first free step that has not failed its model check (planned 2026-10-31 by the plan role; closes the first "Not covered (follow-ups)" bullet in plans/model-check.md, found 2026-10-30 while adding the below-cap check move; independent in file of every `## Planned` entry — `grep -c 'checkFreeResolved\|installFallbackConfig' PLANS.md` and `grep -c 'src/gates/budget-gates.ts\|src/budget/budget-fallback-view.ts' PLANS.md` both print 0 before this entry, and the only `src/budget` path a `## Planned` entry names is `src/budget/fallback-breaker.ts` (part 4j/3), a different module; the `Subtract` parts 4/6 and 6/6 touch src/config, src/doctor/doctor-check-names.ts and docs, not this gate or view; docs/invariants.md binds `src/budget/budget-fallback-view.ts` on `chainInfo`, `fallbackServingPair` and `pairDailyCost`, not `installFallbackConfig`, so its INV-BN1/BN2 bindings stay; touches src/gates/budget-gates.ts src/budget/budget-fallback-view.ts plans/model-check.md test/model-check.test.ts)

**Goal.** At the daily cap, the gate already skips a free fallback step whose model check failed: `servingResolved` drops it, so the `chain` block reads the next step and the pause set holds nothing on the dead pair. But the config the roles actually run under is installed from `priceResolved`, which prices steps and ignores the check, so a cap-moved tier's roles keep a runner config pointing at the failed pair and `modelCheckHolds` parks every one of them there. Make the cap's installed view step past failed pairs exactly as the chain and pause set do, while still keeping a breaker-demoted pair installed for its half-open probe.

**Approach.**
- `src/gates/budget-gates.ts`, `pollBudgetGate`: after the existing `checkResolved`, add `const checkFreeResolved = ctx.modelCheckFailed === undefined ? undefined : resolveTierFallbacks(liveConfig, (p) => pairFreeAt(p) && !checkFailed(modelPairName(p)));` — the price resolution stepped past check-failed pairs only. Unlike `servingResolved` it does not read `fallbackServingPair`, so a breaker-demoted cap pair stays in the view (the `priceResolved` comment's probe/merge requirement). Pass it to `budgetFallbackView` as `checkFreeResolved`.
- `src/budget/budget-fallback-view.ts`: add `checkFreeResolved?: TierFallbackMap` to `BudgetFallbackViewInput` with a doc comment saying it is the cap view's check-aware resolution, absent while the check is off. In `installFallbackConfig`, replace the `priceResolved` argument of `withCheckMoves(priceResolved, a.checkResolved, checkMoved)` with `a.checkFreeResolved ?? priceResolved`, so cap-moved tiers come from the check-aware map while checkMoved tiers still come from `checkResolved`. In `budgetFallbackView`, append the `checkFreeResolved` pair names to `fromKey` when the field is present (a `checkFreeKey` joined exactly like `resolvedKey`, added as `|${checkFreeKey}`), so a failed or recovered check re-installs `state.fallbackConfig` on the next poll. With the check off (`checkFreeResolved` undefined), `fromKey`, `installFallbackConfig` and `state.fallbackConfig` stay as they are today.
- `plans/model-check.md`: delete the first "Not covered (follow-ups)" bullet (the cap view now follows the step the chain and pause set use); leave the director, in-flight, probe-hang, pi-only and merge/review bullets.
- `docs/invariants.md` is not edited: its `src/budget/budget-fallback-view.ts` bindings are `chainInfo`, `fallbackServingPair` and `pairDailyCost`, and `chainInfo`'s input and output are untouched.

**Files touched.** src/gates/budget-gates.ts src/budget/budget-fallback-view.ts plans/model-check.md test/model-check.test.ts

**Acceptance criteria.**
- With the cap reached, a priced default primary, a free fallback chain `local/a`, `local/b`, and `modelCheckFailed("local/a")`, one `pollBudgetGate` returns `chain.default.pair` `local/b` and `seamPairName(configForRole(p.roleConfig, "feature"))` `local/b`; a second poll on the same `BudgetGateState` with that verdict cleared re-installs `local/a` in `roleConfig`.
- With no check (no `modelCheckFailed` in the poll context), the poll's `roleConfig`, its install behavior, the `chain` block and the `fallback_switched` events are unchanged; the existing cap and breaker cases in test/budget-gates.test.ts pass unedited.
- A breaker-demoted cap pair stays installed in `roleConfig` (the probe and a parked merge must still reach it): `checkFreeResolved` does not consult `fallbackServingPair`, so the demotion cases in test/budget-gates.test.ts pass unedited.
- `plans/model-check.md`'s "Not covered (follow-ups)" list no longer carries the cap-moved failed-step bullet.
- `npm run test:gate` passes.

**Tests.** Add one case to `test/model-check.test.ts` after "at the cap, a free primary that failed moves to a verified free step past a priced one", named "at the cap, a cap-moved tier steps past a free fallback step that failed its check": a `teamConfig` with `config.model.default = "paid/x"` and a models file pricing `paid/x` above zero while `local/a` and `local/b` are free, `config.maxDailyCostUsd = 0.000001`, `config.fallback = { default: ["local/a", "local/b"] }`, spend past the cap, and `modelCheckFailed: (pair) => pair === "local/a"`; assert `onFallback`, `chain.default.pair === "local/b"`, and `seamPairName(configForRole(p.roleConfig, "feature")) === "local/b"`; then poll the same state with the failure cleared and assert `configForRole(p2.roleConfig, "feature")` resolves to `local/a`. Run test/model-check.test.ts and test/budget-gates.test.ts whole, then the project's gate, and confirm green.

_None yet._

## Done
