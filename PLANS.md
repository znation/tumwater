# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### `tumwater issues --open`/`--closed` narrow the mirror read to one state, so an operator sees what the mirror still owes without scanning the closed rows

(planned 2026-11-22 by the plan role)

**Problem.** `tumwater issues` lists every row the ledger keeps — the open issues first, then the
issues tumwater closed (`issueRows` in src/github/github-issues-render.ts folds `open` then
`closedRows`, numbered 1..N across both). The only narrowing tool is `--grep <text>`, which matches
number and title, so there is no way to ask the read one question an operator actually has: what is
still open, and what has tumwater closed. The closed-row feature left the gap open on purpose — the
archived plan that added the closed rows (PLANS-DONE.md, "Keep the closed issue's row in the mirror
ledger so `issues` names it") records under **Not covered (follow-ups).** the line "No
`--closed`/`--open` filter and no cap knob". `grep -rn '"--closed"\|"--open"' src test docs` is
empty, so nothing exists to extend.

**Approach.** Two bare flags on the issues read, filtered by row state at the one place the rows are
numbered, with no change to numbering, the header, or `--json`'s shape.

- `src/cli/cli-flag-specs.ts`: two bare `FlagSpec` consts beside `JSON_FLAG` — `OPEN_FLAG = { names: ["--open"] }`
  and `CLOSED_FLAG = { names: ["--closed"] }` — so the gate's accepted vocabulary and the help usage
  line name the same spellings.
- `src/github/github-issues-render.ts`: one exported `stateIssueRows(rows, state)` beside
  `grepIssueRows` (`state` is `"open" | "closed"`), keeping the rows whose `wasClosed === true` for
  `"closed"` and the rows that are not closed for `"open"`, each kept row keeping its whole-list
  `position` — the rule `grepIssueRows` already keeps, so `--show <n>` addresses the same issue it
  always did. No change to `issueRows`, `issueRowAt`, `issuesHeader`, `renderIssues` or `issuesJson`:
  the header keeps naming the ledger's open-of-the-kept-rows count and its whole-ledger
  `<n> closed by tumwater` segment exactly as it does behind `--grep` today.
- `src/cli/cli-query-commands.ts` `cmdIssues`: add the two specs to its `rejectUnknownArgs` spec
  list; after `parseGrepFlag` yields `rest`, fail when `rest` names both spellings (the wording shape
  `tumwater backlog --list` already keeps, src/cli/cli-backlog-view.ts:
  `--open and --closed are mutually exclusive: each keeps the issues the other hides`), resolve the
  state, and apply `stateIssueRows` to the rows the pattern kept inside `readIssues`, so both the
  one-shot print and every `-f/--follow` frame carry the same filter. The state check reads `rest`,
  never `args`, because the `--grep` value token leaves `rest`: `--grep --closed` greps for the text
  `--closed` and keeps the whole list, the same rule that already keeps `--grep --json` from reading
  as `--json`. Empty-result prose is decided in `renderIssuesFrame`, not in `renderIssues` (which
  returns the header line alone for an empty row list): when the ledger holds rows but the pattern and
  state filter together keep none, the line stays `no GitHub issues match "<text>"` for a pattern and
  is `no open GitHub issues` / `no closed GitHub issues` for a state filter alone; a ledger holding no
  rows at all keeps printing its header line alone. `--json` keeps serving
  `issuesJson(kept, issuesHeader(ledger))` — the kept rows only, no new key.
  `cmdIssuesShow` is untouched: its empty `rejectUnknownArgs` gate already refuses `--open`/`--closed`
  beside `--show`, naming the flag and exiting 1, exactly as it refuses `--grep` there.
- `src/cli/cli-help-text.ts`: the `issues` usage line becomes
  `tumwater issues [-f/--follow] [--open|--closed] [--show <n>] [--grep <text>] [--json]` and the
  stanza's prose names both flags, their mutual exclusion, and the two `no …` lines.

**Files touched.** `src/cli/cli-flag-specs.ts`, `src/github/github-issues-render.ts`,
`src/cli/cli-query-commands.ts`, `src/cli/cli-help-text.ts`, `test/github-issues-render.test.ts`,
`test/cli-issues.test.ts`, `test/cli-issues-follow.test.ts`, `test/help.test.ts`,
`test/completion.test.ts`, `docs/cli.md` (the reference row's usage text and prose —
`test/cli-doc.test.ts` requires docs/cli.md to name every long flag `tumwater help` lists).
`docs/invariants.md` needs no edit: `grep -n "issueRows\|grepIssueRows\|github-issues-render"
docs/invariants.md` is empty, and INV-DE1/INV-DE2 bind the scan-stall and re-offer holds only, and
stay untouched.

**Acceptance criteria.** Against a ledger with `open` holding #7 and #8 and `closedRows` holding #9
(the ledger test/cli-issues.test.ts's "issues lists the issues tumwater closed after the open ones"
test writes):

1. `tumwater issues --closed` exits 0 and prints the header line followed by exactly one row,
   `3. #9 — A closed request — …, closed <ago>` — the closed row under its whole-list position, not
   renumbered to 1.
2. `tumwater issues --open` prints the header plus rows `1. #7` and `2. #8` and no `#9` row; the
   header's closed segment still names the ledger's `1 closed by tumwater`.
3. With no `closedRows` key at all, `tumwater issues --closed` prints `no closed GitHub issues` and
   nothing else (exit 0); with `open` empty and `closedRows` holding #9, `tumwater issues --open`
   prints `no open GitHub issues`. A ledger with neither list keeps printing its `0 open` header line
   alone, as it does today.
4. `tumwater issues --closed --json` exits 0 and its `issues` array holds only the closed row, with
   `position: 3` and `wasClosed: true`; `tumwater issues --json` with no state flag is unchanged,
   byte for byte, from what that same test asserts today.
5. `tumwater issues --closed --show 3` exits 0 and prints `issue 3: #9 — A closed request` (a state
   filter never shifts what `--show` addresses); `tumwater issues --show 1 --closed` exits 1 with
   stderr naming `--closed`.
6. `tumwater issues --open --closed` exits 1 and its stderr reads
   `--open and --closed are mutually exclusive: each keeps the issues the other hides`.
7. `tumwater issues -f --closed` repaints `3. #9 — A closed request` every frame and never shows
   `#7`; `--grep` composes: `tumwater issues --closed --grep 9` prints the `#9` row, and
   `--closed --grep 7` prints `no GitHub issues match "7"` (nothing in the kept subset matched);
   `tumwater issues --grep --closed` takes `--closed` as the pattern, not the flag — it does not list
   the closed subset, and since no title in that ledger contains `--closed` it prints
   `no GitHub issues match "--closed"`.
8. `test/help.test.ts`'s usage-line assertion is updated to the new bracketed pair and passes;
   `completionSpec().flags.issues` contains `--open` and `--closed` (asserted beside the existing
   `--follow` assertion), and `completionSpec().subcommands.issues` stays empty.
9. The read still never shells out to `gh` and still needs no ready repo: every criterion above is
   met in the same fake-repo harness the existing issues tests use, with no GitHub remote configured
   beyond the ledger file.

**Not covered (follow-ups).** No `--sort`, no cap knob, and no new `--json` key; the dashboard has no
issues view to filter. Independent of the standing scan-stall banner plan — that one touches
`src/ui/team-alert-status.ts` and `src/status/status-data.ts`, this one neither file.

## Done
