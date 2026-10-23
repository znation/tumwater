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
`TUMWATER_EVENT_TYPE` (the type names are in the Notify events table below), `TUMWATER_EVENT_SOURCE`, and `TUMWATER_EVENT_MESSAGE` in its environment;
verify it with `tumwater notify --test`; a hook that exits nonzero logs a warning).
Edits apply live while the team runs. A config file written before the settings were renamed still
loads, and `tumwater doctor` names each older key with its new name.
From the terminal, `tumwater config` prints the effective config as JSON, `tumwater config get
<key>` reads one resolved value, `tumwater config set <key> <value>` writes one top-level
key, and `tumwater config unset <key>` removes one — the inverse of `set`, so a value reverts
to its default or disappears from its map or section (the confirmation names what the key now
resolves to, and says so when the file never held it); dotted keys
(`maxDailyCostUsdPerRole.feature 1.5`, `roles.qa.model x`, `review.model x`, `bootstrap.untilPlansDone 3`) merge one entry into the
existing map, role entry or section, while bare keys replace the whole value. `roles` always merges the built-in
catalog per entry at load, so a bare `config set roles` replaces the file's section but cannot
disable a role by omission — disable one with `tumwater config set roles.<id>.enabled false`.

## Every setting

`tumwater config` prints the effective values, and `tumwater config get|set|unset <key>` reads or writes them. One row per top-level key of `tumwater.json`, in the order the schema lists them; `test/config-doc.test.ts` fails when a row is missing or stale. Defaults are what a file with no entry for the key gets.

