# How tumwater works

## Setup

`tumwater init "<prompt>"` seeds a git repo with the project brief (README.md, holding your prompt
and a status section between managed markers), PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md,
and tumwater.json, and commits the tracked ones — tumwater.json is created too, but stays
untracked and gitignored, so it is the one seeded file the commit leaves behind. A bare `tumwater init` reads the prompt from an existing
README.md's `tumwater:prompt` markers instead. A `TUMWATER.md` with the same markers takes
precedence over README.md, so an existing project's README can stay untouched. A brief
missing a usable marker block (markers missing, or no text between them), or one past the
read cap, is surfaced by `tumwater doctor`'s `brief` row, which also raises its standing twin in
the alerts band (`no-brief`, `brief-truncated` — `src/ui/team-alert-standings.ts`), so a hand edit
that strips the prompt cannot run the team silently without its project brief. Pointed at an
existing repo whose README.md has no markers, init adopts it: the brief goes in `TUMWATER.md`,
README.md and any existing backlog files are left byte-identical, and only the missing files are
created (`--adopt` asks for this path explicitly). `--dry-run` prints what init would create and
leave alone, then exits without writing or committing anything. init never
rewrites an existing brief: a prompt that differs from the one it carries is refused, naming the
file to edit instead. The prompt is capped at 4096 characters because it rides into every run.

`tumwater start` then starts every enabled role. `tumwater start --once` runs one full
round — every enabled role runs at most once, every commit that round produced merges — and
then exits, for cron and CI and for trying one round before committing to a team. It exits 3
when a role that ran ended in `error`, `review_error`, `merge_conflict`, or
`merge_blocked`, so a failing round is distinguishable from a quiet one. `--for <duration>` runs the
team for that long and then stops it. What you do from here — steering the team through the backlog
from your own interactive agent, which is how tumwater is meant to be run — is in
[steering.md](steering.md).

## A run

1. Lease a workspace from the shared pool (`.tumwater/worktrees/_slot-<n>`; `worktreeSlots`
   of them, default `maxConcurrent` + 1). The role's persistent branch `tumwater/<role>` is
   checked out as-is when present, so its unmerged commit survives, and created from main
   otherwise. The director instead keeps its own `.tumwater/worktrees/director`.
2. Run pi in a fresh session with a role-specific "find one thing to do" prompt. Nothing carries
   over between runs except the role's own notes (see Prompts); durable knowledge lives in
   the repo's markdown files. The workspace sits inside your checkout, so a path that drops
   `.tumwater/worktrees/<name>` names a real file there. The run's edit and write tools (pi's,
   claude's through a hook, OpenCode's through a plugin, and codex's `apply_patch` through a
   trusted hook) refuse a path inside the project but outside the run's workspace, and name the
   same file inside the workspace instead. Shell writes stay unchecked on every backend; a run
   that leaves new changes in your checkout gets a `wrote outside the worktree` warning.
3. If pi changed files, commit and pin the commit by the run's merge ref, then end queued —
   the pin and the commit's trailers are the change's waiting state, and no queue file is
   written; the poll's drain merges it. A rejection resets the branch and passes the reasons to
   the author's next run. Right before the commit, a plan or bug the run pasted under PLANS.md's
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

A plan closed without being built is retired: it moves to `## Done` with a `retired YYYY-MM-DD`
heading stamp (`, retired …`, `; retired …` or `…) — retired …)`) and a first body line reading
`**Retired YYYY-MM-DD by <role>: <evidence>**`, whose evidence names the landed commit or the
surviving entry. `done` keeps meaning built — the report's features-done counts only built plans —
but every reader that tells finished entries from open ones accepts `retired`: a `## Done` entry
with a retired stamp is not stranded, and a `requires … landed` clause naming a retired part
counts as dangling, so the change that retires a part must point its dependents at the survivor.
Duplicate `## Planned` entries — two copies sharing an entry key or a series part label, found by
reading the markdown alone — are shown to the plan role in its prompt's `<duplicate-plans>` block,
which it retires before planning anything new.

Retiring and refusing are different closes. A plan with nothing to build — its deliverable
already exists, another entry already carries it, or a measurement disproves it — is a plan
defect: the feature role hands it back to the plan role with the plan-defect note naming the
evidence, and the plan role checks the evidence and retires the entry. A `Refused` note is
reserved for a product or design decision that is the user's to make; the refused-entries alert
and `plan|bug --release` cover that set.

## The merge pipeline

A run ends as soon as its commit is pinned: a changed run pins its commit by its merge ref,
logs `merge_queued`, and is done — the pin plus the commit's trailers are its waiting state, and
no queue file is written. The poll's drain then gates and merges the pin in the merge worktree
under the merge lock — one at a time — so other roles keep running while a change is in the
pipeline. (A file an older build left in the merge-queue directory starts no merge: the drain
reads only the live merge pins.)

- **Rebase.** The change is rebased onto current main first, so the pipeline checks what will
  actually merge.
- **Check.** The project's declared check runs: `check.command` in tumwater.json, else
  `npm test`, else typecheck/build. A failure is re-run once; one that then passes is warned
  as a flake and proceeds; the bugfix run's prompt lists the checks excused as flakes in the last
  24 h, with their counts. A repeated failure not already known as main's or a recorded flake
  is attributed at main's tip at once, never by waiting on the main watch: a check that names
  tests re-runs just those there when they can be re-run alone, else main's whole check runs
  fresh; a check that names no test (a compile or lint error, a crash) runs the gate command at
  main's tip. With named failures, a tip that reproduces them makes them main's and the change
  goes on; one that passes them, or fails only other tests, leaves them the change's, so the
  change is rejected as on a green main (unless its own old base already failed them and main has
  since fixed them). A nameless failure is main's when the gate command fails at the tip too, and
  the change's when it passes there. An unavailable tip rejects, with the reason attribution could
  not be made. Optionally, `check.gateCommand` names a cheaper check (say, only the tests a diff
  touches) that this per-change step runs instead. It is off by default; tumwater's own team sets
  it to `npm run test:gate`. `check.timeoutSeconds` (default 300) bounds every check, the detected
  `npm test` included.

  The per-change verify gate is the only check a merge depends on: since part 4l/3 the merge
  itself runs no in-lock build re-check (a merge is a rebase and a fast-forward — see below).
  The main watch runs the full check on main's tip after a merge: a break it finds queues the
  red-main heal prompt for the `ci` healer.
