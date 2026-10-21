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
file to edit instead. The prompt is capped at 4096 characters because it rides into every run.

`tumwater start` then starts every enabled role. `tumwater start --once` runs one full
round — every enabled role runs at most once, every commit that round produced merges — and
then exits, for cron and CI and for trying one round before committing to a team. It exits 3
when a role that ran ended in `error`, `review_error`, `merge_conflict`, `merge_blocked`, or
`main_red`, so a failing round is distinguishable from a quiet one. `--for <duration>` runs the
team for that long and then stops it.

## A run

1. Lease a workspace from the shared pool (`.tumwater/worktrees/_slot-<n>`; `worktreeSlots`
   of them, default `maxConcurrent` + 1). The role's persistent branch `tumwater/<role>` is
   checked out as-is when present, so its unmerged commit survives, and created from main
   otherwise. The director instead keeps its own `.tumwater/worktrees/director`.
2. Run pi in a fresh session with a role-specific "find one thing to do" prompt. Nothing carries
   over between runs except the role's own notes (see Prompts); durable knowledge lives in
   the repo's markdown files.
3. If pi changed files, commit and put the change in the merge queue, where the merge pipeline
   reviews it and fast-forwards main. A rejection resets the branch and passes the reasons to the
   author's next run. Right before the commit, a plan or bug the run pasted under PLANS.md's
   `## Done` or BUGS.md's `## Fixed` moves to the top of PLANS-DONE.md or BUGS-FIXED.md.
   Every run commit's trailer carries `Model: <model> · backend <id>` for the model and backend
   the run started on.
4. If pi found nothing to do, the role sleeps, with the wait growing after each empty run.
   Sleeping roles wake early when main moves, since the answer may have changed.

### The backlog files

PLANS.md, BUGS.md and QUESTIONS.md hold open work, and every run reads them, so they stay
short. Finished plans and fixed bugs live in PLANS-DONE.md and BUGS-FIXED.md, newest first,
under the same `## Done` and `## Fixed` headings. Roles still paste a finished entry under the
live file's heading. tumwater moves the entries a change added there into the archive right
before that change commits. `tumwater start` moves anything else still there in one commit on
main, such as legacy history or a hand commit's move, and so does `tumwater archive`.
`tumwater doctor` warns while a live file still holds finished entries. Nothing reads an archive
file whole: the dashboards, the report and `plan|bug --list --done` read the live section and
then the archive, and roles search the archives or read one entry by its line range. When a merge or a revision conflicts in one of the three live
files and each side only added, removed or edited different `### ` entries, tumwater merges the
entries itself; the same entry edited on both sides still goes to the conflict resolver.

## The merge pipeline

A run ends as soon as its commit is in the merge queue. Queued changes are approved in parallel
and one serial merge step merges them, so other roles keep running while a change is under review.

- **Rebase.** The change is rebased onto current main first, so the pipeline checks what will
  actually merge.
- **Check.** The project's declared check runs: `check.command` in tumwater.json, else
  `npm test`, else typecheck/build. A failure is re-run once; one that then passes is warned
  as a flake and proceeds; the bugfix run's prompt lists the checks excused as flakes in the last
  24 h, with their counts. A failure that repeats is attributed through main's own verdict at
  its tip: main passing (or no verdict) rejects the change with the check's output, no model run;
  main's check failing is not the change's failure, so its pin is kept for a later retry and the
  failure goes to bugfix. Optionally, `check.gateCommand` names a cheaper check (say, only the
  tests a diff touches) that this per-change step runs instead. It is off by default; tumwater's
  own team sets it to `npm run test:gate`. The full check then still runs once per merge, over
  the batch or the single change, and a failing result there blocks the merge. Optionally,
`check.mergeCommand` names a cheaper check for that in-lock step (lint, compile and the change's
affected tests). A merge whose rebased head the gate verified then runs nothing in the lock, and
a green of the cheaper command never seeds main's verdict. The main watch runs the full check on
main's tip after the merge: a break it finds is reverted, and the red-main gate, the bugfix note
read the watch's verdict instead of starting a full check (no verdict yet reads as green); the
gate's re-attribution of a repeated failure still runs main's check fresh, as it does unset. Its in-lock `build_check` events carry `full: false`, so reports and
doctor's merge-check median leave them out. Unset, every merge runs the full check.
  `check.timeoutSeconds` (default 300) bounds every check, the detected `npm test` included.
- **Review.** A fresh reviewer checks the diff against PRINCIPLES.md and replies
  `VERDICT: approve|reject`. Markdown-only diffs skip review, but the pipeline first rejects,
  md-only diffs included, an edit to the brief's prompt block or to PRINCIPLES.md from any role
  but the director and steward, and a change that newly writes a secret environment variable's
  value, or a credential pi stores in `auth.json`/`models.json`, into a file (INV-G2). Each
  reviewer run is capped at `review.timeoutSeconds` (default 900, never above
  `runTimeoutSeconds`; at least 3600 while the over-cap model carries the team, since a slower
  free model needs as many turns); a reviewer still making progress at that deadline gets one
  extension of the same length before it is killed. One that runs over fails without a strike
  and the change goes back through the merge pipeline on the author's next run. An approval is
  keyed by the diff's patch-id, so an approved change retried after a clean rebase is not
  reviewed again; its check still runs.
