# Plain-language terminology: team, role, run, merge

Planned 2026-10-16, requested by the user ("where we say fleet, say team; where we say loop, say
role; find other jargon we could rename"), and decisions settled by the user the same day. This is the shared design for
every `Plain terms …` series in PLANS.md. Each entry there is independently landable and points
back to a section of this document instead of repeating its tables.

## The problem

Tumwater's vocabulary grew out of its implementation, not out of what a newcomer expects. A
first-time user reads that "a fleet of loops ticks, lands through the land queue once vetted,"
which takes a glossary to follow. Three things make it worse than ordinary jargon:

- **Two words name one thing.** "Loop" and "role" name the same thing (`--role <id>` scopes to
  "one loop"). So do "brief" and "initial prompt", and "notebook" and "notes". A merged change
  shows as "Landed", "merged", "changed" or "Changes".
- **One word names several things.** "Queued" has four meanings, "slot" five, "hold" six, and
  "prompt" four: the brief, a role's instructions, a queued message, and the assembled model
  prompt. "Tier" means both a scheduling class and a model size. "Fallback" means both the budget
  model and the failure backup.
- **Raw machine names leak into the UI.** The Activity feed shows `3 × tick_end` chips, and the
  status table shows `no_change` and `merge_blocked`.

## Decisions

Settled by the user on 2026-10-16:

1. **tick → run.** The `tumwater run` command becomes `tumwater start`, which pairs with
   `tumwater stop`. `tumwater tick <role> <n>` becomes `tumwater history <role> <n>`. Both old
   spellings stay as hidden aliases.
2. **director stays `director`** everywhere: UI, CLI and code.
3. **Script-facing names may break.** That covers `--json` keys, `/api/*` routes and payloads,
   event types and fields in `events.jsonl`, and the notify hook's environment. There are no
   compatibility aliases for them, with two exceptions:
   - **Old data stays readable.** The event log and state files are normalized on read (see
     "Event log" and "State and git").
   - **Old dashboard URL hashes still route**, because bookmarks cost nothing to keep.
4. **Role names change in both places:** display titles and ids. `dry` → `dedupe` and
   `telemetry` → `selfcheck`, with migration (see "Role names").
5. **The `tumwater(operator):` commit prefix stays.** It is git history, and it reads clearly.
6. **The internal code rename happens too** (see "Code names"). It comes last, after every
   user-facing and persisted change.

Every other suggestion from the 2026-10-16 survey is adopted as written below.

## Glossary

The user-facing terms. Each entry gives the term, what it means, and the old words it replaces.
`docs/glossary.md` is generated from this table, with each term's one-line meaning.

| Term | Meaning | Replaces |
| --- | --- | --- |
| team | All the roles running on a project, together | fleet |
| role | One specialist (feature, bugfix, plan, …) and the worker that runs it. A role with parallel instances shows each as `feature #2` (id `feature-2`). | loop, runner |
| instance | One of several parallel workers of the same role (`roles.<id>.instances`). Shown only when a role has more than one. | loop id |
| run | One pass of a role: wake up, find one thing to do, do it, commit. A reviewer run and a conflict-resolver run are runs too. | tick |
| merge | The pipeline that takes a run's commit onto main: rebase, check, review, fast-forward. | landing, land |
| merge queue | Commits waiting to merge, in order (`tumwater queue`) | land queue |
| merged | On main | landed, changed, "Changes" |
| approved | Passed the check and review, waiting for its turn to merge | vetted |
| director | The role that runs your messages first and keeps working through a team pause | (unchanged) |
| you | The person running tumwater (prose only; the commit prefix stays `tumwater(operator):`) | operator |
| custom role | A role you define in `customRoles` | user-defined loop, custom loop |
| brief | The project description every role reads | initial prompt, project brief |
| instructions | A role's built-in instructions plus your override | standing prompt, find text, instructions override |
| notes | A role's own scratch file that carries over between runs | notebook |
| inbox | Messages waiting for a role's next run (`tumwater prompt`) | queued prompts, "Queued" tab |
| check | The project's declared check (`check.command`) | main check, build check, gate check, baseline check, project check, suite |
| update | tumwater's own newer build, restarted onto when idle | stale build, self-redeploy, generation |

## Wording rules

These rules are for user-visible text: CLI output, help, dashboard, TUI, notify messages, warning
messages, and agent prompts. Each row is a rule a reviewer can check.

| Today | Write instead |
| --- | --- |
| "Queued" (role state: due, starts on the next poll) | **Due** |
| "Queued to land" (a run's result) | **Waiting to merge** |
| "queue" anywhere except the merge queue | **inbox** (messages) or **due** (roles) |
| "slots 5/8", "Waiting for a slot", "Concurrent pi slots" | **running 5 of 8**, **waiting to start**, **running at once** |
| "worktree slot", "worktree pool" | **workspace**, **workspaces** (the config key `worktreeSlots` stays) |
| merge slot, check slot, provider slot | Not shown. Say what is happening instead: "merging", "checking", "waiting for omlx". |
| A held backlog entry ([refused], [needs review], [needs replan], [blocked: requires …]) | **blocked** (`[blocked: refused]`, `[blocked: needs review]`, …) |
| Disk / bootstrap / maintenance / 429 / backend / claude-window hold | **waiting** ("waiting: low disk", "waiting: maintenance allowance used") |
| "paused" | Only for a pause you set |
| "main is red", "main red" | **main's check is failing** |
| "Build abc · 3 behind", STALE, "self-redeploys", "generation N" | **Update available (3 commits behind) — restarts when idle**, **restart N** |
| "build" | Only the project's build outputs |
| "Scheduling tier: 0 (work)" | **Priority: work** |
| status table column `gen` (tokens the last run generated) | **output** |
| "tier" | Only small/default/strong models |
| budget fallback | **over-cap model** |
| model fallback | **fallback** (unchanged) |
| quiet kill | **stall** ("Stalled, resumed") |
| "while the project is quiet" | "while there is nothing to do" |
| "quiet" | Only quiet hours |
| observer TUI | **TUI** ("observer" means only the qa/selfcheck role group) |
| seam(s) ("claude seams", "strong seams", doctor `routing: seam selector backend`) | Name the thing: "role runs, the reviewer and the conflict resolver", or **model jobs** for short. Doctor's routing header becomes `job · model · backend`. |
| drain, draining | **finish current work, then stop**, **finishing up** |
| backoff, backing off, backed-off | **sleeping** ("sleeping — next check in 12m"), "Wake sleeping roles" |
| error-streak breaker | **repeated-failure pause** |
| harness | **tumwater** |
| "pi" in a message that the claude backend reaches too ("no pi output for 9m") | **agent** ("no agent output for 9m") |
| selector | **model id** |
| primary checkout | **your checkout** |
| claim, sibling ("idle: sibling mid-entry") | "another feature instance is working on it" |
| notional spend | **estimated** spend |
| conflict hand-back | "sent back to the role to resolve" |
| Interrupted vs "Aborted by you" | **Stopped by you** (abort) and **Interrupted** (restart or crash) |
| Raw codes in the UI (`tick_end` chips, `no_change`, `merge_blocked`) | Display labels ("run finished", "no change", "merge blocked") from one shared map. Codes stay in `--json` and `logs --type`. |
| Doctor check names ("fix claims", "stranded plans", "mach ports", "tier models", "work instances", "worktree pool", "merge lock", "stale queued landings") | Plain titles ("claimed bugs", "plans stuck in Planned", "macOS port leak", "models for each tier", "parallel instances", "workspaces", "merge lock", "stale merge-queue entries") |
| Dashboard/TUI name mismatches: Health vs Health check, Brief vs Initial prompt, Queued tab vs Queued view | One name on both surfaces: **Health**, **Brief**, **Inbox** |
| `feature-2` in prose or labels | **feature #2** (from one shared label helper). The id stays in `--role`, `--json` and paths. |

## Commands and config

The new name is canonical, and the old one is a hidden alias: not shown in help or completion,
and never removed.

| Old | New |
| --- | --- |
| `tumwater run …` | `tumwater start …` (same flags: `--gui`, `--tui`, `--for`, `--once`, `--role`, `--branch`) |
| `tumwater tick <role> <n> [--last] [--stat] [--json]` | `tumwater history <role> <n> [--last] [--stat] [--json]`. `history <role> --last` shows the newest run's trail. The bare `tumwater history [flags]` listing is unchanged. |
| `tumwater history --result changes` | `--result merged` |

**Config keys.** Load accepts the old name, with these rules:
- A file that sets both the old and new name of a key is refused, naming the pair.
- `tumwater doctor` notes each old key with the exact rename.
- `config set|unset|get` accept both and write the new one.
- `init`, `tumwater.example.json`, the dashboard's editable-keys list and completion use only the
  new names.
- The director's `.tumwater-config-request.json` accepts both.
- Existing legacy aliases chain: `agentBin`/`piArgs` map to `backends.pi.bin`/`.args`.

| Old key | New key |
| --- | --- |
| `customLoops` | `customRoles` |
| `minTickIntervalSeconds` (top level and `roles.<id>`) | `minRunIntervalSeconds` |
| `tickTimeoutSeconds` | `runTimeoutSeconds` |
| `landBatchMax` | `mergeBatchMax` |
| `maintenancePerWorkLanding` | `maintenancePerWorkMerge` |
| `agent` | `backend` (the top-level default for selectors that name none; a tier entry, role, review or fallback step also takes `backend` beside `model`) |
| `agents` (and `agents.<id>.bin`/`.args`) | `backends` |

The supervisor keeps spawning its child generations with the `run` word. Every build accepts it,
so a respawn works even after a rollback to a build that predates `start`.

Unchanged: `worktreeSlots`, `diskReclaimGB`, `worktreeIdleReclaimHours`, `quietHours*`,
`maxConcurrent*`, `check.*`, `review.*`, and every `--role` flag.

## Role names

| Old id | New id | New title |
| --- | --- | --- |
| `dry` | `dedupe` | duplication remover |
| `telemetry` | `selfcheck` | self-check: files tumwater bugs from its own failure log |
| `steward` | (unchanged) | backlog curator |
| `readme` | (unchanged) | brief and README keeper |

Every other id and title is unchanged. The dashboard and TUI show the title beside the id
wherever a role is listed.

**Migrating an old id** (`dry`, `telemetry`):
- **One alias table, `LEGACY_ROLE_IDS`** (src/roles/legacy-role-ids.ts), read through
  `canonicalRoleId`. Each switch part adds one row to it. The event normalizer has no per-id
  rows. Mapping an id before its switch would show `dedupe` while the role is still `dry`.
- **On read, the old id is an alias of the new one:**
  - config `roles.<old>`, `maxDailyCostUsdPerRole.<old>` and `quietHoursPerRole.<old>`, with the
    same both-set refusal and doctor nudge as the config keys;
  - `--role <old>`;
  - the `source` of old events;
  - `state/paused-roles.json` entries;
  - merge-queue entries.
- **Once, at orchestrator startup**, before anything reads per-runner state, an idempotent step
  renames the old id's on-disk artifacts. It is registered in the startup-migration hook (see
  "State and git") after the merge-refs step:
  - branch `tumwater/<old>` → `tumwater/<new>`, skipped when the new branch exists;
  - refs `refs/tumwater/merge|rejected/<old>`;
  - `state/<old>.json`;
  - `state/notes/<old>.md`;
  - `inbox/<old>/`;
  - `sessions/<old>/` and `sessions/_review/<old>/`;
  - native and pi logs, which are left in place (they are history).
- **Commit subjects keep their history** (`tumwater(dry): …`). New commits say
  `tumwater(dedupe): …`.
- **Prompt text that greps git history** for a role's trailers matches both ids.

## Script interfaces

These rename with no alias (decision 3). The rule is the glossary applied to keys:
- `loop` → `role`
- `loops` → `roles`
- `tick` → `run`, and `ticks` → `runs`
- `land*`/`landing*`/`landed*` → `merge*`/`merged*`
- `notebook`/`note` → `notes`
- `agent` (backend) → `backend`
- doctor's `seams` → `routing`

In `--json` and API payloads, `role` holds the exact id (`feature-2`), and `instanceOf` keeps
naming the base role.

| Surface | Renames |
| --- | --- |
| `/api/status` = `status --json` (one payload) | `loops[]` → `roles[]`. Row fields: `ticks` → `runs`, `lastTickEndedAt` → `lastRunEndedAt`, `lastLandedAt` → `lastMergedAt`. `phase` values follow the role-state labels (`landing` → `merging`, …); they change with those labels in Plain terms text, because the payload ships the rendered label. `landQueue` → `mergeQueue` (its entries' `tick` → `run`), `landingBadge` → `mergeBadge`, `landQueueLabels` → `mergeQueueLabels`, `budget.agent` → `budget.backend`. Any other key containing a retired word follows the rule. |
| `history --json` | Rows: `loop` → `role`, `tick` → `run`. Summary: `{loops:[{loop,ticks}]}` → `{roles:[{role,runs}]}`. |
| run trail (`history <role> <n> --json`, formerly `tick --json`) | `tick` → `run`, `landing` → `merge` |
| `report --json` | `ticks` → `runs`, `ticksByRole` → `runsByRole`, `failedTicksByRole` → `failedRunsByRole`, `landingRuns` → `mergeRuns`, `landingTokens` → `mergeTokens`, `landingCostUsd` → `mergeCostUsd`, `landingFailed` → `mergeFailed`, `landedByRole` → `mergedByRole`, `landingFailedByRole` → `mergeFailedByRole` |
| `role --json` | `minTickIntervalSeconds` → `minRunIntervalSeconds`, `agent` → `backend`, `note` → `notes` |
| `retire --json` | `landingRef` → `mergeRef`, `midTick` → `midRun` |
| `doctor --json`, `/api/doctor` | `seams` → `routing` |
| Routes | `GET /api/tick` → `GET /api/run`. The other routes keep their names. |
| Dashboard hashes | `#fleet` → `#team`, `#loop/<id>` → `#role/<id>`. The old hashes still route. |
| Alert actions | `act:"loop"` → `act:"role"` |
| Notify hook env | `TUMWATER_EVENT_LOOP` → `TUMWATER_EVENT_SOURCE` (see "Event log") |
| `report --failures --json` | `ticks` → `runs`, `prevTicks` → `prevRuns`, `landed` → `merged`, `landedTotal` → `mergedTotal`, time-spend class `"landed"` → `"merged"` |
| `queue --json` | `entries[].tick` → `run` |
| Activity feed items (`/api/logs`, status `eventItems`) | `loop` → `source`, matching the event log |
| `role --json` and status rows | `lastTickEndedAt` → `lastRunEndedAt`; the fallback view's `agent` → `backend` |
| `/api/config` | `agents` → `backends` (it follows the config key, in Plain terms commands) |

Keys with no retired word in them keep their names, for example `backoffSeconds`, `slot`, `claim`,
`notionalCostUsd`, `quietKills`, `restartPending`, and the history summary's `changes` (the
`--result merged` flag maps onto that class internally). The Plain terms scripting entries list
every key they rename.

## Event log

`events.jsonl` changes its names, and **every reader normalizes old lines on read**. One
function, `normalizeLegacyEvent`, is applied at every point that parses an event line:
- the event reader and windowing;
- `logs -f` follow;
- the report fold cache;
- history and failure collectors;
- anything else that `JSON.parse`s an event line.

Old logs and rotated archives therefore read as if written today.

| Old | New |
| --- | --- |
| field `loop` (who logged it: a runner id, or `"harness"`) | field **`source`** (the runner id, or **`"tumwater"`**). `role` stays the field name for the subject of a role event (`role_paused`, `role_cap_*`, `slot_wait`, …). |
| `tick_start`, `tick_end`, `tick_deferred`, `tick_aborted`; payload `tick` | `run_start`, `run_end`, `run_deferred`, `run_aborted`; payload `run` |
| `land_queued`, `landed`, `land_failed` | `merge_queued`, `merge_done`, `merge_failed`. The existing `merged` (fast-forwarded onto main) is unchanged. |
| `fleet_paused`, `fleet_resumed` | `team_paused`, `team_resumed` |
| `build_check.scope: "landing"`, `conflict_handback.reason: "landing"` | `"merge"` |
| `slot_wait.purpose: "tick" \| "vet"` | `"run" \| "verify"` |
| `restart` payload `drainedMs`, `abortedTicks`, `drainWindowMs` | `finishedMs`, `abortedRuns`, `finishWindowMs` |
| `claim` payload `source: "staged"` | `origin: "staged"`, so it cannot collide with the new `source` field |

The normalizer is `normalizeLegacyEvent` in src/events/event-legacy.ts. It is applied in
`parseEventLine`, which every reader goes through, and in `logEvent`, so in-process subscribers
see exactly what readers see. Its rewrites are permanent, because a long-lived supervisor on an
older build can keep writing old names. Role ids are not mapped here (see "Role names"). The
`"tumwater"` source is the constant `TUMWATER_SOURCE`, and a custom role may not be named
`tumwater`. Test fixtures that write old lines straight to disk keep their old names on purpose:
they are the normalizer's regression tests.

`logs --type` takes the new names and also matches a legacy name, through the normalizer's map.
The notify allowlist and `TUMWATER_EVENT_TYPE` use the new names. `TUMWATER_EVENT_LOOP` becomes
`TUMWATER_EVENT_SOURCE`.

**Widely used fields.** `source` is written by every `logEvent` call site. So the rename goes
through the input type in stages:
1. `HarnessEventInput` accepts `source` (preferred) or `loop` (deprecated), `logEvent` always
   writes `source`, and every reader reads `source`.
2. Call sites switch from `loop:` to `source:` one directory group at a time.
3. A last part removes `loop` from the input type.

## State and git

Persisted state follows the same rules: read both forms, write the new one, and migrate
idempotently at orchestrator startup before the first read.

| Old | New |
| --- | --- |
| `state/<id>.json` fields `ticks`, `lastTickStartedAt`, `lastTickEndedAt`, `landingReviewError`, `landingCheckFailures`, `lastLandedAt` | `runs`, `lastRunStartedAt`, `lastRunEndedAt`, `mergeReviewError`, `mergeCheckFailures`, `lastMergedAt`. The loader maps the old keys, and the next save writes the new ones. |
| `.tumwater/land-queue/` and its entries' `tick` | `.tumwater/merge-queue/` and `run`. Startup moves the old directory's entries. |
| `state/landing.json`, status `"landing" \| "vetted" \| "done"` | `state/merging.json`, status `"merging" \| "approved" \| "done"` |
| `slots.json` `purpose: "tick" \| "vet"` | `"run" \| "verify"` |
| refs `refs/tumwater/landing/<id>` | `refs/tumwater/merge/<id>`. Startup moves them with `update-ref`. `refs/tumwater/rejected/<id>` is unchanged. |
| commit trailer `Tick: <id> #N · turns … · ctx …` | `Run: <id> #N · turns … · ctx …`. Every trailer parser accepts both, and so does every prompt that greps for it. ("turns" keeps meaning model turns.) |
| session names `tumwater-<id>-<tick>` | Unchanged (no retired word) |
| legacy `_land-<role>` worktree recognition | Unchanged |

**The startup-migration hook.** src/orchestrator/startup-migrations.ts holds the registry:
`registerStartupMigration`, `runStartupMigrations`, and `runStartupMigrationsIfIdle` for CLI
readers, which runs only when no team is alive. src/orchestrator/startup-migration-steps.ts
registers the steps in order: `mergeQueueDir`, `mergingMarker`, `mergeRefs`, and then the role-id
step. `runOrchestrator` awaits it before constructing any runner. A step that moved something
logs one `state_migrated` event. `slot_wait.purpose` moves with the `slots.json` lease purpose,
because they share one type.

**Self-hosting hazard.** tumwater develops itself. A commit lands under the build that predates
it, and the new build starts by reading what the old build left. So:
- every rename here ships its legacy reader in the same part as its new writer, or earlier;
- each migration runs before the orchestrator's first read of that file;
- each migration is tested against a fixture of the old layout.

## Code names

The last stage. Identifiers, file names, directory names, comments and test names adopt the
glossary.

**Renamed in code:**

| Family | Rule |
| --- | --- |
| fleet | **team**. `fleet` → `team` and `Fleet` → `Team`, in identifiers and comments. `src/fleet/` → `src/team/`; `fleet-*.ts` → `team-*.ts`; `gui-client-fleet.ts` → `gui-client-team.ts`; `gui-fleet-commands.ts` → `gui-team-commands.ts`; `fleet-alerts.ts` → `team-alerts.ts`. |
| loop (the per-instance worker) | **runner** in code. The user-facing word is "role", but code needs the precise word for one instance: `LoopRunner` → `RoleRunner`, `LoopState` → `RunnerState`, `loopId`/`loopIds` → `runnerId`/`runnerIds`, `loop-state.ts` → `runner-state.ts`, `loop-ids.ts` → `runner-ids.ts`, `src/loop/` → `src/runner/`, and `loop-*.ts` → `runner-*.ts`. `gui-client-loops.ts` becomes `gui-client-roles.ts`, because it renders the user-facing Roles card. "loop" meaning a JavaScript loop, the poll loop or the event loop stays. |
| tick | **run**. `tick`/`Tick` → `run`/`Run` in identifiers; `src/tick/` → `src/run/`; `tick-*.ts` → `run-*.ts`. `TickResult` → `RunResult` and `tickNumber` → `runNumber`. On a collision with an existing `run*` name, `runTick` → `runOnce` and `runTimedRoleTick` → `runTimedRoleRun`. In comments, the bare noun "run" meaning one agent invocation becomes "agent run", so "a run's agent runs" stays unambiguous. `cmdRun`/`cli-run.ts` become `cmdStart`/`cli-start.ts`. |
| landing, land, lander, vet | **merge**: `src/landing/` → `src/merge/`; `landing-*.ts` → `merge-*.ts`, except `landing-merge.ts` → `merge-to-main.ts` and `landing-vetting.ts` → `merge-verify.ts`; `lander` → `merger`; `landQueue` → `mergeQueue`; `landed` → `mergeDone`, because `merged` already names the fast-forward; `vet`/`vetting` → `verify`; `vetted` → `approved`. |
| notebook | **notes** |
| initialPrompt | **brief** |
| customLoop(s) | **customRole(s)** |
| agent (the backend selector in config, not the model doing the work) | **backend** |
| dry, telemetry (role ids, as they appear in identifiers and file names) | **dedupe**, **selfcheck**. For example, `telemetry-digest.ts` → `selfcheck-digest.ts`. |

**Kept in code** as precise internal words whose UI text changed:
- seam
- operator
- harness
- slot
- hold
- backoff
- drain
- reclaim
- director
- orchestrator

Each is listed in `docs/glossary.md`'s "In the code" section.

**How a family rename is chunked:**
- **Directory moves are their own parts.** A part moves the directory or files and updates every
  import path, with no identifier changes. Its diff is wide but one line per importer.
- **Widely used exports go through an alias.** When a symbol is used across more than one part's
  directories, the first part introduces the new name and leaves the old one as a deprecated
  alias (`/** @deprecated use RoleRunner */ export type LoopRunner = RoleRunner;`). Later parts
  migrate callers one directory at a time, and the family's last part deletes the alias.
- **Each part's tests move with it.** Test files are renamed and their identifiers updated in the
  part that touches the module they cover.
- **Each family's last part adds its retired identifiers** to the retired-names guard (see
  "Guards").

