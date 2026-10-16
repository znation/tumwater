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
then exits, for cron and CI and for trying one round before committing to a fleet. It exits 3
when a role that ticked ended in `error`, `review_error`, `merge_conflict`, `merge_blocked`, or
`main_red`, so a failing round is distinguishable from a quiet one.

## A loop tick

1. Lease a worktree slot from the shared pool (`.tumwater/worktrees/_slot-<n>`; `worktreeSlots`
   of them, default `maxConcurrent` + 1). The role's persistent branch `tumwater/<role>` is
   checked out as-is when present, so its unlanded commit survives, and created from main
   otherwise. The director instead keeps its own `.tumwater/worktrees/director`.
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
  touches) that this per-change step runs instead. It is off by default; tumwater's own fleet
  sets it to `npm run test:gate`. The full check then still runs once per landing, over the batch
  or the single change, and a red result there blocks the merge. `check.timeoutSeconds` (default
  300) bounds every check, the detected `npm test` included.
- **Review.** A fresh reviewer checks the diff against PRINCIPLES.md and replies
  `VERDICT: approve|reject`. Markdown-only diffs skip review, but the gate first rejects, md-only diffs included, an edit to the initial prompt block or to PRINCIPLES.md from any role but the director and steward, and a change that newly writes a secret environment variable's value, or a credential pi stores in `auth.json`/`models.json`, into a file (INV-G2). Each reviewer run is capped at
  `review.timeoutSeconds` (default 900, never above `tickTimeoutSeconds`; at least 3600 while
  the budget fallback carries the fleet, since a slower free model needs as many turns); a
  reviewer still making progress at that deadline gets one extension of the same length before
  it is killed. One that runs over fails without a strike and the change re-lands on the
  author's next tick. An approval is keyed by the
  diff's patch-id, so an approved change re-landed after a clean rebase is not reviewed again;
  its build check still runs.
- **Merge.** Approved work fast-forwards main under a merge lock, so history stays linear. If
  main moved since the vet's check, the rebased tree is checked again inside the lock, unless it
  differs from the checked one only in review-exempt paths: doc commits on main don't trigger a
  full re-run. Main's own verdict carries over doc-only commits the same way, so the red-main
  check and the self-redeploy's green check run the suite once per code change, not once per
  doc landing. Attributing a red check to a change still runs main's suite for real. The
  merge-side steps (a stack and its bisect, the conflict resolver, the post-resolve re-review)
  run in one dedicated `_merge` checkout, reserved outside the pool so a vet waiting for a slot
  can never deadlock behind the merge lock.
- **Batching.** When several changes are queued, each is reviewed alone, then up to
  `landBatchMax` (default 3) land together under one check. A red batch lands its longest
  passing prefix and checks the rest again. A change that is red on its own is rejected, unless
  main is red too, in which case its pin is kept for later.
- **Parallel vetting.** Each queued change is rebased, checked and reviewed in a slot leased
  from the shared worktree pool (`.tumwater/worktrees/_slot-<n>`; the pool holds `worktreeSlots`
  checkouts, default `maxConcurrent` + 1), several at once. A vet counts as active work: it
  holds one of the `maxConcurrent` permits role ticks use, ahead of any waiting tick, so
  landings never add streams to the provider beyond `maxConcurrent` plus the director. Vets take
  at most `maxConcurrent` − 1 of those permits (at least one), so a deep queue always leaves one
  for authoring. A change that
  fails vetting frees its author at once, and the merge step lands vetted changes in queue
  order, up to `landBatchMax` per stack, without waiting on a slower review ahead of them. A
  vetted change whose base moved is checked again before it lands; a change whose landing check
  fails twice is judged by main's own check, like a red gate check.

Errors keep the commit for re-review, up to three strikes. `tumwater abort --role <id>`
discards a role's in-flight landing.

## Scheduling

