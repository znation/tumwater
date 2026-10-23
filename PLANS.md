# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Reviewer as a regular role, part 2/4: Post-merge review at fleet scale — the merge poll keeps up and the revert path holds under bugfix volume (planned 2026-10-23 by user; design in plans/reviewer-as-role.md "What lands" item 2 and "Risks"; requires part 1/4 landed; touches src/review/post-merge-review.ts src/merge/merge-slot.ts and their tests)

**Goal.** Post-merge review was built for three slow maintenance roles; part 1/4 moves bugfix's volume onto it. The merge poll's one-at-a-time when-a-permit-is-free cadence and the revert-after-merge path must hold: no unreviewed merged commit waits indefinitely, and a rejection of an already-archived entry does not strand the entry.

**Approach.**
- src/review/post-merge-review.ts: verify (and pin with a test) the review schedule under a sustained merge rate — the poll picks the oldest unreviewed merged commit, and a role whose changes merge faster than they are reviewed accrues at most one pending review per role (the per-role key), never an unbounded backlog.
- The revert slot's routing (`settlePostReview` → revert → author revision) gains a test for the archive race: a change whose PLANS/BUGS entry was archived on merge, then rejected post-merge, re-opens or re-adds its entry so the author has something to fix (today only the clean/dedupe/coverage roles hit this, and their entries are usually self-referential).
- POST_REVIEW_FAILURE_LIMIT (3) behavior is reviewed, not changed: three verdict-less reviews drop the change with the same exhaustion bookkeeping as the pre-merge path's REVIEW_FAILURE_LIMIT — confirm a dropped post-merge change leaves main holding it (already merged, already green-checked) and only logs, which is correct for a failure of the *reviewer*, not the change.

**Acceptance criteria.**
- A test merges N=10 changes across 4 roles with fake reviews resolving on a controlled clock: every merged commit is eventually reviewed, none reviewed twice, and the per-role pending count never exceeds one.
- The archive-race test above passes; `npm run test:gate` passes.

### Reviewer as a regular role, part 4/4: Reviewer feedback the author cannot miss — the rejection note leads the next run, and the commit body acknowledges each reason (planned 2026-10-23 by user; design in plans/reviewer-as-role.md "What lands" item 4; evidence: the same reason text recurring across 27 consecutive rejections of bugfix-2 (10-22T08:29→14:35Z), so the injected `lastReview` note is not changing the author's next run; touches src/prompt/prompt.ts src/git/commit-message.ts src/runner/runner-run.ts and their tests)

**Goal.** Close the broken feedback loop that makes rejections cheap to repeat: when a run starts with a rejected change's reasons, those reasons — not the general charter — organize the run; and the resulting commit's body says, per numbered reason, what was done about it, so the re-review's prior-objection check (plans/revise-rejected.md) reads an answer, not a shrug.

**Approach.**
- src/prompt/prompt.ts: when `buildRejectedReviewNote`'s note is present, it renders at the very top of the run prompt, before the role charter, phrased as the run's primary task: "Your previous change was rejected; fix each numbered objection or drop the change" (the note already carries the reasons verbatim).
- src/git/commit-message.ts / runner-run's body assembly: when the run is a revision, the body template gains one line per prior reason — `Objection N: <done|dropped|unchanged-by-design because …>` — sourced from the same `lastReview` reasons, so the reviewer's interdiff check has the author's claim beside each objection.
- No change to the reviewer prompt in this part; the re-review already reads the prior objections first (plans/revise-rejected.md part 2/2).

**Acceptance criteria.**
- A revision run's prompt test asserts the rejection note precedes the charter and names every reason; a fresh run's prompt is byte-unchanged.
- A revision commit's body carries one Objection line per prior reason; the existing commit-body tests are updated for the new template, and a non-revision commit body is unchanged.
- The measurable target (stated in the plan, verified by hand after landing): first-rejection → second-rejection on the *same* reason drops against the 10-21→23 audit baseline.
- `npm run test:gate` passes.

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### Interlock relief, part 1/2: The merge-queue interlock holds only what the feedback contract needs — a queued author whose change is approved may run (planned 2026-10-23 by user; design in plans/interlock-relief.md "The decision" and "What lands"; evidence: queue waits before landing ran median 5 min, max 3 h 17 m over 58 h, and the interlock parks the author for the whole window; requires reviewer-as-role part 1/4 landed (one switch: `afterMerge` opts a role into both post-merge review and this relief); touches src/merge/merge-queue.ts src/orchestrator/orchestrator-scheduling.ts and their tests)

**Goal.** plans/merge-queue.md invariant 3 ("a loop with a queued or landing change is not eligible to tick") exists to preserve the `state.lastReview` feedback contract. For post-merge-review roles that contract no longer needs the pre-merge pipeline: scope the interlock per role and per stage, so an author whose change is approved-and-waiting or in the fast-forward is not parked, while the stages that actually race the author's branch stay exclusive.

