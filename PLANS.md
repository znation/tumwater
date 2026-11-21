# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

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

### GitHub issues, part 2/5: the orchestrator scans a project's open GitHub issues on a clock and records which ones no backlog entry mirrors (planned 2026-11-21 by the operator; requires GitHub issues part 1/5 landed; touches src/github/issue-scan.ts src/github/issue-mirrors.ts src/github/github-issues-state.ts src/paths.ts src/orchestrator/orchestrator-poll.ts src/events/events.ts test/github-issue-scan.test.ts test/github-issue-mirrors.test.ts test/fakes/fake-gh.ts)

**Goal.** A running team reads the project's open GitHub issues about once an hour through the
operator's `gh`. It records in `.tumwater/state/github-issues.json` whether `gh` worked, which
issues are open and trusted, and which of them no backlog entry mirrors yet. Parts 3–5 read
that ledger. This part only reads GitHub, and writes nothing to the backlog or to GitHub.

**Approach.** Follow plans/github-issues.md "Decisions" 3–5 and "State".
- src/github/issue-mirrors.ts, pure: `mirroredIssueNumbers(text): Set<number>` parses every
  `mirrors GitHub issue #<n>` and `mirrors GitHub issues #<a>, #<b>` occurrence in headings,
  matching `#\d+` as a whole number. `mirrorStates(files)` reads BUGS.md, PLANS.md,
  BUGS-FIXED.md and PLANS-DONE.md at the base branch's tip with `fileContentAt` and maps each
  number to its entries `{ file, section, heading, retired }`. Sections and entries are
  located with `sectionSpan` / `actionableEntryRanges` (src/backlog/), never with new heading
  parsing.
- src/github/github-issues-state.ts: the ledger type, `readGithubIssues(root)` (missing or
  malformed returns null), and `writeGithubIssues(root, …)` through `writeJsonAtomic`.
  `githubIssuesPath(root)` lives in src/paths.ts.
- src/github/issue-scan.ts: `scanGithubIssues(root, config, run = defaultGhRunner)`.
  - Return early when `enabled` is false or `githubTarget` is null.
  - When `ghReadiness` is not `ok`, record `gh` and the reason and return.
  - Otherwise run `gh api -X GET repos/<repo>/issues -f state=open -f per_page=100
    --paginate` and stop after 5 pages. Drop items that carry `pull_request`.
  - Mark `trusted` per decision 4 (author_association OWNER/MEMBER/COLLABORATOR, the
    `mirrorLabel` label, or `authors: "anyone"`).
  - Keep `bodyExcerpt` to 2,500 characters, and only for trusted issues.
  - Record `checkedAt`. A non-zero exit or unparsable JSON records `gh: "error"` with the
    stderr's first line and keeps the previous `open` list.
- src/orchestrator/orchestrator-poll.ts: `pollGithubIssues` sits beside `pollOrphanReap` and
  takes the same shape: a `state.lastGithubScanAt` stamp, `dueForGithubScan(last, now,
  intervalMs)`, and a first scan 60 s after team start. It awaits the scan inside the poll's
  error boundary, so a throw logs one warning and never fails the poll.
- src/events/events.ts: add a `github_issues_unavailable` event that fires only when `gh` turns
  from ok (or unknown) to not-ok, with repo and reason, so the log gets one line per outage
  rather than one per hour.
- test/fakes/fake-gh.ts: answers `api repos/<repo>/issues` with a configured list.

**Acceptance criteria.**
- `mirroredIssueNumbers` finds 1 and 12 in `(mirrors GitHub issue #1; …)` plus
  `(mirrors GitHub issues #12, #3)`, finds 3 too, and never reads `#12` as 1. A heading without
  the phrase yields nothing.
- `mirrorStates` places an entry under `## Fixed` in BUGS-FIXED.md as finished, and an entry
  with the `retired` stamp in PLANS-DONE.md as retired.
- With the fake gh answering three issues (an OWNER bug, a NONE-association issue, a NONE issue
  labeled `tumwater`) and one PR, the ledger lists three open issues. Two are trusted, the PR is
  absent, and the untrusted one has no `bodyExcerpt`.
- Scheduling: a second scan inside the interval makes zero gh calls, and one after it makes the
  listing call. `enabled: false` makes zero calls ever.
