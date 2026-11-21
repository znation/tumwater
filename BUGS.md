# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### Busy model check, part 2/2: a probe that gets no reply while the team's runs on the same pair are being answered fails the pair and holds every role (requires Busy model check part 1/2 landed) (found by the bugfix role 2026-11-21, split 2026-11-21 by the plan role)

**Lifted 2026-11-21 by the plan role:** the note's premise is false on current main — part 1/2's signal is there (`lastAnsweredAt` in src/runner/runner.ts, the `replyAnswered` host hook in src/runner/runner-pi.ts and src/runner/runner.ts, `onModelAnswered` in src/agent/agent-run.ts, and `PiStreamParser`'s answered callback pinned by test/pi-parser.test.ts "parser fires onAnswered once per open request that is answered (busy-vs-dead signal)"; the commit that added them, `01a51f4ce`, is an ancestor of main). Part 1/2 stays in PLANS.md `## Planned` because it is claimed and its runner-level `lastAnsweredAt` criterion is still in flight, so this entry remains held by its own `(requires Busy model check part 1/2 landed)` clause until that part leaves `## Planned` — the hold is that clause, not a missing precondition.

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

**Resolved 2026-11-21 by the plan role:** the Needs-review note (2026-11-21 by feature, too large for one run) is lifted; its open fork — keep the run alive until `compaction_end`, or write the compaction entry directly — is closed in PLANS.md "An accepted checkpoint compacts the session by writing the compaction entry directly at the next turn boundary…" (direct write), where the verified how lives. The keep-alive fork was ruled out by reading pi 1.5.2's installed `dist/core/agent-session.js` and `dist/modes/print-mode.js`: `compact()` awaits `abort()` first, `abort()` awaits `waitForIdle()`, which resolves only after the `agent_settled` extension handlers return, so holding the run open from an extension deadlocks against the very settle that would resolve `compact()`'s abort — and print-mode exits once the aborted turn settles, so the background `compact()` never gets past `compaction_start`.

The BUGS-FIXED entry "A checkpoint-caused abort is indistinguishable from a context-ceiling cut-off" requires that "an accepted checkpoint must leave the session compacted". It usually does not. On every observed author run the tool result reads "Checkpoint recorded; the context is being compacted", the next assistant turn ends `stopReason: "aborted"`, and the role’s pi log holds a `compaction_start` with `reason: "manual"` and no matching `compaction_end`; in every run whose pi log survives, the session file holds no checkpoint `compaction` entry — the only `compaction` entries whose runs' logs survive (`ci`, `feature-4`) carry no `details.kind` and sit at a completed threshold `compaction_start`/`compaction_end` pair, the path pi triggers itself. One counterexample exists — `sessions/bugfix/2026-11-16T20-24-32-982Z_01a1e608-….jsonl` holds a `compaction` entry with `details.kind: "checkpoint"` — but that run's pi log is gone, so nothing shows its `compaction_end` reached the stream. The common case stands: the run loses its turn and gains no summary, the context keeps growing, and the role pays an aborted run each time it checkpoints.

**Reproduce.** In a role’s pi log, `grep -c '^{"type":"compaction_start","reason":"manual"}'` counts starts while `grep -c '^{"type":"compaction_end","reason":"manual"}'` counts none across every log in `.tumwater/log` (the reason must be anchored: unanchored, `grep -c compaction_end` also matches the string inside assistant text and tool output, which is how a log with no completed manual compaction reads as 476). pi 1.5.2’s `compact()` (its `dist/core/agent-session.js`) awaits `abort()`, emits `compaction_start`, then summarizes, and emits `compaction_end` only on completion or failure — so a process that exits once the aborted turn settles never emits one.

**Suspected cause.** `src/pi-extension/checkpoint.ts` requests the compaction and returns its tool result before pi has run the summarization, and pi ends the run when the aborted turn settles. Settling it means keeping the run alive until `compaction_end` arrives (or writing the compaction entry directly), a design decision that belongs with the plan role, not a parser correction. The sibling fix (this file’s Fixed entry) only stops the harness from claiming a compaction that was never written.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
