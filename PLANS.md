# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

_None yet._

## Done

### Per-role prompts 2/2 — surface the per-role queue on the dashboards (planned 2026-09-25, done 2026-09-25)

**Landed as (2026-09-25).** As planned, with two refinements: (1) the TUI's per-loop prompt key
is Ctrl+R rather than a `P` key — Ctrl+P is already the pause toggle in that same control row,
so the mnemonic went to p**R**ompt and the header hint names it (`Ctrl+R prompt`); the mode is
mutually exclusive with budget mode (each refuses to open while the other holds the shared
prompt line) and keeps its own saved-draft pair, so neither mode can clobber the other's draft.
(2) The snapshot shape is counts only (`roleInbox: Record<string, number>`, the director
excluded because its queue IS the shared `inbox`), so the GUI's queued-prompts section lists
role queues as `role: N queued` lines labeled with their role rather than full previews — full
text stays in the queue files, readable with `tumwater prompt --list --role <id>`. Everything
else as planned: `status --json` and `/api/status` carry `roleInbox` (src/ui/status.ts,
src/ui/status-payload.ts; the count is a directory listing per role — src/inbox.ts's
`queuedRolePromptCount`); the shared status table shows a `p:N` marker on a loop's state cell
(src/ui/status-render.ts, mirrored in gui-client.ts); the TUI's transcript view submits through
Ctrl+R → submitRolePrompt + single-role wake, the same path the CLI uses (src/ui/tui.ts, with
the pure parser in src/ui/tui-input.ts); the GUI's loop rows gain a `prompt` control opening
one shared addressed bar that POSTs `/api/prompt-role` — role validated exactly like
`/api/transcript` (the shared rejectBadRole wording), body discipline of `/api/prompt`
(readJsonObject → 400 malformed/non-object, 413 oversized, text a non-empty string within the
shared length rule) — and the director's prompt box and inbox display are untouched
(src/ui/gui-endpoints.ts, src/ui/gui.ts, src/ui/gui-page.ts, src/ui/gui-client.ts).
Acceptance criteria: (a) pinned in test/status.test.ts (snapshot) and test/gui-operator.test.ts
(statusPayload); (b) pinned in test/tui.test.ts (queue content + wake marker + draft restore);
(c) pinned in test/gui-server.test.ts (413 + healthy) and test/gui-operator.test.ts (queue
landing, transcript-error parity, bad bodies, and the row's prompt affordance driving the bar);
(d) the pre-existing director tests pass unchanged; (e) full suite 1831/1831.

**Goal.** Sub-plan 1/2 gives the CLI a per-role prompt queue (`tumwater prompt --role <id>`);
this plan makes it visible and usable from the GUI and TUI, so steering one loop does not require
a terminal.

**Approach.**

1. **src/ui/status.ts** `snapshot` — alongside the director's `inbox`/`inboxPrompts`, add a
   per-role count (`roleInbox: Record<string, number>`) filled from `queuedRolePrompts` (1/2);
   **src/ui/status-render.ts**/**src/ui/tui.ts** — a loop row with queued prompts shows a small
   `p:N` marker next to its state, and the TUI's per-loop controls (pause/wake/abort row) gain a
   `P` key that prompts for text and submits for the viewed loop.
2. **src/ui/gui-endpoints.ts** — `POST /api/prompt-role` `{ role, text }`, reusing the body
   discipline of `POST /api/prompt` (readJsonObject → 400 malformed, 413 oversized, role validated
   like `/api/transcript`) and calling the same submit path the CLI uses (enqueue + single-role
   wake). **src/ui/gui-page.ts**/**src/ui/gui-client.ts** — a per-row prompt affordance on the
   loop table; the queued prompts section lists role prompts labeled with their role.

**Files touched:** src/ui/status.ts, src/ui/status-render.ts, src/ui/tui.ts, src/ui/tui-input.ts,
src/ui/gui-endpoints.ts, src/ui/gui-page.ts, src/ui/gui-client.ts; tests in
test/gui-server.test.ts, test/gui-operator.test.ts, test/tui-adjacent suites.

**Acceptance criteria.** (a) `status --json` exposes `roleInbox` counts matching the on-disk
queues. (b) The TUI can submit a prompt to the currently viewed loop, and it appears in that
loop's queue (verifiable with `tumwater prompt --list`). (c) The GUI's per-row prompt posts to
`/api/prompt-role`, a malformed or oversized body reads 400/413, and an unknown role reads the
same error text as `/api/transcript`. (d) The director's own prompt box and inbox display are
unchanged. (e) Full suite passes.

### Timed pause — `tumwater pause [--role <id>] --for <duration>` auto-resumes (planned 2026-09-25)

**Goal.** Today's pause is indefinite: the marker (`.tumwater/state/paused.json`, `{ at }`) or a
paused role (`.tumwater/state/paused-roles.json`, `{ roles, at }`) stands until a manual `resume`
lifts it, so an operator quieting the fleet for a meeting or a manual repo session must remember
to come back — forget, and the fleet idles forever with nothing on the dashboards saying why.
Add a duration: `tumwater pause --for 30m` (fleet) or `tumwater pause --role cleanup --for 2h`
pauses until the deadline, then the existing pause machinery releases it by itself.

**Approach.** One shared deadline per marker — the marker already carries one `at`; it gains one
optional `until` (ms epoch) covering the whole set. Per-role deadlines would need a map plus
per-role transition logic for no observed need; pausing three roles at three times is three
commands, the last write winning with its own deadline.

1. **src/cli-args.ts** — `parseDurationFlag(flag, raw)`, shaped like `parseCountFlag`: accepts
   `<n><s|m|h|d>` (e.g. `45s`, `90m`, `2h`, `1d`), rejects zero, negatives, a missing or unknown
   unit, and a missing value via `fail()`; returns the duration in ms. No absolute `--at` form —
   one way of saying it.
2. **src/cli.ts** — the marker-command arg gate (`runRoleCommand`'s `rejectUnknownArgs(command,
   args, [ROLE_FLAG])`) accepts `--for <duration>` for `pause` only; the other marker commands
   keep rejecting it.
3. **src/fleet-state.ts** — `pauseFleet(root, untilMs?)` writes `{ at, until? }`, `pauseRole`
   writes `{ roles, at, until? }`; the read side (`isFleetPaused`, `pausedRoles`) treats a marker
   whose `until` is in the past as not paused, and `pauseFleet`/`pauseRole` likewise treat an
   expired marker as absent, so a `pause` after expiry reports a fresh pause, never the stale
   "already paused". `resume`/`resumeRole` are unchanged — they lift early. Consequence: the
   orchestrator's existing poll-diff (`src/orchestrator.ts` ~lines 374–391, `isFleetPaused`/
   `pausedRoles` → `role_resumed` logging and the paused skip branches) sees the expiry as an
   ordinary unpaused transition — auto-resume needs **no new scheduler code**.
4. **src/operator-commands.ts** — `cmdPause` parses `--for` and passes the deadline through;
   `rolePauseMessage` (and the fleet branch's confirmation, which phrases its own sentence)
   names the auto-resume when a deadline stands: "… paused for 30m — resumes automatically at
   14:05". A `--for` on an already-paused marker overwrites the deadline (extend or shorten)
   and says so, rather than the idempotent no-op.
5. **src/ui/status.ts** `snapshot` + **src/ui/status-payload.ts** — expose `pausedUntil`
   (ms epoch, absent when no timed pause stands) so `status --json` and any later dashboard
   countdown read one field. Rendering a live countdown in `status`/TUI/GUI is deliberately
   out of scope: they already read the same markers and show the expired pause as unpaused,
   which is correct; a countdown is a small follow-up if wanted.

**Files touched:** src/cli-args.ts, src/cli.ts, src/fleet-state.ts, src/operator-commands.ts,
src/ui/status.ts, src/ui/status-payload.ts; tests in test/cli-args.test.ts,
test/fleet-state.test.ts, test/operator-commands.test.ts, test/status.test.ts.

**Acceptance criteria.** (a) `pause --for 30m` and `pause --role <id> --for 2h` write the
matching marker with `until = now + duration` and confirm with the auto-resume time. (b) With
`until` in the past, `isFleetPaused`/`pausedRoles` read false, the orchestrator's transition
logging fires as for a manual resume, the dashboards show unpaused, and a subsequent `pause`
reports a fresh pause. (c) `resume` (fleet or `--role`) lifts a timed pause early with today's
wording; pausing with `--for` over an existing marker overwrites the deadline and reports it.
(d) `parseDurationFlag` rejects zero, negative, unit-less, unknown-unit, and missing values with
the standard `fail()` shape, and `pause` alone (no `--for`) behaves exactly as today. (e)
`status --json` carries `pausedUntil` only while a timed pause stands. (f) Full suite passes.

## Done

### `tumwater run --once --role <id>` — one round scoped to a single role (planned 2026-09-25, done 2026-09-25)

**Landed as (2026-09-25).** As planned, with three refinements: (1) `cmdRun` validates `--role`
against `enabledRoleIds(config)` rather than `knownRoleIds(config)` — reusing `parseRoleFlag`'s
shared wording, this makes a DISABLED id fail fast with the same "unknown role: … (valid ids: …)"
message as an unknown one, which is what acceptance criterion (b) actually requires (a scoped
round that booted a disabled role's runner would run nothing while claiming to serve the
operator who just queued it a prompt); enabled custom loops still pass. (2) Implementing
criterion (c) end-to-end exposed a latent once-mode bug: the "at most one tick" contract lived
only in the deferral/backoff paths of deferrable built-ins, so a custom loop (which never
defers) re-qualified every poll once its 1s idle backoff expired under the real 2s poll cadence
and the round never ended. Fixed by adding the explicit settle gate the OnceRound contract
documents — `once.active && !runner.state.running && once.isSettled(runner)` now skips the role
in the orchestrator's scheduling pass (src/orchestrator.ts) — which also hardens unscoped once
rounds for work roles. (3) The run-flag tests landed in test/cli-args.test.ts (vocabulary) and
test/orchestrator-once.e2e.test.ts (CLI behavior, where the run e2e suite lives) rather than
test/cli.test.ts; test/cli-2.test.ts's existing unknown-argument regex still matches the
widened valid-flags list. Full suite: 1808 gating tests pass; e2e tier 72/72.

**Goal.** `tumwater run --once` (Done, 2026-09-25) always runs every enabled role, and an
operator who just steered one loop (`tumwater prompt --role <id> ...`) must either wait out that
loop's interval or run a full round where every other role also spends tokens. Add a `--role`
flag to `run --once` that scopes the round to exactly one role: it ticks at most once, its
landing drains, everything else (including the director) does not run. Pairs with per-role
prompts 1/2 for a deterministic "prompt one loop, watch it act now" loop.

### Next-run visibility — show when each sleeping loop will tick again (`tumwater status`, TUI, GUI) (planned 2026-09-25, done 2026-09-25)

**Landed as (2026-09-25).** As planned, with two refinements to the helper's signature:
`nextRunCell(s, phase, now, fleetRunning)` also takes the loop's rendered phase and the fleet's
running flag, because neither fact lives on `LoopState` alone — an in-flight landing is visible
only in the phase label, and the not-running rule (criterion b) lives on the snapshot, not the
loop. Remaining time uses `humanSeconds`' existing s/m/h bucketing (the same formatter the
sleeping phase label uses, so the two cannot drift). The GUI's client-side twin is `fmtNextRun`
in a marked `next-run-fmt` region, cross-checked against `nextRunCell` over the same fixtures in
test/gui.test.ts. A prior attempt at this plan was rejected in review on two compile errors
(missing `isActivePhase` import; `statusPayload` imported from the wrong module); this version
compiles and the full suite passes.

**Goal.** An operator looking at a quiet fleet has no way to tell why: a loop may be backing off
after repeated no-change ticks (minutes to hours), merely waiting out its min interval, or due
right now. `LoopState` already carries both facts — `nextRunAt` (epoch ms before which the loop
must not run, src/types.ts:59) and `backoffSeconds` — and they flow into `StatusSnapshot.loops`,
but every consumer drops them: the `/api/status` payload (src/ui/status-payload.ts, the per-loop
mapping at ~line 57) omits both fields, and neither the status table (src/ui/status-render.ts)
nor the GUI row builder (src/ui/gui-client.ts) renders them. The `wake` row-action that clears a
backoff is likewise blind: the operator cannot see whether waking is meaningful. Surface both.

**Approach.** Rendering and payload only — no scheduler or state change.

1. **src/ui/status-render.ts** — new exported helper `nextRunCell(s: LoopState, now: number):
   string`: `-` when the loop is in flight (an active phase or `s.running`) or the fleet is not
   running; `now` when `nextRunAt <= now`; otherwise the remaining time via the existing duration
   formatting (`3m`, `1h12m`), prefixed `backoff ` when `s.backoffSeconds > 0`. Add it as a new
   **last** column (`next run`, index 10) in `renderStatus`'s `cols` and row arrays — appended
   after `last result` so `FLEXIBLE_COLUMNS`' positional indices (see the renumber comment at
   ~line 64) stay untouched, and never flexible (a short fixed-width cell like `today`). The TUI
   renders `renderStatus`'s output as-is, so it inherits the column with no change of its own.
2. **src/ui/status-payload.ts** — add `nextRunAt: s.nextRunAt` and `backoffSeconds:
   s.backoffSeconds` to the per-loop payload object (raw values, formatted client-side like
   `lastTickEndedAt`/`costUsd`). `status --json` picks them up through the same payload.
3. **src/ui/gui-page.ts** — add `<th>next run</th>` to the loop table header (after `last
   result`, before `controls`). **src/ui/gui-client.ts** — in the `sortLoops(d.loops).map` row
   builder (~line 337), a cell mirroring `nextRunCell`'s rules in browser JS (the page script
   cannot import TS — same reason `fmtLastTick` is a client-side twin of `lastTickCell`).

**Files touched:** src/ui/status-render.ts, src/ui/status-payload.ts, src/ui/gui-page.ts,
src/ui/gui-client.ts; tests in test/status-render.test.ts (cell states: future/now/in-flight/
backoff/not-running), test/status.test.ts (payload fields), test/gui-server.test.ts (payload
via /api/status), test/gui.test.ts (client-twin lockstep).

**Acceptance criteria.** (a) `tumwater status` and the TUI show a `next run` cell per loop: an
idle loop with a future `nextRunAt` reads its remaining time (`backoff ` prefix when
`backoffSeconds > 0`), a due idle loop reads `now`, in-flight loops read `-`. (b) When the fleet
is not running every cell reads `-`. (c) `status --json` and `/api/status` expose `nextRunAt`
and `backoffSeconds` per loop matching the on-disk state. (d) The GUI table renders the column
from those raw fields. (e) No existing column index or width test regresses (the new column is
appended last and non-flexible); full suite passes.

### Per-role prompts 1/2 — `tumwater prompt --role <id> <text...>`: steer one loop directly from the terminal (planned 2026-09-25, done 2026-09-25)

**Landed as (2026-09-25).** The whole approach, plus one correction a review caught: the role's
queue is dequeued in `assembleTickPrompt`, which runs BEFORE the red-main gate in loop.ts's tick —
and the gate's blocked return originally neither re-queued nor cleared, so a prompt queued while
main was red was lost (the pending field is memory-only). The blocked return now re-queues the
dequeued prompt to its own queue and clears the pending record, so it survives restarts and runs
on the first tick after main goes green (tested in test/loop-2.test.ts). Also as planned: the
director's queue stays at the inbox root (no migration); `submitRolePrompt`/`requestWake` wake the
targeted loop on submit; `--list` prints `nothing queued` when every queue is empty (the old
"nothing queued for the director" no longer tells the whole truth).

**Original entry.** Goal: today the only steering channel is `tumwater prompt`, which queues a request for the
*director* (src/inbox.ts, one shared queue in `inboxDir(root)`; `src/tick-prompt.ts` dequeues it
only in the `DIRECTOR_ROLE` branch of `assembleTickPrompt`). A user who knows exactly which loop
they want to talk to must phrase their wish as a director instruction and wait for the director to
redistribute it. Add a per-role queue: `tumwater prompt --role qa "check the X flow"` queues a
prompt only that loop's next tick sees, appended to its tick prompt as an explicit user request.

Approach: reuse the file-queue mechanics (src/file-queue.ts `queueFileName`/`listQueueFiles`)
with one subdirectory per role under the inbox dir (src/paths.ts `inboxDir`): the director keeps
its existing queue untouched, roles get `inboxDir(root)/<role>/`.

1. **src/inbox.ts** — parameterize the queue by target: `enqueueRolePrompt(root, role, text)`,
   `dequeueRolePrompt(root, role)`, `queuedRolePrompts(root, role)`, `cancelRolePrompt(root,
   role, position)`; the existing director functions keep their signatures (they become the
   `"director"` special case so `tumwater prompt --list` stays truthful). Reuse `promptPreview`,
   `promptLengthProblem` (the `DIRECTOR_PROMPT_MAX_CHARS` cap applies to role prompts too —
   rename its exported name only if trivial; otherwise alias it as the shared cap) and the
   stat-keyed prompt cache.
2. **src/cli-args.ts** `parsePromptArgs` + **src/cli.ts** case `"prompt"` — accept `--role <id>`
   with enqueue, `--list`, and `--cancel <n>`; validate the role through the same
   `knownRoleIds(config)` fallback the other `--role` consumers use (unknown role fails naming
   the valid ids). `--list` groups output as `director:` then each role with queued prompts.
   Submitting to a live fleet also wakes that one role so a sleeping loop sees the prompt now:
   call src/operator-commands.ts `requestWake(root, [role])` (its marker is safe with no fleet
   running — same as `tumwater wake`).
3. **src/tick-prompt.ts** `assembleTickPrompt`, non-director branch — dequeue the role's queue
   before building the prompt; when one is present, set `userPrompt` to it (loop.ts's
   `pendingUserPrompt` machinery — requeue on unfulfilled, clear on landing — is already generic
   over `userPrompt`), and pass the text to `buildTickPrompt` via a new optional field.
4. **src/prompt.ts** `buildTickPrompt` — new optional `userRequest` field rendered as a clearly
   labeled block ("an explicit request from the user, aimed at this loop") near the top of the
   role's task text. The loop still owns find-something-to-do: the request steers, the role's
   rules and the landing gate still apply unchanged.
5. **src/loop.ts** `requeueUnfulfilledPrompt` — requeue to the role's own queue (it has
   `this.role`), not the director's, so a re-queued request never leaks across loops.

Files touched: src/inbox.ts, src/paths.ts, src/cli-args.ts, src/cli.ts, src/help.ts (usage
stanza), src/tick-prompt.ts, src/prompt.ts, src/loop.ts, src/operator-commands.ts (caller only);
tests in test/inbox.test.ts, test/cli.test.ts (or cli-2), test/prompt.test.ts, and a tick-level
test that the dequeued text lands in the assembled prompt.

Acceptance criteria. (a) `tumwater prompt --role qa hello` queues only for qa: qa's next tick
prompt contains the request verbatim, every other role's does not, and the director's inbox is
untouched. (b) An unfulfilled tick (no change) re-queues the prompt to qa's queue, not the
director's; a landed change clears it. (c) `tumwater prompt --list` shows role queues grouped by
role; `--cancel` removes from the named role's queue. (d) An unknown `--role` fails with the valid
ids; `--role` is rejected where unsupported exactly like today. (e) Full suite passes.

Cross-reference: **Per-role prompts 2/2** (dashboard surface) lands after this one and depends on
its queue format.

### `tumwater run --once` — one full round of ticks (every enabled role once, landings drained), then exit (planned 2026-09-25, done 2026-09-25)

**Landed as (2026-09-25).** All of the approach, with two corrections discovered in the code:
(1) `run` already rejected unknown flags — cli.ts's dispatcher had a --branch-only spec, so
the vocabulary became a shared exported `RUN_FLAG_SPECS` in cli-args.ts (extended with
`--once`) that cli.ts validates with, instead of a second check inside cmdRun. (2) Once-mode
settling also covers a fleet- or role-paused role (reported as skipped/paused, per the
acceptance criteria) and the director with an empty inbox — otherwise a leftover pause marker
or a quiet inbox would hold the round open forever. Files touched: src/scheduling.ts,
src/orchestrator.ts, src/cli-args.ts, src/cli.ts, src/cli-run.ts, src/help.ts,
docs/how-it-works.md, test/orchestrator-once.e2e.test.ts (new, 7 scenarios),
test/cli-args.test.ts.

**Goal.** `tumwater run` is daemon-only: it loops until Ctrl+C. That locks the harness out of supervised settings — a cron job, a CI job, a user who wants to try one round and inspect the diff before committing to a fleet — and it hides the natural unit the brief describes ("each run attempts to find something to do, do one thing, commit, merge to main") behind an always-on process. Add `tumwater run --once`: start the same orchestrator, give every enabled role at most one tick, wait for every landing that round produced to merge, then exit 0. The supervisor already ends cleanly when a child exits with anything but the restart code (src/supervisor.ts's respawn condition), so no supervisor change is needed — a once child that exits 0 ends the whole invocation.

**Approach.** Reuse the running orchestrator's own machinery rather than building a second, simpler runner — the tick path, the land queue, the drain, and the concurrency cap are exactly what a once round must honor:

- src/scheduling.ts — `isEligible` gains an options parameter, `{ once?: boolean }`: in once mode the `minTickIntervalSeconds` gap check is skipped (a one-shot is an explicit demand for a round now; without this, a round started shortly after a daemon run does nothing because every role's clock is still fresh) while every other gate is kept as-is — error backoff (`nextRunAt`), resume gating, `s.running`, and per-role enablement. The director's branch is untouched (it stays inbox-driven).
- src/orchestrator.ts — `RunOptions.once`. At start, snapshot each runner's `state.ticks`; in the poll loop, mark a role **settled** when its `state.ticks` has advanced past the snapshot, or when this round's poll deferred it (record the role at the existing `tick_deferred` branch — a deferred maintenance tick decided not to run, which is its once-round answer), or when it is skipped with a persistent reason (backoff, paused, disabled mid-round). Once every enabled role is settled AND no role tick is in flight AND the land queue has been empty with no landing in flight for one full poll cycle, fire the existing internal stop — the same graceful-shutdown path the restart drain uses, which awaits in-flight landing tasks to the end. The one-poll-cycle requirement on the empty queue is the guard against dropping a queued-but-not-yet-started landing (a stop that lands during the shutdown drain drops the queue entry; waiting one cycle means the slot has had its poll to pick the entry up). Once mode passes `redeploy: null` — a one-shot never self-redeploys, and the handoff machinery stays daemon-only. The OrchestratorExit shape is unchanged (`restart: false`).
- src/cli-run.ts — `cmdRun` parses `--once` via `rejectUnknownArgs("run", args, [<branch spec>, <once spec>])` (cli-args.ts's FlagSpec vocabulary — `run` currently parses `--branch` without rejecting anything else, so a typo'd flag is silently ignored today; the new spec list fixes that for both flags). The flag flows to the supervised child through the already-forwarded `runArgs`. Keep the existing `orchestratorAlive` guard: a once round must never run beside a daemon (two writers to main). After `runOrchestrator` returns in once mode, print one summary line — per-role `lastResult` counts read from the runners' persisted loop state (e.g. `once: 5 ticks — 1 changed, 3 no_change, 1 skipped (backoff)`), so a cron job's log shows what the round did without parsing events.
- src/help.ts — extend the `tumwater run` stanza's flag list with `--once` and its one-line description.
- docs/how-it-works.md — one sentence in the run/operations section: `--once` runs one round and exits, for cron/CI.
- test/orchestrator-once.e2e.test.ts — new, on the existing e2e fixture pattern (fake pi shim, short `pollMs`): (a) a fleet where every role returns `no_change` exits promptly with `restart: false`, each role's `state.ticks` advanced by exactly one; (b) a role returning a change (queued) merges before exit — the round's `landed` event is in events.jsonl and main's head moved; (c) a role in backoff from its persisted state (`nextRunAt` in the future) is skipped and reported, not run; (d) a deferrable role with an open backlog and a no_change history is deferred (one round, no tick) and does not block exit; (e) the summary line lists each role's outcome; (f) `tumwater run --once` with a live daemon fails fast with the already-running message; (g) `--onc` fails fast with the rejectUnknownArgs wording. Plus a small addition to test/cli.test.ts or cli-args coverage pinning that `run` now rejects unknown flags.

**Acceptance criteria.**
- `tumwater run --once` (supervised invocation, fresh repo, fake pi) exits 0 on its own — no signal needed — after every enabled role has ticked at most once; a role whose round produced a change is merged to main before the process exits.
- Once mode overrides the per-role `minTickIntervalSeconds` gap (a role that ticked seconds earlier still runs) but honors error backoff and pause markers: such a role is reported as skipped with its reason and runs no tick.
- A once round never self-redeploys (no `redeploy` seam consulted) and refuses to start while a daemon holds the orchestrator: the existing already-running error.
- The supervisor exits with the child's 0 and records no fleet-down event for a clean once exit (existing behavior, pinned by test).
- `tumwater help run` documents `--once`; `npm run test` passes with the new tests.

## Done

### `tumwater backlog` — read the project's planned features, open bugs, and open questions from the terminal (planned 2026-09-25, done 2026-09-25)

**Goal.** The backlog is visible only on the two dashboards: the GUI's /api/backlog endpoint and the TUI's project-status browse. An operator working in terminals — the same person `tumwater status`, `tumwater report`, and `tumwater logs` serve — has no way to see what the fleet plans to build, which bugs are open, or what questions await a human decision, short of opening PLANS.md/BUGS.md/QUESTIONS.md and reading them raw (and those files grow without bound; the dashboards' parsed views exist precisely so nobody has to). Add `tumwater backlog`: a read-only command that prints the three open sections — Planned (PLANS.md), Open bugs (BUGS.md), Open questions (QUESTIONS.md) — through the same parser the dashboards use, so the terminal view cannot drift from the dashboard view.

**Approach.** The reading side already exists and is tested: `src/backlog.ts` exports `plannedPlanEntries`, `openBugEntries`, and `openQuestionEntries` (each `{title, body}`, stat-cached, degrading to `[]` on a missing file — `parseEntryDetails` already skips `_None yet._` placeholders and stops at the next `## ` heading, so Done/Fixed entries never leak in). The new work is only a renderer and CLI wiring:

- src/backlog-report.ts — new small module exporting `renderBacklogMarkdown(root): string`. It renders three `## ` sections titled `Planned features`, `Open bugs`, `Open questions`, each listing its entries as the verbatim `### ` heading followed by the entry body indented two spaces (the body is kept verbatim — these are markdown the loops wrote, including their Goal/Approach/Acceptance-criteria structure). An empty section renders a single `_(none)_` line rather than disappearing, so an all-clear backlog reads as three explicit empties, not a suspiciously short document. No re-parsing: the renderer calls the three backlog.ts entry readers, so cache behavior and placeholder handling come for free.
- src/cli.ts — a new `case "backlog"` in the dispatch switch, in the style of `case "report"`: `rejectUnknownArgs("backlog", args, [])` (no flags — one format, opinionated), **no** `requireReadyRepo` gate (the entry readers degrade to `[]` on a missing file, so the command prints three empty sections in any directory, matching report's rationale rather than config's), then `process.stdout.write(renderBacklogMarkdown(root) + "\n")`.
- src/help.ts — one usage line after the `logs` lines: `tumwater backlog               Show planned features, open bugs, and open questions (the dashboards' backlog view)`.
- test/backlog-report.test.ts — new test file: the renderer against an empty root (three sections, three `_(none)_` lines); against seeded PLANS.md/BUGS.md/QUESTIONS.md fixtures (titles verbatim with their `(planned …)`/`(found …)` suffixes, bodies indented, a `_None yet._` placeholder producing the empty rendering); and a CLI dispatch smoke test through the existing `cli()` harness in test/util.ts asserting the exit output contains a seeded bug title and that `--json` fails fast with `unknown argument`.

**Acceptance criteria.**
- `tumwater backlog` prints the three sections; every `### ` heading under `## Planned`/`## Open` in the three files appears with its body, byte-identical to what `plannedPlans(root)`/`openBugs(root)` return as titles (same parser, no drift).
- An empty or missing backlog file renders `_(none)_` under its section; the command exits 0 and never throws on a missing file.
- `tumwater backlog --anything` fails fast with the standard `unknown argument` message; the command works in a directory without an initialized project (no `requireReadyRepo` gate).
- `tumwater help` lists the new command; `npm run test` passes with the new tests.

**Done 2026-09-25.** Landed as planned: src/backlog-report.ts (renderer, calling the three backlog.ts entry readers so there is one parser for terminal and dashboards; a `# tumwater backlog` h1 tops the document, matching the usage report's shape), the `case "backlog"` dispatch in src/cli.ts (no flags, no requireReadyRepo gate), the usage line in src/help.ts, and test/backlog-report.test.ts (renderer on seeded and bare roots, CLI smoke test, help listing). One wording correction to the criteria above: with zero accepted flags the standard rejectUnknownArgs message is `tumwater backlog takes no arguments` — the `unknown argument: …` shape only exists for commands that accept some flags — so the fast-fail test pins `takes no arguments`.

### TUI per-loop controls — pause/resume, abort, and wake the loop whose transcript you are viewing (planned 2026-09-25, done 2026-09-25)

**Goal.** The GUI's loop rows carry wake, abort, and pause/resume controls (the `/api/wake`, `/api/abort`, and `/api/pause-role` endpoints; per-role pause 2/2), but the TUI — the other dashboard — offers only the director prompt line and budget editing: an operator watching `tumwater tui` must switch to another terminal to quiet one noisy loop or kill one in-flight tick. Add per-loop control keys in the TUI: while a loop's transcript pane is on screen, Ctrl+P pauses/resumes that loop, Ctrl+A aborts its in-flight tick, and Ctrl+W wakes it.

**Approach (as built).** The TUI calls the same marker-writing cores the CLI's `--role` flags do, so the surfaces cannot drift on marker format, idempotence, or wording:

- src/operator-commands.ts — the per-role pause/resume confirmations are now exported wording helpers (`rolePauseMessage`/`roleResumeMessage`, taking the `changed` boolean their marker writer returns), and `cmdPause`/`cmdResume` print them verbatim. The resume helper carries the fleet-pause interplay note (the fleet gate outranks the per-role one, so with it active a freshly resumed role still starts no ticks — omitting it would promise ticking the scheduler then deny), so CLI and TUI get the same honest sentence by construction rather than by copied text.
- src/ui/tui.ts — one keypress branch, guarded to the transcript views (`view` inside the role range) and skipped while `budgetMode` is set (elsewhere Ctrl-letters stay inert through applyKey as before): Ctrl+P toggles by the marker's current state, flashing the pause or resume wording via the shared helpers (their `changed: false` renders the CLI's "already paused"/"was not paused" when another window raced the toggle); Ctrl+A flashes `requestAbort`'s `message`, or `error: <liveness error>` when no harness runs (no marker written); Ctrl+W flashes `requestWake(root, [role])`'s confirmation. Every branch is a disk write that can fail (lock timeout, torn fs) and an unguarded throw would escape the keypress handler and kill the TUI, so the whole branch is wrapped in try/catch flashing `error: <reason>` — the same contract the prompt-submit path already honors. The transcript header gains the hints (`Ctrl+P pause · Ctrl+A abort · Ctrl+W wake · Ctrl+T to cycle`).
- test/tui.test.ts — the fake-TTY keypress harness drives each key: the pause toggle round-trips the marker (`pausedRoles`) with the CLI's wording and the `paused` status cell, the resume flash carries the fleet-pause interplay note while `pauseFleet` stands, abort flashes the confirmation with a live harness (the test process's pid stands in) and the liveness error without (no marker), wake flashes and drops its marker, the keys are inert in non-transcript views and in budget mode, and a failed marker write (the marker path made a directory) flashes `error:` instead of killing the TUI.

