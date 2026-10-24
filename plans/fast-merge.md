# Fast merge: roles stop waiting on their own change, and main's full check runs after merging

Planned 2026-10-19 · requested by user · not started

## Goal

Get a change from the end of its run onto main in minutes, and let every role spend its time
writing changes instead of waiting for the last one to merge.

Today tumwater treats main like a branch humans depend on: nothing merges until the full test suite
passes on the exact tree that will become main. Agents are good at fixing breaks and at merging, so
the expensive part is not a broken main; it is roles sitting idle while their change waits for that
proof, and changes going back through the whole pipeline for failures that were not theirs.

The new shape:

- A role queues its change and starts its next run at once. A change that fails later comes back to
  that role as a revision.
- Before merging, a change still passes lint, compile and its affected tests (`check.gateCommand`).
  The full check moves after the merge: tumwater runs it on main's tip, finds the commit that turned
  main red, reverts it, and hands it back to its author.
- A red main stops nobody. Each role's prompt lists the tests already failing on main and who owns
  them, and a change passes if it adds no new failures.
- A flaky test is quarantined the first time it fails and then passes on the same tree.
- A diff is reviewed once, not once per requeue or rebase.
- Self-redeploy only ever runs a commit whose full check is green.

## What the logs show

Window: `.tumwater/log/events.jsonl`, 2026-10-17 04:47 → 2026-10-19 12:48 (56 h, the team on
DeepSeek through HF Inference Providers). 344 changes merged. 2026-10-16 (Opus, few flakes) is the
comparison day.

| Measure | Value |
| --- | --- |
| Role time writing changes vs waiting on its own change | 178 h vs **268 h (60% waiting)**; 37% on 2026-10-16 |
| Runs writing code at any moment | 3.2 on average, against `maxConcurrent` 12 |
| End of run → on main | p50 10 min, **mean 51 min**, p90 79 min |
| The final, successful attempt alone | queued → approved p50 3.8 min, approved → main p50 3.0 min |
| Where pipeline time goes | 73% waiting, 16% review, 11% checks |
| Merge slot busy with in-lock checks | 24% of the window |
| Pipeline time spent in attempts that failed | **55%**: `merge_blocked` 79 attempts / 60 h, `review_error` 47 / 34 h, `rejected` 178 / 29 h, `merge_conflict` 6 / 22 h, `main_red` 24 / 3.5 h |
| Check failures not caused by the change | 33 of 46 gate-failure episodes and 24 of 38 merge-check episodes passed later with no code change |
| One flaky test | test/merger.test.ts "a green batch stacks every approved change…": **104 of 165** check-failure warnings since 2026-10-17, all on 2026-10-19 05:00–12:29, until a10e2ccfe fixed it |
| Review time spent on a diff that had not changed | **42%** (66 reviews after a requeue, 14.3 h; 40 after a clean rebase, 3.5 h) |
| Agents' own full-suite runs | 12% of author run time; 70 of 162 sampled author runs ran the full suite at least once |
| Spend on the pipeline (reviews, conflict resolvers, gate fixes) | 32–39% of all spend |
| Restart drains (no new runs) | 3.1 h of the 56 h |

Real breaks are rare: at most 14 merge-check failure episodes in the window (about 6 a day) needed
the author to change code, and some of those were conflicts rather than breaks.

**Method** (to re-measure after each lever lands):

- Per instance (`source`), wall time between `run_start` and `run_end` is authoring, and between
  `merge_queued` and the next `merge_done`/`merge_failed` is the pipeline.
- Inside a pipeline span, time covered by that source's `build_check` (`spawnedAt`…`settledAt`) or
  `review_start`…verdict is check or review time; the rest is waiting.
- A failure episode is "not the change's fault" when the same instance's next check of that scope
  passes with no authoring run (`run_end.durationMs` > 5 s) in between.
- Agents' own test time comes from `<role>.pi.jsonl` (+ `.1`): an assistant `toolCall` whose
  `arguments.command` runs `npm test`/`npm run test`, paired with its `toolResult` timestamp.

## What happens today

Gate by gate, as of b21bca4dc (`check.gateCommand: "npm run test:gate"` in tumwater.json, no
`check.command`, so every full check is `npm test`):

