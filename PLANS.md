# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Remote CI, part 2/3: A hosted-CI failure pages the operator once per commit, and `tumwater doctor` gains a `remote CI` row (planned 2026-11-04 by the operator at the user's direction; design in plans/remote-ci.md "Shape"; requires Remote CI part 1/3 landed; the event-notify.ts edit is one list entry beside the ones Every commit is verified on main part 4k/3 and Subtract part 3f/7 remove, so whichever merges second rebases; touches src/observer/remote-ci.ts src/run/run-dismiss.ts src/events/events.ts src/events/event-notify.ts src/events/event-labels.ts src/events/event-format.ts src/failure/failure-state-change.ts src/doctor/doctor-project-checks.ts src/doctor/doctor.ts docs/config.md docs/how-it-works.md docs/invariants.md test/remote-ci.test.ts test/run-dismiss.test.ts test/event-format.test.ts test/event-labels.test.ts test/event-notify.test.ts test/doctor-checks.test.ts)

**Goal.** Part 1/3 records GitHub's verdict, but only the next ci prompt reads it. An operator should hear when a pushed main goes red on GitHub, and `tumwater doctor` should answer "is GitHub CI green on what I pushed?" next to the `ci parity` row.

**Approach.**
- New event type `remote_ci_failed`, carrying `sha` and `repo`. Register it everywhere `issue_filed` is registered: the event-type union in src/events/events.ts, src/events/event-labels.ts (label `remote CI failed`), src/events/event-format.ts and src/failure/failure-state-change.ts. Also add it to `NOTIFY_EVENT_TYPES` in src/events/event-notify.ts, with a one-line comment, so it pages.
- `recordDismissedRemote` (src/run/run-dismiss.ts) logs the event with `logEventBestEffort` when the new result is `failed` and the previous record, as `recordRemoteCi` returns it, is not `failed` at the same sha. The message reads `GitHub CI failed at <sha7> on <repo>; the ci role reproduces it and fixes or files it — https://github.com/<repo>/commit/<sha>`, with the repo from the recorded result. Re-recording the same failed sha logs nothing. A failed ledger write still logs the event, the way `recordDismissedFiling` logs `issue_filed` before its write.
- src/observer/remote-ci.ts: `remoteCiStalled(entry, now)` is true when `now - entry.checkedAt > CI_PARITY_STALE_MS` (imported from ci-parity.ts). It is the one stall predicate, the same shape as `ciParityStalled`.
- src/doctor/doctor-project-checks.ts: `checkRemoteCi(root, config, now)` returns null when the ci role is disabled or `remoteCiTarget` is null, so the row is omitted the way `checkFeedbackFiling` omits its row. Otherwise:
  - no record: ok, `no remote CI result recorded yet — the ci role reads GitHub Actions on <repo> on its next run`;
  - stalled (checked before `failed`, so it applies to every result): warn, `no remote CI check recorded in over 3 days — the ci role is disabled, paused, or not reporting its REMOTE line`;
  - `failed`: warn, `GitHub CI failed at <sha7> on <repo> (checked <age> ago) — the ci role fixes or files it; it stays failed until a newer push passes`;
  - `pending`: ok, `GitHub CI was still running on <sha7> (checked <age> ago)`;
  - `passed`: ok, `GitHub CI passed at <sha7> on <repo> (checked <age> ago)`;
  - `unavailable`: ok (decision 3: the operator never opted in, so a missing `gh` is information), `the ci role could not read GitHub Actions: <reason> — run gh auth login, or set roles.ci.remote to false`.
- Register the row as `remote CI` right after `ci parity` in src/doctor/doctor.ts.
- Docs:
  - docs/config.md "Notify events" gains a `remote_ci_failed` row.
  - docs/how-it-works.md names the doctor row next to the `ci parity` row.
  - docs/invariants.md adds INV-BW5, "remoteCiStalled is the one home of the remote CI stall decision", binding src/observer/remote-ci.ts and `checkRemoteCi`.

**Files touched.** src/observer/remote-ci.ts src/run/run-dismiss.ts src/events/events.ts src/events/event-notify.ts src/events/event-labels.ts src/events/event-format.ts src/failure/failure-state-change.ts src/doctor/doctor-project-checks.ts src/doctor/doctor.ts docs/config.md docs/how-it-works.md docs/invariants.md test/remote-ci.test.ts test/run-dismiss.test.ts test/event-format.test.ts test/event-labels.test.ts test/event-notify.test.ts test/doctor-checks.test.ts

**Acceptance criteria.**
- Recording `failed` at sha A after `passed` at A logs one `remote_ci_failed` event naming A and the repo. Recording `failed` at A again logs none. Recording `failed` at a newer sha B logs one more.
- `NOTIFY_EVENT_TYPES` contains `remote_ci_failed`, and `formatEvent` renders its message with the commit URL.
- `checkRemoteCi` returns null in a repo without a GitHub remote. In a GitHub-remote fixture it returns each row above for each ledger state, and a `failed` record checked 4 days ago reads as stalled.
- `tumwater doctor` lists `remote CI` right after `ci parity` in a GitHub-remote fixture, and leaves it out otherwise.
- `npm run test:gate` passes.

**Tests.**
- test/run-dismiss.test.ts: the event-once cases.
- test/remote-ci.test.ts: `remoteCiStalled` at the boundary, one past it, and on a fresh record.
- test/event-format.test.ts, test/event-labels.test.ts and test/event-notify.test.ts: the new type.
- test/doctor-checks.test.ts: `checkRemoteCi` for every state, plus the omitted case.
- Run those files and the gate.

### Remote CI, part 3/3: The status line, TUI header and dashboard show GitHub's verdict on the pushed main beside the ci parity badge (planned 2026-11-04 by the operator at the user's direction; design in plans/remote-ci.md "Shape"; requires Remote CI part 1/3 landed; independent of part 2/3; the badges.ts, status-payload.ts, status-render.ts and gui-client-team.ts edits sit beside the ci parity badge and Hourly full check part 4/4's main-check age edits, and the status-polls.ts and status-data.ts edits are one field beside Subtract part 3f/7's removals, so whichever merges second rebases; touches src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/badges.test.ts test/status-payload.test.ts test/status-render.test.ts test/gui-client-team.test.ts)

**Goal.** The ci parity badge says whether the local full suite covered main's tip. Nothing at a glance says whether GitHub CI is green on what was pushed. Add a second badge from part 1/3's ledger, so a red push shows on `tumwater status`, the TUI header and the dashboard team panel without opening doctor.

**Approach.**
- src/status/status-polls.ts: `remoteCiForPoll(root)` returns `{ result, sha?, checkedAt }` from `readRemoteCi`, or undefined when there is no record. It reads only the ledger (no git, no `gh`) and uses the stat-keyed cache the parity reader uses (`cachedByStat`), so a per-second poll costs one stat.
- src/status/status-data.ts: the snapshot gains `remoteCi?` beside `ciParity`, filled by `remoteCiForPoll`.
- src/ui/badges.ts:
  - `remoteCiBadge(remote, now)` returns ` · github: passed at <sha7> <age>`, ` · github: failed at <sha7> <age>` or ` · github: running at <sha7> <age>`. It returns `""` for an `unavailable` record or no record, so a header without a GitHub remote stays byte-identical.
  - `remoteCiTone(remote)` maps passed to green, failed to red and pending to blue.
