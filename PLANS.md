# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### GitHub issues, part 4c/5: the orchestrator queues each unmirrored, trusted open issue to the director, one at a time (planned 2026-11-21 by the operator, split 2026-11-21 by the plan role; requires GitHub issues parts 4a/5 and 4b/5 landed; touches src/github/issue-queue.ts src/github/issue-scan.ts src/github/github-issues-state.ts src/events/events.ts test/github-issue-queue.test.ts test/orchestrator-director.test.ts)

Split from part 4/5 (too large for one run). It requires part 4a/5, so the director knows how to
route what it is sent, and part 4b/5, so a declined or already-fixed issue is not offered again.

**Goal.** Every trusted open issue that no backlog entry mirrors reaches the director as a
prompt, one at a time, without re-queuing it every poll (plans/github-issues.md decisions 2–5
and 8).

**Approach.**
- New src/github/issue-queue.ts: `nextIssuePrompt(ledger, mirrors, queuedDirectorPrompts, now)`
  is pure. It returns null while any queued director prompt starts with `GitHub issue #`. Otherwise
  it returns the oldest trusted open issue that meets all of these:
  - not mirrored (src/github/issue-mirrors.ts);
  - not `queued` within 24 h;
  - not `declined` at its current `updatedAt`;
  - not in `fixedIn`.
  The text has three pieces:
  - The preamble `GitHub issue #<n> on <repo> is open and no backlog entry mirrors it`. If
    `closed` records #n, append `; it was reopened after tumwater closed it citing <sha>`
    (decision 8).
  - The author, association, labels, url and title, then the fenced `bodyExcerpt`.
  - A short fixed ask that points at the routing bullet from 4a/5: read the thread, route or
    decline.
  The whole text fits `DIRECTOR_PROMPT_MAX_CHARS`. Trim the excerpt the way `fitBody` in
  src/inbox/director-request.ts does, never the preamble or the ask.
- src/github/github-issues-state.ts: add `queued?: Record<string, { at; updatedAt }>`.
- src/github/issue-scan.ts `pollGithubIssues`: on every poll, not only when a scan is due, and
  with no `gh` call, call `nextIssuePrompt`. If it returns text, queue that text with
  `submitRolePrompt(root, DIRECTOR_ROLE, …)`, record `queued`, and log `github_issue_queued`
  (issue, repo).

**Acceptance criteria.**
- With two trusted unmirrored issues, `nextIssuePrompt` returns only the older one. It returns
  null while that prompt sits in the director queue. Once that prompt is gone and the first issue
  is mirrored, it returns the second.
- It returns null for an issue queued 2 h ago and the text again at 25 h. It returns null for a
  declined issue until its `updatedAt` changes, and for an issue in `fixedIn`. It never returns
  an untrusted issue.
- A 20,000-character body yields a prompt within `DIRECTOR_PROMPT_MAX_CHARS` that keeps the
  preamble and the full ask.
- End to end in test/orchestrator-director.test.ts, using the fake gh and a fake director model
  that appends `### Crash on start (mirrors GitHub issue #1; filed … by director)` to BUGS.md:
  the poll queues one prompt for #1. After the director's change merges, the next poll finds #1
  mirrored and queues nothing.

## Done