- **Merge.** Approved work fast-forwards main under a merge lock, so history stays linear. If
  main moved since the approval's check, the rebased tree is checked again inside the lock,
  unless it differs from the checked one only in review-exempt paths: doc commits on main don't
  trigger a full re-run. Main's own verdict carries over doc-only commits the same way, so the
  main's-check-failing test and the update's passing check run the suite once per code change,
  not once per doc merge. Attributing a failing check to a change still runs main's suite for
  real. The merge-side steps (a stack and its bisect, the conflict resolver, the post-resolve
  re-review) run in one dedicated `_merge` workspace, reserved outside the pool so an approval
  waiting for a workspace can never deadlock behind the merge lock.
- **Batching.** When several changes are queued, each is reviewed alone, then up to
  `mergeBatchMax` (default 3) merge together under one check. A failing batch merges its longest
  passing prefix and checks the rest again. A change that fails on its own is rejected, unless
  main's check is failing too, in which case its pin is kept for later.
- **Parallel approval.** Each queued change is rebased, checked and reviewed in a workspace
  leased from the shared pool (`.tumwater/worktrees/_slot-<n>`; the pool holds `worktreeSlots`
  checkouts, default `maxConcurrent` + 1), several at once. An approval counts as active work: it
  holds one of the `maxConcurrent` permits role runs use, ahead of any waiting run, so
  merges never add streams to the provider beyond `maxConcurrent` plus the director. Approvals
  take at most `maxConcurrent` − 1 of those permits (at least one), so a deep queue always leaves
  one for authoring. A change that fails approval frees its author at once, and the merge step
  merges approved changes in queue order, up to `mergeBatchMax` per stack, without waiting on a
  slower review ahead of them. An approved change whose base moved is checked again before it
  merges; a change whose merge check fails twice is judged by main's own check, like a failing
  pipeline check.

Errors keep the commit for re-review, up to three strikes. `tumwater abort --role <id>`
discards a role's in-flight merge.

## Scheduling

- **Workspace pool.** Runs and approvals share `worktreeSlots` pooled workspaces
  (`.tumwater/worktrees/_slot-<n>`, default `maxConcurrent` + 1): each is leased for one run,
  reset to that run's commit, and released back. A role whose run is resumable keeps its workspace
  pinned so the resumed session runs in the same directory; a lease that waits 30 s or more
  logs a `slot_wait` event so `worktreeSlots` can be sized from real contention; `tumwater
  doctor`'s "worktree pool" row sums the last 24 h of those waits and warns once they total 10
  minutes, naming the number to raise `worktreeSlots` above. While every workspace is leased,
  `tumwater status`, the TUI header and the dashboard's team panel show `workspaces
  <leased>/<worktreeSlots>`, plus `, <n> waiting` when runs queue for one. Outside the pool sit the director's
  own `.tumwater/worktrees/director`, the merge step's `_merge`, the review gate's `_gate-main`,
  and the update mirror and witness (`_main`, `_build`). Size the disk for about `worktreeSlots`
  + 3 warm checkouts of the project.
- **Parallel work instances.** `roles.feature.instances` and `roles.bugfix.instances` (1–8)
  run that many instances of the role — `feature`, `feature-2`, … (shown as `feature #2`) — each
  with its own branch and state. The scheduler assigns each due instance one eligible backlog
  entry and holds it until the entry merges, the instance gives it up, or it sits idle past 24 h;
  two instances never work the same entry. `instances` is the number of runs writing code at
  once: above 1 tumwater keeps up to twice as many runners, and a runner whose change waits in
  the merge pipeline holds no place, so another starts while fewer than `instances` are running
  (a runner whose change came back for revision is admitted first). The assignment names any paths the entry cites that
  no longer exist in the checkout. The repeated-failure pause stops only the failing instance;
  instance 1's pause shows as `feature-1`, and `tumwater resume --role feature-1` lifts it. An
  extra instance with no unassigned eligible entry is
  skipped without lengthening its sleep, and so is the first instance while siblings hold every
  eligible entry (a wake from you still runs it). A feature instance, the first included, skips its
  scheduled and main-moved runs while no plan is eligible at all, so a wake from you, an inbox
  message or a resume still runs; a `start --once` round settles a skipped instance as
  `no free entry`. A bugfix instance does the same while BUGS.md has open bugs but none is
  eligible (with no open bugs at all it keeps searching for latent bugs). The plan role keeps
  `instances(feature) + 1` eligible plans ahead so every feature instance has something to
  take (a due plan run defers while that many are waiting and none is marked needs-review or
  needs-replan). The plan run's prompt gives both the target and the current count, the same
  count the deferral uses. `tumwater status`, the TUI and the dashboard name each instance's assigned entry
  while it is idle or merging, `tumwater logs` renders the `claim` assigned/released events, and
  `tumwater doctor`'s `parallel instances` check warns on an assignment whose entry is gone or stale.
  An idle instance that is paused on its own (by you, or by the repeated-failure pause) gives its
  entry back and a sibling takes it; pausing the whole role keeps every claim.
- `maxConcurrent` caps parallel runs and approvals together. Merges go first, then
  work roles (feature, bugfix, plan), then maintenance roles.
