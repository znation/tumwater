# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; split 2026-10-25 by the plan role — the gate-scope narrowing moved to part 3m/3, then split again the same day after feature held it too large (held 6): the migration of the pre-merge reviewer's merge-verify and pipeline/runner/e2e cases moved to parts 3p/3–3w/3, so this part now requires parts 3g/3, 3l/3, 3p/3, 3z/3, 4a/3, 3q/3, 3r/3, 3s/3, 3t/3, 3u/3, 3v/3, 3w/3, 3x/3 and 3y/3 landed — 3g/3's universal post-landing review and 3l/3's review-suite retirement are on main, and 3p/3–3y/3 must retire the remaining reviewer-run cases before the run they assert goes; touches src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts)

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

### Every commit is verified on main, part 3p/3: the pre-merge reviewer's approved-merge, durable-verdict and rejected-merge cases in test/merger.test.ts are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split again 2026-10-26 by the plan role after feature held the too-large part 3p/3 nine times (held 9): the first of three finer parts replacing part 3p/3's one-file scope, sibling to parts 3z/3 and 4a/3, which take the same file's reviewer-failure and conflict-resolution cases and serialise behind this one, so this part holds no prerequisite and part 3z/3 serialises behind it; touches test/merger.test.ts)

**Goal.** Part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes the `test/merger.test.ts` cases that reach a merge through a `reviewerPi` approval fail. Move the approved-merge and merge-bookkeeping cases first, as part 3l/3 did for `test/review.test.ts` and `test/review-precheck.test.ts`, so the source switch lands against a suite that no longer depends on the reviewer. Part 3z/3 takes the reviewer-failure, strike and abort cases that follow; part 4a/3 takes the conflict-resolution and re-review cases; part 3x/3 takes the rebase/check/batch/stack blocks below `a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both`.

**Approach.** In `test/merger.test.ts`, retire or re-point the pre-merge reviewer cases `an approved merge merges on main and deletes the ref`, `the gate's verdict is durable on disk before the run's end save`, and `a rejected merge merges nothing: role worktree clean at main, ref deleted, reasons recorded`. Delete a case that exists only to pin the reviewer, or re-point its rejection trigger to a deterministic gate rejection (a `diffRuleReasons` finding such as a conflict-marker diff or a leaked credential, or a failing declared check) when its real subject is the merge or verify bookkeeping that survives. Leave every other case untouched — parts 3z/3, 4a/3 and 3x/3 own those. Leave the reviewer-run helpers (`reviewerPi`, `APPROVE_PI`, `perRoleReviewerPi`, `reviewerByRole`) in `test/fixtures/pi-events.ts` and `test/fixtures/merger-fixtures.ts` in place and edit neither fixture file: the reviewer still runs until part 3h/3, and part 3e/3 deletes the helpers with the plumbing.

**Files touched.** test/merger.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the three cases named in Approach for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Every case that remains keeps its original subject (merge or verify bookkeeping) and asserts the same outcome through a deterministic rejection.
- No edit outside test/merger.test.ts.

### Every commit is verified on main, part 3z/3: the pre-merge reviewer's retry, strike and abort cases in test/merger.test.ts are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-26 by the plan role, split from the too-large part 3p/3 after feature held it nine times (held 9): the second of three finer parts replacing part 3p/3's one-file scope, sibling to parts 3p/3 and 4a/3, requires part 3p/3 landed since all three edit test/merger.test.ts and part 3p/3's edits there must settle first; touches test/merger.test.ts)

**Goal.** The reviewer-failure twin of part 3p/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes the `test/merger.test.ts` cases that reach a merge or recovery through a reviewer failure, a verdict-less result or an abort fail because each drives `review_error`/`reviewRetries` bookkeeping. Move those cases next, after part 3p/3's outcome cases, so the source switch lands against a suite that no longer depends on the reviewer. Part 4a/3 takes the conflict-resolution and re-review cases; part 3x/3 takes the rebase/check/batch/stack blocks below `a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both`.

**Approach.** In `test/merger.test.ts`, retire or re-point the pre-merge reviewer cases `a reviewer killed once (exit 143) is retried in the verify: the change merges with no merge_failed`, `a verdict-less failure under the strike cap returns review_error and keeps the ref`, `three verdict-less failures discard the merge and delete the ref`, and `an abort mid-review returns aborted and keeps the ref`. Delete a case that exists only to pin the reviewer, or re-point its rejection trigger to a deterministic gate rejection (a `diffRuleReasons` finding such as a conflict-marker diff or a leaked credential, or a failing declared check) when its real subject is the strike-cap, retry or abort bookkeeping that survives. Leave the cases parts 3p/3 and 4a/3 own untouched, and leave the reviewer-run helpers (`reviewerPi`, `APPROVE_PI`, `perRoleReviewerPi`, `reviewerByRole`) in `test/fixtures/pi-events.ts` and `test/fixtures/merger-fixtures.ts` in place and edit neither fixture file: the reviewer still runs until part 3h/3, and part 3e/3 deletes the helpers with the plumbing.