- **Worktree pool.** Ticks and landing vets share `worktreeSlots` pooled checkouts
  (`.tumwater/worktrees/_slot-<n>`, default `maxConcurrent` + 1): each is leased for one run,
  reset to that run's commit, and released back. A role whose tick is resumable keeps its slot
  pinned so the resumed session runs in the same directory; a lease that waits 30 s or more
  logs a `slot_wait` event so `worktreeSlots` can be sized from real contention; `tumwater doctor`'s "worktree pool" row sums the last 24 h of those waits and warns once they total 10 minutes, naming the number to raise `worktreeSlots` above. Outside the
  pool sit the director's own `.tumwater/worktrees/director`, the merge drain's `_merge`, the
  review gate's `_gate-main`, and the redeploy mirror and witness (`_main`, `_build`). Size the
  disk for about `worktreeSlots` + 3 warm checkouts of the project.
- **Parallel work instances.** `roles.feature.instances` and `roles.bugfix.instances` (1–8)
  run that many loop ids — `feature`, `feature-2`, … — each with its own branch and state. The
  serial scheduler assigns each due instance one eligible backlog entry and holds the claim
  until the entry lands, the instance gives it up, or it sits idle past 24 h; two instances
  never work the same entry. An extra instance with no unclaimed eligible entry is skipped
  without climbing its backoff (the scaling rule). A feature runner, primary included, skips
  its scheduled and main-moved ticks while no plan is eligible at all, so an operator wake, a
  queued prompt or a resume still runs; a `run --once` round settles a skipped runner as
  `no free entry`. A bugfix runner does the same while BUGS.md has open bugs but none is
  eligible (with no open bugs at all it keeps searching for latent bugs). The plan loop keeps
  `instances(feature) + 1` eligible plans ahead so every feature instance has something to
  take (a due plan tick defers while that many are waiting and none is marked needs-review or
  needs-replan). `tumwater status`, the TUI and the dashboard name each instance's claimed entry while
  it is idle or landing, `tumwater logs` renders the `claim` assigned/released events, and
  `tumwater doctor`'s `work instances` check warns on a claim whose entry is gone or stale.
- `maxConcurrent` caps parallel ticks and landing vets together. Landings get slots first, then
  work roles (feature, bugfix, plan), then maintenance roles.
- `maxConcurrentPerProvider` (optional) caps how many of those runs each model provider serves
  at once, beside the fleet total: a run starts only when BOTH its provider and the fleet have
  headroom, and a full provider never holds back a run on another (plans/provider-concurrency.md
  §1). A role tick's key is the provider its authoring seam resolves to (a claude seam's own id,
  else the pi provider, or pi's saved default for a seam that names no model).
- `maxConcurrentChecks` (default 2) caps how many runs of the project's check are in flight at
  once: gate, landing, batch, and main-baseline checks share it, the rest queue, and landings go
  first.
- A maintenance role whose last tick did nothing is deferred until feature, bugfix, director, or
  human work lands on main, and stays deferred while PLANS.md or BUGS.md has work a feature or bugfix runner can take (refused, needs-review/replan and blocked entries do not count). `qa` is
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
  Before that, the loop logs one `role_cap_warning` event when its own spend crosses the same
  fixed 80% while it is still ticking — re-armed when spend falls back below — so a configured
  notify command can page the operator while there is still room to raise the cap.