**Approach.**
- src/merge/merge-queue.ts: `queuedMergeRoles` (or its scheduler-side caller) gains the entry's stage. The scheduling skip (src/orchestrator/orchestrator-scheduling.ts, the `queuedRoles.has(runner.role)` skip) applies to a role whose entry is pre-approval (under review or checks) or in a conflict/`main_red` hold (`resolve-wait`, `resolving`, a held pin) — not to one approved-and-waiting or in the merge's fast-forward.
- The per-role tiering follows `review.afterMerge` exactly: a role on that list gets the scoped interlock; a pre-merge-review role keeps today's full interlock (its rejection must reach the runner before it authors again — that is the contract's original case).
- The queue's own per-runner cap is unchanged: a role with a queued change still cannot queue a second (invariant 3's "no change accumulates more than one commit ahead of main"); an author whose new run finishes while its previous change is queued holds the new commit on the branch until the entry drains. The author's next run starts from `reset --hard main` as always, so a queued-approved change does not block its author's tree.
- plans/merge-queue.md invariant 3's text is updated to the scoped form with a pointer to plans/interlock-relief.md; docs/glossary.md's `waiting to merge` row keeps its meaning (it names the queue, not the run gate).

**Acceptance criteria.**
- A post-merge-review role with an approved queued entry starts its next run in the same poll it would have started in with an empty queue; the same role with an entry in `resolve-wait` or under review does not start (test over both stages).
- A pre-merge-review role (feature) with any queued entry still does not start — today's behavior, test unchanged.
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

### Cooldown scope: A pending stale-build restart holds the redeploy, not the team (planned 2026-10-23 by user; design in plans/cooldown-scope.md "The decision"; evidence: the live instance paused 2026-10-23T09:51Z with all 30 roles stopped and auto-restart blocked by the cooldown until 13:04Z — 3 h 13 m of full stop over a stale build 15 commits ahead; the team pause and the error-streak breaker are deliberately out of scope (a pause is the operator's explicit command; the streak breaker already pauses only the failing role); touches src/redeploy/redeploy-policy.ts src/redeploy/redeployer.ts src/orchestrator/orchestrator-scheduling.ts and their tests)