**Files touched.** test/merger.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the four cases named in Approach for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Every case that remains keeps its original subject (retry, strike-cap or abort bookkeeping) and asserts the same outcome through a deterministic rejection.
- No edit outside test/merger.test.ts.

### Every commit is verified on main, part 4a/3: the pre-merge reviewer's conflict-resolution and re-review cases in test/merger.test.ts are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-26 by the plan role, split from the too-large part 3p/3 after feature held it nine times (held 9): the third of three finer parts replacing part 3p/3's one-file scope, sibling to parts 3p/3 and 3z/3, requires part 3z/3 landed since all three edit test/merger.test.ts and part 3z/3's edits there must settle first; part 3x/3 serialises behind this part because its rebase/check/batch/stack blocks come below the whole replacement; touches test/merger.test.ts)

**Goal.** The resolution and re-review twin of part 3p/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes the `test/merger.test.ts` conflict-resolution cases and their re-review follow-ups fail, because each drives a reviewer verdict on the resolution diff or a reviewer usage fold. Move those cases last of the three, so the source switch lands against a suite that no longer depends on the reviewer. Part 3x/3 takes the rebase/check/batch/stack blocks below `a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both`.

**Approach.** In `test/merger.test.ts`, retire or re-point the pre-merge reviewer cases `a conflicting merge gets one resolution run and then merges`, `a resolution the re-review rejects deletes the pin and merges nothing`, `an unwritable state file mid-review still folds the reviewer runs and settles a rejected re-review`, and `a re-review with no parseable verdict keeps the pin for a retry`. Delete a case that exists only to pin the reviewer, or re-point its rejection trigger to a deterministic gate rejection (a `diffRuleReasons` finding such as a conflict-marker diff or a leaked credential, or a failing declared check) when its real subject is the conflict-resolution or re-review bookkeeping that survives — keep the resolution run and the re-review pin's flow and switch only the trigger. Leave the cases parts 3p/3 and 3z/3 own and every case at or below `a merge pinned behind main's advance…` untouched (part 3x/3 owns those), and leave the reviewer-run helpers (`reviewerPi`, `APPROVE_PI`, `perRoleReviewerPi`, `reviewerByRole`) in `test/fixtures/pi-events.ts` and `test/fixtures/merger-fixtures.ts` in place and edit neither fixture file: the reviewer still runs until part 3h/3, and part 3e/3 deletes the helpers with the plumbing.

**Files touched.** test/merger.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the four cases named in Approach for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Every case that remains keeps its original subject (conflict resolution or re-review bookkeeping) and asserts the same outcome through a deterministic rejection.
- No edit outside test/merger.test.ts.

### Every commit is verified on main, part 3s/3: the pre-merge reviewer's merge-pipeline sequencing cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3o/3 after feature held it (held 7); one of eight finer parts replacing the held parts 3n/3 and 3o/3, independent in files of the other seven (3p/3–3w/3), which take disjoint test files, and holding no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/merge-pipeline.test.ts)

**Previously held 7**

**Goal.** Part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/merge-pipeline.test.ts`'s per-change `review_start` count (`afterMerge !== true`), its `reviewing`-stage sequencing and its reject-verdict pipeline cases fail. Move those cases first, as part 3l/3 did for the review suites, so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In `test/merge-pipeline.test.ts`, retire or re-point the pre-merge reviewer cases: move the per-change `review_start` count and the `reviewing`-stage sequencing to the post-landing review's own `review_start` (`afterMerge: true`) or to the pre-check stage; delete a case that exists only to pin a reviewer verdict or usage fold; re-point a reject-driven case to a deterministic gate rejection (a conflict-marker diff, a leaked credential or a failing declared check). `mergeStartHeld`'s reviewer-hold scoping case stays, since part 3i/3 owns its removal. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/merge-pipeline.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over `test/merge-pipeline.test.ts` for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Its `review_start` assertions name only post-landing (`afterMerge: true`) reviewer runs, or survive as flow assertions that do not count a pre-merge run.
- No edit outside test/merge-pipeline.test.ts.

### Every commit is verified on main, part 3u/3: the pre-merge reviewer's leftover-recovery cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3o/3 after feature held it (held 7); one of eight finer parts replacing the held parts 3n/3 and 3o/3, independent in files of the other seven (3p/3–3w/3), which take disjoint test files, and holding no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/runner-leftover-recovery.test.ts)

**Previously held 7**

