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

### Backlog hold convergence: A needs-review/needs-replan entry that ping-pongs blocks its entry for the operator after three holds (planned 2026-10-23 by user; from the flow audit — feature↔plan is a genuine role-to-role loop with no convergence backstop: feature's `Needs review` note holds the entry until plan splits it, feature can mark it again, and nothing bounds the cycle; the reviewer's reject→revise loop got REVISION_BACKSTOP and REVISION_FINAL_ON_REPEAT (plans/revise-rejected.md), this loop got nothing; touches src/backlog/backlog-eligibility.ts src/roles/role-catalog.ts src/doctor/doctor-backlog-bugs.ts and their tests)

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

### Split orchestrator-scheduling.ts's pollRunnerReasons, part 2/3: the per-runner skip decision in scheduling-skip.ts (planned 2026-10-23 by the organize role, plan-only; split 2026-10-23 by the plan role out of the too-large single split; requires part 1/3 landed; independent sibling of part 3/3 — either may land first after part 1/3; touches src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-skip.ts (new) test/orchestrator-scheduling.test.ts)

**Goal.** Lift every gate that decides whether a runner is due or skipped into one function, so the WHY-due policy reads on its own screen.

**Approach.**
- New `src/orchestrator/scheduling-skip.ts`: `export async function skipRunner(scope: SchedulingScope, runner: RoleRunner): Promise<SkipVerdict>` with `SkipVerdict = { skip: true } | { skip: false; reason: string }`.
- Move the loop head and skip gates verbatim: once-mode settlement (the pre-gate `once.settle` and the `once.isSettled` continue), `holdForRestart`/`diskHeld`, per-role pause, `capPaused`, `maintenanceQuotaOverLine`, `bootstrapHeldNow`, `operatorPauseBlocks`, the director window hold, the `reviewHeld`/provider holds, the `isEligible` call with its `leftoverPending`/`planBacklogOpen` inputs, the not-due branch (`deferredDue` reset, `once.settleSkipped`, `noteSkip`, continue), the merge-queue interlock, the `instances` limit, the need-based deferral block (still awaiting `scope.workMergedSince.since` and updating `scope.deferredDue`), and the maintenance-allowance admission (mutating `scope.quotaAdmitted`). `noteSkip` is the one from `scheduling-scope.ts`.
- `orchestrator-scheduling.ts`'s loop becomes `const verdict = await skipRunner(scope, runner); if (verdict.skip) continue;` and passes `verdict.reason` to the still-inline admit tail (part 3/3 moves that tail).

**Acceptance criteria.**
- No gate predicate or once/deferral bookkeeping remains in `orchestrator-scheduling.ts`'s loop; the skip path is one function in `scheduling-skip.ts`.
- `test/orchestrator-scheduling.test.ts` passes unchanged (the exported `pollRunnerReasons` behavior is identical).
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

## Done
