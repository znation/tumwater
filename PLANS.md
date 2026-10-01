# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

<!-- One more plan already in ## Planned would end a plan tick in TUMWATER_NOTHING_TO_DO -->

### The dashboard speaks when the fleet needs you: a synthesized audio cue on a new needs-you alert, with a mute toggle (planned 2026-10-01 by plan loop)

**Goal.** The dashboard's alerts band (src/ui/gui-client-fleet.ts's `renderFleet`, the `// alerts ----`
section fed by `pageAlerts` in src/ui/gui-client-model.ts) already computes exactly which entries
need a human — `needsYou(alerts)` counts the red/amber/indigo ones — but an operator with the page
open in a background tab learns of a failing loop, a red main, or a spent budget only when they
look. Play a short synthesized cue the first time a new needs-you alert appears, with a mute
toggle persisted across sessions. Client-side only: Web Audio is a browser built-in, so this
keeps the zero-runtime-dependencies principle intact (design sketch: docs/feature-gui-audio-sound-effects.md;
this plan scopes that doc's sound set down to the alerts cue — the one moment the fleet genuinely
needs a human — and leaves tick-complete/landed cues for a possible follow-up).

**Approach.**
1. **src/ui/gui-client-sound.ts (new):** export `GUI_CLIENT_SOUND_JS`, a String.raw module spliced
   into the `GUI_CLIENT_JS` array in src/ui/gui-client.ts (before `GUI_CLIENT_BOOT_JS`), delimited
   by `// sound:start` / `// sound:end` region markers so clientScope can test it like the other
   modules. Contents: (a) `soundMuted` read once via the existing `recall("sound")` helper
   (gui-client.ts's CORE_JS already ships `store`/`recall` localStorage wrappers) — default
   unmuted; (b) `armAudio()`, called on the first pointerdown/keydown (the boot module wires the
   one-time document listener) which lazily creates the `AudioContext` — autoplay policies keep
   the page silent until the operator's first gesture, and a browser without AudioContext leaves
   `armAudio` a no-op so the page never throws; (c) `playAlertCue(tone)`, a short oscillator
   envelope distinct per tone (red: two beeps, amber: one, indigo: soft low), rate-limited to one
   cue per 2 s so an alert storm cannot become noise.
2. **src/ui/gui-client-model.ts:** a pure `newNeedsYouKeys(prev, next)` helper — the set of alert
   keys with a needs-you tone present in `next` but not `prev` — so the poll diff is testable
   headless. `pageAlerts` already stamps each alert with a stable `key`.
3. **src/ui/gui-client-fleet.ts, `renderFleet`:** after computing `alerts`, diff the needs-you keys
   against the previous poll's set (a `lastNeedsYouKeys` module variable alongside `lastStatus` in
   gui-client.ts's CORE_JS state block) and call `playAlertCue` with the new alert's tone when the
   diff is nonempty, audio is armed, and sound is unmuted. First poll diffing against an empty
   previous set is fine — a page opened onto an already-alerting fleet chirps once; the muted or
   never-gestured case stays silent.
4. **src/ui/gui-client-operator.ts:** a `soundControlHtml()` beside `pauseControlHtml` — a small
   masthead button (id `soundtoggle`) whose label/title flips between the muted and unmuted icon,
   persisting via `store("sound", ...)` and taking effect on the next cue (no server call, no
   config key — a per-browser preference, not fleet state).
5. **Tests: test/gui-client-sound.test.ts (new),** following the gui-client-scope.ts pattern with
   a stubbed AudioContext: (a) a new red key plays, a repeated key does not; (b) a muted state
   plays nothing; (c) the 2 s rate limit drops a second cue; (d) `newNeedsYouKeys` returns only
   the newly appeared keys, and a null `prev` (first poll) yields every needs-you key — the
   opened-onto-a-live-alert cue — pinning that choice in the test; (e) `soundControlHtml`'s label flips and the
   toggle's click handler updates the stored state; plus the standard
   `GUI_CLIENT_JS.includes(GUI_CLIENT_SOUND_JS)` verbatim-splice assertion.

**Files touched:** src/ui/gui-client-sound.ts (new), src/ui/gui-client.ts, src/ui/gui-client-model.ts,
src/ui/gui-client-fleet.ts, src/ui/gui-client-operator.ts, test/gui-client-sound.test.ts (new).

**Acceptance criteria.** With the dashboard open and audio armed by any prior click, a new
red/amber/indigo alert plays one short cue per new alert (distinct per tone), known alerts stay
silent, the mute toggle persists across reloads, a page opened onto an already-alerting fleet
cues once, browsers without AudioContext (and the pre-gesture window) render and poll normally
with no sound and no errors, and `npm run test` passes including the new suite.

## Done
### The dashboard's Queued tab shows each prompt's age (planned 2026-10-01 by plan loop, done 2026-10-01 by feature) — part 2/2, the observers

**Goal.** The same age `tumwater prompt --list` gains in part 1/2, on the dashboard: the backlog's
Queued tab (src/ui/gui-client-fleet.ts's `renderBacklog`, the `key === "queued"` branch, fed by
`queuedPrompts` in src/ui/gui-client-model.ts) currently shows only the preview and the "for the
<loop> loop" meta line. A prompt parked for a paused loop is the exact case the tab exists to
make visible; show how long each has waited, from the timestamp part 1/2 attaches to every queue
entry. Do not start this plan before part 1/2 has landed — it consumes that part's
`queuedAtMs`.

**Approach.**
1. **src/status-data.ts:** the snapshot's director queue fields (`inboxPrompts` + `inboxFiles`,
   from `queuedRolePromptEntries`) and the per-role `roleInboxPrompts` entries flow through the
   same `QueuedPromptEntry` objects part 1/2 extended, so add a parallel `inboxQueuedAt` array for
   the director (same order as `inboxPrompts`, the established pairing pattern) and pass
   `queuedAtMs` through each `roleInboxPrompts[r]` entry (part 1/2 already put it there at
   runtime; this part aligns the declared `StatusSnapshot` type with it). Both feed
   src/ui/status-payload.ts — the director's stamps pass through as a plain new field, the
   per-role entries already spread raw.
