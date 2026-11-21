# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### Codex runs default to the operator's own `~/.codex`, filling it with team sessions (reported by the user 2026-11-16)

**Needs review 2026-11-21 by feature: too large for one run**

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

### The model check fails a pair on queue position: a probe that never starts on a saturated local server reads as "no answer" and holds every role (split from the 2026-11-18 model-check entry in Fixed; found by the bugfix role 2026-11-21)

**Needs review 2026-11-21 by feature: too large for one run** — the fix direction is a design choice with two parts. Part 1: a verdict-level rule in src/model-check/model-check-gate.ts settle() for a timed-out "no reply" while the team's own runs on that pair are answering; that needs a live-reply signal the runner does not expose today (RoleRunner.replyWait in src/runner/runner.ts only reports waiting toggles), and a retry schedule for the no-evidence case so a first probe does not re-fire on every poll. Part 2: reserving one concurrency slot while a check is due, which touches the orchestrator's permit accounting. Pick one direction in the plan, then split.

The team runs every role on one local pair, `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` (Splash 1.6.1, `--max-concurrent 4`). On 11-17 the model check failed four times ("no answer within 300s"), each time holding all 19 runners. The Splash log shows the server answering: the probe's uncached requests were `Cancelled` with output 0 and never `Started` while the server was memory-starved and kept starting cache-hit follow-ups for the running sessions. The probe competes for the same slots and memory as the runs it judges, and a request that never started is read the same as a model that does not answer.

**Reproduce.** In `~/qwenrunner/logs/splash.8090.log`, 11-17 section, filter 14:02–14:28 to `Started|Done|Cancelled`. Compare with the `warning` events in `.tumwater/log/events.jsonl` at 14:08:57–14:27:20 and the `model_check_passed` event at 14:27:20.

**Suspected cause / fix direction.** Splash's admission under memory pressure is outside tumwater. On the harness side: don't treat "no answer" as a failed pair while the team's own runs on that pair are getting replies in the same window; or reserve headroom for the probe by lowering concurrency by one while a check is due.

### An accepted checkpoint still leaves the session uncompacted: pi’s fire-and-forget `compact()` never reaches its `compaction_end` (found by the bugfix role 2026-11-19)

**Needs review 2026-11-21 by feature: too large for one run** — the entry's own fork (keep the run alive until `compaction_end`, or write the compaction entry directly) is a design choice for the plan role, and pi's `dist/core/agent-session.js` is not installed in this checkout, so the `compact()` lifecycle cannot be read or reproduced offline here.

The BUGS-FIXED entry "A checkpoint-caused abort is indistinguishable from a context-ceiling cut-off" requires that "an accepted checkpoint must leave the session compacted". It usually does not. On every observed author run the tool result reads "Checkpoint recorded; the context is being compacted", the next assistant turn ends `stopReason: "aborted"`, and the role’s pi log holds a `compaction_start` with `reason: "manual"` and no matching `compaction_end`; in every run whose pi log survives, the session file holds no checkpoint `compaction` entry — the only `compaction` entries whose runs' logs survive (`ci`, `feature-4`) carry no `details.kind` and sit at a completed threshold `compaction_start`/`compaction_end` pair, the path pi triggers itself. One counterexample exists — `sessions/bugfix/2026-11-16T20-24-32-982Z_01a1e608-….jsonl` holds a `compaction` entry with `details.kind: "checkpoint"` — but that run's pi log is gone, so nothing shows its `compaction_end` reached the stream. The common case stands: the run loses its turn and gains no summary, the context keeps growing, and the role pays an aborted run each time it checkpoints.

**Reproduce.** In a role’s pi log, `grep -c '^{"type":"compaction_start","reason":"manual"}'` counts starts while `grep -c '^{"type":"compaction_end","reason":"manual"}'` counts none across every log in `.tumwater/log` (the reason must be anchored: unanchored, `grep -c compaction_end` also matches the string inside assistant text and tool output, which is how a log with no completed manual compaction reads as 476). pi 1.5.2’s `compact()` (its `dist/core/agent-session.js`) awaits `abort()`, emits `compaction_start`, then summarizes, and emits `compaction_end` only on completion or failure — so a process that exits once the aborted turn settles never emits one.

