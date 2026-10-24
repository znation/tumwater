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

### Forward, never back, part 3a/6: a post-merge review dropped at its failure cap files its commit as backlog work (planned 2026-10-24 by the plan role, split 2026-10-24 by the plan role from the held part 3/6; requires part 1/6 landed, since the drop sites and the entries they leave are part 1/6's; independent of part 3b/6 and shares no file with it; touches src/merge/merge-post-review.ts src/backlog/backlog-archive.ts test/post-merge-review.test.ts test/backlog-archive.test.ts)

**Previously held 1**

**Goal.** A post-merge review that never reaches a verdict disappears today: in `startPostReview` (src/merge/merge-post-review.ts) a third failed run warns "stays on main unreviewed" and `settlePostReview(root, entry.commit, null)` drops the entry, and the failed-fix-merge cap in `mergeReviewerFix` drops it the same way. The commit stays on main with nothing but an event line naming it. This part leaves the commit on main *and* files one BUGS.md `## Open` entry naming it, so an unreviewed commit becomes ordinary backlog work a role can pick up.

**Approach.**
- src/backlog/backlog-archive.ts: extract the body of `fileQuarantineBugsOnMain` — the `withLock(mergeLockDir(root), …)` + `withPrimaryWorktreeLockAsync` wrapper, the primary-on-base-branch check, the `git status --porcelain -- BUGS.md` cleanliness check, the read and `restoreBugs`/`writeTextAtomic` rollback, the `appendBugEntryLocked` appends, and the `tumwater(operator):` `git commit` — into an exported `fileBugsOnMain(root, entries: readonly { title: string; body: string }[], subject: string, opts?: { lockTimeoutMs?: number })`. `fileQuarantineBugsOnMain` becomes a thin caller that maps each `{ test, tail }` to its `quarantineTitlePrefix(test) + date + ")"` title and its body and passes the existing "File N quarantined flaky tests in BUGS.md" subject, so its behavior and tests stay as they are.
- src/merge/merge-post-review.ts: add a best-effort `fileDroppedReview(root, entry, failure)`: build one entry (title `` `post-merge review of ${shortSha(entry.commit)} never reached a verdict (found by the review role ${formatDate(new Date())})` ``, body naming `entry.summary` and the `failure` text) and call `fileBugsOnMain(root, [entry], "File an unreviewed post-merge commit in BUGS.md")`; on `{ status: "skipped" }` or a throw, log one `warnEventBestEffort(root, entry.role, …)` and return, so a filing problem never stops the drop. Import `formatDate` from ../text/datetime.js and `fileBugsOnMain` from ../backlog/backlog-archive.js.
- Call `await fileDroppedReview(...)` before the two `settlePostReview(root, entry.commit, null)` drop sites: in `startPostReview` when `failures >= POST_REVIEW_FAILURE_LIMIT`, passing `outcome.detail`; in `mergeReviewerFix` when `failures >= POST_REVIEW_FAILURE_LIMIT`, passing `` `fix did not merge: ${result}` ``. File before settling, keep the existing warnings and the `deleteRef(reviewFixRef(...))` calls, and leave the `exhausted` (REVISION_BACKSTOP) arm alone — it records its own surviving findings.

**Files touched.** src/merge/merge-post-review.ts src/backlog/backlog-archive.ts test/post-merge-review.test.ts test/backlog-archive.test.ts

**Acceptance criteria.**
- A post-merge review dropped at `POST_REVIEW_FAILURE_LIMIT`, on either the verdict-less path or the failed-fix-merge path, leaves the commit on main, drops the entry, and leaves exactly one BUGS.md `## Open` entry whose heading names the commit's short sha and whose body names its summary and the failure.
- `fileQuarantineBugsOnMain`'s behavior is unchanged: it still files one entry per new flaky test, skips on a dirty BUGS.md or an off-base checkout, restores BUGS.md on a failed append or commit, and commits with its existing subject.
- A filing that is skipped (off-base checkout or a BUGS.md with uncommitted changes) or throws never prevents the entry from being dropped and never throws out of the drain.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: extend "a verdict-less review past the failure limit drops the entry, warns, and starts no revert" to assert exactly one BUGS.md `## Open` entry names the dropped commit's short sha and its summary; extend "a fix whose landing keeps failing is dropped at POST_REVIEW_FAILURE_LIMIT" the same way; add a case where BUGS.md is uncommitted, so the filing skips and the entry is still dropped.
- test/backlog-archive.test.ts: keep the `fileQuarantineBugsOnMain` cases green and add one `fileBugsOnMain` case with an arbitrary title and body (the extracted helper files and commits it).

