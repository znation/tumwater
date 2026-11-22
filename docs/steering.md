# Steering tumwater

tumwater runs a team of specialist roles inside your git repo. Each role takes one backlog entry,
makes one small reviewed change, and merges it to main. The team does the volume work; the
direction comes from you. What you steer with is markdown: PLANS.md holds planned work, BUGS.md
holds found bugs, and QUESTIONS.md holds what the roles want decided. Running the team hands-off
works — `tumwater start --for 8h` for a bounded window, `tumwater start --once` for one round — and
it is how you try a project or run a scheduled round. It is not where tumwater does its best work:
with nothing in the backlog but the brief, the team chooses what to work on.

## The three ways to steer

In the order they are worth doing, most first:

1. **Your own agent, in the repo — the primary way.** In a second terminal, open claude, codex, or
   omp in the same directory and have it read and write PLANS.md and BUGS.md. It has your
   conversation, your judgment, the whole repo, and the strongest model you have: this is where a
   vague wish becomes an entry one run can finish, and where design decisions get made. Run
   `tumwater guide` first and hand its output to that agent — it prints the working rules, versioned
   with this install, so it always names the commands you have.
2. **The director prompt, for quick steering without leaving the dashboard.** The dashboard's prompt
   box or `tumwater prompt "<text>"` in a terminal puts a message in the director's inbox and the
   director acts on it in its next run; `--role <id>` aims one message at a named role's next run.
   Use it to nudge priorities ("finish the backlog's check entry before anything else"), not to
   design a change.
3. **Answering the questions the team raises.** `tumwater questions` lists what the roles asked that
   nobody has answered — a fork they should not guess at. `tumwater questions answer <n> "<text>"`
   records your answer and wakes the role that asked.

## Day to day

1. `tumwater init "<brief>"`, then `tumwater start` — or `tumwater start --gui`, which also serves
   the dashboard at http://127.0.0.1:7180.
2. In a second terminal, open your own agent in the same repo and tell it to run `tumwater guide`
   before it does anything else.
3. Have it orient first: `tumwater status`, `tumwater history --result problems`,
   `tumwater plan --list`, `tumwater bug --list`, `tumwater questions`, `tumwater doctor`, and
   `tumwater issues` on a repo whose GitHub issues the mirror reads.
4. Ask it to investigate what you care about, then to file, sharpen, reorder, or retire entries —
   one entry at a time with `tumwater plan` and `tumwater bug`, or by editing the backlog files and
   putting the commit on main with `tumwater land`.
5. Watch what merges — the dashboard, `tumwater status`, `tumwater logs -f`, `tumwater history` —
   and steer again from what you see.

## What makes a good entry

One entry is one run's worth of work: one focused change, small enough to be reviewed as a diff.
Its body says what is true afterwards (Goal), which files and functions change and how (Approach),
every path it touches so a reviewer can check the diff against it (Files touched), what you would
run to confirm each claim (Acceptance criteria), and where each test's expected value comes from.
Work too big for one run becomes a numbered series whose parts name the part they wait on. An entry
that reads as a wish ("make the CLI friendlier") gets reworked into something checkable before a run
can take it; that reworking is your agent's job, and `tumwater guide` carries the full rules.

## Naming the GitHub issue an entry answers

With a GitHub remote and `gh` logged in, the mirror reads the repo's open issues on its own clock
(`githubIssues.scanIntervalMinutes`) and offers the trusted ones to the director, one at a time. By
default an issue is trusted when its author is the repo's owner, a member, or a listed
collaborator, or it carries the configured `githubIssues.mirrorLabel`. An entry that answers such
an issue names it in its `### ` heading with `mirrors GitHub issue #4`, or `mirrors GitHub issues
#4, #9` when one entry answers several. Only a `### ` heading counts, so the same phrase in an
entry's body mirrors nothing, and every entry that answers the issue carries the phrase, so the
link survives a split into a series. Then leave the issue itself alone: while
`githubIssues.close` is on (the default) tumwater closes it, citing the fix commits, once they are
on GitHub's copy of the base branch and every entry mirroring it sits in a `## Done`, `## Fixed` or
`## Verified` section, and closes nothing whose mirroring entries were all retired. `tumwater
issues -f` watches that happen; `tumwater guide` carries the same rules for your agent.

An issue can also leave GitHub on its own — closed upstream, deleted, or converted to a PR. The next
complete scan notices it is gone and keeps a record of it in the mirror's ledger, so a lost issue
leaves a trace instead of vanishing: `tumwater issues` lists those rows last, under a `closed
upstream` count in the header, and ages them by when the mirror last saw them open rather than by a
close date tumwater cannot have. Such a row is never mirrored and never counted as unmirrored, so it
holds nothing up — it is the mirror's own record, not a request.

## Getting your own edit onto main

Edits to one entry at a time go through the write commands — `tumwater plan`, `tumwater bug`,
`tumwater plan --edit <n>`, `--top`, `--retire` — and each commits on main for you. For anything
bigger, edit PLANS.md or BUGS.md in your own branch or worktree, commit there, and run `tumwater
land`: it takes the same merge lock a team merge takes, so it waits behind an in-flight merge, then
fast-forwards main or replays your commit(s) onto a main that has moved, settling backlog insert
conflicts and refusing (exit 1) a code conflict. `tumwater land --dry-run` previews it.

Do not `git merge` or `git pull` on the base branch in the checkout the team runs in. That merge
takes no lock, so it can move main, or leave the working tree mid-merge, while the pipeline is
rebasing and fast-forwarding a queued change; the merge then fails with `main moved outside the
merge lock` or a `fast-forward failed:` message naming the files it would overwrite, and the change
has to be rebased again. `tumwater land` is the same operation done in the queue's order.

## What the director is for

The director is a role on the team, not a control panel. It runs on the team's strong model tier, it
runs your messages first and keeps working through a team pause, and it is where a role hands off
what it cannot settle — a bug a bugfix run cannot reproduce is marked `[blocked: with the director]`
and waits there until the director resolves it or parks it for you.

Compare that with your own agent: it is outside the team, costs the team nothing, reads the whole
repo with your conversation beside it, and is where design decisions get made. The director is for
what does not need all of that — a priority change, a correction to a role mid-stream, a decision on
something a role reported.

## Where else to look

- `tumwater guide` — the working rules your agent should follow, printed to stdout.
- [cli.md](cli.md) — every command and flag; `tumwater help` prints the same list.
- [how-it-works.md](how-it-works.md) — what a run does, how the merge pipeline gates a change, and
  how the schedule decides what runs next.
- [glossary.md](glossary.md) — the plain words tumwater uses everywhere, and the older names they
  replaced.
- [config.md](config.md) — the settings in `tumwater.json`, which apply live while the team runs.
