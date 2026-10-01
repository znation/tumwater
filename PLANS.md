# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### `tumwater prompt --list --json` — the queued-prompt listing as machine-readable data (planned 2026-09-30 by plan loop)

**Goal.** Every read command offers `--json` for scripts — `status`, `report`, `doctor`, `logs`,
`history`, `tick`, `diff`, `backlog`, `role` — but `prompt --list`, the inspection command that
shows what will be steered, prints prose only. A script that wants to react to queued prompts
(a watcher that cancels stale entries, an external dashboard) must parse numbered Markdown
lines. Give `prompt --list --json` a machine-readable payload of the same data the rendered
list prints, so the two can never disagree.

**Approach.**

- `src/cli-command-args.ts` — `parsePromptArgs`: add `{ names: ["--json"] }` to
  `PROMPT_FLAG_SPECS` (so `rejectEqualsForm` covers `--json=true`), allow the token in the
  unknown-flag loop, and fail `--json may only be given once` on a duplicate, matching the
  `--list`/`--cancel` rule. `--json` is valid only with `--list`: in enqueue and cancel mode
  fail with `--json only applies to --list` (it must never silently ride along as prompt
  text). In list mode, collect the `--json` indexes and pass them into the existing
  `failStrayArg` call's claimed set so `--list --json` does not read as a stray positional;
  the list-mode return gains `json: boolean`.
- `src/operator-commands.ts` — `cmdPrompt`'s list branch: build one payload and render both
  shapes from it, so prose and JSON share a source. New local `promptListPayload(root, role,
  validIds)`: the same traversal the render does today — director first via `queuedPrompts`,
  then the remaining `validIds` via `queuedRolePrompts`, empty queues skipped — returned flat
  as `{ prompts: [{ role: string, position: number, text: string }] }`, where `position` is
  the 1-based per-loop number the rendered list prints and `--cancel` consumes, and `text` is
  the full verbatim prompt (not `promptPreview`). Render the prose from the same array
  (group by `role`, print `${i + 1}. ${text}` per group, `nothing queued` when it is empty),
  and `sayJson` the payload under `--json` (an empty queue prints `{"prompts":[]}`, the
  `history --json` empty-rows precedent). Keep the branch's existing broken-config fallback
  (`knownRoleIdsCached`) untouched.
- `src/help.ts` — the `prompt --list` usage stanza names `--json` (`prompt --list [--json]`,
  one clause: "--json prints the {prompts} array as machine-readable data"); `helpTopic`
  derives from HELP, so no other sync work.
- Tests — `test/cli-prompt-queue.test.ts`: json output matches the rendered list's roles,
  per-loop positions, and full text for a mixed director+role queue; `--role <id> --json`
  scopes; empty queue prints `{"prompts":[]}`; enqueue/cancel with `--json` fail with the
  `--json only applies to --list` wording; `--json` twice fails. `test/cli-command-args.test.ts`:
  parser cases for the new flag (accept with --list, reject alone, reject with --cancel,
  duplicate, equals form).

**Acceptance criteria.**

- `tumwater prompt --list --json` exits 0 and prints exactly one JSON document whose `prompts`
  array holds every queued prompt — director first, then catalog order, empty queues omitted —
  with `position` values identical to the numbers the same command's prose render prints.
- `tumwater prompt --list --json --role <id>` scopes to that loop's queue; an unknown role
  still fails with `unknownRoleMessage`'s wording (unchanged).
- `tumwater prompt hello --json`, `tumwater prompt --cancel 1 --json`, and a duplicate
  `--json` all exit 1 with the error named above; `--json=true` is rejected as the equals form.
- `tumwater help prompt --list` shows the stanza naming `--json`.
- `npm run test` passes with the new cases in both test files.

**Size.** Three source files plus their tests, well under a hundred lines of change. One run,
no open design questions (the flat `{role, position, text}` shape is decided here; `--cancel`
gains no `--json` — it is a state change, like pause/wake, which print prose).

<!-- One more plan already in ## Planned would end a plan tick in TUMWATER_NOTHING_TO_DO -->

## Done

### Tick drill-down in the GUI History view: one row expands to that tick's event trail (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

**Goal.** The dashboard's History view (src/ui/gui-client-history.ts) shows the same one-line
rows the CLI does; the only path to a failed tick's causes is the loop drawer's live transcript.
Give each row an expandable detail card served by the same collector the CLI plan introduces, so
a click shows the tick's events (review verdict, build check, landing outcome) without leaving
the page.

