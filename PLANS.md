# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### The dashboard's Settings view reads the GitHub-issues mirror, so an operator sees which issues the team saw and what it did about each without leaving the browser (planned 2026-11-22 by the plan role; touches src/gui/gui-issues-commands.ts src/gui/gui-endpoint-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-settings.ts src/ui/gui/gui-client-boot.ts src/github/github-issues-render.ts src/github/github-issues-state.ts docs/cli.md docs/how-it-works.md docs/invariants.md test/gui-issues.test.ts test/gui-client-settings.test.ts)

**Problem.** The GitHub-issues mirror has one read: `tumwater issues` (src/cli/cli-query-commands.ts
`cmdIssues`, over `issueRows`/`issuesHeader` in src/github/github-issues-render.ts). The dashboard
shows the mirror only as banners (src/ui/team-alert-status.ts), so an operator watching the team and
asking "which issues did it see, which did it mirror, and why was this one left alone?" must leave the
browser for a terminal. There is no `/api/issues` route and no card: `grep -rn "api/issues|fetchIssues"
src/ui src/gui` is 0 hits.

**Approach.** One read-only endpoint plus one Settings card, both over the render module that already
exists. No writes, and no `gh` call (plans/github-issues.md invariant 2: `gh` is called only by the
scan and the doctor's check).

- `src/gui/gui-issues-commands.ts` (new, shaped like src/gui/gui-salvage-commands.ts):
  `handleIssuesList(q: URLSearchParams, res: http.ServerResponse, root: string): void` — the
  `(q, res, root)` shape the query-carrying GET handlers already use (`handleLogs`,
  `handleBacklog`). `const ledger = readGithubIssues(root)`;
  `const rows = ledger === null ? [] : issueRows(ledger)`; `const header = issuesHeader(ledger)`. A
  `state` query parameter of `open` or `closed` narrows the rows through the existing
  `stateIssueRows(rows, state)` — the same predicate `--open`/`--closed` use, so the dashboard cannot
  divide the rows a different way than the CLI does — and any other value answers a 400 whose error
  reads `state must be open or closed (got "<raw>")`; a `q` parameter keeps only the rows
  `grepIssueRows` keeps (its `pattern` argument already takes a raw substring). Answer 200 with
  `issuesJson(kept, header)` — the document `tumwater issues --json` already serves, carrying `read`,
  `repo`, `branch`, `checkedAt`, `gh` (`ok`/`missing`/`unauthenticated`), an optional `reason`, and the
  positioned `issues` — plus `openCount: header.openCount` and `closedCount: header.closedCount` (the
  document does not carry them, and the card's header needs them: take both from
  `issuesHeader(ledger)`, never from the kept rows, the rule INV-DE3 pins), `empty: ledger === null`
  so the card can tell an unread mirror from a mirror with no issues, and `state` when a state filter
  was given. When `ledger === null` answer 200
  `{ read: false, empty: true, openCount: 0, closedCount: 0, issues: [] }` without calling
  `issuesHeader` (it takes a ledger, not null — `cmdIssues` returns its "has not been read yet" line
  before reaching it), creating nothing. The endpoint resolves no remote of its own: `repo` and `branch`
  come only from the ledger, so on no ledger the answer names neither — unlike `tumwater issues --json`,
  which resolves the remote through `issuesTarget` and answers `{ read: false, repo, branch }` with no
  `issues` key at all.
- `src/gui/gui-endpoint-commands.ts`: re-export `handleIssuesList` from `./gui-issues-commands.js`
  beside the salvage exports; `src/gui/gui-server.ts`: route
  `"GET /api/issues": (_req, res, target) => handleIssuesList(target.searchParams, res, root)` in the
  GET block, next to `"GET /api/retire"`.
- `src/ui/gui/gui-client-settings.ts`: a fourth card in `buildSettingsView()`'s markup
  (`<div class='card' id='issuescard'><div class='empty'>Loading…</div></div>`) after `id='briefcard'`,
  and `renderIssues(d)` + `paintIssues()` + `fetchIssues()` in `renderSalvage`/`paintSalvage`/
  `fetchSalvage`'s exact shape (a cached `lastIssues`, the card repainted from it, and
  `errorPanel("GitHub issues could not load", err, "empty")` on a failed fetch). The paint opens with
  the card's own `settings-row` header — `<strong>GitHub issues</strong>` plus a `<span>` naming
  `d.repo` and the mirror's counts in `issuesHeader()`'s words, `<n> open` and `, <n> closed by
  tumwater` only when the closed count is positive (the region already has `plural` in scope —
  `renderDoctorReport` calls it) — and on an empty read that span names no repo and no counts. then one `settings-row` per issue in the order the
  endpoint sent them: `<strong><position>. #<number> <escaped title></strong>` (the title wrapped in a
  `rel='noopener' target='_blank'` anchor to the row's `url` when it has one, plain escaped text when
  it does not), a `<span>` reading `mirrored` or `not mirrored`, an untrusted row carrying
  `<span class='pill t-amber'>untrusted</span>` (the doctor card's pill idiom) and a trusted row plain
  text, and the age segment reading `closed <ago>` for a `wasClosed` row and `updated <ago>` otherwise.
  Above the rows: `d.empty` renders `<div class='empty'>the GitHub issues mirror has not been read
  yet</div>`; a read whose frame keeps no row renders `no issues to show`; and when `d.gh` is not `ok`
  one gate line in `renderIssues`' shape — `gh <gh>` plus `: <d.reason>` when the ledger carries a
  reason — the same reading of the stored gate state the CLI prints, kept in the client because
  `renderIssues` writes terminal text and `ghUnreadableSentence` (src/github/gh.ts) is not reachable
  from the bundle. It reads no clock of its own: the endpoint's `checkedAt` and each row's `updatedAt`
  are the only times, and the age text comes from the client's existing `fmtAgo`, the same helper the
  salvage card's `saved <ago>` uses.
  `renderIssues` stays a pure paint like `renderSalvage`: no fetch, no clock, every value escaped.
- `src/ui/gui/gui-client-boot.ts`: call `fetchIssues()` beside `fetchSalvage()` in the Settings-open
  sequence.
- `src/github/github-issues-render.ts` and `src/github/github-issues-state.ts`: comment-only — name
  `handleIssuesList` as the second caller of `issueRows`, `issuesHeader`, `stateIssueRows`,
  `grepIssueRows` and `issuesJson`, so those symbols' comments list every consumer.

**Files touched.** The five src files above, the two github module comments, `docs/cli.md`,
`docs/how-it-works.md`, `docs/invariants.md`, `test/gui-issues.test.ts` (new),
`test/gui-client-settings.test.ts`.

**Acceptance criteria.**

- `GET /api/issues` over a ledger holding open issues #4 (trusted, mirrored) and #7 (untrusted, not
  mirrored) plus one closed row answers 200 with `read: true`, `repo` and `branch` naming the remote,
  `gh` carrying the gate state, `openCount: 2` and `closedCount: 1`, and `issues` as the whole
  positioned list in `issueRows` order — #4 at `position` 1 and #7 at 2 — each object carrying `number`,
  `title`, `mirrored` and, on the closed row, `wasClosed: true`. With no ledger file the same route
  answers 200 with `read: false`, `empty: true`, `openCount: 0`, `closedCount: 0` and `issues: []`, and
  no ledger file exists afterwards.
