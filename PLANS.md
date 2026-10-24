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

### A post-merge rejection stops reverting, part 1/3: the merge drain hands the reviewer's reasons to the authoring role instead of filling the revert slot (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; gated on the `## Planned` accounting plan "Every post-merge rejection reaches one accounted terminal state…" landing first — it adds `recordForwardedChange` and the runner routing this part calls; touches src/merge/merge-post-review.ts src/merge/merge-drain.ts src/baseline/main-revert.ts docs/invariants.md test/post-merge-review.test.ts test/merge-drain.test.ts test/main-revert.test.ts)

**Refused 2026-10-24 by feature: superseded — the user's 2026-10-24 "Forward, never back" plan deletes this part's machinery (`sendReviewToRole`, the `recordForwardedChange` routing and the whole revert subsystem), replacing it with the reviewer fixing the finding itself, and the prerequisite accounting plan that would add `recordForwardedChange` has not landed; implementing it would land the direction the user decided against**

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** feature runners claim this entry every minute (48 claims so far) and have landed nothing, and its direction — forward the reviewer's reasons to the commit's authoring role — is replaced by "Forward, never back" below, where the reviewer that found the issue fixes it itself. Leave whatever is in flight as it is: the seam this part builds (`sendReviewToRole`, the reasons payload, the runner routing) is what the newer plan reuses to land the reviewer's own fix, so a landed part is not wasted and nothing landed should be undone. Reconcile the hand-back target when that plan lands.

**Goal.** A rejected post-merge review should cost one follow-up fix, not a revert cycle. Today `drainPostReviews` (src/merge/merge-post-review.ts) builds a revert-slot culprit (`postReview: { reasons }`), so a rejection pays a revert commit, a gate run on that revert inside the single merge slot, an authoring run that re-applies the whole patch from `refs/tumwater/rejected/<role>`, and then the follow-up's own gate, merge and second review. The reviewer's reasons never reach the author as a fix on top of main, where the commit already is. This part makes forwarding the only path `drainPostReviews` takes and leaves `runMainRevert` its red-main job.

**Approach.**
- src/merge/merge-post-review.ts `drainPostReviews`: for a rejected entry, forward the reviewer's numbered reasons to the commit's authoring role through `sendReviewToRole` (the prerequisite plan routes it through `recordForwardedChange`), then `settlePostReview(ctx.root, rejected.commit, null)`. Delete the `skipChecks` WeakSet, the `revertSkipReason` import and call, the `postReview` culprit construction and the `p.revert = culprit` assignment: the entry exists to carry the reasons to a fix, not to wait for a revert. A rejection with no free runner is parked by the prerequisite routing and stays in post-review.json until assigned. The unreviewed-entry arm and the one-review-at-a-time behaviour are unchanged.
- src/merge/merge-drain.ts: `sendReviewToRole` becomes the primary forward, not the failed-revert fallback — keep its "A review after merging rejected your commit <sha> on <branch>. It is still on main. Fix what the reviewer found in a new change:" text, drop its `reason` parameter and the "it could not be reverted" clause, and drop the `c.postReview === undefined` guard. `revertReasons`' `if (c.postReview)` branch, `handBackReverted`'s post-review handling, `startRevert`'s `(c, reason) => sendReviewToRole(...)` argument and its `if (culprit.postReview) settlePostReview(...)` line go with their only producers.
- src/baseline/main-revert.ts: delete `MainCulprit.postReview` and every read of it — `heal`'s `toReviewer`/`onFailed` branch, the post-merge-rejection wording in the revert message, and `reason: c.postReview ? "post-review" : "main-red"`, which becomes the constant `reason: "main-red"`. Delete `runMainRevert`'s `onFailed` parameter. Keep the `main_revert.reason` field and its readers (`revertGuardrail` and the report, run-detail and failure surfaces): events written before this change still carry `post-review`, and that value must keep reading as a post-merge rejection.
- docs/invariants.md: delete INV-BT2's pin "a rejecting post-merge review reverts the commit and hands it back as a revision" with the path it pins; state the new guarantee (a rejected entry is forwarded to its authoring role and leaves post-review.json with no revert). Correct the INV-C3 paragraph so `reason: "post-review"` reads as a legacy event value no new revert carries, not a live one.
- No change to `recordForwardedChange` (prerequisite-owned), `POST_MERGE_REJECT_WARN`, the churn alert, the red-main watch, or the revert-skip check's other callers.

**Files touched.** src/merge/merge-post-review.ts src/merge/merge-drain.ts src/baseline/main-revert.ts docs/invariants.md test/post-merge-review.test.ts test/merge-drain.test.ts test/main-revert.test.ts

**Acceptance criteria.**
- A rejecting post-merge review hands its numbered reasons to the commit's authoring role, naming that commit and the branch, settles the entry out of post-review.json, and starts no revert: no `main_revert` event and the merge slot is free for the next queued change on the same poll.
- A rejection whose reasons cannot be delivered leaves the commit on main and logs one warning; no revert is attempted and no entry is silently dropped.
- A red-main culprit revert is unchanged end to end except that its `main_revert.reason` is always `main-red`; a pre-existing `reason: "post-review"` event still reads as a post-merge rejection on every reader.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: replace "a rejecting post-merge review reverts the commit and hands it back as a revision" with `a rejecting post-merge review forwards the reasons and starts no revert` — seed a merged afterMerge change, reject it, and assert the authoring role's inbox/pending record carries the reasons and the commit sha, the entry left post-review.json, and no revert was started. Keep the torn-entry, failed-write and git-could-not-start cases.
- test/merge-drain.test.ts: `a post-merge rejection never fills the revert slot` — run two polls with a rejected entry and an idle merge slot and assert the slot stays free for a queued change while the entry leaves post-review.json once forwarded.
- test/main-revert.test.ts: move the failed-delivery assertion to the primary path — a rejection whose reasons cannot be delivered warns and leaves the commit on main with no revert attempted; the red-main culprit revert's existing cases are unchanged.

### A post-merge rejection stops reverting, part 2/3: `tumwater reviews` and the shared renderer name the forwarded follow-up, not a revert (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; requires part 1/3 landed, since the entry it renders no longer waits on a revert; touches src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/post-merge-review-render.test.ts test/cli-reviews.test.ts)

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** this entry's surfaces change again under "Forward, never back" below — a rejected entry reads `fixed — <finding> (fix <sha>)`, and the accept affordances go entirely rather than being re-worded — so land it only as far as it goes; its wording half (no "waiting to revert", no "let the revert run") is what the newer plan keeps, and whatever is in flight now stays as it is.

**Goal.** The shared renderer `postReviewStatusLabel` still prints `[rejected — waiting to revert: …]`, and `cmdReviewsAccept` still refuses a rejected entry with "waiting on its revert". After part 1/3 there is no revert to wait for: a rejected entry is forwarded to its author, or parked until a runner can take it. Name the forwarding state instead.

**Approach.**
- src/review/post-merge-review-render.ts `postReviewStatusLabel`: the `rejected` branch reads `[rejected — awaiting the author's follow-up: <reasons>]` (keep the 60-character squash). Update the function's doc comment, which says the reasons are "still waiting on the revert". The label is shared by `tumwater reviews` and the TUI Pending pane; no other renderer change.
- src/review/post-merge-review-accept.ts: its doc comments call a `rejected` entry "waiting on its revert"; say it awaits its author's follow-up. The `rejected` outcome and the never-accept rule are unchanged.
- src/cli/cli-review-commands.ts `cmdReviewsAccept`: the `outcome.status === "rejected"` failure says the entry is rejected and awaiting its author's follow-up and cannot be accepted until the fix lands; update the function's doc comment.
- src/cli/help.ts, the `tumwater reviews` stanza: the `[rejected — waiting to revert: …]` line and "it refuses an entry already rejected and waiting on its revert" take the follow-up wording.
- docs/cli.md: the `tumwater reviews` clause and the Pending-pane `Ctrl+A` key-table row (both say "waiting on its revert") take the follow-up wording.
- No change to `renderPostReviews`'s line shape, `acceptPostReview`'s outcome kinds, or the `PostReview` type.

**Files touched.** src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/post-merge-review-render.test.ts test/cli-reviews.test.ts

**Acceptance criteria.**
- A rejected entry renders `[rejected — awaiting the author's follow-up: <reasons>]` from `postReviewStatusLabel` and on `tumwater reviews`'s line; no read surface says "waiting to revert".
- `tumwater reviews --accept <n>` on a rejected entry fails naming the author's follow-up, and changes nothing.
- The failed-run, unreviewed and empty cases are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review-render.test.ts: update the pinned rejected-label assertions (the end-to-end render and `postReviewStatusLabel`) to the new wording.
- test/cli-reviews.test.ts: update the review-list and `reviews --accept` refusal assertions to the new wording.

