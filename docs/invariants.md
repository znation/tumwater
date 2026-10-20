# Invariants

What each subsystem promises, stated where a fixer can read it. A bug report often says what
broke without saying what the code was supposed to guarantee; this register is that guarantee,
grouped by the boundary it binds. Read the section for the code you are about to change before
you reconstruct its contract from the tests and the surrounding code.

Each entry:

- **id** — stable, so a bug or a review can name it (`INV-A1`). Ids never change; an entry that
  is retired is struck through and dated, never renumbered. Each section takes the next unused prefix; after `INV-Z`
  prefixes run on in two letters (`INV-AA`, `INV-AB`, …).
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
`backendsInUse`, so doctor checks exactly the binaries the startup gate would require — neither a
binary the team never runs nor a missing one it does.

**Binds.** `src/gates/startup-gate.ts` (`backendsInUse`), `src/doctor/doctor-checks.ts`
(`checkBackendBinary`), `src/pi/pi-bin.ts` (`resolveBackendBin`).

**Pinned by.** `test/doctor-checks.test.ts` — "checkBackendBinary checks the enabled seams'
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

### INV-A5: a Markdown table's separator always matches its header

**Guarantee.** `markdownTable` derives the separator row from the header, one `---` cell per
header cell (`---:` where `align` says `right`, left past the end of `align`), and renders cells
verbatim. So the failure digest's tables and the usage report's day table can never emit a
separator that collapses the table into plain text.

**Binds.** `src/text/markdown.ts` (`markdownTable`), `src/failure/failure-render.ts`,
`src/report/report-render.ts`.

**Pinned by.** `test/markdown.test.ts` — "markdownTable's separator always carries as many cells
as the header" and "markdownTable defaults every column to left alignment".

### INV-A6: the prompt and CLI numbered lists number through one helper

**Guarantee.** `numberedList` numbers items from 1 as `N. item`, one per line, and returns its
`empty` argument verbatim for no items. The review prompt's prior objections and findings, the
rejected/revision notes, `tumwater questions`' list and `wake --list` all build through it. Two surfaces number their own lines and are not bound:
the TUI's queued-prompt rows (`src/ui/tui/tui.tsx`) push one styled row per item, and the merge
queue's rows (`src/merge/merge-queue-render.ts`) are indented and carry per-row columns.

**Binds.** `src/text/markdown.ts` (`numberedList`), `src/prompt/gate-prompts.ts`,
`src/prompt/gate-notes.ts`, `src/backlog/question-answer.ts`, `src/operator/operator-intent.ts`
(`renderWakeList`).

**Pinned by.** `test/markdown.test.ts` — "numberedList numbers items from 1, one per line" and
"numberedList returns the empty fallback verbatim for no items"; `test/operator-intent.test.ts` —
"renderWakeList numbers wakes and words the empty case".

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
rejects an md-only edit to the brief text block with no pi run" and "gate rejects an md-only
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
`prerequisitesMerged`, `planDependencyProblems`), `src/run/stage-backlog-checks.ts` and
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

## Provider concurrency: every run holds one team permit and at most one provider slot

The counting semaphore (`maxConcurrent`) bounds how many runs the team has in flight, and its
per-key caps (`maxConcurrentPerProvider`) bound how many of those sit on one provider. A run's
lease moves with it: it is re-keyed to the provider the run actually uses, and it is released once.
The build-check cap (`check-permit.ts`) and the cross-process mutex (`lock.ts`) are separate
subsystems and not covered here.

### INV-P1: admission needs both a team permit and the provider key's headroom, and a full key never delays another

**Guarantee.** `acquireLease(tier, key)` is granted only while the team total has a free permit and
the key, when it has a cap (`enforcedKeyCaps`), has headroom. A parked waiter whose key is full does
not hold back a waiter for another key, and waiters for one key are granted in FIFO order.

**Binds.** `src/concurrency/semaphore.ts` (`Semaphore.acquireLease`, `enforcedKeyCaps`),
`src/merge/merge-pipeline.ts`.

**Pinned by.** `test/semaphore.test.ts` — "semaphore bounds concurrency" and "two keys fill
independently: a full key never delays a free key, FIFO within a key";
`test/orchestrator-permits.e2e.test.ts` — "maxConcurrentPerProvider caps role-run admission per
provider while others run beside (part 2/5)" and "a verify's reviewer and a role run on the same
capped provider never overlap, while another provider runs beside (part 3/5)".

### INV-P2: a cap change never preempts, and permits never leak

**Guarantee.** Growing a cap wakes parked waiters up to the new headroom and no further. Shrinking
below the in-use count stops nothing already in flight and grants nothing until releases drain under
the cap. Repeated resizes leave the counts whole, and capacity is fully restored after a burst.

**Binds.** `src/concurrency/semaphore.ts` (`setCapacity`, `setKeyCaps`),
`src/config/config-live.ts`.

**Pinned by.** `test/semaphore.test.ts` — "growing capacity wakes queued acquirers up to the new
headroom, never beyond it", "shrinking below current in-use admits no new work until releases drain
under the cap", "shrinking a key below its in-use preempts nothing and grants nothing until releases
drain", "repeated grow/shrink cycles leak no permits and starve no waiter" and "capacity fully
restores after a burst: no slot leak".

### INV-P3: wait order is by tier, FIFO within a tier, and the reserve holds a permit for work roles

**Guarantee.** Parked waiters are ordered by tier, a lower tier ahead of a higher one, and FIFO
within a tier. A higher tier is not starved: once no lower-tier waiter is parked, it drains FIFO.
The reserve withholds permits from tier 1 and above (maintenance), so a work acquirer finds one
free; the verify and merge tiers ignore the reserve.

**Binds.** `src/concurrency/semaphore.ts` (`acquire`, `acquireLease`).

**Pinned by.** `test/semaphore.test.ts` — "a lower-tier arrival jumps ahead of parked higher-tier
waiters, FIFO within a tier", "tier ordering never starves a higher tier: once no lower-tier waiter
is parked, it drains FIFO", "a reserve keeps a permit free for a work acquirer while maintenance
sits at its cap" and "the verify and merge tiers ignore the reserve";
`test/orchestrator-permits.e2e.test.ts` — "the director's run starts immediately while every
maxConcurrent slot is busy".

### INV-P4: a lease follows its run to the provider it actually uses, and a re-key cannot deadlock

**Guarantee.** A run on another key re-keys its lease, returning the old key first. A parked re-key
holds only its team permit and is granted ahead of admission waiters for that key. Releasing a lease
whose re-key is parked cancels the grant without taking the target slot. A forced lease may exceed
a full key by one holder and blocks grants until the key drains under the cap. Without a lease in
context, `ensureProviderLease` does nothing.

**Binds.** `src/concurrency/provider-lease.ts` (`withProviderLease`, `ensureProviderLease`),
`src/concurrency/semaphore.ts` (`SemaphoreLease.rekey`, `forceLease`), `src/merge/merge-drain.ts`,
`src/merge/merge-verify.ts`.

**Pinned by.** `test/provider-lease.test.ts` — "ensureProviderLease is a no-op without a lease in
context", "a run on a different key re-keys: it releases the old key and takes the new one" and "a
re-key to a full provider parks (holding no key) and is granted when it drains";
`test/semaphore.test.ts` — "rekey gives the old key back first, and a parked re-key beats a parked
admission for the key", "releasing a lease while its re-key to a full key is parked cancels the
grant and never steals the target", "a forced lease overshoots a full key by one holder, blocking
grants until it drains under the cap" and "re-key waiters hold a team permit only, so the key always
drains (no deadlock)".

### INV-P5: no provider slot is held while waiting for a worktree pool slot

**Guarantee.** Before it parks on a busy worktree pool, a lease is re-keyed to no key
(`dropProviderLeaseKey`), so it keeps its team permit but gives the provider slot back. A run
waiting for a pool slot therefore cannot block the drain of a key that a parked re-key is waiting
on.

**Binds.** `src/concurrency/provider-lease.ts` (`dropProviderLeaseKey`), `src/git/worktree-pool.ts`
(its `acquire`).

**Pinned by.** `test/provider-lease.test.ts` — "dropProviderLeaseKey returns the held key without
giving up the team permit"; `test/orchestrator-permits.e2e.test.ts` — "two runs on one provider and
a single worktree slot both finish (pool-slot wait rule, part 4/5)".

## Init: a user's repo loses nothing to tumwater init

`initProject` is the one command that writes into a user's existing project. It validates first,
then creates only what is absent, then commits only what it created. A dry run goes through the
same steps and writes nothing.

### INV-Q1: every refusal comes before any side effect

**Guarantee.** An unknown template, an over-long brief (a template preamble included), an empty
prompt with no brief to read, an invalid branch name, `--branch` on an existing repo, and a team
workspace are each refused before any write, `git init` or commit, in a dry run too.

**Binds.** `src/init/init.ts` (`initProject`), `src/paths.ts` (`owningTeamRoot`).

**Pinned by.** `test/init.test.ts` — "initProject validates before seeding: a bad prompt leaves no
repo behind", "initProject rejects an over-long brief text before seeding", "initProject
refuses --branch on an existing repo instead of silently ignoring it" and "initProject refuses
inside a team workspace and writes nothing"; `test/init-templates.test.ts` — "an unknown template
id and an overflowing preamble fail before any side effect".

### INV-Q2: init creates only what is absent, so a re-run is idempotent

**Guarantee.** Every seeded file and starter directory that already exists is left alone and
reported in `leftAlone`. An existing .gitignore only gains the missing ignore lines, each on its
own line. A README.md without the managed markers is adopted (the brief goes to TUMWATER.md) and
never rewritten.

