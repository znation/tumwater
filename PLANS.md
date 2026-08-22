# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

_None yet._

## Done

### Rename project from "automaton" to "tumwater" (planned 2026-08-21, done 2026-08-21)

Shipped: package/bin/scripts renamed; CLI help, status header, GUI title, prompts (including the
nothing-to-do sentinel, now `TUMWATER_NOTHING_TO_DO`), markers (`<!-- tumwater:… -->`), state dir
`.tumwater/`, config `tumwater.json`, branches `tumwater/<role>`, session names, and commit
prefixes. `migrateLegacyState` (src/paths.ts) transparently renames a legacy `.automaton/` dir and
`automaton.json` on every CLI entry and orchestrator start (old worktrees are dropped and
recreated); `ensureWorktree` adopts `automaton/<role>` branches by renaming them. Historical
Done/Fixed entries below keep the old name by design. Rebuild + relink for the new command name.

### Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21)

`renderStatus` appends a separator plus a `total` row summing tokens (compact-formatted) and cost
across loops; shared by the TUI and one-shot status. Tests in test/status-render.test.ts.

### Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21)

A single shared `DECOMPOSITION_GUIDANCE` constant (src/prompt.ts) is embedded in the director's
routing block and the plan/bugfix role prompts: independent subparts become separate
cross-referencing PLANS.md/BUGS.md entries; coupled work stays a single entry. Tests in
test/decompose.test.ts.

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