**Goal.** The recovery-path twin of part 3s/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/runner-leftover-recovery.test.ts`'s `review_error`/`review_failed`/strike-cap recovery cases fail — the reviewer failure is the pin the recovery path re-queues. Move those cases first so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In `test/runner-leftover-recovery.test.ts`, retire or re-point the reviewer-recovery cases: re-point the `mergeHead` `review_error` and `review_failed` expectations (and the "no second reviewer run while held" strike-cap case) to a deterministic gate rejection that leaves the same recovery bookkeeping — a conflict-marker diff, a leaked credential or a failing declared check — or delete a case that exists only to pin the reviewer. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/runner-leftover-recovery.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the file for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Every case that remains keeps its original subject (leftover recovery and re-queue bookkeeping) and asserts the same outcome through a deterministic rejection.
- No edit outside test/runner-leftover-recovery.test.ts.

### Every commit is verified on main, part 3v/3: the pre-merge reviewer's orchestrator e2e cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3o/3 after feature held it (held 7); one of eight finer parts replacing the held parts 3n/3 and 3o/3, independent in files of the other seven (3p/3–3w/3), which take disjoint test files, and holding no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/orchestrator-3.e2e.test.ts)

**Previously held 7**

**Needs review 2026-10-25 by feature: too large for one run (held 8)**

**Goal.** The orchestrator-e2e twin of part 3s/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/orchestrator-3.e2e.test.ts`'s held/hanging reviewer runs, its reject-driven merge outcomes and its per-seam reviewer-model assertions fail. Move those cases first so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In `test/orchestrator-3.e2e.test.ts`, retire or re-point the pre-merge reviewer cases: re-point a case that holds a merge on a hanging reviewer run to a deterministic gate rejection (a conflict-marker diff or a failing declared check) when its real subject is the orchestrator's scheduling handoff, or delete a case that exists only to pin the reviewer's hold; drop the reviewer-model per-seam assertion where the surviving post-landing review does not carry it. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/orchestrator-3.e2e.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the file for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Every case that remains keeps its original subject (orchestrator scheduling and redeploy handoff) and asserts the same outcome through a deterministic rejection.
- No edit outside test/orchestrator-3.e2e.test.ts.

### Every commit is verified on main, part 3w/3: the pre-merge reviewer's orchestrator-mixed and director cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3o/3 after feature held it (held 7); one of eight finer parts replacing the held parts 3n/3 and 3o/3, independent in files of the other seven (3p/3–3w/3), which take disjoint test files, and holding no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/orchestrator-mixed.e2e.test.ts test/orchestrator-director.test.ts)

**Needs review 2026-10-25 by feature: too large for one run (held 8)**

**Previously held 7**

**Goal.** The orchestrator-mixed and director twin of part 3v/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/orchestrator-mixed.e2e.test.ts`'s `review_start` assertion and `test/orchestrator-director.test.ts`'s reject/idle-reviewer cases and its `review.afterMerge: []` hold case fail. Move those cases first so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In `test/orchestrator-mixed.e2e.test.ts`, re-point the `review_start` assertion to the surviving post-landing review, or drop it where the mixed flow no longer starts a pre-merge run. In `test/orchestrator-director.test.ts`, retire or re-point the reject-reviewer case ("an idle reply is a review_error") and the case that sets `review.afterMerge: []` to hold a merge on a pre-merge review: re-point each to a deterministic gate rejection (a conflict-marker diff or a failing declared check) when its real subject is the director's abort/handoff bookkeeping, or delete it when it exists only to pin the reviewer. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/orchestrator-mixed.e2e.test.ts test/orchestrator-director.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the two files for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- `review_start` assertions name only post-landing (`afterMerge: true`) reviewer runs, or survive as flow assertions that do not count a pre-merge run.
- No edit outside test/orchestrator-mixed.e2e.test.ts and test/orchestrator-director.test.ts.

### Every commit is verified on main, part 3x/3: the pre-merge reviewer's rebase, check and batch/stack cases in test/merger.test.ts are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-26 by the plan role, split from the too-large part 3p/3 after feature held it too large again (held 8); the lower part replacing part 3p/3's one-file scope, now split into the three finer parts 3p/3, 3z/3 and 4a/3, requires part 4a/3 landed since all four edit test/merger.test.ts and the three finer parts must settle first, and independent in files of every other planned part; touches test/merger.test.ts)

**Previously held 8**

**Goal.** The lower-file twin of the three finer parts 3p/3, 3z/3 and 4a/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes the `test/merger.test.ts` cases below `a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both` fail where they reach a merge through a `reviewerPi` approval, a per-role reviewer run or a `review_start` count rather than through the deterministic gate. Move those cases first so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In `test/merger.test.ts`, retire or re-point the pre-merge reviewer cases at or below `a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both`: `a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both`, `a synced rebase moves the merge ref so a failed gate keeps the tree that can merge`, `the merge checkout is shared, kept detached, and persists at a terminal outcome`, `a failing pre-check on a green main rejects the merge and spends no pi run`, `a fix-claim-blocked merge retries once, then rejects with the block reason`, `a failing pre-check on a red main keeps the pin, records no rejection, and spends no pi run`, `an all-rejected batch returns a defined result for every request without throwing`, `an abort after the last gate approved stops the batch before its shared check`, `a merge reports each change as it reaches it: the stack merges together, and a rejected change never reaches it`, and `the gate re-pins the merge ref to the head its verdict judged`. Prefer re-pointing over deletion: these cases' real subject is the rebase, check or batch/stack bookkeeping, so drive the same outcome through a deterministic gate rejection (a conflict-marker diff, a leaked credential or a failing declared check), or, where a case only asserts that no reviewer ran, keep that assertion without a `reviewerPi` approval behind it. Leave the blocks above `a merge pinned behind main's advance…` untouched — parts 3p/3, 3z/3 and 4a/3 own those — and edit neither fixture file (part 3e/3 deletes the reviewer-run helpers).

