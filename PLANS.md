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

### `tumwater history <role> <n>` names why a merged change was reverted — a red main's check vs a post-merge review rejection — on the CLI, the TUI History trail and the dashboard drill-down (planned 2026-10-23 by the plan role; independent of every eligible plan — the three in-flight review plans edit src/review, src/merge/merge-post-review.ts, src/gui, src/ui/gui, src/ui/tui/tui-pane-pending.ts, src/ui/status-payload.ts, src/ui/team-alerts.ts, src/ui/status-render.ts, src/ui/tui/tui.tsx plus docs/cli.md, docs/how-it-works.md and docs/invariants.md; this touches none of those and shares docs/cli.md only in the `tumwater history` clause of the "Watch run history" row, a different region from the review and TUI-keys clauses they edit; touches src/run/run-detail-data.ts src/run/run-detail-render.ts docs/cli.md test/run-detail-data.test.ts test/run-detail.test.ts)

**Goal.** A `main_revert` event already carries `reason: "main-red" | "post-review"` (src/events/events.ts; written at src/baseline/main-revert.ts as `reason: c.postReview ? "post-review" : "main-red"`, and events written before the field default to `main-red`). `RunDetail.reverted` (src/run/run-detail-data.ts, `revertedOf`) drops it, keeping only `kind: "main" | "operator"`, so `renderRunDetail`'s header (src/run/run-detail-render.ts) prints `reverted <sha> (failing: <test>)` for a red-main revert and the bare `reverted <sha>` for a post-merge rejection (whose `failingTests` is empty) — the operator reading a run's trail cannot tell an intended post-merge rejection from a red main. After the 2026-10-23 reason split, name the cause on every surface that renders the trail (`tumwater history <role> <n>`, the TUI History Ctrl+N trail, and the dashboard History drill-down — all three read the one `renderRunDetail`).

**Approach.**
- src/run/run-detail-data.ts: make `RunDetail.reverted` a discriminated union `{ kind: "main"; reason: "main-red" | "post-review"; sha: string; revert: string; failingTests: string[] } | { kind: "operator"; sha: string; revert: string; failingTests: string[] } | null` and update its doc comment to name the reason. In `revertedOf`, on the `main_revert` branch add `reason: e.reason === "post-review" ? "post-review" : "main-red"` (an absent, older or unknown `reason` reads as `main-red`, the events.ts contract — `e.reason` is `unknown` through the event index signature, like `e.failingTests`); the `operator_revert` branch is unchanged. No other read changes.
- src/run/run-detail-render.ts, `renderRunDetail`'s header: replace the `d.reverted.kind === "main"` failing-tests branch with `if (d.reverted.reason === "post-review") header += " (post-merge review rejection)"; else if (d.reverted.failingTests[0] !== undefined) header += \` (failing: ${d.reverted.failingTests[0]})\`; else header += " (main's check failed)";`. The operator branch stays `(by operator)`. So a main revert always names a cause: its first failing test, `main's check failed` when the red named none, or `post-merge review rejection`.
- docs/cli.md, the "Watch run history" row's revert clause: after `adds \`reverted <sha> (failing: <test>)\`, naming the culprit sha and its first failing test` add `(a revert a post-merge review caused reads \`(post-merge review rejection)\`, and one whose red named no test \`(main's check failed)\`)`.
- No change to src/events, src/baseline, src/merge, the TUI or the GUI: the TUI History pane calls `renderRunDetail` (src/ui/tui/tui-pane-history.ts) and `GET /api/run` pre-renders it through `renderRunDetail` (src/gui/gui-history-endpoints.ts), so both surfaces follow with no edits, and the CLI is the third. An implementation that finds itself editing those has gone off-plan.

**Acceptance criteria.**
- `tumwater history <role> <n>`'s header for a run whose landed change a `main_revert` with `reason: "post-review"` names ends `· reverted <short> (post-merge review rejection)`; the same header for a `main_revert` with `reason: "main-red"` and `failingTests: ["a.test.ts"]` ends `(failing: a.test.ts)`; for one with `reason: "main-red"` and no `failingTests` ends `(main's check failed)`; a `main_revert` with no `reason` field (an older event) reads as `main-red`.
- An `operator_revert` still reads `(by operator)`, and a run with no revert still ends `· commit <short>` with no `reverted` clause.
- `RunDetail.reverted` carries the `reason` for a main revert, and `failingTests` for both kinds; the GUI's `/api/run` (the pre-rendered `renderRunDetail` text) and the TUI History trail show the same header the CLI prints, because all three read the one `renderRunDetail`.
- `npm run test:gate` passes.

**Tests.**
- test/run-detail-data.test.ts: in "a run's main_revert names the automatic revert of its landed sha", add `reason: "post-review"` to the seeded `main_revert` event and its `deepEqual` expectation; add a seeded window whose `main_revert` omits `reason` and assert `readRunDetail(root, "feature", 1)!.reverted` has `reason: "main-red"` (the default). In "a no-op fast-forward run matches its main_revert through the pinned commit", add the `reason` field the seeded event carries to the expectation.
- test/run-detail.test.ts, "renderRunDetail names a reverted change and its first failing test": add `reason: "main-red"` to the existing failing-test case; add a case `header({ reverted: { kind: "main", reason: "post-review", sha: "abcdef1234", revert: "9999999", failingTests: [] } })` matching `/ · reverted abcdef12 \(post-merge review rejection\)$/m`; add a case `reason: "main-red"` with `failingTests: []` matching `/ \(main's check failed\)$/m`; keep the operator and null cases and their expectations.

## Done
