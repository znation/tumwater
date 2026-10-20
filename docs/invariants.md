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

**Keep it honest.** A merge that adds or changes a guarantee updates this file in the same
commit, and every invariant keeps a resolvable test citation: a stale citation is a visible
broken link, not silent drift. Do not state a guarantee here that no test pins — add the test
with the entry, or leave the guarantee out. Each title quoted after a cited test path must name
a test in that file, and a trailing `…` cites by prefix.

## Cross-surface agreement: one fact, one computation

When two surfaces show the same fact, one module computes it and both read that computation.
Two independent derivations drift, and the drift is invisible until one surface contradicts the
other.

### INV-A1: one rule decides which backend binaries the team needs

**Guarantee.** The set of backends the team will actually spawn is computed once by
`agentsInUse`, so doctor checks exactly the binaries the startup gate would require — neither a
binary the team never runs nor a missing one it does.

**Binds.** `src/gates/startup-gate.ts` (`agentsInUse`), `src/doctor/doctor-checks.ts`
(`checkAgentBinary`), `src/pi/pi-bin.ts` (`resolveAgentBin`).

**Pinned by.** `test/doctor-checks.test.ts` — "checkAgentBinary checks the enabled seams'
agents, not always pi" (a claude-only team passes with `claude` present and fails when it is
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
stripping the entries of custom roles it removes. A dotted `roles.<id>.<field>` write updates
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
the selfcheck role can tell "the team was idle" from "I could not read the log"; a
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

### INV-B5: an entry you filed is committed on main under the primary-worktree lock

**Guarantee.** `tumwater bug`/`tumwater plan`, the dashboard's New form, the TUI's Ctrl+N, and
`tumwater brief --file`/`--edit` and the dashboard's brief Save (the brief file, as `tumwater(operator): Edit brief`)
commit the one file they wrote as `tumwater(operator): File <kind>: <title>` while
holding the primary-worktree lock `ffMainTo` takes, so the entry reaches main and the primary
checkout stays clean for the next fast-forward. Only that file is committed (other staged paths
stay staged). Your cancel, edit, and question answer (`--cancel`, `--edit`, `questions answer`, and the dashboard and TUI equivalents) commit their file the same way, as `Cancel <kind>: <title>`, `Edit <kind>: <title>`, and `Answer question: <title>`; your release (`--release` and the dashboard's Release, `handleBacklogRelease`) commits `Release <kind>: <title>` and wakes the kind's role unless the entry stays held, which every surface reports with `stillHeldNote` and which wakes no role; your reorder (`--top`, the dashboard's Move to top `handleBacklogTop`, and the TUI's Ctrl+V) commits `Prioritize <kind>: <title>` and wakes no role; a refused or no-op write commits nothing. A question answer also wakes the role named in the heading's `(asked by <role> …)` clause when it is a known role, and wakes no role for an unknown or missing asker (`test/question-asker.test.ts`). When the primary is not on the base branch, or git fails, the commit is skipped
(`commitOperatorBacklogEdit` returns false, never throws) and the entry stays written.

**Binds.** `src/backlog/backlog-commit.ts` (`commitOperatorBacklogEdit`), `src/backlog/backlog-cli.ts`
(`announceFiled`), `src/gui/gui-endpoint-commands.ts` (`handleBacklogFile`), `src/ui/tui/tui-keys.ts`, `src/cli/brief-command.ts`, `src/brief/brief-edit.ts`, `src/gui/gui-endpoint-commands.ts` (`handleBriefEdit`), `src/gui/gui-backlog-commands.ts` (`handleBacklogRelease`, `handleBacklogTop`).

**Pinned by.** `test/backlog-commit.test.ts`, `test/brief-command.test.ts`, `test/gui-endpoints.test.ts`.

### INV-B6: a scheduled stop fires once, is consumed when it fires, and is cleared at a fresh `start`

**Guarantee.** `tumwater stop --in` writes `.tumwater/stop-at.json`; the running team's
`armScheduledStopWatch` calls its stop closure exactly once when `until` passes and removes the
marker first. A fresh unsupervised `tumwater start` clears a stale marker. `scheduledStopAt` never
throws: a missing, torn, or non-finite marker reads as no stop.

**Binds.** `src/team/team-state.ts` (`scheduleStop`, `scheduledStopAt`, `cancelScheduledStop`), `src/cli/cli-start.ts` (`armScheduledStopWatch`).

**Pinned by.** `test/scheduled-stop.test.ts`.

## Sibling result shapes a classifier treats alike

When a classifier groups outcomes into classes, every result shape that belongs to a class must
be treated as that class. A shape added later is easy to leave behind, and the omission shows as
a count that does not match the table it summarizes.

### INV-C1: the error section itemizes the `error` and `main_red` run outcomes

**Guarantee.** The failure report's error section selects exactly the run outcomes whose
`result` is `error` or `main_red` — caused or cause-less, with no error-text test — so its total
equals the Outcome table's error column plus its `main_red` cells, and a run counted in the
table never vanishes from the section built to itemize it.

**Binds.** `src/failure/failure-data.ts` (`collectFailureReport`), `src/failure/failure-render.ts`
(`renderFailureMarkdown`), `src/failure/failure-cluster.ts`.

**Pinned by.** `test/failure-render.test.ts` — "a main_red run's cause is clustered with the
run errors, not left a bare count" (asserts the section total equals the Outcome tables' error
column plus `main_red` cells).