1. **Run start.** A role with a queued change never runs: `queuedRoles.has(runner.role)` in
   src/orchestrator/orchestrator-scheduling.ts (~341), keyed by runner id (`feature-3`), from the
   queue files in `.tumwater/merge-queue/`. A fresh run then asks `mainRedGate`
   (src/baseline/main-red.ts ~131) for main's verdict, which runs a full `npm test` on main when
   the commit is not cached. On red, feature and every code maintenance role
   (`BASELINE_BLOCKED_ROLES`, src/roles/roles.ts ~99) end the run `main_red`; once per red commit
   tumwater logs `main_red_hold` ("code merges blocked until main is green") and sends bugfix a
   heal prompt.
2. **Inside the run.** The prompt says "verify with `npm run test` (the project's declared
   check) — run it after your change and fix what you broke" (src/prompt/prompt.ts ~147). It names
   the full check, never the gate command.
3. **Verify, parallel.** The pin is rebased onto main, then `gateBuildPrecheck`
   (src/review/review-precheck.ts) runs `npm run test:gate` (lint, `tsc --incremental`, affected
   tests). A failure re-runs once; a second failure is excused only if the same headline flaked in
   the last 24 h, and that excuse still ends the attempt as `review_error` (BUGS.md, "An excused
   known-flaky gate failure ends the merge attempt as `review_error`…"). Then the reviewer runs,
   unless the role's single remembered approval matches by patch-id (src/review/review.ts ~274).
4. **Merge, serial.** One merge task at a time. Under the merge lock, `verifyMerge`
   (src/merge/merge-to-main.ts ~255) rebases and runs the full `npm test` on every code change:
   its no-op-rebase skip and inherited-green skip are both off while `gateCommand` is set. A first
   red keeps the pin as `merge_blocked`, with no in-lock retry. Batches of up to `mergeBatchMax` run
   one full check outside the lock and bisect by prefix (src/merge/merge-batch.ts ~239).
5. **Every retry restarts the pipeline.** `merge_blocked`, `review_error`, `main_red` and
   `merge_conflict` drop the queue entry and keep the pin; only the author's next run re-queues it
   (`recoverLeftover`, src/runner/leftover.ts), and the change then pays the gate, often the review
   and the merge check again.
6. **After merge.** The in-lock green seeds main's verdict cache. Self-redeploy targets main's tip
   only (src/orchestrator/orchestrator.ts ~355) and, when the tip is red, deploys nothing until main
   moves (src/redeploy/redeployer.ts ~317, ~411).

## Design

### Lever 1: roles stop waiting on their own change (parts 1–2)

One change in flight per runner stays the rule. The pin (`refs/tumwater/merge/<runner>`), the
pipeline maps, `state.revision`, the claim and the resume slot are all keyed by runner id and assume
it (plans/merge-queue.md invariant 3), and a second run on the same runner would be handed the same
claimed entry. So instead of a second change per runner, a role gets more runners:

- **Part 1: the pipeline re-queues a kept change itself.** After a retriable outcome
  (`merge_blocked`, `review_error` that is neither held nor discarded, `merge_conflict` under
  `MERGE_CONFLICT_LIMIT`) the merge pipeline re-enqueues the same entry at once; a `main_red` pin is
  re-enqueued when main's head next moves. The author's leftover recovery stays for pins left by a
  restart or a crash, and for the conflict hand-back at the limit. A retry no longer waits for the
  author to be scheduled, and no author run is spent on it.
- **Part 2: a runner waiting on its change no longer counts toward `instances`.** For the roles that
  may run instances (`INSTANCE_ROLES`: feature and bugfix), `instances: N` now means "N runs writing
  code at once". Tumwater keeps up to 2N runner ids (`feature` … `feature-10` for N = 5). A runner
  whose change is in the pipeline is parked; the poll admits another of the role's runners while
  fewer than N are running. A parked runner whose change comes back (a revision or a conflict
  hand-back) is admitted first. Each runner holds its own claim, so the new run takes the next
  entry, never the parked one's. Single-runner roles are unchanged.

### Lever 2: merge on the gate, full check after the merge (parts 3–6)

- **Part 3: main watch (record only).** Whenever main's head moves and no watch run is in flight,
  tumwater runs the full check on the tip in `_gate-main` (through `gateMainQueue`, at merge-tier
  check priority). One run covers every commit since the last verdict. A red is confirmed by one
  re-run before it counts. Each verdict records the failing test titles, parsed from the complete
  output (the `✖ …` lines `FAILED_TEST_LINE` matches) before it is clipped. Red verdicts persist
  beside the greens in `.tumwater/state/baseline-verdicts.json`. It logs a `main_check` event.
  Doc-only commits inherit green as today. Nothing acts on the verdicts yet.
- **Part 4: bisect and revert.** When the watch confirms a red tip T whose last green commit is G,
  tumwater first re-checks G; if G is red too, the cause is the environment, so it warns and stops.
  Otherwise it bisects the first-parent code commits in G..T, reusing cached verdicts, to the first
  red commit C, and confirms C's red once. If C was merged by a role runner other than the director
  (its `merged` event names the runner), tumwater reverts it as a merge-slot task: `git revert
  --no-edit C` in `_merge`, the gate command on the result when one is configured, then
  `ffMainToOrWhy` under the merge lock. The commit is stamped like `tumwater revert`
  (src/operator/revert.ts) and its body names the failing tests. C goes back to its role as a
  revision whose reason is the failing tests and the clipped output: to its own runner when that
  runner has no queued change and no pending revision, else to the first of the role's runners that
  is free. When the revert conflicts or its check fails, when C is a director, operator or hand
  commit, or when main is still red after the revert, tumwater does not revert (again); it sends
  bugfix the heal prompt naming C and the failing tests.
- **Part 5: self-redeploy runs main's newest green commit.** The redeploy target becomes the newest
  first-parent commit on main with a green full-check verdict (inherited greens over doc-only
  commits count) that is newer than the running build. A red tip no longer blocks a redeploy that an
  older green commit allows. A commit with no green full-check verdict is never deployed. This keeps
  the green-only redeploy rule once main can be red between merges.
- **Part 6: `check.mergeCommand`.** A new check key names what must pass inside the merge lock.
  It defaults to `check.gateCommand` (see "Defaults"); `""` keeps the full check in the lock.
  When it is in effect:
  - `verifyMerge` and the batch path run it instead of the full check, and skip it when the rebased
    tree is the tree the gate already verified;
  - its greens never seed main's verdict cache (the watch does that);
  - the run-start red-main gate and the gate's re-attribution read the watch's newest verdict and
    never start a full check of their own;
  - the docs that promise "never a red main" say what happens instead.

  Compile and lint therefore still run before every merge, together with the change's affected
  tests; only the full suite moves after the merge.

### Lever 3: main's known failures instead of a team-wide hold (parts 7–8)

- **Part 7: a change passes when it fails only what main already fails.** Main's known failures are
  the failing titles of the watch's newest red verdict on the tip or its nearest checked ancestor.
  When a gate or merge check fails and every failing title it names is a known failure, the change
  goes on (gate: on to review, as verified; merge: on to the fast-forward), with a warning naming
  them. A failure whose titles cannot be parsed (another test runner, a crash, a compile error)
  keeps today's handling. This replaces the gate's `main_red` outcome and the fresh full check it
  runs on main to decide it.
- **Part 8: every role runs on a red main.** While main's failures are known, `mainRedGate` stops
  ending runs `main_red`, and every role's prompt carries a `<main-known-red>` note: the failing
  titles, "tumwater or bugfix owns these; leave them alone unless your task is about them". bugfix
  keeps its `<main-red>` note and heal prompt, sent once per failing set instead of once per red
  commit. `main_red_hold` no longer says merges are blocked.

### Lever 4: a flaky test is quarantined the first time (part 9)

A test that fails and then passes on the same tree (the gate's re-run, a merge re-run, the watch's
confirming re-run) is quarantined at once: recorded in `.tumwater/state/quarantine.json` and treated
like a known failure everywhere (part 7's rule, the watch's red/green call, part 4's culprit
search). Tumwater files one BUGS.md entry per quarantined test, committed on main under both the
merge lock and the primary-worktree lock as `archiveFinishedOnMain` does
(src/backlog/backlog-archive.ts). The test leaves quarantine when its entry leaves `## Open`. The
existing 24 h known-flake excuse folds into this.

On 2026-10-19 this would have contained test/merger.test.ts "a green batch stacks…" at its first
flake (05:0x) instead of after 104 failures and 7½ hours.

### Lever 5: a diff is reviewed once (parts 10–12)

- **Part 10: approval survives a rebase, a requeue and a restart.** The approval key becomes a
  context-free patch-id (`git diff -U0 main...head | git patch-id --verbatim`): the change's own
  lines only, so main moving near a hunk (PLANS.md and BUGS.md hunks above all) no longer forces a
  new review. Approvals are remembered per queued change, not one per role, persist across restarts,
  and clear when the change merges or is finally rejected. The gate still runs on a moved tree; only
  the reviewer is skipped. A conflict resolution that changes the change's own lines still gets
  reviewed.
- **Part 11: a failed reviewer run retries in place.** A reviewer that times out, is killed, loses
  its connection or never states a VERDICT is retried (resumed when it can be) up to twice inside
  the same verify before the attempt ends `review_error`. In the window, `review_error` ended 47
  attempts and cost 34 h of pipeline time.
- **Part 12: the review runs alongside the gate check.** The gate check runs in a second leased
  checkout of the same head while the reviewer starts at once with a fixed "tumwater is running the
  project's check on this tree; do not run it" rule. A red gate cancels the reviewer; an approval
  waits for the gate. This saves the gate's duration (p50 67 s) on every attempt.

### Lever 6: agents run the tests for what they touched (part 13)

With `check.gateCommand` set, the run prompt's verify rule names it: run the gate command (lint,
compile and the tests your change affects) and fix what you broke; tumwater runs the full check
after merging. Without a gate command the wording is unchanged. This was 12% of author run time.

