# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, refined 2026-08-23)

**Goal:** Let a user see what a specific loop's pi actually did — its transcript of tool
calls and assistant messages — with `tumwater logs --role <id>`. Today only harness events
(tick start/end, merged, wake, warnings) are surfaced; each loop's real work lives in the raw
pi JSONL at `.tumwater/log/<role>.pi.jsonl` and no command reads it. The initial prompt says
loops must be "observable by gui/tui/log" — this closes the per-loop-work half of that.

**Approach:**
The raw log is pi's *streaming* event stream: ~95% of its lines are `message_update` deltas
(`thinking_delta`, `text_delta`, `toolcall_delta`) that must never be rendered. Render only
from complete events (shapes verified against real logs in `.tumwater/log/`):

- `agent_start` — bare `{type:"agent_start"}`, one per pi run, including resumed runs (unlike
  `session`, which fires only for fresh sessions) → separator line between runs. It carries no
timestamp; if a time is wanted, stamp it from the epoch-ms `timestamp` of the first user
  message in that run.
- `message_end` with `message.role === "assistant"` — exactly one per completed assistant turn
  (the same invariant `progress.ts` already uses to count turns); its `content[]` holds the full
  blocks, so no delta reconstruction is needed. Per block: `{type:"thinking", thinking}` → one
  abbreviated line (~80 chars, e.g. `· there's a merge conflict…` — note the field is
  `thinking`, not `text`); `{type:"text", text}` → indented lines truncated to ~120 cols,
  capped at 4 lines per message then `…`; `{type:"toolCall", name, arguments}` →
  `→ read PLANS.md` via the already-exported `describeToolCall(name, arguments)`.
- `auto_retry_start` — `{attempt, maxAttempts, errorMessage}` → warning line (e.g.
  `⚠ retry 1/3: terminated`) so failed attempts are visible in the transcript.
- Everything else is skipped: all `message_update` deltas, `tool_execution_*`, `turn_*`,
  `agent_end`/`agent_settled`, and user messages — in particular never dump the multi-KB tick
  prompt that arrives as a user message each run.

Implementation:
- New module `src/transcript.ts`. Expose `readTranscript(root, role, limit): string[]`
  (rendered lines for the last `limit` *entries*, oldest first; an entry is one run separator or
  one assistant turn's line block) plus a pure formatter over raw JSONL lines so tests need no
  files. Handle a missing file gracefully (return []).
- Reading: reuse files.ts's shared helper `readCompleteLines(file, offset, size)` (already
  exported; used by progress.ts's incremental tail and the CLI's `logs -f`); it returns only
  complete lines and leaves a torn trailing partial line unconsumed. One-shot
  mode reads the whole current file in one call (offset 0 → size): the log rotates at
  `logMaxBytes` (default 16MB), trivial to parse for a CLI command. Do NOT use progress.ts's
  incremental `tails` cache or its 4MB seed window — those exist for per-second TUI/GUI polling,
  and a short-lived CLI process just reads fresh.
- `-f` mode: keep an offset at the last complete newline across watchFile polls (same 500ms
  cadence as today's `logs -f`) and render only when a complete renderable line (`agent_start`,
  assistant `message_end`, `auto_retry_start`) arrives, so each turn prints exactly once. Do not
  copy cmdLogs' follow quirk of advancing the offset past a torn trailing line *before* parsing
  (that silently drops events straddling poll boundaries); `readCompleteLines` avoids it by
  design — advance only to its returned `end`.
- CLI (`src/cli.ts`): extend the existing `logs` command with a `--role <id>` flag.
  `tumwater logs --role feature [-n N]` prints that loop's transcript (last N entries, default
  ~50). Validate the id against `allRoleIds()`; unknown id → clear error + non-zero exit, role
  with no log yet → friendly "no transcript yet for <role>".
- Read-only: never touches scheduling, loop state, or git. When `--role` is absent, existing
  harness-event behavior is unchanged.

**Files touched:** `src/transcript.ts` (new), `src/cli.ts`, and `test/transcript.test.ts`
(new). No changes needed in progress.ts or files.ts — `readCompleteLines` is already
exported from files.ts; its incremental cache stays private to the hot path.

**Acceptance criteria:**
- `tumwater logs --role <id>` prints that loop's recent pi activity as readable lines — run
  separators, one-line abbreviated thinking, indented assistant text, tool calls labeled via
  `describeToolCall` — oldest first within the window, honoring `-n N`.
- No streaming-delta or user-prompt content ever appears in output; non-JSON/torn lines are
  skipped without failing.
- Unknown role id → clear error and non-zero exit; a role with no log yet → friendly message,
  no crash.
- `-f` appends new entries as they arrive (byte-offset watchFile like `logs -f`, but the offset
  advances only past complete lines), rendering each assistant turn exactly once when its
  `message_end` lands.
- Existing `tumwater logs` output is byte-for-byte unchanged when `--role` is absent.
- `npm test` passes; no changes to scheduling/state/git paths.

**Non-goal / follow-up:** Surfacing the transcript in the TUI/GUI (a per-loop detail pane or a
`/api/transcript?role=` endpoint) builds on this formatter but is deliberately out of scope here
so this stays one focused, shippable change; record it as its own PLANS.md entry once this lands.

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