- `GET /api/issues?state=closed` returns only the `wasClosed` rows and echoes `state: "closed"`, while
  the header counts still report the whole mirror: a mirror with two open issues and one closed row
  filters to one issue yet still answers `openCount: 2, closedCount: 1`, the rule INV-DE3 pins. With
  `?state=open` the closed row is absent. `?state=both` answers 400 with
  `{"error":"state must be open or closed (got \"both\")"}` and no issues list.
- Opening the Settings view shows a `GitHub issues` card that fetched `/api/issues`: its header states
  the mirror's counts in the same words `tumwater issues`' header uses, an unmirrored issue's row reads
  `not mirrored` with its age segment `updated <ago>`, and an issue the closer shut reads
  `closed <ago>` in that same slot. `test/gui-client-settings.test.ts`'s exported-name list gains
  `renderIssues`, and the boot sequence assertion in that file (currently pinning
  `if (v === "settings") { fetchSettings(); fetchDoctor(); fetchSalvage(); fetchRetirable(); fetchBrief(); }`)
  gains `fetchIssues()` in the same line.
- On no ledger the card prints `the GitHub issues mirror has not been read yet` and no issue rows; when
  the fetch fails it prints `GitHub issues could not load` with the error's message, never a bare code.
- `docs/cli.md`'s GitHub-issues row gains a closing sentence naming the card and the endpoint it reads
  (the pattern the `tumwater salvage` row already sets), and `docs/how-it-works.md`'s Settings-view
  paragraph names a `GitHub issues` card that reads the mirror's ledger file and never `gh`.
- `docs/invariants.md`'s GitHub-issues mirror section gains one INV entry with **Guarantee.**, **Binds.**
  and **Pinned by.** fields: the mirror has two read front ends (`tumwater issues` and
  `GET /api/issues`) over one row-numbering, one header-count source and one state filter, so neither
  front end can report a filtered subset as the whole mirror or number rows differently, and the
  dashboard never calls `gh`. Every title cited in **Pinned by.** appears verbatim in the file it names.

Verify: `npm run build`, then
`node scripts/check-permit.mjs node dist/test/test-runner.js gui-issues gui-client-settings gui-endpoints gui-server-api gui-client-boot cli-doc invariants-doc backlog-structure backlog-pending backlog-eligibility plans-citations plan-citations`.

**Not covered (follow-ups).** No per-issue detail view in the browser — the CLI's `--show <n>` body
excerpt and decline reason stay terminal-only; no filter controls in the card, though the endpoint
already accepts `state` and `q`; the `github-scan-stalled` and `gh-unreadable` banners are unchanged;
and the card will need one more state spelling when the upstream-close series lands its
`upstreamClosed` rows.

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
