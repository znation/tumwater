# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; split 2026-10-25 by the plan role — the gate-scope narrowing moved to part 3m/3, then split again the same day after feature held it too large (held 6): the migration of the pre-merge reviewer's merge-verify and pipeline/runner/e2e cases moved to parts 3p/3–3w/3, so this part now requires parts 3g/3, 3l/3, 3p/3, 3z/3, 4a/3, 3q/3, 3r/3, 3s/3, 3t/3, 3u/3, 3v/3, 4b/3, 4c/3, 3w/3, 4d/3, 3x/3 and 3y/3 landed — 3g/3's universal post-landing review and 3l/3's review-suite retirement are on main, and 3p/3–3y/3 must retire the remaining reviewer-run cases before the run they assert goes; touches src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts)

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

### Every commit is verified on main, part 3j/3: the permanent reviewer-config hold `mergeReviewError` is deleted (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3i/3 landed, since with no pre-merge reviewer no selector can fail there and this removal takes its last consumers; touches src/merge/merge-core.ts src/runner/runner-leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/runner-leftover.test.ts test/runner-state.test.ts)

**Previously held 3**

**Goal.** `RunnerState.mergeReviewError` held a merge pin when the pre-merge reviewer failed permanently on a bad model selector. Part 3h/3 removed the pre-merge reviewer, so `gate.configError` can no longer be set and the hold can never be produced; delete it and every reader.

**Approach.**
- src/merge/merge-core.ts: drop the `state.mergeReviewError = {...}` write on a `configError`, its two clears (in `discardPin` and on the approved path) and the `modelSelectorField`/`reviewRunConfig` reads that fed it.
- src/runner/runner-leftover.ts: delete `reviewHold`, the `mergeReviewError` field on `LeftoverContext` and `pinnedRetrySha`'s state pick, and the two `reviewHold` read branches; recovery never reports `held` for a reviewer config.
- src/runner/runner-run.ts: drop the `mergeReviewError` read/clear beside the review selector and its state hand-back.
- src/runner/runner-state.ts: delete the `mergeReviewError?` field; src/run/run-apply.ts drops its `changeGone` clear. Keep the legacy `landingReviewError` read in runner-state-load.ts (old state files still name the key) and note it now loads into nothing.
- Delete the `mergeReviewError` cases and fixtures from the tests.

**Files touched.** src/merge/merge-core.ts src/runner/runner-leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/runner-leftover.test.ts test/runner-state.test.ts

**Acceptance criteria.**
- `mergeReviewError` is absent from `RunnerState` and from every read/write; a pin is never held for a reviewer selector, and recovery re-queues it as any other pin.
- An old state file carrying `mergeReviewError` still loads (the legacy key is ignored).
- `npm run test:gate` passes.

**Tests.**
- test/runner-leftover.test.ts: `a pin is never held by a reviewer config` — a state carrying the legacy field still re-queues its pin.
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

### Every commit is verified on main, part 3f/3: the merge slot runs no in-lock gate check and no batch check — a merge is a rebase and a fast-forward (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3e/3 landed, since the gate-scope checks lose their producers once the pre-merge reviewer is gone; touches src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/runner-leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts)

**Previously held 2**

**Goal.** With the watch verifying every new tip, the checks that stood in front of a landing are redundant. Delete the merge slot's in-lock build re-check and the batch check with its largest-passing-prefix bisect, so a merge is: rebase onto the tip, take the fast-forward under the merge lock. A broken commit then sits on main between its landing and the watch's fix, which is the `ci` healer's job.

**Approach.**
- Delete the in-lock re-check from `mergeApprovedChange` (src/merge/merge-to-main.ts): the `runScopedBuildCheck`/`mergeCommand` run and its `merge_blocked` cause. The fast-forward, the conflict resolver, the dirty-checkout refusal and the `MERGE_CONFLICT_LIMIT` hand-back stay (a conflicted tree cannot be landed).
- Delete the batch path from `mergeApproved` (src/merge/merge-batch.ts): the shared scope-`batch` check, its `BATCH_RESTACK_ATTEMPTS` re-stack and its per-pick bisect/fallback, and whatever in `merge-stack.ts` only that path used. Every approved change merges one at a time through the now-check-free `mergeApprovedChange`.
- The gate-scope check producers go: `review-precheck.ts`'s build-check reject and `merge-check-failures.ts`'s `merge_blocked`/`review_rejected` attribution lose their callers; the merge-side `main_red` keep (`merge-core.ts`), `requeueMainRedPin`'s wait (`merge-requeue.ts`) and leftover's `main_red` wait go with the in-lock verdict that produced them.
- With no producer left, remove the merge verdict `main_red`: `heldByMainRed` and `mainCheckRecovered` (`src/status/status-polls.ts`), the status phase's `main red` label (`src/ui/status-model.ts`) and the doctor's held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`) go; the red-main warning that names an unheld red stays.
- Keep the two rules part 3h/3 left pre-merge (secret leaks and protected edits) and the refusals that are not quality verdicts: the dirty-checkout pre-flight (`merge-to-main.ts`), a rebase conflict and its hand-back, a lost fast-forward race, and the startup/redeploy stage check.
- Docs: docs/how-it-works.md's merge paragraph says a merge is a rebase and a fast-forward; docs/invariants.md's merge-check guarantees are re-pointed to the watch.

**Files touched.** src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/runner-leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts

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

### Every commit is verified on main, part 4b/3: the pre-merge reviewer's orchestrator-3 held-merge abort, interlock and hand-off cases are re-pointed ahead of its removal (planned 2026-10-27 by the plan role, split from the too-large part 3v/3 after feature held it (held 8): the second of three finer parts replacing part 3v/3's one-file scope, sibling to parts 3v/3 and 4c/3, requires part 3v/3 landed since all three edit test/orchestrator-3.e2e.test.ts and 3v/3's drain edits there must settle first; touches test/orchestrator-3.e2e.test.ts)

**Refused 2026-10-27 by the feature role: the planned conflict-resolution hold cannot keep any of this entry's abort cases' outcomes. `tumwater abort --role` aborts the merge's own controller (operator-requests.ts:337) and never fires the harness shutdown signal, while a conflict-resolution run watches only that signal (runner-pi.ts — `runMergePi` uses `this.host.signal`), so the user abort in tests 1, 2 and 3 never kills the parked resolver run and the merge cannot settle `aborted` (it proceeds to merge once the parked run returns). A shutdown abort (tests 4, 5) kills the resolver run, but `resolveConflict` then `return false` with no signal remap, so the merge settles `merge_conflict`, not `aborted` (merge-to-main.ts, merge-batch.ts's `mergeOne`), and test 4's `clean:aborted`/`dedupe:aborted` assertion fails. The approach criterion (hold every in-flight merge on a parked conflict-resolution run) thus contradicts the outcome criterion (every case asserts `aborted`) for all five cases. Needs the plan role to re-specify the hold to a mechanism both user abort and shutdown settle as `aborted` — a verify-stage park (e.g. a declared-build-check run, whose signal kill maps to `GateResult.aborted`) rather than the merge-time resolver — the same re-specification requested for the sibling 4d/3.**

**Goal.** Part 3h/3 stops `reviewAttempt` from running the model reviewer, so `test/orchestrator-3.e2e.test.ts`'s cases that hold a merge in flight on a hanging reviewer run lose the hold they assert against: `a user abort during a merge kills it and discards the pinned ref`, `a role with a queued or in-flight merge never starts a new run (interlock)`, `an abort for one queued role stops only that role's verify and discards its pin; the other verify runs on`, `a restart's hand-off aborts the merges that outlive its deadline instead of waiting them out` and `a restart's drain aborts only its permit-holding role runs — the in-flight merge keeps its hand-off window, and a role enabled mid-run is cut off with the startup ones`. Re-point the hold to a deterministic in-flight merge step first.