**Approach.**
- New GET-data handler `GET /api/tick?role=<id>&tick=<n>` in src/ui/gui-endpoints.ts, shaped like
  the sibling GET handlers (the pre-parsed query, JSON body). It calls `readTickDetail` from
  `src/ui/tick-detail.ts` — the collector the CLI plan landed — and serves its payload plus
  `text`, the same payload through `renderTickDetail` pre-rendered server-side (the
  /api/transcript precedent, so the browser shows the CLI's exact rendering). Routed in
  src/ui/gui.ts beside the other GET-data routes.
- In gui-client-history's row rendering, a per-row details toggle button (the drawer's btn-sm
  control style, its own leading cell) expands an inline card beneath the row: the summary
  header and the formatted events, fetched on first expand and cached per role#tick until the
  view refetches. The card renderer branches explicitly on the entry's state — loading →
  error → ok — so the Loading… placeholder can never fall into the fetched path and read as an
  empty trail (an earlier attempt's review objection). The row's existing
  click-to-open-the-drawer behavior is unchanged: expansion is the button's alone
  (gui-client-boot's data-open handler skips data-tickdetail clicks).

**Files touched.** `src/ui/gui-endpoints.ts`, `src/ui/gui.ts` (the route),
`src/ui/gui-client-history.ts`, `src/ui/gui-client-boot.ts` (the one-line data-tickdetail
guard), `src/ui/gui-styles.ts` (the toggle and card styles), plus tests pinning the endpoint's
payload and its error cases in the GUI endpoint test's style and the card's states in the GUI
client history test's style.

**Acceptance criteria.**
- `GET /api/tick?role=bugfix&tick=3` serves the collector's payload (plus its pre-rendered
  text); a missing or unknown role and a missing or non-positive tick answer 400 naming the
  rule; a tick absent from the scan window answers 404 with the CLI's not-found wording —
  never a crash.
- A history row's toggle expands the detail card with that tick's events (the Loading…
  placeholder paints while the fetch is in flight); collapsing and re-expanding reuses the
  fetched card; a failed fetch renders the server's message; the drawer still opens on the row
  itself.
- `npm run test` passes with the new tests in the suite.

### `tumwater tick <role> <n>` — one completed tick's full event trail from the terminal (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

**Goal.** History renders each tick as one line (src/history-data.ts `TickRow`), and `tumwater
logs` filters only by role/grep/since — so when a tick reads "problem · 12m · $0.08" the operator
greps the raw event feed by hand to learn why. Add a read-only command that prints one tick's
whole event block: `tumwater tick <role> <n>` (the `loop` + `tick` number every event carries and
every history row names).

**Approach.**
- New `src/ui/tick-detail.ts`: `readTickDetail(root, role, tick)` reads a bounded window of the
  event log via `readEvents` (src/event-read.ts) with its own named scan cap (documented like
  history-data's `HISTORY_SCAN_MAX_EVENTS`), selects the events whose `loop` matches and whose
  `ts` falls inside the `tick_start`…`tick_end` pair with `tick === n` for that loop (so
  tick-less in-tick events — `review_verdict`, `build_check`, `warning` — are included, while
  other loops' events are excluded), and returns a `TickDetail` payload: role, tick, startTs,
  endTs (null while the tick is in flight or its end is lost to rotation), `durationMs` via
  `tickSpanMs`, result/tokens/costUsd from the `tick_end` event via `eventUsage`, and the events
  oldest-first. Pure collector, shared by the CLI and later by the GUI (see the sibling plan).
- A `renderTickDetail` in the same module prints a short summary header (result, duration,
  usage, commit sha when a `land_queued`/`landed` event carries one) and then each event through
  `formatEvent` (src/event-format.ts) — no new formatting of event bodies.
- `cmdTick` dispatched from a new `case "tick"` in src/cli.ts behind `requireReadyRepo`, shaped
  like `cmdHistory` (src/ui/history.ts): `rejectUnknownArgs` admits only `--json`; positional
  arity is exactly `<role> <n>` with `n` a positive integer. A tick with no events in the scan
  prints a not-found line and exits 0 (history's empty-output convention). `--json` prints the
  `TickDetail` payload as data.
- One stanza in src/help.ts's listing (the suggestion machinery derives from it).

**Files touched.** `src/ui/tick-detail.ts` (new), `src/cli.ts`, `src/help.ts`,
`test/tick-detail.test.ts` (new) — window bracketing (a neighbor loop's tick with the same
number contributes nothing), in-flight behavior, the `--json` shape, and the arg-error cases
alongside the existing cli arg-strictness tests.

**Acceptance criteria.**
- `tumwater tick bugfix 3` on a fixture log prints the tick's summary and exactly that loop's
  tick-3 events in ts order; a still-running tick prints its events so far marked in flight.
- `tumwater tick bugfix 3 --json` emits the payload with durationMs null on an unpaired tick.
- `tumwater tick` with a missing/unknown role, a non-positive or non-numeric `n`, an unknown
  flag, or stray extra args fails with usage naming the expected shape.
- `npm run test` passes with the new tests in the suite.

### `tumwater role <id>` — inspect one loop's standing prompt and resolved settings (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

**Goal.** Operators can steer a loop (`tumwater prompt --role <id>`, run it one-shot with `run --once --role`) and see its last tick (`status`, the GUI drawer), but nothing surfaces what a loop actually carries: its standing find prompt, the per-role `instructions` override from tumwater.json, its resolved provider/model with the fallback pair applied, and what its *next* tick's prompt will read like (including the reject-reject, discard, and cut-off notes and any queued per-role prompt). Debugging a misbehaving loop or aiming a targeted prompt means guessing. Add a read-only `tumwater role <id>` command that shows exactly that, with `--json` for scripts. Not a config knob — pure observability, so it stays inside the opinionated-defaults principle.

**Approach.**

1. Read-only prompt seam. src/inbox.ts: add `peekPrompt(root)` and `peekRolePrompt(root, role)` beside `dequeuePrompt`/`dequeueRolePrompt` — read the oldest queue file's full text (same reader, same order/race policy as `queuedRolePromptEntries`) and never unlink. src/tick-prompt.ts: add `preview?: boolean` to `TickPromptInput`; when set, `assembleTickPrompt` calls the peek functions instead of the dequeues, so a preview can never consume a queued prompt (the director's empty-inbox `null` path applies unchanged). The reject-reject / conflict-discard / cut-off notes already derive from `state`, which the caller loads read-only via `loadLoopState` (src/loop-state.ts).
2. Collector. New src/role-view.ts: `rolePayload(root, role, modelsPath?)` — the modelsPath test seam mirrors status-data.ts's `snapshot`. Resolves the loop: catalog entry via `roleById`, else `customRole` from `config.customLoops`; the director is allowed and special-cased (no find text; inbox count instead); unknown id exits 1 with `unknownRoleMessage` (src/roles.ts). Payload: id, title, custom flag, enabled (`enabledRoleIds`), paused (`pausedRoles`), tier (`roleTier`), resolved provider/model via `configForRole` (src/config-views.ts) plus `fallbackPair` when the budget gate engages it, `minTickIntervalSeconds`, the `instructions` override verbatim, and `nextPrompt` from `assembleTickPrompt({ root, config, role, state, preview: true })`. Every read degrades like `backlogPayload` does (missing files → empty), so the command works with the fleet stopped and never throws on a torn repo.
3. Renderer and CLI. New src/ui/role-report.ts: `renderRoleMarkdown(payload)`, following ui/backlog-report.ts's shape (payload thunk consumed by exactly one of the two branches). src/cli.ts: a `case "role"` follows the `backlog` case — no requireReadyRepo, `rejectUnknownArgs("role", args, [ROLE_FLAG])`, `sayJsonOrRender(args, thunk, renderRoleMarkdown)`. src/help.ts: one stanza in the listing.

**Landed as (2026-09-30, feature).** Two approach anchors moved during implementation, recorded so the entry matches the code: (1) the id is a positional (`tumwater role <id>`) with `--role <id>` also accepted (the flag spelling every other role-targeting command shares) — cli.ts peels the positional before `rejectUnknownArgs("role", rest, [ROLE_FLAG, {names: ["--json"]}])`, and both spellings at once fails with "give the role id once"; the unknown-role exit 1 lives in the collector (rolePayload throws `unknownRoleMessage`, the CLI's main catch prints it) rather than at the parse site. (2) The `modelsPath` test seam serves the payload's `fallbackFree` verdict (`fallbackModelFree` against pi's definitions — what makes the budget gate willing to engage the pair), consulted only when a fallback is configured; the pair itself comes from `fallbackPair` unchanged. Also as planned: the director resolves through a pseudo-Role with no find text, and the file list is exactly as written above.

**Files touched.** src/inbox.ts, src/tick-prompt.ts, src/role-view.ts (new), src/ui/role-report.ts (new), src/cli.ts, src/help.ts; tests under test/.

**Acceptance criteria.**

- `tumwater role <id>` prints title, enabled/paused state, resolved provider and model (naming the fallback pair when one is configured), the interval override if set, the instructions override if set, the find text verbatim (a custom loop's `task`), and the next tick's assembled prompt verbatim.
- A queued `tumwater prompt --role <id> <text>` survives a `role <id>` invocation and appears inside the previewed prompt — this is the test that proves the peek seam never consumes.
- `--json` prints the collector's payload as one JSON document (the payload the renderer consumes, not a parallel shape); an unknown role exits 1 printing `unknownRoleMessage`; the command works while the fleet is stopped, reading persisted state.
- Tests: the preview seam in test/tick-prompt.test.ts (preview leaves the queue intact; the real dequeue still consumes); the collector and renderer in a new test/role-view.test.ts; one CLI wiring case alongside the existing operator-command tests (test/cli-operators.test.ts's patterns).
- `npm run test` green.

### Operator notify hook: a configured shell command the harness runs when something needs a human (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

**Goal.** Everything the fleet does on its own — the daily budget pausing it (src/budget-gates.ts), the error-streak breaker pausing a role (src/streak-gate.ts), a change failing to land (src/landing-slot.ts), the self-redeploy being blocked (src/redeploy-policy.ts) — is recorded faithfully in events.jsonl and rendered on the dashboards, but all of it is pull-based: an operator who is not watching a TUI/GUI or tailing `tumwater logs` learns of a stalled fleet hours late. Give the harness a push channel: one configured shell command, `notify` in tumwater.json, that the orchestrator runs whenever one of a small, fixed set of notable events fires. One knob, an opinionated allowlist of event types, no per-event selection — a command that can post anywhere (a desktop notification, a webhook, a phone push) composes it with the environment the harness hands it.

**Approach.**

- **New module `src/notify.ts`** — `NOTIFY_EVENT_TYPES` and `newNotifier(root)` returning `{ update, dispose }`. The module owns the allowlist, the throttle, and the only spawn site:
  - **Fixed allowlist** — `NOTIFY_EVENT_TYPES = ["budget_paused", "role_streak_paused", "land_failed", "restart_blocked"] as const`: the four states where the fleet or one of its changes is stopped and only a human can act (spend cap hit with no free fallback, a breaker trip, a landing that did not land, a rebuild/restart that cannot proceed). Deliberately excluded: operator-initiated events (`fleet_paused`, `role_paused`, `wake` — the operator caused them), self-resolving holds (`rate_limit_hold`, `build_stale`), and per-change review outcomes (`review_rejected`/`review_failed` — a rejected change becomes a `land_failed` if it ends there).
  - **Throttle** — `NOTIFY_MIN_GAP_MS = 60_000`; a `Map<type, timestamp>` suppresses a second spawn of the same type within the gap, so a burst of `land_failed` events pages once, not once per landing.
  - **Spawn shape** — when the stored command is a non-empty string and the event's type is on the allowlist and passes the throttle: `spawn(cmd, [], { shell: true, env: { ...process.env, TUMWATER_EVENT_TYPE: ev.type, TUMWATER_EVENT_LOOP: ev.loop, TUMWATER_EVENT_MESSAGE: formatEvent(ev) }, stdio: "ignore", detached: true })`, then `.unref()` — fire-and-forget, never awaited from the poll loop. `formatEvent` (src/event-format.ts) gives the env var the exact line `tumwater logs` renders. An `error` event on the spawn (the shell itself could not start) logs one `warnEvent(root, "harness", ...)`; a nonzero exit is ignored. `"warning"` is not on the allowlist, so the warning can never recurse.
  - **Scope, stated in the module doc** — the notifier subscribes via `subscribeEvents` (src/events.ts), which only sees events THIS process logs. All four allowlist types are logged by the orchestrator's own process (budget-gates.ts, gate-polls.ts → streak-gate.ts, landing-slot.ts, redeploy-policy.ts), so nothing notable is missed; events appended by operator CLI commands go straight to the file and are out of scope by design.
- **Config plumbing** — `notify?: string` on `TumwaterConfig` in src/config-schema.ts beside `quietHours`, doc comment stating: a shell command run on notable fleet events (env vars `TUMWATER_EVENT_TYPE`, `TUMWATER_EVENT_LOOP`, `TUMWATER_EVENT_MESSAGE`); absent or empty string disables. src/config-validation.ts: add `"notify"` to `TOP_LEVEL_KEYS` and one block beside the `quietHours` block — must be a string when present, empty string allowed (= off). src/config-write.ts needs no new code: `setConfigKey` handles any `TOP_LEVEL_KEYS` member generically (the value JSON-parses or stays a literal string, which is what a shell command is), and the whole-candidate `validateConfig` covers the type.
- **Orchestrator wiring** — `const notifier = newNotifier(root)` before the scheduler loop in src/orchestrator.ts; `notifier.update(liveConfig)` immediately after the loop's `const liveConfig = liveReload.poll()`, so a live `config set notify` edit takes effect on the next poll with no restart; `notifier.dispose()` (the `subscribeEvents` unsubscribe) in the `finally` block beside the `orchestrator_stop` logEvent.
- **Docs** — one clause in README.md's settings paragraph ("Settings live in `tumwater.json`: … a `notify` shell command run when the fleet needs a human"), keeping the steward's list current; docs/how-it-works.md is not touched (the gate enumeration is unchanged — this is an observer, not a gate).

**Files touched.** src/notify.ts (new), src/config-schema.ts (one field), src/config-validation.ts (one key + one validation block), src/orchestrator.ts (three lines of wiring), README.md (one clause); tests: test/notify.test.ts (new).

**Acceptance criteria.**

1. With `notify` set to a command that appends its env to a temp file, a `budget_paused` event delivered through `subscribeEvents` spawns it exactly once, and the captured environment carries `TUMWATER_EVENT_TYPE=budget_paused`, `TUMWATER_EVENT_LOOP` equal to the event's loop, and a `TUMWATER_EVENT_MESSAGE` equal to `formatEvent`'s rendered line.
2. `tick_end`, `warning`, and `landed` events spawn nothing; with `notify` absent or an empty string, nothing spawns even for allowlisted types.
3. Two same-type notable events within `NOTIFY_MIN_GAP_MS` spawn once; after the gap the same type spawns again (throttle keyed per type, so a `budget_paused` never suppresses a later `land_failed`).
4. `validateConfig` rejects a non-string `notify` with an actionable message, accepts `""` and a command string, and `tumwater config set notify '<cmd>'` / `config get notify` round-trip it (membership in `TOP_LEVEL_KEYS`).
5. A notify command whose spawn fails does not throw out of the event listener: one `warning` event names the failure and the orchestrator keeps polling.
6. Setting `notify` live while a fake fleet runs takes effect on the next poll (the `update(liveConfig)` path), no restart.
7. `npm run test` passes with the new test file green.

### An error-streak circuit breaker: a loop that keeps failing gets paused, not just warned (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

**Goal.** A role whose ticks fail consecutively is warned at 3 (`ERROR_STREAK_WARN`, src/tick-outcome.ts) and the fleet-wide storm alarm names shared causes (src/error-storm.ts) — but both only *talk*. (Anchors corrected at implementation, 2026-09-30: the gate family's wiring moved from orchestrator.ts into src/gate-polls.ts's pollFleetGates, so the new gate wired there.) A single loop failing on its own cause (a broken worktree, a cursed task, a wrong per-role model) keeps ticking on the error ladder's 600 s max backoff forever, burning a model slot and spend on a loop that cannot succeed. Give the harness a third act-on-it gate beside the budget gate (src/budget-gates.ts) and the pause gates (src/pause-gates.ts): after `ERROR_STREAK_BREAKER = 10` consecutive failed ticks, the harness auto-pauses that role by writing it into the same per-role pause marker the operator's `tumwater pause --role` uses, so the scheduler's existing `pausedRolesSet.has(runner.role)` skip (src/orchestrator.ts) blocks new ticks with zero scheduler changes. The director is not exempt: a failing director cannot process prompts anyway, and one uniform rule needs no carve-out. `tumwater resume --role <id>` (or the dashboard's per-row toggle) lifts it, as today.

**Approach.**

- **Constant** — `ERROR_STREAK_BREAKER = 10` in src/tick-outcome.ts beside `ERROR_STREAK_WARN` (3). At the warn bar the failure is already clearly not transient; the ladder has doubled three times by tick 4, so 10 consecutive failures is ~45+ minutes of a role failing on the slowest rung — long enough to ride out genuine transience, short enough to act well before the hours-long storms the 2026-09-22 meltdown showed. One sensible default, no config knob.
- **New module `src/streak-gate.ts`** — sibling of pause-gates.ts/budget-gates.ts: `newStreakGateState()` and `pollStreakGate(root, state, runners, pausedRoles)`. The pure trip rule lives here (unit-testable without a fleet, like error-storm.ts's reducer); the module owns the only event emission. Per-role bookkeeping in the in-memory state, an `acked: Map<role, number>`:
  - **Trip**: for each runner whose `LoopState.consecutiveErrors` (via the same `r.state` pick pollErrorStorm uses) is ≥ `ERROR_STREAK_BREAKER + (acked.get(role) ?? 0)` and whose role is **not** in `pausedRoles`: call `pauseRole(root, role)` (src/fleet-state.ts — the shared marker, lock, and idempotence come free) and log one event `role_streak_paused` carrying `role`, `streak`, and `lastError`.
  - **Ack while paused**: every poll, for each role present in `pausedRoles`, set `acked` to its current streak. The marker itself is the ack carrier, so no separate resume detection is needed: after the operator resumes a breaker-paused role, re-tripping requires ten *more* consecutive failures, not one. This also covers the operator-paused-then-resumed failing role (no instant re-trip) and a harness restart mid-pause (state is lost; the marker freezes the ack on the first poll after restart).
  - A role whose streak resets to 0 through its own success needs no special case — the bar arithmetic simply never trips again until a fresh streak climbs to 10.
- **Orchestrator wiring** — one call beside `pollPauseGates` in the gate family's poll (src/gate-polls.ts, where the pause gate state is stepped; the anchor moved there after the plan was written): `pollStreakGate(root, streakGateState, runners, pausedRolesSet)`. The gate returns the roles it just paused and they fold into that poll's paused-roles view, so the scheduler blocks them on the very poll of the trip, not the next one. In-flight ticks finish; only new ticks are blocked, like every gate.
- **Event plumbing** — add `"role_streak_paused"` to the `HarnessEvent["type"]` union (src/events.ts) with a comment naming the trigger, and a renderer case in src/event-format.ts beside `role_paused`: `role <id> paused — 10 ticks failed in a row; fix the cause and resume it (tumwater resume --role <id>)`. Treated as routine-with-explanation like `rate_limit_hold`, not a `warning` — the pause IS the harness handling the failure.
- **Accepted behavior** (state it in the module doc, do not fix here): the dashboards' "failing tick after tick" alert (src/ui/fleet-alerts.ts) reads `consecutiveErrors` regardless of pause, so it keeps listing a breaker-paused role until the streak clears; the loop cell's paused badge explains why it is not ticking, and the `role_streak_paused` event tells the operator why.
- **Docs** — one sentence in docs/how-it-works.md's gate enumeration if it lists the fleet gates (the same list the pause-gates.ts doc comment points at).

**Files touched.** src/tick-outcome.ts (constant), src/streak-gate.ts (new), src/gate-polls.ts (one call site + state init; the anchor corrected from src/orchestrator.ts, whose gate wiring had moved into the family), src/events.ts (union entry), src/event-format.ts (renderer case), docs/how-it-works.md (one sentence); tests: test/streak-gate.test.ts (new) plus a renderer case in test/event-format.test.ts.

**Acceptance criteria.**

1. A runner state with `consecutiveErrors: 10` and a role absent from the paused-roles marker gets paused by one `pollStreakGate` call: `pauseRole` wrote the marker, exactly one `role_streak_paused` event (with role, streak, lastError) is in the log.
2. Repeated polls while the role stays paused log nothing more (idempotent), and a streak that keeps climbing while paused does not re-log or re-write the marker.
3. A streak of 9 does not trip; a streak that resets to 0 and climbs to 10 again trips normally.
4. After a trip at streak S, an operator resume (role removed from the marker) plus a poll does not re-trip until the streak reaches S + 10; an operator-paused failing role that is resumed does not trip on its pre-pause streak.
5. An orchestrator restart mid-pause logs nothing while the marker stands (the first poll re-acks), and if the operator had already resumed before the restart, a still-live streak ≥ 10 re-trips once (durable cause, one event).
6. The director's streak trips the breaker like any role's.
7. `npm run test` passes with the new test file green; the new event renders in `tumwater logs` output via the event-format case.

### Reject a change that files a new plan directly under `## Done` (planned 2026-09-30, done 2026-09-30) — part 4/4, the gate rule

**Goal.** Part 3/4 repairs a stranded plan after it lands; this part stops the most common
stranding from landing at all. The case is a change that ADDS a new PLANS.md entry and puts it
under `## Done` with no done date: a plan written into the wrong section, or a conflict
resolution that keeps both sides and puts the new plan on the Done side of a heading
(2026-09-25, `9eaae5ac`). Part 2/4's heading check cannot see this when the file has a single
`## Done`, because the heading set is unchanged.

**Evidence the rule is safe to enforce now (measured 2026-09-30).** Replaying the rule below
over all 390 versions of PLANS.md on main's first-parent history (`git log --first-parent
main -- PLANS.md`) fires on exactly one commit: `9eaae5ac`, the real stranding. A naive rule
("any `(planned …)` entry under Done without a done date") fires on 22 commits, 21 of them
false. Those false hits have two shapes, and the rule has to avoid both:
- **Wrapped headings.** The done date sits on the heading's second line (`(planned
  2026-09-02, done` / `2026-09-03)`). Join heading continuation lines first, with part 3/4's
  shared helper.
- **Legitimate moves under the older convention.** Through mid-September, entries were moved
  Planned → Done without adding a done date to the heading (e.g. `Pre-flight environment
  check — tumwater doctor (planned 2026-09-05)` at `cd31355e`). A move is not a stranding:
  the entry already existed on the base.

**Approach.**
- In src/backlog-structure.ts (from 2/4 and 3/4), add the rule to the gate-side check that
  part 2/4's `backlogStructureReason` runs, so both call sites get it with no new wiring.
  Those call sites are the review gate in src/review.ts (md-only and code diffs alike, as a
  deterministic `reject`) and `verifyLanding` in src/landing-merge.ts after the rebase
  (→ `merge_blocked` plus a `warning` event). The second one is the site that catches a
  conflict resolution. The rule applies to PLANS.md only. Reject when the head has a
  `### ` entry under `## Done` that meets all three conditions:
  (1) its joined heading metadata has a `(planned YYYY-MM-DD` parenthetical;
  (2) it has no `done YYYY-MM-DD`;
  (3) its key does not appear as a `### ` heading ANYWHERE in the base's PLANS.md (any
  section). The key is the heading text before its first ` (`, whitespace-normalized; this
  matches how `normalizeFixedHeading` in src/fix-claim.ts compares headings across a move.
  The reason names the entry and says to file it under `## Planned`, so the author's next
  tick (or a retry of the leftover) knows the one-line fix.
- The base is the diff's merge-base, the same one part 2/4 and `falseFixReason` use. A
  stacked batch where one change adds a plan and a later change stamps it done is then
  measured change by change, not against main's tip.
- Deliberately not gated: part 3/4's reverse case (a done-dated entry still under
  `## Planned`) and any pre-existing stranded entry. Both stay part 3/4's repair job, so an
  old mistake never blocks unrelated landings.

**Files touched.** src/backlog-structure.ts; test/backlog-structure.test.ts, plus one gate
test and one landing test next to part 2/4's.

**Acceptance criteria.**
- Unit: rejects a head that adds `### X (planned 2026-09-25)` directly under the only
  `## Done`. Passes all of these:
  - the same entry under `## Planned`;
  - a Planned → Done move whose heading keeps only its `(planned …)` date (the `cd31355e`
    shape);
  - a new entry under Done whose done date is on a wrapped second heading line;
  - a new entry filed directly as done (`(planned …, done …)`), as hand commits recording
    finished work do;
  - a heading inside a fenced block.
- Gate: an md-only plan-loop diff shaped like `9eaae5ac` is rejected with the reason and
  spends no pi run.
- Landing: in part 2/4's conflict fixture with ONE `## Done` heading on main, a fake resolver
  that places the branch's new plan below that heading makes `verifyLanding` refuse
  (merge_blocked) and log the warning; main is unchanged.
- The implementing tick re-runs the history replay once and records the hit count in its
  commit body's VERIFIED line. The expected hit is only `9eaae5ac`; a second hit means
  the rule is wrong, not that history has another stranding to excuse. This is a one-off
  check, not a suite test: it reads this repo's history, not a fixture.
- `npm run test` passes.

**Landed 2026-09-30 by feature.** The rule lives in `backlogStructureReason` (PLANS.md only),
so both call sites got it with no new wiring, as planned. Two notes for the record: the
part 2/4 duplicate fixture ("passes when the base already had the duplicate") previously
added a planned-only `### C` under Done — that entry now carries a done date, since the new
rule correctly rejects it; and the history replay over 402 first-parent commits fired on
exactly `9eaae5ac`, as expected.

### Backlog structure check at the review gate and the in-lock landing re-check (planned 2026-09-30, done 2026-09-30) — part 2/4, the backstop

**Goal.** A change that leaves PLANS.md, BUGS.md, or QUESTIONS.md with a duplicated or
dropped `## ` section heading must not reach main. Today nothing checks backlog structure.
The Planned reader in src/backlog.ts (`parseEntryDetails`) stops at the first `## `
heading, so extra Done headings parse cleanly, and the damage stays invisible until an entry
ends up on the wrong side of one. Markdown-only diffs skip both the build check and the model
reviewer (`isExemptDiff` over `config.review.exemptPaths`, default `*.md`), so the plan and
clean loops' landings get no structural check at all. On 2026-09-25 the malformed files
came from two paths: a feature commit's own edit (`52cbadd1`), and an md-only plan landing
whose conflict resolution added a third `## Done` (`9eaae5ac`). A check at the review gate
alone would have caught the first but not the second, because the conflict resolution
happens after the gate, inside the landing.

**Approach.** Follow the `falseFixReason` precedent (src/fix-claim.ts): a deterministic,
no-pi check that returns a rejection reason or nothing, called from the same two places.
- New module src/backlog-structure.ts exporting `backlogStructureReason(wt, mainBranch,
  files)`. It runs only when `files` includes PLANS.md, BUGS.md, or QUESTIONS.md. For each
  touched file it reads the `## ` headings (fence-aware, reusing backlog.ts's fence scanner
  (`fenceTracker` / `parseEntryDetails`) so a `## Done` quoted inside a code block is not a
  heading) on the tree being landed and on the diff's merge-base (the same base
  `falseFixReason` compares against). It returns a reason naming the file and the heading
  when:
  (a) any `## ` title appears more than once, or
  (b) a `## ` title present on the base is missing on the head.
  Do NOT hard-code the section names: the rule is "same heading set as the base, no
  duplicates", so a project whose BUGS.md adds `## Verified` (this repo's does) or a fresh
  repo seeded from src/init.ts's templates both pass unchanged. A base that already has a
  duplicate must not block unrelated edits forever: rule (a) fires only when the head's
  count for that title is greater than the base's (a change that removes a duplicate always
  passes).
- src/review.ts, the gate: call it on BOTH paths, for exempt (md-only) diffs next to
  `falseFixReason`, and for non-exempt diffs as a deterministic rejection before the build
  pre-check (no pi run spent), through the same `reject([...])` helper so the author's next
  tick sees the reason.
- src/landing-merge.ts `verifyLanding`: call it after the rebase on both branches (exempt
  and full check), before `runScopedBuildCheck`. A structural failure returns false
  (→ `merge_blocked`), like a false fix. Log a `warning` event naming the file and heading,
  so a conflict resolution that broke structure shows on the dashboards instead of reading
  as an unexplained block. Keep the existing early return for an unchanged rebase: that
  tree already passed the gate's check.
- Optional, same change if small: add a `tumwater doctor` line reporting a duplicated
  heading already present on main (src/doctor-checks.ts already has a fix-claims check to
  copy the shape from), so an existing malformed file is visible without waiting for the
  next edit to trip the gate.

**Files touched.** src/backlog-structure.ts (new), src/review.ts, src/landing-merge.ts,
optionally src/doctor-checks.ts; test/backlog-structure.test.ts (new), plus one gate test
and one landing test beside the existing false-fix ones.

**Acceptance criteria.**
- Unit: a PLANS.md head with two `## Done` headings where the base had one yields a reason
  naming `PLANS.md` and `## Done`; a head that drops `## Planned` yields one; a `## Done`
  inside a fenced block is ignored; a head whose base already had two `## Done` and still
  has two passes; a head that removes a duplicate passes; BUGS.md with `## Open` /
  `## Fixed` / `## Verified` unchanged passes.
- Gate: an md-only diff that duplicates `## Done` is rejected with that reason and spends
  no pi run; a code diff that does the same is rejected before the build pre-check runs.
- Landing: reproduce the 2026-09-25 shape in a fixture repo. The branch adds a plan under
  `## Planned`; main moves the only planned entry to Done by adding a `## Done` above it;
  the rebase conflicts and a fake conflict resolver keeps both sides. `verifyLanding`
  refuses (merge_blocked) and logs the warning; main is unchanged.
- `npm run test` passes; the existing false-fix gate and landing tests are unchanged.

### The build-stale alert's refresh icon becomes a button that forces a restart (planned 2026-09-30, done 2026-09-30)

**Goal.** In the GUI dashboard, the refresh icon on the stale-build alert — "The fleet runs an
old build: main is N ahead and the restart is blocked" (amber) and its sibling "main is N ahead
of the running build" (blue) — becomes an actual button; pressing it forces the fleet's
self-redeploy onto newer main now, instead of waiting out the 12 h restart cooldown or the
drain deferral.

**Semantics (pinned — nothing left open).** Forcing clears ONLY the cooldown deferral
(RESTART_COOLDOWN_MS measured from the last completed auto-restart). It never bypasses a
refusal: a red main verdict, a failed compile, a swap error, or a startup-gate boot problem
still blocks the episode as today (the `blockedHead`/`restartBlocked` path), and in-flight
ticks still drain through the ordinary drain window before the swap. A press when the build is
not stale writes nothing and reports that no restart is pending. With no fleet running, the
marker is written harmlessly and the reply says only a live fleet would apply it — the same
liveness contract `tumwater wake` states.

**Approach.**
1. `Redeployer` (src/redeploy-policy.ts): add `forceRestart()` — arm a forced flag the next
   `poll()` consults in the cooldown check (one flag, consumed by that poll: set
   `lastAutoRestartAt` to null semantics or clear the deferral branch) and log one
   `restart_forced` event through the existing `RedeployEvent` channel. No other state changes:
   verify-green, compile, drain, and swap all proceed through the existing episode machinery.
2. Marker transport, mirroring wake: src/paths.ts gains `restartRequestPath(root)` beside
   `wakeRequestPath` (`.tumwater/restart.json`); src/operator-intent.ts gains
   `requestRestart(root)` returning the confirmation string with the `markerApplyNote`
   liveness clause; src/operator-requests.ts gains `consumeRestartRequest(root, redeployer)`
   (call `forceRestart()` once, delete the marker, log the event); src/orchestrator.ts calls
   it in the marker-consumption block next to `consumeWakeRequest`.
3. Endpoint: src/ui/gui-endpoints.ts gains `handleRestart` shaped like `handleWake`
   (structured `{ ok, message }` / `{ ok: false, error }`); src/ui/gui.ts routes
   `POST /api/restart` behind the existing cross-origin gate with the other POST routes.
4. GUI client (src/ui/gui-client-fleet.ts, `renderAlerts`): when an alert's key is `build`
   and `d.build && d.build.stale`, wrap the alert's icon span (`ALERT_ICONS.build`, the
   refresh glyph) in a `<button type='button' class='alert-icon' data-act='restart'
   title='Restart onto the new build now'>` — the icon itself is the press target; no extra
   labeled action button, and the TUI's rendering of the same alerts is untouched. In
   src/ui/gui-client-boot.ts, dispatch `act === "restart"` through the existing
   `postJson`/flash flow to `POST /api/restart`.
5. Tests: test/redeploy.test.ts — a forced restart proceeds into verify/compile while the
   cooldown was deferring, and a forced restart still refuses on a blocked head; add these
   alongside the existing drain/cooldown tests, using the same injected seams they use.
   test/gui-endpoints.test.ts — POST /api/restart writes the marker and replies ok; the
   not-stale and no-fleet cases keep their stated reply shapes.

**Acceptance criteria.** With the fleet running an old build and the restart cooldown
pending, clicking the refresh icon in the dashboard's build-stale alert produces a
`restart_forced` event and the fleet verifies, compiles, drains, and swaps onto main's head
within one drain window; a red main still blocks with the existing blocked wording; a fresh
build's press changes nothing; `npm run test` passes with the new tests above.

**Landed as planned (2026-09-30).** Two small files beyond the approach's list: src/events.ts
gains the `restart_forced` event type, and src/ui/gui-styles.ts strips the native button chrome
from `button.alert-icon` so the press target reads as the same icon the other alerts render.

### Stranded-plan detection: the clean loop re-files an open plan sitting under `## Done` (planned 2026-09-30, done 2026-09-30) — part 3/4, the repair

**Goal.** Parts 1/4 and 2/4 stop a duplicated `## Done` heading from landing, but a plan can
be stranded without one. A conflict resolution or a misplaced insert can put a new
`### … (planned YYYY-MM-DD)` entry just below the file's single `## Done` heading, and the
set of `## ` headings is unchanged, so part 2's check passes it. The Planned reader
(`plannedPlanEntries`, src/backlog.ts) then never lists it: the dashboards, `tumwater
backlog`, and the plan loop's "two or more plans wait" rule all miss it. The feature loop only
finds it if it reads past `## Done`. On 2026-09-25 the timed-pause plan sat like this from
13:10 to 14:38. The clean loop repaired it (`b7ab97c7`), but only because it happened to
look, since its prompt is about code. The reverse case is the same kind of error: an entry
still under `## Planned` whose heading already carries a `done YYYY-MM-DD` was finished and
never moved, so the feature loop may implement it again. Make detection deterministic and
hand the repair to clean.

**Approach.**
- A pure detector, `strandedPlanEntries(md)`, in src/backlog-structure.ts (created by part
  2/4; if this part lands first, create the module here and part 2 adds to it). It is
  fence-aware through backlog.ts's `parseEntryDetails`, like every other backlog reader. It
  returns the `### ` headings of:
  (a) entries under `## Done` whose heading has a `(planned YYYY-MM-DD…)` parenthetical but
  no `done YYYY-MM-DD`;
  (b) entries under `## Planned` whose heading already carries `done YYYY-MM-DD`.
  Scope is PLANS.md only. This repo's PLANS.md satisfies both rules today; every retained
  Done heading carries a done date. BUGS.md does not: two retained Fixed-section headings
  lack a `fixed YYYY-MM-DD` suffix, so a BUGS.md version would misfire and is out of scope.
- src/tick-prompt.ts: for `role === "clean"`, read the primary checkout's PLANS.md (the
  same `root` the telemetry digest and qa coverage blocks read) and, when the detector
  returns anything, render a `<backlog-structure>` block listing each stranded heading with
  its current section. Pass it through a new optional `TickPromptInput` field in src/prompt.ts,
  following the `digest`/`coverage` precedent. An unreadable or clean file gives no block, so
  the prompt is unchanged in the common case.
- src/roles.ts, `clean` role `find` text: one sentence. When a `<backlog-structure>` block is
  present, that repair is this tick's ONE task: move each listed entry to the section its
  heading says it belongs in (cut and paste, under the existing heading, never adding a `## `
  heading), and change nothing else.
- `tumwater doctor` (src/doctor-checks.ts): a warn line naming each stranded heading on main,
  beside part 2/4's optional duplicate-heading line if that has landed, so an operator sees
  the state without waiting for a clean tick.
- Read each heading with its wrapped continuation lines joined. Many headings wrap their
  parenthetical onto a second line (`(planned 2026-09-02, done` / `2026-09-03)`), and
  `parseEntryDetails` titles keep only the first line, so matching titles alone reports those
  as missing a done date. `entryDates` in the same file already joins heading metadata up to
  the closing `)`; extract that join into a shared helper rather than writing a second one.
- Rejecting a stranding change at the gate is part 4/4, not this part.

**Files touched.** src/backlog-structure.ts (new or extended), src/tick-prompt.ts,
src/prompt.ts, src/roles.ts, src/doctor-checks.ts; test/backlog-structure.test.ts,
test/prompt.test.ts, one doctor test.

**Acceptance criteria.**
- Unit: a PLANS.md fixture that reproduces the 2026-09-25 shape (a `(planned 2026-09-25)`
  entry directly under the only `## Done`) yields that heading; a `(planned …, done …)` entry
  under Done yields nothing, and neither does one whose done date sits on a wrapped second
  heading line; an entry under Planned with a done date yields it; a stranded-looking
  heading inside a fenced block is ignored; this repo's current PLANS.md yields nothing.
- The clean tick's prompt carries the `<backlog-structure>` block when the fixture root is
  stranded and omits it otherwise; the clean `find` text names the block.
- `tumwater doctor` warns on the stranded fixture and is silent on a clean one.
- `npm run test` passes.

**Landed 2026-09-30 by feature.** This part landed before part 2/4, so
src/backlog-structure.ts was created here with the detector and the clean tick's block
renderer; part 2 adds its heading-set check to the same module. The shared join was
extracted from entryDates as `headingMetadata` (src/backlog.ts), whose callers now share it.

### Image drag-and-drop into the GUI composer: dropped or pasted images are saved beside the queued prompt and the prompt text points the loop at them (planned 2026-09-30, done 2026-09-30)

**Goal.** Dropping image files onto the "Tell the fleet what to do next…" textarea in the GUI (and pasting an image from the clipboard) attaches them to the queued prompt: each image is stored on disk and the prompt text gains one `[image attached: <absolute path>]` line per image, so the receiving loop's pi agent can view the file with its read tool (pi renders images). Works for both the director target and a per-role target. The CLI `tumwater prompt` stays text-only — out of scope.

**Approach.**

1. New module `src/inbox-attachments.ts`:
   - `PROMPT_IMAGE_EXTENSIONS: readonly string[]` = png, jpg, jpeg, gif, webp, bmp (exactly what pi's read tool renders); `PROMPT_IMAGE_MAX_BYTES = 5 * 1024 * 1024` per image; `PROMPT_IMAGES_MAX_COUNT = 4` per prompt.
   - `savePromptImages(root, role, images): { paths: string[] } | { problem: string }` — validates `images` (an array of `{ name, dataBase64 }`, at most `PROMPT_IMAGES_MAX_COUNT`, each name's extension in `PROMPT_IMAGE_EXTENSIONS`, each decoded size within `PROMPT_IMAGE_MAX_BYTES`), sanitizes each name to `[A-Za-z0-9._-]` (default `image.png`, basename only), and writes each file into `roleInboxDir(root, role)` with the **same stem as the queue file it will belong to**: the caller enqueues the prompt's `.md` with `queueFileName(...)` first, then images are written as `<stamp>-<seq>-<pid>.<ext>` beside it (image extensions never collide with the `.md` filter in `listQueueFiles`). Returns the absolute paths in order.
   - `imageReferenceLines(paths: string[]): string` — the text to append: `"\n\n"` then one `"[image attached: <absolute path>]"` line per path.
2. `src/ui/gui-endpoints.ts` — extend `handlePrompt` and `handlePromptRole` with an optional `images` body field: after `requirePromptText`, call `savePromptImages`; a `problem` answers 400 with that reason and writes nothing; success enqueues `text + imageReferenceLines(paths)` through the existing `submitPrompt` / `submitRolePromptAndWake`. The existing length rule (`promptLengthProblem`) applies to the final text including the reference lines — fine, they are short. `promptPreview` naturally shows the first reference line if the prompt is short; no change needed there.
3. Attachment cleanup: in `src/inbox.ts`'s `takeQueuedFile`, after removing the queue `.md`, also remove same-stem siblings in the same directory (any file whose name equals the `.md`'s stem plus an extension) — ENOENT-tolerant like `removeQueueFile`. This covers both dequeue (the loop's tick picks the prompt up) and cancel (`cancelQueuedFile`, `cancelRolePrompt`), so images never outlive their prompt.
4. `src/ui/http-body.ts` — raise `MAX_BODY_BYTES` from 64 KiB to `32 * 1024 * 1024` (32 MiB): 4 images × 5 MiB × ⁴⁄₃ base64 ≈ 27 MiB must fit one POST. The cap exists to bound memory on a local dashboard; update its comment to say so, and update any test pinning the old cap or the "body too large" message (grep test/ for `body too large`).
5. Client `src/ui/gui-client-fleet.ts`:
   - A single pending-image list shared across targets (not per-target like `drafts`), cleared only on a successful submit or manual removal.
   - `dragover` (preventDefault + a highlight class) / `drop` on `#prompt`, and a `paste` listener that collects `clipboardData.files` items whose type is an image; ignore anything that is not an image.
   - Render one chip per pending image (name, size, a remove ×) into a new `<div id="promptimages">` container inside `#promptform` in `src/ui/gui-page.ts`; an empty container stays hidden.
   - In the `promptform` submit handler: read each pending `File` as a data URL (`FileReader.readAsDataURL`, strip the `data:...;base64,` prefix), include them as `images: [{ name, dataBase64 }]` in the `sendPrompt` body (both `/api/prompt` and `/api/prompt-role`), clear the list only on success — a rejected submit keeps text and images so it can be fixed and resent, matching today's text behavior. Flash message names the attachment count when images rode along.

**Files touched:** `src/inbox-attachments.ts` (new), `src/inbox.ts`, `src/pending-prompt.ts`, `src/operator-intent.ts`, `src/ui/gui-endpoints.ts`, `src/ui/http-body.ts`, `src/ui/gui-client-fleet.ts`, `src/ui/gui-page.ts`, `src/ui/gui-styles.ts`, tests (`test/inbox-attachments.test.ts` new; `test/gui.test.ts` endpoint e2e; the old-cap-pinned 413 tests in `test/http-body.test.ts`, `test/gui-server.test.ts`, `test/gui-operator.test.ts`).

**Re-land 2026-09-30 by feature: the first attempt was rejected in review; two fixes ride in this landing.** (1) The client's pending-image entries are now a uniform `{ name, size, file }` record — the rejected version's `renderPromptImages` read `img.file.name` off entries that were raw `File`s and threw on every drop/paste. (2) Requeued prompts no longer carry dangling image references: `takeQueuedFile` removes an image with its prompt, so `PendingPrompt.requeueUnfulfilled` strips reference lines whose files are gone and records the loss in a note line the preview, `prompt --list`, and the next tick's agent all see. The endpoints also gained the one missing piece the first attempt needed to pass at all: a text-only POST (no `images` field) is distinct from an invalid one, and answers 200 instead of leaving the client hanging.

**Acceptance criteria.**

1. A POST to `/api/prompt` (or `/api/prompt-role`) with `images` writes each image beside the queue `.md` under the same stem, and the queued prompt's text ends with one `[image attached: <absolute path>]` line per image pointing at a file that exists on disk.
2. A non-image extension, more than `PROMPT_IMAGES_MAX_COUNT` images, a `dataBase64` that does not decode, or a decoded image over `PROMPT_IMAGE_MAX_BYTES` answers 400 naming the rule, with no queue file and no image written.
3. Dequeuing the prompt (unit-level: `dequeueRolePrompt`) and cancelling it (`cancelQueuedFile`) remove the `.md` **and** its same-stem image files; a vanished sibling is tolerated.
4. The 32 MiB body cap holds: an oversized body still answers 413 with the updated message; the existing per-endpoint 400/413 discipline is unchanged for text-only submits.
5. Client behavior (drop, paste, chips, clear-on-success, keep-on-failure) is implemented in the served client script and covered by the endpoint e2e for its server half; `npm run test` passes.

Sizing: one run — ~90 new lines in the new module, ~40 across the two endpoints/inbox, ~80 client, ~180 tests. No sub-plans needed.

### Land queue drawer: clicking the GUI sidebar's "Land queue" chip lists the queued changes (planned 2026-09-30, done 2026-09-30)

**Goal.** The GUI sidebar shows `Land queue N` (a row in the `statuschips` panel, `renderSidebar` in `src/ui/gui-client-fleet.ts`) whose only detail is a hover title naming the count and — sometimes — the one landing currently in flight. An operator cannot see WHAT is queued: which roles are waiting, what each change is, or how long each has sat in the queue. Clicking the chip opens the dashboard's detail drawer (the same sheet loops and backlog entries use) listing every queued change — position, role, summary, short sha, age — plus the in-flight landing when one is running.

**Approach.**

1. Server payload — `src/status-data.ts`: the snapshot already reads every queued entry each poll (`queuedLandings(root)` into `landings`, used only for `.length` and the in-flight cross-check) and `LandingEntry` already carries `role`, `sha`, `tick`, `summary`, `enqueuedAt`. Extend `StatusSnapshot.landQueue` with `entries: Array<{ role: string; sha: string; tick: number; summary: string; enqueuedAt: number }>` — filled from `landings` (shallow per-entry copies without the optional `body`/`highFriction`) only when `depth > 0`, absent when empty, exactly the `roleInboxPrompts` filling discipline (documented in the same doc comment). Zero extra reads per poll: the entries come from the listing pass the depth already pays for, and `landing-queue.ts`'s stat cache keeps unchanged files at one stat. `src/ui/status-payload.ts` passes `landQueue` through untouched — no change there.
2. Client drawer — `src/ui/gui-client-drawer.ts`: add a third drawer kind, `drawer = { kind: "landqueue" }` (the union comment on the `drawer` variable names the current two). New `openLandQueue()` / `toggleLandQueue()` mirroring `openEntry`/`toggleEntry` (no hash — like the entry drawer, the drawer is transient state, not a shareable view), a `renderLandQueueDrawer(d)` that paints `drawerhead` (kicker "Land queue", title `N changes`, a `Landing now: <role> — <summary> (<stage>)` pill from `landQueue.inFlight` when present) and `drawerbody` (one section per queued entry in payload order: position, `role` in mono, `summary`, `<sha.slice(0, 8)>` in mono, `fmtAgo(enqueuedAt)`; the existing `sec-head`/`note` markup the loop drawer uses) — and a `"landqueue"` case in `refreshDrawer()` so the open drawer repaints on each 1 s poll instead of going stale. Esc, the close button, and re-click all close it through the existing `closeDrawer`.
3. Click wiring — `src/ui/gui-client-fleet.ts`: the `Land queue N` row gets `data-action='landqueue'` (and `cursor:pointer` styling); the sidebar panel `#statuschips` gains a delegated click listener (the same pattern the backlog panel's `$("backlog").addEventListener("click", …)` already uses) that calls `toggleLandQueue()` when the click lands on that row. The row keeps its existing `landingTitle` tooltip.
4. Tests: `test/status.test.ts` (or its `test/status-fixtures.ts` helpers) asserts the new `landQueue.entries` shape — present with the queued roles/shas/summaries in queue order when entries are enqueued (use `enqueueLanding`), absent when the queue is empty, and absent-but-depth-N after entries drop. `test/cli-gui.test.ts` gets one e2e: enqueue a landing, GET the served page, and assert the `/api/status` payload's `entries` reach the client (the drawer rendering itself is client-side script — the endpoint e2e covers its server half, as the drag-and-drop plan's client behavior does).

**Files touched:** `src/status-data.ts` (~15 lines: type + fill + doc comment), `src/ui/gui-client-drawer.ts` (~70 lines), `src/ui/gui-client-fleet.ts` (~10 lines), `src/ui/gui-styles.ts` (pointer cursor for the clickable row, a line or two), tests (`test/status.test.ts`, `test/cli-gui.test.ts`, ~120 lines).

**Acceptance criteria.**

1. With entries enqueued, `/api/status`'s `landQueue.entries` lists each in queue order (oldest first) with `role`, `sha`, `summary`, `enqueuedAt`, and `tick`; with an empty queue the field is absent and `depth` is 0. The in-flight `inFlight` block is unchanged.
2. Clicking the sidebar's `Land queue N` chip opens the drawer listing every queued change (position, role, summary, short sha, age) and, while a landing runs, the in-flight change with its stage; the drawer refreshes on subsequent polls while open; Esc / close / re-click closes it; clicking any other sidebar row does not open it.
3. No extra per-poll reads are introduced beyond what the depth already costs (the entries ride the existing `queuedLandings` pass).
4. `npm run test` passes, including the new snapshot-shape and GUI e2e assertions.

Sizing: one run — ~95 lines across three client/server files plus styles, ~120 test lines. No sub-plans needed.

**Done 2026-09-30 by feature:** implemented as specified — `landQueue.entries` filled from the existing `queuedLandings` pass in `buildSnapshot` (shallow per-entry copies, absent when empty), the `landqueue` drawer kind with `openLandQueue`/`toggleLandQueue`/`renderLandQueueDrawer` and its `refreshDrawer` case, the `data-action='landqueue'` chip wired through a delegated `#statuschips` listener, and the pointer-cursor style. One addition inside the named files: `showDrawer` in gui-client-drawer.ts also clears `lastPaint["drawerbody"]` — the land-queue drawer is the first to paint `drawerbody` through `paintPanel`, so the paint cache must not outlive the body `showDrawer` writes directly. Snapshot-shape assertions extend the existing land-queue test in test/status.test.ts (two entries, order, shallow-copy fields, absent-when-empty) and test/cli-gui.test.ts gains the e2e asserting the served `/api/status` delivers both queued entries oldest first.

### Backlog moves cut and paste under the existing heading: prompt wording for feature, bugfix, and conflict resolution (planned 2026-09-30, done 2026-09-30) — part 1/4, the prompts

**Goal.** Stop loops from rewriting a backlog file's section headings when they move an entry.
On 2026-09-25 the feature loop's `run --once` commit `52cbadd1` marked its plan done by
rewriting the top of PLANS.md in place (`## Planned` / `### X` became `## Planned` /
`_None yet._` / `## Done` / `### X (…, done …)`) and never touched the existing `## Done`
further down. That left PLANS.md with two `## Done` headings. The next three feature commits
(`761af2b7`, `758e6de1`, `f91ed2b2`) repeated the shortcut, each adding one heading and
removing one, so the count stayed at two. Then the timed-pause plan's landing (`9eaae5ac`)
hit a rebase conflict. The conflict-resolution run stripped the markers and kept both
sides, so the new plan ended up after a Done entry, under the first `## Done`, and the
file had three `## Done` headings. The plan sat outside `## Planned` until the clean loop
re-filed it (`b7ab97c7`, 14:38). The root cause is the wording: the feature prompt says
"move it to a Done section with the date" and bugfix says "move it to a Fixed section".
Both read as "create a section", and nothing says the heading already exists.

**Approach.**
- src/roles.ts, `feature` role `find` text: replace "(move it to a Done section with the
  date)" with wording that says to cut the entry out of `## Planned`, paste it as the first
  entry under the file's existing `## Done` heading with the done date in its heading, and
  never add, remove, or rename a `## ` heading. When the moved entry was the last one under
  Planned, `## Planned` keeps a `_None yet._` placeholder. `grep -n '^## ' PLANS.md` should
  list the same headings before and after the edit.
- src/roles.ts, `bugfix` role `find` text: the same fix for "(move it to a Fixed section with
  the date)", naming `## Open` → the existing `## Fixed`.
- src/gate-prompts.ts `buildConflictPrompt`: add one rule for backlog files. When a
  conflicted file is PLANS.md, BUGS.md, or QUESTIONS.md, resolve section headings as
  structure, not text: the result keeps exactly one of each `## ` heading, and every
  `### ` entry sits under the section its own side put it in (a new plan stays under
  `## Planned` even when main's side moved entries around it). Keep this generic, e.g. "for
  markdown backlog files, the `## ` section headings are structure: never duplicate one" —
  the prompt must not grow file-specific branches for every name.
- Keep wording shared, not repeated: if the two role strings end up with the same
  sentence, extract a helper in src/role-guidance.ts (the home of `PLAN_SIZING` and the
  other shared role clauses) that takes the section names.

**Files touched.** src/roles.ts, src/gate-prompts.ts, possibly src/role-guidance.ts;
test/prompt.test.ts and test/gate-prompts.test.ts.

**Acceptance criteria.**
- The feature and bugfix prompts name the existing `## Done` / `## Fixed` heading and forbid
  adding a second one; neither says "a Done section" or "a Fixed section" anymore.
- `buildConflictPrompt` carries the backlog-heading rule; test/gate-prompts.test.ts pins it
  beside the existing "combining the intent of BOTH sides" assertion.
- test/prompt.test.ts pins the new feature and bugfix wording.
- `npm run test` passes.
- Part 2/4 (the deterministic check below) is the backstop; this part only makes the
  failure rarer, so it lands first and on its own.

**Done 2026-09-30 by feature:** the prompts landed as specified — a shared `backlogMoveGuidance(file, open, resolved)` helper in src/role-guidance.ts embedded by the feature and bugfix find texts, and the backlog-heading rule in `buildConflictPrompt` (src/gate-prompts.ts), pinned in test/prompt.test.ts and test/gate-prompts.test.ts. The acceptance criteria's "neither says 'a Done section' or 'a Fixed section'" holds for both find texts.

### GitHub CI on main builds the installable npm package and uploads it as a workflow artifact (planned 2026-09-30, done 2026-09-30)

**Goal.** Every push to `main` on GitHub produces a downloadable, installable package — the packed
npm tarball — attached to that CI run as a workflow artifact, so a user can grab the current state
of main without a tag release or npm publish.

**Approach.** Extend `.github/workflows/ci.yml` (currently a single `test` job) with a second job,
`package`, that runs only on pushes to main (`if: github.event_name == 'push' && github.ref ==
'refs/heads/main'`) and never on pull requests:

1. `actions/checkout@v4` + `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, matching
   `release.yml`'s pins (the release workflow is the house style for packaging steps).
2. `npm ci`.
3. `npm pack` — `prepack` already runs `npm run build` (`rm -rf dist && tsc && node
   scripts/stamp-build.mjs`), so the tarball always carries a freshly stamped `dist/`. Do NOT run the
   test suite in this job: the existing `test` job already gates the run, and duplicating it doubles
   CI minutes for no new signal.
4. Upload with `actions/upload-artifact@v4`: `name: tumwater-${{ github.sha }}` (the sha disambiguates
   artifacts across runs, which would otherwise collide on one name), `path: tumwater-*.tgz`,
   `retention-days: 30` (a main build is a moving target; release tarballs keep living on the releases
   page via `release.yml`).

Notes for the implementer:
- The job needs no git identity config (the suite's fixture commits only matter when tests run; the
  `test` job already sets one).
- Keep both jobs independent (no `needs:`) so a packaging failure cannot block the test report and
  vice versa; GitHub marks the run red either way.
- No new dependencies, no package.json changes — `files`/`bin` are already declared there and
  `prepack` is already wired.

**Files touched.** `.github/workflows/ci.yml` only.

**Acceptance criteria.**
- A push to main produces a workflow run containing a `package` job whose artifact is the packed
  tarball (one `.tgz`, name `tumwater-<version>-<sha>`), downloadable from the run page.
- Pull-request runs and pushes to non-main branches run only the `test` job — no artifact upload.
- The workflow YAML is valid (`node -e "…yaml check…"` is not available offline; verify by eyeballing
  structure against `release.yml` and running `npm pack` locally to confirm `prepack` produces
  `tumwater-<version>.tgz`).
- `npm run test` stays green (nothing in the suite can see this change, but the tick's gate still
  applies).

Implemented 2026-09-30 by the feature loop: added the `package` job to `.github/workflows/ci.yml` per the approach (push-to-main only, `node-version: 22` and `cache: npm` matching `release.yml`, `npm ci`, `npm pack`, `upload-artifact@v4` named `tumwater-${{ github.sha }}` with `retention-days: 30`); both jobs stay independent. Verified locally: `npm pack` produces `tumwater-0.1.0.tgz` through the `prepack` build, and `npm run test` is green (2427 tests).

### Quiet hours: surface the window on the dashboards (planned 2026-09-30, done 2026-09-30) — part 2/2, observability

**Goal.** Part 1/2's gate is invisible: an operator looking at `tumwater status`, the TUI, or the GUI during a quiet window sees idle loops but no reason. Surface the configured window and whether the fleet is inside it, the same way the pause and budget gates are surfaced.

**Approach (as landed).**
- src/status-data.ts: `StatusSnapshot` carries `quietHours` (the operator's own window string, trimmed, absent when unset or off) and `inQuietHours`, computed fresh per poll through a new `quietHoursStatus` helper in src/quiet-hours.ts — the same membership predicate the gate polls, so the dashboards and the hold cannot disagree. A malformed config value degrades with the whole config (configForStatus's last-known-good hold), so the badge never flashes off on one broken write.
- Renderers: a `quietBadge` in src/ui/badges.ts (beside `pauseBadge`, the header badges' one home) renders `· quiet until 07:00` while inside the window and `· quiet 23:00-07:00` otherwise; renderStatus appends it to the header after the pause badge. The active in-window indicator is a blue `quiet` alert in src/ui/fleet-alerts.ts — informational, no actions — which both the TUI's attention lines and the GUI's alerts band render through the shared `fleetAlerts`, the `paused` field's actual render precedent. The GUI's sidebar (gui-client-fleet.ts) adds a quiet chip from the payload's raw fields, and status-payload.ts ships `quietHours`/`inQuietHours` plus the preformatted `quietBadge`.
- src/help.ts: the `config` stanza now names `quietHours` among the settable keys.

**Files touched.** `src/quiet-hours.ts`, `src/status-data.ts`, `src/ui/badges.ts`, `src/ui/status-render.ts`, `src/ui/fleet-alerts.ts`, `src/ui/status-payload.ts`, `src/ui/gui-client-model.ts` (alert icon), `src/ui/gui-client-fleet.ts` (sidebar chip), `src/help.ts`, README's settings line; tests in `test/quiet-hours.test.ts`, `test/status-header.test.ts`, `test/fleet-alerts.test.ts`, `test/status.test.ts`, plus the `snapshotWith` fixture.

**Deviations from the entry as written.** The plan named `src/ui/tui-frame.ts` for the TUI, but the TUI owns no badge code of its own — it paints the shared header (status-render.ts) and alerts (fleet-alerts.ts), which now carry the field; the anchor was stale. The window/in-window derivation factored into `quietHoursStatus` in quiet-hours.ts rather than inline in status-data.ts, keeping the domain logic in one module. `help.ts` had no settable-key list to extend, so the `config` stanza gained one.

**Acceptance criteria.**
- `tumwater status` shows the configured window and, inside it, an active quiet-hours indicator naming the window end; with `quietHours` unset, output is byte-identical to today's (pinned: the header badge is empty without a window, and the fleet-alerts suite asserts no quiet alert outside the window).
- The TUI and GUI render the same field without layout regressions in the existing test fixtures (full suite green).
- Depends on part 1/2 (`quietHours.ts`'s `parseQuietHours`/`inQuietHours` and the config key) — landed 2026-09-30 (see Done); this part lands once that is the running build.

**Done 2026-09-30 by feature.**

### Quiet hours: a daily local-time window the fleet holds itself during (planned 2026-09-30, done 2026-09-30) — part 1/2, the gate

**Goal.** A fleet that runs 24/7 spends budget overnight on work nobody is awake to steer. Add a
config-driven daily window during which role loops start no new ticks, so an operator can set
`quietHours` once (e.g. `"23:00-07:00"`) and the fleet idles through it every night — the
operator pause's semantics on a schedule, without anyone typing `tumwater pause` at 23:00.

**Approach.**
- New `src/quiet-hours.ts`: `parseQuietHours(value: unknown)` returns `{ ok: true, window } | { ok: false, error }` (window null when off; minutes since local midnight otherwise) or an actionable error message; `inQuietHours(window, date)` decides membership for a `Date` in LOCAL time (a window that wraps midnight, `start > end`, spans across 00:00; `start === end` is a parse error, not a zero-length always-on window; same-day windows are half-open `[start, end)`); `pollQuietHoursGate(root, quietHours, state, now)` mirrors `pollPauseGates`'s edge-triggered shape — it logs exactly one `quiet_hours_started` / `quiet_hours_ended` event (`loop: "harness"`, carrying the window string) per crossing, holding the previous in-window boolean in `QuietHoursGateState` (in memory only; a restart mid-window logs one event on the first poll, like the pause gate). The config value is read fresh per poll, so a live edit applies on the next cycle.
- Config: the optional `quietHours?: string` key added to `TumwaterConfig` (src/config-schema.ts) and to `TOP_LEVEL_KEYS` (src/config-validation.ts); `validateConfig` rejects a non-string or a malformed value using `parseQuietHours`'s message (empty string means off). `checkQuietHours(value)` added to src/config-write.ts beside `checkDailyBudgetUsd`, wired into a new per-key validators map in `setConfigKey` so `tumwater config set quietHours "23:00-07:00"` (and the TUI/GUI editors that go through it) share one definition of valid.
- Orchestrator wiring: in src/orchestrator.ts's poll cycle the gate is polled next to `pollPauseGates` and its boolean folded into the same hold site that combines `userPaused || (gate === "paused" && !probeDue)` before `role !== DIRECTOR_ROLE` — the director is exempt exactly as under the budget gate and the operator pause (a human steering outranks a schedule); unlike the budget gate there is no probeDue exception, since a schedule is not probe-worthy. In-flight ticks finish; the gate sits before eligibility, so a tick due inside the window simply starts at window end. No change to the landing pipeline, the budget gate, or scheduling clocks.

**Files touched.** `src/quiet-hours.ts` (new), `src/config-schema.ts`, `src/config-validation.ts`, `src/config-write.ts`, `src/orchestrator.ts`, `src/events.ts` (the two event types), `test/quiet-hours.test.ts` (new), plus additions to `test/config-validation.test.ts` / `test/config-write.test.ts`.

**Acceptance criteria.**
- With `quietHours: "23:00-07:00"` in tumwater.json and the wall clock inside the window, idle role loops start no new ticks while the director keeps ticking; in-flight ticks run to completion.
- Exactly one `quiet_hours_started` event at window entry and one `quiet_hours_ended` at exit per crossing, even across many polls; a restart inside the window logs at most one event.
- A wrapping window (`23:00-07:00`) holds from 23:00 through 00:00 into 07:00; `start === end` and malformed strings fail `validateConfig` and `config set` with an actionable message; absent or empty `quietHours` changes no behavior.
- `npm run test` passes with the new `test/quiet-hours.test.ts` covering parse (valid/wrap/invalid), membership at the boundaries, and edge events.

**Done 2026-09-30 by feature.** One deviation from the plan as written: the director-exemption
criterion is covered at the orchestrator e2e tier (test/orchestrator-quiet-hours.e2e.test.ts —
roles blocked through the startup tick, the director ticking, exactly one event per crossing, a
live `config set quietHours ""` lifting the hold) rather than in the unit file, because the
exemption lives in the poll loop's hold predicate, which only a live orchestrator exercises; the
gating suite runs the unit file, the e2e tier runs the live slice. Part 2/2 (dashboards) remains
in Planned.

### `tumwater config get <key>` / `tumwater config set <key> <value>` — read and edit top-level settings from the terminal (planned 2026-09-30, done 2026-09-30)

**Goal.** Today the only ways to change a setting are hand-editing tumwater.json or the two
narrow in-harness editors (TUI Ctrl+B, GUI /api/budget — both just the budget cap, via
`setDailyBudgetUsd`). `tumwater config` is read-only (show the whole resolved config). Give the
operator a terminal way to read one value and write one top-level key, with the same
fresh-load → validate → atomic-write discipline the in-harness writers already use, so a typo
can never leave a broken or silently-ignored tumwater.json behind. The running fleet needs no
change: the live reload (`newLiveConfigReload` in src/config-live.ts) polls the file every ~2 s
and already picks up external edits.

**Approach.**
- src/config-validation.ts: export `TOP_LEVEL_KEYS` (currently a module-private constant used
  by the top-level `checkKnownKeys` call) so the CLI can name valid keys in its errors instead
  of hardcoding a second list.
- src/config-write.ts: extract the load/validate/write idiom `setDailyBudgetUsd` embodies into
  a small internal helper — fresh `loadConfig(root)` (stat cache bypassed on purpose), apply a
  mutation, `validateConfig`, `writeJsonAtomic(file, cfg, true)` — leaving the file untouched
  (and no tmp remnant) on any failure. Re-point `setDailyBudgetUsd` at the helper and add
  `setConfigKey(root, key, rawValue): { ok: true; oldValue: unknown } | { ok: false; error }`:
  the key must be a member of `TOP_LEVEL_KEYS` (else an error naming the valid keys — the same
  protection `checkKnownKeys` gives the file itself, so `config set modle x` cannot write a
  dead key); the value is `JSON.parse(rawValue)` when that parses, else the literal string (so
  `set maxDailyCostUsd 20` is the number 20 and `set model gpt-5` is the string "gpt-5"); then
  validate the whole merged config so a type mismatch (`set maxDailyCostUsd "20"`) fails with
  validateConfig's own message. Top-level keys only — nested sections (`roles`, `review`,
  `check`, `idleBackoff`, `fallbackModel`) stay file-edited; one op per run.
- src/operator-commands.ts: `cmdConfig(root, args)` dispatches — no args keeps today's
  whole-config JSON dump; `get <key>` prints `JSON.stringify(value)` of that key from the same
  resolved config (defaults merged in, exactly what the no-arg dump prints); `set <key> <value>`
  writes and prints one confirmation line naming the key and its new value; anything else fails
  with usage. Errors go through the standard `fail()`.
- src/cli.ts: the `config` case's `rejectUnknownArgs("config", args, [])` becomes subcommand
  arity checks (`get` takes exactly one arg, `set` exactly two); `requireReadyRepo` stays.
- src/help.ts: update the config line to the three forms.
- Tests: update test/cli-operators-fleet.test.ts's `config takes no flags…` test (now
  `config get`/`set` subcommand arg-shape cases + the help-table match) and add: a get/set
  roundtrip (`set minTickIntervalSeconds 45` then `get minTickIntervalSeconds` prints 45 and
  `loadConfig` sees it), an unknown-key set rejected with the valid-keys list and the file
  byte-identical afterward, a type-invalid set rejected with validateConfig's message and the
  file untouched, and `set model gpt-5` landing as the string. Unit cases for `setConfigKey`
  (JSON-vs-string parsing, untouched file on failure) in test/config-write.test.ts.

**Files touched:** src/config-validation.ts, src/config-write.ts, src/operator-commands.ts,
src/cli.ts, src/help.ts, test/cli-operators-fleet.test.ts, test/config-write.test.ts.

**Acceptance criteria.**
- `tumwater config get <key>` prints the resolved value as JSON; an unknown key exits 1 naming
  the valid keys.
- `tumwater config set <key> <value>` writes the parsed value to tumwater.json atomically,
  prints a confirmation, and a running fleet picks the change up on its next ~2 s config poll
  (no harness code changes needed).
- An unknown key or a value that fails `validateConfig` exits 1 with an actionable message and
  leaves tumwater.json byte-identical (no tmp remnant).
- Bare `tumwater config` behaves exactly as today; `npm run test` green including the updated
  arg-shape test.

Done 2026-09-30 by feature. As planned, plus one small shape note: `setConfigKey`'s success
value also carries the parsed value (`{ ok: true; value; oldValue }`) so `cmdConfig`'s
confirmation line names the parsed value exactly (`set model to "gpt-5"`), not the raw text.
The shared helper is `writeConfigMutation` in src/config-write.ts; `setDailyBudgetUsd` and
`setConfigKey` both sit on it.

### Hand in-flight fallback ticks back to the primary at `budget_resumed` (planned 2026-09-30, done 2026-09-30)

**Goal.** When local midnight reopens the budget, `pollBudgetGate` flips new ticks back to the primary, but a tick that started on the fallback keeps it until it ends ("In-flight ticks finish; only NEW ticks are gated", src/budget-gates.ts). On 2026-09-30, three ticks started under the 09-29 fallback held their permits on the slow local model after midnight: steward until 00:06, plan until 00:21, telemetry until 01:20 (a 12,588 s tick; that role's primary ticks take minutes). The fleet's fresh budget ran on no permits for the first 6 minutes (no role tick started between 00:00:01 and 00:06:01), one permit for the next 15, and two for the next hour, while oMLX stayed busy. The operator asked why oMLX was still running on a new day. Hand those ticks back: interrupt them resumably and let their next tick continue the same session on the primary.

**Approach.**
- src/loop.ts: capture the model a tick runs on. `runTick` already snapshots `cfg = configForRole(this.config, this.role)` at tick start; store its provider/model pair on the runner (transient, not persisted) and expose it (e.g. `tickModel(): { provider?: string; model?: string } | null`, null when no tick is running).
- src/loop.ts: add `handBackTick()` beside `abortTick()`. Same guard (`state.running`), but it aborts `tickAbort` without setting `userAborted`. So `finishAbortedTick` takes its shutdown branch (pi session and worktree edits kept) and `applyTickOutcome`'s `"aborted"` arm sets `resumePending` and `nextRunAt = now`, the path redeploy's drain already exercises. Give the resume its own cause so the bridge prompt tells the truth: add `"budget-resumed"` to `LoopState.resumeCause` and to src/prompt.ts's `ResumeCause`/`buildResumePrompt`. Suggested wording: your run was moved from the local fallback to the primary model; your session and edits are intact, so continue where you left off.
- src/budget-gates.ts: `BudgetGatePoll` gains `resumed: boolean`, true only on the poll whose transition logs `budget_resumed` (prevGate was `fallback` or `paused`, gate now `open`), plus the fallback pair it left (`fallbackPair(liveConfig)`, src/config-views.ts).
- src/orchestrator.ts: on a `resumed` poll, call `handBackTick()` on every non-director runner whose `tickModel()` equals that pair. Log one `budget_handback` event `{ roles, provider, model }` so the digest and `logs` explain the resulting aborted ticks. Landings (the orchestrator's slot runs) and the director are untouched.
- src/event-format.ts: render `budget_handback` in `logs`/the feed ("budget reopened: handed <roles> back to the primary").

**Files touched.** src/loop.ts, src/budget-gates.ts, src/orchestrator.ts, src/prompt.ts, src/event-format.ts, src/loop-state.ts and src/tick-outcome.ts (both spell the `resumeCause` union), test/budget-gates.test.ts, test/loop.test.ts (or the loop test file that covers abortTick), test/prompt.test.ts.

**Acceptance criteria.**
1. `pollBudgetGate` returns `resumed: true` on exactly the fallback→open (and paused→open) poll and `false` on every other poll, pinned in test/budget-gates.test.ts.
2. `handBackTick()` on a running loop ends its tick `aborted` with `resumePending: true`, `resumeCause: "budget-resumed"`, and the worktree's uncommitted edits intact. On an idle loop it is a no-op. The next tick passes `--continue` and the primary's `--provider/--model` (fake-pi argv capture).
3. The orchestrator hands back only runners whose captured tick model is the fallback pair: a tick started on the primary (or the director) keeps running. It logs one `budget_handback` naming them.
4. `buildResumePrompt(role, "budget-resumed")` names the model move; the existing causes' texts are unchanged.
5. Manual check before calling it done: continue a real oMLX-started session with `pi --continue --provider huggingface --model <primary>` once, to confirm pi carries the history across providers. If it cannot, say so in Done and fall back to a fresh tick (drop `--continue` for this cause).

Size: one run, ~120 lines of source plus ~6 tests. The gate change is pure. The runner method reuses the existing abort path.

Done 2026-09-30 by feature: implemented as planned. Deltas from the written approach: the
pair-matching predicate is a small exported pure helper, `tickOnPair`, in src/budget-gates.ts
(pinned in test/budget-gates.test.ts), so the orchestrator's handback wiring is one filter call;
the loop e2e landed in test/loop-5.test.ts (the file that covers abortTick) and the fleet-level
wiring is pinned end to end in test/orchestrator-budget.e2e.test.ts (in-flight fallback tick →
budget_handback naming the role and pair → resumably aborted → resume with `--continue` on the
budgeted pair), which the entry's files list did not name; test/event-format.test.ts pins the
`budget_handback` rendering and docs/how-it-works.md's fallback bullet names the handback.
Criterion 5's manual check — continuing a real oMLX-started session with the primary pair — was
NOT run: a harness tick never calls a real model (PRINCIPLES.md), and no oMLX backend is
guaranteed reachable here. The code keeps `--continue` for this cause (pi's session files are
provider-independent on disk); if a real handback ever shows pi refusing a cross-provider
continuation, the fallback is one line: map the "budget-resumed" cause to a fresh tick (skip
`--continue`) in runTick's resume decision, and record that here.

- `npm run test:coverage`: a coverage report through the suite's own runner, so coverage ticks stop hand-building raw `node --test` runs (planned 2026-09-30, done 2026-09-30; commit 09a2ceb5)
- `tumwater history --grep <text>` — the tick-table filter its sibling `logs --grep` already has (planned 2026-09-30, done 2026-09-30; commit 2ba41a49)
- `tumwater diff` fleet-wide — one line per loop holding pending work, no `--role` needed (planned 2026-09-29, done 2026-09-30; commit 402d02fb)

- `tumwater diff --role <id>` — show the change a loop holds: its branch's unlanded commits and its worktree's uncommitted edits (planned 2026-09-29, done 2026-09-29; commit ee4e8353)
- `tumwater history --since <duration>` — window-shaped tick history, completing the `--since` pattern (planned 2026-09-29, done 2026-09-29; commit e840f010)
- Windowed event reads span the rotation boundary: `readWindowEvents` continues into `events.jsonl.1` (planned 2026-09-29, done 2026-09-29; commit b6b8ce82)
- Count the landing slot's spend in the usage report: `landed`/`land_failed` usage folds into `tumwater report` totals, with a reviewer-and-conflict-resolution breakdown line (planned 2026-09-29, done 2026-09-29; commit 98b9c928)
- Fleet-wide backend-failure hold: extend the 429 storm hold to connection, 5xx, and model-load failures (planned 2026-09-29, done 2026-09-29; commit 5377e34d)
- Retire the README freshness stamp: `tumwater status` reports main's last green check (planned 2026-09-29, done 2026-09-29; commit e5cb99ab)
- Time and spend by outcome in the failure digest (planned 2026-09-29, done 2026-09-29; commit 5d50f981)
- Yield-scaled clocks: a search role whose recent ticks land nothing ticks less often (planned 2026-09-29, done 2026-09-29; commit 3f3f6dc7)
- Plan just in time: stop refining while plans wait, and anchor plans on symbols (planned 2026-09-29, done 2026-09-29; commit 9303f28c)
- Harness-attested suite counts: parse the gate check's `node --test` summary and hand it to the reviewer (planned 2026-09-29, done 2026-09-29; commit c2640c74)
- Bugfix defers like a maintenance role while BUGS.md has no open bugs (planned 2026-09-29, done 2026-09-29; commit 550f3bbd)
- A deterministic unused-export check in the suite (planned 2026-09-29, done 2026-09-29; commit 9a66e789)
- Cancel a queued prompt from the dashboard — the GUI's queued-prompts rows get a per-row cancel control, backed by a file-addressed `/api/prompt-cancel` (planned 2026-09-29, done 2026-09-29; commit 0d23f313)
- `tumwater doctor --json` — the pre-flight report as machine-readable data, finishing the scriptable-surface series (planned 2026-09-28, done 2026-09-29; commit bfb37aaf)
- `tumwater backlog --json` — the project backlog as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit 933d2bdf)
- `tumwater logs --json` — the event feed as machine-readable NDJSON, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit b87d724c)
- `tumwater history --json` — the per-tick history as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit 4aba2051)
- `tumwater report --json` — the usage report as machine-readable data, beside `status --json` (planned 2026-09-28, done 2026-09-28; commit ad5dfce4)
- GUI history tab — the dashboard shows the per-tick history `tumwater history` prints (planned 2026-09-28, done 2026-09-28; commit 495525f6)
- `logs --grep <text>` — show only the events whose type or rendered line matches (planned 2026-09-28, done 2026-09-28; commit 713835af)
- `report --since <duration>` — totals over a trailing window, not whole days (planned 2026-09-28, done 2026-09-28; commit 2060487d)
- `logs --since <duration>` — show the events of a time window, not a guess at a count (planned 2026-09-28, done 2026-09-28; commit e20948b4)

- Pause countdown — show when a timed pause auto-resumes (`status`/TUI header badge, GUI pause badge) (planned 2026-09-25, done 2026-09-28; commit 00cf2e98)
- `tumwater history [--role <id>] [-n N]` — one row per completed tick, newest first (planned 2026-09-28, done 2026-09-28; commit 5d0f978e)
- Timed pause — `tumwater pause [--role <id>] --for <duration>` auto-resumes (planned 2026-09-25, done 2026-09-28; commit 670fb0a1)

- Per-role prompts 2/2 — surface the per-role queue on the dashboards (planned 2026-09-25, done 2026-09-25; commit f91ed2b2)
- `tumwater run --once --role <id>` — one round scoped to a single role (planned 2026-09-25, done 2026-09-25; commit 758e6de1)
- Next-run visibility — show when each sleeping loop will tick again (`tumwater status`, TUI, GUI) (planned 2026-09-25, done 2026-09-25; commit ce24d771)
- Per-role prompts 1/2 — `tumwater prompt --role <id> <text...>`: steer one loop directly from the terminal (planned 2026-09-25, done 2026-09-25; commit 761af2b7)
- `tumwater run --once` — one full round of ticks (every enabled role once, landings drained), then exit (planned 2026-09-25, done 2026-09-25; commit 52cbadd1)
- `tumwater backlog` — read the project's planned features, open bugs, and open questions from the terminal (planned 2026-09-25, done 2026-09-25; commit 3251fd9a)
- TUI per-loop controls — pause/resume, abort, and wake the loop whose transcript you are viewing (planned 2026-09-25, done 2026-09-25; commit 84e17230)
- Per-role pause 2/2 — dashboard per-row pause toggle (planned 2026-09-25, done 2026-09-25; commit 568b7cc8)
- Per-role pause 1/2 — `tumwater pause --role <id>` / `resume --role <id>`: quiet one loop while the fleet keeps working (planned 2026-09-25, done 2026-09-25; commit 88903ade)
- `tumwater config` — print the effective merged config as JSON (planned 2026-09-25, done 2026-09-25; commit 4fa76fca)
- `tumwater stop` — stop a running fleet from another terminal (planned 2026-09-24, done 2026-09-25; commit 69568f58)
- Land-queue speed 2c — Split landing into a parallel vetting stage and a serial merge stage (planned 2026-09-23, done 2026-09-24; commit 84af95b)
- Land-queue speed 1/3 — Take the build-fix run out of the landing slot: retry a failed gate check once, then hand the failure to whoever caused it (planned 2026-09-23, done 2026-09-24; commits 4e9bf7f, 91ef22a)
- Land-queue speed 2a — Approvals survive a clean rebase: key them by patch-id, not sha (planned 2026-09-23, done 2026-09-24; commit 689a293)
- Land-queue speed 3c — One writer to main: route leftover recovery through the land queue (planned 2026-09-23, done 2026-09-24; commit 3206c2e)
- Land-queue speed 3d — When a batch check is red, land the largest passing prefix (planned 2026-09-23, done 2026-09-24; commit c35f78c)
- Land-queue speed 2b — One process-wide cap on concurrent build checks: `maxConcurrentChecks` (planned 2026-09-23, done 2026-09-24; commit 16e25b1)
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
- Live-reload tumwater.json while the harness is running (planned 2026-08-23, done 2026-08-25; commit 637b7f0)
- Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25; commit 52fcfa2)
- Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, done 2026-08-24; commit d36cb17)
- Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, done 2026-08-23; commit 48f45a1)
- Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21; commit 9ddd731)
- Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21; commit 3e002c9)
- Web GUI (done 2026-08-20; commit 2182085)
- pi-driven merge conflict resolution (done 2026-08-20; commit 2182085)
- Per-role model/effort overrides (done 2026-08-20; commit 2182085)
- Log rotation and session pruning (done 2026-08-20; commit 2182085)