**Binds.** `src/init/init.ts` (`initProject`'s local `claim`, `ensureGitignore`),
`src/brief/brief.ts` (`briefFile`).

**Pinned by.** `test/init.test.ts` — "initProject never clobbers existing files and is
idempotent", "initProject never clobbers an existing PRINCIPLES.md", "initProject appends both
ignore entries to an existing .gitignore on their own lines" and "initProject adopts a repo whose
README has no tumwater markers instead of refusing"; `test/init-templates.test.ts` — "initProject
--template leaves existing starter directories alone and reports them as leftAlone".

### INV-Q3: a prompt is never silently dropped

**Guarantee.** A prompt that differs from the brief an existing file already carries is refused,
and the refusal names the file that owns the brief. Adopting over a TUMWATER.md without markers is
refused. A marked TUMWATER.md never gains a duplicate README.md. A bare init re-seeds from the
existing brief.

**Binds.** `src/init/init.ts` (`initProject`), `src/brief/brief.ts` (`briefFile`).

**Pinned by.** `test/init.test.ts` — "initProject refuses a prompt that differs from the one a
README-owned brief carries", "a TUMWATER.md-owned brief refuses a different prompt instead of
writing it into a new README.md", "initProject refuses to adopt over a TUMWATER.md without
markers", "a TUMWATER.md-owned brief never gains a duplicate README.md on a matching or bare init"
and "a bare init re-seeds a lost config from the README's prompt (portability 4a/7)".

### INV-Q4: the init commit holds only the files init created, and none is half-written

**Guarantee.** The commit pathspec is the created files minus tumwater.json and the starter
directories, so a user's unrelated dirty files stay uncommitted and the config stays untracked. A
repo that only gained a config gets no commit. Seeded files are written atomically.

**Binds.** `src/init/init.ts` (`initProject`), `src/files/files.ts` (`writeTextAtomic`).

**Pinned by.** `test/init.test.ts` — "initProject leaves user's unrelated dirty files
uncommitted", "initProject seeds the config from a tracked tumwater.example.json and keeps it
untracked", "a repo that only gains a config reports it and stays uncommitted" and "initProject
leaves no half-written file when a seeded write dies mid-way".

### INV-Q5: a dry run writes nothing

**Guarantee.** `dryRun` does the same validation and returns the same created and left-alone
lists, but writes no file, edits no .gitignore, calls no `git init` and makes no commit. Listing
templates touches nothing either.

**Binds.** `src/init/init.ts` (`initProject`, `ensureGitignore`), `src/cli/cli-start.ts`
(`cmdInit`).

**Pinned by.** `test/init.test.ts` — "initProject --dry-run writes nothing: no files, no gitignore
edit, no commit"; `test/init-templates.test.ts` — "cmdInit --list-templates prints the catalog and
exits 0 without touching the repo".

### INV-Q6: bootstrap is seeded only on a fresh project

**Guarantee.** `bootstrap.untilPlansDone` goes into a newly created config only when
`isFreshProject` holds: no commits, or history that holds only scaffolding. A repo that already
carries code gets none.

**Binds.** `src/init/init.ts` (`isFreshProject`, `isScaffoldingPath`).

**Pinned by.** `test/init.test.ts` — "initProject seeds bootstrap on a fresh project",
"initProject seeds bootstrap in a repo with no commits", "initProject seeds bootstrap when a
repo's only history is scaffolding" and "initProject seeds no bootstrap when the repo already
carries code".

## The usage report fold: a warm read equals a cold one

`collectReport` and `collectReportSince` (`src/report/report-data.ts`) both fold the event log
through `foldWindowEvents`. It keeps a bounded memo (`reportFoldCache`, `REPORT_FOLD_CACHE_MAX`)
and either reuses it, folds the appended complete lines, or falls back to a full
`readWindowEvents` pass. The memo is correct only if every warm answer equals the cold one.

### INV-R1: a warm fold equals the cold read, and an appended event counts once

**Guarantee.** A cache hit on an unchanged log (same dev, ino, mtime and size, by
`sameStatIdentity`) returns the stored fold. Growth on the same file folds only the lines past the
stored offset. The offset a full pass seeds is the scan's own end (`raw.liveEnd`), not the earlier
stat's size, so an event appended between the stat and the read is never folded twice. A legacy
`merged` line appended to a warm fold folds as `merge_done`.

**Binds.** `src/report/report-fold.ts` (`foldWindowEvents`, `foldLineInto`, `foldEventInto`),
`src/files/files.ts` (`sameStatIdentity`).

**Pinned by.** `test/report-fold-cache.test.ts` — "warm collectReport equals the cold read before
and after appends", "a merge appended after a warm fold counts once, including in the role split"
and "a legacy `merged` line appended after a warm fold folds as merge_done";
`test/report-data.test.ts` — "collectReport does not double-count an event appended between the
cache's stat and its read".

### INV-R2: a torn trailing write folds only once its newline lands

**Guarantee.** The append arm reads through `readCompleteLines`, which holds back a newline-less
tail. A grown log with no complete new line returns the stored fold unchanged, and the next call
folds the completed line whole.

**Binds.** `src/report/report-fold.ts` (`foldWindowEvents`), `src/files/tail.ts`
(`readCompleteLines`).

**Pinned by.** `test/report-fold-cache.test.ts` — "a torn trailing write is ignored until its
newline lands".

### INV-R3: a replaced or shrunken log refolds from scratch

**Guarantee.** The append arm runs only when the size grew and dev and ino match the stored
entry. A log replaced by a different file (even one larger than the stored offset) or a shrunken
one takes the full `readWindowEvents` pass, so no fold mixes two files' bytes.

**Binds.** `src/report/report-fold.ts` (`foldWindowEvents`, `ReportFoldEntry`'s `dev` and `ino`).

**Pinned by.** `test/report-fold-cache.test.ts` — "a rotated log replaced by a fresh larger one
refolds instead of folding the new log's bytes" and "a shrunken log (rotation) refolds instead of
misaligning the byte offset".

### INV-R4: the coverage proof follows the window

**Guarantee.** The memo key includes `fromKey`, so a moved window gets a fresh entry and its own
`fileCovers` instead of carrying an older window's proof. An empty or missing log reads as fully
covered, not truncated, and the proof updates when the first event is appended.

**Binds.** `src/report/report-fold.ts` (`foldWindowEvents`), `src/report/report-data.ts`
(`collectReport`, `collectReportSince`).

**Pinned by.** `test/report-fold-cache.test.ts` — "the coverage proof follows the window, not the
memo's seed: empty-log vacuous arm flips on first append"; `test/report-data.test.ts` —
"collectReportSince treats an empty or missing event log as fully covered, not truncated" and
"collectReportSince proves coverage on a same-day log start and notes a log born inside the
window".

### INV-R5: both reports aggregate through one fold, with the merge share named

**Guarantee.** `collectReport` and `collectReportSince` fold every event through
`foldUsageEvent`, so a trailing window and a same-seed day slice agree. Merge-slot tokens and cost
go into `mergeTokens` and `mergeCostUsd`, never into `tokensOut` or `costUsd` inside the fold, and
each collector adds the merge share to its surfaced totals. A role-scoped window excludes the
merge share.

**Binds.** `src/report/report-fold.ts` (`foldUsageEvent`, `UsageFold`),
`src/report/report-data.ts` (`collectReport`, `collectReportSince`).

**Pinned by.** `test/report-data.test.ts` — "collectReportSince aggregation matches a same-seed
collectReport slice", "collectReport folds merge_done/merge_failed usage into the day and totals,
with the merge share named", "collectReportSince folds merge_done/merge_failed usage into the
window totals" and "collectReportSince scopes a trailing window to one role, excluding the merge
share".

## History rows: each merge verdict shows once, and missing evidence keeps the raw label

`runRows` (`src/history/history-data.ts`) is the pure collector the CLI, the GUI and the tests
share. `readRunRows` (the last-N view) and `readRunRowsSince` (`--since`) read the event log and
feed it. Each row is one finished run, and a queued row joins the merge outcome of the change it
queued.

### INV-S1: a row's duration and model come only from its own run_start

**Guarantee.** `runRows` pairs each run_end with its run_start through the shared
`runStartMap` and `runStartModelMap`. A row whose start is not in the read gets `durationMs: null`
(a dash), never a made-up span, and its model is null when the start is absent or carries no
model. Rows come back newest first, at most `limit` of them, filtered by role.

**Binds.** `src/history/history-data.ts` (`runRows`, `RunRow`), `src/events/event-read.ts`
(`runStartMap`, `runSpanMs`, `runStartModel`).

**Pinned by.** `test/history-data.test.ts` — "runRows pairs each run_end with its run_start for
the duration", "runRows renders no duration when the run's start is outside the scanned window",
"runRows names the model its run_start carried, or none when the start is absent or unnamed" and
"runRows returns the newest limit rows, newest first, and filters by role".

### INV-S2: the last-N view grows its window, and only up to a ceiling

**Guarantee.** `readRunRows` re-reads with a four-times larger tail window while the rows fall
short of `limit` or a row's start is unpaired, but only if the read filled the window. It stops at
`HISTORY_SCAN_MAX_EVENTS`. `history -n` accepts only 1..`HISTORY_MAX_RUNS`.

**Binds.** `src/history/history-data.ts` (`readRunRows`, `HISTORY_SCAN_MAX_EVENTS`,
`HISTORY_MAX_RUNS`).

**Pinned by.** `test/cli-history.test.ts` — "history grows the scan window to pair a run_start the
first window's boundary cut off", "history --role grows its scan window until it reaches the
role's runs" and "history -n accepts 1..200 and fails zero, negative, non-numeric, and over-large
values".

### INV-S3: a queued row reads its change's verdict, and each attempt's verdict shows on one row

**Guarantee.** The authoring row takes the change's final verdict, walking forward through
recovery re-enqueues (`isRecoveryPin`) and stopping at a pin that starts a fresh change. A
recovery row takes the retriable verdict of the attempt it re-enqueued (`recoveredAttemptVerdict`).
While a re-enqueued attempt is pending, the authoring row keeps "queued". The `claimTop` cursor
hands each queued run the newest unclaimed pin at or before its end, so two runs never claim one
pin.

**Binds.** `src/history/history-data.ts` (`resolveQueuedResult`, `recoveredAttemptVerdict`,
`isRecoveryPin`, `endsChange`, `bucketMergeEvents`), `src/runner/leftover.ts` (`recoverLeftover`,
the "recovered leftover work from " summary prefix).

**Pinned by.** `test/history-data.test.ts` — "a queued run resolves to its change's merge outcome
— merged or merge_failed (BUGS.md 2026-09-30)", "a queued run resolves past a rebased retriable
failure to the recovery's merged verdict (BUGS.md 2026-10-10)", "while a re-queued attempt is
pending, the recovery row shows the failure and the authoring row waits to merge", "a change
re-queued after seven review timeouts and then rejected reads each attempt once (feature-3,
2026-10-18)", "a recovery pin after a change that ended is a fresh change's first attempt, read by
the authoring rule" and "a retriable verdict is not swept up by the next FRESH change's merge
(BUGS.md 2026-10-10)".

### INV-S4: missing evidence keeps the raw label, and the join never crosses roles

**Guarantee.** `resolveQueuedResult` returns null (the row stays "queued") when the merge has no
outcome yet, when no outcome matches the pin's sha, or when the row's run_start sits before a
since-read's `floorTs`. Pins and outcomes are bucketed per role (`bucketMergeEvents`), so a
`--role` filter or a role list never lends one role's verdict to another. A torn outcome falls
back to its type's default text.

**Binds.** `src/history/history-data.ts` (`resolveQueuedResult`, `attemptVerdict`,
`bucketMergeEvents`, `runRows`).

**Pinned by.** `test/history-data.test.ts` — "a queued run whose merge is still in the pipeline
keeps the raw label", "a queued run stays raw when no merge outcome matches its pinned sha", "a
queued row whose run_start predates the join read's floor keeps the raw label", "the resolution
survives the --role filter and never crosses roles", "runRows takes a list of role ids, joining
each queued row's merge verdict" and "a queued run's torn merge outcome reads as its type default,
never [object Object]".

### INV-S5: the --since view holds exactly the window's runs, with a wider read for the join

**Guarantee.** `readRunRowsSince` returns the run_ends at or after the cutoff and drops everything
before it. A run that spans the cutoff renders a dash, because the ts filter removes its start
too. Its queued verdict still resolves, because the join reads `RUN_ROW_JOIN_BACKSLACK_MS` further
back through `readEventsSinceJoined`. `covered` stays false while the log starts inside the
window, and a missing or empty log reads as no rows over a covered window.

**Binds.** `src/history/history-data.ts` (`readRunRowsSince`, `RUN_ROW_JOIN_BACKSLACK_MS`,
`RunRowJoin`), `src/events/event-window.ts` (`readEventsSinceJoined`).

**Pinned by.** `test/history-data.test.ts` — "rows keep the in-window runs, newest first, and drop
everything before the cutoff", "a run spanning the cutoff renders a dash: the ts filter removes
its start too", "a queued run whose pin sits before the --since cutoff still resolves (BUGS.md
2026-09-30)", "covered is false while the log starts inside the window, true once an event
predates the cutoff" and "a missing or empty log reads as no rows over a covered window".

## Status polls: an observer never throws, and shows only what is still true

`tumwater status`, `tumwater queue`, `tumwater doctor`, the TUI and the GUI read the cached readers
in `src/status/status-polls.ts` every second, in a process separate from the orchestrator. Every
reader must therefore tolerate a torn, foreign or stale file, and show only what is still true.

### INV-T1: main's badge is the newest merge-scope check, and an unproven check shows nothing

**Guarantee.** `mainCheckForPoll` reports the newest build_check whose scope `isFullCheckScope`
accepts: `merge`, `batch` or `baseline`, and never a `gate` check or one with `full: false`. The
sha comes from the merge_done event that follows the check, otherwise main's branch head, otherwise
the merge_done before it. The event tail grows up to `MAIN_CHECK_SCAN_MAX_EVENTS`, past which the
badge drops. A check whose status is not one of the three (`isMainCheckStatus`) or which has no
numeric ts reads as no check.

**Binds.** `src/status/status-polls.ts` (`mainCheckForPoll`, `scanMainCheck`, `isMainCheckStatus`,
`MAIN_CHECK_SCAN_MAX_EVENTS`), `src/build/build-check-events.ts` (`isFullCheckScope`).

**Pinned by.** `test/status-data-team.test.ts` — "snapshot carries mainCheck from the newest
merge-scope build_check event" and "a merge-scope check with a foreign status reads as no
mainCheck"; `test/status-header.test.ts` — "the status header carries a mainCheck badge only after
a merge-scope check".

### INV-T2: a red-main hold stands until a newer passed check retires it, and status and doctor agree

**Guarantee.** `heldByMainRed` is true only when the role's last result is `main_red`, it has no
queued summary, and no passed check is stamped strictly after its last run ended
(`mainCheckRecovered`). It is the one predicate behind the status phase's red-main label and
doctor's `checkMainRed`.

**Binds.** `src/status/status-polls.ts` (`heldByMainRed`, `mainCheckRecovered`),
`src/ui/status-model.ts` (`rolePhase`), `src/doctor/doctor-holds.ts` (`checkMainRed`).

**Pinned by.** `test/status-model.test.ts` — "rolePhase shows main red for idle roles whose last
run was blocked by a red main", "rolePhase retires a stale main red when main's newest check passed
after it" and "roleRowCells retires the stale main red and teamAlerts raises no banner for it";
`test/doctor-holds.test.ts` — "checkMainRed: a role with a queued summary is ok" and "checkMainRed:
a passed merge check newer than the red run retires the hold".

### INV-T3: the merge marker displays only while the orchestrator lives and a queued change it names is unfinished

**Guarantee.** `queueInFlight` returns nothing unless `running` is true. `liveMergeMarker` shows an
older-format marker only while its sha is queued. A per-change marker keeps only its well-formed
records whose sha is queued, and shows only while one of them is not `done`. A malformed record is
dropped, never read.

**Binds.** `src/status/status-polls.ts` (`queueInFlight`, `liveMergeMarker`),
`src/merge/merge-slot.ts` (`isMergeChange`, `readMergeMarker`).

**Pinned by.** `test/cli-queue.test.ts` — "queue prints the in-flight label only while an
orchestrator is alive"; `test/status-polls.test.ts` — "liveMergeMarker shows a single-change marker
only while its sha is queued", "liveMergeMarker keeps only the queued records and hides a marker
whose queued records are all done" and "liveMergeMarker drops a null or malformed record instead of
throwing".

### INV-T4: a broken tumwater.json never blinds an observer

**Guarantee.** `configForStatus` never throws. It returns the fresh config when it is valid,
otherwise the last valid config this process loaded for that root, otherwise defaults. A fixed file
is picked up on the next poll.

**Binds.** `src/status/status-polls.ts` (`configForStatus`), `src/config/config.ts`
(`loadConfigCached`).

**Pinned by.** `test/status-data.test.ts` — "snapshot survives a broken tumwater.json and recovers
when it is fixed".

### INV-T5: each poll owns its runner state, and an unchanged file is not re-read

**Guarantee.** `runnerStateForPoll` serves an unchanged state file from the stat-keyed cache and
returns a copy, so a caller's mutation never reaches the next poll. A missing file yields a fresh
state.

**Binds.** `src/status/status-polls.ts` (`runnerStateForPoll`), `src/files/stat-cache.ts`
(`cachedByStat`).

**Pinned by.** `test/status-data.test.ts` — "snapshot serves unchanged runner state from the
stat-keyed cache without re-reading" (it pins the cache hit and the per-poll copy; the missing-file
case is not pinned by a test).

## Runner ids: only feature and bugfix split, and everything about a role resolves through its base

A base role may run several runner ids (`feature`, `feature-2`, `bugfix-3`, …), each keying its own
state, branch and session, while every lookup about the role resolves through `baseRoleOf`. The id
arithmetic lives in `src/roles/runner-ids.ts`; scheduling, the gate polls, doctor's holds, status,
the pause commands and config validation all go through it.

### INV-U1: only a feature or bugfix id with an index of 2 or more is an instance

**Guarantee.** `baseRoleOf` maps `<feature|bugfix>-N` (N ≥ 2) to its base and returns every other id
unchanged, including `feature-1`, `clean-2` and custom names. `instanceIndex` is N for an instance
and 1 for anything else. Both read the one `INSTANCE_ID_SOURCE` pattern.

**Binds.** `src/roles/runner-ids.ts` (`INSTANCE_ROLES`, `INSTANCE_ID_SOURCE`, `baseRoleOf`,
`instanceIndex`).

**Pinned by.** `test/runner-ids.test.ts` — "baseRoleOf and instanceIndex map only a base role's -N
ids".

### INV-U2: the runner set is the enabled roles in config order, with twice the instances once a role splits

**Guarantee.** `runnerIds` lists each enabled role's bare id in `config.roles` order. For an
`INSTANCE_ROLES` base at `instances: N > 1` it then lists `-2` through `-2N`. At the default count
it is exactly the enabled bare ids. A disabled base contributes no id. `runnerEnabled` agrees: an
id runs only while its base is enabled and its index is within that runner count, so lowering the
count turns the surplus off.

**Binds.** `src/roles/runner-ids.ts` (`runnerIds`, `runnerEnabled`, `runnerCount`,
`RUNNERS_PER_INSTANCE`).

**Pinned by.** `test/runner-ids.test.ts` — "runnerEnabled reads the base role and its configured
instance count", "runnerIds enumerates enabled roles and each instance base's extra runners" and
"runnerIds omits disabled roles and their instances".

### INV-U3: instance 1 pauses under <role>-1 only while the role has siblings, and a base pause stops every instance

**Guarantee.** `instancePauseKey` gives the bare id of a split role the key `<role>-1`, and every
other id its own id. `runnerPaused` is true for the runner's own key, its base role's key, or (for
an instance role's bare id) `<role>-1`. A `<role>-1` pause therefore stops instance 1 and not its
siblings.

**Binds.** `src/roles/runner-ids.ts` (`instancePauseKey`, `runnerPaused`); callers include
`src/orchestrator/orchestrator-scheduling.ts` (`runnerPaused`).

**Pinned by.** `test/runner-ids.test.ts` — "instancePauseKey and runnerPaused give instance 1 its
own pause key only while the role has siblings".

### INV-U4: an instance shares its base role's catalog entry, tier, model and spend cap

**Guarantee.** `roleById`, `roleTier`, `yieldScaledRole` and `baselineBlocked`
(`src/roles/roles.ts`) and `configForRole` (`src/config/config-views.ts`) answer for an instance
exactly as for its base. `pollRoleCapGate` sums the instances' spend against the base role's cap,
pauses every instance together, and emits one `role_cap_paused` naming the base.

**Binds.** `src/roles/roles.ts`, `src/config/config-views.ts`, `src/gates/role-cap-gates.ts`
(`pollRoleCapGate`, `roleCapVerdicts`).

**Pinned by.** `test/runner-ids.test.ts` — "role helpers resolve an instance id through its base
role", "configForRole resolves an instance id's model through its base role" and "the per-role cap
groups instances: their spend sums against the base role's cap".

### INV-U5: a custom role cannot take an instance-shaped name

**Guarantee.** `validateConfig` rejects a custom role whose name `baseRoleOf` maps to a different
id, so a custom role can never shadow a feature or bugfix instance's state.

**Binds.** `src/config/config-validation.ts` (`validateConfig`).

**Pinned by.** `test/runner-ids.test.ts` — "a custom role name shaped like an instance id is a
validation error".

## Context shake: old bulky output becomes a recoverable pointer, never the recent window

Every pi run loads `src/pi-extension/context-shake.ts`. Once the context fills past a crossing, it
replaces old tool results with pointers through persisted `context_edit` entries. `shakePlan` is
the pure selector; the default export `contextShake` is the thin adapter that maps pi's `turn_end`
onto it and carries the summary note.

### INV-V1: only an old, bulky, successful read or bash result is elided, and never twice

**Guarantee.** A candidate is a `toolResult` from `read` or `bash` that is not an error, has a
session entry id, is longer than `SHAKE_MIN_CHARS`, does not already start with `ELIDED_PREFIX`,
and has at least the protected slice of estimated tokens newer than it. Edit, write, user and
assistant messages are never touched.

**Binds.** `src/pi-extension/context-shake.ts` (`shakePlan` and its private `isCandidate`,
`SHAKE_MIN_CHARS`, `ELIDED_PREFIX`, `estimateTokens`).

**Pinned by.** `test/context-shake.test.ts` — "shakePlan elides the old bulky result and leaves the
newest slice alone", "shakePlan never selects edit, write, error, user or assistant messages",
"shakePlan leaves short and already-elided results alone", "shakePlan leaves a long already-elided
result alone instead of re-eliding it", "shakePlan skips a bulky result with no session entry to
edit" and "a result exactly at the size floor is skipped while an over-floor companion is
elided".

### INV-V2: every pointer leads back to the full text

**Guarantee.** A bash result is elided only with a recoverable path: pi's `details.fullOutputPath`,
or else one that `writeFullOutput` returns. When neither exists, the result is kept. A read
pointer names the file and a whole-line range that starts at the offset, after `nonNegativeNumber`
heals it and it is floored, clamped to line 1.

**Binds.** `src/pi-extension/context-shake.ts` (`shakePlan`, private `replacementFor`),
`src/pi-extension/full-output.ts` (`writeFullOutput`).

**Pinned by.** `test/context-shake.test.ts` — "a bash result without a pi full-output path gets
one written", "a bash result with no recoverable path is kept rather than lost", "a read pointer
names the file and the range it elided", "a read pointer counts the lines of a multi-line
result", "a read pointer without a path or offset names the file from line 1", "a read pointer
clamps a non-positive, non-finite, or missing offset to line 1", "a read pointer floors a
fractional offset to a whole line" and "the adapter writes a bash result's full output and points
the edit at it".

### INV-V3: no pass runs on an unknown fill, below the crossing, or for less than the reclaim floor

**Guarantee.** `shakePlan` is empty when the fill percentage cannot be known, when the fill is
below the first crossing, or when the whole pass would reclaim less than the floor. `percentOf`
uses a finite percent when pi gives one, else tokens over window; a non-finite or negative token
count or window, or a window of 0, is unknown, not a fill. A team-sized context on the 1M primary
therefore plans nothing.

**Binds.** `src/pi-extension/context-shake.ts` (`shakePlan`, private `percentOf`,
`SHAKE_MIN_RECLAIM_TOKENS`).

**Pinned by.** `test/context-shake.test.ts` — "shakePlan stays empty below the first crossing",
"shakePlan is empty when the whole pass would reclaim under the floor", "percentOf falls back to
tokens/contextWindow when pi gives no percent", "percentOf ignores a non-finite percent and uses
the token ratio instead", "percentOf reads a non-finite token count or window as unknowable, not
as a fill" and "a team-sized context on the 1M primary plans nothing".

### INV-V4: on a small window both passes stay under pi's compaction line

**Guarantee.** `shakeLimits` returns the tuned `SHAKE_*` constants at and above the 128k reference
window and when the window is unknown. Below 128k, the second pass sits
`COMPACTION_MARGIN_PERCENT` under `compactionPercent(window)` and the first pass keeps its
15-point lead. The protected slice and the reclaim floor scale by `windowScale`.

**Binds.** `src/pi-extension/context-shake.ts` (`shakeLimits`, `SHAKE_PERCENT`,
`SHAKE_MAX_PERCENT`, `SHAKE_PROTECTED_TOKENS`), `src/pi-extension/context-window.ts`
(`compactionPercent`, `windowScale`, `REFERENCE_WINDOW_TOKENS`, `PI_COMPACTION_RESERVE_TOKENS`).

**Pinned by.** `test/context-shake.test.ts` — "shakeLimits keeps the tuned thresholds at and above
128k and when the window is unknown", "shakeLimits keeps both passes under pi's compaction line on
a 64k window", "shakeLimits moves the passes down smoothly between 64k and 128k" and "a 64k run
is shaken at its scaled crossing with its scaled protected slice".

### INV-V5: the adapter shakes once per crossing, and its note rides exactly one tool result

**Guarantee.** `contextShake` runs at most one pass when the first crossing is reached and at most
one more when the run climbs to the second; a pass that plans nothing still uses up its crossing.
A repeat `turn_end` above an already-used crossing returns nothing. Missing or unreducible usage
and an empty context are no-ops. The summary note from `shakeNote` is appended to the next
`tool_result` only, through `appendToolResultNote`.

**Binds.** `src/pi-extension/context-shake.ts` (`contextShake`, `shakeNote`),
`src/pi-extension/tool-result-content.ts` (`appendToolResultNote`),
`src/pi-extension/context-usage.ts` (`readContextUsage`).

**Pinned by.** `test/context-shake.test.ts` — "the adapter shakes once at 70%, again at 85%, and
notes the next tool result", "the adapter shakes a 64k run at 57.5% and again at 72.5%" and "the
adapter tolerates missing usage and an empty context".

## Bounded output: an oversized read or bash result shrinks to head and tail, never past its limit and never unrecoverably

Every pi run loads `src/pi-extension/bounded-output.ts`. It rewrites every oversized `read` and
`bash` result before the model sees it. `boundText`, `boundReadResult` and `boundBashResult` are
the pure bounders, `outputLimits` picks the budgets for the model's window, and the default export
`boundedOutput` is the thin adapter on pi's `tool_result` event.

### INV-W1: a bounded text never exceeds its limit and never splits a character

**Guarantee.** `boundText` returns empty and under-limit text byte-identical. Over the limit it
keeps head and tail around a marker naming the omitted count (and the full-output path when given),
counted in code points. When the marker alone outgrows the budget, the head and tail clamp to zero
and a final hard cut keeps the result within the limit.

**Binds.** `src/pi-extension/bounded-output.ts` (`boundText`, private `cpsWhenOverLimit`).

**Pinned by.** `test/bounded-output.test.ts` — "boundText returns text under the limit
byte-identical", "boundText over the limit returns head + marker + tail within the limit",
"boundText marker names the full-output path when one is given", "boundText never splits
multi-byte UTF-8 mid-character", "boundText keeps its limit when the full-output path alone
swallows the budget", "boundText with a tiny limit and no path still stays within the limit" and
"boundText returns astral-heavy text with cps within the limit unchanged".

### INV-W2: a bounded read keeps whole lines and tells the model how to read the middle

**Guarantee.** `boundReadResult` passes ranged reads (`offset` or `limit` set), short and empty
text through untouched. Otherwise its cuts snap to line boundaries, and its marker names the file
and asks for an offset/limit re-read; nothing is copied to disk. When snapping cannot fit (lines
too long, the snap swallowing the text, or the snapped result overgrowing the limit), it falls
back to `boundText` with no path.

**Binds.** `src/pi-extension/bounded-output.ts` (`boundReadResult`, private `snapHeadForward`,
`snapTailStartForward`, `SNAP_SLACK`).

**Pinned by.** `test/bounded-output.test.ts` — "boundReadResult keeps whole lines and reports the
omitted amount", "boundReadResult passes through ranged, short, and empty results",
"boundReadResult of a 1000-line file stays under the read limit without input ranges",
"boundReadResult clamps a path-swollen marker to the marker-alone bound, not a dropped tail",
"boundReadResult falls back to a plain cut when lines are too long to snap", "boundReadResult
passes astral-heavy text through when the code-point count fits the limit", "boundReadResult falls
back to a plain cut when the line snap swallows the whole text" and "boundReadResult falls back to
a plain cut when snapping overgrows the kept head past the limit".

### INV-W3: a bounded bash result points at its complete output, and only an over-limit one earns a write

**Guarantee.** `boundBashResult` prefers pi's `details.fullOutputPath` and then never calls the
writer; otherwise it uses the path the writer returns, and with no path the marker carries none.
Empty and under-limit output (by code points, so astral-heavy text within the limit included) is
returned unchanged and the writer is never called.

**Binds.** `src/pi-extension/bounded-output.ts` (`boundBashResult`),
`src/pi-extension/full-output.ts` (`writeFullOutput`).

**Pinned by.** `test/bounded-output.test.ts` — "boundBashResult keeps the first and last line on
either side of the marker", "boundBashResult prefers pi's own fullOutputPath and never calls the
writer", "boundBashResult with no fullOutputPath and no harness root writes nothing",
"boundBashResult uses the writer's path when it provides one", "boundBashResult passes short
results through untouched", "boundBashResult returns astral-heavy under-limit text unchanged and
never writes it", "boundBashResult truncates astral-heavy text just past the code-point limit" and
"boundBashResult returns empty output untouched".

### INV-W4: the limits shrink with a small window, but never below a quarter

**Guarantee.** `outputLimits` returns `READ_LIMIT_CHARS` and `BASH_LIMIT_CHARS` at and above the
128k reference window and when the window is unknown, and scales both by `windowScale` below it,
floored at `MIN_LIMIT_SHARE`.

**Binds.** `src/pi-extension/bounded-output.ts` (`outputLimits`, `READ_LIMIT_CHARS`,
`BASH_LIMIT_CHARS`, `MIN_LIMIT_SHARE`), `src/pi-extension/context-window.ts` (`windowScale`).

**Pinned by.** `test/bounded-output.test.ts` — "outputLimits keeps the tuned limits at and above
the 128k window and when it is unknown" and "outputLimits scales both limits with a smaller
window, down to a quarter".

### INV-W5: the adapter rewrites only an oversized read or bash text result

**Guarantee.** `boundedOutput` returns nothing for any other tool, a non-array content payload, a
result with no text block (an image), and a result its bounder leaves unchanged. Otherwise it
returns a one-text-block `content` patch at the budgets `outputLimits` gives for
`ctx.model.contextWindow`, read per result; for bash it hands the bounder a writer that calls
`writeFullOutput` with the tool call id.

**Binds.** `src/pi-extension/bounded-output.ts` (`boundedOutput`).

**Pinned by.** `test/bounded-output.test.ts` — "adapter bounds oversized read results and passes
everything else through", "adapter bounds oversized bash results using pi's fullOutputPath",
"adapter persists the full output itself when pi's bash tool left no file", "adapter leaves a
non-array content payload untouched" and "adapter bounds a 64k model's results to its scaled
limits".

## Terminal text: a clipped line never overflows its columns, and a did-you-mean names only a near miss

`displayWidth`, `clipToWidth` and `padToWidth` in `src/text/text-width.ts` measure in terminal
columns, not UTF-16 code units (`truncate` in `src/text/text.ts` budgets by characters, a different
unit). `suggestClosest`, `didYouMean` and `typoSuffix` in `src/text/suggest.ts` are the one home of
the did-you-mean hint's threshold and wording.

### INV-X1: width is counted in terminal columns, per code point

**Guarantee.** `displayWidth` counts each code point as one column, except those in the
`WIDE_RANGES` table (East Asian wide and fullwidth characters and common emoji), which count two.
An astral character is one unit of width two, never two halves. Combining marks count one, so the
measure can only overestimate.

**Binds.** `src/text/text-width.ts` (`displayWidth`, private `codePointWidth`, `WIDE_RANGES`).

**Pinned by.** `test/text-width.test.ts` — "clipToWidth counts wide characters as two columns and
holds the invariant at every width".

### INV-X2: a clipped line never exceeds its width and never splits a character

**Guarantee.** `clipToWidth` returns text that fits unchanged and the empty string for a
non-positive width. Over the budget it cuts on a code-point boundary, drops a wide character that
cannot fit whole, and ends in `…`, which takes one column. A width of one clips bare, with no
ellipsis. At every width the result's `displayWidth` is at most the width and holds no lone
surrogate.

**Binds.** `src/text/text-width.ts` (`clipToWidth`).

**Pinned by.** `test/text-width.test.ts` — "clipToWidth never exceeds the requested width, even at
degenerate widths", "clipToWidth never splits a surrogate pair (no lone surrogates in clipped
lines)" and "clipToWidth counts wide characters as two columns and holds the invariant at every
width".

### INV-X3: padding reaches the exact column and never clips

**Guarantee.** `padToWidth` appends spaces until the text's `displayWidth` equals the width, so a
cell holding wide characters gets fewer spaces. Text already at or past the width is returned
unchanged, so a caller clips first when a cell must not overflow.

**Binds.** `src/text/text-width.ts` (`padToWidth`).

**Pinned by.** `test/text-width.test.ts` — "padToWidth pads with spaces to the exact display
column, and never past it".

### INV-X4: a suggestion names only a near miss

**Guarantee.** `suggestClosest` compares case-insensitively by Levenshtein distance and returns the
closest candidate within `maxDistance` (two by default), else null. A candidate more than one edit
away must share the input's first character. That filter runs inside the scan, so a disqualified
nearer candidate cannot hide a farther one that qualifies. An empty candidate list gives null.

**Binds.** `src/text/suggest.ts` (`suggestClosest`, private `editDistance`).

**Pinned by.** `test/suggest.test.ts` — "suggestClosest names the closest candidate within two
edits, case-insensitively".

### INV-X5: the hint has one wording, and the suffix is its composition

**Guarantee.** `didYouMean` renders `` — did you mean `x`?`` for a suggestion and the empty string
for none. `typoSuffix` is exactly `didYouMean(suggestClosest(input, candidates))`, so every
unknown-name error that uses it spells the hint the same way.

**Binds.** `src/text/suggest.ts` (`didYouMean`, `typoSuffix`).

**Pinned by.** `test/suggest.test.ts` — "didYouMean wraps a suggestion in the pinned wording, empty
string for none" and "typoSuffix appends the did-you-mean wording for a close typo, nothing
otherwise".

## Thinking strip and context notes: a small window sends no old thinking, and each threshold warns once

`src/pi-extension/strip-thinking.ts` and `src/pi-extension/context-budget.ts` are pi extensions
loaded on every pi run. Their rules are pure exported functions (`stripsThinking`, `stripThinking`,
`contextNote`) behind a thin default-export adapter. The strip edits only what one request sends
(pi's `context` event), never the session file.

### INV-Y1: only a small-window chat-completions model loses its thinking

**Guarantee.** `stripsThinking` holds only when the model's `api` is `STRIP_THINKING_API`
(`openai-completions`) and `declaredWindow` gives a positive window of at most
`STRIP_THINKING_MAX_WINDOW` (262,144). Any other API keeps its thinking whatever the window, and a
missing model, or a missing, non-finite, negative or zero window, keeps it too.

**Binds.** `src/pi-extension/strip-thinking.ts` (`stripsThinking`, `STRIP_THINKING_API`,
`STRIP_THINKING_MAX_WINDOW`), `src/pi-extension/context-window.ts` (`declaredWindow`).

**Pinned by.** `test/strip-thinking.test.ts` — "stripsThinking holds for a chat-completions model at
or under the 256k window", "stripsThinking keeps the thinking of a large-window model",
"stripsThinking keeps signed thinking on every other API, whatever the window" and "stripsThinking
keeps the thinking when the model or its window is unknown or unusable".

### INV-Y2: the strip removes every thinking block, copies only what it changes, and says when it changed nothing

**Guarantee.** `stripThinking` drops every `thinking` block from every assistant message, the newest
included. Messages it does not change come back as the same objects, the input is never mutated, an
assistant message that only thought stays with empty content, and it returns null when no message
carried thinking.

**Binds.** `src/pi-extension/strip-thinking.ts` (`stripThinking`).

**Pinned by.** `test/strip-thinking.test.ts` — "stripThinking removes every thinking block, the
newest message's included", "stripThinking passes untouched messages through as the same objects and
never mutates", "stripThinking returns null when no message carries thinking" and "stripThinking
leaves an assistant message that only thought with empty content".

### INV-Y3: each stripped request is a prefix of the next

**Guarantee.** Because every thought is stripped, not all but the newest, the messages sent for
request k are a prefix of those sent for request k+1, so a server that can only rewind its prompt
cache to a checkpoint never re-reads the transcript. The adapter reads the model per request and
leaves the context untouched (returns undefined) for a non-qualifying model, no model, no message
list, or nothing to strip.

**Binds.** `src/pi-extension/strip-thinking.ts` (`stripThinking`, default export
`stripThinkingExtension`).

**Pinned by.** `test/strip-thinking.test.ts` — "each request's stripped history is a prefix of the
next request's" and "the extension strips a qualifying model's request and leaves the rest alone".

### INV-Y4: a context note fires once per threshold, for the highest one crossed

**Guarantee.** `contextNote` returns null below the first of `CONTEXT_THRESHOLDS` (50, 70, 85), for
a null, undefined or non-finite percent, and for a threshold at or below `lastWarned`. When several
are crossed at once it names only the highest. The note's advice depends only on the threshold, not
the role, and an unusable token count or window drops the count parenthetical rather than printing
half a reading.

**Binds.** `src/pi-extension/context-budget.ts` (`contextNote`, `CONTEXT_THRESHOLDS`).

**Pinned by.** `test/context-budget.test.ts` — "contextNote stays silent below the first threshold
and on unknown usage", "contextNote fires once per threshold and names the numbers", "contextNote
jumps to the highest crossed threshold instead of replaying the lower ones", "contextNote advice is
role-agnostic, so the reviewer and conflict runs can carry it" and "contextNote omits the token
counts when they are unknown".

### INV-Y5: the note follows the tool result, and usage is never asked for once nothing is left to say

**Guarantee.** The extension appends the note after the result's own content (a result with no
content array gets the note alone), and composed after bounded-output it follows the bounded result.
A context without usage or with a throwing getter yields no note and no throw (`readContextUsage`).
With no thresholds, or once the last threshold has fired, it returns without calling
`getContextUsage`.

**Binds.** `src/pi-extension/context-budget.ts` (default export `contextBudget`),
`src/pi-extension/context-usage.ts` (`readContextUsage`), `src/pi-extension/tool-result-content.ts`
(`appendToolResultNote`).

**Pinned by.** `test/context-budget.test.ts` — "the extension appends the note after the tool
result's own content, once per threshold", "a tool result with no content array still gets the note
alone", "the extension tolerates a context without usage or a throwing getter", "empty thresholds
warn at nothing and never ask for a projection", "the extension stops asking for usage once the last
threshold has fired" and "composed after bounded-output the way pi composes handlers, the note
follows the bounded result".

## Local time: a day is the local calendar day, and an age or countdown never reads negative

`src/text/datetime.ts` is the one home of the local calendar-day rule and of the s/m/h/d phrasing
behind every relative time. The GUI's browser script keeps its own twins of a few of these, which
this section does not bind.

### INV-Z1: a day key is the local calendar day, never the UTC date

**Guarantee.** `formatDate` renders `YYYY-MM-DD` from the local date parts, and `dayKey` is
`formatDate` of the instant. `dayAt(n, now)` is local midnight n days before `now`, with the Date
constructor rolling month and year edges.

**Binds.** `src/text/datetime.ts` (`formatDate`, `dayKey`, `dayAt`).

**Pinned by.** `test/datetime.test.ts` — "dayKey is the LOCAL calendar day of the instant, never the
UTC date", "formatDate renders the local calendar date, zero-padded, from date parts alone" and
"dayAt returns local midnight offset from the given instant, rolling month/year edges".

### INV-Z2: a trailing window holds exactly its days, and a day count survives DST

**Guarantee.** `dayWindow(days, now)` gives inclusive `from` and `to` keys for `days` local calendar
days ending on `now`'s day, both derived from the one `now`. `daysBetween` counts whole days between
two keys through `Date.UTC`, so a DST shift cannot move it by one, and it is negative when `toKey`
is earlier.

**Binds.** `src/text/datetime.ts` (`dayWindow`, `daysBetween`).

**Pinned by.** `test/datetime.test.ts` — "dayWindow bounds a trailing window of `days` local
calendar days ending today" and "daysBetween counts whole calendar days, across DST and in either
direction".

### INV-Z3: a timestamp's date and clock come from one Date, and a corrupt instant reads as the em dash

**Guarantee.** `formatTimestamp` builds both halves from one `Date`, so they cannot disagree across
midnight. It renders a non-finite `ms` as `—`, never `NaN`. `formatTime` and `pad2` zero-pad to two
digits and leave longer numbers alone.

**Binds.** `src/text/datetime.ts` (`formatTimestamp`, `formatTime`, `pad2`).

**Pinned by.** `test/datetime.test.ts` — "formatTimestamp renders date and clock from ONE Date, so
its halves cannot disagree", "formatTimestamp renders a non-finite instant as the em dash, never
NaN", "formatTime renders the zero-padded local wall clock from date parts alone" and "pad2
zero-pads to two digits and leaves longer numbers alone".

### INV-Z4: an age or a countdown is whole seconds and never negative

**Guarantee.** `secondsSince` and `secondsUntil` round to whole seconds and clamp at zero. A future
instant reads 0 ago, and a passed deadline reads 0 until. `humanUntil` and `humanAgo` are
`humanSeconds` over them, with `humanAgo` adding ` ago`.

**Binds.** `src/text/datetime.ts` (`secondsSince`, `secondsUntil`, `humanUntil`, `humanAgo`).

**Pinned by.** `test/datetime.test.ts` — "humanUntil renders how-long-until an instant in one call"
and "secondsSince and secondsUntil round to whole seconds and never go negative, and humanAgo reads
the same span with the ago suffix".

### INV-Z5: a duration reads in one of four buckets, and a rounding carry moves up a bucket

**Guarantee.** `humanSeconds` reads seconds under a minute, then minutes, hours and days, rounding
within each bucket. A count that rounds up to 60 minutes or 24 hours is shown in the next bucket
(`1h`, `1d`), never as `60m` or `24h`. A day or more reads days, never an hour count.

**Binds.** `src/text/datetime.ts` (`humanSeconds`).

**Pinned by.** `test/datetime.test.ts` — "humanSeconds buckets sub-second-to-day spans compactly".

## Full tool output: a pointer names a complete file inside the harness, or there is no pointer

The module is the side-effect half of the two context extensions, kept apart so their rules stay
pure. It finds the harness root itself because a pi run's working directory may be a worktree.

### INV-AC1: the root walk is bounded and finds the nearest .tumwater/

**Guarantee.** `findTumwaterRoot` checks `startDir` and its ancestors for a `.tumwater/` directory,
at most 64 directories including `startDir` (`walkUp(startDir, 63, …)`). It returns the first one it
finds, and null when none is within the bound or the filesystem root comes first.

**Binds.** `src/pi-extension/full-output.ts` (`findTumwaterRoot`), `src/files/files.ts` (`walkUp`).

**Pinned by.** `test/full-output.test.ts` — "findTumwaterRoot walks up to the harness root" and
"findTumwaterRoot gives up after 64 levels without .tumwater/ instead of looping forever".

### INV-AC2: with no harness root or a failed write, the result is null and nothing throws

**Guarantee.** `writeFullOutput` returns null when there is no root, and turns any mkdir or write
error into null, so its callers keep the result rather than point at a missing file.

**Binds.** `src/pi-extension/full-output.ts` (`writeFullOutput`).

**Pinned by.** `test/full-output.test.ts` — "writeFullOutput returns null when no ancestor has
.tumwater/" and "writeFullOutput returns null when the write fails instead of throwing".

### INV-AC3: a returned path holds the whole output, never a truncated one

**Guarantee.** The write goes through `writeTextAtomic`, so a process that dies mid-write leaves no
file at the target, and a returned path names a file holding the exact text passed in.

**Binds.** `src/pi-extension/full-output.ts` (`writeFullOutput`), `src/files/files.ts`
(`writeTextAtomic`).

**Pinned by.** `test/full-output.test.ts` — "writeFullOutput leaves no truncated log when the
process dies mid-write" and "writeFullOutput writes into .tumwater/log/tool-output named by
toolCallId".

### INV-AC4: the file is named by the tool call id, and the name stays inside tool-output

**Guarantee.** The file is `<id>.log` under `toolOutputDir(root)`, where `<id>` is `toolCallId` with
each character outside `[\w-]` replaced by `_`. A missing, non-string or empty id gets
`result-<ms>.log` instead.

**Binds.** `src/pi-extension/full-output.ts` (`writeFullOutput`), `src/paths.ts` (`toolOutputDir`).

**Pinned by.** `test/full-output.test.ts` — "writeFullOutput writes into .tumwater/log/tool-output
named by toolCallId", "writeFullOutput falls back to a timestamped name when the tool call has no
id" and "writeFullOutput keeps a toolCallId with path characters inside tool-output".

## System-prompt trim: pi's docs section never goes out, and nothing else in the prompt changes

`src/pi-extension/trim-system-prompt.ts` is a pi extension loaded on every pi run. Its rule is a
pure exported function (`withoutDocsSection`) behind a thin default-export adapter. It edits only
the system prompt that pi's `before_agent_start` event hands it.

### INV-AB1: the docs section goes with the blank lines before it, and every other byte stays

**Guarantee.** `withoutDocsSection` removes the first `<docs>`…`</docs>` span (the match is
non-greedy) together with the newlines directly before it, so the sections around it keep the one
blank line between them and a docs section last in the prompt leaves no trailing blank lines.
Everything outside that span is returned byte for byte.

**Binds.** `src/pi-extension/trim-system-prompt.ts` (`withoutDocsSection`, `DOCS_SECTION`).

**Pinned by.** `test/trim-system-prompt.test.ts` — "withoutDocsSection cuts the docs section and
keeps every other section byte for byte" and "withoutDocsSection leaves a prompt with no docs
section alone" (its second assertion covers the docs-last case).

### INV-AB2: a prompt with no docs section, or none at all, is left to pi

**Guarantee.** `withoutDocsSection` returns null for a prompt with no docs section (a custom
prompt, or a pi that no longer renders one), and the handler then returns undefined, so pi keeps
its own prompt; a missing or non-string `systemPrompt` also returns undefined. The extension never
substitutes text of its own.

**Binds.** `src/pi-extension/trim-system-prompt.ts` (`withoutDocsSection`, default export
`trimSystemPrompt`).

**Pinned by.** `test/trim-system-prompt.test.ts` — "withoutDocsSection leaves a prompt with no docs
section alone" and "the extension trims on every model, whatever window it declares".

### INV-AB3: the trim applies on every model, whatever window it declares

**Guarantee.** The `before_agent_start` handler does not read the model, so a 64k, 128k or 1M
window, or no model at all, gets the same trimmed prompt.

**Binds.** `src/pi-extension/trim-system-prompt.ts` (default export `trimSystemPrompt`).

**Pinned by.** `test/trim-system-prompt.test.ts` — "the extension trims on every model, whatever
window it declares".

## Shared phrases: a count agrees with its noun, a hold or budget never reads NaN, and an unreadable field falls back to fixed wording

`src/text/phrases.ts` is the single home of these wordings, so the event feed, the failure digest,
the status surfaces and the CLI cannot drift apart. It is pure presentation over `format.ts`'s
tokens.

### INV-AE1: a count's word is singular for exactly one and plural for every other count

**Guarantee.** `plural(n, one, many)` renders `n === 1` with `one` and every other count, zero
included, with `many` (default `one` plus `s`); `agree` makes the same choice without printing the
count. The GUI keeps its own JS copy in `gui-client.ts`, which this entry does not bind.

**Binds.** `src/text/phrases.ts` (`plural`, `agree`).

**Pinned by.** `test/phrases.test.ts` — "plural and agree treat exactly one as singular and every
other count as plural".

### INV-AE2: a span under two minutes reads in seconds, and a hold never reads negative

**Guarantee.** `shortSpanPhrase` reads a span in seconds while the rounded seconds count is under
120, and in whole minutes otherwise, so a span that rounds up to two minutes reads `2m`, never
`120s`. `holdPhrase` clamps a negative or unreadable hold to `for 0s` and names `(relapse N)` only
when the escalation count is above zero.

**Binds.** `src/text/phrases.ts` (`shortSpanPhrase`, `holdPhrase`).

**Pinned by.** `test/phrases.test.ts` — "shortSpanPhrase rounds a near-two-minute span into the
minute arm, never 120s" and "holdPhrase clamps an unreadable or negative hold to 0s and adds the
relapse only past zero".

### INV-AE3: a budget phrase reads a non-numeric field as $0.00, never $NaN

**Guarantee.** `budgetPhrase` coerces the spent and cap fields through `finiteNumber` with a
fallback of 0 before the money format renders them, so a string, `NaN` or infinite value reads
`$0.00`.

**Binds.** `src/text/phrases.ts` (`budgetPhrase`).

**Pinned by.** `test/phrases.test.ts` — "budgetPhrase reads a non-numeric or non-finite event field
as $0.00, never $NaN".

### INV-AE4: a tool-call label is one bounded line naming the path's basename or the command after any leading cd

**Guarantee.** `describeToolCall` takes the first string among `path`, `file_path`, `command`,
`cmd`, `pattern` and `url`; a `path` or `file_path` reduces to its basename, a `command` or `cmd`
loses any leading `cd <dir> &&` (or `;`) prefixes, and the others stay verbatim. The detail is
squashed to one line of at most 32 characters. The label is the tool name and the detail, the bare
detail when the name is empty, and the bare name when the args give no string detail.

**Binds.** `src/text/phrases.ts` (`describeToolCall`, `withoutLeadingCd`).

**Pinned by.** `test/phrases.test.ts` — "describeToolCall summarizes common arg shapes tersely",
"describeToolCall with an omitted toolName yields the bare detail, no leading space",
"describeToolCall basenames path-like keys and shows the others verbatim", "describeToolCall
prefers the first present key in path, file_path, command, cmd, pattern, url order",
"describeToolCall falls back to the bare tool name for non-object or non-string args" and
"describeToolCall drops a leading cd so the label names the command".

### INV-AE5: an unreadable reason or failure kind falls back to fixed wording

**Guarantee.** `firstReason` returns the first reason when it is a string and the fixed
no-reasons wording otherwise. `backendKindPhrase` names each known backend-failure kind and reads
any other kind, or none, as `backend failure`.

**Binds.** `src/text/phrases.ts` (`firstReason`, `backendKindPhrase`).

**Pinned by.** `test/phrases.test.ts` — "firstReason returns the first string reason and falls back
when there is none" and "backendKindPhrase names each backend-failure kind and falls back on an
unreadable kind".

## Display formats: each number, money, size and hash format has one home and one rule

`src/text/format.ts` is presentation only: it imports nothing but `text.ts`, so any layer can
render through it. The GUI's browser script keeps its own twins of some of these formats
(`fmtTokens`, the money and cap cells, the file-size label), which this section does not bind.

### INV-AA1: a token count is bare below 10,000, then one-decimal k, then one-decimal M

**Guarantee.** `compactTokens` renders an integer as-is below 10,000, `(n/1000).toFixed(1)` plus
`k` from 10,000, and `(n/1e6).toFixed(1)` plus `M` from 1,000,000. 999,999 reads `1000.0k`, the
same as the report's table.

**Binds.** `src/text/format.ts` (`compactTokens`).

**Pinned by.** `test/format.test.ts` — "compactTokens renders bare integers below 10,000",
"compactTokens renders one-decimal k at and above 10,000" and "compactTokens renders one-decimal M
at and above 1,000,000".

### INV-AA2: a short hash is its first 8 characters, and a missing hash reads "?"

**Guarantee.** `shortSha` slices `textOr` of its argument to 8 characters. A string or finite
number abbreviates; `undefined`, `null`, an object, NaN or Infinity reads `?`, never `undefined`.

**Binds.** `src/text/format.ts` (`shortSha`), `src/text/text.ts` (`textOr`).

**Pinned by.** `test/format.test.ts` — "shortSha abbreviates a hash to its first 8 characters".

### INV-AA3: money always shows cents, and a cap drops only a whole-dollar .00

**Guarantee.** `usd` renders `$` and exactly two decimals. `usdCap` renders the same, then strips
a trailing `.00` only, so `$50` and `$12.34`, never `$12.3`.

**Binds.** `src/text/format.ts` (`usd`, `usdCap`).

**Pinned by.** `test/format.test.ts` — "usd always keeps two decimals; usdCap drops a whole-dollar
.00".

### INV-AA4: a disk size is always GB, and a byte count takes the largest 1024-based tier

**Guarantee.** `formatGB` renders one decimal and ` GB` at any magnitude. `formatBytes` picks GB,
MB or KB at 1024-based thresholds with one decimal, and renders a count under 1024 as a bare
integer with ` B`.

**Binds.** `src/text/format.ts` (`formatGB`, `formatBytes`).

**Pinned by.** `test/format.test.ts` — "formatGB renders one decimal and the unit" and
"formatBytes picks the largest of the B/KB/MB/GB tiers, one decimal each".

### INV-AA5: a prompt note is joined by exactly one blank line, unconditionally

**Guarantee.** `appendPromptNote` returns the prompt, `\n\n`, then the note, with no trimming and
no skip for an empty note, so the separator lives in one place.

**Binds.** `src/text/format.ts` (`appendPromptNote`).

**Pinned by.** `test/format.test.ts` — "appendPromptNote joins a note to the prompt with one blank
line, even an empty note".

## Text shaping: a bounded line never overflows or splits a character, and a count is plain decimal

`src/text/text.ts` is the single home of these one-line text rules, so a display surface, a prompt
cap and an input parser cannot drift apart. It is presentation and parsing only: it uses node
built-ins alone and can be imported from any layer.

### INV-AD1: a truncated line is at most max characters and never ends on a lone surrogate

**Guarantee.** `truncate` returns `s` unchanged when it fits. Otherwise it cuts to `max - 1` code
units, backing off one more when the cut would split a surrogate pair (`cutSplitsSurrogatePair`),
drops trailing whitespace the cut leaves behind, and appends `…`. A non-positive `max` gives `""`.

**Binds.** `src/text/text.ts` (`truncate`, `cutSplitsSurrogatePair`).

**Pinned by.** `test/text.test.ts` — "truncate leaves a string unchanged when it fits, including the
exact boundary", "truncate cuts to at most max characters, ellipsis included", "truncate drops a
trailing space the cut leaves behind before appending the ellipsis", "truncate never splits a
surrogate pair (no lone surrogates in clipped labels)", "truncate never returns a string longer than
max (the display-width invariant)" and "truncate with a non-positive max fits nothing and returns the
empty string".

### INV-AD2: a squashed detail is one line, collapsed before it is bounded

**Guarantee.** `squash` is `truncate(collapseWhitespace(s), max)`. Every whitespace run becomes one
space and both ends are trimmed before the cut, so the budget is spent on words, not on newlines.

**Binds.** `src/text/text.ts` (`squash`, `collapseWhitespace`).

**Pinned by.** `test/text.test.ts` — "collapseWhitespace folds runs of spaces, tabs, and newlines to
single spaces" and "squash collapses whitespace before it bounds the line".

### INV-AD3: a capped prompt text keeps a plain prefix and always says it was cut

**Guarantee.** `truncateWithNote` returns text of at most `max` characters unchanged. Past that it
keeps exactly the first `max` code units (`max - 1` when that cut would split a surrogate pair),
with no ellipsis or trim, and then appends `\n…[<label> truncated at <max> chars]`, which names
`max`, not the number of units kept.

**Binds.** `src/text/text.ts` (`truncateWithNote`, `cutSplitsSurrogatePair`).

**Pinned by.** `test/text.test.ts` — "truncateWithNote passes short text through and appends its
marker past the cap" and "truncateWithNote never splits a surrogate pair at the cut boundary".

### INV-AD4: a count parses only as a plain decimal digit run that is a safe integer

**Guarantee.** `parsePositiveInt` and `parseNonNegativeInt` accept only `^\d+$` with no leading zero
(a lone `"0"` is allowed) that `Number()` gives as a safe integer. Hex, exponent, sign, whitespace
padding, a decimal point, zero-padding and an overflowing run all give null. `parsePositiveInt` also
rejects 0, and `parseNonNegativeInt` accepts it.

**Binds.** `src/text/text.ts` (`parsePositiveInt`, `parseNonNegativeInt`).

**Pinned by.** `test/text.test.ts` — "parsePositiveInt accepts plain decimal only — hex, scientific,
signed, and padded forms are null" and "parseNonNegativeInt accepts plain decimal only and allows
zero".

### INV-AD5: untrusted text reaches the terminal without control characters except newline and tab

**Guarantee.** `stripTerminalControls` removes every C0 control except `\n` and `\t`, plus DEL and
the C1 block U+0080–U+009F. ESC goes with the rest, so no OSC or CSI sequence survives. The CLI's
output helpers (`src/cli/cli-output.ts`) and the composed TUI frame (`src/ui/tui/tui-frame.ts`)
apply it, as do several stderr diagnostics and the notify command's message text; event JSON is
not stripped, so machine-readable output stays byte-exact.

**Binds.** `src/text/text.ts` (`stripTerminalControls`).

**Pinned by.** `test/text.test.ts` — "stripTerminalControls removes ESC/C0/C1/DEL and keeps only
newline and tab".

## Untrusted JSON: a torn, foreign or wrong-shaped value reads as no data, never as a throw or a stand-in

`src/files/json-object.ts` and `src/files/json-files.ts` are the one home of the reads every state
file, event-log line, pi or backend wire line and request body goes through. Keeping the rule in
one place means one consumer cannot accept a value the others reject.

### INV-AF1: null, an array and a scalar are never a JSON object, and a non-object section reads as empty

**Guarantee.** `isJsonObject` is true only for a non-null, non-array object, so JSON null,
an array and every scalar are refused. `objectOrEmpty` returns the same object when given one and
a fresh empty object for anything else, so a caller can index a section without a guard.

**Binds.** `src/files/json-object.ts` (`isJsonObject`, `objectOrEmpty`).

**Pinned by.** `test/json-object.test.ts` — "a plain object is a JSON object, narrowed to an
indexable record", "an array is not a JSON object (an array is an object in JS)", "scalar values are not JSON objects" and
"objectOrEmpty keeps a plain object and reads every other value as an empty section".

### INV-AF2: a line that does not parse to an object reads as null, never a throw

**Guarantee.** `parseJsonObject` returns the parsed object for text that is a JSON object, and
null for a torn line, an empty string, or valid JSON that is null, an array or a scalar.

**Binds.** `src/files/json-object.ts` (`parseJsonObject`).

**Pinned by.** `test/json-object.test.ts` — "parseJsonObject parses an object and reads every
other JSON value as no data".

### INV-AF3: a list field keeps only its strings, and a number field is finite or the caller's fallback

**Guarantee.** `stringList` keeps the string entries of an array and reads a non-array as the empty
list. `finiteNumber` accepts any finite number, negative included, and `nonNegativeNumber` accepts
zero and positives; each returns the caller's fallback for NaN, an infinity or a non-number (and
`nonNegativeNumber` for a negative). It matters because a NaN or negative cost makes every
budget-cap comparison false.

**Binds.** `src/files/json-object.ts` (`stringList`, `finiteNumber`, `nonNegativeNumber`).

**Pinned by.** `test/json-object.test.ts` — "stringList keeps only the string entries of a mixed
array", "stringList reads a non-array field as the empty list", "finiteNumber accepts any finite
number, negative included, and rejects poison" and "nonNegativeNumber keeps zero and positives,
rejects negatives and poison".

### INV-AF4: a missing, torn or non-object state file reads as null, and an atomic write never leaves a torn file or a tmp remnant

**Guarantee.** `readJsonFile` returns null for a missing file, a torn file, or valid JSON that is
not an object. `writeJsonAtomic` replaces the target in one step with the caller's newline
convention; a failed write is rethrown, its tmp file is removed and the target keeps its old bytes.

**Binds.** `src/files/json-files.ts` (`readJsonFile`, `writeJsonAtomic`).

**Pinned by.** `test/json-files.test.ts` — "readJsonFile treats missing or torn files as no data,
not errors", "readJsonFile treats a valid JSON non-object as no data", "writeJsonAtomic replaces
the target atomically, honoring the caller's newline convention" and "writeJsonAtomic rethrows a
failed write, removes its tmp, and leaves the target untouched".

### INV-AF5: both backends' usage blocks carry totalTokens as the sum of the four counts

**Guarantee.** `canonicalUsageBlock` builds the usage block with `totalTokens` equal to input plus
cache read plus cache write plus output, and the cost wrapped as `{ total }`, so the two stream
translators cannot drift apart on the sum or the envelope.

**Binds.** `src/files/json-object.ts` (`canonicalUsageBlock`); consumers
`src/agent/claude/claude-stream.ts` and `src/agent/opencode/opencode-stream.ts`.

**Pinned by.** `test/json-object.test.ts` — "canonicalUsageBlock sums the four counts into
totalTokens and wraps the cost".

## Queue files: one file per entry, ordered by name, and a missing queue reads as empty

The director's prompt inbox (`src/inbox/inbox.ts`) and the durable merge queue
(`src/merge/merge-queue.ts`) both list, name, stamp and remove entries through
`src/files/file-queue.ts`. Keeping those rules in one file stops the ordering and the race
handling from drifting between the two queues.

### INV-AG1: a listing is the exact-extension entries oldest first by filename, a missing or non-directory queue reads as empty, and any other read error is thrown

**Guarantee.** `listQueueFiles` returns the full paths of the entries whose names end in exactly
the given extension (case-sensitive), sorted by filename. A directory that is missing (ENOENT) or a
path that is not a directory (ENOTDIR) reads as an empty list; any other read error, such as EACCES,
is thrown, so an unreadable queue never reads as an empty one and hides queued work.

**Binds.** `src/files/file-queue.ts` (`listQueueFiles`).

**Pinned by.** `test/file-queue.test.ts` — "listQueueFiles reads a missing directory as an empty
queue", "listQueueFiles keeps only matching extensions, oldest-first by filename", "listQueueFiles
reads a queue path that is a regular file as an empty queue" and "listQueueFiles rethrows an
unreadable queue directory instead of reading it as empty".

### INV-AG2: an entry's name sorts by stamp, then by zero-padded sequence, with the pid keeping two processes apart

**Guarantee.** `queueFileName` returns `<stamp>-<seq padded to 6 digits>-<pid><ext>`. Names with
same-width stamps sort by stamp first, then by the padded sequence (10 after 9), and the pid is
part of the name so two processes using the same stamp and sequence do not collide.

**Binds.** `src/files/file-queue.ts` (`queueFileName`).

**Pinned by.** `test/file-queue.test.ts` — "queueFileName orders across processes and breaks ties
with seq and pid".

### INV-AG3: a stamp is read back only from a leading run of exactly 13 digits, and anything else is unstamped

**Guarantee.** `queueFileStamp` returns the number from a name that starts with exactly 13 digits
followed by `-`, which is the stamp `queueFileName` wrote. A shorter or longer digit run, a name with
no digits and the empty string return null, never a guessed date.

**Binds.** `src/files/file-queue.ts` (`queueFileStamp`).

**Pinned by.** `test/file-queue.test.ts` — "queueFileStamp round-trips queueFileName's stamp and
rejects non-conforming names".

### INV-AG4: removing an entry that already vanished reports false, and any other removal error is thrown

**Guarantee.** `removeQueueFile` returns true when it removed the file and false when the file was
already gone (ENOENT), the normal race with a concurrent dequeue or cancel. Any other error is
rethrown.

**Binds.** `src/files/file-queue.ts` (`removeQueueFile`).

**Pinned by.** `test/file-queue.test.ts` — "removeQueueFile reports true for a file it removed",
"removeQueueFile reports false for a file that already vanished" and "removeQueueFile rethrows
errors other than ENOENT".

## Deferred prompts: only the writer's exact marker defers or is stripped, and a prompt is due at its stamp

`tumwater prompt --at` keeps the deferral inside the queue file's text, so no queue format migrates.
One module both composes and reads the marker, so the delivery and display surfaces cannot disagree.

### INV-AI1: only a marker in the writer's exact shape, the stamp line plus the blank separator, defers a prompt, and a stamp that does not parse reads as deliverable

**Guarantee.** `notBeforeMs` returns a time only for text that starts with the stamp line
`notBeforeMarker` writes followed by the blank separator line. Operator content that merely starts
with the prefix, a marker without the blank separator, and a stamp in the writer's shape that
`Date.parse` rejects all read as null, which is deliverable.

**Binds.** `src/inbox/prompt-not-before.ts` (`notBeforeMarker`, `notBeforeMs` and the
`NOT_BEFORE_MARKER` pattern).

**Pinned by.** `test/prompt-not-before.test.ts` — "notBeforeMarker round-trips through notBeforeMs
to the millisecond and strips to the body" and "a writer-shaped stamp that Date.parse rejects is
neither deferred nor stripped"; `test/inbox.test.ts` — "operator content that merely starts with a
marker-shaped line is never treated as plumbing" and "a marker line without the writer's blank
separator is content, not a deferral".

### INV-AI2: the stripper removes exactly what the parser accepts, once, and passes every other text through unchanged

**Guarantee.** `stripNotBeforeMarker` removes the leading marker only when `notBeforeMs` accepts it,
and removes just that one marker. Any other text, including a stamp that does not parse, is returned
as given. Its consumers are `inbox.ts`, `inbox-edit.ts` and `run-prompt.ts`.

**Binds.** `src/inbox/prompt-not-before.ts` (`stripNotBeforeMarker`).

**Pinned by.** `test/prompt-not-before.test.ts` — "notBeforeMarker round-trips through notBeforeMs
to the millisecond and strips to the body" and "a writer-shaped stamp that Date.parse rejects is
neither deferred nor stripped".

### INV-AI3: a deferred prompt is due when now reaches its stamp, and a prompt without a marker is due at once

**Guarantee.** `deliverableAt` is true for a null stamp and for a stamp at or before now, so a prompt
is due at its stamp's own millisecond. `deliverableNow` parses the text's marker and applies the
same check.

**Binds.** `src/inbox/prompt-not-before.ts` (`deliverableAt`, `deliverableNow`).

**Pinned by.** `test/prompt-not-before.test.ts` — "deliverableAt delivers at the stamp's own
millisecond, not before"; `test/inbox.test.ts` — "counts exclude deferred prompts and include them
once due".

## Pending prompts: an unfulfilled request goes back to its own role's queue, a resume reclaims exactly that file, and images follow the request

The queue file is the durable store for a dequeued request, so every outcome that leaves the request
undone hands it back before the run ends. One class holds that policy beside the queue mechanics in
`src/inbox/inbox.ts`.

### INV-AJ1: an unfulfilled request is re-queued into the running role's own queue, and a null or empty prompt queues nothing

**Guarantee.** `requeueUnfulfilled` enqueues the prompt into the queue of the role the
`PendingPrompt` was built for, so a re-queued request never crosses roles, and returns without
queueing for a null or empty prompt. `requeuePendingUnfulfilled` re-queues whatever is still
recorded and then clears the memory copy. Callers are `src/run/run-verdict.ts`,
`src/runner/runner-recovery.ts` and `src/runner/runner-run.ts`.

**Binds.** `src/inbox/pending-prompt.ts` (`requeueUnfulfilled`, `requeuePendingUnfulfilled`).

**Pinned by.** `test/pending-prompt.test.ts` — "requeueUnfulfilled puts the prompt back in the
role's own queue — never across roles" and "requeueUnfulfilled ignores null;
requeuePendingUnfulfilled requeues and clears memory".

### INV-AJ2: a non-director requeue for resume records its queue file, and the resume reclaims exactly that file or nothing; the record is consumed either way

**Guarantee.** For a non-director role `requeueForResume` stores the new queue file in
`state.resumePromptFile`; a director takes the plain requeue path and records nothing, and a null or
empty prompt leaves the record untouched. `reclaimForResume` clears the record on every call, takes
the recorded file only when the run is resuming, and reclaims nothing when that file has vanished.
It never takes another prompt enqueued meanwhile. Its caller is `src/run/run-resume.ts`.

**Binds.** `src/inbox/pending-prompt.ts` (`requeueForResume`, `reclaimForResume`).

**Pinned by.** `test/pending-prompt.test.ts` — "requeueForResume: director takes the plain path; a
role records the queue file", "requeueForResume ignores null without touching the resume record",
"reclaimForResume consumes the flag even when not resuming — a stale record never survives",
"reclaimForResume takes the exact recorded file, not whatever enqueued meanwhile" and
"reclaimForResume reclaims nothing when the file was cancelled meanwhile".

### INV-AJ3: a request's images are removed by its queue file's stem only when it was not handed back; a requeue moves them to the new stem and replaces a vanished reference with one loss note

**Guarantee.** `settleImages` removes the same-stem images of the recorded queue file unless a
requeue marked them retained, and always forgets the request afterwards. A requeue moves each
attachment to the new queue file's stem, and a reference whose file is gone is dropped and replaced
by one loss note. A resume that reclaims the requeued file records it as its queue file, so the
resume's own fulfilment sweeps the moved images.

**Binds.** `src/inbox/pending-prompt.ts` (`settleImages` and the private `enqueueCarryingImages`),
via `movePromptImages` and `stripVanishedImageReferences` in `src/inbox/inbox-attachments.ts`.

**Pinned by.** `test/pending-prompt.test.ts` — "settleImages removes a fulfilled request's images
and keeps a requeued request's", "cancel removes an image a requeue moved to the new queue file's
stem", "a requeue whose prompt lost one attachment still carries the survivors", "settleImages never
deletes a file named by hand-typed prompt text" and "a resumed request's images survive the
interrupted run and are swept from the reclaimed file's stem once the resume fulfils it".

## Prompt images: an attachment is exactly a same-stem image sibling, a reference is exactly the writer's line, and no save or move overwrites another image

Images live beside the prompt's queue file under its stem, so the stem decides which files every
sweep and move touches. One module, `src/inbox/inbox-attachments.ts`, holds that shape, the
reference-line format and the dedup rule.

### INV-AK1: an image sibling of a stem is exactly `<stem><ext>` or `<stem>-<digits><ext>`, with ext one of PROMPT_IMAGE_EXTENSIONS in any case

**Guarantee.** `isPromptImageSibling` is true for a name that is the stem followed by an image
extension, or by a hyphen, digits and an image extension; extension case does not matter. Any
other name, including a longer stem (`ab.png` for `a`), a word after the hyphen (`a-notes.png`)
and a non-image extension, is not a sibling, so no sweep or move touches it.

**Binds.** `src/inbox/inbox-attachments.ts` (`isPromptImageSibling`) and its callers
(`takenImageSiblings` there, `removeSameStemSiblings` in `src/inbox/inbox.ts`).

**Pinned by.** `test/inbox-attachments.test.ts` — "isPromptImageSibling matches exactly the shapes
savePromptImages writes" and "cancelling a prompt does not delete a hyphen-named sibling prompt's
queue file".

### INV-AK2: a reference is only a line that, trimmed, is exactly `[image attached: <path>]`; any other line is content

**Guarantee.** The private `referencedImagePath` accepts a line only in the writer's shape, and
`imageReferencePaths`, `stripImageReferenceLines`, `stripVanishedImageReferences` and
`movePromptImages` all use it. `movePromptImages` moves only a referenced same-stem sibling inside
`fromFile`'s directory; a writer-shaped line naming any other file passes through untouched and
the file stays where it is.

**Binds.** `src/inbox/inbox-attachments.ts` (`referencedImagePath` and the four functions above).

**Pinned by.** `test/inbox-attachments.test.ts` — "imageReferenceLines appends one absolute-path
line per image", "stripVanishedImageReferences drops only vanished references and records the
loss" and "movePromptImages carries saved attachments to the new stem and rewrites their lines".

### INV-AK3: saving or moving an image never overwrites one already on the target stem, and a vanished or unmovable attachment never stops the others moving

**Guarantee.** `uniqueStemName` picks `<stem><ext>` when free and otherwise the first free
`<stem>-<n><ext>` from 2, against the siblings `takenImageSiblings` found plus the names already
chosen. `savePromptImages` and `movePromptImages` both name files through it. In
`movePromptImages` a vanished attachment keeps its line and an attachment whose rename fails is
recorded as a problem; the remaining attachments still move. When a request's images are swept or
moved is INV-AJ3's policy; this entry holds the mechanics.

**Binds.** `src/inbox/inbox-attachments.ts` (`uniqueStemName`, `takenImageSiblings`,
`savePromptImages`, `movePromptImages`).

**Pinned by.** `test/inbox-attachments.test.ts` — "savePromptImages does not overwrite an image
already beside the queue file" and "movePromptImages never overwrites an image already under the
new stem"; `test/pending-prompt.test.ts` — "a requeue whose prompt lost one attachment still
carries the survivors".

### INV-AK4: one module states every image rule (count, extension, size, base64), so every surface rejects with the same wording

**Guarantee.** `promptImagesProblem` composes `promptImagesCountProblem`,
`promptImageExtensionProblem` and `promptImageSizeProblem` with the base64 check, and the limits
come from `PROMPT_IMAGES_MAX_COUNT` and `PROMPT_IMAGE_MAX_BYTES`. Surfaces outside `src/inbox`
import these instead of restating them: `src/ui/tui/tui-editor-attach.ts`,
`src/ui/gui/gui-client-composer.ts` and `src/gui/gui-prompt-commands.ts`.

**Binds.** `src/inbox/inbox-attachments.ts` (`promptImagesProblem`, `promptImagesCountProblem`,
`promptImageExtensionProblem`, `promptImageSizeProblem`, `PROMPT_IMAGE_MAX_BYTES`,
`PROMPT_IMAGES_MAX_COUNT`).

**Pinned by.** `test/inbox-attachments.test.ts` — "promptImagesProblem accepts valid images and
names every rule it enforces" and "promptImageExtensionProblem names the near miss on a mistyped
extension, the list alone otherwise".

## Run markers: a mark names exactly one run, and the exit sweep signals only that run's processes and never fails a run

Process groups cannot attribute a detached grandchild to its run (the `RUN_MARKER_VAR` doc comment
explains why), so an environment mark does. One module, `src/process/run-marker.ts`, writes the
mark, reads it and sweeps by it.

### INV-AL1: a fresh mark is <harness pid>-<12 hex>, unique per run, and a nested run appends its mark to the inherited one

**Guarantee.** `makeRunMarker` returns the harness pid, a hyphen and 12 hex digits of fresh random
bytes, so two runs of one harness never share a mark. `runMarkerEnv` appends the new mark to an
inherited `TUMWATER_RUN` value, comma-separated, and sets it alone when none was inherited.
`backendBaseEnv` builds every backend's environment from it and prepends a given `binDir` to PATH.

**Binds.** `src/process/run-marker.ts` (`makeRunMarker`, `runMarkerEnv`, `backendBaseEnv`).

**Pinned by.** `test/run-marker.test.ts` — "runMarkerEnv appends to an inherited mark and makes fresh
markers unique" and "backendBaseEnv prepends a given binDir to PATH (the notes shim dir)".

### INV-AL2: a process carries a mark only when one comma-separated value equals it exactly, empty values are no mark, and the reader's own pid is never reported

**Guarantee.** Each reader splits a `TUMWATER_RUN` value on commas and matches a whole value, so a
prefix of a run id, or an id with extra characters around it, does not match. Empty values are
dropped and duplicates collapse. `runMarkersInPs` and `pidsMarkedInPs` skip the reader's own pid.
The ps reader counts any `TUMWATER_RUN=` token in the command column, argv included, as the
grep row in the "pidsMarkedInPs" test shows.

**Binds.** `src/process/run-marker.ts` (`runMarkersInEnviron`, `runMarkersInPs`, `pidsMarkedInPs`,
`procEnvironCarriesMarker` and the private `markerValueCarries`).

**Pinned by.** `test/run-marker.test.ts` — "pidsMarkedInPs picks the marked rows only, never the
scanner itself", "runMarkersInEnviron and runMarkersInPs extract a mark's comma-separated values,
skipping the reader's own pid", "procEnvironCarriesMarker reads NUL-separated environ entries" and
"the ps readers match a mark as a whole comma-separated run id, never as a prefix, and drop empty
values".

### INV-AL3: the exit sweep sends SIGTERM to exactly the marked same-user processes, escalates to SIGKILL after 10 s, and an unreadable table makes it report 0 instead of throwing

**Guarantee.** `sweepRunMarker` finds the same-user processes carrying the mark (a `/proc` walk on
Linux, one `ps -wwE -U <uid>` pass elsewhere), sends each SIGTERM and returns how many it signaled.
Unmarked neighbors are left alone. A survivor gets SIGKILL 10 s later on an unref'd timer. When the
table cannot be read, the sweep returns 0 and throws nothing.

**Binds.** `src/process/run-marker.ts` (`sweepRunMarker`, the private `findMarkedPids`,
`readProcEnvironEntries` and `psEnvironTable`).

**Pinned by.** `test/run-marker.test.ts` — "sweepRunMarker signals the marked orphan and spares the
unmarked neighbor", "sweepRunMarker on Linux walks /proc environ and signals only the marked pid",
"sweepRunMarker escalates to SIGKILL when a marked victim survives the SIGTERM leg" and
"sweepRunMarker reports 0 and throws nothing when the process table cannot be read".

### INV-AL4: a leftover warning is logged only when a run tumwater did not kill left marked processes running

**Guarantee.** `leftoversSweptMessage` returns a warning only when the sweep signaled at least one
process and tumwater did not kill the run. A killed run's own group SIGTERM would otherwise be
counted as a leak. `runAgent` passes it the sweep's count and its killed flag.

**Binds.** `src/process/run-marker.ts` (`leftoversSweptMessage`) and its caller in
`src/agent/run-agent.ts`.

**Pinned by.** `test/run-marker.test.ts` — "leftoversSweptMessage words the sweep's count and stays
silent for a killed or clean run".

## Process table: the parsers skip what does not fit, cwds fails loudly, and the marker and port reads never fail

`src/process/process-table.ts` only reads the host's process table: it never spawns or signals a
process beyond its ps, lsof and top calls. Every consumer reaches it through the `ProcessProbe`
interface, so tests run against a fake host.

### INV-AM1: the ps, lsof and top parsers keep only lines that fit and never fail a scan

**Guarantee.** `parsePsOutput`, `parseLsofCwds` and `parseTopPorts` skip a line that does not
match their shape instead of throwing. A zombie row with no argv parses with an empty `command`.
`parseLsofCwds` counts an `n` line only under a `p` line whose id is an integer, so a name line
before any process line or under a non-numeric one belongs to no pid. `parseTopPorts` matches the
process name exactly and keeps the largest count when several rows match.

**Binds.** `src/process/process-table.ts` (`parsePsOutput`, `parseLsofCwds`, `parseTopPorts`).

**Pinned by.** `test/process.test.ts` — "parsePsOutput reads BSD and procps rows, keeps argv
spaces, and skips junk", "parseLsofCwds maps each pid to its cwd and leaves out a process lsof
could not read", "parseTopPorts reads the named process's #PORTS from a top sample, the largest
of several" and "parseLsofCwds keeps a name line only under a numeric process line".

### INV-AM2: cwds answers lsof's partial output on a numeric exit, leaves out unreadable pids, and rejects only when no lookup could run

**Guarantee.** `systemProcessProbe.cwds` returns an empty map for an empty pid list without
running a lookup. On Linux it reads the `/proc/<pid>/cwd` link, strips a trailing ` (deleted)`,
and leaves out a pid whose read fails. Elsewhere `readLsofCwds` keeps lsof's output on a numeric
nonzero exit, because lsof exits 1 when any named pid is gone, and rejects when lsof could not
run at all (missing, timed out, or killed by a signal), since a silent empty map would read as
"no orphans". `list` likewise rejects when ps cannot run, but no test calls it directly; doctor's
side of that is pinned by the `checkOrphans` test below.

**Binds.** `src/process/process-table.ts` (`readLsofCwds`, `systemProcessProbe.cwds`).

**Pinned by.** `test/process.test.ts` — "readLsofCwds answers lsof's parsed map on exit 0 and
keeps its partial output on a nonzero exit", "readLsofCwds rejects when the runner could not run
at all — no lsof, a timeout, or a signal", "systemProcessProbe.cwds rejects when no lookup could
run at all — no lsof on PATH", "systemProcessProbe.cwds on Linux reads /proc, strips ' (deleted)',
and skips vanished pids" and "systemProcessProbe.cwds answers an empty pid list without running
lsof"; `test/doctor-orphans.test.ts` — "checkOrphans degrades instead of crashing doctor: no table
warns, unreadable cwds fall back to argv".

### INV-AM3: runMarkers and launchServicesPorts never reject: an unreadable source answers an empty map or null

**Guarantee.** `systemProcessProbe.runMarkers` answers an empty map when its source cannot be
read (for example ps failing), and on Linux it skips the scanner's own pid and vanished pids.
`readLaunchServicesPorts` and `systemProcessProbe.launchServicesPorts` answer null when the
sample fails, and off macOS they answer null without sampling. How a mark is matched lives in
`src/process/run-marker.ts` (INV-AL2).

**Binds.** `src/process/process-table.ts` (`systemProcessProbe.runMarkers`,
`readLaunchServicesPorts`, `systemProcessProbe.launchServicesPorts`).

**Pinned by.** `test/process.test.ts` — "systemProcessProbe.runMarkers on Linux reads /proc
environ, skipping the scanner and vanished pids", "systemProcessProbe.runMarkers degrades to an
empty map when the ps table cannot be read", "readLaunchServicesPorts answers null off macOS
without asking for a sample" and "readLaunchServicesPorts parses an injected top sample on macOS
and answers null when the sample fails".

## launchservicesd port watch: one warning per step past the threshold, a restart re-arms it, and a poll never waits or rejects

On 2026-09-25 a launchservicesd that ran out of Mach ports wedged the GUI session of the Mac running
the team (see the header of `src/process/launch-services.ts`). The running team's watch and
`tumwater doctor` share one set of thresholds and one warning text, both defined in that module.

### INV-AN1: a team warns at the threshold, again only a full step past its last warning, and a count back under the threshold re-arms it

**Guarantee.** The first sample at or past `LAUNCH_SERVICES_WARN_PORTS` warns; after that a sample
warns only when it is `LAUNCH_SERVICES_REWARN_PORTS` past the last warning. A count back under the
threshold means launchservicesd restarted: it ends the episode, so the next climb warns afresh,
through `LaunchServicesWatch.poll` as well as through the pure function. An unreadable sample
(`null`) changes nothing: it neither warns nor ends the episode.

**Binds.** `src/process/launch-services.ts` (`nextLaunchServicesWarning`, `LaunchServicesWatch.poll`,
`LAUNCH_SERVICES_WARN_PORTS`, `LAUNCH_SERVICES_REWARN_PORTS`).

**Pinned by.** `test/launch-services.test.ts` — "a team warns at the threshold, again every step
past its last warning, and re-arms once the daemon restarts", "the team's watch samples on its first
poll, then at most once per interval, warning through the event feed", "an unreadable sample
mid-episode neither warns nor ends the episode" and "the watch re-arms once the count drops under
the threshold, warning on the next climb past it".

### INV-AN2: a poll samples at most once per interval, never overlaps a sample in flight, and never rejects

**Guarantee.** A poll samples when `LAUNCH_SERVICES_SAMPLE_MS` has passed since the last sample and
none is in flight; the first poll samples at once. A failed sample (a rejecting probe, an unwritable
events log) still advances the schedule and clears the in-flight flag, and `poll` resolves either
way. Only a daemon team builds a watch (`src/cli/cli-start.ts`); a `--once` round runs without
it.

**Binds.** `src/process/launch-services.ts` (`LaunchServicesWatch.poll`, `LAUNCH_SERVICES_SAMPLE_MS`).

**Pinned by.** `test/launch-services.test.ts` — "the watch never overlaps samples and stays quiet on
an unreadable count" and "a poll that cannot warn — a rejecting probe, an unwritable events log —
still resolves"; `test/launch-services.e2e.test.ts` — "a daemon team samples launchservicesd on its
first poll and warns once through the event feed" and "a once round runs without the watch even when
one is passed".

### INV-AN3: doctor and the team print the same warning from the same threshold, and doctor is ok off macOS

**Guarantee.** `launchServicesWarning` words the count, the kill ceiling, the consequence and the
only remedy (restart the Mac), and both surfaces print it. Doctor's `checkLaunchServicesPorts` also
warns on an unreadable count, where the team stays quiet. The count is read by
`readLaunchServicesPorts` in `src/process/process-table.ts`.

**Binds.** `src/process/launch-services.ts` (`launchServicesWarning`);
`src/doctor/doctor-launch-services.ts` (`checkLaunchServicesPorts`).

**Pinned by.** `test/launch-services.test.ts` — "the warning names the count, the kill ceiling, the
consequence and the only remedy" and "doctor's port check: ok with the count, a warning past the
threshold or when unreadable, and nothing to do off macOS".

## Detached process groups: a timed-out tree is gone when the run settles, and the runner never throws

A timeout is group-wide because killing only the leader once leaked `node --test` workers for up to
twelve days (2026-09-21, quoted in `runScriptGroup`'s doc comment). The build check and the lockfile
install (`runScriptGroup`) and git-run's `execGitBounded` share one deadline home, `armGroupDeadline`.

### INV-AO1: the escalation is armed when the deadline fires, never at spawn, and a timed-out run settles once the group is gone or at deadline + grace

**Guarantee.** A healthy run that outlasts the SIGKILL grace is not mistaken for a timeout. When
the deadline fires the group gets SIGTERM, then SIGKILL after `KILL_GRACE_MS`; the run settles as
soon as the group is gone (polled every `GROUP_POLL_MS`), or at deadline + grace at the latest,
never on the leader's `close` alone while a member survives.

**Binds.** `src/process/process-group.ts` (`armGroupDeadline`, `KILL_GRACE_MS`, `GROUP_POLL_MS`,
`runScriptGroup`).

**Pinned by.** `test/build-check-process.test.ts` — "a healthy check that outlasts the SIGKILL grace
is not mistaken for a timeout", "a timed-out check whose tree ignores SIGTERM and holds its pipes
settles at deadline + grace with the group gone (regression)", "a timed-out check does not settle on
its leader's close while a grandchild survives", "a timed-out check whose tree dies on SIGTERM
settles right after the deadline, not after the grace" and "a timed-out build check takes its
process tree with it (regression)".

### INV-AO2: a group is alive while a signal-0 probe of it succeeds or fails with EPERM, and no pid is no group

**Guarantee.** `groupAlive` probes `-pid` with signal 0: success and EPERM (a member exists that we
may not signal) both count as alive; any other error, and an undefined pid, count as gone.

**Binds.** `src/process/process-group.ts` (`groupAlive`).

**Pinned by.** `test/process-group.test.ts` — "groupAlive: no pid is no group, EPERM is a live
member, any other error is gone".

### INV-AO3: the runner never throws: a spawn failure is spawnError, each stream keeps at most the chunks that arrive before it reaches maxBuffer, and the tree runs with the LaunchServices preload

**Guarantee.** A command missing from PATH resolves with `spawnError` set and no exit code, not
with the `close` event's code. Each of stdout and stderr stops accumulating once it reaches
`maxBuffer`; later chunks are dropped. The tree's env carries the LaunchServices preload on macOS.

**Binds.** `src/process/process-group.ts` (`runScriptGroup`).

**Pinned by.** `test/process-group.test.ts` — "runScriptGroup caps each stream at maxBuffer,
dropping later chunks", "runScriptGroup reports a command missing from PATH as spawnError, never a
code, and resolves" and "runScriptGroup starts its tree with the LaunchServices preload on macOS,
and the env unchanged elsewhere"; `test/build-check.test.ts` — "runBuildCheck skips (not fails
closed) when npm is missing from PATH".

## Queue-file names: a file-addressed request names a plain .md basename inside its role's inbox, or nothing is touched

The dashboard and the TUI address a queued prompt by its file name so a stale snapshot cannot hit
the wrong entry. The name is joined onto the role's inbox directory, so one guard decides which
names are safe.

### INV-AH1: a name is accepted only as a non-empty .md basename with no separator, NUL or bare ..

**Guarantee.** A non-string or empty value is "file required" with no suffix. A `/`, `\`, NUL or
exactly `..` is the plain-basename refusal, and any other non-`.md` name is the extension refusal.
Both detailed refusals echo the name through `gotSuffix`.

**Binds.** `src/inbox/inbox-cancel.ts` (`queueFileNameProblem`).

**Pinned by.** `test/inbox.test.ts` — "queueFileNameProblem echoes the rejected name and names the
accepted shape" and "every file-addressed queue function refuses a name failing
queueFileNameProblem, touching nothing".

### INV-AH2: every file-addressed queue function throws the guard's reason before touching disk

**Guarantee.** `cancelQueuedFile`, `editQueuedFile`, `readQueuedPromptBody` and `topQueuedFile`
each run `assertQueueFileName` first and throw the reason `queueFileNameProblem` gives, so a caller
that skips the dashboard's check fails closed: the inbox listing, the queued texts and the event
log stay as they were.

**Binds.** `src/inbox/inbox-cancel.ts` (`assertQueueFileName`, `cancelQueuedFile`);
`src/inbox/inbox-edit.ts` (`editQueuedFile`, `readQueuedPromptBody`); `src/inbox/inbox-top.ts`
(`topQueuedFile`).

**Pinned by.** `test/inbox.test.ts` — "every file-addressed queue function refuses a name failing
queueFileNameProblem, touching nothing"; `test/inbox-edit.test.ts` — "editQueuedFile refuses a name
failing queueFileNameProblem, touching nothing".

### INV-AH3: the dashboard answers a bad name with the guard's reason as a 400, before any read

**Guarantee.** `rejectBadQueueFileName` sends `queueFileNameProblem`'s reason as the shared 400 and
tells the handler to stop. On 2026-10-20 it is called once in `src/gui/gui-endpoints.ts` and three
times in `src/gui/gui-prompt-commands.ts`.

**Binds.** `src/gui/gui-args.ts` (`rejectBadQueueFileName`).

**Pinned by.** `test/gui-server-api.test.ts` — "gui /api/prompt-cancel removes one queued prompt by
file, answers gone on a race".

## Git execution: every git call is bounded in time and output, decodes UTF-8 whole, and fails with a GitError that says why

Every harness git call goes through `execGitBounded` in its own detached process group, because a
timeout that signalled only git once leaked grandchildren for days (2026-09-21, in `execGitBounded`'s
doc comment). The `GitError` text is what a person reads as a role's lastError, so it has to say why.

### INV-AP1: a failed git call is a GitError naming the argv, the exit code or spawn errno, and the cause when there is one

**Guarantee.** An argv value containing whitespace is JSON-quoted in the message, so the failing
command reads unambiguously. A silent nonzero exit is reported by its code alone, with no dangling
colon. A spawn failure with empty stderr falls back to the spawn error's message. A noisy nonzero
exit keeps git's stderr as the cause.

**Binds.** `src/git/git-run.ts` (`GitError`, `runGit`).

**Pinned by.** `test/git.test.ts` — "runGit names the spawn failure when git cannot be started
(empty stderr)", "runGit reports a silent nonzero exit by its code alone, with no dangling colon",
"runGit quotes a whitespace-bearing argv value so the failing command reads unambiguously" and
"runGit keeps git's stderr on a noisy nonzero exit (format unchanged)".

### INV-AP2: a git call settles by timeoutMs + killGraceMs, takes its whole process group down, and fails rather than truncate past EXEC_MAX_BUFFER on either stream

**Guarantee.** A hung git is stopped at `timeoutMs` and the error names the deadline; a git that
ignores SIGTERM is SIGKILLed after the grace, together with its grandchild. A git whose stdout or
stderr passes `EXEC_MAX_BUFFER` is killed and fails with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, never
with truncated output. The deadline itself is `armGroupDeadline` (see INV-AO1).

**Binds.** `src/git/git-run.ts` (`execGitBounded`, `GIT_TIMEOUT_MS`, `runGit`).

**Pinned by.** `test/git.test.ts` — "runGit times out a hung git and names the deadline instead of
stalling forever", "runGit SIGKILLs a git that ignores SIGTERM, taking its grandchild with it",
"runGit SIGKILLs a git that floods stdout past the buffer cap and reports the overflow" and "runGit
SIGKILLs a git that floods stderr past the buffer cap and reports the overflow".

### INV-AP3: output is decoded as UTF-8 across chunk boundaries, and extraEnv overlays the inherited environment

**Guarantee.** A multibyte character split across two output chunks is reassembled, because both
streams are `setEncoding("utf8")`. `extraEnv` is merged over `process.env` by `childEnv`, so an
override adds a variable and the child keeps PATH and the rest.

**Binds.** `src/git/git-run.ts` (`execGitBounded`), `src/process/process.ts` (`childEnv`).

**Pinned by.** `test/git.test.ts` — "runGit reassembles a UTF-8 character split across two output
chunks" and "runGit's extraEnv adds to the inherited environment rather than replacing it".

## Operator requests: a marker reaches exactly the roles it names, and the poll always acknowledges it

The orchestrator's poll consumes the request markers that the CLI, GUI and TUI drop
(`src/operator/operator-requests.ts`). The poll body has no catch, so a consumer must not throw out
of it.

### INV-AQ1: a role-list marker targets the runners it names by id or base role, and a requested role with no runner is reached through its state file

**Guarantee.** A marker listing roles reaches each runner whose `role` or `baseRole` is listed, so
`wake --role feature` also wakes `feature-2`. A retired id reads as its current id (`dry` reaches
`dedupe`). A requested role with no live runner is reached through its existing state file. A
corrupt marker targets every runner.

**Binds.** `src/operator/operator-requests.ts` (`roleRequestTargets`, `requestedRoles`,
`runnerlessTargets`).

**Pinned by.** `test/operator-requests.test.ts` — "consumeResetRequest resets only the named roles
and logs one role event", "consumeResetRequest treats a corrupt marker as all roles (superset is
safe)", "consumeResetRequest zeroes a named role that has no live runner through its state file",
"consumeWakeRequest clears the schedule of a named role that has no live runner" and
"consumeWakeRequest wakes every instance of a named base role and the current id of a legacy one".

### INV-AQ2: an unloggable event or a failed state save does not end the poll or skip later roles

**Guarantee.** A consumer never throws out of the poll. When its event cannot be logged, the reset,
wake or abort still takes effect and the marker is consumed. A state save that fails for one role
does not skip the roles after it.

**Binds.** `src/operator/operator-requests.ts` (`logRequestEvent`, `warnStatePersistFailed`,
`consumeAbortRequests`).

**Pinned by.** `test/operator-requests.test.ts` — "consumeWakeRequest wakes every named role when a
wake event cannot be logged", "consumeResetRequest resets and acknowledges when its event cannot be
logged", "consumeAbortRequests consumes every marker when one run abort cannot be logged",
"consumeAbortRequests keeps a marker whose abort side effect throws, without skipping later ones",
"consumeResetRequest survives an unwritable runnerless state file instead of ending the poll",
"consumeWakeRequest survives an unwritable runnerless state file" and "consumeWakeRequest keeps a
live runner whose wake save fails from skipping later ones".

### INV-AQ3: a scheduled wake applies only once its deadline passes

**Guarantee.** A scheduled wake with a future `notBeforeMs` stays in place. A missing, non-numeric
or non-finite `notBeforeMs`, or a corrupt file, reads as due. Listing pending wakes deletes nothing,
and cancelling removes only files that are still pending, optionally limited to the listed roles.

**Binds.** `src/operator/operator-requests.ts` (`wakeDeadlineMs`, `wakeNotDue`,
`pendingScheduledWakes`, `cancelScheduledWakes`).

**Pinned by.** `test/operator-requests.test.ts` — "consumeWakeRequest leaves a scheduled wake in
place before its deadline", "consumeWakeRequest consumes a scheduled wake at its deadline",
"consumeWakeRequest reads a non-numeric notBeforeMs as immediate", "consumeWakeRequest reads a
non-finite notBeforeMs as immediate", "consumeWakeRequest applies an immediate wake.json but leaves
a future scheduled file", "consumeWakeRequest wakes everyone for a corrupt scheduled file and
ignores tmp leftovers", "pendingScheduledWakes lists future entries by deadline and deletes
nothing", "cancelScheduledWakes removes pending files and leaves a due one", "cancelScheduledWakes
with a role drops only that role" and "cancelScheduledWakes with a role list drops each listed
role".

### INV-AQ4: a marker whose presence is the request is removed even when nothing can act on it

**Guarantee.** A reclaim marker with no controller, and an abort marker for an idle role or one
with no runner, are removed.

**Binds.** `src/operator/operator-requests.ts` (`consumeMarkerRequest`, `consumeReclaimRequest`,
`consumeAbortRequests`).

**Pinned by.** `test/operator-requests.test.ts` — "consumeReclaimRequest with no controller
still removes the marker", "consumeAbortRequests silently clears a marker for an idle role" and
"consumeAbortRequests clears a marker for a role with no runner at all".

## Retire: a role's leftovers go only when nothing unmerged or in use goes with them

`tumwater retire --role <id>` (`src/operator/retire.ts`) deletes a role's worktree, branch and merge
ref. Its rails are the only thing between an operator and lost work.

### INV-AR1: without --force, retire refuses and removes nothing while the role is in use or holds unmerged work

**Guarantee.** Without `--force`, retire refuses, leaving every artifact in place, when the role is
enabled (a work instance id included), when its branch or an unmerged merge-ref pin holds unmerged
commits, when the worktree is dirty or unusable, or when a run is in flight. The branch's commits are
counted from the branch ref, even when the worktree directory is gone, and a merge-ref pin counts as
one unmerged commit even while the branch sits at main. `--force` overrides those rails. A
`tumwater.json` that cannot be read refuses even with `--force`.

**Binds.** `src/operator/retire.ts` (`collectRetire`, `objections`, `retireRole`).

**Pinned by.** `test/retire.test.ts` — "retire refuses an enabled role, unmerged commits, a dirty
worktree, and a mid-run role; --force goes through", "retire refuses a dirty worktree and a mid-run
role before removing anything", "retire refuses an unusable worktree it cannot check for uncommitted
changes", "retire counts a dead worktree's unmerged branch commits even when the directory is gone",
"retire refuses an enabled work instance id, not just its bare base role (part 5b/7)" and "retire
refuses when tumwater.json cannot be read, even with --force"; `test/retire-merge-ref.test.ts` —
"retire refuses a merge ref pinning an unmerged commit while the branch sits at main".

### INV-AR2: a pooled slot is unpinned and reset in place, and anything already gone is skipped

**Guarantee.** A pooled slot is unpinned and reset, never removed, even when its directory is gone. A
legacy worktree is removed, and a dead registration is cleared with it. An artifact already gone is
reported as skipped, so a second retire exits 0.

**Binds.** `src/operator/retire.ts` (`retireRole`).

**Pinned by.** `test/retire.test.ts` — "retire a pinned slot clears the pin and resets it in place
instead of removing it", "retire clears a pinned slot whose directory is already gone", "a second
retire is idempotent: skipped artifacts, exit 0" and "retire removes a dead worktree registration
(directory already gone, branch remains)".

### INV-AR3: the merge ref is found and deleted under its current and its legacy name

**Guarantee.** A merge ref is found under either spelling and `retireRole` deletes it, so a pin under
the legacy name is reported and removed. A pin already merged into main does not block.
`hasRetirableLeftovers` accepts only a well-formed, non-director id that still has a branch or a pin.

**Binds.** `src/operator/retire.ts` (`mergeRefSha`, `hasRetirableLeftovers`, `retireRole`).

**Pinned by.** `test/retire.test.ts` — "retire removes a disabled role's worktree, branch, and merge
ref", "hasRetirableLeftovers gates on a well-formed non-director id with a branch or merge ref" and
"hasRetirableLeftovers counts a legacy-named pin"; `test/retire-merge-ref.test.ts` — "retire reports
and deletes a legacy-named merge ref that is the role's only pin".

### INV-AR4: --dry-run previews the removal and changes nothing

**Guarantee.** `retire --dry-run` lists what a real run would remove or skip, leaves the worktree,
branch and merge ref in place, and `previewRetire` leaves a paused marker in place.

**Binds.** `src/operator/retire.ts` (`previewRetire`).

**Pinned by.** `test/retire.test.ts` — "retire --dry-run previews the removal and changes nothing"
and "previewRetire lists a paused marker and leaves it in place".

## Prompt submission: a prompt is capped, gated and queued in one step, or nothing is queued

`src/inbox/inbox-submit.ts` is the one submit pipeline the TUI, GUI and CLI share: the length cap,
the image gate and the enqueue.

### INV-AS1: an over-cap prompt is refused before anything is queued or logged

**Guarantee.** A prompt over the cap is refused before anything is queued or logged. The cap
applies to the composed text (body plus image reference lines), and an over-cap composition leaves
no image files behind. The error names the target role's run.

**Binds.** `src/inbox/inbox-submit.ts` (`promptLengthProblem`, `submitRolePrompt`,
`submitPromptWithImages`).

**Pinned by.** `test/inbox-submit.test.ts` — "submitPrompt rejects an over-long prompt before
anything is queued or logged", "a role prompt's over-cap error names the target role's run, not the
director's", "the director prompt length cap applies to role prompts too" and "an image-carrying
prompt is capped on its composed text, not its body alone".

### INV-AS2: an image no configured model can read, or a malformed image, is refused at submit

**Guarantee.** An image no configured model can read is refused at submit. A reroute tier accepts
it, with a notice, and a probe-failed pi claim reads as text-only. A malformed image is refused
before the role's inbox directory is created.

**Binds.** `src/inbox/inbox-submit.ts` (`imagePromptGuidance`, `submitRolePrompt`).

**Pinned by.** `test/inbox-submit.test.ts` — "image prompts are refused when no configured model
reads images, accepted when a tier reroutes", "imagePromptGuidance returns a refusal or a reroute
notice, and nothing when the role reads images" and "imagePromptGuidance treats a probe-failed pi
claim as text-only, matching the surfaces"; `test/inbox-submit-guards.test.ts` — "a malformed image
is refused before the role's inbox is touched".

### INV-AS3: the queue write is the durable effect, and notBeforeMs defers a prompt on both paths

**Guarantee.** An unwritable events feed does not fail a submit on either the text or the image
path. `notBeforeMs` defers the prompt on both paths: it is listed but not deliverable until the
time passes.

**Binds.** `src/inbox/inbox-submit.ts` (`submitRolePrompt`, `submitPromptWithImages`).

**Pinned by.** `test/inbox-event-best-effort.test.ts` — "submitPrompt queues the prompt and reports
success when the events feed is unwritable" and "submitRolePrompt's image path queues the prompt
when the events feed is unwritable"; `test/status-data-inbox.test.ts` — "snapshot's director inbox
deliverability advances with its pinned clock" (text path); `test/inbox-submit-guards.test.ts` — "an
image-carrying prompt submitted with notBeforeMs is queued deferred" (image path).

## Backlog release and reorder: a release lifts one hold from one entry, and a refused write leaves the file as it was

`src/backlog/backlog-release.ts` holds the writers behind `tumwater plan|bug --release <n>` and
`--top <n>`, and the non-exiting `try…` twins the TUI and dashboard call.

### INV-AT1: a release lifts one note, Refused first, from the addressed entry only

**Guarantee.** A release lifts the entry's Refused note or, when it has none, its
Waiting-for-the-next-failure note: one note per release, so an entry carrying both needs two
releases and loses the Refused note first. Only the addressed entry's lines are filtered, and its
Needs review note stays. An entry with neither note is refused and the file is left as it was.

**Binds.** `src/backlog/backlog-release.ts` (`liftRefusal`, `releaseEntry`, `tryReleaseEntry`),
`src/backlog/backlog-eligibility.ts` (`withoutRefusalNotes`, `withoutWaitingNotes`).

**Pinned by.** `test/backlog-release-holds.test.ts` — "a release lifts the Refused note first and
leaves the Waiting note for a second release" and "a release touches only the addressed entry and
keeps its Needs review note"; `test/backlog-write-cancel.test.ts` — "releaseEntry lifts a
waiting-for-the-next-failure note"; `test/backlog-eligibility.test.ts` — "withoutRefusalNotes drops
Refused note lines and the blank line after one between blanks".

### INV-AT2: the try… twins write the CLI writers' bytes and refuse as data without writing

**Guarantee.** `tryReleaseEntry` and `tryMoveEntryToTop` leave the same file bytes as
`releaseEntry` and `moveEntryToTop`. They answer `gone` (no such position), `moved` (the title at
that position differs from the expected one), `not_refused` and `already_first` as data, and write
nothing. In the code, each decision is made inside `withPrimaryWorktreeLock`; no test checks the
lock itself.

**Binds.** `src/backlog/backlog-release.ts` (`tryReleaseEntry`, `tryMoveEntryToTop`).

**Pinned by.** `test/backlog-write-cancel.test.ts` — "tryReleaseEntry leaves the bytes
releaseEntry leaves and refuses without writing"; `test/backlog-write-top.test.ts` —
"tryMoveEntryToTop leaves the bytes moveEntryToTop leaves and refuses without writing".

### INV-AT3: a move to the top moves the entry whole, and a refused move changes no byte

**Guarantee.** A move to the top moves the entry's lines whole (a fenced `###` line and a Refused
note included), leaves `## Done` untouched and keeps the file's trailing newline. Position 1 and
an out-of-range position fail and leave the file byte-identical.

**Binds.** `src/backlog/backlog-release.ts` (`moveEntryToTop`, `spliceEntryToTop`).

**Pinned by.** `test/backlog-write-top.test.ts` — "moveEntryToTop moves the last entry first and
leaves ## Done untouched", "moveEntryToTop moves a middle entry above the first", "moving the
file's last entry keeps the file's trailing newline and doubles no blank", "a body holding a
fenced ### line and a Refused note move whole" and "position 1 and an out-of-range position fail
and leave the file byte-identical".

## Role change view: every known role answers, degraded rather than failing, with a bounded patch

`src/change/change-data.ts` collects what `tumwater diff`, `tumwater diff --role <id>` and the
dashboard's diff endpoint show: `collectRoleChange` for one role, `collectTeamChanges` for all.

### INV-AU1: a role query never fails on a degraded team

**Guarantee.** A missing baseline is `no-base`, a missing or half-deleted worktree is `absent`,
and a malformed slots.json falls back to the legacy worktree. Every degraded field is zero or
empty.

**Binds.** `src/change/change-data.ts` (`collectRoleChange`), `src/git/slots-state.ts`
(`roleWorktreeDir`), `src/git/worktree.ts` (`isUsableWorktree`).

**Pinned by.** `test/change-data.test.ts` — "a configured base branch that does not exist degrades
to no-base" and "a malformed slots.json degrades to no pooled slot instead of crashing the
reader"; `test/change-render.test.ts` — "a half-deleted worktree — the directory survives, its git
link does not — degrades to absent"; `test/cli-diff.test.ts` — "a role with no worktree yet
degrades to a line, exit 0".

### INV-AU2: the baseline is the configured baseBranch, then the primary checkout's branch

**Guarantee.** A configured `baseBranch` is the diff's baseline; without one the primary checkout's
branch is. The role's checkout is a slot leased for its run when one exists, else the legacy
worktree.

**Binds.** `src/change/change-data.ts` (`collectRoleChange`), `src/git/slots-state.ts`
(`roleWorktreeDir`).

**Pinned by.** `test/cli-diff.test.ts` — "a configured baseBranch is the diff's baseline, not the
checked-out branch"; `test/change-data.test.ts` — "a slot leased for a role's run serves its
change to the diff reader".

### INV-AU3: the uncommitted half is `git diff HEAD`, bounded by DIFF_MAX_BYTES

**Guarantee.** Staged and unstaged tracked edits both appear in the patch below the cap. Untracked
paths appear in `dirtyFiles` only. Over `DIFF_MAX_BYTES` the patch becomes a truncation note plus
the `--stat` summary.

**Binds.** `src/change/change-data.ts` (`cappedWorkingDiff`).

**Pinned by.** `test/change-data-scope.test.ts` — "a staged and an unstaged edit below the cap
both appear in the uncommitted patch"; `test/change-render.test.ts` — "untracked files show in the
dirty list with no patch text" and "an uncommitted diff over the cap truncates to a note plus the
--stat summary".

### INV-AU4: the team view has one entry per known role and no patch fields

**Guarantee.** `collectTeamChanges` lists the catalog, then custom roles, then parallel instance
ids, selfcheck (disabled by default) included, each with its counts and commit subjects. Neither
patch field rides the team view.

**Binds.** `src/change/change-data.ts` (`collectTeamChanges`), `src/config/config.ts`
(`knownRoleIdsCached`).

**Pinned by.** `test/change-data-scope.test.ts` — "the team view lists custom roles and parallel
instances after the catalog, each with its own change"; `test/change-data.test.ts` — "the team
view keeps the counts and drops the patch fields"; `test/cli-diff.test.ts` — "team diff --json
prints the roster: one entry per known role, no patch fields".

## Pause markers: a pause stands until resumed or expired, a wrong-shaped marker never throws, and the role set reads in canonical ids

### INV-AV1: the team marker's presence is the pause, and a missing or expired one never throws

**Guarantee.** A missing or expired team marker reads as unpaused and never throws; a
non-finite `until` reads as an indefinite pause, never a countdown.

**Binds.** `src/team/team-state.ts` (`standingMarker`, `isTeamPaused`, `pausedUntil`).

**Pinned by.** `test/team-state.test.ts` — "isTeamPaused reads false with no .tumwater dir and no
marker", "an expired team deadline reads as unpaused everywhere and a re-pause starts fresh", "a
non-finite team deadline reads as an indefinite pause, never a bogus countdown".

### INV-AV2: pauseTeam reports whether it changed state and keeps one folded reason

**Guarantee.** A plain pause on a standing one is a no-op that keeps the reason; a `--for`
overwrites the deadline. The reason is folded to one line, capped at `PAUSE_REASON_MAX`, and
cleared by a reasonless write.

**Binds.** `src/team/team-state.ts` (`pauseTeam`, `pausedReason`).

**Pinned by.** `test/team-state.test.ts` — "pauseTeam writes the marker once and is idempotent",
"a fresh --for over a standing team pause overwrites the deadline; a plain pause no-ops",
"pauseTeam carries the operator reason: trimmed, capped, last-write-wins, cleared by a reasonless
write", "a standing marker's reason is folded, capped, and type-guarded on read, whoever wrote
it".

### INV-AV3: the per-role set is idempotent and its writers serialize

**Guarantee.** `pauseRole` and `resumeRole` are idempotent, the last removal deletes the file, a
sibling write keeps the shared deadline, and concurrent writers serialize through the state lock,
which a crashed writer's stale lock does not hold forever.

**Binds.** `src/team/team-state.ts` (`pauseRole`, `resumeRole`, `standingRolesUntil`,
`withPausedRolesLock`).

**Pinned by.** `test/team-state.test.ts` — "pauseRole and resumeRole maintain the marker set
idempotently", "a sibling pause or resume keeps the paused-roles marker's standing shared
deadline", "simultaneous cross-process pauseRole calls all survive in the marker", "a crashed
pause writer's lock is stolen, not waited on forever".

### INV-AV4: the role set reads in canonical ids, and its deadline shows only while it is non-empty

**Guarantee.** `readPausedRoles` maps each stored id through `canonicalRoleId`, so a marker
written before a rename still pauses and resumes the renamed role. An expired deadline releases
the whole set, and the deadline is reported only while the set is non-empty.

**Binds.** `src/team/team-state.ts` (`readPausedRoles`, `standingRolePause`,
`pausedRolesUntil`).

**Pinned by.** `test/team-state-pause-read.test.ts` — "a paused-roles marker naming a legacy id
pauses and resumes the canonical role", "an empty paused-roles set carries no deadline, and a
non-empty one carries its future deadline"; `test/team-state.test.ts` — "pauseRole with a
deadline writes { roles, at, until } and expiry releases the set", "a non-finite per-role
deadline is dropped on a rewrite instead of becoming an expired marker".

## Worktree reclaim: a clean stays inside idle linked worktrees, removes only ignored files, and runs once per drop

`src/team/reclaim.ts` deletes the gitignored files of idle harness worktrees (`git clean -fdX`)
under disk pressure, when a worktree goes idle, and on `tumwater reclaim`.

### INV-AW1: a clean refuses what it must not touch and removes only ignored files

**Guarantee.** A clean throws, deleting nothing, outside `worktreesDir` or on a directory that is
not a linked worktree. It returns false without cleaning a worktree in use by a run, and the
refusal leaves no claim behind. It removes only ignored files, keeping tracked edits, untracked
files and nested repositories, and counts as a reclaim only when git removed something.

**Binds.** `src/team/reclaim.ts` (`reclaimWorktree`, `isLinkedWorktree`, `cleanIgnored`).

**Pinned by.** `test/reclaim.test.ts` — "reclaimWorktree removes only gitignored files, keeping
edits and nested repos", "reclaimWorktree throws and deletes nothing outside worktreesDir",
"reclaimWorktree throws for a plain repo inside worktreesDir (not a linked worktree)" and
"reclaimWorktree reports false when a worktree has nothing ignored to clean";
`test/reclaim-guards.test.ts` — "reclaimWorktree refuses a worktree in use, deleting nothing, and
cleans it once the use ends".

### INV-AW2: candidates come least recently used first, and the unsafe ones are left out

**Guarantee.** Candidates are ordered least recently used first, with resume-pending roles last.
Reserved mirrors and in-use worktrees are left out. A never-seen worktree is seeded as used now and
skipped for this pass, and the dry-run listing never seeds.

**Binds.** `src/team/reclaim.ts` (`reclaimCandidates`, `inspectReclaimCandidates`).

**Pinned by.** `test/reclaim.test.ts` — "reclaimCandidates seeds unknown worktrees as used and
excludes them from the pass", "a non-finite registry timestamp reads as never seen, not as used
forever", "reclaimCandidates orders least-recently-used first, resume-pending last, and skips
reserved and in-use", "inspectReclaimCandidates lists idle age and ignored-path count without
cleaning" and "inspectReclaimCandidates never seeds the use registry".

### INV-AW3: a pass stops at the floor and logs one event with freed space clamped at zero

**Guarantee.** A pressure pass stops once free space reaches the floor. An idle pass cleans only
expired candidates. A guard failure skips that one candidate. A pass logs one `disk_reclaim`, and
only when it cleaned something, with freed space as after minus before, clamped at zero. An
unwritable event feed does not lose the result.

**Binds.** `src/team/reclaim.ts` (`reclaimPass`, `isIdleExpired`).

**Pinned by.** `test/reclaim.test.ts` — "reclaimPass cleans least-recently-used first and stops
once the sampler reaches diskReclaimGB", "reclaimPass returns null and logs nothing when there is
nothing to clean", "reclaimPass still returns its result when the events feed is unwritable",
"reclaimPass idle mode cleans only worktrees unused past the threshold", "reclaimPass idle mode
with idleHours 0 cleans nothing" and "reclaimPass continues past a guard-failing candidate and one
with nothing to clean"; `test/reclaim-guards.test.ts` — "reclaimPass reports freed space as after
minus before, clamped at zero when another writer consumed it".

### INV-AW4: the controller starts one pressure pass per drop and arms idle passes at most hourly

**Guarantee.** The controller starts one pressure pass per drop and then lets the disk hold
engage, arms idle passes at most hourly, and runs a manual request over every candidate.

**Binds.** `src/team/reclaim.ts` (`ReclaimController`).

**Pinned by.** `test/reclaim.test.ts` — "ReclaimController runs one pass per drop, then lets the
disk hold engage", "ReclaimController.pollIdle cleans once, throttles the next arm, and honors
reclaimedAt" and "ReclaimController.requestManual runs a manual pass over every candidate".

## False-fix gate: an md-only fix claim names only code the tree holds, wherever the Fixed entry lives

`src/verdict/fix-claim.ts` is the check on a diff that touches only Markdown and moves a bug to
Fixed. A real claim usually arrives as a BUGS-FIXED.md edit, because the archive move happens right
before the commit.

### INV-AX1: a Fixed entry the diff writes or rewrites names only code the tree holds

**Guarantee.** A new Fixed entry, or an already-Fixed entry whose body the diff rewrites (including
text after a quoted fence), is rejected when a name in any of its Fix paragraphs is on neither the
code haystack nor the tree. An untouched entry is not checked. This holds for an edit to BUGS.md
and for an edit to BUGS-FIXED.md, measured against the diff's merge-base.

**Binds.** `src/verdict/fix-claim.ts` (`falseFixReason`, `fixSymbols`, `unbackedSymbols`).

**Pinned by.** `test/fix-claim.test.ts` — "falseFixReason flags a new Fixed entry whose Fix names
nothing on the tree", "falseFixReason flags a later Fix paragraph in a Fixed body, not only the
first", "falseFixReason checks an already-Fixed entry whose narrative the diff rewrites",
"falseFixReason leaves an already-Fixed entry with an untouched body alone", "falseFixReason
measures an Open→Fixed restoration against the merge-base, not main's tip" and "falseFixReason
checks a Fixed entry whose narrative after its quoted fence the diff rewrites";
`test/fix-claim-archive.test.ts` — "falseFixReason checks a fix claim that reaches the gate as a
BUGS-FIXED.md edit, and leaves an untouched archive entry alone".

### INV-AX2: a one-line record carries forward only names the base already holds

**Guarantee.** A one-line record may carry forward any name the base's Fixed section holds. A name
it introduces must exist on the tree, and a compression that makes a different entry last passes.

**Binds.** `src/verdict/fix-claim.ts` (`fixedSection`, `isOneLineRecord`).

**Pinned by.** `test/fix-claim.test.ts` — "fixedSection ends an entry's own body at its first
one-line record", "isOneLineRecord matches the compressed record forms and never a body bullet",
"falseFixReason passes a compression that makes a different full entry last", "falseFixReason lets
an edited record carry a name the base's Fixed section already holds" and "falseFixReason flags a
new one-line record that introduces a name the tree lacks".

### INV-AX3: the code haystack covers source in any language and fails open

**Guarantee.** The code haystack covers src/, test/ and scripts/ in any language, skips
node_modules and dist trees, excludes Markdown, and tolerates unreadable files. A deleted BUGS.md
passes this check and leaves the report to the structure check.

**Binds.** `src/verdict/fix-claim.ts` (`sourceHaystack`).

**Pinned by.** `test/fix-claim.test.ts` — "sourceHaystack covers code but excludes markdown (the bug
entry names its own symbols)", "sourceHaystack walks nested subdirectories — a symbol defined under
src/ui backs a claim", "sourceHaystack skips node_modules and dist trees at any depth but keeps
other subdirs", "sourceHaystack tolerates unreadable files and stays usable", "sourceHaystack reads
non-JS source, so a Rust symbol backs a claim", "sourceHaystack still excludes markdown living under
the walked source dirs", "falseFixReason passes an md-only Fixed edit in a non-JS (Rust) project"
and "falseFixReason tolerates a deleted BUGS.md instead of throwing out of the gate".

