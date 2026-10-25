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

### Split src/agent/run-agent.ts's runAgent, part 1/2: the build-and-spawn stage moves to src/agent/run-spawn.ts (planned 2026-10-25 by the organize role; split 2026-10-25 by the plan role after feature held the whole too large (held 1) — the streaming pipeline moves to part 2/2, which requires this part; independent in files of every eligible plan and blocked part — no `## Planned` entry edits src/agent/*, and the blocked `Every commit is verified on main` series touches src/runner/runner-run.ts, not src/agent/run-agent.ts; touches src/agent/run-agent.ts src/agent/run-spawn.ts (new) test/pi.test.ts test/pi-watchdogs.test.ts test/agent-backend.test.ts)

**Previously held 1**

**Goal.** `runAgent` (src/agent/run-agent.ts) is one 461-line function whose pre-spawn setup, `prepare` await, build-and-spawn, stream pipeline, watchdogs and settlement wiring share one scope of ~25 mutually-capturing locals; the settlement half already lives in src/agent/run-settle.ts behind the `RunSettleState` getter interface. This part extracts the build-and-spawn stage into `src/agent/run-spawn.ts` behind a `SpawnedRun` bundle; run-agent keeps setup, the watchdogs, the stream pipeline and the `error`/`exit`/`close` wiring. Part 2/2 extracts the stream pipeline next.

**Approach.**
- `src/agent/run-spawn.ts` (new). Move `AppendLog` and `openAppendLog` here (run-agent imports `openAppendLog` for its setup). Export:
  - `interface SpawnedRun { child: ChildProcess; resolved: ResolvedBackendBin; runSpec: AgentRunSpec; invocation: AgentInvocation; parser: PiStreamParser; translator: StreamTranslator; decoder: StringDecoder; stderrDecoder: StringDecoder; rawLog: AppendLog; nativeLog: AppendLog; runTmp: string; runMarker: string; preSpawnSessionId: string; terminate: () => void; blindRead: () => string | undefined }`.
  - `async function spawnPiRun(backend: AgentBackend, logs: { raw: AppendLog; native: AppendLog }, runTmp: string, opts: PiRunOptions): Promise<SpawnedRun>`.
- Move today's build-and-spawn verbatim (after the coordinator's own setup): the `tumwater_run` marker write built from `opts.label`/`opts.kind`/`backend.id`; `new PiStreamParser(opts.onToolCallStart, { imageInput: seamImageInput(opts.config, readPiProviders(piModelsPath())), onBlindRead })`; `makeRunMarker()`; `backend.resolveBin(opts.config)`; the `nearestTumwaterRoot`/`ensureNotesShim` guard and its `onAgentWarning`; the `runSpec` object; the `warnEventBestEffort`-guarded `backend.prepare?.(runSpec)` call/await/catch; `backend.invocation(runSpec)`; `invocation.sessionId ?? opts.sessionName` as `preSpawnSessionId`; `recordSession`; `backend.translator()`; both `new StringDecoder("utf8")`; `spawn(resolved.bin, invocation.args, { cwd, stdio, detached, env: { ...invocation.env, TMPDIR: runTmp } })`; the `child.stdin?.on("error", () => {})` + `child.stdin?.end(invocation.stdin)` block.
- Blind-read termination: keep a module-local `blind: { read?: string; terminate?: () => void }`; the parser's `onBlindRead` sets `blind.read = path` for an authoring run and calls `blind.terminate?.()`; `spawnPiRun` assigns `blind.terminate = () => terminateChild(child)` right after `spawn`. The bundle's `blindRead`/`terminate` close over `blind`. Because the body awaits only when `backend.prepare` is defined, a backend without `prepare` (pi, claude, opencode) runs synchronously through `spawn` before the returned promise resolves, so the watchdog-start ordering the logical-clock tests pin is preserved.
- run-agent.ts keeps: backend resolution (`backendById(opts.config.agent ?? DEFAULT_BACKEND) ?? piBackend`); the setup try/catch (`ensureDir`, `openAppendLog` for both logs, `fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-run-"))`, and its `setupFailureResult` resolution on failure); the `registerAgentBackend(...)` registrations (src/gates/startup-gate.ts imports this module for that side effect); `MAX_NATIVE_LINE_CHARS`; `startPiWatchdogs`; the abort wiring; the whole stream pipeline; the `RunSettleState` assembly; and `child.on("error"/"exit"/"close")`. Replace only the pre-spawn/build-and-spawn block with `const spawned = await spawnPiRun(backend, { raw: rawLog, native: nativeLog }, runTmp, opts);` inside the existing inner try/catch that rejects on a synchronous throw, then bind the stream pipeline's `child`/`resolved`/`runSpec`/`invocation`/`parser`/`translator`/`decoder`/`stderrDecoder`/`runMarker`/`preSpawnSessionId`/`blindRead` from the bundle.

