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

### INV-A3: one rule shapes the event feed and one decides its grep

**Guarantee.** The dashboard's activity rows are computed once: `eventFeedItem` shapes each
`HarnessEvent` for both the status payload's `eventItems` and `GET /api/logs`, and
`eventMatchesGrep` decides both the CLI's `tumwater logs --grep` and the endpoint's `grep`, so
the surfaces cannot disagree on a feed row's fields or on what a pattern matches.

**Binds.** `src/events/event-format.ts` (`eventFeedItem`, `eventMatchesGrep`),
`src/ui/status-payload.ts` (`eventItems`), `src/cli/log-commands.ts` (`cmdLogs`),
`src/gui/gui-endpoints.ts` (`handleLogs`).

**Pinned by.** `test/gui-endpoints.test.ts` — "handleLogs serves the matched tail oldest-first
as feed items, composing grep and role" (the handler's answer equals
`readEventsTailWithEnd(...).events.filter(eventMatchesGrep).map(eventFeedItem)`) and "the live
server routes GET /api/logs to the slice handler".

### INV-A4: the config help example names no key the writer refuses as legacy-only

**Guarantee.** No key `tumwater help config` presents as a settable top-level example is
refused by `tumwater config set` as a legacy-only key absent a prior value — notably the
legacy-only `fallbackModel`, which `setConfigKey` declines to add to a config that lacks it.

**Binds.** `src/cli/help.ts` (the `config` stanza's example list), `src/config/config-write.ts`
(`setConfigKey`'s legacy `provider`/`fallbackModel` refusal).

**Pinned by.** `test/config-write.test.ts` — "the config help example names no key the writer
refuses as legacy-only" (reads the example's key list out of `helpTopic("config")` and asserts
`setConfigKey` does not refuse each as legacy, and that the list names `fallback` and not
`fallbackModel`).

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

### INV-B3: a whole-config write preserves the file's own roles section

**Guarantee.** Any `config set`/`unset` that does not name the `roles` section itself —
top-level, a dotted per-role map/tier/agent key, and the budget setter both dashboards use —
carries the raw file's `roles` section back exactly as it found it (and writes no section when
the file had none); the director's config request (`applyConfigRequest`) does the same while
stripping the entries of custom loops it removes. A dotted `roles.<id>.<field>` write updates
only that field and leaves the file's other role entries untouched. No such edit re-expands the
built-in catalog into tumwater.json; `roles` still merges per entry at load, so omission never
disables a role and the dotted `roles.<id>.enabled false` is the disable verb.

**Binds.** `src/config/config-write.ts` (`setConfigKey`, `unsetConfigKey`, `setDailyBudgetUsd`,
`applyConfigRequest`, `preserveFileRoles`).

**Pinned by.** `test/config-write.test.ts` — "a whole-config write preserves the file's own
roles section", "a whole-config write does not add a roles section the file never had", and
"dotted writes preserve the file's own roles section" — and `test/config-request.test.ts` —
"applyConfigRequest preserves the file's own roles section".

### INV-B4: an unreadable event feed is named, not rendered as idle

**Guarantee.** A windowed or one-shot read of `events.jsonl` reports its outcome as
`ok`/`empty`/`unreadable`: a present file whose bytes yield no parseable event line (a directory
at the path, a permission failure, or every complete line corrupt) reads `unreadable` and is
distinct from a missing or zero-byte feed's `empty`; an unreadable file outranks a readable
sibling, so a readable rotated archive cannot mask an unreadable live log. The failure digest renders
`log unreadable — evidence missing` for the unreadable case instead of `no events retained`, so
the telemetry role can tell "the fleet was idle" from "I could not read the log"; a
newline-less trailing fragment remains a write in flight and never by itself makes a feed
unreadable.

**Binds.** `src/events/event-window.ts` (`readWindowEvents`, `scanEventsFile`, `eventLogState`,
`EventLogState`), `src/failure/failure-data.ts` (`FailureReportData.logState`),
`src/failure/failure-render.ts` (`renderFailureMarkdown`), `src/doctor/doctor-checks.ts`
(`checkEventLog`).

