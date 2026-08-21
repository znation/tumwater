# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Totals row for tokens and cost in the status table (planned 2026-08-21)

**Goal:** The TUI live table (and the one-shot `automaton status`, which shares the renderer) shows a
totals row summing the `tokens` and `cost` columns across all loops, so total usage is visible at a
glance without mental arithmetic.

**Approach:** In `renderStatus` (`src/status.ts`), after the per-loop rows append one totals row:
- Label cell in the first column (e.g. `total`); leave `state`, `last tick`, and `last result` cells
  empty or `-`. Sum `s.totalTokens` over `snap.loops` for the tokens cell and `s.totalCostUsd` for
  the cost cell.
- Format the summed tokens with the existing compact `tokens()` helper (e.g. `123.4k`) so the row
  does not widen the table — important while the open table-width bug is unfixed; format cost as
  `$X.XX` like per-loop rows.
- Visually separate it from data rows with a thin separator line above it (matching the existing
  header separator style), keeping column alignment via the same `widths`/`fmt` logic.
- No changes needed in `src/tui.ts`: its line budgeting already counts
  `status.split("\n").length`, so the extra row is accounted for automatically — verify this holds.
- The browser GUI table (`src/gui.ts`) is out of scope; user asked for the TUI only.

**Files touched:** `src/status.ts`, `test/lock-status.test.ts`.

**Acceptance criteria:**
- With multiple loops having non-zero `totalTokens`/`totalCostUsd`, both the TUI table and
  `automaton status` output end with a totals row whose tokens cell equals the sum of per-loop
  token values (compact-formatted) and whose cost cell equals `$<sum to 2 decimals>`.
- The totals row is separated from data rows by a separator line and stays column-aligned; an empty
  state set (all zeros) renders `0` / `$0.00` without breaking alignment.
- Unit test in `test/lock-status.test.ts` asserts the totals row values for a multi-loop snapshot;
  `npm test` passes.

### Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21)

**Goal:** Whenever a loop decides to put something into PLANS.md or BUGS.md — the director routing a
user prompt, or any role interpreting README.md/PLANS.md and recording a new plan or bug — it should
first consider whether the item can be broken down into independent subparts. If decomposition makes
sense, record each part as its own plan/bug entry (cross-referencing its siblings) instead of one
monolithic entry; otherwise keep it single.

**Approach:** Add shared decomposition guidance to `src/prompt.ts` and include it at every point where
bug/feature categorization happens:
- In `buildDirectorPrompt`'s routing block, add a rule alongside the existing feature/bug bullets:
  before recording, consider whether the request decomposes into independent subparts (separate
  features or bugs); if so, record each as its own PLANS.md/BUGS.md entry that cross-references its
  siblings; otherwise keep it single.
- Reuse the same guidance in role find prompts that create entries: at minimum `plan` (interprets
  README.md/initial prompt → PLANS.md) and `bugfix`'s "record a newly discovered bug" path, so loops
decompose consistently rather than only the director doing it. Define the text once (exported from one
module) to avoid drift between prompts.

**Files touched:** `src/prompt.ts`, `src/roles.ts`, `test/prompt.test.ts`.

**Acceptance criteria:**
- The director prompt instructs decomposition into multiple plans/bugs when a request has independent
  subparts, and says to keep it single otherwise; a unit test asserts the guidance is present in
  `buildDirectorPrompt` output.
- The `plan` role's tick prompt (and `bugfix`'s new-bug recording instruction) contain equivalent
  guidance; unit tests assert presence for those roles too.
- The guidance text is defined once and shared, not copy-pasted with drift.
- `npm test` passes.

## Done

### Web GUI (done 2026-08-20)

`automaton gui [--port N]` serves a zero-dependency browser dashboard on 127.0.0.1 (default
port 7180): loop table with live working detail, event feed, and a prompt box that queues to
the director. Reads the same `.automaton/state` + `events.jsonl` files as the TUI, polling
every second. Files: `src/gui.ts`, `src/cli.ts`.

### pi-driven merge conflict resolution (done 2026-08-20)

On a merge conflict, the loop re-runs the merge leaving markers in place, asks pi to resolve
them (one attempt per tick, honoring both sides' intent), verifies no markers remain, and
concludes the merge; unresolvable conflicts abort cleanly as before. Files: `src/loop.ts`,
`src/git.ts`, `src/prompt.ts`.

### Per-role model/effort overrides (done 2026-08-20)

Each role entry in `automaton.json` may set `provider`/`model`/`thinking`, falling back to the
top-level values — cheap models for mechanical roles, strong ones for feature/bugfix. Files:
`src/types.ts`, `src/config.ts`, `src/loop.ts`.

### Log rotation and session pruning (done 2026-08-20)

`events.jsonl` and per-role pi logs rotate to `<file>.1` past a size cap (`logMaxBytes`,
default 16MB); pi session files older than `sessionRetentionDays` (default 7) are pruned at
orchestrator start. Files: `src/events.ts`, `src/pi.ts`, `src/orchestrator.ts`.
