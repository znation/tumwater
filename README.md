# tumwater

An opinionated autonomous development harness built on [pi](https://github.com/badlogic/pi-mono).
You write the initial prompt; a fleet of role-driven loops builds the project with immense effort.

![The tumwater web dashboard: the loop fleet mid-run, with live per-loop state, tick/commit/token counts, last results, the shared backlog of planned features and open bugs, the event feed, and the director prompt box](docs/gui.png)

## Initial prompt

<!-- tumwater:prompt:start -->
Idea: agentic harness

Opinionated. Built on pi. Lots of autonomous loops. You only write the markdown/initial prompt.
It builds the project with immense effort. First puts the initial prompt and project status into
README.md. Background loops are observable by gui/tui/log. GUI/TUI also gives user a main prompt.
Loop sleeps a while when the prompt results in no further changes. Starts again after a while to
see if the answer has changed due to the new state of the world. Each run attempts to find
something to do, do one thing, commit, merge to main. The find-something-to-do part is role
specific. Each loop has a role:

- Make the code more organized
- Increase unit test code coverage
- Make the code cleaner
- Make the code less repetitive
- Implement a planned feature (tracked in PLANS.md)
- Fix a bug (tracked in BUGS.md in repo)
- Plan a feature (write markdown plan, add to PLANS.md)
- Keep the README up to date
- Make an improvement to the code

Assumptions: run within a git repo dir. Each loop uses a persistent git workspace and branch.
Each loop keeps itself synced up with git main. Don't involve git remotes at all; do everything
locally and keep all project state within the git repo.
<!-- tumwater:prompt:end -->

## Status

<!-- tumwater:status:start -->
v0.1: working harness. Commands: `init`, `run`, `tui`, `gui` (`--port N`, `--all-interfaces`),
`status` (`--json`), `report` (`--days N`; `--failures` for the Markdown failure digest),
`doctor`, `logs` (`-f`, `--role <id>`, `-n N`, `--prompt`), `prompt "text"` / `--list` /
`--cancel <n>`, `reset-counters [--role <id>]`, `wake [--role <id>]`, `abort --role <id>`,
`pause` / `resume`, and `help` / `version`. All thirteen roles — `feature`, `bugfix`, `plan`,
`readme`, `organize`, `coverage`, `clean`, `dry`, `perf`, `qa`, `telemetry`, `improve`,
`steward` — plus the director are enabled by default; user-defined loops come from `customLoops`
in tumwater.json or by prompting the director.

Open items:
- Open bug: the build check's rejection headline is a node:test summary counter — two
  rejections reported as `build check failed (test): ℹ todo 0`, naming nothing (found by
  telemetry 2026-09-22).
- Open bug: one pi log per role carries two pi runs — a landing run's `session` event resets
  the turn counter the dashboard shows for the authoring tick (reported by user 2026-09-22).
- Open bug: the live-progress tail seeds from an arbitrary byte offset, so a first
  observation reports a turn count that means nothing (reported by user 2026-09-22).
- Open bug: a landing's state cell shows only elapsed time — bare `landing <elapsed>` — while
  the reviewer run behind it has the same turns/context/tool detail a working or reviewing
  loop shows (reported by user 2026-09-22).
- Open bug: a timed-out build check signals npm alone, leaking the entire test process tree
  to PID 1 (found 2026-09-21).
- Open bug: a load-sensitive live-orchestrator test falsely reddens main — the same sha
  failed and passed two minutes apart (found 2026-09-21).
- Open bug: HTTP 429 is not a transient failure class, so a rate-limit storm errors
  two-thirds of the fleet's ticks instead of retrying (found 2026-09-21).
- Open bug: the failure digest's `## Outcome by role` separator row has no cell delimiters,
  so the table never renders (found 2026-09-21).
- Open bug: the grandchild-leak fix landed its kill but not its detector — `doctor` reports
  nothing about orphaned worktree processes (found 2026-09-21).
- Open bug: the build check's 300 s timeout does not bound it — skipped checks recorded
  331–1158 s (found 2026-09-21).
- Open bug: the budget fallback has no liveness check — an unreachable free model turns the
  spend cap into an hour of 100% tick failure instead of a pause (found 2026-09-20).
- Planned: fix a failed landing build check on the spot instead of rejecting — one bounded
  model run to fix the tree and re-check before a red main rejects every queued landing
  (planned 2026-09-21, requested by user).
- Planned: portability & packaging — run an installed copy on any repo/branch with any agent
  binary (planned 2026-09-14, requested by user; the PLANS.md portability series 2/7–7/7; 1/7
  CI and npm packaging landed 2026-09-21, 4c/7 landed 2026-09-21).
- Open questions: none (this repo tracks no QUESTIONS.md; `init` seeds one for new projects).

Current main (`3557e40`): build clean, suite 1276/1276 (one timing-sensitive loop-2 retry
  test flaked once under load and passed on rerun).
<!-- tumwater:status:end -->

## How it works

`tumwater init "<prompt>"` seeds a git repo with README.md (your prompt + a status section),
PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md, and tumwater.json, and commits them — the
initial prompt is capped at 4096 chars, because it rides into every tick's prefill. `tumwater run` then starts
one loop per enabled role. Every loop tick:

1. Resets its persistent worktree (`.tumwater/worktrees/<role>`, branch `tumwater/<role>`) to main.
2. Builds a role-specific "find something to do" prompt and runs `pi --print --mode json` in the
   worktree, starting a FRESH pi session every tick: context never accumulates across ticks, so
   ticks start with a small, cheap prefill and stay far from the model's context window. Durable
   knowledge lives in the repo itself (README/PLANS/BUGS/QUESTIONS, read at the start of every tick), not
   in model context.
3. If pi changed files: commits (a reply without the SUMMARY block gets one follow-up turn in
   the same session to produce it; failing that the subject names the changed files), pins the
   sha by `refs/tumwater/landing/<role>`, and enqueues a landing in `.tumwater/land-queue/` —
   then the tick ENDS: it holds no slot through review, and the role's branch resets to main
   the moment its commit exists. Queued landings show as `· land queue: N` in the status header
   and both dashboard headers, and the landing role's row reads `landing <elapsed>`. The
   orchestrator drains the queue on a single serial landing
   slot that takes the same `maxConcurrent` permit as a role tick (at a higher-priority tier,
   so a queued landing jumps ahead of parked role waiters while authors keep ticking on the
   remaining slots) — an adversarial review gate over the full ahead-of-main
   diff, in a harness-owned worktree (`_land-<role>`) off the pinned ref: the pinned tree is
   first rebased onto main's current head (a no-op when main has not moved — a conflicting
   advance defers the rebase to the landing itself), so the gate checks what can actually land
   instead of a stale tree a sibling loop has already fixed: first a deterministic
   build pre-check (the project's declared verify script: `npm test` when declared, else
   typecheck/build; failure rejects without spending a model run), then a fresh-session
   reviewer against PRINCIPLES.md that replies `VERDICT: approve|reject` (md-only diffs are
   exempt); rejects reset the branch with reasons injected into the author's next tick,
   failures keep the commit for re-review under a 3-strike discard cap. When several landings are
   queued, the drain reviews each change individually but stacks the approved ones in one lander
   worktree, runs the declared check once over the combined tree, and fast-forwards main through
   the whole stack (`landBatchMax`, default 3, caps a batch); a red or un-assemblable stack falls
   back to one-at-a-time landings, each re-verified by its own gate. Approved work rebases
   onto main (so main's history stays linear), re-runs the declared check on the rebased tree
   when main moved under it, and fast-forwards under the merge lock — the only code that ever
   holds it, so other roles keep ticking behind an in-flight landing. A role with a queued or
   in-flight landing never starts a new tick, and `tumwater abort --role` reaches the landing
   itself (a deliberate stop discards the pin; a shutdown keeps it — every interrupted landing
   re-lands through the same gate on the next tick). The drain runs even while the fleet is
   paused: a queued landing is committed work, not a new tick. If pi found nothing to do, the
   loop backs off (exponentially, capped) and sleeps; an observer (`qa`) instead treats a
   `no_change` as a passing check and re-ticks at its interval, rotating through the documented
   flows via a gitignored coverage ledger and ending its tick with a `FLOW: <name> — passed|bug`
   line so its next tick can see what it last exercised. A failed tick retries on a
   shorter error ladder (capped at ten minutes) instead, so a broken toolchain parks a loop for
   minutes, not hours.
4. Sleeping loops wake early when main moves — the world changed, so the answer may have changed.

Scheduling is need-aware: a maintenance role's due tick (scheduled or main-moved) is deferred —
one `tick_deferred` event per episode in logs, TUI, and GUI — while its last tick did nothing
and no feature/bugfix/director/human commit has landed on main since; it starts within one poll
of such work landing. Observer roles (`qa`) are never deferred — an unmoved tree says nothing
about whether the running product has something new to report. While PLANS.md's Planned section
or BUGS.md's Open section is non-empty, idle maintenance ticks stay deferred regardless of
landings — queued feature/bugfix work outranks them until the backlog drains. Slot allocation
orders the work roles (feature, bugfix, plan) ahead of every maintenance role,
least-recently-ticked first within a tier — and the same tier order holds for ticks already
waiting on a slot across polls: a work-role tick that becomes due later jumps ahead of
maintenance ticks parked from an earlier poll (in-flight ticks always run to completion).

Two operator-visible states sit alongside scheduling. While main's build/test suite is red,
code-producing roles skip their authoring run and show a `main red` state in both dashboards
until main is green again — the director, bugfix, and the markdown-only roles keep ticking, since
bugfix can land the fix and its prompt is pointed at the failure's headline line so it fixes main
instead of hunting blind. Three consecutive error ticks on one loop raise one `warning`, and that
loop reads `failing` in both dashboards until a healthy tick.

The fleet's autonomous spend is capped by `maxDailyCostUsd` (default $50; set 0 to disable).
While the day's total cost has reached the cap, role loops stop starting new ticks — scheduled,
main-moved wakes, or startup — until local midnight or a live edit raises/disables the cap;
in-flight ticks finish and the director stays exempt (its spend still counts toward the cap).
Name a free model as `fallbackModel` and they keep working instead of stopping: at the cap every
role loop switches to that model — author runs, reviewer, conflict resolution, and any per-role
model override alike — so the day's paid work ends but the fleet does not. Only a model pi's
`models.json` prices at zero is ever engaged (an unknown id, a priced model, or a missing
definitions file is refused, and the fleet pauses as it would without one), so spend cannot climb
past the cap either way. The operator-intent sibling is `tumwater pause` / `resume`: a persistent
marker that blocks new role ticks (same wake reasons, same director exemption) until lifted, and
the GUI header's `· pause` / `· paused — resume` badge toggles that same marker in one click
(`POST /api/pause`), so an operator watching the dashboard — e.g. over `gui --all-interfaces` —
can halt the fleet without a shell. Each
gate transition lands as one `budget_paused`/`budget_fallback`/`budget_resumed` or
`fleet_paused`/`fleet_resumed` event, visible in `tumwater logs`, the TUI activity pane, and the
GUI feed.

Every tick prompt also carries the project's `PRINCIPLES.md` — its design principles, the codified
answer to "what would a senior engineer on this team always do" — so all loops share one standard of
taste. Only the director and steward roles edit that file; every other loop treats it as read-only.

The prompts are written for the fleet's real model — a mid-sized local model with thinking on
behind a large but finite window: rules are grouped, with numeric budgets
(choose the task within ~15 tool calls; check a file's size before reading it whole; read anything
over ~300 lines in ranges; the reply ends with plain text, never an announced next step). Roles with
no backlog to point at (`organize`, `clean`, `dry`, `perf`, `improve`) carry a shortlist-and-decide
search procedure — cheap signals such as recent churn, size outliers, and targeted grep, with their
own recent commits as the memory of what they already did — instead of surveying the codebase file
by file, which is what filled the window on half of all ticks before. Plans are sized to one
implementation run so the feature loop can land them whole — a plan too large for one run is
marked and handed to the plan loop to split, not split inline — and the reviewer works through a
five-point checklist and is told when the gate's deterministic pre-check already passed, so it
spends its run on what a green suite cannot show rather than re-running it.

Stopping the harness (Ctrl+C) mid-tick loses nothing: the interrupted loop's pi session and its
worktree's uncommitted edits stay in place, and on the next `tumwater run` that loop resumes the
same session (`--continue`) with a short bridge prompt and finishes the task it was on. A run the
quiet watchdog kills for lack of progress (tick result `quiet_killed`) is recovered the same way,
with the bridge prompt naming the hang instead of claiming a restart — but only up to 3
consecutive kills, after which the loop drops the starved session, raises one `warning`, reads
`failing` in both dashboards, and takes a fresh tick on the idle backoff ladder instead of
re-sending the session the backend could not schedule. A crash
(power loss, kill -9) is recovered the same way — except an interruption during the review gate,
where the work is already committed and the next launch recovers and re-reviews it via a fresh
tick instead of resuming the author session. The director is the exception: its interrupted
user prompt goes back into the inbox and runs fresh.

`npm run build` stamps `dist/build-info.json` with the commit it compiled, and the orchestrator
records that stamp in its start event and in `.tumwater/state/orchestrator.json`. When the project
being built IS tumwater (dogfood), the harness compares the stamp against main whenever main
moves: a `build_stale` event fires the first time main's `src/`, `package.json`, or
`tsconfig.json` differ from the running code, both dashboards show `STALE: main +N` in the
header, and `tumwater doctor` warns. With `autoRestart` (default true) the fleet then redeploys
itself: it verifies main is green (a green verdict seeded by the landing path — its post-rebase
check at merge time, or one run of the suite in a detached `_main` worktree), compiles main into
`.tumwater/build/<sha>` with the project's own
tsc — borrowed from the nearest ancestor install, since no worktree has one of its own — stops
starting new ticks while in-flight ones finish (role ticks up to the fleet's observed p75 tick
duration — a 30-minute cold-start fallback until enough ticks have completed — counted across the
whole hold even when main moves again meanwhile, after which they are aborted resuably; an in-flight
director tick is waited for without a cap — a human prompt outranks the redeploy), swaps the compiled tree into `dist/`, and exits so the `tumwater run` supervisor — the
process you started, which runs the orchestrator as a child — respawns it on the new code.
Completed auto-restarts are rate-limited to at most one per 12 h: inside that cooldown STALE
stays visible with a `restart BLOCKED: cooldown until …` deadline and ticks continue on the stale
build, so sustained churn cannot halt the fleet for a drain over and over. A green
verdict is reused fleet-wide; a red is provisional until two different worktrees have seen it,
because a suite can fail for reasons that belong to a worktree rather than to the tree. A red
main or a failed compile leaves the old build running until main moves again — a warning event,
and `restart BLOCKED:
<reason>` in both dashboard headers and `tumwater doctor`, so a restart that will never happen
does not look like one that is seconds away.

The director loop is special: it executes prompts you type into the TUI (or `tumwater prompt`),
queued in a file-based inbox. It always has priority — a queued prompt starts immediately,
outside the `maxConcurrent` limit and ahead of every role loop, and queued prompts run back to
back with no cooldown between them. Everything is local git; no remotes are ever touched. Runtime state
lives in `.tumwater/` (gitignored); durable state (plans, bugs, questions, principles, status, config) lives
in tracked markdown and `tumwater.json`.

## Usage

```
npm install -g tumwater    # or: npx tumwater — no checkout needed

cd your-project        # existing or new project dir
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
tumwater run          # terminal 1: the loops (Ctrl+C to stop)
tumwater tui          # terminal 2: dashboard + main prompt
tumwater gui          # or the same dashboard at http://127.0.0.1:7180 (--port N to change)
tumwater gui --all-interfaces      # serve the dashboard to the whole network (see below)
tumwater status       # one-shot table
tumwater status --json   # machine-readable fleet state (the GUI's /api/status payload minus its serverBuildSha)
tumwater report [--days N]   # Markdown usage report — tokens/ticks/commits per day (default 14 days; --days bounded to the GUI's shared 1–90 window)
tumwater report --failures [--days N]   # Markdown failure digest — tick outcomes, deltas, clustered errors, and fleet state changes (default 14 days)
tumwater doctor       # pre-flight check: node, git, repo, config, fallback model, pi, locks, build (read-only; exit 0/1)
tumwater logs -f      # follow harness events
tumwater logs --role feature   # that loop's pi transcript (also supports -f, -n N)
tumwater logs --role feature --prompt   # …and the exact prompt each run received
tumwater prompt "prefer no third-party deps"
tumwater prompt --list             # show queued prompts, numbered in execution order
tumwater prompt --cancel <n>       # remove the Nth queued prompt (as shown by --list)
tumwater reset-counters            # zero ticks/commits/tokens/cost (a running fleet picks it up within ~2s)
tumwater reset-counters --role feature   # …or just one loop
tumwater wake [--role feature]     # wake a backed-off fleet — the named roles (or all) tick within one poll
tumwater abort --role feature      # kill that loop's in-flight tick now (work discarded; the loop keeps running)
tumwater pause                     # stop role loops starting new ticks (in-flight finish; the director keeps running)
tumwater resume                    # lift a fleet pause
tumwater help                      # print the command reference
tumwater version                   # print the harness version
```

Build from source instead (or when developing tumwater itself):

```
npm install && npm run build && npm link
```

`reset-counters` starts a fresh observation window (e.g. "cost since today") without touching
scheduling, backoff, or pi session continuity — loops keep sleeping and waking exactly as before.
Its operator-side counterpart is `wake`: it touches ONLY the schedule (backoff cleared,
next run due now), so a fleet parked in backoff after a toolchain outage starts ticking
within one poll of the fix, instead of sleeping out its backoff.

Review-gate runs are labeled in loop transcripts: each role's raw log interleaves author ticks
and reviewer runs, and review runs render as `── review @ <timestamp> ──` in `tumwater logs
--role`, the TUI transcript pane, and the GUI detail panel.

`gui --all-interfaces` binds every network interface (IPv4 and IPv6) instead of localhost, and
prints the LAN URLs it is reachable at. The dashboard has **no authentication**, and its prompt
box feeds the director — anyone who can reach the port can steer the fleet and read every
transcript. Use it only on networks where that is acceptable. Its `report` tab charts usage
(served by `GET /api/report?days=N`) and its `failures` tab renders the same Markdown failure
digest as `tumwater report --failures` (served by `GET /api/failures?days=N`, the sibling
endpoint sharing the report's clamped 1–90 window; both read files directly, so they work with
no fleet running).

Roles: `feature`, `bugfix`, `plan`, `readme`, `organize`, `coverage`, `clean`, `dry`, `perf`,
`qa`, `telemetry`, `improve`, `steward`, `director`. Enable/disable them, pick pi's provider/model/thinking
level, set a per-role tick interval (by default the steward runs on a ~6 h clock, qa and telemetry
on ~2 h, readme on 30 min and plan on 1 h — the bookkeeping roles batch a burst of landings into one sync
instead of restamping after every merge), and tune backoff in
`tumwater.json`. While the harness is running, edits to `tumwater.json` are picked up
within ~2s — every setting applies live: enabling/disabling roles, per-role provider/model/
thinking/instructions, tick intervals, backoff, the `maxConcurrent` cap and `landBatchMax` batch size, `autoRestart`, and
`sessionRetentionDays` (a mid-run edit re-prunes immediately). A live edit that changes any of
these logs one `config_changed` event naming the keys that changed (the two settings with their
own, more informative events — `maxConcurrent` and `sessionRetentionDays` — keep those). A
`roles.<id>` change is named per role, never as the whole map. User-defined loops (`customLoops` entries in tumwater.json) can be added, removed, or rearranged by prompting the director ("add a loop named X that does Y") or by hand-editing the file (live within ~2 s); they act like any other loop and are marked with `*` beside their name on both dashboards.

Spend is capped by `maxDailyCostUsd` in tumwater.json (default 50; set 0 to disable): once the
day's total cost across all loops reaches it, role loops stop starting new ticks for the rest of
the local day — in-flight ticks finish and the director keeps running your prompts. The cap is
editable from both dashboards (TUI Ctrl+B on the prompt line; GUI header badge click-to-edit) —
they write tumwater.json like any other edit, so it applies live within ~2s.

`fallbackModel` (optional; `{ "provider": …, "model": …, "thinking": … }`, each field falling
back to the top-level value) names the free model the role loops switch to at the cap instead of
stopping — the budgeted model does the day's paid work, the free one keeps the fleet alive
afterwards:

```json
"provider": "<paid-provider>", "model": "<paid-model>",
"fallbackModel": { "provider": "<free-provider>", "model": "<free-model>" }
```

The switch covers every seam that could spend — author runs, the review gate, conflict
resolution, and any per-role `provider`/`model` override, which is dropped for the duration — and
only a pair pi's `models.json` prices at zero is accepted, so a typo or a priced model leaves the
fleet paused rather than quietly spending past the cap (the `budget_paused` event names the pair
it refused). The header badge reads `· budget: $10.02/$10 today · fallback: <model> (cost n/a)`
while the fallback is carrying the fleet, and the loops keep their ordinary state cells — they
are working, not stopped. The director never switches: an explicit human prompt outranks the
autonomous-spend cap. Everything is live, so crossing local midnight, raising the cap, or fixing
a mistyped fallback id takes effect within ~2s.

## Backends

tumwater runs against any OpenAI-compatible backend pi can reach: `provider`, `model`, and
`fallbackModel` in `tumwater.json` point at it, and an honest `contextWindow` in pi's model
catalog is what keeps a tick inside it. See [docs/backends.md](docs/backends.md) for what a
backend must give tumwater and a worked configuration.

## Development

```
npm test               # build + full unit suite (node:test)
npm test <filter>      # …or just the test files whose name contains <filter> (e.g. npm test merge)
```

Layout: `src/` harness code (`loop.ts` is the tick lifecycle, `orchestrator.ts` the scheduler,
`pi.ts` the pi subprocess integration, `git.ts` the git plumbing, `worktree.ts` the persistent
worktree lifecycle, `merge.ts` the
rebase/fast-forward/conflict-resolution landing flow), `src/ui/` the observer/presentation layer
(TUI, GUI dashboard, status table, transcript, and report rendering — imported only by each other
and `cli.ts`), `test/` unit tests.
Tests fake pi with a shell shim on PATH, so they run offline.