- `maxConcurrentPerProvider` (optional) caps how many of those runs each model provider serves
  at once, beside the team total: a run starts only when BOTH its provider and the team
  have headroom, and a full provider never holds back a run on another
  (plans/provider-concurrency.md §1). A role run's key is the provider its model job resolves to
  (a claude job's own id, else the pi provider, or pi's saved default for a job that names no
  model). A run whose admission waits 30 s or more for its provider/team slot logs a
  `provider_wait` event, and `tumwater doctor`'s "provider contention" row sums the last 24 h
  and warns at 10 minutes, naming every key that waited, busiest first. The event's `cap` names
  which cap held the run (its provider's, else `maxConcurrent`) and `limit` its value; the
  doctor row files a team-cap wait under "the run cap" whatever its key.
- `maxConcurrentChecks` (default 2) caps how many runs of the project's check are in flight at
  once: pipeline, merge, batch, and main-baseline checks share it, the rest queue, and merges go
  first. A scoped check whose permit wait reaches 30 s logs a `check_wait` event (role, scope,
  waitedMs, and the checks holding the slots and the cap when it parked), and `tumwater doctor`'s "check contention" row sums the last 24 h, names what the waits sat behind (merge, gate or batch checks, or the main baseline), and warns at
  10 minutes, naming `maxConcurrentChecks` to raise. `tumwater report` and the dashboard's Report
  tab show the per-day median of those waits as "Check wait median" (team scope only).
  While a check runs or waits, `tumwater status`, the TUI header and the dashboard's team panel
  show `checks <running>/<cap>`, plus `, <n> waiting` when checks are queued.
- A bug that bugfix cannot reproduce is held by a `**Waiting for the next failure <date> by
  bugfix: …**` note, which bugfix writes once it has made the failure's message name the cause.
  The backlog index marks the entry `[blocked: waiting for the next failure]`, so bugfix skips it
  (and sleeps when it is the only open bug). The hold lifts when whoever records a new occurrence
  deletes the note line (selfcheck does this), or with `tumwater bug --release <n>`.
  A bugfix run that adds a Progress note to an open bug without writing the note is asked to
  write it in its staging fix-up turn.
  `tumwater doctor` warns when the held bug's quoted test has failed again in a gate or merge
  check since the day after the note.
- A maintenance role whose last run did nothing is deferred until feature, bugfix, director,
  you, or another human's work merges to main (your own `tumwater brief`, `plan`, `bug` and
  `questions answer` edits count as human work), and stays deferred while PLANS.md or BUGS.md has
  work a feature or bugfix instance can take (refused, needs-review/replan, waiting-for-the-next-failure and blocked entries do
  not count). `qa` is never deferred. `bugfix` is not a maintenance role, but while BUGS.md has no
  open bugs it has nothing assigned and defers like one — with the difference that any
  feature, bugfix, director, you or another human wakes it (your own `tumwater brief`, `plan`, `bug`
  and `questions answer` edits count) (a deferral only holds while no qualifying work has merged),
  and that one open bug puts it back on the every-wake schedule.
- The director runs your prompts immediately, outside `maxConcurrent` and ahead of every role.
  With no prompt, a director holding a kept merge pin is also due on its own min-run clock (20 s
  by default) and wakes as `woke (leftover)`; that run re-queues the pin and authors nothing.
- `tumwater prompt --role <id>` puts a prompt in one role's inbox for its next run instead of the
  director's, and wakes it. `--list` shows the inboxes grouped by role; per-role prompts
  wait behind a paused role like the director's wait behind a team pause.
- While main's check is failing and names its failing tests, every role keeps working: the code
  roles' prompts carry a `<main-known-red>` note listing those tests (at most 20), and a change
  merges when it adds no new failures. Only when the failure names no test (another runner, a crash,
  a compile error) do code-producing roles pause authoring (the status shows "main's check is
  failing") until it passes again; bugfix, the director, and markdown-only roles keep going. A
  newly-verified red main also queues a bugfix healer, so the healer starts on the next poll instead
  of waiting out its interval or deferral — once per failing set, not once per red commit — and that
  queued prompt no-ops (a "verify green" clause) if main turned green before it ran.
- A main watch runs the full check on main's tip in the background whenever the head moves (one run
  at a time, covering every commit since the last watched head; a red is re-run once before it counts;
  a doc-only tip inherits its green). It logs a `main_check` event with the failing test titles and
  saves reds beside the greens in `.tumwater/state/baseline-verdicts.json`. On a red tip it also
  bisects the first-parent commits since the last green and logs a `main_culprit` event naming the
  commit, its merging runner and the failing tests (or a warning when it cannot name one). No run or
  merge waits for the watch. It hands the named commit to the merge slot, which reverts it before
  any merge pick (serialized with merges): it checks out main's tip in the `_merge` worktree,
  commits the inverse as `tumwater(tumwater): Revert <short sha>`, runs `check.gateCommand` on it
  when one is set, fast-forwards main under the merge lock and logs `main_revert`. A commit with no
  merging runner, one the director merged, a revert itself, or one already reverted is not
  reverted, and a revert that conflicts, fails its gate or loses the fast-forward is abandoned with
  main unchanged; each of those queues bugfix's heal prompt naming the commit and the failing tests.
  After a successful revert the commit goes back to its role as a revision: the merging runner when
  it is idle with no queued change or pending revision, else the first such free runner of the same
  base role. It points that runner's `refs/tumwater/rejected/<role>` at the commit and records
  `reverted after merge: turned main red — <failing tests>` as the review to revise against. With no
  free runner it waits in `.tumwater/state/reverted.json`, assigned on a later merge poll and dropped
  once assigned.
- A role listed in `review.afterMerge` is reviewed after merging: its change still passes the
  deterministic rejects and the gate check, then merges with no reviewer run. The `merged` commit
  is recorded in `.tumwater/state/post-review.json`, and the merge poll runs one review at a time
  over `git diff <commit>^ <commit>` when a permit is free (`review_start`, `review_verdict` and
  `review_rejected` carry `afterMerge: true`). An approval ends it. A rejection goes to the revert
  slot as above, with the reviewer's reasons in place of the failing tests, and the commit goes
  back to its role as a revision. A revert that conflicts leaves the commit on main and puts the
  reasons in the role's inbox. A review that ends three times with no verdict is dropped with a
  warning.
