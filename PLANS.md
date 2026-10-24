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

### The failure digest marks the rejections that already landed — a post-merge review rejection — so `tumwater report --failures` names the costly class that starts a revert (planned 2026-10-23 by the plan role; independent of every eligible plan — the in-flight `tumwater history` revert-reason plan edits src/run/run-detail-data.ts, src/run/run-detail-render.ts, docs/cli.md and test/run-detail*.test.ts, and the time-spend plan edits src/failure/time-spend.ts, docs/invariants.md and test/failure-time-spend.test.ts; this edits src/failure/failure-data.ts, src/failure/failure-render.ts, docs/cli.md and test/failure-render.test.ts, so it shares only docs/cli.md, in the `tumwater report --failures` clause, a different row from the history plan's "Watch run history" row, and touches none of src/failure/time-spend.ts)

**Goal.** The failure digest's rejection view (`data.rejections`, a `ClusterSection` built in `assembleFailureReport`, src/failure/failure-data.ts) clusters every `review_rejected` by (role, `firstReason(reasons)`) with no regard to `afterMerge`, so a post-merge rejection — one the reviewer returned after the commit had already reached main, the costly kind that starts a revert and a re-author — is indistinguishable from a pre-merge one the gate caught in time. `tumwater report` has the `Post-merge rejections by role` table (src/report/report-fold.ts `postMergeRejectionsByRole`) and the day surfaces have the `post-merge-churn` alert (src/ui/team-alerts.ts), but the digest — the operator's failure-analysis view and the selfcheck role's evidence — shows neither a count nor a marker. After this plan the digest's rejection clusters name their post-merge rows and the digest states how many of the window's rejections were post-merge.

**Approach.**
- src/failure/failure-data.ts, `FailureReportData`: add `postMergeRejections: number;` doc-commented as the window's `review_rejected` events with `afterMerge: true` (counted before any cluster filter, so it equals the subset `tumwater report`'s `postMergeRejectionsByRole` sums and the `post-merge-churn` alert counts).
- In `assembleFailureReport`'s rejections block, prefix the message of an already-landed rejection so it clusters apart from a same-reason pre-merge one and the row names the class: `message: ev.afterMerge === true ? \`post-merge rejection: ${firstReason(reasons)}\` : firstReason(reasons)`. Keep the `keyPrefix` on role (the message difference already splits the keys). Update the block's comment ("Rejections cluster on (role, reasons[0])") to name the post-merge split. Compute `const postMergeRejections = rejectedEvents.filter((ev) => ev.afterMerge === true).length;` beside `rejectedEvents` and add `postMergeRejections,` to the returned object (`ev.afterMerge === true` is the same test src/report/report-fold.ts uses, so the digest count and the report table cannot disagree).
- src/failure/failure-render.ts, `renderFailureMarkdown`: after `renderClusters(lines, "Top rejection clusters", data.rejections, "rejections")`, when `data.postMergeRejections > 0` push one line `` _${plural(data.postMergeRejections, "post-merge rejection", "post-merge rejections")} — the commit already reached main, so each starts a revert and a re-author_ `` (`plural` is already imported from ../text/phrases.js). The line names the window's true total even when the top-N cluster cut hides some rows.
- docs/cli.md, the `tumwater report --failures` clause: add "and its rejection clusters mark the already-landed commits a post-merge review turned back (with the window's post-merge rejection count)".

**Files touched.** src/failure/failure-data.ts src/failure/failure-render.ts docs/cli.md test/failure-render.test.ts

**Acceptance criteria.**
- `collectFailureReport`/`collectFailureReportSince` return `postMergeRejections` equal to the number of the window's `review_rejected` events with `afterMerge: true` (including ones with no `reasons`), and `0` when none; both collectors share `assembleFailureReport`, so one field fills both.
- Two `review_rejected` events from the same role with the same `reasons[0]`, one `afterMerge: true` and one without, form two clusters in `data.rejections.clusters`; the post-merge cluster's `example` starts `post-merge rejection: `; `data.rejections.total` still counts every `review_rejected` (reasons or not, post-merge or not), so it still equals the Deltas column's sum.
- `renderFailureMarkdown` prints the post-merge count line only when `postMergeRejections > 0`, and an afterMerge rejection's cluster row carries the `post-merge rejection: ` marker; a window with only pre-merge rejections renders exactly as before (no line, no marker).
- `npm run test:gate` passes.

**Tests.**
- test/failure-render.test.ts: add `the digest marks post-merge rejections and counts them` beside "review rejections cluster on (role, reasons[0]), not role alone": seed a root with two `review_rejected` events for `bugfix` sharing `reasons: ["half done"]`, one `afterMerge: true` and one without, plus one `afterMerge: true` with no `reasons` field; `collectFailureReport(root, …)`; assert `data.postMergeRejections === 2`, the two reasons-bearing rejections are two clusters with the post-merge one's example `post-merge rejection: half done`, `data.rejections.clusters` totals 2 and `data.rejections.total === 3`; assert `renderFailureMarkdown(data)` matches `/post-merge rejections/` and `/post-merge rejection: half done/`. A second root with no `afterMerge` event asserts `postMergeRejections === 0` and that the rendered markdown has no `/post-merge/` line.

## Done
