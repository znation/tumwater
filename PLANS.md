# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### Interlock relief, part 1/2: The merge-queue interlock holds only what the feedback contract needs — a queued author whose change is approved may run (planned 2026-10-23 by user; design in plans/interlock-relief.md "The decision" and "What lands"; evidence: queue waits before landing ran median 5 min, max 3 h 17 m over 58 h, and the interlock parks the author for the whole window; one switch: `afterMerge` opts a role into both post-merge review and this relief (Reviewer as a regular role, part 1/4, landed); touches src/merge/merge-queue.ts src/orchestrator/orchestrator-scheduling.ts src/runner/leftover.ts and their tests)

**Goal.** plans/merge-queue.md invariant 3 ("a loop with a queued or landing change is not eligible to tick") exists to preserve the `state.lastReview` feedback contract. For post-merge-review roles that contract no longer needs the pre-merge pipeline: scope the interlock per role and per stage, so an author whose change is approved-and-waiting or in the fast-forward is not parked, while the stages that actually race the author's branch stay exclusive.

**Approach.**
- src/merge/merge-queue.ts: `queuedMergeRoles` (or its scheduler-side caller) gains the entry's stage. The scheduling skip (src/orchestrator/orchestrator-scheduling.ts, the `queuedRoles.has(runner.role)` skip) applies to a role whose entry is pre-approval (under review or checks) or in a conflict/`main_red` hold (`resolve-wait`, `resolving`, a held pin) — not to one approved-and-waiting or in the merge's fast-forward.
- The per-role tiering follows `review.afterMerge` exactly: a role on that list gets the scoped interlock; a pre-merge-review role keeps today's full interlock (its rejection must reach the runner before it authors again — that is the contract's original case).
- The queue's own per-runner cap is unchanged: a role with a queued change still cannot queue a second (invariant 3's "no change accumulates more than one commit ahead of main"); an author whose new run finishes while its previous change is queued holds the new commit on the branch until the entry drains. The author's next run starts from `reset --hard main` as always, so a queued-approved change does not block its author's tree.
- src/runner/leftover.ts: consult `ctx.mergeReviewError` and `ctx.mainRedRetry` before the pin is read or written — the pin-present path is unchanged, but the pin-absent path must not fall into the branch-tip adoption below. A held `main_red` pin is not a queue entry, so the scoped interlock admits the role and the run can reach recovery with a held record and the previous run's commit on the branch; adopting the tip then would create or repoint `refs/tumwater/merge/<role>` at the held commit and lose the kept sha (the review's repro). When the pin is missing and a held record stands, do not adopt: return the record's own held outcome (`held`, or `main_red_wait` with the held head) with the branch tip's sha, so the commit survives for the next run and the kept record is not silently re-labelled.
- plans/merge-queue.md invariant 3's text is updated to the scoped form with a pointer to plans/interlock-relief.md; docs/glossary.md's `waiting to merge` row keeps its meaning (it names the queue, not the run gate).

**Acceptance criteria.**
- A post-merge-review role with an approved queued entry starts its next run in the same poll it would have started in with an empty queue; the same role with an entry in `resolve-wait` or under review does not start (test over both stages).
- A pre-merge-review role (feature) with any queued entry still does not start — today's behavior, test unchanged.
- A recovery run with a branch commit ahead of main, no pin, and `mainRedRetry` (or `mergeReviewError`) set creates or repoints no `refs/tumwater/merge/<role>`, leaves the branch commit in place, and ends on the held/`main_red` path (test in test/leftover.test.ts) — the review's repro.
- `npm run test:gate` passes.

### Interlock relief, part 2/2: Docs state which roles wait on their merge and which do not (planned 2026-10-23 by user; design in plans/interlock-relief.md "What lands" item 2; requires part 1/2 landed; touches docs/how-it-works.md docs/glossary.md plans/merge-queue.md)

**Goal.** An operator reading the merge-pipeline section can predict which roles author through a queued change and which park, and why the split follows `review.afterMerge`.

**Approach.**
- docs/how-it-works.md, the merge-pipeline/scheduling sections: the interlock paragraph states the two tiers and the stage exclusions (pre-approval, conflict, main-red) as behavior, one paragraph, no new terms.
- docs/glossary.md: the `waiting to merge` status row gains the half-sentence "for pre-merge-review roles, this also holds the role's next run" — the scoped behavior is the row's whole difference.
- plans/merge-queue.md's invariant text carries the final wording (part 1/2 edits it; this part reconciles any drift from review).

**Acceptance criteria.**
- The three docs agree on the tiers and the excluded stages; grep finds no remaining unscoped "a role with a queued change never runs" claim outside plans/ as historical record.
- `npm run test:gate` passes (docs only).