- `fallback` names a free model that role loops switch to at the cap instead of stopping (the
  legacy `fallbackModel` object still parses). Each seam runs its tier's resolved fallback: the
  tier's own entry, else the nearest other tier's own fallback (small → default → strong;
  default → strong → small; strong → default and never small — a weak reviewer costs more than
  a paused one). Only a model pi's `models.json` prices at zero is accepted; anything else
  leaves the fleet paused. Free is not enough either: a fallback whose backend cannot serve
  (three consecutive
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
- `worktreeIdleReclaimHours` (default 24; 0 disables) is how long a worktree may sit unused
  before an hourly idle pass deletes its gitignored build outputs whatever the free space,
  catching paused, retired, and rarely due roles. A worktree already reclaimed since its last
  use is skipped, and one with a pending resume is never idle-reclaimed. `tumwater reclaim`
  runs one manual pass over every candidate: with a live fleet it drops a marker the
  orchestrator consumes within a poll, and with none running it cleans in-process; `--dry-run`
  lists each candidate with its idle age and ignored-path count and cleans nothing.
- `tumwater pause` / `resume`, or the dashboard's Pause control (which also offers timed
  pauses), block new role ticks until lifted.
  Queued landings still drain. Both accept `--role <id>` to gate a single loop instead of the
  fleet: in-flight ticks finish, every other role keeps ticking, and the director is not
  exempt — its queued prompts simply wait in the inbox. `pause --for <duration>` (e.g. `2h`)
  lifts itself when the deadline passes, so a quieted fleet resumes without an operator. A
  fleet pause may carry `--reason <text>` — the why behind the pause, surfaced on `status`,
  the TUI, and the dashboard (a per-role pause carries no reason). The dashboard's per-loop
  pause button also offers timed pauses (the same choices as the fleet menu, matching
  `pause --role <id> --for`), and a timed role pause shows its auto-resume countdown on the
  loop's row and drawer.
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
than a recurring search, has no notebook. The operator can clear or replace a note with
`tumwater role <id> --clear-notes` or `--notes-file <path>`; a tick running at that moment may
still overwrite it through its own `role_notes` call.

## Configuration

`tumwater.json` is untracked and seeded from the tracked `tumwater.example.json`; edit the example
to share a baseline with collaborators. It sets enabled roles, provider, model, and thinking level
(globally or per role), tick intervals, backoff, and the settings above. Edits apply within ~2 s
while the fleet runs, and each one logs a `config_changed` event. From the terminal,
`tumwater config get <key>` reads one resolved value, `tumwater config set <key> <value>`
writes one, and `tumwater config unset <key>` removes one (the inverse of `set`, so a value
reverts to its default or disappears from its map or section) — all through the same lock,
validation, and atomic write, so an operator never has to hand-edit the file.

- **Custom loops:** add `customLoops` entries by hand or by prompting the director ("add a loop
  named X that does Y"). The TUI marks them with `*`, the web dashboard with a `custom` tag.
- **Agent binary:** each backend resolves its own: `TUMWATER_<ID>_BIN`, then `agents.<id>.bin`
  (pi also reads the legacy top-level `agentBin`), then the backend's default binary (`pi` or
  `claude`) on PATH.

## Operator notes

- `reset-counters` zeroes ticks, commits, tokens, and cost without touching the schedule (the dashboard's Loops card and loop drawer reach the same reset). `wake`
  does the opposite: it clears backoff so loops tick within one poll.
- `gui --all-interfaces` has no authentication unless you pass `--token <secret>`. Clients send the
  token as `Authorization: Bearer <token>` or `?token=`.
- The web dashboard opens on Fleet: alerts for whatever needs you (a failing or stuck loop, a red
  main, a spent budget, an old build, open questions, a pause), the prompt box (a prompt can be
  deferred by a duration — the same grammar and `tumwater:not-before` marker `tumwater prompt
  --at` uses), today's progress,
  the loops grouped by what they are doing, the backlog, and the notable activity — a Loop picker
  and a case-insensitive Search box narrow the events the card carries, and an active Loop or
  Search filter also searches the log's recent slice through `/api/logs` (well past the events a
  status poll carries), persisted like the Notable/All choice. A new
  needs-you alert also plays a short Web Audio cue, with a sidebar speaker toggle persisted
  across reloads; the Queued tab lists each queued prompt and how long it has waited, and each
  row can be edited in place — Edit loads the prompt's body, Save replaces it through the same
  path `tumwater prompt --edit` uses; an open question's Answer button opens its drawer, whose
  Record answer form writes the decision to QUESTIONS.md as `tumwater questions answer` does.
  Clicking a loop
  opens its details — its notebook and next tick's prompt included — and its live transcript
  (`#loop/<name>` links straight to it). Its History, Usage,
  Failures, and Pending views match `tumwater history`, `tumwater report`, `tumwater report
  --failures`, and `tumwater diff`; the Pending view also paints the land queue as a card
  mirroring `tumwater queue`, and shows a loop's full unlanded patch in its drawer.
  Its Settings view shows the curated top-level config keys (provider, model, fallback, the daily
  spend cap, quiet hours, the notify hook) with inline Save and Clear buttons: Save writes
  through the same path `tumwater config set` uses, and Clear retracts through the same path
  `tumwater config unset` uses, so the field reverts to the key's default (unsetting the daily
  spend cap restores the default 50). The view also runs `tumwater doctor`'s checks on each open
  in a Health check card, with a Re-run button.