### Forward, never back, part 3b/6: every surface reads a rejected entry as the reviewer's recorded finding, not a pending revert (planned 2026-10-24 by the plan role, split 2026-10-24 by the plan role from the held part 3/6; requires part 1/6 landed, since a rejected entry no longer fills the revert slot; independent of part 3a/6 and shares no file with it; docs/invariants.md's revert guarantees are part 4/6's and are left alone; touches src/review/post-merge-review-render.ts src/review/post-merge-review.ts src/ui/gui/gui-client-pending.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/gui/gui-operator-commands.ts src/ui/team-alerts.ts src/ui/status-payload.ts docs/how-it-works.md docs/cli.md test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts test/team-alerts.test.ts test/status-payload.test.ts)

**Previously held 1**

**Goal.** Part 1/6 made a rejected commit stop filling the revert slot: a rejection is answered by the reviewer's own landed fix, and a rejection whose reply carried no fix is a recorded finding, not a state waiting for a revert. The renderer, the CLI, the TUI, the dashboard, the churn alert and their docs still say "waiting to revert" and "the rejection starts a revert and a re-author". This part removes every such claim so the surfaces agree with the code: a rejected entry reads `[rejected — <reasons>]`, and `--accept` retires it like any other terminal entry.

**Approach.**
- Shared label: in src/review/post-merge-review-render.ts, `postReviewStatusLabel`'s `rejected` branch returns `` `[rejected — ${entry.rejected!.map((r) => squash(r, 60)).join("; ")}]` `` (drop "waiting to revert: "), and its doc comment loses "still waiting on the revert". In src/review/post-merge-review.ts, the `PostReview.rejected` comment loses "and its revert has not been started yet (the revert slot was busy)", and the `POST_MERGE_REJECT_WARN` comment's "the pre-revert signal" becomes "the reviewer-fix signal". The `fixed`, `failing` and `waiting` branches are unchanged — part 1/6's `[fixed — the repair <sha> already merged on main]` already reads the fix.
- GUI twin: src/ui/gui/gui-client-pending.ts's hand-kept `postReviewStatusLabel` `rejected` branch takes the same text and its comments lose "still waiting on the revert".
- Accept: a rejected entry waits on nothing now, so it is acceptable. In src/review/post-merge-review-accept.ts, delete `removeAcceptedEntry`'s `if (entry.rejected) return { status: "rejected", commit: entry.commit };` guard and the `rejected` member of `AcceptPostReviewOutcome`, and reword the file's comments; in src/cli/cli-review-commands.ts, delete `cmdReviewsAccept`'s `outcome.status === "rejected"` branch and the doc-comment clause; in src/ui/tui/tui-pane-pending.ts, drop the "cannot be accepted until its revert runs — let the revert go, then review the revision" row line and the `outcome.status === "rejected"` flash branch; in src/gui/gui-operator-commands.ts, drop the `outcome.status === "rejected"` 409 branch and the comment naming it. In src/ui/gui/gui-client-pending.ts, the row's accept-button guard drops `!Array.isArray(e.rejected)` so a rejected row renders the two-click Accept like any pending row. The `fixed` guard (a landed repair is not acceptable) stays.
- Alert and payload: src/ui/team-alerts.ts's `post-merge-churn` comment block and detail string ("the pre-revert signal", "costs a revert and a re-author") say the rejection is answered by the reviewer's own fix and the remedy is to narrow `review.afterMerge`; src/ui/status-payload.ts's `postMergeChurnAlert` doc comment takes the same wording. The alert's key, tone, title, count and actions are unchanged.
- Docs: docs/how-it-works.md's post-merge-review bullet (a rejection "goes to the revert slot as above … back to its role as a revision") describes the reviewer's fix on top of main, and its "pre-revert signal" phrase takes the reviewer-fix wording; its red-main revert paragraphs stay for part 4/6. docs/cli.md's `tumwater reviews` clause, its `--accept` sentence and the Pending pane's `Ctrl+A` key row lose "waiting on its revert". docs/invariants.md is not touched (part 4/6). src/cli/help.ts's `tumwater reviews` stanza takes the same wording.

