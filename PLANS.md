# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. The
harness renders it read-only; the roles that act on it are plan (adds and retires `## Planned`
entries), feature (claims, completes, refuses, and reports plan defects on `## Planned`), and bugfix
(claims, fixes, and refuses `## Open`). Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### Release version display, part 1/2: the build stamp records the npm release version when it was compiled from that release's tag (planned 2026-11-16 by the operator; touches src/build/build-info.ts src/redeploy/redeployer.ts src/team/team-orchestrator-info.ts test/build-info.test.ts test/stamp-build.test.ts test/redeployer.test.ts test/team-orchestrator-info.test.ts)

**Goal.** An npm-installed tumwater shows a commit hash where the operator expects a version. The
GUI sidebar's Version row (src/ui/gui/gui-client-team.ts) prints `shortSha(d.build.sha)`, and for
an npm install that sha is the commit the Release workflow (.github/workflows/release.yml) packed
from: `npm publish` runs `prepack` → `npm run build` → scripts/stamp-build.mjs, which writes
`dist/build-info.json`, and package.json `files` ships that stamp. `createRedeployer`
(src/redeploy/redeploy.ts) builds a Redeployer from any stamp, self-hosted or not, so
`orchestrator.json` carries `build.sha` and every dashboard shows it. An operator who installed
`tumwater@0.8.1` cannot match `a1b2c3d4` to a release. This part records the release version in
the stamp so part 2/2 can show it.

The version must come from the build, not be read from package.json at run time. Main always
carries the NEXT version (scripts/release.mjs: "Main always carries the NEXT version"), so a
checkout build showing package.json's version would claim an unreleased version. Only a build
compiled from the commit the release tag `v<version>` points at is that release.

**Approach.**
- `BuildInfo` (src/build/build-info.ts) gains `release?: string`: the package.json version, set
  only when the build's commit is the one tag `v<version>` points at. Doc comment: why it is not
  read from package.json at run time (the sentence above).
- `stampBuild(root, dist, sha?)` reads `version` from `root`'s package.json (reuse
  `packageVersion` in src/version.ts) and asks git whether the tag `v<version>` resolves to the
  stamped sha: `refSha(root, "refs/tags/v<version>^{commit}")` compared with the sha, or
  `git tag --points-at` through `gitTry`. Match ⇒ write `release`. No package.json, no version, no
  tag, or a tag on another commit ⇒ leave `release` out. A failed git read never fails the
  stamp. The Release workflow's `actions/checkout@v4` on a tag push fetches the tag ref, so the
  tag is present locally there; verify that in the acceptance check below rather than assume it.
- `readBuildInfo` keeps `release` only when it is a non-empty string (a foreign value drops, like
  the other fields).
- `BuildStatus` gains `release?: string`. `Redeployer.status()` (src/redeploy/redeployer.ts)
  copies `this.build.release` when set, and `parseBuild` (src/team/team-orchestrator-info.ts)
  keeps it only when it is a non-empty string, so it reaches orchestrator.json and every
  observer.
- Nothing else changes: staleness, self-redeploy and self-reload still key on `sha`.

**Acceptance criteria.**
- In a fixture repo whose package.json says `1.2.3`: a stamp of a commit tagged `v1.2.3` carries
  `release: "1.2.3"`; a stamp of an untagged commit, of a commit tagged `v1.2.2`, or with the
  `v1.2.3` tag on an older commit carries no `release`; a missing or version-less package.json
  stamps normally without `release`.
- `readBuildInfo` round-trips `release`, and drops a non-string or empty one while keeping the
  rest of the stamp.
- `Redeployer.status()` includes `release` exactly when the build info has it, and `parseBuild`
  keeps a string `release` and drops a foreign one without dropping the build.
- Manual check, in a scratch clone (never in the primary checkout): tag HEAD `v<package.json
  version>`, run `npm pack`, and confirm the tarball's `package/dist/build-info.json` has
  `release`; delete the tag, pack again, and confirm it does not.

### Release version display, part 2/2: the GUI's Version row shows the npm release version, keeping the commit in its tooltip (planned 2026-11-16 by the operator; requires Release version display part 1/2 landed; touches src/build/build-info.ts src/ui/badges.ts src/ui/gui/gui-client-team.ts src/ui/status-payload.ts src/doctor/doctor.ts src/cli/cli-start.ts test/gui-client-sidebar.test.ts test/badges.test.ts test/status-payload.test.ts test/doctor-checks.test.ts)

