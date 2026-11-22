# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### `tumwater issues -f/--follow` repaints the mirror read, so an operator watches a merge's scan and close land (planned 2026-11-22 by the plan role)

`tumwater issues` is the one live read view in the CLI with no follow. `status`, `diff`, `backlog`,
`quarantine`, `reviews`, `salvage` and `doctor` all take `-f/--follow` through the shared
`FOLLOW_FLAG` + `hasFollowFlag` + `followView` machinery (src/follow.ts), but `cmdIssues`
(src/cli/cli-query-commands.ts) accepts only `--show`, `--grep` and `--json`, so watching what the
mirror's after-merge scan did means re-running the command by hand. The ledger it reads
(`.tumwater/state/github-issues.json`, `githubIssuesPath` in src/paths.ts) is rewritten by
`scanGithubIssues` (src/github/issue-scan.ts) after a merge, and `closeFixedIssues`
(src/github/issue-close.ts) rewrites it in the same pass, so the file the operator wants to watch
changes under them.

**How it works.** One flag in one command, no new view code. `cmdIssues` takes the follow seam the
quarantine list already takes (`seams: FollowViewSeams = {}`), adds `FOLLOW_FLAG` to its
`rejectUnknownArgs` spec list, reads the flag with `hasFollowFlag(rest)` after `parseGrepFlag`, and
refuses the `--json` rival with `failFollowJsonRival("issues --json")` (src/cli/cli-args.ts). The
per-frame model is the one-shot read lifted into a closure, exactly as `cmdQuarantine` does: re-read
with `readGithubIssues(root)` (the uncached reader the command already uses — never the
stat-cached `readGithubIssuesForPoll`, which belongs to the status poll), fold with `issueRows`,
filter with `grepIssueRows`, and render with `renderIssues(kept, issuesHeader(ledger), Date.now())`
so each frame's ages come from that frame's clock. A missing ledger is a frame like any other: the
not-read line, repainted, so the first scan's result appears on its own.

Files touched: `src/cli/cli-query-commands.ts` (`cmdIssues`), `src/cli/cli-help-text.ts` (the
`tumwater issues` stanza), `docs/cli.md` (the issues row), new `test/cli-issues-follow.test.ts`,
one assertion in `test/completion.test.ts`. No `docs/invariants.md` change: no INV section binds
the follow views (grep for `followView` there prints 0 hits), and nothing in src/github or
src/follow.ts changes.

**Acceptance criteria.**

1. `tumwater issues -f` over a ledger holding issues prints, as its first frame, exactly what
   `tumwater issues` prints for the same ledger — the `github issues — <repo> (<branch>): N open,
   checked <ago>` header plus the numbered rows — then repaints that view on the follow interval
   until Ctrl+C or the process that started it exits. Pinned in-process with the follow seams
   (`{ ppid, intervalMs, tty }`), the way `test/cli-quarantine-follow.test.ts` drives
   `cmdQuarantine`.
2. A ledger rewritten while the follow runs shows in the next repaint: rewrite
   `.tumwater/state/github-issues.json` to add an issue and the following frame names it; rewrite
   it to drop one and the following frame no longer lists it.
3. Ages advance between frames — the header's `checked <ago>` and each row's `updated <ago>` grow,
   never a frozen first-frame age.
4. `--grep` composes: `issues -f --grep <text>` keeps the whole-list numbering and the same filter
   rule, and a non-empty mirror where nothing matches repaints `no GitHub issues match "<text>"`.
5. `-f` with `--json` fails with the shared rival sentence (`issues --json prints one document;
   -f/--follow repaints a live view — drop one of them`) and starts no repaint; `-f` beside
   `--show` is refused by the detail branch's own flag gate before any read.
6. With no ledger yet, every frame prints `the GitHub issues mirror has not been read yet`, and the
   frame after a ledger appears prints the header and rows.
7. The follow never calls `gh`: run with `gh` nowhere on PATH it repaints the same list a present
   `gh` gives, and a fake-`gh` call counter stays at 0.
8. `tumwater help issues` opens `tumwater issues [-f/--follow] [--show <n>] [--grep <text>] [--json]`,
   the `docs/cli.md` issues row names `-f/--follow`, its per-frame re-read and its refusal of
   `--json`, and shell completion offers `--follow` for `issues` (`completionSpec().flags.issues`
   includes `--follow`, asserted in `test/completion.test.ts` beside its `quarantine`/`reviews`
   assertions).

## Done
