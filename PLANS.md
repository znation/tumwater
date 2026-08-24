# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

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