- **Gate.** The pre-merge gate is deterministic — the diff rules, the exempt fast path and
  the build pre-check: it rejects, md-only diffs included, an edit to the brief's prompt block
  or to PRINCIPLES.md from any role but the director and steward, and a change that newly writes
  a secret environment variable's value, or a credential pi stores in `auth.json`/`models.json`,
  into a file (INV-G2) — the three findings a later commit cannot repair. A conflict marker, a
  false fix claim on an exempt diff and a broken backlog structure can all be repaired by a
  later commit, so the gate lets them land and the main watch reports each on main's tip after
  it lands; a markdown-only diff is exempt; and a healthy change passes with no
  model reviewer. Every merged change is judged once, after it lands, by the post-landing review.
  Each reviewer run is capped at `review.timeoutSeconds` (default 900, never above
  `runTimeoutSeconds`; at least 3600 while the reviewer's own model is a free one, since a slower
  free model needs as many turns); under a starved host the budget stretches by the
  load-to-cores ratio (capped at double, the merge-scope precedent), so a progressing review on
  a loaded box is not killed at the wall by load it does not control. A reviewer still making
  progress at that deadline gets one extension of the same length before it is killed. One that
  runs over fails without a strike.
  The gate also drops a change whose entry was withdrawn from the backlog (`withdrawn`), before
  its rebase and again inside the merge lock.
- **Merge.** Gated work fast-forwards main under a merge lock, so history stays linear. A
  merge is a rebase and a fast-forward: no in-lock build re-check runs, because the pre-merge
  gate judged the tree before it reached the merge slot and the main watch verifies every
  new tip after it lands (a broken commit sits on main between its landing and the watch's fix,
  which is the `ci` healer's job). Every queued change merges one at a time, in queue order,
  through `mergeApprovedChange` — a rebase onto main's tip then the fast-forward, with no shared
  batch check and no per-change in-lock check. The conflict resolver and the re-review of a resolution that
  left the reviewed change's lines still run. The merge-side steps (the one-change merges, the
  conflict resolver, the post-resolve
  re-review) run in one dedicated `_merge` workspace, reserved outside the pool so a gate
  waiting for a workspace can never deadlock behind the merge lock.
- **Gate then merge.** The drain runs one gate-then-merge task at a time — the first eligible
  kept pin in runner order — so nothing parks a pinned change between its gate and its merge.
  A kept merge pin — a crash between a run's commit and its pin, or a pin-only writer — is
  gated and merged by the same one task on the next poll, with the pin kept on a retriable
  outcome for the next poll; a file an older build left in the merge-queue directory starts no
  merge. A pin whose claim is withdrawn is left for its role's next run to set aside, never
  merged.
  The task's gate counts as active work: it holds one of the `maxConcurrent` permits role runs
  use (`VERIFY_TIER`, ahead of any waiting run) for the gate's whole length, and the conflict
  resolver holds another (`MERGE_TIER`) for its run, so merges never add streams to the
  provider beyond `maxConcurrent` plus the director.

Errors keep the commit for re-review, up to three strikes. `tumwater abort --role <id>`
discards a role's in-flight merge and stops the change's gate build check mid-run — an abort
never has to wait a parked check out.

## Scheduling

- **Workspace pool.** Runs and the gate's build checks share `worktreeSlots` pooled workspaces
  (`.tumwater/worktrees/_slot-<n>`, default `maxConcurrent` + 1): each is leased for one run,
  reset to that run's commit, and released back. A role whose run is resumable keeps its workspace
  pinned so the resumed session runs in the same directory; a lease that waits 30 s or more
  logs a `slot_wait` event so `worktreeSlots` can be sized from real contention; `tumwater
  doctor`'s "worktree pool" row sums the last 24 h of those waits and warns once they total 10
  minutes, naming the number to raise `worktreeSlots` above. A workspace pinned longer than a
  day by a run that never resumed is the doctor's `worktree pool` row's stale-pin clause,
  cleared by resuming the role or retiring its leftovers. While every workspace is leased,
  `tumwater status`, the status header and the dashboard's team panel show `workspaces
  <leased>/<worktreeSlots>`, plus `, <n> waiting` when runs queue for one. Outside the pool sit the director's
  own `.tumwater/worktrees/director`, the merge step's `_merge`, the review gate's `_gate-main`,
  the main watch's full-check mirror `_main-full`, and the update mirror and witness (`_main`,
  `_build`). Size the disk for about `worktreeSlots` + 3 warm checkouts of the project.
- **Parallel work instances.** `roles.feature.instances` and `roles.bugfix.instances` (1–8,
  default 3; set 1 for a single runner) run that many instances of the role — `feature`,
  `feature-2`, … (shown as `feature #2`) — each with its own branch and state. An idle extra
  costs nothing: it is skipped without a run while no unassigned entry is eligible (below). The scheduler assigns each due instance one eligible backlog
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
  `instances(feature) + 1` eligible plans ahead (4 at the default) so every feature instance has something to
  take (a due plan run defers while that many are waiting and none is marked needs-review).
  Both counts read `## Planned` as it will be once every unmerged change merges — the merge
  pins and the role branches, never the merge queue — so a plan already waiting to merge stops
  the plan role instead of being re-planned (plans/duplicate-plans.md "Decision" 1). The
  plan run's prompt gives both the target and the current count, the same
  count the deferral uses. `tumwater status` and the dashboard name each instance's assigned entry
  while it is idle or merging, `tumwater logs` renders the `claim` assigned/released events, and
  `tumwater doctor`'s `parallel instances` check warns on an assignment whose entry is gone or stale.
  When a project declares no check, the orchestrator queues the director one automatic request to
  declare one; the plan and feature roles are never asked to plan or build the declaration.
  While a claim names an entry no longer listed, or has sat idle past `CLAIM_IDLE_MAX_MS`,
  `tumwater doctor`'s `parallel instances` row warns on it; it clears when the scheduler's
  next poll releases the claim.
  The row's third warn — an enabled instance role running more than one instance while
  `worktreeSlots` sits below `maxConcurrent` — is the same row's pool clause.
  An idle instance that is paused on its own (by you, or by the repeated-failure pause) gives its
  entry back and a sibling takes it; pausing the whole role keeps every claim.
  Deleting a claimed entry from `## Planned` or `## Open` withdraws it. An instance that still owes
  it a resume or a revision drops that work with a warning and takes its next entry on the same
  poll. Its next run first sets aside what the interrupted run left unmerged (branch commits, an
  unqueued pin) under `refs/tumwater/withdrawn/<role>/<sha>`, so leftover recovery cannot merge
  it; delete those refs once you no longer need the work. A run in flight keeps its claim until it settles. A change for the entry that is queued,
  or that reaches the queue later, is dropped unmerged (`withdrawn`) by its gate, or inside the
  merge lock if the entry goes after the gate.
