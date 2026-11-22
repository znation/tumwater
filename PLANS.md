# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### `tumwater issues --lost` names the issues GitHub closed upstream as a state of its own, so an operator reads what the mirror lost without scanning the open rows (planned 2026-11-22 by the plan role; touches src/github/github-issues-render.ts src/cli/cli-query-commands.ts src/cli/cli-flag-specs.ts src/cli/cli-help-text.ts docs/cli.md docs/invariants.md test/cli-issues.test.ts test/cli-issues-follow.test.ts test/github-issues-render.test.ts test/help.test.ts test/completion.test.ts)

The mirror's ledger keeps a third kind of issue — `upstreamClosed`, the issues GitHub stopped listing
while tumwater held them open — and `tumwater issues` lists them last, under a header that counts
them, but has no way to ask for them. The state read (`stateIssueRows`) splits the list on
`wasClosed` alone, so a lost row currently answers `--open` (it is not `wasClosed`) and is hidden
from `--closed`: an operator watching `tumwater issues --open` sees a lost issue still listed as
open, and no filter shows the losses on their own. part 1/2 of the upstream-close series named this
choice as its follow-up — "Decide, in the follow-up that changes the mirror banner or the state
read, whether a lost issue belongs to `--open` or a state of its own" — and both of its
prerequisites are on main now: `--open`/`--closed` and the `upstreamClosed` ledger list.

Approach: widen `IssueState` (src/github/github-issues-render.ts) to `"open" | "closed" | "lost"`
and classify in `stateIssueRows` by `upstreamClosed === true` first, then `wasClosed === true`, then
open — so a lost row leaves both older filters. In `cmdIssues` (src/cli/cli-query-commands.ts) the
flag joins the `rejectUnknownArgs` spec, the pairwise mutual-exclusion `fail`s (the one existing
pair check becomes three), the `state` resolution gains a `--lost` arm, and `renderIssuesFrame`'s
state-found-nothing line, which names the state it found empty; `issuesJson` passes the rows through
unchanged, so a lost row's `--json` object keeps carrying `upstreamClosed: true`. `cmdIssuesShow` needs no change:
its empty-flag `rejectUnknownArgs` gate already refuses any flag with the
`tumwater issues takes no arguments (got "…")` line. A `LOST_FLAG` spec joins `OPEN_FLAG` and
`CLOSED_FLAG` in src/cli/cli-flag-specs.ts so completion and the valid-flag refusal pick it up.

Files touched: `IssueState`, `stateIssueRows` (src/github/github-issues-render.ts); `cmdIssues`,
`renderIssuesFrame` (src/cli/cli-query-commands.ts); `LOST_FLAG` (src/cli/cli-flag-specs.ts); the
issues usage line and its state prose (src/cli/cli-help-text.ts); the issues row (docs/cli.md);
INV-DG1's **Binds**/**Pinned by** (docs/invariants.md, the guarantee that the read treats a lost row
as neither open nor tumwater-closed); the tests named in the heading.

Acceptance:

- With `open` holding #7, `closedRows` #9 and `upstreamClosed` #8 and #10, `tumwater issues --lost`
  prints the header `github issues — znation/proj (main): 1 open, 1 closed by tumwater, 2 closed
  upstream, checked <ago>` and then exactly `3. #8 …` and `4. #10 …`, each age segment reading
  `last seen open <ago>` — the whole-list numbering and the header's counts never follow the filter.
- The same ledger under `--open` prints only `1. #7`, and under `--closed` only `2. #9`: a lost issue
  answers neither older filter. The unfiltered read still prints all four rows.
- Any two of `--open`, `--closed`, `--lost` together exit 1 naming the pair —
  `--open and --lost are mutually exclusive: each keeps the issues the other hides` and its two
  siblings — and `--lost --lost` exits 1 with `--lost may only be given once`.
- A mirror holding open issues and no `upstreamClosed` key (or an empty one) exits 0 and answers
  exactly `no lost GitHub issues`; a mirror with nothing on record keeps its `0 open` header line,
  as the older state filters assert today; `--lost --grep <text>` with no match answers
  `no GitHub issues match "<text>"`, the pattern's line still winning over the state's.
- `tumwater issues --lost --json` answers the same payload shape as the unfiltered `--json` does
  today, its `issues` array holding only #8 and #10, each carrying `upstreamClosed: true`, its
  whole-list `position` (3 and 4) and its `closedAt` instant, and no `wasClosed` key;
  `tumwater issues -f --lost` repaints those same rows, under those same numbers, every frame, while
  the header keeps naming the mirror's own counts.
- `tumwater issues --show 3 --lost` exits 1 with `tumwater issues takes no arguments
  (got "--lost")`, and `tumwater issues --bogus` lists `--lost` among the valid flags for the command.
- `tumwater help issues` prints the usage line `tumwater issues [-f/--follow]
  [--open|--closed|--lost] [--show <n>] [--grep <text>] [--json]` and its prose says what `--lost`
  keeps; shell completion offers `--lost` for `issues`; the issues row in docs/cli.md names it; and
  INV-DG1's **Binds** list names `stateIssueRows` beside the other read symbols, its **Pinned by**
  list naming the tests that pin how a lost row filters.

## Done