- A test that fails and then passes on the same tree is quarantined at once: the gate's re-run, a
  red in-lock merge check's one immediate re-run (the change then merges), and the watch's
  confirming re-run each add the failing tests the failed run named to
  `.tumwater/state/quarantine.json` (newest 100). A quarantined test counts as a known failure
  everywhere: a gate or merge check failing only known tests goes on, the watch records a red
  naming only quarantined tests as passed (`quarantined: [tests]`) with no bisect, and the culprit
  search treats such a red as green. The watch files one BUGS.md `## Open` entry per newly
  quarantined test, committed on main under the merge and primary-worktree locks (it warns and
  retries on a later poll when the checkout is dirty or off main). A test leaves quarantine when its
  entry is no longer under `## Open`; a later flake puts it back. The 24 h headline excuse
  (`known-flaky failure, merge kept`) remains for failures that name no test.
- Failed runs retry on a shorter ladder, capped at ten minutes. Three failures in a row mark a
  role `failing` until it has a healthy run.
- A search role's own recent yield stretches its clock: after ten consecutive counted runs
  that merged nothing, its minimum gap doubles, and doubles again per five further empty
  runs up to ×8 — and the stretched gap gates the "main moved" wake too, so a quiet role
  stops re-checking on every merge. One merge in the last ten counted runs restores the
  plain gap. Failed runs (errors, aborts, stalls) count as neither. `tumwater status`
  shows the stretch as `×N` beside the next-run time; feature, plan, and the director are
  never scaled, and a wake or inbox message bypasses it.

## Spend and pausing

- `maxDailyCostUsd` (default $50; 0 disables) stops new role runs for the rest of the local
  day once reached. In-flight runs finish, and the director keeps running. Before that, the
  team logs one `budget_warning` event when spend crosses a fixed 80% of the cap while the
  gate is still open — re-armed when spend falls back below (a new day, a raised cap) — so a
  configured notify command can page you while there is still room to act.
- `maxDailyCostUsdPerRole` (optional map of role id to USD; 0 disables that role's cap) bounds
  one role's own daily spend the way `maxDailyCostUsd` bounds the team's: a role that has
  reached its cap starts no new runs until the next local day or a live edit raises/removes
  the cap. In-flight runs finish and the director is exempt; a per-role cap never engages the
  fallback, and the other roles, the team-wide cap, and its fallback demotion are untouched.
  Before that, the role logs one `role_cap_warning` event when its own spend crosses the same
  fixed 80% while it is still running — re-armed when spend falls back below — so a configured
  notify command can page you while there is still room to raise the cap.
- `fallback` names a free model that roles switch to at the cap instead of stopping (the
  legacy `fallbackModel` object still parses). Each model job runs its tier's resolved fallback:
  the tier's own entry, else the nearest other tier's own fallback (small → default → strong;
  default → strong → small; strong → default and never small — a weak reviewer costs more than
  a paused one). Only a model pi's `models.json` prices at zero is accepted; anything else
  leaves the team paused. Free is not enough either: a fallback whose backend cannot serve
  (three consecutive
  role runs failing on it) is demoted to the same pause, then retried with one probe run after
  a cool-down of 5 minutes doubling to at most 30. When the gate reopens (the cap raised, or a
  new local day), a run that started on the fallback is handed back to the primary: it is
  interrupted resumably — session and workspace edits kept — and its next run continues the
  same session on the budgeted model (`budget_handback` in the feed).
- Model failure fallback is separate from the budget gate above, triggered by health rather
  than spend: when one role's runs fail with provider-class errors (429s, and connection,
  timeout, server, model-load, and stream-severed backend failures) three times in a row, its
  next runs use its tier's resolved `fallback` pair while the primary is probed. Once the
  5-minute cooldown elapses, the next run uses the primary as the probe — a real run, not a
  separate canary request — and an answering probe returns the role to the primary. The episode
  is per role and never moves the director; `tumwater status`, the TUI, the dashboard, and
  `tumwater role <id>` name the off-model pair, its start, and the tripping reason.
- `quietHours` (default off; absent or empty) is a daily local-time window, `"HH:MM-HH:MM"`,
  during which roles start no new runs — a run due inside the window starts at window
  end, and a window may wrap midnight (`"23:00-07:00"`). The director is exempt, exactly as
  under the budget gate and a pause you set. Edits apply live, and each crossing into or
  out of the window logs one `quiet_hours_started` / `quiet_hours_ended` event in the feed.
- `diskHoldGB` (default 10; 0 disables) is the free-space floor, in GB (10^9 bytes), for the
  volume holding `.tumwater/worktrees`. When free space drops below it, no new work starts —
  role runs, the director, approvals and merges — until free space climbs 5 GB back above
  the floor (the hysteresis that keeps a team at the line from flapping). In-flight work runs
  on. A live edit applies on the next poll (including editing to 0, which lifts an active
  hold), each crossing logs one `disk_low` / `disk_ok` event (and `disk_low` pages a configured
  `notify` command), and `tumwater doctor` fails below the floor, passes above it, and warns
  when the volume cannot be measured.