- `maxConcurrent` caps parallel runs and merges together. Merges go first, then a red-main
  heal run (a `ci` run whose inbox holds a heal prompt — healing main is work, so it is admitted
  ahead of every queued role run even though `ci` otherwise schedules as maintenance), then
  work roles (feature, bugfix, plan), then maintenance roles.
  **Maintenance permit floor.** While maintenance holds fewer than its permit floor —
  a third of `maxConcurrent` (at least 1 from cap 2), the same share the work reserve may claim,
  so 2 at the default 6 —
  the longest-parked maintenance run takes the next free permit ahead of every work run, the
  reserve not withstanding; nothing already running is preempted.
- **No merge interlock.** A role with a queued or in-flight change still authors on the next
  poll: the merge queue is not a scheduling gate, so landing never holds authoring. A fresh run
  resets the role's branch to main, and a second commit by a role with a waiting pin stays on its
  own branch (`heldOnBranch`), so it cannot collide with the change that is landing.
- **One bound.** `maxConcurrent` is the only concurrency bound: a run whose admission waits
  30 s or more because the team is busy logs a `provider_wait` event, and `tumwater doctor`'s
  "provider contention" row sums the last 24 h and warns at 10 minutes. Every wait is a
  team-cap one (the event carries no provider key), and the row files each under "the run
  cap" — `maxConcurrent`, the one knob to raise.
- `maxConcurrentChecks` (default 2) caps how many runs of the project's check are in flight at
  once: pipeline, merge, batch, and main-baseline checks share it, the rest queue, and merges go
  first. A scoped check whose permit wait reaches 30 s logs a `check_wait` event (role, scope,
  waitedMs, and the checks holding the slots and the cap when it parked), and `tumwater doctor`'s "check contention" row sums the last 24 h, names what the waits sat behind (merge, gate or batch checks, or the main baseline), and warns at
  10 minutes, naming `maxConcurrentChecks` to raise. `tumwater report` and the dashboard's Report
  tab show the per-day median of those waits as "Check wait median" (team scope only).
  While a check runs or waits, `tumwater status`, the status header and the dashboard's team panel
  show `checks <running>/<cap>`, plus `, <n> waiting` when checks are queued.
- A bug that bugfix cannot reproduce once it has made the failure message name the cause is
  handed to the director before it is parked for the user: the bugfix run records a Progress note
  and writes `.tumwater-director-request.md` at its worktree root holding the entry's heading,
  every attempted reproduction, and the failure message. The harness queues it as one director
  prompt and deletes the file before staging, so it never enters a diff (INV-B8). The director
  then either explains or reproduces the bug (a Progress note under the entry, which stays open)
  or, when it cannot resolve it, parks the entry with a `**Needs review <date> by director: …**`
  note naming what the user must decide. Only when the request file cannot be written does
  bugfix keep the old park: a `**Needs review <date> by bugfix: …**` note naming what the next
  failure's message will show, which the backlog index marks `[blocked: waiting for a recurrence]`.
  Nothing is asked of a reviewer: the wait ends on its own. When the flake quarantine sees the
  bug's test fail and pass again — the bug's own quarantine entry, or a bug whose heading quotes
  the test name — tumwater records the occurrence (with its output) under the entry and deletes
  the wait note, so bugfix takes the bug again; selfcheck does the same for a failure it finds in
  its digest. A wait that sees no recurrence for 7 days closes the bug to BUGS-FIXED.md
  (`— closed <date> by tumwater`); if it fails again later it is filed afresh.
- A maintenance role whose last run did nothing is deferred until feature, bugfix, director,
  you, or another human's work merges to main (your own `tumwater brief`, `plan`, `bug` and
  `questions answer` edits count as human work), and stays deferred while PLANS.md or BUGS.md has
  work a feature or bugfix instance can take (refused, needs-review and blocked entries do
  not count). `qa`, `selfcheck`, `feedback` and `ci` are never deferred. `bugfix` is not a maintenance role, but while BUGS.md has no
  open bugs it has nothing assigned and defers like one — with the difference that any
  feature, bugfix, director, you or another human wakes it (your own `tumwater brief`, `plan`, `bug`
  and `questions answer` edits count) (a deferral only holds while no qualifying work has merged),
  and that one open bug puts it back on the every-wake schedule.
- The director runs your prompts immediately, outside `maxConcurrent` and ahead of every role.
  With no prompt, a director holding a kept merge pin is also due on its own min-run clock (20 s
  by default) and wakes as `woke (leftover)`; that run re-pins the change and authors nothing.
- `tumwater prompt --role <id>` puts a prompt in one role's inbox for its next run instead of the
  director's, and wakes it. `--list` shows the inboxes grouped by role; per-role prompts
  wait behind a paused role like the director's wait behind a team pause.
