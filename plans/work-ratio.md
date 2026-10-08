# Work ratio — more features and fixes per commit; new projects build before they tidy

Planned 2026-10-08 · requested by user. The dashboard's "Landed today" tile read "64 commits ·
4 features done · 2 bugs fixed", and the user said there should be "many more features and bug
fixes for that many commits". They also asked that a project fresh from `tumwater init` in an
empty repo run "just the feature and plan loops a bit first, until the project is established".

This doc holds the shared design for the four `Work ratio N/4` entries and the two
`New-project bootstrap N/2` entries in PLANS.md. Nothing here reads project code; it relies only
on the harness's events and backlog markdown, so it works for any language.

## The numbers (this repo's live fleet, from main and .tumwater/log/events.jsonl)

| day   | commits | feature+bugfix commits | plans done | bugs fixed | commits per item |
|-------|---------|------------------------|------------|------------|------------------|
| 10-04 | 227     | 50                     | 14         | 31         | 5.0              |
| 10-06 | 223     | 42                     | 19         | 23         | 5.3              |
| 10-07 | 335     | 42                     | 22         | 28         | 6.7              |
| 10-08 (partial) | 64 | 8                   | 4          | 2          | 10.7             |

Landings on 10-07 by role: clean 118, dry 65, improve 35, feature 23, robustness 21, bugfix 19,
coverage 14, organize 8, telemetry 7, plus about 10 from the remaining roles. Code-maintenance
roles landed 271 commits, about 6.3 for every work landing.

- **Clean commits were tiny.** The 118 clean commits averaged 1.1 files and +8/−7 lines, almost
  all doc-comment corrections and reflows. Five of them, each a separate tick, review, check and
  landing, fixed the same drift: stale `_land-<role>` comments left by Worktree pool 2d/5
  (814074e2, 808f4b85, 888f9d73, 5913a6a1, 6ce40875).
- **Nothing throttles a maintenance loop that always finds something.**
  - clean, dry, improve, coverage and robustness run on the global 20 s gap (src/config/config.ts
    `defaultConfig`).
  - The need-based deferral (src/scheduling/scheduling.ts `deferTickReason`) only fires after a
    `no_change` tick. clean returned `queued` on 128 of its 129 ticks, so it was never deferred.
  - Tier ordering (`fairOrder` plus the semaphore) decides who goes first, not how much
    maintenance happens. With six permits, maintenance fills every slot work leaves idle.
- **Maintenance volume still costs work throughput.** On 10-07 there were 627 build checks under
  `maxConcurrentChecks: 2`, and clean alone used 844 tick-minutes and 592 landing-minutes.
  Feature is single-flight (busy ~14 h of tick time), and its checks and reviews queue behind
  this volume.
- **The work tier's own cap** is single-flight per role plus a 44% feature landing-failure rate
  (18 of 41). Parallel work instances 5a/7–7/7 and revise-rejected already address it, so this
  plan does not.
- **The plan loop counts blocked entries.** Its charter (src/roles/role-catalog.ts, plan step 1)
  ends with nothing-to-do when `## Planned` "holds two or more plans", and entries tagged
  `[blocked: requires …]` count toward that. With 9 planned entries, of which only 3 were
  eligible, plan returned `no_change` on 19 of 21 ticks on 10-07. A feature series split into
  sequential parts can therefore starve feature while plan sits idle.

## Design

1. **Maintenance follows work (Work ratio 1/4).**
   - Code-maintenance landings in a rolling 24 h window are capped at
     `maintenancePerWorkLanding × work landings + 12`. The default for `maintenancePerWorkLanding`
     is 2.
   - Work landings are `merged` events from feature, bugfix and director.
   - Applied to 10-07: 43 work landings give an allowance of 98, against 271 actual maintenance
     landings. That is about 3.1 commits per item instead of 6.7.
   - The fixed floor of 12 keeps hygiene running on a project whose backlog is empty.
   - A held maintenance loop costs nothing. The idle permits go to work loops, or the fleet
     simply idles.
2. **Batch hygiene (Work ratio 2/4).**
   - A clean tick fixes one *kind* of drift everywhere it occurs, not one site.
   - It stays inside a reviewable size ceiling, so a sweep reviews in the time a small fix
     does.
   - This is still "one focused change per tick" (PRINCIPLES.md), focused on one theme.
3. **Keep feature fed (Work ratio 3/4).**
   - The plan loop's "two or more" target counts only entries feature could take now: not
     blocked, not Refused, and not marked Needs-review or Needs-replan.
   - Parallel work instances 5c/7 later scales the number; this part fixes what is counted.
4. **Make the ratio visible (Work ratio 4/4).**
   - Report `commits` by role and by tier (work vs maintenance).
   - The "Landed today" tile and `tumwater report` show "N work / M maintenance commits" next to
     the features and bugs, so the operator can see whether 1/4–3/4 worked.
5. **New-project bootstrap (1/2, 2/2).**
   - When `tumwater init` finds an empty project, it writes `"bootstrap": {"untilPlansDone": 5}`.
   - Until PLANS.md `## Done` holds 5 entries, only plan, feature, director, and bugfix with open
     bugs tick.
   - plan runs on the global gap instead of its 3600 s one.
   - Completion is latched in `.tumwater/`, so a later `## Done` compression by steward cannot
     re-enter bootstrap.
   - Existing codebases adopting tumwater never enter bootstrap.

## Target and how to check it

- On a day with at least 10 work landings, commits per backlog item (plans done plus bugs fixed)
  should be ≤ 3. It was 6.7 on 10-07.
- Feature landings per day must not fall. If the quota idles permits, feature should finish no
  slower.
- Re-measure a few days after Work ratio 1/4 and 2/4 are live:
  - the per-day table above, from main's `tumwater(<role>)` subjects and the PLANS.md/BUGS.md
    dates;
  - `maintenance_quota_hold` events;
  - clean's average diff size, which should be larger but fewer.
