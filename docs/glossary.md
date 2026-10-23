# Glossary

The plain terms tumwater uses in everything you read: CLI output, help, the dashboard, the TUI,
notifications and agent prompts. This page also maps every older word and machine name to its
current one, so history, old logs and old scripts stay readable.

## Terms

| Term | Meaning | Older names |
| --- | --- | --- |
| team | All the roles running on a project, together. | fleet |
| role | One specialist (feature, bugfix, plan, …) and the worker that runs it. A role with parallel instances shows each as `feature #2` (id `feature-2`). | loop, runner |
| instance | One of several parallel workers of the same role (`roles.<id>.instances`). Shown only when a role has more than one, for example `feature #2` (id `feature-2`). | loop id |
| run | One pass of a role: wake up, find one thing to do, do it, commit. A reviewer run and a conflict-resolver run are runs too. | tick |
| merge | The pipeline that takes a run's commit onto main: rebase, check, review, fast-forward. | landing, land |
| merge queue | Commits waiting to merge, in order (`tumwater queue`). | land queue |
| merged | On main. | landed, changed, "Changes" |
| approved | Passed the check and review, waiting for its turn to merge. | vetted |
| director | The role that runs your messages first and keeps working through a team pause. | (unchanged) |
| you | The person running tumwater. Prose only; the commit prefix stays `tumwater(operator):`. | operator |
| custom role | A role you define in `customRoles`. | user-defined loop, custom loop |
| brief | The project description every role reads. | initial prompt, project brief |
| instructions | A role's built-in instructions plus your override. | standing prompt, find text, instructions override |
| notes | A role's own scratch file that carries over between runs. | notebook |
| inbox | Messages waiting for a role's next run (`tumwater prompt`). | queued prompts, "Queued" tab |
| check | The project's declared check (`check.command`). | main check, build check, gate check, baseline check, project check, suite |
| update | tumwater's own newer build, restarted onto after the cooldown; work continues on the current build meanwhile. | stale build, self-redeploy, generation |

## Status words

| Word | Meaning |
| --- | --- |
| due | A role is ready and the next poll starts it — a role the poll declined but will decline again shows an `idle: …` or `waiting: …` reason instead. |
| idle: every role instance is busy | The role's concurrent-instances cap is full (another of its instances is writing). |
| idle: waiting out its yield gap ×N | A scalable role is held back by its yield-stretched minimum gap. |
| waiting to merge | A run's commit is in the merge queue. |
| waiting: <reason> | A role is held by a condition, such as "waiting: low disk" or "waiting: maintenance allowance used". |
| blocked | A backlog entry that cannot be picked: `[blocked: refused]`, `[blocked: needs review]`, `[blocked: requires …]`. |
| sleeping | A role is between runs ("sleeping — next check in 12m"). "Wake sleeping roles" ends the sleep. |
| stalled | A run was stopped for producing nothing ("Stalled, resumed"). |
| paused | Only a pause you set. |
| update available | A newer tumwater build exists ("Update available (3 commits behind)"); work continues while the restart waits. |
| restart N | How many times tumwater has restarted onto an update. |
| priority | Which kind of work a role does first, for example "Priority: work". |
| over-cap model | The model a role falls back to when its budget cap is spent. |
| fallback | The model used when the first choice is unavailable. |
| model jobs | The things a model does for tumwater: role runs, the reviewer and the conflict resolver. Doctor's routing header reads `job · model · backend`. |
| model id | The string naming a model. |
| backend and model | Two axes: `model` names the model, `backend` (`pi`, `claude`, `opencode`, `codex`) names the program that runs it; a tier entry, role, review or fallback step sets both, and the top-level `backend` is the default for any that names none. |
| workspace | A working copy where a role does its run (config key `worktreeSlots`). |
| running N of M | How many runs are in progress out of the most allowed at once. |
| waiting to start | A run is due but all workspaces or run slots are busy. |
| finishing up | tumwater is finishing current work, then stopping. |
| repeated-failure pause | A role stopped after too many failed runs in a row. |
| stopped by you | A run you aborted. |
| interrupted | A run cut short by a restart or a crash. |
| your checkout | The working copy you edit, where main is checked out. |
| estimated spend | Cost computed from token counts, not billed. |
| main's check is failing | The check fails on main. |
| send later | Hold a message until a chosen time (`prompt --at`). |
| TUI | The terminal interface. "Observer" names the qa, selfcheck and feedback role group. |

## In the code

Identifiers keep these words as precise internal terms, though the text users read does not.