**Pinned by.** `test/failure-render.test.ts` — "a present-but-unreadable feed is named
unreadable, not 'no events retained'" and "a log whose only lines are torn in flight still reads
as empty, not unreadable" and "a readable archive does not mask an unreadable live log";
`test/doctor-checks.test.ts` — "checkEventLog passes an absent log, fails an unreadable one, and
passes a readable one".

### INV-B5: an operator-filed entry is committed on main under the primary-worktree lock

**Guarantee.** `tumwater bug`/`tumwater plan`, the dashboard's New form, and the TUI's Ctrl+N
commit the one backlog file they wrote as `tumwater(operator): File <kind>: <title>` while
holding the primary-worktree lock `ffMainTo` takes, so the entry reaches main and the primary
checkout stays clean for the next fast-forward. Only that file is committed (other staged paths
stay staged). When the primary is not on the base branch, or git fails, the commit is skipped
(`commitOperatorBacklogEdit` returns false, never throws) and the entry stays written.

**Binds.** `src/backlog/backlog-commit.ts` (`commitOperatorBacklogEdit`), `src/backlog/backlog-write.ts`
(`announceFiled`), `src/gui/gui-endpoint-commands.ts` (`handleBacklogFile`), `src/ui/tui/tui-keys.ts`.

**Pinned by.** `test/backlog-commit.test.ts`.

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

## Disclosed cuts and recorded causes

A bounded view and a terminal decision each owe the reader the same thing: what the view left
out, and what the outcome was decided from. A silent cut reads as a complete list; a defaulted
outcome reads as evidence the run never produced. Both rules are stated here so a landing that
adds a capped view or a terminal outcome updates the record shape in the same commit.

### INV-D1: a capped failure-digest section discloses the count its cut dropped

**Guarantee.** Every failure-digest list section that cuts its list — the top-N error, warning,
review-failure and rejection clusters, the top-`LOSS_TOP` loss-cause ranking, the newest-
`STATE_CHANGE_TOP` state transitions, and the newest-`LANDED_TOP` merges — prints a remainder
line whose dropped count is derived from the same list the section itemized, so a cut section
never reads as a complete itemization of the window.

**Binds.** `src/failure/failure-data.ts` (the `*_TOP` caps, and the `hiddenClusters` /
`lossCausesHidden` / `stateChangesTotal` / `landedTotal` fields the render reads),
`src/failure/failure-render.ts` (`renderFailureMarkdown`, `renderClusters`), `src/failure/time-spend.ts`
(`LOSS_TOP`), `src/failure/failure-state-change.ts` (`STATE_CHANGE_TOP`).

**Pinned by.** `test/failure-render.test.ts` — "the top-N cluster sections mark their cut:
remainder line, no silent truncation", "a state changes section over the newest-6 cap names its
remainder instead of truncating silently", "a landed list over the newest-10 cap names its
remainder instead of reading as the whole window", and "the loss-cause ranking's top-5 cut
discloses its remainder, like every other capped section".

### INV-D2: an unparseable FLOW line and a signal-killed check record a cause, not a pass or a timeout

**Guarantee.** A malformed or truncated `FLOW:` line yields no `FlowResult` — `extractFlow`
requires the `passed|bug` verdict — so the qa rotation records nothing rather than defaulting to
`passed`, and a check killed by a signal is reported as a signal kill distinct from a timeout:
`killedPhrase` names the signal, and `tscVerdict` returns a signal-death rejection rather than a
timeout.

**Binds.** `src/verdict/reply-contract.ts` (`extractFlow`), `src/tick/tick-verdict.ts` (the
`ctx.flow && !diagnosis.cutOff` guard around `recordFlow`), `src/build/build-check-events.ts`
(`killedPhrase`, `timedOutPhrase`), `src/build/build-stage.ts` (`tscVerdict`).

**Pinned by.** `test/reply-contract.test.ts` — "extractFlow requires the verdict and keeps
hyphens in the name" and "extractFlow returns null when absent, empty, or only mid-sentence";
`test/build-check.test.ts` — "a merge-scope check killed by an external signal rejects, naming
the signal and real duration"; `test/build-stage.test.ts` — "compileStaged reads a tsc that died
by signal as a rejection even with output attached".

## Bounded waits: a step that produces no verdict cannot hold its caller forever