- gh logged out → `gh: "unauthenticated"`, and exactly one `github_issues_unavailable` event
  across two consecutive scans.

### GitHub issues, part 3/5: the GUI warns when a project has a GitHub remote but `gh` is missing or logged out, and shows issues waiting to be mirrored (planned 2026-11-21 by the operator; requires GitHub issues part 2/5 landed; touches src/status/status-data.ts src/ui/team-alert-status.ts test/status-data.test.ts test/team-alert-status.test.ts)

**Goal.** The operator sees in the dashboard, without running doctor, that tumwater cannot read
the project's GitHub issues and what to do about it. They also see when trusted issues are
waiting to be mirrored, and when outside issues need a maintainer's label. The GUI only reads
part 2's ledger and never runs `gh` (plans/github-issues.md invariant 2).

**Approach.**
- src/status/status-data.ts: add `githubIssues?: GithubIssuesSummary` to `StatusSnapshot`.
  Read it fresh from `readGithubIssues(root)` and fold it to
  `{ repo, gh, reason, checkedAt, unmirrored, untrusted, waitingPush }`. `waitingPush` stays
  0 until part 5 writes it. It is absent when there is no ledger or the config disables the
  feature.
- src/ui/team-alert-status.ts, three alerts:
  - amber, key `github-gh`, when `gh` is `missing` or `unauthenticated`. Title `Can't read
    GitHub issues for <repo>`. Detail is part 1's doctor text for the case ("gh is missing —
    install GitHub CLI …" / "gh is not logged in — run `gh auth login` …"). Both the row and
    the alert take the sentence from one exported helper in src/github/gh.ts, so they cannot
    drift.
  - gray, key `github-error`, when `gh` is `error`. Title `Last GitHub issue scan failed`,
    with the reason and the scan's age.
  - blue, key `github-mirror`, when `unmirrored > 0` or `untrusted > 0`. Detail like `2 open
    issues on <repo> are waiting for the director to mirror them · 3 from outside
    collaborators are not mirrored — add the label \`tumwater\` to let one in`. Leave out
    whichever clause is 0, and name the configured `mirrorLabel`.
- Order: amber with the other actionable alerts; gray and blue after the backlog alerts.

**Acceptance criteria.**
- A snapshot whose ledger reads `gh: "unauthenticated"` raises exactly the amber alert, and its
  detail equals the doctor row's warn sentence for that case. `missing` does the same with the
  missing sentence.
- `gh: "ok"` with `unmirrored: 0, untrusted: 0` raises none of the three.
- Counts 2 and 3 produce the blue detail above with the configured label, and 2 and 0 drop the
  outside-collaborators clause.
- No ledger and `githubIssues.enabled: false` both raise nothing.
- Manual check: on a scratch clone with a github.com remote, set `GH_CONFIG_DIR` to an empty
  directory for the team so gh reads as logged out. Within one scan after start, the dashboard
  shows the amber banner naming the repo and `gh auth login`.

### GitHub issues, part 4/5: each unmirrored, trusted open issue goes to the director, which files it in BUGS.md or PLANS.md tagged `mirrors GitHub issue #<n>` (planned 2026-11-21 by the operator; requires GitHub issues part 2/5 landed; touches src/github/issue-queue.ts src/orchestrator/orchestrator-poll.ts src/prompt/prompt.ts src/roles/role-guidance.ts src/verdict/reply-contract.ts src/runner/runner-run.ts src/events/events.ts test/github-issue-queue.test.ts test/reply-contract.test.ts test/role-guidance.test.ts test/orchestrator-director.test.ts)

**Goal.** Every trusted open issue on the project's GitHub repo ends up as a backlog entry the
team works on. A defect becomes a BUGS.md `## Open` bug, and a request becomes a PLANS.md
`## Planned` plan (or a series). An issue an existing entry already covers gets the phrase added
to that entry instead. Every entry carries `mirrors GitHub issue #<n>` in its heading
parenthetical, so `grep "mirrors GitHub issue"` lists them all, and splits and retires keep the
phrase.