### A post-merge rejection stops reverting, part 3/3: the dashboard and TUI Pending panes name the forwarded follow-up, not a revert (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; requires parts 1/3 and 2/3 landed, since the TUI renders part 2/3's shared label and the browser mirrors it; touches src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts)

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** same as part 2/3 — the dashboard and TUI wording this part fixes is replaced by "Forward, never back" below (a rejected entry reads `fixed — <finding> (fix <sha>)`, with no accept affordance to explain), so land it only as far as it goes and leave anything in flight as it is.

**Goal.** The TUI Pending pane's two operator messages, the browser's hand-kept label and the GUI's accept-refusal error still tell the operator a rejected entry waits on a revert. After part 1/3 it awaits the author's follow-up instead; the three dashboard surfaces must say so and match `tumwater reviews`.

**Approach.**
- src/ui/tui/tui-pane-pending.ts: the row hint "cannot be accepted until its revert runs — let the revert go, then review the revision" and the accept-flash "is rejected and waiting on its revert — let the revert run, then review the revision" say the entry awaits its author's follow-up and cannot be accepted until the fix lands. Update any row-rendering comment that names a revert.
- src/ui/gui/gui-client-pending.ts: the browser twin `postReviewStatusLabel` (a hand-kept copy) prints `[rejected — awaiting the author's follow-up: …]`; the card and accept-button comments ("not waiting on its revert") follow. A rejected entry still renders no Accept button.
- src/gui/gui-operator-commands.ts: the GUI accept endpoint's 409 error ("rejected and waiting on its revert — let the revert run, then review the revision") takes the follow-up wording.
- docs/how-it-works.md: the post-merge review paragraph (the rejection "goes to the revert slot", the reasons "back to its role as a revision", the `reverted after merge` note) describes the forwarded fix on main instead; the red-main revert paragraph is unchanged.
- No change to the GUI's `data-accept` guard, the TUI Ctrl+A handler, or the status payload shape.

**Files touched.** src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts

**Acceptance criteria.**
- Every dashboard/TUI string about a rejected post-merge review says it awaits the author's follow-up; none says "waiting on its revert" or "let the revert run".
- The TUI and browser render the same rejected label as `tumwater reviews` for the same entry.
- The accept affordances for a rejected entry are unchanged: the TUI refuses it, the GUI renders no Accept button.
- `npm run test:gate` passes.

**Tests.**
- test/tui-keys.test.ts: update the rejected accept-flash assertion to the new wording.
- test/gui-client-pending.test.ts: update the rejected-label assertion.
- test/gui-post-review-accept.test.ts: update the GUI 409 error assertion.

### A `ci` role runs the CI workflow's own jobs at main's tip and fixes what fails, part 3/3: its parity block and `CI:` result line make its no-op decision cheap (planned 2026-10-24 by the operator, split from the held single `ci` plan; requires part 1/3 landed — the block is the role's own record and the `CI:` line is what it reads back — and lands before its repeated full-suite runs get expensive; touches src/config/config.ts src/run/ci-parity.ts src/prompt/prompt.ts src/verdict/reply-contract.ts src/runner/runner-outcome.ts src/run/run-verdict.ts docs/config.md test/reply-contract.test.ts test/qa-coverage.test.ts)

**Previously held 1**

**Goal.** Without a record of what it covered, the role must run the whole CI job — minutes of suite plus e2e — every tick to answer a question its own history already holds. The parity block and the `CI:` result line make that decision cheap: the role reads the tip and the `package-lock.json` hash its last green run covered, and declares nothing-to-do when main has not moved since and the lock file is unchanged.

**Approach.**
- src/config/config.ts: seed `minRunIntervalSeconds` for `ci` at the observer trio's `7200` (docs/config.md's row), so parity costs at most one full suite plus e2e every two hours; the per-role override works as for every other role.
- src/run/ci-parity.ts (new) + src/prompt/prompt.ts (its `flowCoverage` field, :314): the same-shaped `ciParity` prompt field — the tip the last recorded green parity run covered, its `package-lock.json` hash, and each step's outcome — rendered by a module of its own, and omitted entirely when the record is missing or unreadable, exactly as the qa coverage block is.
- src/verdict/reply-contract.ts: `ciResultLine` beside `flowLine` (:187) — `CI: <sha> — passed|failed`, split and validated with the same `labeledLine`/verdict-required rules (a bare `CI: <sha>`, or a reply truncated mid-verdict, is not a result and is not recorded). The run outcome carries it (src/runner/runner-outcome.ts:54, src/run/run-verdict.ts) and the parity block reads it back, so a fresh session that remembers nothing still knows what the last run covered.
- docs: docs/config.md's `minRunIntervalSeconds` row names `ci` with `7200` (the `Observer` line in docs/glossary.md and the observer paragraph in docs/how-it-works.md belong to part 1/3).
- No change to `.github/workflows/*`, to `check.gateCommand`, to `npm run test:gate`'s definition, to the main watch's check or to the post-merge review. The merge gate stays fast and affected-only — that is the point of a role whose cadence is its own. An implementation that finds itself slowing the gate, or editing a workflow file, has gone off-plan.

**Files touched.** src/config/config.ts src/prompt/prompt.ts src/run/ci-parity.ts src/verdict/reply-contract.ts src/runner/runner-outcome.ts src/run/run-verdict.ts docs/config.md test/prompt-roles.test.ts test/reply-contract.test.ts test/qa-coverage.test.ts