### INV-AX4: the doctor reads Fixed entries BUGS.md first, then BUGS-FIXED.md

**Guarantee.** `fixedEntriesAt` lists BUGS.md's Fixed entries (from the `bugsMd` text when given),
then BUGS-FIXED.md's, and reads a missing file as empty.

**Binds.** `src/verdict/fix-claim.ts` (`fixedEntriesAt`).

**Pinned by.** `test/fix-claim-archive.test.ts` — "fixedEntriesAt lists BUGS.md's Fixed entries
before BUGS-FIXED.md's, reads the bugsMd text when given, and reads a missing file as empty".

## Backlog conflicts: a backlog rebase conflict settles without a model only when no authored bytes need judgment

`src/merge/backlog-conflicts.ts` settles backlog rebase conflicts without a model run in two
passes: `resolveInsertOnlyText` hunk by hunk, then `mergeBacklogEntries` entry by entry.

### INV-AY1: a hunk settles only in its insert-only shapes

**Guarantee.** A hunk settles only in its three insert-only shapes. Any other hunk, a malformed
conflict, or a non-diff3 conflict leaves the file to the resolver.

**Binds.** `src/merge/backlog-conflicts.ts` (`resolveInsertOnlyText`).

**Pinned by.** `test/backlog-conflicts.test.ts` — "resolveInsertOnlyText refuses a hunk with a
non-empty base section", "resolveInsertOnlyText refuses a hunk with an empty side",
"resolveInsertOnlyText leaves near misses of an entry above a deleted entry to the resolver" and
"resolveInsertOnlyText refuses a malformed (non-diff3) conflict".