**Files touched.** src/agent/run-agent.ts src/agent/run-spawn.ts (new) test/pi.test.ts test/pi-watchdogs.test.ts test/agent-backend.test.ts

**Acceptance criteria.**
- With the same `PiRunOptions`, every path returns the same `PiRunResult`: a setup failure (broken log, ENOSPC tmpdir) still resolves a failed run via `setupFailureResult`; a synchronous throw in the pre-spawn/build-and-spawn stage still rejects the run's promise; a normal run resolves only after both logs flush; the blind-read kill, abort and watchdog kill settle exactly as today.
- `src/agent/run-agent.ts` no longer constructs `PiStreamParser`, calls `makeRunMarker`/`backend.resolveBin`/`backend.prepare`/`backend.invocation`/`spawn` or `recordSession`; `src/agent/run-spawn.ts` holds every one of those.
- No runtime import cycle: `grep -n 'from "./run-agent.js"' src/agent/run-spawn.ts` shows a type-only import line (`import type { PiRunOptions }`), and run-spawn imports nothing else of run-agent's.
- Every `run-agent.js` export is unchanged; `test/agent-backend.test.ts` still imports `runAgent` and `MAX_NATIVE_LINE_CHARS` from `../src/agent/run-agent.js`.
- `npm run test:gate` passes.

**Tests.**
- No new behavior, so no new test module. The existing fake-pi suites are the guard: run `test/pi.test.ts`, `test/pi-watchdogs.test.ts`, `test/agent-backend.test.ts`, `test/claude-run.test.ts`, `test/codex-run.test.ts`, `test/opencode-run.test.ts` and `test/run-resume.test.ts` whole and confirm green.

### Split src/agent/run-agent.ts's runAgent, part 2/2: the streaming pipeline moves to src/agent/run-stream.ts (planned 2026-10-25 by the organize role; split 2026-10-25 by the plan role after feature held the whole too large (held 1); requires part 1/2 landed — the stream's `createAgentStream` consumes the `SpawnedRun` bundle part 1/2 introduces, and before it lands the streaming pipeline still lives in run-agent.ts; independent in files of every eligible plan and blocked part — no `## Planned` entry edits src/agent/*, and the blocked `Every commit is verified on main` series touches src/runner/runner-run.ts, not src/agent/run-agent.ts; touches src/agent/run-agent.ts src/agent/run-stream.ts (new) src/agent/run-spawn.ts test/pi.test.ts test/pi-watchdogs.test.ts test/agent-backend.test.ts)

**Previously held 1**

**Goal.** With the build-and-spawn stage in run-spawn.ts (part 1/2), run-agent's remaining live lifecycle is the streaming pipeline — `emitNativeLine`, `feedCanonical`, the stdout/stderr `data` handler bodies, `onLine` and `finish`, plus the mutable state they share (`stderr`, `fallbackClone`, `stderrTail`, `nativeTail`, `nativeOverflow`, `streamMintedSession`, `settled`). Extract that into `src/agent/run-stream.ts` behind an `AgentStream` interface so run-agent is the coordinator only.