- src/ui/status-payload.ts carries `remoteCiBadge` and `remoteCiTone` preformatted, the way `ciParityBadge` and `ciParityTone` are carried. src/ui/status-render.ts renders the badge right after the ci parity badge. src/ui/gui/gui-client-team.ts adds a row after the ci parity row, the same way.
- docs/how-it-works.md names the badge in the ci paragraph.

**Files touched.** src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/badges.test.ts test/status-payload.test.ts test/status-render.test.ts test/gui-client-team.test.ts

**Acceptance criteria.**
- With a `failed` record at sha A, `tumwater status` shows ` · github: failed at <A7> <age>` in red right after the ci parity badge. The TUI header and the dashboard team panel show the same text and tone.
- With no record or an `unavailable` record, the status header, the payload's badge field and the dashboard panel are byte-identical to today's.
- `remoteCiForPoll` reads the ledger once while it is unchanged (one stat per poll) and re-reads it after a write.
- `npm run test:gate` passes.

**Tests.**
- test/badges.test.ts: each state, plus the empty cases.
- test/status-polls.test.ts: the cache.
- test/status-payload.test.ts, test/status-render.test.ts and test/gui-client-team.test.ts: the badge rides after the ci parity badge with its tone, and is absent without a record.
- Run those files and the gate.


### No duplicate plans, part 3/6: The plan role's prompt lists what unmerged changes add to and remove from `## Planned`, and its charter treats them as already planned (planned 2026-11-04 by the operator at the user's direction; design in plans/duplicate-plans.md "Decision" 1; requires No duplicate plans part 2/6 landed; touches src/backlog/backlog-pending.ts src/run/run-prompt.ts src/roles/role-catalog.ts test/backlog-pending.test.ts test/run-prompt.test.ts test/prompt-roles.test.ts)