**Files touched.** test/merger.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the ten cases named in Approach for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Every case that remains keeps its original subject (rebase, check or batch/stack bookkeeping) and asserts the same outcome through a deterministic rejection.
- No edit outside test/merger.test.ts.

### The e2e/concurrency tier's wall-clock waits and pid probes become deterministic, part 2/3: the concurrency tests' reap checks use a process-identity handle, not a bare pid (planned 2026-10-26 by the plan role, split from the too-large class plan after feature held it (held 1); one of three finer parts replacing the class plan, sibling to part 1/3 and part 3/3 and editing only src/process/process.ts, test/codex-hook-trust.test.ts and test/supervisor.test.ts, so it holds no prerequisite and merges independently; touches src/process/process.ts test/codex-hook-trust.test.ts test/supervisor.test.ts)

**Previously held 1**

**Goal.** Retire the class plan's two pid/signal members. `test/codex-hook-trust.test.ts`'s `a hanging fake rejects within timeoutMs and its child is gone afterwards` decides "gone" by polling `process.kill(pid, 0)`, which reports a reused pid alive; `test/supervisor.test.ts`'s `startParentDeathWatch takes a SIGKILLed supervisor's grandchild down with it` retries SIGUSR2 until a 60 s wall-clock deadline, so a starved grandchild can lose on scheduling alone.

**Approach.**
- src/process/process.ts: add an identity-aware liveness probe beside `pidAlive`. Capture a per-process start identity when the fake app-server is spawned (a recorded nonce, or the OS start time — `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS) and expose it (e.g. `pidIdentity(pid)` / `identityAlive(handle)`); leave `pidAlive`'s signature and behavior unchanged for production callers.
- test/codex-hook-trust.test.ts: the hanging-fake case reads the fake's recorded identity and decides "gone" from the identity probe, so a reused pid cannot read as the fake still alive. Keep the bounded poll; the bound now only reports a genuine hang.
- test/supervisor.test.ts: end the grandchild case's signal loop on the reparent it observes (the `seen` file holds a ppid different from `supervisor.pid`), signalling again only until that observation, instead of a `Date.now() + 60_000` deadline. The real-process SIGKILL shape stays.

**Files touched.** src/process/process.ts test/codex-hook-trust.test.ts test/supervisor.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes.
- The hanging-fake case decides "gone" through the identity probe; it contains no bare `process.kill(pid, 0)` liveness poll.
- The supervisor case's signal loop ends on the reparent it observes in `seen`, not on a `Date.now() + 60_000` deadline.
- `pidAlive` keeps its current contract: a non-positive or fractional pid is false, and the probe reports a reaped pid as not alive.

### The e2e/concurrency tier's wall-clock waits and pid probes become deterministic, part 3/3: the e2e grow-waits observe the orchestrator's own events and run markers, not live process samples (planned 2026-10-26 by the plan role, split from the too-large class plan after feature held it (held 1); one of three finer parts replacing the class plan, sibling to part 1/3 and part 2/3 and editing only test/orchestrator-budget.e2e.test.ts, test/orchestrator-resize.e2e.test.ts and test/fixtures/orchestrator-fixtures.ts, so it holds no prerequisite and merges independently; touches test/orchestrator-budget.e2e.test.ts test/orchestrator-resize.e2e.test.ts test/fixtures/orchestrator-fixtures.ts)

**Previously held 1**