**Acceptance criteria.**
- Its prompt carries a CI parity block naming the tip and lock hash of the last green run; with main unmoved since that run and the lock hash unchanged the role declares nothing-to-do without running the suite (one model run, no suite run).
- A `CI:` line is required on every run and a bare `CI: <sha>` records nothing, so the parity block cannot advance on a truncated reply (the `FLOW:` line's own rule).
- The merge gate is untouched: `npm run test:gate` still runs only the affected tests, and no test that pins its command changes.
- `npm run test:gate` passes.

**Tests.**
- test/reply-contract.test.ts: `ciResultLine` mirrors the FLOW cases — `CI: abc1234 — passed` and `CI: abc1234 — failed` parse, a mid-sentence mention does not, and `CI: abc1234` alone (or a reply truncated mid-verdict) records nothing.
- test/qa-coverage.test.js (or a new test/ci-parity.test.js): the parity block renders "current" for the recorded green tip with a matching lock hash, "stale" naming both shas and hashes when main moved or the lock hash changed, and is omitted entirely for a missing or malformed record rather than rendering an empty verdict.

### Forward, never back, part 1a/6: the harness commits a reviewer's worktree edit as one fix commit and lands it on main, so a review run can repair what it found (planned 2026-10-24 by the plan role, split from the held part 1/6; part 1/6 below turns on the fix-forward prompt this part makes landable; a change to how a commit reaches main, so the switch that depends on it is a separate part and merges only once this one is the running build; touches src/review/post-merge-review.ts src/merge/merge-post-review.ts src/verdict/reply-contract.ts src/paths.ts test/post-merge-review.test.ts test/reply-contract.test.ts)

**Previously held 3**

**Goal.** Give the harness a way to land a reviewer's edit as a commit on main. Today `reviewMergedCommit` (src/review/post-merge-review.ts) runs the reviewer in a `--detach --force` checkout of the reviewed commit C and throws the worktree away: whatever the reviewer wrote is lost, which is why a post-merge finding can only be answered by a revert. This part makes a review run whose reply carries a `FIX:` line and whose worktree has edits produce one `tumwater(reviewer): Fix <short sha> — <first finding>` commit on C and land it through the ordinary change path (the gate on the fix tree, then the fast-forward under the merge lock), so the work survives. It changes no prompt and asks for no edits: until part 1/6 lands, a normal review run leaves the worktree clean and emits no `FIX:` line, so the path is inert.

**Approach.**
- src/review/post-merge-review.ts `reviewMergedCommit`: hold the worktree on a branch-backed checkout of C — create/reset `refs/tumwater/review-fix/<short sha>` with `setRef` (src/git/git.ts) at C and check that ref out instead of `--detach --force` — and parse the reply's `FIX:` line (below). When the verdict parses and the worktree has edited paths (`git status --porcelain`), commit them with the harness's own `git` call (never pi) as one commit whose subject is `tumwater(reviewer): Fix <short sha> — <first reason>` and whose body carries the numbered reasons; return a new `{ kind: "fixed"; fix: string; reasons: string[] }` outcome naming the fix's full sha, and log the reviewed commit's verdict so `review_rejected`/`review_verdict` still carry one record for C. A clean worktree, or a reply with no `FIX:` line, keeps today's `{ kind: "reject" }` / `{ kind: "approve" }` outcomes and deletes the ref.
- src/verdict/reply-contract.ts: `fixLine` beside `flowLine`/`ciResultLine` — `FIX: <comma-separated paths>` split and validated with `labeledLine`, so a bare `FIX:` or a reply truncated mid-verdict records nothing.
- src/merge/merge-post-review.ts `startPostReview`: on `outcome.kind === "fixed"`, merge the fix ref through the ordinary change path (`mergeApprovedChange`/`mergeToMain`, its gate over the fix tree and its `mergeLockDir` lock), then `settlePostReview(root, entry.commit, { ...entry, fixed: outcome.fix })` so the entry names both shas. A landing that fails (conflict, red gate, a refused fast-forward) leaves main at C, warns, and keeps the entry for the next poll, exactly as a failed run is kept today; a run with no edit and no finding still settles `approved`, and an unrepairable finding still settles `rejected`.
- src/paths.ts: add the durable ref name (`reviewFixRef(sha)`) beside the other `refs/tumwater/` paths, so the fix's ref has one home and the existing pin housekeeping sees it; delete the ref once the merge settles.
- No prompt change here — part 1/6 adds the clause that makes a reviewer emit the `FIX:` line. This part only makes an edit durable and merged.

**Files touched.** src/review/post-merge-review.ts src/merge/merge-post-review.ts src/verdict/reply-contract.ts src/paths.ts test/post-merge-review.test.ts test/reply-contract.test.ts

**Acceptance criteria.**
- A post-merge review run that carries a `FIX:` line and leaves an edited path in its worktree produces exactly one commit whose subject begins `tumwater(reviewer): Fix <short sha>` and whose parent is the reviewed commit; main fast-forwards to it and the entry settles `fixed` naming both shas.
- A run with no edit and no finding settles `approved`; a run whose finding is unrepairable (no edits, or no `FIX:` line) settles `rejected` as today; a bare or truncated `FIX:` line records nothing.
- A fix whose landing fails leaves main at the reviewed commit, keeps the entry in post-review.json with its failure recorded, and the next poll retries it.
- The reviewer's worktree is reset to the reviewed commit at the start of every review, so a leftover ref or edit from an earlier review cannot change what is reviewed.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: `the harness commits and lands a reviewer's edit as one fix` — seed a merged afterMerge change, have the fake review run write a file in the worktree and reply with a `FIX:` line and `VERDICT: reject`, and assert one `tumwater(reviewer): Fix <sha>` commit whose parent is the reviewed commit is on main and the entry settles `fixed` with both shas; `a run with no edit settles approved`, `a finding with no FIX line records reasons`, and `a failed landing keeps the entry and leaves main unmoved` cover the other arms. Keep the torn-entry, failed-write and git-could-not-start cases.
- test/reply-contract.test.ts: `fixLine` mirrors the FLOW cases — `FIX: a.ts, b.ts` parses to the two paths, a mid-sentence mention does not, and `FIX:` alone (or a reply truncated mid-verdict) records nothing.

### Forward, never back, part 1/6: the reviewer's fix-forward prompt replaces the revert slot, so a post-merge rejection never reverts (planned 2026-10-24 by the plan role; requires part 1a/6 landed, since the harness that commits and lands the reviewer's fix is part 1a/6, and the switch that asks for an edit merges only once that landing path is the running build; its scope split again 2026-10-24 by the plan role — part 1b/6 below deletes the failed-forward hand-back plumbing this part leaves with no caller; split from the held parts 1/2–2/2; supersedes the accounting plan and parts 1/3–3/3 of "A post-merge rejection stops reverting" above; design half: plans/post-merge-fix-forward.md "Decision"; part 2/6 below accounts and bounds the self-fix chain, part 3/6 files a review that never reaches a verdict and updates every surface, and parts 4/6–6/6 delete the revert machinery this part stops using; lands before "Every commit is verified on main" part 3/3 below, which removes the last pre-merge block; touches src/merge/merge-post-review.ts src/prompt/gate-prompts.ts test/merge-drain.test.ts test/gate-prompts.test.ts)

**Previously held 3**

**Goal.** Nothing is ever taken off main for a post-merge finding. A rejection today pays a revert commit, a gate run on the revert inside the single merge slot, a hand-back to the author and a second review — 11 such cycles in the trailing day of 2026-10-23/24, every one a doc/claim slip (plans/post-merge-fix-forward.md "Measurement"), and 8 of 11 are the class a forward fix repairs on top of main in one run. With part 1a/6's landing path in place, this part makes the reviewer's own fix the only answer a rejection gets: `drainPostReviews` stops building the revert-slot culprit, and the post-merge review prompt tells the reviewer that a finding it can repair is the work — make the minimal fix in the worktree, leave the edit, and end with the verdict line plus `FIX: <files changed>`. Self-review is deliberate: at this project's 53% reject rate (plans/reviewer-as-role.md) the author and the reviewer were already rewriting the same text by turns, so the second reader was mostly nominal. The red-main revert is untouched here; parts 4/6–6/6 delete it.

**Approach.**
- A post-merge rejection stops filling the revert slot. src/merge/merge-post-review.ts `drainPostReviews` no longer builds a revert-slot culprit (`postReview: { reasons }` and the `skipChecks` WeakSet go): a rejected entry is answered by the reviewer's own fix (part 1a/6), never by a revert. The failed-forward fallback `sendReviewToRole` and the parked-forward plumbing it alone used are now unreachable and are deleted by part 1b/6 below, not here.
- What deliberately stays until part 4/6: `MainCulprit.postReview` (never set once `drainPostReviews` stops building the slot item, but still read by `runMainRevert` and `startRevert`), `startRevert`, `handBackReverted`, `revertReasons` and src/baseline/main-revert.ts itself, because the red-main revert still runs through them, and `revertCommitIn` (src/operator/revert.ts) with the `operator_revert` event, which is the operator's own act and stays for good.
- src/prompt/gate-prompts.ts `buildReviewPrompt` (its post-merge arm): the reviewer is told that a finding it can repair is the work — make the minimal fix in the worktree, leave the edit, and end with the verdict line plus `FIX: <files changed>`; a finding it cannot repair is recorded as the reasons are today. The clause renders only when the post-merge mode is set, so a pre-merge caller's prompt is byte-identical.
- The self-fix chain's accounting and bound, the failure cap and the surfaces are part 2/6 and part 3/6, not this part: this part only makes a repairable finding become a landed fix.

**Files touched.** src/merge/merge-post-review.ts src/prompt/gate-prompts.ts test/post-merge-review.test.ts test/merge-drain.test.ts test/gate-prompts.test.ts

**Acceptance criteria.**
- No rejection starts a revert and none hands anything back to the authoring role: `drainPostReviews` builds no revert-slot culprit and sets no `postReview`, so the reviewer's own fix (part 1a/6) is the only answer. (Part 1b/6 below deletes the now-dead `sendReviewToRole`, parked-forward record and `state.forwarded`.)
- The fix-forward instruction and its `FIX:` line reach only the post-merge review: a pre-merge caller's `buildReviewPrompt` output is unchanged, pinned by a test.
- The red-main revert still runs through `runMainRevert` (part 4/6 deletes it), and `tumwater revert <sha>` is unchanged.
- Nothing that verifies code changes here: the pre-merge deterministic checks, the main watch's own check and the gate's rule set are untouched.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: replace the revert-slot cases (`a rejecting post-merge review reverts the commit and hands it back as a revision`, `a rejected entry stays queued until its revert ran`, and the `drainUntilRevert` helper) with the forward assertions — a rejected entry never fills `p.revert`; it leaves post-review.json once the reviewer's fix lands (part 1a/6) while its reviewed commit stays on main. Keep the torn-entry, failed-write and queueing cases.
- test/merge-drain.test.ts: `a post-merge finding never takes the revert slot` — run two polls with a rejected entry and an idle merge slot and assert the slot stays free for a queued change while the entry leaves post-review.json once the fix lands; keep the no-rejected and one-review-at-a-time cases.
- test/gate-prompts.test.ts: the fix-forward clause and its `FIX:` line appear only when the post-merge mode is set; the prompt a pre-merge caller gets is unchanged.

### Forward, never back, part 1b/6: the failed-forward hand-back machinery is deleted — a rejected commit is answered only by the reviewer's own fix (planned 2026-10-24 by the plan role, split from the held part 1/6; requires part 1/6 landed, since the plumbing this part deletes is dead only once a rejection stops filling the revert slot; touches src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/run/run-verdict.ts src/run/run-stage.ts src/prompt/gate-notes.ts src/paths.ts docs/how-it-works.md docs/invariants.md test/main-revert.test.ts test/revision.test.ts test/merge-drain.test.ts)

**Previously held 2**

**Goal.** Once part 1/6 answers a post-merge rejection with the reviewer's own landed fix, the fallback that handed the reviewer's reasons to the authoring role has no reachable caller: `sendReviewToRole` (src/merge/merge-drain.ts) is passed only as `runMainRevert`'s `onFailed`, which runs only for a culprit carrying `postReview`, and part 1/6 removes the only place that sets `postReview` (`drainPostReviews` in src/merge/merge-post-review.ts). This part deletes that whole path — the parked `forwarded.json` queue, `recordForwardedChange`, the runner's `state.forwarded` follow-up and its note — so no code, state file or doc names a hand-back that can no longer happen.

**Approach.**
- src/merge/merge-drain.ts: delete `sendReviewToRole`, `handBackForward`, `pendingForwards` and `assignPendingReverts`' forward loop, and stop passing `sendReviewToRole` as `runMainRevert`'s `onFailed` in `startRevert` (a red-main culprit carries no `postReview`, so the callback is never needed).
- src/merge/merge-core.ts: delete `recordForwardedChange` and `handBackChange`'s `"forwarded"` arm and its `verdict` parameter, so `recordRevertedChange` is `handBackChange`'s only caller.
- src/runner/runner-state.ts: delete the `forwarded` field and drop it from `hasOutstandingWork`'s parameter and predicate; src/runner/runner-state-load.ts drops its heal; src/runner/runner-run.ts drops the forwarded follow-up branch; src/run/run-verdict.ts and src/run/run-stage.ts drop their `state.forwarded` consumption arms.
- src/prompt/gate-notes.ts: delete `buildForwardNote`; src/paths.ts deletes `forwardedPendingPath`.
- Docs: docs/how-it-works.md's forwarded-record paragraphs and docs/invariants.md's forwarded-hand-back guarantee and its bindings describe the deleted path and go with it; the revert hand-back they sit beside stays until parts 4/6–6/6.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/run/run-verdict.ts src/run/run-stage.ts src/prompt/gate-notes.ts src/paths.ts docs/how-it-works.md docs/invariants.md test/main-revert.test.ts test/revision.test.ts test/merge-drain.test.ts

**Acceptance criteria.**
- No forwarded hand-back remains: `grep -rn "sendReviewToRole\|recordForwardedChange\|forwardedPendingPath\|buildForwardNote\|\.forwarded" src/` finds none, `RunnerState` has no `forwarded` field, and `hasOutstandingWork` reads only `revision` and `resumePending`.
- No doc describes a forwarded hand-back and `forwarded.json` is named nowhere in src/ or docs/.
- The revert hand-back (`recordRevertedChange`, `state.revision`) is untouched and its tests still pass.
- `npm run test:gate` passes.

**Tests.**
- test/main-revert.test.ts: drop the `sendReviewToRole`/parked-forward cases and the `forwardedPendingPath` import; keep the operator-revert and red-main cases.
- test/revision.test.ts: drop "a forwarded post-merge rejection records the same round as a reverted one" and "a runner consuming a forwarded hand-back carries the round and re-applies nothing"; keep the reverted-chain cases.
- docs/invariants.md: remove the forwarded-hand-back guarantee and its bindings.

### Forward, never back, part 2/6: the self-fix chain is counted and its dead end holds the answered plan (planned 2026-10-24 by the plan role, split from the held parts 1/2–2/2; requires part 1/6 landed, since the chain this counter bounds is the fix chain part 1/6 lands; touches src/runner/revision.ts src/review/post-merge-review.ts src/merge/merge-post-review.ts test/revision.test.ts test/post-merge-review.test.ts)

**Previously held 1**

**Goal.** A self-fix chain cannot loop forever, and its dead end is operator-visible. A landed fix enters the queue as a normal post-review entry (`addPostReview`, `summary` = the finding it answers), so the next iteration reviews it like any unreviewed commit; the entry must carry the reviewed commit's round + 1 and stop at `REVISION_BACKSTOP` (src/runner/revision.ts), holding the answered plan as **Needs review** naming the surviving findings (`holdEntryAfterExhaustion`) rather than fixing again. Without this part the forward path as written is counted by neither `state.lastReview` nor the backstop, so a fix that never converges is an unbounded loop with an invisible dead end (plans/post-merge-fix-forward.md "The machinery a forward arm can reuse").

**Approach.**
- Carry the round on the fix: when the harness commits the reviewer's fix (part 1/6), its body carries the `Revision: <n>` trailer of the reviewed commit's round + 1 (`revisionRoundOf`, src/merge/merge-core.ts calls it today for the reverted hand-back), so the next review of that fix reads its own round from the same place a rejection's hand-back reads it.
- Stop at the backstop: in `reviewMergedCommit`/`startPostReview` (src/review/post-merge-review.ts, src/merge/merge-post-review.ts), when the reviewed commit's round is at `REVISION_BACKSTOP`, the reviewer records its surviving reasons instead of committing a fix, and the harness holds the answered PLANS.md plan through `holdEntryAfterExhaustion(root, role, claim, reasons)` — the same terminal state a rejection's exhaustion reaches (`recordRejectedChange`, src/merge/merge-core.ts).
- One counter: reuse `revisionRoundOf` and `holdEntryAfterExhaustion` rather than a second counter, so the self-fix chain and the rejection chain share `REVISION_BACKSTOP` and `REVISION_FINAL_ON_REPEAT` and cannot drift.
- A landed fix is a post-review entry, not a `state.revision`/`state.forwarded` hand-back: the round lives on the fix commit's body and the hold is the only runner state this part writes. (Part 1b/6 below deletes `state.forwarded`; this part does not write it.)

**Files touched.** src/runner/revision.ts src/review/post-merge-review.ts src/merge/merge-post-review.ts test/revision.test.ts test/post-merge-review.test.ts

**Acceptance criteria.**
- The landed fix appears as a new post-review entry and is reviewed on a later iteration; its commit body carries `Revision: <n>` one past the reviewed commit's round.
- A chain of self-fixes stops at `REVISION_BACKSTOP`: the reviewer stops fixing, and the answered plan is held with **Needs review** naming the surviving findings exactly as a rejection's exhaustion holds it.
- There is one backstop constant: the self-fix chain and the rejection chain both read `REVISION_BACKSTOP`, and no second counter is introduced.
- `npm run test:gate` passes.

**Tests.**
- test/revision.test.ts: `a self-fix chain stops at the backstop and holds the answered plan` — walk the fix commits' `Revision` rounds to `REVISION_BACKSTOP` and assert the hold note names the surviving findings and the entry is cleared.
- test/post-merge-review.test.ts: `a reviewer's fix commit carries the next revision round` — assert the landed `tumwater(reviewer): Fix` commit's body names one past the reviewed commit's round, and that a review at the backstop records reasons instead of committing a fix.

### Forward, never back, part 3/6: a review that never reaches a verdict files the commit as backlog work, and every surface reads the reviewer's fix rather than a revert (planned 2026-10-24 by the plan role, split from the held parts 1/2–2/2; requires part 1/6 landed, since the states it renders and files are part 1/6's; touches src/merge/merge-post-review.ts src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md docs/cli.md test/post-merge-review.test.ts test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts)

**Previously held 1**

**Goal.** Two loose ends of the forward path become visible and honest. A review that never reaches a verdict disappears today: after `POST_REVIEW_FAILURE_LIMIT` runs (src/merge/merge-post-review.ts) the entry is dropped with "stays on main unreviewed" and nothing else reads it — under this part the commit stays on main *and* a BUGS.md entry names it (sha, the commit summary, the last failure), so another role can improve it in the ordinary backlog flow. And every surface that named a revert reads the reviewer's fix instead.

**Approach.**
- File the unreviewed commit: at the failure cap, instead of `settlePostReview(root, entry.commit, null)` alone, append one BUGS.md entry naming the commit's short sha, its summary and the last failure, through the same backlog-write path `tumwater bug` uses; the `dropped-post-reviews` alert keeps counting the event.
- Surfaces: `postReviewStatusLabel` (src/review/post-merge-review-render.ts) and its GUI twin (src/ui/gui/gui-client-pending.ts) read `fixed — <finding> (fix <sha>)` for a landed fix, `approved` for a clean review, and `rejected — <finding>` for a recorded finding with no fix; `rejected — waiting to revert` and `awaiting the author's follow-up` go. The rejected entry's accept affordances go with the state that had them (`cmdReviewsAccept`'s rejected refusal, the dashboard's Accept button, the TUI's Ctrl+A arm), so no surface offers to accept a rejection.
- Docs: docs/how-it-works.md's post-merge-review paragraph describes the reviewer's fix (`fixed — <finding> (fix <sha>)`) instead of a revert and a revision, and docs/cli.md's `tumwater reviews` entry loses its rejected-entry accept wording; its `tumwater revert` entry stays and says the CLI revert is the operator's alone.
- The `post-merge-churn` alert keeps counting findings with the reviewer-fixes remedy (`narrow review.afterMerge` remains the alternative); the `post-merge-risk` and `dropped-post-reviews` alerts are unchanged.