- `diskReclaimGB` (default 40; 0 disables) is the pressure-reclaim threshold, in GB (10^9
  bytes). Below it, one background pass deletes the files git ignores (`git clean -fdX`) in
  idle tumwater workspaces, least recently used first, so build outputs of any ecosystem
  (`target/`, `node_modules/`, `dist/`, `.venv/`) are freed before the hold engages; a
  workspace in use is never cleaned, and one the registry has never seen counts as used at
  first sight. A pass that cleaned anything logs one `disk_reclaim` event. The hold waits for
  the pass to settle, and with `diskReclaimGB` 0 it engages immediately. It must be at least
  `diskHoldGB` unless it is 0. `tumwater doctor` warns between the hold floor and this
  threshold.
- `worktreeIdleReclaimHours` (default 24; 0 disables) is how long a workspace may sit unused
  before an hourly idle pass deletes its gitignored build outputs whatever the free space,
  catching paused, retired, and rarely due roles. A workspace already reclaimed since its last
  use is skipped, and one with a pending resume is never idle-reclaimed. `tumwater reclaim`
  runs one manual pass over every candidate: with a live team it drops a marker the
  orchestrator consumes within a poll, and with none running it cleans in-process; `--dry-run`
  lists each candidate with its idle age and ignored-path count and cleans nothing.
- `tumwater pause` / `resume`, or the dashboard's Pause control (which also offers timed
  pauses), block new role runs until lifted. Queued merges still finish. Both accept
  `--role <id>` to hold a single role instead of the team: in-flight runs finish, every other
  role keeps running, and the director is not exempt — its inbox messages simply wait.
  `pause --for <duration>` (e.g. `2h`) lifts itself when the deadline passes, so a paused team
  resumes without you. A team pause may carry `--reason <text>` — the why behind the pause,
  surfaced on `status`, the TUI, and the dashboard (a per-role pause carries no reason). The
  dashboard's per-role pause button also offers timed pauses (the same choices as the team menu,
  matching `pause --role <id> --for`), and a timed role pause shows its auto-resume countdown on
  the role's row and drawer.
- The repeated-failure pause acts on the same evidence the per-role warning uses: after
  10 consecutive failed runs a role is paused through the same per-role marker (a
  `role_streak_paused` event names the streak and the cause), so a role failing on its own
  cause stops burning workspaces until `tumwater resume --role <id>` lifts it; the director
  included.

## Interruptions

Stopping the team mid-run loses nothing: on the next `tumwater start`, the role resumes its pi
session and uncommitted edits. `tumwater stop` is the graceful path — it signals the orchestrator,
lets in-flight runs finish and merge, then exits. The orchestrator also runs the same graceful
stop if its supervisor dies without forwarding a signal (a `kill -9` or OOM kill), so a dead
supervisor takes the team down instead of leaving it orphaned and running unattended. Crashes
recover the same way, and so do runs the watchdog stops as stalled, up to three in a row. An
interrupted merge goes back through the pipeline, and an interrupted director prompt goes back to
its inbox. A change whose merge ends blocked, in a review error, or in a conflict that stays
under the limit is put back in the merge queue by the pipeline itself, at once, with its original
summary and no author run; a review error waits 60 s first, and a held reviewer configuration
error is not re-queued. A change kept because main's check was failing goes back once main's head
moves. A commit left unmerged by a crash or a restart (or one before it was queued) goes back in
the merge queue at the role's next run, which ends there instead of authoring, so the one merge
step stays main's only writer. The director's next run is otherwise only ever your prompt, so while
it holds a kept commit it is also due on its own min-run clock. A commit whose last three merges
all hit conflicts that
conflict resolution could not settle is dropped instead, and the role's next prompt says so.

## Updates

When the project being built is tumwater itself, the team notices when main's code differs from
the running build and shows `Update available`. With `autoRestart` (default true) it confirms
main's check passes, compiles it, finishes in-flight runs, swaps the new build into `dist/`, and
restarts, at most once every 4 hours. The commit it builds is main's newest one whose full check
passed and that is newer than the running build, so a red tip does not stall an update that an older
green commit allows. A failing check on main (with no green commit newer than the running build) or a failed compile keeps the old
build running and shows `restart BLOCKED`, with the reason. You do not have to wait out the
4-hour clock: the dashboard's update alert has a refresh button that waives the cooldown
and starts the pending update immediately — every other gate (a passing check on main, a
successful compile, in-flight runs finishing) still applies. From the terminal, run
`tumwater restart` to press the same button: both write the marker the redeployer consumes.

`tumwater tui` and `tumwater gui` follow the swap: each re-execs onto the new `dist/` within a
second, and only onto a build stamped with a real commit of the repo. Because the team executes
your checkout's own `dist/`, `npm test` refuses to run in that checkout while the team is up (the
suite's first steps recompile and restamp `dist/`), so run suites in a worktree.

## Prompts

Every run carries PRINCIPLES.md, which only the director and steward edit. Prompts are written
for a mid-sized model with a finite context window: tool-call budgets, ranged reads of large
files, and bundled pi extensions that trim oversized tool output to its head and tail and, on
a model with a window of at most 256k, stop sending the model's earlier thinking back to it.

Every run gets a compact prompt, whatever model it runs on. Its rules keep every directive in
few words, its principles block keeps only the bullets, and it leaves out the brief block, since
the brief file holds the same text. A run that tumwater assigned one backlog entry also goes
without the backlog index and reads its entry first. pi's system prompt loses its section about
pi's own documentation. Each turn re-sends the whole prompt, so the shorter one saves tokens on
every turn of every run.

