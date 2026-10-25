# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Prerequisite landed 2026-10-23 by the steward: reviewer-as-role parts 1/4 and 3/4 both landed today (their PLANS-DONE.md entries stamp done 2026-10-23), so the refusal's stated cause — "parts 1/4 and 3/4 are still under `## Planned` (not landed)" — no longer holds. The plan's remaining gate is the week of post-reviewer-plan `check_wait` data the approach requires, which cannot exist before ~2026-10-30; the refusal is not lifted here — releasing a Refused note is an operator/director call — but the record is corrected so the real gate (the data week, not the parts) is what blocks.**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; split 2026-10-25 by the plan role — the gate-scope narrowing moved to part 3m/3, then split again the same day after feature held it too large (held 6): the migration of the pre-merge reviewer's merge-verify and pipeline/runner/e2e cases moved to parts 3n/3 and 3o/3, so this part now requires parts 3g/3, 3l/3, 3n/3 and 3o/3 landed — 3g/3's universal post-landing review and 3l/3's review-suite retirement are on main, and 3n/3/3o/3 must retire the remaining reviewer-run cases before the run they assert goes; touches src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts)

**Previously held 6**

**Goal.** `reviewAheadOfMain` (src/review/review.ts) stops running the pre-merge model reviewer: after the deterministic diff rules, the exempt check and the build pre-check it approves, so every merged change is judged once, by the post-landing review (part 3g/3). This part keeps the gate's five deterministic rules as they are and leaves the reviewer's retry/overlap seams in place; part 3m/3 narrows the gate's rule scope, and the reviewer's remaining plumbing goes with review-run.ts/review-followup.ts. After this part lands, no diff starts a pi reviewer run.

**Approach.**
- `reviewAttempt` (src/review/review.ts): once `gateBuildPrecheck` returns a passing pre-check, set `state.lastApprovedHead = head`, clear `state.reviewResume` and return `{ decision: "approved", verifiedHead: retry.pre.verifiedHead }` — today's `review.afterMerge` branch, now the only continuation. The `afterMerge` (`reviewedAfterMerge`) and `patchApproved` (`patchId`/`approvedPatchIds`) approvals, the overlap helpers (`leaseCheckSlot`, `startOverlappedCheck`, and the `SlotLeaseHandle` import), the `keep`/`settleFailedCheck` helpers, the `runReviewer` call and the `restoreReviewedHead`/`withRuns` import go. Keep `CheckOverlap` and `ReviewRetry` exported — review-run.ts still imports both. The build pre-check now always runs in the change's own slot. `review-run.ts` and `review-followup.ts` stay compiling and unreferenced.
- Keep `reviewAheadOfMain`'s one-attempt-per-loop shape and `reviewAttempt`'s `retry` argument: `retryable` is never set, so the loop returns the first result. Leave the `GateResult.run`/`followUpRun`/`nudgeRun`/`retryable` fields and the `ReviewContext.leaseCheckSlot`/`reviewHeld`/`retries`/`retryDelayMs`/`foldUsage` members in place — this part removes only what `noUnusedLocals` rejects, and the remaining reviewer seams go with review-run.ts/review-followup.ts.
- Keep the `reject` path's bookkeeping, the exempt path and `gateBuildPrecheck`'s behavior unchanged.
- docs/how-it-works.md: the **Review.** paragraph says the pre-merge gate is deterministic (the diff rules, the exempt fast path and the build pre-check) and every merge is judged once after landing, by the post-landing review; the `review.afterMerge` bullet's "A role listed in `review.afterMerge` is reviewed after merging … then merges with no reviewer run" becomes true of every role pending part 3d/3's key deletion.

**Files touched.** src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- `reviewAheadOfMain` starts no pi reviewer run: a healthy code change reaches `{ decision: "approved" }` with `state.lastApprovedHead === head` and the pi-run marker absent.
- A diff with a secret leak, a brief-block edit, a protected edit or a conflict marker still rejects with that reason; an exempt (md-only) diff still returns `exempt`; the build pre-check still rejects as before.
- `npm run test:gate` passes.

**Tests.**
- Part 3l/3 has retired the reviewer cases in both files; re-point only the kept cases the source change touches.
- test/review.test.ts: re-point `gate fails closed on an aborted run without bookkeeping` off its fake reviewer run (`a shutdown during a failing pre-check fails closed` in test/review-precheck.test.ts already covers the abort path) while keeping its assertions that the commit stays and no bookkeeping is written. The deterministic-rule, exempt, already-approved and no-op cases pass unchanged; no case references `runReviewer`, and the `reviewRetryDelayMs` case stays until the reviewer seams go with review-run.ts.
- test/review-precheck.test.ts: add `a green pre-check approves with no reviewer run` — a healthy build returns `{ decision: "approved" }`, `state.lastApprovedHead` is set, and the pi-run marker is absent.
- The existing `gateBuildPrecheck` and exempt-path cases still pass.

### Every commit is verified on main, part 3i/3: the reviewer-provider holds defer only the post-landing review — no role start, verify or landing waits on the reviewer, and the `review.afterMerge` scheduling exemptions go (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3h/3 landed, since no pre-merge reviewer remains to be held; touches src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-scope.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-run.ts docs/how-it-works.md test/orchestrator-scheduling.test.ts test/runner-recovery.test.ts test/runner-leftover-recovery.test.ts)

**Previously held 3**

**Goal.** With every change reviewed after landing (parts 3g/3–3h/3), a held reviewer provider or unresolvable strong tier parks the review queue, not the team: no role start, merge-queue verify or landing waits on the reviewer. The `review.afterMerge` exemptions that existed only to let such a role keep merging go, and the queued-change interlock relief applies to every role.

**Approach.**
- src/orchestrator/scheduling-skip.ts: drop the `reviewHeld && !afterMergeRoles.has(...)` leg and the `afterMergeRoles`/`isAfterMergeRole` inputs; the queued-role interlock relief drops its `isAfterMergeRole` test, so a queued role falls through to author unless it is in a held stage (`interlockedHold`).
- src/orchestrator/scheduling-scope.ts: remove the `afterMergeRoles` field from `SchedulingScope` and its destructuring; `budgetHolds` drops the `reviewStrongPaused` disjunct; `buildSchedulingScope`'s `interlockedHold` walk drops its `isAfterMergeRole` continue.
- src/orchestrator/orchestrator-scheduling.ts: remove `reviewStrongPaused` from `DeferralInputs` and its computation when no reader remains, with its comment.
- src/orchestrator/orchestrator-poll.ts: `mergeStartHeld(held, reviewHeld, role?)` drops `afterMergeRoles` and keeps `reviewHeld` only for the role-less call, so `drainPostReviews` (which calls `startHeld()` with no role) stays parked while `merge-verify.ts`'s `startHeld(entry.role)` and every landing proceed. Remove the two `afterMergeRoles` Sets and simplify the role-start `startHeld` to the restart/disk case plus the role's own provider hold.
- src/runner/runner-run.ts: the `already_queued` recovery arm falls through to authoring for every role (drop the `reviewedAfterMerge(ctx.config, ctx.role)` test and its import), as the interlock relief now applies team-wide.
- docs/how-it-works.md's reviewer-hold paragraph (the "roles a pre-merge review gates are held … a role on `review.afterMerge` is not" sentence) says the hold parks only the post-merge review queue. Comments naming `review.afterMerge` as the exempt set in these files are reworded.

**Files touched.** src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-scope.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-run.ts docs/how-it-works.md test/orchestrator-scheduling.test.ts test/runner-recovery.test.ts test/runner-leftover-recovery.test.ts

**Acceptance criteria.**
- While the reviewer's provider is held or the strong tier is unresolvable, every role starts and every queued change verifies and merges; only `drainPostReviews` is parked, and it resumes when the hold lifts.
- A role with an `already_queued` recovery authors on current main instead of ending, with no `review.afterMerge` membership test.
- `npm run test:gate` passes.