**Approach.**
- `src/agent/run-stream.ts` (new). Move `MAX_NATIVE_LINE_CHARS` and its doc comment here. Define:
  - `interface AgentStream { feedStdout(chunk: Buffer): void; feedStderr(chunk: Buffer): void; onLine: (line: string) => void; feedCanonical: (text: string, final?: boolean) => void; finish: (result: PiRunResult) => void; settled: () => boolean; stderr: () => string; fallbackClone: () => string | undefined }`.
  - `function createAgentStream(input: { opts: PiRunOptions; backend: AgentBackend; spawned: SpawnedRun; wd: ReturnType<typeof startPiWatchdogs>; onAbort: () => void }): AgentStream`.
- Move `emitNativeLine`, `feedCanonical`, `finish`, `onLine` and the stdout/stderr `data` handler bodies; `createAgentStream` owns the six stream locals. `feedStdout` does `wd.noteByte()` then `feedCanonical(decoder.write(chunk))`; `feedStderr` does `wd.noteStderr()`, decodes, runs `backend.matchStderrWarning?.(text, stderrTail)`, carries the 512-char tail and keeps the 64 KiB `stderr` window. `finish` keeps its settle logic unchanged: the `settled` guard, `parser.imageBlind` + `opts.onBlindRead`, `removeTree(runTmp)`, `wd.stop()`, `opts.signal?.removeEventListener("abort", onAbort)`, `translator.warnings?.()`, and the raw/native-log `end`-flush before `resolve`.
- `src/agent/run-agent.ts`: after the watchdogs and abort wiring, `const stream = createAgentStream({ opts, backend, spawned, wd, onAbort });`, attach `spawned.child.stdout?.on("data", (chunk) => stream.feedStdout(chunk))` and `.stderr?.on("data", (chunk) => stream.feedStderr(chunk))`, and assemble `RunSettleState` from the bundle plus `stream.onLine`/`stream.feedCanonical`/`stream.finish`/`stream.stderr`/`stream.fallbackClone`/`stream.settled`. Remove the moved locals and their `state` getters. Keep `export { MAX_NATIVE_LINE_CHARS } from "./run-stream.js";` so `test/agent-backend.test.ts`'s import from `../src/agent/run-agent.js` is unchanged.
- `src/agent/run-spawn.ts` needs no new fields: the bundle already carries `rawLog`/`nativeLog`/`runTmp`/`preSpawnSessionId`/`parser`/`translator`/`decoder`/`stderrDecoder`; run-stream imports `AppendLog`/`SpawnedRun` from it as types only.

**Files touched.** src/agent/run-agent.ts src/agent/run-stream.ts (new) src/agent/run-spawn.ts test/pi.test.ts test/pi-watchdogs.test.ts test/agent-backend.test.ts

**Acceptance criteria.**
- `runAgent` returns the identical `PiRunResult` on every path as before part 2/2: stdout line splitting; the `MAX_NATIVE_LINE_CHARS` over-long-line discard with its `onAgentWarning`; UTF-8 straddle decoding with no U+FFFD; the `tumwater_run` marker ordering; the stream-minted session's second ledger record; the stderr warning match; and the both-logs-flush-before-resolve contract are all unchanged.
- `src/agent/run-agent.ts` defines none of `nativeTail`, `nativeOverflow`, `emitNativeLine`, `feedCanonical` or `finish`; they live in `src/agent/run-stream.ts`, and run-agent's remaining body is backend resolution, setup, watchdogs, abort, the `createAgentStream` call, the `RunSettleState` assembly and the three `child.on(...)` handlers.
- `MAX_NATIVE_LINE_CHARS` is still importable from `../src/agent/run-agent.js`.
- No runtime import cycle: run-stream.ts imports from run-agent.js and run-spawn.js as `import type` only.
- `npm run test:gate` passes.

**Tests.**
- No new behavior, so no new test module. The existing fake-pi suites are the guard: run `test/pi.test.ts`, `test/pi-watchdogs.test.ts`, `test/agent-backend.test.ts`, `test/claude-run.test.ts`, `test/codex-run.test.ts`, `test/opencode-run.test.ts` and `test/run-resume.test.ts` whole and confirm green.

