# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### `tumwater tick <role> --last` — the newest tick's trail without knowing its number (planned 2026-10-04 by plan loop)

**Goal.** `tumwater tick <role> <n>` answers "what did tick #7 do?" — but the operator's actual question after an incident is "what did the latest tick do?", and getting there today means running `history --role <id>` first to learn the number, then `tick <role> <n>`. Add a `--last` form: `tumwater tick <role> --last` resolves the role's newest completed tick in the scanned window and prints its trail exactly as `tick <role> <n>` would, sharing every rendering path. `--last` and a numeric `<n>` are rivals: `tick <role> --last 3` and `tick <role> 3 --last` fail with the usage.

**Approach.** Small wiring on top of existing machinery; no collector changes.

- `src/cli-flag-specs.ts` — add `export const LAST_FLAG: FlagSpec = { names: ["--last"] }` beside `JSON_FLAG`.
- `src/cli.ts` dispatcher `case "tick"` — admit `LAST_FLAG` in the `rejectUnknownArgs("tick", rest, [...])` call, and relax the pre-gate arity check from `positionals.length !== 2` to `positionals.length < 1 || positionals.length > 2` so the one-positional `--last` form reaches `cmdTick` (which already owns arity and keeps its own guard — the dispatcher comment says as much).
- `src/tick-detail.ts` `cmdTick` — take the extra flag (extend the signature to `(root, positionals, json, last)`, passing `rest.includes("--last")` from cli.ts). Arity rules: `last` accepts exactly one positional (`<role>`); the numeric path keeps exactly two. With `last`, resolve the newest tick via `readTickRows(root, 1, role)` from `src/history-data.ts` — rows come newest-first, so the first row's `tick` is the number; an empty array takes the existing not-found path (`sayJson(null)` / `tickNotFoundMessage(role, 0)` is wrong under `--last`, so make the not-found wording for this form say `no completed tick for <role> in the scanned window…` — extend `tickNotFoundMessage` or add a sibling `tickNotFoundLastMessage` and keep both used by the GUI's 404 wording where applicable; pick one shape and use it consistently). The resolved number then flows through the unchanged `readTickDetail` → `renderTickDetail` / `sayJson(detail)` tail — no rendering changes at all.
- `TICK_USAGE` becomes `"tumwater tick <role> [<n>] [--last] [--json]"` — it is the single string the dispatcher gate and `cmdTick`'s guards both fail with, so all three sites move together.
- `src/help.ts` — update the `tick` stanza's usage line and add one sentence: `--last` shows the newest completed tick's trail instead of numbering it.
- `README.md` — extend the per-tick-history row's `tumwater tick <role> <n>` mention with the `--last` spelling, phrased like the surrounding flags.