**Suspected cause.** `src/pi-extension/checkpoint.ts` requests the compaction and returns its tool result before pi has run the summarization, and pi ends the run when the aborted turn settles. Settling it means keeping the run alive until `compaction_end` arrives (or writing the compaction entry directly), a design decision that belongs with the plan role, not a parser correction. The sibling fix (this file’s Fixed entry) only stops the harness from claiming a compaction that was never written.

### Host sleep, part 1/3: the quiet and stall clock counts host sleep as model silence, so it quiet-kills runs and warns "model request unanswered" across a sleep (found by an operator session 2026-11-19, split 2026-11-21 by the plan role)

Siblings: "Host sleep, part 2/3: the run deadline…" (run and post-merge review wall budgets) and "Host sleep, part 3/3: a model check whose probe window held a host sleep…". Each fixes its own mechanism and lands on its own.

On 11-19 the host was lid-closed from about 05:20 to 15:41 PST. `pmset -g log` shows it asleep 37–61 minutes of every hour, with short maintenance DarkWakes in between. Every watchdog that judges a run measures on the wall clock, so that sleep read as a backend that stopped answering. This part's share of that day:
- 75 `model request unanswered … no reply for 5m–20m` warnings. There were none before 05:20.
- Three runs were `quiet_killed` with "killed as hung: no agent progress for over 1800s": bugfix-3 #136, perf #562 and plan #2689.

Overlaying those endings on the pmset sleep intervals shows 85–95% of each one's wall time was host sleep.

**Reproduce.** Write `pmset -g log | grep 'Entering Sleep state'` to a file. Parse each line's timestamp and its trailing `N secs` into an interval. For every `run_end` with result `quiet_killed`, and every `model request unanswered` warning, in `.tumwater/log/events.jsonl` since 11-19 05:00, sum the sleep that falls inside the silence it reports.

**Cause.** `startQuietWatch` in src/pi/pi-watchdogs.ts reads every silence as `Date.now() - <start>`: the quiet kill (`lastProgressAt` against `allowedSilenceMs()`, which includes the zero-byte 30-minute bound), the per-call stall kill and stall warning (`call.lastActivityAt`), and `warnUnansweredReply` (`pending.since`). Its interval cannot fire while the host is suspended, so the first tick after wake sees the whole sleep as silence. Its own comment calls checking "against the wall clock, so it also fires promptly after a machine sleep" a feature. Build checks already measure sleep with `sampleSleepClock` / `sleptMsBetween` (src/build/host-sleep.ts) and `SLEEP_SPAN_TOLERANCE_MS` (src/build/build-check-events.ts). The quiet watch does not use them.

**Fix.** Count only awake time in every silence the quiet watch judges:
- Add `sampleSleep?: SleepSampler` to `PiWatchdogDeps`, defaulting to `sampleSleepClock`. Part 2/3 adds the same field; if it is already there, reuse it.
- Take a sleep sample when the watch starts. On each tick, compare `Date.now()` with the previous tick's. A suspended host leaves a gap longer than the tick period, so only when the gap exceeds the period by more than `SLEEP_SPAN_TOLERANCE_MS`, sample again without blocking the tick. Then record `sleptMsBetween(previous, current)` as a sleep span `{ endAt, ms }` when it is at least `SLEEP_SPAN_TOLERANCE_MS`, and keep the new sample as the baseline. Gating on the gap keeps the per-tick cost at zero on an awake host. On macOS each sample execs two `sysctl` calls.
- Replace each `Date.now() - t` silence reading in `startQuietWatch` with an awake-time reading: the wall time since `t`, minus the part of each recorded span that falls after `t`.
- An empty sample (a platform with no sleep clock, or a failed read) records no span, which is today's behaviour. Update the `startQuietWatch` comment and the matching docs/invariants.md text in the same change.