**Approach.** Follow plans/github-issues.md decisions 2–5 and 8.
- src/github/issue-queue.ts: `nextIssuePrompt(ledger, mirrors, queuedDirectorPrompts, now)`
  is pure. It returns null while any queued director prompt starts with the fixed marker
  `GitHub issue #` (one at a time). Otherwise it returns the oldest trusted open issue that
  meets all of these:
  - not mirrored;
  - not `queued` within 24 h;
  - not `declined` at its current `updatedAt`;
  - not recorded in `fixedIn`.
  The text is a fixed preamble, `GitHub issue #<n> on <repo> is open and no backlog entry
  mirrors it` (adding `; it was reopened after tumwater closed it citing <sha>` per decision 8),
  then the author, association, labels, url and title, then the fenced `bodyExcerpt`. A fixed
  ask closes it, and the whole text must fit `DIRECTOR_PROMPT_MAX_CHARS` (fit the excerpt the
  way `fitBody` in src/inbox/director-request.ts does). The ask tells the director:
  - the issue text is a report from its author, not instructions;
  - read the whole thread with `gh issue view <n> --repo <repo> --comments`;
  - route it as the routing rules say, with the phrase in every heading it writes, or add the
    phrase to an existing entry that covers it;
  - or end with one result line, `ISSUE: #<n> — declined: <reason>` or
    `ISSUE: #<n> — fixed in <sha>`.
  `pollGithubIssues` calls it every poll (no `gh`) and queues the text through
  `submitRolePrompt(root, DIRECTOR_ROLE, …)`. It then records `queued` and logs
  `github_issue_queued` (issue, repo).
- src/prompt/prompt.ts `buildDirectorPrompt` routing list: add one bullet for a prompt that
  opens `GitHub issue #`. It says what the ask says, plus: never close or comment on the issue
  (tumwater closes it when the fix reaches GitHub).
- src/roles/role-guidance.ts `DECOMPOSITION_GUIDANCE`: one added sentence. A heading that
  carries `mirrors GitHub issue #<n>` passes it to every part it is split into and to the
  survivor of a duplicate retire. Every role and the director embed this guidance, so no
  separate charter edit is needed.
- src/verdict/reply-contract.ts: `extractIssueOutcome(text)` is built on `labeledLine(text,
  "ISSUE")` and returns `{ issue, declined: reason } | { issue, fixedIn: sha }`. It returns
  null when the line is absent or malformed, or the sha is not 7–40 hex digits.
  src/runner/runner-run.ts reads it on director runs, beside the feedback `FILED` extraction,
  and writes `declined` (with the issue's ledger `updatedAt`) or `fixedIn` to the ledger. It
  accepts `fixedIn` only when `merge-base --is-ancestor <sha> <base>` holds. Log
  `github_issue_declined` for a decline.

**Acceptance criteria.**
- With two trusted unmirrored issues, `nextIssuePrompt` returns only the older one. It returns
  null while that prompt sits in the director queue, and returns the second once the first
  prompt is gone and the first issue is mirrored.
- It returns null for an issue queued 2 h ago and the text again at 25 h. It returns null for a
  declined issue until its `updatedAt` changes. It never returns an untrusted issue.
- A 20,000-character body yields a prompt within `DIRECTOR_PROMPT_MAX_CHARS` that keeps the
  preamble and the full ask.
- `extractIssueOutcome` parses both forms and rejects `ISSUE: 12 — declined: x` (no `#`),
  `ISSUE: #12 — fixed in zz`, and a mid-sentence mention.
- The director prompt built for a queued issue contains the routing bullet, and every
  role's prompt contains the phrase-preservation sentence (test/role-guidance.test.ts).
- End to end in test/orchestrator-director.test.ts with the fake gh and a fake director model
  that appends `### Crash on start (mirrors GitHub issue #1; filed … by director)` to BUGS.md:
  after the director's change merges, the next scan finds #1 mirrored and queues nothing.

### GitHub issues, part 5/5: when every entry mirroring an issue is finished and the fix is on GitHub's base branch, tumwater closes the issue citing the fix commit (planned 2026-11-21 by the operator; requires GitHub issues part 2/5 landed; touches src/github/issue-close.ts src/orchestrator/orchestrator-poll.ts src/status/status-data.ts src/ui/team-alert-status.ts src/events/events.ts test/github-issue-close.test.ts test/team-alert-status.test.ts test/fakes/fake-gh.ts)

**Goal.** An issue that tumwater mirrored and fixed does not stay open on GitHub. When the fix
is on the branch GitHub serves, tumwater closes the issue as the operator's `gh` login. The
comment cites the fix commit(s) and the backlog entry, for example: `Fixed on main in 1a2b3c4d
("tumwater(bugfix): Cap the GUI's history read …"). Closed by tumwater, which mirrored this
issue as BUGS.md entry "Heap OOM 12 s after run --gui starts".` Fixes not pushed yet wait, and
the GUI says so.

**Approach.** Follow plans/github-issues.md decisions 6–8. The step runs right after each scan
in `pollGithubIssues`, and only when `githubIssues.close` is not false and `gh` is `ok`.
- src/github/issue-close.ts: `closeCandidates(ledger, mirrorStates)` is pure. It returns each
  open issue where either:
  - every phrase-carrying entry is finished and at least one is not retired; or
  - the ledger has a `fixedIn` sha for it.
  It skips issues `closed` at or after their current `updatedAt`, unless decision 8's reopen
  applies.
- `fixCommits(root, base, n, since?)` runs `git log --format=%H%x00%s --pickaxe-regex
  -S'<phrase regex for n>' <base> -- BUGS-FIXED.md PLANS-DONE.md BUGS.md PLANS.md`. It keeps
  the commits that increased the phrase's count in a finished section, newer than `since` (the
  previous close), plus any `fixedIn` sha.