- **seam**: one place the code chooses a model and backend for a job.
- **operator**: the person at the keyboard; appears in the `tumwater(operator):` commit prefix and the operator command modules.
- **harness**: the tumwater program itself, as opposed to the agents it runs.
- **slot**: a counted lease on a limited resource, such as a workspace, a merge or a provider.
- **hold**: a condition that keeps a role or backlog entry from being picked.
- **backoff**: the growing delay a role sleeps after a failed or empty run.
- **drain**: stop starting new work and let current work finish.
- **reclaim**: delete idle workspaces to free disk.
- **director**: the role that handles your messages first; it keeps running through a team pause.
- **orchestrator**: the process that schedules every runner and owns the git operations.
- **runner**: one instance of a role, the code word for `feature-2`.

Identifiers follow the glossary: fleet → team, loop → runner, tick → run, landing/land/lander/vet → merge, notebook → notes, initialPrompt → brief, customLoop → customRole, the config `agent` → backend.

## Older names

### Words

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| fleet | team | n/a (prose) |
| loop, runner | role | n/a (prose) |
| loop id | instance | n/a (prose) |
| tick | run | n/a (prose) |
| landing, land | merge | n/a (prose) |
| land queue | merge queue | n/a (prose) |
| landed, changed, "Changes" | merged | n/a (prose) |
| vetted | approved | n/a (prose) |
| operator | you | n/a (prose) |
| user-defined loop, custom loop | custom role | n/a (prose) |
| initial prompt, project brief | brief | n/a (prose) |
| standing prompt, find text, instructions override | instructions | n/a (prose) |
| notebook | notes | n/a (prose) |
| queued prompts, "Queued" tab | inbox | n/a (prose) |
| main check, build check, gate check, baseline check, project check, suite | check | n/a (prose) |
| stale build, self-redeploy, generation | update | n/a (prose) |
| "Queued" (role state) | Due | n/a (prose) |
| "Queued to land" | Waiting to merge | n/a (prose) |
| "queue" (other than the merge queue) | inbox or due | n/a (prose) |
| "slots 5/8", "Waiting for a slot", "Concurrent pi slots" | running 5 of 8, waiting to start, running at once | n/a (prose) |
| worktree slot, worktree pool | workspace, workspaces | n/a (prose) |
| merge slot, check slot, provider slot | not shown; say what is happening | n/a (prose) |
| a held backlog entry ([refused], [needs review], [needs replan], [blocked: requires …]) | blocked (`[blocked: refused]`, `[blocked: needs review]`, …) | n/a (prose) |
| disk, bootstrap, maintenance, 429, backend, claude-window hold | waiting ("waiting: low disk") | n/a (prose) |
| "paused" (for any hold) | paused only for a pause you set | n/a (prose) |
| "main is red", "main red" | main's check is failing | n/a (prose) |
| "Build abc · 3 behind", STALE, "self-redeploys", "generation N" | Update available (3 commits behind) — restarts after cooldown; work continues; restart N | n/a (prose) |
| "build" (for tumwater's own build) | update; "build" means only the project's build outputs | n/a (prose) |
| "Scheduling tier: 0 (work)" | Priority: work | n/a (prose) |
| status table column `gen` | output | n/a (prose) |
| "tier" (for scheduling) | priority; "tier" means only small/default/strong models | n/a (prose) |
| budget fallback | over-cap model | n/a (prose) |
| quiet kill | stall ("Stalled, resumed") | n/a (prose) |
| "while the project is quiet" | "while there is nothing to do" | n/a (prose) |
| "quiet" (for idleness) | quiet means only quiet hours | n/a (prose) |
| observer TUI | TUI | n/a (prose) |
| seam(s), "claude seams", "strong seams", `routing: seam selector backend` | model jobs; header `job · model · backend` | n/a (prose) |
| drain, draining | finish current work, then stop; finishing up | n/a (prose) |
| backoff, backing off, backed-off | sleeping ("sleeping — next check in 12m"), "Wake sleeping roles" | n/a (prose) |
| error-streak breaker | repeated-failure pause | n/a (prose) |
| harness | tumwater | n/a (prose) |
| "pi" (where the claude backend is reached too) | agent ("no agent output for 9m") | n/a (prose) |
| selector | model id | n/a (prose) |
| primary checkout | your checkout | n/a (prose) |
| claim, sibling ("idle: sibling mid-entry") | "another feature instance is working on it" | n/a (prose) |
| notional spend | estimated spend | n/a (prose) |
| conflict hand-back | "sent back to the role to resolve" | n/a (prose) |
| "Aborted by you", Interrupted (for both) | Stopped by you (abort) and Interrupted (restart or crash) | n/a (prose) |
| raw codes in the UI (`tick_end` chips, `no_change`, `merge_blocked`) | display labels ("run finished", "no change", "merge blocked"); codes stay in `--json` and `logs --type` | n/a (prose) |
| doctor checks "fix claims", "stranded plans", "mach ports", "tier models", "work instances", "worktree pool", "merge lock", "stale queued landings" | "claimed bugs", "plans stuck in Planned", "macOS port leak", "models for each tier", "parallel instances", "workspaces", "merge lock", "stale merge-queue entries" | n/a (prose) |
| Health check, Initial prompt, Queued view | Health, Brief, Inbox (one name on both surfaces) | n/a (prose) |
| `feature-2` in prose or labels | feature #2 (the id stays in `--role`, `--json` and paths) | n/a (prose) |

### Commands

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| `tumwater run …` | `tumwater start …` | yes, as a hidden alias |
| `tumwater tick <role> <n> [--last] [--stat] [--json]` | `tumwater history <role> <n> [--last] [--stat] [--json]` | yes, as a hidden alias |
| `tumwater history --result changes` | `tumwater history --result merged` | yes, as a hidden alias |

### Config keys

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| `customLoops` | `customRoles` | yes; `tumwater doctor` names the rename |
| `minTickIntervalSeconds` (top level and `roles.<id>`) | `minRunIntervalSeconds` | yes; `tumwater doctor` names the rename |
| `tickTimeoutSeconds` | `runTimeoutSeconds` | yes; `tumwater doctor` names the rename |
| `landBatchMax` | `mergeBatchMax` | yes; `tumwater doctor` names the rename |
| `maintenancePerWorkLanding` | `maintenancePerWorkMerge` | yes; `tumwater doctor` names the rename |
| `agent` | `backend` | no; a top-level `agent` key fails the load as an unknown key naming `backend` |
| `agents` (and `agents.<id>.bin`/`.args`) | `backends` | yes; `tumwater doctor` names the rename |
| `agentBin`, `piArgs` | `backends.pi.bin`, `backends.pi.args` | yes; `tumwater doctor` names the rename |

A config file that sets both the older and the current name of a key is refused.

### Role ids and titles

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| `dry` | `dedupe` (duplication remover) | yes, old ids are accepted on read |
| `telemetry` | `selfcheck` (self-check: files tumwater bugs from its own failure log) | yes, old ids are accepted on read |
| `steward` | `steward` (title: backlog curator) | id unchanged |
| `readme` | `readme` (title: brief and README keeper) | id unchanged |

### Event log

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| field `loop` (runner id, or `"harness"`) | field `source` (runner id, or `"tumwater"`) | yes, old lines are read as new ones |
| `tick_start`, `tick_end`, `tick_deferred`, `tick_aborted` | `run_start`, `run_end`, `run_deferred`, `run_aborted` | yes, old lines are read as new ones |
| payload field `tick` | payload field `run` | yes, old lines are read as new ones |
| `land_queued`, `landed`, `land_failed` | `merge_queued`, `merge_done`, `merge_failed` | yes, old lines are read as new ones |
| `fleet_paused`, `fleet_resumed` | `team_paused`, `team_resumed` | yes, old lines are read as new ones |
| `build_check.scope: "landing"`, `conflict_handback.reason: "landing"` | `"merge"` | yes, old lines are read as new ones |
| `slot_wait.purpose: "tick"` / `"vet"` | `"run"` / `"verify"` | yes, old lines are read as new ones |
| `restart` payload `drainedMs`, `abortedTicks`, `drainWindowMs` | `finishedMs`, `abortedRuns`, `finishWindowMs` | yes, old lines are read as new ones |
| `claim` payload `source: "staged"` | `origin: "staged"` | yes, old lines are read as new ones |
| `TUMWATER_EVENT_LOOP` (notify hook env) | `TUMWATER_EVENT_SOURCE` | no |

The existing `merged` event (fast-forwarded onto main) is unchanged. `logs --type` takes the current names and also matches an older one.

### Script interfaces

None of these keep the older name, except the dashboard hashes.

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| `/api/status` and `status --json`: `loops[]` | `roles[]` | no |
| status rows: `ticks`, `lastTickEndedAt`, `lastLandedAt` | `runs`, `lastRunEndedAt`, `lastMergedAt` | no |
| status payload: `landQueue` (entries' `tick`), `landingBadge`, `landQueueLabels` | `mergeQueue` (entries' `run`), `mergeBadge`, `mergeQueueLabels` | no |
| status `phase` value `landing` (and the other role-state labels) | `merging` (following the role-state labels) | no |
| `history --json` rows: `loop`, `tick` | `role`, `run` | no |
| `history --json` summary: `{loops:[{loop,ticks}]}` | `{roles:[{role,runs}]}` | no |
| run trail (`history <role> <n> --json`, formerly `tick --json`): `tick`, `landing` | `run`, `merge` | no |
| `report --json`: `ticks`, `ticksByRole`, `failedTicksByRole` | `runs`, `runsByRole`, `failedRunsByRole` | no |
| `report --json`: `landingRuns`, `landingTokens`, `landingCostUsd`, `landingFailed` | `mergeRuns`, `mergeTokens`, `mergeCostUsd`, `mergeFailed` | no |
| `report --json`: `landedByRole`, `landingFailedByRole` | `mergedByRole`, `mergeFailedByRole` | no |
| `report --failures --json`: `ticks`, `prevTicks`, `landed`, `landedTotal`, time-spend class `"landed"` | `runs`, `prevRuns`, `merged`, `mergedTotal`, `"merged"` | no |
| `role --json`: `minTickIntervalSeconds`, `agent`, `note` | `minRunIntervalSeconds`, `backend`, `notes` | no |
| `role --json` and status rows: `lastTickEndedAt`; fallback view `agent` | `lastRunEndedAt`; `backend` | no |
| `retire --json`: `landingRef`, `midTick` | `mergeRef`, `midRun` | no |
| `queue --json`: `entries[].tick` | `entries[].run` | no |
| `doctor --json`, `/api/doctor`: `seams` | `routing` | no |
| route `GET /api/tick` | `GET /api/run` | no |
| `/api/config`: `agents` | `backends` | no |
| activity feed items (`/api/logs`, status `eventItems`): `loop` | `source` | no |
| dashboard hashes `#fleet`, `#loop/<id>` | `#team`, `#role/<id>` | yes, the older hashes still route |
| alert action `act:"loop"` | `act:"role"` | no |

### State and git

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| `state/<id>.json` fields `ticks`, `lastTickStartedAt`, `lastTickEndedAt`, `landingReviewError`, `landingCheckFailures`, `lastLandedAt` | `runs`, `lastRunStartedAt`, `lastRunEndedAt`, `mergeReviewError`, `mergeCheckFailures`, `lastMergedAt` | yes, read and migrated |
| `.tumwater/land-queue/` and its entries' `tick` | `.tumwater/merge-queue/` and `run` | yes, read and migrated |
| `state/landing.json`, status `"landing"` / `"vetted"` / `"done"` | `state/merging.json`, status `"merging"` / `"approved"` / `"done"` | no, a leftover file is deleted at startup (display-only) |
| `slots.json` `purpose: "tick"` / `"vet"` | `"run"` / `"verify"` | yes, read and migrated |
| refs `refs/tumwater/landing/<id>` | `refs/tumwater/merge/<id>` | yes, read and migrated |
| commit trailer `Tick: <id> #N · turns … · ctx …` | `Run: <id> #N · turns … · ctx …` | yes, parsers accept both |

### Code identifiers

For readers of old commits. None of the older identifiers is kept.

| Older name | Current name | Old name still accepted? |
| --- | --- | --- |
| `fleet`, `Fleet`; `src/fleet/`; `fleet-*.ts`; `gui-client-fleet.ts`; `gui-fleet-commands.ts`; `fleet-alerts.ts` | `team`, `Team`; `src/team/`; `team-*.ts`; `gui-client-team.ts`; `gui-team-commands.ts`; `team-alerts.ts` | no |
| `LoopRunner`, `LoopState`, `loopId`/`loopIds`, `loop-state.ts`, `loop-ids.ts`, `src/loop/`, `loop-*.ts` | `RoleRunner`, `RunnerState`, `runnerId`/`runnerIds`, `runner-state.ts`, `runner-ids.ts`, `src/runner/`, `runner-*.ts` | no |
| `gui-client-loops.ts` | `gui-client-roles.ts` | no |
| `tick`/`Tick`, `src/tick/`, `tick-*.ts`, `TickResult`, `tickNumber` | `run`/`Run`, `src/run/`, `run-*.ts`, `RunResult`, `runNumber` | no |
| `runTick`, `runTimedRoleTick` (on collision) | `runOnce`, `runTimedRoleRun` | no |
| `cmdRun`, `cli-run.ts` | `cmdStart`, `cli-start.ts` | no |
| `src/landing/`, `landing-*.ts` | `src/merge/`, `merge-*.ts` | no |
| `landing-merge.ts`, `landing-vetting.ts` | `merge-to-main.ts`, `merge-verify.ts` | no |
| `lander`, `landQueue`, `landed` | `merger`, `mergeQueue`, `mergeDone` | no |
| `vet`/`vetting`, `vetted` | `verify`, `approved` | no |
| notebook | notes | no |
| `initialPrompt` | `brief` | no |
| `customLoop`, `customLoops` | `customRole`, `customRoles` | no |
| `agent` (config backend selector) | `backend` | no |
| role ids `dry`, `telemetry` in identifiers and file names (`telemetry-digest.ts`) | `dedupe`, `selfcheck` (`selfcheck-digest.ts`) | no |

## What keeps the older words

Some places keep the older words on purpose, because they are a record rather than current text: the finished entries in PLANS-DONE.md and BUGS-FIXED.md, BUGS.md, QUESTIONS.md answers, `plans/*.md`, git history and commit subjects, the `tumwater(operator):` prefix, and `tumwater/<id>` branches. The tables above translate them.
