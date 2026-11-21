# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### Codex runs default to the operator's own `~/.codex`, filling it with team sessions (reported by the user 2026-11-16)

`codexHome` (src/agent/codex/codex-catalog.ts) falls back to `~/.codex` when the Codex backend has
no `configDir`. kde-macos8.6-theme's `tumwater.json` has `"backends": {}`, so every tumwater Codex
session (7,466 distinct ids from 2026-11-08 to 11-12) went into the operator's personal Codex
home: `~/.codex` is 2.9 GB, `~/.codex/sessions` 701 MB, `state_5.sqlite` 557 MB, and the
operator's own history is buried under thousands of `tumwater-review-*` threads. Each real
`codex delete --force` took about 1 s during the 2026-11-16 prune (about 53 a minute; a delete of
an unknown UUID returns in 0.19 s); the shared, bloated state DB is the likely reason, not a
measured one. The Codex half of `RetentionPruner.prune` (src/orchestrator/retention.ts) also says
CODEX_HOME is set "so the inherited CODEX_HOME never reaches the purge (its rollout fallback would
otherwise unlink the operator's own home)" — with the default config the resolved team home *is*
the operator's home. The fallback unlinks only rollouts the ledger recorded, so it is safe in
practice, but the comment's guarantee is not real.

**Reproduce.** Observed. Any team with Codex enabled and no `backends.codex.configDir`: run one
Codex role and its rollout appears under `~/.codex/sessions/`.

**Suspected cause.** The default was chosen so a known home always exists. Fix: default the Codex
home to a per-team directory (e.g. `.tumwater/codex-home/`, seeded with `auth.json`/`config.toml`
the way the codex-account seed and the isolated OpenCode DB work), and use `~/.codex` only when
the config asks for it. Add a `tumwater doctor` row that warns about an unisolated Codex home, and
fix the retention comment either way.

### 1,451 commits dropped from post-merge review on 2026-11-09 and 11-11 stay unreviewed, and nothing can re-queue them (reported by the user 2026-11-16)