- While main's check is failing, every role keeps working: a change merges when it adds no new
  failures, every role's prompt names the failing tests in a `<main-known-red>` block, and a fix
  from any role lands like any other change — `ci` owns the repair without monopolizing it. A
  newly-verified red main queues a ci healer — handed the failing tests when the red
  names them — so the healer starts on the next poll instead of waiting out its interval or
  deferral, once per failing set (not per red commit); that queued prompt no-ops (a "verify
  green" clause) if main turned green before it ran. Separately, the
  `ci` role runs the workflow's own full suite and e2e at main's tip on its own clock and records what
  it covered in the CI-parity ledger. The main-check line on `tumwater status`, the status header and the
  dashboard's team panel carries a `CI: covered <sha> <age> ago` badge as the glance surface (its tone
  follows the verdict) so an operator can tell whether the expensive verification behind a green main has
  actually run on this tip, while `tumwater doctor`'s `ci parity` row (and the dashboard Health card
  that renders the same rows) is the exact surface answering "is main verified by
  CI?" — `current` when the last green run covered the current tip and lock, `stale` while main has since
  moved (still ok, since the ci role runs on its own clock), a `warn` when the last run failed, and a
  `warn` when a `stale` verdict has stayed stale past the stall window — the full suite has silently
  stopped covering new tips, reading the same `parityIsCurrent`
  rule for `current`/`stale` and the shared `ciParityStalled` predicate for the stall, so a `current`
  badge and a `current` prompt block cannot disagree. Separately, the `ci` role reads the hosted CI's
  verdict on the newest pushed commit of the base branch with the operator's own `gh` (read-only,
  only when the base branch's remote is on GitHub and the repo has a `.github/workflows` file, and
  `roles.ci.remote` is not false): its prompt ends with a Remote CI block naming the repo, the
  branch and the `gh run list` command, its reply carries a `REMOTE:` line just before the `CI:`
  line, and the harness records the verdict in the remote-CI ledger (`.tumwater/state/remote-ci.json`):
  the main-check line on `tumwater status`, the status header and the dashboard's team panel carry a
  `github: passed|failed|running at <sha7> <age> ago` badge beside the ci parity badge (its tone
  follows the verdict) so a red push shows at a glance without opening doctor — the badge is empty
  without a record and for an `unavailable` one (no GitHub remote or `gh`), where the doctor
  `remote CI` row is the surface that names the state. When a recorded verdict turns `failed` for
  a commit not already recorded failed, the harness logs a `remote_ci_failed` event that pages the
  operator (one page per commit), and `tumwater doctor`'s `remote CI` row — beside the `ci parity`
  row in the Health card — answers "is GitHub CI green on what I pushed?" from
  the same ledger: ok while the record is fresh and green or still running, a warn on a `failed`
  record and when no check has been recorded for over three days (the one `remoteCiStalled`
  predicate), and ok information when the ci role could not read GitHub Actions at all
  (`unavailable`). The row is omitted when the ci role is disabled, or where there is no
  hosted-CI target (no GitHub remote, no workflow file, or `roles.ci.remote: false`).
  The `qa` observer keeps its own flow-coverage
  ledger the same way, and a coverage ledger whose newest exercise is over three days old raises the
  doctor `qa coverage` warn through the one `qaCoverageStalled`
  predicate. The `feedback` observer's per-install filing ledger gets the same operator read: the
  issues it filed are visible in `tumwater role feedback` and the dashboards' role detail.
- A main watch runs the full check on main's tip in the background (one run
  at a time, covering every commit since the last watched head; the full check runs at most once per
  `check.fullIntervalMinutes` — default 60 — on main's latest tip, only while a non-exempt code
  commit sits above the newest verdict a full check actually produced; `0` restores one full run per
  new code head; the full check owns its own `_main-full` mirror and its own in-flight pass, so a
  per-head diff-rules pass and the review gate's main-tip verdict run in the shared `_gate-main`
  mirror and never wait behind a slow full run; the deterministic diff rules still run on every new
  head, and a red anchor is re-checked on the next new head, never delayed by the hour; a
  red is confirmed once before it counts — by re-running only its failing tests when the project
  declares a re-run command (`check.rerunCommand`, or an npm `test:rerun` script), else the whole
  check; a doc-only tip inherits its green). The heal prompt and ci's `<main-red>` note name that
  re-run command, so the healer reproduces and verifies only the failing tests. While a red is
  open, a new head re-runs only the spell's still-failing tests — never the full check — so an
  hour of red repairs narrows the spell as each failing test passes; when none of the open tests
  fail the red clears as a `main_check` with `cleared: true` and `durationMs` 0 (no full verdict
  written, so the head is not yet deployable) and one confirming full run starts at once on that
  head (Hourly full check part 3b/4). It logs a `main_check` event with the failing test titles and
  saves reds beside the greens in `.tumwater/state/baseline-verdicts.json`. On a red tip it also
  names the commit that opened the red as the culprit — bisecting the first-parent commits since
  the newest full green and re-running only the failing tests at each candidate (Hourly full check
  part 3a/4), so an hour's worth of commits names its breaker instead of the newest head — logging
  a `main_culprit` event with the culprit, its merging runner and the failing tests. Every
  surface that shows main's verdict — the `tumwater status` badge, the dashboard's
  `Main` row and `status --json` — says which SHA the full verdict covers, how long ago it ran,
  and when the next full run is due: ` · full check green at abc1234, 23m ago · next in 37m`,
  read from the newest full check's checked time (its settle stamp) and
  `check.fullIntervalMinutes` (Hourly full check part 4/4); a red is rechecked on the next head,
  so it carries its age but no interval due. A cleared red whose confirming full
  run is still settling reads ` · cleared at def5678 · full check running` instead of quoting a
  verdict, so the badge never implies the newest commit was fully checked while the hour's full
  verdict is older than main. The watch
  also runs the deterministic diff rules' full set — conflict markers, protected edits,
  secret leaks, a false-fix claim on a doc-only tip, and backlog structure — against each first-parent
  commit's own diff in the watched range, attributed to that commit's own merging role; a violation is
  logged as a warning naming the rule and the head (the same reason text the
  gate would reject with), deterministically within one poll, with no confirming re-run. That warning in the trailing day raises `tumwater doctor`'s `main diff rules` row naming the tip and the rule, so a diff the gate let through cannot sit on main unremarked. No run or
  merge waits for the watch. On a red tip it names the opener as the culprit and queues ci's
  heal prompt (Forward, never back, part 4/6): the same `mainRedHealPrompt` wording a red-main
  hold uses — `Main was reported red at commit <sha>; verify main is green now; if it is still
  red, reproduce the failure and land the fix` — naming the commit and the failing tests. A new
  heal prompt replaces the one already waiting in ci's inbox, and a green tip drops the waiting
  heal prompts for reds it contains, so ci never works through a backlog of reds main has
  already passed. Nothing
  is ever taken off main for a red tip, and no revision is handed back or parked for one; the
  only way a commit leaves main is the operator's own deliberate `tumwater revert <sha>`.
  A main left red over 30 minutes is surfaced: `tumwater doctor`'s `main's check` row and the
  selfcheck and feedback observers' shared digest's `## Fast merge guardrails` section report
  how long main has had no passing full check, the sha it has been red since, and its newest
  failing test.
