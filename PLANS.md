# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### The GitHub-issues mirror gets a terminal read: `tumwater issues` lists what the scan saw and what tumwater did about each issue, from the ledger file alone (planned 2026-11-21 by the plan role)

**Goal.** The GitHub-issues series (parts 1–5) landed the scan, the mirror check, the director queue
and the closer, but their state is only visible as the doctor's one `github issues` row and the
status snapshot's counts. An operator asking "which issues did the team see, and why was this one
left alone?" has no command to answer it. Add one read-only command, `tumwater issues`, mirroring
the shape of `tumwater quarantine`: a positioned list, a `--show <n>` detail, a `--grep` filter, and
`--json`.

**Approach.** Read only `.tumwater/state/github-issues.json` through the existing reader
`readGithubIssues` in `src/github/github-issues-state.ts` — never call `gh` (plans/github-issues.md
invariant 2: `gh` is called only by the orchestrator's scan and the doctor's `github issues` check).

- New pure module `src/github/github-issues-render.ts`, following `src/review/quarantine-render.ts`:
  `issueRows(ledger)` returns positioned rows (number ascending, positions 1..N) with `position`,
  `number`, `title`, `url`, `author`, `trusted`, `mirrored`, `labels`, `updatedAt` and the tumwater
  state folded in from the ledger's optional maps — `queued`, `declined` (with its `reason`),
  `fixedIn` (with its `sha`), `closed` (with its `at` and `shas`), `waitingPush` (with its shas) and
  membership in `retiredOnly`. Plus `grepIssueRows`, `issueRowAt(ledger, position)`,
  `renderIssues(rows, now)` and `renderIssueDetail(entry, position, now)`. Pure over its inputs: no
  I/O, no clock, every branch unit-tested with a hand-built `GithubIssuesLedger`.
- New `cmdIssues` (and a `cmdIssuesShow` branch routed before the flag gate, as `cmdQuarantine` does
  for `--show`) in `src/cli/cli-query-commands.ts`: `rejectUnknownArgs("issues", args,
  [JSON_FLAG, grepFlagSpec(ISSUES_GREP_VALUE_ERROR)])`, `refuseTeamWorkspace(root)`, then
  `sayJsonOrRender`-style output; registered as `issues:` in `COMMAND_HANDLERS` in `src/cli.ts`.
- One usage stanza in `src/cli/cli-help-text.ts`, beside the `tumwater quarantine` stanza:
  `tumwater issues [--show <n>] [--grep <text>] [--json]` plus its description continuation.
- One row in `docs/cli.md`'s table (between `Check state` and `Read a kept patch`) naming
  `tumwater issues` and every flag it offers — `test/cli-doc.test.ts` pins the help's command list
  and the help's long-flag set against the reference in both directions.
- Tests: new `test/cli-issues.test.ts` modelled on `test/cli-quarantine.test.ts` (writes the ledger
  with `writeFileDeep` at the path the state module reads, then runs the CLI), plus unit assertions
  on the render module; `test/help.test.ts` gains `"issues"` to `ALL_COMMANDS`, which its
  "ALL_COMMANDS names exactly the commands the full help lists" test cross-checks against the
  stanzas.

Deliberate non-goals for this entry: no `-f/--follow` (the ledger is rewritten only by a scan poll;
the list is cheap to re-run), no write mode of any kind, no dashboard card, and no new scan.

**Acceptance.**

1. With no ledger file, `tumwater issues` exits 0 and prints
   `the GitHub issues mirror has not been read yet`; `tumwater issues --json` prints
   `{ read: false, repo, branch }`-shaped output naming the same absence, not an error.
2. With a ledger naming three open issues — two trusted, one not, one of them mirrored —
   `tumwater issues` prints a header naming the repo and `3 open` with how long ago the scan ran,
   then three numbered lines ascending by issue number, each naming the squashed title, `trusted` or
   `untrusted`, `mirrored` or `not mirrored`, and the issue's age.
3. `tumwater issues --show <n>` prints, for the issue that list numbered `n`: full title, url,
   author and its `authorAssociation`, labels, `updated <ISO time>`, then tumwater's own state —
   `queued <ago>`, `declined <ago>: <reason>`, `fixed by <sha>`, `closed <ago>`, `waiting for a push
   of <shas>`, or `every mirroring entry is retired` — and the body excerpt when the ledger holds
   one; a position past the end fails with the same wording the quarantine detail view uses.
4. `--grep <text>` keeps only rows whose number or title contains the text, case-insensitively,
   each kept row still numbered as the full list numbers it, so `--show` addresses the same issue;
   a non-empty list where nothing matches prints `no GitHub issues match "<pattern>"` and exits 0;
   `--grep` with no value fails with the shared missing-value wording
   (`issues --grep needs text (usage: tumwater issues --grep <text>)`).
5. `--json` serves the rows as data: `repo`, `branch`, `checkedAt`, `gh`, `reason` when the gh probe
   was not ok, and `issues` — each with the row fields above plus its state — so a script never
   parses the text.
6. A ledger whose `gh` state is `missing` or `unauthenticated` still lists the issues it holds and
   adds one line naming that state (and its `reason` when present) — the read never depends on a
   working `gh`.
7. The command runs with `gh` nowhere on `PATH`: a test that writes a ledger and runs the CLI with
   that PATH prints the same list as the same ledger with `gh` present, proving no scan happened.
8. `tumwater help` lists the `tumwater issues` stanza, `tumwater help issues` prints it, shell
   completion offers `issues`, and `docs/cli.md` names `tumwater issues` and its flags; the existing
   help, completion and cli-doc checks pass with `"issues"` added to `ALL_COMMANDS`.
9. Unknown flags are refused with the standard unknown-argument wording naming the `issues` command,
   and running the command from a role worktree refuses the same way `quarantine` does.

## Done
