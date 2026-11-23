# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### A shared merge-settle waiter retires the recurring live-orchestrator merge-queue flake: tests
  wait on a merge *effect* — its pin deleted, its entry dropped — then count merge events, and
  read `merge_done` / `merge_failed` short because the settle appends them after the effect lands
  (planned 2026-11-23 by the steward role, promoted from six fixed or quarantined records in
  this area — four carrying `gap:** no-repro`, one `no-observability`, one `none`; two of them
  closed by hand-writing a wait for the settle's event — and the same window is open in BUGS.md
  today; the fixture that would retire it does not exist)

**Why:** five incidents in the live-orchestrator merge-queue tests — the six records above, the
dedup flake filed twice — each repaired at its own site:

  `an entry whose sha main already holds is dropped at the drain without a merge run` failed only
  in full-file runs and was fixed by anchoring the first-merge wait on `hello.txt` present in the
  primary repo (`test/orchestrator-3.e2e.test.ts`, fixed 2026-10-30; filed twice, the first record
  `no-repro` because it passed in isolation on the same tree, the second `none` once the whole
  file reproduced it in-process).
  `a role rejected in its verify runs again while another queued change is still in review` was
  fixed by waiting for `clean`'s `merge_failed` and its entry's drop before the next leg (fixed
  2026-11-01, `no-observability` — a leaked permit read as live contention).
  `a verification rejection drops its entry at once — its role may run next poll — and the next
  queued entry starts on the next drain` failed then passed on the same tree, and its fix polls
  for the settle's event (quarantined 2026-11-11, `no-repro` — "a read landing in the window
  between the gate's pin-delete and the settle's write, which only widens on a loaded host").
  `a pin surviving a restart drains through the gate on next start` was gated on `awaitQuietHost()`
  with `t.skip` under load (fixed 2026-11-15, `no-repro`) — the same test filed the entry now open
  in BUGS.md, where its `merge_done` count read 0, then 1 on the same tree.
  `restart hand-off: an in-flight merge outliving its deadline is aborted, not waited out` failed
  then passed on the same tree, its premise broken by a scheduling change (quarantined
  2026-10-31, fixed 2026-11-01, `no-repro`).

The recurring part is the wait, not the cause: each one read a merge event after an effect- or
state-keyed wait, and the quiet-host gate the 2026-11-15 fix added (INV-F2's bar) does not close
the window — it only defers the test. The ordering is worth naming once: a merged change's pin is
deleted inside the merge (`src/merge/merge-core.ts:544`, on `result === "changed"`), and the
queue's `merge_done` / `merge_failed` event is appended afterwards in the settle
(`src/merge/merge-slot.ts:436-438`, reached from `settleOne` at `src/merge/merge-drain.ts:414-419`).
The runner-state save sits at `src/merge/merge-slot.ts:418`, *before* that event write, so waiting
on `loadRunnerState(...).lastResult` does not close the window either; only the merge marker lands
after it — `settleMergeOutcome` (`src/merge/merge-pipeline.ts:189, 199`) writes the outcome and
logs the event first, then clears the marker (`removeMergeChange`). On a loaded host that gap
widens past one poll, and an exact-count or deepEqual assertion is the first thing to notice.

**Approach:** one exported waiter in `test/fixtures/orchestrator-fixtures.ts` — the file both
live-orchestrator test files already import, and which holds the matching `awaitSettledRun` helper
at its line 324 — shaped like `awaitMergeSettled(repo, role, what, ms?)`: it polls until the
settle's terminal `merge_done` or `merge_failed` event for that role is visible in `readEvents`,
and returns that event, so a caller asserts the count and the event's `result` from one read.
`pinDrained` (`test/fixtures/merge-fixtures.ts:127`) is not the answer: it reads the in-memory
pipeline's `mergeTasks`, so it serves only the offline `test/merge-pipeline.test.ts` and
`test/merge-drain.test.ts` pumps, which settle synchronously.

**Sites to convert** (line numbers at main's tip as of 2026-11-23; re-derive them, they drift):
`test/orchestrator-3.e2e.test.ts:109` (state + ref wait) before the `merge_failed` count at
`:119-120`; `:210` (pin deleted plus `crash.txt` on main) before the `merge_done === 1` at `:216`
and `merge_failed === 0` at `:221` — today's open flake; `:267` (pin dropped as stale) before the
same pair at `:272` and `:277`; `:515` (state + ref) before the `merge_failed` deepEqual array at
`:523-528`; and `test/orchestrator-director.test.ts:307` (a parked-gate flag file) before the
`merge_failed` map deepEqual at `:316-318`. Two sites already hand-write this leg —
`test/orchestrator-3.e2e.test.ts:261` and `:314`, each waiting for `hello.txt` plus
`merge_done === 1` with the same explanation duplicated at 258-259 and 311-312 — replace both with
the helper so the reasoning lives once. Leave the already-event-keyed waits alone (`:604`, `:682`,
and `test/merge-pipeline.test.ts:338`, whose comment at 334-337 already reconstructs this write
order), and leave the `:335` wait (pin absent and the merge marker gone) — its marker leg already
implies the event by the write order above — converting it only if the helper reads more clearly.

**Docs:** record the guarantee in `docs/invariants.md` under `## Hermetic, deterministic gating
tests` (INV-F1 at 630, INV-F2 at 653) as `### INV-F3:` — a live-orchestrator test reads a merge's
queue events only after the shared settle waiter has seen that merge's terminal event, never
immediately after a ref-, state-, or queue-shaped wait, since the pin, the runner state and the
outcome all reach disk before the event does. Both tiers are covered: the `.e2e.` files and
`test/orchestrator-director.test.ts`, which starts the same live orchestrator but runs in the
gating tier because its name carries no `.e2e.` part.

**Acceptance criteria:** a unit test for the waiter over a hand-written event log
(`test/fixtures/log-fixtures.ts`: `writeEvents` at 61, `eventsOfType` at 108) on the existing fake
clock (`test/fakes/time.ts` `fakeClock`, used by `test/wait.test.ts`) — it resolves with the
settle's event and its `result`, resolves for either terminal type, and times out on a log holding
neither. Then the sites above convert, `test/orchestrator-3.e2e.test.ts` and
`test/orchestrator-director.test.ts` re-run, and today's BUGS.md repro holds: `a pin surviving a
restart drains through the gate on next start` counts 1, not 0, in the full e2e tier.

**Do not:** change `src/` to log the event before the pin delete — the pin is deleted at the gate
on purpose, so a restart cannot re-merge a change whose merge already ran, and the settle's later
event is the record of the outcome; add no further `awaitQuietHost()` gate and no raised
`waitFor` deadline (the 2026-11-15 fix tried the gate and the window survived it, and INV-F2
already owns the host-load bar); quarantine or delete none of these tests; and do not fold this
into the offline pipeline fixtures, which have no live event log to poll.


## Done