**Files touched.** src/merge/merge-post-review.ts src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md docs/cli.md test/post-merge-review.test.ts test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts

**Acceptance criteria.**
- A post-merge review that exhausts its failure cap leaves its commit on main and files one BUGS.md entry naming it (sha, summary, last failure), so an unreviewed commit is backlog work rather than a line in a log.
- The rejected-entry accept affordances are gone: `tumwater reviews` (and its dashboard and TUI twins) accept a pending entry only, and no surface offers to accept a rejection.
- `postReviewStatusLabel` and its GUI twin read `fixed — <finding> (fix <sha>)`, `approved`, or `rejected — <finding>`, and never "waiting to revert".
- docs/how-it-works.md and docs/cli.md carry the new wording, and no doc says a post-merge rejection reverts.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: `a review that never reaches a verdict files the commit` — drive `POST_REVIEW_FAILURE_LIMIT` failed runs and assert the commit is still on main, the entry is gone, and exactly one BUGS.md entry names its sha; keep the failed-write case.
- The surface tests keep their subjects with the new wording: test/cli-reviews.test.ts (`fixed — … (fix <sha>)` renders; an accept on a fixed entry fails like an accept on any non-pending one), test/tui-keys.test.ts, test/gui-client-pending.test.ts, test/gui-post-review-accept.test.ts.