### `Redeployer.poll`'s 240-line state machine is split into one named private stage method per decision, so a stage's rule is found by name (planned 2026-10-25 by the plan role; independent in files of every eligible plan and blocked part — no entry under `## Planned` and no blocked `Every commit is verified on main` part names `src/redeploy/redeployer.ts` (the blocked series edits src/review, src/orchestrator, src/runner/runner-run.ts, src/merge, src/baseline, src/status, src/doctor, src/config and src/ui with their tests), and the in-flight plans edit src/agent, src/events/event-format.ts, src/config, src/pi/pi-stream.ts and src/ui/status — none src/redeploy; the other `## Planned` files-touched lists name `src/redeploy/redeploy-probes.ts` only via the landed 2026-10-25 self-redeploy plan, not this file; touches src/redeploy/redeployer.ts)

**Goal.** `Redeployer.poll` (src/redeploy/redeployer.ts) is one ~240-line method that runs the whole self-redeploy state machine inline: observe a moved head, escalate a sustained pin, honour the restart cooldown and its forced-restart waiver, open an episode behind the boot gate, wait on the green check, compile the staged tree, then drain, swap and record the restart. The class already exposes its leaves as named private methods (`endDrain`, `refuse`, `block`, `noteFailure`, `escalateIfSustained`, `bootProblem`, `clearPending`, `consumeForcedRestart`, `effectiveCooldownUntil`, `logRestartPending`, `ensureBuildRedCheck`), so `poll` reads as one long block of their call sites interleaved with the stage rules themselves; a rule is found only by reading the whole method. Extract each stage into a named private method on the same class (all state stays on `this` — no state threading, no behavior change) and leave `poll` as the guard plus the ordered stage calls.

**Approach.**
- src/redeploy/redeployer.ts: add these private methods, each the current inline block moved verbatim with its comments, and reduce `poll` to call them in the same order. Every stage method returns `RedeployAction | null`, where `null` means "proceed to the next stage" and a returned action (`"none"`/`"hold"`/`"restart"`) is `poll`'s result unchanged:
  - `private async observeHead(mainHead: string, now: number): Promise<void>` — the `if (mainHead !== this.lastHead)` block: capture `wasStale`, set `this.lastHead`, `await this.deps.staleness(mainHead)`, log `build_stale`, update `staleSince`/`lastEscalationAt`/`forcedRestart`, and `clearPending()` when a pending head was superseded.
  - `private cooldownStage(mainHead: string, now: number): RedeployAction | null` — `ensureBuildRedCheck` inside the cooldown, `consumeForcedRestart`, `effectiveCooldownUntil`, the deferred-branch warning plus `probes.prewarm` and `endDrain` when still cooled, then the `cooldownWarnedUntil = null` reset and the urgent-early-lapse warning.
  - `private async startEpisode(mainHead: string, inFlight: InFlightCounts, now: number): Promise<RedeployAction | null>` — the `if (this.pendingHead === null)` block: `bootProblem`/`refuse`, set `pendingHead`, start `drainSince`/`drainWindowMs`, adopt the probe's green/compile, `logRestartPending`, return `"hold"` (or `null` when a pending head already exists).
  - `private greenStage(mainHead: string, now: number): RedeployAction | null` — the `!this.green?.done` hold, the `this.green.error` rejected-check branch (note, warn once per head, `clearPending`, `endDrain`) and the `this.green.result !== true` red-verdict branch (`block`, `endDrain`).
  - `private compileStage(mainHead: string, now: number): RedeployAction | null` — the missing/undone compile holds, then the `!c?.ok` branch: `noteFailure`, the rejected/undefined-compile warn-and-`clearPending` path, and the real compiler-exit `block` path.
  - `private async drainAndSwap(mainHead: string, inFlight: InFlightCounts, now: number): Promise<RedeployAction>` — the director/role drain holds, the second `bootProblem`, the `deps.swap` try/catch, `restartRecord.record`, `lastAutoRestartAt`, clearing `staleSince`/`lastEscalationAt`, the `restart` log and `pendingLoggedHead = null`, returning `"restart"`.
