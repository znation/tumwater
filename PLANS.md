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

### `tumwater doctor` gains a `post-merge churn` row, the audit twin of the amber `post-merge-churn` alert: the CLI audit names the roles whose already-merged commits the reviewer turned back, so a churn day can no longer make `tumwater doctor` report a false all-clear on main's check (planned 2026-10-23 by the plan role; independent of every eligible plan — the in-flight `tumwater history` revert-reason plan edits src/run/run-detail-data.ts, src/run/run-detail-render.ts, docs/cli.md and test/run-detail*.test.ts, the time-spend plan edits src/failure/time-spend.ts, docs/invariants.md and test/failure-time-spend.test.ts, and the failure-digest plan edits src/failure/failure-data.ts, src/failure/failure-render.ts, docs/cli.md and test/failure-render.test.ts; this touches none of those and shares docs/how-it-works.md with no waiting entry; touches src/review/post-merge-review.ts src/ui/status-payload.ts src/doctor/doctor-project-checks.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts docs/how-it-works.md test/doctor-checks.test.ts test/doctor.test.ts)

**Goal.** A post-merge rejection — a `review_rejected` event with `afterMerge: true`, written by `reviewMergedCommit` (src/review/post-merge-review.ts) — is an already-landed commit the reviewer turned back, the costly kind that starts a revert and a re-author. The always-on `post-merge-churn` amber alert fires when a trailing day holds at least `POST_MERGE_REJECT_WARN` (2) of them and names each role (src/ui/status-payload.ts `postMergeChurnAlert`, the block in src/ui/team-alerts.ts), but it renders only on the live dashboard/TUI/`tumwater status` surfaces. `tumwater doctor` has no row for it, and the row that audits main's reverts — `main's check` (`checkMainRed`, src/doctor/doctor-holds.ts) — reads `revertWarnings`/`revertGuardrail` (src/baseline/main-guardrails.ts), which deliberately count only `reason !== "post-review"`. So on a day of six post-merge rejections the doctor prints `no role waiting on main's check`: a false all-clear on the very cost the `review.afterMerge` tiering introduced. Give the doctor the audit twin, sharing the alert's window, threshold and event selection so the two cannot disagree on when churn fires.

**Approach.**
- src/review/post-merge-review.ts: move `POST_MERGE_REJECT_WINDOW_MS` here from src/ui/status-payload.ts (beside `POST_MERGE_REJECT_WARN`), doc-commented as the 24 h window the churn rule reads. Add the one home of the trigger and selection: `export function postMergeChurn(events: readonly HarnessEvent[]): { count: number; roles: readonly PostMergeRejection[] } | null` — `const roles = postMergeRejectionCounts(events); const count = roles.reduce((n, r) => n + r.count, 0); return count >= POST_MERGE_REJECT_WARN ? { count, roles } : null;`.
- src/ui/status-payload.ts: import `POST_MERGE_REJECT_WINDOW_MS` and `postMergeChurn`; reduce `postMergeChurnAlert`'s body to `const events = eventsSince(root, POST_MERGE_REJECT_WINDOW_MS, now, (e) => e.type === "review_rejected"); return postMergeChurn(events);` inside its existing `try`; re-export the constant (`export { POST_MERGE_REJECT_WINDOW_MS };`) so test/status-payload.test.ts's import keeps working. `PostMergeChurn` and the alert's behavior are unchanged.
- src/doctor/doctor-project-checks.ts: add `export function checkPostMergeChurn(root: string): CheckOutcome { const churn = postMergeChurn(readEventsSince(root, POST_MERGE_REJECT_WINDOW_MS).events); if (churn === null) return okOutcome("no post-merge rejection burst in the last day"); return warnOutcome(...); }`, modelling `checkFlakyChecks` beside it (ok/warn only — a churn burst does not stop the team); the warn detail is `` `${plural(churn.count, "post-merge review rejection")} in the last day (${churn.roles.map((r) => `${roleLabel(r.role)} ×${r.count}`).join(", ")}) — each commit had already landed, so each cost a revert and a re-author; narrow \`review.afterMerge\` for the noisy role or raise the authoring bar` ``. It imports `postMergeChurn`/`POST_MERGE_REJECT_WINDOW_MS` from ../review/post-merge-review.js and `roleLabel` from ../roles/role-labels.js.
- src/doctor/doctor.ts: register `{ name: "post-merge churn", run: () => checkPostMergeChurn(root) }` immediately after `flaky checks`; import it from ./doctor-project-checks.js.
- src/doctor/doctor-check-names.ts: add `"post-merge churn"` immediately after `"flaky checks"`.
- test/doctor.test.ts: add `"post-merge churn"` to the expected name list immediately after `"flaky checks"`.
- docs/how-it-works.md, the post-merge-review paragraph: after "Two or more post-merge rejections in a day raise one standing amber alert naming each role on the dashboard, the TUI and `tumwater status`", add "— and a matching `post-merge churn` doctor row names the same roles on `tumwater doctor`".
- No change to `postMergeRejectionCounts`, `POST_MERGE_REJECT_WARN`, the `post-merge-churn` alert's trigger/wording/window, or `checkMainRed`.

**Files touched.** src/review/post-merge-review.ts src/ui/status-payload.ts src/doctor/doctor-project-checks.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts docs/how-it-works.md test/doctor-checks.test.ts test/doctor.test.ts

**Acceptance criteria.**
- `tumwater doctor` prints a `post-merge churn` row: a trailing day holding at least `POST_MERGE_REJECT_WARN` `review_rejected` events with `afterMerge: true` makes it a warn naming each role with its count and `review.afterMerge`; a day with one such event, a day of only pre-merge `review_rejected` events, and a lone post-merge rejection 25 h old each make it ok.
- The doctor row and `postMergeChurnAlert` select the same events and fire on the same threshold: `postMergeRejectionCounts` stays the only place the `e.type === "review_rejected" && e.afterMerge === true` test lives, and `POST_MERGE_REJECT_WARN`/`POST_MERGE_REJECT_WINDOW_MS` (both exported from src/review/post-merge-review.ts) are the single threshold and window.
- `postMergeChurnAlert`'s existing behavior is unchanged, and test/status-payload.test.ts passes unedited.
- `checkMainRed`'s `main's check` row is unchanged: it stays ok on a post-review churn day (that separation is why this row is needed).
- `npm run test:gate` passes.

**Tests.**
- test/doctor-checks.test.ts: add `checkPostMergeChurn warns on a day's post-merge rejection burst and stays quiet below the bar` beside the `checkFlakyChecks` tests: seed a root's event log with two `review_rejected` events carrying `afterMerge: true` (one `bugfix`, one `clean`) written now, plus one `review_rejected` without `afterMerge` and one 25 h old with `afterMerge: true`; assert `checkPostMergeChurn(root)` is a warn whose detail names `bugfix`, `clean` and `review.afterMerge`; rewrite the log with a single post-merge rejection and assert `{ level: "ok", detail: "no post-merge rejection burst in the last day" }`.
- test/doctor.test.ts: the expected-name list gains `"post-merge churn"` after `"flaky checks"`.

## Done