A wait on something outside the harness — a spawned child, a probe — is bounded so a hang is
reported as a hang instead of stalling the caller. State the bound here so a later change
cannot drop it silently.

### INV-E1: `tumwater notify --test` bounds its hook wait

**Guarantee.** `tumwater notify --test` stops waiting for a hook that does not finish within
`NOTIFY_TEST_TIMEOUT_MS` and reports the timeout with a non-zero exit, rather than awaiting the
hook forever; the bound is cleared on every outcome, so a hook that exits promptly never keeps
the CLI alive.

**Binds.** `src/cli/notify-command.ts` (`runNotifyHook`, `cmdNotify`, `NOTIFY_TEST_TIMEOUT_MS`).

**Pinned by.** `test/notify-command.test.ts` — "a hook that never exits is killed at the timeout
and reported, not awaited forever" and "runNotifyHook resolves a never-ending hook at the
injected timeout".

### INV-E2: a fleet that goes down unasked runs the configured notify hook once

**Guarantee.** When the supervisor logs `supervisor_exit` (a generation died unasked or the
crash-loop guard tripped), it runs the `notify` command from tumwater.json once, with no
throttle; a missing or invalid tumwater.json or an absent `notify` pages nothing and never throws.

**Binds.** `src/events/notify.ts` (`notifyFleetDown`) and `src/cli/cli-run.ts`
(`superviseRunCommand`'s `onFleetDown`).

**Pinned by.** `test/cli-run-shutdown.test.ts` — "a fleet that goes down unasked runs the notify
hook once"; `test/notify.test.ts` — the `notifyFleetDown` tests.

### INV-E3: a notify hook that exits nonzero leaves a warning naming the paged type

**Guarantee.** When the notify hook exits nonzero or is killed by a signal while the fleet is
still running, one `warning` from loop `harness` names the paged event type and the exit code or
signal; a clean exit logs nothing and the page is not retried.

**Binds.** `src/events/notify.ts` (`notifyExitWarning` and the `exit` listener in
`spawnNotifyCommand`).

**Pinned by.** `test/notify.test.ts` — the `notifyExitWarning` test and "a notify hook that exits
nonzero logs one warning naming the paged type".

## Hermetic, deterministic gating tests

The gating tier (`npm test`'s `*.test.ts` files, which run on every landing) reads the host's
state and time only through seams a test controls: a live probe or a real listener makes the
suite answer the machine it happens to run on, and a live clock lets a loaded host report a
spent budget as a product failure (the `no-repro` gap in BUGS.md). State the rule here so a new
gating test reaches the host through the seam, not around it.

### INV-F1: the gating tier probes no live host and takes its clock from a seam

**Guarantee.** In the gating tier — every `test/*.test.ts` except the `*.e2e.test.ts`
live-orchestrator files — a test probes no live host (it spawns no `lsof`/`top`/`sysctl` and
reads no literal `/proc` path) and binds no real listener (no `.listen(`/`createServer(`),
unless the guard's explicit allowlist names the file and why; and a test that asserts a
deadline, window, backoff, or poll interval takes its clock from an injected seam
(`test/fakes/time.ts`'s `fakeClock`/`sleepRecorder`, `test/helpers/sleep-clock.ts`'s
`scriptedSampler`, or `test/helpers/wait.ts`'s `watchdogClock`) rather than the live one, with a
flake fixed by converting the failing case into a deterministic regression instead of widening
its budget.

**Binds.** `test/invariants-doc.test.ts` (`hermeticProblems`, `HERMETIC_ALLOWLIST`),
`test/fakes/time.ts`, `test/helpers/sleep-clock.ts`, `test/helpers/wait.ts`.

**Pinned by.** `test/invariants-doc.test.ts` — "a planted live-host probe and a planted listener
bind are reported; an e2e source is not" and "this repo's gating test sources probe no live host
and bind no real listener". The flake-regression half is pinned by `test/orchestrator-probe.test.ts`
— "a demoted fallback admits exactly one probe tick per cool-down; other due roles wait", whose
hold assertions wait on the injected breaker clock's own reads instead of a wall-clock sleep. The
deadline-clock half and the remaining flake regressions are pinned by the cases the plan's parts
2/5–5/5 add.