**Acceptance criteria.**
- Viewing a loop's transcript and pressing Ctrl+P writes the paused-roles marker (verifiable via `pausedRoles(root)`) and flashes the pause wording; pressing it again flashes the resume wording and removes the marker; the status table's cell for that role reads `paused` while the marker stands.
- With a fleet pause active, the resume flash includes the interplay note (`the fleet pause is still active — `tumwater resume` lifts it`), identical to `tumwater resume --role`'s output.
- Ctrl+A with a live harness writes the per-role abort marker and flashes the confirmation; with no live harness it flashes the liveness error and writes no marker.
- Ctrl+W flashes `wake requested for <role> — …` and drops the wake marker for that role.
- In budget-edit mode and in the non-transcript views (events, project status, usage report, failures), all three keys are inert; plain letters still edit the prompt line in every view.
- A failed marker write (lock timeout, fs error) flashes `error: <reason>` in the TUI instead of throwing out of the keypress listener.

### Per-role pause 2/2 — dashboard per-row pause toggle (planned 2026-09-25; 1/2 landed 2026-09-25, done 2026-09-25)

**Goal.** Plan 1/2 gives the CLI per-role pause, but the dashboard's loop rows already carry wake and abort controls while pausing a single loop still means leaving the browser. Add a per-row `pause`/`resume` toggle reusing 1/2's marker functions.