**Goal.** When the running build is a release (`build.release`, part 1/2), the GUI sidebar's
Version row reads `Version 0.8.1`, not `Version a1b2c3d4`. The commit stays one hover away for bug
reports. Builds from a checkout (the self-hosted team, a developer's dist) have no `release` and
keep showing the short sha, unchanged. Every other place that names the running build uses the
same rule, so the GUI, the TUI header, `doctor` and `tumwater start` never disagree about which
version is running.

**Approach.**
- One shared label: a small exported helper beside `BuildStatus` in src/build/build-info.ts (for
  example `buildLabel(build)`), returning `build.release` when set and `shortSha(build.sha)`
  otherwise. Each site below calls it; no site does its own `release ?? sha`.
- GUI: the server sends the label ready-made, like `buildBadge`. src/ui/status-payload.ts ships
  `buildLabel` beside `buildBadge`. gui-client-team.ts renders `"Version <span class='mono'>" +
  esc(d.buildLabel || shortSha(d.build.sha)) + "</span>"`, falling back to the sha for a payload
  from an older server.
- Tooltip: `buildBadge` (src/ui/badges.ts) reads `, version 0.8.1 (build a1b2c3d4)` for a release
  and keeps `, build a1b2c3d4` otherwise. The GUI tooltip's `.replace(/^, build/, "")` in
  gui-client-team.ts must handle both, so a release tooltip reads `Running version 0.8.1 (build
  a1b2c3d4)` and a checkout tooltip stays `Running version a1b2c3d4`. The TUI header uses the same
  `buildBadge`, so it follows with no TUI change.
- `doctor`'s running line (src/doctor/doctor.ts, `version ${shortSha(info.build.sha)}`) and
  `tumwater start`'s ` · build <sha>` (src/cli/cli-start.ts) use the label too.
- A release build is never stale (a non-self-hosted Redeployer never sets `stale`), so the
  "commits behind" and "update waits for main's check" suffixes need no release wording.

**Acceptance criteria.**
- A GUI payload with `build: { sha: "aaaaaaaa…", release: "0.8.1" }` renders `Version <span
  class='mono'>0.8.1</span>`, and its row title contains `0.8.1` and `aaaaaaaa`.
- A payload without `release` renders exactly today's `Version <span class='mono'>aaaaaaaa</span>`
  row, title and suffixes; the existing stale, waiting-for-check and restart-hold assertions in
  test/gui-client-sidebar.test.ts pass unchanged. A payload with `build` but no `buildLabel` (an
  older server) still renders the sha.
- `buildBadge` returns `, version 0.8.1 (build aaaaaaaa)` for a release build and today's string
  for every existing case in test/badges.test.ts.
- `doctor` prints `version 0.8.1` for a release build and the short sha otherwise.
- Manual check: install the packed tarball from part 1/2's check globally (`npm i -g
  ./tumwater-<version>.tgz`) in a scratch environment, run `tumwater start` in a demo repo and
  open the GUI. The sidebar reads `Version <version>` and hovering shows the commit.

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

### Operator steering, part 1/5: `tumwater land` puts a hand-made commit on main under the team's merge lock (planned 2026-11-16 by the operator; touches src/operator/operator-land.ts src/cli/cli-land-command.ts src/cli.ts src/cli/cli-help-text.ts docs/cli.md test/operator-land.test.ts)

**Goal.** The intended way to use tumwater is an operator steering the team, mostly by editing
PLANS.md and BUGS.md from their own interactive agent (claude, codex, omp) with a strong model.
Those edits have no safe way onto main while a team runs. A bare `git merge --ff-only` (or a
commit in the primary checkout) can move main while a team merge is inside its locked check, so
that merge fails as a reasonless `merge_blocked` and the change redoes gate, review and check.
Concurrent role commits also conflict at the top of `## Planned`, `## Done` and `## Fixed`, which
tumwater already knows how to merge entry by entry. `tumwater land` makes this one command: it
takes the locks the team takes and fast-forwards main to the operator's commits.

**Approach.**
- New `src/operator/operator-land.ts` holding `landOnMain(root, ref, opts)`. Shape it on
  `archiveOnMain` (src/backlog/backlog-archive.ts:477): `withLock(mergeLockDir(root), …)` around
  `withPrimaryWorktreeLockAsync(root, …)`, so a land waits for an in-flight team merge instead of
  racing it.
- Inside the locks: resolve `ref` (default `HEAD` of the cwd's worktree) and the base branch. Refuse
  when `ref` is already contained in main (`nothing to land`), when it holds a merge commit, or when
  its range touches `.tumwater/`. When main is an ancestor of `ref`, fast-forward through
  `ffMainToOrWhy` (src/merge/merge-git.ts) and nothing else. When main has moved, replay the
  commits main lacks onto main in a temporary detached worktree under `.tumwater/` (never the
  operator's worktree, never the primary checkout). Settle conflicts in PLANS.md, BUGS.md and
  QUESTIONS.md with `resolveBacklogInsertConflicts` (src/merge/merge-backlog-conflicts.ts). Any
  other conflict aborts the replay, removes the temporary worktree and refuses, naming the
  conflicted paths and leaving main and the operator's branch exactly as they were. Then
  fast-forward main to the replayed tip.
- After a replay, point the operator's branch at the landed tip only when it is checked out
  nowhere else and has no uncommitted changes. Otherwise say which sha landed so the operator can
  `git reset --hard <sha>` in their worktree.
- No model runs, no check runs: the operator's own commit is trusted, and the hourly full check
  and the next role gates see it as any other main move. Say so in the help stanza.
- CLI: `tumwater land [<ref>] [--dry-run] [--json]` in a new `src/cli/cli-land-command.ts`, a row in
  the `COMMAND_HANDLERS` table in src/cli.ts behind `requireReadyRepo` and `rejectUnknownArgs`, and
  a usage stanza in src/cli/cli-help-text.ts. `--dry-run` reports the commits, the paths they
  touch, whether a replay is needed and whether it would apply, and writes nothing. `--json` prints
  `{ landed, beforeSha, headSha, replayed, commits }`, and on a dry run `{ dryRun: true, commits,
  paths, replay, applies }`. Add the command's row to docs/cli.md's "Steer the project" row
  beside `tumwater revert`.

**Acceptance criteria.**
- With a team merge holding `.tumwater/merge.lock`, `tumwater land` waits and lands after it
  releases; it never moves main while that lock is held by someone else.
- A branch one commit ahead of main lands as a fast-forward: main's new tip is that commit's sha.
- A branch whose base is behind main, adding a `### ` entry at the top of `## Planned` while main
  added a different entry at the same spot, lands with both entries present and main's entry
  order otherwise unchanged.
- A replay that conflicts in a code file refuses with exit 1, names the file, and leaves main, the
  operator's branch and the primary checkout byte-identical; no temporary worktree is left behind.
- `--dry-run` writes nothing (main's sha and `git worktree list` unchanged).
- Refusals: an already-merged ref, a merge commit in the range, a range touching `.tumwater/`.

**Tests.** test/operator-land.test.ts against repo fixtures (test/fixtures/repo-fixtures.ts):
fast-forward, replay with a backlog insert conflict, code conflict refusal, dry run, each refusal,
and the lock wait (hold the merge lock from the test, start a land, release, assert it landed
after). Expected shas come from the fixture's own commits, not from the code under test. Then the
project's gate.

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

**Approach.** Write docs/steering.md for a human reader, in plain terms (docs/glossary.md):
- **The three ways to steer**, in order: your own agent in the repo (the primary one); the
  director prompt (dashboard, TUI, `tumwater prompt`) for quick steering without leaving the UI;
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
  guide` before `tumwater tui`, `status` and `logs`.
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

## Done

### `sectionSpan`'s fence-aware section boundary is pinned in test/backlog.test.ts, so a regression in the one fence-aware home of a `## ` section's span the backlog writers (backlog-write.ts) and the archive mover (backlog-archive.ts) both read through — the heading a `## <title>` section opens at, and the next real `## ` heading that ends it — is caught by the suite (planned 2026-11-16 by the plan role; continues the pin-a-rule family — the recent `roleInScope` (test/roles.test.ts, above), `lowerMedian`, `compareCodeUnits`, `validEntries` entries each take one correct-but-unpinned single-home rule and pin it in its natural test file with plain `assert`. `sectionSpan(lines: readonly string[], title: string)` in src/backlog/backlog-md.ts returns the 0-based span `{ heading, end }` of the FIRST `## <title>` section — its heading line, then `nextSectionHeading`'s walk to the next real `## ` heading (or `lines.length`) — or `null` when no such section exists. It reads every line through the shared fenceTracker, so a `## ` line quoted inside a fenced code block is body text, never a section boundary. `grep -rlw sectionSpan test/` is empty — no test file references it. Its fence branch is genuinely unpinned: its only src consumers are the writers, and neither `test/backlog-archive.test.ts` (0 fenced blocks) nor a write test feeds a section whose boundary is quoted inside a fence. The two sibling fence-aware section readers are already pinned transitively and are NOT this entry's target — `fenceAwareHeadingLines`'s consumers (`duplicateHeadings`, `actionableEntryRanges`) have fenced-heading tests in test/backlog-structure.test.ts, and `sectionBodyLines`'s consumer (`strandedPlanEntries`) has a fenced-`## Planned` test there; pinning them again would add a duplicate. The flip a regression would silently make: read the heading line without the fence guard (or drop `fencedHeadingTitle`) and a `## Done` quoted inside a fenced entry is mistaken for the archive's real `## Done` heading — or, reading the end boundary without the guard, cuts the section at a quoted `## Fixed`, so the archive mover ships the wrong lines — done 2026-11-16 by the feature role

**Goal.** Pin the one fence-aware section reader the backlog writers read through — `sectionSpan` — in `test/backlog.test.ts`, the file that already hosts the fence-reading tests (`fenceTracker`, `fenceOpener`, `closesFence`) and imports from `../src/backlog/backlog-md.js`.

**Approach.** One file, no new dependency, no src change, no invariant edit. In `test/backlog.test.ts` add `sectionSpan` to the existing `../src/backlog/backlog-md.js` import and add one `test(…)` block named for the rule (e.g. `"sectionSpan finds a ## section's span, fence-aware"`), with plain `assert` cases whose expected values are worked from the `fencedHeadingTitle`/`nextSectionHeading` bodies in src/backlog/backlog-md.ts, not from calling the function — `sectionSpan` takes a `string[]`, so each case is `sectionSpan([...lines], "<title>")` against a `assert.deepEqual` of the exact `{ heading, end }` or `null`:
- a quoted `## <title>` inside a fence is not the section, and a later real `## <title>` is: `sectionSpan(["## Done", "", "x", "```md", "## Done", "```", "", "## Fixed", "y"], "Done")` is `{ heading: 0, end: 7 }` — the fence is open at line 4, so the quoted `## Done` (line 4) is body text and never the heading; the real heading is line 0 and the end is the real `## Fixed` at line 7.
- a `## <title>` whose only occurrence is fenced is absent: `sectionSpan(["## Open", "", "```", "## Done", "```", "", "## Fixed", "y"], "Done")` is `null` — the sole `## Done` is a quoted line inside the fence, so the section does not exist.
- a plain (unfenced) section still resolves: `sectionSpan(["## Open", "a", "", "## Done", "b", "", "c"], "Done")` is `{ heading: 3, end: 7 }` — the non-fenced rule still works, so the fence branch is a special case, not a rewrite.
- a section that runs to EOF: `sectionSpan(["## Done", "x", "y"], "Done")` is `{ heading: 0, end: 3 }` — `nextSectionHeading` returns `lines.length` when no later `## ` heading follows.
- a missing section: `sectionSpan(["## Open", "", "## Done"], "Missing")` is `null`.

Each expectation is read from `fencedHeadingTitle` (a `## ` line inside a fence returns `null`, so it is neither a heading nor a boundary) and `nextSectionHeading` (returns the next real `## ` index, or `lines.length`), not from a call to `sectionSpan`; the quoted-in-a-fence cases are the fence contract the pin asserts.

**Files touched.** `test/backlog.test.ts` only — add `sectionSpan` to the existing `backlog-md.js` import and add the one test block. No `src/` file changes; no `docs/invariants.md` edit (no section-boundary section binds `sectionSpan`).

**Acceptance criteria.**
- The new test in `test/backlog.test.ts` passes on the current tree.
- A regression that read the `## ` heading or the section end boundary WITHOUT the fence guard fails the new test on the quoted-`## Done`-inside-a-fence cases (`{ heading: 0, end: 7 }` and the `null` case).
- The plain-section and EOF cases pin that the fence branch is a special case: an unfenced `## Done` still resolves to `{ heading: 3, end: 7 }` and a section with no following heading ends at `lines.length`.
- The pin does NOT add a duplicate of the two sibling readers' existing coverage: it tests `sectionSpan` only (not `fenceAwareHeadingLines` or `sectionBodyLines`, whose fence branches their consumers' tests already exercise).
- No `src/` file, `docs/invariants.md` line, or other test file changes — the change is confined to `test/backlog.test.ts`.
