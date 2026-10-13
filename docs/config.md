# Settings

Settings live in `tumwater.json`: enabled roles, model (either one selector or a map of tiers
`small`/`default`/`strong` — omitted tiers inherit `default`; per-tier `fallback` overrides may
name a model or `"pause"`, and a role's `model` may name a tier; see
[plans/model-tiers.md](../plans/model-tiers.md)),
intervals, per-role `instances` (`feature` and `bugfix` may each run 1–8 parallel runners, every one
with its own branch and state; default 1), the daily spend cap
(`maxDailyCostUsd`, with optional per-role caps `maxDailyCostUsdPerRole` — a loop over its own
cap starts no new ticks until the next local day or a live edit), a
`maintenancePerWorkLanding` ratio (default 2; a rolling 24 h allowance of that many
code-maintenance landings per feature/bugfix/director landing, plus a floor of 12 — when the
window reaches it the scheduler holds the enabled maintenance loops until it rolls under, and a
fresh `tumwater wake <role>` or a queued prompt for one admits a single tick anyway), a nightly
`quietHours` window (e.g. `"23:00-07:00"` local time) during
which role loops start no new ticks (the director is exempt), with optional per-role windows
`quietHoursPerRole` — a loop inside its own window starts no new ticks, whether or not the
fleet-wide window covers now — a `diskHoldGB` free-space floor (default 10; when the volume
holding the worktrees drops below it, no new work starts until free space recovers 5 GB above it;
0 disables), a `diskReclaimGB` pressure-reclaim threshold (default 40; below it idle worktrees
drop their gitignored build outputs before the hold engages; 0 disables), and a
`worktreeIdleReclaimHours` window (default 24; an hourly pass drops a worktree's gitignored build
outputs once it has sat unused that long, whatever the free space; 0 disables), a
`worktreeSlots` count of pooled checkouts shared by role ticks and landing vets (default
`maxConcurrent` + 1; the director's worktree sits outside the pool) — user-defined
`customLoops`, and an
optional `notify` shell command run when the fleet needs a human (a budget pause, a budget warning
at 80% of the cap while the gate is still open, a role's own cap warning or cap pause, low disk
space holding new work, a claude subscription window nearing its limit or holding the claude
seams, an error-streak breaker trip, main's own check going red, a failed landing, a blocked restart, a posted question, a refused backlog entry, the
fleet going down — the command gets
`TUMWATER_EVENT_TYPE`, `TUMWATER_EVENT_LOOP`, and `TUMWATER_EVENT_MESSAGE` in its environment;
verify it with `tumwater notify --test`; a hook that exits nonzero logs a warning).
Edits apply live while the fleet runs.
From the terminal, `tumwater config` prints the effective config as JSON, `tumwater config get
<key>` reads one resolved value, `tumwater config set <key> <value>` writes one top-level
key, and `tumwater config unset <key>` removes one — the inverse of `set`, so a value reverts
to its default or disappears from its map or section; dotted keys
(`maxDailyCostUsdPerRole.feature 1.5`, `roles.qa.model x`) merge one entry into the existing
map or role entry, while bare keys replace the whole value. `roles` always merges the built-in
catalog per entry at load, so a bare `config set roles` replaces the file's section but cannot
disable a role by omission — disable one with `tumwater config set roles.<id>.enabled false`.

Model backends (OpenAI-compatible endpoints, the `claude` agent, and fallbacks) are covered in
[backends.md](backends.md).