**Files touched.** src/review/post-merge-review-render.ts src/review/post-merge-review.ts src/ui/gui/gui-client-pending.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/gui/gui-operator-commands.ts src/ui/team-alerts.ts src/ui/status-payload.ts docs/how-it-works.md docs/cli.md test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts test/team-alerts.test.ts test/status-payload.test.ts

**Acceptance criteria.**
- `postReviewStatusLabel` and its GUI twin render `[rejected — <reasons>]`; no source file under src/ says a rejected post-merge review is waiting for a revert, and docs/how-it-works.md and docs/cli.md carry the recorded-finding wording.
- `tumwater reviews --accept <n>` on a rejected entry retires it like any pending entry (logs the accepted-unreviewed warning and drops it); `--accept` on a `fixed` entry still fails with "already merged its fix on main".
- The `post-merge-churn` alert's key, tone, title, count and actions are unchanged; only its detail and comment wording move off the revert.
- `npm run test:gate` passes.

**Tests.**
- test/cli-reviews.test.ts: the list assertions read `[rejected — <reasons>]`; the accept-on-rejected case now asserts acceptance (the entry leaves the queue and the warning logs).
- test/tui-keys.test.ts: a rejected row no longer prints the "cannot be accepted until its revert runs" line, and Ctrl+A on it now retires the entry.
- test/gui-client-pending.test.ts: the rejected label assertion takes the new text, and the row renders an Accept button for a rejected entry.
- test/gui-post-review-accept.test.ts: the accept-on-rejected case now answers 200 `accepted` and removes the entry.
- test/team-alerts.test.ts and test/status-payload.test.ts: pin the new churn detail text, asserting no "revert".

### Forward, never back, part 4/6: the revert subsystem is deleted — no `main_revert` is emitted and a red main is healed forward (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 3b/6 landed, since every surface must read the forward finding before the backward readers go; parts 5/6–6/6 then delete every reader of the historical events this part stops writing; touches src/baseline/main-revert.ts (deleted) src/baseline/main-red.ts src/baseline/main-watch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator.ts src/runner/revision.ts docs/invariants.md docs/how-it-works.md test/main-revert.test.ts (deleted) test/operator-revert.test.ts)

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

### Every commit is verified on main, part 3a/3: the red-main authoring block comes off — a code role authors on a red main and the `ci` healer is handed the failing tests (planned 2026-10-24 by the operator, split from the held part 3/3; rewritten 2026-10-24 by the plan role to answer the convergence hold's stale-wording and archive-list objections; the pre-merge blocks themselves come off in parts 3g/3–3j/3 and 3d/3–3f/3 below; touches src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts src/prompt/gate-notes.ts src/runner/model-fallback.ts src/runner/runner-fallback.ts src/baseline/main-baseline.ts src/doctor/doctor-holds.ts src/config/config.ts src/cli/cli-start.ts src/ui/status-model.ts src/build/build-check-report.ts src/run/run-prompt.ts docs/how-it-works.md docs/invariants.md test/main-red.test.ts test/main-red-heal.test.ts test/runner-red-main.test.ts test/roles.test.ts test/runner-ids.test.ts test/main-baseline.test.ts test/runner-2.test.ts test/runner-prompt-requeue.test.ts test/status-render-cells.test.ts test/gate-notes.test.ts test/build-check.test.ts)

**Previously held 2**

**Goal.** Main's redness stops blocking authoring. `mainRedGate` (src/baseline/main-red.ts) and `baselineBlocked`/`BASELINE_BLOCKED_ROLES` (src/roles/roles.ts) exist only to keep a code role from spending an authoring run whose diff the pre-merge check would reject; with the pre-merge blocks coming off (parts 3g/3–3j/3 and 3d/3–3f/3) nothing is left to reject it, so the block only stalls every code role while main is red. The surviving information is the `ci` healer's hand-off (`mainRedHealNote`, `mainRedHealPrompt`) naming the failing tests and their owner, and the watch's and `main red` label's report of an unheld red. A code role no longer gets a `<main-known-red>` note: the gate that built it is gone.