**Goal.** The restart cooldown is a rate limit against restart storms, and it should limit restarts — not hold every role's runs and merges while it runs. A team whose build is merely stale (the common case: work landed, build didn't move) keeps working; the redeploy happens when its cooldown lapses or the operator forces it (the dashboard's restart button and `tumwater restart` already waive it — the escape hatch exists).

**Approach.**
- src/redeploy/redeploy-policy.ts / redeployer.ts: the cooldown's deferral stops feeding the `holdForRestart` reason that orchestrator-scheduling reads to hold all new runs and merges; only the redeploy itself waits. The drain that precedes any actual swap, the red-running-build urgency carve-out (BUGS.md 2026-09-30), and the swap's own safety conditions (green check on the new head, a successful compile, in-flight runs finishing) are unchanged.
- The build-stale alert's text updates: "restarting when idle" becomes "restarting after cooldown; work continues" — the operator's mental model of what a stale build costs changes from "the team stops" to "the team runs yesterday's code until the swap".
- docs/how-it-works.md's redeploy section states the narrowed scope; docs/glossary.md's `update available` row gains "work continues while the restart waits".

**Acceptance criteria.**
- A test with a pending restart inside its cooldown: new runs start and merges proceed on the running build; the restart itself fires at the cooldown's lapse or on `restart_forced`, with the drain as today.
- The red-running-build carve-out still cuts the cooldown and the swap's preconditions still block a bad swap (existing tests untouched).
- `npm run test:gate` passes.

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

### Codex backend, part 9a/9: Doctor's Codex rows — install, login, home, models, account, leaks and sessions size (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9b/9, 9c/9 and 9d/9 — any of the four may land first; design in plans/codex-backend.md "CODEX_HOME and sessions", "Spend, free-ness, window, images" and "Hand steps"; touches src/doctor/doctor-codex-checks.ts (new) src/doctor/doctor-model-checks.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts src/agent/codex/codex-backend.ts test/fakes/fake-codex.ts test/doctor-checks.test.ts)

**Goal.** An operator can set Codex up from `tumwater doctor` alone: whether the binary is new enough, whether the configured `CODEX_HOME` is logged in the supported way, and what the home shares or leaks.

**Approach.**
- src/agent/codex/codex-backend.ts: export `CODEX_MIN_VERSION = "0.163.0"`, the sibling of `OPENCODE_MIN_VERSION` (src/agent/opencode/opencode-backend.ts) and `CLAUDE_MIN_VERSION` (src/agent/claude/claude-backend.ts).
- src/doctor/doctor-model-checks.ts: add `codexSeamsInUse(config)` beside `claudeSeamsInUse`/`opencodeSeamsInUse` (both built on `seamPairs`), the gate every codex row reads to stand down on a pi-only team.
- src/doctor/doctor-codex-checks.ts (new; the twin of doctor-opencode-checks.ts and doctor-claude-checks.ts): one exported check function per row, each returning null when `!codexSeamsInUse(config)`.
  - install/version: resolve the codex bin as a run would (the run's `TUMWATER_CODEX_BIN`/config dir) and read `codex --version`; below `CODEX_MIN_VERSION` fails.
  - login: `codex login status` under the run's `CODEX_HOME`; ChatGPT passes; an API-key login fails with the startup-gate message; not logged in fails naming `CODEX_HOME=<home> codex login --device-auth`.
  - home: `backends.codex.configDir` unset warns that team runs share the operator's `~/.codex` (trust entries, sessions in the resume picker, skills, a global `AGENTS.md`).
  - models: each routed codex model is in the home's catalog, with its window and any thinking level it lacks.
  - account: `credits.has_credits` true warns that a run crossing a limit may spend credits tumwater cannot count (design §7).
  - leaks: the home's `AGENTS.md`, `skills/` beyond `.system`, `hooks`, and the target repo's `.codex/config.toml` MCP servers, each named.
  - sessions size: report the size of the home's `sessions/`.
- src/doctor/doctor.ts: import the new check functions from doctor-codex-checks.ts and register the rows in the check list (as it imports checkOpencode from doctor-opencode-checks.ts); src/doctor/doctor-check-names.ts: add each row's name to `DOCTOR_CHECK_NAMES`.
- test/fakes/fake-codex.ts: extend the PATH shim beyond its `exec` case to answer `--version`, `login status` and the catalog read, and to shape `$CODEX_HOME` files, so every row runs offline against the fake (never a real codex).

**Acceptance criteria.**
- On the fake: `>= 0.163.0` passes and a lower version fails; ChatGPT login passes; an API-key login fails with the startup-gate message; a logged-out home fails naming the login command; unset `configDir` warns naming what the shared home exposes; a routed model missing from the catalog and a `has_credits` account warn; each leak path is named; a pi-only team shows no codex row.
- `npm run test:gate` passes.

### Codex backend, part 9b/9: Session retention — prune expired Codex sessions with `codex delete --force` (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9a/9, 9c/9 and 9d/9; design in plans/codex-backend.md "CODEX_HOME and sessions"; touches src/agent/session-ledger.ts src/orchestrator/retention.ts test/session-ledger-prune.test.ts test/retention.test.ts)

**Goal.** The team's Codex sessions age out on `sessionRetentionDays` like every other backend's, so a team's `CODEX_HOME` does not grow forever; the same prune reports what it deleted.

**Approach.**
- src/agent/session-ledger.ts: add `pruneCodexSessions(sessionsRoot, days, { bin, env })`, the twin of `pruneOpencodeSessions`: read the expired codex ledger records first and run `codex delete --force <id>` under the run's `CODEX_HOME` env, bounded at 10 s. Without `--force` Codex refuses to delete without a terminal (design finding 21), so `--force` is part of the command.
- When a delete fails or the binary is unusable, remove that session's rollout file under `$CODEX_HOME/sessions/` as the fallback (the OpenCode spill-file fallback's twin), so the ledger line and rollout do not outlive the window.
- src/orchestrator/retention.ts: in `RetentionPruner.prune`, call `pruneCodexSessions` beside `pruneOpencodeSessions` when a codex seam is configured (resolve the codex bin as a run would), before `pruneOldFiles` ages the ledger out, and warn one `deleted N expired codex session(s)` event when it deleted anything.

**Acceptance criteria.**
- A test with an expired codex ledger record and a fake codex on PATH sees exactly one `codex delete --force <id>` for it and its rollout gone; a fresh record is kept and gets no delete.
- A fake codex whose delete exits nonzero leaves that session's rollout removed by the fallback.
- `npm run test:gate` passes.

### Codex backend, part 9c/9: Codex docs — a backends.md section, the config keys and the README backend list (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9a/9, 9b/9 and 9d/9; design in plans/codex-backend.md "The decisions" and "Hand steps"; touches docs/backends.md docs/config.md README.md)

**Goal.** The Codex backend is documented where the other backends are, so an operator can configure and trust it from the docs alone.

**Approach.**
- docs/backends.md: a "Codex (`backend: "codex"`)" section — what it runs, the home and its one login, subscription-only billing, the windows and reserve, what is disabled and why (no sandbox, API-key login refused), sessions, and the sandbox choice — naming `backends.codex.configDir`, `codex login --device-auth` and `windowReserve`.
- docs/config.md: the `backends.codex` keys (`configDir`, `windowReserve`, `args`).
- README.md: add Codex to the backends list (the Backends paragraph; never the brief block between the `tumwater:prompt` markers).

**Acceptance criteria.**
- docs/backends.md's Codex section names `backends.codex.configDir`, `codex login --device-auth` and `windowReserve`; docs/config.md names the `backends.codex` keys; README's backend list names Codex.
- `npm run test:gate` passes.

### Codex backend, part 9d/9: The opt-in `smoke:codex` live check (planned 2026-10-20 by user; split 2026-10-23 by the plan role out of the too-large part 9/9; requires part 8/9 landed; independent sibling of parts 9a/9, 9b/9 and 9c/9; design in plans/codex-backend.md "Hand steps" and "Risks"; touches scripts/smoke-codex.mjs (new) package.json)

**Goal.** After a Codex upgrade, one live command proves the production invocation still works — the same hand check `smoke:claude` and `smoke:opencode` give.

**Approach.**
- scripts/smoke-codex.mjs (new; the twin of scripts/smoke-opencode.mjs and scripts/smoke-claude.mjs), run through a new `"smoke:codex"` script in package.json; it is not part of `npm test`.
- It runs the exact production invocation in a throwaway git repo and lists every step under `--help`/a dry-run without spawning codex: a fresh run that edits a file and runs a command; a resume that recalls it; a SIGTERM mid-command after which no marked process is left; an end-of-run note through `tumwater-notes`; an assertion that the first request is under 10,000 input tokens (8,059 on 0.163.0), catching an isolation regression; a 90-second command polled to completion with no `codex_command_abandoned`; and an assertion that the rollout gave a `five_hour` and a `seven_day` reading.

**Acceptance criteria.**
- `npm run smoke:codex --help` (or the dry-run flag) prints its steps without spawning codex.
- `npm run test:gate` passes.

### The day report's backlog lag median: how long a finished plan or bug waited from filing to done (planned 2026-10-23 by the plan role; shares src/report/report-types.ts, src/report/report-data.ts, src/report/report-render.ts and the src/ui/gui report files with the in-flight `tumwater report` main-red and review-duration entries — it adds a different field, line and chart beside theirs, so whichever lands later rebases; touches src/backlog, which no waiting entry touches; touches src/backlog/backlog-md.ts src/backlog/backlog.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts docs/cli.md test/backlog.test.ts test/report-data.test.ts test/report.test.ts test/gui-client-report.test.ts)

**Goal.** The usage report shows each day's throughput (`features done` / `bugs fixed`) but never how long the items it closed had waited since filing, so a day that closes two stale plans looks the same as one that closes two fresh ones. Add `backlogLagMedianDays` per day: the lower median, over the entries completed that day whose heading carries both a filing and a completion stamp, of the filing-to-done span in whole calendar days. (`tumwater backlog --list` already shows an open entry's age; nothing shows the age at which entries were closed.)

