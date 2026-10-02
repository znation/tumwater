# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

<!-- One more plan already in ## Planned would end a plan tick in TUMWATER_NOTHING_TO_DO -->

### The TUI moves to ink, part 3/3: retire the hand-rolled renderer remnants and correct the docs (planned 2026-10-01 by director; requires part 2b/3 landed)

**Goal.** After parts 1–2 the ink port is the only TUI path; this part removes what it made dead
and fixes every claim that the project has zero runtime dependencies.

**Approach.**
1. **Dead code:** delete exports in src/ui/tui-frame.ts and src/ui/tui.ts that only the
   hand-rolled paint path used (candidates: any remaining full-frame ANSI assembly; `toneLine`'s
   string-painting variant if `status-render.ts` no longer consumes it — check its CLI callers
   in src/cli.ts first and keep what `tumwater status` still renders through). Verify with the
   existing zero-dependency/dead-export test the repo already runs (docs/
   commit-history-analysis.md describes it).
2. **Docs:** docs/code-metrics.md:80 ("no runtime dependencies, only Node built-ins; four dev
   dependencies") is updated to name ink and react as the sanctioned runtime exceptions per
   PRINCIPLES.md; README.md and docs/how-it-works.md passages describing the hand-rolled
   renderer/repaint are updated to describe the ink renderer; src/ui/tui.ts's header comment and
   the `TuiSeams` doc comment no longer describe `CLEAR`-style painting.
3. **Tests:** any test asserting deleted exports goes with them; `npm run test` green.

**Acceptance criteria.**
- No dead exports flagged by the repo's existing dead-export check; `grep -r '\x1b\[2J' src`
  finds nothing outside deliberate full-clear sites (resize, if any remain).
- All doc claims about dependencies and the TUI renderer match the shipped code.
- `npm run test` is green.

### The dashboard's Settings view: view and edit the curated top-level config keys live (planned 2026-10-02 by plan loop)

**Goal.** The GUI can steer the fleet (pause, wake, abort, budget, prompts) but cannot see or
change any other setting: model, provider, quiet hours, the notify hook, and the fleet-wide
spend cap are read-only on `status` and editable only through `tumwater config set` in a
terminal. A Settings view closes that gap for the operator who only has the browser.

**Approach.** Reuse the existing write path — src/config-write.ts's `setConfigKey` (unknown-key
refusal, JSON-or-literal parsing, per-key validators, whole-candidate `validateConfig`, atomic
write that live readers pick up) — so the GUI cannot drift from the CLI's rules.
1. **src/ui/gui-endpoints.ts:** add `EDITABLE_CONFIG_KEYS` (a constant: `provider`, `model`,
   `maxDailyCostUsd`, `quietHours`, `notify` — the top-level keys an operator edits often;
   `customLoops` and per-role maps stay CLI/director territory) and two handlers modeled on
   `handleBudget`: `handleConfig` (GET — resolved values for exactly the curated keys, read
   via the same load path `cmdConfig` uses in src/config-commands.ts) and `handleConfigSet`
   (POST `{key, value}` — 400 when the key is outside `EDITABLE_CONFIG_KEYS` or the value
   fails `setConfigKey`'s check, 200 `{ok, key, value, oldValue}` on success, reusing
   readPostBody's body discipline).
2. **src/ui/gui.ts:** route `GET /api/config` and `POST /api/config-set` next to the
   `/api/budget` dispatch.
3. **src/ui/gui-page.ts + src/ui/gui-client.ts:** a fifth tab (`#settings`) listing the five
   keys as label + current-value + inline text field + Save button (values pre-rendered with
   the existing `esc` discipline); Save posts and flashes the same success/error pattern the
   prompt composer uses. One panel, no new fetch polling loop — values load when the tab is
   first opened.
4. **Tests:** extend test/gui-endpoints.test.ts (GET shows the curated keys; POST set then GET
   round-trips; bad key and bad value each 400 naming the key; a `quietHours` typo hits
   `checkQuietHours`'s message) and a small test/gui-client-settings.test.ts for the panel's
   markup and Save wiring, following gui-client-scope.ts's pattern. Update README.md's GUI
   sentence and `tumwater help gui`-adjacent docs only where they enumerate views.

**Acceptance criteria.**
- `GET /api/config` returns exactly the five curated keys; POST to any other key (including a
  known-but-not-curated one like `customLoops`) is refused with the key named.
- A successful edit writes tumwater.json through `setConfigKey` and the running fleet applies
  it live (same mechanism as `tumwater config set`); a failed edit leaves the file untouched.
- `npm run test` is green.

## Done

### The TUI moves to ink, part 2b/3: key handling moves to ink's `useInput` (planned 2026-10-01 by director, split 2026-10-02 by plan loop; requires part 2a/3 landed, done 2026-10-02 by feature)

The second half of the split part 2/3: with the handler already framework-free in
src/ui/tui-keys.ts (2a), this step only swaps who feeds it keys.

**Goal.** Replace the readline keypress path in src/ui/tui.tsx with ink's input parsing:
`useInput` inside the component tree dispatches to the extracted handler, leaving tui.tsx with
only data polling and state assembly.

**Approach.**
1. **src/ui/tui-app.tsx:** add a `useTuiKeys` hook wrapping ink's `useInput` that maps ink's
   parsed input object to the shape the 2a handler consumes (ink's `key.*` flags and `input`
   char → the readline `str`/`key` pair, a small pure adapter in src/ui/tui-keys.ts so it is
   unit-testable), then calls the factory's dispatch. Set `exitOnCtrlC: false` in the `render`
   options so the existing quit key keeps exiting through the same cleanup path; pass `stdin`
   into `render` so ink claims the injected stream tests already provide.
2. **src/ui/tui.tsx:** delete the `emitKeypressEvents`/`setRawMode` setup and the
   `stdin.on("keypress", …)` block; restore raw mode only through ink's own lifecycle.
3. **src/ui/tui-input.ts:** retire only what ink's parsed key object supersedes (the raw
   `KeyLike` keystroke decoding); the pure edit/history/parsing functions stay and keep their
   tests.
4. **Tests:** test/tui-operator-keys.test.ts and the key-driven parts of test/tui.test.ts drive
   keys through the injected stdin ink reads (same fake, now consumed by ink's input parser);
   test/tui-input.test.ts keeps its pure-logic cases minus any asserting raw decoding; the
   adapter gets direct cases in test/tui-keys.test.ts.

**Acceptance criteria.**
- `grep readline src/ui/tui.tsx` finds nothing; no manual `setRawMode` outside ink's own setup.
- All key behaviors the existing tests pin — tab switching, prompt editing (incl. the astral
  surrogate-pair cursor rules in `applyKey`), budget and role-prompt input, history recall,
  quit — pass unchanged.
- `npm run test` is green.


### The TUI moves to ink, part 2a/3: extract the key handler from `runTui` into a framework-free module (planned 2026-10-01 by director, split 2026-10-02 by plan loop; requires part 1/3 landed, done 2026-10-02 by feature)

Landed with the deps object smaller than the Approach sketch: the factory imports the
disk-action modules (fleet-state, operator-intent, inbox-submit, config-write, report/
failure collection) directly and takes only `root`, `quit`, `requestRender`, and an
injectable `now` clock (so the flash-expiry test runs without waiting the real 3 s).
Render syncs snapshot data and line budgets in via `syncSnapshot`/`setLineBudgets` and
reads `state()` out each frame.

Split from the original part 2/3 (which a feature run found too large for one run): the
~280-line keypress handler is first extracted *as-is*, with no framework change, so the ink
swap in 2b/3 becomes a small, mechanical step.

**Goal.** A pure refactor: the readline keypress handler inside src/ui/tui.tsx's `runTui`
(the `stdin.on("keypress", …)` block and its `emitKeypressEvents`/`setRawMode` setup) moves
into a new framework-free module src/ui/tui-keys.ts, still driven by the same readline event.
Behavior is byte-identical; ink's rendering path (part 1/3, src/ui/tui-app.tsx) is untouched.

**Approach.**
1. **src/ui/tui-keys.ts (new):** export a `createTuiKeys(deps)` factory owning the handler's
   mutable locals today scattered through `runTui` — `input`/`cursor`, budget-mode
   (`budgetMode`, `savedInput`, `savedCursor`), role-prompt mode (`rolePromptFor` and its saved
   pair), `promptHistory`, `currentCapUsd`/`currentBudgetFree`, flash (`flash`/`flashUntil` and
   the `flashMessage`/`flashError` helpers), `view`, `selectedEntry`/`entryScroll`,
   `paneCache`/`paneScroll`, `eventBudget`/`entryBudget`, `roleIds` — plus the keypress
   dispatch (`applyKey`, `parseBudgetInput`, `parseRolePromptInput`, the `PromptHistory`
   functions from src/ui/tui-input.ts, all imported unchanged). The factory takes a deps
   object: the actions it calls out of the handler today (quit/pause/abort/restart, prompt
   submission, config write) and the getters render feeds it (snapshot data, pane bodies,
   budgets). It exposes the readers `runTui`'s render step needs (`inputLine`, `view`,
   `selectedEntry`, scrolls, flash, budget mode state) so render assembles the same frame.
2. **src/ui/tui.tsx:** `runTui` constructs the handler with its real deps and passes the
   handlers to `stdin.on("keypress", …)`; every `render()` call the old branches made becomes
   a `requestRender` callback dep. No behavioral edit anywhere; delete nothing else.
3. **Tests:** test/tui-operator-keys.test.ts and the key-driven parts of test/tui.test.ts pass
   unchanged (same readline seam). Add test/tui-keys.test.ts driving the factory directly —
   at minimum one case per handler family: prompt editing via `applyKey`, budget mode open/
   save/cancel, role-prompt mode, history recall, view cycling and paging, flash expiry.

**Acceptance criteria.**
- `git diff` shows no change to key behavior: all existing key-driven tests pass unmodified.
- `grep -n 'keypress\|applyKey\|budgetMode' src/ui/tui.tsx` shows only the construction and the
  single `stdin.on("keypress", …)` call delegating to the factory; the handler body lives in
  src/ui/tui-keys.ts.
- test/tui-keys.test.ts exercises the factory without a terminal or a readline event emitter.
- `npm run test` is green.

### The TUI moves to ink, part 1/3: adopt ink and render the frame with it (planned 2026-10-01 by director, from the user's answered question in QUESTIONS.md, done 2026-10-01 by feature)

**Goal.** The user answered the open TUI-framework question: adopt a production TUI framework.
This part introduces ink and moves the *rendering* of `tumwater tui` onto it, which also kills
the recorded flicker bug (BUGS.md, "The TUI flickers on every table update") — ink diff-renders,
so a one-cell change rewrites only what changed instead of `CLEAR + full repaint` (src/ui/tui.ts's
`CLEAR = "\x1b[2J\x1b[H"` at :73 and its single call site at :299). Key handling stays exactly as
it is today; part 2/3 moves it. The view model does not change: src/ui/tui-frame.ts's pure
builders (`tabStrip`, `alertLines`, `hintLine`, `toneLine`, the `TuiView` type) keep producing
`StatusLine[]`/`StatusSpan[]`, and src/ui/status-render.ts (shared with `tumwater status` in the
CLI) is untouched.

**Approach.**
1. **Dependencies:** add `ink` and `react` to package.json (install inside the implementing
   worktree; commit package.json and package-lock.json). Landing step: after the merge, run
   `npm install` at the repo root *before* the post-landing build check, so main's build resolves
   the new deps. This is the project's first runtime dependency and is sanctioned by the amended
   PRINCIPLES.md first principle (2026-10-01).
2. **New src/ui/tui-app.tsx:** an ink component tree that renders the existing view model —
   one `<Box>` per `StatusLine`, one `<Text>` per `StatusSpan` with its tone mapped through a new
   exported `toneColor(tone: StatusSpan["tone"]): string` (ink color names replacing the ANSI
   painting `paintLine` does for the CLI path; `paintLine` itself stays for status-render.ts).
   `tabStrip`, `alertLines`, `hintLine` outputs render as-is; their width-clipping logic stays in
   tui-frame.ts so the frame stays deterministic and testable.
3. **src/ui/tui.ts:** keep `runTui`, `TuiSeams`, `TuiStdin`, `TuiStdout`, the polling loop, and
   the entire readline keypress handler byte-for-byte in behavior. Replace only the paint step:
   delete `CLEAR` and the `lastFrame` string diff, call ink's `render(<TuiApp …/>, { stdout,
   exitOnCtrlC: false })` once at startup, and push each new view into the app via a rerender
   bridge (a state ref the component reads). Pass no stdin to ink this part — with no `useInput`
   hook mounted, ink does not claim raw mode, so today's `readline.emitKeypressEvents` +
   `setRawMode(true)` setup (:330–:332) keeps working unchanged.
4. **Tests:** test/tui.test.ts's frame assertions move from comparing hand-painted strings to
   reading the fake stdout ink writes into (ink accepts injected `stdout`); add a regression test
   pinning that a one-cell change between frames emits **no** `\x1b[2J` (the test the BUGS.md
   entry asked for). test/tui-frame.test.ts stays green — pure model unchanged; test/tui-input*.ts
   untouched.

**Acceptance criteria.**
- Rendering two frames differing in one elapsed-time cell through the test fakes emits no
  `\x1b[2J` anywhere in the captured output, and the second frame's changed cell text is present.
- Every `tui*.test.ts` file passes; `npm run test` is green.
- `runTui`'s key handling, seams, and polling code paths are unmodified (diff shows only the
  paint step replaced plus the new import/render calls).
- The dependency addition is committed with a lockfile, and the plan note above about
  `npm install` at the repo root is followed at landing time.

**Landed 2026-10-01 by feature:** as planned, with three deviations worth recording. (1) src/ui/tui.ts became src/ui/tui.tsx — the rerender bridge is ink's `rerender` with the next view as props (the component is pure), which required the JSX parse; the paint step and only the paint step moved. (2) src/cli.ts now imports the TUI lazily (`await import` inside the tui command): an install without node_modules must reach every other command's own broken-install reporting instead of dying on the static ink import — test/version.test.ts's broken-install scenario pins this. (3) scripts/stamp-build.mjs's prune and test/exports.test.ts's source scan learned .tsx alongside .ts. Tests read ink's writes through the same fake stdout (test/tui-fixtures.ts strips all escape sequences and counts text-bearing chunks as frames); the frame layout is unchanged except that ink trims invisible trailing columns per line, and the styled NO_COLOR run pins chalk's basic 16-color palette (`\x1b[90m`/`\x1b[97m`) since the fake terminal is not a real TTY.

### The budget badge says when the cap will be hit: a burn-rate projection in the shared badge (planned 2026-10-01 by plan loop, done 2026-10-01 by feature)

**Goal.** The header badge — `budgetBadge` in src/ui/badges.ts, shipped display-ready by
src/ui/status-payload.ts to the GUI sidebar and rendered directly by src/ui/status-render.ts's
TUI/status header — shows today's spend against the cap (`· budget: $3.20/$5.00 today`), but an
operator watching spend climb has to do the arithmetic themselves: will the fleet hit the cap
before the day ends, and roughly when? Append a projection computed from today's burn so the
badge reads `· budget: $3.20/$5.00 today · ~cap at 17:40` while the forecast says the cap falls
today, and stays byte-identical to today's output whenever it does not (no cap, no spend yet,
cap already reached, or a burn too slow to reach it by midnight).

**Approach.**
1. **src/budget.ts:** a new pure `projectCapHit(budget: { spentUsd: number; capUsd: number },
   now = Date.now()): number | null`. Linear burn since local midnight (`dayAt(0, new Date(now))`
   from src/datetime.ts): `rate = spentUsd / elapsedMs`, `hitAt = midnight + capUsd / rate`.
   Return null when `capUsd <= 0` (gate disabled), `spentUsd <= 0` (no burn to extrapolate),
   `spentUsd >= capUsd` (the gate's own `open`/`fallback`/`paused` states supersede a forecast —
   `budgetReached` already names that moment), or `hitAt >= next local midnight` (at this burn
   the cap is not reached today; the daily window resets at midnight, so a tomorrow figure would
   be a lie — silence is the honest output). The `~` in the badge marks it a forecast: the rate
   is linear over the whole day, so quiet hours make the morning figure pessimistic about the
   remaining day — a stated simplification, refreshed on every poll, not a design question.
2. **src/status-data.ts:** the snapshot's `budget` field (the object typed inline next to the
   `loops` field, doc-commented "today's fleet spend vs the cap") gains `capHitAt: number | null`,
   computed once per poll with `projectCapHit` from the same materialized spend the badge already
   renders — the scheduler's published figure while running, the persisted states' sum otherwise —
   so what every observer shows is one computed fact, not three derivations. `status --json` and
   `/api/status` carry it to scripts for free via the existing snapshot serialization.
   (Review response: `snapshot()` and `statusPayload()` take an optional trailing `now` —
   production callers take the `Date.now()` default — so a test pins the whole budget block to
   one instant instead of racing the collector's own clock; the first review pass flagged the
   wall-clock flake in exactly that shape.)
3. **src/ui/badges.ts, `budgetBadge`:** when `budget.capHitAt` is non-null, append
   ` · ~cap at HH:MM` — wall-clock local time from `pad2` (src/datetime.ts), hours and minutes
   only (`pad2(d.getHours()) + ":" + pad2(d.getMinutes())`); `formatTime`'s seconds are noise for
   a forecast. No gate check needed here: `projectCapHit` returns null exactly when the gate is
   no longer open, so the badge's own null test is the whole condition. One home for the rule,
   like `buildBadge` and `landingBadge` — the TUI header, `tumwater status`, and the GUI sidebar
   inherit the fragment without individual edits, and the other budget mentions
   (status-render's table cell, the GUI budget editor popover, the sidebar's budget card) stay
   unchanged.
4. **Tests:** in test/budget.test.ts, `projectCapHit` cases — zero spend → null; no cap → null;
   spend at or over cap → null; exact hit time for a fixed `now` and spend (arithmetic checked
   against a hand-computed instant); a burn too slow to reach the cap by midnight → null; a
   spend crossing midnight attributed to the new day (rate restarts). In test/badges.test.ts —
   `budgetBadge` with `capHitAt` set renders the `· ~cap at HH:MM` fragment with zero-padded
   minutes; with `capHitAt` null the badge is byte-identical to its current output (the existing
   `· budget: n/a`, `· no cap`, and fallback-model cases all still hold). In
   test/status-data.test.ts and test/gui-operator.test.ts, the snapshot/payload carry
   `capHitAt` through with the budget block pinned to one instant via the clock seam. The
   pre-existing `StatusSnapshot["budget"]` literals (test/status-fixtures.ts,
   test/fleet-alerts.test.ts, the header/render suites) gain `capHitAt: null`.

**Files touched:** src/budget.ts, src/status-data.ts, src/ui/status-payload.ts, src/ui/badges.ts,
test/budget.test.ts, test/badges.test.ts, test/status-data.test.ts, test/gui-operator.test.ts,
test/status-fixtures.ts, test/fleet-alerts.test.ts, test/status-header.test.ts,
test/status-render.test.ts, test/status-render-cells.test.ts.

**Acceptance criteria.**
- `projectCapHit` returns the documented values for every case above; no other budget.ts export
  changes behavior.
- With a cap configured, spend in flight, and a burn that reaches the cap before midnight,
  `tumwater status`, the TUI header, and the GUI sidebar all show `· ~cap at HH:MM` with the same
  time; `status --json`'s `budget.capHitAt` is that instant as epoch ms.
- Without a cap, with no spend, with the cap already reached, or with a burn that misses
  midnight, every budget-rendering surface is byte-identical to its pre-change output.
- `npm run test` green.

**Done 2026-10-01 by feature:** implemented as planned (anchors corrected above: the suites
live in test/, not src/, and the literal updates plus the clock seam touch more files than the
plan first listed). Suite green: 2816 passed, 0 failed, 1 skipped.

### The dashboard speaks when the fleet needs you: a synthesized audio cue on a new needs-you alert, with a mute toggle (planned 2026-10-01 by plan loop, done 2026-10-01 by feature)

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
   into the `GUI_CLIENT_JS` array in src/ui/gui-client.ts (after `GUI_CLIENT_MARKDOWN_JS`, before
   `GUI_CLIENT_OPERATOR_JS`), delimited by `// sound:start` / `// sound:end` region markers so
   clientScope can test it like the other modules. Contents: (a) `soundMuted` read once via the existing `recall("sound")` helper
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
3. **src/ui/gui-client-fleet.ts, `renderAlerts` (corrected anchor: renderAlerts computes
   `alerts` and runs on every poll whatever the view — renderFleet never sees them):** after
   computing `alerts`, diff the needs-you keys against the previous poll's set (a
   `lastNeedsYouKeys` variable in the fleet module's needs-you-cue region, its only use) and call
   `playAlertCue` with each new alert's tone, each booking its own cue 2 s apart so one poll
   bearing several new alerts still sounds one cue per alert while the rate limit holds across
   polls. First poll diffing against a null previous set is fine — a page opened onto an
   already-alerting fleet chirps once; the muted or never-gestured case stays silent.
4. **src/ui/gui-client-operator.ts:** a `soundControlHtml()` beside `pauseControlHtml` — a small
   sidebar-top button beside the theme toggle (id `soundtoggle`, painted into the new `#soundwrap`
   slot in gui-page.ts; corrected anchor: the page has no masthead, the sidebar top is its
   closest surface) whose label/title flips between the muted and unmuted icon, persisting via
   `store("sound", ...)` and taking effect on the next cue (no server call, no config key — a
   per-browser preference, not fleet state). Toggling goes through a `toggleSound()` the click
   handler calls, so tests exercise it without a DOM Element.
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

_Implemented 2026-10-01 by feature with the three anchor corrections noted inline (renderAlerts
not renderFleet; the splice sits with the other content modules; the toggle lives in the sidebar
top beside the theme toggle). test/gui.test.ts's shell-id list gained `soundwrap`, and
test/gui-client-sidebar.test.ts's renderSidebar scope stubs the new `renderSoundBadge` call._
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

- `tumwater tick <role> <n>` — one completed tick's full event trail from the terminal (planned 2026-09-30 by plan loop, done 2026-09-30 by feature; commit 04944411)
- `tumwater role <id>` — inspect one loop's standing prompt and resolved settings (planned 2026-09-30 by plan loop, done 2026-09-30 by feature; commit 64fc06d5)
- Operator notify hook: a configured shell command the harness runs when something needs a human (planned 2026-09-30 by plan loop, done 2026-09-30 by feature; commit 91e0b808)
- An error-streak circuit breaker: a loop that keeps failing gets paused, not just warned (planned 2026-09-30 by plan loop, done 2026-09-30 by feature; commit 16983baf)
- Reject a change that files a new plan directly under `## Done` (planned 2026-09-30, done 2026-09-30) — part 4/4, the gate rule (commit 2f366f5e)
- Backlog structure check at the review gate and the in-lock landing re-check (planned 2026-09-30, done 2026-09-30) — part 2/4, the backstop (commit 4c53188d)
- The build-stale alert's refresh icon becomes a button that forces a restart (planned 2026-09-30, done 2026-09-30; commit 05165700)
- Stranded-plan detection: the clean loop re-files an open plan sitting under `## Done` (planned 2026-09-30, done 2026-09-30) — part 3/4, the repair (commit 6845a5d7)

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
