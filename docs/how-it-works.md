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

`tumwater run` then starts one loop per enabled role. `tumwater run --once` runs one full
round — every enabled role ticks at most once, every landing that round produced merges — and
then exits, for cron and CI and for trying one round before committing to a fleet.

## A loop tick

1. Reset the role's persistent worktree (`.tumwater/worktrees/<role>`, branch `tumwater/<role>`)
   to main.
2. Run pi in a fresh session with a role-specific "find one thing to do" prompt. Nothing carries
   over between ticks except the role's own notebook (see Prompts); durable knowledge lives in
   the repo's markdown files.
3. If pi changed files, commit and queue the change for the landing gate, which reviews it and
   fast-forwards main. A rejection resets the branch and passes the reasons to the author's next
   tick.
4. If pi found nothing to do, back off exponentially and sleep. Sleeping loops wake early when
   main moves, since the answer may have changed.

## The landing gate

A tick ends as soon as its commit is queued. Queued changes are vetted in parallel and one serial
merge step lands them, so other loops keep ticking while a change is under review.

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
  `review.timeoutSeconds` (default 900, never above `tickTimeoutSeconds`; at least 3600 while
  the budget fallback carries the fleet, since a slower free model needs as many turns); a
  reviewer still making progress at that deadline gets one extension of the same length before
  it is killed. One that runs over fails without a strike and the change re-lands on the
  author's next tick. An approval is keyed by the
  diff's patch-id, so an approved change re-landed after a clean rebase is not reviewed again;
  its build check still runs.
- **Merge.** Approved work fast-forwards main under a merge lock, so history stays linear.
- **Batching.** When several changes are queued, each is reviewed alone, then up to
  `landBatchMax` (default 3) land together under one check. A red batch lands its longest
  passing prefix and checks the rest again. A change that is red on its own is rejected, unless
  main is red too, in which case its pin is kept for later.
- **Parallel vetting.** Each queued change is rebased, checked and reviewed in its own lander
  worktree, several at once. A vet counts as active work: it holds one of the `maxConcurrent`
  slots role ticks use, ahead of any waiting tick, so landings never add streams to the
  provider beyond `maxConcurrent` plus the director. Vets take at most `maxConcurrent` − 1 of
  those slots (at least one), so a deep queue always leaves one for authoring. A change that
  fails vetting frees its author at once, and the merge step lands vetted changes in queue
  order, up to `landBatchMax` per stack, without waiting on a slower review ahead of them. A
  vetted change whose base moved is checked again before it lands; a change whose landing check
  fails twice is judged by main's own check, like a red gate check.

Errors keep the commit for re-review, up to three strikes. `tumwater abort --role <id>`
discards a role's in-flight landing.

## Scheduling

- `maxConcurrent` caps parallel ticks and landing vets together. Landings get slots first, then
  work roles (feature, bugfix, plan), then maintenance roles.
- `maxConcurrentChecks` (default 2) caps how many runs of the project's check are in flight at
  once: gate, landing, batch, and main-baseline checks share it, the rest queue, and landings go
  first.
- A maintenance role whose last tick did nothing is deferred until feature, bugfix, director, or
  human work lands on main, and stays deferred while PLANS.md or BUGS.md has open work. `qa` is
  never deferred. `bugfix` is not a maintenance role, but while BUGS.md has no open bugs it has
  nothing assigned and defers like one — with the difference that any feature/bugfix/director/
  human landing wakes it (a deferral only holds while no qualifying work has landed), and that
  one open bug puts it back on the every-wake schedule.
- The director runs your prompts immediately, outside `maxConcurrent` and ahead of every role.
- `tumwater prompt --role <id>` queues a prompt for one loop's next tick instead of the
  director's inbox, and wakes it. `--list` shows the queues grouped by loop; per-role prompts
  wait behind a paused loop like the director's wait behind a fleet pause.
- While main's build is red, code-producing roles pause authoring (`main red`) until it is green
  again. Bugfix, the director, and markdown-only roles keep going.
- Failed ticks retry on a shorter ladder, capped at ten minutes. Three failures in a row mark a
  loop `failing` until it has a healthy tick.
- A search role's own recent yield stretches its clock: after ten consecutive counted ticks
  that landed nothing, its minimum gap doubles, and doubles again per five further empty
  ticks up to ×8 — and the stretched gap gates the "main moved" wake too, so a quiet role
  stops re-checking on every landing. One landing in the last ten counted ticks restores the
  plain gap. Failed ticks (errors, aborts, quiet kills) count as neither. `tumwater status`
  shows the stretch as `×N` beside the next-run time; feature, plan, and the director are
  never scaled, and a wake or queued prompt bypasses it.

## Spend and pausing

- `maxDailyCostUsd` (default $50; 0 disables) stops new role ticks for the rest of the local
  day once reached. In-flight ticks finish, and the director keeps running. Before that, the
  fleet logs one `budget_warning` event when spend crosses a fixed 80% of the cap while the
  gate is still open — re-armed when spend falls back below (a new day, a raised cap) — so a
  configured notify command can page the operator while there is still room to act.