**Tests.**
- test/orchestrator-scheduling.test.ts: `a held reviewer parks only the post-review drain` — a role's run is admitted and its merge starts while `reviewHeld` stands, and the post-review drain does not start.
- test/runner-recovery.test.ts / test/runner-leftover-recovery.test.ts: an `already_queued` recovery from a role not in `review.afterMerge` authors.

### Every commit is verified on main, part 3j/3: the permanent reviewer-config hold `mergeReviewError` is deleted (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3i/3 landed, since with no pre-merge reviewer no selector can fail there and this removal takes its last consumers; touches src/merge/merge-core.ts src/runner/leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/leftover.test.ts test/runner-state.test.ts)

**Previously held 3**

**Goal.** `RunnerState.mergeReviewError` held a merge pin when the pre-merge reviewer failed permanently on a bad model selector. Part 3h/3 removed the pre-merge reviewer, so `gate.configError` can no longer be set and the hold can never be produced; delete it and every reader.

**Approach.**
- src/merge/merge-core.ts: drop the `state.mergeReviewError = {...}` write on a `configError`, its two clears (in `discardPin` and on the approved path) and the `modelSelectorField`/`reviewRunConfig` reads that fed it.
- src/runner/leftover.ts: delete `reviewHold`, the `mergeReviewError` field on `LeftoverContext` and `pinnedRetrySha`'s state pick, and the two `reviewHold` read branches; recovery never reports `held` for a reviewer config.
- src/runner/runner-run.ts: drop the `mergeReviewError` read/clear beside the review selector and its state hand-back.
- src/runner/runner-state.ts: delete the `mergeReviewError?` field; src/run/run-apply.ts drops its `changeGone` clear. Keep the legacy `landingReviewError` read in runner-state-load.ts (old state files still name the key) and note it now loads into nothing.
- Delete the `mergeReviewError` cases and fixtures from the tests.

**Files touched.** src/merge/merge-core.ts src/runner/leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/leftover.test.ts test/runner-state.test.ts

**Acceptance criteria.**
- `mergeReviewError` is absent from `RunnerState` and from every read/write; a pin is never held for a reviewer selector, and recovery re-queues it as any other pin.
- An old state file carrying `mergeReviewError` still loads (the legacy key is ignored).
- `npm run test:gate` passes.

**Tests.**
- test/leftover.test.ts: `a pin is never held by a reviewer config` — a state carrying the legacy field still re-queues its pin.
- test/runner-state.test.ts: `mergeReviewError is gone` — the field no longer exists and a legacy state file loads.

### Every commit is verified on main, part 3d/3: `review.afterMerge` and every surface that sets or shows it are deleted (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3j/3 landed, since the key no longer changes behavior; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts src/config/config.ts src/review/post-merge-review.ts src/cli/cli-role-command.ts src/cli/help.ts src/roles/role-view.ts src/roles/role-render.ts src/gui/gui-config-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-drawer-config.ts src/ui/gui/gui-client-boot.ts docs/config.md docs/cli.md test/config.test.ts test/role-view.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts)

**Previously held 2**

**Goal.** With every role reviewed after landing (parts 3g/3–3j/3), `review.afterMerge` no longer chooses anything: it is a knob that would move a role between two paths that are now the same. Delete it and the three ways it is set and shown, so the record has one review policy.

**Approach.**
- Remove the key: `REVIEW_KEYS` and the `afterMerge` field in `config-schema.ts`, the naming check in `config-validation.ts`, `reviewedAfterMerge` in `config-views.ts`, `isAfterMergeRole` in `post-merge-review.ts`, the default in `config.ts`, and docs/config.md. An old config carrying it still loads (the path every removed key takes).
- Delete the write surfaces: `tumwater role <id> --review-after-merge`/`--clear-review-after-merge` (`cli-role-command.ts`, `src/cli/help.ts`), the `/api/role-review-after-merge` route and `handleRoleReviewAfterMerge` (`gui-config-commands.ts`, `gui-server.ts`) and the dashboard role drawer toggle with its `runAct` chain (`gui-client-drawer-config.ts`, `gui-client-boot.ts`).
- Delete the read/display surfaces: `role-view.ts`'s `reviewedAfterMerge` field and `role-render.ts`'s row.
- Update docs/cli.md and docs/config.md so no surface names the flag, key or toggle.

**Files touched.** src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts src/config/config.ts src/review/post-merge-review.ts src/cli/cli-role-command.ts src/cli/help.ts src/roles/role-view.ts src/roles/role-render.ts src/gui/gui-config-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-drawer-config.ts src/ui/gui/gui-client-boot.ts docs/config.md docs/cli.md test/config.test.ts test/role-view.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts

**Acceptance criteria.**
- `review.afterMerge` is absent from the schema, a rendered default config, `tumwater config`'s listing and docs; an old config carrying it still loads.
- `tumwater role <id> --review-after-merge`/`--clear-review-after-merge`, the `/api/role-review-after-merge` route and the dashboard drawer toggle no longer exist; `tumwater role <id>` prints no review-after-merge row.
- `npm run test:gate` passes.

**Tests.**
- test/config.test.ts: `review.afterMerge is gone` — absent from the schema, the default and the listing, while an old config still loads.
- test/role-view.test.ts / test/gui-endpoints.test.ts / test/gui-client-drawer.test.ts: drop the review-after-merge cases; assert the flags and route are unknown and the drawer renders no toggle.

### Every commit is verified on main, part 3e/3: the pre-merge reviewer plumbing is deleted — `review-run.ts`, `review-followup.ts` and the review resume state (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3j/3 landed, since nothing calls the reviewer once every role is reviewed after landing; touches src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/request-timeouts.ts docs/how-it-works.md test/review.test.ts)

**Previously held 2**

**Goal.** Parts 3g/3–3j/3 leave the pre-merge reviewer unreferenced; delete it so the gate is one thing and no reviewer prompt, resume session or retry budget lingers.

**Approach.**
- Delete `src/review/review-followup.ts` and `src/review/review-run.ts`. `review.ts` keeps the deterministic rules and build pre-check and builds its `GateResult` without `runReviewer`, `withRuns` and `restoreReviewedHead`; the small helpers it still needs (`reject`/`keep`, the pi-run fields) move into `review.ts` when a reader remains.
- Delete the reviewer resume machinery from `RunnerState` (`reviewResume`, and `REVIEW_RESUME_LIMIT`/`APPROVED_PATCH_IDS_MAX`/`approvedPatchIds` when the deterministic dedupe no longer reads the patch ids) and its healing in `runner-state-load.ts`; keep `lastApprovedHead` while the deterministic same-head dedupe uses it.
- Delete `buildReviewResumePrompt` and the reviewer-only parts of `buildReviewPrompt` from `src/prompt/gate-prompts.ts`; `buildReviewPrompt` stays because `post-merge-review.ts` reads it.
- Drop the `review-followup.ts` mention from `src/request-timeouts.ts`'s comment and update docs/how-it-works.md's review paragraph to name the one post-landing review.

**Files touched.** src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/request-timeouts.ts docs/how-it-works.md test/review.test.ts

**Acceptance criteria.**
- `review-run.ts` and `review-followup.ts` no longer exist; no code imports them, and no reviewer prompt, resume session or no-rerun nudge remains.
- The gate still runs its deterministic rules and build pre-check and returns the same verdicts part 3h/3 established.
- `npm run test:gate` passes.

**Tests.**
- test/review.test.ts: the part 3h/3 deterministic cases still pass with the reviewer files gone; no case imports a review-run/review-followup symbol.

### Every commit is verified on main, part 3f/3: the merge slot runs no in-lock gate check and no batch check — a merge is a rebase and a fast-forward (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3e/3 landed, since the gate-scope checks lose their producers once the pre-merge reviewer is gone; touches src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts)

**Previously held 2**

**Goal.** With the watch verifying every new tip, the checks that stood in front of a landing are redundant. Delete the merge slot's in-lock build re-check and the batch check with its largest-passing-prefix bisect, so a merge is: rebase onto the tip, take the fast-forward under the merge lock. A broken commit then sits on main between its landing and the watch's fix, which is the `ci` healer's job.