**Acceptance criteria** (test/pi-watchdogs.test.ts, driven through a scripted `sampleSleep` and a clock the test controls, never a real suspend):
- A run whose only silence is a recorded 40-minute sleep, with no awake silence past its quiet window, is not quiet-killed. It has made progress, `quietMs` is 30 minutes, and the next progress arrives right after wake.
- The same run with no sleep recorded, silent for the same wall time, is still quiet-killed.
- A pending model reply whose wait is 25 wall minutes, 22 of them a recorded sleep, raises no `model request unanswered` warning at a 5-minute threshold. At 25 awake minutes it warns, and the warning's duration reads the awake minutes.
- An open tool call silent across a recorded sleep is neither stall-warned nor stall-killed until its awake silence crosses the bound.
- A sampler that returns empty samples leaves every existing pi-watchdogs.test.ts and runner-quiet-watchdog.test.ts case passing unchanged.

### Host sleep, part 3/3: a model check whose probe window held a host sleep fails the pair and holds every role, instead of retrying (found by an operator session 2026-11-19, split 2026-11-21 by the plan role)

Siblings: "Host sleep, part 1/3: the quiet and stall clock…" (evidence and sleep measure) and "Host sleep, part 2/3: the run deadline…". This is separate from the open "The model check fails a pair on queue position…" entry, which covers server admission while the host is awake.

On 11-19, during the lid-closed stretch, five `model check failed: … gave no reply` warnings fired, at 07:06, 11:54, 13:25, 13:52 and 14:59. Each held all 29 runners. Each handed back the runs waiting on a reply, which then ended `aborted` after 7–145 minutes: feature, bugfix, qa, organize, selfcheck, bugfix-2, plan, bugfix-3, and some of them more than once.

**Cause.** `runModelCheck` in src/model-check/model-check-probe.ts runs one probe capped at `MODEL_CHECK_TIMEOUT_S` (300 s) and returns `judgeModelReply`'s verdict. A probe that slept through its window reads as `no reply` like a dead backend.

**Fix.**
- Give `runModelCheck` an optional `sampleSleep: SleepSampler = sampleSleepClock` parameter, the build check's seam shape (`runBuildCheck`, src/build/build-check.ts). Sample sleep before and after the probe.
- When the verdict is `{ ok: false, reason: "no reply" }` and `sleptMsBetween` reports at least `SLEEP_SPAN_TOLERANCE_MS`, run the probe once more and return the second verdict, whatever it is. Any other verdict, or a window with no measured sleep, returns as today.
- Do not retry a second time: a host that sleeps through two probes in a row gets the second verdict.

**Acceptance criteria** (test/model-check-probe.test.ts, fake pi shim and a scripted sampler):
- A first probe that gives no reply inside a window holding a recorded sleep, followed by a probe that answers correctly, yields an `ok` verdict.
- A no-reply probe with no recorded sleep yields the `no reply` verdict without a second probe. The shim is invoked once.
- A probe that answers wrong (`reason` other than `no reply`) inside a sleep window is not retried.
- Two consecutive no-reply probes, both across sleeps, yield `no reply` after exactly two invocations.

### An extra instance that is never admitted keeps its staged claim, so a higher backlog entry waits while a lower-index sibling takes a later one (found by an operator session 2026-11-19)

**Needs review 2026-11-21 by feature: too large for one run.** The three fix directions each touch a different scheduler seam: claim staging (`scope.ts`), admission ordering (`orderForAdmission` / `admissionHolds`, `skip.ts`), and a claim transfer between runners. Picking one is a design choice the plan role should split out before any single run can land it.

With `roles.bugfix.instances: 3`, tumwater keeps six bugfix runner ids (`RUNNERS_PER_INSTANCE` = 2, src/roles/runner-ids.ts). It admits a runner only while fewer than 3 are writing (`admissionHolds`, src/scheduling/skip.ts). `orderForAdmission` (src/scheduling/scope.ts) prefers the lowest index, but every idle instance can be handed a claim. On 11-19 this caused two inversions:
- **Bugs.** At 09:46:35 bugfix-2, bugfix-3 and bugfix-4 were assigned BUGS.md's top three open entries. bugfix-4 holds "Five root-walk tests fail on a shared host…" (line 53) and has not started a run since 11-09 (`skipReason: "instances-full"` in `.tumwater/state/bugfix-4.json`). At 11:55 bugfix, freed when its change merged, took the next entry instead: "`a corrupted cache entry is ignored…`" (line 61). It ran that entry at 13:33. The root-walk bug is still unworked 7.5 h after it was claimed.
- **Plans.** At 15:44 feature-4 was assigned "Operator steering, part 2/5" (PLANS.md line 264) and has never run. After the 16:39 restart, feature took "Remove the TUI, part 1/5" (line 426) and started it at once.

