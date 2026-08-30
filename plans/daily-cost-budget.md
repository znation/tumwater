# Daily cost budget — cap the fleet's autonomous spend

Planned 2026-08-30 · by the plan loop

## Goal

An autonomous development harness that spends money needs a spending valve. Add a daily
cost budget: when the fleet's spend for the local day reaches `maxDailyCostUsd`, role loops
stop starting new ticks until the next local midnight (or until the user raises/disables the
cap). The director is exempt — an explicit human prompt outranks the autonomous-spend cap.
Spend and the cap are visible on both dashboards, and pause/resume land as events in
`tumwater logs`.

## Motivation

The harness already *measures* spend — per-loop `totalCostUsd` folded from pi's usage events
(src/loop.ts `foldUsage`, src/pi.ts), a `cost` column plus totals row on both dashboards, and
`tumwater reset-counters` for fresh observation windows. But nothing *acts* on it: a fleet
running 24/7 against a paid API can spend unbounded while nobody is watching — exactly the
failure mode an opinionated harness should refuse to ship. A senior engineer's answer is a
hard daily cap with visible state, not a dashboard that watches the number climb. Local-model
fleets (the dogfood setup; see README "Notes on local model servers") report $0 cost, so the
cap never fires for them — the guardrail protects API users by default and is invisible to
everyone else.

## Design

### Config: `maxDailyCostUsd` (top-level)

- New top-level key in `TumwaterConfig` (src/types.ts): number ≥ 0, **0 disables** (the same
  off-switch convention as `quietTimeoutSeconds`/`sessionRetentionDays`).
- `defaultConfig()` carries **50** — enabled by default. Rationale: an unattended fleet must
  not spend unbounded; $50/day is generous for a normal day of autonomous work on mid-tier API
  models and low enough to catch a runaway (thrashing loop, high thinking level, mispriced
  model). One line in tumwater.json raises or disables it. Local-model fleets never see it
  fire because pi reports $0 cost.
- Validation: add to `TOP_LEVEL_KEYS` (so a typo like `maxDailyCostUsds` fails fast with the
  unknown-key error) plus a `checkNumber … >= 0` in src/config.ts, like the other numeric
  fields.
- No restart needed: `loadConfig` merges over `defaultConfig()` (`...base, ...cfg`), so
  existing repos pick up the default with no file edit, and the orchestrator's live-reload
  poll pushes cap edits into every runner within ~2 s — the gate reads the fresh config each
  cycle.

### State: per-loop daily cost window

- `LoopState` gains two optional fields (src/types.ts): `dayStamp?: string` (local
  `YYYY-MM-DD`) and `dayCostUsd?: number`. `freshLoopState` defaults them to `""`/`0`; old
  state files load unchanged through the existing merge-over-fresh in `loadLoopState`, where a
  missing stamp reads as "stale" (below) — i.e. $0 today, which is honest: spend before this
  field existed is unknown.
- **Write path** — src/loop.ts's `foldUsage` records the run's cost into the daily window via
  a new exported pure helper in src/state.ts, e.g. `recordDailyCost(s, usd, now)`: if
  `s.dayStamp !== todayStamp(now)` it resets `dayCostUsd = 0` and sets the stamp (local-midnight
  rollover), then adds `usd`. A tick that crosses midnight attributes its spend to the correct
  day; the value persists at tick end with the rest of the state.
- **Read path** — never mutates: `dailyCost(s, now)` in src/state.ts returns
  `s.dayStamp === todayStamp(now) ? s.dayCostUsd : 0`. Both the orchestrator (in-memory runner
  states) and status.ts (state files) read through it, so a loop that hasn't ticked since
  yesterday reads as $0 today with no save required. `todayStamp` uses local time — the same
  convention as every other wall-clock display in the harness (`lastTickCell`).
- **`reset-counters` deliberately does NOT zero the daily window** (`zeroCounters` untouched):
  the budget is a safety valve, not an observation window — zeroing today's spend would let
  the cap be bypassed by running `tumwater reset-counters`. The `cost` column (lifetime since
  last reset) and the budget badge (today) are different windows; that is intended.

### Gate: fleet-wide, in the orchestrator poll loop