### Lever 7: maintenance roles reviewed after merging (part 14)

A new `review.afterMerge` list names roles whose changes merge once the gate passes, without a
review first. The reviewer then reviews the merged commit (`C^..C`); a rejection reverts C through
part 4's revert path and hands it back as a revision. It defaults to the high-volume,
low-blast-radius roles — `bugfix`, `readme`, `organize`, plus `clean`, `dedupe` and `coverage` (see
"Defaults"). Every other role keeps review before merge.

## Defaults

Decided 2026-10-21 by you. Parts 6 and 14 shipped both switches as opt-in keys, and tumwater.json is
gitignored, so no team commit could turn them on: as of 2026-10-21 02:24 the merge lock still ran
the full `npm test` (142–330 s per merge). Both become defaults instead:

- **`check.mergeCommand` defaults to `check.gateCommand`.** A project that declared a cheaper gate
  check merges on it, and its full check runs after the merge. A project with no gate command keeps
  the full check in the lock, because tumwater cannot guess a cheaper check for an arbitrary
  project. `"mergeCommand": ""` opts out and keeps the full check in the lock.
- **`review.afterMerge` defaults to `["bugfix", "clean", "coverage", "dedupe", "organize", "readme"]`** for every project. `[]` opts
  out, so every role is reviewed before it merges.

