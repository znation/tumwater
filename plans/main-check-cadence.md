# Main's full check runs hourly; failures are found and fixed by re-running only them

Planned 2026-11-01 · requested by the user, after asking whether main now re-runs only its
failures:

> "I think we should relax the once per main commit (for non-gate tests) and make it more like
> once per hour on latest main. Then when fixing failures, re-run only the failed tests."

and, of a change the gate rejected for a test it broke: "'gate' is aptly named — it should gate
each commit."

## Today (measured 2026-11-01 01:00 PST, the 24 h before)

- The main watch (src/baseline/main-watch.ts) runs the full check (`check.command`, `npm test`
  here) on every new main head, one run in flight, a head that moved during a run watched next.
  The redeployer's own green checks were cut back by 568526a12 and 30d968e0e.
- 104 full runs in 24 h, 421 min of wall time (p50 193 s, max 931 s; 1,180–1,377 s at the
  10-30 load peak), for 66 first-parent commits on main and 53 `main_check` verdicts.
- Since 9f8fe8be7, a red is confirmed, and the ci healer checks its fix, by re-running only the
  failing tests (`check.rerunCommand`, `npm run test:rerun`): 19 such runs, p50 14 s, max 15 s.
- While main is red, every new head still gets a full run. A red found on a head covering several
  commits names that head's commit as the culprit; nothing narrows it further.

## Decision

1. **Every commit still gets the gate's tests, once, by the main watch.** Subtract part 3b/7 (in
   flight, claimed by feature-2 on 2026-11-01, left as written at the user's direction: "leave
   it alone and put new plans on top") deletes the pre-merge build check. With it gone, the
   watch runs the gate command (`check.gateCommand`: the affected tests within the 30 s budget
   here) on each new main head, over the commits since the last head it checked. That is the
   per-commit check; it is what "gate each commit" keeps after 3b/7.
2. **The full check runs at most once an hour, on main's latest tip.** Its interval is
   `check.fullIntervalMinutes` (default 60; `0` restores a full run per head). A due run starts
   only when main has a code commit its newest full verdict does not cover (a doc-only tip still
   inherits green), and it runs in its own mirror worktree so the per-commit gate checks never
   queue behind a 3–20 min suite. The due time comes from the newest full verdict's recorded
   time, so a restart does not add a run.
3. **Failures are found and cleared by re-running only the failing tests.** A red (full or
   per-commit) is confirmed by re-running its failing tests (as today). Its opener is found by
   bisecting the first-parent code commits since the last green for those tests alone, so the
   culprit is a commit, not "everything this hour". While the red is open, each new head re-runs
   only the open failures. When none fail any more, the red closes as *cleared*, which brings the
   next full run forward to start at once rather than at the hour.
4. **Redeploy rules stay.** The redeployer targets the newest commit with a green *full* verdict
   (`redeployTarget`'s watched branch); the user decided on 2026-11-01 that redeploy keeps waiting
   for a green main. A cleared red records no full green, so the team's build moves when the full
   run that the clearing brought forward comes back green. The build lags main by up to an hour.

## What this supersedes

- Subtract part 3b/7's goal ("main has exactly one full check per merged commit, the main watch's
  post-landing one") and acceptance criterion ("the main watch's post-landing `build_check` still
  runs for every merged tip") hold until part 1/3 below lands, which replaces them with the
  per-commit gate check plus the hourly full check. 3b/7 is in flight, so its text is unchanged.
- Subtract part 3g/7 and plans/subtract.md "How we will know it worked" said "a post-landing
  check per commit" and "`build_check` events per merged commit fall to 1": both are amended
  (2026-11-01) to say the per-commit check is the gate command and the full check is hourly.
- The user's 2026-10-31 direction behind 9f8fe8be7 (a red main blocks nobody, the full suite at
  most once per main commit) is relaxed on cadence only. Its other half, re-run only the failing
  tests, is kept and extended to bisection and to every head while main is red.
- Consistent with plans/post-merge-fix-forward.md "Decision" item 4 (2026-10-24): "the full
  suite and e2e stay the `ci` role's own cadence". The per-commit full run was drift from that.

## Risks

- **A failure only the full suite sees surfaces up to an hour later.** The hourly run covers
  more commits per verdict, so the bisection in part 2/3 is what keeps the culprit precise. It
  costs about log2(commits) runs of a few seconds each.
- **Roles' `<main-known-red>` note and the alerts lag.** They read the newest verdict, which can be
  an hour old; part 3/3 makes the surfaces say how old it is and when the next one is due.
- **A gate command run on main must be told what changed.** `--affected` diffs against its
  merge-base with `main`, which on main's own tip is empty. Part 1/3 passes the previous checked
  head as the base (`TUMWATER_CHECK_BASE`). A project's gate command that ignores it runs its
  ordinary selection: project-neutral, and no worse than a no-op.

## Series

"Hourly full check", parts 1/3–3/3 in PLANS.md:

| Part | What it does | Requires |
| --- | --- | --- |
| 1/3 | The watch runs the gate command per new head and the full check at most hourly on the latest tip, in its own mirror | Subtract part 3b/7 |
| 2/3 | Bisect a red's opener, re-run only the open failures on each new head, and bring the full run forward when a red clears | part 1/3 |
| 3/3 | Status, doctor and the dashboard say how old main's full verdict is and when the next is due | part 2/3 |

## How we will know it worked

- `build_check` events with scope `baseline` fall from ~100/day to ≤ 24/day plus one per cleared
  red; per-commit `gate`-command checks on main stay ≈ one per commit (p50 ≈ 25 s).
- No full run starts while main's newest full verdict is under an hour old, except right after a
  red clears.
- A red found by an hourly run names a single commit as culprit, the same one a full run of
  each commit would have named.
