# Invariants

What each subsystem promises, stated where a fixer can read it. A bug report often says what
broke without saying what the code was supposed to guarantee; this register is that guarantee,
grouped by the boundary it binds. Read the section for the code you are about to change before
you reconstruct its contract from the tests and the surrounding code.

Each entry:

- **id** — stable, so a bug or a review can name it (`INV-A1`). Ids never change; an entry that
  is retired is struck through and dated, never renumbered.
- **Guarantee** — one sentence, described from the code's side.
- **Binds** — the modules and surfaces the guarantee spans.
- **Pinned by** — the `test/...` case(s) that enforce it. A cited test must exercise the
  guarantee, not merely touch the module; if a test is renamed or moved, update the citation in
  the same commit.

**Keep it honest.** A landing that adds or changes a guarantee updates this file in the same
commit, and every invariant keeps a resolvable test citation: a stale citation is a visible
broken link, not silent drift. Do not state a guarantee here that no test pins — add the test
with the entry, or leave the guarantee out.

## Cross-surface agreement: one fact, one computation

When two surfaces show the same fact, one module computes it and both read that computation.
Two independent derivations drift, and the drift is invisible until one surface contradicts the
other.

### INV-A1: one rule decides which agent binaries the fleet needs

**Guarantee.** The set of agent backends the fleet will actually spawn is computed once by
`agentsInUse`, so doctor checks exactly the binaries the startup gate would require — neither a
binary the fleet never runs nor a missing one it does.

**Binds.** `src/gates/startup-gate.ts` (`agentsInUse`), `src/doctor/doctor-checks.ts`
(`checkAgentBinary`), `src/pi/pi-bin.ts` (`resolveAgentBin`).

**Pinned by.** `test/doctor-checks.test.ts` — "checkAgentBinary checks the enabled seams'
agents, not always pi" (a claude-only fleet passes with `claude` present and fails when it is
absent, rather than checking pi).

### INV-A2: both stall surfaces apply the same piped-hang threshold

**Guarantee.** A command whose stdout is piped or redirected carries no silence signal, so both
stall surfaces judge it by the same wall-clock threshold from `bufferedCommandStallMs`, and both
classify the command with the same `commandBuffersOutput` — the event feed's warning and the
dashboard's flag agree on when a buffered command is stalled.

**Binds.** `src/pi/command-shape.ts` (`bufferedCommandStallMs`, `commandBuffersOutput`),
`src/pi/pi-watchdogs.ts` (runPi's stall warning), `src/ui/progress-data.ts`
(`stalledToolLabel`, the in-flight flag).

**Pinned by.** `test/pi.test.ts` — "a piped command open past the buffered wall-clock threshold
warns even though it holds its bytes" and "a stalled piped-stdout call warns nothing; the
redirect is found in the full command, not the truncated label"; `test/progress.test.ts` — "a
piped call is flagged past the buffered wall-clock threshold, not the silence one".

## Reader and writer over a persisted or appended file

A file that one process appends to or persists and another reads has two ends to agree on: the
byte at which the reader stops, and how a hand-edited or partially written value reads. The
reader must tolerate what the writer can produce.

### INV-B1: the event-log window consumes complete lines, not torn ones

**Guarantee.** The window reader consumes a complete trailing JSON line even when its newline is
still in flight, and leaves a torn (mid-JSON) fragment unconsumed, with `liveEnd` at the last
complete line, so a resumed ingest re-reads only what the writer had not finished.

**Binds.** `src/events/event-window.ts` (`readWindowEvents`), `src/events/event-read.ts`,
`src/events/events.ts`.

**Pinned by.** `test/event-window.test.ts` — "a trailing complete-JSON line without its newline
is consumed and moves liveEnd past it" and "a trailing torn fragment is left unconsumed, with
liveEnd at the last complete line".

### INV-B2: non-finite or incomplete slot records read as absent

**Guarantee.** A `slots.json` value that a hand edit can write but `JSON.stringify` cannot
(`1e999` parses to a non-finite number) reads as absent: a non-finite `pinnedAt` or
`lastReleasedAt` is no pin and no last release, and an incomplete lease frees the slot rather
than reading as a live claim.

**Binds.** `src/git/slots-state.ts` (`readSlotsState`, `writeSlotsState`),
`src/files/json-object.ts` (`finiteNumber`), with `src/git/worktree-pool.ts` as the reader's
consumer.

**Pinned by.** `test/worktree-pool.test.ts` — "a slot record's non-finite timestamps read as
absent, not as a stuck pin" and "a slot record's non-finite lease numbers read as no lease".

## Sibling result shapes a classifier treats alike

When a classifier groups outcomes into classes, every result shape that belongs to a class must
be treated as that class. A shape added later is easy to leave behind, and the omission shows as
a count that does not match the table it summarizes.

### INV-C1: the error section itemizes the `error` and `main_red` tick outcomes

**Guarantee.** The failure report's error section selects exactly the tick outcomes whose
`result` is `error` or `main_red` — caused or cause-less, with no error-text test — so its total
equals the Outcome table's error column plus its `main_red` cells, and a tick counted in the
table never vanishes from the section built to itemize it.

**Binds.** `src/failure/failure-data.ts` (`collectFailureReport`), `src/failure/failure-render.ts`
(`renderFailureMarkdown`), `src/failure/failure-cluster.ts`.

**Pinned by.** `test/failure-render.test.ts` — "a main_red tick's cause is clustered with the
tick errors, not left a bare count" (asserts the section total equals the Outcome tables' error
column plus `main_red` cells).

### INV-C2: every failed landing prices its authoring span as error-class

**Guarantee.** The time-spend classifier prices a change whose landing failed — `rejected`,
`review_error`, and `merge_conflict` alike — as error-class authoring hours, and each such span
is itemized under a loss cause matching its result: a review rejection as a `review-rejected`
cause carrying its rejection reason, a `review_error` under the matching review-failure cluster,
and a conflict under a `merge-conflict` cause taking the shared no-text placeholder — a conflict
names no rejection and is not invented as one.

**Binds.** `src/failure/time-spend.ts` (`timeAndSpend`), `src/failure/failure-data.ts`
(`collectFailureReport`).

**Pinned by.** `test/failure-time-spend.test.ts` — "a review-rejected change's authoring hours
price into error-class, not landed" (its `coverage` fixture prices a rejected landing's span as
error-class under a `review-rejected` cause carrying the reason; its `organize` fixture prices
the `merge_conflict` arm as error-class under a `merge-conflict` cause with the shared no-text
placeholder, not a review-rejection), and "a review_error landing prices its authoring hours
under the matching review_failed cause".