**Goal.** Retire the class plan's e2e grow-waits. `test/orchestrator-resize.e2e.test.ts`'s `a live maxConcurrent edit resizes the cap without a restart` and `a live maxConcurrentPerProvider edit admits a parked omlx run and logs its own event` wait on the concurrency fake's `samples.log` (`readSamples(runDir).some((n) => n >= 2)`) with a 150 s/60 s budget; `test/orchestrator-budget.e2e.test.ts`'s `a reached cap switches roles to the free fallback model instead of stopping them`, `a free fallback whose runs keep failing is demoted to a pause, then probed back once it serves`, and `budget_resumed hands the in-flight fallback runs back to the primary` wait on live-run counts and, after a fixed sleep, on runner state. A loaded host can push the sampled state past the budget with no code change.

**Approach.**
- The orchestrator already emits the deterministic transitions these cases assert: `provider_concurrency_changed` (the resize case reads it today), and `budget_paused` / `budget_resumed` / `budget_fallback` / `budget_handback` (the budget cases already use `readEvents` for some steps). Re-point each grow-wait's "a slot opened / a run started" step onto the emitted event or an admitted-run count taken from the run markers the fake writes.
- Keep `readSamples` for the assertions whose real subject is overlap (peak stays 1) and read those only after the event confirms the transition; do not delete a peak assertion to make a grow-wait pass.
- `budget_resumed`'s post-sleep runner-state wait in test/orchestrator-budget.e2e.test.ts waits on the handed-back run's own terminal/next-start marker instead of the fixed sleep plus state poll.

**Files touched.** test/orchestrator-budget.e2e.test.ts test/orchestrator-resize.e2e.test.ts test/fixtures/orchestrator-fixtures.ts (only if `readSamples` needs an event-based sibling)

**Acceptance criteria.**
- `npm run test:gate` passes.
- In test/orchestrator-resize.e2e.test.ts, neither grow-wait uses `readSamples(...).some((n) => n >= 2)` with a 150 s/60 s budget; each grow assertion reads an emitted event or an admitted-run count.
- In test/orchestrator-budget.e2e.test.ts, the three named cases no longer decide the grow/handback step on a fixed `sleep` followed by a `waitFor` over live-run counts; each waits on an emitted event or a run marker.
- Every peak-overlap assertion keeps its subject and still reads the concurrency fake's samples.

### Subtract, part 1/6: Only a stopped team asks for a person — the banner feed keeps the seven alerts that mean the team is stopped or a decision is the operator's (planned 2026-10-26 by the operator, from the "simplicity over being heavily optimized" request; design in plans/subtract.md "The six strokes", stroke 6; touches src/ui/team-alerts.ts src/ui/team-alert-shared.ts src/ui/team-alert-backlog.ts src/ui/team-alert-backlog-feed.ts src/ui/team-alert-merge.ts src/ui/team-alert-status.ts src/ui/team-alert-tail.ts src/ui/alert-feeds.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts)

**Needs review 2026-10-26 by feature: too large for one run (held 1)**

**Goal.** `teamAlerts` (src/ui/team-alerts.ts) emits only what means the team cannot make progress on its own, plus the operator's own decision queue. Every other amber, blue and gray banner becomes a `tumwater doctor` row — or is deleted with the mechanism its own part removes.

**Approach.**
- Keep exactly these builders: in team-alert-status.ts `main's check is failing — N roles are blocked`, `N roles are failing run after run`, `N roles look stuck`, `Today's budget is spent, so the roles are paused`; in team-alert-tail.ts `tumwater is not running`, the low-disk alert, the root-install drift alert; in team-alert-backlog.ts the question alert (`:35`) and the refused-entry alert (`:74`).
- Delete every other builder and its feeder in src/ui/alert-feeds.ts (quarantineAlert, flappedChecksAlert, postMergeChurnAlert, postReviewRiskAlert, droppedPostReviewsAlert, mainRuleFailures, qaCoverageAlert, regressedFixesAlert, staleOpenBugs, staleOpenQuestions, stalePrompts, staleMerges, skippedMergeFiles, primaryOverwriteBlocks, capacityContention, providerCapProblems, instancePoolProblems, staleWorkspacePins, staleClaimEntries, stalledEntries, operatorHeldEntries, strandedPlanEntriesFor, duplicatedBacklogHeadings, validationGapProblems, planDependencyAlert, notifyFailures, liveFinished, staleQuestions, staleWaitingBugs), the matching `TeamAlert` members in team-alert-shared.ts, the `teamAlerts` parameters they feed, and their fields in status-payload.ts / status-render.ts.
- The doctor keeps its rows unchanged (src/doctor/doctor-check-names.ts): each deleted alert already has one. Where one does not, add the row in this same change, so no condition becomes invisible — that is the part's rule, not a follow-up.
- The dashboard's alert banner shows the count and links to the doctor view; the TUI's Alert pane shows the kept set.