- Every change now merges with no reviewer run before it — the gate is deterministic (see
  **Review.**) — and is reviewed after merging: its change passes the deterministic rejects and
  the gate check, then merges. The `merged` commit
  is recorded in `.tumwater/state/post-review.json`, and the merge poll runs one review at a time
  over `git diff <commit>^ <commit>`. It waits for a team permit ahead of every queued role run, as
  a pre-merge verification does (`review_start`, `review_verdict` and `review_rejected` carry
  `afterMerge: true`). An approval ends it. A rejection never reverts:
  the reviewer's own minimal fix is landed on top of main in the same run, and where the review
  records a finding it cannot repair, the commit stays on main with the reviewer's reasons read as
  that recorded finding. A review that ends three times with no verdict is dropped with a warning.
  Two or more post-merge rejections in a day raise `tumwater doctor`'s `post-merge churn` row
  naming each role — the reviewer-fix signal to raise the authoring bar. A reviewer fix its own
  pre-check withheld is not one of those rejections: its reasons name the reviewer's bytes, and the
  review stays open and re-runs.
  While the reviewer's provider stands under a failure hold, or its strong tier is unresolvable
  under the review gate, the hold parks only the post-merge review queue: no role start, verify
  or landing waits on the reviewer. Every role keeps authoring and its queued changes
  keep draining. The post-merge review queue holds only where that gate's no-role form holds — a
  restart or disk hold, or a hold on the reviewer's provider — and never on the unresolvable
  strong tier, which never reaches the post-merge review queue.
- A test that fails and then passes on the same tree is quarantined at once: the gate's re-run and
the watch's confirming re-run each add the failing tests that passed on the re-run to
  `.tumwater/state/quarantine.json` (newest 100). A quarantined test counts as a known failure
  everywhere: a gate or merge check failing only known tests goes on, the watch records a red
  naming only quarantined tests as passed (`quarantined: [tests]`) with no culprit, and such a red
  is never attributed. The watch files one BUGS.md `## Open` entry per newly
  quarantined test, committed on main under the merge and primary-worktree locks (it warns and
  retries on a later poll when the checkout is dirty or off main). A test leaves quarantine when its
  entry is no longer under `## Open`; a later flake puts it back. The 24 h headline excuse
  (`known-flaky failure, merge kept`) remains for failures that name no test.
  `tumwater doctor`'s `flaky checks` row and the selfcheck digest warn when a quarantined test's
  age passes 3 days (naming the oldest, with its BUGS.md heading or "not filed") or when the list
  holds more than 10 tests. A Fixed record whose quoted test fails again is likewise a standing
  always-on alert (the doctor's `regressed fixes` row) until a day passes or the failure is filed. `tumwater quarantine [--json]` lists the current list — every entry
  oldest first with its age, flake count, last sighting and filed bug.
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
  notify command can page you while there is still room to raise the cap. While a role is under
  its cap and burning, `tumwater role <id>` and the dashboard role drawer state `~cap at
  HH:MM` — the same `projectCapHit` forecast the budget badge carries for the team cap — so
  the cap can be raised before the hold starts.
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
- The model check proves every model pair the team can run on can answer before roles run on
  it (plans/model-check.md). This covers each role's model, the reviewer's and resolver's, and
  every fallback step. When a pair first appears (at start, after a config edit routes a seam to
  it, or when a fallback engages), it gets one short probe, a ~230-token paragraph with a known
  one-word answer, sent through the same backend the runs use. The probe also runs again when a
  run on the pair ends without changes and without declaring nothing-to-do. A pair that gives no
  reply or the wrong one holds its roles, shown as `waiting: model check` on their rows. With
  review on, a failed or still-checking reviewer pair parks only the post-merge review drain —
  no role start, verify or landing waits on the reviewer, so every role on another pair keeps
  running. The failure logs one
  warning quoting the reply, raises a red alert on the dashboard, and shows on doctor's
  `model check` row; the `over-cap model` row then says whether the fallback answered instead of
  "serving not verified". At the cap, a fallback step that failed is skipped like a demoted one.
  The pair is checked again after 1 minute, then at doubling intervals up to 30 minutes. Once it
  answers, its roles run again on their own (`model_check_passed` in the feed). A probe that stays
  silent while the same pair is answering the team's own runs is queueing, not a dead server: the
  pair keeps its verdict, nothing is held, and the feed reads `model_check_busy`. The verdicts and
  the back-off they earn are kept in `.tumwater/state/model-checks.json`, so a restart — including
  a self-redeploy — holds a failed pair on the wait it already earned instead of probing it again
  from the first interval, and a verdict older than the check's suspicion interval is re-probed
  rather than trusted. The check runs
  for `tumwater start`, not for a `--once` round. The failed pair's dashboard banner offers a
  `Re-check now` button, which asks the running team to probe the failed pairs immediately
  instead of waiting out the back-off.
- Model failure fallback is separate from the budget gate above, triggered by health rather
  than spend: when one role's runs fail with provider-class errors (429s, and connection,
  timeout, server, model-load, and stream-severed backend failures) three times in a row, its
  next runs use its tier's resolved `fallback` pair while the primary is probed. Once the
  5-minute cooldown elapses, the next run uses the primary as the probe — a real run, not a
  separate canary request — and an answering probe returns the role to the primary. The episode
  is per role and never moves the director; `tumwater status`, the dashboard, and
  `tumwater role <id>` name the off-model pair, its start, and the tripping reason.