2. **src/ui/gui-client-model.ts, `queuedPrompts(d)`:** carry `queuedAtMs` onto each emitted item —
   for the director from `d.inboxQueuedAt[i]`, for roles from the entry itself — defaulting to
   `null` when the field is absent (an older payload must not break the render).
3. **src/ui/gui-client-fleet.ts, the `queued` branch of `renderBacklog`:** append the age to the
   `li-meta` span — `· queued <humanSeconds-age> ago`, omitted when `queuedAtMs` is null — using
   the page's existing relative-time helper (the one gui-client-drawer.ts's `fmtAgo` call and
   gui-client.ts's shared formatters already provide; reuse, never re-derive).
4. **Tests:** test/gui-client-fleet.test.ts (created for this — `renderBacklog` had no direct
   coverage; the suite runs the backlog block through a new marked `// backlog:` region, like
   the other client regions) gains: (a) a queued item with a `queuedAtMs` renders the age in
   its meta line, (b) a null `queuedAtMs` renders exactly today's meta text, (c) the Cancel
   button's `data-file`/`data-role` are unchanged in both cases; test/gui-client.test.ts's
   `queuedPrompts` model test carries the new field.

**Acceptance criteria.** The dashboard's Queued tab shows how long each prompt has waited;
items without a parseable stamp render as today; cancel behavior and the other backlog tabs are
unchanged; `npm run test` passes including the new render tests.

### `tumwater prompt --list` shows how long each prompt has waited (planned 2026-10-01 by plan loop, done 2026-10-01 by feature) — part 1/2, the shared stamp and the CLI

**Goal.** A steering prompt queued to a paused, disabled, or long-backoff loop sits in its queue
file indefinitely, and nothing in `tumwater prompt --list` reveals how long it has been waiting —
the operator sees the text but not the age, so a request queued yesterday beside a loop that will
never take it reads exactly like one queued a minute ago. The enqueue stamp is already in every
queue filename (`queueFileName`, src/file-queue.ts, writes `<epoch ms>-<seq, 6 digits>-<pid>.md`)
but no reader parses it back. Surface it. (The land queue solved the same problem with an explicit
`enqueuedAt` field — landing-queue.ts, surfaced as `fmtAgo` in src/ui/gui-client-drawer.ts; the
prompt queue never gained the equivalent, and it should not grow a body field the filename already
encodes.) The dashboard half of this is part 2/2; this part lands the shared parsing and the CLI.

**Approach.**
1. **src/file-queue.ts:** export `queueFileStamp(name: string): number | null` — parse the leading
   digits before the first `-` as epoch milliseconds; return `null` when the name does not fit the
   convention (a hand-placed file). Tightened while landing, per review: the leading run must be
   exactly 13 digits — epoch ms of any instant since 2001-09-09 — so a hand-written `2026-notes.md`
   reads as unstamped rather than as 2026 ms after the epoch. One home beside `queueFileName`, so
   the prompt inbox and landing-queue.ts read the same naming rule from the same place.
2. **src/inbox.ts:** the one read pass behind the list-shaped readers (queuedRoleFileTexts) gained
   the stamp and became the exported `queuedRolePromptRecords` (`{file, text, queuedAtMs}`), so the
   CLI reads text and stamp from the same pass the snapshot's entries do. `QueuedPromptEntry` gains
   `queuedAtMs: number | null` and `queuedRolePromptEntries` sets it from the record — the snapshot
   side keeps its `{file, preview, queuedAtMs}` shape and gains no prompt text.