**Approach.**
- Delete `mainRedGate` (src/baseline/main-red.ts) and its call in `runner-run.ts` (the `blocked` branch that reads `mainRedGate(ctx.root, ctx.role, wt, undefined, …)`), so a code role's run on a red main proceeds. Keep `mainRedHealNote`, `mainRedHealPrompt`, `queueCulpritHeal` and `baselineCheckLogger` — the healer hand-off the watch and the `ci` plan read.
- Delete `buildMainKnownRedNote` (src/prompt/gate-notes.ts) and its `test/gate-notes.test.ts` cases: its only caller is the gate's `onKnownRed` path in `runner-run.ts`, which goes with the branch. Drop `runner-run.ts`'s `knownRed` accumulation and the import.
- Delete `baselineBlocked` and `BASELINE_BLOCKED_ROLES` (src/roles/roles.ts) and every reader; `DEFERRABLE_ROLES` and `OBSERVER_ROLES` (which keeps `ci`) stay, so the healer still schedules while main is red.
- Leave `heldByMainRed` (src/status/status-polls.ts), the status phase's `main red` label and the doctor's `main red` row in place: a kept `main_red` merge pin still ends a run `main_red` until part 3f/3 removes it, so the row still has a producer. Only reword `checkMainRed`'s doc comment to drop the `(mainRedGate)` citation and the gate-guardrail phrase.
- Refresh every live reference to the removed block, in the same commit. The reviewer named those that call a run that "never invoked pi" `a red-main block` — src/runner/model-fallback.ts and src/runner/runner-fallback.ts — and test/runner-2.test.ts's "The red-main baseline block now lives in runner-red-main.test.ts" plus test/main-baseline.test.ts's "the red-main gate's one-shot" comment and its "the configured command's failure blocks authoring" assertion. The same class reaches src/baseline/main-red.ts (the `mainRedGate` exempts/warns comments), src/runner/runner-run.ts (the `baseRole` comment and the "pristine main for the red-main gate" note), src/baseline/main-baseline.ts's section header and "main-red.ts's gate consumes it", src/doctor/doctor-holds.ts, src/config/config.ts's `liveConfig` reader list, src/cli/cli-start.ts's `persistBaselineVerdicts` comment, src/ui/status-model.ts's stale-`main red` comment, src/build/build-check-report.ts's consumer list, src/run/run-prompt.ts's requeue comment, and the "red-main gate" comments in test/runner-prompt-requeue.test.ts, test/status-render-cells.test.ts, test/main-red.test.ts, test/merge-to-main-recheck.test.ts and test/build-check.test.ts. In src/prompt/gate-notes.ts change only the "a red main blocks every other code role" clause; its pre-merge "the gate's deterministic pre-check rejects any change that leaves the suite red" clause stays for parts 3g/3–3j/3 and 3d/3–3f/3.
- docs/how-it-works.md: the red-main paragraph (the "code roles' prompts carry a `<main-known-red>` note … only when the failure names no test … do code-producing roles pause authoring" sentence) now says every role keeps working on a red main and the `ci` healer is handed the failing tests; the merge paragraph's "the red-main gate, the ci note read the watch's verdict" sentence names the surviving readers.
- docs/invariants.md, in the same commit: retire the `baselineBlocked` guarantee, drop `mainRedGate` from the `main_red_hold` guarantee (INV-AZ1) and the `warnMainRedOnce` guarantee, and re-point or drop their `test/main-red.test.ts` "mainRedGate …" pins to the surviving `mainRedHealNote`/`mainTipVerdict` cases.

**Files touched.** src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts src/prompt/gate-notes.ts src/runner/model-fallback.ts src/runner/runner-fallback.ts src/baseline/main-baseline.ts src/doctor/doctor-holds.ts src/config/config.ts src/cli/cli-start.ts src/ui/status-model.ts src/build/build-check-report.ts src/run/run-prompt.ts docs/how-it-works.md docs/invariants.md test/main-red.test.ts test/main-red-heal.test.ts test/runner-red-main.test.ts test/roles.test.ts test/runner-ids.test.ts test/main-baseline.test.ts test/runner-2.test.ts test/runner-prompt-requeue.test.ts test/status-render-cells.test.ts test/gate-notes.test.ts test/build-check.test.ts