**Approach.**
- Delete the in-lock re-check from `mergeApprovedChange` (src/merge/merge-to-main.ts): the `runScopedBuildCheck`/`mergeCommand` run and its `merge_blocked` cause. The fast-forward, the conflict resolver, the dirty-checkout refusal and the `MERGE_CONFLICT_LIMIT` hand-back stay (a conflicted tree cannot be landed).
- Delete the batch path from `mergeApproved` (src/merge/merge-batch.ts): the shared scope-`batch` check, its `BATCH_RESTACK_ATTEMPTS` re-stack and its per-pick bisect/fallback, and whatever in `merge-stack.ts` only that path used. Every approved change merges one at a time through the now-check-free `mergeApprovedChange`.
- The gate-scope check producers go: `review-precheck.ts`'s build-check reject and `merge-check-failures.ts`'s `merge_blocked`/`review_rejected` attribution lose their callers; the merge-side `main_red` keep (`merge-core.ts`), `requeueMainRedPin`'s wait (`merge-requeue.ts`) and leftover's `main_red` wait go with the in-lock verdict that produced them.
- With no producer left, remove the merge verdict `main_red`: `heldByMainRed` and `mainCheckRecovered` (`src/status/status-polls.ts`), the status phase's `main red` label (`src/ui/status-model.ts`) and the doctor's held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`) go; the red-main warning that names an unheld red stays.
- Keep the two rules part 3h/3 left pre-merge (secret leaks and protected edits) and the refusals that are not quality verdicts: the dirty-checkout pre-flight (`merge-to-main.ts`), a rebase conflict and its hand-back, a lost fast-forward race, and the startup/redeploy stage check.
- Docs: docs/how-it-works.md's merge paragraph says a merge is a rebase and a fast-forward; docs/invariants.md's merge-check guarantees are re-pointed to the watch.

**Files touched.** src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts

**Acceptance criteria.**
- A merge runs no build check: the merge slot's per-change work is the rebase, the commit and the fast-forward, and the only pre-merge refusals left are a dirty or conflicted tree, a secret leak and a protected edit.
- `mergeApproved` has no batch/stack/bisect path; every approved change is merged through the one-change `mergeApprovedChange`.
- No run or merge verdict is `main_red`; the status `main red` label and the doctor's held-code-role list are gone, while the red-main warning stays.
- `npm run test:gate` passes.

**Tests.**
- test/merge-to-main.test.ts: `a merge runs no gate command` — with a declared check, no build-check run starts and the fast-forward lands; the dirty-checkout and conflict cases stay.
- test/main-red.test.ts: `heldByMainRed is gone` — no code role is reported held by main's redness, and the unheld red warning still renders.
- test/merge-verify.test.ts: the batch/stack cases are dropped; one-change merges still land.

### The TUI Transcript view edits the viewed role's provider and thinking overrides with `Ctrl+U` and `Ctrl+K`, completing the terminal twins of the dashboard role drawer's Model overrides triple and `tumwater role <id> --provider`/`--thinking` (planned 2026-10-24 by the plan role; independent in behavior of every eligible plan — the in-flight TUI Health `Ctrl+S` plan (broken-pin drop) and TUI Health `Ctrl+V` plan (role enable/disable) both add fields to src/ui/tui/tui-editor-session.ts, tui-editors.ts, tui-keys.ts, tui-frame.ts, tui.tsx and docs/cli.md at neighbouring symbols, table rows and interface members this plan also touches, so whichever lands second rebases there, and neither touches tui-editor-role-key.ts nor this plan's two new editor modules; the blocked `Forward, never back` part 3b/6 and `A post-merge rejection stops reverting` part 3/3 edit src/ui/tui/tui-pane-pending.ts and test/tui-keys.test.ts at blocks this plan does not touch; touches src/ui/tui/tui-editor-role-thinking.ts (new) src/ui/tui/tui-editor-role-provider.ts (new) src/ui/tui/tui-editor-role-key.ts src/ui/tui/tui-editor-session.ts src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/tui/tui.tsx src/ui/tui/tui-pane-ctx.ts src/ui/tui/tui-pane-transcript.ts docs/cli.md test/tui-role-thinking.test.ts (new) test/tui-role-provider.test.ts (new))

**Refused 2026-10-24 by feature: the assigned Ctrl+U/Ctrl+K are the TUI's global readline line-editing keys (tui-input.ts applyKey: Ctrl+U kills from line start to cursor, Ctrl+K kills to line end), used by the budget/notes/search editors and the plain prompt line to edit a held line on a Transcript, so claiming them on every Transcript as this plan's model editor pattern does (editorEntryDenied steals the key and flashes the holder's subject even while another editor holds the line) breaks the budget, notes, and search editor tests' Ctrl+U line-clear; keeping those requires a special-cased fall-through deviation from the plan's stated mutual-exclusion contract that makes the new editors inconsistent with their createRoleModelEditor twin. The plan's files-touched/test list does not account for the three affected editors.**

**Goal.** `tumwater role <id>` writes the whole model triple (`--provider`/`--model`/`--thinking`, with `--clear-*`; src/cli/cli-role-command.ts), and the dashboard role drawer edits all three in its one `Model overrides` row (all three reach the shared `setRoleModelFields`, src/config/config-write.ts, through `/api/role-model`). The TUI's Transcript view edits only the middle field: `Ctrl+X` writes `roles.<base>.model` through the same `setRoleModelFields`, but `grep -rn 'rawRoleField(.*"provider"\|rawRoleField(.*"thinking"' src/ui/tui` matches nothing, so the terminal operator cannot set the two fields the drawer's triple and the CLI both expose. Add both editors on a role's Transcript view — `Ctrl+U` for the provider override and `Ctrl+K` for the thinking level — modelled on the existing role-pinned editors and writing through the same shared `setRoleModelFields` the CLI and drawer use.

**Approach.**
- `src/ui/tui/tui-editor-role-thinking.ts` (new) — `createRoleThinkingEditor(session): TuiEditorModule`, a `createRoleKeyEditor` spec: `mode: "roleThinking"`, `openCtrl: "k"`, `prefill: (s, base) => { const v = rawRoleField(s.root, base, "thinking"); return typeof v === "string" ? v : ""; }`, `commit: (s, base, text) => setRoleModelFields(s.root, base, { thinking: text })`, an open flash naming the seven levels and empty-clears, and `${role}: thinking override set to ${text}` / `${role}: thinking override cleared` saves — mirroring `createRoleModelEditor` (tui-editor-role-model.ts) line for line. `checkModelTripleField` (modelShape `"tier-name"`) owns the level's truth, so a typo flashes its message and the editor stays open.
- `src/ui/tui/tui-editor-role-provider.ts` (new) — `createRoleProviderEditor(session)` with `mode: "roleProvider"`, `openCtrl: "u"`, prefill `rawRoleField(..., "provider")`, commit `setRoleModelFields(s.root, base, { provider: text })`, and the provider set/cleared flashes. Same shape; `rawRoleField` and `setRoleModelFields` are the imports the model editor already uses.
- `src/ui/tui/tui-editor-role-key.ts` — widen `RoleKeySpec["mode"]` from `"roleModel" | "instances"` to add `"roleThinking" | "roleProvider"`.
- `src/ui/tui/tui-editor-session.ts` — add `roleThinking: boolean` and `roleProvider: boolean` to `TuiHeld` (beside `roleModel`), add `"roleThinking" | "roleProvider"` to the `EditorEnterKey` union, add `["roleThinking", "role thinking edit"]` and `["roleProvider", "role provider edit"]` to `HOLDER_SUBJECTS`, and initialize both `false` in `createTuiEditorSession`'s `held` literal. `heldEditorFlash`/`anyEditorHeld`/`editorEntryDenied` iterate that registry, so the mutual-exclusion contract needs no other change.
- `src/ui/tui/tui-editors.ts` — import `createRoleThinkingEditor` and `createRoleProviderEditor`, append both to the `editors` array (beside `createRoleModelEditor`), add `roleThinkingMode: boolean` and `roleProviderMode: boolean` to the `TuiEditorState` interface (beside `roleModelMode`), and return `roleThinkingMode: session.held.roleThinking, roleProviderMode: session.held.roleProvider` from `state()`.
- `src/ui/tui/tui-keys.ts` — add `roleThinkingMode: boolean` and `roleProviderMode: boolean` to `TuiKeysState` (beside `roleModelMode`); its `state()` already spreads `editors.state()`.
- `src/ui/tui/tui-frame.ts` — add `roleThinkingMode?: boolean` and `roleProviderMode?: boolean` to `TuiMode`; add the two `else if (mode.roleThinkingMode)` / `else if (mode.roleProviderMode)` hint branches beside the `roleModelMode` branch (`[Enter, "save role thinking"]` and `[Enter, "save role provider"]`); add `if (mode.roleThinkingMode) return [{ text: "role thinking", tone: "brand" }, { text: " › " }];` and the `role provider` twin to `promptPrefix` beside the `role model` line; and add `["Ctrl+U", "role provider"]` and `["Ctrl+K", "role thinking"]` to the `view.kind === "transcript"` line in `hintLine`.
- `src/ui/tui/tui.tsx` — add `roleThinkingMode: s.roleThinkingMode, roleProviderMode: s.roleProviderMode` to the `mode` object built from `keys.state()` (the frame's hint/prefix input).
- `src/ui/tui/tui-pane-ctx.ts` — add `roleThinkingMode: boolean` and `roleProviderMode: boolean` to `TuiPaneEditorState` (beside `roleModelMode`) and add `!es.roleThinkingMode && !es.roleProviderMode` to `promptLineFree`'s conjunction, so every pane arm's guard and the shared `/`-search guard restate the two new holders; `editors.state()` already returns both flags, so this interface is what lets the pane modules read them under `tsc`.
- `src/ui/tui/tui-pane-transcript.ts` — extend the `Ctrl+N` arm's explicit editor-flag guard (the `ctx.es.budgetMode || ctx.es.rolePromptFor || … || ctx.es.instructionsEditFor` list) with `ctx.es.roleThinkingMode || ctx.es.roleProviderMode` beside `ctx.es.roleModelMode`, so the notes/change cycle keeps its mutual-exclusion contract while either editor is open; the `Ctrl+Y` and `Ctrl+X` arms call `promptLineFree(ctx.es)`, so they pick the two flags up with no edit of their own.
- docs/cli.md — in the TUI keys table add a `| Ctrl+U | Transcript | edit the viewed role's provider override (`roles.<base>.provider`, a pi provider name; empty clears it) — the terminal twin of `tumwater role <id> --provider` and the dashboard role drawer's Model overrides provider field (an instance id writes its base role's key) |` row and a `| Ctrl+K | Transcript | edit the viewed role's thinking level (`roles.<base>.thinking`, one of off, minimal, low, medium, high, xhigh, max; empty clears it) — the terminal twin of `tumwater role <id> --thinking` and the dashboard role drawer's Model overrides thinking field (an instance id writes its base role's key) |` row, and extend the Check-state row's model-triple clause (which already names the drawer and `--provider`/`--thinking`) to name the TUI Transcript's `Ctrl+U`/`Ctrl+K` beside them. Insert the two clauses directly after the existing `(Ctrl+X) edits or clears the role's model override, writing `roles.<base>.model` for the base id (a model id or tier name like `strong`; empty clears it)` clause and before its `—and the TUI's notes view (Ctrl+N) clears them` tail: append rather than reflow, leave the Ctrl+X clause's text untouched, keep the parenthetical balanced, and keep the row's closing `|`.
- No change to `setRoleModelFields`, the CLI flags, the dashboard drawer or its `/api/role-model` route, and no new pane arm or routing in src/ui/tui/tui-panes.ts: the editors claim `Ctrl+U`/`Ctrl+K` before the panes and only on a role's Transcript (view 1..roleIds.length), so off it `Ctrl+U` keeps its Activity declared-check and Health re-sync-install meanings and `Ctrl+K` its Activity check-cap and Health orphan-kill meanings.

**Files touched.** src/ui/tui/tui-editor-role-thinking.ts (new) src/ui/tui/tui-editor-role-provider.ts (new) src/ui/tui/tui-editor-role-key.ts src/ui/tui/tui-editor-session.ts src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/tui/tui.tsx src/ui/tui/tui-pane-ctx.ts src/ui/tui/tui-pane-transcript.ts docs/cli.md test/tui-role-thinking.test.ts (new) test/tui-role-provider.test.ts (new)

**Acceptance criteria.**
- On a role's Transcript view, `Ctrl+U` opens the provider editor pre-filled with the FILE's raw `roles.<base>.provider` (empty when unset); typing a provider name and Enter writes `roles.<base>.provider` through `setRoleModelFields` and flashes `<role>: provider override set to <text>`; an empty or whitespace-only line clears it and flashes `<role>: provider override cleared`.
- On a role's Transcript view, `Ctrl+K` opens the thinking editor pre-filled with the FILE's raw `roles.<base>.thinking`; a valid level writes `roles.<base>.thinking` and flashes `<role>: thinking override set to <level>`; an invalid level flashes `checkModelTripleField`'s message naming `roles.<base>.thinking` and the editor stays open; an empty line clears it.
- An instance id (`feature-2`) writes its base role's key (`roles.feature.provider`/`roles.feature.thinking`), since the factory passes `baseRoleOf(role)` to the commit.
- Opening either while another prompt-line editor holds the line flashes that holder's subject and opens nothing; Esc, the same Ctrl again and `Ctrl+T` exit by restoring the prompt draft, and the prompt line shows the `role provider ›`/`role thinking ›` label while open.
- `Ctrl+U` off the Transcript keeps its Activity declared-check and Health re-sync-install meanings; `Ctrl+K` off the Transcript keeps its Activity check-cap and Health orphan-kill meanings; the Transcript's `Ctrl+X` model, `Ctrl+G` instances, `Ctrl+O` quiet and `Ctrl+S` interval arms are unchanged.
- docs/cli.md's TUI keys table names the Transcript `Ctrl+U` and `Ctrl+K` bindings; the Check-state row's existing `(Ctrl+X) edits or clears the role's model override, writing `roles.<base>.model` for the base id (a model id or tier name like `strong`; empty clears it)` clause still reads as it did, the two new clauses sit between it and the `—and the TUI's notes view (Ctrl+N) clears them` tail, and the row's parenthetical and closing `|` are balanced.
- The change stays within this plan's Files-touched list: it carries no edit from the `Every commit is verified on main` series (in particular none to `src/doctor/doctor-holds.ts`) and does not edit PLANS-DONE.md.
- `npm run test:gate` passes.

**Tests.**
- test/tui-role-thinking.test.ts (new), driven like test/tui-role-model.test.ts through `makeTuiRepo`/`withTui`: seed `roles.clean.thinking: "low"`, enter the clean role's Transcript, press `Ctrl+K`, assert the line pre-fills `low` and the footer reads `save role thinking`, type `high`, press Enter, and assert the frame flashes `clean: thinking override set to high` and `readJson(tumwater.json).roles.clean.thinking === "high"`; a second case types `hgih` and asserts the frame carries `thinking must be one of off, minimal, low, medium, high, xhigh, max` with the file byte-identical; a third clears with an empty line and asserts `clean: thinking override cleared` and the key removed; a fourth asserts Esc and `Ctrl+T` restore a draft prompt.
- test/tui-role-provider.test.ts (new): seed `roles.clean.provider: "anthropic"`, enter the clean role's Transcript, press `Ctrl+U`, assert the pre-fill and `save role provider`, type `openai`, press Enter, and assert `clean: provider override set to openai` with `roles.clean.provider === "openai"`; an empty line clears it; a unit case asserts `feature-2` writes `roles.feature.provider`; a mutual-exclusion case asserts `Ctrl+U` on the Activity view keeps the declared-check editor (it does not open the provider editor).

### Every commit is verified on main, part 3m/3: the pre-merge gate's deterministic rule set narrows to the three findings a later commit cannot repair (planned 2026-10-25 by the plan role, split from the too-large part 3h/3; requires part 3h/3 landed, since with no pre-merge reviewer the narrowed gate scope is what sends the three repairable findings to the main watch alone; touches src/review/diff-rules.ts src/review/review.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/review.test.ts test/review-precheck.test.ts)

**Previously held 5**

**Goal.** With the pre-merge reviewer gone (part 3h/3), the gate's deterministic rules are the only pre-merge rejections. Three of the five mark a defect a later commit can repair — a conflict marker (`conflictMarkerReason`), a false fix claim on an exempt diff (`falseFixReason`) and a broken backlog structure (`backlogStructureReason`) — so they stop refusing a diff pre-merge; the main watch still reports each on main's tip. The gate keeps the three a later commit cannot repair: a brief-block edit (`briefEditReason`), a protected edit (`protectedEditReason`) and a leaked credential (`secretLeakReason`).

**Approach.**
- src/review/diff-rules.ts: `diffRuleReasons` gains a final `scope: "gate" | "watch"` argument and declares in one place which rules each scope runs, and in what order. `"watch"` runs all five in today's order (conflict marker, brief, protected, secret, false fix when `exempt`, backlog structure); `"gate"` runs only brief, protected and secret. The function still short-circuits on the first finding within the chosen scope. Extend its doc comment to name both scopes and that the watch runs the full set.
- src/review/review.ts passes `"gate"` at the `diffRuleReasons` call site; src/baseline/main-watch.ts passes `"watch"`. Those are the only two call sites.
- docs/how-it-works.md, the **Review.** paragraph: the pre-merge gate rejects the brief-block, protected-edit and secret-leak changes; a conflict marker, a false fix claim and a broken backlog structure are reported by the main watch after they land.
- docs/invariants.md, "The merge gate's deterministic rejections": INV-G3 moves its pre-merge guarantee to the stage check and the main watch (the gate no longer rejects conflict markers; the read-error fail-closed behavior stays pinned through `conflictMarkerReason`'s own tests and the stage check); the section intro's "runs the same deterministic diff rules on main's new tip after it lands, in the gate's own order and scope" says the watch runs the full set while the gate runs the three unrepairable rules. INV-G1 (brief/protected) and INV-G2 (secret) are unchanged.

**Files touched.** src/review/diff-rules.ts src/review/review.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/review.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- The gate approves a change whose only finding is a conflict marker, a false fix claim or a broken backlog structure; it still rejects on a brief-block edit, a protected edit or a leaked credential.
- The main watch still reports all five: a main tip carrying a conflict marker, a false fix claim or a broken backlog structure logs the same `main's tip <sha> fails the diff rules: <reason>` warning as today.
- `grep -n 'diffRuleReasons' src` shows the two call sites only, each passing a literal scope (`"gate"` in review.ts, `"watch"` in main-watch.ts).
- `npm run test:gate` passes.

