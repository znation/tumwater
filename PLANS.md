# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### `tumwater wake --in <duration>` — schedule a wake that arrives later, the scheduled sibling of `pause --for` (planned 2026-10-04 by plan loop)

**Goal.** `tumwater wake` clears backoff the moment it runs, but an operator often knows the
world changes LATER — a cron finishes at 02:00, a CI run ends in 40 minutes, a dependency
update lands after midnight. Today the only scheduled lever is a queued prompt (`prompt --at`,
which deliberately wakes the target loop when it delivers), but that burns a model run whose
text must be invented; the operator wants the plain "try again at T" demand. Add
`--in <duration>` to `wake`: the marker is written now but consumed no earlier than
`now + duration`, exactly mirroring `pause --for`'s auto-resume and `prompt --at`'s
deferred-delivery marker. Without `--in`, behavior is identical to today. No new marker file,
no new consumer loop — the existing wake request path grows one optional field and one gate.

**Approach.**
- `src/cli-flag-specs.ts`: add `WAKE_IN_FLAG` (`names: ["--in"]`, `value: true`,
  `valueName: "<duration>"`, validate: `parseDurationFlag("--in", value)`) beside
  `DURATION_FLAG`, so the gate names a typo'd value before the ready-repo gate — same shape
  as the `--for` spec.
- `src/cli.ts` `runMarkerCommand`: the accepted-flag list becomes
  `command === "pause" ? [ROLE_FLAG, DURATION_FLAG, REASON_FLAG] : command === "wake" ?
  [ROLE_FLAG, WAKE_IN_FLAG] : [ROLE_FLAG]`, so a stray `--in` on pause/reset-counters still
  fails fast. Update the comment naming the per-command vocabularies.
