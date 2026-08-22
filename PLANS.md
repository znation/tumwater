# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21)

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
- GUI (`src/gui.ts`): add a `last tick` column to the HTML table header and render it client-side
  from `l.lastTickEndedAt` (e.g. `new Date(ts).toLocaleTimeString()`), `-` when null. The payload
  already carries the value; only the `<thead>` row and the row-building JS change.
- Keep the TUI width-awareness contract: no rendered line may exceed `maxWidth`; the wider cell is
  fine because `last tick` is not in `FLEXIBLE_COLUMNS`, but verify a narrow terminal (e.g. 80 cols)
  still clips cleanly — if the combined cell makes overflow worse, consider making it shrinkable.

**Files touched:** `src/status.ts`, `src/gui.ts`, `test/status-render.test.ts` (extend for the new
cell format; add a narrow-width case), optionally a small test for the GUI payload/HTML column if
one exists or is cheap to add.

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