## Guards

- **Vocabulary guard** (from the first series):
  - `test/vocabulary.test.ts` uses the TypeScript compiler API to walk string literals and
    template-literal text, never `${…}` expressions. Its target is every `src/` module that
    carries a `// vocabulary: plain` header line.
  - Letters, digits and `_` count as word characters, so snake_case machine names such as
    `tick_end` are never flagged.
  - In those literals it fails on retired words, case-insensitive, word-bounded: `fleet`, `loop`,
    `tick`, `landing`, `landed`, `land queue`, `vetted`, `seam`, `notebook`, `initial prompt`,
    `harness`, `operator`, `backoff`, `backed off`, and `drain`. The role-id switch parts add
    `dry` (not `dry-run`) and `telemetry` when those ids retire.
  - A line ending in `// vocabulary-ok: <reason>` is exempt, for machine names such as the
    `tumwater(operator):` prefix or an event type string.
  - Each user-text part adds the header to the modules it converts, so coverage grows with no
    shared list to conflict over.
  - The Code names series' last part drops the header requirement and scans all of `src/`.
- **Retired-names guard** (from the Code names series): `test/retired-names.test.ts` holds the
  list of retired identifiers and file-name stems. It fails when any appears in `src/` or
  `test/`. Each family's last part appends to it.
  - Some code keeps the old names on purpose, and the guard exempts it: the event normalizer's
    legacy tables, the state loaders' legacy-key maps, the `legacyLand*` path helpers, the
    startup migrations, `CONFIG_KEY_RENAMES`, `LEGACY_ROLE_IDS`, and test fixtures that write
    old names to disk.