| Key | Default | What it does |
| --- | --- | --- |
| `provider` | none | The pi provider name; unset leaves pi's own default. |
| `model` | none | The model for runs: one selector `provider/id[:thinking]`, or a map of tiers `small`/`default`/`strong` whose entries may be selector objects `{ "backend", "model", "thinking" }`; unset leaves pi's own default. |
| `thinking` | none | The pi thinking level; unset leaves pi's own default. |
| `backend` | `"pi"` | The default backend for every selector that names none: `"pi"`, `"claude"`, `"opencode"` or `"codex"`; a tier entry, role, review or fallback step names its own beside its `model`. A model id never names a backend: `claude/<id>`, `opencode/<id>` (under pi) and a bare `claude-…` id under pi fail the load, each message naming the `backend` edit, and a top-level `agent` key is an unknown key naming `backend`. See [backends.md](backends.md). |
| `baseBranch` | none | The branch the team merges into and bases every role's worktree on; unset targets whichever branch the primary checkout has checked out, and an explicit value must exist. |
| `agentBin` | none | The agent binary to spawn (`TUMWATER_PI_BIN` overrides it for one invocation); unset means `pi`, and a value with a path separator is resolved to an absolute path. |
| `backends` | `{}` | Per-backend overrides of the binary (`bin`), extra arguments (`args`), and, for claude and codex, a team config dir (`configDir`) and the subscription-window reserve (`windowReserve`), keyed by `pi`, `claude`, `opencode` or `codex`; see [backends.md](backends.md). `backends.claude.configDir` becomes `CLAUDE_CONFIG_DIR` for every claude process, so team transcripts and login live outside `~/.claude` (keeps a personal `funes` hook from indexing the team; it needs a one-time `claude auth login` in that dir). `backends.codex.configDir` is the Codex home (`CODEX_HOME`) — one `CODEX_HOME=<dir> codex login` seeds it — and `backends.codex.windowReserve` is the codex reserve. `backends.opencode.bin` names the OpenCode CLI (`TUMWATER_OPENCODE_BIN` overrides it for one invocation), and `backends.opencode.args` appends extra argv. An opencode passthrough arg is appended last and a positional value would be joined into OpenCode's message, so pass flag values as `--flag=value`. |
| `check` | none | The project's own verification command (`command`, optional cheaper `gateCommand`, optional `mergeCommand` (a cheaper check inside the merge lock; defaults to `gateCommand` when unset, and `""` keeps the full check in the lock; the main watch then runs the full check on main after the merge and a red reverts the change), `cwd`, `timeoutSeconds`); unset detects an npm script at the nearest installed root. |
| `piArgs` | `[]` | Extra arguments passed straight to pi; a flag the team sets itself is rejected. Team pi runs pass `--no-extensions` and re-enable only pi's built-ins (`llama.cpp`, `codemode`, `tool-search`) explicitly, so pi's auto-discovery — installed packages, `~/.pi/agent/extensions`, a target repo's own `.pi/extensions`, and the `mcp.json` server built-in — can never put an operator MCP server into a team run; `tumwater doctor`'s "pi extensions" row names what is being skipped. |
| `maxConcurrent` | `6` | The most model runs in flight at once across all roles, merges included; the director's own runs sit outside it. |
| `maxConcurrentPerProvider` | none | Per-provider caps on concurrent runs, beside `maxConcurrent`; an absent provider is uncapped. `maxConcurrentPerProvider.opencode` caps concurrent OpenCode runs (the rollout starts at 3). |
| `claudeWindowReserve` | none | The older top-level spelling of `backends.claude.windowReserve`: a per-window-type fraction (0–1] of the claude.ai subscription window left for you — at or past it the team counts the window as used up until it resets. Either may be set, but not both. The director is exempt. See [backends](backends.md). |
| `mergeBatchMax` | `3` | The most vetted changes stacked into one merge and one shared check; 1 merges every change on its own. |
| `maxConcurrentChecks` | `2` | The most runs of the project's check in flight at once across the whole team (editable from the dashboard Settings card as `Max concurrent checks`). |
| `worktreeSlots` | none | How many shared workspaces role runs and merge checks lease; unset means `maxConcurrent` + 1. |
| `minRunIntervalSeconds` | `20` | The minimum seconds between two runs of the same role, even when woken early. |
| `runTimeoutSeconds` | `14400` | The hard cap on one run, in seconds (four hours). |
| `quietTimeoutSeconds` | `1800` | Kill a run that emits no output for this many seconds; 0 disables. |
| `toolCallStallSeconds` | `300` | Warn, without killing, when one tool call has been open this many seconds with no output; 0 disables. |
| `logMaxBytes` | `16777216` | Rotate each role's pi transcript log when it exceeds this many bytes (16 MiB). The harness event log is separate: it rotates at a fixed 16 MiB and keeps five rotated generations, so a by-hand audit still sees months. |
| `sessionRetentionDays` | `7` | Delete pi session files older than this many days at start; 0 disables. |
| `maxDailyCostUsd` | `50` | The daily spend cap in USD; once reached, roles start no new runs until local midnight or a live edit; 0 disables. |
| `maxDailyCostUsdPerRole` | none | Per-role daily caps in USD, keyed by role id; 0 disables that role's cap and an absent role is uncapped. |
| `maintenancePerWorkMerge` | `2` | Code-maintenance merges allowed per feature, bugfix or director merge in a rolling 24 h window, on top of a floor of 12. |
| `quietHours` | none | A daily local-time window `"HH:MM-HH:MM"` in which roles start no new runs; empty or unset means off. |
| `quietHoursPerRole` | none | Per-role quiet-hours windows, keyed by role id; a role is held when either its own window or `quietHours` covers now. |
| `diskHoldGB` | `10` | The free-space floor in GB for the volume holding the worktrees; below it no new work starts; 0 disables. |
| `diskReclaimGB` | `40` | Below this many GB free, idle worktrees drop their gitignored build outputs before the hold engages; 0 disables. |
| `worktreeIdleReclaimHours` | `24` | Hours a worktree may sit unused before its gitignored build outputs are dropped; 0 disables. |
| `notify` | none | A shell command run when the team needs a human; empty or unset disables. |
| `fallback` | none | The budget fallback as one selector, a step object `{ "backend", "model", "thinking", "maxDailyCostUsd" }`, a list of those, or a map by tier (values may be `"pause"`); see [backends.md](backends.md). |
| `fallbackModel` | none | The free model roles switch to when `maxDailyCostUsd` is reached, as `provider`/`model`/`thinking`; mutually exclusive with `fallback`. |
| `thrashTurns` | `40` | A run is flagged high-friction only when it used more than this many assistant turns and ran longer than `thrashMinutes`. |
| `thrashMinutes` | `30` | The wall-clock minutes half of the high-friction test; see `thrashTurns`. |
| `idleBackoff` | `{"initialSeconds":120,"factor":2,"maxSeconds":3600}` | How long a role sleeps after a run that changed nothing: the first sleep, the multiplier for each further idle run, and the ceiling. |
| `autoRestart` | `true` | Rebuild and restart onto new code when main's build inputs move past the running build and main is green; off, the dashboards only flag the stale build. |
| `bootstrap` | none | Set by `tumwater init` on a new project: `untilPlansDone` holds the maintenance roles until that many plans are Done; removing it ends bootstrap early. |
| `review` | `{"enabled":true,"exemptPaths":["*.md","docs/**"],"afterMerge":["bugfix","clean","coverage","dedupe","organize","readme"]}` | The adversarial review (`enabled`, `exemptPaths`, `afterMerge`, `provider`, `model`, `thinking`, `timeoutSeconds`). `afterMerge` lists base role ids (never `director`) whose changes merge once the gate passes and are reviewed after merging; a rejection reverts the commit and hands it back as a revision. `[]` opts out (every role is reviewed before merging). Tiered by blast radius: the high-volume maintenance roles (bugfix, readme, organize, plus clean, dedupe, coverage) move the model-verdict pass after merge, while feature, director, perf, improve and custom roles keep the pre-merge verdict. Everything deterministic (build pre-check, conflict markers, protected edits, secret leaks, backlog structure) stays fail-closed before merge for every role. Tradeoff accepted: at the fleet's reject rate roughly half of the listed roles' changes land-then-revert before a fix lands — the main baseline watcher and fast-merge's "a red main stops nobody" carry that churn. |
| `customRoles` | `[]` | Your own roles; each is merged into `roles` as enabled at load. |
| `roles` | the built-in catalog | Per-role entries merged over the built-in catalog; the fields are in the next table. |

