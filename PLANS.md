# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### The dashboard's GitHub-issues card gets a search box and a state picker, so an operator narrows the mirror without leaving the Settings view (planned 2026-11-23 by the plan role)

**Goal.** The card at the bottom of the Settings view grows two filter controls — a search box and a
state picker — and the dashboard reads the mirror through the query parameters `GET /api/issues`
already answers. Today the card paints every row the mirror lists, in the mirror's own order, with no way
to narrow it; the only way to find an old or closed issue is `tumwater issues --grep` in a shell. The
follow-up this entry retires is recorded in PLANS-DONE.md's "The dashboard's GitHub-issues card offers a
per-issue View" entry: *no filter controls in the card, though the endpoint already accepts `state` and
`q`.*

**Approach.** No server change. `handleIssuesList` (src/gui/gui-issues-commands.ts) already accepts
`?state=open|closed|lost` — `isIssueState`/`ISSUE_STATES` live in src/github/github-issues-render.ts and
the 400 message comes from `oneOfMessage` (src/text/suggest.ts), reading `state must be one of open,
closed, lost (got "x")` — and `?q=` through `grepIssueRows`, then state through `stateIssueRows`, in the
CLI's order. `state` is echoed only when one was asked for, and the whole-mirror `openCount`,
`closedCount` and `upstreamClosedCount` are sent whatever the kept rows are (INV-DE3,
docs/invariants.md). `grep -rn "issues-state\|issues-grep\|setIssuesFilter\|issuesGrep" src test docs`
returns 0 today, so the control names are free. The card lives in the settings-view region of
src/ui/gui/gui-client-settings.ts — `renderIssues(d, open)` / `paintIssues()` / `fetchIssues()`, backed by
the module-level `lastIssues` and `issuesOpen` next to the card comment; the filter lives in that same
block, as `issuesFilter`, so the cached-document repaint and the cached-document pattern the salvage card
already uses there stay in one place.

1. src/ui/gui/gui-client-settings.ts, in the settings-view region:
   - `renderIssues(d, open)` gains a third parameter, `filter` as `{ state: string; grep: string }`, read
     from `issuesFilter` at the one call site in `paintIssues`. It emits a controls row above the header
     row: a
     `<select data-action='issues-state'>` with four options — `All states`, `Open`, `Closed`, `Lost` —
     the current one marked `selected`, and an
     `<input class='field' data-action='issues-grep' type='search' placeholder='Search issues…'>`
     carrying the current text as its value. An empty filter selects `All states` and leaves the search
     input empty; never preselect from the payload's `state`.
   - When a filter is in effect (`state` or `grep` non-empty) the header row gains the sentence
     `Showing <N> of <M> issues matching this filter.` where N is `d.issues.length` and M is
     `openCount + closedCount + upstreamClosedCount`, each defaulted to 0 the way `issuesHeaderSpan`
     already defaults them. With no filter the header row keeps today's `issuesHeaderSpan` copy exactly.
   - An empty list under a filter reads `no issues match this filter` instead of today's
     `no issues to show`, which stays the no-filter empty copy: a filtered empty list says the filter
     missed, not that the mirror has nothing. `the GitHub issues mirror has not been read yet` (the
     `d.empty` branch) is unchanged and wins over both.
   - `fetchIssues` builds its path from `issuesFilter` — `/api/issues` plus `?state=` and/or `&q=` with
     only the non-empty halves (`grepIssueRows` takes the raw substring, so `q` goes through
     `encodeURIComponent`; never a bare `?`) — and paints the controls from `issuesFilter`, not from the
     payload, so a picker or search box keeps its value across the repaint and across every later read of
     the Settings view.
   - New `setIssuesFilter(next)` exported from the region: it stores the filter, repaints from
     `lastIssues` immediately when there is a cached document, then refetches — the card shows the rows it
     typed before the round trip settles. A card that has never fetched refetches only.
   - `issueViewClick` is unchanged: the View slot is keyed by position alone, and positions are the
     filter-independent 1-based `tumwater issues --show <n>` positions (INV-DE6, docs/invariants.md), so
     View on a filtered row opens that issue's detail.
2. src/ui/gui/gui-client-boot.ts: the document `change` delegate already routes
   `input[data-action='doctor-problems']` in the same settings view. Add the two siblings to that branch
   — `select[data-action='issues-state']` calls `setIssuesFilter` with the picker's state and the current
   search text, `input[data-action='issues-grep']` calls it with the search text and the current state —
   so one repaint follows a change to either control. The search applies on the control's own `change`
   (Enter or blur), the trigger `#histgrep` uses in the History view — not on every keystroke, which is
   what `#backloggrep` does and which would spend a request per character here.
3. docs/how-it-works.md, in the GitHub-issues mirror section's dashboard sentence: say the card's search
   box and state picker narrow the rows through the same `?q=` and `?state=` the CLI flags use, that the
   counts beside them stay whole-mirror, and that a row's position — the number its View button reads —
   is the unfiltered `tumwater issues --show <n>` position.

**Files touched.** src/ui/gui/gui-client-settings.ts (renderIssues, paintIssues, fetchIssues, a new
`issuesFilter` and `setIssuesFilter`); src/ui/gui/gui-client-boot.ts (the existing document `change`
delegate that already routes `input[data-action='doctor-problems']`); docs/how-it-works.md;
test/gui-client-settings.test.ts. No server, CLI, status-payload, or invariant change: docs/cli.md and
docs/invariants.md keep their wording, and the endpoint's `?state=`/`?q=` behaviour stays pinned by the
guard's `state must be one of open, closed, lost (got "x")` message.

**Acceptance criteria.**
- Given a payload of 2 open and 1 closed issue and an empty filter, the card's controls carry
  `data-action='issues-grep'` and `data-action='issues-state'`, the `All states` option is the selected
  one, and the header row keeps today's `issuesHeaderSpan` copy — `<repo>: 2 open, 1 closed by tumwater,
  checked <ago>` — with no matching-issues sentence.
- Given `{ state: "lost", grep: "login" }` over that same payload, the `Lost` option carries `selected`,
  the search input carries value `login`, and the header row carries
  `Showing 0 of 3 issues matching this filter.`
- Given a filtered payload whose `issues` is empty, the card reads `no issues match this filter` and still
  shows the header row; given an unfiltered payload whose `issues` is empty, it still reads
  `no issues to show`; a payload with `read: false` still reads
  `the GitHub issues mirror has not been read yet`.
- Given `setIssuesFilter({ state: "closed", grep: "" })` after a fetch, the card repaints from the cached
  document at once, and the next read requests `/api/issues?state=closed`; given
  `{ state: "", grep: "a b" }` it requests `/api/issues?q=a%20b`; both halves set it requests
  `/api/issues?state=open&q=x`; an empty filter requests exactly `/api/issues`.
- Given the picker set to `Open` while the search box holds `x`, one `change` event repaints the card once
  with both halves applied, and the test asserting the boot's delegates matches `GUI_CLIENT_BOOT_JS` for
  `select[data-action='issues-state']` and `input[data-action='issues-grep']`.
- Given a filtered card, clicking a row's `View #<n>` still fetches `/api/issues-show?position=<n>` and
  shows that issue's detail above the filtered list — the existing View tests keep passing unchanged.
- The new tests land in test/gui-client-settings.test.ts alongside the existing `renderIssues` and
  `fetchIssues` tests, their scope reaches `setIssuesFilter` through the `settingsScope` helper's export
  list, and the guard checks (backlog-structure, plan-citations, invariants-doc, config-doc, cli-doc)
  stay green.

## Done
