# Main's full check runs hourly; failures are found and fixed by re-running only them

Planned 2026-11-01 · requested by the user, after asking whether main now re-runs only its
failures:

> "I think we should relax the once per main commit (for non-gate tests) and make it more like
> once per hour on latest main. Then when fixing failures, re-run only the failed tests."

Of a change the gate rejected for a test it broke, the user also said: "'gate' is aptly named — it should gate each commit." Asked whether Subtract part 3b/7 should still remove the
gate's build check, they answered: "No, keep the gate." A separate session is looking at pruning
`test:gate` toward a 10 s run.

## Today (measured 2026-11-01 01:00 PST, the 24 h before)

- Every change passes the pre-merge gate: the diff rules, then the declared gate command
  (`check.gateCommand`, `npm run test:gate`: compile, changed-file lint and the affected tests
  that fit a 30 s budget). Its p50 was 22–29 s on 10-30.
- The main watch (src/baseline/main-watch.ts) runs the full check (`check.command`, `npm test`)
  on every new main head, one run in flight, a head that moved during a run watched next. The
  redeployer's own green checks were cut back by 568526a12 and 30d968e0e.
- 104 full runs in 24 h, 421 min of wall time (p50 193 s, max 931 s; 1,180–1,377 s at the
  10-30 load peak), for 66 first-parent commits on main and 53 `main_check` verdicts.
- Since 9f8fe8be7, a red is confirmed, and the ci healer checks its fix, by re-running only the
  failing tests (`check.rerunCommand`, `npm run test:rerun`). There were 19 such runs, p50 14 s,
  max 15 s.
- A gate check that fails twice is attributed through the watch (7344a68d8). If the watch has no
  verdict covering the change's base, the change is kept as `main_red` for up to 15 minutes.
- While main is red, every new head still gets a full run. A red found on a head covering
  several commits names that head as the culprit; nothing narrows it further.

## Decision

1. **Each change is checked once, before it lands, by the gate.** The gate keeps its build check
   (Subtract part 3b/7, which deleted it, is withdrawn). These are the gate tests the user's
   "for non-gate tests" leaves per-commit.
2. **A twice-failed gate check asks main's tip about exactly its failures, at once.** Its named
   tests are re-run alone on main's tip; a failure that names no test runs the gate command
   there. Tests failing on main too are main's, and the change goes on to review; any other
   failure rejects the change. Nothing waits on the watch, and no change is kept as `main_red`.
3. **The full check runs at most once an hour, on main's latest tip.** Its interval is
   `check.fullIntervalMinutes` (default 60; `0` restores a full run per head).
   - A due run starts only when main has a code commit that its newest full verdict does not
     cover. A doc-only tip still inherits green.
   - It runs in its own mirror worktree, so the gate's re-runs on main's tip and the per-head
     diff rules never queue behind a 3–20 min suite.
   - The due time comes from the newest full verdict's recorded time, so a restart does not add
     a run.
4. **Failures are found and cleared by re-running only the failing tests.**
   - A red is confirmed by re-running its failing tests, as today.
   - Its opener is found by bisecting the first-parent code commits since the last green, re-running only those tests, so the culprit is a single commit rather than "everything this hour".
   - While the red is open, each new head re-runs only the open failures.
   - When none fail any more, the red closes as *cleared*, and one full run starts on that head at once to confirm it.
5. **Redeploy rules stay.** The redeployer targets the newest commit with a green *full* verdict
   (`redeployTarget`'s watched branch). The user decided on 2026-11-01 that redeploy keeps waiting
   for a green main. A cleared red records no full green; the team's build moves when the
   confirming full run is green, and otherwise lags main by up to an hour.

## What this changes in other plans (2026-11-01)

- **Subtract part 3b/7** (pre-merge verify stops running the build check) is withdrawn, at the
  user's direction. feature-2 had claimed it; its one run was aborted with nothing committed.
- **Subtract part 3c/7** now requires Hourly full check part 1b/4 instead of 3b/7. Its merge step
  runs the gate, both the diff rules and the build check, outside the merge lock.
  **Parts 3e/7 and 3g/7** say a change reaches main after its one gate check, and the docs keep
  the pre-merge check.
- **Every commit is verified on main parts 4j/3 and 4k/3** (remove the `main_red` verdict) now
  require Hourly full check part 1b/4 instead of 3b/7: that part is what leaves the gate with no
  `main_red` path.
- **plans/subtract.md** stroke 3 and "How we will know it worked" are amended: the one check per
  change is the gate's, before landing, and the full check runs hourly.
- The user's 2026-10-31 direction behind 9f8fe8be7 (a red main blocks nobody; the full suite at
  most once per main commit) is relaxed on cadence only. Its other half, re-running only the
  failing tests, is kept and extended to gate attribution, bisection and every head while main is
  red.
- This is consistent with plans/post-merge-fix-forward.md "Decision" item 4 (2026-10-24): "the
  full suite and e2e stay the `ci` role's own cadence". The per-commit full run was drift from
  that.

## Risks

- **A failure only the full suite sees surfaces up to an hour later.** That covers a test outside
  the gate's selection, or two changes that each passed the gate but break together after the
  rebase. The hourly run covers more commits per verdict, so the bisection in part 3/4 is what
  keeps the culprit precise. It costs about log2(commits) runs of a few seconds each. A smaller gate (the 10 s target) leaves more to this path.
- **Roles' `<main-known-red>` note and the alerts lag.** They read the newest verdict, which can
  be an hour old. Part 3/4 narrows the open set on every head, and part 4/4 makes the surfaces say
  how old the verdict is.
- **Main's tip is judged by a test re-run, not a full check, when a gate fails twice.** A test
  that is flaky on main can be blamed on main once, letting a change through; the hourly run and
  the quarantine catch it, as they do today.

## Series

"Hourly full check", parts 1a/4–4/4 in PLANS.md:

| Part | What it does | Requires |
| --- | --- | --- |
| 1a/4 | The gate restores its build check and asks main's tip about its own failures at once; no watch wait | — |
| 1b/4 | The dead watch-wait and `awaitingWatch` plumbing is removed; no `main_red` producer remains | part 1a/4 |
| 2/4 | The full check runs at most hourly on the latest tip, in its own mirror | part 1b/4 |
| 3/4 | Bisect a red's opener, re-run only the open failures on each new head, and confirm a cleared red with one full run | part 2/4 |
| 4/4 | Status, doctor and the dashboard say how old main's full verdict is and when the next is due | part 3/4 |

## How we will know it worked

- `build_check` events with scope `baseline` fall from ~100/day to ≤ 24/day plus one per cleared
  red.
- A twice-failed gate settles within its targeted re-run (seconds), never as `main_red`.
- No full run starts while main's newest full verdict is under an hour old, except to confirm a
  cleared red.
- A red found by an hourly run names a single commit as culprit, the same one a full run of each
  commit would have named.