### INV-C2: every failed merge prices its authoring span as error-class

**Guarantee.** The time-spend classifier prices a change whose merge failed — `rejected`,
`review_error`, and `merge_conflict` alike — as error-class authoring hours, and each such span
is itemized under a loss cause matching its result: a review rejection as a `review-rejected`
cause carrying its rejection reason, a `review_error` under the matching review-failure cluster,
and a conflict under a `merge-conflict` cause taking the shared no-text placeholder — a conflict
names no rejection and is not invented as one.

**Binds.** `src/failure/time-spend.ts` (`timeAndSpend`), `src/failure/failure-data.ts`
(`collectFailureReport`).

**Pinned by.** `test/failure-time-spend.test.ts` — "a review-rejected change's authoring hours
price into error-class, not merged" (its `coverage` fixture prices a rejected merge's span as
error-class under a `review-rejected` cause carrying the reason; its `organize` fixture prices
the `merge_conflict` arm as error-class under a `merge-conflict` cause with the shared no-text
placeholder, not a review-rejection), and "a review_error merge prices its authoring hours
under the matching review_failed cause".

## Disclosed cuts and recorded causes

A bounded view and a terminal decision each owe the reader the same thing: what the view left
out, and what the outcome was decided from. A silent cut reads as a complete list; a defaulted
outcome reads as evidence the run never produced. Both rules are stated here so a merge that
adds a capped view or a terminal outcome updates the record shape in the same commit.

### INV-D1: a capped failure-digest section discloses the count its cut dropped

**Guarantee.** Every failure-digest list section that cuts its list — the top-N error, warning,
review-failure and rejection clusters, the top-`LOSS_TOP` loss-cause ranking, the newest-
`STATE_CHANGE_TOP` state transitions, and the newest-`MERGE_DONE_TOP` merges — prints a remainder
line whose dropped count is derived from the same list the section itemized, so a cut section
never reads as a complete itemization of the window.

**Binds.** `src/failure/failure-data.ts` (the `*_TOP` caps, and the `hiddenClusters` /
`lossCausesHidden` / `stateChangesTotal` / `mergedTotal` fields the render reads),
`src/failure/failure-render.ts` (`renderFailureMarkdown`, `renderClusters`), `src/failure/time-spend.ts`
(`LOSS_TOP`), `src/failure/failure-state-change.ts` (`STATE_CHANGE_TOP`).

**Pinned by.** `test/failure-render.test.ts` — "the top-N cluster sections mark their cut:
remainder line, no silent truncation", "a state changes section over the newest-6 cap names its
remainder instead of truncating silently", "a merged list over the newest-10 cap names its
remainder instead of reading as the whole window", and "the loss-cause ranking's top-5 cut
discloses its remainder, like every other capped section".

### INV-D2: an unparseable FLOW line and a signal-killed check record a cause, not a pass or a timeout

