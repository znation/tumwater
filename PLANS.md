# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. The
harness renders it read-only; the roles that act on it are plan (adds and retires `## Planned`
entries), feature (claims, completes, refuses, and reports plan defects on `## Planned`), and bugfix
(claims, fixes, and refuses `## Open`). Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### Release version display, part 3/3: `tumwater status` and `tumwater start` name the npm release version too (planned 2026-11-17 by the operator; requires Release version display part 2/3 and Remove the TUI part 1/5 landed; touches src/ui/badges.ts src/ui/gui/gui-client-team.ts src/cli/cli-start.ts test/badges.test.ts test/gui-client-sidebar.test.ts test/status-render.test.ts test/cli-start.test.ts)

**Goal.** After part 2/3 the GUI and `doctor` say `0.8.1` for a release build, while
`tumwater status`'s header still says `build a1b2c3d4` and `tumwater start` still announces
` · build a1b2c3d4`. This part brings those two in line, so every place that names the running
build agrees. It waits for Remove the TUI part 1/5 because the TUI header renders through the same
`buildBadge` (via `renderStatusSpans`) and that part rewrites src/cli/cli-start.ts: once the TUI
is gone, changing the badge changes only `tumwater status` and the GUI tooltip, and the two plans
never edit the same lines at once.

**Approach.**
- `buildBadge` (src/ui/badges.ts) leads with `, version 0.8.1 (build a1b2c3d4)` when
  `build.release` is set, using part 2/3's `buildLabel` for the version, and keeps
  `, build a1b2c3d4` otherwise. Every suffix (update available, waiting for check, restart
  blocked or pending) follows the lead unchanged. `tumwater status` (renderStatus,
  src/ui/status-render.ts) picks this up with no change of its own.
- GUI tooltip (src/ui/gui/gui-client-team.ts): part 2/3 built the tooltip's lead itself because
  `buildBadge` could not change yet. Go back to deriving it from the badge, stripping either lead
  word (`/^, (?:build|version) /`) after `Running version `, so the tooltip text stays exactly
  what part 2/3 shipped (`Running version 0.8.1 (build a1b2c3d4)` for a release, today's text for
  a checkout) and the badge is again its one home.
- `tumwater start`'s announcement (src/cli/cli-start.ts, today
  `` ` · build ${shortSha(redeploy.build.sha)}` ``) reads ` · version 0.8.1 (build a1b2c3d4)` for
  a release build and keeps ` · build a1b2c3d4` otherwise. If Remove the TUI part 1/5 moved this
  line, change it where it now lives.

**Acceptance criteria.**
- `buildBadge` returns `, version 0.8.1 (build aaaaaaaa)` for a release build, with each existing
  suffix appended unchanged, and today's string for every existing case in test/badges.test.ts.
- `renderStatus` on a snapshot with a release build shows `version 0.8.1 (build aaaaaaaa)` in its
  header; a checkout build's header is unchanged.
- The GUI row title for a release build is still `Running version 0.8.1 (build aaaaaaaa)`, and
  every existing tooltip assertion in test/gui-client-sidebar.test.ts passes unchanged.
- `tumwater start`'s announcement names `version 0.8.1 (build aaaaaaaa)` for a release build and
  ` · build aaaaaaaa` for a checkout build.
- Manual check: with the tarball install from part 1/3's check, `tumwater status` and the line
  `tumwater start` prints both name the installed version.

### `isMergeClaim`'s fail-closed boolean shape guard is pinned in test/merge-queue.test.ts, so a regression in the one home of "is this a well-formed backlog-claim trailer" the queue's file reader (`isMergeEntry`, which validates each entry's `claim`) and the commit-trailer reader (`claimOf`) both apply would be caught at the gate rather than as a torn or foreign claim the readers silently admit (planned 2026-11-16 by the plan role; the pin-a-rule the retired bad-anchor `isMergeClaim` entry's defect note flagged as "a different entry than this one" — the real boolean guard, not the 3-arm refusal-string builder that entry described)