**Tests.**
- test/review-precheck.test.ts: give every `diffRuleReasons` call in `diffRuleReasons returns the gate's rules in order` a scope argument, keeping the full-order assertions on `"watch"`, and add `the gate scope runs only the three unrepairable rules` — under `"gate"` an exempt diff with a conflict marker and a false fix claim returns `[]` while `"watch"` returns the conflict-marker reason; a brief-block edit and a secret leak are found under both scopes.
- test/review.test.ts: re-point `gate rejects a change that still holds conflict markers, with no pi run` and `gate rejects an md-only diff that files a new plan directly under ## Done, with no pi run` to assert the gate now approves or exempts them and the main watch reports them (its conflict-marker cases live in test/main-watch.test.ts). The protected-edit, secret-leak, exempt and already-approved cases pass unchanged.
- The fail-closed read-error guarantee stays covered by test/merge-git.test.ts's `conflictMarkerReason` read-error case and the stage check (`test/stage-check.test.ts`).

### Every commit is verified on main, part 3n/3: the pre-merge reviewer's merge-verify cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3h/3 after feature held it (held 6); independent in files of part 3o/3, which takes the pipeline/runner/e2e suites, and holds no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/merger.test.ts test/merger-restack.test.ts test/merger-bisect.test.ts test/merge-check-strikes.test.ts test/revision.test.ts test/revision-prior-tags.test.ts test/fixtures/merger-fixtures.ts)