Before 4120526fe the review provider's quota wall made each commit's post-merge review fail three
times and get dropped ("dropping the post-merge review of … after 3 failed runs; it stays on main
unreviewed"): 821 drops on 2026-11-09 and 630 on 2026-11-11 in kde-macos8.6-theme. Those commits
are on main and were never reviewed. `state/post-review.json` holds 395 entries, none unreviewed,
so they are not queued anywhere, and no command or role re-queues a review dropped because of a
provider failure.

**Reproduce.** Observed: count the `dropping the post-merge review` warnings in that project's
`log/events.jsonl` for those days and compare against `state/post-review.json`. BUGS-FIXED.md
mentions "never reached a verdict" 240 times; check whether the per-commit entries 4120526fe's
message describes (821 in 20 min) were cleaned up or only moved to BUGS-FIXED.md.

**Suspected cause.** A drop is terminal, and its only record is a warning. Fix: emit an explicit
`review_dropped` event (commit, role, reason) on every drop, and add a way to re-queue them, e.g.
`tumwater review --requeue-dropped [--since <date>]`, reading the events (and the old warnings for
history). Run it once for 2026-11-09 to 11-11 when the review provider has quota. Decide whether
the matching BUGS-FIXED.md entries should be deleted rather than kept as "fixed".

### A post-merge review that times out "while still making progress" restarts from scratch every attempt and counts toward the drop limit, so a review longer than its budget can never finish (found by an operator session 2026-11-18)

When a post-merge review hits its wall budget while progressing, the warning reads "the post-merge review of <sha> failed (timed out after 7200s while still making progress — session and worktree edits preserved for resume)". Nothing on the post-merge path resumes:
- `reviewMergedCommit` (src/review/post-merge-review.ts) calls `ensureDetachedWorktree`, which hard-resets the post-review worktree to the commit, and resets the review-fix ref to the commit.
- It then starts `runGatePi` without `continueSession`, so pi opens a new session file.
- `settlePostReviewOutcome` (src/merge/merge-post-review-drain.ts) counts the timeout as an ordinary failed run toward `POST_REVIEW_FAILURE_LIMIT` (3). The third timeout drops the commit unreviewed and files a "never reached a verdict" entry.

The pre-merge gate had the same wording bug, fixed on 10-01 (BUGS-FIXED.md, "A timed-out review is reported as 'session and worktree edits preserved for resume'…"). That fix rewrote the message only in src/review/review.ts. The post-merge drain reports `pi.errorMessage` unchanged.

**Seen live.** On 11-17 every failed post-merge review hit the 7200 s cap: f6e2431a, 7734f02f, 54a4a07f, ff1a8d34, 620887d8 and 1fc125aa. That is about 12 slot-hours on the local Qwen. The day had 15 post-merge review starts and 8 verdicts. 54a4a07f's second attempt (`_review/bugfix/post-54a4a07f/2026-11-18T07-48-57-952Z_*.jsonl`) is a new session that re-reads the same files the first one had read. It timed out again at 11-18 01:48:57 PST. ff1a8d34 and 54a4a07f are now at 2 of 3 failures, so one more timeout each drops them unreviewed.

**Reproduce.** `ls .tumwater/sessions/_review/bugfix/post-54a4a07f/` shows two session files, one per attempt. `sessions.jsonl` there records two starts with the same session name. The events log pairs each `review_start` (`afterMerge: true`) with a timeout warning exactly 7200 s later.

**Suspected cause / fix direction.** The post-merge path was built on the gate's fresh-session design and never got either remedy. At minimum, reword the message for this path as review.ts does, keeping the failure-cluster pooling in src/failure/failure-cluster.ts. The fix that ends the waste is to continue the timed-out reviewer's own session on the same commit without resetting the worktree or the fix ref. Alternatively, do not count a progressing timeout toward the drop limit while each attempt keeps making progress. Without one of those, a review that needs more than one budget has no way to finish.

### A model check run while the only local server is saturated fails on queue position, holding every role and handing back runs to "a pair that answers" that does not exist (found by an operator session 2026-11-18)

The team runs every role on one local pair, `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` (Splash 1.6.1, `--max-concurrent 4`). On 11-17 the model check failed four times ("gave no reply (no answer within 300s) — runs on it wait (feature, bugfix, plan, …, +13 more)"), each time holding all 19 runners. The Splash log (`~/qwenrunner/logs/splash.8090.log`) shows that the server was answering, not down:
- At 14:08:57 and 14:20:00 PST the probe's requests (input 1,420 tokens, 0 cached) were `Cancelled` with output 0 and never `Started`. The server was memory-starved ("Memory: growth paused; waiting=1") and kept starting cache-hit follow-ups from the sessions already running, while new uncached requests waited.
- In the same minutes the running sessions' requests finished at 30–48 tok/s.
- dedupe's request (input 50,031, 0 cached) had waited unstarted since about 13:43.

The hand-back cancelled dedupe's run at 14:08:59 (aborted after 2.0 h) and clean's at 14:27:18 (after 1.75 h). Each warning says "the run resumes on a pair that answers", but no other pair is configured. Once clean's request was cancelled, the next probe started at once and answered in 3 s (`model_check_passed` at 14:27:20). So the check measured the probe's place in a saturated server's admission queue, and the hand-back is what made the next probe pass.

**Reproduce.** In the Splash log's 11-17 section (after the 23:59→00:00 rollover near line 600823), filter 14:02–14:28 to `Started|Done|Cancelled`. Compare with `.tumwater/log/events.jsonl` `warning` events at 14:08:57–14:27:20 and the `model_check_passed` event at 14:27:20.

**Suspected cause / fix direction.** The probe (src/model-check/model-check-probe.ts, `MODEL_CHECK_TIMEOUT_S` = 300) competes for the same server slots and memory as the runs it judges. A request that never started is read the same as a model that does not answer. Part of this is Splash's admission behavior under memory pressure, which tumwater cannot fix. On the harness side, options are:
- Don't treat "no answer" as a failed pair while the team's own runs on that pair are getting replies in the same window.
- Or reserve headroom for the probe, for example by lowering the team's concurrency by one while a check is due.
- Either way, the hand-back warning should not promise another pair when the tier has none.

### An accepted checkpoint still leaves the session uncompacted: pi’s fire-and-forget `compact()` never reaches its `compaction_end` (found by the bugfix role 2026-11-19)

The BUGS-FIXED entry "A checkpoint-caused abort is indistinguishable from a context-ceiling cut-off" requires that "an accepted checkpoint must leave the session compacted". It usually does not. On every observed author run the tool result reads "Checkpoint recorded; the context is being compacted", the next assistant turn ends `stopReason: "aborted"`, and the role’s pi log holds a `compaction_start` with `reason: "manual"` and no matching `compaction_end`; in every run whose pi log survives, the session file holds no checkpoint `compaction` entry — the only `compaction` entries whose runs' logs survive (`ci`, `feature-4`) carry no `details.kind` and sit at a completed threshold `compaction_start`/`compaction_end` pair, the path pi triggers itself. One counterexample exists — `sessions/bugfix/2026-11-16T20-24-32-982Z_01a1e608-….jsonl` holds a `compaction` entry with `details.kind: "checkpoint"` — but that run's pi log is gone, so nothing shows its `compaction_end` reached the stream. The common case stands: the run loses its turn and gains no summary, the context keeps growing, and the role pays an aborted run each time it checkpoints.

**Reproduce.** In a role’s pi log, `grep -c '^{"type":"compaction_start","reason":"manual"}'` counts starts while `grep -c '^{"type":"compaction_end","reason":"manual"}'` counts none across every log in `.tumwater/log` (the reason must be anchored: unanchored, `grep -c compaction_end` also matches the string inside assistant text and tool output, which is how a log with no completed manual compaction reads as 476). pi 1.5.2’s `compact()` (its `dist/core/agent-session.js`) awaits `abort()`, emits `compaction_start`, then summarizes, and emits `compaction_end` only on completion or failure — so a process that exits once the aborted turn settles never emits one.

**Suspected cause.** `src/pi-extension/checkpoint.ts` requests the compaction and returns its tool result before pi has run the summarization, and pi ends the run when the aborted turn settles. Settling it means keeping the run alive until `compaction_end` arrives (or writing the compaction entry directly), a design decision that belongs with the plan role, not a parser correction. The sibling fix (this file’s Fixed entry) only stops the harness from claiming a compaction that was never written.

### Host sleep counts as model silence: the run watchdogs, the model check and the run and review wall budgets kill or hand back work the host slept through (found by an operator session 2026-11-19)

On 11-19 the host was lid-closed from about 05:20 to 15:41 PST. `pmset -g log` shows it asleep 37–61 minutes of every hour, with short maintenance DarkWakes in between. Every watchdog that judges a run measures on the wall clock, so that sleep read as a backend that stopped answering:
- 75 `model request unanswered … no reply for 5m–20m` warnings. There were none before 05:20.
- Five `model check failed: … gave no reply` warnings, at 07:06, 11:54, 13:25, 13:52 and 14:59. Each held all 29 runners.
- Each check failure handed back the runs waiting on a reply. These ended `aborted` after 7–145 minutes: feature, bugfix, qa, organize, selfcheck, bugfix-2, plan, bugfix-3, and some of them more than once.
- Three runs were `quiet_killed` with "killed as hung: no agent progress for over 1800s": bugfix-3 #136, perf #562 and plan #2689.
- Feature #3013 was killed with "timed out after 14400s while still making progress".
- Four post-merge reviews timed out "after 7200s" or "after 14400s": 99ebf171, d3352500, c4fb62f2 and 1fc125aa.

Overlaying each of those 22 endings on the pmset sleep intervals shows that 85–95% of each one's wall time was host sleep. Feature #3013 ran 242 minutes and was asleep for 223 of them. 1fc125aa's review ran 240 minutes and was asleep for 201. Each post-merge review timeout also counts toward `POST_REVIEW_FAILURE_LIMIT`, so sleep alone can push a commit toward being dropped unreviewed. The open entry above, "A post-merge review that times out … restarts from scratch", covers why that limit hurts.

**Reproduce.** Write `pmset -g log | grep 'Entering Sleep state'` to a file. Parse each line's timestamp and its trailing `N secs` into an interval. For every `run_end` with result `aborted` or `quiet_killed`, and every "post-merge review of … timed out" warning in `.tumwater/log/events.jsonl` since 11-19 05:00, sum the sleep that falls inside `[ts − durationMs, ts]`.

**Suspected cause / fix direction.** Build checks already measure host sleep: `sleptMs` in src/build/host-sleep.ts, through `SLEEP_SPAN_TOLERANCE_MS` and `unverifiedTreeOutcome`. None of the following use that measurement:
- The quiet and stall clock in src/pi/pi-watchdogs.ts (`startQuietWatch`, whose `waitedMs = Date.now() - pending.since` feeds the unanswered warning).
- The zero-byte 30-minute bound and the run and review timeouts.
- The model-check probe's 300 s budget (`MODEL_CHECK_TIMEOUT_S`, src/model-check/model-check-probe.ts).

One fix is to subtract measured host sleep from each silence or budget before acting on it. Another is to treat a window that spans a sleep as no evidence, the way an unverified build check is treated: re-arm the timer and do not count a failure. A probe whose window held a sleep should be retried, not failed. This entry is separate from the open "A model check run while the only local server is saturated…" entry. That one is about server admission while the host is awake. This one is about the host being asleep.

### An extra instance that is never admitted keeps its staged claim, so a higher backlog entry waits while a lower-index sibling takes a later one (found by an operator session 2026-11-19)

With `roles.bugfix.instances: 3`, tumwater keeps six bugfix runner ids (`RUNNERS_PER_INSTANCE` = 2, src/roles/runner-ids.ts). It admits a runner only while fewer than 3 are writing (`admissionHolds`, src/scheduling/skip.ts). `orderForAdmission` (src/scheduling/scope.ts) prefers the lowest index, but every idle instance can be handed a claim. On 11-19 this caused two inversions:
- **Bugs.** At 09:46:35 bugfix-2, bugfix-3 and bugfix-4 were assigned BUGS.md's top three open entries. bugfix-4 holds "Five root-walk tests fail on a shared host…" (line 53) and has not started a run since 11-09 (`skipReason: "instances-full"` in `.tumwater/state/bugfix-4.json`). At 11:55 bugfix, freed when its change merged, took the next entry instead: "`a corrupted cache entry is ignored…`" (line 61). It ran that entry at 13:33. The root-walk bug is still unworked 7.5 h after it was claimed.
- **Plans.** At 15:44 feature-4 was assigned "Operator steering, part 2/5" (PLANS.md line 264) and has never run. After the 16:39 restart, feature took "Remove the TUI, part 1/5" (line 426) and started it at once.

The claim is released only by the 24 h stale sweep (`CLAIM_IDLE_MAX_MS`), or when the instance is disabled or paused. An instance that is enabled but never admitted is none of those, so the entry stays held while the lower-index runners keep winning admission.

**Reproduce.** In `.tumwater/log/events.jsonl`, pair each `claim` `assigned` event with that runner's next `run_start`. Since 11-19, bugfix-4's and feature-4's claims have no `run_start` at all, while siblings' later claims start within 0–219 minutes. `tumwater backlog` shows both entries as being worked.

**Suspected cause / fix direction.** Claim staging and admission disagree about who will run next. Options:
- Stage claims only on runners that admission would let in.
- Have admission prefer the runner that holds the highest-placed backlog entry, rather than the lowest index.
- When a lower-index runner becomes free while a higher-index sibling's claim is still waiting, move that claim to it.

### A shutdown or restart that waits on a post-merge review names no role: "waiting on the merge in progress for " (found by an operator session 2026-11-19)

The feed logged `shutdown waiting on the merge in progress for ` at 11-19 05:20:09 and `restart waiting on the merge in progress for  (deadline 360s)` at 16:38:04. In both, the role list is empty. The task in flight both times was a post-merge review: coverage's review of 6ab53d1e settled at 16:39:18, just before `orchestrator_stop`. `startPostReview` (src/merge/merge-post-review-drain.ts) builds its `InFlightMerge` with `roles: []`. `drainInFlightWork` and `awaitMergeForHandoff` (src/run/run-timing.ts) join `roles` into the message, and the abort and abandon follow-ups use it too. The operator cannot tell what the restart is waiting for. Fix direction: give the post-merge review task its author role, or name the commit under review, so the hand-off wording identifies it. Check first that `tumwater abort --role` (`abortableMerges`) is still meant to skip a post-merge review once it carries a role.

**Reproduce.** `grep 'merge in progress for ' .tumwater/log/events.jsonl`.

### A full check that the host slept through marks main's head watched, so a code head goes without a verdict until main moves again (found by an operator session 2026-11-19)

Bugfix's 6c9b25b6 (a `src/` change) merged at 11-19 11:29. The `_main-full` mirror's baseline failed with `sleptMs: 140544` (18 tests), and its clean retry failed with `sleptMs: 182225` (34 tests) at 12:01. Both were correctly not cached red: `runBaselineOnce` returns `unverified`. Then nothing re-ran. There was no `main_check` for 6c9b25b6. The next full check ran only when da13f613 merged at 16:02, 4.5 h later, although the hourly interval (`check.fullIntervalMinutes`, default 60) had long passed. The cause is in `fullPass` (src/baseline/main-watch-full.ts). On a run with no verdict it calls `markWatched(state, tip)`, which sets `lastWatched` to the tip and clears `fullCheckDueAt`. The poll in src/baseline/main-watch.ts then sees `mainHead === state.lastWatched` with nothing due, and never retries. This contradicts runBaselineOnce's own comment: "nothing is cached — the next consult re-runs". A red main that lands just before a sleep therefore goes unseen until someone else merges. Fix direction: after an unverified or skipped full run, leave the head due, for example by setting `fullCheckDueAt` to now plus a short backoff instead of clearing it. Keep the existing rule that a run with no verdict is never cached.

**Reproduce.** In events.jsonl, find the two `build_check` `scope: "baseline"` events at 11:36:49 and 12:01:02 with `sleptMs` > 0. No `main_check` follows until 16:08:02.

### The budget-fallback e2e `a reached cap switches roles to the free fallback model instead of stopping them` reds a full e2e step once, then passes isolated and in the tier re-run — the 2026-11-20 headroom bar admits a quiet sample and the 150 s spawn wait still starves (found by the ci role 2026-11-20)

**Symptom.** In the CI workflow's own e2e step (`npm run test:e2e`) against main tip `fa69a208` (lock md5 `ed710f21`), one test failed: `a reached cap switches roles to the free fallback model instead of stopping them` (test/orchestrator-budget.e2e.test.ts:210), `Error: timed out waiting for a role run after the cap was reached` at **150431 ms** — its own full wall budget, so the wait never got the run-start marker at all. The same tip's `npm test` (guard, lint, tsc, stamp, full unit runner) was green with no failing test.

**Why it is a flake, not a regression.** Two checks, both in this run: re-running that one test in isolation on a host the gate reads as quiet passed in **1.2 s**, and a second full `npm run test:e2e` at the same tip reached its summary with no failure and no skip. No file under `src/budget`, `src/runner`, `src/orchestrator` or `src/process` moved since the last covered green tip `d6d3def9` (`git diff --name-only d6d3def9..HEAD -- src/budget src/runner src/orchestrator src/process` printed nothing), so nothing on the budget-gate or run-spawn path this test drives changed.

**What the 2026-11-20 fix did not close.** That fix (BUGS-FIXED.md, fixed 2026-11-20 by the bugfix role; `QUIET_HOST_HEADROOM`/`quietHostBar` in test/helpers/wait.ts) judged both averages against 0.8 × cores, so admission saw load 2.76/2.70 on 18 cores against a bar of 14.4 and admitted. The single `recheckQuietHost()` sample taken immediately before the 150 s wait also passed. The wait still starved: on this shared host other runs (sibling role runs, review checks, the `_main-full` baseline mirror) saturate cores inside the 150 s window with no signal either gate can see, because both samples are point-in-time and the e2e tier's files run one at a time, so nothing in-process explains the starvation.

**Reproduce.** `npm run test:e2e` on a host whose load rises after the tier starts; the test prints its duration at 150 s (L4's tell for a starved wall budget, not a verdict). The test itself is deterministic and fast when the host is idle: the same file in isolation finishes in seconds.

**Required behavior.** A full e2e step must not carry a red from a 150 s wall-clock wait the host starved after admission. Options the class has already sketched, none landed: drive the run-start-marker wait on the fake clock the watchdog tests use, or re-sample the host during the wait and skip when it crosses the bar mid-wait. The 150 s bound itself is not the lever (the 2026-10-25/26 entries record the ceiling, not a bound).

### post-merge review of 54a4a07f never reached a verdict (found by the review role 2026-11-19)

The post-merge review of commit `54a4a07f9d57a0fd649376ecbe00fa8d349e47ac` (Name checkpoint aborts in the no-change diagnosis, not ceiling cut-offs) never reached a verdict: timed out after 7200s while still making progress — session and worktree edits preserved for resume. It stays on main as ordinary unreviewed backlog work. To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would lift the note.

### the stage self-check finding "added lines name paths that do not exist in the tree: src/cli/cli-land-command.js, src/operator/operator-land.js, src/c…" was not closed by the fix-up turn and re-fires each run (filed by tumwater 2026-11-20)

- **Symptom:** the pre-queue self-check raised this finding on the run's change; the one-turn fix-up could not close it and reverted the whole change instead, so the run ended `no_change` (`selfCheckReverted`) and the finding lived only in the run's warning event.
- **Finding:** `added lines name paths that do not exist in the tree: src/cli/cli-land-command.js, src/operator/operator-land.js, src/cli/cli-retire-command.js, src/report/report-types.js, src/agent/agent-args.js, src/agent/agent-backend.js, src/agent/agent-git-config.js, src/agent/agent-run.js, src/agent/agent-se…`
- **Reproduce:** author a change that trips a pre-queue self-check finding the fix-up resolves by reverting the whole change (clean tree); the run ends `no_change` with only the self-check warning carrying the finding.
- **Cause:** a finding the fix-up could not close was never filed to BUGS.md, so the same finding re-burned the same authoring each run instead of becoming bugfix work.
- **Fix sketch:** fix the finding's cause — the file and line it names, or the check that raised it — and move this entry to Fixed with a Fix paragraph showing the finding gone.

### the stage self-check finding "added lines carry garbled rename wording (reword them; a rote word swap such as "tick" → "run" reads wrong here or leav…" was not closed by the fix-up turn and re-fires each run (filed by tumwater 2026-11-20)

- **Symptom:** the pre-queue self-check raised this finding on the run's change; the one-turn fix-up could not close it and reverted the whole change instead, so the run ended `no_change` (`selfCheckReverted`) and the finding lived only in the run's warning event.
- **Finding:** `added lines carry garbled rename wording (reword them; a rote word swap such as "tick" → "run" reads wrong here or leaves a word doubled): .scratch/cov.log:858 "run runs", .scratch/cov.log:9204 "run runs", .scratch/cov.log:9770 "run's run"`
- **Reproduce:** author a change that trips a pre-queue self-check finding the fix-up resolves by reverting the whole change (clean tree); the run ends `no_change` with only the self-check warning carrying the finding.
- **Cause:** a finding the fix-up could not close was never filed to BUGS.md, so the same finding re-burned the same authoring each run instead of becoming bugfix work.
- **Fix sketch:** fix the finding's cause — the file and line it names, or the check that raised it — and move this entry to Fixed with a Fix paragraph showing the finding gone.

### A change whose own commit message says it leaves tests failing still merges, because the budgeted gate runs none of the tests it breaks (reported by the user 2026-11-20)

Feature run #3029's revision `dac2a150b` ("Set the default work-instance count to 3; rewrap its doc comment") merged on 2026-11-20 at 15:43 PST. Its own RISK line said "the change is NOT complete — the flip leaves the suite red: `npm run test:rerun` fails 22 tests in claims, backlog-pending, run-prompt, role-view, doctor-checks, status-data, team-alerts, config, cli-diff, change-data-scope, gui-client-boot, gui-operator, scheduling, run-stage". Its VERIFIED line said the change "is not suite-green as it stands". Nothing stopped it:
- Its only pre-merge check was `npm run test:gate`. In events.jsonl that `build_check` passed with `counts.tests` 28 in 8.2 s, and none of the 22 failing tests was among them. The edit was a one-line constant change in src/roles/runner-ids.ts (`DEFAULT_INSTANCES` 1 → 3), which is read by almost every scheduling, GUI and doctor path, so the tests it broke were too far away for the 20 s budget.
- The first attempt (`4e884e68`) was rejected only for two 101-column comment lines. The revision fixed those and merged on the gate.
- The main watch flagged `dac2a150b` as culprit (`main_culprit`) at 15:50. Main stayed red until the ci role's `ccdfe746b` merged at 19:18, about 3.5 hours later. An operator cutting 0.9.0 found main red mid-cut and could not release until the fix landed.

**Reproduce.** At `dac2a150b`, `npm run test:gate` passes and `npm test` fails 23 tests (the 22 named plus `orchestrator-fallback`'s breaker test), and `npm run test:e2e` fails one more (an orchestrator-permits test where a sibling instance takes the freed permit).

**Suspected cause / fix direction.** Two separate gaps:
- The merge path never reads the commit's own declaration. A RISK or VERIFIED line saying the suite is red, "NOT complete", or "not suite-green" is a statement from the author that it should not merge. The stage self-check (src/stage/) could refuse such a summary on the authoring turn, or the merge could hold it for a full check instead of the budgeted gate.
- The budgeted gate ranks tests by import distance, so a change to a widely read constant or default selects few of its dependents. A change that alters an exported default value (as opposed to adding code) could force a wider selection, or route to the full check the main watch already runs.

**Related, seen in the same run.** Run #3029's claim was "Remove the TUI, part 3/5" (its `Claim:` trailer and the `claim released … reason queued` event), but the run implemented "Three work instances by default, part 2/2". The plan entry it actually worked on was never claimed, so another instance could have taken it at the same time.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