- `maxDailyCostUsdPerRole` (optional map of role id to USD; 0 disables that role's cap) bounds
  one role's own daily spend the way `maxDailyCostUsd` bounds the fleet's: a loop that has
  reached its cap starts no new ticks until the next local day or a live edit raises/removes
  the cap. In-flight ticks finish and the director is exempt; a per-role cap never engages the
  fallback, and the other roles, the fleet-wide cap, and its fallback demotion are untouched.
- `fallback` names a free model that role loops switch to at the cap instead of stopping (the
  legacy `fallbackModel` object still parses). Each seam runs its tier's resolved fallback: the
  tier's own entry, else the nearest other tier's own fallback (small → default → strong;
  default → strong → small; strong → default and never small — a weak reviewer costs more than
  a paused one). Only a model pi's `models.json` prices at zero is accepted; anything else
  leaves the fleet paused. Free is not enough either: a fallback whose backend cannot serve (three consecutive
  role ticks failing on it) is demoted to the same pause, then retried with one probe tick after
  a cool-down of 5 minutes doubling to at most 30. When the gate reopens (the cap raised, or a
  new local day), a tick that started on the fallback is handed back to the primary: it is
  interrupted resumably — session and worktree edits kept — and its next tick continues the
  same session on the budgeted model (`budget_handback` in the feed).
- Model failure fallback is separate from the budget gate above, triggered by health rather
  than spend: when one role's ticks fail with provider-class errors (429s, and connection,
  timeout, server, model-load, and stream-severed backend failures) three times in a row, its
  next ticks run on its tier's resolved `fallback` pair while the primary is probed. Once the
  5-minute cooldown elapses, the next tick runs the primary as the probe — a real tick, not a
  separate canary request — and an answering probe returns the role to the primary. The episode
  is per role and never moves the director; `tumwater status`, the TUI, the dashboard, and
  `tumwater role <id>` name the off-model pair, its start, and the tripping reason.
- `quietHours` (default off; absent or empty) is a daily local-time window, `"HH:MM-HH:MM"`,
  during which role loops start no new ticks — a tick due inside the window starts at window
  end, and a window may wrap midnight (`"23:00-07:00"`). The director is exempt, exactly as
  under the budget gate and the operator pause. Edits apply live, and each crossing into or
  out of the window logs one `quiet_hours_started` / `quiet_hours_ended` event in the feed.
- `diskHoldGB` (default 10; 0 disables) is the free-space floor, in GB (10^9 bytes), for the
  volume holding `.tumwater/worktrees`. When free space drops below it, no new work starts —
  role ticks, the director, landing vets and merges — until free space climbs 5 GB back above
  the floor (the hysteresis that keeps a fleet at the line from flapping). In-flight work runs
  on. A live edit applies on the next poll (including editing to 0, which lifts an active
  hold), each crossing logs one `disk_low` / `disk_ok` event (and `disk_low` pages a configured
  `notify` command), and `tumwater doctor` fails below the floor, passes above it, and warns
  when the volume cannot be measured.
- `diskReclaimGB` (default 40; 0 disables) is the pressure-reclaim threshold, in GB (10^9
  bytes). Below it, one background pass deletes the files git ignores (`git clean -fdX`) in
  idle harness worktrees, least recently used first, so build outputs of any ecosystem
  (`target/`, `node_modules/`, `dist/`, `.venv/`) are freed before the hold engages; a
  worktree in use is never cleaned, and one the registry has never seen counts as used at
  first sight. A pass that cleaned anything logs one `disk_reclaim` event. The hold waits for
  the pass to settle, and with `diskReclaimGB` 0 it engages immediately. It must be at least
  `diskHoldGB` unless it is 0. `tumwater doctor` warns between the hold floor and this
  threshold.
- `tumwater pause` / `resume`, or the dashboard's Pause control (which also offers timed pauses), block new role ticks until lifted.
  Queued landings still drain. Both accept `--role <id>` to gate a single loop instead of the
  fleet: in-flight ticks finish, every other role keeps ticking, and the director is not
  exempt — its queued prompts simply wait in the inbox. `pause --for <duration>` (e.g. `2h`)
  lifts itself when the deadline passes, so a quieted fleet resumes without an operator. A
  fleet pause may carry `--reason <text>` — the why behind the pause, surfaced on `status`,
  the TUI, and the dashboard (a per-role pause carries no reason).
- The error-streak circuit breaker acts on the same evidence the per-role warning uses: after
  10 consecutive failed ticks a role is paused through the same per-role marker (a
  `role_streak_paused` event names the streak and the cause), so a loop failing on its own
  cause stops burning slots until `tumwater resume --role <id>` lifts it; the director
  included.

## Interruptions

Stopping the fleet mid-tick loses nothing: on the next `tumwater run`, the loop resumes its pi
session and uncommitted edits. `tumwater stop` is the graceful path — it signals the orchestrator,
lets in-flight ticks finish and land, then exits. The orchestrator also runs the same graceful
stop if its supervisor dies without forwarding a signal (a `kill -9` or OOM kill), so a dead
supervisor takes the fleet down instead of leaving it orphaned and ticking unattended. Crashes
recover the same way, and so do runs the
watchdog kills for
going quiet, up to three in a row. An interrupted landing re-lands through the gate, and an
interrupted director prompt goes back to its inbox. A commit left unlanded (a landing error that
kept it, or a crash before it was queued) goes back on the land queue at the role's next tick,
which ends there instead of authoring, so the one merge step stays main's only writer. A commit
whose last three landings all hit merge conflicts that conflict resolution could not settle is
dropped instead, and the role's next prompt says so.