- **The reviewer.** After the groundwork lands, PRINCIPLES.md gains a line, which you add by hand
  (only the director and steward may edit that file): "User-visible text uses the terms in
  docs/glossary.md."

## Series and order

The series below are listed in landing order. Every part's heading names its prerequisites in the
`requires … landed` form, so the backlog holds each part until the parts it builds on have landed.

As filed on 2026-10-16 there are 116 parts. The longest prerequisite chain is 89 parts.

One small plan lands first: **Compact backlog index, part 1/1**. Every role's prompt carries a
backlog index, and listing 116 held parts one per line would grow it from about 600 to about
22,000 characters. That plan shows a series' blocked parts as one line per series instead. The
four parts with no other prerequisite (groundwork 1/4 and 2/4, commands 1/6 and 5/6) require
it.

| Series | Parts |
| --- | --- |
| Plain terms groundwork | 4 |
| Plain terms commands | 6 |
| Plain terms text | 19 |
| Plain terms docs | 5 |
| Plain terms scripting | 5 |
| Plain terms event log | 9 |
| Plain terms state | 5 |
| Plain terms role ids | 5 |
| Plain terms code team | 6 |
| Plain terms code merge | 11 |
| Plain terms code runner | 14 |
| Plain terms code run | 20 |
| Plain terms code cleanup | 7 |