`isMergeClaim` (src/merge/merge-queue.ts) is a **fail-closed boolean shape guard** — `isJsonObject(v) && (v.file === "PLANS.md" || v.file === "BUGS.md") && typeof v.key === "string" && typeof v.title === "string"` — with **no direct test** (`grep -rn isMergeClaim test/` prints nothing on this entry's base). Its two live readers — the queue-file reader `isMergeEntry` (same file, which validates `e.claim`) and the commit-trailer reader `claimOf` (src/git/commit-message.ts, `isMergeClaim(value) ? value : undefined`) — each consult it, and the existing `claimOf` trailer test (test/commit-message.test.ts) pins the valid arm, the wrong-`file` arm (`file: "NOT.md"` → absent), and the not-JSON arm, but never a non-string `key` or `title` or a non-object — those arms of the guard are unpinned, and `isJsonObject` (src/files/json-object.ts) accepts any plain object, so the `file`/`key`/`title` field checks are the only shape discipline. A regression that loosens one of them (say, dropping the `key`/`title` string checks) would let a torn or foreign claim — or a hand-made `Claim:` trailer — pass a reader meant to admit only a well-formed backlog claim, and no existing test catches it. The L23 bar (0 direct refs and an arm the readers leave unpinned) is met.

- **Approach**: in test/merge-queue.test.ts, add `isMergeClaim` to the existing import from `../src/merge/merge-queue.js` (the file already imports `isPriorReview` and the other queue functions from there) and pin the guard directly against a minimal claim object. Exact expected values (hand-computed from the guard's four conditions): a well-formed claim `{ file: "PLANS.md", key: "alpha", title: "Alpha" }` → `true`; the same with `file: "BUGS.md"` → `true`; a non-object (`null`, a JSON array, or a bare string) → `false`; a `key` that is not a string (a number) → `false`; a `title` that is not a string (an object) → `false`; and a claim whose `file` is a non-backlog file (`"NOT.md"`) → `false` (the arm the trailer test already pins end-to-end, kept here for the guard's own completeness). Each case asserts the boolean directly.
- **Acceptance criteria**:
  - test/merge-queue.test.ts passes with the cases above.
  - The `key`-not-a-string and `title`-not-a-string cases each return `false`, and would fail if the guard dropped the `typeof v.key === "string"` / `typeof v.title === "string"` checks — the two arms no reader test covers.
  - The non-object cases (`null`, a JSON array, a bare string) return `false` (and would fail if the guard dropped the `isJsonObject(v)` check), and the valid `PLANS.md` and `BUGS.md` cases return `true`.
  - No other entry pins the guard: after this entry's change, `grep -rc isMergeClaim test/` matches only test/merge-queue.test.ts (the new test this entry adds) — the earlier `isMergeClaim` pin is already retired as a plan defect (it described a 3-arm refusal-string builder that is not on main), and `test/commit-message.test.ts`'s `claimOf` test reads the guard only indirectly through the trailer, never naming it — so this is the first direct pin, not a duplicate.
  - `npm run test:gate` passes.

### Visible session cleanup, part 1/3: the retention prune writes a progress marker and logs start and finish events (planned 2026-11-16 by the operator; touches src/paths.ts src/orchestrator/retention.ts src/agent/session-ledger.ts src/events/events.ts src/events/event-labels.ts src/events/event-format-hold.ts test/session-ledger-prune.test.ts test/retention.test.ts test/event-format.test.ts test/event-labels.test.ts)

**Goal.** On 2026-11-16 the kde-macos8.6-theme team looked stuck after a restart: a running
orchestrator, no paused marker, no alerts, no role started, director prompts waiting in the inbox
and nothing in the event log after `orchestrator_start` for over an hour. The cause was the
session-retention prune (`RetentionPruner.prune`, src/orchestrator/retention.ts), which runs in
the constructor at startup and from `poll()` once a day. Its `pruneCodexSessions`
(src/agent/session-ledger.ts) runs one synchronous `spawnSync(codex, ["delete", "--force", id])`
per expired session: 3,944 ids at about 0.9 s each, about 75 minutes with the poll loop blocked.
No role was scheduled (the director included), nothing was logged until the one summary warning
at the end, and `orchestrator.json` and the role states stayed frozen. The operator restarted
three times, and each restart threw the work away. `pruneOpencodeSessions` has the same shape.
The blocked loop can still write files between two synchronous deletes, so this part makes the
prune report its progress to disk, for the separate (responsive) GUI and TUI processes to read in
part 2/3.

**Approach.**
- New `maintenancePath(root)` → `.tumwater/state/maintenance.json` in src/paths.ts, next to
  `orchestratorStatePath`.
- Marker shape (export the type from the module that writes it):
  `{ pid, task: "session-prune", backend: "codex" | "opencode" | "files", done, total, startedAt,
  updatedAt }`. `pid` is the orchestrator that wrote it; `task` leaves room for later blocking
  housekeeping; `total` is known up front because the expired-id set is built before the delete
  loop; `startedAt` is the start of the whole prune pass.
- `pruneCodexSessions` and `pruneOpencodeSessions` take an optional `onProgress(done, total)` in
  their options. They call it once with `done = 0` after the expired set is built (only when
  `total > 0`) and after each id they handle. They stay free of path knowledge.
- `RetentionPruner.prune` writes the marker before the OpenCode half, passes an `onProgress` that
  rewrites it with `writeJsonAtomic` (throttled: at most once per second or every 25 ids,
  whichever comes first, plus the final id), sets `backend: "files"` for the file and ledger-line
  passes, and removes the marker in a `finally`. Marker writes are best-effort: a failed write
  never fails the prune (this runs in the poll loop, where a throw ends the team).
- Events, so the log is not silent: `maintenance_start { task, backend, total }` when a half has
  work (`total > 0`), and `maintenance_done { task, backend, done, durationMs }` when it finishes.
  Add both to the events.ts type union with doc comments, labels in event-labels.ts, and
  formatting beside the hold formatters in event-format-hold.ts. Keep the existing
  `deleted N expired codex sessions` warning.

**Acceptance criteria.**
- `pruneCodexSessions` and `pruneOpencodeSessions` call `onProgress` with a monotonically
  increasing `done` ending at the final `total`, and never call it when nothing is expired.
- With a stubbed slow delete, `maintenance.json` exists while the prune runs (carrying the
  orchestrator's pid and a rising `done`) and is gone afterwards, including when a delete throws.
- A prune with work logs one `maintenance_start` and one `maintenance_done` per half that had
  work; a prune with nothing to delete logs neither.
- `maintenance_start`/`maintenance_done` format through the hold formatter, and the legacy-event
  table (src/events/event-legacy.ts) is unaffected.

### Visible session cleanup, part 2/3: the GUI and TUI show a session-cleanup banner with progress and an ETA, and idle rows read `held: session cleanup` (planned 2026-11-16 by the operator; requires Visible session cleanup part 1/3 landed; touches src/status/status-data.ts src/ui/team-alert-status.ts src/ui/status-model.ts test/status-data.test.ts test/team-alert-status.test.ts test/team-alerts.test.ts test/status-model.test.ts)

**Goal.** Whenever the prune blocks scheduling, the dashboard says so, shows progress and
estimates when it will finish, instead of a healthy-looking team doing nothing. The prune blocks
the whole poll loop, not one role, so it is a team alert banner (the `TeamAlert` model,
src/ui/team-alerts.ts), which the GUI banners and the TUI's attention lines both render. The roles
table changes too: otherwise its rows show their last-known phase (`idle`, overdue `next run in …`
countdowns), which is the misleading part.

**Approach.**
- src/status/status-data.ts: add `maintenance?: MaintenanceMarker & { etaMs?: number }` to
  `StatusSnapshot`, read fresh on every poll like the pause marker (no cache). Treat it as absent
  when its `pid` is not the live orchestrator pid: a SIGKILLed orchestrator skips the `finally`,
  and its stale marker must not hold the banner up forever.
- `etaMs = (updatedAt − startedAt) / done × (total − done)`, left out until `done ≥ 10` so the
  first noisy samples give no silly ETA.
- New alert in src/ui/team-alert-status.ts, emitted early in the order because it explains every
  other symptom: `key: "maintenance"`, `tone: "blue"` (it informs; there is nothing to do), title
  `Cleaning up expired sessions — roles start when it finishes`, detail like
  `deleting expired codex sessions: 1,204 / 3,944 · about 48 min left · started 22:38`, with the
  suffix `Restarting tumwater starts this over.` (that line is what would have prevented the three
  restarts; Fast session cleanup part 1/2 drops it). No actions: a "skip for now" button would need
  the blocked orchestrator to read a request.
- `rolePhase` (src/ui/status-model.ts) takes one more team-wide hold argument beside `restartHold`
  and returns `held: session cleanup` for every row that is not in flight. A run already in flight
  when a daily in-poll prune starts keeps its working label, because its agent process is still
  running. Its one call site derives it from the snapshot (src/ui/status-model.ts, where
  `restartHoldRolePhase(snap.build)` is passed), so the GUI and TUI rows both pick it up.
- The TUI gets the alert through `alertLines` and the row cell through the shared `rolePhase`, with
  no TUI-specific change.

**Acceptance criteria.**
- A marker whose pid differs from the live orchestrator pid reads as absent; no marker file reads
  as absent; the ETA is absent below 10 deletes and present from 10.
- The maintenance alert's title, detail (count with thousands separators, ETA, start time) and
  restart suffix match the text above, and it sorts ahead of the other status alerts.
- `rolePhase` returns `held: session cleanup` for an idle row and for a row with an overdue next
  run while the hold is set, and keeps the working label for an in-flight row.
- Manual check: about 4,000 expired Codex ledger records and a stub `codex` that sleeps 1 s.
  Start the team and open the GUI. Within one GUI poll the blue banner shows
  `deleting expired codex sessions: n / N` with a rising count and, after 10 deletes, an ETA;
  every idle row reads `held: session cleanup`; the event log has a `maintenance_start` line.
  SIGKILL the orchestrator: the banner goes once the GUI sees the pid gone, and the stopped-team
  alert replaces it.

### Visible session cleanup, part 3/3: an amber "orchestrator hasn't polled" alert when the poll loop stalls without a marker (planned 2026-11-16 by the operator; requires Visible session cleanup part 2/3 landed; touches src/paths.ts src/orchestrator/orchestrator-poll.ts src/status/status-data.ts src/ui/team-alert-status.ts test/status-data.test.ts test/team-alert-status.test.ts)

**Goal.** Parts 1/3 and 2/3 cover the session prune. The next synchronous pass that blocks the
poll loop will have no marker, and the team will look healthy and idle again. A heartbeat gives
the observers a generic backstop.

**Approach.**
- At the top of each poll (src/orchestrator/orchestrator-poll.ts), stamp
  `{ pid, lastPollAt }` into a new small `.tumwater/state/heartbeat.json` (`heartbeatPath(root)`
  in src/paths.ts) with `writeJsonAtomic`, rather than rewriting the larger `orchestrator.json`
  every ~2 s. Best-effort: a failed write never fails the poll.
- status-data reads it fresh each poll. Observers raise an amber alert,
  `Orchestrator hasn't polled for 3m — it may be blocked`, when the orchestrator pid is alive,
  the heartbeat's pid matches it, `lastPollAt` is more than 3 minutes old, and no maintenance
  marker stands. The marker wins because it is the more specific explanation. No heartbeat file at
  all (a team started by an older build) raises nothing.
- Before settling on 3 minutes, measure the longest synchronous poll step that is not a prune on
  a live team (the doc assumes a merge's check runs as a child process and does not block the
  poll; confirm it) and record the measurement in the constant's doc comment.

**Acceptance criteria.**
- A live pid with a 4-minute-old heartbeat and no marker raises the amber alert; a 1-minute-old
  heartbeat does not; a dead pid does not (the stopped-team alert covers that).
- With a maintenance marker standing for the live pid, the heartbeat alert is suppressed and the
  blue maintenance alert shows instead.
- A missing heartbeat file raises nothing.

### Fast session cleanup, part 1/2: the session prune skips placeholder and already-gone Codex sessions, walks the rollout tree once, and resumes where a restart stopped it (planned 2026-11-16 by the operator; requires Visible session cleanup part 2/3 landed; touches src/agent/session-ledger.ts src/agent/codex/codex-rollout.ts src/agent/codex/codex-backend.ts src/orchestrator/retention.ts src/ui/team-alert-status.ts test/session-ledger-prune.test.ts test/retention.test.ts test/team-alert-status.test.ts)

**Goal.** Visibility explains a long prune; this makes it short and restart-safe. On 2026-11-16
half of the 3,944 expired Codex ids had no rollout left (earlier, interrupted passes had already
deleted them) yet each still cost about 1 s of `codex delete`. And because ledger lines are
trimmed only after the whole pass, every restart started the 75-minute pass over.

_Amended 2026-11-16 by the operator: added the placeholder-id skip and the single rollout walk,
from bugs found while diagnosing the same stall._

**Approach.**
- In `pruneCodexSessions`, skip every id that is not a Codex thread UUID before any lookup or
  spawn. A fresh Codex run's pre-spawn ledger record carries the session *name* as its id
  (src/agent/agent-spawn.ts, `invocation.sessionId ?? opts.sessionName`; the streamed UUID is a
  second record), and `codex delete --force <name>` always refuses (`--force requires a session
  UUID`). On 2026-11-16, 5,488 of 11,003 Codex records were placeholders and 875 of the expired
  ids were names. Move `THREAD_ID_RE` out of src/agent/codex/codex-backend.ts into
  codex-rollout.ts (which session-ledger already imports, so no import cycle) and use it in both
  places. The placeholder lines are still trimmed by `pruneSessionLedgers` as today. (Resume is
  already safe: `resolveCodexSession` and `resumable` accept only `THREAD_ID_RE` ids.)
- Build one `id → rollout path` index from a single walk of `$CODEX_HOME/sessions` at the start
  of the pass and look ids up in it, instead of calling `findRollout` per id: `findRollout`
  walks the whole tree on every call and never stops at the first match (about 4,000 ids ×
  3,800 entries per prune), and its comment claiming the walk "stays small" is wrong; fix the
  comment too.
- Then look up each id's rollout in that index before spawning, and skip
  `codex delete` when the rollout is already gone (count it handled, not deleted). Keep the
  existing rollout-unlink fallback for a failed delete.
- Make progress durable: after each handled id, record it so a restart does not redo it. Either
  trim that id's ledger lines as it goes, or append it to a resume file under `.tumwater/state/`
  that the next pass subtracts from the expired set and that is removed once the ledger trim
  runs. Pick whichever keeps the ledger writer single-homed (`pruneSessionLedgers`), and say which
  in the commit.
- Apply both to `pruneOpencodeSessions` (skip an id OpenCode no longer has, if its CLI or DB can
  tell cheaply; otherwise only the resume half).
- Note: the "(bounded)" in both functions' doc comments means the 10 s per-delete timeout
  (`SESSION_DELETE_TIMEOUT_MS`), not a cap on deletes per pass; reword it so it is not misread.
- Drop the `Restarting tumwater starts this over.` suffix from the maintenance alert (part 2/3),
  since it is no longer true.

**Acceptance criteria.**
- An expired non-UUID Codex id (a session name) is never passed to the `codex` binary, and its
  ledger lines are still trimmed by the line pass.
- One prune pass walks `$CODEX_HOME/sessions` once, however many ids are expired.
- An expired Codex id whose rollout is already absent is never passed to the `codex` binary (a
  stub binary that records its argv sees only ids that still have a rollout).
- A prune interrupted after k of N ids (stub delete that throws or the test stops it) and run
  again spawns deletes only for the remaining N − k ids.
- The maintenance alert no longer carries the restart suffix.

### Fast session cleanup, part 2/2: session deletes run off the poll loop, so roles keep running during cleanup (planned 2026-11-16 by the operator; requires Fast session cleanup part 1/2 landed; touches src/agent/session-ledger.ts src/orchestrator/retention.ts src/orchestrator/orchestrator.ts src/orchestrator/orchestrator-poll.ts src/ui/team-alert-status.ts src/ui/status-model.ts test/session-ledger-prune.test.ts test/retention.test.ts test/team-alert-status.test.ts test/status-model.test.ts)

**Goal.** Even short, a synchronous prune holds every role for its whole length, at startup and
once a day. Running the CLI deletes asynchronously lets scheduling continue during cleanup. (A
per-pass delete cap was the other option; it was not chosen because a daily pass with a cap can
fall behind a busy Codex team indefinitely.)

**Approach.**
- `pruneCodexSessions` and `pruneOpencodeSessions` become async, using `spawn` with a small
  concurrency limit (4) and the same 10 s per-delete timeout and status-0 success rule.
- `RetentionPruner` starts the prune as a background task from the constructor and from `poll()`
  and never awaits it in the poll; a pass already in flight makes `poll()` skip starting another.
  The file and ledger-line passes still run after the deletes, inside the same task, so the ledger
  is read before it is trimmed. Stopping the orchestrator abandons the task cleanly (its progress
  is durable since part 1/2), and a rejected task logs a warning instead of ending the team.
  Today a SIGTERM during the prune cannot reach the JS handler while `spawnSync` blocks, so
  shutdown never runs: the 2026-11-16 instances stopped mid-prune (pids 4663, 15799) logged no
  `orchestrator_stop`, handed off no merge and released no slot.
- The marker and events from part 1/3 stay. The maintenance alert becomes purely informational:
  title `Cleaning up expired sessions in the background`, no "roles start when it finishes".
  Remove the `held: session cleanup` hold from `rolePhase` (part 2/3), so rows show their normal
  phases during cleanup.

**Acceptance criteria.**
- With a stub `codex` that sleeps 1 s and 50 expired ids, a role due at startup starts its run
  before the prune finishes.
- No more than 4 delete processes run at once.
- A second `poll()` while a prune is in flight does not start another pass.
- A SIGTERM while a prune is in flight ends the orchestrator within the shutdown window, with an
  `orchestrator_stop` event and the usual merge hand-off and slot release.
- The maintenance alert reads as informational and idle rows show their normal phase while the
  marker stands.

### Operator steering, part 2/5: `tumwater guide` prints the operator's working rules for an interactive agent (planned 2026-11-16 by the operator; requires Operator steering part 1/5 landed; touches src/operator/operator-guide.ts src/cli.ts src/cli/cli-help-text.ts docs/cli.md test/operator-guide.test.ts)

**Goal.** An operator's own agent (claude, codex, omp) should be able to learn how to steer
tumwater by running one command: `tumwater guide`. The text is versioned with the install, so it
always matches the commands the installed tumwater has. It must not live in the project's
CLAUDE.md or AGENTS.md: tumwater's claude, codex and opencode backends load those files into every
role run (src/agent/claude/claude-args.ts, src/agent/codex/codex-args.ts,
src/agent/opencode/opencode-config.ts), and these rules are for the operator's agent, not the
team.

**Approach.**
- New `src/operator/operator-guide.ts` exporting `guideText(project?: GuideProject): string`. The
  static body is plain markdown, wrapped at 100 columns, in this order:
  1. **What you are doing.** The team executes PLANS.md and BUGS.md one small reviewed change at
     a time; you (the operator's agent) steer by investigating and writing sharp entries. You do
     not implement backlog entries yourself unless the operator asks.
  2. **Orient first.** `tumwater status`, `tumwater history --result problems`, `tumwater plan
     --list`, `tumwater bug --list`, `tumwater questions`, `tumwater doctor`.
  3. **Writing a plan.** One run's worth of work: Goal, Approach (named files and functions),
     Files touched, Acceptance criteria (each checkable), Tests (where each expected value comes
     from). Larger work is a series: headings `### <Series>, part i/n: <title> (planned <date> by
     the operator; requires <Series> part j/n landed; touches <paths>)`. The `requires … landed`
     clause must sit in the heading's last parenthetical, since that is the only place the claim
     allocator reads it.
  4. **Writing a bug.** Symptom as the heading; **Reproduce.**, **Suspected cause.** A bug
     moved to `## Fixed` carries a `**Validation gap:** <tag> — <one sentence>` line (the tags
     init-templates.ts lists).
  5. **Rules.** Never edit or move an entry `--list` marks `[working on it: …]`. Put a conflicting
     new plan on top of it with a `requires` clause instead. Latest instruction wins: amend an
     unclaimed entry in place with a dated `amended <date> by the operator` note rather than
     filing a duplicate. Never edit PLANS-DONE.md or BUGS-FIXED.md directly or anything under
     `.tumwater/`. tumwater.json edits apply live.
  6. **Getting edits onto main.** For one entry, `tumwater plan|bug --file`, `--edit <n> --file`,
     `--top`, `--cancel`, `--retire`, `--release`, and `tumwater questions answer`. They commit on
     main under the team's lock. `--file` appends its own `(reported by the user <date>)` stamp as
     the heading's last parenthetical, so a series part with a `requires` clause goes the other
     way: edit the files in your own branch or worktree, commit, then `tumwater land`. Never
     commit, merge or pull on the base branch in the primary checkout yourself.
  7. **Other steering.** `tumwater prompt "<text>"` for the director, `tumwater revert <sha>`,
     `tumwater pause` / `resume`, `tumwater questions answer`.
- Inside a ready tumwater repo, append a **This project** section: the base branch, the declared
  check as `describeCheck` (src/build/build-check-report.ts) words it (never assume npm), and
  whether a team is running (the same pid read `tumwater status` uses). Outside a repo, print the
  static body alone and exit 0, like `help`.
- CLI: `tumwater guide` takes no arguments (`rejectUnknownArgs`), a `COMMAND_HANDLERS` row in
  src/cli.ts, a usage stanza in src/cli/cli-help-text.ts, and a row in docs/cli.md.

**Acceptance criteria.**
- `tumwater guide` outside any repo exits 0 and prints the seven sections above.
- In a fixture repo with a declared `check.command`, the output names that command and the
  fixture's base branch; with no declared check it says so instead of naming npm.
- Every `tumwater <command>` the guide text names is a command in `HELP`: the test extracts them
  from `guideText()` and checks each against the help text, so a renamed command cannot leave the
  guide stale.
- `tumwater guide --json` and any stray argument fail like other unknown arguments.

**Tests.** test/operator-guide.test.ts: the outside-repo and fixture-repo outputs (expected branch
and command taken from the fixture's own setup), the command-name drift check, unknown arguments.
Then the project's gate.

### Operator steering, part 3/5: docs/steering.md says how an operator runs tumwater with their own agent (planned 2026-11-16 by the operator; requires Operator steering parts 1/5, 2/5 landed; touches docs/steering.md docs/how-it-works.md docs/cli.md)

**Goal.** The docs describe the intended way to use tumwater, and that way is not hands-off. The
team does the volume work; the operator steers it, and the primary way to steer is a strong model
in the operator's own interactive harness (claude, codex, omp) editing PLANS.md and BUGS.md. Today
no doc says so; the knowledge an operator's agent needs lived only outside the repo.

_Amended 2026-11-16 by the operator: no longer names the TUI, which the Remove the TUI series
deletes._

**Approach.** Write docs/steering.md for a human reader, in plain terms (docs/glossary.md):
- **The three ways to steer**, in order: your own agent in the repo (the primary one); the
  director prompt (dashboard, `tumwater prompt`) for quick steering without leaving the UI;
  answering the questions the team raises (`tumwater questions`). Running hands-off works (`start
  --for`, `--once`), but it is not where tumwater does its best work.
- **The loop.** Start the team; in a second terminal open your agent in the repo and tell it to
  run `tumwater guide` first; have it read `tumwater status`, `history --result problems` and the
  backlog lists; ask it to investigate and to file, sharpen, reorder or retire entries; watch what
  merges.
- **What makes a good entry**, briefly, pointing at `tumwater guide` for the full rules rather than
  repeating them.
- **Landing direct edits** with `tumwater land`, and why a plain `git merge` on main can collide
  with a team merge.
- **What the director is for** compared with your own agent: the director lives in the team and
  runs on the team's strong tier; your agent has your conversation, your judgment and the whole
  repo, and is where design decisions get made.
- Link it from docs/how-it-works.md's Setup section (one sentence after `tumwater start`) and from
  docs/cli.md's opening paragraph.

**Acceptance criteria.**
- docs/steering.md exists, names `tumwater guide` and `tumwater land`, and lists the three ways to
  steer in the order above.
- docs/how-it-works.md and docs/cli.md each link to docs/steering.md.
- Every `tumwater` command the new doc names exists in `tumwater help`.
- No README change in this part (part 4/5 owns it).

**Tests.** The project's gate (the docs-drift checks cover links and command names).

### Operator steering, part 4/5: The README says up front that you steer tumwater, mainly from your own agent (planned 2026-11-16 by the operator; requires Operator steering part 3/5 landed; touches README.md)

**Goal.** A first-time reader learns from the README's opening that tumwater is meant to be
steered, not run hands-off, and that the primary way is their own interactive agent editing the
backlog.

_Amended 2026-11-16 by the operator: no longer names the TUI, which the Remove the TUI series
deletes._

**Approach.**
- Rewrite the intro paragraph after the token warning. Keep what it says about roles, small reviewed
  commits and local-only git state. Replace "It came from wanting to write only the brief and let
  a team of always-on specialists do the rest" with: the team does the volume work, and you steer
  it, mainly by curating PLANS.md and BUGS.md with a strong model in your own interactive harness
  (claude, codex, omp).
- Add a short `## How you work with tumwater` section between Install and Status: the three ways
  to steer (your own agent, primary; the director prompt; answering questions), the one-line loop
  ("start the team, open your agent in the repo, tell it to run `tumwater guide`"), and a link to
  docs/steering.md.
- In Usage, the paragraph starting "From another terminal" leads with your agent and `tumwater
  guide` before the browser dashboard, `status` and `logs`.
- Leave the warning, the `tumwater:status` markers and the brief appendix between the
  `tumwater:prompt` markers untouched; the brief is the operator's to change.

**Acceptance criteria.**
- The README no longer says you only write the brief anywhere outside the brief appendix.
- The new section exists between Install and Status, links docs/steering.md, and names `tumwater
  guide`.
- The status and prompt marker blocks are byte-identical to before.

**Tests.** The project's gate.

### Operator steering, part 5/5: Seeded files, help and package text stop describing a hands-off team (planned 2026-11-16 by the operator; requires Operator steering part 2/5 landed; touches src/init/init-templates.ts src/cli/cli-init.ts src/cli/cli-help-text.ts package.json docs/glossary.md PLANS.md)

**Goal.** The text a new user meets outside the README matches the steered use. Today the seeded
PLANS.md says plans are "written by the plan role", the help's first line and package.json
describe "an autonomous development team" that needs only the initial prompt, and `init`'s next
step mentions only `tumwater start` and `tumwater tui`.

**Approach.**
- src/init/init-templates.ts: `PLANS_TEMPLATE`'s lead becomes "Planned features, written by you
  (often through your own agent) or the plan role, and implemented by the feature role." and
  `BUGS_TEMPLATE`'s "recorded by any role" becomes "recorded by you or any role". Keep the rest of
  both templates.
- src/cli/cli-init.ts: the `next:` line adds "and point your own agent at `tumwater guide`".
- src/cli/cli-help-text.ts: `HELP`'s first line describes a development team you steer, still
  naming the four backends.
- package.json: `description` says the team builds the project while you steer it through the
  backlog, from your own agent or the director; keep `autonomous` in keywords.
- docs/glossary.md: add a Terms row "your agent: the interactive harness (claude, codex, omp) you
  run in the repo to steer the team; not one of tumwater's roles".
- This repo's PLANS.md lead paragraph: replace "The harness renders it read-only; the roles that
  act on it are …" with a sentence that the operator (often through their own agent) writes and
  edits entries too, keeping the list of what each role does. Edit only that paragraph.

**Acceptance criteria.**
- A fresh `tumwater init` writes the new PLANS.md and BUGS.md leads and prints the new `next:` line.
- `tumwater help`'s first line and package.json's `description` no longer say the team needs only
  the initial prompt.
- The glossary row exists; no `### ` entry in PLANS.md changes.

**Tests.** Update the init and help tests that pin the old wording to the new text (test/init*.ts,
test/help.test.ts) from the template constants, not by copying the output. Then the project's gate.

### Remove the TUI, part 1/5: delete the terminal dashboard and both ways to start it, `tumwater tui` and `start --tui` (planned 2026-11-16 by the operator; touches src/ui/tui/ src/cli.ts src/cli/cli-start.ts src/cli/cli-start-supervisor.ts src/cli/cli-flag-specs.ts src/cli/cli-help-text.ts src/cli/cli-init.ts src/doctor/doctor-orphans.ts src/doctor/doctor-backlog.ts src/ui/status-render.ts src/ui/status-payload.ts src/roles/role-view.ts src/history/history-data.ts test/tui-*.test.ts test/cli-tui-strictness.test.ts test/fixtures/tui-fixtures.ts test/gui-client.test.ts test/status-render.test.ts test/transcript.test.ts test/categories-tumwater.test.ts test/supervisor.test.ts docs/cli.md docs/invariants.md README.md RELEASE_NOTES.md)

**Goal.** The operator watches and steers the team through the browser dashboard (`tumwater gui`,
`tumwater start --gui`) and the CLI, and has stopped using the ink TUI. The TUI is too busy to
read, bugs and UX problems have piled up in it because nobody uses it, and every change to a
shared status, alert or editor rule has to be built and tested twice. It is 58 files and about
10,900 lines under `src/ui/tui/`, plus 31 test files, and it is the only reason tumwater has
runtime dependencies (ink, react). Nobody else runs tumwater. Remove it outright. Nothing in it
is ported to the GUI: a TUI-only control is dropped, not moved (operator's decision 2026-11-16).
This part deletes the code and its two entry points, and fixes everything that would otherwise
fail to build or fail the suite. Parts 2/5 to 5/5 tidy what is left.

**Approach.**
- Delete `src/ui/tui/` and its tests: every `test/tui-*.test.ts` and the dot-named
  `test/tui.test.ts` (the glob misses it), test/cli-tui-strictness.test.ts and
  test/fixtures/tui-fixtures.ts.
- `tumwater tui`: drop `cmdTuiCase` and the `tui` row of `COMMAND_HANDLERS` in src/cli.ts. The
  command then fails as an unknown command, and the existing did-you-mean (src/text/suggest.ts)
  names `gui`. No tombstone message.
- `tumwater start --tui`: drop the `--tui` flag spec (src/cli/cli-flag-specs.ts), the two `--tui`
  rival-shape refusals in src/cli/cli-start.ts, and the supervisor's hosting path in
  src/cli/cli-start-supervisor.ts: `spawnTui`, the TTY guard through `tuiTerminalError`, the
  hosted `runTui` and its abort controller, and the silent `childStdio` used while a TUI is
  hosted (children always inherit stdio now). `start --tui` then fails as an unknown flag before
  anything boots.
- src/cli.ts `main`'s stdout/stderr error guard: drop the EIO deferral
  (`errCode(err) === "EIO" && stream.listenerCount("error") > 1`) and its comment. It existed only
  so the TUI's own `error` listener could take its quit teardown. EPIPE still exits 0, and every
  other write error, EIO included, throws.
- Text a user reads: the `tumwater tui` stanza and the `--tui` lines in
  src/cli/cli-help-text.ts; the `watch:` line in src/cli/cli-start.ts names `tumwater gui` or
  `tumwater logs -f`; the `next:` line in src/cli/cli-init.ts says `tumwater gui` where it says
  `tumwater tui` and keeps the rest of the line (Operator steering part 5/5 edits that line too);
  drop the "or the TUI Health tab's …" clauses in src/doctor/doctor-orphans.ts and
  src/doctor/doctor-backlog.ts.
- Shared exports that only the TUI imported. test/exports.test.ts names them once the TUI is
  gone: `HistorySummaryGroup` (src/history/history-data.ts), `rawRoleField`
  (src/roles/role-view.ts), `DASHBOARD_ANSWERED_QUESTIONS`, `DASHBOARD_RECENT_FINISHED` and
  `recentFinished` (src/ui/status-payload.ts), and `StatusSpan`, `StatusLine`, `clipSpans` and
  `toneLine` (src/ui/status-render.ts). When the symbol's own module still uses it, drop only the
  `export`; otherwise delete it and any helper only it used.
- Tests that reach into the TUI for a shared rule:
  - test/gui-client.test.ts imports `parseBudgetInput` to show the GUI's cap editor agrees with
    the TUI. Rewrite that test against `checkDailyBudgetUsd` (src/config/config-keys.ts), the
    rule both surfaces were meant to share, with expected verdicts written out as literals.
  - test/status-render.test.ts uses `sanitizeFrameLines` (tui-frame.ts) and
    test/transcript.test.ts uses `paneBody` (tui-pane.ts). Keep the cases that test a surviving
    function, and delete the ones that only exercised the TUI half.
  - test/categories-tumwater.test.ts: replace the `src/ui/tui/tui.tsx` row with another
    `src/ui/` file.
  - test/supervisor.test.ts: drop the `--tui` cases and keep the `--gui` ones.
  - Drop the tests that pinned the EIO deferral (the "CLI-hosted TUI exits 0 when its terminal
    dies" case). Keep the EPIPE cases.
- docs/cli.md: the `tumwater start --tui` example, `tumwater tui` in the "Watch the team" row
  (the row then leads with the browser dashboard), and the whole `## TUI keys` section.
- docs/invariants.md. test/invariants-doc.test.ts requires every cited path and test title to
  exist, so six entries change here:
  - INV-A6, INV-AD5, INV-AK4, INV-B5 and INV-T6: drop the TUI clause and its path, keeping each
    guarantee for the surfaces that remain.
  - INV-DC1: drop the EIO-deferral sentence, the `src/ui/tui/tui.tsx` (`runTui`) Binds path and
    the test/tui-dead-terminal.test.ts pin.
- README.md: the `tumwater start --tui` example, "`tumwater tui` or the browser dashboard" and
  "every … TUI key". RELEASE_NOTES.md, under `## CLI`: a bullet saying the terminal dashboard
  (`tumwater tui`, `start --tui`) is removed and to use `tumwater gui` / `start --gui`.

**Acceptance criteria.**
- `src/ui/tui/` and the 31 TUI test files (all 30 `test/*tui*.test.ts` plus
  `test/fixtures/tui-fixtures.ts`) are gone, and nothing in src/, test/ or scripts/ imports
  from `ui/tui/`.
- `tumwater tui` exits 1 as an unknown command whose message names `gui`.
- `tumwater start --tui` exits nonzero as an unknown flag without starting an orchestrator.
- `tumwater start` and `tumwater start --gui` behave as before: the supervisor's children inherit
  stdio, and the supervisor and cli-start tests pass.
- A CLI whose stdout reader closes still exits 0 (EPIPE); an EIO on stdout is no longer swallowed.
- The repo-wide scans pass, which the gate's `--affected` selection can skip: run
  `npm run test:rerun -- exports.test invariants-doc.test docs-links.test docs-commands.test cli-doc.test help.test completion.test comment-width.test`
  as well as the gate.

**Tests.** No new tests beyond the rewritten `checkDailyBudgetUsd` case, which takes its expected
verdicts from the rule's own definition (finite, ≥ 0, ≤ MAX_SAFE_INTEGER), not from calling it.
The deletion is pinned by the existing unknown-command and unknown-flag tests: add `tui` and
`start --tui` cases to them (test/cli-help-unknown.test.ts, test/cli-start-guards.test.ts), with
the expected suggestion `gui` written as a literal. Then the project's gate and the scans above.

### Remove the TUI, part 2/5: delete what is left in src/ only for tests now that the TUI is gone (planned 2026-11-16 by the operator; requires Remove the TUI part 1/5 landed; touches src/history/history-data.ts src/inbox/inbox.ts src/review/quarantine-render.ts src/roles/role-render.ts src/ui/status-render.ts src/redeploy/self-reload.ts test/history*.test.ts test/inbox*.test.ts test/quarantine*.test.ts test/role-render*.test.ts test/status-render*.test.ts test/self-reload*.test.ts)

**Goal.** After part 1/5, some exports in src/ are used by nothing in src/ except their own
module; only tests still import them. test/exports.test.ts counts a test as a user, so it does
not flag them, but they are dead code with tests pinning them in place. As of 2026-11-16 they are
`runRowGrepHaystack` (src/history/history-data.ts), `enqueuePrompt` (src/inbox/inbox.ts),
`renderQuarantineSection` (src/review/quarantine-render.ts), `inspectMarkdownLines`
(src/roles/role-render.ts) and `renderStatusSpans` (src/ui/status-render.ts). The self-reload
watch (src/redeploy/self-reload.ts) also still carries reasoning written for an orphaned TUI on
the operator's terminal.

**Approach.**
- Re-derive the list on the tree as it stands: for each exported symbol in src/, collect the
  files outside its own module that use it. A symbol whose only such users are under test/ is a
  candidate.
- From the candidates, take only those that a TUI file imported before part 1/5
  (`git show <part 1/5's parent>:src/ui/tui/…`). Other test-only exports are not this part's
  business.
- For each one: if its own module still calls it, drop the `export` and rewrite its tests to go
  through the exported function that calls it. Otherwise delete it, along with any helper only it
  used and the tests that only pinned it.
- src/redeploy/self-reload.ts: the dashboards it reloads are now `tumwater gui` alone. Delete any
  branch, option or state that only a TUI process exercised (`reloadDisabled` was passed only by
  the hosted TUI), and reword the module's doc comment. Keep the GUI's reload behaviour exactly.

**Acceptance criteria.**
- Nothing on the list keeps an `export` that only tests use.
- `tumwater gui` still reloads itself after a self-redeploy swaps `dist/`. The self-reload tests
  that cover the GUI pass unchanged, apart from deleted TUI-only options.
- No behaviour visible through the CLI or the GUI changes.

**Tests.** Removed tests are those that only pinned a deleted symbol. Tests of a now-unexported
helper move to its exported caller with the same expected values. Then the project's gate, plus
`npm run test:rerun -- exports.test`.

### Remove the TUI, part 3/5: drop ink and react, so tumwater has no runtime dependencies (planned 2026-11-16 by the operator; requires Remove the TUI part 1/5 landed; touches package.json package-lock.json tsconfig.json eslint.config.js scripts/stamp-build.mjs test/stamp-build.test.ts PRINCIPLES.md docs/code-metrics.md)

**Goal.** ink and react, plus the `@types/react` dev dependency, were adopted for the TUI alone
(the ink decision of 2026-10-01 in PRINCIPLES.md). With the TUI gone, nothing imports them, and
removing them returns tumwater to zero runtime dependencies. That means a smaller install and no
JSX toolchain settings.

**Approach.**
- `npm uninstall ink react @types/react`, so package.json and package-lock.json change together.
  The team re-syncs the primary tree's node_modules from the lockfile after its own merge.
- tsconfig.json: drop `"jsx": "react-jsx"` and the `src/**/*.tsx` include.
- eslint.config.js: drop the `src/**/*.tsx` globs.
- scripts/stamp-build.mjs: no source is `.tsx` any more, so a `.js` output's source is its `.ts`
  alone. Drop the `.tsx` branch and its comment, and update test/stamp-build.test.ts to match.
- PRINCIPLES.md: the dependency rule no longer names ink as an exception (the TypeScript
  toolchain stays the only one), and the **Dependencies** line reads 0 runtime.
  docs/code-metrics.md: the dependencies bullet says the same.

**Acceptance criteria.**
- `npm ls --omit=dev --depth=0` shows no dependencies, and package.json names neither ink nor
  react.
- `npm run build` succeeds from a clean `dist/`, and no `.tsx` file exists under src/.
- The built CLI starts: `node dist/src/cli.js help` exits 0.

**Tests.** test/stamp-build.test.ts as above. Then the project's gate, plus
`npm run test:rerun -- stamp-build.test`.

### Remove the TUI, part 4/5: source comments stop describing a TUI (planned 2026-11-16 by the operator; requires Remove the TUI parts 1/5, 2/5, 3/5 landed; touches src/ (comments only) scripts/diff-check.mjs scripts/live-fixture.mjs)

**Goal.** Before part 1/5, about 100 files under src/ (outside `src/ui/tui/`) mentioned the TUI
some 315 times. Most of those mentions are comments that call a piece of code "the TUI's twin",
cite a `src/ui/tui/…` path, name a TUI key (Ctrl+…), or list the TUI among the surfaces that read
a file. Part 1/5 removes only the user-facing ones. A reader, human or model, who follows the rest
looks for code that does not exist, or keeps two surfaces in step when there is only one.

**Approach.**
- Wherever a comment in src/ or scripts/ names the TUI, a `ui/tui/` path or a TUI key, rewrite
  the sentence for the surfaces that remain (the CLI, the GUI, `tumwater status`). Drop "twin of
  the TUI's …" cross-references outright. Change comments only; any code change found along the
  way becomes its own BUGS.md entry. Keep comment lines within the 100-column limit
  (test/comment-width.test.ts).
- scripts/diff-check.mjs compares the `renderStatus` table (the `tumwater status` view) and the
  GUI's `/api/status` payload; say so instead of "TUI table strings". Fix the TUI mentions in
  scripts/live-fixture.mjs.

**Acceptance criteria.**
- `grep -rniw tui src scripts` matches nothing.
- No source line other than a comment changes: `git diff -U0 -- src scripts` adds and removes
  only comment lines.
- test/comment-width.test.ts passes.

**Tests.** None new. Run the project's gate, plus `npm run test:rerun -- comment-width.test`.

### Remove the TUI, part 5/5: tests and docs stop describing a TUI (planned 2026-11-16 by the operator; requires Remove the TUI parts 1/5, 2/5, 3/5 landed; touches test/ (comments and test titles only) docs/invariants.md DEVELOPMENT.md README.md docs/how-it-works.md docs/feature-doctor.md docs/backends.md docs/glossary.md docs/feature-per-role-spending.md docs/implementation-per-role-spending.md docs/implementation-model-fallback.md docs/code-metrics.md)

**Goal.** Outside the deleted TUI tests, about 70 test files mention the TUI some 480 times, in
comments and in test titles such as "matches the TUI's …". Several docs still describe TUI panes
and keys as current. Once the TUI is gone, these mislead whoever reads them next.

**Approach.**
- test/: rewrite comments and test titles that name the TUI, a `ui/tui/` path or a TUI key for
  the surfaces that remain. Change no assertion. When a renamed title is cited in
  docs/invariants.md (a `**Pinned by.**` line quotes it), update the citation in the same change.
- DEVELOPMENT.md: "Checking rendered output by hand" says diff-check compares the
  `tumwater status` table and the GUI payload, not "TUI status-table strings"; the src/ layout
  list drops `src/ui/tui/`; drop other TUI mentions.
- docs/: rewrite each live description of a TUI pane, key or surface (how-it-works,
  feature-doctor, backends, glossary, the per-role-spending and model-fallback docs, and
  code-metrics' TUI key-handler complexity rows) for its GUI or CLI equivalent, or delete it
  where there is none. README.md's "observable by gui/tui/log. GUI/TUI also gives user a main
  prompt" becomes gui/log and GUI.
- Leave history alone: plans/*.md, PLANS-DONE.md, BUGS-FIXED.md and earlier release-note
  sections record what was true at the time.

**Acceptance criteria.**
- `grep -rniw tui test` matches nothing. `grep -rniw tui docs README.md DEVELOPMENT.md
  PRINCIPLES.md` matches only sentences saying that the TUI was removed.
- No test assertion changes: `git diff -U0 -- test` touches only comments and test-title
  strings.
- test/docs-links.test.ts, test/invariants-doc.test.ts and test/comment-width.test.ts pass.

**Tests.** None new. Run the project's gate, plus
`npm run test:rerun -- docs-links.test invariants-doc.test comment-width.test`.

## Done