**Approach.**
- src/backlog/backlog-md.ts: add `entryLags(md, sectionTitle, dateRe, filingRe): { done: string; lagDays: number }[]`, walking exactly the lines `entryDates` counts (the `### ` headings and `- ` epitaphs that close a trailing `(…; commit …)`) with the same `headingMetadata`/`trailingParenthetical` rules: `done = lastDate(meta, dateRe)`, `filed = firstDate(meta, filingRe)`, and push `{ done, lagDays: daysBetween(filed, done) }` only when both exist and `lagDays >= 0`. `firstDate` stays module-local; `filingRe` is a parameter so `STAMP_DATE_RE` (backlog.ts) keeps its one home. Import `daysBetween` from src/text/datetime.ts (a pure text helper, like this module). Update `firstDate`'s doc comment: `entryDates` and `entryLags` are now both callers.
- src/backlog/backlog.ts: add `sectionCompletionLags(root, fileName, sectionTitle, dateRe): { date: string; lagDays: number }[]` beside `sectionCompletionDates`, the same stat-cached file reader with its own `lagCache` (key `${file}\u0000${sectionTitle}\u0000${dateRe.source}\u0000${dateRe.flags}`), calling `entryLags(md, sectionTitle, dateRe, STAMP_DATE_RE)`. A missing or unreadable file yields `[]`.
- src/report/report-types.ts: `ReportDay` gains `backlogLagMedianDays?: number` (team-only, absent when the day has none, like `checkMedianMs`), documented as the lower median of the whole-day filing-to-done lags of the entries completed that day.
- src/report/report-data.ts: in `collectReport`'s team branch (`role === undefined`), beside the `validationGaps` loop, collect a `Map<string, number[]>` from `sectionCompletionLags` over `finishedFiles("PLANS.md")` with `DONE_DATE_RE` and `finishedFiles("BUGS.md")` with `FIXED_DATE_RE`; for each `{ date, lagDays }` whose `date` is a `byDate` key, push into that day's list, then set `day.backlogLagMedianDays = lowerMedian(lags)`. (`collectReportSince` has no day series, so the `--since` report is unchanged, like the other day-granular backlog tallies.)
- src/report/report-render.ts: in `renderReportMarkdown`, after the `**Commits:**` line, under its own `data.role === undefined` guard, push `**Backlog lag median:** ${cells}` where `cells` joins `` `${monthDay(d.date)} ${d.backlogLagMedianDays}d` `` for each day that carries the field (no line when none); values are whole days from `daysBetween`, so a plain `${n}d` is exact where `medianLine`'s `shortSpanPhrase` would print minutes.
- src/ui/gui/gui-client-report-chart.ts: add `chartBacklogLagMedian(data)` = `reportSvg(data.series, (d) => [{ value: Number(d.backlogLagMedianDays) || 0, color: "#0891b2", title: d.date + ": " + (Number(d.backlogLagMedianDays) || 0) + "d median backlog lag" }], (v) => Math.round(v) + "d", false)` and `seriesHasBacklogLagMedian(data)` = `seriesHasScalar(data, "backlogLagMedianDays")`, beside their siblings.
- src/ui/gui/gui-client-report.ts: append `(seriesHasBacklogLagMedian(d) ? block("Backlog lag median", chartBacklogLagMedian(d), "per day · filing to done") : "")` to the day-report block chain, beside the `Backlog items done` block.
- docs/cli.md: the `tumwater report` row names the new `Backlog lag median` line (per day, whole days from each finished entry's filing stamp to its done/fixed stamp, team report only).

**Tests.**
- test/backlog.test.ts: `entryLags` over a `## Done` fixture returns `{ done: "2026-10-04", lagDays: 3 }` for a heading `(planned 2026-10-01 …; done 2026-10-04)`; a heading with no filing stamp and one whose filing is after its done yield nothing; a `- ` epitaph bullet is read the same way; a wrapped heading whose stamp continues on the next line still pairs.
- test/report-data.test.ts: a `## Done`/`## Fixed` fixture with two entries completed the same day (lags 2 and 4) gives that day `backlogLagMedianDays === 2` (the lower median) and no other day; a completion with no filing stamp still counts toward `featuresDone` but leaves the day's median unset when it is the day's only completion; a role-scoped `collectReport` leaves every day unset.
- test/report.test.ts: `renderReportMarkdown` prints `**Backlog lag median:** <MM-DD> <N>d` for the day that carries one and omits the line when no day does, and on a role-scoped report.
- test/gui-client-report.test.ts: the day-report block chain contains the `seriesHasBacklogLagMedian`/`chartBacklogLagMedian` gate, and `seriesHasScalar(d, "backlogLagMedianDays")` is false for a lag-free series.

**Acceptance criteria.**
- A day on which a finished plan or bug that carries both stamps completed reports the lower median of those completions' filing-to-done spans in whole days as `backlogLagMedianDays`; a day with no such entry carries no field and the line is omitted (zero means absent).
- Entries with no filing stamp or a filing later than completion contribute nothing; `- ` epitaph bullets count like `### ` headings, matching the entry detection `featuresDone`/`bugsFixed` uses.
- The field and line are team-only: a role-scoped day report and `report --json --role <id>` carry no `backlogLagMedianDays`; the `--since` report is unchanged.
- The dashboard renders the `Backlog lag median` chart only when a day carries the field.
- The existing per-day lines render unchanged (their tests pass untouched); `npm run test:gate` passes.

### Write guard on Codex, part 3/9: The hook's definition and its two `-c` flags, and `hooks` keys reserved from the passthrough (planned 2026-10-23 by user; requires part 2/9 landed; design in plans/codex-write-guard.md "The flags (part 3)" and findings 1–2; touches src/agent/codex/codex-write-guard.ts src/agent/codex/codex-args.ts src/config/config-validation.ts test/codex-write-guard.test.ts test/codex-args.test.ts test/config-validation.test.ts)

**Goal.** Build the exact `-c` values that install the hook and trust it, without wiring them into runs yet. Make sure an operator's `backends.codex.args` cannot replace either.

**Approach.**
- src/agent/codex/codex-write-guard.ts gains three exports:
  - `codexWriteGuardDefinition(nodeBin = process.execPath)` returns `{ matcher: "^apply_patch$", command, timeout: 30 }`. `command` is `n=<nodeBin quoted>; [ -x "$n" ] || n=node; exec "$n" <hook quoted>`, built like claude-write-guard.ts's `writeGuardSettings`. The hook path comes from `fileURLToPath(new URL("./write-guard-hook.js", import.meta.url))`, so a staged build runs its own copy.
  - `codexHookArg(definition)` returns the value `hooks.PreToolUse=[{matcher=<s>,hooks=[{type="command",command=<s>,timeout=30}]}]`.
  - `codexHookTrustArg(trust: { key: string; hash: string })` returns `hooks.state={<key>={trusted_hash=<hash>}}`, in the inline-table spelling. The dotted `hooks.state."<key>".trusted_hash=` spelling is ignored by Codex because the key contains dots (finding 2).
  - One `tomlString(s)` helper writes every TOML basic string, escaping `\`, `"` and control characters.
- Reserve `hooks`: a `-c`/`--config` passthrough whose key is `hooks` or starts with `hooks.` is refused. Codex is last-wins, so it could otherwise replace the guard or its trust.
  - Add a prefix rule beside `HARNESS_CODEX_CONFIG_KEYS` in codex-args.ts, for example `HARNESS_CODEX_CONFIG_KEY_PREFIXES = ["hooks"]` and an `isHarnessCodexConfigKey(key)` that both screens call.
  - The screens are config-validation.ts's `checkCodexConfigKeys` and any check codexArgs makes on its passthrough.
  - The problem text names the key as the existing one does ("…passes the config key hooks.PreToolUse, which tumwater manages — drop it or use another key").

**Tests.**
- test/codex-write-guard.test.ts:
  - `codexHookArg` and `codexHookTrustArg` produce the exact strings for a fixed definition and trust;
  - a `nodeBin` and hook path containing `'`, `"` and a space round-trip: the definition's `command` run through `sh -c` with a stray payload on stdin still prints the deny JSON;
  - `tomlString` escapes `\`, `"` and a control character.
- test/codex-args.test.ts: `isHarnessCodexConfigKey` is true for `hooks`, `hooks.PreToolUse` and `hooks.state` and false for `hooksy` and `model_provider`. The existing reserved keys stay true.
- test/config-validation.test.ts: `backends.codex.args` of `["-c", "hooks.PreToolUse=[]"]`, `["--config=hooks.state={}"]` and `["-c", "hooks={}"]` each report the key. `["-c", "model_provider=\"x\""]` still passes.

**Acceptance criteria.**
- Nothing in a run's argv changes in this part.
- The three passthrough spellings above are refused at config validation.
- `npm run test:gate` passes.

### Write guard on Codex, part 4/9: Ask codex for the hook's trust key and hash through `hooks/list`, and cache them per build and Codex version (planned 2026-10-23 by user; requires part 3/9 landed; design in plans/codex-write-guard.md "Trust (parts 4–5)" and finding 3; touches src/agent/codex/codex-hook-trust.ts (new) src/paths.ts test/fakes/fake-codex.ts docs/invariants.md test/codex-hook-trust.test.ts (new))

**Goal.** Codex runs a session-flag hook only with the right `trusted_hash`. The hash is opaque: no simple digest of the definition matched (finding 3). So tumwater asks Codex for it, once per build and Codex version.

**Approach.**
- src/agent/codex/codex-hook-trust.ts (new): `lookupCodexHookTrust({ bin, env, cwd, definition, timeoutMs = 15_000 }): Promise<{ key: string; hash: string }>`.
  - It spawns `<bin> -c <codexHookArg(definition)> app-server` in `cwd` with `env`, using the harness's own spawn helper with process-group kill. It kills the group when done, on timeout and on error.
  - Over stdio, one JSON object per line, it sends `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"tumwater","version":<tumwater version>}}}`, then `{"jsonrpc":"2.0","method":"initialized"}`, then `{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":[cwd]}}`.
  - It reads the reply to id 2 and returns the first hook in `result.data[*].hooks` with `source: "sessionFlags"`, `eventName: "preToolUse"` and `command` equal to `definition.command`, giving `{ key, hash: currentHash }`. It never hardcodes the key, which was `/<session-flags>/config.toml:pre_tool_use:0:0` on 0.163.0.
  - It rejects on timeout, on child exit before the reply, on a JSON-RPC error, and on "codex listed no session-flag PreToolUse hook with this command". It needs no login and makes no model request (verified with an empty `CODEX_HOME`).
- `codexHookTrust({ root, bin, env, cwd, definition })` caches in `codexHookTrustPath(root)` (new in src/paths.ts: `.tumwater/state/codex-hook-trust.json`).
  - The cache key is the trimmed output of `<bin> --version` plus `JSON.stringify(definition)`, each entry `{ key, hash, checkedAt }`.
  - A hit returns without spawning `app-server`. A miss looks up and writes the entry through `writeJsonAtomic`.
  - With `root` undefined (a hand run with no `.tumwater` root) it looks up and caches nothing. It never creates a `.tumwater` directory: a hand run once minted a phantom `$TMPDIR/.tumwater` and reddened every suite on the host (plans/codex-write-guard.md "Visibility").
- test/fakes/fake-codex.ts: the shim answers `app-server`.
  - It reads the JSON-RPC lines and answers `initialize` with `{}` and `hooks/list` with one sessionFlags preToolUse hook whose `command` is parsed from the `-c hooks.PreToolUse=` argument and whose `currentHash` is `sha256:` plus the sha256 of that command.
  - It appends each app-server start to a calls file the test can count. A test switch makes it hang, for the timeout case.
- docs/invariants.md: the next free `INV-CW` id. It is "the trust key and hash come from Codex's own `hooks/list` for the exact definition, are cached per Codex version and definition, and a lookup that times out leaves no child behind", pinned by the tests below.

**Tests.** test/codex-hook-trust.test.ts, on the fake:
- a lookup returns the fake's key and `sha256:` hash;
- a second `codexHookTrust` with the same version and definition starts no `app-server` (the calls file has one line);
- a changed `timeout` or a changed `--version` output looks up again;
- a hanging fake rejects within `timeoutMs` (set to 500 ms in the test), and the child's pid is gone afterwards;
- a fake whose list holds no matching hook rejects with the message above;
- `root` undefined writes no file.

**Acceptance criteria.**
- No Codex run's argv changes yet, and no code path calls the lookup outside the tests.
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

### Feedback role, part 1/2: the opt-in `feedback` observer — files one tumwater bug per run as a GitHub issue on znation/tumwater (planned 2026-10-23 by user; independent of every Planned entry; design in plans/feedback-role.md "The decision", "Invariants" and "Shape" → "Part 1"; touches src/roles/role-catalog.ts src/roles/roles.ts src/run/run-prompt.ts src/run/selfcheck-digest.ts src/config/config.ts src/doctor/doctor-model-checks.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts test/fakes/fake-gh.ts (new) README.md docs/config.md docs/glossary.md docs/how-it-works.md test/roles.test.ts test/config.test.ts test/prompt-roles.test.ts test/run-prompt.test.ts test/doctor-checks.test.ts)

**Goal.** Bring back the telemetry concept with the destination fixed: a new default-off observer role `feedback` that reads the same injected `<failure-digest>` selfcheck reads, applies the same response-was-wrong and rank-by-loss rules, and files ONE bug per run as a GitHub issue on github.com/znation/tumwater via the model's own shell running `gh` — never into the local BUGS.md, never editing the repo. Enabling is the operator's config choice (`roles.feedback.enabled`), selfcheck's exact opt-in precedent; nothing leaves the machine until then.

**Approach.**
- src/roles/role-catalog.ts: the `feedback` entry after `selfcheck` and before `security`, tier "default", title `feedback: files tumwater bugs upstream on GitHub`. The charter mirrors selfcheck's five rules verbatim where shared (rule 1 — a cluster is a bug ONLY when tumwater's RESPONSE to it is wrong; rank by loss; dedupe via `gh issue list --repo znation/tumwater --search` before every create) with the destination swapped: file with `gh issue create --repo znation/tumwater --title … --body …`, verify the issue URL in the command's output, cite the cluster key, the correlated merged commit, and `tumwater version` in the body, and redact absolute paths and secrets. Closing rule: "You never edit files in this repo — `gh` is your only write"; a fulfilled run ends with the nothing-to-do sentinel; a run that cannot file (gh missing/unauthenticated/failed) ends without the sentinel so the existing finished-without-changes warning (src/run/run-verdict.ts:321-326) surfaces the failure in the digest.
- src/roles/roles.ts: `OBSERVER_ROLES` gains `"feedback"`; the DEFERRABLE_ROLES/BASELINE_BLOCKED_ROLES doc comments name the role (excluded by construction, no code change).
- src/run/run-prompt.ts: the digest injection (line 177) covers `base === "feedback"` too; src/run/selfcheck-digest.ts's doc comment names both consumers of the shared trailing-24h window.
- src/config/config.ts: `roles.feedback = { enabled: false, minRunIntervalSeconds: 7200 }` beside the selfcheck entry, with the opt-in comment rewritten for the two roles. tumwater.example.json stays selfcheck-only (dogfood).
- Doctor gains a `feedback filing` check, shown only when the role is enabled: `gh` resolves and `gh auth status` exits 0, else fail with the `gh auth login` instruction (the codex-login pattern).
- Docs: README status line names two opt-in roles and 16 catalog roles; docs/config.md (enabled default, 7200 clock list, the selfcheck-or-feedback alternatives sentence), docs/glossary.md observer group, docs/how-it-works.md observer mentions.
- test/fakes/fake-gh.ts (new): records create/list invocations; a switch to simulate missing auth.