- `poll` keeps exactly: `this.autoRestartOn = autoRestart;`; the `!this.selfHosted || !mainHead` guard; `await this.observeHead(...)`; `if (this.staleness?.stale && autoRestart) this.escalateIfSustained(now);`; the `!stale || !autoRestart || blockedHead === mainHead` guard; then `await/const stage = this.cooldownStage(...)` — return when non-null, else `startEpisode`, `greenStage`, `compileStage`, and finally `return this.drainAndSwap(...)`.
- No change to the class's fields, constructor, `status`, `forceRestart`, any existing private method, any exported symbol, or any other file.

**Files touched.** src/redeploy/redeployer.ts

**Acceptance criteria.**
- `poll`'s body is only the two top guards, the escalation call, and the ordered stage calls; it no longer contains the head-observation, cooldown, boot-gate, green-check, compile or drain/swap rules, each of which lives in exactly one named method above.
- Every moved line is preserved verbatim (statements, order and comments); the only added lines are the method headers, the call lines and the `RedeployAction | null` return plumbing.
- No public API change: `Redeployer`, its fields, its constructor, `status`, `forceRestart`, the existing private methods and every exported symbol are unchanged, and no other file is edited.
- `npm run test:gate` passes.

**Tests.**
- No new test module: a behavior-preserving move guarded by test/redeployer.test.ts (the cooldown, forced restart, boot-gate refusal, green-check reject/red, compile reject/fail, drain and swap cases), test/redeploy-escalation.test.ts, test/redeploy-prewarm.test.ts, test/redeploy-rejected.test.ts, test/redeploy-startup-gate.test.ts, test/redeploy-wiring.test.ts and test/orchestrator-redeploy.test.ts. Run them whole and confirm green.

### `stageRunMerge`'s 306-line staging pipeline is split into one named stage per decision, so a staging rule is found by name (planned 2026-10-25 by the plan role; independent in files of every eligible plan and blocked part — `grep -n 'src/run/run-stage.ts' PLANS.md` matches nothing, and no `## Planned` entry's Files-touched list names it: the in-flight plans edit src/agent, src/pi/pi-stream.ts, src/redeploy/redeployer.ts, src/runner/runner-pi.ts, src/report/report-data.ts and src/run/run-verdict.ts, while the blocked `Every commit is verified on main` series edits src/review, src/orchestrator, src/runner/runner-run.ts, src/merge, src/baseline, src/status, src/doctor, src/config, src/ui and src/run/run-apply.ts, none listing src/run/run-stage.ts; PLANS-DONE.md holds no split of `stageRunMerge` (its `run-stage.ts` entries are landed behavior changes — the interlock-relief hold, the qa-flow failed-write warning, the tick→run rename and the self-check finding-log fields); touches src/run/run-stage.ts)

**Goal.** `stageRunMerge` (src/run/run-stage.ts) is the commit-staging layer: it derives the commit description from the reply (one bounded follow-up turn when the SUMMARY is missing or over cap), runs the pre-queue self-check with its fix-up turn, computes friction, builds and commits the message, holds the commit on the branch when the role already queues one, or pins and enqueues it, then records the qa flow and feedback filing. It is one ~306-line async function holding all of those rules inline in one scope, so a staging rule is found only by reading the whole body. Extract each decision into a module-private stage function beside `findingDigest` and `logSelfCheckOutcome`, and leave `stageRunMerge` as the ordered stage calls plus the final outcome.