- `quietHours` (default off; absent or empty) is a daily local-time window, `"HH:MM-HH:MM"`,
  during which roles start no new runs — a run due inside the window starts at window
  end, and a window may wrap midnight (`"23:00-07:00"`). The director is exempt, exactly as
  under the budget gate and a pause you set. Edits apply live, and each crossing into or
  out of the window logs one `quiet_hours_started` / `quiet_hours_ended` event in the feed.
- `diskHoldGB` (default 10; 0 disables) is the free-space floor, in GB (10^9 bytes), for the
  volume holding `.tumwater/worktrees`. When free space drops below it, no new work starts —
  role runs, the director and the merge drain — until free space climbs 5 GB back above
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
  surfaced on `status` and the dashboard (a per-role pause carries no reason). The
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
recover the same way, and so do runs the watchdog stops as stalled, up to three in a row. A run
that ends before tumwater can account for its workspace (a crash, or tumwater's own git commands
failing, as when the machine runs out of processes) leaves its uncommitted edits in the
workspace. A crashed run's workspace is held for its role, and the restart resumes the run in it.
Otherwise the next run to use that workspace saves the edits as a patch under
`.tumwater/salvage/pending/<role>/`, and the role's next run gets them back in a fresh session
told they are there. If the role's branch has moved since, files that clash come back with
conflict markers, and hunks git cannot place arrive in the prompt to apply by hand. The role
resolves both like any conflict. Edits nothing gives back (ones a run chose to discard, or a
check's scratch files) are saved directly under `.tumwater/salvage/` for you to read. Those kept
patches are surfaced until session retention prunes them: a doctor `salvage patches` row and the
standing amber `salvage-patches` alert on `tumwater status` and the dashboard name them
(capped, with a count of the rest), so work a run left behind is never silently discarded. Both
kinds are deleted with the session store by the `sessionRetentionDays` pass, which also ages out
each role's pi session files, its session ledgers and the full-output files kept for oversized
tool results, and purges the expired OpenCode and Codex sessions each backend's ledger names. It
runs at start, once a day while the team runs, and at once whenever you change the window (0
disables it); the pass blocks the poll loop while it runs, so it writes a progress marker and
logs one `maintenance_start`/`maintenance_done` event pair per half that has work. An
interrupted merge goes back through the pipeline, and an interrupted director prompt goes back to
its inbox. In the merge pipeline too, git commands that fail never read as "nothing there": a
conflict list, a change's diff or a resolution's diff that git cannot produce fails that merge or
review instead of letting unreviewed or unchecked work through, and the change stays unmerged for
its next attempt. When git cannot start at all, a revision waits for its role's next run and a
post-merge review for the next poll, neither counted as failed. A queued change whose merge ends
blocked, in a review error, or in a conflict that stays under the limit is put back in the merge
queue by the pipeline itself, at once, with its original summary and no author run; a review error
waits 60 s first. A pin-only change whose merge ends that way keeps its pin, and the next poll
retries it the same way. A change kept because main's check was failing goes back once main's head
moves. A commit left unmerged by a crash or a restart (or one before it was queued) is re-pinned at
the role's next run, which ends there instead of authoring, so the one merge step stays main's only
writer. The director's next run is otherwise only ever your prompt, so while it holds a kept commit
it is also due on its own min-run clock. A commit whose last three merges all hit conflicts that
conflict resolution could not settle is dropped instead, and the role's next prompt says so.

## Updates

When the project being built is tumwater itself, the team notices when main's code differs from
the running build and shows `Update available`. With `autoRestart` (default true) it confirms
main's check passes, compiles it, finishes in-flight runs, swaps the new build into `dist/`, and
restarts, at most once every 4 hours. The commit it builds is main's newest one whose full check
passed and that is newer than the running build, so a red tip does not stall an update that an older
green commit allows. With the main watch on (the default whenever `check.gateCommand` is set),
that verdict is the watch's: the update waits for the watch to call a newer commit green and runs
no check of its own. Until it does — main's check timing out under load, or failing — the running
build is current against the newest green commit, so instead of `Update available` the status
shows `update waiting`: main's tip, how many commits it is ahead, and that no newer commit has
passed main's check yet. The `Main` row (and doctor's `main's check` row) says why. The restart cooldown is a rate limit against restart storms, not a work stop:
while a restart merely waits out its cooldown, the team keeps authoring and merging on the running
build (it has been executing that build all along), and only the redeploy itself — the drain and the
swap — waits. With the main watch off, a failing check on main (with no green commit newer than the running build) or a failed compile keeps the old
build running and shows `restart BLOCKED`, with the reason. You do not have to wait out the
4-hour clock: the dashboard's update alert has a refresh button that waives the cooldown
and starts the pending update immediately — every other gate (a passing check on main, a
successful compile, in-flight runs finishing) still applies. From the terminal, run
`tumwater restart` to press the same button: both write the marker the redeployer consumes.

`tumwater gui` follows the swap: it re-execs onto the new `dist/` within a
second, and only onto a build stamped with a real commit of the repo. Because the team executes
your checkout's own `dist/`, `npm test` refuses to run in that checkout while the team is up (the
suite's first steps recompile and restamp `dist/`), so run suites in a worktree.

## Prompts

Every run carries PRINCIPLES.md, which only the director and steward edit. Prompts are written
for a mid-sized model with a finite context window: tool-call budgets, ranged reads of large
files, and bundled pi extensions that trim oversized tool output to its head and tail and, on
a model with a window of at most 256k, stop sending the model's earlier thinking back to it.
The file is capped for injection, so an over-cap PRINCIPLES.md silently degrades every run's
design guidance. The orchestrator then queues the director (the role allowed to edit it) a
one-shot consolidation prompt — read the file whole, merge overlapping rules, drop superseded
wording, keep every active rule in its positive voice and keep the measured Budgets facts, and
land a version under the cap — one at a time, not one per poll, while `tumwater doctor`'s
`principles` row still warns on the over-cap state.
The status table's `peak ctx` column reads each run against the role's declared window
(`110.0k (84%)`), so an operator can see how close a run came to where pi compacts it.