**Previously held 6**

**Needs review 2026-10-25 by feature: too large for one run (held 7)**

**Goal.** Part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes every merge-verify case that pins a reviewer verdict, a reviewer failure or the reviewer's usage fold fail. As part 3l/3 did for `test/review.test.ts` and `test/review-precheck.test.ts` while the reviewer still runs, this part moves those cases first so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In each file named above, find the cases whose subject is the pre-merge reviewer run — the verdicts (`reviewerPi("VERDICT: reject…")`), the failures (`review_error`, `review_failed`, `reviewRetries`, `REVIEW_FAILURE_LIMIT`, `unreviewFailures`), the usage fold (`folded.length`), `state.lastReview?.verdict`, the pre-merge `review_start` count, and the `reviewing` merge stage a reviewer run sets — and either (a) delete the case when it exists only to pin the reviewer, or (b) re-point its rejection trigger to a deterministic gate rejection (a `diffRuleReasons` finding such as a conflict-marker diff or a leaked credential, or a failing declared check) when its real subject is the merge/verify/stack/revision bookkeeping that survives. Leave the reviewer-run helpers (`reviewerPi`, `APPROVE_PI`) in `test/fixtures/pi-events.ts`/`merger-fixtures.ts` in place: the reviewer still runs until part 3h/3, and part 3e/3 deletes the helpers with the plumbing. Do not change the fixture's `ROLE`/`makeCtx`/`pinnedFixture` shape beyond what a re-point needs.

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the named files for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer (queue/state cases that never start a reviewer and post-landing-review cases are fine).
- Every case that remains keeps its original subject (merge, verify, stack or revision bookkeeping) and asserts the same outcome through a deterministic rejection.
- No edit falls outside this part's Files-touched list.

**Files touched.** test/merger.test.ts test/merger-restack.test.ts test/merger-bisect.test.ts test/merge-check-strikes.test.ts test/revision.test.ts test/revision-prior-tags.test.ts test/fixtures/merger-fixtures.ts

### Every commit is verified on main, part 3o/3: the pre-merge reviewer's pipeline, runner and e2e cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3h/3 after feature held it (held 6); independent in files of part 3n/3, which takes the merge-verify suites, and holds no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/merge-pipeline.test.ts test/merge-drain-verify.test.ts test/runner.test.ts test/runner-leftover-recovery.test.ts test/orchestrator-3.e2e.test.ts test/orchestrator-mixed.e2e.test.ts test/orchestrator-director.test.ts)

**Previously held 6**

**Needs review 2026-10-25 by feature: too large for one run (held 7).** The migration spans seven test files and two dozen reviewer-dependent cases, several of them deep semantic re-points that must stay green while the reviewer still runs and then survive its removal — the merging-pipeline's `reviewing`-stage sequencing and stack-check `review_start` count, runner-leftover-recovery's `review_error`/`review_failed`/strike-cap recovery path, the orchestrator e2e's held/hanging reviewer runs and per-seam model assertions, and merge-drain-verify's reviewer-held verifications. A partial migration would break the suite. Needs a further split (one file or one theme per part) before it fits a run.

**Goal.** The pipeline, runner and orchestrator twin of part 3n/3: retire or re-point their pre-merge reviewer cases so part 3h/3's source switch breaks no test there.

**Approach.** Apply part 3n/3's rule to the named files: delete a case that exists only to pin a reviewer verdict, failure or usage fold; re-point one whose real subject is pipeline/runner scheduling to a deterministic gate rejection (a conflict-marker diff or a failing declared check). In `test/merge-pipeline.test.ts` the per-change `review_start` count (`afterMerge !== true`) and the `reviewing`-stage sequencing move to the post-landing review's own `review_start` (`afterMerge: true`) or to the pre-check stage; `mergeStartHeld`'s reviewer-hold scoping case stays, since part 3i/3 owns its removal. In `test/runner.test.ts` the `review_start` model-recording pair re-points to the surviving post-landing review, or is deleted if that path does not carry the reviewer's model. In `test/orchestrator-director.test.ts` the case that sets `review.afterMerge: []` to hold a merge on a pre-merge review re-points to a deterministic rejection or is deleted. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the named files for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- `review_start` assertions in `test/merge-pipeline.test.ts`, `test/runner.test.ts` and the two orchestrator e2e files name only post-landing (`afterMerge: true`) reviewer runs or survive as flow assertions that do not count a pre-merge run.
- No edit falls outside this part's Files-touched list.