1. **Plain terms groundwork:**
   - `docs/glossary.md`;
   - the vocabulary guard;
   - the shared helpers: the `feature #2` role label, the event-type display labels, and the
     role-title lookup.
2. **Plain terms commands:** the config-key aliases, `backend`, `tumwater start`,
   `tumwater history <role> <n>`, and `--result merged`.
3. **Plain terms text:** user-visible strings, one module group per part, applying "Glossary" and
   "Wording rules":
   - event messages, status and TUI table, alerts and notify, doctor, report/history/failures,
     CLI command output, help and completion;
   - the dashboard, by client module;
   - the TUI;
   - the agent prompts;
   - warning text in the deeper modules.
4. **Plain terms docs:** README, docs/*, and DEVELOPMENT.md. These parts wait for the commands
   and help-text parts.
5. **Plain terms scripting:** the `--json`, `/api` and alert-action renames from "Script
   interfaces".
6. **Plain terms event log:** the normalizer, then one event family per part, then the `source`
   field in stages.
7. **Plain terms state:** state fields, merge queue and merging.json, refs, slots purpose, and
   the `Run:` trailer.
8. **Plain terms role ids:** the alias and migration step, then the switch for `dedupe` and for
   `selfcheck`, plus the titles.
9. **Plain terms code:** by family (team, runner, run, merge, then the small families), with the
   final guard flip.

**Manual steps** (done by you, not the team):
- add the PRINCIPLES.md line once the groundwork lands;
- regenerate `docs/gui.png` once the dashboard text parts land;
- run `tumwater pause` around any part you choose to land by hand.

## Out of scope

- **History stays as written:**
  - dated reports and design records in docs/: code-metrics.md, commit-history-analysis.md, and
    feature-*.md and implementation-*.md. Each gets a one-line banner pointing to
    docs/glossary.md;
  - PLANS.md `## Done`;
  - BUGS.md;
  - QUESTIONS.md answers;
  - `plans/*.md` design docs;
  - git history and commit subjects.

  `docs/glossary.md`'s "Older names" column maps their words.
- **Unchanged names:**
  - branch names `tumwater/<id>`;
  - the `tumwater(operator):` prefix;
  - the `director` id;
  - the internal words listed under "Kept in code".
- **The project's own `tumwater.json`.** Its old keys keep working through the aliases. You
  rename them when the doctor nudge appears.