### INV-AY2: the entry merge keeps each side's changes and returns null when judgment is needed

**Guarantee.** The entry-by-entry merge keeps each side's finished and added entries and places an
added entry after its nearest surviving predecessor. It returns null for an entry both sides
edited, an edit against a delete, a duplicate heading, a renamed section, an unclosed fence, and
a preamble or section header both sides changed.

**Binds.** `src/merge/backlog-conflicts.ts` (`mergeBacklogEntries`).

**Pinned by.** `test/backlog-conflicts.test.ts` — "mergeBacklogEntries merges entries each side
finished or added", "mergeBacklogEntries bails out when judgment is needed" and
"mergeBacklogEntries keeps a heading inside a fence as body text";
`test/backlog-conflicts-entries.test.ts` — "mergeBacklogEntries places the change's new entry
after its nearest surviving predecessor, keeps one copy of an entry both sides added, and settles
a preamble or header only one side changed".

### INV-AY3: only settled repo-root backlog files are written; the rest stay conflicted

**Guarantee.** A settled file is written atomically and staged. An unreadable file, a non-backlog
file, or an archive file the hunk settler cannot settle is returned as still conflicted with its
markers kept.

**Binds.** `src/merge/backlog-conflicts.ts` (`resolveBacklogInsertConflicts`,
`mergeStagedEntries`).