3. **src/prompt-commands.ts:** `promptListPayload` copies `queuedAtMs` into each prompt it emits
   (the same array serves prose and `--json`, so they cannot disagree). The prose render suffixes
   each line with ` (queued <age> ago)` — age from `Date.now() - queuedAtMs`, human-phrased — and
   omits the suffix when `queuedAtMs` is null. `--json` carries the absolute `queuedAtMs` so
   scripts compute age themselves; the per-loop position numbering `--cancel` consumes is
   untouched.
4. **Layering first (the plan's one precondition):** `humanSeconds` — the compact `45s`/`12m`/`3h`
   duration phrasing — lives in src/ui/badges.ts, and core modules may not import src/ui
   (test/layering.test.ts's "no core module imports src/ui" allows only cli.ts). Move
   `humanSeconds` down to src/datetime.ts (its natural home, beside the other time phrasing),
   have src/ui/badges.ts import it from there (updating its one-home comment), and have
   prompt-commands.ts import it from `../datetime.js`. The layering test's own header comment
   anticipates exactly this "move the shared formatter down to src/" move.
5. **Tests:** test/file-queue.test.ts — `queueFileStamp` round-trips `queueFileName`'s output and
   returns null for a non-conforming name. test/cli-prompt-queue.test.ts — (a) a prose `--list`
   line carries the ` (queued … ago)` suffix for a real queue file, (b) `--json` entries carry
   `queuedAtMs` matching the filename stamp, (c) a hand-placed non-conforming filename renders
   with no suffix and `queuedAtMs: null`, and cancels by position as today.

**Acceptance criteria.** `tumwater prompt --list` states each queued prompt's age in prose and
`queuedAtMs` in `--json`; positions, ordering, and `--cancel` behavior are unchanged; a
non-conforming queue filename degrades to no age rather than an error; `npm run test` passes
including the new file-queue and prompt-queue tests and the unchanged layering test.

### The sidebar's Build row refresh icon restarts the build, like the build alert's icon (planned 2026-10-01 by director, done 2026-10-01 by feature)

**Goal.** The dashboard's build-stale alert carries a clickable refresh icon that restarts the
fleet onto main's head (`alertParts`' `restartable` branch in src/ui/gui-client-fleet.ts,
wired to `data-act='restart'` → `runAct` in src/ui/gui-client-boot.ts → `handleRestart` in
src/ui/gui-endpoints.ts). The sidebar's Build row in the left nav (the `d.build` branch of
`renderSidebar`, src/ui/gui-client-fleet.ts) shows the same refresh glyph but as inert
decoration. Make the sidebar icon the same restart affordance, under the same condition the
alert uses: clickable when the build is stale (`d.build.stale`), inert decoration when fresh.
Match the alert's rule exactly — including when `restartBlocked` is set — so one mental model
covers both icons: the click posts the same request, and a blocked restart surfaces the same
409 refusal message via `postAction`'s existing error toast.