**Tests.**
- test/roles.test.ts: the `exempt` set, the OBSERVER_ROLES membership assertion and its message gain `feedback`.
- test/config.test.ts: the default-enabled loop skips both opt-in roles and asserts `roles.feedback?.enabled === false`; feedback's 7200 joins the interval assertions and the `slow` clock set.
- test/prompt-roles.test.ts: a feedback charter contract test, oneLine-anchored like selfcheck's.
- test/run-prompt.test.ts: a feedback prompt carries `<failure-digest>`; the "neither evidence block" test's role set gains feedback.
- test/doctor-checks.test.ts: the enabled-by-default count becomes `allRoleIds().length - 2`; the gh check's pass/fail cases on the fake.

**Acceptance criteria.**
- A default install has `feedback` disabled; the digest is rendered for it only when enabled.
- An opted-in install's feedback run files exactly one issue per run on znation/tumwater via `gh`, and a run with nothing to file ends no_change with the sentinel; the repo is never edited and main never moves.
- Doctor's `feedback filing` check reports gh missing/unauthenticated with actionable text, only when the role is enabled.
- `npm run test:gate` passes.

### Feedback role, part 2/2: the FILED reply line, the per-install filing ledger, and the issue_filed event (planned 2026-10-23 by user; requires part 1/2 landed; design in plans/feedback-role.md "Shape" → "Part 2" and "Invariants" 3-5; touches src/verdict/reply-contract.ts src/runner/runner-run.ts src/run/feedback-filings.ts (new) src/paths.ts src/prompt/prompt.ts src/run/run-prompt.ts src/run/run-verdict.ts src/run/run-stage.ts src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/roles/role-catalog.ts test/reply-contract.test.ts test/feedback-filings.test.ts (new) test/run-prompt.test.ts test/run-verdict.test.ts test/event-format.test.ts test/event-labels.test.ts)

