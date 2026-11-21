# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### Fast session cleanup, part 2b/2: stopping the orchestrator abandons an in-flight session prune (planned 2026-11-16 by the operator, split 2026-11-21 by the plan role; requires Fast session cleanup part 2a/2 landed; touches src/agent/session-ledger.ts src/orchestrator/retention.ts src/orchestrator/orchestrator.ts test/retention.test.ts)

Sibling of "Fast session cleanup part 2a/2" (background deletes) and 2c/2 (alert wording).

**Goal.** Today a SIGTERM during the prune cannot reach the JS handler while `spawnSync` blocks,
so shutdown never runs: the 2026-11-16 instances stopped mid-prune (pids 4663, 15799) logged no
`orchestrator_stop`, handed off no merge and released no slot. Once 2a makes the pass async the
handler runs, but a pass still in flight keeps spawning deletes and holds the process open.

**Approach.**
- The two purges accept an optional `AbortSignal`: once it aborts, no further delete starts and
  each running delete child is killed (`spawn`'s `signal` option); the purge resolves with what it
  counted so far. Ids already handled stay in the resume record, so the next pass resumes there
  (part 1/2).
- `RetentionPruner` owns an `AbortController`; a new `stop()` aborts it and returns `whenIdle()`.
  The file/ledger-line passes do not run after an abort (they would trim lines whose sessions the
  aborted pass never reached).
- The orchestrator's graceful-shutdown path (src/orchestrator/orchestrator.ts, the drain before
  the `orchestrator_stop` event) calls `retentionPruner.stop()` and awaits it, bounded by the
  existing shutdown window.

**Acceptance criteria.**
- With a stub `codex` that sleeps 30 s per delete and several expired ids, `stop()` resolves
  within a couple of seconds, no stub process is left running, and the maintenance marker file is
  gone.
- After a stopped pass, ids it handled are in the resume record and a fresh `RetentionPruner` does
  not delete them again.
- An orchestrator stopped (via its stop signal) while such a prune is in flight logs
  `orchestrator_stop` within its shutdown window.

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

## Done