- New exported pure helpers in src/state.ts (NOT src/orchestrator.ts — observers must not
  depend on the scheduler module, per state.ts's existing one-way dependency rule):
  `fleetDailyCost(states: LoopState[], now)` summing `dailyCost`, and
  `budgetPaused(states, config, now)` = `config.maxDailyCostUsd > 0 && fleetDailyCost ≥ cap`.
- In `runOrchestrator`'s poll loop (src/orchestrator.ts), compute the predicate once per cycle
  from all runners' states. While paused, **role runners are skipped before `isEligible`** —
  no scheduled tick, no "main moved" early wake, no startup tick starts; the director is
  unaffected and queued prompts still run (explicit human requests outrank the autonomous-spend
  cap). In-flight ticks finish — nothing kills a pi run mid-tick; only *new* ticks are blocked.
- Why not inside `isEligible`: the budget is fleet-wide (a sum across loops), while
  `isEligible`'s per-loop contract and its existing unit tests stay intact. One new pure
  function plus a few lines in the poll loop.
- **Resume is live and stateless**: raising/disabling the cap or crossing local midnight flips
  the predicate on the next poll (~2 s) — there is no paused flag to clear, so nothing can get
  stuck. (Contrast with e.g. backoff: no new scheduling field is introduced.)

### Events

- `HarnessEvent.type` gains `"budget_paused"` and `"budget_resumed"` (src/types.ts), filed at
  harness level (`loop: "harness"`) with `spentUsd` + `capUsd`. The orchestrator tracks the
  previous cycle's paused state and logs exactly one event per transition — including
  transitions caused by a live cap edit or midnight rollover, since the predicate is re-evaluated
  every poll. src/event-format.ts renders both (e.g. `budget paused — $50.12 of $50.00 daily
  cost reached` / `budget resumed ($3.20 of $50.00 today)`), plain lines, no warning prefix —
  a routine state change, like `counters_reset`.

### Display (both dashboards)

- `StatusSnapshot` gains `budget: { spentUsd: number; capUsd: number } | null` (src/status.ts):
  computed from the same state.ts helpers plus `configForStatus` (which already loads the
  config); `null` when disabled (cap 0). Spend lags in-flight ticks by up to one tick boundary,
  exactly like the existing `cost` column — consistent, not a new property.
- Header badge: renderStatus's header line appends `· budget: $12.34/$50 today` whenever
  enabled (src/status-render.ts). Unlike the inbox/questions badges (action-needed → shown only
  when non-zero), spend is standing information for a money-spending system, so it shows at all
  levels; on narrow terminals the header's existing last-resort whole-line clipping applies.
- State cell: `loopPhase` gains an optional trailing `budgetPaused?: boolean`; when set and the
  loop is not running and is not the director, it returns `budget paused`. renderStatus passes
  it from the snapshot; src/gui.ts passes it into its existing per-loop `phase` payload field —
  one function covers both surfaces, and the GUI page needs no state-cell JS change. The GUI
  header badge mirrors the TUI's in gui-page.ts's header assembly (the same place inbox/
  questions badges are built).

### README

- Usage: document `maxDailyCostUsd` — what it caps (role loops' new ticks, per local day),
  that 0 disables, that the director is exempt, and that edits apply live within ~2 s.
- How it works: one short paragraph on the pause/resume behavior and the events.

## Files touched

src/types.ts (config field, LoopState fields, two event types), src/config.ts (default,
TOP_LEVEL_KEYS, validation), src/state.ts (`freshLoopState` defaults; `todayStamp`,
`dailyCost`, `recordDailyCost`, `fleetDailyCost`, `budgetPaused`), src/loop.ts (`foldUsage`
records the daily window), src/orchestrator.ts (gate in poll loop + transition events),
src/status.ts (snapshot `budget` field), src/status-render.ts (header badge; `loopPhase`
param), src/gui.ts (pass paused into phase payload), src/gui-page.ts (header badge JS),
src/event-format.ts (two render cases), test/config.test.ts, test/state.test.ts,
test/orchestrator.test.ts, test/status-render.test.ts, test/event-format.test.ts,
test/gui.test.ts, README.md.

## Acceptance criteria

- `maxDailyCostUsd` is a validated top-level key (number ≥ 0; 0 disables) with default 50 in
  `defaultConfig()`; an existing config file picks up the default without editing, and a live
  edit applies within one poll cycle. Negative/non-numeric values are rejected with actionable
  errors like the other numeric fields.
- The per-loop daily window rolls over at local midnight on write (`recordDailyCost`) and reads
  as $0 when stale or missing on read (`dailyCost`); old state files load unchanged; a tick
  crossing midnight attributes its spend to the new day; `reset-counters` leaves the daily
  window untouched.
- While fleet daily spend ≥ cap, no role loop starts a new tick (scheduled, main-moved wake, or
  startup) — verified end-to-end with the fake pi shim reporting cost (tiny cap: first tick
  lands, second is blocked while a queued director prompt still runs); in-flight ticks finish;
  raising/disabling the cap live resumes role loops within ~2 s.
- `budget_paused`/`budget_resumed` events land once per transition and render in
  `tumwater logs`, the TUI activity pane, and the GUI feed.
- Both dashboards show the header badge with today's spend vs cap while enabled (absent when
  disabled), and paused role loops' state cell reads `budget paused` while the director shows
  its normal phase.
- `npm test` passes; new behavior is covered by units for every pure helper plus the e2e above,
  per this repo's "every behavior change ships with a test" principle.

## Dependencies & sequencing

None — builds on existing config/state/orchestrator/status machinery (live-reload poll,
state-file merge-over-fresh, snapshot + render split). Independent of the two current Planned
remainders (commit-bodies tests, steward tests); any order works.

## Out of scope

Per-role budgets (fleet-level is the one sensible way for now — opinionated defaults over
configuration); killing a tick mid-run on overshoot (in-flight ticks finish; `tickTimeoutSeconds`
bounds them); estimating cost when pi reports no usage (it stays $0 and the cap never fires —
documented, not faked); weekly/monthly windows.
