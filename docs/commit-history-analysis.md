# Commit-history analysis: how a fleet-built history differs, and what it says to change

**Effective date: 2026-09-29.** Git data runs through main `53745873` (1,905 commits,
2026-08-20 → 2026-09-29). Fleet data comes from `.tumwater/log/events.jsonl` (19,559 events,
3,827 ticks) through 2026-09-29 01:10 PDT. Every number below describes that snapshot; the fleet
lands ~50–200 commits a day, so re-derive them before relying on them later (the method is at
the end). A human-directed Claude Code session did this analysis. The changes it recommends are
filed in [PLANS.md](../PLANS.md) `## Planned` and [BUGS.md](../BUGS.md) `## Open`, and are listed
by title [at the end](#filed-changes).

## Two windows

The fleet changed a lot in forty days. It moved from LM Studio to oMLX, then to a budgeted
hosted model with a local fallback. It also gained a landing pipeline on 2026-09-24. A number
averaged over the whole history can therefore describe a fleet that no longer exists. This
report quotes two windows:

- **All time**, 2026-08-20 → 09-29. Best for the git-history shape.
- **Last 7 days**, 2026-09-22 → 09-29, on the current hosted model and landing pipeline. Best for
  what to fix now.

## How the history differs from a human-authored one

1. **Volume and rhythm.** About 48 commits a day, peaking at 218 (09-25) and 197 (09-28) once the
   landing pipeline landed. Commits are spread flat across all 24 hours, with no workday,
   weekend, or overnight gap.

2. **Tiny, single-purpose commits sorted by role.** Each role has a consistent size:

   | role | commits | avg lines +/− | files/commit |
   |---|---|---|---|
   | clean | 163 | +4 / −4 | 1.4 |
   | readme | 231 | +7 / −5 | 1.1 |
   | coverage | 208 | +74 / −1 | 1.1 |
   | dry | 199 | +31 / −29 | 3.0 |
   | feature | 126 | +253 / −49 | 6.9 |
   | human (unprefixed) | 116 | +238 / −78 | 6.5 |

   A human project mixes concerns in one commit. It does not produce hundreds of commits of the
   form "un-export one interface".

3. **The work mix is inverted.** Features are 7% of fleet commits (5% in the last 7 days). The
   maintenance roles (readme, coverage, dry, clean, organize) make up ~56% (57% in the last 7
   days). In a human project, features and fixes dominate.

4. **Bookkeeping dominates.**
   - 500 of 1,817 non-merge commits touch only PLANS.md, BUGS.md, or README.md, and those are the
     three most-touched files in the repo (351, 328, and 307 commits).
   - **readme:** 184 of its 231 commits re-stamp the README's `Current main (<sha>): build
     clean, suite N/N` line. The rate is rising: 17 in August, then 43, 22, 42, and 60 per week.
     In the last 7 days readme made 9% of all commits. Only 21 of the 1,507 lines it ever wrote
     survive in the tree (1%).
   - **plan:** 113 of its 193 commits re-audit or refine an existing plan ("re-audit … after 95
     landings of drift"). In the last 7 days that was 16 of 45. The plans cite line numbers
     (`src/cli.ts … (lines 132-140)`), and every landing moves them.

5. **Over-specified commit messages.** Subjects average 88 characters. 86% are longer than 72,
   and 11% are cut off with "…". Bodies follow a model-written WHY / RISK / VERIFIED template
   plus a harness-written `Tick:` trailer. That is more rigor than most humans apply. The
   VERIFIED line, however, is also the part the reviewer most often finds wrong (see below).

6. **Corrections happen in public, as new commits.** Humans amend or squash. The fleet lands
   follow-ups instead:
   - "Redo the rejected review-gate test factoring…"
   - "Remove PLANS.md's stray duplicate heading left by commit 3251fd9a"
   - "Rewrap the two orphaned continuation lines the fan-out commit left"

   Each follow-up pays for a full tick, gate check, and landing.

7. **The structural changes came from humans.** Human commits are 6% of the count and 18% of the
   surviving tree. They include the landing pipeline (09-24), the 91 → 36 s suite (09-25), and
   the launchservicesd port leak (09-28). Most came from reading the fleet's logs, not from any
   loop.

**Line survival** (git blame on src/, test/, and *.md) by the role that wrote the line:

| role | survival |
|---|---|
| feature | 49% |
| human | 54% |
| bugfix | 59% |
| coverage | 69% |
| plan | 40% |
| director | 4% |
| readme | 1% |

organize's 77% is inflated because blame does not follow moved code. Moves credit the lines to
organize and slightly understate everyone else.

## What the tick logs add

### All time (1,967 agent-hours of wall-clock tick time; ticks run concurrently)

| outcome | hours | share |
|---|---|---|
| changed | 731 | 37% |
| queued (landing pipeline) | 228 | 12% |
| error + aborted + quiet_killed | 618 | 31% |
| no_change | 300 | 15% |

Most all-time infrastructure loss belongs to the local-model era: context-ceiling cut-offs,
oMLX memory-guard aborts, and model-load failures. None of those recur in the last 7 days.

### Last 7 days (199 agent-hours, $29.32 spent on the hosted model)

- **Infrastructure loss: 63 h, 32%.** Nearly all of it is one episode. From 2026-09-22 14:35 to
  22:42 PDT, every one of the 14 roles timed out at the 1800 s `tickTimeoutSeconds` default: 97
  ticks, about 55 agent-hours. A timed-out tick discards its worktree edits (a quiet kill keeps
  them), so all of that work was thrown away. The operator's workaround was to raise
  `tickTimeoutSeconds` to 54000. Since then, **29 ticks have landed work after running past 30
  minutes** (the longest ran 185 min), and each of them would have been discarded under the
  default. That workaround in turn removes the only bound on a run that never emits a byte. Both
  problems are filed as bugs.
- **Nothing-to-do spend: $6.49 of $29.32 (22%).**
  - **perf** spent $1.17 on 41 empty ticks against $0.48 on its 15 landings.
  - **qa** spent $0.38 on 23 empty ticks for 2 landings.
  - **bugfix** spent $2.27 on 133 empty ticks while BUGS.md `## Open` was empty. It is a work
    role, so it is never deferred and wakes on every main move.
  - **feature**'s 214 empty ticks cost only $0.003 each. An empty PLANS.md is cheap to read.
- **Review: 151 of 686 reviews rejected (22%).** A keyword pass over the reasons (rough;
  overlapping categories) found:
  - ~116 reject weak, missing, or duplicate tests;
  - ~113 cite a claim in the record that the diff disproves (a VERIFIED count, a PLANS or BUGS
    note, a misattribution);
  - ~51 name a real behavior bug;
  - 9 reject formatting.

  The second class includes facts the harness already knows (the SHA, the suite counts), but it
  asks the model to restate them.
- **The gate check and the reviewer cost about 23 h and 21 h of wall-clock** over the 7 days.
  Because `*.md` and `docs/**` are exempt from review, readme's 61 landings cost only 0.2 h of
  checks. The restamps' cost is in history noise, ticks, and landing slots, not in review.

## What to change

The changes are ranked by how much they would have recovered in the last 7 days.

1. **Keep a slow run's work when it times out.** The 09-22 timeouts discarded ~55 agent-hours in
   one evening, which is more than a week of no_change spend. A timed-out tick should resume, as
   a quiet kill already does. The default timeout should also fit the model that is actually
   serving. Separately, the zero-byte run needs a bound of its own that does not depend on
   `tickTimeoutSeconds`.
2. **Stop running search roles on a timer when they have stopped finding things.** Two changes:
   - bugfix should defer like maintenance whenever BUGS.md has nothing open.
   - Every search role's clock should stretch with its recent yield, so perf and qa tick less
     often while they keep landing nothing.
3. **Let the harness state the facts it already knows.** Parse the `node --test` summary the gate
   check already produces (`ℹ tests 2066 / ℹ pass 2065 / ℹ fail 0 / ℹ skipped 1`) and give it to
   the reviewer. The VERIFIED contract then no longer needs the model to restate counts. This
   removes a whole class of rejections.
4. **Retire the README freshness stamp.** It is volatile state in a committed file: 60 commits
   this week at 1% survival. `tumwater status` can report main's last green check instead
   (depends on 3).
5. **Replace mechanical loop work with deterministic checks.** 28 of clean's 67 commits this week
   un-exported a symbol nothing else uses. A zero-dependency test that fails on such an export
   catches it in the author's own gate check. clean then never needs a tick for it. Right now the
   tree has zero violations, so the check is purely a regression guard.
6. **Plan just in time.** Don't refine plans while they wait; add the next one when feature is
   about to need it. Anchor plans on symbol names rather than line numbers so landings don't make
   them drift.
7. **Measure time, not just counts.** The failure digest counts ticks by outcome, so a 200 ms
   error and a 30-minute timeout weigh the same. `tick_end` should carry `durationMs`, and the
   digest should rank agent-hours and dollars lost by cause and role. This analysis had to pair
   `tick_start`/`tick_end` by hand, and telemetry would have seen the 09-22 episode as 97
   identical errors instead of 55 lost hours.
8. **Hold the fleet on shared backend failures, not only 429s.** The 429 storm hold
   (src/rate-limit-hold.ts — shipped 2026-09-29 as the generalized src/fleet-hold.ts) is the
   only cross-role failure response. "Connection error.", 5xx,
   "Request timed out", and model-load failures each fail every role separately. This mattered
   most in the local-model era (~100 such ticks all time, 7 in the last week), so it ranks last.

## Filed changes

PLANS.md `## Planned`:

- *Bugfix defers like a maintenance role while BUGS.md has no open bugs*
- *Yield-scaled clocks: a search role whose recent ticks land nothing ticks less often*
- *Harness-attested suite counts: parse the gate check's `node --test` summary and hand it to the
  reviewer*
- *Retire the README freshness stamp: `tumwater status` reports main's last green check*
- *A deterministic unused-export check in the suite*
- *Plan just in time: stop refining while plans wait, and anchor plans on symbols*
- *Time and spend by outcome in the failure digest*
- *Fleet-wide backend-failure hold: extend the 429 storm hold to connection, 5xx, and model-load
  failures*

BUGS.md `## Open`:

- *A tick that reaches tickTimeoutSeconds discards its worktree edits and session, while a quiet
  kill resumes them*
- *At a raised tickTimeoutSeconds a run that never emits a byte has no watchdog*

## Method (to re-derive)

- **Roles:** from the commit subject prefix (`tumwater(<role>):` or `automaton(<role>):`).
  Anything else is "human", and `Merge branch …` subjects are merges.
- **Sizes:** `git log --no-merges --numstat`.
- **Survival:** `git blame --line-porcelain -w` over `git ls-files src test '*.md'`, joined to
  each commit's role and compared with the lines that role added.
- **Tick time:** each `tick_end` paired with its `tick_start` by (loop, tick), and the difference
  summed by result.
- **Spend:** the `costUsd` field on `tick_end`. Local-model ticks record no cost, which is why
  all-time spend is only $52.
- **Review themes:** keyword matching over `review_rejected.reasons`. Treat them as rough.