The fields of a `roles.<id>` entry:

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` (`false` for selfcheck and feedback) | Whether the role runs. `feedback` and `selfcheck` are alternatives: selfcheck files tumwater bugs into the local BUGS.md on the tumwater repo itself (dogfood), while `feedback` files them as GitHub issues on znation/tumwater from any other install that opts in; nothing leaves the machine until `roles.feedback.enabled` is true. |
| `instructions` | none | Extra instructions appended to this role's prompt. The director's entry is honored like any role's (its notes stay unset, the `role` command's `--clear-notes` refusal). |
| `provider` | none | A provider override for this role; unset uses the top-level value. |
| `model` | none | A model override for this role: a selector, or a tier name from the top-level `model` map; a value one or two letters off a tier name (in any case) is rejected as a misspelled tier; unset uses the role's catalog tier. |
| `backend` | none | The backend (`pi`, `claude`, `opencode`, `codex`) that runs this role's `model`; the id passes to it as written. Alone, it inherits the tier's model only when that tier already routes to the same backend, otherwise the backend's tier default applies. See [backends.md](backends.md). |
| `thinking` | none | A thinking-level override for this role; unset uses the top-level value. |
| `minRunIntervalSeconds` | `3600` for plan and organize, `1800` for readme, `7200` for qa, selfcheck and feedback, `21600` for steward, otherwise the top-level value | The minimum seconds between two runs of this role, overriding the top-level value. While PLANS.md's `## Planned` still has planning room (`planBacklogFull` false — below the plan loop's eligible-plan target, or holding a plan that needs review/needs replan), the plan role schedules with a zero gap instead, so a productive plan run reruns on the next poll and an unproductive one drops to the idle backoff; once the target is met the plan loop defers (`plans-full`) and this interval applies. |
| `instances` | `1` | How many runs of the role may write code at once, 1–8; accepted only for feature and bugfix. Above 1, tumwater keeps up to twice as many runners (`feature` … `feature-10` at 5), so a runner waiting on its change does not hold a place. |

Model backends (OpenAI-compatible endpoints, the `claude` backend, and fallbacks) are covered in
[backends.md](backends.md).

A Claude model beside models from other providers on pi is a selector object with the backend
named: `"strong": { "backend": "claude", "model": "claude-opus-5-5" }` runs on the claude CLI's
included usage, while `anthropic/claude-…` stays on pi (see
[plans/agent-backends.md §3](../plans/agent-backends.md)). A fallback step takes the same keys
(`{ "backend", "model", "thinking", "maxDailyCostUsd" }`).

## Notify events

The `notify` command receives one of these values as `TUMWATER_EVENT_TYPE`; each type pages at most once a minute; an event that minute held back is sent when the minute ends (the newest one, with a count of the others), and `tumwater notify --test` sends `merge_failed`.

| Event | When it fires |
| --- | --- |
| `budget_warning` | Daily spend crossed 80% of the cap and the gate is still open: time to raise the cap or fix the fallback before the pause. The event names up to three roles that spent the most today. |
| `role_cap_warning` | One role's own daily spend crossed 80% of its cap and it is still running: time to raise the cap before the pause. |
| `budget_paused` | The spend cap is hit with no usable free fallback, so the role loops are stopped; the message names the lift paths (raise or remove `maxDailyCostUsd`, or wait for the local day to roll over); like `budget_warning` it carries `topRoles`, the roles spending most today, omitted when none did. |
| `subscription_window_warning` | The claude.ai subscription window first reported a warning (once per window, also across restarts), and the message names how full the window is when claude reported it; claude jobs still run. This is the heads-up before the hold. |
| `subscription_window_limited` | The subscription window was rejected, so every claude job is held until it resets. |
| `role_streak_paused` | The repeated-failure breaker paused a role; the message names the streak and its last error. |
| `role_cap_paused` | A role reached its own daily cost cap and stops starting runs. |
| `disk_low` | Free space on the worktrees volume dropped below `diskHoldGB`, so new work is held. |
| `main_red_hold` | Main's own check is failing. When the check names its failing tests, the message names the first and roles keep working on changes that add no new failures; otherwise every code role is held until a fix merges. |
| `merge_failed` | A merge finished without landing its change; the message names the change's summary and why the merge failed: the review's first reason, or the check, block or error that stopped it. |
| `restart_blocked` | The restart onto the new main is blocked, and the team is stuck behind it. |
| `question_posted` | A merge added a new entry under `## Open` in QUESTIONS.md; only a human can answer it; the message names the question's number and the `tumwater questions answer` command. |
| `entry_refused` | A refusal note landed, so the entry is held until a human or the director releases it; the message names the held entry. |
| `supervisor_exit` | The supervisor gave up and the team is down; the supervisor runs the hook itself. |