- `src/operator-commands.ts` `cmdWake`: when `flagValue(args, "--in")` is non-null, parse it
  with `parseDurationFlag("--in", ...)` (the failOverDurationCap idiom in cli-args.ts applies —
  the same ceiling `pause --for` honors), compute `dueMs = Date.now() + ms` at submit (the
  deferral starts when the operator typed it — the decision `prompt --at`'s comment records),
  and pass it through.
- `src/operator-intent.ts` `requestWake`: add an optional trailing `notBeforeMs?: number`
  parameter, written into the marker as `notBeforeMs` when present (`{ at, roles }` stays the
  absent case, so older markers keep parsing). The confirmation gains
  ` — wakes in ${durationLabel(ms)}` on the deferred path, reusing the phrase `prompt --at`'s
  confirmation uses.
- `src/operator-requests.ts` `consumeWakeRequest`: before the `roleRequestTargets` read, if
  the marker carries a numeric `notBeforeMs` greater than `Date.now()`, return WITHOUT removing
  the marker — a later poll retries it; the wake lands within one poll cycle after the
  deadline, the same delivery granularity `prompt --at`'s consumer gives. A non-numeric value
  reads as immediate (defensive; validation happens at the CLI).
- `src/help.ts` and README.md's control-table `wake` row: append `--in <duration>` to the wake
  usage with a one-clause scheduled-wake phrase, beside `pause --for`.

**Files touched:** src/cli-flag-specs.ts, src/cli.ts, src/operator-commands.ts,
src/operator-intent.ts, src/operator-requests.ts, src/help.ts, README.md, plus tests.

**Acceptance criteria.**
- `tumwater wake --in 45m` writes a wake marker whose `notBeforeMs` is ~45 minutes out; a poll
  run before the deadline leaves the marker in place and wakes nothing; a poll after it wakes
  exactly the marker's roles and removes it.
- `tumwater wake --role qa --in 2h` targets only qa; without `--in` every existing wake
  behavior (all-roles default, immediate consume, marker shape) is unchanged.
- `--in` on any other marker command, a malformed duration (`--in xyz`), and a missing value
  each fail fast at the CLI gate with a message naming the flag.
- Tests cover the consume-gate (before/at/after the deadline: marker preserved, then
  consumed), `requestWake`'s marker field, `cmdWake`'s flag parsing, and the strict-args gate
  for the new flag — in test/operator-requests.test.ts, test/operator-intent.test.ts, and
  test/cli-operators.test.ts beside the wake cases already there. `npm run test` passes.

## Done

### Per-role quiet hours: `quietHoursPerRole`, the scheduled sibling of `maxDailyCostUsdPerRole` (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** The fleet-wide `quietHours` window silences every role at once, but the operator's
real schedule is per-role: run the cheap roles around the clock and hold the expensive ones
during working hours (or let one noisy role sleep while the rest of the fleet works overnight).
Add a top-level `quietHoursPerRole?: Record<string, string>` config key, keyed by role id,
mirroring `maxDailyCostUsdPerRole`: a loop whose own window is active starts no new ticks until
its window ends or a live edit removes it; in-flight ticks finish; the director is exempt, as
under every autonomous gate; an absent key or an empty-string window means off for that role.
The fleet-wide `quietHours` keeps working unchanged — a role is held when EITHER window covers
`now`.

**Approach.**
- `src/quiet-hours.ts`: reuse the existing parser — `parseQuietHours` already validates one
  `"HH:MM-HH:MM"` value (wrapping windows included) and `inQuietHours(window, date)` decides
  membership. Add one small helper, `roleQuietHold(perRole: Record<string, string> | undefined,
  role: string, now: Date): boolean`, that parses the role's value and returns membership
  (an absent key, a non-string, or an unparseable value reads as off here; validation is
  config-validation.ts's job, not this helper's).
- `src/gate-polls.ts`: `pollAllGates` computes a stateless per-role hold set — for each runner
  but the director, `roleQuietHold(liveConfig.quietHoursPerRole, role, new Date(now))` — and
  returns it as `roleQuietHold: ReadonlySet<string>` beside `capPaused`. No new event type and
  no state: unlike the fleet-wide gate (which logs exactly one
  `quiet_hours_started`/`quiet_hours_ended` per crossing), a per-role hold is an anonymous,
  stateless verdict recomputed per poll, exactly like `capPaused`'s set (the pause marker is
  anonymous and must never masquerade as an operator's).
- `src/orchestrator.ts`: where the scheduling pass folds `quietNow` into the no-new-tick hold
  (the `(userPaused || quietNow || ...)` condition), add the role's membership in
  `roleQuietHold` as a fourth disjunct, director-excluded by the same existing role check.
- `src/config-schema.ts`: add `quietHoursPerRole?: Record<string, string>` to the config
  interface (next to `maxDailyCostUsdPerRole`, with the same doc-comment shape) and to
  `TOP_LEVEL_KEYS`.
- `src/config-validation.ts`: beside the `maxDailyCostUsdPerRole` block, validate the map —
  object of strings; every key passes the same `checkKnownRoleId` gate (a typo'd role id would
  silently no-op the window); every value passes `checkQuietHours`'s parse (empty string
  allowed = off).
- `src/config-example.ts` / `src/help.ts` / README.md settings paragraph: name the new key one
  line after its fleet-wide sibling, so `tumwater config` users can find it.
- Status surface: follow status-data.ts's `roleCapPaused` pattern minimally — a loop held by
  its own window shows the same quiet-hours hold wording the fleet-wide gate already uses; if
  status-data.ts cannot distinguish the cause without new plumbing, note that in the plan's
  Done entry rather than growing the change.

**Files touched:** src/quiet-hours.ts, src/gate-polls.ts, src/orchestrator.ts,
src/config-schema.ts, src/config-validation.ts, src/config-example.ts, src/help.ts,
README.md, plus tests (quiet-hours and config-validation suites).

**Acceptance criteria.**
- A config with `quietHoursPerRole: { qa: "23:00-07:00" }` holds qa's new ticks inside the
  window (wrapping included) while other roles tick normally; the director is never held by it.
