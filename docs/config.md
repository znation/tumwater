# Settings

Settings live in `tumwater.json`: enabled roles, model (either one model id or a map of tiers
`small`/`default`/`strong` — omitted tiers inherit `default`; per-tier `fallback` overrides may
name a model or `"pause"`, and a role's `model` may name a tier; see
[plans/model-tiers.md](../plans/model-tiers.md)),
run intervals and timeouts (`minRunIntervalSeconds`, `runTimeoutSeconds`), the merge batch size
(`mergeBatchMax`), per-role `instances` (`feature` and `bugfix` may each run 1–8 parallel instances, every one
with its own branch and state; default 1), the daily spend cap
(`maxDailyCostUsd`, with optional per-role caps `maxDailyCostUsdPerRole` — a role over its own
cap starts no new runs until the next local day or a live edit), a
`maintenancePerWorkMerge` ratio (default 2; a rolling 24 h allowance of that many
code-maintenance merges per feature/bugfix/director merge, plus a floor of 12 — when the
window reaches it the scheduler holds the enabled maintenance roles until it rolls under, and a
fresh `tumwater wake <role>` or an inbox message for one admits a single run anyway), a nightly
`quietHours` window (e.g. `"23:00-07:00"` local time) during
which roles start no new runs (the director is exempt), with optional per-role windows
`quietHoursPerRole` — a role inside its own window starts no new runs, whether or not the
team-wide window covers now — an optional `maxConcurrentPerProvider` map of per-provider
concurrency caps (each value a positive integer keyed by provider; a run starts only when both
its provider and `maxConcurrent` have headroom, and a full provider never holds back a run on
another — see [plans/provider-concurrency.md](../plans/provider-concurrency.md)) — a
`diskHoldGB` free-space floor (default 10; when the volume
holding the worktrees drops below it, no new work starts until free space recovers 5 GB above it;
0 disables), a `diskReclaimGB` pressure-reclaim threshold (default 40; below it idle worktrees
drop their gitignored build outputs before the hold engages; 0 disables), and a
`worktreeIdleReclaimHours` window (default 24; an hourly pass drops a worktree's gitignored build
outputs once it has sat unused that long, whatever the free space; 0 disables), a
`worktreeSlots` count of workspaces shared by role runs and merge checks (default
`maxConcurrent` + 1; the director's workspace sits outside the shared set) — your own
`customRoles`, and an
optional `notify` shell command run when the team needs a human (a budget pause, a budget warning
at 80% of the cap while the gate is still open, a role's own cap warning or cap pause, low disk
space holding new work, a claude subscription window nearing its limit or holding the claude
model jobs, a repeated-failure pause, main's check failing, a failed merge, a blocked restart, a posted question, a blocked backlog entry, the
team going down — the command gets
`TUMWATER_EVENT_TYPE`, `TUMWATER_EVENT_LOOP`, and `TUMWATER_EVENT_MESSAGE` in its environment;
verify it with `tumwater notify --test`; a hook that exits nonzero logs a warning).
Edits apply live while the team runs. A config file written before the settings were renamed still
loads, and `tumwater doctor` names each older key with its new name.
From the terminal, `tumwater config` prints the effective config as JSON, `tumwater config get
<key>` reads one resolved value, `tumwater config set <key> <value>` writes one top-level
key, and `tumwater config unset <key>` removes one — the inverse of `set`, so a value reverts
to its default or disappears from its map or section; dotted keys
(`maxDailyCostUsdPerRole.feature 1.5`, `roles.qa.model x`) merge one entry into the existing
map or role entry, while bare keys replace the whole value. `roles` always merges the built-in
catalog per entry at load, so a bare `config set roles` replaces the file's section but cannot
disable a role by omission — disable one with `tumwater config set roles.<id>.enabled false`.

Model backends (OpenAI-compatible endpoints, the `claude` backend, and fallbacks) are covered in
[backends.md](backends.md).

A bare model id that starts with `claude-` (such as `"strong": "claude-opus-5-5"`) routes to the
claude CLI even under the default `backend: "pi"`, so a Claude model runs on the claude CLI's
included usage beside models from other providers on pi; `anthropic/claude-…` keeps pi (see
[plans/agent-backends.md §3](../plans/agent-backends.md) rule 3a).
