# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### `tumwater prompt --file <path>` — queue a steering prompt from a file or stdin (planned 2026-10-03 by plan loop)

**Goal.** Steering prompts today must be typed as CLI arguments (`tumwater prompt "..."`), so a long,
multi-paragraph request means shell quoting pain and hits argv-length limits. `tumwater init` already
accepts `--file <path>`; the steering command should speak the same idiom. Add `tumwater prompt
--file <path>`, where a path of `-` reads the prompt from stdin (so `cat note.md | tumwater prompt
--file -` works), combinable with the existing `--role <id>`.

**Approach.**
- `parsePromptArgs` in src/cli-command-args.ts: add `--file` to `PROMPT_FLAG_SPECS`, extend the
  unknown-argument message, and, when the flag is present, claim its value and refuse stray
  positional tokens (same `failStrayArg` shape init's `--file` branch uses: "with --file the prompt
  comes from the file"). Read the file with `fs.readFileSync(path, "utf8")`; when the value is
  `-`, read stdin synchronously (`fs.readFileSync(0, "utf8")`). Fail with the init wording when the
  file cannot be read (`cannot read prompt file ...`) or is whitespace-only (`the prompt file ...
  is empty — it carries no prompt text`). `--file` composes with `--role` and `--json`-free enqueue
  mode only; combining it with `--list` or `--cancel` fails (`--file only queues a prompt`).
- `cmdPrompt` in src/prompt-commands.ts: in the enqueue branch, `parsed.text` already carries the
  resolved text — no change beyond whatever field naming the parser needs; the enqueue path
  (`submitRolePromptAndWake`) and the queued-age/preview rendering are untouched.
- `help.ts`: list the flag on the prompt command's usage line.
- Tests: extend the existing parsePromptArgs test file (grep `parsePromptArgs` under test/) with
  cases — `--file` + `--role` composition, `-` reading stdin (feed a pipe in the test), missing
  value, unreadable path, empty file, and combination with `--list`/`--cancel` failing; and one
  cmdPrompt-level test that a queued `--file` prompt lands in the director queue verbatim.

**Files touched.** src/cli-command-args.ts, src/prompt-commands.ts, src/help.ts, test/ (the
parsePromptArgs and prompt-command test files).

**Acceptance criteria.**
- `tumwater prompt --file note.md` queues note.md's contents verbatim for the director; with
  `--role qa` it queues for qa.
- `echo hi | tumwater prompt --file -` queues "hi".
- Stray positional tokens with `--file`, a missing/unreadable/empty file, and `--file` plus
  `--list`/`--cancel` each fail with a message naming the problem.
- `tumwater help prompt` shows `--file <path>`; the suite passes.

<!-- One more plan already in ## Planned would end a plan tick in TUMWATER_NOTHING_TO_DO -->


## Done

### The dashboard's Settings view: view and edit the curated top-level config keys live (planned 2026-10-02 by plan loop, done 2026-10-02 by feature)

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

### The TUI moves to ink, part 3/3: retire the hand-rolled renderer remnants and correct the docs (planned 2026-10-01 by director; requires part 2b/3 landed, done 2026-10-02 by feature)

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

- The cap-paused loop is legible: the status table, TUI, GUI, and `status --json` read the same cap verdict (planned 2026-09-30, done 2026-10-01; commit 7f1c19cf)
- Per-role daily cost cap: a loop over its own cap stops starting ticks — the feed names it, the notify hook pages, midnight or an edit lifts it (planned 2026-09-30, done 2026-10-01; commit cd019473)
- Budget warning at 80% of the daily cap: the notify hook pages before the gate bites, not after (planned 2026-09-30, done 2026-09-30; commit e69e3102)
- `tumwater pause --reason <text>` — the operator pause records why, and every observer states it (planned 2026-09-30, done 2026-09-30; commit 1ce00350)
- `tumwater prompt --list --json` — the queued-prompt listing as machine-readable data (planned 2026-09-30, done 2026-09-30; commit 0dee85db)
- Tick drill-down in the GUI History view: one row expands to that tick's event trail (planned 2026-09-30, done 2026-09-30; commit 84a2e069)
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