- For each candidate's shas, run `gh api repos/<repo>/compare/<sha>...<branch> --jq .status`.
  If any is not `ahead`/`identical`, record `waitingPush[n] = shas` and stop. Otherwise run
  `gh issue close <n> --repo <repo> --reason completed --comment <text>`. On exit 0, record
  `closed[n] = { at, shas }`, clear `waitingPush[n]`, and log `github_issue_closed` (issue,
  repo, shas). On failure, log a warning and leave the ledger as it was, so the next scan
  retries.
- An issue whose entries are all retired is listed as `retiredOnly` and never closed.
- status-data folds `waitingPush` and `retiredOnly` counts. src/ui/team-alert-status.ts adds a
  blue alert, key `github-close`, e.g. `1 GitHub issue is fixed on main and closes when you
  push main to <repo>`, and when retired-only is non-zero, `· 1 mirrored issue's entries were
  all retired — close or re-file it on GitHub`.
- test/fakes/fake-gh.ts: answers `api …/compare/…` per configured ancestry and records
  `issue close` calls with their args.

**Acceptance criteria.** All in a fixture repo with a fake github.com remote and the fake gh.
- A bug mirrored as `#1` is moved to BUGS-FIXED.md in commit X, and the fake compare answers
  `ahead`. The next scan closes #1 exactly once. The recorded comment contains X's short sha,
  X's subject and the entry heading, `--reason completed` is passed, and a
  `github_issue_closed` event names X.
- The same with compare answering `behind`: no close call is made, `waitingPush` names X, and
  the blue alert says 1 issue closes on push. Then compare answers `ahead` and the issue closes.
- A plan split into parts 1/2 and 2/2, both mirroring `#4`, with only 1/2 done → #4 stays open.
  Once both are done, the close cites both commits.
- A mirror whose only entry was retired is never closed and is counted retired-only.
- `githubIssues.close: false` makes zero `issue close` calls with a finished mirror on main.
- After tumwater closes #1, the ledger shows it open again with a newer `updatedAt` and a new
  live entry mirrors it → no close. When that entry is fixed in commit Y, the close cites only
  Y.
- `#1`'s finished entry never triggers a close of `#12`.

### Self-declared check, part 2/3: the no-check alert becomes a blue info message saying tumwater is declaring a check (planned 2026-11-21 by the director role; "requires part 1/3 landed"; touches src/doctor/doctor-project-checks.ts src/ui/team-alert-standings.ts test/doctor-checks.test.ts test/team-alerts.test.ts docs/invariants.md docs/feature-doctor.md)