**Pinned by.** `test/backlog-conflicts.test.ts` — "resolveBacklogInsertConflicts rewrites and
stages an insert-only PLANS.md", "resolveBacklogInsertConflicts leaves a non-insert-only backlog
file untouched", "resolveBacklogInsertConflicts ignores non-backlog and non-root files",
"resolveBacklogInsertConflicts treats an unreadable path as still conflicted" and
"resolveBacklogInsertConflicts leaves the conflicted file intact when a write dies mid-way";
`test/backlog-conflicts-entries.test.ts` — "resolveBacklogInsertConflicts leaves an archive
conflict the hunk settler cannot settle to the resolver".

## Red-main healer: a red main pages once per SHA and queues bugfix once per failing set

### INV-AZ1: `main_red_hold` logs at most once per red SHA per process

**Guarantee.** Whichever of `mainRedGate`, `bugfixMainRedNote` or `mainTipVerdict` sees a red SHA
first logs the `main_red_hold` event; the others stay silent for that SHA.

**Binds.** `src/baseline/main-red.ts` (`warnMainRedOnce`).

**Pinned by.** `test/main-red.test.ts` — "mainRedGate warns once per red SHA: a repeat run on the
same HEAD re-blocks silently" and "mainTipVerdict reports red with the team-wide warning, once per
SHA".