**Approach.**
- src/ui/gui.ts — a `POST /api/pause-role` endpoint beside the existing `/api/wake` and `/api/abort` handlers: validates the posted role the same way those do, then calls `pauseRole`/`resumeRole` (src/fleet-state.ts, from 1/2) and returns `{ changed, paused }`; behind the token gate like its siblings. If the fleet-wide pause stands, the endpoint still records the role marker (they compose: the fleet gate is checked first at scheduling).
- src/ui/gui-client.ts — each loop row's controls cell (the row-actions block the wake/abort plan added) gains `pause` for a running non-paused role and `resume` for a paused one — the state is already in the payload once 1/2 adds `pausedRoles`. Same delegated click listener and `postJson` flash pattern as wake/abort; no confirmation dialog.

**Acceptance criteria.**
- Clicking pause on a loop row stops that role's new ticks within one scheduler cycle and the row renders `paused`; resume restores it; the returned message flashes in the header like the other controls. **Done 2026-09-25:** `POST /api/pause-role` sits beside `/api/abort` in src/ui/gui.ts (token-gated by the shared front gate; rejects unknown/missing roles with the shared rejectBadRole 400 wording, non-boolean `paused` with /api/pause's wording) and returns `{ ok, changed, paused }`; the endpoint has no server message, so the client composes its flash from `changed`/`paused` ("docs paused" / "docs was already paused" / "docs resumed" / "docs was not paused"). Each row carries a pause/resume toggle driven by the payload's `pausedRoles`; the fleet pause composes — the row marker is still recorded under a fleet pause.
- src/ui/gui.ts — a `POST /api/pause-role` endpoint beside the existing `/api/wake` and `/api/abort` handlers: validates the posted role the same way those do, then calls `pauseRole`/`resumeRole` (src/fleet-state.ts, from 1/2) and returns `{ changed, paused }`; behind the token gate like its siblings. If the fleet-wide pause stands, the endpoint still records the role marker (they compose: the fleet gate is checked first at scheduling). **Landed as above.**
- src/ui/gui-client.ts — each loop row's controls cell gains `pause` for a non-paused role and `resume` for a paused one, read from the payload's top-level `pausedRoles` (no per-loop field added); same delegated click listener and flash pattern as wake/abort; no confirmation dialog. **Landed as above.**
- Tests: test/gui-operator.test.ts (marker effect, 400 on unknown role, idempotence) and the evaled client block pin, extending the existing row-actions test pattern. **Done 2026-09-25:** `POST /api/pause-role writes the per-role marker…` covers marker effect, idempotence on both directions, the shared 400 wording, malformed/non-object 400 and oversized 413, and marker-untouched on rejection; the row-actions pin gained pause/resume anchors and their composed flashes.