**Guarantee.** A malformed or truncated `FLOW:` line yields no `FlowResult` — `extractFlow`
requires the `passed|bug` verdict — so the qa rotation records nothing rather than defaulting to
`passed`, and a check killed by a signal is reported as a signal kill distinct from a timeout:
`killedPhrase` names the signal, and `tscVerdict` returns a signal-death rejection rather than a
timeout.

**Binds.** `src/verdict/reply-contract.ts` (`extractFlow`), `src/run/run-verdict.ts` (the
`ctx.flow && !diagnosis.cutOff` guard around `recordFlow`), `src/build/build-check-events.ts`
(`killedPhrase`, `timedOutPhrase`), `src/build/build-stage.ts` (`tscVerdict`).

**Pinned by.** `test/reply-contract.test.ts` — "extractFlow requires the verdict and keeps
hyphens in the name" and "extractFlow returns null when absent, empty, or only mid-sentence";
`test/build-check.test.ts` — "a merge-scope check killed by an external signal rejects, naming
the signal and real duration"; `test/build-stage.test.ts` — "compileStaged reads a tsc that died
by signal as a rejection even with output attached".

## Bounded waits: a step that produces no verdict cannot hold its caller forever

A wait on something outside tumwater — a spawned child, a probe — is bounded so a hang is
reported as a hang instead of stalling the caller. State the bound here so a later change
cannot drop it silently.

### INV-E1: `tumwater notify --test` bounds its hook wait

**Guarantee.** `tumwater notify --test` stops waiting for a hook that does not finish within
`NOTIFY_TEST_TIMEOUT_MS` and reports the timeout with a non-zero exit, rather than awaiting the
hook forever; the bound is cleared on every outcome, so a hook that exits promptly never keeps
the CLI alive. The dashboard's `POST /api/notify-test` runs the same test under the same bound.

**Binds.** `src/cli/notify-command.ts` (`runNotifyHook`, `testNotifyHook`, `cmdNotify`, `NOTIFY_TEST_TIMEOUT_MS`) and
`src/gui/gui-config-commands.ts` (`handleNotifyTest`).

**Pinned by.** `test/notify-command.test.ts` — "a hook that never exits is killed at the timeout
and reported, not awaited forever" and "runNotifyHook resolves a never-ending hook at the
injected timeout"; `test/gui-endpoints.test.ts` — the `handleNotifyTest` tests.

### INV-E2: a team that goes down unasked runs the configured notify hook once

**Guarantee.** When the supervisor logs `supervisor_exit` (a generation died unasked or the
crash guard tripped), it runs the `notify` command from tumwater.json once, with no
throttle; a missing or invalid tumwater.json or an absent `notify` pages nothing and never throws.
A once round's `ONCE_FAILED_EXIT_CODE` is an asked-for ending and pages nothing.

