# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### The budget-fallback e2e re-checks the quiet-host bar mid-wait, so a host that re-saturates inside a 150 s spawn wait skips the file instead of reddening a verdict a starved host never fairly reached (planned 2026-11-21 by the plan role, closing the Needs-review note on the BUGS.md flake "The budget-fallback e2e … reds a full e2e step once …")

**Planning decision (2026-11-21).** The flake's fork — drive the spawn wait on the fake clock, or re-sample load mid-wait and defer — is resolved to the second: re-sample the host during the wait and skip when a sample crosses the bar. Drive-the-clock would put the e2e tier on two clocks (the harness already sleeps wall-clock across poll loops, merges, and resize phases in the same test), and the *witness the wait waits on* is the orchestrator's real spawn of a fake pi shim over a real filesystem — advancing fake time changes nothing the host's load postpones. The load can rise after both point-in-time samples (the 2026-11-20 evidence: both read ≤ 2.76 on 18 cores) and only stall postpones the spawn, so re-sampling while waiting is exactly what the starvation makes observable, and it is verified the same two ways the class already verifies: a deterministic fake-clock test, and a stated inference from the shipped sample.

**Approach.**
- Add `waitForQuietHost(pred, what, waitMs, opts?)` to test/helpers/wait.ts as the mid-wait gate: it polls `pred` (the marker) exactly like `waitFor` (a deadline, not a fixed sleep — 100 ms cadence), and every `pollEvery` ms (default 2_000 ms — the burn-poll cadence — via the existing `recheckQuietHost`) takes one quiet-host sample; when a sample crosses the bar it returns `{ deferred: true, load1, load5, cpus }` and stops polling, otherwise it returns `{ deferred: false }` the moment `pred` holds. No helper holds a `TestContext` — the call site `t.skip`s on `deferred: true` with the same load-named message `recheckQuietHost`'s inline skip already uses (`host load … e2e deferred after the load rose, not a verdict`). `sample` and `clock` are injectable (defaults: `sampleHostLoad`, `liveWaitClock`) so a unit test pins the crossing deterministically with `test/fakes/time.ts`'s `fakeClock`.
- Convert the three 150 s spawn waits the 2026-11-20 flake and the 2026-11-12 commentary already identify: the "a role run after the cap was reached" and "the first fallback run" waits in `test/orchestrator-budget.e2e.test.ts`, and the "overlapping runs after the grow" wait in `test/orchestrator-resize.e2e.test.ts` — each shim-marker `waitFor(…, 150_000)` becoming a `waitForQuietHost(…, …, 150_000)` call with the same predicate and wording. These are the one class of wait — the orchestrator must schedule a real child on a host only stall postpones — that the 150 s bound exists for (BUGS.md 2026-10-27); the other `150_000` waits in the suite (the stale-pin clear in `test/orchestrator-3.e2e.test.ts`, the `budget_paused` probe in `test/orchestrator-probe.test.ts`, the counting probe in `test/launch-services.e2e.test.ts`) wait on events or files, not a child spawn, and are left as-is.