Each role also has notes: a short, model-written note its own earlier runs left for the
next fresh session (where things live, what was ruled out, what to look at next). They live at
`.tumwater/state/notes/<role>.md`, are capped at 4 KB, and are the only state carried between a
role's runs besides the repo itself. A run sees the note when one exists, along with the day it was last saved and how many days ago that was, and may replace it
by running `tumwater-notes write` on every backend; the director, whose work is your prompt rather
than a recurring search, has no notes. You can clear or replace a note with
`tumwater role <id> --clear-notes` or `--notes-file <path>`; a run in progress at that moment may
still overwrite it through its own `tumwater-notes` call.

## Configuration

`tumwater.json` is untracked and seeded from the tracked `tumwater.example.json`; edit the example
to share a baseline with collaborators. It sets enabled roles, provider, model, and thinking level
(globally or per role), run intervals, sleep lengths, and the settings above. Edits apply within
~2 s while the team runs, and each one logs a `config_changed` event. From the terminal,
`tumwater config get <key>` reads one resolved value, `tumwater config set <key> <value>`
writes one, and `tumwater config unset <key>` removes one (the inverse of `set`, so a value
reverts to its default or disappears from its map or section) — all through the same lock,
validation, and atomic write, so you never have to hand-edit the file.

- **Custom roles:** add `customRoles` entries by hand or by prompting the director ("add a role
  named X that does Y"). The TUI marks them with `*`, the web dashboard with a `custom` tag.
- **Backend binary:** each backend resolves its own: `TUMWATER_<ID>_BIN`, then `backends.<id>.bin`
  (pi also reads the legacy top-level `agentBin`), then the backend's default binary (`pi` or
  `claude`) on PATH.

## More controls