- A role held by its own window AND the fleet window is held once, not double-counted.
- A live `config set quietHoursPerRole` edit applies on the next poll cycle, like the
  fleet-wide window and the per-role caps.
- Validation rejects: a non-object, an unknown role id, and a malformed window string, each
  with a message naming the key and the offending id/value.
- Tests cover the helper (in/out/absent-key/wrapping), the validation cases, and a gate-polls
  test asserting the hold set. `npm run test` passes.

_Note on the status surface: the plan's "same quiet-hours hold wording" is delivered — status-data.ts computes `roleQuietPaused` (role → window, director exempt) with the new roleQuietHold helper, and status-model.ts's loopPhase renders the fleet badge's own `quiet until <end>` wording scoped to the loop's window, carried to the GUI payload through status-payload.ts. `src/config-example.ts` holds no key catalog (it seeds from the tracked tumwater.example.json, which sets no quietHours), so it needed no change; help.ts and the README settings paragraph name the new key beside its fleet-wide sibling._

### `tumwater prompt --at <duration>` — queue a steering prompt that stays hidden until its time arrives (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** Operators can already queue a prompt for a loop's next tick, but "remind the fleet to
re-check coverage in 3h" means staying awake to run `tumwater prompt` then. Let a queued prompt
carry a not-before time: it is listed and cancellable from the moment it is queued, but the loop
cannot dequeue it until the time arrives, and its existence alone never wakes the loop early.

**Approach.**
- Marker format: a deferred prompt's queue file starts with one line
  `tumwater:not-before <iso-utc>` followed by a blank line, then the prompt text. Everything
  downstream already treats queue-file text opaquely, so the marker rides in the content and no
  queue format migrates. (Implemented as planned; a follow-on refinement strips the marker from
  every operator-facing surface — promptPreview and `prompt --list`'s text — so plumbing never
  shows in a preview, the Queued tab, or a cancel reply; the queued file and the dequeued tick
  text still carry it verbatim.)
- `src/inbox.ts` owns the mechanics:
  - New exported `notBeforeMs(text: string): number | null` — parse the marker line; anything
    absent or malformed reads as null (deliverable). An ISO stamp missing/unparseable is null so
    a hand-edited file can never strand a prompt forever. (Done; plus the shared
    `stripNotBeforeMarker` display helper.)
  - `enqueueRolePrompt` gains an optional `notBeforeMs` argument (or callers prepend the marker
    via the existing decorate hook) — pick whichever keeps the marker written in the same single
    atomic `writeTextAtomic` call. (Done: the marker composes in the one write, ahead of the
    decorate hook's output.)
  - `dequeueRolePrompt` iterates `queuedFiles` and pops the first file whose text (via the
    existing stat-keyed `promptCache` read) is deliverable now; a queue holding only future
    prompts returns null. The dequeue-vs-cancel race policy is unchanged. (Done; the
    deliverability read keeps the module's ENOENT-vs-other-error discrimination so the pinned
    rethrow-on-EACCES behavior still holds.)
  - `peekRolePrompt`/`queuedRolePrompts` follow the same filter, so `tumwater role <id>`'s
    next-prompt preview never shows a prompt the tick cannot yet take. (Done.)
  - `inboxSize` and `queuedRolePromptCount` exclude not-yet-deliverable prompts, so a deferred
    prompt does not make its loop due by itself (scheduling.ts's queued-prompt wake reads
    `inboxSize`); once due, the marker falls out of the count naturally. These functions
    currently document "no content read" — the stat cache makes the added read one stat per
    unchanged file, matching what the listing consumers already pay; update their doc comments.
    (Done.)
  - `queuedRolePromptEntries` and `queuedRolePromptRecords` gain `notBeforeMs`, so `prompt
    --list` and the dashboard's Queued tab can render a countdown (`in 2h 5m`, using
    `src/datetime.ts`'s `humanSeconds`) instead of an age for deferred entries. (Done; the
    prose countdown reads `delivers in 2h` through the same humanSeconds.)
  - Cancel paths are untouched: positions still number the full list, deferred entries included.
    (Done.)