**Goal.** Every feedback run starts a fresh session, so the only durable record of what this install already filed must live in harness state — exactly the qa flow-coverage problem (plans/observer-roles.md 2/2). Add the model-reported result line, the ledger it persists to, the next run's injected "previously filed" block, and the event that makes a filing visible in the operator's activity feed.

**Approach.**
- src/verdict/reply-contract.ts: `extractFiled(text)` beside `extractFlow` — `labeledLine(text, "FILED")`, then `/^#(\d+)\s*[—-]\s*(.+)$/`; null on no match, a missing number, or an empty title, so a truncated run never records a result it never declared.
- src/runner/runner-run.ts: `const filed = ctx.baseRole === "feedback" ? extractFiled(pi.finalText) : null;` beside the qa flow extraction (line 731), threaded into the verdict context.
- src/run/feedback-filings.ts (new, mirroring qa-coverage.ts): the `{ filings: [{ issue, title, filedAt }] }` ledger capped at the newest 100; read (malformed → empty), atomic record, and a `renderFilingsBlock` that returns undefined when empty and renders `#<n> <title> (<age>)` newest-first otherwise.
- src/paths.ts: `feedbackFilingsPath(root)` = `.tumwater/state/feedback-filings.json` with the qaCoveragePath-style doc comment.
- src/prompt/prompt.ts: `RunPromptInput.filings?: string` rendered beside the digest block; src/run/run-prompt.ts injects it for feedback only, in the qa coverage block's try/catch shape.
- src/run/run-verdict.ts + src/run/run-stage.ts: record beside qa's `recordFlow` — a non-cut-off `ctx.filed` writes the ledger and logs the `issue_filed` event (best-effort; a failed ledger write warns and never fails the run); a feedback run that also changed the tree still records its filing.
- src/events: `issue_filed` joins the event type union, rendered `filed issue #<n> <title> on znation/tumwater` in the feed, label `issue filed`.
- src/roles/role-catalog.ts: the charter's dedupe step names the injected "previously filed" block.