**Files touched.** src/ui/team-alerts.ts src/ui/team-alert-shared.ts src/ui/team-alert-backlog.ts src/ui/team-alert-backlog-feed.ts src/ui/team-alert-merge.ts src/ui/team-alert-status.ts src/ui/team-alert-tail.ts src/ui/alert-feeds.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts

**Acceptance criteria.**
- For any snapshot, `teamAlerts` returns only the kept titles; the deleted ones cannot be produced because their builders and inputs are gone (no `tone: "amber"` builder left outside the kept set).
- Every condition a deleted alert reported still prints in `tumwater doctor`, or its mechanism was deleted by the part that owns it.
- `npm run test:gate` passes.

### Subtract, part 2/6: One hold vocabulary — Refused and Needs review (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 2, and plans/refusal-and-thrash.md; touches src/roles/role-guidance.ts src/backlog/backlog-eligibility.ts src/backlog/backlog-release.ts src/backlog/backlog-cli.ts src/backlog/backlog-cli-view.ts src/backlog/backlog-index.ts src/runner/revision.ts src/roles/role-catalog.ts src/prompt/prompt.ts src/doctor/doctor-backlog-plans.ts src/doctor/doctor-backlog-bugs.ts src/ui/team-alert-backlog.ts src/ui/team-alert-backlog-feed.ts src/ui/gui/gui-client-backlog.ts src/ui/tui/tui-pane-backlog.ts docs/glossary.md docs/how-it-works.md test/backlog-eligibility.test.ts test/doctor-checks.test.ts)

**Goal.** A backlog entry can be parked exactly two ways: `**Refused …**` (the system declined and wants a decision) and `**Needs review …**` (the work is not done, and the note says why). The other three kinds and the held counters go. An entry a work role reports too large for one run is one such `**Needs review …**` entry: the plan role always refines and splits it, automatically, and it never escalates to the operator to release (user request 2026-10-26).

**Approach.**
- Delete `NEEDS_REPLAN_PREFIX` and `NEEDS_REPLAN_NOTE` (src/roles/role-guidance.ts:189, :198) and `WAITING_FOR_FAILURE_PREFIX`/`WAITING_FOR_FAILURE_NOTE` (:203, :209): a rejected plan is a `**Needs review …**` note carrying the reviewer's objections, and a bug nobody can reproduce is a `**Needs review …**` note naming what would make it fail.
- Delete the held counters — `HELD_TAG_PREFIX` (:144), `PRIOR_HELD_PREFIX` (:169), `PRIOR_HELD_NOTE` (:175) — and `CONVERGENCE_HOLD_MARKER` (:163) as a separate kind: `holdEntryAfterExhaustion` (src/runner/revision.ts) writes a plain `**Needs review <date> by <role>: could not converge — <objections>**`. The count's only readers were the split ordering and the operator-held alert; the note's text carries what the plan role needs, and age is already the doctor's signal.
- `EntryHold` (src/backlog/backlog-eligibility.ts:25) becomes `"refused" | "needs-review" | { blockedBy } | null`; the held-for-operator derivation (:248) and `operatorHeldEntries` (:375) go with the alert that read them, and the doctor's `stalled entries` row reports `needs-review` only. With `entryHold` no longer deriving `held-for-operator`, a too-large `**Needs review …**` note keeps the plan role running (`planBacklogFull`, src/scheduling/claims.ts, tests `needs-review`) and routes it to the plan role's split step (src/roles/role-catalog.ts), with no operator release in the path.
- One release verb: `src/backlog/backlog-release.ts` lifts Refused, else Needs review; `tumwater plan|bug --release <n>`, the TUI's Ctrl+R and the dashboard's Release all call it, and `LiftableHold` (backlog-release.ts:17) has one member.
- The prompts say two holds: src/prompt/prompt.ts's refusal bullet, the plan/feature/bugfix steps in src/roles/role-catalog.ts, docs/glossary.md's hold rows.

**Files touched.** src/roles/role-guidance.ts src/backlog/backlog-eligibility.ts src/backlog/backlog-release.ts src/backlog/backlog-cli.ts src/backlog/backlog-cli-view.ts src/backlog/backlog-index.ts src/runner/revision.ts src/roles/role-catalog.ts src/prompt/prompt.ts src/doctor/doctor-backlog-plans.ts src/doctor/doctor-backlog-bugs.ts src/ui/team-alert-backlog.ts src/ui/team-alert-backlog-feed.ts src/ui/gui/gui-client-backlog.ts src/ui/tui/tui-pane-backlog.ts docs/glossary.md docs/how-it-works.md test/backlog-eligibility.test.ts test/doctor-checks.test.ts

