# GitHub issues: mirror open issues into the backlog, close them when the fix is on main

Planned 2026-11-21 by the operator at the user's direction. Shared design for the five
`GitHub issues` entries in PLANS.md; each part's entry names what it needs from the others.
Siblings: plans/remote-ci.md (GitHub detection, `githubRepoOf`) and plans/feedback-role.md
(the `gh` readiness probe and the fake gh the tests use).

## The problem

Tumwater reads work only from its backlog files: BUGS.md `## Open` (the bugfix role), PLANS.md
`## Planned` (the feature role) and the director's prompt queue. It has no inbound path from
GitHub. `grep` over src/ for `gh issue list` or the issues API finds only outbound use: the
opt-in `feedback` role files issues *on* znation/tumwater (src/roles/role-catalog.ts), and the
ci role reads Actions runs (src/observer/remote-ci.ts). An issue someone opens on a project's
GitHub repo stays invisible to the team until a human copies it into a backlog file by hand, and
when the team fixes it nobody closes the issue.

Measured 2026-11-21 on tumwater's own repo: znation/tumwater has one open issue, #1 "Crash:
JavaScript heap out of memory (OOM) ~12s after tumwater run --gui startup" (opened by the owner
09:47 UTC). No entry in BUGS.md, PLANS.md, BUGS-FIXED.md or PLANS-DONE.md mentions it.

## Scope: every project, not tumwater's own repo

This feature is for **every project tumwater runs on**, not only tumwater itself (the user,
2026-11-21). Nothing in it names znation/tumwater. The repo is whatever the project's base branch
pushes to (`branch.<base>.remote`, default `origin`, parsed by `githubRepoOf`). Prompts, alerts
and close comments name that repo. Tests run against a fixture repo with a fake remote URL. A
project whose base branch has no remote, or a remote that is not on github.com, gets none of
this: no probe, no alert, no doctor warning (the doctor row reads "skipped: no GitHub remote").

## Decisions

1. **On by default when the project has a GitHub remote.** The user asked for it on every
   project. `githubIssues.enabled: false` in tumwater.json turns all of it off, and
   `githubIssues.close: false` keeps mirroring but never closes an issue. Both are listed in
   docs/config.md.

2. **The harness reads and closes issues through the operator's `gh`; the director writes the
   backlog entries.** This deliberately departs from remote-ci decision 2 and feedback-role
   invariant 2 ("the harness makes no network request"), and the reasons should be on record:
   - The scan has to run on a clock with no model run behind it. An hourly model run just to
     list issues would cost tokens on every project, most of the time for nothing.
   - The user wants a GUI alert when `gh` is missing or logged out. That state has to be probed
     by the harness, so it can be recorded and shown.
   - Closing is triggered by a fact the harness already observes deterministically: the mirror
     entry reaching a finished section on main. Leaving it to a model would make it
     probabilistic.
   What still holds from those decisions: tumwater has no HTTP code, stores no token and adds no
   credentials. Every GitHub call is a bounded `gh` child process running under the operator's
   own login (`gh api …`, `gh issue close …`), using the same `boundedProbe` and `childEnv` the
   doctor's `feedback filing` row already uses. Turning an issue into a good BUGS.md bug or
   PLANS.md plan takes judgment, and the director already does exactly that for the user's own
   messages (src/prompt/prompt.ts, "route it"), so the harness hands each issue to the director
   as a queued prompt.

3. **The grep phrase is `mirrors GitHub issue #<n>`**, inside the entry heading's trailing
   parenthetical, e.g. `### Heap OOM 12 s after `run --gui` starts (mirrors GitHub issue #1;
   filed 2026-11-21 by director)`. It goes in the heading because headings survive every move:
   the archive, the backlog index, a split. Match it as a word: `mirrors GitHub issue #1` must
   not match `#12` (a regex `mirrors GitHub issue #(\d+)\b`, numbers compared as integers).
   - When a mirrored entry is split into parts, **every part carries the phrase**.
   - A duplicate retire moves the phrase onto the survivor.
   - One entry may mirror several issues: `mirrors GitHub issues #4, #9`. The parser accepts both
     the singular and plural forms.
   Shell: `grep -n "mirrors GitHub issue" BUGS.md PLANS.md BUGS-FIXED.md PLANS-DONE.md`.

4. **Only issues the project's maintainers stand behind are mirrored.** An issue body is text
   from whoever opened it. Once mirrored, it lands in a director prompt and in a backlog entry
   that roles with a full shell act on, which makes it a prompt-injection path on any public
   repo. An open issue is *trusted* when its REST `author_association` is `OWNER`, `MEMBER` or
   `COLLABORATOR`, or when it carries the label `githubIssues.mirrorLabel` (default `tumwater`).
   A label can only be applied by someone with triage access, so a maintainer can vouch for an
   outside report (for example a `feedback` filing from another install) by labeling it.
   `githubIssues.authors: "anyone"` mirrors every issue. Untrusted issues are counted in the
   ledger and the GUI says how to let them in. They are never queued.

5. **Pace: one GitHub read per hour, one issue in the director's queue at a time.** The default
   scan interval is 60 minutes (`githubIssues.scanIntervalMinutes`, minimum 15) and the first
   scan runs one minute after team start. A scan is a single paginated `gh api` listing, capped
   at 5 pages (500 issues). Queueing is local and runs every poll, and it holds at most one
   issue prompt in the director's queue. Neither a repo with 300 open issues nor a first scan
   can flood the director or push a user's own message behind a batch.