**Acceptance criteria.**
- A code role's run on a red main proceeds and ends on its own outcome — never `main_red` — and no `<main-known-red>` note is appended; `mainRedGate`, `baselineBlocked`, `BASELINE_BLOCKED_ROLES` and `buildMainKnownRedNote` no longer exist.
- The `ci` healer's hand-off is unchanged: `mainRedHealNote`/`mainRedHealPrompt` still name the failing tests for a red main, and `warnMainRedOnce` still logs one `main_red_hold` per red SHA.
- No live source or test line presents the removed authoring block as a path: `grep -rn 'mainRedGate\|baselineBlocked\|BASELINE_BLOCKED_ROLES\|red-main block\|red-main gate\|main-red gate' src test` returns nothing.
- The change is confined to the removal and this refresh: every file the landing commit edits is on the Files-touched list, and the feature run's PLANS-DONE entry lists them all (the archive-consistency objection).
- `npm run test:gate` passes.

**Tests.**
- test/main-red.test.ts and test/main-red-heal.test.ts: drop the `mainRedGate` cases (the gate no longer exists) and assert `mainRedHealNote` still names the failing tests for the `ci` healer on a red main.
- test/runner-red-main.test.ts: fold the blocked-role and exempt-role cases into one `a code role authors while main is red` case (pi runs, the run ends on its own outcome, no `main_red`); drop the gate-only green-passes, unverifiable-blocks and re-checks-new-SHA cases; keep the `ci` healer's fresh-prompt case.
- test/runner-prompt-requeue.test.ts: drop the red-gate prompt-survival case, keeping the failed-resume and post-dequeue-crash cases.
- test/roles.test.ts and test/runner-ids.test.ts: drop the `BASELINE_BLOCKED_ROLES`/`baselineBlocked` cases; keep the catalog and `OBSERVER_ROLES` checks.
- test/gate-notes.test.ts: drop the `buildMainKnownRedNote` cases; keep the `buildMainRedNote` cases.

**Needs review 2026-10-24 by feature: could not converge — The change is not what its record claims. The commit body/`RISK` says "Comment only — no behavior change," but the diff removes the entire red-main authoring block — `mainRedGate`, `baselineBlocked`/`BASELINE_BLOCKED_ROLES`, `buildMainKnownRedNote`, and `runner-run.ts`'s gate/requeue branch — which…; `src/baseline/main-baseline.ts:31-32` still says the module "checks MAIN ITSELF — once per SHA, team-wide — before an authoring run is spent on top of it," then two lines later says "a code role still authors on top of it." With the gate gone, no baseline check precedes a non-`ci` authoring run, so…; `src/runner/runner-run.ts:572` (new comment) cites "parts 3c/3–3f/3" for the parts that remove the pre-merge blocks, but 3c/3 no longer exists (it was split into 3g–3j); the plan's own corrected citation is "parts 3g/3–3j/3 and 3d/3–3f/3" (PLANS-DONE 3a, docs/how-it-works). The stale string that a…**

### Every commit is verified on main, part 3g/3: every merged commit queues a post-landing review, whatever its role (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; independent of the other parts in files; touches src/merge/merge-drain.ts test/merge-drain.test.ts test/post-merge-review.test.ts)

**Previously held 3**

**Goal.** The post-landing review stops being a `review.afterMerge`-only path: a merge queues a review for the commit it landed whatever role produced it, so being reviewed becomes a property of every change rather than of a role list. This is the bridge that lets part 3h/3 remove the pre-merge model reviewer without leaving a role unreviewed.

**Approach.**
- In `postReviewDue` (src/merge/merge-drain.ts) drop the `!isAfterMergeRole(config, role)` test and the `role` parameter it alone used: keep the `config.review.enabled` gate and the exempt-diff test (`treeDiffFiles` + `isExemptDiff`), so a `"changed"` merge with review on and a non-exempt diff queues a `PostReview` via `addPostReview` in `settleOne`. The role still rides the queued entry.
- `reviewMergedCommit` (src/review/post-merge-review.ts) already reviews any entry with no role test, so it needs no change here.
- Reword merge-drain.ts's `postReviewDue` doc and the `settleOne` comment from the `review.afterMerge` role's review to every merged role.

**Files touched.** src/merge/merge-drain.ts test/merge-drain.test.ts test/post-merge-review.test.ts