**Approach.**
1. **src/ui/gui-client-fleet.ts, `renderSidebar()`'s build row:** when `d.build && d.build.stale`,
   render the row's lead as `<button type='button' class='alert-icon' data-act='restart'
   title='Restart onto the new build now'>` + `icon("refresh")` + `</button>` instead of bare
   `icon("refresh")` — the exact markup `alertParts()` already emits, so styling and behavior
   come from the same place and cannot drift. Keep the plain glyph when the build is fresh.
   No new click wiring: the global delegated handler in gui-client-boot.ts already dispatches
   any `[data-act='restart']`, and `handleRestart` needs no server change.
2. **src/ui/gui-styles.ts:** reuse the `.alert-icon` button styling (it already strips native
   button chrome per its comment). Only add a narrow rule if the button visibly misbehaves
   inside `.side-status .row` (e.g. inherits a button background) — prefer zero new CSS when
   the alert's rule already renders correctly there.
3. **test/gui-client-sidebar.test.ts:** extend the existing harness (`clientScope` +
   `paintPanel` capture) with tests named for the behavior: (a) a stale build renders the
   Build row's lead as the `data-act='restart'` button, (b) a fresh build keeps the inert
   glyph (no `data-act`), (c) the row's text and behind-count are unchanged in both cases.

**Acceptance criteria.** With the fleet running an old build, clicking the sidebar's refresh
icon triggers the same restart as the alert's icon (toast confirms, poll applies it); with a
current build the icon is inert as today; `npm run test` passes including the new sidebar
tests.

Landed 2026-10-01 by feature: renderSidebar's stale-build lead reuses alertParts' exact button
markup (no new CSS — the alert's `.alert-icon` rules already style it in the row), the global
`[data-act='restart']` handler picks it up unchanged, and three new tests cover it (stale →
button, fresh → inert glyph, row text and behind-count unchanged in both cases); the sidebar
test harness gained the shortSha stand-in its build row needs. Suite: 2786 tests, 2785 pass,
1 skipped, 0 fail.

### The cap-paused loop is legible: the status table, TUI, GUI, and `status --json` read the same cap verdict (planned 2026-09-30 by plan loop, done 2026-10-01 by feature) — part 2/2, the observers

**Goal.** Part 1/2 blocks a cap-paused loop at scheduling and pages the feed, but no observer
surfaces the verdict: the shared state-cell ladder (`loopPhase`, src/ui/status-model.ts) reads
"paused" only from the operator pause marker and the fleet budget gate, so an idle loop under its
own cap reads as its ordinary sleep/queue state and `status --json` carries nothing to say it is
held. Give every observer the same verdict the scheduler enforces — the fleet budget gate's rule
that "what an operator sees is what the scheduler is doing": the snapshot computes the cap verdict
per loop, the cell ladder names it, and the payload carries it. Depends on part 1/2 landing
(it provides `roleCapPaused`); the two are otherwise independent.

**Approach.**
1. `src/status-data.ts`: add `capPaused: string[]` to `StatusSnapshot` — the ids of enabled loops
   whose local-day spend has reached their cap, computed in the existing loops pass with
   `roleCapPaused(s, caps?.[s.role])` (src/role-cap-gates.ts) against the caps from the same
   last-known-good config that produced the loop list (a transiently broken tumwater.json degrades
   with the whole config, like `quietHours`). Always present, empty when none — the `pausedRoles`
   shape — fresh per poll. The director is excluded exactly as the gate exempts it.
2. `src/ui/status-model.ts`: a new `capPaused` parameter on `loopPhase`, checked after `userPaused`
   (user intent still wins) and before `budgetPaused` (the role's own cap is the more specific spend
   state — the ladder's existing "user intent is more specific than spend state" argument extended
   one level), returning `"cap paused"` for an idle loop; `loopRowCells` passes
   `snap.capPaused.includes(s.role)`. `loopRank` adds `"cap paused"` to the paused rank (3), which
   `phaseTone` (src/ui/tone.ts) derives from the rank — so the TUI/status table sorts and colors a
   held loop with the other paused states from that one edit. That is the single ladder the status
   table and both dashboards share.
3. `src/ui/status-payload.ts`: carry `capPaused` in the payload field list beside `pausedRoles`, so
   `status --json`, the GUI, and the TUI read one shape.
4. `src/ui/gui-client-model.ts` (the browser twin — it cannot import the server module, so the
   label needs its own copy): `phaseInfo` gains a `cap paused` branch beside `budget paused`
   (amber, "its own daily cap is spent") and the twin's `loopRank` copy adds the label to rank 3,
   so the GUI's per-loop pill, its tone, and the page's Paused group match the server.
   `test/gui-client.test.ts`'s twin-pin extends with it (review of the first landing 2026-10-01:
   the original plan said "no browser blob edit beyond verifying the pill", which was wrong — the
   twin's `phaseInfo`/`loopRank` copies are part of the surface).
No new CLI flag, config key, or doc surface — the key's docs land in part 1/2.

**Tests.**
- `test/status-data.test.ts`: a fixture loop with today's `dayStamp` and `dayCostUsd` at/over its
  cap, config holding `maxDailyCostUsdPerRole`, puts the role in `capPaused`; absent key → `[]`;
  a stale-stamp loop (yesterday's spend) is never cap-paused; the director is never listed.
- `test/status-model.test.ts`: a cap-paused idle loop's `loopPhase` reads `cap paused` and
  `loopRank` ranks it 3; an operator- AND cap-paused loop still reads `paused` (user intent wins);
  a fleet-budget-paused AND cap-paused idle loop reads `cap paused` (more specific spend state).
- `test/status-payload.test.ts`: the field is present in the payload (empty when no caps), and a
  held idle loop's phase reads `cap paused`.
- `test/gui-client.test.ts`: the twin-pin's phase table and rank lockstep cover `cap paused`
  (label "Cap paused", amber, not live, grouped with the paused states).

**Acceptance criteria.**
- `npm run test` passes with the cases above.
- `status --json` exposes `capPaused`; a cap-paused idle loop reads `cap paused` in the terminal
  status table, the TUI, and the GUI's loop pill; an operator-paused cap-paused loop still reads
  `paused`; in-flight ticks, the fleet budget badge, and every other cell are unchanged.

**Sizing.** One run: three source files plus three test files, well under 200 lines including
tests; no design question left open (the ladder position and the payload field are decided above).
Sibling: part 1/2 (the gate), which this plan depends on.

Landed 2026-10-01 by feature, as above with the twin extension the first landing's review asked
for (approach step 4): verified by `npm run test` (2781 pass) with the twin-pin's
`phaseInfo`/`loopRank` lockstep covering the new label — the GUI pill renders `phaseInfo`'s
label and tone, so the lockstep is the pill verification — and no other phase cell changed.

### Per-role daily cost cap: a loop over its own cap stops starting ticks — the feed names it, the notify hook pages, midnight or an edit lifts it (planned 2026-09-30 by plan loop, done 2026-10-01 by feature) — part 1/2, the gate

**Goal.** The fleet has a fleet-wide daily cap (`maxDailyCostUsd`, src/budget-gates.ts) and the
80% `budget_warning` — but per-role spend is only *visible* (the report's "Cost by role" line, the
status table's `cost`/`today` columns, the GUI loops view), never *bounded*: one runaway role can
eat the fleet cap and starve every other loop for the rest of the day. Add
`maxDailyCostUsdPerRole` — a role id → USD map in tumwater.json — so a loop whose local-day spend
has reached its own cap starts no new ticks until the next local day or a live config edit. This
is docs/feature-per-role-spending.md stage 3 (the cap); its tracking and surfaces already exist
(`LoopState.dayCostUsd` via `recordDailyCost`, the report's per-role lines). The stateless verdict
follows the fleet budget gate's own rule (`budgetPaused`'s doc: "resume is stateless, so …
crossing midnight flips it on the next cycle and nothing can get stuck"). Two deliberate
differences from that doc's sketch, stated here so the implementer does not re-litigate them:
the gate writes NO entry to the shared per-role pause marker (src/fleet-state.ts's `pauseRole` —
it is anonymous, so after a restart across midnight the harness could not tell a cap pause from an
operator's, and would either refuse to lift the operator's pause or orphan it), and an unknown role
id in the map is a validation error matching the existing `roles.<id>` idiom (explicit misconfiguration
never silently no-ops).

**Approach.**
1. **New `src/role-cap-gates.ts`** (sibling of src/streak-gate.ts — same shape: pure trip bookkeeping
   here, the module owns the only event emission, orchestrator wires it):
   - `export function roleCapPaused(state: Pick<LoopState, "dayStamp" | "dayCostUsd">, cap: number | undefined, now = Date.now()): boolean`
     — true iff `cap` is a finite number, `cap > 0` (0 disables that role, like the fleet cap), and
     `dailyCost(state, now) >= cap` (`dailyCost` from src/budget.ts). The role→cap lookup stays in
     the caller (`caps?.[role]`), so part 2/2's observers share this single definition.
   - `export interface RoleCapGateState { prev: Set<string> }`, `export function newRoleCapGateState()`,
     and `export function pollRoleCapGate(root, state, runners: readonly Pick<LoopRunner, "role" | "state">[], caps: Record<string, number> | undefined, now): ReadonlySet<string>`:
     per runner, skip `DIRECTOR_ROLE` (exempt like every autonomous gate); `paused =
     roleCapPaused(r.state, caps?.[r.role], now)`; on ENTER (paused now, not in `prev`) `logEvent`
     `{ loop: "harness", type: "role_cap_paused", role, spentUsd: dailyCost(r.state, now), capUsd: cap }`;
     on EXIT log `{ loop: "harness", type: "role_cap_resumed", role }`; update `prev`; return the
     current paused set. In-memory only, like every gate state — a restart with a still-over-cap role
     re-logs one `role_cap_paused` on the first poll (the durable-cause honest report the streak-gate
     doc accepts).
2. `src/gate-polls.ts`: add `cap: RoleCapGateState` to `FleetGateStates` (seeded in
   `newFleetGateStates`); in `pollFleetGates`, after the streak block, call
   `pollRoleCapGate(root, states.cap, runners, liveConfig.maxDailyCostUsdPerRole, now)` and add
   `capPaused: ReadonlySet<string>` to `FleetGatePoll` (returned, not folded into `pausedRoles` —
   that set is the marker's view, and the pause gates' edge bookkeeping must never see cap pauses).
3. `src/orchestrator.ts`: destructure `capPaused` at the `pollFleetGates` call site; add
   `capPaused.has(runner.role)` to the once-mode settle condition (the
   `pausedRolesSet.has(runner.role) || operatorPauseBlocks(runner.role)` site) and to the per-role
   pause skip (`if (pausedRolesSet.has(runner.role)) continue;`). No start-gate change: a parked
   waiter finishes, exactly like every per-role pause (established semantics — in-flight ticks
   finish, NEW ticks are gated at scheduling); a cap-paused role gets no fallback-probe exception
   (its stop is about spend, and probing it adds noise, not signal). The lift is a live config edit
   or local midnight — there is no marker for `resume --role` to touch.
4. `src/events.ts`: add `"role_cap_paused"` (carries role, spentUsd, capUsd) and
   `"role_cap_resumed"` (carries role) beside `role_streak_paused`.
5. `src/event-format.ts`: render both, modeled on the `budget_paused`/`budget_resumed` cases — the
   paused line names the role, its spend vs its cap, and the two lift paths (raise/remove the cap
   in tumwater.json, or local midnight); the resumed line states the loop ticks again.
6. `src/ui/tone.ts` `PROBLEM_EVENTS` AND the GUI client's duplicated list in
   `src/ui/gui-client-model.ts`: add `"role_cap_paused"` to both (the budget_warning Done entry
   records why the GUI list must follow the server one).
7. `src/notify.ts`: add `"role_cap_paused"` to `NOTIFY_EVENT_TYPES` (page on entry; the resumed
   event is not notified, as `budget_resumed` is not).
8. `src/config-schema.ts`: optional `maxDailyCostUsdPerRole?: Record<string, number>` on
   `TumwaterConfig` with a doc comment (per-role sibling of `maxDailyCostUsd`: a loop whose
   local-day spend has reached its cap starts no new ticks until local midnight or a live edit;
   0 disables that role; absent key = uncapped; the director is exempt); add
   `"maxDailyCostUsdPerRole"` to the `TOP_LEVEL_KEYS` list.
9. `src/config-validation.ts`: when present, a plain object; each key a known role id
   (`allRoleIds()` ∪ the `customNames` set the same function already builds — the `roles.${id}`
   wording idiom, so a typo cannot silently no-op a cap); each value a finite number ≥ 0 (the
   `NON_NEGATIVE_OR_DISABLED` semantics).
10. `README.md`: the settings paragraph names `maxDailyCostUsdPerRole` beside
    `maxDailyCostUsd`; `docs/how-it-works.md`: one sentence in the budget section.

**Tests.**
- New `test/role-cap-gates.test.ts`: `roleCapPaused` boundaries (at-cap true, below false, 0/absent
  false); `pollRoleCapGate` — a crossing logs exactly one `role_cap_paused` carrying spend/cap,
  repeated over-cap polls log nothing, a next-local-day poll logs `role_cap_resumed` and a later
  crossing re-logs, a cap removal/raise lifts, a fresh state holding an over-cap role logs exactly
  one event on its first poll (the restart case), a director runner never enters the returned set,
  and the returned set is exactly the currently paused roles.
- `test/gate-polls.test.ts`: `pollFleetGates` returns `capPaused` reflecting the config's map, and
  an absent key yields the empty set (add to the existing wiring test).
- `test/config-validation.test.ts`: absent key ok; non-object, negative, non-numeric, and unknown
  role id each fail with the named wording; a `customLoops` name is accepted; 0 is valid.
- `test/event-format.test.ts`: both lines render with the role and its figures; `test/notify.test.ts`:
  `role_cap_paused` is in `NOTIFY_EVENT_TYPES` (and `role_cap_resumed` is not).

**Acceptance criteria.**
- `npm run test` passes with the cases above.
- With `{"maxDailyCostUsdPerRole": {"organize": 0.01}}` set and an organize tick crossing 0.01,
  exactly one `role_cap_paused` appears in the feed per crossing, a configured notify command
  receives `TUMWATER_EVENT_TYPE=role_cap_paused`, and organize starts no new ticks until the next
  local day or a live edit — while every other role, the fleet-wide cap, and its fallback demotion
  are untouched (a per-role cap never engages the fallback), and the pause marker/`pausedRoles`
  stay exactly as before (no marker is written).
- No key (or an all-zero map) → the gate returns the empty set, logs nothing, and behavior is
  byte-identical to today.
- README and docs/how-it-works.md describe the key and its lift paths.

**Sizing.** One run: ~12 source files — most of them one-line additions at the anchors named
above — plus four-to-five test files, well under 400 lines including tests; no design question left
open (stateless verdict, event names, exemptions, and validation idiom are all decided above).
Sibling: part 2/2 (the observers) depends on this plan's `roleCapPaused` and lands after it.



### Budget warning at 80% of the daily cap: the notify hook pages before the gate bites, not after (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

**Goal.** Today the operator notify hook (`notify` in tumwater.json, src/notify.ts) only fires
for `budget_paused` — the operator learns the fleet has *already* stopped ticking, with no
chance to raise the cap or fix the fallback first. Add a `budget_warning` event fired once when
the fleet's daily spend crosses 80% of `maxDailyCostUsd` while the gate is still open, so a
c configured notify command pages the operator while there is still room to act. The threshold
is a fixed 80% (a named constant, no config knob — opinionated defaults over configuration),
and `budget_warning` joins the notify allowlist and the event feed; no other surface changes.

**Approach.**
1. `src/budget.ts`: add `export const BUDGET_WARNING_FRACTION = 0.8` and
   `export function budgetWarning(budget: { spentUsd: number; capUsd: number } | null): boolean`
   beside `budgetReached` — true iff the budget is non-null, `capUsd > 0` (a cap of 0 disables
   the budget, so no warning), and `spentUsd >= capUsd * BUDGET_WARNING_FRACTION`.
2. `src/budget-gates.ts`: add a `warned: boolean` field to `BudgetGateState` (default `false`
   in `newBudgetGateState`). In `pollBudgetGate`, right after the `reached`/`gate` verdict is
   computed and before the `prevGate` transition block: when `gate === "open"` and
   `budgetWarning(...)` is true and `state.warned` is false, `logEvent` a `budget_warning`
   event (`loop: "harness"`, `spentUsd`, `capUsd`) and set `state.warned = true`; when the
   predicate is false, reset `state.warned = false`. The edge-trigger with reset-on-below is
   the whole state machine: crossing local midnight drops `fleetDailyCost` back under the
   threshold, which re-arms the warning for the new day with no extra day-stamp state; a cap
   raise above the current spend disarms it the same way; a second crossing the same day warns
   again. Warn only while the gate is `open` — a poll that engages `fallback`/`paused` already
   logs its own transition event, so the warning never doubles the page.
3. `src/events.ts`: add `"budget_warning"` to the `HarnessEvent`/`HarnessEventInput` type
   unions next to the other `budget_*` members, commented "fleet daily spend crossed 80% of
   maxDailyCostUsd; the gate is still open".
4. `src/event-format.ts`: add a `case "budget_warning"` rendering
   `budget warning — <budgetPhrase(e.spentUsd, e.capUsd)> of the daily cap spent; the gate is
   still open` (the `budgetPhrase` helper already imported there).
5. `src/ui/tone.ts`: add `"budget_warning"` to `PROBLEM_EVENTS` so the feed badge and GUI tone
   match the other budget events. As implemented this also added the same literal to the GUI
   client's own duplicated list (`src/ui/gui-client-model.ts` PROBLEM_EVENTS) — tone.ts's set is
   server-side only, so without it the GUI activity feed would have ranked the warning "info".
6. `src/notify.ts`: add `"budget_warning"` to `NOTIFY_EVENT_TYPES` (its comment block says the
   allowlist is fixed — this extends the fixed list, one more type in the same shape).
7. `README.md`: extend the `notify` trigger list in the settings paragraph with "a budget
   warning (daily spend at 80% of the cap, gate still open)". `docs/how-it-works.md`: one
   sentence in the budget-gate section naming the warning event and the fixed threshold.

**Tests** (all offline, fake pi never invoked — these are pure-function/poll tests):
- `test/budget-gates.test.ts`: a poll that crosses 80% from below logs exactly one
  `budget_warning`; a second poll while still above logs none; spend dropping back below and
  crossing again warns again (re-arm); a poll where `reached` is true logs the
  `budget_fallback`/`budget_paused` transition and no warning; no warning at any spend when
  `maxDailyCostUsd` is 0/absent; `newBudgetGateState` starts with `warned: false`.
- `test/notify.test.ts`: `budget_warning` is in `NOTIFY_EVENT_TYPES`.
- `test/event-format.test.ts`: the `budget_warning` line renders with the spend phrase.

**Acceptance criteria.**
- `npm run test` passes with the new cases above.
- With a cap configured and spend crossing 80% of it without reaching it, exactly one
  `budget_warning` event appears in the feed per crossing, `tumwater logs` renders it with the
  problem tone, and a configured notify command receives `TUMWATER_EVENT_TYPE=budget_warning`.
- No warning ever fires with no cap configured, while spend stays above 80% without dropping
  back, or on the poll where the cap itself is reached.
- README and docs/how-it-works.md describe the warning and its fixed threshold.

**Sizing.** One run: ~8 files, well under 150 lines including tests; no design question left
open (threshold, edge-trigger rule, and surfaces are all decided above).

### `tumwater pause --reason <text>` — the operator pause records why, and every observer states it (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

**Goal.** An operator who pauses the fleet (`tumwater pause`, GUI pause control) is leaving a
note the whole team will read hours later — but today the pause is anonymous: the dashboards
say only "The fleet is paused" (fleet-alerts.ts's paused alert) and the header badge says only
"paused — auto-resumes in …" (badges.ts's `pauseBadge`). Let the pause carry a one-line reason
that every observer — CLI status header, TUI header, GUI alert banner, `status --json` —
states verbatim, so an operator returning to a paused fleet knows why without digging through
`history`.

**Approach.** The pause marker (src/fleet-state.ts's `PauseMarker` body, written by
`pauseFleet` and read by `standingMarker`) gains an optional `reason?: string` — the same
last-write-wins rule as `until`: each new pause write carries its own reason, and a pause
written without one clears a stale reason. Scope is the FLEET marker only; per-role pauses
(`pauseRole`'s `{roles, at, until}` body) stay anonymous — a per-role reason would need a
per-role map for no observed need.

- src/fleet-state.ts — `PauseMarker` gains `reason?: string`; export `PAUSE_REASON_MAX = 200`
  (chars, the cap every writer shares); `pauseFleet(root, untilMs?, reason?)` persists the
  trimmed, capped reason (`reason?.slice(0, PAUSE_REASON_MAX)` — the single cap, so the GUI
  path cannot smuggle a longer one even if a later plan wires it); new accessor
  `pausedReason(root): string | undefined` beside `pausedUntil`, read from the same
  `standingFleetPause` so no extra marker read is added.
- src/cli.ts — `runMarkerCommand`'s unknown-args gate admits a `--reason` flag for `pause`
  only (alongside the existing `DURATION_FLAG` carve-out), so a stray `--reason` on wake/abort
  fails fast instead of being silently ignored.
- src/operator-commands.ts — `cmdPause` reads `--reason <text>` with the imported `flagValue`
  (a missing value fails as `pause --reason needs a reason`, the `GREP_VALUE_ERROR` idiom);
  pass it to `pauseFleet`; the confirmation line appends the reason verbatim —
  `fleet paused — "deploying to prod" …` — while `already paused` keeps its idempotent
  wording (a reasonless `pause` on a standing marker stays a no-op, matching the existing
  `until` overwrite rule: only a fresh pause or a `--for` overwrite applies the new reason).
- src/status-data.ts — `StatusSnapshot` gains `pauseReason?: string`; the single
  `fleetPause = standingFleetPause(root)` read in the poll already holds it —
  `pauseReason: fleetPause?.reason` beside `pausedUntil`, no extra marker read.
- src/ui/status-payload.ts — ship `pauseReason: snap.pauseReason` beside `pausedUntil`, the
  same omit-undefined idiom, so `status --json` and the GUI payload carry it.
- src/ui/fleet-alerts.ts — the paused alert's title appends the reason:
  `The fleet is paused and resumes in ${left} — "${reason}"` (and the untimed form likewise);
  covers CLI, TUI, and GUI at once, since status-payload.ts computes the alerts for both
  dashboards from this one function.
- src/ui/badges.ts — `pauseBadge(pausedUntil, now, reason?)` appends ` — "${reason}"` after
  the countdown, so the `tumwater status` header (status-render.ts) and the TUI header state
  the reason; no reason, no change to today's byte-exact badge.
- src/help.ts — the `pause` stanza line gains `--reason <text>`.

**Out of scope (deliberate).** The GUI's pause toggle keeps sending `{paused, forSeconds}` —
`/api/pause` (src/ui/gui-endpoints.ts) is untouched; GUI *displays* the reason automatically
through the payload and alerts, and a follow-on plan can add a reason input to the composer if
operators want one. Per-role pause reasons likewise stay out.

**Acceptance criteria.**
- `tumwater pause --reason "deploying to prod"` writes a marker carrying the reason; the
  confirmation line quotes it; `tumwater status` shows `· paused — "deploying to prod"`;
  `status --json` carries `pauseReason`; the GUI/TUI paused banner states it; `tumwater
  resume` clears both.
- A pause without `--reason` behaves exactly as today (idempotent no-op on a standing marker,
  byte-identical badge/alert when no reason stands).
- `pause --reason` with no value fails with the named message; a 200+-char reason is stored
  capped; `wake --reason x` fails as an unknown argument.
- A `--for` overwrite refreshes both deadline and reason (last write wins), pinned by test.
- Tests extend the existing homes: test/fleet-state.test.ts (marker shape, `pausedReason`,
  cap, last-write-wins), test/operator-commands.test.ts (flag parse, wording, unknown-arg
  rejection), test/status-data.test.ts (`pauseReason` in the snapshot), test/badges.test.ts
  and test/status-header.test.ts (badge with and without reason), test/fleet-alerts.test.ts
  (alert title with and without reason).

**Landing note (2026-09-30, feature).** The reviewer's objection to the first attempt — `pause --role <id> --reason` succeeded and silently dropped the note — is closed by failing fast instead: cmdPause rejects the `--role` + `--reason` combination with a message naming the fleet-only scope, before any marker is written, and the help line states that scope. Everything else landed exactly as written here.

### `tumwater prompt --list --json` — the queued-prompt listing as machine-readable data (planned 2026-09-30 by plan loop, done 2026-09-30 by feature)

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

- Image drag-and-drop into the GUI composer: dropped or pasted images are saved beside the queued prompt and the prompt text points the loop at them (planned 2026-09-30, done 2026-09-30; commit 693ce725)
- Land queue drawer: clicking the GUI sidebar's "Land queue" chip lists the queued changes (planned 2026-09-30, done 2026-09-30; commit 9cc50dae)
- Backlog moves cut and paste under the existing heading: prompt wording for feature, bugfix, and conflict resolution — part 1/4, the prompts (planned 2026-09-30, done 2026-09-30; commit ed154097)
- GitHub CI on main builds the installable npm package and uploads it as a workflow artifact (planned 2026-09-30, done 2026-09-30; commit 654c496b)
- Quiet hours: surface the window on the dashboards — part 2/2, observability (planned 2026-09-30, done 2026-09-30; commit 9266aa2c)
- Quiet hours: a daily local-time window the fleet holds itself during — part 1/2, the gate (planned 2026-09-30, done 2026-09-30; commit 3604f218)
- `tumwater config get <key>` / `tumwater config set <key> <value>` — read and edit top-level settings from the terminal (planned 2026-09-30, done 2026-09-30; commit d2c873b9)
- Hand in-flight fallback ticks back to the primary at `budget_resumed` (planned 2026-09-30, done 2026-09-30; commit 4c502ca6)

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