**Approach.**
- src/run/run-stage.ts: add a module-private `interface StagedCommitDescription { summary: string; body: string | undefined; summaryDerived: boolean }` and these stages, each holding its current inline block moved verbatim (statements, order and comments):
  - `function revisionFields(ctx: RunStageContext): { revisionRound: number | undefined; priorReview: PriorReview | undefined }` — the `revisionRound` read and the `priorReview` derivation (both comment blocks included). Add `PriorReview` to the existing type import from `../merge/merge-queue.js`.
  - `async function resolveCommitDescription(ctx: RunStageContext): Promise<StagedCommitDescription | RunOutcome>` — the `extractSummary`/`extractCommitBody` reads, the missing-SUMMARY follow-up turn (`summaryDerived` derivation, path fallback and its warning) and the over-cap follow-up turn (shortening and its warning). Returns `ctx.finishAbortedRun()` when a follow-up aborts, otherwise the description.
  - `async function runStageSelfCheck(ctx: RunStageContext, desc: StagedCommitDescription): Promise<RunOutcome | undefined>` — the staged-moved-entry claims (`stagedMovedEntries`, `heldMovedFinding`, `assignedMovedFinding`, the `s.claim` assignment and its `claim` event), the `ctx.stageCheck` findings and the fix-up turn (`requestStageFix`, `foldAgentCommitsSince`), the reverted-change `no_change` return and the `logSelfCheckOutcome` reporting. Mutates `desc.summary`/`desc.body` exactly as the inline block mutates `summary`/`body`.
  - `function frictionSnapshot(ctx: RunStageContext): { minutes: number; authoringTurns: number; highFriction: boolean }` — the `minutes`/`authoringTurns`/`highFriction` computation and the high-friction warning.
  - `function stagedCommitMessage(ctx: RunStageContext, desc: StagedCommitDescription, revisionRound: number | undefined, friction: ReturnType<typeof frictionSnapshot>): string` — the `buildCommitMessage(stampedSubject(baseRoleOf(ctx.role), desc.summary), desc.body, commitTrailer(...))` call.
  - `async function pinAndEnqueueChange(ctx: RunStageContext, change: { commit: string; summary: string; body: string | undefined; highFriction: boolean; revisionRound: number | undefined; priorReview: PriorReview | undefined }): Promise<{ heldOnBranch: boolean } | RunOutcome>` — the `heldOnBranch` computation (`queuedMerges`/`hasUnmergedPin`), the `pinAndReset` failure error outcome, the `enqueueMerge` call with `entryRevisionFields`, the `s.revision = undefined` clear and the `merge_queued` event; returns `{ heldOnBranch }` when the run may finish queued.
  - `function recordStageRecords(ctx: RunStageContext, summary: string, friction: ReturnType<typeof frictionSnapshot>): string` — the `finalSummary` computation, the `recordFlow` try/catch and the `filed` event and `recordFiled` try/catch; returns `finalSummary`.
- `stageRunMerge` keeps exactly: `const s = ctx.state;`, `const { revisionRound, priorReview } = revisionFields(ctx);`, `const desc = await resolveCommitDescription(ctx);` with `if ("result" in desc) return desc;`, `const selfCheck = await runStageSelfCheck(ctx, desc);` with `if (selfCheck) return selfCheck;`, `const friction = frictionSnapshot(ctx);`, `const message = stagedCommitMessage(ctx, desc, revisionRound, friction);`, the `archiveNewFinishedEntries` sweep and `commitAll` commit, `const queued = await pinAndEnqueueChange(ctx, { ... });` with `if ("result" in queued) return queued;`, `const finalSummary = recordStageRecords(ctx, desc.summary, friction);`, and the closing `{ result: "queued", summary: finalSummary, commit, highFriction: friction.highFriction, ...(queued.heldOnBranch ? { heldOnBranch: true } : {}) }` — the same order, guards and short-circuiting as today. `s` is dropped if `stagedCommitMessage` and `pinAndEnqueueChange` read `ctx.state` themselves.
- No change to `RunStageContext`'s fields, to any exported symbol, or to any other file. docs/invariants.md is not edited: the section that binds `stageRunMerge` (the qa-flow failed-write guarantee, which names the function, `resolveRunVerdict` and `recordFlow`) is unchanged by a pure move.

**Files touched.** src/run/run-stage.ts