**Approach.** In `test/orchestrator-3.e2e.test.ts`, for the five named cases replace the hanging pre-merge reviewer with a hold that survives part 3h/3: advance main with a conflicting edit after the pin so the rebase conflicts, and make the fake pi park on the merge's conflict-resolution run (match its `tumwater-<role>-<run>-conflict` session or the conflict prompt's markers) instead of on `VERDICT:`. Delete a case instead when it exists only to pin the reviewer's hold — none of the five does; each keeps its subject (the abort kills the in-flight merge, the interlock holds the role, the deadline lapses and aborts), which the conflict hold preserves. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/orchestrator-3.e2e.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- No case among the five hangs a `VERDICT:` run to hold a merge; each in-flight merge is held by a parked conflict-resolution run.
- Each surviving case keeps its original subject (the abort, interlock or hand-off) and asserts the same outcome against the parked conflict-resolution run.
- No edit outside test/orchestrator-3.e2e.test.ts.

### Every commit is verified on main, part 4c/3: the pre-merge reviewer's orchestrator-3 concurrency and rejection cases are re-pointed ahead of its removal (planned 2026-10-27 by the plan role, split from the too-large part 3v/3 after feature held it (held 8): the third of three finer parts replacing part 3v/3's one-file scope, sibling to parts 3v/3 and 4b/3, requires part 4b/3 landed since all three edit test/orchestrator-3.e2e.test.ts and 4b/3's held-merge edits there must settle first; touches test/orchestrator-3.e2e.test.ts)

**Goal.** Part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/orchestrator-3.e2e.test.ts`'s cases that overlap pre-merge reviewer runs or drive a merge through a reviewer rejection fail: `a role rejected in its verify runs again while another queued change is still in review`, `maxConcurrent 4 verifies three queued changes at once on the live orchestrator, then merges them all` and `a verify slot that can no longer be created is contained: the healthy change merges, the other drops as an error`. Re-point them to the deterministic gate.

**Approach.** In `test/orchestrator-3.e2e.test.ts`, re-point the rejection in `a role rejected in its verify...` to a deterministic pre-merge rejection (a conflict-marker diff or a failing declared check) when its subject is the rejected author's fix run starting mid-merge, and re-point the parked/overlapping runs in `maxConcurrent 4 verifies...` and `a verify slot that can no longer be created...` to conflict-resolution runs that park, so the verify-overlap sampling and the terminal-error containment keep their subjects. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/orchestrator-3.e2e.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- No case among the three drives a pre-merge reviewer verdict; the rejection is the gate's own finding and the parked runs are conflict-resolution runs.
- Each surviving case keeps its original subject (the rejected role's fix run starts while another merge is in flight, the three verifies overlap, the un-creatable slot degrades to a terminal error) and asserts the same outcome.
- No edit outside test/orchestrator-3.e2e.test.ts.

### Every commit is verified on main, part 4d/3: the pre-merge reviewer's orchestrator-director cases are re-pointed ahead of its removal (planned 2026-10-27 by the plan role, split from the too-large part 3w/3 after feature held it (held 8): the director-file half of part 3w/3, sibling to part 3w/3, which takes the same series' mixed case in test/orchestrator-mixed.e2e.test.ts, and independent in files of it; touches test/orchestrator-director.test.ts)

**Refused 2026-10-27 by the feature role: the restart-hand-off case's planned mechanism cannot preserve its own outcome — holding the in-flight merge on a parked conflict-resolution run makes the hand-off's abort settle `merge_conflict`, not `aborted` (resolveConflict returns false with no signal check, and the single-change merge path has no post-hoc abort remap in merge-batch.ts), so the entry's criteria 2 and 4 contradict for that case. Cases 1 and 2 (conflict-marker deterministic reject; conflict-resolution interlock hold) re-point cleanly and were verified working; only the hand-off case blocks a faithful landing. Needs the plan role to re-specify the hand-off hold (e.g. a verify-stage park such as a declared build check, which maps a signal-kill to `aborted` via GateResult.aborted, instead of the merge-time conflict-resolution run).**

**Goal.** Part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/orchestrator-director.test.ts`'s reviewer-driven cases fail: `director: once recovers a kept merge pin and drains the queue before exit` (its idle reply is a `review_error`), `merge queue interlock: a role with a queued merge starts no run until the merge ends` (a real pre-merge review run precedes the role's run) and `restart hand-off: an in-flight merge outliving its deadline is aborted, not waited out` (it sets `review.afterMerge: []` to hold the merge on a pre-merge review). Re-point each to a deterministic hold or rejection.

**Approach.** In `test/orchestrator-director.test.ts`, re-point the reject-reviewer arm in `director: once recovers...` to a deterministic gate rejection (a conflict-marker diff or a failing declared check) and keep its subject (the pin is re-queued and the queue drains before exit). In `merge queue interlock...`, replace the pre-merge review run with a parked conflict-resolution run on a conflicting rebase so the same ordering (the merge's own run finishes before the role's run starts) is asserted. In `restart hand-off...`, stop relying on `review.afterMerge: []` for the hold and hold the merge in flight on a parked conflict-resolution run instead, keeping the abort/lapse assertions. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/orchestrator-director.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- No case in the file drives a pre-merge reviewer verdict; the reject is the gate's own finding, and each in-flight merge is held by a parked conflict-resolution run.
- `restart hand-off` no longer relies on `review.afterMerge: []` for its hold.
- Each case keeps its original subject (recovery drain, the interlock ordering, the hand-off abort) and asserts the same outcome.
- No edit outside test/orchestrator-director.test.ts.

### Subtract, part 3/6: The merge queue becomes a lock and a fast-forward (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 3; requires Every commit is verified on main part 3f/3 landed; touches src/merge src/orchestrator/orchestrator-poll.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-skip.ts src/orchestrator/scheduling-scope.ts src/runner/runner-run.ts src/status/status-data.ts src/doctor/doctor-contention-checks.ts src/concurrency/check-permit.ts docs/how-it-works.md docs/invariants.md test/merger-restack.test.ts test/merge-backlog-conflicts.test.ts test/worktree-pool.test.ts)

**Goal.** A change lands as `pin → rebase onto main → fast-forward under the merge lock`. The queue, its stage machine, the coalesced batch check with its prefix bisect, the re-queue, the entry drop limits and the scheduling interlock are gone, because nothing about landing can fail any more: verification moved after the merge (part 3f/3), and a break is an ordinary open bug owned by the author.