**Goal.** The operator asked on 2026-11-21 that this condition be an info message, not a
warning, saying the project will get a gate check, because part 1/3 now creates one
automatically. Under PRINCIPLES.md ("raise a UI warning only for what the operator must act
on"), a state the system settles on its own is not amber.

**Approach.**
- `checkBuildCheck` (src/doctor/doctor-project-checks.ts): when no check is declared, return
  `okOutcome` instead of `warnOutcome`, with this detail: `none declared yet — tumwater is
  declaring one: the director finds this project's test, typecheck or build command and
  declares it, and the review gate's build pre-check, the red-main baseline and redeploy's
  green check turn on once it merges`. Rewrite the function's doc comment: it currently
  argues the warn level, and its 2026-09-05 rationale is superseded by the operator's
  2026-11-21 request.
- `pushNoCheckAlert` (src/ui/team-alert-standings.ts) stops using `pushDoctorTwinAlert`
  (which raises only on a warn row). It pushes `{ key: "no-check", tone: "blue", title:
  "Declaring a build check", detail: <the row's detail>, actions: [] }` whenever it is called.
  `buildStandingAlerts` already calls it only under the snapshot's `noDeclaredCheck` flag.
  Update `pushDoctorTwinAlert`'s doc comment, which lists no-check among its users.
- docs/invariants.md INV-T6: no-check leaves the "standing amber alerts" list. It is now the
  one standing blue alert, still gated by `noDeclaredCheck` and still worded by
  checkBuildCheck's detail. docs/feature-doctor.md: update the `check` row's description if
  it says "warn".

**Acceptance criteria.**
- test/doctor-checks.test.ts: with no check, the `check` row has level `ok` and the new
  detail (its existing exact-text case is updated, since this sentence is the row's
  contract).
- test/team-alerts.test.ts: under `noDeclaredCheck` the `no-check` alert has tone `blue`,
  title "Declaring a build check", and detail equal to `checkBuildCheck`'s detail. The old
  `plan role will plan this project's check` match is gone. Without the flag there is no
  `no-check` alert. "tumwater status prints the standing no-check banner from the snapshot's
  flag" now matches the new title.
- No source or test file still contains the old sentence "set `check.command` in tumwater.json
  for a non-npm repo" (checked by grep).

### Self-declared check, part 3/3: retire the plan/feature no-check notes, so the director's automatic request is the one way a check gets declared (planned 2026-11-21 by the director role; "requires part 1/3 landed"; touches src/prompt/gate-notes.ts src/run/run-prompt.ts src/prompt/prompt.ts src/backlog/backlog.ts src/roles/role-guidance.ts src/roles/role-catalog.ts test/gate-notes.test.ts test/run-prompt.test.ts docs/invariants.md)

**Goal.** "Prefer one sensible way." After part 1/3, a missing check has two cures: the
director's single-run request, and the slower route where a plan run writes a marked entry
and a feature run builds it. Retire the second, so a plan run is never spent writing a
declaration the director is already making.

**Approach.**
- Delete `buildNoCheckNote` (src/prompt/gate-notes.ts) and the `noCheck` note it feeds in
  src/run/run-prompt.ts (the `declaration`/`noCheck` block and its field on the returned
  notes) and src/prompt/prompt.ts (the no-check note slot and its rendering).
- Delete `declarationPlanEntry` (src/backlog/backlog.ts) and `CHECK_DECLARATION_MARKER`
  (src/roles/role-guidance.ts), plus the role-catalog.ts charter sentences that cite them
  (the plan charter's "write the declaration entry before anything else" and the feature
  charter's `<no-check>` sentence). Grep `CHECK_DECLARATION_MARKER|declarationPlanEntry|
  buildNoCheckNote|<no-check>` across src, test and docs, and remove or reword every hit.
- Delete their tests in test/gate-notes.test.ts and test/run-prompt.test.ts. Keep or add one
  run-prompt case showing that a plan or feature prompt for a project with no check contains
  no `<no-check>` block.
- docs/invariants.md: remove or reword any guarantee that pins the plan/feature no-check
  notes.

**Acceptance criteria.**
- A grep for `CHECK_DECLARATION_MARKER`, `declarationPlanEntry`, `buildNoCheckNote` and
  `<no-check>` over src/ and test/ finds nothing.
- test/run-prompt.test.ts: a plan prompt and a feature prompt built for a repo with no
  declared check contain no `<no-check>` block.
- The project's check passes.

## Done