**Acceptance criteria.**
- A `"changed"` merge from a role absent from `review.afterMerge` queues a `PostReview` entry for its commit; an exempt-only diff queues none, and with `review.enabled` false none queues.
- `npm run test:gate` passes.

**Tests.**
- test/merge-drain.test.ts: `every merged role queues a post-landing review` — a `"changed"` merge from a role not in `review.afterMerge` lands a `PostReview` entry; an exempt-only diff queues none.
- test/post-merge-review.test.ts: the existing post-review cases still pass for a role absent from `review.afterMerge`.

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer — only a secret leak, a brief-block edit or a protected edit refuses a diff (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3g/3 landed, since a role not on `review.afterMerge` must have its post-landing review queued before its pre-merge model review goes; touches src/review/review.ts src/review/diff-rules.ts docs/how-it-works.md test/review.test.ts)

**Previously held 3**

**Goal.** `reviewAheadOfMain` (src/review/review.ts) stops running the pre-merge model reviewer: after the deterministic diff rules, the exempt check and the build pre-check it approves, so every merged change is judged once, by the post-landing review (part 3g/3). The pre-merge rejection set shrinks to the findings a later commit cannot repair: a leaked credential (`secretLeakReason`), a brief-block edit (`briefEditReason`) and a protected edit (`protectedEditReason`). A conflict marker, a false fix claim and a broken backlog structure no longer refuse here — the main watch still reports them on main's tip.

