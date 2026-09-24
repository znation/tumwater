# How tumwater works

## Setup

`tumwater init "<prompt>"` seeds a git repo with the project brief (README.md, holding your prompt
and a status section between managed markers), PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md,
and tumwater.json, and commits them. A bare `tumwater init` reads the prompt from an existing
README.md's `tumwater:prompt` markers instead. A `TUMWATER.md` with the same markers takes
precedence over README.md, so an existing project's README can stay untouched. Pointed at an
existing repo whose README.md has no markers, init adopts it: the brief goes in `TUMWATER.md`,
README.md and any existing backlog files are left byte-identical, and only the missing files are
created (`--adopt` asks for this path explicitly). `--dry-run` prints what init would create and
leave alone, then exits without writing or committing anything. init never
rewrites an existing brief: a prompt that differs from the one it carries is refused, naming the
file to edit instead. The prompt is capped at 4096 characters because it rides into every tick.

`tumwater run` then starts one loop per enabled role.

## A loop tick

1. Reset the role's persistent worktree (`.tumwater/worktrees/<role>`, branch `tumwater/<role>`)
   to main.
2. Run pi in a fresh session with a role-specific "find one thing to do" prompt. Nothing carries
   over between ticks; durable knowledge lives in the repo's markdown files.
3. If pi changed files, commit and queue the change for the landing gate, which reviews it and
   fast-forwards main. A rejection resets the branch and passes the reasons to the author's next
   tick.
4. If pi found nothing to do, back off exponentially and sleep. Sleeping loops wake early when
   main moves, since the answer may have changed.

## The landing gate

A tick ends as soon as its commit is queued. A single serial lander drains the queue, so other
loops keep ticking while a change is under review.

- **Rebase.** The change is rebased onto current main first, so the gate checks what will
  actually land.
- **Build check.** The project's declared check runs: `check.command` in tumwater.json, else
  `npm test`, else typecheck/build. A failure is re-run once; one that then passes is warned
  as a flake and proceeds. A failure that repeats is attributed through main's own verdict at
  its tip: main green (or no verdict) rejects the change with the check's output, no model run;
  main red is not the change's failure, so its pin is kept for a later re-land and the red goes
  to bugfix. Optionally, `check.gateCommand` names a cheaper check (say, only the tests a diff
  touches) that this per-change step runs instead. It is off by default. The full check then
  still runs once per landing, over the batch or the single change, and a red result there
  blocks the merge.
- **Review.** A fresh reviewer checks the diff against PRINCIPLES.md and replies
  `VERDICT: approve|reject`. Markdown-only diffs skip review. Each reviewer run is capped at
  `review.timeoutSeconds` (default 900, never above `tickTimeoutSeconds`); one that runs over
  fails without a strike and the change re-lands on the author's next tick.
- **Merge.** Approved work fast-forwards main under a merge lock, so history stays linear.
- **Batching.** When several changes are queued, each is reviewed alone, then up to
  `landBatchMax` (default 3) land together under one check. A red batch falls back to one at a
  time.

Errors keep the commit for re-review, up to three strikes. `tumwater abort --role <id>`
discards a role's in-flight landing.

## Scheduling

- `maxConcurrent` caps parallel ticks. Work roles (feature, bugfix, plan) get slots before
  maintenance roles.
- `maxConcurrentChecks` (default 2) caps how many runs of the project's check are in flight at
  once: gate, landing, batch, and main-baseline checks share it, the rest queue, and landings go
  first.
- A maintenance role whose last tick did nothing is deferred until feature, bugfix, director, or
  human work lands on main, and stays deferred while PLANS.md or BUGS.md has open work. `qa` is
  never deferred.
- The director runs your prompts immediately, outside `maxConcurrent` and ahead of every role.
- While main's build is red, code-producing roles pause authoring (`main red`) until it is green
  again. Bugfix, the director, and markdown-only roles keep going.
- Failed ticks retry on a shorter ladder, capped at ten minutes. Three failures in a row mark a
  loop `failing` until it has a healthy tick.

## Spend and pausing

- `maxDailyCostUsd` (default $50; 0 disables) stops new role ticks for the rest of the local
  day once reached. In-flight ticks finish, and the director keeps running.
- `fallbackModel` names a free model that role loops switch to at the cap instead of stopping.
  Only a model pi's `models.json` prices at zero is accepted; anything else leaves the fleet
  paused. Free is not enough either: a fallback whose backend cannot serve (three consecutive
  role ticks failing on it) is demoted to the same pause, then retried with one probe tick after
  a cool-down of 5 minutes doubling to at most 30.
- `tumwater pause` / `resume`, or the GUI's pause badge, block new role ticks until lifted.
  Queued landings still drain.

## Interruptions

Stopping the fleet mid-tick loses nothing: on the next `tumwater run`, the loop resumes its pi
session and uncommitted edits. Crashes recover the same way, and so do runs the watchdog kills for
going quiet, up to three in a row. An interrupted landing re-lands through the gate, and an
interrupted director prompt goes back to its inbox.

## Self-redeploy

When the project being built is tumwater itself, the fleet notices when main's code differs from
the running build and shows `STALE: main +N`. With `autoRestart` (default true) it confirms main
is green, compiles it, drains in-flight ticks, swaps the new build into `dist/`, and restarts, at
most once every 12 hours. A red main or failed compile keeps the old build running and shows
`restart BLOCKED: <reason>`.

## Prompts

Every tick carries PRINCIPLES.md, which only the director and steward edit. Prompts are written
for a mid-sized model with a finite context window: tool-call budgets, ranged reads of large
files, and a bundled pi extension that trims oversized tool output to its head and tail.

## Configuration

`tumwater.json` is untracked and seeded from the tracked `tumwater.example.json`; edit the example
to share a baseline with collaborators. It sets enabled roles, provider, model, and thinking level
(globally or per role), tick intervals, backoff, and the settings above. Edits apply within ~2 s
while the fleet runs, and each one logs a `config_changed` event.

- **Custom loops:** add `customLoops` entries by hand or by prompting the director ("add a loop
  named X that does Y"). They show with a `*` on both dashboards.
- **Agent binary:** resolved as `TUMWATER_PI_BIN`, then `agentBin`, then `pi` on PATH.

## Operator notes

- `reset-counters` zeroes ticks, commits, tokens, and cost without touching the schedule. `wake`
  does the opposite: it clears backoff so loops tick within one poll.
- `gui --all-interfaces` has no authentication unless you pass `--token <secret>`. Clients send the
  token as `Authorization: Bearer <token>` or `?token=`.
- The GUI's report and failures tabs match `tumwater report` and `tumwater report --failures`.
- Review runs show as `── review @ <timestamp> ──` in role transcripts.
- Runtime state lives in `.tumwater/` (gitignored). Durable state lives in tracked markdown and
  `tumwater.json`.