**Files touched.** test/merge-pipeline.test.ts test/merge-drain-verify.test.ts test/runner.test.ts test/runner-leftover-recovery.test.ts test/orchestrator-3.e2e.test.ts test/orchestrator-mixed.e2e.test.ts test/orchestrator-director.test.ts

### `renderStatusSpans`'s ~260-line status-table assembly is split into one named builder per stage, so a status-table stage is found by name (planned 2026-10-25 by the plan role; independent in files of every eligible plan and blocked part — `grep -n 'src/ui/status-render.ts' PLANS.md` names no `## Planned` entry: the in-flight plans edit src/agent, src/run/run-stage.ts, src/ui/status-payload.ts, src/ui/tui/tui-pane-history.ts, src/ui/tui/tui-panes.ts, src/report/report-data.ts and src/status/status-data.ts, and the blocked `Every commit is verified on main` parts edit `src/ui/status-model.ts` and `src/ui/tui/*` but no part names `src/ui/status-render.ts`; the in-flight `snapshot` plan changes only `status-data.ts`'s private assembly, leaving `StatusSnapshot` and its key order untouched, so `renderStatusSpans` still reads the same snapshot shape; touches src/ui/status-render.ts)

**Goal.** `renderStatusSpans` (`src/ui/status-render.ts`) is one ~260-line function that interleaves several stages: it composes the header badge line, derives each role's metric inputs with `roleRowCells`, builds the per-role table rows and the totals row, fits the columns to `maxWidth`, and formats every line through a local `fmt` closure. A reader asking "where does the `next run` cell get its tone?", "how do columns give way on a narrow terminal?" or "which footnote appears for a shared model?" has only the one body to scan, and the stage has no name to grep. Split it into one module-private builder per stage so a status-table stage is found by name and `renderStatusSpans` becomes the shared locals plus the calls and the line-order pushes. No behavior change: the returned `{ lines, roles }` is byte-identical for the same arguments.

