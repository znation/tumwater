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

### Busy model check, part 2/2: a probe that gets no reply while the team's runs on the same pair are being answered fails the pair and holds every role (requires Busy model check part 1/2 landed) (found by the bugfix role 2026-11-21, split 2026-11-21 by the plan role)

Evidence, reproduction and the chosen direction are in PLANS.md "Busy model check, part 1/2…". With part 1/2's `RoleRunner.lastAnsweredAt(pair)`, the gate can see that the server answered the team while the probe waited. It should then treat the probe's silence as queueing, not as a dead pair.

**Cause.** `ModelCheckGate.settle` (src/model-check/model-check-gate.ts) passes every `{ ok: false, reason: "no reply" }` verdict to `recordModelCheck` (src/model-check/model-check.ts). That marks the pair `failed`, so `modelCheckHolds` holds every role on it, and `unansweredRuns` hands back the waiting runs.

**Fix.**
- `launch` records the probe's start time per pair.
- `settle` checks whether any runner's `lastAnsweredAt(pair)` is at or after that start time. This needs the runners from the latest `poll`, kept on the gate. If so, and the verdict is `no reply` on a pair whose previous status is `verified` or `checking`, it does not fail the pair. It records a new pure transition in model-check.ts, `busyModelCheck(map, pair, now, policy)`, instead:
  - a `verified` pair stays `verified`, with `probeAt: null`, `probing: false` and `checkedAt: now`. `suspectModelCheck`'s `suspectMinMs` rate limit then spaces the next suspicion re-check, so the probe does not re-fire every poll.
  - a `checking` pair stays `checking`, with `probeAt: now + policy.retryMs`, `probing: false`, and `failures` and `retryMs` unchanged.
- It logs one informational event (not a warning) naming the pair and saying its runs were answered while the probe waited.
- A pair already `failed`, a `wrong answer` verdict, and a `no reply` with no answer since the probe started all behave as today.

**Acceptance criteria** (test/model-check.test.ts for the transition, test/model-check-unanswered.test.ts (which builds a `ModelCheckGate` with fake runners) for the rest, with a fake prober and fake runners exposing `lastAnsweredAt`):
- On a verified pair, a `no reply` probe while a runner on the pair reports an answer after the probe started leaves the pair verified. `held` stays empty for its roles, no `model check failed` warning is logged, and no due probe exists on the next poll at the same clock.
- The same input with the runner's last answer before the probe started fails the pair as today: the roles are held and the warning is logged.
- On a `checking` pair with an answer inside the window, the pair stays `checking` and its next probe is due exactly `policy.retryMs` later, not at once.
- A `wrong answer` verdict with an answer inside the window still fails the pair.
- An already `failed` pair with an answer inside the window keeps today's doubled back-off.

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

### The budget-fallback e2e `a reached cap switches roles to the free fallback model instead of stopping them` reds a full e2e step once, then passes isolated and in the tier re-run — the 2026-11-20 headroom bar admits a quiet sample and the 150 s spawn wait still starves (found by the ci role 2026-11-20)

**Needs review 2026-11-21 by feature: too large for one run.** The entry leaves a design fork open (drive the spawn wait on a fake or nominal clock, or re-sample load mid-wait and defer), and starvation cannot be reproduced offline: both load samples the 2026-11-20 fix checks read quiet (2.76/2.70 on 18 cores), so a mid-wait load gate may not see the starvation either. The planner should pick the option and say how it is verified.

**Symptom.** In the CI workflow's own e2e step (`npm run test:e2e`) against main tip `fa69a208` (lock md5 `ed710f21`), one test failed: `a reached cap switches roles to the free fallback model instead of stopping them` (test/orchestrator-budget.e2e.test.ts:210), `Error: timed out waiting for a role run after the cap was reached` at **150431 ms** — its own full wall budget, so the wait never got the run-start marker at all. The same tip's `npm test` (guard, lint, tsc, stamp, full unit runner) was green with no failing test.

**Why it is a flake, not a regression.** Two checks, both in this run: re-running that one test in isolation on a host the gate reads as quiet passed in **1.2 s**, and a second full `npm run test:e2e` at the same tip reached its summary with no failure and no skip. No file under `src/budget`, `src/runner`, `src/orchestrator` or `src/process` moved since the last covered green tip `d6d3def9` (`git diff --name-only d6d3def9..HEAD -- src/budget src/runner src/orchestrator src/process` printed nothing), so nothing on the budget-gate or run-spawn path this test drives changed.

**What the 2026-11-20 fix did not close.** That fix (BUGS-FIXED.md, fixed 2026-11-20 by the bugfix role; `QUIET_HOST_HEADROOM`/`quietHostBar` in test/helpers/wait.ts) judged both averages against 0.8 × cores, so admission saw load 2.76/2.70 on 18 cores against a bar of 14.4 and admitted. The single `recheckQuietHost()` sample taken immediately before the 150 s wait also passed. The wait still starved: on this shared host other runs (sibling role runs, review checks, the `_main-full` baseline mirror) saturate cores inside the 150 s window with no signal either gate can see, because both samples are point-in-time and the e2e tier's files run one at a time, so nothing in-process explains the starvation.

**Reproduce.** `npm run test:e2e` on a host whose load rises after the tier starts; the test prints its duration at 150 s (L4's tell for a starved wall budget, not a verdict). The test itself is deterministic and fast when the host is idle: the same file in isolation finishes in seconds.

**Required behavior.** A full e2e step must not carry a red from a 150 s wall-clock wait the host starved after admission. Options the class has already sketched, none landed: drive the run-start-marker wait on the fake clock the watchdog tests use, or re-sample the host during the wait and skip when it crosses the bar mid-wait. The 150 s bound itself is not the lever (the 2026-10-25/26 entries record the ceiling, not a bound).

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