**Acceptance criteria.**
- `stageRunMerge`'s body is only the `revisionFields`/`resolveCommitDescription`/`runStageSelfCheck`/`frictionSnapshot`/`stagedCommitMessage`/`pinAndEnqueueChange`/`recordStageRecords` calls, the archive sweep, the commit and the final outcome; it no longer contains the revision-field derivation, the description recovery, the self-check, the friction rule, the message build, the pin/enqueue rule or the flow/filed recording, each of which lives in exactly one named stage above.
- Every moved statement, expression and comment is preserved verbatim; the warning texts, the `claim` and `merge_queued` event payloads, the `ctx.warn` calls, and the outcome objects are identical to the current ones.
- The stages run in the same order with the same fall-through and the same early returns as the inline body today, so `stageRunMerge` returns the identical `RunOutcome` for every input, `heldOnBranch` included.
- The only import change is the type-only addition of `PriorReview`; `RunStageContext`, `foldAgentCommitsSince`, `findingDigest` and `logSelfCheckOutcome` are unchanged and no other file is edited.
- `npm run test:gate` passes.

**Tests.**
- No new test module: a behavior-preserving move guarded by test/run-stage.test.ts (the summary derivation, follow-up, self-check/fix-up, no_change, friction, pin/enqueue, held-on-branch and flow/filed cases) and the `stageRunMerge` revision-round and pin cases in test/revision.test.ts, plus the held-on-branch row cases in test/history-data.test.ts. Run them whole and confirm green.

### `main`'s command switch is split into one named handler per substantial command, so a command's parse-and-dispatch rules are found by name (planned 2026-10-25 by the plan role; independent in files of every eligible plan and blocked part — `grep -n 'src/cli.ts' PLANS.md` matches nothing, and no `## Planned` entry's Files-touched list names it: the blocked `Every commit is verified on main` parts edit src/cli/cli-role-command.ts and src/cli/help.ts (different files), plus src/config, src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/doctor, src/status and src/ui; the in-flight plans edit src/agent, src/pi/pi-stream.ts, src/redeploy/redeployer.ts, src/runner/runner-pi.ts, src/report/report-data.ts, src/run/run-verdict.ts and src/run/run-stage.ts, and parts 3n/3 and 3o/3 are test-only; PLANS-DONE.md holds no split of `main` (its `cli.ts` entries are landed behavior changes — the doctor retire/drop-pin flags and the logs notable cull); touches src/cli.ts)

**Goal.** `main` (src/cli.ts) is one ~500-line function: after the Node-floor gate, the `--help` topic gate and the `repoToplevel` read, its switch inlines each substantial command's rules — flag-spec arrays, `rejectUnknownArgs` calls, ready-repo gates, lazy `import(…)` expressions, payload assembly and the exit-code write — so a command's parse-and-dispatch is found only by reading the whole switch. Extract each substantial case body into a module-private async handler beside `runTrailCommand` and leave `main` as the prefix gates plus the dispatch.