The claim is released only by the 24 h stale sweep (`CLAIM_IDLE_MAX_MS`), or when the instance is disabled or paused. An instance that is enabled but never admitted is none of those, so the entry stays held while the lower-index runners keep winning admission.

**Reproduce.** In `.tumwater/log/events.jsonl`, pair each `claim` `assigned` event with that runner's next `run_start`. Since 11-19, bugfix-4's and feature-4's claims have no `run_start` at all, while siblings' later claims start within 0–219 minutes. `tumwater backlog` shows both entries as being worked.

**Suspected cause / fix direction.** Claim staging and admission disagree about who will run next. Options:
- Stage claims only on runners that admission would let in.
- Have admission prefer the runner that holds the highest-placed backlog entry, rather than the lowest index.
- When a lower-index runner becomes free while a higher-index sibling's claim is still waiting, move that claim to it.

### The budget-fallback e2e `a reached cap switches roles to the free fallback model instead of stopping them` reds a full e2e step once, then passes isolated and in the tier re-run — the 2026-11-20 headroom bar admits a quiet sample and the 150 s spawn wait still starves (found by the ci role 2026-11-20)

**Needs review 2026-11-21 by feature: too large for one run.** The entry leaves a design fork open (drive the spawn wait on a fake or nominal clock, or re-sample load mid-wait and defer), and starvation cannot be reproduced offline: both load samples the 2026-11-20 fix checks read quiet (2.76/2.70 on 18 cores), so a mid-wait load gate may not see the starvation either. The planner should pick the option and say how it is verified.

**Symptom.** In the CI workflow's own e2e step (`npm run test:e2e`) against main tip `fa69a208` (lock md5 `ed710f21`), one test failed: `a reached cap switches roles to the free fallback model instead of stopping them` (test/orchestrator-budget.e2e.test.ts:210), `Error: timed out waiting for a role run after the cap was reached` at **150431 ms** — its own full wall budget, so the wait never got the run-start marker at all. The same tip's `npm test` (guard, lint, tsc, stamp, full unit runner) was green with no failing test.

**Why it is a flake, not a regression.** Two checks, both in this run: re-running that one test in isolation on a host the gate reads as quiet passed in **1.2 s**, and a second full `npm run test:e2e` at the same tip reached its summary with no failure and no skip. No file under `src/budget`, `src/runner`, `src/orchestrator` or `src/process` moved since the last covered green tip `d6d3def9` (`git diff --name-only d6d3def9..HEAD -- src/budget src/runner src/orchestrator src/process` printed nothing), so nothing on the budget-gate or run-spawn path this test drives changed.

**What the 2026-11-20 fix did not close.** That fix (BUGS-FIXED.md, fixed 2026-11-20 by the bugfix role; `QUIET_HOST_HEADROOM`/`quietHostBar` in test/helpers/wait.ts) judged both averages against 0.8 × cores, so admission saw load 2.76/2.70 on 18 cores against a bar of 14.4 and admitted. The single `recheckQuietHost()` sample taken immediately before the 150 s wait also passed. The wait still starved: on this shared host other runs (sibling role runs, review checks, the `_main-full` baseline mirror) saturate cores inside the 150 s window with no signal either gate can see, because both samples are point-in-time and the e2e tier's files run one at a time, so nothing in-process explains the starvation.

