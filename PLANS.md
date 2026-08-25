# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### CLI subcommand to reset loop counters — ticks, commits, tokens, cost (planned 2026-08-25)

**Goal:** A new `tumwater reset-counters [--role <id>]` command that zeroes the per-loop
counters shown in the TUI/GUI tables — ticks, commits, tokens, cost — so a user can start a
fresh observation window (e.g. "cost since today") without restarting the fleet. Requested by
the user 2026-08-25.

**Why it is not just rewriting files:** the dashboards read state from disk (`snapshot()` in
src/status.ts calls `loadLoopState` per render), but each running `LoopRunner` keeps its own
copy in memory (loaded once in the constructor, src/loop.ts) and re-saves it at tick start and
tick end. A CLI that only zeroes `.tumwater/state/<role>.json` would be clobbered by the next
save — so the command must reach both the files *and* the in-memory state of running runners.

**Approach:**
- `src/paths.ts`: new `resetRequestPath(root)` → `.tumwater/reset-counters.json` (the marker a
  running fleet consumes).
- `src/state.ts`: new pure helper `zeroCounters(s: LoopState): LoopState` — sets exactly
  `ticks`, `commits`, `totalTokens`, `totalCostUsd` to 0 and preserves everything else
  (`nextRunAt`, `backoffSeconds`, `lastMainHead`, `hasSession`, `consecutiveErrors`, the
  last-result fields) so scheduling, wake-on-main-moves, and pi session continuity are
  untouched.
- CLI (`src/cli.ts`): new `reset-counters` case beside `status`/`prompt`. Optional
  `--role <id>` (validated with `roleById`, same pattern as `logs --role`); default is every
  role in the config. For each target: load state, `zeroCounters`, save atomically — immediate
effect on TUI/GUI and fully functional when the harness is not running. Then write marker
  `{ at: Date.now(), roles: [...] }` to `resetRequestPath`. Print one confirmation line noting
  that a running fleet picks it up within ~2s.
- Orchestrator (`src/orchestrator.ts`): in the existing poll cycle (every POLL_MS), if the
  marker exists, call a new small public method `runner.resetCounters()` on each affected
  runner — zero the four counters in memory and `save()` — log one event so the reset is
  visible in `tumwater logs`/the feed, then delete the marker. If the live-reload tumwater.json
  plan has landed first, consume the marker in that same poll block (one reload point shared by
  all loops). The operation is idempotent, so a marker left behind by a killed run is consumed
  harmlessly at most once after restart.
- Events: add `counters_reset` to the `HarnessEvent.type` union (src/types.ts) with plain
  rendering in `formatEvent` (src/events.ts) — no warning prefix; it is routine operation.
- Known minor edge, acceptable: a reset landing while one tick is in flight may drop that
tick's +1 from the new window (the increment happened at tick start). Do not over-engineer
around it.

**Files touched:** `src/paths.ts`, `src/state.ts`, `src/cli.ts`, `src/orchestrator.ts`,
`src/loop.ts` (one small public method), `src/types.ts` + `src/events.ts`; tests: extend
`test/state.test.ts` (`zeroCounters` zeroes exactly the four counters and preserves
scheduling/session fields), a CLI-level test (files zeroed, marker written, `--role`
targeting, unknown role fails cleanly), extend `test/orchestrator.test.ts` (marker consumed →
in-memory counters zeroed and re-saved, event logged, marker deleted); one README usage line.

**Acceptance criteria:**
- Harness not running: `tumwater reset-counters` zeroes ticks/commits/tokens/cost in every
role's state file; TUI/GUI/status show 0; scheduling fields and session continuity are
unchanged (loops resume their existing sleep/backoff exactly as before).
- Harness running: the counters drop to zero on both dashboards immediately and stay zeroed
across subsequent tick boundaries (no resurrection from a stale in-memory save); the reset is
visible as one plain event in `tumwater logs`.
- `--role <id>` affects only that loop; an unknown role fails with a clear message and changes
nothing.
- `npm test` passes.

### Show current work item per active loop in the GUI/TUI tables (planned 2026-08-25)