### INV-AZ2: a heal prompt is queued once per failing set, and again after green

**Guarantee.** bugfix is queued one heal prompt per failing set, keyed order-blind (by the SHA when
the red names no complete set). A green main clears the key, so a set that returns is healed again.
A red that bugfix found itself queues nothing.

**Binds.** `src/baseline/main-red.ts` (`warnMainRedOnce`, `mainRedGate`, `bugfixMainRedNote`).

**Pinned by.** `test/main-red.test.ts` — "mainRedGate lets a role run on a red main that names its
failing tests, once per failing set", "bugfix's own red-main note queues nothing and still returns
the note and warning" and "green main and a non-blocked role leave bugfix's inbox empty";
`test/main-red-heal.test.ts` — "a failing set queues one heal prompt in any order, and queues
another after main turns green".

### INV-AZ3: the heal prompt is one self-limiting line, with clauses only when it has them

**Guarantee.** A culprit prompt names the culprit's short SHA and adds the failing-tests and
output-tail clauses only when it has them.

**Binds.** `src/baseline/main-red.ts` (`mainRedHealPrompt`, `queueCulpritHeal`).

**Pinned by.** `test/main-red.test.ts` — "mainRedHealPrompt returns one self-limiting line naming
the short SHA"; `test/main-revert.test.ts` — "a revert that conflicts leaves main alone and queues
the heal prompt naming the culprit"; `test/main-red-heal.test.ts` — "mainRedHealPrompt with a
culprit names it and adds the failing and tail clauses only when it has them".

## Maintenance allowance: maintenance merges stop at the rolling-day allowance, counted from the event log

`src/gates/maintenance-quota.ts` caps code-maintenance merges in a rolling 24 h window:
`maintenanceQuota` is the pure verdict, `pollMaintenanceQuotaGate` adds the roles in flight and
logs transitions, and `countMaintenanceWindow` counts `merged` events from the events log.

### INV-BA1: the allowance is the floor plus a share of work merges, and in-flight maintenance roles spend it

**Guarantee.** The allowance is `maintenancePerWorkMerge × work merges + MAINTENANCE_DAILY_FLOOR`
over the trailing 24 h, and the gate holds while merged maintenance plus enabled maintenance roles
in flight reach it. Disabled roles and work roles add nothing to the in-flight figure.

**Binds.** `src/gates/maintenance-quota.ts` (`maintenanceQuota`, `pollMaintenanceQuotaGate`).

**Pinned by.** `test/maintenance-quota.test.ts` — "maintenanceQuota computes the allowance, used,
and held verdict", "the floor keeps the allowance at 12 when no work merged", "a run in progress
and a queued merge both count as in flight toward the used figure"; `test/maintenance-quota-gate.test.ts`
— "the in-flight figure skips disabled and work roles, and a legacy dry merge counts as maintenance".

### INV-BA2: the window counts merges by tier and a vanished log never drops them

**Guarantee.** The window counts `merged` events by tier (legacy ids under their canonical role),
folds only appended complete lines, reseeds after rotation, and a missing, vanished or non-file log
never throws and never drops counted merges.

**Binds.** `src/gates/maintenance-quota.ts` (`countMaintenanceWindow`).

**Pinned by.** `test/maintenance-quota.test.ts` — "countMaintenanceWindow counts merged events by
tier inside the last 24 h", "a rotated log is reseeded from the live file and its archive, not
folded from the old offset", "a torn trailing merged line is counted once, not again when its
newline arrives", "a missing events log counts zero and seeds an empty memo";
`test/maintenance-quota-gate.test.ts` — "a vanished or replaced events log keeps the window's
counted merges and does not throw".

### INV-BA3: the gate logs one hold per transition and the scheduler spends headroom one role at a time

**Guarantee.** The gate logs one `maintenance_quota_hold` per open-to-held transition and one
`maintenance_quota_resumed` per re-open, and the scheduler starts at most one due maintenance role
per poll while headroom remains.

**Binds.** `src/gates/maintenance-quota.ts` (`pollMaintenanceQuotaGate`).

**Pinned by.** `test/maintenance-quota.test.ts` — "pollMaintenanceQuotaGate computes the allowance
verdict and logs one hold per transition"; `test/orchestrator-scheduling.test.ts` — "the
allowance's in-flight headroom starts at most one of two due maintenance roles per poll".

## Commit messages: the harness's stamps and trailers read back only in their exact stamped form

`src/git/commit-message.ts` builds every run commit message, and the harness reads it back later:
leftover recovery calls `parseCommitMetadata`, `recordRevertedChange` calls `revisionRoundOf`, and
`revertFollowUp` calls `stampedRole`.

### INV-BB1: a run commit is the stamped subject, the body, then the trailer, each its own paragraph

**Guarantee.** A run commit is the stamped subject, then the WHY/RISK/VERIFIED body when present,
then the harness trailer, with each part a separate paragraph. The trailer's Model line comes right
after Run, and Revision comes last.

**Binds.** `src/git/commit-message.ts` (`buildCommitMessage`, `commitTrailer`, `stampedSubject`).

**Pinned by.** `test/commit-message.test.ts` — "buildCommitMessage assembles subject, body, and
trailer as separate paragraphs", "commitTrailer appends a sibling Friction line only when flagged
high-friction" and "commitTrailer puts the Model line right after Run, with Revision last".

### INV-BB2: the Friction and Revision trailers count only as whole lines

**Guarantee.** The Friction and Revision trailers count only as whole lines, so prose in a body
cannot flag friction or claim a round. Leftover recovery gets the round back from the trailer.

**Binds.** `src/git/commit-message.ts` (`hasFrictionTrailer`, `revisionRoundOf`,
`parseCommitMetadata`).

**Pinned by.** `test/commit-message.test.ts` — "hasFrictionTrailer matches only the
harness-stamped Friction line"; `test/revision.test.ts` — "leftover recovery rebuilds a revision's
round from its commit trailer"; `test/commit-message-stamps.test.ts` — "revisionRoundOf reads only
a whole harness Revision line, and parseCommitMetadata carries it".

### INV-BB3: a subject is stamped only as `tumwater(<role>):` plus a space or the line's end

**Guarantee.** A subject counts as stamped only as `tumwater(<role>):` followed by a space or the
line's end. `stampedRole` and `commitSubject` read only the first line, and a hand-made subject
passes through whole.

**Binds.** `src/git/commit-message.ts` (`stampedRole`, `commitSubject`).

**Pinned by.** `test/commit-message.test.ts` — "commitSubject returns the message's first line with
the harness stamp stripped"; `test/operator-revert.test.ts` — "stampedRole reads the role of a
stamped subject only" and "revertFollowUp names a role, and is null when no role made the commit";
`test/commit-message-stamps.test.ts` — "the subject stamp needs a space or the line's end after its
colon, and stampedSubject round-trips through both readers".

## Quiet hours: a daily local-time window holds every role but the director, and only a well-formed window holds

`src/scheduling/quiet-hours.ts` owns the quiet-hours gate. The orchestrator polls it once per cycle
through `src/gates/gate-polls.ts` with the live `quietHours` value.

### INV-BC1: a window is `HH:MM-HH:MM` in local time, and the end is excluded

**Guarantee.** A window is `HH:MM-HH:MM` local time with one dash, hours 0-23 in one or two digits,
minutes in exactly two, and distinct ends. An absent, empty or whitespace value means off.
Membership is the half-open `[start, end)`, wrapping midnight when start is after end.

**Binds.** `src/scheduling/quiet-hours.ts` (`parseQuietHours`, `inQuietHours`).

**Pinned by.** `test/quiet-hours.test.ts` — "parseQuietHours: valid windows, empty means off,
absent means off", "parseQuietHours: malformed values fail with an actionable message",
"inQuietHours: same-day window boundaries — start in, end out" and "inQuietHours: wrapping window
spans midnight"; `test/quiet-hours-edges.test.ts` — "parseQuietHours takes one- or two-digit hours
but exactly two minute digits, and quietWindowEnd reads the end back as written".

### INV-BC2: the team gate logs one event per crossing, and an off or malformed value ends the hold

**Guarantee.** The team gate logs exactly one `quiet_hours_started` or `quiet_hours_ended` per
crossing, none while settled, and one on a restart mid-window. An off or malformed live value ends
the hold, and the event's `window` is the value only when it is a string. The director runs through
the window.

**Binds.** `src/scheduling/quiet-hours.ts` (`pollQuietHoursGate`, `newQuietHoursGateState`).

**Pinned by.** `test/quiet-hours.test.ts` — "pollQuietHoursGate: one started/ended event per
crossing, none while settled", "pollQuietHoursGate: unset window is silent, restart mid-window logs
one event" and "pollQuietHoursGate: a live edit from a window to off logs the ended crossing";
`test/orchestrator-quiet-hours.e2e.test.ts` — "quiet hours block role runs while the director runs;
emptying the window unblocks live"; `test/quiet-hours-edges.test.ts` — "pollQuietHoursGate reads a
malformed or non-string value as off, ending a held window with one event that carries only a
string window".