### Backlog hold convergence, part 2/3: The operator sees a held-for-operator entry and `--release` clears it (planned 2026-10-23 by the plan role, split from the user's "Backlog hold convergence" plan; requires part 1/3 landed; touches src/backlog/backlog-eligibility.ts src/backlog/backlog-release.ts src/doctor/doctor-backlog-plans.ts src/ui/team-alerts.ts src/ui/status-model.ts and their tests)

**Goal.** A held-for-operator entry is visible to the operator with `tumwater plan --release` as the way out, and release actually lifts it — today `--release` lifts only Refused and Waiting notes and deliberately leaves Needs-review alone.

**Approach.**
- src/backlog/backlog-eligibility.ts: add `operatorHeldEntries(root): RefusedEntry[]` beside `refusedEntries`, returning the planned plans whose hold is `"held-for-operator"`, each with `file: "plans"`, its 0-based index and title (reuse the `RefusedEntry` shape and the `backlogHolds` + `plannedPlanEntries` pairing).
- src/backlog/backlog-eligibility.ts: add `withoutHeldForOperatorNotes(lines)` (through `withoutNoteLines`) dropping a `**Needs review … (held N)**`/`**Needs replan … (held N)**` line and its `**Previously held N**` line together. It drops nothing when the note's count is below the threshold, so `--release` still cannot lift a live first/second Needs-review hold.
- src/backlog/backlog-release.ts: `liftRefusal` gains a third branch after Refused and Waiting — when the entry's `entryHold` is `"held-for-operator"`, splice out the held note and prior-held line via `withoutHeldForOperatorNotes`; otherwise `not_refused` as today.
- src/doctor/doctor-backlog-plans.ts: `checkStalledPlans` keeps its needs-review/replan branch and adds a held-for-operator branch whose warn names the entry, its `(held N)`, and `tumwater plan --release` as the recovery (the plan role does not resolve this one).
- src/ui/team-alerts.ts: a new amber alert (key `"operator-held"`) listing `operatorHeldEntries` through `entryListDetail`, with the refused alert's "Open backlog" action and text naming `tumwater plan --release`; add the input to `buildAlerts`'s params (default `[]`) and pass `operatorHeldEntries(root)` from src/ui/status-model.ts beside `refusedEntries(root)`.

**Tests.**
- test/backlog-eligibility.test.ts: `operatorHeldEntries` returns a `(held 3)` plan and not a `(held 2)` one.
- test/backlog-release-holds.test.ts: `--release` on a `(held 3)` entry removes both the note and `**Previously held 3**`; on a `(held 2)` entry it reports `not_refused` and writes nothing.
- test/doctor-backlog.test.ts: `checkStalledPlans` warns for a held-for-operator entry naming `tumwater plan --release`.
- test/team-alerts.test.ts: an `operator-held` amber alert names the entry; no such alert when the list is empty.

**Acceptance criteria.**
- The dashboard alerts and the doctor both name a held-for-operator entry and `tumwater plan --release`; a Needs-review entry below the threshold surfaces exactly as today.
- `tumwater plan --release` on a held-for-operator entry leaves no Needs-review and no `**Previously held` line behind, and the entry becomes eligible; on any other Needs-review entry it refuses without writing.
- `npm run test:gate` passes.

### Backlog hold convergence, part 3/3: Feature increments the count; the plan role carries it across a split and release clears it (planned 2026-10-23 by the plan role, split from the user's "Backlog hold convergence" plan; requires part 1/3 landed; touches src/roles/role-guidance.ts src/roles/role-catalog.ts test/role-guidance.test.ts)

**Goal.** The held count part 1/3 reads is actually written and maintained: feature appends `(held N)` with N one past the surviving prior count; the plan role carries `**Previously held N**` onto each child of a split.

**Approach.**
- src/roles/role-guidance.ts: `NEEDS_REVIEW_NOTE` and `NEEDS_REPLAN_NOTE` gain the trailing tag ` (held <N>)`; add `PRIOR_HELD_NOTE = \`${PRIOR_HELD_PREFIX}<N>**\`` beside them. `NEEDS_REVIEW_PREFIX`/`NEEDS_REPLAN_PREFIX` are unchanged (the tag is inside the line, so recognition is unaffected).
- src/roles/role-catalog.ts, feature `find` step 4: on appending a Needs-review (or Needs-replan) note, write `N = heldCount + 1`, where the prior count is read from the entry's existing `(held N)` or `**Previously held N**` line; an entry carrying neither starts at 1. State that the count must not reset while the same plan ping-pongs, and that a plan that landed and left `## Planned` needs no marker.
- src/roles/role-catalog.ts, plan `find` step 1: when the plan role lifts a Needs-review/replan note (split or rewrite) and the change has not landed, replace the note with `PRIOR_HELD_NOTE` at the same N and copy it to every child part the split produces; a landed parent leaves none. This corrects the original entry's "split resets to held 1": a split carries the count to its children, so three consecutive holds without a landing reach `(held 3)` and part 1/3's block.