- The TUI shows the same alerts under its header, and names its views the same way; `Ctrl+T`
  cycles Activity, each loop's Transcript, Backlog, Usage, Failures, History, Pending,
  Queued, Health (the same checks `tumwater doctor` prints, re-run on each entry), and Brief (the initial prompt `tumwater brief` prints, read-only). Activity keeps the live tail and `PgUp`/`PgDn` page it back through a fixed 200-event
  tail, the bottom of the page resuming the live tail; `Ctrl+G` scopes the feed to the fleet or
  one raw roster id (the same exact-loop slots History uses) and `/` on an empty prompt line
  opens a free-text search over the same loaded tail. Both filters match through the rules
  `tumwater logs --grep` and the dashboard Activity view use — `eventRole` for the loop and
  `eventMatchesGrep`'s case-insensitive type-plus-rendered-line haystack for the text — and the
  hint line names the active scope and pattern.
  On History, `Ctrl+S` cycles the pane's trailing window (default, 1h, 6h, 1d, 7d) through the
  same collector and sparse-window note `tumwater history --since` uses.
  `Ctrl+O` cycles the pane's outcome filter (all, changes, none, problems) through the same
  `historyClass` buckets and an emptied filter's `no ticks with result "<class>"` wording
  `tumwater history --result` uses, with the hint line naming the active class (`result: all` or
  `result: <class>`).
  `Ctrl+G` cycles the pane's exact-loop scope through the fleet and each raw roster id — an
  instance id is its own slot, the same scope `tumwater history --role` and the dashboard picker
  take; the hint line names it (`scope: fleet` or `scope: <id>`) and a scoped pane prefixes its
  body with `role: <id>`.
  `/` on the History pane with an empty prompt line opens a free-text search; Enter filters the
  rows through the same `tickRowGrepHaystack` haystack and case-insensitive substring rule
  `tumwater history --grep` and the dashboard's History search use, the pane's `search:` header
  and the hint line name the active pattern, and Esc cancels.
  `Ctrl+N` swaps the pane for the newest completed tick's full event trail — the loop's newest
  when `Ctrl+G` scopes the pane, else the fleet's — rendered from the same
  `readTickDetail`/`renderTickDetail` pair `tumwater tick --last` and the dashboard's History
  drill-down use, then the tick commit's per-file stat footer (`tumwater tick --stat`'s text, loaded
  async so the trail shows at once); the tab strip reads `Tick` and `Ctrl+N` again returns to the rows.
  The Pending pane shows the durable land queue above the pending-change roster, reading and
  rendering it through the same `readLandingQueue`/`renderLandingQueue` pair `tumwater queue`
  prints, so the queue's order, age, skips, and wording match the CLI — including the bracketed
  landing label (`[landing 2m · reviewing]`, `[vetted, awaiting merge]`) on an entry a running fleet is landing.
  The Queued pane lists every loop's queued prompts, reading through the same queue traversal
  and renderer `tumwater prompt --list` uses, so the two surfaces cannot drift on order,
  per-loop numbering, or the queued-age/deferred-countdown suffix. Up/Down select a queued
  prompt and show its full text under a header naming its loop and position, `Ctrl+X`
  cancels the selected one through the same per-role `cancelRolePrompt` path
  `tumwater prompt --cancel` uses, and `Ctrl+E` rewrites the selected one in place through the
  same `readQueuedPromptBody`/`editQueuedFile` pair the dashboard's Queued tab Edit uses
  (`tumwater prompt --edit` at the CLI), carrying the entry's position, enqueue stamp,
  deferral marker, and attached images over the rewrite; Esc returns to the list.
  `Ctrl+F` on an unpaused fleet opens a one-line pause editor (`[duration] [reason]`, e.g.
  `2h deploy freeze`; empty pauses until resumed; Enter pauses, Esc cancels) and on a paused
  fleet resumes at once, through the same marker `tumwater pause --for/--reason`/`resume`
  write: loops start no new ticks, in-flight ticks finish, and the director still runs your
  prompts — so an operator watching the terminal can hold or release the fleet without a
  second terminal. `Ctrl+Q` (quit later) opens a duration editor (`2h`; empty is refused, so the
  key never means "stop now") that schedules a graceful fleet stop through the marker
  `tumwater stop --in` writes, and cancels the pending stop at once when one is scheduled. On the Usage and Failures panes, `Ctrl+G` cycles the base-role report scope
  through the fleet and each base role, the same scope `tumwater report --role` and the
  dashboard's Usage/Failures views take; the tab strip names it (`Usage: <role>`) and the hint
  line shows the current scope (`scope: fleet` or `scope: <role>`). `Ctrl+E` cycles a session-only
  trailing window for the Usage and Failures panes (default, 1h, 6h, 1d, 7d) through the same
  collectors `tumwater report --since` and `tumwater report --failures --since` use, with the
  hint line naming it (`window: default` or `window: <window>`).