Every run gets a compact prompt, whatever model it runs on. Its rules keep every directive in
few words, its principles block keeps only the bullets, and it leaves out the brief block, since
the brief file holds the same text. A run that tumwater assigned one backlog entry also goes
without the backlog index and reads its entry first. pi's system prompt loses its section about
pi's own documentation. Each turn re-sends the whole prompt, so the shorter one saves tokens on
every turn of every run.

Each role also has notes: a short, model-written note its own earlier runs left for the
next fresh session (where things live, what was ruled out, what to look at next), and lessons:
the durable conclusions a role's earlier runs kept (a still-true, reusable lesson, not a
point-in-time recollection) — the operator twin of the `<role-lessons>` block a run is asked to
check before acting on them. They live at `.tumwater/state/notes/<role>.md` and
`.tumwater/state/notes/lessons/<role>.md` respectively. The note is capped at 4 KB; a lessons
store holds at most 12 lessons of at most 300 bytes each (2 KB whole file). A run sees the note
when one exists, along with the day it was last saved and how many days ago that was, and may replace it
by running `tumwater-notes write` on every backend; it may add, replace, or retire a lesson with
`tumwater-notes lesson add` / `replace` / `retire`, and sees its stored lessons in the run prompt
before the note. The director, whose work is your prompt rather
than a recurring search, has neither. When a note runs past the 4 KB bound (a hand edit or an old
build), the next run sees only its head plus a truncation marker while every operator surface reads
the file whole — `tumwater doctor`'s `role notes` row warns on that over-bound state (and on a lessons
file grown past its 12-lesson / 2 KB store caps, which the role's own `add` will now refuse), and
`tumwater status --json` carries the over-bound roles as a `roleNotesOverCap` array. You can clear or replace a note with
`tumwater role <id> --clear-notes` or `--notes-file <path>`, and empty a role's lessons with
`--clear-lessons` (it leaves the note untouched); a run in progress at that moment may
still overwrite them through its own `tumwater-notes` call. When a note names an entry or series of
the backlog, the run prompt also shows the current backlog state of each thing the note names
(PLANS.md and BUGS.md as of that run), right after the note, so the live state wins where the two
disagree — a note cannot keep telling a role to skip an entry the operator has since lifted.

Right after the note, a run also sees a `<since-last-run>` block generated from git: what has
merged to main since the role's last run. It reads the range once (a bounded `git log`), lists the
commits newest first and the files they touched most-touched first, and notes how long ago the
role's last run ended, its result, and its summary. It is meant to sit beside the unverified
recollection of the note and make its currency explicit — the block is current, the note is a
prior session's memory, so a role skips re-reading what already holds but re-reads any file it
plans to edit that the block lists. An assigned run's entry names the files it will touch, and
those lead the file list. The block is left out on a first run, when main has not moved since the
anchor, or when git cannot read the range — its absence never fails a run.

## Configuration

`tumwater.json` is untracked and seeded from the tracked `tumwater.example.json`; edit the example
to share a baseline with collaborators. It sets enabled roles, provider, model, and thinking level
(globally or per role), run intervals, sleep lengths, and the settings above. Edits apply within
~2 s while the team runs, and each one logs a `config_changed` event. From the terminal,
`tumwater config get <key>` reads one resolved value, `tumwater config set <key> <value>`
writes one, and `tumwater config unset <key>` removes one (the inverse of `set`, so a value
reverts to its default or disappears from its map or section); `tumwater config edit` rewrites
the whole file, opening it in `$VISUAL`/`$EDITOR` or taking its replacement from `--file <path>`. All
of those writes go through the same lock, validation, and atomic write, so you never have to
hand-edit the file — even a bulk multi-key edit is validated the way a load does before it lands. A broken or missing
`tumwater.json` while the team runs keeps the last good config, logs the load warning, and
raises the standing amber `config-problem` alert on `tumwater status` and the dashboard
(with the load error or the missing-file sentence as the status `configProblem` field)
until a valid file loads again — so a live edit gone bad never silently leaves the team on
stale settings.

- **Custom roles:** add `customRoles` entries by hand or by prompting the director ("add a role
  named X that does Y"). The web dashboard marks them with a `custom` tag.
- **Backend binary:** each backend resolves its own: `TUMWATER_<ID>_BIN`, then `backends.<id>.bin`
  (pi also reads the legacy top-level `agentBin`), then the backend's default binary (`pi` or
  `claude`) on PATH.

## More controls

