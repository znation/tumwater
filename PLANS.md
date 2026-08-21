# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Rename project from "automaton" to "tumwater" (planned 2026-08-21)

**Goal:** The project is renamed to `tumwater` everywhere: package, CLI command, docs, prompts, and
internal identifiers. References to "project automaton"/"project-automaton" become "tumwater" (no
"project" prefix). This repo is itself a live harness project, so the rename must migrate existing
runtime state rather than orphan it.

**Scope — rename:**
- `package.json`: `name`, `bin` key (`automaton` → `tumwater`), npm script name.
- CLI: help text, error messages, next-step hints in `src/cli.ts`; status table header line
  (`src/status.ts`); GUI page title/header (`src/gui.ts`).
- Runtime state dir `.automaton/` → `.tumwater/` (`STATE_DIR`, `src/paths.ts`) and the `.gitignore`
  entry.
- Config file `automaton.json` → `tumwater.json` (`src/config.ts`, `src/init.ts`, `src/cli.ts`).
- Branch names `automaton/<role>` → `tumwater/<role>` (`branchName`, `src/paths.ts`) and pi session
  names `automaton-<role>-…` → `tumwater-<role>-…` (`src/loop.ts`).
- Commit message prefixes `automaton:` / `automaton(<role>):` → `tumwater:` / `tumwater(<role>):`
  (`src/init.ts`, `src/loop.ts`).
- Prompt text: "loop of automaton" and the `.automaton`/`automaton.json` mentions in `COMMON_RULES`
  (`src/prompt.ts`), marker/command references in role find prompts (`src/roles.ts`).
- Markdown markers `<!-- automaton:prompt|status:start|end -->` → `<!-- tumwater:… -->`: the
  constants in `src/prompt.ts` AND the four marker lines in README.md. The prompt block content
  between the markers must stay byte-identical (it contains no "automaton" anyway).
- README.md: title, usage examples, how-it-work prose (all references outside the protected prompt
  block). PLANS.md and BUGS.md: rename references in Open/Planned sections only — Done/Fixed
  entries are historical records of what shipped under the old name; leave them.

**Scope — do NOT touch:** git history (no rewriting), the initial prompt block content, the on-disk
repo folder name (`project-automaton` → user renames it manually outside the repo).

**Migration (this repo runs itself):** add an idempotent `migrateLegacyState(root)` helper (e.g. in
`src/paths.ts`) that, when the new path is absent: renames `.automaton/` → `.tumwater/` and
`automaton.json` → `tumwater.json`. Call it from every CLI entry point that reads state and from
orchestrator start. In worktree setup (`src/git.ts`), adopt an existing `automaton/<role>` branch by
renaming it to `tumwater/<role>` when the new name is missing, so loop branches aren't orphaned.

**Files touched:** `package.json`, `.gitignore`, `README.md`, `PLANS.md`, `BUGS.md`, `src/paths.ts`,
`src/config.ts`, `src/init.ts`, `src/cli.ts`, `src/prompt.ts`, `src/roles.ts`, `src/loop.ts`,
`src/git.ts`, `src/orchestrator.ts`, `src/status.ts`, `src/gui.ts`, and the tests that assert old
names (`test/*.ts`: config, init, loop, git, prompt, state, util).

**Acceptance criteria:**
- `grep -ri automaton` over tracked files matches only: Done/Fixed sections of PLANS.md/BUGS.md, and
  the legacy-name strings inside the migration helper (and its test). Nothing else.
- Fresh `tumwater init` creates `tumwater.json`, `.tumwater/`, branch prefix `tumwater/<role>`,
  commit prefix `tumwater:`; unit tests updated accordingly and `npm test` passes.
- Migration unit test: a repo seeded with `.automaton/state/x.json` + `automaton.json` becomes
  `.tumwater/state/x.json` + `tumwater.json` with contents preserved; running twice is a no-op.
- README title/usage/how-it-work say tumwater; the four marker comments are renamed and the prompt
  block between them is unchanged.
- Note in README: after this change, rebuild + relink (`npm run build && npm link`) is needed for
  the new `tumwater` command to appear on PATH.

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

**Files touched:** `src/status.ts`, `test/status.test.ts`.

**Acceptance criteria:**
- With multiple loops having non-zero `totalTokens`/`totalCostUsd`, both the TUI table and
  `automaton status` output end with a totals row whose tokens cell equals the sum of per-loop
  token values (compact-formatted) and whose cost cell equals `$<sum to 2 decimals>`.
- The totals row is separated from data rows by a separator line and stays column-aligned; an empty
  state set (all zeros) renders `0` / `$0.00` without breaking alignment.
- Unit test in `test/status.test.ts` asserts the totals row values for a multi-loop snapshot;
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