**Tests.**
- test/role-guidance.test.ts (or the file already covering these exports): `NEEDS_REVIEW_NOTE`/`NEEDS_REPLAN_NOTE` each contain `(held <N>)`, `PRIOR_HELD_NOTE` contains `Previously held <N>`, and `NEEDS_REVIEW_PREFIX` still matches a tagged note line — so `heldCount` round-trips a `PRIOR_HELD_NOTE`-shaped line.
- A role-catalog test (the existing pattern for `find` texts): the feature text mentions `(held ` and the plan text mentions `Previously held`.

**Acceptance criteria.**
- A Needs-review note the feature charter writes carries ` (held <N>)`; a re-mark after one lift writes `(held 2)`, and a split's children each carry `**Previously held <N>**`.
- `NEEDS_REVIEW_PREFIX`/`NEEDS_REPLAN_PREFIX` still match the tagged notes, so `entryHold` classification is unchanged except for the count.
- `npm run test:gate` passes.

### Split run-agent.ts's run lifecycle from its post-run settlement (planned 2026-10-23 by the organize role; independent of every in-flight agent entry — the Codex write-guard parts (6/9–9/9) and the Codex backend parts (9a/9–9d/9) touch src/agent/codex/*, src/prompt/dialect.ts, src/doctor/doctor-model-checks.ts and scripts/smoke-codex.mjs, not src/agent/run-agent.ts directly, and the `prepare` step that binds this file to codex already landed in part 5/9, so its contract is settled; mirrors the runner-run → runner-outcome split (linked by design but widened to run-agent's stdout/stdin/process-group concerns); touches src/agent/run-agent.ts src/agent/run-settle.ts docs/invariants.md)

**Goal.** `runAgent` is a single ~555-line async function (src/agent/run-agent.ts, 760 lines total) that both drives a backend agent to completion and settles what happened after it dies: pre-spawn setup (raw/native append logs, per-run tmpdir, marker, blind-read state, notes shim, session ledger), the async `prepare` step, spawn (env, detached group, process title, stdin pipe), incremental stdout/stderr decoding, the translator→parser→raw-log pipeline, the two watchdog clocks, and — in the `error`/`exit`/`close` handlers — the spawn-error cause, the process-group and marker orphan sweeps, the backend's post-run reconciliation, the exit-cause classification, and building the `PiRunResult` from the parser. One function owning setup, live streaming and death-handling is the largest module in the tree; it is also the single biggest obstacle to understanding any one backend's run, because the settlement half is interleaved with the feed half that precedes it. Split it on the same seam the runner split used: the run lifecycle stays where it is, the post-run settlement moves out.

**Approach.**
- src/agent/run-settle.ts (new): the post-run settlement half — the spawn-`error` handling (setupFailureResult), the `close`-handler work (flushing the decoders' held-back bytes, the translator's pending canonical lines, the backend's post-run reconciliation — opencode's session export — skipped when a killed run already settled, the exit-cause classification merging the backend's stderr verdict with the parser's event-derived flags, the blind-read failure override, and `resultFromParser` building the `PiRunResult` so adding a field touches one place), plus the `exit` orphan sweeps (the process-group sweep, then the fire-and-forget marker sweep). Each handler's body moves verbatim into a function that takes the live run state it closes over as a parameter.
- src/agent/run-agent.ts: keeps the run lifecycle — pre-spawn setup, `prepare`, spawn, decoders, stream pipeline, watchdogs, and the feed — and keeps `runAgent`/`PiRunOptions` as its exported surface. It defines a `RunSettle` binder (the shared run state: child, rawLog, parsers, decoders, watchdogs, terminateRun, finish, backend id, run marker, and the flags the handlers read live) as a type-only import for run-settle, so there is no runtime cycle; run-agent registers the `error`/`exit`/`close` listeners that delegate to run-settle's handlers.
- Move any helper only the settlement half uses (setupFailureResult, and openAppendLog if the state it returns travels only into settlement) with it; keep the type of the returned `PiRunResult` and the run's external behavior identical.
- docs/invariants.md: update the section that describes `runAgent`'s death handling (the orphan-sweep and exit-cause guarantees) to name run-settle.ts, alongside the live-reference update, in the same commit.

**Files touched.** src/agent/run-agent.ts, src/agent/run-settle.ts (new), docs/invariants.md.

**Acceptance criteria.**
- `runAgent` no longer contains the `close`/`exit`/`error` handler bodies; those live in run-settle.ts and run-agent imports them back, with no runtime import cycle (run-settle imports run-agent's binder type only).
- A grep over src/, test/ and the markdown docs for `setupFailureResult` and the moved settlement names finds no stale path or reference.
- The wipe, orphan-sweep, reconciliation and exit-cause tests that drive runAgent through the fake backend suites — test/claude-run.test.ts, test/codex-run.test.ts, test/opencode-run.test.ts, test/release-run.test.ts and test/agent-backend.test.ts — pass unchanged; `npm run test:gate` passes.

## Done