**Acceptance criteria.**
- After the change, no live reader or writer of `Needs replan`, `Waiting for the next failure`, `(held ` or `**Previously held ` remains in `src/` (grep is empty apart from the archived PLANS-DONE.md and BUGS-FIXED.md records).
- A `**Needs review 2026-10-26 by feature: could not converge — <objections>**` note classifies as the needs-review hold and `--release` lifts it; a Refused note is lifted first when an entry carries both.
- The plan role's split flow still sees why an entry is held (the note's text), with no count to carry.
- A `**Needs review … too large for one run**` plan or bug keeps the plan role scheduled (`planBacklogFull` false) and is split by it, with no held count and no operator `--release` in the path.
- `npm run test:gate` passes.

### Subtract, part 3/6: The merge queue becomes a lock and a fast-forward (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 3; requires Every commit is verified on main part 3f/3 landed; touches src/merge src/orchestrator/orchestrator-poll.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-skip.ts src/orchestrator/scheduling-scope.ts src/runner/runner-run.ts src/status/status-data.ts src/doctor/doctor-contention-checks.ts src/concurrency/check-permit.ts docs/how-it-works.md docs/invariants.md test/merger-restack.test.ts test/merge-backlog-conflicts.test.ts test/worktree-pool.test.ts)

**Goal.** A change lands as `pin → rebase onto main → fast-forward under the merge lock`. The queue, its stage machine, the coalesced batch check with its prefix bisect, the re-queue, the entry drop limits and the scheduling interlock are gone, because nothing about landing can fail any more: verification moved after the merge (part 3f/3), and a break is an ordinary open bug owned by the author.

**Approach.**
- Delete the queue and its stages: src/merge/merge-queue.ts, merge-queue-render.ts, merge-requeue.ts, merge-cancel.ts, merge-pipeline.ts, merge-slot.ts, merge-drain.ts, merge-batch.ts, merge-stack.ts, and the `.tumwater/merge-queue/` directory with its `uncommitted backlog`-style checks.
- `merge-core.ts` and `merge-to-main.ts` keep the pin read, the rebase, the merge lock and the fast-forward; the conflict-resolution pi run stays as the one non-deterministic step. `MERGE_CONFLICT_LIMIT` and the entry attempt/drop limits go: a conflict whose resolution fails comes back as a `**Needs review …**` note naming the conflict (part 2/6's vocabulary).
- Delete the scheduling interlock: `queuedRoles` (orchestrator-scheduling.ts), its legs in scheduling-skip.ts and scheduling-scope.ts, and `mergeStartHeld`'s merge half (orchestrator-poll.ts). A role whose change is merging authors its next run, as plans/interlock-relief.md's per-role tiering intended for the low-blast-radius roles only.
- Delete the check permit with the in-lock and batch checks it served (src/concurrency/check-permit.ts) and the three contention rows and the `capacity bottleneck` alert (part 1/6 removes the alert; doctor-contention-checks.ts keeps `slot_wait`/`provider_wait` only if part 4/6 has not yet removed the pool).
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
- `tumwater.json` with `instances` set is refused by validation naming the deleted key (the same treatment the other deleted keys get in part 5/6), not silently ignored.
- The measured p90 end-of-run → on main from the gate above is quoted in the part's PLANS-DONE entry, so the deletion's premise is on the record.
- `npm run test:gate` passes.

### Subtract, part 5/6: One model per role — tiers, fallback chains and provider caps go (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 5; touches src/config/config-schema.ts src/config/config.ts src/config/config-views.ts src/config/config-validation.ts src/runner/model-fallback.ts src/runner/runner-fallback.ts src/runner/runner-run.ts src/agent/subscription-account.ts src/team/team-polls.ts src/doctor/doctor-model-checks.ts src/doctor/doctor-fallback-checks.ts src/doctor/doctor-contention-checks.ts src/doctor/image-probe.ts src/ui/team-alert-status.ts src/ui/team-alert-tail.ts docs/config.md docs/backends.md docs/how-it-works.md tumwater.example.json test/config.test.ts test/doctor-checks.test.ts)

**Goal.** The model a run uses is the role's (or the seam's) model, named once in `tumwater.json`. The tier map, the fallback maps and chain steps, the per-provider caps, the subscription-window carve-outs and the image-capability probe are deleted: they route around a fleet that is expected to change, which is optimization for the wrong thing.