### Forward, never back, part 4/6: the revert subsystem is deleted — no `main_revert` is emitted and a red main is healed forward (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 3/6 landed, since a rejection must have a complete forward path before the backward one goes; parts 5/6–6/6 then delete every reader of the historical events this part stops writing; touches src/baseline/main-revert.ts (deleted) src/baseline/main-red.ts src/baseline/main-watch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator.ts src/runner/revision.ts docs/invariants.md docs/how-it-works.md test/main-revert.test.ts (deleted) test/operator-revert.test.ts)

**Previously held 1**

**Goal.** With a rejection answered forward, the machinery that takes a commit off main has no caller but the red-main culprit, and this part removes that too: nothing is ever removed from main, including a red main's culprit, which the watch's already-queued heal prompt repairs forward. No new `main_revert` event is logged and no revision is handed back for a red main. The event type and its readers stay, reading history (parts 5/6–6/6 delete them).

**Approach.**
- Delete the revert subsystem: src/baseline/main-revert.ts (`runMainRevert`, `revertSkipReason`, `routeMainCulprit`), src/merge/merge-drain.ts's revert slot (`startRevert`, `handBackReverted`, `handBackRevert`, `revertReasons`, `PendingRevert`, `revertedPendingPath`/`pendingReverts`, and `assignPendingReverts`' revert loop), src/merge/merge-pipeline.ts's `p.revert`, src/merge/merge-core.ts's `recordRevertedChange` and `handBackChange`'s `"reverted"` arm, src/orchestrator/orchestrator.ts's `routeMainCulprit` wiring, and src/runner/revision.ts's re-apply chain (`applyRevision`/`applyWithConflicts` and the `revision`/`rejectedRefName` helpers the reverted path reads). `MainCulprit` moves to src/baseline/main-watch.ts, whose `onCulprit` is its only remaining producer, and keeps only the fields a red-main heal needs. `revertCommitIn` (src/operator/revert.ts) stays: `tumwater revert` is the operator's own act, and the `operator_revert` event with it.
- A red main heals forward: src/baseline/main-red.ts's heal path becomes the only one — the heal prompt the watch already queues, with the existing wording — and `main-watch.ts`'s `onCulprit` names the tip as the culprit without routing a revert.
- Docs: docs/invariants.md loses INV-L1, INV-C3, INV-BS1/2/3 and INV-CO1's revert guarantees (the `reason: "post-review"` paragraph is parts 5/6–6/6's, with the readers); docs/how-it-works.md's revert paragraphs describe the red-main heal prompt instead.
- No change to the pre-merge deterministic checks, the main watch's own check, or the `main_revert` event type and its readers: this part removes the emission, not the verification, and parts 5/6–6/6 remove the readers.

**Files touched.** src/baseline/main-revert.ts (deleted) src/baseline/main-red.ts src/baseline/main-watch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator.ts src/runner/revision.ts docs/invariants.md docs/how-it-works.md test/main-revert.test.ts (deleted) test/operator-revert.test.ts

**Acceptance criteria.**
- No `runMainRevert`, `routeMainCulprit` or `startRevert` remains, no `main_revert` event is logged for a red main, and no revision is handed back for one; `tumwater revert <sha>` still reverts and still logs `operator_revert` with the merge slot free afterwards.
- A red main queues the watch's heal prompt (its existing wording) and reverts nothing.
- The `main_revert` event type, its formatter and its readers still compile and read events already in the log; the only production code that mentions a revert is `tumwater revert`'s operator path, the `operator_revert` event, and wording saying a commit is never taken off main.
- `npm run test:gate` passes.

**Tests.**
- test/main-revert.test.ts: deleted with the module; the cases that still hold (a director-merged or runnerless culprit, `tumwater revert`) move to test/operator-revert.test.ts.
- test/operator-revert.test.ts: `tumwater revert still reverts and logs operator_revert` — a deliberate operator revert lands, logs `operator_revert`, and leaves the merge slot free.

### Forward, never back, part 5/6: the revert guardrails, doctor row, alerts and digest lose a revert that can no longer happen (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 4/6 landed, since no emission remains for the readers this part removes; part 6/6 below then deletes the report and GUI surfaces and the event type itself; touches src/baseline/main-guardrails.ts src/doctor/doctor-holds.ts src/doctor/doctor-project-checks.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/run/selfcheck-digest.ts docs/invariants.md test/main-guardrails.test.ts test/selfcheck-digest.test.ts)

**Previously held 1**

**Goal.** With no revert emitted, the doctor's revert rule, the `reverts` status alert and the digest's revert line count events that can never come. This part deletes them and the ceiling constant, so the 5-revert ceiling disappears and BUGS.md's churn entry loses its counting half (a reason-less event can no longer be misread as a red-main revert). The report and GUI "Reverts by role" charts and the `main_revert` event type are part 6/6's.

**Approach.**
- Delete the guardrail: src/baseline/main-guardrails.ts's `revertGuardrail`/`revertWarnings`/`revertLooksFalse`/`REVERT_RATE_LIMIT`/`revertsFor` and their `main_revert`-vs-`merged` patch-id matching.
- Delete every reader of it: src/doctor/doctor-holds.ts's `revertWarnings` phrases and src/doctor/doctor-project-checks.ts's revert row, src/ui/team-alerts.ts's `reverts` banner, src/ui/status-payload.ts's `revertAlert` (and its call site in the `teamAlerts` list), src/ui/status-render.ts's import and argument, and src/run/selfcheck-digest.ts's `guardrailWarnings` revert section.
- Docs: docs/invariants.md loses the revert-ceiling guarantee and any binding that names the deleted guardrail functions; no summary surface reads a revert that can no longer happen.
- The `main_revert` event type, formatter and label stay so the log still parses and the report/GUI can be removed in part 6/6.

**Files touched.** src/baseline/main-guardrails.ts src/doctor/doctor-holds.ts src/doctor/doctor-project-checks.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/run/selfcheck-digest.ts docs/invariants.md test/main-guardrails.test.ts test/selfcheck-digest.test.ts

**Acceptance criteria.**
- `grep -rn "revertGuardrail\|revertWarnings\|revertLooksFalse\|REVERT_RATE_LIMIT\|revertsFor\|revertAlert" src/ --include=*.ts` is empty, and no doctor row, status alert or digest line mentions a revert.
- The 5-revert ceiling is gone: no constant counts revert events and no warning fires on one.
- `operator_revert` and `tumwater revert` still work and their surfaces are untouched.
- `npm run test:gate` passes.

**Tests.**
- test/main-guardrails.test.ts: drop the revert-ceiling and revert-phrase cases, and keep one case pinning that an `operator_revert` still reads as a deliberate revert while no automatic revert rule warns.
- test/selfcheck-digest.test.ts: drop the digest's revert line case; keep the digest's other sections green.

### Forward, never back, part 6/6: the report and GUI "Reverts by role" surfaces and the `main_revert` event type are deleted (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 5/6 landed, so the event type loses its last readers in the same deletion; touches src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/events/event-read.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts src/run/run-detail-data.ts src/failure/time-spend.ts docs/invariants.md test/time-spend.test.ts test/report-data.test.ts)

**Previously held 1**

**Goal.** With no producer and no summary reader left, the report's and GUI's "Reverts by role" charts and the `main_revert` event type are dead weight. This part deletes them, so `grep -rn "main_revert" src/` is empty and the `reason: "post-review"` split `1917e9c80` added goes with the event (with no revert there is no cause to tag). `operator_revert` and its report/run-detail rendering stay.