A config that leaves `check.mergeCommand` out gets the gate-command fallback: it is a reading-time
fallback in `mergeCommandOf`, never a default, so tumwater never writes it into the file (an
unrelated-key write leaves an absent key absent). `review.afterMerge` IS a default in
`defaultConfig()`, so, like every other default, any config write expands it into the file.

## What stays

- **Compile and lint before every merge** (decided 2026-10-19 by you). A type error on main breaks
  every role's gate and every agent's working tree at once; the gate catches it in seconds.
- **Self-redeploy only runs a green commit** (decided 2026-10-19 by you). Tumwater runs its own
  main; a broken build deployed into the orchestrator could stop the team that would fix it.
- **One owner for a red main.** Tumwater reverts the culprit and bugfix fixes forward. Every other
  role ignores main's known failures instead of fixing them: N parallel fixes of one break would
  turn into N conflicting changes.
- **Review before merge for every role not listed in `review.afterMerge`.** It catches what
  tests cannot (in the window it rejected 0.4 times per merged change, including an e2e test the
  gate skips).
- **One change in flight per runner** (plans/merge-queue.md invariant 3).

## Decisions

- **D1: no new role.** The post-merge check, bisect and revert are mechanical, so tumwater's own
  code does them. bugfix already receives the red-main heal prompt and keeps fix-forward and flake
  root-causing.
- **D2: revert first, fix forward second.** A revert is deterministic and takes seconds; the author
  gets the change back as a revision, which costs about what a rejection costs today.
- **D3: more runners, not more changes per runner** (lever 1), for feature and bugfix only.
- **D4: the merge lock runs the gate command** (`npm run test:gate`: lint, compile, affected tests),
  not a lint-and-compile-only script; it is skipped when the gate already verified the same tree.