**Approach.**
- src/cli.ts: add these module-private handlers (not exported), each the current case body moved verbatim with its comments, and reduce each switch case to `await <handler>(root, args); break;`:
  - `cmdStartCase(root, args)` — the `start`/`run` case: `rejectUnknownArgs("start", args, START_FLAG_SPECS)`, `requireReadyRepo(root)`, the `cmdStart` import and call.
  - `cmdTuiCase(root, args)`, `cmdGuiCase(root, args)`, `cmdNotifyCase(root, args)`, `cmdArchiveCase(root, args)` — the same guard-then-lazy-import shape for their commands: `tui` keeps its two comments and `runTui(root)`; `gui` uses `GUI_FLAG_SPECS`; `notify` its `[{ names: ["--test"] }]`; `archive` its `[JSON_FLAG]`.
  - `cmdConfigCase(root, args)` — the `config` block: the `CONFIG_USAGE` import, the subcommand arity checks, `requireReadyRepo(root)` and `cmdConfig`.
  - `cmdReportCase(root, args)` — the `report` block: its flag specs with the `--days` validator, `refuseTeamWorkspace(root)`, the `cmdReport` import and call.
  - `cmdDoctorCase(root, args)` — the `doctor` block: `peelPositionals`/`rejectUnknownArgs`, `parseDoctorChecks`, the five optional reap flags with their text-vs-`--json` printing, the `withKill`/`withBacklogCommit`/`withResyncInstall`/`withBrokenPinDrop`/`withLeftoverRetire` payload chain, the `--problems` render choice and the `process.exitCode` write.
  - `cmdLogsCase(root, args)` — the `logs` block: its flag specs, `requireReadyRepo(root)` and `cmdLogs`.
  - `cmdHistoryCase(root, args)` — the `history` block: the `cmdHistory`-module import, the `if (historyTrailForm(args)) { await runTrailCommand(root, args); return; }` early exit, its flag specs, `requireReadyRepo(root)` and `cmdHistory`.
  - `cmdBugCase(root, args)` and `cmdPlanCase(root, args)` — the `bug`/`plan` blocks: each keeps its three lazy imports, its `usage` string, its `--show`/`--list`/`--edit`/`--cancel`/`--top`/`--release` arms and its final `fileAndAnnounce` call.
  - `cmdPromptCase(root, args)` — the `prompt` block: its rationale comment, `parsePromptArgs(args)`, `requireReadyRepo(root)` and `cmdPrompt`.
  - `cmdRetireCase(root, args)`, `cmdRevertCase(root, args)`, `cmdStopCase(root, args)` — the operator cases: each keeps its comment, its `rejectUnknownArgs` spec where it has one (`retire` `[ROLE_FLAG, FORCE_FLAG, DRY_RUN_FLAG, JSON_FLAG]`, `stop` `[STOP_IN_FLAG, STOP_CANCEL_FLAG]`, `revert` none), `requireReadyRepo(root)` and its `cmd…` call.
  - `cmdCompletionCase(root, args)` — the `completion` block: the `--roles`/`--config-keys`/`--config-value`/`--models` arms and the shell validation with its two `fail` messages and `completionScript`.
  - `cmdVersionCase(args)` — the `version`/`--version`/`-v` block: `rejectUnknownArgs("version", args, [])`, `packageVersion(PACKAGE_JSON)`, the broken-install `fail` and `say(version)`; takes no `root` because it reads none.
  - `cmdHelpCase(args)` — the `help`/`--help`/`-h`/`undefined` block: the arity check, the topic lookup and `say(topic)`/`write(HELP)`; takes no `root`.
- `main` keeps exactly: the `const [, , command, ...args] = process.argv;` destructure; the `packageEnginesNode`/`nodeFloorProblem` gate; the `helpTopicForArgs` gate; `const root = (await repoToplevel(process.cwd())) ?? process.cwd();`; and the switch, whose substantial cases are now the handler calls above while the short delegated cases stay inline (`init`, `status`, `diff`, `queue`, `reviews`, `backlog`, `quarantine`, `questions`, `brief`, `role`, `tick`, the seven-command `reset-counters`…`restart` fall-through group and `default`), with the same case labels, grouping, `{ … }` blocks and `// vocabulary-ok: command name stays` comment.
- No behavior change: the same flag specs, argument order, gate order, lazy imports, messages and exit codes; every handler is module-private, so no export changes; no module-scope import is added or removed, and each command module stays lazily imported inside its handler, preserving the cold-start rationale in the file header comment.

**Files touched.** src/cli.ts

**Acceptance criteria.**
- `main`'s body is only the argv destructure, the Node-floor gate, the `--help` topic gate, the `root` read and the switch; each substantial case calls exactly one handler and the short delegated cases are unchanged.
- `grep -n 'rejectUnknownArgs\|requireReadyRepo\|parseDoctorChecks\|parsePromptArgs\|refuseTeamWorkspace\|historyTrailForm' src/cli.ts` matches only inside the new `cmd…Case` handlers, never inside `main`.
- Every moved statement, expression, comment, flag-spec array and message is preserved verbatim, in the same order; the only added lines are the handler signatures, their `Promise<void>` return types and the `await <handler>(…);` call lines.
- No handler is exported and no module-scope import is added; the lazy `await import(...)` expressions stay inside the handlers, so a command's module is still loaded only when that command runs.
- `npm run test:gate` passes.

**Tests.**
- No new test module: the CLI suites are the guard. Run `test/cli.test.ts` and the `test/cli-*.test.ts` files whole (arg strictness, flag-value errors, help, preflight, operators, backlog follow, logs, history, queue, questions, status, team-workspace, doctor, start guards) and confirm green.

## Done