**Approach.**
- Delete the type and its formatting: src/events/events.ts's `main_revert` union member (keep `merged`'s and `operator_revert`'s), src/events/event-format.ts's case, src/events/event-labels.ts's `main_revert: "main red reverted"` label, and src/events/event-read.ts's `main_revert` reason normalization.
- Delete every remaining reader: src/report/report-fold.ts's `revertsByRole` fold and `main_revert` arm (+ src/report/report-types.ts's fields), src/report/report-data.ts's `revertsByRole` plumbing, src/report/report-render.ts's "Reverts by role" lines, src/ui/gui/gui-client-report-chart.ts's `chartRevertsByRole` and src/ui/gui/gui-client-report.ts's "Reverts by role" block, src/run/run-detail-data.ts's revert cause and `main_revert` branch, and src/failure/time-spend.ts's `reverted` loss cause and `main_revert` scan.
- Docs: docs/invariants.md loses the `reason: "post-review"` paragraph and any remaining `main_revert` binding; `operator_revert`'s guarantee stays.
- No production code may mention `main_revert` after this part; the log may still contain old events, which simply no longer parse into a known type.

**Files touched.** src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/events/event-read.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts src/run/run-detail-data.ts src/failure/time-spend.ts docs/invariants.md test/time-spend.test.ts test/report-data.test.ts