- **D5: what tumwater cannot name, it does not excuse.** Known failures and quarantine work from
  parsed test titles (node:test's `✖` lines today); any other failure keeps today's fail-closed
  handling, so other projects lose nothing.
- **D6: both switches are on by default** (decided 2026-10-21 by you; see "Defaults"), with an
  explicit `""` or `[]` to opt out.

## Risks

- **Main is red more often, briefly.** Between a breaking merge and its revert, main is red for
  about one full check, the bisect and the revert. Parts 7–8 keep that from stopping anyone; measure
  red minutes per day after part 6.
- **False reverts.** A flaky or load-sensitive full check could blame the wrong commit. Guards: a
  confirmed red, a re-checked last green, a confirmed culprit, quarantine, and no revert of a
  revert.
- **More concurrent authoring.** Part 2 doubles the feature and bugfix runner ids. That needs more
  eligible plans and more worktree slots (pool size), and it raises conflicts. Overlapping files
  stay settled at merge time (decided 2026-10-07 by you).
- **Spend per day rises** with throughput, even as spend per merged change falls. On 2026-10-19 a
  Claude rate-limit event read the seven-day window at 0.9.
- **A revert puts its PLANS.md entry back.** Reverting a change that moved its plan to Done restores
  the entry under `## Planned`; the revision then re-applies it on top.

## Not in this series

- **Restart drains** (3.1 h of the 56 h). A faster main means more redeploys; revisit after part 6.
- **PLANS.md conflicts.** Since d78f0f1e1 the revision re-apply settles three backlog hunk shapes;
  7 hand-backs in the next 8 h still named PLANS.md. Re-measure before planning more.
- **Raising `instances` by hand.** Part 2 makes the waiting runners free; raise it only if runs,
  not waits, are the limit.

## Expected effect

From the window's numbers, once parts 1–13 are in:

- **End of run → on main:** mean about 10–15 min (today 51), p50 about 4 min (today 10).
  Rejections still loop through a revision.
- **Merged work-tier changes per day:** about 2× (range 1.5–2.5×). 60% of role time is waiting
  today, which caps the gain at 2.5× on the same runners; plan supply and spend are the next limits.
- **Spend per merged change:** about 10–15% lower (fewer re-reviews, review retries in place, fewer
  pipeline restarts).

Re-measure with the method above after parts 2, 6 and 9.

## Series

"Fast merge", parts 1/14–14/14 in PLANS.md, in lever order:

| Part | Lever | Requires |
| --- | --- | --- |
| 1/14 The merge pipeline re-queues a kept change itself | 1 | — |
| 2/14 A runner waiting on its change no longer counts toward `instances` | 1 | — |
| 3/14 Main watch records a full-check verdict for every main commit | 2 | — |
| 4/14 A commit that turned main red is bisected, reverted and handed back | 2 | 3 |
| 5/14 Self-redeploy runs main's newest green commit | 2 | — |
| 6/14 `check.mergeCommand` moves the full check after the merge | 2 | 3, 4, 5 |
| 7/14 A change passes when it fails only main's known failures | 3 | 3 |
| 8/14 Every role runs on a red main with a known-failures note | 3 | 7 |
| 9/14 A flaky test is quarantined and filed the first time | 4 | 7 |
| 10/14 An approval survives a rebase, a requeue and a restart | 5 | — |
| 11/14 A failed reviewer run retries in place | 5 | 10 |
| 12/14 The review runs alongside the gate check | 5 | 11 |
| 13/14 The run prompt names the gate command for verification | 6 | — |
| 14/14 Listed maintenance roles merge after the gate and are reviewed after merging | 7 | 4, 6 |

## Guardrails

Added 2026-10-21 · requested by user · series "Fast merge guardrails", parts 1/3–3/3 in PLANS.md.

The gates this series replaced failed loudly: a red gate stopped merges. The machinery that runs
after the merge can fail quietly while merges go on: main stays red, a revert blames the wrong
commit, or quarantine grows and hides real failures. Four permanent warnings make that visible.
They extend existing doctor rows and add no row and no config key. Measuring the series' effect
before and after is a one-off job done by hand, not part of this.

**G1. A red main that lasts** ("main's check" row).

- Evidence, over the last 24 h: `main_check` events that ran the check (`durationMs` > 0) and
  `main_red_hold` events. A `main_check` with `durationMs` 0 (a cached or inherited verdict) is
  ignored: on 2026-10-20, 1645a5c0 had both a `main_red_hold` and a cached green.
- Main is red when the newest of those is red (a failed `main_check` or a `main_red_hold`). It has
  been red since the first red after the newest passing `main_check`. A pass that names
  `quarantined` tests is still a pass.
- Warn when that is more than 30 minutes ago, e.g. "main has had no passing full check for 47 min:
  red since 1645a5c0 at 00:07 — <first failing test>". A window with reds and no pass reads "for
  more than 24 h".
- While the merge lock runs the full check (the live team on 2026-10-21, before "Defaults"
  lands), every merge seeds main's verdicts with its in-lock green, so the watch seldom runs the
  check itself: 2 of the 706 `main_check` events since 2026-10-20 ran it. The warning then lasts
  until the next run that does, even once main is green. Once the lock runs the gate command
  ("Defaults"), the watch runs the check on every code merge's tip.

**G2. Reverts** ("main's check" row).

- A `main_revert` in the last 24 h looks false when either holds:
  - its failure did not reproduce: a test it names has been quarantined since the revert
    (quarantine.json `lastSeen` at or after it, or a later `main_check`'s `quarantined` list);
  - its change came back unchanged and main stayed green: a later `merged` event carries the
    culprit's patch-id, and the first `main_check` after that merge which ran the check passed.
- So that the second test is a read of the event log, `main_revert` gains `patchId` (the
  culprit's) and `merged` gains `patchId` (the merged commit's), on the single and the batch merge
  path alike. Both come from `patchId` (src/git/git.ts): `-U0`, so re-applying the same diff onto a
  moved main keeps the id. An event without `patchId` (an older build) matches nothing.
- Warn also when more than 5 red-main `main_revert` events fall in the last 24 h. Rejection
  reverts are told apart from red-main ones by the event's `reason` (post-review | main-red)
  and are never counted toward the ceiling or called false: a post-merge-review rejection is
  an intended revision cycle, carried instead by `tumwater report`'s post-merge-rejection
  table. An event without `reason` (an older build) defaults to main-red.
- The detail names each false-looking revert (culprit sha and which test failed) and the count
  when over the limit.

**G3. Quarantine** ("flaky checks" row).

- Warn when a test in `.tumwater/state/quarantine.json` has `firstSeen` more than 3 days ago, or
  when the file lists more than 10 tests. A test leaves quarantine only when its BUGS.md entry
  leaves `## Open`, so an old entry is a failure the team has stopped seeing.
- The detail names the oldest tests with their age and BUGS.md heading, or "not filed" when `bug`
  is empty: an unfiled test never leaves quarantine.
- The row's existing flake count over the last 24 h stays as it is.

**G4. Event log retention** ("event log" row).

- events.jsonl rotates at a fixed 16 MB (`EVENTS_MAX_BYTES`, src/events/events.ts, not
  `logMaxBytes`) and keeps one generation, events.jsonl.1, which the next rotation deletes. The
  first rotation, on 2026-10-20, moved 2026-08-20 → 2026-10-20 into events.jsonl.1, this series'
  measurement window included. At that day's 2.2 MB, the next rotation comes in about a week.
- Keep 5 archived generations (`EVENTS_KEEP` beside `EVENTS_MAX_BYTES`, a constant, not a config
  key): at most 96 MB with the live file, about six weeks at 2.2 MB a day. Rotation drops `.5`,
  shifts `.4`→`.5` … `.1`→`.2`, then moves the live file to `.1`. `rotateIfLarge`
  (src/files/files.ts) takes the count, default 1, so role pi logs keep one generation as today.
- The windowed reader (readWindowEvents, src/events/event-window.ts) continues into `.2`…`.5`
  only while the window is not yet covered. The readability check (eventLogState) still reads the
  live file and `.1`. The tail follower drains from `.1`, which stays the newest archive.
- The row's ok detail adds how far back the kept history reaches (the oldest generation's first
  event), and the report header's rotation phrase (eventsRotationLabel) says how many are kept.

**Where the warnings show.** G1–G3 live in one module, src/baseline/main-guardrails.ts, read
synchronously from the event log and quarantine.json, so every surface words them the same:

- `tumwater doctor`, the TUI Health pane and the dashboard's doctor view, through the rows above;
- the selfcheck role's digest (src/run/selfcheck-digest.ts), which ends with a
  `## Fast merge guardrails` section listing the warnings that fire (none: no section). The
  role's charter says each line there is tumwater's own response failing.

| Part | Guardrails | Requires |
| --- | --- | --- |
| 1/3 Doctor warns when main stays red and when quarantine ages or grows | G1, G3 | — |
| 2/3 Doctor warns on a revert that looks false and on more than 5 reverts a day | G2 | 1 |
| 3/3 The event log keeps five rotated generations | G4 | — |