**Files touched:** `src/cli-flag-specs.ts`, `src/cli.ts`, `src/tick-detail.ts`, `src/help.ts`, `README.md`, plus tests in `test/tick-detail.test.ts` (`--last` resolves the newest tick's trail identical to naming that number; `--last` on an empty log exits 0 with the parseable `null` under `--json` and the last-form not-found line otherwise; `tick <role> --last 3` fails with the usage; `--last` with an unknown role keeps the unknown-role wording) and `test/cli-arg-strictness.test.ts` (the dispatcher admits `--last` for `tick` and still rejects it elsewhere).

**Acceptance criteria:**
- After a tick has run, `tumwater tick <role> --last` prints the same trail `tumwater tick <role> <n>` prints for the newest tick number (the tests assert this equality on a fixture log).
- On a log with no ticks for the role, both renderings exit 0 and `--json` prints `null` (the command's documented JSON-in-every-exit-0 contract).
- `--last` combined with a numeric `<n>`, a missing role, or an unknown role fails with the usage or the unknown-role wording before any read.
- Plain `tick <role> <n>` behavior is byte-unchanged, and `npm run test` passes.


## Done

### `tumwater run --for <duration>` — a bounded fleet run that drains and exits at the deadline (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** `tumwater run --once` gives a single round of ticks and exits — the cron-style invocation. An operator who wants the fleet to run for a bounded *window* (an overnight trial, a demo, a CI step, "run for two hours then stop") has to background the process and kill it by hand, which loses the graceful drain. Add `tumwater run --for <duration>` (e.g. `run --for 2h`): boot the fleet, run it until the deadline, then run the same graceful stop a Ctrl+C would run — in-flight ticks finish, the loop drains, a summary line prints — and exit.

**Approach.** Everything hangs off machinery that already exists; no orchestrator changes.

- `src/cli-flag-specs.ts` — add `{ names: ["--for"], value: true, valueName: "<duration>", validate: (v) => parseDurationFlag("--for", v) }` to `RUN_FLAG_SPECS`, so the dispatcher's `rejectUnknownArgs` gate accepts the spelling and rejects a malformed value with the parser's own wording before the ready-repo gate.
- `src/cli-run.ts` `cmdRun` — parse `--for` with `parseDurationFlag` (the same helper the gate ran). Two body-level rules, both fail fast before boot: `--for` and `--once` are rivals (a one-round run and a windowed run cannot both apply — fail with a message naming both flags), and the cap is `pause --for`'s (`PAUSE_FOR_MAX_MS`, via the `failOverDurationCap` helper in operator-commands.ts — import it or move the shared helper; pick one site and keep the wording identical). Where `--once` sets `once = true`, a `--for` run stays a daemon-shaped run: keep `createRedeployer` and `LaunchServicesWatch` exactly as they are — a mid-run self-redeploy hands off to the supervisor, which forwards the same args (including `--for`), so the deadline restarts in the new generation; state that in the command's doc comment rather than coding around it.
- After the boot banner, when a deadline was given: `setTimeout(forMs, stop)` armed beside the existing `SIGINT`/`SIGTERM` handlers (the same `stop` closure, so the drain-and-exit path is literally identical), plus `clearTimeout` in the existing `finally` so an early Ctrl+C or a redeploy hand-off does not leave a stray timer. The boot banner says the window: `tumwater running on branch <name> · for 2h · build <sha>… — Ctrl+C to stop`. When the timer fires first, say a one-line `deadline reached — stopping` before the existing stop message so the log shows why.
- Summary: a `--for` run prints the `onceSummary` line on exit (reuse the existing function; it already supports being called without settle reasons, deriving from `ticksBefore` deltas), so a scheduled invocation's log shows what the window accomplished. `--once` keeps its own settle-reason summary; the two stay separate call sites.
- `src/help.ts` — extend the `run` usage line to `[--branch <name>] [--once] [--for <duration>] [--role <id>]` with a one-line explanation (windowed run, drains like Ctrl+C at the deadline; `--role` stays once-only).
- `README.md` — one row/note in the usage table for `run --for <duration>`, phrased like the `--once` sibling.

**Files touched:** `src/cli-flag-specs.ts`, `src/cli-run.ts`, `src/help.ts`, `README.md`, plus tests in `test/cli-run.test.ts` (flag parsing: `--for` accepted, `--for abc` rejected with the duration wording, `--for` + `--once` rival rule, over-cap rejection, `--for` without a value named by the gate) and `test/cli-run-live.test.ts` (one harness run with a short `--for` boots, stops itself at the deadline, drains, and prints the summary line — no real model; the fake pi shim stays on PATH).

**Acceptance criteria:**
- `tumwater run --for 45m` boots the fleet, and without any operator input stops, drains in-flight ticks, prints the deadline line and the summary, and exits 0.
- `run --once --for 5m` fails before boot naming both flags; `run --for 200d` fails with the cap wording; `run --for abc` and a trailing bare `--for` fail with the parser's wording before any repo gate.
- Ctrl+C during a `--for` run still works and cancels the pending timer; the graceful-stop path is the same code either way.
- `npm run test` passes with the new tests added and no existing behavior changed for plain `run` and `run --once`.

### Dotted per-role config keys: `config get/set maxDailyCostUsdPerRole.<role>` and `roles.<id>.<field>` (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** `tumwater config set` writes whole top-level keys only (src/config-write.ts
`setConfigKey`): the per-role maps (`maxDailyCostUsdPerRole`, `quietHoursPerRole`) and the
`roles` section must be replaced wholesale, so `config set maxDailyCostUsdPerRole
'{"feature":1.5}'` silently drops every other role's entry and `roles.<id>` edits require
re-typing the whole entry. The per-role knobs landed 2026-10-04 are exactly the ones an
operator steers one role at a time — raising `feature`'s cap should not require knowing
qa's. Add dotted keys: `<map>.<role>` for the two per-role maps and `roles.<id>.<field>`
for role entries, each MERGING one entry into the existing map/section; bare keys keep
today's whole-key behavior.

**Approach.**
- `src/config-write.ts`: a `DOTTED_MAP_KEYS` table `{ maxDailyCostUsdPerRole: number,
  quietHoursPerRole: string }` and a dotted-key parser `parseConfigKey(key)` →
  `{ kind: "map", map, role } | { kind: "role", id, field } | { kind: "top", key } | { error }`.
  - Map write: fresh load → spread the existing map (or `{}`) with the new entry →
    validateConfig (its `checkKnownRoleId` and `checkNumberField`/quiet-hours checks over the
    merged map stay the single source of type and role-id truth) → atomic write. The dollar
    cap pre-check reuses `checkDailyBudgetUsd`; the quiet-hours value reuses
    `PER_KEY_VALIDATORS`' `checkQuietHours`.
  - `roles.<id>.<field>`: spread the existing entry, set `field` (must be in
    `ROLE_ENTRY_KEYS` — a `setConfigKey`-style did-you-mean via `suggestClosest` otherwise),
    then the same validate → write idiom. `<id>` naming an unknown role fails with
    validateConfig's known-roles message when validation runs; the parser only checks shape.
  - `unknownConfigKeyError` keeps top-level membership for bare keys unchanged.
- `src/config-commands.ts` `cmdConfig`: `config get maxDailyCostUsdPerRole.feature` reads
  the resolved config and prints `config.maxDailyCostUsdPerRole?.["feature"] ?? null` — the
  same absent-key→null rule the whole-key get applies. The get path needs no new module:
  split the dotted key in place and index.
- `src/help.ts` CONFIG area and README.md's audit/`config` mention: one clause — "dotted
  keys (`maxDailyCostUsdPerRole.feature 1.5`, `roles.qa.model x`) merge one entry; bare
  keys replace the whole value".

**Files touched:** src/config-write.ts, src/config-commands.ts, src/help.ts, README.md,
plus tests.

**Acceptance criteria.**
- `config set maxDailyCostUsdPerRole.feature 1.5` leaves qa's existing entry byte-identical
  in the file and sets feature's to 1.5; `config get maxDailyCostUsdPerRole.feature` prints
  `1.5`, and an unset role prints `null`.
- `config set quietHoursPerRole.qa "23:00-07:00"` merges into the existing per-role map;
  an invalid window fails with `checkQuietHours`'s message and the file is untouched.
- `config set roles.qa.model x` merges into qa's existing entry (other fields preserved);
  `config set roles.qa.colour x` fails naming `ROLE_ENTRY_KEYS`' nearest match; a typo'd
  role id fails with validateConfig's known-roles message.
- Bare-key behavior (whole-value replace, unknown-key error, absent-key `null` get) is
  unchanged — covered by the tests already in test/config-write.test.ts and
  test/config-commands.test.ts, which must keep passing.
- New tests beside them cover: merge-not-replace for both maps and a role entry, dotted get
  hit/miss/null, and the three failure shapes (bad value, bad field, bad role id).
  `npm run test` passes.

### `tumwater wake --in <duration>` — schedule a wake that arrives later, the scheduled sibling of `pause --for` (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

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
  parameter — the absolute ms-epoch deadline. When it is still ahead the wake is SCHEDULED:
  ONLY the marker is written (`{ at, roles, notBeforeMs }`; `{ at, roles }` stays the absent
  case, so older markers keep parsing) and the backoff-clearing state change is SKIPPED — it
  belongs to the deadline, not the submit, so a fleet stopped at submit (or restarted before
  the deadline) does not wake early; `consumeWakeRequest` applies it when it consumes the
  marker at or after the deadline. At-or-past deadlines read as immediate. The confirmation
  gains `wake scheduled for <roles> — wakes in ${durationLabel(ms)} — …` on the deferred path,
  reusing the phrasing `prompt --at`'s confirmation uses.
- `src/operator-requests.ts` `consumeWakeRequest`: before the `roleRequestTargets` read, if
  the marker carries a numeric `notBeforeMs` greater than `Date.now()`, return WITHOUT removing
  the marker — a later poll retries it; the wake lands within one poll cycle after the
  deadline, the same delivery granularity `prompt --at`'s consumer gives. At or past the
  deadline the existing consume path runs, and its `wake()` call is what clears the schedules
  the submit skipped. A non-numeric value reads as immediate (defensive; validation happens at
  the CLI).
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
   `customLoops` and per-role maps stay CLI/director territory; later extracted to its own
   src/config-editable-keys.ts beside the other config-key vocabularies — organize, 2026-10-04) and two handlers modeled on
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

- The TUI moves to ink, part 1/3: adopt ink and render the frame with it (planned 2026-10-01, done 2026-10-01; commit 46420542)
- The budget badge says when the cap will be hit: a burn-rate projection in the shared badge (planned 2026-10-01, done 2026-10-01; commit 483a8026)
- The dashboard speaks when the fleet needs you: a synthesized audio cue on a new needs-you alert, with a mute toggle (planned 2026-10-01, done 2026-10-01; commit d763bf09)
- The dashboard's Queued tab shows each prompt's age — part 2/2, the observers (planned 2026-10-01, done 2026-10-01; commit 68dd5de0)
- `tumwater prompt --list` shows how long each prompt has waited — part 1/2, the shared stamp and the CLI (planned 2026-10-01, done 2026-10-01; commit bbd9f5b6)
- The sidebar's Build row refresh icon restarts the build, like the build alert's icon (planned 2026-10-01, done 2026-10-01; commit 05165700)