### INV-BC3: a per-role window holds only its role, and the dashboards advertise only a parsed window

**Guarantee.** A per-role window means what the same string means team-wide and holds only the
role it names, and an unparseable value never holds. The dashboards advertise a window only when it
parses, and read its end back as written.

**Binds.** `src/scheduling/quiet-hours.ts` (`roleQuietHold`, `quietHoursStatus`,
`quietWindowEnd`).

**Pinned by.** `test/quiet-hours.test.ts` — "roleQuietHold: the per-role window holds the role it
names and no other" and "quietHoursStatus: the window string plus the gate's own membership
predicate"; `test/quiet-hours-edges.test.ts` — "parseQuietHours takes one- or two-digit hours but
exactly two minute digits, and quietWindowEnd reads the end back as written".

## Disk hold: below the floor the team starts no new work, the hold lifts only clear of a 5 GB band, and an unmeasurable disk never holds

`src/gates/disk-gate.ts` owns the disk floor's hold. The orchestrator polls it once per cycle
through `pollTeamGates` in `src/gates/gate-polls.ts`.

### INV-BD1: free space is `bavail * bsize` on the worktrees volume, and null when statfs throws

**Guarantee.** Free space is `bavail * bsize` measured on the worktrees dir once it exists, else on
the root. It is null when statfs throws.

**Binds.** `src/gates/disk-gate.ts` (`diskVolumePath`, `sampleFreeBytes`).

**Pinned by.** `test/disk-gate.test.ts` — "sampleFreeBytes measures the worktrees volume once it
exists, else the root", "sampleFreeBytes returns null when statfs throws" and "pollDiskGate:
measured path detail is the worktrees dir when it exists".

### INV-BD2: the hold enters strictly below the floor, lifts clear of the band, and logs once per crossing

**Guarantee.** The hold enters strictly below `diskHoldGB` (GB = 10^9 bytes), and only once no
reclaim pass is running. It lifts at `diskHoldGB + DISK_HOLD_HYSTERESIS_GB` or when the floor is
edited to 0. Each crossing logs exactly one `disk_low` (with `freeGB`, `holdGB`) or `disk_ok` (with
`freeGB`).

**Binds.** `src/gates/disk-gate.ts` (`pollDiskGate`, `newDiskGateState`, `BYTES_PER_GB`,
`DISK_HOLD_HYSTERESIS_GB`).

**Pinned by.** `test/disk-gate.test.ts` — "pollDiskGate holds below the floor and one disk_low logs
per crossing", "pollDiskGate hysteresis: stays held until floor + 5, lifts with one disk_ok",
"pollDiskGate: diskHoldGB 0 disables the hold at any free space", "pollDiskGate: a live edit to
diskHoldGB 0 lifts an active hold on the next poll", "pollDiskGate: waitForReclaim defers entering
the hold until the pass settles" and "pollDiskGate: an unwritable events feed does not throw out of
the poll"; `test/disk-gate-edges.test.ts` — "pollDiskGate: the floor itself does not hold, a null
sample lifts an active hold, and the unmeasurable warning fires once per process";
`test/gate-polls.test.ts` — "pollTeamGates: a low disk holds new work; recovery and a live floor
edit lift it" and "pollTeamGates publishes the measured disk state for observers".

### INV-BD3: an unmeasurable sample never holds, lifts an active hold, and warns once per process

**Guarantee.** A null sample never holds and lifts an active hold. It logs one `warning` per
process, however the samples alternate with measurable ones.

**Binds.** `src/gates/disk-gate.ts` (`pollDiskGate`).

**Pinned by.** `test/disk-gate.test.ts` — "pollDiskGate: a null sample never holds and warns once
per process"; `test/disk-gate-edges.test.ts` — "pollDiskGate: the floor itself does not hold, a
null sample lifts an active hold, and the unmeasurable warning fires once per process".

## Backlog index: every role's prompt lists the actionable entries and the newest closed ones by line range, marked with the same holds the claim gate reads

`renderBacklogIndexBlock` in `src/backlog/backlog-index.ts` builds the `<backlog-index>` block that
`src/run/run-prompt.ts` puts in every role's prompt.

### INV-BE1: the actionable lines cover PLANS.md Planned, BUGS.md Open and QUESTIONS.md Open as `<start>-<end>: <title>`

**Guarantee.** The actionable lines cover PLANS.md `## Planned`, BUGS.md `## Open` and QUESTIONS.md
`## Open`, in that order. Each entry is `- <start>-<end>: <title>` with 1-based ranges, its stamp
stripped and its title clipped to 160 characters. An empty backlog gives no block, and a changed
file is re-read.

**Binds.** `src/backlog/backlog-index.ts` (`renderBacklogIndexBlock`, `INDEX_SECTIONS`,
`indexTitle`).

**Pinned by.** `test/backlog-structure.test.ts` — "renderBacklogIndexBlock lists actionable entries
with ranges and strips stamp suffixes", "renderBacklogIndexBlock re-reads a backlog file whose stat
changed" and "renderBacklogIndexBlock returns undefined when the actionable sections are empty";
`test/backlog-index-edges.test.ts` — "renderBacklogIndexBlock clips a long heading to 160
characters, in the actionable and the closed lines alike".

### INV-BE2: an entry carries its hold mark, and `[in flight by <role>]` while a live claim names it

**Guarantee.** An entry carries the hold mark `entryHoldAgainst`/`holdMark`
(`src/backlog/backlog-eligibility.ts`) give it, including a BUGS.md entry waiting on an unmerged
plan, and `[in flight by <role>]` while any role's live claim names it.

**Binds.** `src/backlog/backlog-index.ts` (`renderBacklogIndexBlock`);
`src/backlog/backlog-eligibility.ts` (`entryHoldAgainst`, `holdMark`).

**Pinned by.** `test/backlog-structure.test.ts` — "renderBacklogIndexBlock marks an entry carrying a
Needs-replan note", "renderBacklogIndexBlock marks a held entry as blocked, refused or needing
review", "renderBacklogIndexBlock blocks a BUGS.md entry whose prerequisite plan is unmerged",
"renderBacklogIndexBlock marks an entry another role has claimed as in flight" and
"renderBacklogIndexBlock marks an entry a parallel-work instance has claimed as in flight by that
instance".

### INV-BE3: only PLANS.md collapses a series' contiguous blocked parts into one line

**Guarantee.** Only PLANS.md collapses a series' contiguous blocked parts into one line. Refused or
claimed parts keep their own lines, and BUGS.md entries never collapse.

**Binds.** `src/backlog/backlog-structure.ts` (`groupBlockedSeries`); `src/backlog/backlog-index.ts`
(`collapseBlockedSeries`).

**Pinned by.** `test/backlog-structure.test.ts` — "renderBacklogIndexBlock collapses a multi-part
series' blocked parts to one line", "renderBacklogIndexBlock joins non-contiguous blocked parts into
separate ranges", "renderBacklogIndexBlock keeps a refused and a claimed blocked part out of the
collapsed line" and "renderBacklogIndexBlock does not collapse a BUGS.md entry blocked by a plan".

### INV-BE4: at most five closed entries per kind follow, newest first, live section before archive

**Guarantee.** After the actionable lines come at most five closed entries per kind, newest first:
first from the live section, then from its archive file. They carry no hold mark or claimer.

**Binds.** `src/backlog/backlog-index.ts` (`CLOSED_SECTIONS`, `RECENT_CLOSED_MAX`);
`src/backlog/backlog-md.ts` (`FINISHED_ARCHIVES`).

**Pinned by.** `test/backlog-structure.test.ts` — "renderBacklogIndexBlock lists the newest five Done
entries with stripped stamps", "renderBacklogIndexBlock lists Fixed entries after the QUESTIONS.md
Open lines" and "renderBacklogIndexBlock re-reads a Done section whose stat changed";
`test/backlog-index-edges.test.ts` — "renderBacklogIndexBlock takes the newest five closed entries
from the live section first, then its archive".

## Merge strikes: a merge that keeps failing is blamed on its change after two strikes of the same patch, and only a judged failure of a readable patch is a strike

`src/merge/merge-check-failures.ts` owns the strike store on `RunnerState.mergeCheckFailures`, keyed
by patch-id.

### INV-BF1: one patch's failures keep the pin under the limit and blame the change at it

**Guarantee.** One patch's red in-lock check, or its deterministic cross-check block, keeps the pin
(`merge_blocked`) under `MERGE_CHECK_FAILURE_LIMIT`. At the limit the failure is blamed on the
change: a red check through `attributeRedCheck`, a block through a rejection that names it, with the
pin deleted and the strike cleared.

**Binds.** `src/merge/merge-check-failures.ts` (`MERGE_CHECK_FAILURE_LIMIT`, `pinKept`,
`keepPinOrAttribute`, `mergeCheckRed`, `mergeBlocked`).

**Pinned by.** `test/merger.test.ts` — "a single merge's red in-lock check retries once, then
rejects on a green main", "a single merge's red in-lock check retries once, then keeps its pin as
main_red" and "a fix-claim-blocked merge retries once, then rejects with the block reason".

### INV-BF2: strikes are counted per patch-id

**Guarantee.** A pin whose patch-id cannot be read never stores a strike and is never blamed by
count. A stored strike on another patch does not add to the new one.

**Binds.** `src/merge/merge-check-failures.ts` (`tallyCheckFailure`).

**Pinned by.** `test/merge-check-strikes.test.ts` — "mergeBlocked keeps a pin whose patch-id cannot
be read on every attempt and stores no strike" and "mergeBlocked starts a new patch's count at one
when the stored strike belongs to another patch".

### INV-BF3: a red that judged nothing is not a strike

**Guarantee.** A red check that judged nothing (an unverified tree) is not a strike, and neither is
a red that fails only main's known failures. Both keep the pin.

**Binds.** `src/merge/merge-check-failures.ts` (`attributeRedCheck`).

**Pinned by.** `test/merger.test.ts` — "an unverified red in-lock check — the run timed out — keeps
the pin without a strike"; `test/attribute-red-check.test.ts` — "attributeRedCheck keeps the ref and
records no strike for an unverified red" and "attributeRedCheck keeps the ref, with no strike, for a
red that fails only main's known failures".

### INV-BF4: a first strike warns, and a passing retry is a flake only for the same pin

**Guarantee.** A red merge check's first strike logs a warning naming the failing test. A retry that
then passes logs a `MERGE_FLAKY_WARNING_PREFIX` flake, but only when the stored strike's patch-id is
the merged pin's. `attributeRedCheck` excuses a known-flaky headline once per headline per pin.

**Binds.** `src/merge/merge-check-failures.ts` (`noteMergeRetryPassed`, `attributeRedCheck`),
`RunnerState.mergeFlakeExcused`.

**Pinned by.** `test/merger.test.ts` — "a kept-for-re-merge red merge check logs a warning naming
the failing test", "a red merge check that passes on its kept-pin retry logs a merge-check flake
warning" and "a stale red strike of another pin is not recorded as a flake when a different pin
merges"; `test/attribute-red-check.test.ts` — "attributeRedCheck keeps the ref once for a
known-flake red, then attributes a repeat".

## Team hold: two roles failing alike on one provider hold that provider, and the hold re-opens by itself

`teamHold` in `src/team/team-hold.ts` steps one provider's `TeamHold` per poll from the recent
backend-failure observations; `heldProviders`, `standingHolds` and `windowHeldProviders` read the map.

### INV-BG1: a hold trips only when two distinct roles failed alike on one provider within the window

**Guarantee.** A hold trips only when `HOLD_STORM_ROLES` distinct roles failed on the same provider
and kind within `HOLD_STORM_WINDOW_MS` (the edge counts). One role never trips it, and different
kinds or providers never add up. When two groups qualify in one poll, the first one seen wins.

**Binds.** `src/team/team-hold.ts` (`teamHold`, `HOLD_STORM_WINDOW_MS`).

**Pinned by.** `test/team-hold.test.ts` — "one role's 429s never trip the hold — the per-run retry
already answers them", "two distinct roles' 429s within the window trip a base hold naming them",
"429s further apart than the storm window do not add up" and "failures of different kinds are
different incidents: neither storms alone"; `test/team-polls.test.ts` — "pollTeamHold separates the
same kind at different providers: no cross-provider storm"; `test/team-hold-edges.test.ts` — "when
two provider+kind groups both storm in one poll, the first one seen wins".

### INV-BG2: the hold lasts the longer of the escalated base and the furthest Retry-After, up to the cap

**Guarantee.** The hold lasts the longer of `HOLD_BASE_MS` doubled once per relapse and the
furthest Retry-After, measured from its own 429, and never more than `HOLD_CAP_MS`. A relapse is the
same provider and kind re-tripping within `HOLD_RELAPSE_MS` of the re-open; anything else starts at
the base.

**Binds.** `src/team/team-hold.ts` (`HOLD_BASE_MS`, `HOLD_RELAPSE_MS`, `HOLD_CAP_MS`).

**Pinned by.** `test/team-hold.test.ts` — "the hold honors the largest Retry-After seen, measured
from its own 429, and caps it", "backend failures of one kind trip the same hold, but carry no
Retry-After", "a storm that resumes right after re-open doubles the hold; one after a calm spell
starts fresh", "a relapse is per kind: the same kind escalates, a different kind starts at the base"
and "a storm that outlasts every re-open escalates to the cap and stays there".

### INV-BG3: a held provider re-opens by itself at its deadline, and a failure at the re-open never counts

**Guarantee.** A held provider stays held until its deadline and then re-opens by itself. No failure
stamped at or before the re-open counts toward the next storm. A lifted hold stays in the map as
relapse memory, but `heldProviders` does not read it as held.

**Binds.** `src/team/team-hold.ts` (`teamHold`, `heldProviders`).

**Pinned by.** `test/team-hold.test.ts` — "a held team stays held until its deadline, then
re-opens by itself"; `test/team-polls.test.ts` — "a lifted provider's hold stays in the map with its
relapse memory but stops reading as held"; `test/team-hold-edges.test.ts` — "a failure stamped at
the re-open poll never re-trips the hold; one a millisecond later does".

### INV-BG4: a rejected subscription window holds its provider until `resetsAt`, and only it holds the director

**Guarantee.** A rejected subscription window holds its provider until `resetsAt`, however many
roles failed, and a window with no future `resetsAt` holds nothing. A reserve hold is re-checked
every poll, and the director is held only by a rejected window (`windowHeldProviders`).
`standingHolds` lists neither lifted nor subscription-window holds.

**Binds.** `src/team/team-hold.ts` (`windowHeldProviders`, `standingHolds`).

**Pinned by.** `test/team-hold.test.ts` — "a rejected subscription window holds its provider until
resetsAt, whatever the role count", "a standing reserve hold is re-evaluated: a rejected window
replaces it, a vanished one drops it" and "standingHolds names each standing provider hold and skips
lifted and subscription-window ones"; `test/orchestrator-scheduling.test.ts` — "a subscription-window
hold stops the director too, while a 429-storm hold still exempts it"; `test/team-polls.test.ts` —
"a reserve crossing holds claude but not the director, and logs claude_window_reserved once per
window".

## Flake quarantine: a test that failed then passed on one tree is quarantined until its filed bug leaves ## Open, and a possibly truncated list never counts

### INV-BI1: a flake that passed on a re-run quarantines each failing test it names, and a failure naming only quarantined tests goes on without a re-run

**Guarantee.** A check that failed and then passed on the same tree quarantines each failing test
it names, at the gate's re-run, the in-lock merge check's re-run and main-watch's confirming
re-run. A test already listed counts another flake. A failure naming only quarantined tests goes
on without a re-run.

**Binds.** `src/review/known-flakes.ts` (`quarantineTests`, `onlyQuarantined`).

**Pinned by.** `test/known-flakes.test.ts` — "quarantine: a new test is added once, a repeat
counts, and only-quarantined needs every test listed"; `test/review-precheck.test.ts` — "a test
that fails then passes on the gate's re-run is quarantined; a later failure of only that test goes
on without a re-run"; `test/merger.test.ts` — "a red in-lock merge check whose immediate re-run
passes merges and quarantines the failing test"; `test/main-watch.test.ts` — "a red whose
confirming re-run passes quarantines the failing tests and files one BUGS.md entry on main" and "a
red naming only quarantined tests is recorded passed and starts no bisect".

### INV-BI2: an empty list, or one at `FAILING_TESTS_MAX`, is neither quarantined nor counted as only quarantined

**Guarantee.** A list that may have been cut short by the parser is never recorded and never
counts as only quarantined, even when every name in it is listed.

**Binds.** `src/review/known-flakes.ts` (`quarantineTests`, `onlyQuarantined`).

**Pinned by.** `test/known-flakes-quarantine.test.ts` — "quarantine: a failing list at the parser's
cap is neither quarantined nor counted as only quarantined".

### INV-BI3: the store keeps the `QUARANTINE_MAX` most recently seen tests and reads a malformed file as defaults

**Guarantee.** The store keeps the `QUARANTINE_MAX` most recently seen tests. A malformed file or
entry reads as no data or as defaults, never as a throw.

**Binds.** `src/review/known-flakes.ts` (`loadQuarantine`, `QUARANTINE_MAX`).

**Pinned by.** `test/known-flakes-quarantine.test.ts` — "quarantine: the store keeps the most
recently seen tests, reads malformed entries as defaults, and counts a name once per call".

### INV-BI4: a test leaves quarantine only once its filed bug is no longer under `## Open`

**Guarantee.** A test leaves quarantine only once it has a filed BUGS.md heading and that heading
is no longer under `## Open`. An unfiled test, or any test while BUGS.md is missing, stays.

**Binds.** `src/review/known-flakes.ts` (`markQuarantineFiled`, `releaseQuarantine`).

**Pinned by.** `test/known-flakes.test.ts` — "quarantine: a filed test leaves the list once its
entry is not under ## Open"; `test/main-watch.test.ts` — "moving a quarantined test's bug out of
## Open releases it"; `test/known-flakes-quarantine.test.ts` — "quarantine: a missing BUGS.md
releases nothing, even a filed test".

## Review verdict and revision finality: a reply without a verdict never approves, and a rejected change revises until one objection survives two revisions or the backstop

### INV-BH1: a reply with no verdict line is no verdict, and the last verdict line wins

**Guarantee.** A reply with no VERDICT line at line start is no verdict, and the gate fails closed
on it, never approving. When a reply carries several verdict lines, the last one wins.

**Binds.** `src/review/review-verdict.ts` (`parseVerdict`).

**Pinned by.** `test/review-verdict.test.ts` — "parseVerdict returns null when no verdict line
exists", "parseVerdict ignores a VERDICT mention that is not at line start" and "parseVerdict reads
the verdict from the LAST verdict line"; `test/review.test.ts` — "gate fails closed on a
verdict-less reply: commit kept for re-review".

### INV-BH2: reasons are capped and clipped, and only a leading resolution is dropped

**Guarantee.** At most `MAX_REASONS` reasons are recorded, each clipped to the shared per-line cap.
A rejection drops only leading lines that state prior objections resolved and carry no outstanding
signal.

**Binds.** `src/review/review-verdict.ts` (`parseVerdict`, `MAX_REASONS`).

**Pinned by.** `test/review-verdict.test.ts` — "parseVerdict caps recorded reasons at ten",
"parseVerdict clips an over-long reason to the shared per-line cap", "a leading prior-objection
resolution is not recorded as a rejection's first reason" and "a line mixing a resolution with an
open objection is kept whole".

### INV-BH3: a repeat tag is exactly a leading `(prior N)` with N of at least one

**Guarantee.** A repeat tag is a leading `(prior N)`, case-insensitive, with integer N of at least
1. Anything else is an untagged reason.

**Binds.** `src/review/review-verdict.ts` (`priorObjectionNumber`).

**Pinned by.** `test/revision-prior-tags.test.ts` — "priorObjectionNumber reads only a leading
(prior N) tag with N of at least one".

### INV-BH4: a rejection is final when one objection survives two revisions or the round hits the backstop

**Guarantee.** An untagged reason counts 0. A tagged one counts 1 plus the prior round's count for
objection N, taking that count as 0 when the prior list has no entry N. The rejection is final,
with the ref deleted and `exhausted` set, when any count reaches `REVISION_FINAL_ON_REPEAT` or the
round reaches `REVISION_BACKSTOP`. Otherwise the ref points at the judged head and the round
advances. The director never revises.

**Binds.** `src/merge/merge-core.ts` (`recordRejectedChange`); `src/runner/revision.ts`
(`REVISION_FINAL_ON_REPEAT`, `REVISION_BACKSTOP`).

**Pinned by.** `test/revision.test.ts` — "a gate rejection points the rejected ref at the judged
head and records round 1", "a rejection whose objection has survived two revisions is final and
deletes the rejected ref", "a converging chain whose revisions raise only new objections keeps
revising", "a chain whose objections never repeat ends at the backstop" and "the director never
gets a revision: a rejection leaves no revision state"; `test/revision-prior-tags.test.ts` — "a
(prior N) tag beyond the prior list, or with no prior list, counts one revision and is not final".

## Batch merge: a stack merges as one fast-forward on its own check, and only a full check that passed on exactly the merged tip seeds main's baseline

`mergeStack` in `src/merge/merge-stack.ts` cherry-picks a batch of approved changes onto main's tip,
checks the combined tree once, and fast-forwards main through the captured shas (`ffStackToMain`).

### INV-BJ1: one batch check covers the whole stack, and a green stack fast-forwards main once

**Guarantee.** One scope-`batch` check covers the whole stack. A green stack fast-forwards main once
through the captured shas, logs one `merged` event per change, and deletes each change's merge ref.

**Binds.** `src/merge/merge-stack.ts` (`mergeStack`, `ffStackToMain`).

**Pinned by.** `test/merger-bisect.test.ts` — "a stack whose every change passes still takes exactly
one batch check"; `test/merge-stack.test.ts` — "ffStackToMain fast-forwards main through the whole
stack in one ff with per-change events".

### INV-BJ2: a fast-forward lost to a moved main re-stacks a bounded number of times, and a lost race merges nothing

**Guarantee.** A fast-forward lost to a moved main re-stacks on the new tip, up to
`BATCH_RESTACK_ATTEMPTS` times. A re-stack whose tree adds only review-exempt changes to the checked
tree skips its re-check. A race lost on every attempt, a primary checkout dirty in the stack's
files, and a stop before an attempt all keep every ref and merge nothing.

**Binds.** `src/merge/merge-stack.ts` (`mergeStack`, `BATCH_RESTACK_ATTEMPTS`).

**Pinned by.** `test/merger-restack.test.ts` — "a fast-forward lost to a doc-only commit re-stacks
without a second batch check", "a batch that loses the fast-forward race on every attempt keeps
every ref as merge_blocked", "an abort between re-stack attempts stops the batch: aborted, refs
kept, nothing merges" and "a batch whose files are dirty in the primary checkout is blocked before
its check"; `test/merge-stack.test.ts` — "ffStackToMain returns merge_blocked when main diverged
under the stack, with no events".

### INV-BJ3: a stack whose whole delta is review-exempt runs no check, but not no cross-check

**Guarantee.** A stack whose whole delta is review-exempt runs no check, but runs the same
cross-checks as `verifyMerge`'s exempt arm. If either fails, the stack goes to the one-at-a-time
fallback.

**Binds.** `src/merge/merge-stack.ts` (`mergeStack`).

**Pinned by.** `test/merger-bisect.test.ts` — "a stack whose every change is doc-only merges with no
batch check" and "a doc-only stack that breaks backlog structure is blocked, not waved through".

### INV-BJ4: only a full batch check that passed on exactly the merged tip seeds main's baseline

**Guarantee.** After a merge, `mergeStack` seeds the merged tip green only when the batch check's
status is `"passed"` and `check.mergeCommand` is unset. A doc-only stack (no check ran), a stack
whose failures are all main's known failures, and a `check.mergeCommand` green seed nothing, so the
main watch checks that tip itself.