### Per-role pause 1/2 — `tumwater pause --role <id>` / `resume --role <id>`: quiet one loop while the fleet keeps working (planned 2026-09-25, done 2026-09-25)

**Goal.** Pause and resume are fleet-wide only (`pauseFleet`, src/fleet-state.ts:23; the scheduler gate at src/orchestrator.ts:440 blocks every role). `abort --role` kills a tick but the role immediately starts the next one, so an operator who wants a single noisy role out of the way (a docs loop churning, a qa loop waiting on something) has no tool. Add per-role pause: `tumwater pause --role docs` stops that role from starting NEW ticks — in-flight ones finish, every other role keeps ticking, the fleet stays up.

**Approach.**
- src/fleet-state.ts — the single home of the marker, beside `pauseFleet`: a new marker file `.tumwater/state/paused-roles.json` (written with `writeJsonAtomic`, shape `{ roles: string[], at: number }`) plus `pausedRoles(root): string[]` (missing/unreadable file → `[]`, never throws, like `isFleetPaused`), `pauseRole(root, role): boolean` (adds the id, false when already present — idempotent like `pauseFleet`), and `resumeRole(root, role): boolean` (removes it, false when absent). Custom-loop ids are accepted verbatim: the marker must survive config edits, exactly why `namedRole` (src/operator-commands.ts:54) already resolves built-in roles without touching tumwater.json.
- src/operator-commands.ts — `cmdPause`/`cmdResume` take args and branch on the `--role` value (`namedRole`): with a role, call `pauseRole`/`resumeRole` and report `role docs paused — it stops starting new ticks at its next eligibility check (in-flight ticks finish; the rest of the fleet is unaffected)` or `role docs was not paused` (resume's changed-state contract); without, the existing fleet-wide path unchanged. Reuse `markerApplyNote` for the when/tail note.
- src/orchestrator.ts — in the same scheduler cycle as the fleet gate (:440), read `pausedRoles(root)` once per cycle; a role whose id is in the set is skipped exactly where `userPaused` skips roles, before isEligible. Unlike the fleet pause the director is NOT exempt: the operator named the role deliberately, and queued prompts simply wait in the inbox (the same effect pausing the whole fleet has on the director). Log one `role_paused` / `role_resumed` event per crossing per role (loop: "harness", the `prevUserPaused` pattern at :441).
- src/types.ts — add `"role_paused" | "role_resumed"` to `HarnessEvent["type"]` (beside `"fleet_paused"` at :196), with the same comment style.
- src/failure-state-change.ts + src/ui/event-format.ts — register both types in `STATE_CHANGE_TYPES` and give them `describeStateChange`/render phrases so the digest's Fleet state changes section and the event feed show `role docs paused` / `role docs resumed` (the rate_limit_hold pattern).
- src/ui/status.ts + src/ui/status-model.ts — the snapshot payload (:180) gains `pausedRoles: string[]` next to `paused`; in the state-cell chain (status-model.ts:183) an idle role in the set renders `paused` (checked with `userPaused`), so CLI status, TUI, and GUI all show it from one model. In-flight ticks keep their live detail, as under the fleet pause.
- docs/how-it-works.md — one sentence in the operator-control section: pause/resume accept `--role <id>` to gate a single loop.

**Acceptance criteria.**
- `tumwater pause --role docs` then a scheduler cycle schedules no docs tick while other roles tick normally; `tumwater resume --role docs` re-enables it; both are idempotent with distinct wording. An unknown or misconfigured role id reports the same failure `namedRole` already produces.
- Pausing a role before `tumwater run` starts leaves it paused at startup (marker is persistent state).
- `role_paused`/`role_resumed` events appear in the event feed and the digest's Fleet state changes; the status cell of a paused idle role reads `paused` in status, TUI, and GUI.
- Tests: test/fleet-state.test.ts (marker shape, idempotence, missing-file tolerance), test/orchestrator-seams.test.ts or an e2e file (gate before isEligible, one event per crossing, director honored when named), test/operator-commands.test.ts + test/cli-operators.test.ts (CLI wording, `--role` resolution), test/status-render.test.ts (the `paused` cell), test/event-format.test.ts + test/failure-report.test.ts (render/digest phrases).

Implemented as planned, with three deviations: tests use the built-in role id `clean` where the
entry's wording examples said `docs` (there is no `docs` role in the catalog — the wording
itself is unchanged); the paused-cell threading lives at the two loopPhase call sites
(status-payload.ts, status-render.ts) as `snap.paused || snap.pausedRoles.includes(role)` rather
than a new branch inside status-model.ts, so the one shared precedence ladder is untouched; and
pause/resume's `rejectUnknownArgs` now admits `--role <id>`, so the pre-existing stray-argument
test asserts the unknown-argument message instead of `takes no arguments`. Also added: the help
table's pause/resume lines show `[--role <id>]`. Tests landed in fleet-state, operator-commands,
cli-operators, status-render, event-format, failure-report, and a live orchestrator e2e
(orchestrator-2: pre-startup pause gates only that role, the named director is not exempt, one
event per crossing, resume re-enables within one poll). Full suite 1666/1666 green.

### `tumwater config` — print the effective merged config as JSON (planned 2026-09-25, done 2026-09-25)

**Goal.** Every setting edits apply live, but an operator debugging "why is `qa` not ticking?" or "what interval does my custom loop actually run at?" has no way to see what the fleet would actually use: tumwater.json holds only the overrides, and the defaults live in `defaultConfig()` (src/config.ts:29), merged in by `loadConfig` (src/config.ts:182) together with the customLoops-into-roles merge (src/config.ts:117–120). Mental overlaying is error-prone, and `tumwater doctor` reduces the whole config to one "N roles enabled" line. Add `tumwater config`: print the effective config — exactly what `loadConfig(root)` returns, defaults filled in and custom loops merged — as pretty JSON.

**Approach.** The resolved object already exists; the command is a read, not a writer.