**Acceptance criteria.**
- `grep -rn "main_revert" src/ --include=*.ts` is empty, and `grep -rn "revertsByRole" src/ --include=*.ts` is empty.
- The report and the browser dashboard print no "Reverts by role" chart, and the digest, doctor and status surfaces print no revert line.
- `operator_revert` still renders where it did (`tumwater revert`'s run detail and the report counts), and no surface reads a revert that no longer happens.
- `npm run test:gate` passes.

**Tests.**
- test/time-spend.test.ts / test/report-data.test.ts: drop the `reverted` loss-cause and `revertsByRole` cases, and keep one case pinning that an `operator_revert` still folds into the report's operator-revert count while no automatic revert does.

### Every commit is verified on main, part 3/3: the pre-merge blocks come off — no in-lock gate run, no pre-merge model verdict, no red-main authoring block (planned 2026-10-24 by the operator, split from the held single plan; requires part 2/3 landed, since a landing stops being checked on the way in only once the whole deterministic set runs on the watched tip and the tip is the culprit; touches src/merge/merge-verify.ts src/merge/merge-to-main.ts src/merge/merge-batch.ts src/review/review.ts src/review/review-followup.ts (deleted) src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts src/doctor/doctor-holds.ts src/config/config-schema.ts src/config/config-views.ts src/config/config.ts src/orchestrator/ docs/config.md docs/how-it-works.md test/merge-verify.test.ts test/merge-to-main.test.ts test/review.test.ts test/main-red.test.ts test/runner-run.test.ts test/config.test.ts)

**Needs review 2026-10-24 by feature: too large for one run (held 2)**

**Previously held 1**

**Goal.** A commit is never stopped on its way to main. With the watch verifying every new tip, the checks that stood in front of a landing are redundant and go: the in-lock gate run (142–330 s per merge, plans/fast-merge.md), the pre-merge model verdict and the permit it holds, the batch check with its largest-passing-prefix bisect, and the red-main authoring block, which existed only to avoid diffs the pre-merge verdict would reject. The trade becomes explicit: a broken commit sits on main between its landing and its fix (minutes), and the fix is the healer's.

**Approach.**
- Delete the merge path's blocking checks: `mergeApprovedChange`'s in-lock gate run, src/merge/merge-verify.ts's pre-merge review step and the `VERIFY_TIER` permit it holds, src/merge/merge-batch.ts's scope-`batch` check and its largest-passing-prefix bisect (with `mergeBatchMax`'s per-pick attribution), and src/review/review-followup.ts's pre-merge revision round. A merge becomes: rebase onto the tip and take the fast-forward under the merge lock.
- `review.afterMerge` goes: every role lands first and is reviewed by the one post-landing pass. Config-schema, config-views, the `tumwater config` and docs surfaces and the tests that pin the key go with it; `review.exemptPaths` and the post-review model knobs stay.
- The precheck rules keep their non-verdict callers — the merge pre-flight's dirty-checkout refusal, the backlog archive's protected-edit guard — so the module does not disappear, only its role as a gate on a role's own diff.
- The red-main authoring block goes with the pre-merge verdict: `mainRedGate` and `baselineBlocked`/`BASELINE_BLOCKED_ROLES` (src/baseline/main-red.ts, src/roles/roles.ts) exist only to stop a code role spending an authoring run whose diff the pre-merge check would reject — with nothing left to reject it, every role authors on a red main. The information survives where it is useful: the prompt's known-red note (`buildMainKnownRedNote`) naming the failing tests and their owner, and the healer hand-off the `ci` plan above routes to the ci role. The doctor's `main red` row (`doctor-holds.ts`'s held-code-role list) and the outcome the block returns go with it.
- The gate-scope checks that are still on the change's own tree go too: `review-precheck.ts`'s reject (:203-212) and `merge-check-failures.ts`'s `merge_blocked`/`review_rejected` attribution lose their producers, and with them the merge-side `main_red` keep (src/merge/merge-core.ts:275-280) and `requeueMainRedPin`'s wait (src/merge/merge-requeue.ts:65,85-112) — there is no in-lock verdict left for main's redness to excuse. A check failure attributed to a landing is the watch's now, and its repair is the healer's (`ci`, per the `ci` plan).
- Two gate rules stay pre-merge, deliberately, and the plan should say so where it deletes the others: **secret leaks** (src/review/review.ts:301, src/review/secret-leaks.ts) and **protected edits** (src/review/review.ts:298, INV-G1's `protected-edits.ts`). Neither is a wrong-but-green change a later commit repairs: a leaked credential is in the history the moment it lands and has to be rotated, and the protected-edit rule is the operator's policy boundary rather than a correctness verdict. Everything else the gate rejects moves forward — conflict markers (review.ts:294), a false fix claim (review.ts:309) and backlog structure (review.ts:315,325) are all things the post-landing check repairs, and parts 1/3 and 2/3's watch set already runs them.
- The reviewer's provider holds stop gating the team: `reviewHeld`/`reviewStrongPaused` (src/orchestrator/scheduling-skip.ts:118-121, orchestrator-poll.ts:354,425-430) exist to keep a change from landing while the reviewer's provider is down. With `review.afterMerge` gone, `afterMergeRoles` is empty and the `!afterMergeRoles.has(...)` exemption collapses, so the hold as written would defer *every* role and every merge. Re-scope it to the post-landing review queue alone: a review parks, a landing does not. The permanent config-error hold (`mergeReviewError`, src/merge/merge-core.ts:283-306, read at src/runner/leftover.ts:118-124) goes with the pre-merge verdict it belongs to.
- One stranding path is fixed rather than deleted: a torn or foreign queue head silently strands every change behind it (`merge-queue.ts`'s `staleHeadFile`/`readMergeQueue`, dropped in `merge-verify.ts`'s `dropTornHead`). Drop the bad head loudly (a warning naming the file and its role) and re-queue its change, so nothing can wait forever on one unreadable file — the "nothing blocks a landing" rule has to hold for a change the queue cannot even read.
- No change to the refusals that are not verdicts about a change's quality, and the plan says so where it deletes the others so nobody reads the deletion as a licence to remove these too: the dirty-primary-checkout pre-flight (`merge-to-main.ts:172-175`, `merge-git.ts:415` — the 2026-10-23 incident's guard), a rebase conflict and its `MERGE_CONFLICT_LIMIT` hand-back (`leftover.ts:36`), a fast-forward that loses to a main move (`merge-git.ts:345`), the startup/redeploy stage check (`build-stage.ts:89,182`), and every team gate that holds *new runs* rather than a landing (budget, per-role cap, pause, streak, quiet hours, disk floor, maintenance quota, bootstrap, provider storms — `src/gates/*`, `src/team/team-hold.ts`). A conflicted tree cannot be landed and a leaked credential cannot be un-leaked; those are the two rules the plan keeps on the way in, and the rest of this list never was about a change's quality.
- Docs: docs/config.md drops `review.afterMerge` and says which checks the remaining merge path keeps (docs/how-it-works.md's merge paragraph and docs/invariants.md's re-pointed guarantees are part 3/3's).

**Files touched.** src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts src/doctor/doctor-holds.ts src/merge/merge-verify.ts src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-queue.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/review/review.ts src/review/review-precheck.ts src/review/review-followup.ts (deleted) src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-poll.ts src/runner/leftover.ts src/config/config-schema.ts src/config/config-views.ts src/config/config.ts src/orchestrator/ docs/config.md test/main-red.test.ts test/runner-run.test.ts test/merge-verify.test.ts test/merge-to-main.test.ts test/review.test.ts test/merge-queue.test.ts test/config.test.ts

**Acceptance criteria.**
- A merge takes no gate run: the merge slot's per-change work is the rebase, the commit and the fast-forward, and the only refusal left on the path to main is a dirty or conflicted tree.
- Authoring is never blocked by main's redness: `mainRedGate`, `baselineBlocked` and `BASELINE_BLOCKED_ROLES` are gone, no run ends `main_red`, and a role beginning a run on a red main gets the known-red note naming the failing tests and their owner instead. The doctor's `main red` held-role row is gone with them.
- `review.afterMerge` no longer exists in the schema, the config views, the docs or any code path, and every role's commit reaches the queue of unreviewed commits.
- No pre-merge check can refuse a change except the two named: secret leaks and protected edits still reject a diff (`review_rejected` with their reason), and no other rule can — conflict markers, a false fix claim, backlog structure and the declared check are all reported by the watch on main instead. `reviewHeld`/`reviewStrongPaused` defer no role but the post-landing review, and a torn queue head warns and re-queues rather than stranding its change.
- `npm run test:gate` passes.

**Tests.**
- test/merge-to-main.test.ts: `a merge runs no gate command` — merge a change with a gate command declared and assert no build-check run was started and the fast-forward landed; keep the conflict and dirty-checkout refusal cases.
- test/main-red.test.ts / test/runner-run.test.ts: `a red main blocks no run` — a code role's run on a red main proceeds with the known-red note and never returns the `main_red` outcome; `baselineBlocked` no longer exists, and the doctor renders no `main red` held-role row.
- test/review.test.ts: `only a secret leak and a protected edit refuse a diff` — one case per rule: a conflict marker, a false fix claim and a broken backlog structure each land with a `warning`-only path and no `review_rejected`, while a leaked credential and a protected edit still end `review_rejected` with their reason and leave the pin deleted.
- test/merge-verify.test.ts / test/merge-queue.test.ts: `a torn queue head warns and re-queues its change` — plant an unreadable head file and assert one warning names it, the change is re-queued rather than dropped, and the queue advances past it.
- test/config.test.ts: `review.afterMerge is gone` — the key is absent from the schema, from a rendered default config and from `tumwater config`'s listing, while an old config carrying it still loads (the path every removed key takes).

### `tumwater doctor --drop-broken-pins` drops the `refs/tumwater/` pins whose commit is gone, and the dashboard Health card does too — the reap for the one doctor row whose only remedy is a manual `git update-ref -d` (planned 2026-10-24 by the plan role; independent of every eligible plan in behavior — the `ci` parts edit src/roles and src/run, the "Every commit is verified on main" parts edit src/baseline and src/merge, the `teamAlerts` parts edit src/ui/team-alerts.ts, the Pending Ctrl+O plan edits the TUI Pending pane, and the notable-cull plan edits the CLI `logs` feed and the TUI Activity pane; it shares src/cli/cli-flag-specs.ts and src/cli.ts with the notable-cull plan (that plan adds `NOTABLE_FLAG` for `logs`, this one `DROP_BROKEN_PINS_FLAG` for `doctor` — additive sibling lines, so whichever lands second rebases there) and docs/cli.md's doctor row with the notable-cull and Pending plans (this one edits the `doctor` row only, they edit the `logs` and TUI-keys rows); touches src/doctor/doctor-contention-checks.ts src/cli/cli-flag-specs.ts src/cli.ts src/cli/help.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-settings.ts src/ui/gui/gui-client-boot.ts docs/cli.md test/doctor-checks.test.ts test/doctor.test.ts test/gui-endpoints.test.ts test/gui-client-settings.test.ts)

**Goal.** `checkTumwaterPins` (src/doctor/doctor-contention-checks.ts) fails the `tumwater pins` doctor row when a `refs/tumwater/` pin names a commit that is gone, because such a pin stops `git gc` and aborts a detached checkout, and its row names only a manual `git update-ref -d <ref>` as the fix. Every other mutating doctor action has an operator-facing reap: `--kill-orphans` (the orphans row), `--commit-backlog` (the dirty-checkout merges), `--resync-install` (the `root install` row), each reaching the dashboard Health card and the TUI Health tab (Ctrl+K, Ctrl+A and Ctrl+U). Give the `tumwater pins` row the same reach: one core drops each broken pin, and `tumwater doctor --drop-broken-pins` and the dashboard Health card call it, so a lone broken pin cannot hold the team's git housekeeping hostage with no in-product way to clear it.

**Approach.**
- src/doctor/doctor-contention-checks.ts: extract the broken-pin walk out of `checkTumwaterPins` into a private `async function brokenPins(root): Promise<{ ref: string; sha: string }[]>` (`refsUnder(root, "refs/tumwater/")` filtered by `!await commitExists(root, pin.sha)`), and make `checkTumwaterPins` call it, so the row and the reap can never disagree on what a broken pin is. Beside it add `export interface BrokenPinDrop { dropped: { ref: string; sha: string }[]; failed: { ref: string; reason: string }[] }` and `export async function dropBrokenPins(root: string): Promise<BrokenPinDrop>`: for each broken pin call `deleteRefIfAt(root, pin.ref, pin.sha)` (the guarded `git update-ref -d` that is a no-op when the ref moved under us, src/git/git.ts), and report the pins whose ref is gone as `dropped` and any ref that still names a gone commit afterwards as `failed`. Add `export function brokenPinDropLines(drop: BrokenPinDrop): string[]` beside the function (mirroring `orphanKillLines` in src/doctor/doctor-orphans.ts) returning e.g. `dropped 2 broken pins: refs/tumwater/merge/feature names ab12cd3e, …` and, when non-empty, `2 pins could not be dropped: …`. Keep the check read-only: only `dropBrokenPins` mutates.
- src/cli/cli-flag-specs.ts: add `export const DROP_BROKEN_PINS_FLAG: FlagSpec = { names: ["--drop-broken-pins"] };` beside `RESYNC_INSTALL_FLAG`, doc-commented as the fourth mutating doctor flag. src/cli.ts: add it to `doctor`'s `rejectUnknownArgs` allowlist and run `dropBrokenPins(root)` before the checks, printing `brokenPinDropLines(drop)` first (the order `--kill-orphans` uses), and with `--json` carry a `brokenPinDrop` field shaped like `orphanKill` (`{ dropped, failed }`). src/cli/help.ts: the `tumwater doctor` usage line gains `[--drop-broken-pins]`, and the `--kill-orphans`/`--commit-backlog`/`--resync-install` note names the new flag and its row.
- Dashboard: src/gui/gui-operator-commands.ts gains `export async function handleDropBrokenPins(req, res, root, drop = dropBrokenPins)` beside `handleKillOrphans` (same `readPostBody(req, res, "{}")` discipline, `sendJson(res, 200, { ok: drop.failed.length === 0, message: brokenPinDropLines(drop).join("; ") })`). src/gui/gui-server.ts routes `"POST /api/doctor-drop-broken-pins"` beside `/api/kill-orphans`. src/ui/gui/gui-client-settings.ts adds a `Drop broken pins` button to the Health card's button row (beside Kill orphans) with a two-click confirm and a handler that POSTs the route, flashes `d.message`, then re-runs the checks so the `tumwater pins` row repaints; src/ui/gui/gui-client-boot.ts dispatches the button click like `doctor-kill-orphans`.
- Docs: docs/cli.md's `tumwater doctor` row names `--drop-broken-pins` ("drops each `refs/tumwater/` pin whose commit is gone — the manual `git update-ref -d` the `tumwater pins` row names; safe because the work a broken pin named is already lost") and names the dashboard Health card's Drop broken pins button as its twin. The TUI Health tab keeps showing the failing `tumwater pins` row but gets no new key: the candidates are not free (the budget editor consumes Ctrl+B on every view, and Ctrl+H/J/Z are terminal-ambiguous), so this reap is deliberately CLI/dashboard-only — an implementation that finds itself adding a TUI key has gone off-plan.

**Files touched.** src/doctor/doctor-contention-checks.ts src/cli/cli-flag-specs.ts src/cli.ts src/cli/help.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-settings.ts src/ui/gui/gui-client-boot.ts docs/cli.md test/doctor-checks.test.ts test/doctor.test.ts test/gui-endpoints.test.ts test/gui-client-settings.test.ts

**Acceptance criteria.**
- On a repo whose `refs/tumwater/merge/feature` names a commit that no longer exists, `tumwater doctor --drop-broken-pins` deletes that ref, prints one `dropped 1 broken pin: …` line before the report, and the report's `tumwater pins` row now reads `no tumwater pins`; a healthy pin (its commit exists) and a `refs/tumwater/` pin naming a live commit are never dropped, and the row's own wording (`git update-ref -d`) is unchanged for the broken pins a hand run finds without the flag.
- `tumwater doctor --drop-broken-pins --json` carries `brokenPinDrop: { dropped: [...], failed: [...] }` with the same `{ ref, sha }` entries the text line names, and a run with no broken pins carries `{ dropped: [], failed: [] }` and prints no drop lines.
- The dashboard Health card's Drop broken pins button, after a second click, POSTs `/api/doctor-drop-broken-pins`, flashes the drop lines, and re-runs the checks; the route answers `{ ok: true, message }` with a torn or missing ref and never touches a live pin.
- `checkTumwaterPins` and `dropBrokenPins` both call the one private `brokenPins(root)` walk (the only `refsUnder(root, "refs/tumwater/")` call in src/doctor/doctor-contention-checks.ts), so the row and the reap cannot define a broken pin differently.
- `npm run test:gate` passes.

**Tests.**
- test/doctor-checks.test.ts: `dropBrokenPins drops only pins whose commit is gone` — in a temp repo with a `refs/tumwater/merge/feature` pin at a commit that exists and a `refs/tumwater/rejected/clean` pin at a nonexistent sha, assert the drop returns the rejected ref in `dropped`, the merge ref is absent from `dropped`, and `checkTumwaterPins` afterwards reads `no tumwater pins` when only the broken one existed (and still fails, naming the merge ref, when its commit is deleted after a pin is re-pointed). Reuse the existing pins fixtures/helpers in that file.
- test/doctor.test.ts: `doctor --drop-broken-pins drops the row's broken pins before the report` — seed a broken pin, run the CLI handler with the flag, and assert the printed drop line precedes the report and the `tumwater pins` row is `ok`; the same run without the flag leaves the ref and the row `fail`.
- test/gui-endpoints.test.ts: `handleDropBrokenPins answers the drop lines` — an injected `drop` returning the dropped/failed shapes gives `ok`/`message` equal to `brokenPinDropLines(drop).join("; ")`, a malformed body answers 400 and never calls the seam.
- test/gui-client-settings.test.ts: `Drop broken pins POSTs the route after a confirming second click` — the first click arms only, the second POSTs `/api/doctor-drop-broken-pins`, flashes the message, and re-runs the checks.

### The TUI Backlog pane and the dashboard Backlog card gain a Ready-only filter, the `tumwater backlog --ready` twin (planned 2026-10-24 by the plan role; independent of every eligible plan — the `ci` parts edit src/config, src/run, src/prompt and docs/config.md, the "Every commit is verified on main" parts edit src/baseline, src/merge and docs/invariants.md, the `Forward, never back` parts edit src/review, src/merge, src/verdict and docs/invariants.md, and the broken-pin reap plan edits src/doctor, src/cli, src/gui and src/ui/gui/gui-client-settings.ts; none of them edits src/ui/tui/tui-backlog.ts, src/ui/tui/tui-pane-backlog.ts, src/ui/tui/tui-pane.ts, src/ui/tui/tui-panes.ts, src/ui/tui/tui-keys.ts, src/ui/tui/tui-frame.ts or src/ui/gui/gui-client-backlog.ts. Only docs/cli.md is shared, as neighbouring TUI-keys rows and a `tumwater backlog` clause, so whichever lands second rebases there; touches src/ui/tui/tui-backlog.ts src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-pane.ts src/ui/tui/tui-panes.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/gui/gui-client-backlog.ts docs/cli.md docs/how-it-works.md test/tui-backlog.test.ts test/tui-keys.test.ts test/gui-client-team.test.ts)

**Goal.** `tumwater backlog --ready` keeps only the plans and bugs no hold keeps from being picked, but neither dashboard offers it. The TUI Backlog pane interleaves held open entries with pickable ones, and the browser Backlog card always paints its whole `Blocked (n)` section below the pickable rows. With the queue now holding several blocked series parts (the `Forward, never back`, `Every commit is verified on main` and post-merge-rejection series), an operator watching either surface must page past work no role can take. Give both the filter, so the ready set `assignNext` would work through is one key or click away.

**Approach.**
- src/ui/tui/tui-backlog.ts `visibleBacklogIndexes`: add a third parameter `readyOnly = false`; keep an open entry only when its `hold` is null (`EntryHold | null | undefined`; `labeledBacklogEntries` already builds the flat list with `hold`, and questions carry null). The `/` pattern still composes, and the existing two-argument callers keep today's behavior. Pure and unit-testable without a TTY.
- src/ui/tui/tui-pane-backlog.ts: add session-scoped `let backlogReadyOnly = false` beside `backlogGrep`, a Ctrl+O arm in `handleKey` (guarded by `promptLineFree(ctx.es)` and the Backlog view) that flips it and calls `session.requestRender()`, pass it to `visibleBacklogIndexes` in the up/down arm, and return it from `state()`. `reset()` leaves it, like `backlogGrep`.
- src/ui/tui/tui-panes.ts: expose the pane's `backlogReadyOnly` in the aggregate state (beside `backlogGrep`), and route Ctrl+O on the Backlog view to `backlog.handleKey` ahead of the History outcome-cycle fallthrough (the guarded-arm shape the Health and Pending Ctrl+O arms use).
- src/ui/tui/tui-keys.ts: type the new `backlogReadyOnly: boolean` field on the pane state.
- src/ui/tui/tui-pane.ts: the backlog render's `shown` filter also requires `e.hold === null` for open entries when `state.backlogReadyOnly` is true, composed with the `/` pattern; the answered/done/fixed rows stay. `selectedEntry` still indexes the unfiltered `flat`, so the entry actions keep addressing whole-file positions.
- src/ui/tui/tui-frame.ts: the Backlog hint (:103) gains `["Ctrl+O", "ready only"]`.
- src/ui/gui/gui-client-backlog.ts: add `let backlogReady = recall("backlog-ready") === "1"`, a `Ready only` toggle in `buildBacklogView`'s toolbar beside the Search box (a listener stores the choice and re-renders, the `setBacklogGrep` shape), and in `renderBacklog`'s plan/bug branch render only the `ready` rows — skipping the `held`/`Blocked (n)` divider — when `backlogReady` is true. Rows keep their unfiltered `data-index`, so the drawer, Answer, cancel and release still address the position `tumwater backlog` numbers.
- docs/cli.md: the TUI-keys table's Backlog row gains `Ctrl+O` ("keep only the plans and bugs no hold keeps from being picked, the terminal twin of `tumwater backlog --ready`; the answered/done/fixed sections stay"), and the `--ready` clause names the TUI's Ctrl+O and the dashboard Backlog card's Ready only toggle as its twins. docs/how-it-works.md: the dashboard Backlog sentence names the Ready only toggle.
- No change to `readyBacklog` (src/backlog/backlog-render.ts), the `GET /api/backlog` payload, the `/api/backlog-match` route, or any entry action.

**Files touched.** src/ui/tui/tui-backlog.ts src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-pane.ts src/ui/tui/tui-panes.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/gui/gui-client-backlog.ts docs/cli.md docs/how-it-works.md test/tui-backlog.test.ts test/tui-keys.test.ts test/gui-client-team.test.ts

**Acceptance criteria.**
- On the TUI Backlog view, Ctrl+O hides every open plan or bug whose hold is non-null while keeping questions, entries a role is working on (hold null), and the answered/done/fixed sections; a second Ctrl+O restores the full list; `/` search composes with it; up/down step only through the entries still shown.
- On the dashboard Backlog card's Plans and Bugs tabs, the Ready only toggle hides the `Blocked (n)` section and keeps the pickable rows; the choice is remembered across reloads like the Search text; switching tabs keeps it; the Questions and Inbox tabs are unchanged.
- An entry action still addresses the whole-file position: with Ready only on, cancel/release/edit and the row drawer reach the same entry `tumwater backlog` numbers without the filter.
- `tumwater backlog --ready`'s output is unchanged (`readyBacklog` and the payload are untouched).
- `npm run test:gate` passes.

**Tests.**
- test/tui-backlog.test.ts: `visibleBacklogIndexes drops held entries when readyOnly` — a flat list of an eligible plan, a held plan, an eligible bug and a question yields only the eligible plan, bug and question indexes with `readyOnly` true, and every open index with it false; a `/` pattern still composes. Extend the existing `paneBody` backlog cases with a `backlogReadyOnly: true` state asserting the held plan's title is absent and the eligible one is present.
- test/tui-keys.test.ts: `Ctrl+O on the Backlog view toggles ready-only` — feed a Ctrl+O key with the Backlog view selected, assert the pane's `state().backlogReadyOnly` flips and a second press restores it, and that Ctrl+O on a non-Backlog view does not set it.
- test/gui-client-team.test.ts: `the Ready only toggle hides the Blocked section` — extend `backlogScope`'s expose list with the toggle, seed a payload carrying a pickable and a held plan, assert the rendered html carries the `Blocked` divider and the held row, toggle and re-render, and assert the held title and divider are gone while the pickable row remains.

## Done