**Binds.** `src/merge/merge-stack.ts` (`mergeStack`), `src/baseline/main-baseline.ts`
(`noteGreenBaseline`).

**Pinned by.** `test/merge-stack-seed.test.ts` — "a stack whose batch check passed seeds the merged
tip green", "a stack that fails only main's known failures merges but seeds nothing", "a doc-only
stack runs no check and seeds nothing" and "a stack merged on check.mergeCommand runs it as a
non-full batch check and seeds nothing".

## Staging self-check: each git-level finding stops at its cap, and a check that cannot run adds nothing

### INV-BK1: a finding names at most ten paths, files or hits, and a change emits at most ten stale-reference findings

**Guarantee.** A missing-path or lost-final-newline finding names at most 10 paths or files and
counts the rest as ` (+N more)`. A stale-reference finding lists at most 10 `file:line` hits. A
change emits at most 10 stale-reference findings, however many referenced paths it deletes.

**Binds.** `src/run/stage-path-checks.ts` (`gitLevelFindings`, `cappedList`, `MAX_MISSING_PATHS`,
`MAX_NEWLINE_FILES`, `MAX_STALE_PATHS`, `MAX_STALE_HITS`).

**Pinned by.** `test/stage-path-caps.test.ts` — "a missing-path finding names the first ten paths
and counts the rest", "a lost-final-newline finding names the first ten files and counts the
rest", "a change deleting more referenced paths than the cap reports only the cap's worth" and
"one stale reference lists at most ten of its hits".

### INV-BK2: the git-level checks are best-effort, and the index is restored

**Guarantee.** A failed git command adds no finding and does not throw.
`gitLevelFindings` resets the index to HEAD in `finally`, so the run's change detection still sees
the worktree.

**Binds.** `src/run/stage-path-checks.ts` (`gitLevelFindings`); `src/run/stage-check.ts`
(`stageCheckFindings`, its `.catch(() => [])`).

**Pinned by.** `test/stage-check.test.ts` — "a git failure yields no findings instead of
throwing", "the git-level check leaves the index clean, so change detection still sees the
worktree" and "a clean change yields no findings".

## Run timing: a drain sample counts only a run's own work, and a restart's hand-off waits on every merge task for at most two windows

### INV-BL1: a run's drain sample is its own work

**Guarantee.** A run's drain sample is null when the run never started (the signal had already
aborted, or `held()` was true when the permit was granted), when it ended `aborted`/`user_aborted`,
or when it ended `no_change`/`skipped`. Otherwise it is the time from the permit grant to the end
of the run, and the permit is released on every path, including a throw. `p75RunDurationMs` is null
below `DRAIN_P75_MIN_SAMPLES` (10) samples.

**Binds.** `src/run/run-timing.ts` (`runTimedRoleRun`, `p75RunDurationMs`).

**Pinned by.** `test/orchestrator.e2e.test.ts` — "runTimedRoleRun measures the run, not its
semaphore queue wait" (the clock starts at the permit grant); `test/orchestrator-seams.test.ts` —
"runTimedRoleRun returns the run's
wall-clock duration measured by the now seam", "runTimedRoleRun skips an already-aborted run but
still releases its permit", "runTimedRoleRun returns null for an aborted run outcome so it cannot
drag the p75 window", "runTimedRoleRun returns null for a run that ended without work so the window
is not sized to re-checks", "runTimedRoleRun releases its permit when the run throws",
"p75RunDurationMs: null below the sample floor, then the p75 of the samples" and "a waiter parked
before a restart hold is turned away at its permit, which it hands on unused".

### INV-BL2: a restart's hand-off waits on every merge task for at most two windows

**Guarantee.** An operator stop waits for the runs and every merge task without a bound and never
aborts. A restart folds every merge task into one hand-off that names all of their roles. The
hand-off gets one window, then an abort, then one more window. After that it clears the merge
marker and hands off without waiting on the reserved runs.

**Binds.** `src/run/run-timing.ts` (`drainInFlightWork`, `awaitMergeForHandoff`,
`HANDOFF_MERGE_WINDOW_MS`).

**Pinned by.** `test/run-timing-edges.test.ts` — "a restart's hand-off waits for every merge task
and names all their roles"; `test/run-timing.test.ts` — "drainInFlightWork on an operator stop waits
out runs and merges, announcing the merge", "drainInFlightWork on a restart with a merge inside its
window waits out the runs too" and "drainInFlightWork hands off without a wedged merge and without
waiting on reserved runs"; `test/orchestrator-seams.test.ts` — "awaitMergeForHandoff announces the
wait and lets a merge that finishes in time complete", "awaitMergeForHandoff aborts a merge past its
window and waits for it to stop" and "awaitMergeForHandoff hands off without a merge still running
after the abort, clearing its marker".

## Git diff paths: a tree diff tells an unreadable answer from an empty one, lists both ends of a move, and decodes every name

### INV-BM1: a tree diff is null when git fails, `[]` when the trees match, and lists both ends of a move

**Guarantee.** `treeDiffFiles` returns null when git fails (an unknown commit) and `[]` for
identical trees. It passes `--no-renames`, so a file moved from `src/` to `docs/` lists both its
old and its new path. `exemptTreeDelta` treats null as not exempt, so an unreadable diff is never
review-exempt and a code-to-docs move never reads as a docs-only delta.

**Binds.** `src/git/git-diff.ts` (`treeDiffFiles`); `src/merge/merge-stack.ts`
(`exemptTreeDelta`).

**Pinned by.** `test/git-diff-paths.test.ts` — "treeDiffFiles is null for an unknown commit and
empty for identical trees" and "treeDiffFiles lists a moved file under both its old and its new
path".

### INV-BM2: path lists hold decoded real paths, and the ahead range is three-dot

**Guarantee.** `aheadOfMainFiles` and `treeDiffFiles` hand back decoded paths: `héllo.md` is not
`"h\303\251llo.md"`. `aheadOfMainFiles` diffs from the branch's fork point (three-dot), so files
only main gained are left out.

**Binds.** `src/git/git-diff.ts` (`aheadOfMainFiles`, `treeDiffFiles`, `unquotePorcelainPath`).

**Pinned by.** `test/git-diff-paths.test.ts` — "treeDiffFiles and aheadOfMainFiles decode a
non-ASCII name to its real path"; `test/git-diff.test.ts` — "aheadOfMainFiles omits files only
main gained after the branch forked (three-dot range)" and "unquotePorcelainPath keeps malformed
and unrecognized escapes as-is".

### INV-BM3: a capped `aheadOfMainDiff` stays within its budget on two git calls

**Guarantee.** An `aheadOfMainDiff` over `maxBytes` is a truncation note, then `--stat`, then the
largest files' whole sections while they fit, and it never exceeds `maxBytes`. It takes two git
calls, not one per file.

**Binds.** `src/git/git-diff.ts` (`aheadOfMainDiff`).

**Pinned by.** `test/git-diff.test.ts` — "aheadOfMainDiff over the cap keeps --stat plus the
largest files within budget" and "aheadOfMainDiff over the cap spawns only two git calls, not one
per file".

## Fallback chain reasons: a moved tier names why the step before it cannot run, in a fixed order

### INV-BN1: only a moved tier with a pair gets a chain entry, and its reason is read in a fixed order

**Guarantee.** Only a tier the poll moved, with a non-null pair, gets an entry in the `chain`
block. Its reason comes from the position just before the active step (the previous step, or the
primary at step 0), checked in this order: demoted, step-cap, window or reserve, overage, cap. A
prior step the breaker has demoted reads "demoted" even when its step cap is also spent. A prior
step whose own daily cap is spent (spend at or over the cap) reads "step-cap". "overage" needs a
prior Claude step that has extra usage, which is a Claude step after a Claude primary, on an
account that refuses overage; a pi primary's first Claude step reads "cap".

**Binds.** `src/gates/budget-gates.ts` (`chainInfo`, `fallbackServingPair`, `pairDailyCost`).

**Pinned by.** `test/budget-chain-info.test.ts` — "chainInfo names a demoted prior step, ahead of
its spent step cap", "chainInfo names a prior step whose own cap is spent as step-cap, back at
local midnight; under it the reason is cap", "chainInfo names overage only for an extra-usage
Claude step on an account that refuses it" and "chainInfo lists only moved tiers, and prices a step
only when it is priced".

### INV-BN2: a reason carries the time the position before it comes back, and a cap only for a priced capped step

**Guarantee.** `returnsAt` is the window's reset for "window" and "reserve", and the next local
midnight for "step-cap" and "cap". "demoted" and "overage" carry none. `spentUsd` and `capUsd`
appear only when the active step has its own cap and is priced.

**Binds.** `src/gates/budget-gates.ts` (`chainInfo`).

**Pinned by.** `test/budget-chain-info.test.ts` — "chainInfo names a prior step whose own cap is
spent as step-cap, back at local midnight; under it the reason is cap", "chainInfo tells a reserve
hold from a used-up window, both back at the window's reset" and "chainInfo lists only moved tiers,
and prices a step only when it is priced"; `test/budget-gates.test.ts` — "chain: a rejected window
puts the claude tier on its fallback step; under the cap with no window it is empty" and "chain: at
the cap a priced tier lists its fallback step, a free primary stays unlisted";
`test/gate-polls.test.ts` — "pollTeamGates: fallback_switched is logged once per chain change and
orchestrator info carries chain".

## Orchestrator info: a publish writes once for a changed batch and never for an unchanged one, a failed write warns rather than throws, and a reader drops a wrong-shaped field

### INV-BO1: a publish stages every field, writes once when any changed and not at all otherwise

**Guarantee.** A publish stages every field of the batch, compares each by JSON serialization, writes
once when any changed and not at all otherwise, and a field published as `undefined` leaves the file.

**Binds.** `src/team/orchestrator-info.ts` (`publishInfoFields`, `assignInfoFieldIfChanged`).

**Pinned by.** `test/orchestrator-info-publish.test.ts` — "publishInfoFields writes every field of a
changed batch in one publish", "publishInfoFields leaves the file untouched when no field changed"
and "publishInfoFields removes a field published as undefined".

### INV-BO2: a publish never throws, and startup's write stays strict

**Guarantee.** A publish never throws: a failed write logs one `warning`, keeps the new value in
memory, and is not retried until the value changes again. Startup's `writeOrchestratorInfo` stays
strict and atomic.

**Binds.** `src/team/orchestrator-info.ts` (`publishInfoFields`, `writeOrchestratorInfoBestEffort`,
`writeOrchestratorInfo`).

**Pinned by.** `test/orchestrator-info-publish.test.ts` — "publishInfoFields warns instead of throwing
when the info file cannot be written"; `test/orchestrator-info.test.ts` — "writeOrchestratorInfo
leaves the previous file intact when a write is killed mid-flight".

### INV-BO3: a reader drops a foreign-shaped field and keeps the well-formed ones

**Guarantee.** `readOrchestratorInfo` returns null for a missing, torn or non-object file, and drops
each nested field whose shape is foreign while it keeps well-formed ones; `orchestratorAlive` is
false with no info.

**Binds.** `src/team/orchestrator-info.ts` (`readOrchestratorInfo`, `normalizeInfoFields`,
`orchestratorAlive`).

**Pinned by.** `test/orchestrator-info.test.ts` — "readOrchestratorInfo returns null for missing,
torn, and non-object files", "readOrchestratorInfo drops nested fields with a foreign shape and keeps
well-formed ones", "readOrchestratorInfo round-trips a well-formed providerHolds and drops foreign
entries" and "orchestratorAlive is false with no info and reflects pid liveness otherwise";
`test/gate-polls.test.ts` — "pollTeamGates publishes the measured disk state for observers".

## Session ledger: a write or trim never throws, a reader skips what is not a record, and pi continues only into the newest line's own session

### INV-BP1: recording never throws, and reading skips what is not a whole record

**Guarantee.** `recordSession` never throws and repairs a torn previous line before it appends;
`readSessions` skips torn, malformed and incomplete lines.

**Binds.** `src/agent/session-ledger.ts` (`recordSession`, `readSessions`, `isSessionRecord`).

**Pinned by.** `test/session-ledger-prune.test.ts` — "recordSession into a path it cannot create
drops the record without throwing"; `test/session-ledger.test.ts` — "recordSession and readSessions
round-trip records, skipping malformed lines", "recordSession repairs a torn previous line so the
next record is not lost" and "readSessions skips a line that parses but is not a complete record".

### INV-BP2: a resume continues only into a session of its own kind, agent and cwd

**Guarantee.** An id-selecting resume takes the newest record of its own kind, agent and cwd; pi's
`--continue` needs a session file and, with a ledger, the newest line overall to be its own; the
ledger never counts as a session file.

**Binds.** `src/agent/session-ledger.ts` (`latestSession`, `resumableSession`, `sessionResumable`,
`hasResumableSession`).

**Pinned by.** `test/session-ledger-prune.test.ts` — "hasResumableSession counts a backend session
file but never the ledger itself"; the `latestSession`, `resumableSession` and `sessionResumable`
tests in `test/session-ledger.test.ts`.

### INV-BP3: the retention trim never throws and leaves what it cannot rewrite as it was

**Guarantee.** The retention trim drops lines past the window or without a numeric stamp, rewrites
only a ledger that changed, leaves an emptied ledger in place, and leaves a ledger it cannot rewrite
as it was, uncounted and without throwing. The OpenCode purge counts only deletes that exited 0, and
a missing or failing binary costs nothing but the count.

**Binds.** `src/agent/session-ledger.ts` (`pruneSessionLedgers`, `pruneOpencodeSessions`).

**Pinned by.** `test/session-ledger-prune.test.ts` — "pruneSessionLedgers leaves a ledger it cannot
rewrite as it was and counts nothing for it", "pruneSessionLedgers does not rewrite a ledger with
nothing past the window", "pruneSessionLedgers empties a fully stale ledger in place and ages out a
non-numeric stamp" and "pruneOpencodeSessions counts only deletes that succeeded and never throws";
`test/session-ledger.test.ts` — "pruneSessionLedgers drops lines past the window and keeps the recent
ones" and "pruneOpencodeSessions deletes expired opencode sessions and prunes old spill files".

## Session retention: the once-per-day gate, a re-prune on a window change, and a prune pass that never throws

### INV-BQ1: a prune is due for a positive window once a day, and startup prunes at once

**Guarantee.** A prune is due when the window is positive and a full day has passed since the last
prune or none has run; a window of 0 disables pruning; startup prunes at once.

**Binds.** `src/orchestrator/retention.ts` (`dueForPrune`, the `RetentionPruner` constructor).

**Pinned by.** `test/retention.test.ts` — "dueForPrune: the once-per-day gate with fake timestamps",
"RetentionPruner: construction runs the startup prune at a positive window" and "RetentionPruner:
retention 0 disables the startup prune".

### INV-BQ2: a window change re-prunes at once and logs one event per distinct value

**Guarantee.** A change in the live window logs one `retention_changed` per distinct value and
re-prunes at once, even inside the daily window.

**Binds.** `src/orchestrator/retention.ts` (`RetentionPruner.poll`).

**Pinned by.** `test/retention.test.ts` — "RetentionPruner: poll re-prunes immediately on a window
change and logs one event".

### INV-BQ3: the OpenCode purge reads a ledger before the file pass can age it out

**Guarantee.** The OpenCode session purge runs before the file pass, so an idle role's ledger is read
before its file ages out.

**Binds.** `src/orchestrator/retention.ts` (`RetentionPruner.prune`, order of its passes).

**Pinned by.** `test/retention.test.ts` — "RetentionPruner: an idle role's expired opencode session is
purged before its ledger ages out".

### INV-BQ4: a prune pass never throws

**Guarantee.** A prune pass never throws. An unwritable event feed costs only its warnings, and an
OpenCode DB directory that cannot be created costs only the OpenCode session deletes.

**Binds.** `src/orchestrator/retention.ts` (`RetentionPruner.prune`) and `warnEventBestEffort`.

**Pinned by.** `test/retention.test.ts` — "RetentionPruner: a window change and a prune survive an
unwritable events feed" and "RetentionPruner: an OpenCode DB dir that cannot be created skips the
session deletes and still prunes the rest".

## Runner state in the poll loop: a failed save costs only that save

### INV-BR1: a skip-reason or claim-release save that fails warns and the poll goes on

**Guarantee.** A skip-reason or claim-release save that fails logs one warning under the role's id,
and the poll goes on with the in-memory state; the next successful save writes it.

**Binds.** `src/runner/runner-state.ts` (`saveRunnerStateBestEffort`) and
`src/orchestrator/orchestrator-scheduling.ts` (`noteSkip`, `pollRunnerReasons`).

**Pinned by.** `test/orchestrator-scheduling.test.ts` — "a skip reason that cannot be saved warns and
leaves the poll running" and "a claim release that cannot be saved warns and leaves the poll running";
the saves still land when the disk is fine: "a released claim is saved to disk before the runner runs
again" and "a sibling held by an unclaimed mid-entry runner records claim-hold, cleared once admitted".

### INV-BR2: a main_red re-queue never throws

**Guarantee.** `requeueMainRedPin` never throws: a failed state save still re-queues the change, and a
failed queue write warns and leaves the kept pin to the role's leftover recovery.

**Binds.** `src/merge/merge-slot.ts` (`requeueMainRedPin`).

**Pinned by.** `test/merge-requeue.test.ts` — "a main_red re-queue whose state save fails still queues
the change", "a main_red re-queue whose queue write fails warns instead of throwing" and "a main_red
pin is re-queued once main's head moves, and not before".

## Pending reverts: a hand-back from reverted.json never throws and never hands a commit out twice

### INV-BS1: a torn reverted.json entry is dropped

**Guarantee.** A reverted.json entry that is not an object with a string commit, a string role and an
array of reasons is dropped, and the reasons keep only their strings.

**Binds.** `src/merge/merge-drain.ts` (`pendingReverts`).

**Pinned by.** `test/main-revert.test.ts` — "a torn reverted.json entry is dropped and the well-formed
one is still handed back".

### INV-BS2: assigning pending reverts never throws

**Guarantee.** `assignPendingReverts` never throws. A failed state save warns under the taker's id and
the entry still counts as assigned, and a failed rewrite warns under `tumwater`.

**Binds.** `src/merge/merge-drain.ts` (`handBackRevert`, `assignPendingReverts`).

**Pinned by.** `test/main-revert.test.ts` — "a hand-back whose state save fails warns and still counts
as assigned", "a failed reverted.json rewrite warns, and the next poll does not hand the commit out
twice" and "with no free runner the revision waits in reverted.json and is assigned once one frees".

### INV-BS3: a commit already handed back is never handed out again

**Guarantee.** A commit some runner's `lastReview` records as reverted is never handed out again.

**Binds.** `src/merge/merge-drain.ts` (`assignPendingReverts`).

**Pinned by.** `test/main-revert.test.ts` — "a failed reverted.json rewrite warns, and the next poll
does not hand the commit out twice".

## Post-merge reviews: post-review.json never throws out of the merge drain

### INV-BT1: a torn post-review.json entry is dropped

**Guarantee.** An entry that is not an object with a string commit, role and summary is dropped, as
is one whose `rejected` is not an array. The next write leaves it out.

**Binds.** `src/review/post-merge-review.ts` (`readPostReviews`).

**Pinned by.** `test/post-merge-review.test.ts` — "a torn post-review.json entry is dropped and the
well-formed one is still reviewed".

### INV-BT2: a failed post-review.json write warns and never throws

**Guarantee.** A failed post-review.json write warns under `tumwater` and never throws, so a
revert's settle still frees the merge slot and a skip check still logs its reason.

**Binds.** `src/review/post-merge-review.ts` (`writePostReviews`, `addPostReview`,
`settlePostReview`).

**Pinned by.** `test/post-merge-review.test.ts` — "a failed post-review.json write after a revert
warns and still frees the merge slot", "a failed post-review.json write in the revert skip check
still logs why it does not revert", and "a rejecting post-merge review reverts the commit and hands
it back as a revision" (on the healthy path the entry is still dropped).

## Image-probe cache: a foreign entry reads as unprobed

### INV-BU1: the probe cache reader returns only well-formed entries

**Guarantee.** `readImageProbeCache` returns only well-formed entries, so a missing, torn or foreign
cache file or entry never throws out of `snapshot`, `collectImageProbeFailures` or the doctor's probe
check, and a dropped entry reads as unprobed.

**Binds.** `src/doctor/image-probe.ts` (`readImageProbeCache`, `isImageProbeCacheEntry`).

**Pinned by.** `test/image-probe.test.ts` — "the probe cache drops a foreign entry and keeps the valid
ones" and "the probe cache round-trips and a verdict expires after the 7-day TTL" (a valid entry still
survives); `test/status-data-models.test.ts` — "a foreign entry in the probe cache leaves
collectImageProbeFailures and snapshot standing".

## QA flow coverage: a failed ledger write never fails a run

### INV-BW1: a failed qa-coverage.json write warns and the run keeps its outcome

**Guarantee.** A `recordFlow` write failure in `stageRunMerge` or `resolveRunVerdict` warns once and
the run keeps its `queued` or `no_change` outcome, so a full disk or read-only `.tumwater` does not
count toward the role's error streak.

**Binds.** `src/run/run-stage.ts` (`stageRunMerge`), `src/run/run-verdict.ts` (`resolveRunVerdict`),
`src/run/qa-coverage.ts` (`recordFlow`).

**Pinned by.** `test/run-stage.test.ts` — "a failed qa coverage write warns and the run still ends
queued" and "a qa flow record from the reply is written into the coverage file" (on the healthy path
the flow is still recorded); `test/run-verdict.test.ts` — "a failed qa coverage write warns and the
no_change run stands" and "a no_change run records its qa flow".

## OpenCode catalog cache: a foreign entry reads as an unknown model

### INV-BV1: readOpencodeCache returns only well-formed catalog entries

**Guarantee.** `readOpencodeCache` returns only well-formed catalog entries, so a missing, torn or
foreign cache file or entry never throws out of `pollBudgetGate`, `collectBudget` or
`observeOpencodeRun`, and a dropped entry reads as not free.

**Binds.** `src/agent/opencode/opencode-catalog.ts` (`readOpencodeCache`, `isOpencodeCatalogModel`).

**Pinned by.** `test/opencode-catalog.test.ts` — "readOpencodeCache drops a foreign catalog entry
and keeps the valid ones", "opencodeModelFree: free and unbilled is free; priced, unknown, or
billed are not" and "observeOpencodeRun demotes a cached free model on a priced run, once" (a valid
entry still round-trips); `test/status-budget.test.ts` — "a foreign entry in the opencode catalog
cache leaves collectBudget standing, read as not free".

## Merge write-back: a settled entry is always dropped

### INV-BX1: writeMergeOutcome drops the entry's queue file for every result

**Guarantee.** `writeMergeOutcome` drops the entry's queue file for every result, even when the role's
state save or the event write fails; each failure warns and nothing throws.

**Binds.** `src/merge/merge-slot.ts` (`writeMergeOutcome`), `src/runner/runner-state.ts`
(`saveRunnerStateBestEffort`).

**Pinned by.** `test/merge-slot.test.ts` — "a failed role-state save still logs the outcome and drops
the settled entry", "an unwritable events feed still drops the settled entry — the queue never
retries" and "a merge's nonzero usage rides its merge_done event and the entry is dropped".

## Run end: a failed state save still ends the run

### INV-BY1: a failed role-state save warns and the run still ends

**Guarantee.** `finalizeRun` resolves with the run's outcome and logs `run_end` even when the role's
state save or the events feed fails; a failed save warns under the role's id.

**Binds.** `src/run/run-finalize.ts` (`finalizeRun`); `src/runner/runner-state.ts`
(`saveRunnerStateBestEffort`).

**Pinned by.** `test/run-finalize.test.ts` — "a failed role-state save cannot reject finalizeRun — run_end still logs and the run warns", "an unwritable events feed cannot reject finalizeRun — the outcome still folds and saves" and "finalizeRun folds the outcome onto the state, persists it, and logs run_end".