- `reset-counters` zeroes runs, commits, tokens, and cost without touching the schedule (the
  dashboard's Roles card and role drawer reach the same reset). `wake` does the opposite: it ends
  every role's sleep so they run within one poll.
- `gui --all-interfaces` has no authentication unless you pass `--token <secret>`. Clients send the
  token as `Authorization: Bearer <token>` or `?token=`.
- The web dashboard opens on Team: alerts for whatever needs you — a spent budget, a failing or
  stuck role, a stopped team, disk and install drift, orphaned processes, open questions, refused
  entries, running on the fallback chain, a model that failed its model check, a stalled poll
  loop, the GitHub-issues mirror family (no `gh`, a failed scan, a scan gone quiet, issues the
  director has not declined and has not mirrored, fixes waiting on a push), the background
  maintenance pass, and the standing doctor
  twins `no-check`, `no-brief`, `brief-truncated`, `role-notes-truncated`, `salvage-patches`,
  `instance-pool` and `config-problem` (`teamAlerts` in `src/ui/team-alerts.ts` and its per-domain
  builders; `tumwater status` renders the same set). Main's newest check verdict is not an alert:
  it is the sidebar's `Main` row and the header badge. What stays in the report rather than the
  band — one `tumwater doctor` row each — includes stale questions, a stalled entry, a broken plan
  dependency clause, a stranded plan, a duplicated heading, finished history, a bad Validation gap
  trace, a false Fix, a stale claim, a regressed fix, an over-cap PRINCIPLES.md, and a provider
  hold; a stale build, a pause and quiet hours ride in the header badges and their own doctor rows
  (`update`, `pause`, `quiet hours`) instead. The
  band names the same `needsYou` count the tab's badge and the page title carry, and — while it
  has alerts — shows one `Open Health check` control next to it that routes through the existing
  view/hash path to the Settings view's Health check card (`#doctorcard`), which keeps each
  alert's detail as a `tumwater doctor` row. Then the prompt
  box, today's progress, the roles grouped by what they are doing,
  the backlog, and the notable activity — a `Role picker` and a case-insensitive Search box narrow
  the events the card carries, and an active picker or Search filter also searches the log's
  recent slice through `/api/logs` (well past the events a status poll carries), persisted like
  the Notable/All choice (which culls routine bookkeeping via `eventKind(it) !== "routine"` —
  the same rule `tumwater logs --notable` uses).
  A Window picker (last hour / 6 hours / day) shows that trailing
  window's events through `/api/logs?sinceMs=`, the twin of `tumwater logs --since`, refreshing
  when a new event arrives. Its ◀ Earlier / Later ▶ buttons step that window back by its own length through
  `/api/logs?sinceMs=&untilMs=`, the twin of `logs --since --until`, and a stepped window does not
  refresh. The Inbox tab lists each queued prompt and how long it
  has waited, and each row can be edited in place — Edit loads the prompt's body, Save replaces it
  through the same path `tumwater prompt --edit` uses — and can be moved to the front of its role's
  queue, the same reorder `tumwater prompt --top` makes, addressed by the row's queue file; an open question's Answer button opens its
  drawer, whose Record answer form writes the decision to QUESTIONS.md as `tumwater questions
  answer` does. The Backlog card's Plans and Bugs tabs each carry a Ready only toggle that
  keeps only the entries an operator could pick — hiding their held/`Blocked (n)` section while
  every entry action still addresses the whole-file position — the browser twin of `tumwater
  backlog --ready`, and a Held only toggle
  beside it that inverts the view to just the rows a hold keeps from being picked, the twin of
  `tumwater backlog --held`; the two are mutually exclusive and
  each is remembered across reloads like the Search box. Clicking a role opens its details — its notes and next run's prompt included — and, for the
  `qa` role, its flow-coverage ledger (each flow it exercises with its last exercise age and
  result, the same rows `tumwater role qa` prints) — and
  its live transcript (`#role/<name>` links straight to it). A "Show prompts" button re-reads it through
  `GET /api/transcript?…&prompt=1` with each agent run's prompt, the text `tumwater logs --transcript <id> --prompt` prints; `&grep=<text>` keeps only the entries containing the text, each under its run's separator, as `tumwater logs --transcript <id> --grep` does. The role drawer's search box sends that `&grep=`. Its History, Usage, Failures, and
  Pending views match `tumwater history`, `tumwater report`, `tumwater report --failures`, and
  `tumwater diff`; the Failures view lists the current flake quarantine below the digest, each
  entry with a Release button, the browser twin of `tumwater quarantine --release <n>`; the Pending view also paints the merge queue as a card
  with a Role picker that keeps only the chosen role's waiting merges, each under its
  whole-queue position, and the files two or more roles' pending changes touch as an Overlapping files card mirroring
  `tumwater diff --overlaps` (`GET /api/diff?overlaps=1[&role=<ids>][&path=<path>]`; clicking a listed file shows each role's change to it, `GET /api/diff?role=<id>&path=<path>`, the twin of `diff --role --path`; its Role picker keeps only the files the chosen role holds, each still naming every holder, the `diff --overlaps --role` twin, and its Folder picker keeps only the files at or under the chosen directory, the `diff --overlaps --path` twin), and shows a role's full unmerged patch in its drawer (its Stat only toggle shows the diffstat instead, `GET /api/diff?role=<id>&stat=1`, the twin of `diff --role --stat`), which also lists that role's waiting merges
  under their whole-queue positions. It also paints the
  post-merge review queue as a Post-merge reviews card mirroring `tumwater reviews` with a Role picker that keeps only the chosen role's entries, the `tumwater reviews --role` twin, and a State picker that keeps only the chosen states — waiting, failing, rejected, each entry counted in the first state it matches — the `tumwater reviews --status` twin — the merged
  commits put aside for post-merge review, each row naming the wait since the
  commit was queued for review (`<age> ago`, omitted for an entry an older file wrote without a
  timestamp), each with its rejected (stays on main with the reviewer's reasons) or failed-review status, and each row a two-click Accept posting
  `POST /api/post-review-accept`, the browser twin of `tumwater reviews --accept <n>` (which names
  the deliberate accept-unreviewed action). A review one failed run from the
  `POST_REVIEW_FAILURE_LIMIT` drop is surfaced by the `post-merge reviews` doctor row, and a
  review the drain actually drops leaves its commit on main unreviewed.
  Its Settings view shows the
  curated top-level config keys (provider, model, fallback, the daily spend cap, quiet hours, the
  notify hook) with inline Save and Clear buttons: Save writes through the same path `tumwater
  config set` uses, and Clear retracts through the same path `tumwater config unset` uses, so the
  field reverts to the key's default (unsetting the daily spend cap restores the default 50). The
  view also runs `tumwater doctor`'s checks on each open in a `Health check` card, with a Re-run
  button. Its Re-sync install button is the twin of `tumwater doctor --resync-install`
  (POST /api/doctor-resync-install through the same `resyncRootInstall`) — the repair for the
  `install` amber alert, which reads the drift live and clears once the install lands. The view
  also lists disabled roles that still keep a worktree, branch, merge ref, or
  paused marker, each with what `tumwater retire` would remove and a two-click Retire button; a
  role the safety rails object to shows the objections and the `--force` command instead,
  because the dashboard never forces. Its `GitHub issues` card reads the mirror's ledger file
  through `GET /api/issues` — the browser twin of `tumwater issues`, the same read and the same
  numbering — naming the mirror's counts and each issue's number, title, trust, mirror state and
  age; it never calls `gh`, since the hourly scan and the doctor's check are `gh`'s only callers.
- Review runs show as `── review @ <ts> ──` in role transcripts.
- Runtime state lives in `.tumwater/` (gitignored). Durable state lives in tracked markdown and
  `tumwater.json`.