**Tests.**
- test/reply-contract.test.ts: `extractFiled` parses `FILED: #12 — title`; a line without a number, a mid-sentence mention, and a truncated `FILED: #12 — tit` yield null.
- test/feedback-filings.test.ts (new): ledger round-trip, the 100-entry cap keeps the newest, a malformed file reads empty, an empty ledger renders no block, the block renders newest-first with ages.
- test/run-prompt.test.ts: a feedback prompt over a non-empty ledger carries the filings block; no other role ever does.
- test/run-verdict.test.ts: a no_change feedback run with `filed` records the ledger entry and a cut-off run records nothing, mirroring the qa flow tests' shape (lines 156-183); a failed ledger write warns without failing the run.
- test/event-format.test.ts and test/event-labels.test.ts: the `issue_filed` rendering and label.

**Acceptance criteria.**
- A fulfilled feedback run's reply carrying `FILED: #<n> — <title>` persists to `.tumwater/state/feedback-filings.json`, renders in the next run's prompt as the previously-filed block, and logs `issue_filed` to the event feed; a truncated or malformed line records nothing.
- The run's outcome is unchanged (`no_change`, clean worktree, no warning): recording is bookkeeping that never fails the run.
- `npm run test:gate` passes.

### Split orchestrator-scheduling.ts's pollRunnerReasons pass into a scope/skip/admit structure (planned 2026-10-23 by the organize role, plan-only; the pass is one 444-line function, ~73% of the 611-line module, so it is not splittable in one run — this plan lands the target structure for a later organize run)