**Goal.** Part 2/6 stops the scheduler from admitting a plan run that has nothing to plan. This part makes an admitted run see the unmerged plans, so its dedupe step (the plan charter's step 3: "confirm with grep … that no Planned entry … already covers it") also checks them. It also keeps the run from splitting or replanning an entry that an unmerged change already splits or removes. The `<backlog-index>` block is rendered from main, and every role's prompt shares it with line ranges into main's PLANS.md, so this is a separate block, not a change to the index.

**Approach.**
- Add `renderPendingPlansBlock(root): string | undefined` to src/backlog/backlog-pending.ts. It returns undefined when `pendingPlanChanges(root)` is empty.
- Otherwise it lists one line per unmerged change: `<role> <short sha>: <subject>`. Under each line it lists that change's effects on `## Planned`: `adds "<title>"`, `removes "<title>"` and `edits "<title>"`.
- Titles go through `stripEntryStamp`, like the index block's rows. Cap the block at 40 lines and end with a count of anything omitted.
- `collectRoleDirectives` (or a sibling collector, like `collectBacklogStructureBlock`) in src/run/run-prompt.ts adds the block for base role `plan` only.
- The plan charter in src/roles/role-catalog.ts gets one bullet at the top of step 1. Entries a `<pending-plans>` block adds are already planned: count them toward the eligible-plan stop, include them in step 3's dedupe, and never plan the same change again. An entry it removes or edits is being handled by that change: never split, replan, retire or refuse it.
- No other role's prompt changes.

**Files touched.** src/backlog/backlog-pending.ts src/run/run-prompt.ts src/roles/role-catalog.ts test/backlog-pending.test.ts test/run-prompt.test.ts test/prompt-roles.test.ts

**Acceptance criteria.**
- With the plan role pinned to a commit that adds `### A` and removes `### B`, the plan role's assembled prompt holds a `<pending-plans>` block naming the role, the short SHA, `adds "A"` and `removes "B"`. The feature and clean prompts do not have it.
- With no unmerged change touching PLANS.md, the plan prompt is byte-identical to the prompt before this part.
- The plan charter text names `<pending-plans>` in step 1, and the dedupe step names it too.
- `npm run test:gate` passes.

**Tests.**
- test/backlog-pending.test.ts: the block's rendering, including the cap and the empty case.
- test/run-prompt.test.ts: the block appears in the plan prompt only.
- test/prompt-roles.test.ts: the charter bullet.
- Run those files and the gate.

### No duplicate plans, part 5/6: Staging gives the author one fix-up turn when its change adds a duplicate `## Planned` entry or retires a plan on evidence that does not check out (planned 2026-11-04 by the operator at the user's direction; design in plans/duplicate-plans.md "Decision" 3 and 4; requires No duplicate plans part 2/6 and No duplicate plans part 4/6 landed; touches src/stage/stage-backlog-checks.ts src/stage/stage-check.ts src/runner/runner-outcome.ts test/stage-check.test.ts)

**Goal.** Catch a duplicate before it commits, not after it merges. In the 11-03 incident's clearest pair, run 700's sibling plan merged while run 700 was still running. A staging check reading main at staging time, together with part 2/6's snapshot, would have named it. Also check the evidence a retire cites, so a retire that rests on a SHA main lacks, or on a "survivor" that does not exist, never lands.

**Approach.**
- Add `duplicatePlanFinding(head, base, pending): string | undefined` to src/stage/stage-backlog-checks.ts, beside `planDependencyFinding`.
  - `head` is the run's PLANS.md, `base` is main's at staging, and `pending` is the unmerged changes the caller passes (below).
  - For each `## Planned` entry the head adds, by `entryKey` over the base, it reports when the entry's key or part label is already in base's `## Planned` or added by a pending change.
  - The finding names the existing entry, and the unmerged change's role and SHA when there is one. It says to drop the copy, or fold what it adds into the existing entry.
  - Only new entries count: a duplicate already on main stays part 4/6's to retire.
- Add `retireEvidenceFinding(wt, head, base)`. For each entry the head newly retires, it reads the first `**Retired …: <evidence>**` line and runs two checks.
  - Every short SHA in the evidence must resolve to a commit that main's tip contains (`git merge-base --is-ancestor` in `wt`).
  - Every double-quoted title must match a `## Planned` heading in head, or a done (not retired) heading in PLANS-DONE.md, by `finishedKey`.
  - Evidence with neither a SHA nor a quoted title passes. The post-merge review judges prose.
- `stageCheckFindings` (src/stage/stage-check.ts) gains an optional `pending: readonly PendingPlanChange[]` argument and hands it to `plansFindings`, which appends both findings. Like every staging check, a git error yields no finding.
- src/runner/runner-outcome.ts's `stageCheck` passes `pendingPlanChanges(ctx.root)`. It drops any change whose SHA the run's worktree HEAD already contains (`git merge-base --is-ancestor`), such as a held commit the run builds on, because those entries already appear in the head-over-base diff. The plan role's own earlier unmerged plan stays in the list: re-planning it is the case this part exists for.
- This is not a merge-gate rule: since part 3m/3 the gate refuses only what a later commit cannot repair.

**Files touched.** src/stage/stage-backlog-checks.ts src/stage/stage-check.ts src/runner/runner-outcome.ts test/stage-check.test.ts

**Acceptance criteria.**
- A head adding `### S, part 2/3: …` while base's `## Planned` already holds `### S, part 2/3: …` gets a finding naming the base entry.
- A head adding `### T (planned …)` while a pending feature-2 change adds `### T (planned …)` gets a finding naming feature-2 and the SHA.
- A head that only edits an existing entry gets no finding.
- A head retiring `### X` with `**Retired 2026-11-05 by the plan role: duplicate of abc1234**`:
  - gets a finding when `abc1234` is not on main;
  - gets none when it is.
- Evidence `duplicate of "No such entry"` gets a finding. Evidence quoting a planned heading gets none.
- `npm run test:gate` passes.

**Tests.**
- test/stage-check.test.ts:
  - each case above, against a temp repo for the SHA checks;
  - `stageCheckFindings` returning both findings.
- Run the file and the gate.


### Hourly full check, part 2c/4: The full check runs in its own `_main-full` mirror with its own in-flight pass, so a suite run never holds `_gate-main` (planned 2026-11-03 by the plan role, splitting the 2026-11-01 part 2/4 after feature held it too large for one run; requires Hourly full check part 2b/4 landed, so the full check is due-gated before it moves mirrors; touches src/paths.ts src/baseline/main-red.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-rules.test.ts test/main-watch-mirror.test.ts)

**Goal.** A full suite run, which can take 3–20 minutes, no longer holds the `_gate-main` mirror the per-head diff rules and the gate's main-tip attribution use. The full check runs in a detached mirror of its own, `_main-full`, with its own in-flight promise; `poll` starts each pass independently and `idle()` waits for both.

**Approach.**
- Add `fullMainWorktreePath(root)` to src/paths.ts: `_main-full` beside `_gate-main`, documented the same way.
- In src/baseline/main-red.ts add `withFullMainTipWorktree`, shaped like `withMainTipWorktree` but pinning `fullMainWorktreePath` and queuing on its own promise, never `gateMainQueue`, so a gate's main-tip re-run and a full check can overlap.
- In `createMainWatch`, replace the single `inFlight` promise with a per-head rules pass in `_gate-main` and a due full-check pass in `_main-full`. `poll` starts the rules pass on every new head and the full-check pass when part 2b/4 says it is due, each behind its own in-flight guard. `idle()` waits for both plus housekeeping.
- Keep one `lastWatched` for the rules pass, so each head's diff is judged once; the full pass derives its own due state from `checkedAt`, so a head already checked starts no second run.
- docs/how-it-works.md says the full check owns its mirror; docs/invariants.md adds INV-DA2: the full check runs at most once per interval, on the latest tip, in `_main-full`, only while a code commit is uncovered, and a `_gate-main` diff-rule or gate step never waits behind it.

**Files touched.** src/paths.ts src/baseline/main-red.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-rules.test.ts test/main-watch-mirror.test.ts

**Acceptance criteria.**
- With a full check that sleeps before exiting, a new head's diff rules finish and a gate's main-tip re-run completes while that full run is still in flight.
- The full check runs in `_main-full`; no full run holds `_gate-main`.
- `idle()` returns only after the rules pass, the full-check pass and housekeeping have all finished.
- A head that moves while a full run is in flight is checked on the latest tip by the next poll, as today.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch-mirror.test.ts: a slow full check and a concurrent `mainTipVerdict` call overlap (the gate's answer arrives before the full run ends), and the two worktree paths differ.
- test/main-watch.test.ts and test/main-watch-rules.test.ts: existing per-head cases pass with the split passes, including `idle()` draining a slow full run.
- Run those files and the project's gate.

### Hourly full check, part 3/4: Main's failures are narrowed and cleared by re-running only the failing tests — the watch bisects a red's opener, re-runs only the open failures on each new head, and confirms a cleared red with one full run at once (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 2c/4 landed; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts)

**Goal.** With the full check hourly, one red verdict covers up to an hour of commits. Narrowing it and closing it must not cost more full runs (user, 2026-11-01: "when fixing failures, re-run only the failed tests"):
- A confirmed red's opener is found by bisection that re-runs only the failing tests, so `main_culprit` and ci's heal prompt name one commit.
- While the red is open, each new head re-runs only the open failures.
- When none fail any more, the red closes as cleared, and one full run starts on that head at once to confirm it, so a healed main becomes deployable without waiting out the hour.

**Approach.**
- After a red is confirmed at tip T, bisect in `_gate-main` with `rerunTests`. The code lives in main-watch.ts, beside `reportCulprit`.
  - The range is the first-parent code commits above the newest observed full green G, found by walking down from T.
  - The opener C is the first commit at which any of the confirmed failing tests fails. Before naming C, confirm once that they fail at C and pass at C's parent.
  - A failing test not accounted for at C (it passes there) gets its own bisect over C..T, up to `FAILING_TESTS_MAX` tests.
  - With no G on the walk, a one-commit range, or a confirmation that does not reproduce, name T as today.
- `reportCulprit` names C everywhere: `main_culprit.commit`, its merging runner, `redSpellOpeners` and the `onCulprit` hand-off (`commit` C, `tip` T).
- While a red spell is open, the per-head pass also re-runs the spell's open failing tests on each new head (one `rerun`-scope check). Tests that pass leave the open set. An empty set:
  - logs `main_check` `{ status: "passed", cleared: true }`, which writes no full green;
  - calls `clearHealKeyOnGreen` and closes the spell;
  - starts a full run on that head at once, once per cleared red.
- `knownMainFailures` and the `<main-known-red>` note read the open set, so a role's prompt stops naming a test ci already fixed.
- docs/how-it-works.md describes bisection and clearing. docs/invariants.md gains:
  - INV-DA3: a red's culprit is the first commit at which its failing tests fail, found by re-running only them.
  - INV-DA4: an open red is narrowed and cleared by re-running only its failing tests, and a clearing starts one confirming full run.

**Files touched.** src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts

**Acceptance criteria.**
- An hourly red at T covering eight code commits, whose failing test breaks at the third, logs one `main_culprit` naming the third. That takes at most five `rerun`-scope checks and no second `baseline`-scope run.
- A red whose bisect confirmation does not reproduce names T, as today.
- While red, a new head runs one `rerun` of the open failures and no full run. When they all pass, `main_check` is `cleared` and a full run starts though the hour has not passed. `redeployTarget` does not target the cleared head until that full run is green.
- The heal prompt and the `<main-red>` note name C and the re-run command for its failing tests.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts:
  - the eight-commit bisect against a fake check whose failure starts at one commit;
  - the non-reproducing bisect;
  - "a red whose breaking commit is intermediate" now names that commit, not the tip;
  - a cleared head that is not deployable.
- test/main-watch-failures.test.ts: per-head narrowing — a new head re-runs only the open failures, and `knownMainFailures` drops a test that passes there.
- test/main-watch-spells.test.ts: the bisected opener is the spell's culprit; clearing closes the spell with `cleared: true` and starts the confirming full run though the hour has not passed.
- test/main-red-heal.test.ts: the heal prompt names the bisected opener.
- Run those files and the gate.

### Hourly full check, part 4/4: Status, doctor and the dashboard say how old main's full verdict is and when the next is due (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 3/4 landed; touches src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts)

**Goal.** Main's badge stops implying the newest commit was fully checked. With the full check hourly, `mainCheckForPoll`'s status reads up to an hour behind main. Every surface that shows it says which SHA it covers, how long ago it ran, and when the next run is due (or "due now" after a cleared red).

**Approach.**
- `MainCheckStatus` (src/status/status-polls.ts) gains the full verdict's `checkedAt` and `nextDueAt`. `nextDueAt` comes from part 2/4's interval and part 3/4's cleared-red start.
- `mainCheckBadge` (src/ui/badges.ts) renders "full check green at abc1234, 23 min ago · next in 37 min". A cleared red reads "cleared at def5678 · full check running".
- The TUI line (status-render.ts) and the dashboard card (gui-client-team.ts) use the same payload fields (status-payload.ts). No new alert or doctor row: the existing main-check row carries the text.
- docs/how-it-works.md names what the badge shows.

**Files touched.** src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts

**Acceptance criteria.**
- With a full green 23 min old and a 60 min interval, `tumwater status`, the TUI and the dashboard show the covered SHA, "23 min ago" and "next in 37 min".
- After a cleared red, they show the clearing head until its full run settles.
- No new alert builder or doctor row exists.
- `npm run test:gate` passes.

**Tests.** test/status-polls.test.ts: `nextDueAt` from the interval and from a cleared red. test/status-render.test.ts and test/gui-client.test.ts: the badge text for green, red and cleared. Run those files and the gate.

### Subtract, part 6a/6: The live docs and example config keep only the mechanisms that survived the series (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6b/6, independent in files of it; design in plans/subtract.md "The six strokes" and "How we will know it worked"; its original prerequisites Subtract parts 1e/6, 5v/6 and 5x/6 have landed, and it requires Subtract part 3g/7 landed, the last unlanded Subtract part; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json)

**Goal.** The live prose and `tumwater.example.json` describe only mechanisms that still exist after the Subtract series: the names whose producer and reader the earlier parts removed are gone from the config tables, command lists, glossary, architecture prose and example config, while every mechanism the user kept is still documented and its keys still appear. This is the documentation half of the old sweep; the doctor rows, tests and before/after counts are part 6b/6.

**Approach.** All edits are documentation and the example config; no `src/` file changes here.
- Treat the old sweep list as a candidate list, not a mandate: for each name, `grep -rn '<name>' src/` first. A name whose live `src/` reader or writer is gone is removed from the swept docs and the example; a name `src/` still reads or writes stays documented with its tests. The pre-merge gate keeps its build check (user, 2026-11-01), so in particular `check_wait` and `maxConcurrentChecks` stay wherever the check permit still serves that gate or the main watch, and `mergeCommand` stays wherever the merge step still reads it. `mergeBatchMax` is dead after the batch path landed; `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `review.afterMerge`, `held-for-operator`, `Needs replan`, `Waiting for the next failure` and the `(held N)` counter are dead. The queue vocabulary (`merge queue`, `interlock`) belongs to the landed part 3g/7; remove any occurrence this file still carries.
- docs/config.md: drop the dead keys and aliases from the tables, and keep the rows for the keys `src/config/config-schema.ts` still reads — `instances`, `slotCount`, `slot_wait`, `slot salvage`, the tier/fallback keys, the image reroute and the subscription usage-window display (the Settings concurrency controls and those mechanisms were kept: director 2026-10-31, user 2026-10-28 and 2026-10-30).
- docs/cli.md and the TUI-keys table: drop commands, flags and keys whose implementation parts 3d/7–3f/7 removed, and keep the concurrency controls and declared-check editing that remain. docs/glossary.md: remove the terms for deleted mechanisms and keep the kept vocabulary.
- docs/how-it-works.md: remove paragraphs that still promise a deleted stage, queue or alert; keep the gate's pre-merge build check and the Hourly full check's hourly main watch as landed.
- tumwater.example.json: remove only the dead keys; preserve the kept capacity, tier, fallback, image-reroute and subscription-window settings.
- docs/invariants.md: drop or re-scope the invariants of deleted subsystems (merge-slot stages, the permit where its mechanism is gone, per-provider caps, subscription-window holds), keep the invariants of the tiers, budget fallback, image reroute and subscription usage-window display, and leave every remaining file/test binding naming an existing file and test.
- README.md and DEVELOPMENT.md: remove stale references to the deleted mechanisms; do not touch the brief block between the `tumwater:prompt` markers.

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json

**Acceptance criteria.**
- For every candidate name, the part's Done entry records the `grep` evidence: either no live `src/` reader remains and the name is absent from the swept docs and example, or a live reader remains and the name is still documented with that reader.
- `grep -rnE 'maxConcurrentPerProvider|mergeBatchMax|claudeWindowReserve|windowReserve|review\.afterMerge|held-for-operator|Needs replan|Waiting for the next failure' docs/ README.md DEVELOPMENT.md tumwater.example.json` prints nothing.
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` prints no claim about a mechanism the landed parts deleted.
- The kept mechanisms are still documented: the Settings concurrency controls, the tier and budget-fallback settings, the image reroute and the subscription usage-window display, plus any check-permit key `src/` still reads.
- docs/invariants.md keeps no binding to a deleted module and no binding whose named test file is gone; docs/config.md, docs/cli.md and the TUI-keys table agree with the live schema and command set.
- `npm run test:gate` passes.

**Tests.** Run test/config-doc.test.ts (docs/config.md against the live schema), test/cli-doc.test.ts and test/docs-commands.test.ts (command help/docs parity), test/tui-keys-doc.test.ts, test/docs-links.test.ts and test/invariants-doc.test.ts (file and test bindings), then the project's gate. If a kept key is dropped from the docs or a dead key stays, fix the table; do not weaken a doc check.

### Subtract, part 6b/6: The doctor rows, tests and counts the series left behind (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6a/6, requires Subtract part 6a/6 landed so the surviving key and row set is fixed; touches src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md)

**Goal.** The doctor advertises only checks whose mechanism still exists, and the tests assert only surviving rows, events, artifacts and keys. This is the code-and-tests half of the old sweep; the live docs and example config are part 6a/6, whose surviving set this part follows. The part also records the series' before/after row and key counts and its measurement table.

**Approach.** All edits are the doctor row list and the tests that pin it; no production behavior changes.
- src/doctor/doctor-check-names.ts: delete the rows whose check function no longer exists after the series; do not re-point them at another mechanism. Keep every row whose check still reads a live path. Do not add a row.
- Re-check the parts 1a–1e/6 rule end to end: every condition that used to have a banner and now has no banner still has a doctor row, and every row names a mechanism that exists. Record any condition with neither a banner nor a row in the part's Done entry rather than inventing a row here.
- test/doctor-checks.test.ts: update its row list to exactly the surviving rows; delete cases whose only subject is a deleted row. test/event-format.test.ts: delete the cases for event types no live producer emits (including `check_wait` only when part 6a/6 found no live reader, and the merge-stage events the landed parts removed); keep the cases for surviving event families. test/retention.test.ts: delete the cases for artifacts no mechanism writes; keep the surviving ones. test/config.test.ts: update the key cases to the surviving key set part 6a/6 documented; do not delete a case for a key `src/config/config-schema.ts` still reads.
- In the part's PLANS-DONE entry, record the doctor row count and the config key count before this part and after it, and carry the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md

**Acceptance criteria.**
- Every row name in `doctor-check-names.ts` resolves to a check function that exists and reads a mechanism that still exists; no row reports a path nothing writes.
- The row list in test/doctor-checks.test.ts equals the surviving row set; no test asserts a deleted row, event type, artifact or config key, and the surviving cases stay.
- No production module outside `src/doctor/doctor-check-names.ts` changes; that edit only adds or removes row-name strings, and the diff names only the files listed above.
- The before/after doctor row and config key counts and the measurement table are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

**Tests.** Run test/doctor-checks.test.ts, test/doctor.test.ts, test/event-format.test.ts, test/retention.test.ts, test/config.test.ts and test/config-aliases.test.ts, then the project's gate. If a surviving row or key loses its case, restore it; do not weaken an assertion to make the gate pass.

### Every commit is verified on main, part 4k/3: the `main_red` union member and the run/runner plumbing that names it are removed (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires part 4n/3 landed, so no merge produces the verdict, no surface reads it and `rolePhase` no longer takes it; touches src/run/run-outcome.ts src/scheduling/claims.ts docs/invariants.md src/runner/runner-recovery.ts src/merge/merge-requeue.ts src/runner/runner-leftover.ts src/runner/runner-state-load.ts src/runner/runner-run.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/runner-leftover.test.ts test/merge-requeue.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts test/budget.test.ts test/claims.test.ts test/fallback-breaker.test.ts)

**Goal.** The `main_red` run result no longer has a producer (Hourly full check part 1b/4 removed the gate's `mainRed` path, whose dead branch part 4m/3 deletes; the recovered-pin return removed here is the last one) or a reader (part 4m/3), so the union member itself is dead vocabulary. Remove it and let the compiler name any site still constructing or narrowing it.

**Approach.**
- Remove `| "main_red"` and its doc comment from `RunResult` (src/run/run-outcome.ts). Deleting the member makes every remaining construction or `result === "main_red"` narrowing a compile error, which is the work list.
- Remove the last producer: `runner-recovery.ts`'s recovered-`main_red` return, with the `main_red_wait` result in src/runner/runner-leftover.ts and the `mainRedRetry` record in src/merge/merge-requeue.ts, src/runner/runner-state.ts and src/runner/runner-state-load.ts that feed it. With merge-requeue.ts's `result === "main_red"` branch gone, nothing sets the record any more, so the pin's wait/recovery path, its state key, the orchestrator poll's `requeueMainRedPin` call and the leftover's `mainRedWait` return go with it; keep the stale/dangling pin cleanup and conflict hand-back. Fix any surviving switch/type-narrowing the compiler flags (run-apply, run-finalize and the run prompt), keeping each site's non-`main_red` behavior.
- Drop the record's last writer: src/scheduling/claims.ts's `dropWithdrawnWork` clears `state.mainRedRetry`; with the record gone that line goes. In docs/invariants.md, delete INV-BR2 and INV-CY2, remove INV-CZ1's stale sentence and binding that name a kept `main_red` pin's re-queue (its other red-main guarantees stay), and drop INV-N5's sentence about clearing a kept `main_red` pin's re-queue record (the rest of INV-N5 stays).
- Refresh the comments that still name the verdict as a live outcome in `src/runner/runner-state.ts`, `src/runner/runner-recovery.ts`, `src/run/run-finalize.ts`, `src/run/run-prompt.ts`, `src/orchestrator/orchestrator-poll.ts`, `src/events/event-notify.ts`, `src/inbox/pending-prompt.ts`, `src/review/review.ts`, `src/merge/merge-verify.ts`, `src/merge/merge-queue.ts`, `src/budget/fallback-breaker.ts` and `src/baseline/main-red.ts`.

**Files touched.** src/run/run-outcome.ts src/runner/runner-recovery.ts src/merge/merge-requeue.ts src/runner/runner-leftover.ts src/runner/runner-state-load.ts src/runner/runner-run.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/scheduling/claims.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts docs/invariants.md test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/runner-leftover.test.ts test/merge-requeue.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts test/budget.test.ts test/claims.test.ts test/fallback-breaker.test.ts

**Acceptance criteria.**
- `RunResult` has no `main_red` member, and `grep -rnE '\bmain_red\b' src/` prints nothing (the `main_red_hold` event and its machinery stay; `\bmain_red\b` does not match `main_red_hold`).
- No code path returns or narrows on a `main_red` run result, and nothing writes `mainRedRetry`; the compiler is clean.
- docs/invariants.md no longer binds `requeueMainRedPin` or `mainRedRetry`: INV-BR2 and INV-CY2 are gone, INV-CZ1 keeps only its red-main attribution guarantees, and INV-N5 no longer promises to clear a `main_red` re-queue record.
- `npm run test:gate` passes.

**Tests.**
- test/run-outcome.test.ts: the `main_red` membership case goes; the surviving `RunResult` cases stay.
- test/runner-recovery.test.ts / test/runner-red-main.test.ts: the recovered-`main_red` cases go; the surviving recovery cases stay.
- test/run-apply.test.ts / test/run-finalize.test.ts / test/merge-pipeline-2.test.ts / test/merger.test.ts: drop the `main_red` assertions; the surviving cases stay.
- test/budget.test.ts / test/fallback-breaker.test.ts: drop `main_red` from the `fallbackEvidence` result rows and the run-result vocabulary list; the surviving mappings stay.
- test/claims.test.ts: the withdrawn-work case drops its `mainRedRetry` fixture assertion; the surviving withdrawal assertions stay.

_None yet._

### Subtract verify collapse, part 3/5: The merge queue drains one entry at a time through the gate and the merge in a single task; the verify stage, its maps and its modules are deleted (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 2/5 landed; touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/merge-requeue.test.ts test/fixtures/orchestrator-fixtures.ts)

**Goal.** A queued entry goes from the queue to the gate to the merge in one task: `drainMerge` starts the head entry, `mergeApprovedChange` runs `reviewQueuedChange` in the merge worktree before `mergeToMain`, and a rejected entry settles as today. No `verifying`/`approved` maps, no separate verify task, no second review. The durable queue still orders entries and the pin still carries the commit.

**Approach.**
- merge-core.ts: in `mergeApprovedChangeIn`, check the withdrawn entry (`withdrawnPinReason` plus `dropWithdrawnPin`, as `mergeToMain` does) and run `reviewQueuedChange(ctx, req, wt, ctx.state, ctx.foldUsage)` before `mergeToMain`; return its result when it is not an approval, otherwise merge the approved head. Update `mergeApprovedChange`'s "already passed its own gate" comment.
- merge-drain.ts: `drainMergeQueue` becomes `drainPostReviews` plus `drainMerge`; `drainMerge` takes `headMerge` and starts one single-change `startMerge` task; the task resolves the author, calls `mergeApprovedChange`, settles each outcome through `settleMergeOutcome`, queues the post-merge review on a `merged` event as today, and handles user abort and shutdown as today. Delete `settleAbortedApproved` and the `approved`/`verifying` branches.
- merge-pipeline.ts: `MergePipeline` becomes `{ merge, postReview }`; delete `ApprovedMerge`; `mergeTasks` and `abortableMerges` read those; drop `liveRoles` if no caller remains.
- src/orchestrator/orchestrator-poll.ts: remove the `settleAbortedApproved` import and its per-poll call.
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts; delete test/merge-drain-verify.test.ts.
- test/fixtures/orchestrator-fixtures.ts's `mergeHead` drives the queue head through `drainMergeQueue` (or the one merge task) instead of `startVerify` plus `drainMerge`; update the merge-drain/pipeline/merger tests to assert the one-step path.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/merge-requeue.test.ts test/fixtures/orchestrator-fixtures.ts

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start or approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential, or whose gate check fails for a test of its own, is rejected before it merges; every other queued diff merges without a second review.
- `grep -rn 'drainVerify\|startVerify\|verifyRequest\|ApprovedMerge\|p\.verifying\|p\.approved' src/` prints nothing, and `ls src/merge/merge-verify.ts src/merge/merge-batch.ts` fails.
- test/merge-drain-verify.test.ts is gone with its subject; the surviving merge-drain and pipeline tests drive an entry from queue to merge.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Update test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts, test/merger.test.ts and test/merge-requeue.test.ts to drive an entry from queue to merge without the verify/approved map, and update the fixtures' `mergeHead` to the same path. Run those files and the gate.

### Subtract verify collapse, part 4/5: The `approved` in-flight status and the status, GUI and queue surfaces that wait on it are removed (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 3/5 landed; touches src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/ui/status-model.ts src/ui/gui/gui-client-model.ts src/cli/help.ts test/merge-slot.test.ts test/status-model.test.ts test/status-data-inbox.test.ts test/gui-client.test.ts test/help.test.ts test/team-alerts.test.ts test/merge-queue.test.ts test/status-polls.test.ts)

**Goal.** No operator surface or marker type advertises a change waiting for a merge slot that no longer exists: `MergeChangeStatus` is `"merging" | "done"`, and status, GUI, help and the merge-queue cell render only live states. `checkWaitStage` and `resolveWaitStage` stay because the gate build check (review-precheck.ts) and the conflict resolver still wait on permits.

**Approach.**
- merge-slot.ts: drop `"approved"` from `MergeChangeStatus`, from `isMergeChange`'s accepted statuses and from the comments; keep `setMergeChangeStatus` for merging/done and keep both wait-stage hooks.
- merge-queue-render.ts: drop the `change.status === "approved"` branch (Subtract part 3d/7 later deletes this module; whichever lands first rebases).
- status-model.ts and gui-client-model.ts: remove the `approved, waiting to merge` phase mapping and rank; update the comments that describe the verify-to-approval wait.
- cli/help.ts: remove the `[approved, waiting to merge]` stage example.
- Update the tests above that pin the removed string or status; add no new status.

**Files touched.** src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/ui/status-model.ts src/ui/gui/gui-client-model.ts src/cli/help.ts test/merge-slot.test.ts test/status-model.test.ts test/status-data-inbox.test.ts test/gui-client.test.ts test/help.test.ts test/team-alerts.test.ts test/merge-queue.test.ts test/status-polls.test.ts

**Acceptance criteria.**
- `grep -rn 'approved, waiting to merge\|status === "approved"' src/` prints nothing for the merge marker and operator surfaces; the review gate's own `approved` verdict is out of scope and stays.
- A marker record whose status is `approved` is no longer accepted as a live change; the status, GUI and help tests assert only merging and done states.
- `npm run test:gate` passes.

**Tests.** Run test/merge-slot.test.ts, test/status-model.test.ts, test/status-data-inbox.test.ts, test/gui-client.test.ts, test/help.test.ts, test/merge-queue.test.ts and test/status-polls.test.ts, then the gate.

### Subtract verify collapse, part 5/5: docs/how-it-works.md and docs/invariants.md describe one gate-then-merge step and bind only modules that survive (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 4/5 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md test/invariants-doc.test.ts)

**Goal.** The live prose and invariant bindings describe the landing that exists after parts 1/5–4/5: a queued pin is gated in the merge worktree (the deterministic diff rules plus the declared gate command), then rebased and fast-forwarded under the merge lock; no sentence promises a separate verify stage or an approval wait. The post-landing review and the main watch keep their guarantees.

**Approach.**
- docs/how-it-works.md's merge pipeline section: replace "Queued changes are approved in parallel and one serial merge step merges them" and the Review/Merge paragraphs that describe a separate verify stage with one step per queued head: gate (diff rules plus build check, and the withdrawn check) then merge; keep the post-merge review, the main watch and the permit accounting.
- docs/invariants.md: re-point every binding that names src/merge/merge-verify.ts, src/merge/merge-batch.ts, `verifyRequest`, `dropTornHead`, `ApprovedMerge` or a verify-stage marker to the surviving module and test (merge-head.ts, merge-drain.ts, merge-core.ts, merge-slot.ts); keep the guarantees whose code survives (withdrawn pin drop, torn-head drop, gate build-check abort, post-merge review permit). Do not delete a guarantee just because its binding moves.
- docs/glossary.md's retired-name row for `landing-vetting.ts` names `merge-verify.ts`; point it at the surviving merge-core.ts (Subtract part 3g/7 later re-sweeps the glossary).
- test/invariants-doc.test.ts's expectations follow the re-pointed bindings.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md test/invariants-doc.test.ts

**Acceptance criteria.**
- `grep -rniE 'verify stage|approval stage|approved in parallel|approved, waiting to merge' docs/ README.md` prints no claim that a separate verify stage or approval wait exists.
- Every docs/invariants.md binding names an existing src file and test file; no binding names merge-verify.ts or merge-batch.ts.
- The prose still states the gate's build check, the one merge lock, linear history and the main watch's post-landing check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/docs-links.test.ts, then the gate.

### Subtract, part 3d/7: `tumwater queue`, its cancel/top keys and the browser queue controls go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract verify collapse part 4/5 landed; touches src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts)

**Goal.** The operator stops steering a queue that becomes a lock and a fast-forward: delete the `tumwater queue` command, its `--cancel` and `--top` flags, the GUI Merge queue card's Cancel/Move-to-top handlers, the TUI pending pane's queue rows and keys, and the three modules that implement cancel/top/queue rendering. The queue reader itself stays for status, doctor and the CLI surfaces this part does not own until part 3f.

**Approach.**
- Delete src/merge/merge-cancel.ts, src/merge/merge-top.ts and src/merge/merge-queue-render.ts; remove `cmdQueue`, `cmdQueueCancel`, `cmdQueueTop` and the queue view from src/cli/cli-query-commands.ts and their command/help/completion entries.
- Remove `handleQueueCancel`/`handleQueueTop` and their `/api/queue-cancel`/`/api/queue-top` routes from src/gui/gui-operator-commands.ts and gui-server.ts; delete the dashboard Merge queue card's Cancel/Move-to-top controls.
- Remove the merge-queue rows, labels and Ctrl keys from tui-pane-pending.ts, tui-pane-pending-selection.ts and tui-pane-transcript.ts; keep the post-merge-review rows, which are a separate mechanism.
- docs/cli.md drops `queue`, `queue --cancel` and `queue --top`; no other docs change here.

**Files touched.** src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts

**Acceptance criteria.**
- `tumwater queue` and its `--cancel`/`--top` flags are gone from the parser, help, completion and docs; `grep -rn 'moveQueuedMergeToTop\|cancelQueuedMerge\|renderMergeQueue' src/` prints nothing.
- Neither dashboard nor TUI offers a queue cancel/top control, and no TUI key binds one.
- The queue reader (`readMergeQueue`), the post-merge-review views and the doctor/status queue reads still work.
- `npm run test:gate` passes.

**Tests.** Delete test/cli-queue.test.ts, test/cli-queue-follow.test.ts, test/gui-queue-cancel.test.ts, test/gui-queue-top.test.ts, test/merge-cancel.test.ts and test/merge-top.test.ts with their subjects; trim test/tui-pane-pending.test.ts and test/tui-operator-keys.test.ts to the surviving post-review rows and keys. Run the surviving touched files and the gate.

### Subtract, part 3e/7: A run's merge pin is merged directly, without a queue entry (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3d/7 landed; touches src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts)

**Goal.** New work stops writing a durable queue entry: a run pins its commit by `refs/tumwater/landing/<role>` and the orchestrator merges that pin on a poll. The queue reader still drains files an older build left, so the two paths coexist until part 3f deletes the queue.

**Approach.**
- In run-stage.ts, replace the `enqueueMerge` block with the pin only: after `pinAndReset`, log `merge_queued` with the commit and summary and end the run `queued` exactly as today; `heldOnBranch` still checks an existing pin. Remove the queue-entry construction from the fresh path; keep the revision trailer on the commit so a recovered pin still carries its round.
- In runner-leftover.ts, replace the `enqueueMerge` call with the same pin-only return (`{ kind: "pinned", sha, summary }`): adopt an unpinned branch tip into the merge ref as today, but write no queue file. Keep stale/dangling pin cleanup, the conflict hand-back and `MERGE_CONFLICT_LIMIT`.
- Add the pin merge to orchestrator-poll.ts: for each runner with `hasUnmergedPin` and no in-flight merge, read `recoveredMetadata` for the pinned sha and call the merge path (`mergeApprovedChange`) under the existing merge lock; a merged pin is deleted, a conflicting pin is kept for the existing leftover/conflict hand-back path, and a pin main already contains is dropped.
- docs/how-it-works.md's Merge section says a pin is the waiting state; the durable queue is legacy input only.

**Files touched.** src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts

**Acceptance criteria.**
- A fresh run that commits writes a pin and no `.tumwater/merge-queue/` file; its log path is still `merge_queued → merged` and its change reaches main after its one gate check, with no second check.
- A pin left by a crash or an earlier build is merged on the next poll; a pin whose commit main already contains is deleted without merging.
- A conflicting pin is kept once and hands back to its author at `MERGE_CONFLICT_LIMIT`, not retried forever.
- Old queue files still drain through the pre-3e path until part 3f removes it.
- `npm run test:gate` passes.

**Tests.** New test/orchestrator-merge-pin.test.ts: a pin is merged on a poll, a stale pin is dropped, a conflict keeps the pin and records the streak. test/run-stage.test.ts: a committed run pins and enqueues nothing. test/runner-leftover.test.ts: recovery adopts a tip into the pin and writes no queue file. Run those files and the gate.

### Subtract, part 3f/7: The durable merge queue and its status/doctor readers go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3e/7 landed; touches src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts)

**Goal.** With part 3e writing no queue file, the queue, its pipeline, slot and requeue modules are dead state. Delete them and re-point every reader at the pin/in-flight marker: status shows a role's waiting pin, the doctor drops the two merge-queue rows, and `once --once` waits on no in-flight merge instead of an empty queue directory.

**Approach.**
- Delete src/merge/merge-queue.ts, merge-drain.ts, merge-pipeline.ts, merge-slot.ts and merge-requeue.ts; move the one in-flight marker type/reader the new pin path and post-review drain still need into a small module beside merge-core.ts, and delete `.tumwater/merge-queue/` handling (`mergeQueueDir`, `legacyLandQueueDir`, the startup migration step) from src/paths.ts and startup-migration-steps.ts.
- status-data.ts's `readMergeQueue` block and `queuedRoles` become the pin/in-flight set; status-roles.ts and status-polls.ts read that set. Delete the queue header badge, the queue depth and the per-role queued row that name a now-nonexistent directory.
- doctor-backlog.ts loses `checkStaleQueuedMerges` and `checkMergeQueueFiles`; doctor-check-names.ts drops `stale merge-queue entries` and `merge-queue files`; doctor-holds.ts reads the in-flight/pin set instead of the queue.
- gate-polls.ts and scheduling/once-round.ts read the in-flight/pin state for their `queued` counts instead of `queuedMergeRoles`/`queuedMerges`; once-round's `queuedMerges: number` becomes the pin count.
- events/event-notify.ts drops notifications that name queue files (`unreadable queue files`, `merge-queue file`), keeping `merge_queued`/`merged`.
- docs/how-it-works.md removes the queue directory, stages and queue doctor rows, describing pins and the in-flight marker instead.

**Files touched.** src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts src/paths.ts src/orchestrator/startup-migration-steps.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts

**Acceptance criteria.**
- `grep -rn 'merge-queue\|mergeQueue\|queuedMerges\|readMergeQueue\|mergeQueueDir' src/` finds no live queue path; `docs/how-it-works.md` names no queue directory or stage.
- `tumwater status` shows each waiting role's pin and in-flight merge; the doctor's `stale merge-queue entries` and `merge-queue files` rows are gone rather than warning about a path nothing writes.
- `once --once` treats a waiting pin as unsettled work and exits only after its merge settles, the same way it treated a non-empty queue.
- No module imports a deleted merge-queue/merge-drain/merge-slot/merge-requeue file; the compiler is clean.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-queue.test.ts, test/merge-requeue.test.ts, test/merge-slot.test.ts and the queue-specific cases in test/merge-pipeline*.test.ts; update test/status-data.test.ts, test/status-roles.test.ts, test/doctor-checks.test.ts and test/once-round.test.ts to pins/in-flight. Run those files and the gate.

### Subtract, part 3g/7: Docs and invariants say one lock, linear history and a post-landing check (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3f/7 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts)

**Goal.** The live prose and the invariant bindings describe the landing that exists after parts 3a–3f: a pin, a rebase under the merge lock, a fast-forward, and the main watch's post-landing full check. No sentence promises queue stages or an approval step; the pre-merge gate keeps its build check (user, 2026-11-01), so the docs keep saying so.

**Approach.**
- Sweep the queue vocabulary out of docs/how-it-works.md, docs/invariants.md and docs/glossary.md: merge queue, queue stage, verify/approval stage, batch/bisect (already gone), retry/requeue, queue depth and queue cancel/top.
- In docs/invariants.md, drop or re-scope every binding to a deleted module (`merge-queue`, `merge-verify`, `merge-batch`, `merge-slot` stages, `merge-requeue`) and state the surviving guarantees: one merge writer under one lock, linear history, a deleted pin on merge and the main watch's post-landing checks as docs/how-it-works.md states their cadence at the time (amended 2026-11-01 by the operator: the pre-merge gate keeps its build check, and the Hourly full check series moves main's full check to at most hourly on the latest tip, so this part must not restate "a full check per commit"). Keep the conflict-hand-back and review-gate bindings that still have code.
- README's status line stays as is; remove any queue wording elsewhere in README.
- Re-check docs/invariants.md's file-to-test bindings: every remaining binding names a file and a test that still exist; the invariants-doc test enforces it.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts

**Acceptance criteria.**
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` finds no claim about a mechanism parts 3a–3f deleted (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every docs/invariants.md binding that names a merge module names a file and a test that still exist; deleted-module INVs are gone, not re-pointed.
- The surviving prose says: a change is pinned, gated (the diff rules and the declared gate command), merged by rebase and fast-forward under the merge lock, and covered on main by the main watch's full check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/merge-backlog-conflicts.test.ts whole, then the project's gate, and confirm green.

### `tumwater role <id>` gains `-f/--follow`, repainting one role's inspection view until Ctrl+C or its parent exits, so an operator watching a role sees its last run, spend and next-run schedule move without rerunning the command (planned 2026-11-03 by the plan role; continues the landed follow-view family — `status`, `report`, `logs`, `history`, `queue`, `reviews`, `quarantine`, `backlog`, `diff`, `prompt --list` and `questions` all follow through `followView` in src/cli/follow-view.ts, and `role <id>` is the remaining per-entity inspection view with no live form; independent in file of every `## Planned` entry — before this entry `awk '/^## Planned/,/^## Done/' PLANS.md | grep -c 'cli-role-command\|cmdRole'` prints 0, and no waiting heading or touches list names src/cli/cli-role-command.ts or test/cli-role-follow.test.ts (the in-flight plan/bug `--list` follow takes src/cli/backlog-cli-view.ts, and the in-flight doctor follow takes src/cli/cli-doctor-command.ts; all three touch src/cli/help.ts and docs/cli.md in different stanzas and rows, so whichever lands second rebases there); PLANS-DONE.md holds no `tumwater role` follow plan — `grep -cE '^### .*tumwater role.*follow|^### .*role <id>.*follow' PLANS-DONE.md` prints 2, but both are unrelated (`diff --role <id>` and shell completion's `role <id>`); docs/invariants.md names neither `cmdRole` nor src/cli/cli-role-command.ts (`grep -c 'cmdRole\|cli-role-command' docs/invariants.md` prints 0), so its bindings stay unchanged; touches src/cli/cli-role-command.ts src/cli/help.ts docs/cli.md test/cli-role-follow.test.ts)

**Goal.** `tumwater role <id>` prints one role's standing and next-run prompts, resolved settings, notes, recent runs, spend and schedule, then exits. An operator watching a live team has no live form: a role moving from sleeping to working, a run landing, or its spend and next-run time changing stays invisible until the command is rerun, even though every sibling inspection and list view has a follow view. Add `-f/--follow` so the same document repaints every couple of seconds until Ctrl+C or the parent process exits. The live form is read-only: `--json` and every write flag keep their one-shot forms and are refused with a follow.

**Approach.**
- src/cli/cli-role-command.ts: `cmdRole` takes an optional third `seams: FollowViewSeams = {}` parameter (the `cmdStatus`/`cmdQuestions` shape; src/cli.ts's two-argument call stays unchanged). `rejectUnknownArgs("role", rest, [...])` admits `FOLLOW_FLAG` from src/cli/cli-flag-specs.ts, and `hasFollowFlag(rest)` decides the mode.
- Resolve the id and parse the write flags before branching, as today. With follow plus `--json`, fail before any output with the sibling wording that one document is not a live view. With follow plus any write flag `parseWriteFlags` reports, fail naming that flag and saying a follow is read-only, so no repaint can write config repeatedly.
- Before the follow loop, call `rolePayload(root, id)` once outside the loop so an unknown id throws the same `unknownRoleMessage` the one-shot form prints instead of being swallowed frame by frame by `followView`'s per-frame catch. Then, with no write flag, `await followView(() => renderRoleMarkdown(rolePayload(root, id)), seams); return;`. Each frame re-reads config, runner state, events and notes, so the role's last run, spend and next-run schedule are current, and `followView` already serializes a slow frame.
- A follow that ends by Ctrl+C or parent death returns normally, leaving `process.exitCode` untouched. The one-shot read path keeps `sayJsonOrRender(rest, () => rolePayload(root, id), renderRoleMarkdown)`, its exact text and JSON, and every write dispatch unchanged.
- src/cli/help.ts: the `tumwater role <id> [--json]` usage spelling gains `[-f/--follow]`, and the description gains one clause — repaints the same view every couple of seconds until Ctrl+C or the parent exits, and refuses `--json` and every write flag because the live form is read-only. docs/cli.md's "Watch, check, steer, control, audit" table gains a "Watch one role" row naming the same form and refusal rule.

**Files touched.** src/cli/cli-role-command.ts src/cli/help.ts docs/cli.md test/cli-role-follow.test.ts

**Acceptance criteria.**
- `tumwater role feature -f` and `tumwater role feature --follow` print the role's document once, then repaint it every couple of seconds until Ctrl+C or the process that started them exits; a field that changes between frames (for example the role's notes block after its notes file is rewritten, or its last-run line after a run ends) shows the new value in the next frame. On a TTY each frame clears the screen; a piped follow separates frames with a blank line.
- `tumwater role feature -f --json` exits 1 with a message naming the conflict and prints no frame, clear-screen escape or JSON document. `tumwater role feature -f --notes-file <path>`, and the same with `--clear-notes`, `--cap`, `--model`, `--enable` or any other write flag, exits 1 naming the write flag, performs no write and prints no frame.
- `tumwater role nosuchrole -f` exits 1 with the same unknown-role wording the one-shot `tumwater role nosuchrole` prints, rather than starting a loop.
- A follow that ends by parent death exits 0; the one-shot forms keep their existing exit codes and output.
- Without a follow flag, `tumwater role <id>`, its `--json` form, every write flag and their combinations print exactly the text or JSON and exit code they print today, and `role --verbose` still fails as an unknown argument.
- `grep -n 'tumwater role <id> \[-f/--follow\]' src/cli/help.ts docs/cli.md` finds the usage spelling in both files.
- `npm run test:gate` passes.

**Tests.** New test/cli-role-follow.test.ts, modelled on test/cli-questions-follow.test.ts and test/status-follow.test.ts: drive `cmdRole` in-process with `FollowViewSeams` and node:test's mocked `setInterval`, proving the first frame, repeated repaints, a notes/last-run change between ticks visible in the next frame, the TTY clear-screen versus piped blank-line shape, the parent-death exit with `process.exitCode` left at 0, the unknown-role failure, and the `--json` plus write-flag refusals. Run that file and the gate.

## Done