- In the TUI, viewing a loop's transcript puts that loop's controls on the hint line: `Ctrl+P`
  on an unpaused loop opens a duration editor (empty pauses until resumed, Esc cancels) that
  writes the same `pauseRole` marker `tumwater pause --role --for` does — the deadline is the
  paused-roles marker's one shared field, as with the CLI — and on a paused loop resumes it at
  once, `Ctrl+A` aborts its in-flight tick, `Ctrl+W` opens a wake editor (empty
  wakes it now, a duration like `2h` schedules the wake, `cancel` drops its scheduled wakes), `Ctrl+N` cycles the pane live transcript → notebook → change and back: the
  notebook step shows the loop's notebook and next tick's assembled prompt, and `Ctrl+X` pressed twice there clears the notebook (as `tumwater role <id> --clear-notes` does)
  (the same two things the dashboard drawer shows; the tab strip reads Notebook and PgUp/PgDn
  page it), and the change step is the loop's collected unlanded work — branch, commits ahead
  of main, the ahead-of-main patch, and its dirty files and uncommitted patch — the same
  `collectRoleChange`/`renderRoleChange` view `tumwater diff --role <id>` prints and the
  dashboard drawer's Pending change section shows (the tab strip reads Change, and the pane
  says `(loading pending change…)` until the collector resolves), and `Ctrl+R` opens the
  role-prompt editor that queues a prompt for that loop's
  next tick (Enter sends it; Esc or `Ctrl+R` again cancels and restores the draft). The prompt
  line names who Enter sends to, and Up/Down recall this session's submitted prompts — director
  and role alike — readline-style, with a half-typed draft saved and restored around the walk;
  the editor also takes readline's kill keys — `Alt+Backspace` kills the word before the cursor,
  `Ctrl+U` from the line start, `Ctrl+K` to the line end. Each keypress flashes its outcome for
  a few seconds.
  `Ctrl+L` opens a fourth prompt-line editor for the next prompt's defer delay: type a duration
  (`45m`, `1h30m`, `2d`) and Enter stores it, an empty Enter clears it, and Esc cancels the edit;
  a pending delay rides into the next director or role prompt as the same `tumwater:not-before`
  marker `tumwater prompt --at`, the prompt
  target names it (`director (defer 45m) › `), and a successful submit clears it (one-shot).
- Review runs show as `── review @ <timestamp> ──` in role transcripts.
- Runtime state lives in `.tumwater/` (gitignored). Durable state lives in tracked markdown and
  `tumwater.json`.