6. **Close only when the fix is on GitHub's copy of the base branch.** Tumwater never pushes
   (remote-ci decision 1), so a fix merged on local main can be absent from GitHub for days, and
   a close comment citing it would link to a commit GitHub does not have. An issue is closed
   once every condition holds:
   - (a) every backlog entry carrying its phrase is in a finished section (BUGS.md/BUGS-FIXED.md
     `## Fixed`, `## Verified`; PLANS.md/PLANS-DONE.md `## Done`) at main's tip;
   - (b) at least one of those entries is a real fix, not a `retired` stamp;
   - (c) `gh api repos/<repo>/compare/<sha>...<branch>` answers `ahead` or `identical` for every
     cited sha, meaning each is an ancestor of the pushed branch.
   The close is `gh issue close <n> --repo <repo> --reason completed --comment <text>`. The
   comment cites each fix commit by short sha and subject, plus the backlog heading that
   mirrored the issue.
   - An entry that was **retired** (and no other entry finished it) never closes its issue; the
     GUI lists it instead.
   - An entry that was **refused** keeps its issue open, because a Refused note holds the entry
     in its live section.

7. **The fix commit is the commit that moved the mirror into a finished archive.**
   archiveNewFinishedEntries (src/backlog/backlog-archive.ts) moves a role's finished entry into
   BUGS-FIXED.md / PLANS-DONE.md in the same commit as the fix. So
   `git log --format=%H --pickaxe-regex -S'^### [^\n]*mirrors GitHub issues? [^\n]*#<n>([^0-9]|$)'
   <base> -- BUGS-FIXED.md PLANS-DONE.md` finds the fix commit for each finished part, newest
   first — anchored to a `### ` heading, because the phrase lives only in a heading, so a commit
   that merely quotes one in prose is not a fix (INV-DE5). A hand
   move (the operator closes the entry in a later commit) cites that later commit, which is
   still a commit on main that records the fix. The director can also report an issue as
   already fixed (part 4's `ISSUE: #<n> — fixed in <sha>`). That sha is cited when it is an
   ancestor of main.

8. **A reopened issue is mirrored again.** If tumwater closed an issue and it is open again
   with every phrase-carrying entry finished, someone disagrees with the fix. The issue is
   treated as unmirrored, and its director prompt says it was reopened after tumwater closed it
   citing `<sha>`. The new entry then holds condition (a) until it is fixed. The next close
   cites only commits newer than the previous close.

## Invariants

1. **No GitHub call without a GitHub remote, and none when disabled.** The detection is local
   git config. `githubIssues.enabled: false` makes zero `gh` invocations.
2. **No GitHub call on a status poll.** `gh` runs only in the orchestrator's scan step and in
   `tumwater doctor`. The GUI and `tumwater status` read the ledger.
3. **No test reaches a real `gh`.** Every `gh` call goes through one injectable runner. Tests use
   the fake from test/fakes/fake-gh.ts, extended to answer `api` and `issue close`.
4. **An untrusted issue's text never reaches a prompt or a backlog file.**
5. **An issue is closed only by decision 6's conditions**, and at most once per reopen.
6. **Every tumwater write to GitHub is an event.** `github_issue_closed` carries the issue, the
   repo and the cited shas.

## State

`.tumwater/state/github-issues.json` (`githubIssuesPath(root)` in src/paths.ts), written
atomically by the scan, the queue step and the close step:

```
{ repo, branch, checkedAt,
  gh: "ok" | "missing" | "unauthenticated" | "error", reason?,
  open: [{ number, title, url, author, trusted, labels, updatedAt, bodyExcerpt }],   // ≤ 500
  queued:   { "<n>": { at, updatedAt } },        // a director prompt was queued
  declined: { "<n>": { at, updatedAt, reason } }, // director said not actionable
  fixedIn:  { "<n>": { sha, at } },              // director said already fixed
  closed:   { "<n>": { at, shas } },             // tumwater closed it
  waitingPush: { "<n>": shas },                  // finished on main, not on GitHub yet
  retiredOnly: [n] }                             // open, every entry retired: listed, never closed
```

`bodyExcerpt` is at most 2,500 characters so the composed director prompt stays under
`DIRECTOR_PROMPT_MAX_CHARS` (4,096). The director reads the rest with `gh issue view`.

## Parts

1. **Detection, readiness, config, doctor row.**
2. **The scan and the ledger** (requires 1).
3. **GUI alerts** (requires 2).
4. **Mirroring through the director** (requires 2), split into 4a (director prompt text), 4b (recording the `ISSUE:` result) and 4c (the queue, requires 4a and 4b).
5. **Closing on the fix** (requires 2; reads part 4's `fixedIn` when present).

Parts 3, 4 and 5 are independent of one another. The PLANS.md entries carry each part's files
and acceptance criteria.

## Not in scope

- Pull requests. The issues listing returns PRs as well, and they are dropped (`pull_request`
  key present).
- Syncing comments, labels or edits after mirroring. A later edit bumps `updatedAt`, which only
  lets a declined issue be offered again.
- Closing or editing a mirror entry because its issue was closed on GitHub. The entry stays
  open. A follow-up could note "closed upstream" on it.
- Pushing. The user pushes, and closing waits for that push (decision 6).
- Mirroring into any file other than BUGS.md and PLANS.md, and any tracker other than GitHub.