**Approach.**
- Delete the queue and its stages: src/merge/merge-queue.ts, merge-queue-render.ts, merge-requeue.ts, merge-cancel.ts, merge-pipeline.ts, merge-slot.ts, merge-drain.ts, merge-batch.ts, merge-stack.ts, and the `.tumwater/merge-queue/` directory with its `uncommitted backlog`-style checks.
- `merge-core.ts` and `merge-to-main.ts` keep the pin read, the rebase, the merge lock and the fast-forward; the conflict-resolution pi run stays as the one non-deterministic step. `MERGE_CONFLICT_LIMIT` and the entry attempt/drop limits go: a conflict whose resolution fails comes back as a `**Needs review …**` note naming the conflict (the two surviving holds' vocabulary).
- Delete the scheduling interlock: `queuedRoles` (orchestrator-scheduling.ts), its legs in scheduling-skip.ts and scheduling-scope.ts, and `mergeStartHeld`'s merge half (orchestrator-poll.ts). A role whose change is merging authors its next run, as plans/interlock-relief.md's per-role tiering intended for the low-blast-radius roles only.
- Delete the check permit with the in-lock and batch checks it served (src/concurrency/check-permit.ts) and the three contention rows and the `capacity bottleneck` alert (part 1d/6 removes the alert; doctor-contention-checks.ts keeps `slot_wait`/`provider_wait` only if part 4/6 has not yet removed the pool).
- docs/how-it-works.md's merge-pipeline section and docs/invariants.md's cross-process invariants (INV-CT1 and the merge-slot guarantees) say what replaces the queue: one lock, linear history, and the post-landing check.

**Files touched.** src/merge src/orchestrator/orchestrator-poll.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-skip.ts src/orchestrator/scheduling-scope.ts src/runner/runner-run.ts src/status/status-data.ts src/doctor/doctor-contention-checks.ts src/doctor/doctor-check-names.ts src/concurrency/check-permit.ts docs/how-it-works.md docs/invariants.md test/merger-restack.test.ts test/merge-backlog-conflicts.test.ts test/worktree-pool.test.ts

**Acceptance criteria.**
- A code change's log path from run end to main is `merge_queued → merged`, with no stage events and no second check run; `build_check` events per merged commit are 1 (the post-landing one).
- Two roles land back to back with no interlock: the second role's run starts while the first's merge is in flight, and neither waits on the other's check.
- A conflicting change comes back to its author as one `**Needs review …**` note; nothing is dropped from a queue, because there is no queue.
- No `.tumwater/merge-queue/` directory is written; the doctor's `stale merge-queue entries` and `merge-queue files` rows are deleted (doctor-check-names.ts) rather than left to warn about a path nothing writes.
- `npm run test:gate` passes.

### Subtract, part 4/6: One runner per role — the instance claims and the worktree pool go (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 4, and its measurement gate; requires Subtract part 3/6 landed; touches src/config/config-schema.ts src/config/config.ts src/config/config-validation.ts src/roles/runner-ids.ts src/scheduling/claims.ts src/scheduling/claim-entries.ts src/backlog/backlog-index.ts src/git/worktree-pool.ts src/git/worktree-pool-startup.ts src/git/slots-state.ts src/git/worktree-use.ts src/git/slot-salvage.ts src/doctor/doctor-contention-checks.ts src/ui/status-payload.ts docs/config.md test/worktree-pool.test.ts test/retention.test.ts)

**Goal.** One runner id per role and one persistent checkout per role. `instances`, the instance claims and the slot pool existed to keep a role authoring while its own change merged (fast-merge measured 60% of role time waiting); with landing in minutes that wait is not the constraint, and the pool's own costs — slot waits, pins, stale claims, salvage — go with it.

**Approach.**
- **Measure first, and record it.** Before changing code, read the day report and the log for the week after part 3/6 landed: end-of-run → on main p50/mean/p90 (`merge_done`), `slot_wait` count and total, and red-main minutes (`main_check`/`main_red_hold`). If p90 is at or under ~15 minutes with one runner per role, proceed; if not, hold this part with a `**Needs review …**` note quoting the numbers instead of deleting capacity on a prediction.
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

### Subtract, part 6/6: The sweep — the rows, keys and docs the five parts left behind (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes" and "How we will know it worked"; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts)

**Refused 2026-10-26 by feature: the sweep deletes rows, keys, and docs for mechanisms that are still live in src/ and tumwater.json (instances, mergeCommand, maxConcurrentChecks, maxConcurrentPerProvider, check-permit, worktree-pool, claims, model-fallback), so implementing the entry as written breaks the build and the gate.**

**Goal.** The deletion reads as one system. Every name parts 1/6–5/6 removed is gone from the live docs, the example config, the doctor's row list, the alerts and the tests that assert them; the archive keeps the record.

**Approach.**
- Sweep the deleted names out of the live prose and the example config: `instances`, `slotCount`, `slot_wait`, `check_wait`, `maxConcurrentChecks`, `mergeBatchMax`, `mergeCommand`, `review.afterMerge`, `maxConcurrentPerProvider`, `fallback`, `fallbackModel`, `model.<tier>`, `over-cap model`, `slot salvage`, `merge queue`, `interlock`, `held-for-operator`, `Needs replan`, `Waiting for the next failure`, `(held N)`.
- Delete the rows and tests rather than re-pointing them: a case whose whole subject is a deleted mechanism goes (the existing wording/implementation tests rule: never re-pin), and test/doctor-checks.test.ts's row list, test/event-format.test.ts's deleted event types (`slot_wait`, `check_wait`, the merge-stage events), test/retention.test.ts's pool artifacts and test/config.test.ts's deleted keys are updated to the surviving row/key set.
- Re-check the parts 1a–1e/6 rule end to end: for every condition that used to have a banner and no longer does, the doctor row exists; for every row this series deleted, the mechanism is gone.
- docs/invariants.md drops or re-scopes the invariants of deleted subsystems (merge-slot, pool, permit, instance claims, model routing) in the same commit, per the standing rule.
- Record in the part's PLANS-DONE entry: the doctor row count and the config key count before and after the series, and the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts PLANS.md test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts

**Acceptance criteria.**
- `grep -rnE 'maxConcurrentChecks|maxConcurrentPerProvider|mergeBatchMax|mergeCommand|instances|slot_wait|check_wait|fallbackModel|review\.afterMerge|held-for-operator' src/ docs/ README.md DEVELOPMENT.md tumwater.example.json` finds no live reference (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every doctor row name in doctor-check-names.ts resolves to a check that reads a mechanism that still exists; no row reports a path nothing writes.
- The before/after row and key counts, and the deletions' measurement premise, are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

### Subtract, part 1d/6: The status and tail banners that are not a stopped team go — chain, role cap, no-check, brief, truncation, build, stale claims, quiet, maintenance, provider holds/caps, pause, contention, pins, pool, regressed fixes and image probes move to the doctor (planned 2026-10-26 by the plan role, split from the too-large part 1/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 6; requires Subtract part 1c/6 and Subtract part 5e/6 landed; touches src/ui/team-alert-status.ts src/ui/team-alert-tail.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts)

**Previously held 1**

**Goal.** Only the stopped-team and decision-queue banners remain. Kept in src/ui/team-alert-status.ts: `pushMainRedAlert`, `pushFailingStreakAlert`, `pushStuckRoleAlert`, `pushSpentBudgetAlert` (the red `budget` arm) and `pushDiskAlert`, `pushInstallDriftAlert`; kept in src/ui/team-alert-tail.ts: `pushStoppedAlert` (`tumwater is not running`). Everything else becomes a doctor row: `repeated failures`, `budget` (role cap), `check`/`brief` (no-check, no-brief, brief-truncated), `role notes`, `principles`, `update` (stale build), `parallel instances` (stale claims and the instance pool), `quiet hours`, `maintenance allowance`, `provider waits`, `provider concurrency`, `pause`, `provider contention`/`check contention`/`workspaces` (contention and stale workspace pins), `regressed fixes`, and `image input` (images and image probes). The chain/fallback condition leaves with part 5c/6's fallback removal, which this part waits on.

**Approach.**
- Delete from src/ui/team-alert-status.ts: `pushChainAlert`, `pushRoleCapAlert`, `pushNoCheckAlert`, `pushNoBriefAlert`, `pushBriefTruncatedAlert`, `pushRoleNotesTruncatedAlert`, `pushPrinciplesTruncatedAlert`, `pushBuildAlert`, `pushStaleClaimsAlert` and their calls in `buildStatusAlerts`; keep the six kept builders.
- Delete from src/ui/team-alert-tail.ts: `pushQuietAlert`, `pushMaintenanceAlert`, `pushProviderHoldAlert`, `pushProviderCapsAlert`, `pushPausedAlert`, `pushContentionAlert`, `pushWorkspacePinsAlert`, `pushInstancePoolAlert`, `pushRegressedFixesAlert`, `pushImagesAlert`, `pushImageProbeAlert` and their calls in `buildTailAlerts`; keep `pushStoppedAlert`.
- Delete `capacityContention`, `providerCapProblems`, `instancePoolProblems`, `regressedFixesAlert`, `staleWorkspacePins` and the `CapacityBottleneck`/`RegressedFixAlert` types from src/ui/alert-feeds.ts / team-alert-shared.ts; keep `staleClaimEntries` (src/scheduling/claim-entries.ts), which the doctor's `parallel instances` row still reads.
- Update `teamAlerts`' parameters and the three call sites, and the team-alerts.test.ts / status-payload.test.ts cases; sweep docs/how-it-works.md's sentences naming these banners.
- Do not touch src/doctor/doctor-contention-checks.ts, doctor-project-checks.ts or doctor.ts: their rows are the detail.

**Files touched.** src/ui/team-alert-status.ts src/ui/team-alert-tail.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts

**Acceptance criteria.**
- `buildStatusAlerts` emits only main-red, failing-streak, stuck-role, spent-budget, disk and install-drift; `buildTailAlerts` emits only `stopped`. No other builder remains in either module.
- Each deleted condition prints its `tumwater doctor` row (listed above); the chain/fallback condition has no row because part 5c/6 removes fallback.
- `npm run test:gate` passes.

### Subtract, part 1e/6: The backlog staleness and structure banners go — stale questions, stalled entries, plan dependencies, stranded plans, duplicated headings, live archive, validation gaps and false fixes move to the doctor (planned 2026-10-26 by the plan role, split from the too-large part 1/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 6; requires Subtract part 1d/6 landed; touches src/ui/team-alert-backlog.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts)

**Previously held 1**

**Goal.** src/ui/team-alert-backlog.ts keeps its two decision-queue builders — `pushQuestionsAlert` (open questions need your answer) and `pushRefusedAlert` — and loses the rest: stale questions, stalled entries, plan dependencies, stranded plans, duplicated headings, finished history under a live `## Done`/`## Fixed`, validation gaps and false fixes. Each maps to a doctor row: `stale questions`, `stalled entries`, `plan dependencies`, `plans stuck in Planned`, `backlog headings`, `backlog archive`, `validation gaps`, `regressed fixes`. (`pushOperatorHeldAlert` is already gone after Subtract parts 2a–2c/6.)

**Approach.**
- Delete from src/ui/team-alert-backlog.ts: `pushStaleQuestionsAlert`, `pushStalledEntriesAlert`, `pushPlanDependencyAlert`, `pushStrandedPlansAlert`, `pushBacklogHeadingsAlert`, `pushBacklogArchiveAlert`, `pushValidationGapsAlert`, `pushFalseFixesAlert` and their calls in `buildBacklogAlerts`; keep `pushQuestionsAlert` and `pushRefusedAlert`.
- Delete the `staleOpenQuestions` and `planDependencyAlert` feeds and the `StaleQuestion`/`PlanDependencyProblem` types from src/ui/alert-feeds.ts / team-alert-shared.ts, plus `BacklogHeadingDuplicate`/`LiveFinishedEntry` when no kept builder reads them. Keep the shared structural readers (`stalledEntries`, `strandedPlanEntriesFor`, `duplicatedBacklogHeadings`, `liveFinishedEntriesFor`, `validationGapProblems`, `fixClaimProblems`) that the doctor checks call.
- Update `teamAlerts`' parameters and the three call sites, and the team-alerts.test.ts / status-payload.test.ts cases; sweep docs/how-it-works.md's sentences naming these banners.
- Remove any src/ui/team-alert-shared.ts export whose last caller this part deletes, verified by grep.
- Do not touch the doctor checks or their shared readers (src/doctor/doctor-backlog-plans.ts, doctor-backlog.ts): they are the detail.

**Files touched.** src/ui/team-alert-backlog.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts

**Acceptance criteria.**
- `buildBacklogAlerts` emits only the question and refused alerts; no other builder remains in the module.
- Each deleted condition prints its `tumwater doctor` row (listed above).
- No src/ui/team-alert-shared.ts export is left with zero callers in src/ui.
- `npm run test:gate` passes.

### Subtract, part 5u/6: The fallback circuit breaker, its half-open probe and the demotion state go — the gate resolves every tier from price alone (planned 2026-10-28 by the plan role, split from the too-large part 5l/6 after feature held it (held 1); the first of three runtime parts 5u/6–5w/6 replacing part 5l/6, ordered breaker → switch → config; requires Subtract part 5r/6, Subtract part 5s/6 and Subtract part 5t/6 landed, since the display surfaces this state fed are gone; touches src/budget/fallback-breaker.ts (deleted) src/budget/budget-fallback-view.ts src/budget/budget-wiring.ts src/budget/budget.ts src/gates/budget-gates.ts src/gates/gate-polls.ts src/orchestrator/orchestrator.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/orchestrator-launch.ts src/orchestrator/orchestrator-poll.ts src/team/team-orchestrator-info.ts src/merge/merge-verify.ts test/fallback-breaker.test.ts (deleted) test/budget.test.ts test/orchestrator-probe.test.ts test/orchestrator-launch.test.ts test/budget-wiring.test.ts test/gate-polls.test.ts test/orchestrator-fallback.test.ts)

**Goal.** Nothing judges whether a fallback can serve: a pair the price check accepts is usable, and no breaker, half-open probe, run-outcome evidence fold or published demotion survives. The price-resolved fallback itself stays until part 5v/6 removes it.

**Approach.**
- Delete `src/budget/fallback-breaker.ts` and every symbol it owned (`FallbackBreaker`, `FallbackBreakerMap`, `FALLBACK_BREAKER_POLICY`, `rekeyFallbackBreakers`, `fallbackServingPair`, `fallbackProbeDuePair`, `startFallbackProbeAt`, `abandonFallbackProbeAt`, `recordFallbackRunAt`, `fallbackDemotion`).
- `src/gates/budget-gates.ts`: drop `state.breakers`/`rekeyFallbackBreakers` and the demotion-aware `usable` predicate, so the gate's one resolution is `resolveTierFallbacks(liveConfig, pairFreeAt)` (today's `priceResolved`); the `default`/`strong` verdicts and the derived view read that.
- `src/budget/budget-wiring.ts` and `src/team/team-orchestrator-info.ts`: drop the `fallbackDemotions`/`fallbackDemoted` publish and parse.
- Orchestrator: remove the probe admission and the run-outcome evidence fold from `orchestrator-launch.ts` (`probePair`/`probeRoles`/`admittedProbe` and the `startFallbackProbeAt`/`abandonFallbackProbeAt`/`recordFallbackRunAt` calls), the `probePair`/`probeRoles` inputs from `orchestrator-scheduling.ts`/`orchestrator-poll.ts`, the `fallbackBreakerPolicy`/`breakerNow` seams from `orchestrator.ts`, and `merge-verify.ts`'s `fallbackDemotion` read.
- `src/budget/budget-fallback-view.ts` loses the `servingResolved`/`chainPairs`/`pairNames` inputs and derives from the price resolution alone.

**Acceptance criteria.**
- `grep -rniE 'fallback-breaker|FallbackBreaker|fallbackServingPair|fallbackProbeDue|fallbackDemotion|recordFallbackRun' src/` finds no live reference.
- A free fallback still engages at the cap from price alone; a fallback whose runs fail still engages — the demotion and probe are gone.
- `npm run test:gate` passes.

**Tests.** Delete `test/fallback-breaker.test.ts`; update the breaker/probe/demotion cases in `test/budget.test.ts`, `test/orchestrator-probe.test.ts`, `test/orchestrator-launch.test.ts`, `test/budget-wiring.test.ts`, `test/gate-polls.test.ts` and `test/orchestrator-fallback.test.ts`. Run them, then the project's gate, and confirm green.

### Subtract, part 5v/6: The budget gate pauses at the cap — the fallback switch, its derived config view and its per-run install go (planned 2026-10-28 by the plan role, split from the too-large part 5l/6 after feature held it (held 1); the second of three runtime parts 5u/6–5w/6 replacing part 5l/6; requires Subtract part 5u/6 landed, since the view this part deletes reads the gone serving-resolved verdict; touches src/budget/budget-fallback-view.ts (deleted) src/budget/budget.ts src/budget/budget-wiring.ts src/gates/budget-gates.ts src/gates/gate-polls.ts src/gates/startup-gate.ts src/orchestrator/orchestrator.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts docs/invariants.md test/orchestrator-fallback.test.ts (deleted) test/budget-gates.test.ts test/budget-chain-info.test.ts test/budget-wiring.test.ts test/gate-polls.test.ts test/orchestrator-budget.e2e.test.ts test/run-resume.test.ts test/config-views.test.ts test/gate-event-best-effort.test.ts)

**Goal.** At `maxDailyCostUsd` a role starts no run until local midnight: the gate has `open` and `paused` only, there is no derived fallback config, no `budget_fallback`/`budget_handback`/`fallback_switched` event and no per-run install.

**Approach.**
- `src/budget/budget.ts`: `BudgetGate` becomes `"open" | "paused"` and `budgetGate` returns `paused` when reached; keep `fallbackTierEntries` (still read by `src/events/event-format.ts`'s `subscription_window_limited` case).
- `src/gates/budget-gates.ts`: `pollBudgetGate` keeps the spend read, the `budget_*` edge events minus the fallback ones, and the used-up-subscription-window hold; delete `pairFreeAt`/`resolveTierFallbacks`/`budgetFallbackView`, the `BudgetFallbackView`, and the derived `fallbackConfig`/`windowOut`/`windowTiers`/`windowResumedBackends`/`chain` fields from `BudgetGateState`/`BudgetGatePoll`.
- `src/budget/budget-wiring.ts`: drop the demotion publish, the `fallback_switched` event and `handBackFallbackRuns`; `src/gates/gate-polls.ts`, `src/gates/startup-gate.ts`, `src/orchestrator/orchestrator.ts` and `src/orchestrator/orchestrator-poll.ts` drop the fallback reads they carried.
- Delete `src/budget/budget-fallback-view.ts`; `src/merge/merge-verify.ts` builds its throwaway author from the live config alone.
- `docs/invariants.md` drops the budget-fallback-chain guarantees.

**Acceptance criteria.**
- `grep -rniE 'budgetFallbackView|BudgetFallbackView|fallbackConfig|budget_handback|fallback_switched' src/` finds no live reference.
- At the cap a role logs `budget_paused` and stays paused until local midnight; raising the cap or midnight resumes it on the next poll; the director keeps its model as today.
- `npm run test:gate` passes.

**Tests.** Delete `test/orchestrator-fallback.test.ts`; update `test/budget-gates.test.ts`, `test/budget-chain-info.test.ts`, `test/budget-wiring.test.ts`, `test/gate-polls.test.ts`, `test/orchestrator-budget.e2e.test.ts`, `test/run-resume.test.ts`, `test/config-views.test.ts` and `test/gate-event-best-effort.test.ts`. Run them, then the project's gate, and confirm green.

### Subtract, part 5w/6: The fallback config resolution goes — nothing resolves a tier to a fallback pair and the status and pi views stop reading one (planned 2026-10-28 by the plan role, split from the too-large part 5l/6 after feature held it (held 1); the third of three runtime parts 5u/6–5w/6 replacing part 5l/6, and the last part to read the fallback config before part 5m/6 deletes the keys; requires Subtract part 5v/6 landed, since the gate and view this part removes were the resolution's runtime readers; touches src/config/config-fallbacks.ts src/config/config-views.ts src/config/config-field-checks.ts src/config/config-selector-checks.ts src/config/config-validation-model.ts src/gates/startup-gate.ts src/status/status-budget.ts src/status/status-data.ts src/pi/pi-models.ts docs/invariants.md test/config-views.test.ts test/config-validation.test.ts test/status-budget.test.ts)

**Goal.** No function resolves a tier to a fallback pair: `config-fallbacks.ts`'s fallback half is gone, `seamsInUse` lists only the live seams, and the status and pi views read no fallback.

**Approach.**
- Delete from `src/config/config-fallbacks.ts` the fallback resolution and its helpers — `fallbackPair`, `legacyFallbackPair`, `TierFallback`/`TierFallbackMap`, `tierOwnChain`, `tierChainSteps`, `resolveTierFallbacks`, `tierFallbackLabels`, `tiersResolveDistinctPairs`, `applyFallbackModel`, `fallbackReview`, `stripRoleModels`/`freeRoleModels` — and the `tierChainSteps` loop `seamsInUse` adds; keep `seamsInUse` and its live-seam set.
- Remove the fallback fields and validation from `config-views.ts`, `config-field-checks.ts`, `config-selector-checks.ts` and `config-validation-model.ts` (the `fallback`/`fallbackModel`/`fallbackStepCaps` handling), leaving the schema keys themselves to part 5m/6.
- `src/status/status-budget.ts` and `src/status/status-data.ts` drop their fallback tier-map reads; `src/pi/pi-models.ts` drops `fallbackModelPair` and its resolution read.
- `docs/invariants.md` drops the fallback-resolution guarantees.

**Acceptance criteria.**
- `grep -rniE 'fallbackPair|resolveTierFallbacks|tierFallbackLabels|tiersResolveDistinctPairs|applyFallbackModel|fallbackModelPair' src/` finds no live reference.
- `seamsInUse` lists only enabled roles, the review gate, the resolver and the director; a `fallback` key is still declared by the schema but no code reads or validates it (part 5m/6 refuses it by name).
- `npm run test:gate` passes.

**Tests.** Update `test/config-views.test.ts`, `test/config-validation.test.ts` and `test/status-budget.test.ts`; run them, then the project's gate, and confirm green.

### Subtract, part 5m/6: The fallback config keys, their editors and docs go (planned 2026-10-27 by the plan role; the seventh part replacing part 5c/6; requires Subtract part 5w/6 landed, since nothing reads the keys once the chain and its resolution are gone; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-validation-model.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-write.ts src/config/config-example.ts src/config/config-views.ts src/cli/config-commands.ts src/cli/help.ts src/ui/tui/tui-editor-fallback.ts (deleted) src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/tui/tui-pane-ctx.ts docs/config.md docs/backends.md docs/how-it-works.md docs/invariants.md tumwater.example.json test/config.test.ts test/config-validation.test.ts test/config-views.test.ts test/config-commands.test.ts test/config-write.test.ts test/tui-fallback.test.ts (deleted))

**Goal.** `tumwater.json` has no fallback keys and no editor offers one: `fallback`, `fallbackModel` and `fallbackStepCaps` are gone, and setting one is refused by name.

**Approach.**
- Schema: delete the `fallback` key, `fallbackModel`/`FallbackModelConfig`, `FallbackStep`, `FALLBACK_STEP_KEYS`, `FallbackChain`, `fallbackStepCaps` and the model-map fallback permit (`src/config/config-schema.ts`).
- Validation and keys: delete `validateFallbackBlock`, `checkFallbackList`/`checkFallbackStep` and the `fallback`/`fallbackModel` arms (`config-validation.ts`, `config-validation-model.ts`); the dotted-key/editable/write handling and the legacy `provider`/`fallbackModel` verb (`config-keys.ts`, `config-editable-keys.ts`, `config-write.ts`); the example (`config-example.ts`).
- Views: delete the remaining fallback comment/fields in `config-views.ts` (`fallbackDisplayPair` and its permit) and whatever `config-fallbacks.ts` still holds only for the maps.
- TUI/CLI: delete `src/ui/tui/tui-editor-fallback.ts` and its `fallbackMode`/`held.fallback` wiring (`tui-editors.ts`, `tui-keys.ts`, `tui-frame.ts`, `tui-pane-ctx.ts`); drop the `config set fallbackModel` verb (`cli/config-commands.ts`, `cli/help.ts`).
- Docs: `docs/config.md`, `docs/backends.md`, `docs/how-it-works.md` and `docs/invariants.md` describe no fallback keys; `tumwater.example.json` loses them.

**Acceptance criteria.**
- `grep -rniE 'fallbackModel|fallbackStepCaps|FALLBACK_STEP_KEYS|FallbackStep|FallbackChain|validateFallbackBlock' src/` finds no live reference outside the superseded plans/ and docs prose.
- A `tumwater.json` with `fallback` or `fallbackModel` is refused naming the key; no TUI editor or `config set` verb offers one.
- `npm run test:gate` passes.

**Tests.** Update `test/config.test.ts`, `test/config-validation.test.ts`, `test/config-views.test.ts`, `test/config-commands.test.ts` and `test/config-write.test.ts`; delete `test/tui-fallback.test.ts`. Run them, then the project's gate, and confirm green.

### Subtract, part 5d/6: The subscription-window carve-outs and the per-backend account file go (planned 2026-10-26 by the plan role, split from the too-large part 5/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 5, and plans/codex-backend.md; requires Subtract part 5m/6 landed, since all four fallback-removal parts edit the same config, gate and status files this part touches; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-validation-roles.ts src/config/config-views.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-write.ts src/config/config-example.ts src/agent/subscription-account.ts src/agent/claude/claude-account.ts src/agent/codex/codex-account.ts src/team/team-polls.ts src/gates/gate-polls.ts src/gates/budget-gates.ts src/run/run-finalize.ts src/merge/merge-slot.ts src/doctor/doctor-holds.ts src/doctor/doctor-check-names.ts src/ui/badges.ts src/ui/status-payload.ts src/status/status-budget.ts src/status/status-roles.ts src/roles/role-render.ts src/roles/role-view.ts src/pi/pi-models.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts docs/config.md docs/backends.md docs/how-it-works.md docs/invariants.md test/doctor-holds.test.ts test/config.test.ts test/doctor-checks.test.ts)

**Previously held 1**

**Goal.** The team stops reserving, holding and warning on subscription usage windows. `claudeWindowReserve`/`backends.<id>.windowReserve`, the `windowReserveFor` carve-out, the window hold/reserve/warning loops, the `claude window`/`codex window` rows and the `.tumwater/state/<backend>-account.json` file are deleted. A run's own `PiRunResult` (`transientRateLimit`, `rateWindows`, `billing`) stays the live signal for a window rejection the run resumes from, and `maxDailyCostUsd`'s own spend ledger (src/budget/budget.ts) keeps the cap.

**Approach.**
- Config: delete the top-level `claudeWindowReserve` and `backends.<id>.windowReserve` keys (`src/config/config-schema.ts` `windowReserve`, `CLAUDE_AGENT_KEYS`/`CODEX_BACKEND_KEYS`), their validation (`src/config/config-validation.ts` `checkWindowReserve`, `src/config/config-validation-roles.ts` `validateClaudeWindowReserve`), `windowReserveFor` (`src/config/config-views.ts`), the editable key, the example and the GUI/TUI rows (`src/ui/gui/gui-client-settings.ts`, `src/ui/tui/tui-editor-claude-reserve.ts` and its mode wiring); `config-write.ts`'s nested-reserve collapse goes.
- Delete `src/agent/subscription-account.ts` and the window reads in `src/agent/claude/claude-account.ts`/`codex-account.ts`; delete the window hold/reserve/warning loop and `windowObservation`/`pollClaudeWindowReserve`/`pollClaudeWindowWarning` (`src/team/team-polls.ts`, `src/gates/gate-polls.ts`) and the budget gate's `claudeWindowUsedUp`/`windowReserveFor` use (`src/gates/budget-gates.ts`); drop the `observeAccount` writes (`src/run/run-finalize.ts`, `src/merge/merge-slot.ts`).
- Delete the rows and display: `checkSubscriptionWindow` and the `claude window`/`codex window` rows (`src/doctor/doctor-holds.ts`, `src/doctor/doctor-check-names.ts`); the window badges and status fields (`src/ui/badges.ts`, `src/ui/status-payload.ts`, `src/status/status-budget.ts`, `src/status/status-roles.ts`, `src/roles/role-render.ts`, `src/roles/role-view.ts`, `src/pi/pi-models.ts`'s account reads).
- Docs: `docs/config.md`, `docs/backends.md`, `docs/how-it-works.md`, `docs/invariants.md`. Tests: drop the window cases from `test/doctor-holds.test.ts`; update `test/config*.test.ts`, `test/doctor-checks.test.ts`.

**Acceptance criteria.**
- `grep -rnE 'SubscriptionAccount|subscription-account|windowReserveFor|claudeWindowReserve|windowReserve|claude window|codex window|observeAccount' src/` finds no live reference; no `.tumwater/state/<backend>-account.json` is read or written.
- A run rejected on a subscription usage window still keeps its session and resumes on the live `PiRunResult` flags, and a spent `maxDailyCostUsd` still pauses the role.
- `claude window` and `codex window` are gone from `DOCTOR_CHECK_NAMES`; a config setting either reserve key is refused by name.
- `npm run test:gate` passes.

### Subtract, part 5e/6: The model tier map goes — `model` names one entry per role and seam (planned 2026-10-26 by the plan role, split from the too-large part 5/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 5, and plans/model-tiers.md; requires Subtract part 5d/6 landed, since the fallback resolution keyed by tier and the account reads go with the parts ahead of it; touches src/config/config-schema.ts src/config/config-validation-model.ts src/config/config-validation.ts src/config/config-views.ts src/config/config-write.ts src/config/config-write-core.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-example.ts src/roles/role-catalog.ts src/roles/role-render.ts src/roles/role-view.ts src/ui/badges.ts src/ui/status-render.ts src/ui/status-payload.ts src/ui/gui/gui-client-settings.ts src/ui/gui/gui-client-drawer-config.ts src/ui/tui/tui-editor-model.ts docs/config.md docs/how-it-works.md docs/invariants.md tumwater.example.json test/config-views.test.ts test/config-validation-model.test.ts test/doctor-checks.test.ts)

**Previously held 1**

**Goal.** The top-level `model` map is keyed by role or seam id → selector; `small`/`default`/`strong`, `MODEL_TIERS`, `modelTierMap`, `isTierName` and the catalog `tier` field are deleted. The resolution rule is one line: a run runs `roles.<id>.model` (the seam's own override, e.g. `review.model`) else `model.<id>` else pi's default — there is no tier fallback.

**Approach.**
- Schema and validation: delete `MODEL_TIERS`/`ModelTier`, `modelTierMap`, `TIER_MAP_KEYS`, the tier-name arm of the model-shape check and the map-by-tier shape; `model` becomes the role/seam-keyed map (`src/config/config-schema.ts`, `src/config/config-validation-model.ts`, `src/config/config-validation.ts`); a `model` key that is not a role/seam id (including `default`) is refused by name rather than silently never resolving. `config-views.ts` loses `isTierName`, `topTierSelector`, `resolveTopTier`, `topTierBackend`, `tierModel` and the `withModelOverrides` tier argument in favour of the one rule; `config-write`/`config-keys`/`config-editable-keys`/the example follow.
- Catalog: `src/roles/role-catalog.ts` drops `tier: ModelTier` from every role entry (and its type); the role's model is the config map's, else pi's default. `src/roles/role-render.ts`/`role-view.ts` drop the tier label.
- Surfaces: delete the `models for each tier` row and its check, and the tier names in badges/status (`src/ui/badges.ts`, `src/ui/status-render.ts`, `src/ui/status-payload.ts`, `src/ui/gui/gui-client-settings.ts`, `src/ui/gui/gui-client-drawer-config.ts`, `src/ui/tui/tui-editor-model.ts`).
- Docs and example: `docs/config.md`, `docs/how-it-works.md`, `docs/invariants.md`, `tumwater.example.json` describe the role/seam map; `plans/model-tiers.md` gets a superseded head note. Tests: update `test/config-views.test.ts`, `test/config-validation-model.test.ts`, `test/doctor-checks.test.ts`.

**Acceptance criteria.**
- `grep -rnE 'MODEL_TIERS|ModelTier|modelTierMap|isTierName|topTierSelector|tierModel|models for each tier' src/` finds no live reference.
- One place names a run's model: `roles.<id>.model`/the seam override, else `model.<id>`, else pi's default; a run never substitutes a different model.
- A `tumwater.json` whose `model` map has a `small`/`default`/`strong` key (or a role modelled as a tier name) is refused with a message naming the bad key; the example config uses the role/seam spelling.
- `npm run test:gate` passes.

### Subtract, part 5q/6: The budget-fallback event vocabulary goes — no event type, label, feed line or failure line names the removed episode (planned 2026-10-27 by the plan role, split 2026-10-27 by the plan role from the held part 5k/6 after feature held it as too large/vitiated: the three `HarnessEvent` members could only be deleted once part 5v/6 removed their producers, so this part requires Subtract part 5v/6 landed; the eighth part replacing part 5c/6; sibling to parts 5r/6 and 5s/6, which remove the display surfaces, and independent in file of part 5m/6, which takes the config keys, since neither edits `src/events` or `src/failure`; touches src/events/events.ts src/events/event-labels.ts src/events/event-format.ts src/failure/failure-state-change.ts test/event-format.test.ts test/event-format-team.test.ts test/failure-state-change.test.ts test/failure-render.test.ts)

**Goal.** `budget_fallback`, `budget_handback` and `fallback_switched` no longer exist as event types: the union, its labels, the feed formatter, the failure digest and the `budget_paused` cause branches that named an over-cap model drop them. Their producers left in part 5v/6, so no live event can carry them.

**Approach.**
- `src/events/events.ts`: delete the `budget_fallback`, `budget_handback` and `fallback_switched` members from the `HarnessEvent` union.
- `src/events/event-labels.ts`: delete their `EVENT_TYPE_LABELS` entries (`over-cap model`, `returned to main model`, `fallback switched`).
- `src/events/event-format.ts`: delete the `budget_fallback`, `budget_handback` and `fallback_switched` cases and remove the three names from the `budgetEventMessage` case list; delete `providerModelPair`, whose only caller was the `budget_fallback` case, with the shared comment that names it; and drop the `fallbackRejected`/`fallbackDemoted` branches from the `budget_paused` case, whose producer part 5v/6 removed.
- `src/failure/failure-state-change.ts`: delete the three names from the tracked-event list, the `budget_fallback` case in `budgetStateChange`, the `fallback_switched` and `budget_handback` cases in `modelStateChange`, and the now-unused `providerModel` helper; drop the `fallbackRejected`/`fallbackDemoted` branches from `budgetStateChange`'s `budget_paused` case.

**Acceptance criteria.**
- `grep -rn 'budget_fallback\|budget_handback\|fallback_switched' src/` finds nothing; `grep -rn 'fallbackDemoted\|fallbackRejected' src/events src/failure` finds nothing.
- No `case "budget_fallback"`, `case "budget_handback"` or `case "fallback_switched"` remains in `formatEvent` or `describeStateChange`.
- `npm run test:gate` passes.

**Tests.** Update `test/event-format.test.ts`, `test/event-format-team.test.ts`, `test/failure-state-change.test.ts` and `test/failure-render.test.ts`: remove the fallback-event fixtures and assertions, and the `budget_paused` `fallbackRejected`/`fallbackDemoted` cases. Run them, then the project's gate, and confirm green.

### `readRunTranscript`'s complexity-15 segment scan is split into one named helper per phase — the per-file line segmentation, the window filter that keeps the in-range segments, and the optional grep post-filter — so "how are a pi log file's lines split into run segments?", "which segments fall inside the requested window?" and "how is `--grep` applied to the rendered entries?" are each found by name (planned 2026-10-28 by the plan role; continues the landed split-large-function family — the 2026-10-28 `resolveRunStartDecision`, `applyRateLimit`, `fishFlagValue`, `piCredentialValues`, `skipWhitespaceAndComments` and `buildCandidate` plans each extract one named helper per concern the same way, as the 2026-10-25 `handleRateLimitEvent`/`PiStreamParser.feedLine` plans split sibling bodies; independent in file of every `## Planned` entry — before this entry `grep -c 'readRunTranscript' PLANS.md`, `grep -c 'transcript-run' PLANS.md` and `grep -c 'src/ui/transcript-run' PLANS.md` all print 0, so no `## Planned` heading or touches list names the symbol or the file (the blocked `Every commit is verified on main` parts touch src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/status, src/doctor, src/config, src/cli, src/roles, src/ui, src/gui, src/run, src/agent and src/pi, and the blocked and refused `Subtract` parts touch those plus src/events and src/failure, never src/ui/transcript-run.ts; the five in-flight plans take src/agent/opencode/opencode-config.ts, src/review/secret-leaks.ts, src/pi/pi-stream.ts, src/cli/completion.ts and src/config/config-request.ts, none of them this file); PLANS-DONE.md records no split of `readRunTranscript` (`grep -cE '^### .*readRunTranscript' PLANS-DONE.md` prints 0; the three headings matching `transcript-run` are the 2026-10-19 `--transcript` feature that created the function whole, the 2026-10-19 `--prompt` feature and the 2026-10-20 `--grep` feature, each extending it, not a split of its body); docs/invariants.md names neither the symbol nor the file (`grep -c 'readRunTranscript' docs/invariants.md` and `grep -c 'transcript-run' docs/invariants.md` both print 0), so it stays unchanged; touches src/ui/transcript-run.ts)

**Goal.** `readRunTranscript` (src/ui/transcript-run.ts) renders one past run's agent transcript for `tumwater history <role> <n> --transcript`: for the live pi log and its one rotated generation it splits the lines into run segments, keeps the segments whose start is inside the window, renders them through `formatTranscript`, and optionally filters them through the `--grep` filter. It is one body (complexity 15) that does the line-segmentation, the window test and the grep fold inline, so each phase is found only by scanning it. Split each phase into a named helper and leave `readRunTranscript` the short composition. No behavior change; `segmentStart` keeps its own body (complexity 9).

**Approach.** All edits in src/ui/transcript-run.ts; move the existing code arms, do not rewrite them, move each existing comment with the helper that owns the code it describes, keep `readRunTranscript`'s doc comment on `readRunTranscript`, and add no import (`createTranscriptFilter`, `formatTranscript` and `parsePiEventLine` are already imported). Declare three non-exported helpers beside `readRunTranscript`:

- `function segmentsInText(text: string): string[][]` — today's inner line loop verbatim: a fresh `segments`, the `for (const line of text.split("\n"))`, `if (line === "") continue`, and the `line.includes('"tumwater_run"') && parsePiEventLine(line, MARKER_ONLY)` test that either pushes a fresh `[line]` or falls to `segments.at(-1)?.push(line)`.
- `function keepInWindow(segments: string[][], fromTs: number, toTs: number | null): string[]` — today's segment loop verbatim minus the file loop: a fresh `kept`, `for (const seg of segments)`, `const start = segmentStart(seg)`, and the `start !== null && start >= fromTs && start <= (toTs ?? Infinity)` test before `kept.push(...seg)`.
- `function applyTranscriptGrep(entries: string[][], grep: string): string[]` — today's tail verbatim: `const keep = createTranscriptFilter(grep); return entries.flatMap((e) => keep(e) ?? []);`.

`readRunTranscript` then reads the same order: the `kept` accumulator, the `for (const f of [file + ".1", file])` read with its `try`/`catch` `continue`, `kept.push(...keepInWindow(segmentsInText(text), fromTs, toTs))`, `const entries = formatTranscript(kept, opts)`, then `if (opts.grep === undefined) return entries.flat();` and `return applyTranscriptGrep(entries, opts.grep);`.

**Files touched.** src/ui/transcript-run.ts

**Acceptance criteria.**
- The three helpers are each declared exactly once and are not exported: `grep -nE 'function (segmentsInText|keepInWindow|applyTranscriptGrep)\(' src/ui/transcript-run.ts` shows one declaration per name, and `grep -nE '^export ' src/ui/transcript-run.ts` still matches only `readRunTranscript` (it is the file's only export today).
- The complexity falls: `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/ui/transcript-run.ts` reports `readRunTranscript` at no more than 5 (it reports 15 today), `segmentsInText` and `keepInWindow` each at no more than 6, and `applyTranscriptGrep` at no more than 1 (a run of the proposed body against the same config reported 5, 6, 6 and 1), and reports no other function in the file higher than it does today (`segmentStart` keeps 9).
- Behaviour is preserved: the rotated generation is still read before the live file, a missing file still contributes nothing, a marker without `ts` still falls back to its first user `message_end` `timestamp`, the window test is still inclusive on both bounds with `null` `toTs` open-ended, and the `grep` filter still runs only after `formatTranscript` so a hit keeps its run separator, so every existing `test/transcript-run.test.ts` case is green.
- No edit lands outside src/ui/transcript-run.ts; docs/invariants.md is not edited (`grep -c 'readRunTranscript' docs/invariants.md` prints 0); `readRunTranscript` keeps its export, signature and doc comment, and no other function's code or count changes.

**Tests.** No new test module: a behaviour-preserving private move guarded by the existing suite. Run `test/transcript-run.test.ts` ("readRunTranscript keeps only segments whose start is inside the window", "readRunTranscript reads the rotated generation first, then the live file", "a legacy marker without ts falls back to its first user message timestamp", "a missing file yields nothing and a labeled marker renders its separator", "readRunTranscript with grep keeps only matching entries, under their run's separator") and the project's gate, and confirm green.

### `feedLine`'s complexity-15 progress-event fold is split into one named helper per event family — the session reset, the tool-execution start, the tool-execution update/end, and the assistant-message turn — so "what does a new session reset?", "how is an open tool call started and tracked?" and "how does an assistant message fold its usage and work item?" are each found by name (planned 2026-10-28 by the plan role; continues the landed split-large-function family — the 2026-10-28 `resolveRunStartDecision`, `applyRateLimit`, `fishFlagValue`, `piCredentialValues`, `skipWhitespaceAndComments`, `buildCandidate` and `readRunTranscript` plans each extract one named helper per concern the same way, as the 2026-10-25 `PiStreamParser.feedLine` plan split its own event families; independent in file of every `## Planned` entry — before this entry `grep -c 'progress-data' PLANS.md` and `grep -c 'src/ui/progress-data' PLANS.md` both print 0, so no `## Planned` heading or touches list names the file (the blocked `Every commit is verified on main` and `Subtract` parts touch src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/status, src/doctor, src/config, src/cli, src/roles, src/ui, src/gui, src/events, src/backlog, src/run, src/agent and src/pi, and the five in-flight plans take src/agent/opencode/opencode-config.ts, src/review/secret-leaks.ts, src/pi/pi-stream.ts, src/cli/completion.ts and src/config/config-request.ts, none of them src/ui/progress-data.ts); PLANS-DONE.md records no split of this `feedLine` (`grep -cE '^### .*progress-data' PLANS-DONE.md` prints 2, both feature entries — the Plain terms runner's part 6c/14 and the OpenCode backend's part 1/7 — and neither splits it; the one heading that splits a `feedLine`, `grep -nE '^### .*PiStreamParser.feedLine' PLANS-DONE.md`, is the 2026-10-25 split of src/pi/pi-stream.ts, and the four other headings that merely mention `feedLine` in prose are other helpers' splits citing that landed parent); docs/invariants.md names the file once, in INV-A2 for `stalledToolLabel` (`grep -c 'feedLine' docs/invariants.md` prints 0), which this move does not touch, so it stays unchanged; touches src/ui/progress-data.ts)

**Goal.** `feedLine` (src/ui/progress-data.ts) folds one parsed pi progress event into a `LiveProgress`: a `session` event resets the whole accumulator, a `tool_execution_start` counts the call and records its label and open-call entry, a `tool_execution_update`/`tool_execution_end` folds through `applyToolExecutionEvent`, and an assistant `message_end` counts the turn and folds usage/peak/context and the first work item. It is one body (complexity 15) with every family's code inline in one `switch`, so each family is found only by scanning it. Split each family into a named helper and leave `feedLine` the dispatch.

**Approach.** All edits in src/ui/progress-data.ts; move the existing code arms, do not rewrite them, move each existing comment with the helper that owns the code it describes, keep `feedLine`'s doc comment on `feedLine` and `ProgressEvent`'s field comments where they are, and add no import (`freshProgress`, `describeToolCall`, `applyToolExecutionEvent`, `toolCallCommand` and `nonNegativeNumber` are already in scope). Declare four non-exported helpers beside `feedLine`:

- `function applySessionEvent(progress: LiveProgress): void` — today's `session` arm verbatim: `Object.assign(progress, freshProgress(progress.quietMs));`.
- `function applyToolStart(progress: LiveProgress, event: ProgressEvent): void` — today's `tool_execution_start` block verbatim: the `progress.toolCalls += 1`, the `event.toolName ? describeToolCall(event.toolName, event.args) : undefined`, the `if (label) progress.lastTool = label;`, and the `applyToolExecutionEvent(progress.openToolCalls ??= [], event.type, event.toolCallId, event.partialResult, label ?? "tool", toolCallCommand(event.args))` call with its comment on concurrent tool calls.
- `function applyToolProgress(progress: LiveProgress, event: ProgressEvent): void` — today's `tool_execution_update`/`tool_execution_end` arm verbatim: `if (progress.openToolCalls) applyToolExecutionEvent(progress.openToolCalls, event.type, event.toolCallId, event.partialResult);`.
- `function applyAssistantTurn(progress: LiveProgress, event: ProgressEvent): void` — today's `message_end` block verbatim: the `if (event.message?.role !== "assistant") return;` guard, the `progress.turns += 1`, the `if (usage)` block reading `nonNegativeNumber` for context/output/peak, and the `if (!progress.currentWork) progress.currentWork = workItemFromContent(event.message.content);` line, with its usage-guard and first-text comments.

`feedLine` then keeps its same `switch (event.type)` order but each arm is one call: `case "session": applySessionEvent(progress); break;`, `case "tool_execution_start": applyToolStart(progress, event); break;`, the shared `case "tool_execution_update":`/`case "tool_execution_end":` calling `applyToolProgress(progress, event)`, and `case "message_end": applyAssistantTurn(progress, event); break;`. `PROGRESS_TYPES` stays unchanged and its comment still tells a new event family to register there.

**Files touched.** src/ui/progress-data.ts

**Acceptance criteria.**
- The four helpers are each declared exactly once and are not exported: `grep -nE 'function (applySessionEvent|applyToolStart|applyToolProgress|applyAssistantTurn)\(' src/ui/progress-data.ts` shows one declaration per name, and `grep -nE '^export ' src/ui/progress-data.ts` still matches only `LiveProgress`, `findSeedOffset`, `ProgressRunKind`, `parseProgress`, `toolCallStallMs`, `stalledToolLabel` and `readLiveProgress` (the file's exports today).
- The complexity falls: `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/ui/progress-data.ts` reports `feedLine` at no more than 6 (it reports 15 today), `applyToolStart` and `applyAssistantTurn` each at no more than 5, `applyToolProgress` at no more than 2 and `applySessionEvent` at no more than 1 (a run of the proposed bodies against the same config reported 6, 5, 5, 2 and 1), and reports no other function in the file higher than it does today (`workItemFromContent` at 7, `stalledToolLabel` and `feedDemuxed` each at 10, `findSeedOffset` at 5 and the rest unchanged).
- Behaviour is preserved: a `session` event still restores exactly `freshProgress(progress.quietMs)`, a start still counts the call, records `lastTool` and seeds the open-call entry with `label ?? "tool"`, an update/end still folds only when an open call is tracked, and an assistant `message_end` still counts the turn, folds usage with `nonNegativeNumber` (a corrupt count keeps context, adds zero output and floors peak at the prior value), and sets `currentWork` only when it is unset, so every existing `test/progress.test.ts` case is green.
- No edit lands outside src/ui/progress-data.ts; docs/invariants.md is not edited (`grep -c 'feedLine' docs/invariants.md` prints 0, and INV-A2's `progress-data.ts` binding is `stalledToolLabel`, untouched here); `feedLine` keeps its signature and doc comment, and no other function's code or count changes.

**Tests.** No new test module: a behaviour-preserving private move guarded by the existing suite. Run `test/progress.test.ts` ("parseProgress counts turns/tools and tracks the latest context size", "parseProgress resets at a new session (previous run's events ignored)", "parseProgress accumulates output tokens and peak context for the current run", "parseProgress ignores corrupt usage numbers instead of poisoning the live cell", "parseProgress captures the first assistant text as the current work item", "parseProgress tracks open tool calls and clears them at end", "a content-bearing tool_execution_update moves the open call's activity clock", "content-free tool_execution_updates leave the activity clock alone (no keepalive masking a hang)") and the project's gate, and confirm green.

## Done