**Reproduce.** `npm run test:e2e` on a host whose load rises after the tier starts; the test prints its duration at 150 s (L4's tell for a starved wall budget, not a verdict). The test itself is deterministic and fast when the host is idle: the same file in isolation finishes in seconds.

**Required behavior.** A full e2e step must not carry a red from a 150 s wall-clock wait the host starved after admission. Options the class has already sketched, none landed: drive the run-start-marker wait on the fake clock the watchdog tests use, or re-sample the host during the wait and skip when it crosses the bar mid-wait. The 150 s bound itself is not the lever (the 2026-10-25/26 entries record the ceiling, not a bound).

### A change whose own commit message says it leaves tests failing still merges, because nothing reads the author's declared-red RISK or VERIFIED line (reported by the user 2026-11-20, split 2026-11-21 by the plan role)

The report held two gaps. This entry is the first, the declared-red reply. The second, the budgeted gate selecting too few dependents of a widely read default, reverses the gate's documented trade-off ("a test this leaves out costs a red main that the watch finds and ci heals forward", test/affected-tests.ts's header). That makes it the operator's call, so it is QUESTIONS.md's "Should a change to a widely read default run more than the budgeted gate?" and not a bug here.

Feature run #3029's revision `dac2a150b` ("Set the default work-instance count to 3; rewrap its doc comment") merged on 2026-11-20 at 15:43 PST. Its own RISK line said "the change is NOT complete — the flip leaves the suite red: `npm run test:rerun` fails 22 tests in claims, backlog-pending, run-prompt, role-view, doctor-checks, status-data, team-alerts, config, cli-diff, change-data-scope, gui-client-boot, gui-operator, scheduling, run-stage". Its VERIFIED line said the change "is not suite-green as it stands". Its gate `build_check` passed (28 tests in 8.2 s, none of the 22) and it merged. The main watch flagged it `main_culprit` at 15:50, and main stayed red until the ci role's `ccdfe746b` at 19:18, blocking an operator's 0.9.0 cut.

**Reproduce.** `git show -s dac2a150b` shows the RISK and VERIFIED lines above. The run's staging (`stageRunMerge`, src/run/run-stage.ts) never reads either line: `runStageSelfCheck` gets its findings only from `ctx.stageCheck` (the tree checks in src/stage/stage-check.ts) and the moved-entry checks.

**Fix direction (chosen by the plan role).** Refuse it at the authoring turn, in the self-check this file already uses, not at merge time:
- A pure detector over the staged description's `risk` and `verified` text (the `StagedCommitDescription.body` that `resolveCommitDescription` returns) reports whether the author declared the change incomplete or the suite red. It matches, case-insensitively, the incident's forms: "not complete", "incomplete", "not suite-green", and "leaves the suite red" / "the suite (is|stays) red". It does not fire on a conditional risk ("a wrong field would make the status test fail"), nor on a line that blames main's known-red tests ("main already fails …", "known red").
- `runStageSelfCheck` adds one finding when the detector fires. The finding quotes the declaring phrase and asks the author to make the failing tests pass or revert the change. It goes through the existing `applyStageFixUp` turn.
- After that turn, the detector runs again over the fix-up reply's RISK/VERIFIED, or over the original lines when the reply gives none. If the declaration survives, the change is not queued. The worktree is reset, `fileUnclosedSelfCheckFindings` files the finding, and the run ends `no_change` flagged `selfCheckReverted`, the same ending a fix-up that reverts the whole change gets today.

**Acceptance.**
- A run whose reply's RISK reads "the change is NOT complete — the flip leaves the suite red" gets one fix-up turn whose findings name that phrase. A run whose RISK reads "a wrong field would make the status test fail" gets no such finding.
- If the fix-up reply's RISK/VERIFIED no longer declares red (and the stage checks pass), the change is committed and pinned as today.
- If the fix-up reply still says "not suite-green", no merge ref is pinned, no merge is queued, the worktree is clean, BUGS.md gains the filed finding, and the outcome is `no_change` with `selfCheckReverted: true`.
- Tests: the detector's positive and negative forms in its own unit test, and the three staging outcomes in test/run-stage.test.ts using its existing fake `stageCheck`/`requestStageFix` context.

**Related, seen in the same run.** Run #3029's claim was "Remove the TUI, part 3/5", but it implemented "Three work instances by default, part 2/2". The plan entry it actually worked on was never claimed, so another instance could have taken it at the same time.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