**Goal.** `src/orchestrator/orchestrator-scheduling.ts` is the largest splittable module left: its exported `pollRunnerReasons` (lines 114-557) is a single function that runs the whole per-poll scheduling pass — the one-poll precompute (merge-queue interlock, director pin, per-base claim groups and their release loop, the team-gate block predicates, the multi-runner `writing` count and admission order), then a per-runner loop folding the skip gates and once settlement, then the claim-assignment and stand-down admission. The file's other exports (`reviewHoldKey`, `pollDeferralInputs`) are small. Splitting the pass into three focused modules by phase, with `pollRunnerReasons` kept as the thin binder, makes the WHY-due policy each phase computes addressable on its own screen, the way the config-validation split did for `validateConfig`.

**Approach.**
- New `src/orchestrator/scheduling-scope.ts` — phase A (the one-poll precompute, current lines ~145-288): returns a `SchedulingScope` struct carrying `queuedRoles`, `pinnedDirector`, `claimGroups` (including the claim-release side loop that mutates runner state and persists), the gate-block predicate closures (`budgetHolds`, `operatorPauseBlocks`, `hasDemand`, `bootstrapHeldNow`, `maintenanceQuotaOverLine`), the `writing` counts, `ordered` runners, and the `eligibleMemo` map.
- New `src/orchestrator/scheduling-skip.ts` — phase B (the per-runner verdict loop, ~289-460): given a runner and the scope, returns `{ verdict: SkipReason }` or "due", folding once-mode settlement, the pause/cost-cap/maintenance/bootstrap gates, the director's window hold, inbox due, conflict-pin hand-back, need-based deferral, the merge-queue interlock, and the `instances` limit. It writes the skipped entries into the `reasons` map it is passed.
- New `src/orchestrator/scheduling-admit.ts` — phase C (~461-552): claim assignment for multi-runner groups (the hold/eligible/held rules) and the stand-down turn-down, returning the assigned/stood-down verdict for the runner.
- `src/orchestrator/orchestrator-scheduling.ts` shrinks to: build the scope via scheduling-scope, then loop `ordered` runners calling scheduling-skip and (when "due") scheduling-admit, assembling the `reasons` map; it keeps `SchedulingPassCtx`, `reviewHoldKey`, and `pollDeferralInputs`. The pass-level doc comment (lines 1-13) and each phase's inline invariants move with the code they explain.
- `src/scheduling/scheduling.ts` etc. keep the shared helpers they already own; nothing new is exported beyond the three modules' phase functions.

**Files touched.** src/orchestrator/orchestrator-scheduling.ts; new src/orchestrator/scheduling-scope.ts, src/orchestrator/scheduling-skip.ts, src/orchestrator/scheduling-admit.ts; orchestrator-scheduling.test.ts and orchestrator.test.ts only if an import path changes.

**Acceptance criteria.**
- `pollRunnerReasons` produces a byte-identical `reasons` map for identical input and state: this is a pure code-move restructure, no behavior change (the interlock-relief and cooldown-scope plans change behavior and will touch this file; this split must rebase behind them, not change what they set).
- A grep over src, test and docs finds no stale reference to any moved or renamed symbol; the file-level doc comment still names the pass and each phase module.
- `npm run test:gate` passes.

## Done