**Goal:** Both dashboards show, for each *working* loop, a short description of what it is
currently doing — e.g. `implement plan "Linear history on main"` or `fix bug: zombie streams` —
so the user sees at a glance what the fleet is up to without opening transcripts. Idle loops
show nothing new (`-` in the GUI). Requested by the user; the TUI is secondary — if it does not
fit cleanly, ship GUI-only (the user's explicit fallback).

**Source of truth:** the first assistant *text* message of the current run in the loop's raw pi
log. Role loops state their chosen work item early ("I'll implement plan X" / "The open bug is
Y"), and runs are already delimited by `session` events — the same boundary `readLiveProgress`
uses (current run = after the last `session`). No new persistence, no loop.ts change: extend the
existing incremental tail parse.

**Approach:**
- `src/progress.ts`: add `currentWork?: string` to `LiveProgress`. In `feedLine`: on a `session`
  event reset it to undefined (new run); on an assistant `message_end`, if still unset, take the
  first non-empty text content block from `message.content`, collapse whitespace, and truncate to
  ~60 chars with an ellipsis. Runs whose early messages are thinking/tool-calls only stay unset
  until some message carries text (renders `-`). The field flows through `readLiveProgress`'s
  existing tail cache automatically — no new file reads.
- TUI/one-shot status (`src/status-render.ts`, `workingDetail`): when set, prepend the work item
  to a working loop's state cell — e.g. `implement plan X · working 3m · turn 2 · ctx 45k`.
  Prepending (not appending) so it survives ellipsis clipping on narrow terminals. No new column:
  the table is already width-tight at 80 cols, and adding a ninth would break the no-wrap
  contract / positional `FLEXIBLE_COLUMNS`; the state cell (index 1, flexible, min 12) absorbs
  the extra width exactly like `lastTool` does today.
- GUI payload (`src/gui.ts`, `statusPayload`): add `currentWork: string | null` per loop — from
  `readLiveProgress(root, s.role)` when `s.running`, else null (never show a stale item from a
  finished tick).
- GUI page (`src/gui-page.ts`): new `<th>current</th>` column inserted right after `state`
  (deliberately NOT between `cost` and `last result` — the pending timestamp plan inserts its
  column there; keep the two apart), rendered in `refresh()`'s row builder from `l.currentWork`,
  `-` when null. Keep every inline `<script>` body parseable (test/gui.test.ts asserts this).

**Files touched:** `src/progress.ts`, `src/status-render.ts`, `src/gui.ts`, `src/gui-page.ts`;
tests: extend `test/progress.test.ts` (capture, reset on new session, whitespace collapse +
truncation, no-text run), `test/working-detail.test.ts` (prepend in the state cell; clipping at
narrow width), `test/gui.test.ts` (payload field + served page contains the column header).

**Acceptance criteria:**
- While a loop is working and its pi log has an assistant text message for the current run, both
  surfaces show that work item: GUI in its own `current` column; TUI/one-shot status prepended in
  the state cell. It appears within one poll of the first text message landing.
- Idle/sleeping/queued loops show no work item (`-` in the GUI, unchanged state cell in the TUI);
a finished tick's item never lingers into idle time.
- Runs with only thinking/tool-call messages so far render `-`, not empty or stale text.
- Work items are truncated to ~60 chars; the TUI width contract is preserved (no line exceeds
  `maxWidth` at 80 cols).
- `npm test` passes.

### Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)

**Goal:** The dashboard surfaces project status, not just loop status: both the TUI and the web
GUI show a list of known (open) bugs from BUGS.md and a list of planned features from PLANS.md,
so a user can see what the fleet is working toward without opening the files.

**Approach:** One shared pure parser, two thin renderers. The lists are derived from tracked
markdown that loops edit constantly, so read the files fresh on every render/poll — the same
pattern as events and transcripts (no caching).

- New module `src/backlog.ts`:
  - `parseEntries(md: string, sectionTitle: string): string[]` — returns the `### ` heading texts
    inside one `## <sectionTitle>` section only (stop at the next `## ` line), skipping the
    `_None yet._` placeholder. Body text under an entry is ignored; keep the full heading text
    including any `(planned …)`/`(reported …)` suffix.
  - `plannedPlans(root): string[]` / `openBugs(root): string[]` — read PLANS.md (`## Planned`)
    and BUGS.md (`## Open`) from disk; missing or unreadable file → `[]` (never throw into a
    render path).
  - `backlogLines(plans: string[], bugs: string[]): string[]` — the TUI body lines: a
    `plans (N):` subheader, one line per plan, then an `open bugs (M):` subheader and one line
    per bug; empty sections render `(none)` under their subheader. Pure, so it is unit-testable.
- TUI (`src/tui.ts`): add a **project status** view to the existing Ctrl+T activity-pane cycle
  (events → each loop's transcript → project status), occupying exactly the same slot and height
  budget as recent activity — the no-wrap invariant from the transcript feature is preserved by
  construction. Header: `project status — Ctrl+T to cycle`; body = `backlogLines(...)` clipped
  with `clipToWidth`, keeping the *head* of the list when it overflows (file order is newest-
  first, unlike events which keep the tail). Update the cycle math (`view % (roleIds.length + 2)`) and
  the stale-index clamp accordingly. Empty file state: `(no planned features or open bugs)`.
- GUI payload (`src/gui.ts`): `statusPayload(root)` gains `plans: string[]` and `bugs: string[]`
  from the same helpers (fresh read per poll, like `events`).
- GUI page (`src/gui-page.ts` — all UI edits go there; `gui.ts` only serves): a "project status"
  section below the loop table / transcript panel with two lists — *planned features (N)* and
  *open bugs (M)* — styled like the existing `#feed`/`#transcript` panels, rendered in
  `refresh()` from `d.plans`/`d.bugs`, `(none)` when empty. Keep every inline `<script>` body
  parseable (test/gui.test.ts asserts this).
- Do not add count badges to the status header line here — the Questions outbox plan will add a
  `questions: N` badge in that same spot; keep the two from colliding.

**Files touched:** new `src/backlog.ts`; `src/tui.ts`, `src/gui.ts`, `src/gui-page.ts`; new
`test/backlog.test.ts`; extend `test/gui.test.ts` (payload fields + served page contains the new
section).

**Acceptance criteria:**
- TUI: Ctrl+T cycles to a project status view listing planned features and open bugs, one per
  line, clipped to terminal width; it fits the existing height budget (no wrapped lines, table
  stays pinned at the top); empty sections show `(none)`.
- GUI: `/api/status` includes `plans` and `bugs`; the dashboard renders both lists with counts
  below the loop table and they update on the 1s poll as PLANS.md/BUGS.md change (e.g. a plan
  moved to Done disappears).
- Parser: only entries from the requested section are returned (Done/Fixed excluded); handles
  missing files, `_None yet._`, multiple entries per section, and arbitrary body text under an
  entry without leaking it into titles.
- `npm test` passes.

### PRINCIPLES.md — positive design principles injected into every prompt (planned 2026-08-24)

Full plan: [plans/principles.md](plans/principles.md). Every project gets a tracked
PRINCIPLES.md — the codified taste of the project, phrased as positive principles (per HN/chermi:
LLMs follow positive constraints far better than prohibitions) — seeded at init, injected into
every tick and director prompt, editable only by the director and steward. First item of the
"Senior Tumwater" report sequence; the review gate and refusal plans both lint against it.

### Adversarial review gate before merge (planned 2026-08-24, refined 2026-08-24)

Full plan: [plans/review-gate.md](plans/review-gate.md). No code diff reaches main unreviewed: a
fresh-session pi run (no author context; own model override via a `review` pseudo-role) reviews
each committed tick against PRINCIPLES.md and replies `VERDICT: approve|reject` with reasons.
Rejects reset the branch, record reasons, and inject them into the author's next tick; md-only
diffs are exempt so notes stay cheap. The invariant is structural — a failed or verdict-less
review fails closed (commit stays on the branch for re-review next tick, 3-strike discard cap),
and `recoverLeftover` routes salvaged commits through the same gate so no crash path can land
unreviewed work. The report's highest-leverage item — we have merged broken work twice for lack of
it.

### The right to refuse, and friction as a signal (planned 2026-08-24)

Full plan: [plans/refusal-and-thrash.md](plans/refusal-and-thrash.md). A new
`TUMWATER_REFUSED: <reason>` sentinel and `refused` tick outcome let a loop decline work that
would harm the architecture, recording the objection in PLANS.md/BUGS.md (that md edit merges;
any code half-work is discarded). High-friction ticks (turn/time thresholds) are flagged in the
commit body and events — matsemann's "difficulty is a signal" restored as data.

### Self-explaining commit bodies (planned 2026-08-24)

Full plan: [plans/commit-bodies.md](plans/commit-bodies.md). Reply contract grows WHY/RISK/
VERIFIED lines after SUMMARY; commits get that body plus a harness-stamped trailer (tick, turns,
peak ctx). Gives the reviewer, steward, and human a paper trail of claimed understanding
(TonyAlicea10's do-i-understand, inverted for agents). NOTE: a director-routed request for more
descriptive commit messages may already exist in this file — merge the entries before
implementing.

### Questions outbox — loops that know when to ask (planned 2026-08-24)

Full plan: [plans/questions-outbox.md](plans/questions-outbox.md). A tracked QUESTIONS.md
(Open/Answered) any loop appends to when a decision is genuinely the user's — context, options,
and the loop's recommendation — surfaced as a `questions: N` badge in status/TUI/GUI; answers
flow back by editing the file or via the director. Loops never block on their own questions.
The report's answer to "software lacks victory conditions": be excellent at requesting them.

### Steward role — whole-system judgment on a slow clock (planned 2026-08-24)

Full plan: [plans/steward-role.md](plans/steward-role.md). A markdown-only `steward` role on a
~6 h cadence (adds per-role `minTickIntervalSeconds`) that re-reads the initial prompt,
PRINCIPLES, PLANS, BUGS, and the codebase's shape, then makes one curation move: prune/merge
plans (the only role allowed to delete entries), flag drift, keep the complexity budget honest.
The tech-lead layer the "projects disintegrate past tens of kLOC" reports say becomes mandatory.

### QA role — exercising the product like a user (planned 2026-08-24)

Full plan: [plans/qa-role.md](plans/qa-role.md). A `qa` role that follows the README verbatim in
a scratch dir — build, run, curl — one flow per tick, filing reproducible bugs in BUGS.md (its
only write). Hard safety rails: time-limit every process, ephemeral ports, no source edits. The
structural fix for green-suite-but-broken-product (the GUI page incident shipped through 180
passing tests).

### Live-reload tumwater.json while the harness is running (planned 2026-08-23)

**Goal:** Edits to `tumwater.json` should steer a *running* fleet without a restart —
enable/disable roles, switch per-role provider/model/thinking/instructions, tune backoff and
tick intervals. Today the config is loaded exactly once in `cmdRun` (cli.ts) and passed into
each `LoopRunner`, so mid-run edits do nothing until Ctrl+C + re-`run`. It is also inconsistent:
`snapshot()` reads fresh config for every dashboard render, so a disabled role disappears from
the TUI/GUI table while its loop keeps ticking in the background.

**Approach:** One reload point shared by all loops — the orchestrator's poll cycle (every
`POLL_MS`, 2s) — not per-runner file reads:
- New non-throwing loader in `src/config.ts`: `loadConfigSafe(root): { config?: TumwaterConfig;
  error?: string }` wrapping the existing validating `loadConfig`.
- In `runOrchestrator`'s poll loop (src/orchestrator.ts), call it once per cycle. On success:
  push the fresh object into every runner (`runner.config = fresh`) and create a new
  `LoopRunner` for any role that is enabled but has no runner yet, so enabling a role mid-run
  starts it. On failure: keep last-known-good configs, log one `warning` event per *distinct*
  error text (track the last-warned string so a broken file does not spam an event every 2s),
  and recover silently once the file is fixed.
- Role disable: in `isEligible`, return `{ run: false }` when the runner's fresh config has its
  role disabled — no slot reserved, no tick started. Track the previous cycle's enabled set in
  the poll loop and log a one-shot `warning` on each transition ("role X disabled — stopping
ticks" / "role X enabled — starting ticks"). Re-enabling resumes within one cycle because the
  runner and its persisted state survive.
- Make `LoopRunner.config` assignable (drop `readonly`, src/loop.ts) — every downstream read
  already goes through it: `configForRole` (provider/model/thinking/instructions),
  `minTickIntervalSeconds` (`isEligible`'s min-gap and the runner's scheduling),
  `tickTimeoutSeconds`, backoff via `nextBackoffSeconds`, and `logMaxBytes` for log rotation in
  `runPi`.
- Restart-only settings: `maxConcurrent` (the Semaphore is created once at startup) and
  `sessionRetentionDays` (pruning runs only at orchestrator start). Note both as restart-only in
  the README's usage section. The dashboard needs no change — `snapshot()` already reflects fresh
  config, so disabled roles leave the tables exactly when their ticks stop.

**Files touched:** `src/config.ts`, `src/orchestrator.ts`, `src/loop.ts` (one-line visibility
change), tests in `test/orchestrator.test.ts` / a new focused test file for reload behavior;
one README line documenting live vs restart-only settings.

**Acceptance criteria:**
- Editing tumwater.json while running changes backoff/tick intervals and per-role
  provider/model/thinking/instructions for subsequent ticks within ~2s, no restart (test with the
  fake pi shim: mutate the file between ticks; assert e.g. a new model reaches pi's argv or a new
  minTickInterval gates scheduling).
- Disabling a role mid-run stops its next tick (no further `tick_start` events); re-enabling
  resumes within one poll cycle; enabling a role that was not running at startup starts it.
- A broken tumwater.json mid-run does not stop the harness: ticks continue with last-known-good
  config, exactly one warning event per distinct error text, and behavior recovers when the file
  is fixed.
- `maxConcurrent`/`sessionRetentionDays` documented as restart-only; `npm test` passes.

### Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, refined 2026-08-23)

**Goal:** Both live tables — the TUI/one-shot status table and the web GUI loop table — show
when a loop's last result happened as an absolute wall-clock time, not only relative "3m ago".

**Approach:** The data already exists: `LoopState.lastTickEndedAt` (epoch ms) is set at tick end in
`src/loop.ts` and the GUI's `/api/status` payload (`statusPayload`) already exposes it as
`lastTickEndedAt`. This is a rendering-only change; no state or type changes needed.

- TUI/status (`src/status.ts`, `renderStatus`): extend the existing `last tick` cell to show both,
e.g. `14:32:05 · 3m ago` (absolute local time first, relative after). Format as local `HH:MM:SS`;
  prefix with `MM-DD` when older than a day so multi-day runs stay unambiguous; keep `-` for loops
  that never ticked. If instead you add a dedicated column, note the `FLEXIBLE_COLUMNS` indices in
  `renderStatus` are positional (7 = last result, 1 = state) and must be renumbered.
- GUI (`src/gui-page.ts` — the dashboard HTML template was extracted from `gui.ts` into the
  `GUI_PAGE` constant, so all UI edits go there; `gui.ts` only serves it and needs no change):
  add a `last tick` column to the `<thead>` row, inserted between `cost` and `last result` to
  match the TUI's column order, and render it client-side in `refresh()`'s row builder from
  `l.lastTickEndedAt`, `-` when null. Format with local `HH:MM:SS`, prefixed with `MM-DD` when
  older than a day — mirroring the TUI rule so the "older than a day includes the date" criterion
  holds in both tables, not just the TUI (a bare `toLocaleTimeString()` would miss it). The
  payload already carries the value; only the `<thead>` row and the row-building JS change.
- Keep the TUI width-awareness contract: no rendered line may exceed `maxWidth`; the wider cell is
  fine because `last tick` is not in `FLEXIBLE_COLUMNS`, but verify a narrow terminal (e.g. 80 cols)
  still clips cleanly — if the combined cell makes overflow worse, consider making it shrinkable.

**Files touched:** `src/status.ts`, `src/gui-page.ts`, `test/status-render.test.ts` (extend for
the new cell format; add a narrow-width case), and optionally extend `test/gui.test.ts` to assert
the served page contains the new column header.

**Acceptance criteria:**
- TUI and one-shot status show an absolute local timestamp of the last tick end alongside the
  relative age (or in its own column); loops with no ticks yet show `-`.
- GUI loop table has a matching `last tick` column, populated from `/api/status`, `-` when null.
- Timestamps use local time; values older than a day include the date.
- Existing width-awareness behavior is preserved (no line exceeds `maxWidth`); `npm test` passes.

## Done

### Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25)

Work now lands on main via **rebase**, not merge, so main's history stays linear going forward.
The sync primitives in src/git.ts are rebase equivalents of the old merge ones (shared
`attemptRebase` classifier): `rebaseOntoMain`, `rebaseOntoMainLeaveConflicts`, and
`continueRebase` (`git add -A` + `GIT_EDITOR=true git rebase --continue`, so it can never block
on a commit-message prompt). A resolution that leaves no unique content (the branch's change was
fully superseded by main) is skipped automatically by git, finishing the rebase cleanly. A second
conflict — only possible when pi authored extra commits during the tick — aborts after the one
per-tick resolution attempt and reports `merge_conflict` as before; `resetWorktreeToMain` and the
generalized `abortSync` clear interrupted rebases so a killed tick cannot wedge later ticks with
"you are already rebasing". End-to-end tests assert main's history stays linear (`git log
--merges` does not grow) for both the pi-resolved-conflict and concurrent-main-advance paths, plus
unit tests for each primitive (no-op rebase preserves commit hashes, markers left in place,
empty-resolution skip, interrupted-rebase recovery). Files: src/git.ts, src/loop.ts,
src/prompt.ts, test/git.test.ts, test/loop.test.ts, README.md (one line).

### Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, refined 2026-08-23, done 2026-08-24)

TUI: Ctrl+T cycles the activity pane between recent events and each loop's transcript (header
`transcript: <role> — Ctrl+T to cycle`), occupying exactly the same slot and height budget as
recent activity so the no-wrap invariant holds; the view index clamps when roles change, and an
empty log shows "(no transcript yet)". GUI: GET `/api/transcript?role=&n=` (unknown role or bad
n → 400 with a clear message; default n=50) plus a click-to-toggle transcript panel below the
loop table that re-fetches on the existing 1s poll and shows "(no transcript yet for this loop)"
when empty. Tests in test/gui.test.ts cover endpoint validation and parse every inline `<script>`
body so unparseable page JS can never ship silently (regression for a bare-`\n` template-literal
bug that blanked the dashboard). Files: src/tui.ts, src/gui.ts, src/gui-page.ts, test/gui.test.ts.

### Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, refined 2026-08-23, done 2026-08-23)

`tumwater logs --role <id> [-n N] [-f]` renders a loop's raw pi JSONL into readable transcript
lines: run separators stamped from the first user message of each run, one-line abbreviated
thinking (~80 chars), indented assistant text (capped at 4 lines per message), tool calls via
describeToolCall, and retry warnings; streaming deltas and multi-KB tick prompts are never
shown. `-f` follows the live log with byte-offset/watchFile, advancing only past complete
lines, so each turn prints exactly once when its `message_end` lands. New module src/transcript.ts
(pure formatter over JSONL lines + incremental renderer) tested in test/transcript.test.ts;
one-shot and follow both read through files.ts's shared `readCompleteLines`, which never
consumes a torn trailing line. TUI/GUI surfacing is recorded as its own plan.

### Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21)

`renderStatus` appends a separator plus a `total` row summing tokens (compact-formatted) and cost
across loops; shared by the TUI and one-shot status. Tests in test/status-render.test.ts.

### Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21)

A single shared `DECOMPOSITION_GUIDANCE` constant (src/prompt.ts) is embedded in the director's
routing block and the plan/bugfix role prompts: independent subparts become separate
cross-referencing PLANS.md/BUGS.md entries; coupled work stays a single entry. Tests in
test/decompose.test.ts.

### Web GUI (done 2026-08-20)

`tumwater gui [--port N]` serves a zero-dependency browser dashboard on 127.0.0.1 (default
port 7180): loop table with live working detail, event feed, and a prompt box that queues to
the director. Reads the same `.tumwater/state` + `events.jsonl` files as the TUI, polling
every second. Files: `src/gui.ts`, `src/cli.ts`.

### pi-driven merge conflict resolution (done 2026-08-20)

On a merge conflict, the loop re-runs the merge leaving markers in place, asks pi to resolve
them (one attempt per tick, honoring both sides' intent), verifies no markers remain, and
concludes the merge; unresolvable conflicts abort cleanly as before. Files: `src/loop.ts`,
`src/git.ts`, `src/prompt.ts`.

### Per-role model/effort overrides (done 2026-08-20)

Each role entry in `tumwater.json` may set `provider`/`model`/`thinking`, falling back to the
top-level values — cheap models for mechanical roles, strong ones for feature/bugfix. Files:
`src/types.ts`, `src/config.ts`, `src/loop.ts`.

### Log rotation and session pruning (done 2026-08-20)

`events.jsonl` and per-role pi logs rotate to `<file>.1` past a size cap (`logMaxBytes`,
default 16MB); pi session files older than `sessionRetentionDays` (default 7) are pruned at
orchestrator start. Files: `src/events.ts`, `src/pi.ts`, `src/orchestrator.ts`.