**Acceptance criteria.**
- test/wait.test.ts (where `awaitQuietHost`/`recheckQuietHost` already live): with a fake `LoadSampler` pinned to two scripts (quiet while `clock.now() < 60_000`, then `load1`/`load5` at 0.9 × cpus) and `fakeClock`, `waitForQuietHost(() => false, "never true", 120_000 /* + opts */)` returns `{ deferred: true, load1, … }` shortly after the sampler crosses, without living through the full 150 s budget — `deferred: true` no later than the post-cross sample, and the returned reading equals the crossing sample's values. With the sampler pinned quiet always and a predicate that turns true at `clock.now() >= 60_000`, it returns `{ deferred: false }` and does not report a crossing. A crossing sample after the predicate already held does not flip the verdict.
- The three e2e call sites, when `waitForQuietHost` reports `deferred: true`, `t.skip` (not fail) with a load-named message; when it reports `deferred: false`, the assertion after the wait runs exactly as today — a host that stays under the bar the whole wait skips nothing and the test completes.
- `waitForQuietHost` keeps `awaitQuietHost`'s bar (`quietHostBar`, 80% of cores) — a single home of the bar, so the mid-wait gate and the admission gate can never disagree.
- docs/invariants.md INV-F2 (the e2e tier's quiet-host bar) is updated in the same commit: the guarantee's re-check half grows the mid-wait re-sample (`waitForQuietHost`) alongside the single-sample re-check, and the Binds and Pinned-by lines name the new helper and its test/wait.test.ts cases.

### Busy model check, part 1/2: the runner records when a team run's model request on a pair was last answered, so the model check can tell a busy server from a dead one (planned 2026-11-21 by the plan role, split from the BUGS.md entry "The model check fails a pair on queue position…" found by the bugfix role 2026-11-21)

Sibling: BUGS.md "Busy model check, part 2/2: a probe that gets no reply while the team's runs on the same pair are being answered…" uses this signal and is held until this part lands. **Direction picked 2026-11-21 by the plan role:** a verdict-level rule (part 2/2), not reserving a concurrency slot. On 11-17 the server kept starting the team's cache-hit follow-ups ahead of the probe's uncached request under memory pressure. One fewer team run does not change that admission order, and the team's runner count is not the server's `--max-concurrent`.

**Evidence (11-17).** The team runs every role on one local pair, `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` (Splash 1.6.1, `--max-concurrent 4`). The model check failed four times ("no answer within 300s") and each failure held all 19 runners. The Splash log shows the server answering. The probe's uncached requests were `Cancelled` with output 0 and never `Started`, while the memory-starved server kept starting cache-hit follow-ups for the running sessions. To reproduce: in `~/qwenrunner/logs/splash.8090.log`, 11-17 section, filter 14:02–14:28 to `Started|Done|Cancelled`. Compare with the `warning` events in `.tumwater/log/events.jsonl` at 14:08:57–14:27:20 and the `model_check_passed` event at 14:27:20.

**Cause (this part).** The harness has no record of a reply arriving. `RoleRunner` learns only the unanswered-wait toggles: `RunnerPi`'s `replyWait` host hook (src/runner/runner-pi.ts), fed by `onUnansweredReply` in src/pi/pi-watchdogs.ts. The answer edge exists only inside the parser: `foldPendingReply` (src/pi/pi-event-line.ts) closes `PiStreamParser.pendingReply` (src/pi/pi-stream.ts) on a content-bearing `message_update` or a non-failed assistant `message_end`.

**Fix.**
- `PiStreamParser` calls an optional answered callback each time `pendingReply` goes from open to closed, at both of its `foldPendingReply` sites.
- `AgentRunOptions` gains `onModelAnswered?: () => void` (src/agent/agent-run.ts), wired to that callback.
- `RunnerPi` wires it for authoring runs only, the same `kind === "author"` gate `onUnansweredReply` uses, to a new host hook `replyAnswered?(pair: string)` with `seamPairName(resolved)`.
- `RoleRunner` keeps the latest answer time per pair in memory. It is transient, never persisted, and it outlives the run, because a run that was answered and then ended inside a probe's window is still evidence. `RoleRunner` exposes it as `lastAnsweredAt(pair: string): number | null`.
- No consumer changes in this part.

**Acceptance criteria.**
- test/pi-event-line.test.ts (where `PiStreamParser` is already exercised): feeding an assistant `message_start` and then a content-bearing `message_update` fires the answered callback once. A content-free `message_update` does not fire it. A `message_end` with `stopReason: "error"` does not fire it. A later non-failed `message_end` on the same open request fires it. A `message_end` with no open request does not fire it again.
- A runner test using the fake pi shim: after an authoring run whose scripted reply streams content on pair P, `lastAnsweredAt(P)` is a time within the run's start and end. `lastAnsweredAt` of a pair the run did not use is null. The value is still readable after the run has ended.

## Done

_None yet._