**Approach.** All edits in src/ui/status-render.ts; move code, do not rewrite it, and keep every comment with the code it annotates.
- Make the per-row helpers module-private functions: `statusCell(text: string, tone?: StatusSpan["tone"]): StatusSpan[]` (today's local `cell`), `roleModelLabel(s: RunnerState): string` (today's local `modelInner`), and `queuedPromptMarker(snap: StatusSnapshot, role: string): string` (today's local `roleQueued`).
- Add these module-private builders, each returning exactly what the stage builds today:
  - `statusHeaderLine(root: string, snap: StatusSnapshot, now: number): StatusLine` — the `running` array and the whole first line array (the `name`/badges composition).
  - `statusRowMetrics(root: string, snap: StatusSnapshot): StatusRowMetric[]` — today's `withMetrics` `snap.roles.map` over `roleRowCells`; the anonymous element type becomes a module-private `interface StatusRowMetric { s: RunnerState; m: { generated: number; peakCtx: number }; live: LiveProgress | null; phase: string; role: string; lastRunEndedAt: number | undefined }`.
  - `sharedRoleModel(snap: StatusSnapshot): string | undefined` — today's `inners`/`sharedModel` derivation.
  - `statusRoleRows(root: string, snap: StatusSnapshot, now: number, withMetrics: readonly StatusRowMetric[], sharedModel: string | undefined): StatusSpan[][]` — today's `rows` (`sortRolesByState` map and its name/state/result/next cells).
  - `statusTotalsRow(snap: StatusSnapshot, scoped: boolean, withMetrics: readonly StatusRowMetric[]): StatusSpan[][]` — today's `totalsRow`.
  - `statusColumnWidths(cols: readonly string[], allRows: readonly StatusSpan[][], maxWidth: number | undefined, snap: StatusSnapshot): number[]` — today's `widths` measurement, the `FLEXIBLE_COLUMNS` overflow loop and the name-column floor.
  - `statusLineFormatter(widths: readonly number[]): (r: StatusSpan[][], tone?: StatusSpan["tone"]) => StatusLine` — today's `fmt` closure including the span-wise `trimEnd`.
  - `statusRoleSummaries(withMetrics: readonly StatusRowMetric[]): StatusRoleRow[]`-shaped array — today's `roles` mapping over `withMetrics` (keep the returned element type structural exactly as today).
- `renderStatusSpans` keeps `name`, `lines`, `now`, `cols`, the `separator`, every push (`fmt(cols…)`, rows, totals, the two footnotes) and the final `maxWidth` clip; its body builds no badge array, measures no width and contains no formatting loop of its own.

**Files touched.** src/ui/status-render.ts

**Acceptance criteria.**
- `renderStatusSpans(root, snap, maxWidth, scoped)` returns a deep-equal `{ lines, roles }` to today's for the same arguments: the move changes no cell text, tone, padding, column order or footnote.
- Every stage named above has exactly one module-private builder; `renderStatusSpans`'s body contains no header badge-array push, no `FLEXIBLE_COLUMNS` loop and no `fmt` closure body — only the shared locals, the calls and the line pushes.
- The exported surface is unchanged: `grep -nE '^export ' src/ui/status-render.ts` matches before and after (`renderStatusSpans`, `renderStatus`, `StatusSpan`, `StatusLine`, `lastRunCell`, `lastMergedCell`, `nextRunCell`, `clipSpans`, `toneLine`, `alertLines` keep their signatures), and no import is added or removed.
- `docs/invariants.md` is unchanged: no invariant binds `src/ui/status-render.ts`, so a move changes no guarantee.
- No edit outside src/ui/status-render.ts.

**Tests.** No new test module: a behavior-preserving move guarded by the existing status suites. Run `test/status-render.test.ts`, `test/status-render-cells.test.ts`, `test/status-header.test.ts`, `test/tui-frame.test.ts`, `test/badges.test.ts`, `test/status-payload.test.ts` and `test/cli.test.ts` whole and confirm green (`test/status-render.test.ts` deep-equals the rendered plain text, `test/tui-frame.test.ts` deep-equals the TUI frame, and `test/cli.test.ts` deep-equals its parsed `status` stdout).

### `renderFailureMarkdown`'s ~185-line digest assembly is split into one named section builder per output group, so a failure-digest section is found by name (planned 2026-10-25 by the plan role; independent in files of every eligible plan and blocked part — `grep -n 'src/failure' PLANS.md` matches no `## Planned` entry: the in-flight plans edit src/agent, src/run/run-stage.ts, src/ui/status-payload.ts, src/ui/tui/tui-pane-history.ts, src/ui/tui/tui-panes.ts, src/status/status-data.ts and src/ui/status-render.ts, and the blocked `Every commit is verified on main` parts edit src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/status, src/doctor, src/config, src/cli and src/ui, so none names src/failure/failure-render.ts; the landed 2026-10-25 split of the collector's `assembleFailureReport` in src/failure/failure-data.ts left this render untouched, and the landed 2026-10-25 cut-off cause added only a label arm inside the time-and-spend section this plan extracts; touches src/failure/failure-render.ts)

**Goal.** `renderFailureMarkdown` (`src/failure/failure-render.ts`) is one ~185-line function that assembles every digest section inline: the window/log-state header, the state-change replay, the outcome table, the time-and-spend tables plus loss ranking, the prompt-token telemetry, the deltas table, the five `renderClusters` sections plus the post-merge-rejection line, and the merged list. A reader asking "where does the loss-cause line come from?", "which section reads `mergedTotal`?" or "what prefixes the deltas table?" has only the one body to scan, and a section has no name to grep. Split it into one module-private builder per section so a digest section is found by name and `renderFailureMarkdown` becomes the one `lines` array plus the ordered calls. No behavior change: the returned Markdown is byte-identical for the same `FailureReportData`.

**Approach.** All edits in src/failure/failure-render.ts; move code, do not rewrite it, and keep every comment with the code it annotates. Follow the file's existing convention for a section helper: it takes `lines: string[]` and pushes, the way `renderClusters` already does, so no builder returns a value and the output order is the call order.
- Add these module-private builders between `renderFailureMarkdown` and `renderClusters`, each pushing exactly the lines the corresponding block pushes today, leading blank line included:
  - `pushDigestHeader(lines: string[], data: FailureReportData): void` — the title, the blank line, the bounded/since/day window line, and the `role:` / `logState` / `emptyLog` / `hasEvents` / `partial` lines; it owns the local `bounded` const the empty branch reads, computed from `data.sinceMs`/`untilMs`/`toIso` exactly as today.
  - `pushStateChanges(lines: string[], data: FailureReportData): void` — the `data.stateChanges.length > 0` block, including the scoped-vs-team title and the `+N older transitions hidden` remainder line.
  - `pushOutcomeTable(lines: string[], data: FailureReportData): void` — the `columns(data.outcomes)` call and the `## Outcome by role` `markdownTable` block with its `_no finished runs in the window_` placeholder.
  - `pushTimeAndSpend(lines: string[], data: FailureReportData): void` — the `## Time and spend by outcome` table, the `**Top loss causes by time:**` list and its `lossCausesHidden` remainder line.
  - `pushPromptStats(lines: string[], data: FailureReportData): void` — the conditional `## Prompt tokens by role` loop (no section at all when `data.promptStats` is empty).
  - `pushDeltas(lines: string[], data: FailureReportData): void` — the `## Deltas vs the preceding …` table with its `_no runs in either window_` placeholder.
  - `pushClusterSections(lines: string[], data: FailureReportData): void` — the five `renderClusters` calls in their current order plus the `postMergeRejections > 0` line between the last review/rejection clusters and `Merge failures`.
  - `pushMergedSection(lines: string[], data: FailureReportData): void` — the `## Merged in the window` list and its `+N older merges not listed` remainder line.
- `renderFailureMarkdown` keeps its signature and body shape: `const lines: string[] = [];` then the eight builder calls in the current section order, then `return lines.join("\n");`. It pushes nothing itself and holds no branch, loop or `.map(`.
- A second, smaller move for the private label helpers the digest already threads: leave `columns`, `deltaCell`, `rejectionCell`, `percent`, `edgePercent`, `rate`, `spendCell`, `hoursPhrase`, `renderClusters`, `roleList`, `roleCell` and `stateChangeStamp` exactly where and as they are — this plan only names the section assembly, not the leaf formatters.

**Files touched.** src/failure/failure-render.ts

**Acceptance criteria.**
- `renderFailureMarkdown(data)` returns a string equal to today's for the same `data`: the existing fixtures and their expected Markdown (including the bounded-`since`, day-window, unreadable-log, empty, partial, no-transitions, loss-cut, prompt-stats and merged-cut cases) all pass unchanged, so no section's leading blank line, heading, placeholder or remainder line shifts.
- Every section named above has exactly one module-private builder; `renderFailureMarkdown`'s body contains no `lines.push(...)` and no section-specific branch — only the `lines` local, the eight calls and the join.
- The exported surface is unchanged: `grep -nE '^export ' src/failure/failure-render.ts` still matches only `export function renderFailureMarkdown(data: FailureReportData): string`, and no import is added or removed.
- `renderClusters` keeps its name and signature (INV-D1 binds it by name), so `docs/invariants.md` is unchanged: INV-A5, INV-C1, INV-D1 and the unreadable-log guarantee all bind `renderFailureMarkdown` / `renderClusters` at these symbols, and the private split changes no guarantee.
- No edit outside src/failure/failure-render.ts.

**Tests.** No new test module: a behavior-preserving move guarded by the existing digest suites. Run `test/failure-render.test.ts`, `test/failure-time-spend.test.ts`, `test/failure-state-change.test.ts`, `test/selfcheck-digest.test.ts`, `test/gui-report.test.ts`, `test/report.test.ts` and `test/tui.test.ts` whole and confirm green (`test/failure-render.test.ts` asserts the section text, order, placeholders and remainder lines, `test/selfcheck-digest.test.ts` pins the evidence wrapper around the digest, and `test/gui-report.test.ts` and `test/tui.test.ts` compare the pane/endpoint output to `renderFailureMarkdown`'s own text).

### `buildStatusAlerts`'s ~255-line alert assembly is split into one named builder per alert arm, so a status alert is found by name (planned 2026-10-25 by the plan role; independent in files of every eligible plan and blocked part — `grep -n 'src/ui/team-alert-status.ts\|buildStatusAlerts' PLANS.md` matches no `## Planned` entry: the in-flight plans edit src/status/status-data.ts, src/ui/status-render.ts and src/failure/failure-render.ts, and the blocked `Every commit is verified on main` parts edit src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/status/status-polls.ts, src/doctor, src/config, src/cli, src/ui/status-model.ts and src/ui/gui/*, so none names src/ui/team-alert-status.ts; the landed 2026-10-25 alert plans that last added arms here (`noDeclaredCheck`, `noBrief`, `briefTruncated`, `principlesTruncated`, `roleNotesOverCap`, `stale-claims`) are merged, so no waiting work edits it; touches src/ui/team-alert-status.ts)

**Goal.** `buildStatusAlerts` (`src/ui/team-alert-status.ts`) is one ~255-line function that walks fifteen independent alert arms in emission order, each testing a snapshot field or a `roles` predicate and pushing one `TeamAlert` into a local `out`: the fallback chain, the spent budget (fallback vs red), the per-role daily cap, the disk hold, the root-install drift, the no-check / no-brief / brief-truncated / role-notes-truncated / principles-truncated standing warnings, red main, the failing streak, the stuck marker, the stale running build, and the stale work-instance claims. A reader asking "where does the disk alert come from?", "which arm reads `snap.build.restartBlocked`?" or "what is the emission order?" has only the one body to scan, and an arm has no name to grep. Split it into one module-private builder per alert arm, so a status alert is found by name and `buildStatusAlerts` becomes the destructure, the `out` array, the ordered calls and the return. No behavior change: the returned `TeamAlert[]` is deep-equal for the same input.

**Approach.** All edits in src/ui/team-alert-status.ts; move code, do not rewrite it, and keep every comment with the arm it annotates. Follow the file's existing push convention: each builder takes `out: TeamAlert[]` and the inputs its arm reads, and pushes exactly the alert the arm pushes today, so the output order is the call order. The builders are module-private and return `void`.
- `pushChainAlert(out, snap)` — the `chainFragments(snap.chain)` / `"chain"` block.
- `pushSpentBudgetAlert(out, snap)` — the `!b.free && b.capUsd > 0 && b.spentUsd >= b.capUsd` block, owning `b = snap.budget`, its `fallbackDetail` (the `b.tiers` ternary) and the fallback-vs-`"budget"` `out.push`.
- `pushRoleCapAlert(out, snap, roles)` — the `snap.capPaused.length > 0` block, owning `capPausedRoles`.
- `pushDiskAlert(out, snap)` — the `snap.disk?.held` block.
- `pushInstallDriftAlert(out, snap)` — the `drift = snap.rootInstallDrift ?? []` / `"install"` block, owning `drift` and `names`.
- `pushNoCheckAlert(out, snap)` — the `snap.noDeclaredCheck` block.
- `pushNoBriefAlert(out, snap)` — the `snap.noBrief` block.
- `pushBriefTruncatedAlert(out, snap)` — the `snap.briefTruncated` block.
- `pushRoleNotesTruncatedAlert(out, snap)` — the `notesOver = snap.roleNotesOverCap ?? []` block, owning `notesOver`.
- `pushPrinciplesTruncatedAlert(out, snap)` — the `snap.principlesTruncated` block.
- `pushMainRedAlert(out, snap, roles)` — the `red = roles.filter(...)` block, owning `red`, `redDetail` and `detail`.
- `pushFailingStreakAlert(out, roles)` — the `failing = roles.filter((l) => l.errorStreak)` block, owning `failing`.
- `pushStuckRoleAlert(out, roles)` — the `stuck = roles.filter(...)` block, owning `stuck`.
- `pushBuildAlert(out, snap)` — the `snap.build?.stale` block, owning `behind` and `deferred`.
- `pushStaleClaimsAlert(out, staleClaims)` — the `staleClaims.length > 0` block.
- `buildStatusAlerts` keeps its signature and exact body shape: `const { snap, roles, staleClaims } = input;`, `const out: TeamAlert[] = [];`, the fifteen calls in the arm order listed above, `return out;`. It pushes nothing itself and holds no `if`, `filter` or arm-specific `const`.
- Leave `StatusAlertsInput`, the imports and the module doc comment as they are; every helper each arm calls is already imported, so no import is added or removed.

**Files touched.** src/ui/team-alert-status.ts

**Acceptance criteria.**
- `buildStatusAlerts(input)` returns a deep-equal `TeamAlert[]` to today's for the same input: every alert's key, tone, title, detail and actions are unchanged, and the emission order is the arm order above (the existing order-dependent cases in test/team-alerts.test.ts pass unchanged).
- Every arm named above has exactly one module-private builder; `buildStatusAlerts`'s body contains no `out.push(` and no arm condition — only the destructure, the `out` array, the fifteen calls and the return.
- The exported surface is unchanged: `grep -nE '^export ' src/ui/team-alert-status.ts` still matches only `export function buildStatusAlerts(input: StatusAlertsInput): TeamAlert[]`, and no import is added or removed.
- `docs/invariants.md` is unchanged: `grep -c 'team-alert-status\|buildStatusAlerts' docs/invariants.md` prints 0, and the one citation of test/team-alerts.test.ts (the qa-stale case) does not bind this function, so a private move changes no guarantee.
- No edit outside src/ui/team-alert-status.ts.

**Tests.** No new test module: a behavior-preserving move guarded by the existing alert suites. Run `test/team-alerts.test.ts`, `test/status-payload.test.ts`, `test/status-render.test.ts`, `test/gui.test.ts`, `test/tui.test.ts` and `test/cli.test.ts` whole and confirm green (`test/team-alerts.test.ts` drives `teamAlerts` through the arms and pins their wording and order, `test/status-payload.test.ts` deep-equals the payload built from `snapshot`, and `test/cli.test.ts` deep-equals its parsed `status --json` stdout).

### `buildBacklogFeedAlerts`'s ~150-line alert assembly is split into one named builder per alert arm, so a backlog-feed alert is found by name (planned 2026-10-25 by the plan role; independent in files of every eligible plan and blocked part — `grep -n 'src/ui/team-alert-backlog-feed.ts\|buildBacklogFeedAlerts' PLANS.md` matches no `## Planned` entry (its only hits are PLANS-DONE.md history): the in-flight plans edit src/status/status-data.ts, src/ui/status-render.ts, src/failure/failure-render.ts, src/ui/team-alert-status.ts and src/ui/team-alert-backlog.ts, and the blocked `Every commit is verified on main` parts edit src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/status/status-polls.ts, src/doctor, src/config, src/cli, src/ui/status-model.ts and src/ui/gui/*, so none names src/ui/team-alert-backlog-feed.ts; the landed 2026-10-24 `teamAlerts` split (part 3/5, PLANS-DONE.md) extracted this builder but left its body one flat run, and the landed 2026-10-25 `instance-pool` and `provider-caps` plans edited only the sibling src/ui/team-alert-tail.ts, so no waiting work edits it; touches src/ui/team-alert-backlog-feed.ts)

**Goal.** `buildBacklogFeedAlerts` (`src/ui/team-alert-backlog-feed.ts`) is one ~150-line function that walks seven independent alert arms in emission order, each testing one `BacklogFeedAlertsInput` field and pushing one `TeamAlert` into a local `out`: stale open bugs, a failed notify page, waiting bugs, stranded inbox prompts, a stalled merge queue, skipped merge-queue files and merges refused by an uncommitted primary checkout. A reader asking "where does the `waiting-bugs` alert come from?", "which arm reads `skippedMergeFiles`?" or "what is the emission order?" has only the one body to scan, and an arm has no name to grep. Split it into one module-private builder per alert arm, so a backlog-feed alert is found by name and `buildBacklogFeedAlerts` becomes the `out` array, the destructure and the ordered calls. No behavior change: the returned `TeamAlert[]` is deep-equal for the same input.

**Approach.** All edits in src/ui/team-alert-backlog-feed.ts; move code, do not rewrite it, and keep every comment with the arm it annotates. Follow the push convention the sibling `buildStatusAlerts`/`buildBacklogAlerts` splits use: each builder takes `out: TeamAlert[]` and the input field its arm reads, and pushes exactly the alert the arm pushes today, so the output order is the call order. The builders are module-private and return `void`.
- `pushStaleBugsAlert(out, staleBugs)` — the `staleBugs.length` block, owning `first` and `rest`.
- `pushNotifyAlert(out, notifyFailure, now)` — the `notifyFailure` block (`now` feeds its `humanAgo`).
- `pushWaitingBugsAlert(out, staleWaitingBugs)` — the `staleWaitingBugs.length` block, owning `first` and `rest`.
- `pushStalePromptsAlert(out, stalePrompts)` — the `stalePrompts.length` block, owning `first` and `rest`.
- `pushStaleMergesAlert(out, staleMerges)` — the `staleMerges.length` block, owning `first` and `rest`.
- `pushSkippedMergesAlert(out, skippedMergeFiles)` — the `skippedMergeFiles.length` block, owning its `[first, ...rest]` destructure.
- `pushPrimaryOverwriteAlert(out, primaryOverwrite, now)` — the `primaryOverwrite` block (`now` feeds its `humanAgo`).
- `buildBacklogFeedAlerts` keeps its signature and exact body shape: `const out: TeamAlert[] = [];`, the destructure of `input` (including `now`), the seven calls in the arm order listed above (`now` passed only to `pushNotifyAlert` and `pushPrimaryOverwriteAlert`), `return out;`. It pushes nothing itself and holds no `if` or arm-specific `const`.
- Leave `BacklogFeedAlertsInput`, the imports and the module doc comment as they are; every helper each arm calls (`moreDetail`, `openBacklogAction`, `plural`, `roleLabel`, `duration`, `humanAgo`, `joinWithMore`, `squash`) is already imported, so no import is added or removed.

**Files touched.** src/ui/team-alert-backlog-feed.ts

**Acceptance criteria.**
- `buildBacklogFeedAlerts(input)` returns a deep-equal `TeamAlert[]` to today's for the same input: every alert's key, tone, title, detail and actions are unchanged, and the emission order is the arm order above (the existing order-dependent cases in test/team-alerts.test.ts pass unchanged).
- Every arm named above has exactly one module-private builder; `buildBacklogFeedAlerts`'s body contains no `out.push(` and no arm condition — only the `out` array, the destructure, the seven calls and the return.
- The exported surface is unchanged: `grep -nE '^export ' src/ui/team-alert-backlog-feed.ts` still matches only `export function buildBacklogFeedAlerts(input: BacklogFeedAlertsInput): TeamAlert[]`, and no import is added or removed.
- `docs/invariants.md` is unchanged: `grep -c 'team-alert-backlog-feed\|buildBacklogFeedAlerts' docs/invariants.md` prints 0, so a private move changes no guarantee.
- No edit outside src/ui/team-alert-backlog-feed.ts.

**Tests.** No new test module: a behavior-preserving move guarded by the existing alert suites. Run `test/team-alerts.test.ts`, `test/status-payload.test.ts`, `test/status-render.test.ts`, `test/gui.test.ts`, `test/tui.test.ts` and `test/cli.test.ts` whole and confirm green (`test/team-alerts.test.ts` drives `teamAlerts` through these arms and pins their wording and order, `test/status-payload.test.ts` deep-equals the payload built from `snapshot`, and `test/cli.test.ts` deep-equals its parsed `status --json` stdout).

## Done