**Approach.**
- Config: keep the `model` map (role or seam id → selector). Delete the tier keys of `model` (TierMap, src/config/config-schema.ts:18, :46), the `fallback` maps and their chain steps (FallbackStep :24, FALLBACK_STEP_KEYS :33, the ordered-list form :35), `fallbackModel`/the fallback pair (:148-165), and `maxConcurrentPerProvider` (:298) with its audit (`checkProviderConcurrency`) — validation refuses each deleted key by name rather than ignoring it.
- Delete the routing code and its observations: src/runner/model-fallback.ts, src/runner/runner-fallback.ts, the fallback legs of runner-run.ts, src/agent/subscription-account.ts with the `claude window`/`codex window` rows and team-polls' window observation, and src/doctor/image-probe.ts with the `image input` row and the two image alerts.
- `maxDailyCostUsd` stays as the one spend limit, now per role; a spent cap pauses the role (today's budget behaviour) instead of switching it to an over-cap model, so `budget_fallback`/`budget_handback` and the fallback-budget rows go.
- Delete the rows and alerts this removes: `models for each tier`, `fallback chain`, `over-cap model`, `provider concurrency`, `provider contention`, `claude window`, `codex window`, `image input`, `maxConcurrentPerProvider is misconfigured`, `No configured model can read images…`, `…on models that can't read images`, `A claimed image-capable model failed doctor's probe`, and the fallback/over-cap budget alerts.

**Files touched.** src/config/config-schema.ts src/config/config.ts src/config/config-views.ts src/config/config-validation.ts src/runner/model-fallback.ts src/runner/runner-fallback.ts src/runner/runner-run.ts src/agent/subscription-account.ts src/team/team-polls.ts src/doctor/doctor-model-checks.ts src/doctor/doctor-fallback-checks.ts src/doctor/doctor-contention-checks.ts src/doctor/doctor-check-names.ts src/doctor/image-probe.ts src/ui/team-alert-status.ts src/ui/team-alert-tail.ts docs/config.md docs/backends.md docs/how-it-works.md tumwater.example.json test/config.test.ts test/doctor-checks.test.ts

**Acceptance criteria.**
- One place names a run's model: the role's entry in the `model` map, else its catalog default; a run never substitutes a different model, and a spent daily cap pauses the role with the existing pause wording.
- A `tumwater.json` carrying `fallback`, `fallbackModel`, a tier key or `maxConcurrentPerProvider` is refused with a message naming the deleted key.
- The named rows and alerts are gone from doctor-check-names.ts and the alert builders; the subscription-window and image-probe modules are deleted, not orphaned.
- `npm run test:gate` passes.

### Subtract, part 6/6: The sweep — the rows, keys and docs the five parts left behind (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes" and "How we will know it worked"; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts)

**Refused 2026-10-26 by feature: parts 1/6–5/6 have not landed, so the sweep would delete rows, keys, and docs for mechanisms that still exist and src/ still references (instances, mergeCommand, maxConcurrentChecks, maxConcurrentPerProvider, check-permit, worktree-pool, claims, model-fallback all remain live), breaking the build and the gate; re-queue after 5/6 lands.**

**Goal.** The deletion reads as one system. Every name parts 1/6–5/6 removed is gone from the live docs, the example config, the doctor's row list, the alerts and the tests that assert them; the archive keeps the record.

**Approach.**
- Sweep the deleted names out of the live prose and the example config: `instances`, `slotCount`, `slot_wait`, `check_wait`, `maxConcurrentChecks`, `mergeBatchMax`, `mergeCommand`, `review.afterMerge`, `maxConcurrentPerProvider`, `fallback`, `fallbackModel`, `model.<tier>`, `over-cap model`, `slot salvage`, `merge queue`, `interlock`, `held-for-operator`, `Needs replan`, `Waiting for the next failure`, `(held N)`.
- Delete the rows and tests rather than re-pointing them: a case whose whole subject is a deleted mechanism goes (the existing wording/implementation tests rule: never re-pin), and test/doctor-checks.test.ts's row list, test/event-format.test.ts's deleted event types (`slot_wait`, `check_wait`, the merge-stage events), test/retention.test.ts's pool artifacts and test/config.test.ts's deleted keys are updated to the surviving row/key set.
- Re-check the part 1/6 rule end to end: for every condition that used to have a banner and no longer does, the doctor row exists; for every row this series deleted, the mechanism is gone.
- docs/invariants.md drops or re-scopes the invariants of deleted subsystems (merge-slot, pool, permit, instance claims, model routing) in the same commit, per the standing rule.
- Record in the part's PLANS-DONE entry: the doctor row count and the config key count before and after the series, and the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts PLANS.md test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts

**Acceptance criteria.**
- `grep -rnE 'maxConcurrentChecks|maxConcurrentPerProvider|mergeBatchMax|mergeCommand|instances|slot_wait|check_wait|fallbackModel|review\.afterMerge|held-for-operator' src/ docs/ README.md DEVELOPMENT.md tumwater.example.json` finds no live reference (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every doctor row name in doctor-check-names.ts resolves to a check that reads a mechanism that still exists; no row reports a path nothing writes.
- The before/after row and key counts, and the deletions' measurement premise, are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

## Done
