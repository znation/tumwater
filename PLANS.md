# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

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

### A staging self-check flags a comment block the change duplicated verbatim beside its original, so a comment move that left two copies — the shape three Fixed bugs and this week's re-point runs show — is caught on the authoring turn instead of surviving as prose that reads twice (planned 2026-11-19 by the steward role; promotes the recurring `no-observability` validation gap, cited below)

**Gap being retired.** `no-observability` is the third-largest validation-gap tag across BUGS.md and
its archive (70 entries; `none` 208, `no-repro` 111, `unclear-invariant` 109). Three Fixed entries
carry it with the *same* sentence shape — a comment defect that leaves no trace in any check, so
only a human or loop reading the changed region finds it:

- BUGS-FIXED.md:4863 — `scripts/release.mjs`'s header comment still promised a direct npm publish
  after 5a2733e5 switched the workflow to stage-only publishing (fixed 2026-10-04).
- BUGS-FIXED.md:4915 — commit a412d97d meant to MOVE the `INITIAL_PROMPT_MAX_CHARS` rationale in
  `src/init/init.ts` and instead duplicated it verbatim, leaving two adjacent copies (fixed 2026-10-04).
- BUGS-FIXED.md:4951 — commit a0cff2bf meant to MOVE the TUI's ink-render comment and instead
  duplicated it verbatim, one copy garbled mid-sentence (fixed 2026-10-02).

Each has the same validation sentence: "no runtime trace, so no test or check can fail on it; only
reading the region confirms it." The same shape is still being paid for: six merged commits between
2026-11-14 and 2026-11-17 exist only to re-point comment prose a move or a behavior change left
behind (9e6e51bc, c5820f61, f6e2431a, e258603d, dd3d784a, c4fb62f2), each one a whole run and a
whole review spent on prose. This is the promote case for the tag: the same area recurs, and the
missing infra does not yet exist.

**What already exists (not this entry's target).** The staging self-check family
(`src/stage/stage-check.ts`'s `stageCheckFindings` → `gitLevelFindings`, gathered from
`stage-path-checks.ts`, `stage-name-checks.ts`, `stage-prose-checks.ts`) already owns four adjacent
rules, and none of them reads a duplicated comment block:

- `movedSourceFindings` greps the staged tree for the moved file's **full path** (`pathGrepHits` +
  `hasStandalonePathOccurrence`) and needs the source to be an `M` file with at least
  `MOVED_LINES_MIN` (10) verbatim-moved lines. It cannot see the basename form a comment actually
  uses (`main-watch.ts`, not `src/baseline/main-watch.ts`) — which is why e258603d, dd3d784a and
  c5820f61 were needed after the `createMainWatch` split. Closing that basename gap is a different
  entry.
- `staleReferenceFindings` fires only for `D` and `R` paths.
- `staleNameFindings` / `movedNameFindings` read identifiers, not comment blocks.
- `garbledWordingFindings` catches doubled *words* and broken participles, and its module doc says
  so; a block repeated verbatim in full is not a doubled word.
- `test/comment-width.test.ts` bounds comment line width only.

**Goal.** Add one staging finding that reads the `-U0` diff `gitLevelFindings` already builds and
reports a comment block the change left duplicated: the same run of comment lines appearing twice
in the same file, at least one copy fully inside lines the change touched. Like the rest of the
family it is staging-only (the gate does not run these), language-neutral, and capped, so the
author gets one fix-up turn instead of a reviewer spending a landing on prose.

**Approach.** One new exported finding beside the three prose checks in
`src/stage/stage-prose-checks.ts` (the module whose header already names it "the dormant staging
self-check"'s prose family), appended by `gitLevelFindings` next to `garbledWordingFindings` and
`detachedDocFindings`:

- Read the touched files' post-change text through the existing `readTextOrNull` and the existing
  `closesDocComment` / `DOC_TARGET` helpers; a comment block is a run of lines that are comment-only
  or block-comment continuation lines, trimmed, joined with `\n`.
- Report only a block of at least three comment lines whose exact joined text occurs twice in the
  same file at different line numbers, where at least one occurrence overlaps a `+` line of that
  file's hunks. Two pre-existing copies untouched by the change stay silent, exactly as the family's
  other checks only read what the change did.
- Name the file and both `file:line` sites, and cap the finding with a new module-private
  `MAX_DUPLICATED_DOCS` following `MAX_DETACHED_DOCS` (10). Wording ends with the action the other
  findings take: keep one copy, or make the two copies say different things.
- Update the module header and `stage-check.ts`'s numbered paragraph (it enumerates the family: "A
  fourth check … A fifth … A sixth … A seventh …") so the new check is named in the same voice.
- No merge-gate refusal, no `docs/invariants.md` change unless the run adds a Binds entry: INV-BK1
  binds only the ten-path/ten-hit caps and INV-BK2 only `gitLevelFindings`'s index restore, so a new
  finding inside the same gatherer leaves both true.

**Acceptance criteria.**
- `test/stage-check.test.ts` (the file that already pins `duplicatePlanFinding`, the detached-doc
  and the garbled-wording shapes) gains cases whose expected values are worked from the rule above,
  not from the code: a move that leaves two adjacent identical four-line comment blocks yields
  exactly one finding naming both sites; a single copy yields none; a two-line repeat yields none;
  a repeat untouched by the change yields none.
- The `+`-overlap case is pinned: the same tree with the duplicate pre-existing and the change
  touching only unrelated lines yields no finding.
- `npm run test:gate` passes; the family stays staging-only, so no `src/review` or `src/merge`
  behavior changes.

**Files touched.** `src/stage/stage-prose-checks.ts`, `src/stage/stage-path-checks.ts` (the one
`gitLevelFindings` append line), `src/stage/stage-check.ts` (header paragraph only),
`test/stage-check.test.ts`.

## Done