- `reset-counters` zeroes runs, commits, tokens, and cost without touching the schedule (the
  dashboard's Roles card and role drawer reach the same reset). `wake` does the opposite: it ends
  every role's sleep so they run within one poll.
- `gui --all-interfaces` has no authentication unless you pass `--token <secret>`. Clients send the
  token as `Authorization: Bearer <token>` or `?token=`.
- The web dashboard opens on Team: alerts for whatever needs you (a failing or stuck role, a
  failing check on main, a spent budget, an available update, open questions, a pause), the prompt
  box, today's progress, the roles grouped by what they are doing,
  the backlog, and the notable activity — a `Loop picker` and a case-insensitive Search box narrow
  the events the card carries, and an active picker or Search filter also searches the log's
  recent slice through `/api/logs` (well past the events a status poll carries), persisted like
  the Notable/All choice. A Window picker (last hour / 6 hours / day) shows that trailing
  window's events through `/api/logs?sinceMs=`, the twin of `tumwater logs --since`, refreshing
  when a new event arrives. Its ◀ Earlier / Later ▶ buttons step that window back by its own length through
  `/api/logs?sinceMs=&untilMs=`, the twin of `logs --since --until`, and a stepped window does not
  refresh. The Inbox tab lists each queued prompt and how long it
  has waited, and each row can be edited in place — Edit loads the prompt's body, Save replaces it
  through the same path `tumwater prompt --edit` uses — and can be moved to the front of its role's
  queue, the same reorder `tumwater prompt --top` makes, addressed by the row's queue file; an open question's Answer button opens its
  drawer, whose Record answer form writes the decision to QUESTIONS.md as `tumwater questions
  answer` does. Clicking a role opens its details — its notes and next run's prompt included — and
  its live transcript (`#role/<name>` links straight to it). A "Show prompts" button re-reads it through
  `GET /api/transcript?…&prompt=1` with each agent run's prompt, the text `tumwater logs --transcript <id> --prompt` prints; `&grep=<text>` keeps only the entries containing the text, each under its run's separator, as `tumwater logs --transcript <id> --grep` does. The role drawer's search box sends that `&grep=`. Its History, Usage, Failures, and
  Pending views match `tumwater history`, `tumwater report`, `tumwater report --failures`, and
  `tumwater diff`; the Pending view also paints the merge queue as a card mirroring `tumwater
  queue`, with a Role picker that keeps only the chosen role's waiting merges, each under its
  whole-queue position, the `tumwater queue --role` twin, and the files two or more roles' pending changes touch as an Overlapping files card mirroring
  `tumwater diff --overlaps` (`GET /api/diff?overlaps=1[&role=<ids>][&path=<path>]`; clicking a listed file shows each role's change to it, `GET /api/diff?role=<id>&path=<path>`, the twin of `diff --role --path`; its Role picker keeps only the files the chosen role holds, each still naming every holder, the `diff --overlaps --role` twin, and its Folder picker keeps only the files at or under the chosen directory, the `diff --overlaps --path` twin), and shows a role's full unmerged patch in its drawer (its Stat only toggle shows the diffstat instead, `GET /api/diff?role=<id>&stat=1`, the twin of `diff --role --stat`), which also lists that role's waiting merges
  under their whole-queue positions, mirroring `tumwater queue --role <id>`. Its Settings view shows the
  curated top-level config keys (provider, model, fallback, the daily spend cap, quiet hours, the
  notify hook) with inline Save and Clear buttons: Save writes through the same path `tumwater
  config set` uses, and Clear retracts through the same path `tumwater config unset` uses, so the
  field reverts to the key's default (unsetting the daily spend cap restores the default 50). The
  view also runs `tumwater doctor`'s checks on each open in a `Health check` card, with a Re-run
  button. The view also lists disabled roles that still keep a worktree, branch, merge ref, or
  paused marker, each with what `tumwater retire` would remove and a two-click Retire button; a
  role the safety rails object to shows the objections and the `--force` command instead,
  because the dashboard never forces.
- The TUI shows the same alerts under its header, and names its views the same way; `Ctrl+T`
  cycles Activity, each role's Transcript, Backlog, Usage, Failures, History, Pending,
  Inbox, Health (the same checks `tumwater doctor` prints, re-run on each entry), and Brief (the
  brief `tumwater brief` prints, read-only). Activity keeps the live tail and `PgUp`/`PgDn` page
  it back through a fixed 200-event tail, the bottom of the page resuming the live tail; `Ctrl+G`
  scopes the feed to the team or one raw roster id (the same exact-role scopes History uses) and
  `/` on an empty prompt line opens a free-text search over the same loaded tail. Both filters
  match through the rules `tumwater logs --grep` and the dashboard Activity view use — `eventRole`
  for the role and `eventMatchesGrep`'s case-insensitive type-plus-rendered-line haystack for the
  text — and the hint line names the active scope and pattern.
  On History, `Ctrl+S` cycles the pane's trailing window (default, 1h, 6h, 1d, 7d) through the
  same collector and sparse-window note `tumwater history --since` uses.
  With the trail off, `Ctrl+P` steps that window back by its own length through the same
  `readRunRowsSince` bound `tumwater history --since --until` uses; the header names it
  `window: between X and Y ago`, and `Ctrl+S` returns to the trailing window.
  `Ctrl+O` cycles the pane's outcome filter (all, merged, none, refused, problems) through the same
  `historyClass` buckets and an emptied filter's `no runs with result` wording
  `tumwater history --result` uses, with the hint line naming the active class (`result: all` or
  `result: <class>`).
  `Ctrl+G` cycles the pane's exact-role scope through the team and each raw roster id — an
  instance id is its own scope, the same one `tumwater history --role` and the dashboard picker
  take; the hint line names it (`scope: team` or `scope: <id>`) and a scoped pane prefixes its
  body with `role: <id>`.
  `/` on the History pane with an empty prompt line opens a free-text search; Enter filters the
  rows through the same `tickRowGrepHaystack` haystack and case-insensitive substring rule
  `tumwater history --grep` and the dashboard's History search use, the pane's `search:` header
  and the hint line name the active pattern, and Esc cancels.
  `Ctrl+N` swaps the pane for the newest completed run's full event trail — the newest among the
  pane's rows (its `Ctrl+G` scope, window, result and search) — rendered from the same
  `readTickDetail`/`renderTickDetail` pair `tumwater history <role> --last` and the dashboard's
  History drill-down use, then the run commit's per-file stat footer (`tumwater history <role>
  <n> --stat`'s text, loaded async so the trail shows at once); the tab strip reads `Run` and
  `Ctrl+N` again returns to the rows. `Ctrl+P` on a trail steps to the next older run among those same rows, wrapping to the newest after the oldest. `Ctrl+R` on a trail adds the run's agent transcript, then the transcript with each agent run's prompt, then hides it again (the text of `history <role> <n> --transcript [--prompt]`). `Ctrl+W` adds the run's commit patch below the stat through `runDetailPatch`, the text `history <role> <n> --patch` prints.
  On a trailing window, the dashboard History toolbar's ◀ Earlier / Later ▶ buttons step that window back by its own length, through `/api/history?sinceMs=&untilMs=`, the twin of `history --since --until`. The dashboard Usage and Failures toolbars carry the same buttons on their 1h/6h/1d windows, through `/api/report` and `/api/failures` `?sinceMs=&untilMs=`, the twin of `report [--failures] --since --until`.
  The dashboard's History drill-down adds a "Revert this change…" button on a run whose change is on
  the base branch: it previews through `previewRevert`, then reverts through `revertMergedCommit`,
  the two cores `tumwater revert` uses (`POST /api/revert`).
  Its "Show patch" button loads the run's commit patch on demand through `GET /api/run?…&patch=1`,
  the same `tickDetailPatch` text `tumwater history <role> <n> --patch` prints.
  Its "Show transcript" button loads the run's agent transcript through `GET /api/run?…&transcript=1`,
  the same `tickTranscriptLines` text that `tumwater history <role> <n> --transcript` prints.
  Once it is open, a "Show prompts" button reloads it through `GET /api/run?…&transcript=1&prompt=1`
  with each agent run's prompt, the text `tumwater history <role> <n> --transcript --prompt` prints.
  Its search box (applied on Enter) reloads it through `GET /api/run?…&transcript=1&grep=<text>`, keeping
  only the entries containing the text, the text `tumwater history <role> <n> --transcript --grep`
  prints; toggling prompts clears it.
  `GET /api/run?role=<id>&last=1` serves the role's newest completed run instead of a numbered one,
  and `&result=<class>[,...]` / `&model=<selector>[,...]` narrow it to the newest run in those outcome
  classes or on those models, the run `tumwater history <role> --last [--result] [--model]` opens
  (`newestRunRow`, shared). Without `role`, `GET /api/run?last=1` serves the newest completed run of
  any role, the run bare `tumwater history --last` opens, with the same `result`/`model` narrowing.
  `GET /api/history?result=<class>[,...]` keeps only the runs in those outcome classes, after `grep`
  and before `model`, the rows `tumwater history --result` lists.
  The Pending pane shows the durable merge queue above the pending-change roster, reading and
  rendering it through the same `readMergeQueue`/`renderMergeQueue` pair `tumwater queue`
  prints, so the queue's order, age, skips, and wording match the CLI — including the bracketed
  label (`[merging 2m · reviewing]`, `[approved, waiting to merge]`) on an entry a running team
  is merging.
  Below the roster it lists the files two or more roles' pending changes touch, through the same
  `collectChangeOverlaps`/`renderChangeOverlaps` pair `tumwater diff --overlaps` prints.
  Ctrl+N steps through those files, showing each holding role's change limited to the file (the
  `tumwater diff --role <ids> --path <path>` view); the press after the last one returns to the pane.
  Ctrl+G cycles the list through each holding role and back to all, keeping only the files that role holds (the `tumwater diff --overlaps --role <id>` view, through the same `scopeChangeOverlaps`); the same scope also narrows the merge queue above to that role's waiting merges, each under its whole-queue position (the `tumwater queue --role <id>` view, through the same `scopeMergeQueue`), and the cycle leads with the queue's roles before the overlap holders; Ctrl+N then steps through only those files.
  The Inbox pane lists every role's queued prompts, reading through the same queue traversal
  and renderer `tumwater prompt --list` uses, so the two surfaces cannot drift on order,
  per-role numbering, or the queued-age/send-later countdown suffix. Up/Down select a queued
  prompt and show its full text under a header naming its role and position, `Ctrl+X`
  cancels the selected one through the same per-role `cancelRolePrompt` path
  `tumwater prompt --cancel` uses, and `Ctrl+E` rewrites the selected one in place through the
  same `readQueuedPromptBody`/`editQueuedFile` pair the dashboard's Inbox tab Edit uses
  (`tumwater prompt --edit` at the CLI), carrying the entry's position, enqueue stamp,
  send-later marker, and attached images over the rewrite; Esc returns to the list. `/` keeps only
  the queued prompts whose text contains the typed text, each under its unfiltered per-role number
  (the `tumwater prompt --list --grep` filter); an empty line clears it.
  `Ctrl+F` on an unpaused team opens a one-line pause editor (`[duration] [reason]`, e.g.
  `2h deploy freeze`; empty pauses until resumed; Enter pauses, Esc cancels) and on a paused
  team resumes at once, through the same marker `tumwater pause --for/--reason`/`resume`
  write: roles start no new runs, in-flight runs finish, and the director still runs your
  prompts — so you can hold or release the team from the terminal you are watching without a
  second one. `Ctrl+Q` (quit later) opens a duration editor (`2h`; empty is refused, so the
  key never means "stop now") that schedules a graceful team stop through the marker
  `tumwater stop --in` writes, and cancels the pending stop at once when one is scheduled. On the
  Usage and Failures panes, `Ctrl+G` cycles the base-role report scope through the team and each
  base role, the same scope `tumwater report --role` and the dashboard's Usage/Failures views
  take; the tab strip names it (`Usage: <role>`) and the hint line shows the current scope
  (`scope: team` or `scope: <role>`). `Ctrl+E` cycles a session-only trailing window for the
  Usage and Failures panes (default, 1h, 6h, 1d, 7d) through the same collectors `tumwater report
  --since` and `tumwater report --failures --since` use, with the hint line naming it
  (`window: default` or `window: <window>`). `Ctrl+P` steps that window back by its own length
  through the same `--until` bound `tumwater report --since --until` uses; the body's window
  line names the span, and `Ctrl+E` returns to the trailing window.
- In the TUI, viewing a role's transcript puts that role's controls on the hint line: `Ctrl+P`
  on an unpaused role opens a duration editor (empty pauses until resumed, Esc cancels) that
  writes the same `pauseRole` marker `tumwater pause --role --for` does — the deadline is the
  paused-roles marker's one shared field, as with the CLI — and on a paused role resumes it at
  once, `Ctrl+A` stops its in-flight run, `Ctrl+W` opens a wake editor (empty wakes it now, a
  duration like `2h` schedules the wake, `cancel` drops its scheduled wakes), `Ctrl+N` cycles the
  pane live transcript → notes → change and back: the notes step shows the role's notes and next
  run's assembled prompt, and `Ctrl+X` pressed twice there clears the notes (as `tumwater role <id>
  --clear-notes` does) (the same two things the dashboard drawer shows; the tab strip reads
  Notes and PgUp/PgDn page it), and the change step is headed by the role's waiting merges under their whole-queue positions
  when it has any (mirroring `tumwater queue --role <id>`), then the role's collected unmerged work —
  branch, commits ahead of main, the ahead-of-main patch, and its dirty files and uncommitted
  patch — the same `collectRoleChange`/`renderRoleChange` view `tumwater diff --role <id>` prints
  and the dashboard drawer's Pending change section shows (the tab strip reads Change, and the
  pane says `(loading pending change…)` until the collector resolves), and `Ctrl+R` opens the
  role-prompt editor that queues a prompt for that role's next run (Enter sends it; Esc or
  `Ctrl+R` again cancels and restores the draft). The prompt line names who Enter sends to, and
  Up/Down recall this session's submitted prompts — director and role alike — readline-style,
  with a half-typed draft saved and restored around the walk; the editor also takes readline's
  kill keys — `Alt+Backspace` kills the word before the cursor, `Ctrl+U` from the line start,
  `Ctrl+K` to the line end. Each keypress flashes its outcome for a few seconds. The prompt line
  only ever sends now — a later prompt is queued with `tumwater prompt --at`.
- Review runs show as `── review @ <ts> ──` in role transcripts.
- Runtime state lives in `.tumwater/` (gitignored). Durable state lives in tracked markdown and
  `tumwater.json`.
