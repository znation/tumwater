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

### Backlog hold convergence: A needs-review/needs-replan entry that ping-pongs blocks its entry for the operator after three holds
(planned 2026-10-23 by user; from the flow audit — feature↔plan is a genuine role-to-role loop with no convergence backstop: feature's `Needs review` note holds the entry until plan splits it, feature can mark it again, and nothing bounds the cycle; the reviewer's reject→revise loop got REVISION_BACKSTOP and REVISION_FINAL_ON_REPEAT (plans/revise-rejected.md), this loop got nothing; touches src/backlog/backlog-eligibility.ts src/roles/role-catalog.ts src/doctor/doctor-backlog-bugs.ts and their tests)
**Needs review 2026-10-23 by feature: too large for one run**

**Goal.** The `needs-review`/`needs-replan` hold (feature's note that a plan is too large for one run, or must be rewritten) is a hand-off to the plan role, and the plan role's split or rewrite is the lift. The cycle has no backstop: a plan that feature keeps marking and plan keeps splitting unproductively ties up both roles' attention and the entry, invisibly — unlike a rejected change, which visibly exhausts its revision cap. Give it the same convergence the reject loop got: after the third consecutive hold on one entry, the entry blocks for the operator with the history of holds.

**Approach.**
- src/backlog/backlog-eligibility.ts: `entryHold` already parses the note from the entry body; the hold text gains a counter the way `lastReview`'s reasons carry `(prior N)` tags — the note's writer (feature) appends `(held N)` when re-marking an entry whose previous hold was lifted without a landing (the marker is the entry body, so the count survives like every other note; a re-marked entry whose plan landed in between resets, because the new hold answers a different plan).
- On `held 3`, the hold renders as blocked-for-operator: the plan role no longer picks it (its charter skips entries the index block marks `[blocked: …]`), and the stale-backlog visibility that already exists surfaces it — the dashboard's refused-entry alert (src/ui/team-alerts.ts) is the model: a held entry with `(held 3)` shows the operator the entry, the surviving disagreement, and `tumwater plan --release` as the way out.
- The plan role's lift path is unchanged for the first two holds: a split or rewrite that answers the note lifts it as today.
- Left out deliberately: any prompt-level instruction for feature to mark differently. The counter is harness state, not a behavior ask — the same split between mechanism and verdict that plans/revise-rejected.md drew.

**Acceptance criteria.**
- An entry marked, lifted by a split, and marked again reads `(held 1)`, not `(held 2)` (the landing reset); marked three times without a landing between, it reads `(held 3)`, the plan role's eligibility test excludes it, and the operator alert names it.
- `tumwater plan --release` lifts it and clears the counter, as it lifts every other hold today.
- `npm run test:gate` passes.

### Write guard on Codex, part 5/9: An async `prepare` step on agent backends; codex's resolves the guard's trust before a run (planned 2026-10-23 by user; requires part 4/9 landed; design in plans/codex-write-guard.md "Trust (parts 4–5)"; also edited by the open Codex backend part 9a/9 in other functions of src/agent/codex/codex-backend.ts, so whichever lands later rebases; touches src/agent/agent-backend.ts src/agent/run-agent.ts src/agent/codex/codex-backend.ts test/agent-backend.test.ts test/codex-run.test.ts)

**Goal.** `AgentBackend.invocation()` is synchronous, but the trust lookup spawns `codex app-server`. Resolve it in an awaited step before the invocation is built, without blocking the event loop and without one `app-server` per run.

**Approach.**
- src/agent/agent-backend.ts: `AgentBackend` gains optional `prepare?(run: AgentRunSpec): Promise<void>`, documented as "work the invocation needs that cannot be synchronous; never throws a run away".
- src/agent/run-agent.ts: right before `backend.invocation(runSpec)` (today around line 304), `await backend.prepare?.(runSpec)` inside a try/catch. A throw is logged as a `warning` (source `tumwater`) through `logEventBestEffort` on the run's root (`nearestTumwaterRoot(opts.sessionDir)`, skipped with no root), and the run continues.
- src/agent/codex/codex-backend.ts: `prepare(run)` resolves the guard's trust for `codexWriteGuardDefinition()` under the run's codex env (`CODEX_HOME` as `invocation` computes it).
  - It goes through `codexHookTrust` with `root = nearestTumwaterRoot(run.sessionDir)` and `cwd = run.cwd`.
  - It is single-flight: one in-flight promise per process per (home, definition), shared by concurrent runs.
  - The result is a module-level state that `invocation` reads synchronously: `{ trust }` or `{ off: reason }`.
  - A failed lookup records `off` and logs one `warning` per process per (home, definition): `codex write guard off: <reason>`.
- Nothing uses the stored trust yet. This part only warms it, so a codex run now starts one `app-server` per new build and Codex version, and none on a cache hit.

**Tests.**
- test/agent-backend.test.ts (or a run-agent test beside it): a backend whose `prepare` throws still spawns its run and logs one warning; a backend without `prepare` behaves as before.
- test/codex-run.test.ts, on the fake:
  - two codex runs started together start one `app-server`;
  - a hanging `app-server` lets both runs start after the bounded wait and logs `codex write guard off:` once across three runs;
  - a pi run and a claude run start no `app-server`.

**Acceptance criteria.**
- No backend's argv changes.
- A failing lookup never fails or delays a run beyond the 15 s bound.
- `npm run test:gate` passes.

### Write guard on Codex, part 6/9: Codex runs carry the trusted write-guard hook (planned 2026-10-23 by user; requires part 5/9 landed; design in plans/codex-write-guard.md "Runs (part 6)" and findings 1, 2 and 5; also edited by the open Codex backend part 9a/9 in other functions of src/agent/codex/codex-backend.ts; touches src/agent/codex/codex-args.ts src/agent/codex/codex-backend.ts docs/invariants.md test/codex-args.test.ts test/codex-run.test.ts)

**Goal.** Turn the guard on. A codex run whose `apply_patch` would land under the team root but outside its worktree is refused with the shared refusal, as pi, claude and OpenCode runs are.

**Approach.**
- src/agent/codex/codex-args.ts: `CodexArgOptions` gains `guardArgs?: string[]`. codexArgs inserts it after the harness's own `-c` keys and before `-m`, on fresh and resumed (`exec resume`) runs alike. The passthrough cannot override it, because part 3/9 reserved `hooks`.
- src/agent/codex/codex-backend.ts: `invocation` reads the state `prepare` stored.
  - With `{ trust }` it passes `guardArgs: ["-c", codexHookArg(definition), "-c", codexHookTrustArg(trust)]`.
  - With `{ off }`, or no state, it passes neither. An untrusted hook would be skipped silently anyway.
  - It never passes `--dangerously-bypass-hook-trust`. That flag would run the target repo's own `.codex` hooks unreviewed and add an `error` item to every run's stream (findings 1 and 4).
- docs/invariants.md: the next free `INV-CW` id. It is "a codex run carries the guard's hook and its trust entry together or neither, and never `--dangerously-bypass-hook-trust`", pinned by the tests below.

**Tests.**
- test/codex-args.test.ts: `guardArgs` lands between the last harness `-c` and `-m` for both a fresh and a resumed run, and is absent when unset.
- test/codex-run.test.ts, on the fake:
  - a fresh run and a resumed run each carry both `-c` values with the fake's key and hash;
  - with the lookup failing, neither appears;
  - no argv ever contains `--dangerously-bypass-hook-trust`.

**Acceptance criteria.**
- With trust available, every codex run's argv carries the hook and its trust; without it, the argv is exactly today's.
- The codex stream translator is unchanged: a blocked patch adds no stream item (finding 5).
- `npm run test:gate` passes.

### Write guard on Codex, part 7/9: Codex's prompt dialect sends file edits through `apply_patch` (planned 2026-10-23 by user; requires part 6/9 landed; design in plans/codex-write-guard.md "Coverage (part 7)" and finding 6; touches src/prompt/dialect.ts test/prompt-dialect.test.ts)

**Goal.** The guard sees only `apply_patch`. plans/codex-backend.md's probes saw codex models edit through the shell (`printf >>`) unless the prompt asked for `apply_patch`, so ask for it.

**Approach.**
- src/prompt/dialect.ts: `CODEX_DIALECT.backendRules` gains one rule: "Edit and create files with the `apply_patch` tool, not shell redirection (`>`, `>>`, `tee`) or `sed -i`."
- Update the `CODEX_DIALECT` doc comment to say why: the write guard checks only `apply_patch` (plans/codex-write-guard.md).

**Tests.** test/prompt-dialect.test.ts:
- a codex run prompt contains the rule exactly once;
- the pi, claude and OpenCode run prompts do not contain it;
- the codex prompt's other backend rule (the `write_stdin` polling rule) is still present.

**Acceptance criteria.**
- Only codex prompts change, by exactly that rule.
- `npm run test:gate` passes.

### Write guard on Codex, part 8/9: Doctor's codex group reports whether codex runs carry the write guard (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9a/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)"; touches src/doctor/doctor-model-checks.ts test/doctor-model-checks.test.ts)

**Goal.** An operator can see from `tumwater doctor` whether codex edits are guarded, and why not when they are not.

**Approach.**
- src/doctor/doctor-model-checks.ts: in the codex check rows Codex backend part 9a/9 adds (each shown when any job routes to codex), add a `write guard` row.
- The row runs `codexHookTrust` for the run env's home and the current build's definition, bounded at 10 s like the group's other Codex calls.
  - pass: `trusted (sha256:<first 12 hex>)`;
  - warn: `off: <reason> — codex runs edit without the worktree check`.
- Doctor stays read-only apart from the cache file, which `codexHookTrust` already writes.

**Tests.** test/doctor-model-checks.test.ts, on the fake:
- a fake that lists the hook gives the pass row with the hash prefix;
- a fake whose list is empty gives the warn row naming the reason;
- a pi-only team shows no codex group, so no row.

**Acceptance criteria.**
- Both rows render as above.
- `npm run test:gate` passes.

### Write guard on Codex, part 9/9: The live `smoke:codex` step for the guard, and the docs (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9c/9 and Codex backend 9d/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)" and "Risks"; touches scripts/smoke-codex.mjs docs/how-it-works.md docs/backends.md plans/codex-backend.md)

**Goal.** After a Codex upgrade, one live command proves the guard still blocks. Session-flag trust could stop working while the `hooks/list` lookup still succeeds ("Risks"). The docs should say which backends are guarded and how.

**Approach.**
- scripts/smoke-codex.mjs (added by Codex backend part 9d/9) gains a `write guard` step.
  - Build a throwaway team layout: a git repo `<T>/repo`, its worktree `<T>/repo/.tumwater/worktrees/_slot-1`, and the same `notes.md` text in both. Keep the session dir under `<T>/repo/.tumwater/sessions`, never outside a `.tumwater` root.
  - Run the production invocation through `runAgent`, asking the model to use `apply_patch` to change `notes.md` at the primary's absolute path, and to follow any refusal.
  - Assert three things: the primary's `notes.md` is unchanged, the worktree's `notes.md` changed, and the run's rollout holds "blocked by PreToolUse hook".
  - The step is listed by the script's `--help`/dry-run.
- docs/how-it-works.md, "A run" step 2: the guarded tools name codex's `apply_patch`, through a trusted hook. Shell writes stay unchecked on every backend.
- docs/backends.md, Codex section:
  - the guard is a PreToolUse hook passed with `-c`, trusted through the same session-flag layer with the hash Codex reports;
  - `codex-hook-trust.json` caches the hash;
  - `--dangerously-bypass-hook-trust` is never used.
- plans/codex-backend.md: under "never passes `--dangerously-bypass-hook-trust`", add one sentence: tumwater trusts only its own write-guard hook, through the session-flag layer (plans/codex-write-guard.md).

**Tests.** None beyond the script's dry-run listing. The live step runs by hand: `npm run smoke:codex`.

**Acceptance criteria.**
- `npm run smoke:codex -- --help` (or the script's dry-run flag) lists the `write guard` step.
- The docs name codex among the guarded backends and its `apply_patch`-only coverage.
- `npm run test:gate` passes.

### Split orchestrator-scheduling.ts's pollRunnerReasons, part 3/3: multi-runner claim assignment and stand-down in scheduling-admit.ts (planned 2026-10-23 by the organize role, plan-only; split 2026-10-23 by the plan role out of the too-large single split; requires part 1/3 landed; independent sibling of part 2/3 — either may land first after part 1/3; touches src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-admit.ts (new) test/orchestrator-scheduling.test.ts)

**Goal.** Lift the post-gate admission — the stand-down turn-down and the parallel-work-instance claim assignment — into one function.

**Approach.**
- New `src/orchestrator/scheduling-admit.ts`: `export function admitRunner(scope: SchedulingScope, runner: RoleRunner, reason: string): "admitted" | "skipped"`.
- Move verbatim the stand-down block (the feature/bugfix `reason === "scheduled" || reason === "main moved"`, the `freshlyWoken`/claim/outstanding guards, the `eligibleMemo`-backed empty-eligible skip with `no-free-entry` and `once.settle`) and the claim-group block (keeps its claim; finishes its unrecorded entry; the group-hold skip; `assignNext` over the free entries; `heldElsewhere`; the `source: "assigned"` claim write and its `claim` event; the extra-instance/held-titles skip; the no-group `heldElsewhere` clear). It imports `noteSkip` from `scheduling-scope.ts`.
- `orchestrator-scheduling.ts`'s loop calls `admitRunner(scope, runner, verdict.reason)`; when it returns `"admitted"` the binder does its final `noteSkip(root, runner, undefined)`, `reasons.set(runner, reason)` and the `writing` increment.

**Acceptance criteria.**
- No claim-assignment or stand-down logic remains in `orchestrator-scheduling.ts`.
- `test/orchestrator-scheduling.test.ts` passes unchanged (the exported `pollRunnerReasons` behavior is identical).
- `npm run test:gate` passes.

### The day report's merge-slot median: how long the merge slot held each change it landed (planned 2026-10-23 by the plan role; independent of every eligible plan — the queue-cancel plan touches src/merge, src/cli and src/events, the interlock and split series touch src/orchestrator, and this adds one folded field and one line beside the report's other per-day medians; touches src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts docs/cli.md test/report-data.test.ts test/report.test.ts test/gui-client-report.test.ts)

**Goal.** The team day report and the dashboard Usage view print a per-day `Merge wait median` (a `merge_done`'s enqueue-to-merged `queuedMs`), but nothing says how much of that wait the merge slot itself spent: `merge_done.durationMs` runs from the verification's start to the outcome (`writeMergeOutcome`, src/merge/merge-slot.ts) and is folded nowhere. Add a per-day `Merge slot median` — the lower median of the day's `merge_done.durationMs` — beside the merge-wait median, so an operator reads the queue backlog (the merge wait minus the slot time) apart from the slot's own review/check/rebase/merge work.

**Approach.**
- src/report/report-fold.ts: `UsageFold` and `DayFold` each gain `mergeDurationsMs: number[]` beside `mergeWaitsMs`, seeded `[]` in `dayFoldFor` and in `collectReportSince`'s accumulator (src/report/report-data.ts). In `foldUsageEvent`'s `merge_done` branch, after the `mergeWaitsMs` push, add `pushPositiveMs(target.mergeDurationsMs, finiteNumber(ev.durationMs, 0))`. Only `merge_done` feeds it: like `mergeWaitsMs`, a `merge_failed` is an attempt that never reached main, and a pre-`durationMs` event (or 0) contributes nothing, so the median is over landed merges only.
- src/report/report-types.ts: `ReportDay` gains `mergeSlotMedianMs?: number` beside `mergeWaitMedianMs`, its doc comment saying it is the lower median of the day's `merge_done.durationMs` (verification start to outcome, ms), team-only, absent when the day has none.
- src/report/report-data.ts: add `"mergeSlotMedianMs"` to the `DayMedianKey` union (and its doc comment's "seven `…MedianMs` cells" count), and in `collectReport`'s team branch beside the `mergeWaitMedianMs` line: `setLowerMedian(day, "mergeSlotMedianMs", fold.mergeDurationsMs);`.
- src/report/report-render.ts: in the team-only block, after the `Merge wait median` line, add `pushDayCameoLine(lines, data.series, "Merge slot median", (d) => d.mergeSlotMedianMs);`.
- src/ui/gui/gui-client-report-chart.ts: add `chartMergeSlotMedian(data)` returning `medianBarChart(data, "mergeSlotMedianMs", "#64748b", "merge slot")`, and `seriesHasMergeSlotMedian(data)` returning `seriesHasScalar(data, "mergeSlotMedianMs")`; update the shared `medianBarChart` comment's chart count (it now serves one more median).
- src/ui/gui/gui-client-report.ts: add a block beside `Merge wait median`: `(seriesHasMergeSlotMedian(d) ? block("Merge slot median", chartMergeSlotMedian(d), "per day · verification start to outcome") : "")`.
- docs/cli.md, the `tumwater report` row: in the sentence naming each day's median merge wait, add each day's median merge-slot time (verification start to outcome, from `merge_done.durationMs`; team report only).

**Tests.**
- test/report-data.test.ts, a new test mirroring "collectReport gives each day the lower median of its merge_done queuedMs, team scope only": `merge_done` events on one day with `durationMs` 60_000, 120_000 and 240_000 (lower median 120_000); a `merge_done` with `queuedMs` but no `durationMs` (skipped, not zero); a `merge_failed` with a large `durationMs` (not counted); assert the first day's `mergeSlotMedianMs` is 120_000, a day with only non-qualifying merges omits the key, and every day of `collectReport(root, 3, "feature")` omits it.
- test/report.test.ts: the rendered team report contains `Merge slot median` when a day carries one, and no such line when no day does.
- test/gui-client-report.test.ts: the Usage view renders the `Merge slot median` block when the series carries the field and omits it otherwise, mirroring the existing `Merge wait median` case.

**Acceptance criteria.**
- A day whose landed merges carry `durationMs` shows one `Merge slot median` line in `tumwater report` and one chart block in the dashboard Usage view; a merge-free (or duration-less) window prints no line and no block, so its output is unchanged.
- The field and line are team-only: a role-scoped day report and `report --json --role <id>` carry no `mergeSlotMedianMs`, and the `--since` totals report is unchanged.
- `npm run test:gate` passes.

### `tumwater start --once --json` prints the round's per-role outcomes as one JSON object, so a cron/CI caller does not parse the prose summary (planned 2026-10-23 by the plan role; independent of every eligible plan — the interlock and pollRunnerReasons-split series touch src/orchestrator and src/merge, the Codex write-guard parts touch src/agent, src/prompt and docs/backends, and the merge-slot median touches src/report and src/ui/gui; the only shared file is docs/cli.md, where this edits the `Start the team` once block and that plan edits the `tumwater report` row, so whichever lands second rebases there; touches src/cli/cli-start.ts src/cli/cli-flag-specs.ts src/cli/help.ts docs/cli.md test/cli-start.test.ts test/cli-start-once.test.ts)

**Goal.** `tumwater start --once` is the README's cron/CI command: it does one round, prints a one-line prose summary (`onceSummary`) plus a `once: failed — …` line when the round failed, and exits 3 on such a failure. A CI step that wants per-role outcomes — which role merged, which errored, which was skipped and why — has to scrape that prose. Add `--json`, valid only with `--once`, that prints the same round facts as one JSON document on stdout with the banner and the event stream suppressed, so the caller parses the round directly.

**Approach.**
- src/cli/cli-start.ts: split `onceSummary` into a structured `onceReport(root, roles, runsBefore, settled, runsDone)` and a `renderOnceSummary(report)` that produces today's exact line; keep `onceSummary` as their composition so its exported signature and every existing test stay unchanged. `onceReport` walks the existing `onceRoundRoles`/`onceFailures` helpers and returns `{ runs, outcomes, skipped, failures }`:
  - `runs`: the round's total run count (the `ran > 0` sum).
  - `outcomes`: `{ [result: string]: number }`, one key per result a ran role ended on (`state.lastResult ?? "no_change"`), inserted in the `compareCodeUnits`-sorted order `onceSummary` uses.
  - `skipped`: `[{ role, reason }]` in role order, one entry per role with `ran === 0`, `reason` resolved exactly as `onceSummary` resolves it (the `settled` map, then the pause marker, then `stateSkipReason`).
  - `failures`: `onceFailures(...)` verbatim.
- In `cmdStart`, read `const json = args.includes("--json");` beside `once`, and beside the `--role` guard add `if (json && !once) fail("--json is only valid with --once");`. When `json` is true, skip the three banner `say(...)` lines and the `subscribeEvents((e) => say(formatEvent(e)))` subscription, and after the round print `sayJson(onceReport(...))` instead of the `onceSummary` line; the `onceFailures` line and the `ONCE_FAILED_EXIT_CODE` exit are unchanged. The orchestrator and merge pipeline record events through `logEvent` (file plus subscription), not stdout, and the supervisor prints nothing on stdout for a once round, so stdout then holds exactly the one JSON document.
- src/cli/cli-flag-specs.ts: add `JSON_FLAG` to `START_FLAG_SPECS` and widen the spec's doc comment to name `--once --json`.
- src/cli/help.ts: add `[--json]` after `[--once]` in the `tumwater start` synopsis, and under the `--once` stanza add one wrapped line: ``--once --json prints the round's totals, per-result counts, skipped roles and failures as one JSON object on stdout (no banner or event stream); only valid with --once;``.
- docs/cli.md: in the `Start the team` block, under the `tumwater start --once` comment line, add `# add --json to print the round's totals, per-result counts, skipped roles and failures as one JSON object (only with --once)`.

**Tests.**
- test/cli-start.test.ts: a new test for `onceReport` over the same seeded state the `onceSummary` tests use — one advanced run and one skipped role — asserting `runs`, the sorted `outcomes`, the `skipped` role/reason pairs, and `failures`; and that `onceSummary(...)` still equals `renderOnceSummary(onceReport(...))`.
- test/cli-start-once.test.ts: a new test `run --once --json prints one JSON object and no banner or event stream` — `withIdlePi`, `cli(repo, "run", "--once", "--json")`, `JSON.parse(r.stdout)` gives `runs: 1`, `outcomes: { no_change: 1 }`, empty `skipped` and `failures`, and `r.stdout` matches neither `/tumwater once on branch/` nor `/roles:/`; a second test `run --json without --once is refused` — `cli(repo, "run", "--json")` exits 1 with `/--json is only valid with --once/` and boots nothing.

**Acceptance criteria.**
- `tumwater start --once --json` writes exactly one parseable JSON object to stdout (no banner, no event lines) and exits 0, or 3 when the round failed, carrying `runs`, `outcomes`, `skipped` and `failures`; `--once --role clean --json` carries only clean's work.
- `tumwater start --json` without `--once` exits 1 with `--json is only valid with --once`; the daemon and `--for` output are unchanged.
- `tumwater start --once` (no `--json`) prints the same banner, event stream and summary line as before.
- `npm run test:gate` passes.

## Done
