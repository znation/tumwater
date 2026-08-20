# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Web GUI

Goal: browser-based equivalent of the TUI — loop table, live event feed, main prompt box.
Approach: a `automaton gui` command starting a small zero-dependency HTTP server that serves a
single-page dashboard, reads the same `.automaton/state` + `events.jsonl` files the TUI reads,
and POSTs prompts into the inbox. Poll or SSE for updates.
Files: `src/gui.ts`, `src/cli.ts`, tests.
Acceptance: `automaton gui` opens a dashboard showing the same data as `automaton status`,
prompts typed in the browser reach the director loop.

### pi-driven merge conflict resolution

Goal: stop discarding work when a branch conflicts with main.
Approach: on `merge_conflict`, run a dedicated pi prompt inside the conflicted worktree asking it
to resolve conflict markers, then re-verify and merge. Cap at one attempt per tick.
Files: `src/loop.ts`, `src/git.ts`, tests.
Acceptance: a conflicting tick lands as a merge commit instead of being dropped.

### Per-role model/effort overrides

Goal: cheap models for mechanical roles (clean, dry, readme), strong models for feature/bugfix.
Approach: allow `provider`/`model`/`thinking` inside each role's entry in `automaton.json`,
falling back to the top-level values.
Files: `src/types.ts`, `src/config.ts`, `src/pi.ts`, `src/loop.ts`, tests.
Acceptance: config round-trips and the pi argv reflects the role override.

### Log rotation and session pruning

Goal: keep `.automaton/` from growing without bound on long runs.
Approach: size-capped rotation of `events.jsonl` and per-role pi logs; prune pi session files
older than N days.
Files: `src/events.ts`, `src/pi.ts`, tests.
Acceptance: logs stay under the configured cap across many ticks.

## Done

_None yet._
