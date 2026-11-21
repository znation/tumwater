# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

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