## Self-redeploy

When the project being built is tumwater itself, the fleet notices when main's code differs from
the running build and shows `STALE: main +N`. With `autoRestart` (default true) it confirms main
is green, compiles it, drains in-flight ticks, swaps the new build into `dist/`, and restarts, at
most once every 12 hours. A red main or failed compile keeps the old build running and shows
`restart BLOCKED: <reason>`. An operator watching a stale build does not have to wait out the
12-hour clock: the dashboard's stale-build alert has a refresh button that waives the cooldown
and starts the pending episode immediately — every other gate (a green main, a successful
compile, in-flight ticks draining) still applies.

`tumwater tui` and `tumwater gui` follow the swap: each re-execs onto the new `dist/` within a
second, and only onto a build stamped with a real commit of the repo. Because the fleet executes
its checkout's own `dist/`, `npm test` refuses to run in that checkout while the fleet is up (the
suite's first steps recompile and restamp `dist/`), so run suites in a worktree.

## Prompts

Every tick carries PRINCIPLES.md, which only the director and steward edit. Prompts are written
for a mid-sized model with a finite context window: tool-call budgets, ranged reads of large
files, and a bundled pi extension that trims oversized tool output to its head and tail.

Each role also has a notebook: a short, model-written note its own earlier ticks left for the
next fresh session (where things live, what was ruled out, what to look at next). It lives at
`.tumwater/state/notes/<role>.md`, is capped at 4 KB, and is the only state carried between a
role's ticks besides the repo itself. A tick sees the note when one exists and may replace it
with the bundled `role_notes` tool; the director, whose work is the operator's prompt rather
than a recurring search, has no notebook.

## Configuration

`tumwater.json` is untracked and seeded from the tracked `tumwater.example.json`; edit the example
to share a baseline with collaborators. It sets enabled roles, provider, model, and thinking level
(globally or per role), tick intervals, backoff, and the settings above. Edits apply within ~2 s
while the fleet runs, and each one logs a `config_changed` event.

- **Custom loops:** add `customLoops` entries by hand or by prompting the director ("add a loop
  named X that does Y"). The TUI marks them with `*`, the web dashboard with a `custom` tag.
- **Agent binary:** resolved as `TUMWATER_PI_BIN`, then `agentBin`, then `pi` on PATH.

## Operator notes

- `reset-counters` zeroes ticks, commits, tokens, and cost without touching the schedule. `wake`
  does the opposite: it clears backoff so loops tick within one poll.
- `gui --all-interfaces` has no authentication unless you pass `--token <secret>`. Clients send the
  token as `Authorization: Bearer <token>` or `?token=`.
- The web dashboard opens on Fleet: alerts for whatever needs you (a failing or stuck loop, a red
  main, a spent budget, an old build, open questions, a pause), the prompt box, today's progress,
  the loops grouped by what they are doing, the backlog, and the notable activity. A new
  needs-you alert also plays a short Web Audio cue, with a sidebar speaker toggle persisted
  across reloads; the Queued tab lists each queued prompt and how long it has waited. Clicking a loop
  opens its details and live transcript (`#loop/<name>` links straight to it). Its History, Usage,
  Failures, and Pending views match `tumwater history`, `tumwater report`, `tumwater report
  --failures`, and `tumwater diff`; the Pending view also shows a loop's full unlanded patch in
  its drawer.
  Its Settings view shows the curated top-level config keys (provider, model, fallback, the daily
  spend cap, quiet hours, the notify hook) with inline Save buttons that write through the same
  path `tumwater config set` uses.
- The TUI shows the same alerts under its header, and names its views the same way; `Ctrl+T`
  cycles Activity, each loop's Transcript, Backlog, Usage, and Failures.
- In the TUI, viewing a loop's transcript puts that loop's controls on the hint line: `Ctrl+P`
  toggles its pause, `Ctrl+A` aborts its in-flight tick, `Ctrl+W` clears
  its backoff, and `Ctrl+R` opens the role-prompt editor that queues a prompt for that loop's
  next tick (Enter sends it; Esc or `Ctrl+R` again cancels and restores the draft). The prompt
  line names who Enter sends to, and Up/Down recall this session's submitted prompts — director
  and role alike — readline-style, with a half-typed draft saved and restored around the walk;
  the editor also takes readline's kill keys — `Alt+Backspace` kills the word before the cursor,
  `Ctrl+U` from the line start, `Ctrl+K` to the line end. Each keypress flashes its outcome for
  a few seconds.
- Review runs show as `── review @ <timestamp> ──` in role transcripts.
- Runtime state lives in `.tumwater/` (gitignored). Durable state lives in tracked markdown and
  `tumwater.json`.