- `src/prompt-commands.ts` + `src/cli.ts`: the `prompt` command accepts `--at <duration>`, parsed
  with `parseDurationFlag` (src/cli-args.ts), joined onto the enqueue for both the director and
  `--role <id>` forms; the enqueue confirmation names the delivery time. `help.ts`'s prompt
  stanza documents the flag. (Done; the flag is parsed in src/cli-command-args.ts — where
  parsePromptArgs lives — not src/cli.ts, whose pre-parse needed no change. The confirmation
  names the delay — `delivers in 90m`, via durationLabel — since --at is a duration, not an
  epoch.)
- Dashboard (`src/status-data.ts` consumers and the GUI client's Queued tab) renders the same
  `notBeforeMs` as the CLI list — defer a concrete GUI rendering decision to what the entries
  payload already carries; no new endpoint. (Done: a director-side `inboxNotBefore` array rides
  the payload beside `inboxQueuedAt`, role entries carry `notBeforeMs`, and the Queued tab shows
  `delivers in <duration>` for a not-yet-due entry, the age otherwise; src/ui/status-payload.ts
  and src/ui/gui-client-model.ts gained the pass-through.)

**Acceptance criteria.**
- New tests in test/inbox.test.ts: a deferred prompt is not dequeued before its time and is the
  first popped after it; a queue holding only deferred prompts dequeues null; counts exclude
  deferred prompts and include them once due; cancel by position still reaches a deferred entry;
  a malformed or missing marker reads as deliverable. (Done, with node:test mock-timer clocks.)
- test/prompt-commands.test.ts: `--at 90m` queues a prompt whose marker decodes to now+90m
  (inject the clock the way the pause --for tests do); `--list` shows the countdown; the
  confirmation names the delivery time. (Done, mock timers; also covers --role composition,
  the --json countdown field, and the read-only/destructive refusals.)
- test/cli-arg-strictness.test.ts covers `--at` without a value failing with the
  parseDurationFlag message. (Done.)
- `npm run test` passes; no other command's output changes except the documented list/countdown
  additions. (Done; the parsePromptArgs payload tests gained the new atDelayMs field, and the
  prompt-list/status/gui payload tests gained the notBeforeMs field — shapes the change itself
  documents.)

### `tumwater questions` — read and answer the open-question outbox from the CLI (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** QUESTIONS.md is the harness's channel for decisions that are genuinely the user's, but
answering one means hand-editing markdown: move the `### ` heading from `## Open` to `## Answered`
and append the decision. `tumwater backlog` lists questions read-only, and no CLI command can
answer one (grep over src/ finds no `tumwater questions`). Give operators a CLI so the
loop→human→loop round trip is one command each way, matching the `prompt --list` /
`prompt --cancel` pattern.

**Approach.**
- New module `src/question-commands.ts`:
  - `openQuestionList(root)` — number `openQuestionEntries(root)` (src/backlog.ts) 1..N, keeping
    file order; render as numbered lines with the question title and an ellipsized first body
    line (the `prompt --list` shape).
  - `answerQuestion(root, n, decision)` — load QUESTIONS.md, cut the Nth `### ` entry (heading
    plus its body lines) out of `## Open` using `sectionLines`/`sectionBodyLines`
    (src/backlog.ts), append it at the end of `## Answered` with a
    `**Answered YYYY-MM-DD by operator:** <decision>` paragraph (today's local date,
    src/datetime.ts's local-date helper), and write the file back. `n` out of range → an
    `tumwater: no question at position N (M open)` error and exit 1, mirroring
    `prompt --cancel`'s wording. A missing or `## Answered`-less QUESTIONS.md is created/extended
    with the file's documented two-section skeleton.
  - `questionListPayload(root)` — the same entries as data for `--json` (the backlog --json
    pattern: a JSON document in every exit-0 case, never prose).
- `src/cli.ts`: new `case "questions"` next to `backlog` — no requireReadyRepo gate (the readers
  degrade to empty like backlog's); with no args, the numbered list; `answer <n> <decision>`
  (one positional n plus the rest as the decision text) performs the move and prints one
  confirmation line; `--json` swaps list and answer result for payloads. `rejectUnknownArgs`
  allows only `--json`.
- `src/help.ts`: one usage entry — `tumwater questions [--json]` and
  `tumwater questions answer <n> "<decision>"`, naming that the answer stamps today's date and
  moves the entry to `## Answered`, which loops read at their next tick.
- Tests `test/question-commands.test.ts`: numbering of a seeded two-question file; an answer
  moves only the named heading block (its body and neighbors intact, file order kept);
  `**Answered …by operator:**` carries the real local date; out-of-range n errors with the exact
  wording; `--json` payload shape; missing QUESTIONS.md degrades to the empty list.

**Files touched:** src/question-commands.ts (new), src/cli.ts, src/help.ts,
test/question-commands.test.ts (new).

**Acceptance criteria.**
- `tumwater questions` lists open questions numbered as `--list` shows them; `questions answer 1
  "use ink"` on a two-question file moves question 1's full block to `## Answered` with the
  decision and today's date, leaves question 2 numbered 1 afterward, and exits 0.
- `tumwater questions answer 9 "x"` exits 1 with the `no question at position` wording.
- `tumwater questions --json` prints the payload document; `questions answer … --json` prints the
  answer result as JSON.
- `npm run test` passes, including the new test file.

### `tumwater init --template` — seeded project templates so a fresh fleet starts with signal (planned 2026-10-04 by plan loop, implementing docs/feature-project-templates.md, done 2026-10-04 by feature)

**Goal.** Give `tumwater init` a `--template <id>` option that seeds a fresh project with a
brief preamble and a starter `PLANS.md`, so the fleet's first ticks land on real work instead
of cold-starting from a one-line brief. `blank` (today's behavior) stays the default.

**Approach.**
1. New `src/init-templates.ts` — a static catalog (`INIT_TEMPLATES`) of exactly four templates
   as bundled string data (zero runtime deps, no file reads): `blank` (no preamble, no seeded
   backlog — byte-identical to today's init), `python-cli`, `node-cli`, `static-site`. Each
   non-blank template carries: a one-line `description`, a `briefPreamble` (the framing the doc
   specifies — entry point, tests, docs expectations; the operator's own words stay appended
   after it so they read last), `starterPlans` (3–5 concrete first plans for the seeded
   `PLANS.md`, following the existing `## Planned` before `## Done` convention so the seeded
   file never trips the gate's structure checks — src/backlog.ts's parser and the clean loop's
   `<backlog-structure>` block both read that shape), and `starterDirs` (e.g. `src/`,
   `tests/` — empty directories only, created the way the harness already creates them; the
   fleet's own first ticks write any code). Export `templateIds()`, `getTemplate(id)`, and
   `templateCatalog()` (id + description, for `--list-templates`).
2. Flag plumbing in `src/cli-command-args.ts`: extend `INIT_FLAG_SPECS` and `parseInitArgs`'s
   return with `template: string | null` (validated against the catalog inside the parse so an
   unknown id fails fast listing the valid ones), plus `listTemplates: boolean` for
   `--list-templates`. `--list-templates` with a prompt is an error; alone it prints the
   catalog (id + description, one per line) and exits 0.
3. `src/init.ts` — `initProject` gains an `opts.template?: string` and threads the resolved
   template through the seeding it already does: the `initialPrompt` recorded between the
   tumwater:prompt markers becomes `briefPreamble + "\n\n" + prompt` (the operator's words
   remain the tail, so "latest instruction wins" reads naturally and the existing
   `INITIAL_PROMPT_MAX_CHARS` cap applies to the combined text — reject early if the preamble
   pushes it over), and when the template has `starterPlans` the seeded `PLANS.md`
   (the `PLANS_TEMPLATE` constant) gets the plans rendered as entries under `## Planned`.
   `blank` changes nothing — the existing assertions about today's output stay untouched.
   `InitResult` reports the template id used; `cmdInit` in `src/cli-run.ts` prints it.
4. `src/help.ts`: the init usage line gains `--template <id>` / `--list-templates`.
5. Tests in a new `test/init-templates.test.ts` (catalog shape: four ids, non-blank ones have
   description/preamble/starterPlans; seeded PLANS.md parses under src/backlog.ts's entry
   splitter with one entry per starter plan and `## Planned` first) plus extensions to the
   existing init tests (grep `test/` for `initProject(` fixtures — likely `test/cli-run.test.ts`
   or an init-focused file) covering: default blank is byte-identical to today, `--template
   python-cli` seeds preamble+plans+dirs, unknown id fails with the catalog listed,
   `--list-templates` prints and exits 0, and a preamble that overflows
   `INITIAL_PROMPT_MAX_CHARS` fails before any side effect.

**Files touched:** src/init-templates.ts (new), src/cli-command-args.ts, src/init.ts,
src/cli-run.ts, src/help.ts, test/init-templates.test.ts (new), plus the existing init test
file(s) and `test/cli-command-args.test.ts` for the flag parse.

**Acceptance criteria.**
- `tumwater init "a markdown-to-html converter" --template python-cli` seeds the brief with the
  template preamble after the operator's words, a `PLANS.md` holding that template's starter
  plans under `## Planned`, and the empty starter dirs; `npm run test` passes with the new tests
  green.
- Bare `tumwater init "..."` (no flag) produces output identical to before the change.
- `--list-templates` prints the four ids with descriptions; `--template nope` exits 1 naming the
  valid ids; no partial repo is left behind on any rejection (validation stays ahead of side
  effects, as the existing `initProject` preflight does).
- `docs/feature-project-templates.md` still describes the landed behavior — update it only if an
  acceptance-relevant detail diverged, and say so in the landing summary.

### The TUI's Ctrl+D quits like shell EOF and Ctrl+C interrupts the director's in-flight tick (planned 2026-10-04 by director, from the user's request, done 2026-10-04 by feature)

**Goal.** In `tumwater tui` the director prompt line is the site of text input, so the keys should
behave like a shell line editor: Ctrl+D on (any) line counts as EOF and exits the TUI, while
Ctrl+C is repurposed as the interrupt — it aborts the director's current in-flight tick when one
is running and does nothing (beyond a short flash notice) when none is.

**Approach.**
1. `createTuiKeys` in src/ui/tui-keys.ts: in `handleKey`, add a `key.ctrl && key.name === "d"`
   branch calling `deps.quit()` (same callback today's Ctrl+C branch at the top of `handleKey`
   uses). Change the existing `key.ctrl && key.name === "c"` branch: instead of `deps.quit()`, it
   calls `requestAbort(root, DIRECTOR_ROLE)` from src/operator-intent.ts and arms the flash
   notice (the same `FLASH_MS` mechanism the other actions use) with the abort confirmation from
   its `{ok, message|error}` result — on `ok:false` (e.g. `NO_HARNESS_ERROR`, no fleet running)
   flash the error text instead. Gate the abort on a new `directorInFlight` flag: extend
   `TuiKeysState`/`syncSnapshot` with it (src/ui/tui.tsx already calls `syncSnapshot` each frame
   at tui.tsx:131, and `renderStatusSpans` at tui.tsx:135 returns the per-loop `StatusLoopRow[]`
   with `inFlight` — pass `loops.find(r => r.role === "director")?.inFlight === true`, reading
   rows from the render it already computes). When `directorInFlight` is false, Ctrl+C flashes a
   short notice ("no director task in flight") and quits nothing.
2. Hint lines in src/ui/tui-frame.ts: every `hintKeys` branch that lists `["Ctrl+C", "quit"]`
   (the budget-mode, role-prompt, backlog, usage/failures, and default branches) becomes
   `["Ctrl+D", "quit"]`; the default (director-prompt) branch gains `["Ctrl+C", "interrupt director"]`.
   Extend the `mode`/hint input shape if the flag needs to reach it.
3. Update the stale claims: the `TuiKeysDeps.quit()` doc comment ("Ctrl+C: …") and the
   `exitOnCtrlC is false because Ctrl+C is the TUI's own quit key` comment in src/ui/tui.tsx —
   reword to name Ctrl+D as quit and Ctrl+C as director interrupt.
4. Tests in test/tui-keys.test.ts (and tui-frame.test.ts for the hint lines): extend the existing
   key-dispatch fixtures — ctrl+d quits (quit callback fired), ctrl+c with `directorInFlight`
   true fires `requestAbort` for the director and flashes the confirmation, ctrl+c with it false
   does not abort and flashes the no-task notice, and quit is not called by ctrl+c in either case.
   `requestAbort` writes a marker file — point the test's `root` at a fixture dir the way the
   existing operator-key tests do (see test/tui-operator-keys.test.ts and test/tui-fixtures.ts),
   so no real fleet is touched.

**Files touched:** src/ui/tui-keys.ts, src/ui/tui.tsx, src/ui/tui-frame.ts,
test/tui-keys.test.ts, test/tui-frame.test.ts, test/tui-fixtures.ts (the fake-TTY quit now
presses Ctrl+D), test/tui.test.ts and test/tui-reload.test.ts (teardown tests renamed to
Ctrl+D), test/tui-role-prompt.test.ts (one hint-line regex).

**Acceptance criteria.**
- Ctrl+D in the TUI exits (the quit path — render teardown and main-loop resolve — exactly as
  today's Ctrl+C does).
- Ctrl+C while the director row's `inFlight` is true writes the director abort marker (via
  `requestAbort`) and flashes its confirmation; Ctrl+C with no director tick in flight flashes a
  no-task notice and leaves the fleet untouched.
- Every hint line shows Ctrl+D as quit; the director-prompt view additionally shows Ctrl+C as
  interrupt-director.
- `npm run test` green; no doc or comment in the repo still claims Ctrl+C quits the TUI
  (`grep -rn 'Ctrl+C.*quit' src/ docs/ README.md` returns only the CLI's own `run`/`stop` Ctrl+C
  lines in src/help.ts, src/cli-run.ts, src/operator-commands.ts, which are about the harness
  process, not the TUI).



### `tumwater prompt --file <path>` — queue a steering prompt from a file or stdin (planned 2026-10-03 by plan loop, done 2026-10-03 by feature)

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
- `tumwater prompt --file note.md` queues note.md's contents for the director; with `--role qa`
  it queues for qa.
- `echo hi | tumwater prompt --file -` queues "hi".
- Stray positional tokens with `--file`, a missing/unreadable/empty file, and `--file` plus
  `--list`/`--cancel` each fail with a message naming the problem.
- `tumwater help prompt` shows `--file <path>`; the suite passes.

**Correction (2026-10-03, on landing).** "Verbatim" holds at the parser — `parsePromptArgs` returns
the file's contents whole — but the enqueue path's pre-existing trim in inbox-submit.ts
(`submitRolePrompt`/`submitRolePromptAndWake` trim before queueing) strips leading/trailing
whitespace from everything it queues, `--file` or not. The queued text is the file's content
trimmed at the edges; the tests pin the parser's verbatim return and the queue's trimmed result.
Also found while landing: cli.ts pre-parses prompt's args and cmdPrompt re-parses them, so a
second `fs.readFileSync(0)` on a drained pipe read an empty prompt — the stdin read is memoized
at module level in cli-command-args.ts, and the now-stale "parsePromptArgs is pure" comment in
cli.ts says so.
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
2. **src/ui/gui-server.ts:** route `GET /api/config` and `POST /api/config-set` next to the
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