**Binds.** `src/events/notify.ts` (`notifyTeamDown`) and `src/cli/cli-start.ts`
(`superviseRunCommand`'s `onTeamDown`).

**Pinned by.** `test/cli-start-shutdown.test.ts` — "a team that goes down unasked runs the notify
hook once"; `test/notify.test.ts` — the `notifyTeamDown` tests; `test/supervisor.test.ts` — "a
once round's failed exit code passes through without paging".

### INV-E3: a notify hook that exits nonzero leaves a warning naming the paged type

**Guarantee.** When the notify hook exits nonzero or is killed by a signal while the team is
still running, one `warning` from role `harness` names the paged event type and the exit code or
signal; a clean exit logs nothing and the page is not retried.

**Binds.** `src/events/notify.ts` (`notifyExitWarning` and the `exit` listener in
`spawnNotifyCommand`).

**Pinned by.** `test/notify.test.ts` — the `notifyExitWarning` test and "a notify hook that exits
nonzero logs one warning naming the paged type".

## Hermetic, deterministic gating tests

The gating tier (`npm test`'s `*.test.ts` files, which run on every merge) reads the host's
state and time only through hooks a test controls: a live probe or a real listener makes the
suite answer the machine it happens to run on, and a live clock lets a loaded host report a
spent budget as a product failure (the `no-repro` gap in BUGS.md). State the rule here so a new
gating test reaches the host through the hook, not around it.

### INV-F1: the gating tier probes no live host and takes its clock from a hook

**Guarantee.** In the gating tier — every `test/*.test.ts` except the `*.e2e.test.ts`
live-orchestrator files — a test probes no live host (it spawns no `lsof`/`top`/`sysctl` and
reads no literal `/proc` path) and binds no real listener (no `.listen(`/`createServer(`),
unless the guard's explicit allowlist names the file and why; and a test that asserts a
deadline, window, retry delay, or poll interval takes its clock from an injected hook
(`test/fakes/time.ts`'s `fakeClock`/`sleepRecorder`, `test/helpers/sleep-clock.ts`'s
`scriptedSampler`, or `test/helpers/wait.ts`'s `watchdogClock`) rather than the live one, with a
flake fixed by converting the failing case into a deterministic regression instead of widening
its budget.

**Binds.** `test/invariants-doc.test.ts` (`hermeticProblems`, `HERMETIC_ALLOWLIST`),
`test/fakes/time.ts`, `test/helpers/sleep-clock.ts`, `test/helpers/wait.ts`.

**Pinned by.** `test/invariants-doc.test.ts` — "a planted live-host probe and a planted listener
bind are reported; an e2e source is not" and "this repo's gating test sources probe no live host
and bind no real listener". The flake-regression half is pinned by `test/orchestrator-probe.test.ts`
— "a demoted fallback admits exactly one probe run per cool-down; other due roles wait", whose
hold assertions wait on the injected breaker clock's own reads instead of a wall-clock sleep. The
deadline-clock half and the remaining flake regressions are pinned by the cases the plan's parts
2/5–5/5 add.

## The merge gate's deterministic rejections

The gate rejects some changes without running a reviewer, because the exempt fast path for
markdown would otherwise merge them unreviewed.

### INV-G1: a role cannot merge a change to the brief block, or to PRINCIPLES.md unless it is the director or steward

**Guarantee.** A change that alters, removes, or deletes the text between the `tumwater:prompt`
markers of README.md or TUMWATER.md (a block that merely moves passes), or that touches
PRINCIPLES.md from a role whose base is neither `director` nor `steward`, is rejected before
review — md-only diffs included — and flagged at staging for one fix-up turn.

**Binds.** `src/review/protected-edits.ts`, `src/review/review.ts`, `src/run/stage-check.ts`.

**Pinned by.** `test/protected-edits.test.ts` (the per-case reasons), `test/review.test.ts` — "gate
rejects an md-only edit to the initial prompt block with no pi run" and "gate rejects an md-only
PRINCIPLES.md edit except from the steward" — and `test/stage-check.test.ts` — "an uncommitted
PRINCIPLES.md edit is a finding for a non-steward role only".

### INV-G2: a role cannot merge a change that writes a secret environment variable's value or a credential pi stores in `auth.json`/`models.json` into a file

**Guarantee.** A changed file whose content holds the value of a secret-named environment
variable (name matching token, secret, password, credential, or key; value of 16+ characters, no
whitespace, not a path), or a literal credential pi stores in `auth.json`/`models.json` (`apiKey`,
header values, `key`/`access`/`refresh`; not `$NAME` or `!command` values), that its merge-base
content did not hold is rejected before review —
md-only diffs included — and flagged at staging for one fix-up turn. The reason names the file and
variable or pi source, never the value.

**Binds.** `src/review/secret-leaks.ts`, `src/review/review.ts`, `src/run/stage-check.ts`.

**Pinned by.** `test/secret-leaks.test.ts` — "piCredentialValues returns literal apiKey, header,
key, access and refresh values", "piCredentialValues skips interpolations, commands and short dummy
keys", "secretLeakReason names the pi models.json source, never the value" — `test/review.test.ts` — "gate rejects an md-only change
that writes a secret env value, with no pi run" — and `test/stage-check.test.ts` — "an uncommitted
file holding a secret env value is a finding".

## Tumwater owns every commit

### INV-H1: a run's authoring, SUMMARY follow-up, and stage-fix runs cannot add a commit of their own to the merged history

**Guarantee.** Whatever commits an authoring, SUMMARY follow-up, or stage-fix run makes in its worktree are folded
(`git reset --soft` to the pre-run HEAD) before the verdict is read, so they end up inside the
run's single tumwater-stamped commit, and a clean tree after such a run is not `no_change`.

**Binds.** `src/git/git.ts`, `src/runner/runner-run.ts`, `src/run/run-stage.ts`.

**Pinned by.** `test/agent-commit-fold.test.ts` — "an agent commit beside uncommitted edits becomes
one harness commit", "an agent commit with a clean tree is not dropped as no_change", and the
two `foldCommitsSince` unit tests; `test/run-stage.test.ts` — "a commit made in the missing-SUMMARY
follow-up folds into the harness commit" and "a commit made in the over-long-SUMMARY follow-up folds
into the harness commit".

## The reviewer cannot author the merge

### INV-I1: a gate exit that keeps the change leaves the worktree at the head the gate reviewed

**Guarantee.** A gate exit that keeps the change after the reviewer ran (approved, or failed
without discard) resets the worktree to the head the gate reviewed, so neither the merge pin
nor the next re-review can include a commit the reviewer made. The reject and strike-cap discard
paths reset to main instead.

**Binds.** `src/review/review.ts`.

**Pinned by.** `test/review.test.ts` — "a reviewer's own commit is dropped on approve: the
worktree returns to the reviewed head" and "a reviewer's own commit is dropped when the review
fails strike-free".

## A blind image read cannot become an answered run

### INV-J1: a run whose agent reads an image its model cannot see is stopped and fails

**Guarantee.** When a pi authoring run's agent reads an image pi will strip from the request
(a model that does not support images — pi's non-vision note, or a model job whose effective image
input is false), the runner kills the run before its next event and the run ends `error` with
`lastError` naming the file and the model gap. A gate run's blind read is not killed; it is
recorded on the run and logged as `image_blind` with `action: "logged"`. An authoring run's
blind read logs `image_blind` with `action: "fail"`, and `modelFallbackVerdict` scores it
inconclusive (never a provider failure or an "answered").

**Binds.** `src/pi/pi-stream.ts` (`PiStreamParser.detectBlindRead`), `src/agent/run-agent.ts`
(the kill + result), `src/run/run-verdict.ts` (the fail branch),
`src/runner/model-fallback.ts` (`modelFallbackVerdict`).

**Pinned by.** `test/pi-parser.test.ts` — the blind-read detection cases; `test/pi.test.ts` —
"an authoring run that reads an image on a blind model is killed and fails" and "a gate run
that reads an image on a blind model is logged, not killed"; `test/run-verdict.test.ts` — "a
blind image read fails the run with an error naming the file and the model";
`test/runner-2.test.ts` — "a run whose agent reads an image on a blind model stops and fails".

### INV-J2: a blind read on a tier with an image-capable peer reroutes to it, and a rerouted run never hops twice

**Guarantee.** A blind read on a role whose tier has an image-capable reroute target (a peer
tier in the borrow order — the free fallback pairs only while the budget gate is on fallback
or the role is in a model-fallback episode) ends the run `aborted` with the `image-reroute`
resume cause and records a one-shot `RunnerState.imageReroute` marker naming the target model and backend
and the image. The next run starts directly on the target in a FRESH session over the kept
worktree — never `--continue` — carrying the handoff note that names the prior model and the
image, and its `run_start` is stamped `reroute: "image"`. A run that already started on the
target (`imageRerouteActive` true, the marker consumed at its start) does not reroute again: a
second blind read fails it. The marker is one-shot for the director too: a rerouted director
prompt runs fresh on the target and is delivered exactly once, then the director is back on its
own tier (its marker clears in `runTickPhase`, since the director never resumes and so never
reaches planTickStart's image-reroute branch). A queued prompt attaching an image hops straight
to the target at model choice when the role's model reads no images (`image_reroute`,
`preflight: true`); with no target the run errors without spawning pi.

**Binds.** `src/run/run-verdict.ts` (the reroute arm), `src/runner/runner-run.ts` (model choice
+ attachment preflight), `src/runner/runner.ts` (`runConfig`), `src/run/run-resume.ts` (the
image-reroute handoff), `src/prompt/prompt-followup.ts` (`buildHandoffPrompt`'s image-reroute
note), `src/events/event-format.ts` (the `image_reroute` and image-reroute resume lines).

**Pinned by.** `test/run-verdict.test.ts` — the reroute verdict tests (target + one-hop);
`test/runner-2.test.ts` — "a blind read on a text-only role reroutes to the vision target, then
back to its own tier" and "a rerouted director prompt runs fresh on the vision target and is
delivered once"; `test/prompt-followup.test.ts` — the handoff-note test;
`test/event-format.test.ts` — the `image_reroute` and image-reroute resume rendering tests.

## Self-redeploy runs only verified code

### INV-K1: self-redeploy only runs a commit with a green full-check verdict

**Guarantee.** The commit self-redeploy targets is main's newest first-parent commit newer than
the running build whose full-check verdict is green (observed or inherited), looking at most 64
commits down. A cached-red tip falls back to the newest older green; with none the red tip stays the
target and is blocked alone. An older commit with no green verdict is never a fallback, and the
verdict cache holds only full-check verdicts.

**Binds.** `src/baseline/main-baseline.ts` (`redeployTarget`), `src/orchestrator/orchestrator.ts`
(the target passed to `Redeployer.poll`), `src/redeploy/redeployer.ts`.

**Pinned by.** `test/redeploy-wiring.test.ts` — "redeployTarget picks main's newest green commit
newer than the running build, never a red or unverified-green one" and "redeployTarget never
targets an older commit that no check has called green".

## Main's red culprit

### INV-L1: an automatic revert only reverts a commit a non-director role merged, whose red reproduced and whose parent side is green

**Guarantee.** The revert task queued from a `main_culprit` event reverts only a commit that a
`merged` event credits to a runner whose base role is not the director, that is not itself a
revert, and whose revert has not already merged. The watch names a culprit only after its red
reproduced (the confirming re-run) and the last green commit below it is still green. Any other
culprit, and any revert that conflicts, fails its gate or loses the fast-forward, leaves main
unchanged and queues bugfix's heal prompt.

**Binds.** `src/baseline/main-revert.ts`, `src/baseline/main-culprit.ts`, `src/merge/merge-drain.ts`,
`src/orchestrator/orchestrator.ts`.

**Pinned by.** `test/main-revert.test.ts` — "a named culprit is reverted on main…", "a revert that
conflicts leaves main alone…" and "a director-merged, runnerless or revert culprit is skipped";
`test/main-watch.test.ts` — the culprit cases.

## The fallback breaker: a free fallback that cannot serve is demoted, not retried forever

The engaged free fallback is only worth running while it can serve. The breaker watches the runs
the fallback pair produces, demotes the pair when they keep failing, and lets it back one probe
run at a time. It binds the daily-cap path and the window-move path alike.

### INV-M1: consecutive fallback failures demote the fallback, and a demoted fallback admits one probe run per cool-down

**Guarantee.** `FALLBACK_BREAKER_POLICY.failureLimit` consecutive `error` outcomes on an engaged
fallback pair demote it. The count is team-wide; any served run in between resets the streak.
While the pair is demoted, `fallbackServing` is false and roles on it are paused. After the
cool-down, exactly one probe run is admitted while other due roles wait. A served probe closes the
breaker. A failed probe re-opens it with the cool-down doubled, capped at `maxCooldownMs`. A probe
that never ran, or produced no evidence, hands its slot back.

**Binds.** `src/budget/fallback-breaker.ts` (`fallbackServing`, `fallbackProbeDue`,
`startFallbackProbe`, `abandonFallbackProbe`), `src/orchestrator/orchestrator-launch.ts`.

**Pinned by.** `test/orchestrator-budget.e2e.test.ts` — "a free fallback whose runs keep failing is
demoted to a pause, then probed back once it serves"; `test/orchestrator-probe.test.ts` — "a
demoted fallback admits exactly one probe run per cool-down; other due roles wait";
`test/budget.test.ts` — "each failed probe doubles the cool-down up to its cap; a probe with no
evidence frees the slot"; `test/fallback-breaker.test.ts` — "fallbackServing is false exactly while
the breaker holds a demotion, probe included"; `test/orchestrator-launch.test.ts` — "a probe turned
away by the held start gate has its claim handed back".

### INV-M2: a change of subject re-trusts the fallback

**Guarantee.** Editing the cap, changing the fallback pair, or the gate leaving the fallback (local
midnight) replaces a demoted breaker with a fresh, trusted one on the next poll. Evidence about a
pair that is no longer engaged is dropped.

**Binds.** `src/budget/fallback-breaker.ts` (`rekeyFallbackBreaker`, `rekeyFallbackBreakers`),
`src/gates/gate-polls.ts`.

**Pinned by.** `test/fallback-breaker.test.ts` — "rekey keeps the same breaker while the subject is
unchanged, re-trusts on any change"; `test/budget.test.ts` — "rekeyFallbackBreaker clears a
demotion when the cap, the pair, or the day changes" and "a served straggler closes a demoted
breaker; evidence about another subject is dropped".

### INV-M3: runs a window move put on a fallback feed the breaker below the cap, and its demotion holds the moved tier

**Guarantee.** When a used-up claude window moves tiers to a fallback pair, those roles' run
outcomes fold into that pair's breaker even though the daily cap is not reached. A demoted pair
holds the moved tier's roles, with the same one-probe admission as INV-M1.

**Binds.** `src/gates/gate-polls.ts` (`pollTeamGates`, its `windowMovedRoles`),
`src/orchestrator/orchestrator-launch.ts`, `src/orchestrator/orchestrator-poll.ts`.

**Pinned by.** `test/gate-polls.test.ts` — "pollTeamGates: a used-up window's demoted fallback
holds the moved tier's roles below the cap"; `test/orchestrator-budget.e2e.test.ts` — "a window
move's failing fallback is demoted and its tier held, below the cap".

## Claims: one entry, one holder, in queue order

A claim decides which work-role instance takes which backlog entry. The queue is file order, a
dependency holds only through the heading's `requires` clause, and what releases a claim depends on
whether the runner is idle.

### INV-N1: each listed, eligible entry has at most one claim holder, and assignment takes the first free entry in file order

**Guarantee.** `assignNext` returns the first free entry in `## Planned` / `## Open` file order.
`heldKeys` keeps every same-base claim that is still listed and eligible out of the free set, and a
busy base runner with no claim holds the group. `eligibleEntries` drops an entry claimed by another
base role, but keeps the queried base's own claims.

**Binds.** `src/scheduling/claims.ts` (`assignNext`, `heldKeys`), `src/backlog/backlog-eligibility.ts`
(`eligibleEntries`), `src/orchestrator/orchestrator-scheduling.ts` (the scheduling poll that calls
`assignNext`).

**Pinned by.** `test/claims.test.ts` — "assignNext takes the first free entry in file order" and
"heldKeys counts a claim still listed and eligible and drops the rest";
`test/orchestrator-scheduling.test.ts` — "two feature instances take distinct entry claims in one
poll" and "a busy unclaimed base holds the group so a new instance cannot take its entry";
`test/backlog-eligibility.test.ts` — "eligibleEntries holds a plan another role's base has claimed,
but keeps the owner's own claim".

### INV-N2: a plan is held while a prerequisite named in its heading's requires clause is still planned, and only that clause holds it

**Guarantee.** `entryHoldAgainst` holds an entry whose heading's trailing parenthetical (or a
parenthetical left open by a wrapped heading) names, through `requiredParts`, a part still listed
under `## Planned`. Once no named part is planned, the hold lifts. A `requires` mention in the body
never holds. A note line (Refused, Needs review, Needs replan, Waiting for the next failure) holds
as well. `planDependencyProblems` reports a still-planned prerequisite named without the clause.

**Binds.** `src/backlog/backlog-eligibility.ts` (`requiredParts`, `entryHoldAgainst`,
`prerequisitesMerged`, `planDependencyProblems`), `src/run/stage-check.ts` and
`src/doctor/doctor-backlog.ts` (where the wording problem is reported).

**Pinned by.** `test/backlog-eligibility.test.ts` — "requiredParts reads the trailing
parenthetical, expands ranges, and resolves bare refs to the own series", "a body mentioning
'requires' never blocks — only the heading's clause does", "entryHold blocks a wrapped heading while
its prerequisite is planned", "prerequisitesMerged returns the refs only when none is still
planned", "entryHold reports blocked, refused, needs-review and needs-replan, and null when
eligible", "a waiting-for-the-next-failure note holds a bug, only as a line prefix" and
"planDependencyProblems flags a still-planned prerequisite named without a requires clause".

### INV-N3: a claim on an entry that left or turned ineligible is released outright; disabled, paused and stale release only an idle runner

**Guarantee.** `claimReleaseReason` returns `left` or `ineligible` whatever the runner is doing. It
returns `disabled`, `paused` (own instance id paused while the base role is not) or `stale` (idle
past `CLAIM_IDLE_MAX_MS`) only for an idle runner: one that is not running and has no queued merge
and no outstanding work. Pausing the whole base role keeps every claim. A released claim is saved
before the runner runs again.

**Binds.** `src/scheduling/claims.ts` (`claimReleaseReason`, `CLAIM_IDLE_MAX_MS`),
`src/runner/runner-state.ts` (`hasOutstandingWork`).

**Pinned by.** `test/claims.test.ts` — "claimReleaseReason releases left, ineligible,
disabled-idle, paused-idle and stale-idle claims" and "an idle extra with a revision, a queued
merge, a resume or a run in progress keeps its claim"; `test/orchestrator-scheduling.test.ts` — "a
claimed entry that merges releases the claim on the next poll", "pausing one instance releases its
claim so a sibling can take the entry", "pausing the whole feature role keeps every instance's
claim" and "a released claim is saved to disk before the runner runs again".

## The backlog archive: finished entries move once, and only the ones a change added

The archive moves finished entries out of PLANS.md / BUGS.md into PLANS-DONE.md / BUGS-FIXED.md: at
commit time (`archiveNewFinishedEntries`), in bulk (`archiveFinishedOnMain`, behind `tumwater
archive`) and at team start. Each rule below is the pure `archiveFinishedText`'s.

### INV-O1: the commit-time sweep moves only the entries the change added, to the top of the archive

**Guarantee.** `archiveFinishedText` with a `baseKeys` selection moves only the finished-section
entries whose heading key (`archiveKey`) the change's merge-base did not hold. They go above the
archive's existing entries, in their live order. Entries the base already held stay in the live
section. A `_None yet._` placeholder and the next section's heading are left in place.
`archiveNewFinishedEntries` computes the base from the worktree's merge-base with main.

**Binds.** `src/backlog/backlog-archive.ts` (`archiveFinishedText`, `archiveNewFinishedEntries`),
`src/run/run-stage.ts` (its call before the commit).

**Pinned by.** `test/backlog-archive.test.ts` — "the commit-time sweep moves only the entries the
change added, newest first, into a new archive", "the sweep prepends to an existing archive and
leaves entries the base already had", "the sweep keeps a placeholder in the live section and a
following section's heading intact" and "archiveNewFinishedEntries writes the move in a worktree
against its merge-base".

### INV-O2: an entry the archive already holds is never archived twice

**Guarantee.** A selected entry whose heading key the archive already holds does not move
(`entryFates`). With the same text (blank edges and trailing whitespace ignored, `entryText`) it is
dropped from the live section. With other text it stays in the live section, where the author and
the reviewer see it. This holds for the commit-time sweep, the bulk archive whatever it keeps, and
`archiveFinishedOnMain`.

**Binds.** `src/backlog/backlog-archive.ts` (`entryFates`, `entryText`, `archiveFinishedText`,
`archiveFinishedOnMain`).

**Pinned by.** `test/backlog-archive.test.ts` — "the sweep drops an added entry the archive holds
verbatim and leaves an edited copy in the live section", "a sweep that only finds re-pasted entries
empties the live section and leaves the archive as it was", "the bulk archive skips entries the
archive already holds, whatever it keeps" and "archiveFinishedOnMain drops a hand commit's re-pasted
entries instead of archiving them twice".

### INV-O3: with no archive file, the commit-time sweep leaves a live section that holds older entries as it is

**Guarantee.** When the archive file does not exist and the live finished section would still hold
other entries after the move, `archiveFinishedText` returns null for a `baseKeys` selection. Nothing
is written, so an archive never sits above older live history. The bulk archive (`keep`) still
creates the archive from `archiveTemplate`.

**Binds.** `src/backlog/backlog-archive.ts` (`archiveFinishedText`, `archiveTemplate`).

**Pinned by.** `test/backlog-archive.test.ts` — "the sweep moves nothing while legacy entries sit in
the live section and no archive exists" and "the bulk archive moves the whole body, one-line records
included, or all but the newest kept entries".