- src/operator-commands.ts — add `cmdConfig(root)`: `let config; try { config = loadConfig(root); } catch (err) { fail(errorMessage(err)); }` — a malformed or invalid tumwater.json fails with `validateConfig`'s actionable message (exit non-zero, no JSON printed), the same surfacing doctor's config check produces. Then `process.stdout.write(JSON.stringify(config, null, 2) + "\n")`. No redaction (the config holds no secrets — provider keys belong to pi's own env) and no transformation: print what the fleet loads, including the merged per-role entries custom loops become.
- src/cli.ts — a `case "config"` beside `status`: `await requireReadyRepo(root)` (an initialized repo always has tumwater.json — src/startup-gate.ts:42 — so the command never runs outside a project), then `cmdConfig(root)`. One format, no flags: `rejectUnknownArgs("config", args, [])`. Add the help-table line `tumwater config                 Show the effective config (defaults + tumwater.json) as JSON`. Note for the implementer: print the resolved config only — an operator who wants to see what they wrote reads tumwater.json; do not add a defaults-vs-file diff mode (one sensible way).

**Files touched.** src/operator-commands.ts, src/cli.ts, test/cli-operators.test.ts.

**Acceptance criteria.**
- `tumwater config` in an initialized repo prints pretty JSON that deep-equals `loadConfig(root)` for the same root (test: parse the command's stdout and `assert.deepStrictEqual` against a direct `loadConfig` call), including role defaults the file never mentions.
- With a custom loop defined in tumwater.json, the output's `roles` section contains the merged entry (same shape the orchestrator's runners see).
- A tumwater.json with an invalid value (e.g. a negative `minTickIntervalSeconds`) makes the command exit non-zero with validateConfig's message and print no JSON.
- `tumwater config --anything` fails via `rejectUnknownArgs`; `tumwater config` outside an initialized repo fails with the not-initialized message (the `requireReadyRepo` gate); the help table lists `config`.
- The existing cli-operators suite passes unmodified; the full `npm run test` is green.

Implemented as planned: `cmdConfig` in src/operator-commands.ts, the `config` case and help-table
line in src/cli.ts, and three cli-operators tests pinning the deep-equal-to-loadConfig output,
the invalid-file failure, and the flags/gate/help contract. Full suite 1622/1622 green.

### `tumwater stop` — stop a running fleet from another terminal (planned 2026-09-24, done 2026-09-25)

**Goal.** A fleet started with `tumwater run` can only be stopped from its own terminal (Ctrl+C) or by a hand-rolled `kill <pid>` after digging the pid out of `tumwater status`. Every other operator verb — pause, resume, wake, abort — works from any terminal against the on-disk state; stopping the fleet is the one gap. Add `tumwater stop`: deliver the same graceful SIGTERM shutdown the child already handles, addressed via the recorded orchestrator pid.

**Approach.** No marker file and no fleet-side change: the supervised `run` child already installs SIGINT/SIGTERM handlers that abort the controller and drain in-flight ticks (src/cli.ts:134–141, "stopping — waiting for in-flight ticks"), and the supervisor (src/supervisor.ts) treats a clean child exit as done, so a signal to the child is the entire mechanism. The only new work is addressing it:

- src/operator-commands.ts — add `cmdStop(root)`: read the orchestrator info via `readOrchestratorInfo` (src/fleet-state.ts:64); when the file is missing/unreadable or `pidAlive(info.pid)` (src/process.ts:24) is false, `fail("no harness is running — start it with `tumwater run` first")` — the same wording and liveness gate `requestAbort` uses. Otherwise `process.kill(info.pid, "SIGTERM")` and print `stop requested — the fleet drains its in-flight ticks and exits (the same path as Ctrl+C)`. Document in a comment that a recycled pid is the accepted risk `orchestratorAlive` already carries everywhere (status, abort, pause) — the info file is refreshed by the live orchestrator, so the window is small and the signal is the same one a human `kill` would send.
- src/cli.ts — a `case "stop"` alongside pause/resume: `rejectUnknownArgs("stop", args, [])` (no flags), then `cmdStop(root)`. Add the help-table line `tumwater stop                       Stop a running fleet (drains in-flight ticks, like Ctrl+C)`. Note for the implementer: `run`'s terminal Ctrl+C reaches the whole process group, while `stop` signals only the child — the supervisor needs no signal because a clean child exit already ends `superviseRun`'s loop.
- README.md — one row in the "Control the loops" usage table: `tumwater stop` (the docs loop may also pick this up; one line here keeps the release honest).

**Files touched.** src/operator-commands.ts, src/cli.ts, README.md, test/cli-operators.test.ts.

**Acceptance criteria.**
- `tumwater stop` with no `.tumwater/state/orchestrator.json`, an unreadable one, or a dead pid fails with the "no harness is running" message (exit non-zero), matching `abort`'s behavior.
- With a live pid recorded (test: spawn a `sleep 30` child, write its pid into orchestrator.json via the real `orchestratorStatePath` layout), `cmdStop` SIGTERMs it — asserted by the child's exit signal being SIGTERM — and prints the confirmation.
- `tumwater stop --anything` fails via `rejectUnknownArgs`; the help table lists `stop`.
- The existing cli-operators and fleet-state suites pass unmodified; the full `npm run test` is green.



### Land-queue speed 2c — Split landing into a parallel vetting stage and a serial merge stage (planned 2026-09-23, split from 2/3 into its own entry 2026-09-26, done 2026-09-24)

**Status 2026-09-24 (partly delivered by the BUGS.md sweep):** two of its pieces landed as bug fixes. A batch's Phase A gates run concurrently, two at a time (`PHASE_A_CONCURRENCY`; each extra gate takes its own `maxConcurrent` permit through `BatchContext.gatePermit`), and a terminal Phase A verdict writes its outcome and drops its entry at once (`BatchContext.onFinal`). Still to do: the vetting/merge split, `maxConcurrentLandings`, and merging vetted entries ahead of an unvetted head.

**Why.** From 2026-09-23 12:19 to 20:56 changes arrived at 5.4/h and the one landing slot served 5.8/h at 81% busy — at that load the queue only grows. The slot's time went to model reviews (~49%), per-change full-suite gate checks (~19%, ~107 s each), and the build-fix runs 1/3 removes. The step that must stay serial — stack + batch check + fast-forward — is a few minutes per batch; every review and gate check runs one after another today, both in the single path and in `landBatch`'s Phase A loop (src/land-batch.ts:130, BUGS.md "A batch reviews its changes one after another"). The isolation for concurrency already exists: each role has its own `_land-<role>` worktree, review session dir, pinned ref and LoopState.

**Target.** Queue-to-landed latency of about one review + one gate check + one merge step (~6–10 min at today's medians, not 39). The interlock stays: a role is still blocked while its change is being vetted or merged, just for much less time.

**Approach.**
- **Vetting**, up to `maxConcurrentLandings` at once, taken in queue order: for each queued entry not already being vetted, in its own `_land-<role>` worktree:
  - `ensureDetachedWorktree` at the pin, then `rebaseOntoMain`.
  - `reviewPinnedChange` (gate check + review, the existing function).
  - Persist the verdict at once, as Phase A already does.
  - A **terminal** verdict (`rejected`, a strike-cap `review_error` discard, `error`) calls `writeLandingOutcome` right away. That drops the entry and frees the author, which fixes BUGS.md's "A change rejected early in a batch keeps its role blocked".
  - An approved or exempt verdict leaves the entry queued and marked vetted, with its approved head in the landing ref and its patch-id in state (2a).
- **Merging**, one at a time, on the existing single slot: take every vetted entry, up to `landBatchMax`, in queue order among the vetted. Do not wait for an unvetted queue head; independent changes may merge ahead of a slow review. Stack them on main's current tip with the existing `landBatch` assembly (`base..sha` cherry-picks, one scope-`batch` check, `ffStackToMain`); a stack of one goes through `landChange`, whose gate now short-circuits via 2a. Phase A leaves `landBatch` and becomes the vetting task. `landBatch` keeps stacking, the check, the ff, and the fallback.
- src/landing-drain.ts — `drainLandingQueue` today starts at most one landing when `landingInFlight === null` (src/orchestrator.ts:417). It becomes two drains: `drainVetting` (start vet tasks while below the limit, skipping entries already vetted or in flight) and `drainMerge` (start the merge when the slot is free and at least one entry is vetted). Keep the head dedupe (`isMergedInto`), the torn-head drop, and the authorFor resolution unchanged.
- src/orchestrator.ts — `landingInFlight: InFlightLanding | null` (:181) becomes a vetting set plus the merge slot. The shutdown `Promise.allSettled` (:546) and `consumeAbortRequests` (:299) span all of them; `tumwater abort --role` aborts that role's vet or merge. `holdForRestart` (:411) stops starting vet tasks exactly like ticks. Aborting a vet task is always safe: it is pi runs and a detached worktree, and the pin survives.
- **Permits.** Landing pi runs acquire the shared `maxConcurrent` semaphore today at `LANDING_TIER` (src/landing-drain.ts:25). That was right for the single-GPU local backend but makes N parallel vets cost N author slots. New config `maxConcurrentLandings` (default **1**, which reproduces today's behavior exactly, shared permit included; validated as a positive integer in src/config-validation.ts beside `landBatchMax`). At 1, vetting draws from the shared semaphore as now. Above 1, vetting draws from its own `Semaphore(maxConcurrentLandings)` and adds that many streams to the provider; while the budget gate is in `fallback` (local model), clamp it to 1 and return to the shared semaphore. README documents the total: `maxConcurrent + maxConcurrentLandings + director`. This repo's tumwater.json is raised to 2–3 only after this build is the one running (the self-hosting note below); provider 429s are the thing to watch (BUGS.md's 429-storm entry).
- **Build-check load** is bounded by 2b's `maxConcurrentChecks`, not here — land 2b first, and 1/3 before both, so a load flake costs one retry rather than a rejection.

**Files touched.** src/landing-drain.ts, src/orchestrator.ts, src/land-batch.ts, src/lander.ts, src/config.ts, src/config-validation.ts, README.md; tests: test/landing-drain.test.ts, test/lander.test.ts, test/orchestrator-seams.test.ts, test/config-validation.test.ts.

**Acceptance criteria.**
- Three queued entries with fake reviewers of duration T and `maxConcurrentLandings: 3` → all three merged in about T + check + merge, not 3T (a timing assertion with generous slack, the orchestrator-test style).
- `maxConcurrentLandings: 1` → today's event sequence for the existing landing and batch tests.
- A rejection in vetting drops its entry, and its role ticks within one poll while other vets continue.
- A vetted entry merges while an earlier queue entry is still in review.
- Shutdown and `abort --role` reach every vet task; pins survive a shutdown abort.
- `maxConcurrentLandings: 0` and negatives are rejected by config validation with a named key.

**Self-hosting note.** The fleet lands each step with the *previous* build (the 4b/7 lesson, BUGS.md tumwater.json entry). `maxConcurrentLandings: 1` is behavior-preserving, so this entry can land while the old build runs; this repo's tumwater.json is only raised after the new build is the one running (check `tumwater doctor`'s running-build line).

**Series.** Sibling of 2a, 2b, 2d. Depends on 2a (patch-id approvals survive the rebase into the merge stage) and 2b (concurrent vets mean concurrent suites); 1/3 first so a load flake costs one retry.

**Implemented 2026-09-24** in 84af95b. All criteria are met, including a live-orchestrator e2e test at `maxConcurrentLandings: 3`. Above 1, `drainVetting` in src/landing-drain.ts runs up to that many vets at once, in queue order. Each vet is land-batch.ts's exported `vetRequest`, in its own `_land-<role>` worktree and under its own resizable `Semaphore(maxConcurrentLandings)`. A terminal verdict writes its outcome at once and frees the author; an approved change stays queued, marked vetted in memory. `drainMerge` then lands every vetted entry, up to `landBatchMax`, through `landVetted`, which is the post-Phase-A stack/check/ff and 3d's prefix bisect. It does not wait for an unvetted queue head. Shutdown, the restart hand-off and `abort --role` reach every vet and the merge, and pins survive a shutdown. Deltas: at 1, today's drain (`drainLandingQueue` with its two-at-a-time Phase A) runs unchanged behind the `drainLandings` dispatcher, instead of the split with one vet, which would have been slower; a single vetted change lands through `landApprovedChange`, not `landChange`, so no review re-runs inside the serial slot (the check still re-runs in the merge lock when main moved); vetted state is in memory, so after a restart those changes are vetted again, with the review reused through the patch-id. The fallback clamp and live width switching have no dedicated test. This repo's tumwater.json is unchanged; raise it only once this build is the one running. On 2026-09-24 the separate `maxConcurrentLandings` setting and the width-1 single-slot path were removed at the user's direction (16f0440), and landings (every vet and the merge's conflict resolver) now draw from the shared `maxConcurrent` permits. A follow-up caps vets at `vetLimit` (`maxConcurrent` − 1, at least one), so a deep queue always leaves a slot for authoring.

### Land-queue speed 1/3 — Take the build-fix run out of the landing slot: retry a failed gate check once, then hand the failure to whoever caused it (planned 2026-09-23, requested by user, done 2026-09-24)

**Status 2026-09-24 (partly delivered by the BUGS.md sweep):** step 1 has landed. A failed gate check is re-run once, and a pass logs `gate check failed then passed on retry — flaky: <headline>` and proceeds as verified (the build-fix budget fix, 47c06df). That fix also caps the fix run that remains at 20 minutes (`BUILD_FIX_TIMEOUT_S`) under a shared-host prompt, and dc0d9a7 names any fix commit in the review prompt. Both BUGS.md entries the last acceptance criterion names are already in Fixed. Still to do: attributing a repeat failure through `checkMainBaseline` (step 2) and deleting the fix run (step 3).

**Why.** The land queue is the fleet's bottleneck. A role cannot tick while its change is queued or landing (the merge-queue interlock), so every queued change idles one loop. On 2026-09-23 the queue sat at depth 6 (median), 10 at p90, and a change took 39 min (median) from `land_queued` to its outcome. The single worst cost is the gate's build-fix run (the "Fix a failed landing build check on the spot" plan under Done, user-requested 2026-09-21). It runs inside the one landing slot while the whole queue waits. That day it ran five times: coverage 27 min, dry 112 min and 215 min, feature 35 min, organize 46 min. That is about 7.3 h, of which about 5.4 h was inside the slot. **All five ended rejected; none led to a landing.** Dry's 07:44 run was the batch the 10:42 restart waited 97 minutes on (the self-redeploy Open bug). Dry's 03:48 run load-tested the live host and `pkill`ed every test runner (BUGS.md, the "bounded" build-fix entry). Most failures it chased were load flakes, not breakage.

This supersedes the in-slot fix run from that plan and keeps its goal: a red **main** must not reject every queued change. That case now goes to the machinery that already exists for it. `checkMainBaseline` (src/main-baseline.ts:125) holds a per-SHA, fleet-wide verdict, and landings seed it green. The main-red gate (src/main-red.ts:84) already blocks authoring on a red main and hands the repair to bugfix (`bugfixMainRedNote`, :68). Real breakage by the author goes back to the author, whose next tick fixes it in its own parallel permit instead of in the serial slot.

**Approach.**
- src/review.ts — the pre-check `failed` branch in `reviewAheadOfMain` (the `runPi` fix run from :247 and its commit/re-check through the `verifiedByHarness` assignment ~:289) becomes:
  1. **Retry once.** Re-run `runScopedBuildCheck(root, role, "gate", wt, config, …)`. If it passes, log `warnEvent(root, role, "gate check failed then passed on retry — flaky: <headline>")` and continue exactly like a first-time pass (`verifiedHead = head`, `verifiedByHarness` set). The warning names the flaky test so telemetry and bugfix can go after it.
  2. **Still failing: attribute it.** Ask `checkMainBaseline(mirrorWorktreePath(root), config)` about main's current tip. Refresh the mirror to main first (`ensureDetachedWorktree` at main, the redeploy.ts idiom). It is usually a cache hit, because every landing seeds the SHA it moved main to.
     - **Main green:** the change broke the check. `reject(reasons)` exactly as before 4803c07: deterministic, no pi run, reasons injected into the author's next tick.
     - **Main red:** return `{ decision: "failed", detail: "main <sha> is red — not this change's failure" }` without advancing `unreviewFailures`, the transport-failure rule from BUGS.md 2026-09-20. The pin is kept, main-red.ts owns the repair, and the change re-lands on its author's next tick once main moves green.
     - **Baseline null or skipped:** treat it as the author's failure and reject. This is the safe default, and the reasons say the baseline was unavailable.
  3. Delete the fix-run path: `buildBuildFixPrompt` (src/prompt.ts:391), `GateResult.fixRun` and every `fixRun` carry, and the `tumwater(<role>): fix failing build check` commit. `GateResult.discarded` stays (the strike-cap tell).
- src/lander.ts `reviewPinnedChange` — drop the `gate.fixRun` fold. Keep the `verifiedHead`/`setRef` pin-tracking, which still covers a green rebased head.
- src/land-batch.ts — the `base..sha` range cherry-pick stays: it is correct for a single commit and harmless for more. Update the comment that justifies it by the fix run (:205–211).
- README.md — the review-gate paragraph describes retry-then-attribute instead of the fix run.

**Files touched.** src/review.ts, src/prompt.ts, src/lander.ts, src/land-batch.ts (comment only), README.md, test/review.test.ts, test/prompt.test.ts, test/lander.test.ts, test/land-batch tests that stage a fix run.

**Acceptance criteria.**
- Gate check fails then passes on retry → approved path, one flaky warning naming the failing headline, and no pi run spent before the reviewer.
- Fails twice, and main's baseline at the tip is green (seed it with `noteGreenBaseline` in the test) → `review_rejected` with the check's reasons and zero pi runs. This is the pre-4803c07 behavior, restored by test/review.test.ts's "gate pre-check rejects a failing build with zero reviewer runs".
- Fails twice, main baseline red → `decision: "failed"`, `unreviewFailures` unchanged, landing ref kept, no rejection recorded against the author.
- No code path starts a pi run from the gate's pre-check branch; `buildBuildFixPrompt` no longer exists.
- BUGS.md's "gate's bounded build-fix run has no time or resource budget" and "reviewer is never told about the gate's own build-fix commit" entries move to Fixed (the mechanism is gone).
- `npm test` green.

**Implemented 2026-09-24** in 4e9bf7f, with 91ef22a naming the red-main outcome. All criteria are met; the two BUGS.md entries were already in Fixed. After the one retry, `mainTipVerdict` (src/main-red.ts) asks `checkMainBaseline` about main's tip. Main green rejects with the check's reasons and zero pi runs. Main red returns `failed` with `mainRed`, and the landing reports `main_red`: pin kept, no strike, no dead-backend error streak. No verdict for main rejects, and the reasons say the baseline was unavailable. `buildBuildFixPrompt`, `buildFixConfig`, `BUILD_FIX_TIMEOUT_S`/`BUILD_FIX_QUIET_S`, `GateResult.fixRun` and the review prompt's fix-commit block are gone. Deltas: main is checked in its own `_gate-main` worktree (`gateMainWorktreePath`), not the redeploy mirror, which the redeployer compiles in; lookups are serialized in-process because Phase A gates run concurrently; the docs change is in docs/how-it-works.md.

### Land-queue speed 2a — Approvals survive a clean rebase: key them by patch-id, not sha (planned 2026-09-23, split from 2/3 into its own entry 2026-09-26, done 2026-09-24)

**Status 2026-09-24:** BUGS.md's "fallback re-reviews every change it already approved" entry was fixed another way (45acd18). Phase A reviews each pin rebased onto main, and the one-change path and the fallback land the approved head through `landApprovedChange` with no second gate; the in-lock `verifyLanding` re-check covers the rebased tree. Patch-id approvals are still worth having for the single path: an approved change re-drained after main moved still pays a second review.

**Why.** `reviewAheadOfMain` short-circuits a re-review only on an exact sha match (`state.lastApprovedHead === head`, src/review.ts:188), but `landChange` rebases onto main before the gate (src/lander.ts:190) — so any approved change whose main moved pays a full second reviewer run. This is BUGS.md's open "batch's one-at-a-time fallback re-reviews every change it already approved" entry: about 12 wasted minutes in the 05:03 batch on 2026-09-23. A review judges a diff, not a sha; keying the approval by the diff's patch-id keeps the short-circuit across a clean rebase while still re-reviewing a rebase that changed the patch.

**Approach.**
- src/git.ts — `patchId(wt, base, head): Promise<string | null>`: `git diff --no-color <base> <head>` piped into `git patch-id --stable`, returning the first field of the output, or null on any failure (the plumbing style of the file's other helpers).
- src/types.ts — `LoopState.lastApprovedPatchId?: string` beside `lastApprovedHead` (:286).
- src/review.ts — record it where `lastApprovedHead` is recorded (:379). The short-circuit at :188 becomes: approved when `lastApprovedHead === head` OR (`lastApprovedPatchId` is set and equals `patchId(wt, mainBranch, head)`). The gate's deterministic pre-check still runs on the new tree unless `verifiedHead` covers it — only the **model review** is reused; the check that the tree still builds is not skipped.

**Files touched.** src/git.ts, src/types.ts, src/review.ts, test/git.test.ts, test/review.test.ts.

**Acceptance criteria.**
- An approved change rebased cleanly onto a moved main re-lands with zero reviewer runs and one build check.
- A rebase that changes the patch (conflict resolution, or a hunk moved into different context that changed) re-reviews.
- `patchId` is equal for the same diff taken from two different shas, and null-tolerant (a failed `git patch-id` never throws into the gate).

**Series.** Replaces plan 2/3's step 2a (split 2026-09-26 so each step is one run; 2/3's why/target live on in its siblings). Siblings 2b, 2c, 2d below: 2c depends on this entry (the merge stage re-lands approved heads through the gate after a rebase) and on 2b; 2a and 2b have no dependency between them or on anything else.

**Implemented 2026-09-24** in 689a293. All criteria are met. `patchId` (src/git.ts) hashes the `base...head` diff, the range the reviewer is shown. The gate records `lastApprovedPatchId` beside `lastApprovedHead` and reuses the approval after the build pre-check ran on the new tree. Deltas: `git patch-id --verbatim` (not `--stable`, which ignores whitespace-only changes) with `--binary --no-ext-diff --no-textconv` on the diff; src/state.ts clears the patch-id once a change lands, so a later identical patch is reviewed again.

### Land-queue speed 3c — One writer to main: route leftover recovery through the land queue (planned 2026-09-23, requested by user; split from 3/3 into its own entry 2026-09-23, done 2026-09-24)

**Status 2026-09-24 (partly delivered by the BUGS.md sweep):** the land-batch backstop landed with the `merge_blocked` race fix (3073644). A batch that loses the fast-forward re-stacks onto the new tip and re-checks, at most `BATCH_RESTACK_ATTEMPTS` (2) times, and skips the re-check when main gained only exempt paths. Still to do: routing leftover recovery through the land queue, the one-writer half. That fix's Fix paragraph in BUGS.md records why it was left out.

**Why.** `recoverLeftover` (src/leftover.ts:45, called from the tick at src/loop.ts:510) lands inside the tick through `landChange`, racing the orchestrator's slot — the extra writer to main is what turned two batches (2026-09-22 12:44 and 13:12) into wholesale `merge_blocked` (BUGS.md's "A batch whose base main moves during its build check is discarded wholesale" entry).

**Approach.**
- src/leftover.ts — when recovery finds an unlanded pin, enqueue it (`enqueueLanding`, src/land-queue.ts:23; the entry carries the pin's sha, with summary and body read back from the commit message the way the recovery path reconstructs them today) and end the tick `queued`, exactly like a fresh changed tick. The land-queue interlock then holds the role until it lands, and main has exactly one writer.
- src/land-batch.ts — backstop for human commits: when `ffStackToMain` (src/merge.ts:293) fails because main moved since `base` (the `merge_blocked` marking at :249), re-stack the same shas onto the new tip once and re-run the batch check, instead of marking the whole stack `merge_blocked`.
- README.md — the leftover-recovery paragraph says recovery landings go through the land queue.

**Files touched.** src/leftover.ts, src/land-queue.ts (reuse only), src/loop.ts, src/merge.ts, src/land-batch.ts, README.md, test/leftover.test.ts, test/lander.test.ts.

**Acceptance criteria.**
- A tick whose role has a leftover pin produces a `land_queued` event and no in-tick `merged`.
- A batch whose main moves during its check (a test commit landed mid-check) re-stacks once and lands, with one extra check event and no `merge_blocked`.

**Series.** Sibling of 3a, 3b, 3d, 3e — independent, any order.

**Implemented 2026-09-24** in 3206c2e. All criteria are met; the re-stack backstop was already in (3073644). `recoverLeftover` enqueues the pin with its summary, body and high-friction flag read back from the commit message, or reports `already_queued`, and the tick ends `queued` with no in-tick landing. Deltas: a leftover that cannot be pinned fails the tick instead of landing unpinned; a re-queued pin whose last landing failed retriably still feeds the error streak (`recoveryFailure`); the fallback breaker ignores recovery ticks (`TickOutcome.recoveredLeftover`). A pin that keeps failing non-terminally, such as a repeated `merge_conflict`, now keeps its role re-queuing instead of being dropped by the next authored commit; 62db693 caps that at `MERGE_CONFLICT_LIMIT` (3) consecutive conflicts of one pinned sha, after which recovery discards the pin and the role's next prompt says so.

### Land-queue speed 3d — When a batch check is red, land the largest passing prefix (planned 2026-09-23, requested by user; split from 3/3 into its own entry 2026-09-23, done 2026-09-24)

**Why.** Today a red scope-`batch` check abandons to one-at-a-time landing (src/land-batch.ts:253), re-gating every change — one broken change in a stack of N costs N full gates, all inside the one landing slot.

**Approach.**
- src/land-batch.ts — replace the abandon at :253 with a bisect in queue order: check the first half of the remaining stack; land the longest passing prefix with one ff (the same in-lock invariant as the full-stack ff — nothing rewrites between the check and the ff); split the remainder and continue. When a single change fails, consult `checkMainBaseline` (src/main-baseline.ts:125): main green → reject that change with the check's reasons (deterministic, no pi run); main red → keep its pin for a re-land after main moves green (the same attribution rule 1/3 gives the gate).
- Without 2a in place, an already-reviewed prefix still re-reviews once on the prefix ff — acceptable; 2a removes it. No dependency on landing order.
- Tests: test/lander.test.ts (which owns the `ffStackToMain` batch coverage) gains the prefix case.

**Files touched.** src/land-batch.ts, src/main-baseline.ts (reuse only), test/lander.test.ts.

**Acceptance criteria.**
- A stack of 3 whose second change breaks the check lands change 1, rejects change 2 with the check's output, and lands or re-queues change 3 — 2–3 check runs in total and zero reviewer runs for the changes that pass.
- A stack whose every change passes still takes exactly one batch check.

**Series.** Sibling of 3a, 3b, 3c, 3e — independent, any order. Pairs well with 2a but does not depend on it.

**Implemented 2026-09-24** in c35f78c. All criteria are met. After a red scope-`batch` check, `landStack` checks the first half of that stack, lands the longest passing prefix with one ff, and repeats on the remainder. A single change red on its own goes to `attributeRedChange`: main green rejects it with the check's reasons (no pi run), main red returns `main_red` with the pin kept, and no baseline rejects saying so. Changes after a rejected one are left for the next drain. Deltas: the baseline is checked in the batch's own worktree, not the redeploy mirror; a throw after the first stack attempt becomes `error` on that step's head change, so prefixes already on main keep `changed`.

### Land-queue speed 2b — One process-wide cap on concurrent build checks: `maxConcurrentChecks` (planned 2026-09-23, split from 2/3 into its own entry 2026-09-26, done 2026-09-24)

**Why.** Nothing today bounds how many full check suites run at once: a burst of landings can already stack suites on the same host next to the authors' own test runs, and this suite has load-sensitive tests (BUGS.md's fixed "load-sensitive live-orchestrator test" entry, 2026-09-22). The cap is independently useful and landable, and parallel vetting (2c) would otherwise multiply the problem.

**Approach.**
- src/config.ts — `maxConcurrentChecks: 2` default beside `landBatchMax` (:38).
- src/config-validation.ts — validate it as a positive integer beside `maxConcurrent`/`landBatchMax` (:264–265), named key on failure.
- src/build-check.ts — a module-level `Semaphore` (src/semaphore.ts's exported class) acquired around the run inside `runScopedBuildCheck` (:420) and released in a finally; sized from the live config at call time so it hot-reloads with tumwater.json. Export it, and have src/main-baseline.ts's `checkMainBaseline` (:125) — which runs the suite directly, not through `runScopedBuildCheck` — acquire the same one.
- README.md — document `maxConcurrentChecks` beside `maxConcurrent`.

**Files touched.** src/config.ts, src/config-validation.ts, src/build-check.ts, src/main-baseline.ts, README.md, test/config-validation.test.ts, test/build-check.test.ts.

**Acceptance criteria.**
- At the default 2, a third concurrent check starts only after one of the first two finishes (timing assertion with generous slack, the orchestrator-test style); a check that fails or times out still releases its permit.
- `maxConcurrentChecks: 0` and negatives are rejected by config validation with a named key.
- Existing tests' event sequences are unchanged (the default cap is above anything current tests run concurrently).

**Series.** Sibling of 2a, 2c, 2d. No dependency; land before 2c.

**Implemented 2026-09-24** in 16e25b1. All criteria are met. `withCheckPermit` in src/build-check.ts holds one permit from a process-wide `Semaphore` around every scoped check (both attempts of the killed-check retry share it) and around `checkMainBaseline`'s one in-flight run per SHA; it resizes from the caller's live config before each acquire and releases in a finally. Deltas from the written approach: the helper is exported instead of the raw semaphore; landing and batch checks (which run inside the merge lock) are granted the next free permit ahead of queued gate and baseline checks; a nested request runs under the permit already held, so no path can deadlock at a cap of 1. The key is documented in docs/how-it-works.md (the README no longer carries the config reference), and its validation tests live in test/config.test.ts.

- Land-queue speed 3e — Optional cheaper per-change gate check; the full suite runs once per stack (planned 2026-09-23, done 2026-09-24; commit 46c0bde)
- Land-queue speed 3a — Give the reviewer its own time budget (planned 2026-09-23, done 2026-09-24; commit 376547d)
- 7b/7 — `tumwater init --adopt` and `--dry-run`: adopt an existing repo without touching its README (planned 2026-09-23, done 2026-09-24; commit 063d9b4)
- Give every failure an automated trace: retire the recurring `no-observability` validation gap (planned 2026-09-26, done 2026-09-24; commit 199ed60)
- Land-queue speed 2d — Per-change landing markers so the dashboards show what is really happening (planned 2026-09-23, done 2026-09-24; commits 127157a, 95f848c)
- Land-queue speed 3b — Tell the reviewer, as a rule, not to re-run a verified suite (planned 2026-09-23, done 2026-09-24; commit 07d205e)
- 7a/7 — Resolve the project brief as `TUMWATER.md`, with README.md as the compatibility path (planned 2026-09-23, done 2026-09-23; commit 3be47ac)
- Wake and abort from the GUI dashboard (planned 2026-09-25, done 2026-09-23; commit d947041)
- 6/7 — Make the project's verification command configurable (planned 2026-09-14, done 2026-09-25; commit 4924a54)
- Optional shared-token auth for the GUI dashboard — `gui --token <secret>` (planned 2026-09-23, done 2026-09-23; commit 66c5af0)
- Cost by role in the usage report (planned 2026-09-25, done 2026-09-23; commit 6e1bf39)
- Bound tool output head+tail with a tumwater pi extension (planned 2026-09-23, done 2026-09-24; commit d964507)
- Tell ticks to fan out independent tool calls in one turn (planned 2026-09-23, done 2026-09-23; commit 449985c)
- 5/7 — Make the agent binary configurable (planned 2026-09-14, done 2026-09-24; commit ff4beee)
- 4b/7 — Untrack this repo's own config without deleting it (planned 2026-09-14, done 2026-09-22; commit 48b3474)
- 4a/7 — Seed an untracked config from a tracked template (planned 2026-09-14, done 2026-09-22; commit 0733811)
- 3/7 — Harness-mediated config writes: take custom loops off the commit path (planned 2026-09-14, done 2026-09-23; commit 726e3cc)
- 2/7 — Resolve the repo root, and target any branch (planned 2026-09-14, done 2026-09-22; commit c033ad1)
- Fix a failed landing build check on the spot instead of rejecting (planned 2026-09-21, done 2026-09-23; commit 4803c07)
- Landing gate checks latest main: rebase the pinned change before the build pre-check (planned 2026-09-21, done 2026-09-21; commit f0993fc)
- 1/7 — GitHub Actions CI and a publishable npm package (planned 2026-09-14, done 2026-09-21; commit e6a4228)

- 4c/7 — Move README's rig notes into docs/backends.md (planned 2026-09-14, done 2026-09-21; commit dfa6d26)
- TUI failures pane — the failure digest in the Ctrl+T cycle (planned 2026-09-20, done 2026-09-21; commit c92c549)
- Fleet pause from the dashboard — a click-to-pause control in the GUI header (planned 2026-09-20, done 2026-09-21; commit f265dd7)

- Human-friendly numbers in the report tab's chart labels (planned 2026-09-20, done 2026-09-21; commit 6926014)
- Failure digest in the GUI — a `failures` tab beside `report` (planned 2026-09-19, done 2026-09-19; commit d4d734e)
- Live config-change event — surface what a tumwater.json edit changed (planned 2026-09-19, done 2026-09-19; commit 1767778)
- Red-main handoff — point the bugfix loop at the failing suite when main is red (planned 2026-09-19, done 2026-09-19; commit cfac056)
- Repair traces — record what made each bug hard to validate (planned 2026-09-17, done 2026-09-19; commit 794e170)
- Show the exact prompt each run received — `tumwater logs --role <id> --prompt` (planned 2026-09-19, done 2026-09-19; commit 30f3124)
- Observer roles 2/2 — a flow-coverage ledger so `qa` can rotate (planned 2026-09-17, done 2026-09-19; commit 492cbeb)
- Feature loop hands oversized plans to the plan loop instead of splitting them inline (planned 2026-09-18, done 2026-09-19; commit ac97ec6)
- Telemetry 2/2 — a `telemetry` role that reads the digest and files bugs (planned 2026-09-17, done 2026-09-19; commit 24ded35)
- Telemetry 1/2 — a deterministic failure digest over the fleet's own event log (planned 2026-09-17, done 2026-09-18; commit 39dfc33)
- Observer roles 1/2 — stop scheduling a passing check as an idle tick (planned 2026-09-17, done 2026-09-18; commit c1ad951)
- TUI/GUI auto-reload when a newer build lands on disk (planned 2026-09-13, done 2026-09-18; commit 614ff78)
- Merge queue 5/5 — coalesce the build check across queued landings (planned 2026-09-08, done 2026-09-18; commit 8a3e6a1)
- Fallback model — keep working for free once the daily budget is spent (planned 2026-09-18, done 2026-09-18; commit 7ab1275)
- Merge queue 4/5 — surface the land queue on status and both dashboards (planned 2026-09-08, done 2026-09-15; commit 776fa0f)

- GUI report charts: show a label on each bar segment at the cursor on mouse hover (planned 2026-09-14, done 2026-09-15; commit b56c96f)
- Merge queue 3/5 — asynchronous landing via a durable land queue (planned 2026-09-08, done 2026-09-14; commit bdec4f1)
- Remove the per-loop tokens/sec column from the TUI/GUI tables (planned 2026-09-14, done 2026-09-14; commit b5180be)
- Merge queue 2/5 — land in a per-role detached worktree (planned 2026-09-08, done 2026-09-13; commit a90a1ac)

- Show per-loop token generation rate (5-minute moving average) in the TUI/GUI (planned 2026-09-08, done 2026-09-13; commit 8477f9b)
- User-defined loops 3/3 — dashboard identification: mark user-defined loops on both surfaces (planned 2026-09-07, done 2026-09-13; commit 332e072)
- User-defined loops 2/3 — director control surface: add/remove/rearrange from the prompt box (planned 2026-09-07, done 2026-09-12; commit 0b1db0a)
- User-defined loops 1/3 — config plumbing: `customLoops` in tumwater.json (planned 2026-09-07, done 2026-09-12; commit 7aaa69a)
- Show the GUI loop table's last tick with relative age — match the TUI's "· Nm ago" (planned 2026-09-11, done 2026-09-12; commit 8865aa8)
- Make the daily cost budget editable from the TUI/GUI (planned 2026-09-07, done 2026-09-12; commit e8bdd24)
- Sort the GUI loop table by state category, then last tick (planned 2026-09-09, done 2026-09-11; commit fafebbe)
- TUI "usage report" pane in the Ctrl+T cycle — report 3/3 (planned 2026-09-10, done 2026-09-11; commit dd32fc5)
- GUI "report" tab with SVG dashboard — report 2/3 (planned 2026-09-10, done 2026-09-10; commit 465f1f6)
- Usage report core + `tumwater report` CLI subcommand — report 1/3 (planned 2026-09-10, done 2026-09-10; commit 542e49a)
- Prioritize loops by need — defer unneeded maintenance ticks and order work roles first (planned 2026-09-08, done 2026-09-10; commits 1406be5, b2ddeb6)
- Merge queue 1/5 — landing takes a worktree and a ref (planned 2026-09-08, done 2026-09-08; commit 8665dca)
- Label review-gate runs in loop transcripts (planned 2026-09-07, done 2026-09-08; commit 7730bb1)
- Read backlog entries in full from the TUI/GUI dashboards (planned 2026-09-05, done 2026-09-07; commits 2c85ea4, 1a5fff9)
- Fleet pause — `tumwater pause` / `tumwater resume` (planned 2026-09-05, done 2026-09-06; commits 9481eeb, 7c56ca1, b76fab1)
- Pre-flight environment check — `tumwater doctor` (planned 2026-09-05, done 2026-09-06; commits 784d487, be36b71)
- Machine-readable fleet state — `tumwater status --json` (planned 2026-09-05, done 2026-09-05; commit e46b811)
- Red-main baseline check — skip authoring runs while main is red (planned 2026-09-04, done 2026-09-05; commits 377cf0f, e7ef65c)
- Steward curation of BUGS.md's Fixed history — compress old fixed bugs to one-line records (planned 2026-09-04, done 2026-09-05; commit 24f39e2)
- Steward curation of PLANS.md's Done history — compress old done plans to one-line epitaphs (planned 2026-09-04, done 2026-09-04; commit 81c50a2)
- Section-aware tick reads — stop paying for history every tick (planned 2026-09-04, done 2026-09-04; commit 7516413)

- Bound README's status section — state, not log (planned 2026-09-03, done 2026-09-04; commit 9e00d29)
- Run the project's own test suite in the deterministic pre-merge gate (planned 2026-09-04, done 2026-09-04; commit 495570f)
- Abort a single loop's in-flight tick — `tumwater abort --role <id>` (planned 2026-09-03, done 2026-09-04; commits b37e600, 6b52731, 0d4c41b, 7a9fa8d, ff42635)
- Per-loop today spend — which loop is eating the day's budget (planned 2026-09-02, done 2026-09-03; commits c17893d, 02a8661)
- Steward role — whole-system judgment on a slow clock (planned 2026-08-24, done 2026-09-02; commits 6e3f487, be6dc56, bf42c98)
- Per-tick usage in the event feed — tokens and cost on every tick_end (planned 2026-09-02, done 2026-09-02; commit 3e4086a)
- Director inbox management — list and cancel queued prompts (planned 2026-09-01, done 2026-09-02; commits 53c0477, 349482e, 9c20312, da86dbd)
- Live sessionRetentionDays — re-prune old pi sessions without a restart (planned 2026-08-31, done 2026-09-02; commits eaa9848, 349482e, 157215f)
- Show queued director prompts in TUI/GUI (planned 2026-09-01, done 2026-09-01; commit 55af189)
- Live maxConcurrent — resize the concurrency cap without a restart (planned 2026-08-31, done 2026-09-01; commit af61b7e)
- Self-explaining commit bodies (planned 2026-08-24, done 2026-08-31; commits b41185d, 0f73491, d930959, 4021c1d)
- Daily cost budget — cap the fleet's autonomous spend (planned 2026-08-30, done 2026-08-31; commits 041fd55, 01c28ce, 07d5bf6, 2fbfb49, 92a4ffe, b589e09)
- The right to refuse, and friction as a signal (planned 2026-08-24, done 2026-08-30; commits c2f541a, 0326a2a, 82c7631, bc479b6, c477ce9, 7212a7e, 8e6eeae)
- Questions outbox — loops that know when to ask (planned 2026-08-24, done 2026-08-29; commits 2547b4d, 0294f45, 1a48edc, 931ca26)
- Adversarial review gate before merge (planned 2026-08-24, done 2026-08-29; commits 74224e9, 8ea49b8, 93d14f5, 038519a, 36b0adc, 50ef9eb)
- QA role — exercising the product like a user (planned 2026-08-24, done 2026-08-28; commit 6859e43)
- Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, done 2026-08-26; commit 9ef07d9)
- PRINCIPLES.md — positive design principles injected into every prompt (planned 2026-08-24, done 2026-08-26; commit abd2963)
- Show open bugs and planned features in the TUI/GUI (planned 2026-08-24, done 2026-08-26; commit 7023381)
- Show current work item per active loop in the GUI/TUI tables (planned 2026-08-25, done 2026-08-25; commit 39bfe9d)
- CLI subcommand to reset loop counters — ticks, commits, tokens, cost (planned 2026-08-25, done 2026-08-25; commit 5374aa5)
- Live-reload tumwater.json while the harness is running (planned 2026-08-23, done 2026-08-25; commit 82c7910)
- Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25; commit 52fcfa2)
- Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, done 2026-08-24; commit d36cb17)
- Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, done 2026-08-23; commit 48f45a1)
- Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21; commit 9ddd731)
- Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21; commit 3e002c9)
- Web GUI (done 2026-08-20; commit 2182085)
- pi-driven merge conflict resolution (done 2026-08-20; commit 2182085)
- Per-role model/effort overrides (done 2026-08-20; commit 2182085)
- Log rotation and session pruning (done 2026-08-20; commit 2182085)