**Approach.**
- `diffRuleReasons` (src/review/diff-rules.ts) gains an explicit gate scope — an `only` set of rule names, or a sibling `gateRejectReasons` — so the gate runs only the brief-edit, protected-edit and secret-leak rules while the watch keeps running all five in the shared order. One call site states the ordering, so the two consumers cannot drift.
- `reviewAttempt` (src/review/review.ts) uses that scope for its `reject` list and, when no rule fires, returns `{ decision: "approved" }` with `state.lastApprovedHead = head` and `retry.pre.verifiedHead` — the branch a `review.afterMerge` role takes today. The `afterMerge`/`patchApproved` split disappears, and the now-dead `runReviewer` call and reviewer-only retry plumbing go with it, adjusting imports so `tsc` passes and leaving review-run.ts/review-followup.ts compiling and unreferenced for part 3e/3. The exempt path and the `gateBuildPrecheck` build pre-check are unchanged.
- The reviewer resume state `reviewAttempt` no longer reads is left for part 3e/3 to delete; this part removes only what `noUnusedLocals` would reject.
- docs/how-it-works.md: the review paragraph (the `review.afterMerge` role's separate path at its "A role listed in `review.afterMerge` is reviewed after merging" sentence) says one review runs after every landing and the pre-merge gate is deterministic.

**Files touched.** src/review/review.ts src/review/diff-rules.ts docs/how-it-works.md test/review.test.ts

**Acceptance criteria.**
- `reviewAheadOfMain` starts no pi reviewer run; a diff with a secret leak, a brief-block edit or a protected edit is still rejected with that reason, and a diff with a conflict marker, a false fix claim or a broken backlog structure approves instead.
- The exempt path and the build pre-check are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/review.test.ts: `only a secret leak and a protected edit refuse a pre-merge diff` — a leaked credential, a brief-block edit and a protected edit end `review_rejected` with their reason; a conflict marker, a false fix claim and a broken backlog structure approve with no reviewer run.
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

### The TUI's Activity view edits `maxConcurrentChecks` with `Ctrl+K` on an empty prompt, the terminal twin of the dashboard Settings `Max concurrent checks` field and `tumwater config set maxConcurrentChecks` (planned 2026-10-24 by the plan role; independent of every eligible plan — the `Forward, never back` parts edit src/review, src/merge, src/verdict, src/runner, src/prompt, src/report and src/ui/tui/tui-pane-pending.ts, the `Every commit is verified on main` parts edit src/baseline, src/merge, src/config, src/orchestrator, src/runner, src/status/status-polls.ts and src/ui/status-model.ts, the `ci` parity plan edits src/run/ci-parity.ts, src/doctor/doctor-project-checks.ts and src/ui/team-alerts.ts, and the in-flight `no-check` plan edits src/status/status-data.ts, src/ui/team-alerts.ts and src/ui/status-payload.ts. None of them edits any src/ui/tui/tui-editor-*.ts, tui-editor-config.ts, tui-editor-session.ts, tui-editors.ts, tui-keys.ts or tui-frame.ts; the only shared files are docs/cli.md and test/tui-keys.test.ts, which the `Forward, never back` part 3b/6 and the blocked post-merge-rejection part 3/3 also edit in neighbouring rows/cases, so whichever lands second rebases there; touches src/ui/tui/tui-editor-checks.ts (new) src/ui/tui/tui-editor-config.ts src/ui/tui/tui-editor-session.ts src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/tui/tui.tsx docs/cli.md test/tui-keys.test.ts)

**Goal.** `maxConcurrentChecks` — the cap on concurrent project-check runs that `tumwater doctor`'s `check contention` row names as the knob to raise — is in `EDITABLE_CONFIG_KEYS` and the dashboard's `SETTINGS_KEYS` (`Max concurrent checks`) and writable through `tumwater config set maxConcurrentChecks`, but the TUI cannot edit it: `grep -rn maxConcurrentChecks src/ui/tui` finds nothing, and `createTuiEditors` (src/ui/tui/tui-editors.ts) wires an editor for every other team key in `EDITABLE_CONFIG_KEYS` except the legacy `provider` (budget, model, fallback, run cap, provider caps, slots, claude reserve, quiet, notify, backends). Add the last one. Every plain Ctrl+letter is taken (a–g, k, l, n, o, p, q, r, s, t, u, v, w, x, y), and ink's key bridge maps Ctrl+H to `backspace`, Ctrl+I to `tab`, Ctrl+J to `enter` and Ctrl+M to `return` (node_modules/ink/build/parse-keypress.js), so the only remaining usable letter is Ctrl+Z, which reads as undo/suspend. Reuse `Ctrl+K` instead: on the Activity view it currently only reaches the prompt line's readline kill-line, and the Health pane already reuses `Ctrl+K` with the exact guard this editor needs (`promptLineFree(ctx.es) && (ctx.es.input ?? "") === ""`, src/ui/tui/tui-pane-health.ts). The editor opens only while the prompt line is empty; with text typed, Ctrl+K still kills from the cursor to the line end.

**Approach.**
- `src/ui/tui/tui-editor-checks.ts` (new): `createChecksEditor(session: TuiEditorSession): TuiEditorModule`, a thin call to `createTeamConfigKeyEditor` like `createConcurrencyEditor` (src/ui/tui/tui-editor-concurrency.ts), with `mode: "checks"`, `openCtrl: "k"`, `configKey: "maxConcurrentChecks"`, `plainIntegerKey: true`, the new `requireEmptyPrompt: true`, `prefill: (s) => String(loadConfigSafe(s.root).config?.maxConcurrentChecks ?? "")` (the configured value, so an unset key prefills empty and reads as the default 2 — src/config/config.ts), `openFlash: "edit the team's check cap (maxConcurrentChecks, an integer ≥ 1; empty restores the default): Enter to save, Esc to cancel"`, `clearedFlash: "max concurrent checks reset to the default"`, `setFlash: (text) => \`max concurrent checks set to ${text}\``. `setConfigKey`/`unsetConfigKey` carry the write, so `validateConfig`'s `checkNumber(r, "", "maxConcurrentChecks", POSITIVE_INTEGER)` owns the value's truth: `0` or a non-number flashes and the editor stays open with the file untouched, as the run-cap editor does.
- `src/ui/tui/tui-editor-config.ts`: add `"checks"` to `TeamConfigKeySpec.mode`'s union and an optional `requireEmptyPrompt?: true` to the spec. In `handleKey`'s open arm, after `if (ctx.view !== 0) return false;` and after `if (session.editorEntryDenied(spec.mode)) return true;`, insert `if (spec.requireEmptyPrompt && session.input !== "") return false;` before `takeDraft()`; the key then falls through to `applyKey`'s kill-line. The toggle-out, Esc and Enter arms are unchanged, so Ctrl+K (or Ctrl+T, or Esc) still closes the open editor and restores the draft. No existing spec sets the flag, so their behavior is unchanged.
- `src/ui/tui/tui-editor-session.ts`: add `checks: boolean` to the `TuiHeld` interface (doc: the Activity view's Ctrl+K check-cap editor) and initialize it `false`; add `"checks"` to the `EditorEnterKey` union; add `["checks", "check cap edit"]` to `HOLDER_SUBJECTS`, which `anyEditorHeld` and `heldEditorFlash` both walk, so the busy guard names it with no separate clause.
- `src/ui/tui/tui-editors.ts`: import `createChecksEditor`; add `createChecksEditor(session)` to the `editors` array after `createConcurrencyEditor(session)`; add `checksMode: boolean` to `TuiEditorState` and `checksMode: session.held.checks` to `state()` beside `concurrencyMode`; add `!session.held.checks` to the `onArrow` no-editor condition so Up/Down cannot recall prompt history into the check-cap text.
- `src/ui/tui/tui-keys.ts`: add `checksMode: boolean` to `TuiKeysState` beside `concurrencyMode`; it arrives through the existing `...editors.state()` spread in `state()`.
- `src/ui/tui/tui-frame.ts`: add `checksMode?: boolean` to the `hintLine` and `promptPrefix` mode types, a `keys = [["Enter", "save the check cap"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]` branch after the `concurrencyMode` branch in `hintLine`, and a `check cap › ` prefix after the `run cap › ` one in `promptPrefix`.
- `src/ui/tui/tui.tsx`: add `checksMode: s.checksMode` to the `mode` object passed to the frame's hint/prefix helpers, beside `concurrencyMode`.
- `docs/cli.md`: the TUI-keys table gains the Activity meaning on its `Ctrl+K` row — edit the team's check cap on an empty prompt line; with text it still kills from the cursor to the line end — naming the dashboard Settings `Max concurrent checks` field and `tumwater config set maxConcurrentChecks`; the Health kill-orphans meaning stays.

**Files touched.** src/ui/tui/tui-editor-checks.ts (new) src/ui/tui/tui-editor-config.ts src/ui/tui/tui-editor-session.ts src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/tui/tui.tsx docs/cli.md test/tui-keys.test.ts

**Acceptance criteria.**
- On the Activity view (view 0) with an empty prompt line, Ctrl+K opens the check-cap editor pre-filled with the file's `maxConcurrentChecks` (empty when unset); Enter with `4` runs `setConfigKey(root, "maxConcurrentChecks", "4")` and flashes `max concurrent checks set to 4`; Enter with an empty line runs `unsetConfigKey` and flashes `max concurrent checks reset to the default`; Enter with `0` or `2e0` flashes the refusal and stays open with the file untouched; Esc, Ctrl+K again and Ctrl+T close it and restore the saved prompt draft.
- Ctrl+K with a non-empty prompt line still deletes from the cursor to the line end (the editor returns false so `applyKey` runs), and Ctrl+K on any other view keeps its current meaning, including the Health pane's orphan kill.
- The busy guard is unchanged for every other editor, and a second Ctrl+K while the check-cap editor is open closes it rather than flashing.
- While the editor is open the hint line reads `Enter save the check cap · Esc cancel` and the prompt prefix reads `check cap › `.
- The check-cap editor is the only TUI editor for `maxConcurrentChecks` and it writes through the same `setConfigKey`/`unsetConfigKey` path the dashboard Settings field and `tumwater config set` use, so all three surfaces cannot disagree on the value's validity.
- `npm run test:gate` passes.

**Tests.**
- test/tui-keys.test.ts, modeled on the run-cap editor's cases: `Ctrl+K on the Activity view opens the check-cap editor and Enter writes maxConcurrentChecks` (a greenfield root, an empty prompt, Ctrl+K, type `4`, Enter → `loadConfigSafe(root).config?.maxConcurrentChecks === 4` and the `max concurrent checks set to 4` flash); `the check-cap editor refuses an invalid value and stays open` (`0` and `2e0` each leave the file untouched and the editor open); `Ctrl+K with a typed prompt still kills the line instead of opening the editor` (input `abc`, Ctrl+K → input `""`, no flash, no editor); `Ctrl+K closes the check-cap editor` (open, Ctrl+K again → closed, the saved draft restored).
- The existing doc-letter test (test/tui-keys-doc.test.ts) needs no new letter — Ctrl+K is already in the handled set — and the updated `docs/cli.md` `Ctrl+K` row keeps the table and the handled set in agreement.

## Done
