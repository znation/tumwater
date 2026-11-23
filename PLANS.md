# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### The dashboard's salvaged-patches card gets a search box, so an operator narrows the kept patches the way `tumwater salvage --grep <text>` does without losing the numbers View, Apply and Drop act on (planned 2026-11-23 by the plan role; retires the follow-up left verbatim in PLANS-DONE.md's dashboard salvage-View entry — *the card still has no way to search the patch text the way `tumwater salvage --grep <text>` does (adding a `q` parameter here would renumber the positions, so it needs its own decision about what number a filtered card row carries)* — and that renumbering worry is disproven at the domain home: `grepSalvagePatches` (src/status/status-salvage.ts) returns copies carrying *the patch's own `position` from the unfiltered list*, which is exactly what the CLI's `--grep` prints and what `salvagePatchAt` (the `--show`/`--apply`/`--drop` address, INV-SV1) resolves, so a filtered card row keeps its whole-list number and no decision is owed; `grep -rn "salvage-grep\|salvageGrep\|setSalvageFilter" src test docs` printed 0 before this entry, and `grep -c "api/salvage" docs/cli.md` printed 0 (docs names the endpoint only in docs/invariants.md's INV-SV section, for the position the read and the actions share), so no doc pins the list endpoint's parameter list; overlaps the unmerged `## Planned` issues-card entry in src/ui/gui/gui-client-settings.ts, src/ui/gui/gui-client-boot.ts, test/gui-client-settings.test.ts and docs/how-it-works.md — different card regions (`#salvagecard` vs `#issuescard`), and whichever lands second rebases on the other's two shared lines: the boot's document `change` delegate and the test helper's `settingsScope` export list; no CLI, status-payload, doctor, config or retention change)

**Goal.** The Settings view's `Salvaged patches` card grows one search box. Today the card paints
every kept patch the doctor row counts, and an operator who remembers only a file a patch touched, a
role name, or a phrase inside a patch has to open a shell and run `tumwater salvage --grep <text>`.
After this change, typing that text in the card narrows the rows to the patches whose file name or
patch text contains it — case-insensitively, matching inside the patch body, exactly like the CLI flag —
and every surviving row keeps the number it had in the whole list, so its View/Apply/Drop buttons still
address the same patch as `tumwater salvage --show <n>`, `--apply <n>` and `--drop <n>`.

**Approach.** Filter on the server through the domain home the CLI already uses, so the card searches
patch *text* and not just file names; keep the position numbering untouched.

1. `src/gui/gui-salvage-commands.ts` — `handleSalvageList(res, root)` becomes
   `handleSalvageList(q, res, root)`, its parameters put in the order every other query-reading
   dashboard handler already uses (`handleIssuesList(q, res, root)`, `handleHistory(q, res, root)`, and
   `handleSalvageShow(q, res, root)` two functions below it in the same file). It collects the whole list
   once (`const full = collectSalvagePatches(root)`), reads `q.get("q")`, and keeps rows with
   `grepSalvagePatches(root, full, pattern)` from src/status/status-salvage.ts — the same call
   `cli-salvage-command.ts`'s `readSalvageRows` makes — mapping the kept copies to the existing record
   shape `{ position, file, savedAt, bytes, size, prune }` (`position` is the copy's whole-list position,
   `prune` still `prunePhrase(p.savedAt, liveConfig(root).sessionRetentionDays, now)` per INV-SV3).
   The payload becomes `{ patches, total }` where `total` is `full.length`, always present, filtered or
   not; `grep` is not echoed. A `q` parameter that is absent **or empty** means no filter — the whole
   list answers, never an empty pattern matching everything (the CLI refuses an empty `--grep` value;
   the endpoint settles it silently instead). `handleSalvageShow`/`Apply`/`Drop` are untouched.
2. `src/gui/gui-server.ts` — the `"GET /api/salvage"` route table entry takes the third `target`
   argument it already receives and passes `target.searchParams` first, exactly as the `GET /api/salvage-show`
   line below it passes `target.searchParams` to `handleSalvageShow`. No new route. The only other call
   sites are `test/gui-salvage.test.ts`'s five `handleSalvageList(res, repo)` invocations, which become
   `handleSalvageList(new URLSearchParams(), repo)` (or a `URLSearchParams` carrying `q` for the new
   cases) — the same shape that file's `handleSalvageShow` cases already build through its `captureJson`
   helper.
3. `src/ui/gui/gui-client-settings.ts`, in the settings-view region beside the existing
   `lastSalvage`/`salvageOpen`/`salvageSlot` block: a module-level `salvageGrep` holding the typed text;
   `renderSalvage(d, armed, open)` gains a fourth parameter, the filter text, read from `salvageGrep` at
   the one call in `paintSalvage`. It emits a controls row above the existing card header row:
   `<input class='field' data-action='salvage-grep' type='search' placeholder='Search patches…'
   autocomplete='off'>` carrying `salvageGrep` as its value, escaped. When a filter is in effect the card
   header row gains the sentence `Showing <patches.length> of <total> patches matching this filter.`
   (`total` defaulted to 0 the way the existing row defaults a missing field); with no filter the header
   row and the rows print exactly as they do today. A filtered list whose `patches` is empty reads the
   CLI's own copy, `no salvaged workspace patches match "<text>"`; an unfiltered empty list still reads
   `no salvaged workspace patches are kept for you` (the same sentence lives in both surfaces today —
   test/cli-salvage.test.ts and test/gui-client-settings.test.ts both pin it). The View slot and the
   per-row arm keys (`apply:<position>` / `drop:<position>`) stay keyed by `position`, so nothing about a
   filtered row's actions changes.
   `fetchSalvage` builds its path from `salvageGrep` — `/api/salvage` plus `?q=` with the text through
   `encodeURIComponent` when non-empty, never a bare `?` — and paints from `salvageGrep`, not from the
   payload, so the box keeps its value across the repaint and across every later open of the view.
   New `setSalvageFilter(text)`: stores the text, repaints from the cached `lastSalvage` immediately when
   one is held, then refetches; a card that has never fetched refetches only.
4. `src/ui/gui/gui-client-boot.ts` — the document `change` delegate that already routes
   `input[data-action='doctor-problems']` in this same view gains the sibling
   `input[data-action='salvage-grep']`, calling `setSalvageFilter` with the input's trimmed value. The
   search applies on the control's own `change` (Enter or blur) — the trigger `#histgrep` uses in the
   History view — not on every keystroke, which would spend a request per character.
5. `docs/how-it-works.md`, the salvage paragraph (the one that ends *so work a run left behind is never
   silently discarded*): one clause saying the dashboard card's search box narrows that list the way
   `tumwater salvage --grep <text>` does — file name or patch text, case-insensitively — and that a
   filtered row keeps its whole-list number, the number `tumwater salvage --show <n>` addresses.
   `docs/cli.md` keeps its wording: no CLI flag or output changes, and its `Read a kept patch` row's
   `--grep` sentence already quotes `no salvaged workspace patches match "<pattern>"`.

**docs/invariants.md: no edit needed, and one line to extend.** The `INV-SV` section intro ("the list,
the read and the two actions state one position on every surface") already requires that *each position
a surface prints must address the same patch on the others*, which is what a filtered card row does; the
guarantee is unchanged in substance, so INV-SV1/SV2/SV3 keep their text. INV-SV1's **Pinned by.** list
gains the new endpoint case named in criterion 2, since that case is what pins position addressing
against a filtered listing.

**Acceptance criteria.**

1. In a repo whose salvage dir holds `a.patch` (contains `new` in its body) and `b.patch` (a body with
   neither word), `handleSalvageList` with an empty `URLSearchParams` answers
   `{ patches: [a, b], total: 2 }`: `patches[0].position` is
   `1` and `patches[1].position` `2` — today's rows plus the one new key — and with `q=new` it answers one
   patch, `position` `1`, `file` `a.patch`, still carrying its `prune` clause, with
   `total` `2`: a row matched by patch **text**, not only by name, and still numbered from the whole list.
   A pattern that matches nothing answers `{ patches: [], total: 2 }`; `q` present but empty, and `q`
   absent, answer the identical two-row body; a case-differing pattern (`NEW`) matches `a.patch`.
2. With no salvage dir, an empty `q` answers `{ patches: [], total: 0 }` and still creates no
   salvage dir; `q=x` answers the same body and still creates nothing. A filtered
   listing then addresses the same patch as the unfiltered one: a `q=new` listing followed by
   `handleSalvageShow` at `position=1` returns `a.patch`'s text, and at `position=2` answers the off-list
   sentence naming how many patches the salvage dir holds — an off-list reply from a filtered listing
   (positions renumbered 1..kept) fails this criterion.
3. `renderSalvage` over `{ patches: [{position: 3, file: "c.patch", savedAt, bytes, size, prune}], total: 9 }`
   with filter text `c` paints a `data-action='salvage-grep'` input whose value is `c`, one row carrying
   `data-position='3'` with its View/Apply/Drop buttons and its `prune` clause, and the sentence
   `Showing 1 of 9 patches matching this filter.` Over the same payload with an empty filter text it
   paints the input with no value, and no matching-filter sentence. Over `{ patches: [], total: 9 }` with
   filter text `zz` it reads `no salvaged workspace patches match "zz"`; over `{ patches: [] }` with an
   empty filter it still reads `no salvaged workspace patches are kept for you` and paints no
   `data-action='salvage-apply'`. A `total` the payload omits paints the sentence with `0`.
4. Given `setSalvageFilter("a b")` after a fetch, the card repaints from the cached document at once and
   the next read requests exactly `/api/salvage?q=a%20b`; given `setSalvageFilter("")` the next read
   requests exactly `/api/salvage` (never `/api/salvage?`); the existing `fetchSalvage` and
   apply/drop/view tests still pass unchanged, so a filtered row's Apply still posts
   `{ position }` to `/api/salvage-apply` at its whole-list number.
5. The boot delegate test matches `GUI_CLIENT_BOOT_JS` for `input[data-action='salvage-grep']` beside
   the existing `input[data-action='doctor-problems']` branch, and the region's exports reach
   `setSalvageFilter` through the test helper's `settingsScope` export list; the existing
   `#salvagecard` view-fetch assertion (`fetchSalvage()` inside the `settings` branch) still matches.
6. `tumwater salvage` (list, `--json`, `--grep`, `--show`, `--apply`, `--drop`, `-f`) output is unchanged,
   and `status --json`'s `salvagePatches` keeps its exact `{position,file,savedAt,bytes}` shape — the
   filter lives in the GUI handler, not in `collectSalvagePatches` or `SalvagePatch` (whose shape stays
   `{position,file,savedAt,bytes}` and whose stat-cache contract stays).

**Files touched.** src/gui/gui-salvage-commands.ts (`handleSalvageList`'s signature and body),
src/gui/gui-server.ts (the
`GET /api/salvage` route line), src/ui/gui/gui-client-settings.ts (`renderSalvage`, `paintSalvage`,
`fetchSalvage`, a new `salvageGrep` and `setSalvageFilter`), src/ui/gui/gui-client-boot.ts (the existing
`change` delegate), docs/how-it-works.md, docs/invariants.md (INV-SV1's **Pinned by.** list only),
test/gui-salvage.test.ts, test/gui-client-settings.test.ts. No CLI, flag-spec, help-text, completion,
status-payload, doctor or retention change — no new CLI flag, so the six-site flag family is untouched.

**Test files that gain cases.** `test/gui-salvage.test.ts`: its three existing `GET /api/salvage` cases (list fields, configured
retention window, no salvage dir) are the file's only list cases; the field-by-field list case gains
`total`, the no-salvage-dir case's `deepEqual(data, { patches: [] })` becomes
`{ patches: [], total: 0 }`, and all three move to the new `(q, res, root)` order; and two new cases land beside
them named for criteria 1 and 2 (the whole-list position under `q`, the filtered-listing-then-show
agreement). `test/gui-client-settings.test.ts`: the `renderSalvage` cases (empty list, one row per patch,
the escape case, the confirm-label case) gain the filter argument; the `fetchSalvage` path-assertion case
gains the `?q=` pair; the region-splice case gains the `salvage-grep` delegate assertion; the helper's
export list and `SettingsFns` type gain `setSalvageFilter` and `renderSalvage`'s fourth parameter. The
`getJson` fakes that answer `{ patches: [] }` may stay as they are — `total` is defaulted in the render.

**Runs red before, green after.** test/gui-salvage.test.ts, test/gui-client-settings.test.ts.

**One plausible bug this pins.** A handler that renumbered the kept rows after filtering
(`kept.map((p, i) => ({ position: i + 1, … }))`) would print rows numbered 1..kept and criterion 2's
filtered-then-show agreement fails on it (position 2 would be answered off-list while the whole list
holds two patches). A card that filtered the cached rows by file name alone, never asking the server,
would miss `a.patch` in criterion 1's text-match case and fail it. A `total` computed as
`patches.length` instead of `full.length` prints `Showing 1 of 1 patches matching this filter.` and fails
criterion 3.

**Verify.** From a built tree: `npm run build` once, then
`node scripts/check-permit.mjs node dist/test/test-runner.js gui-salvage gui-client-settings
gui-client-boot gui-endpoints cli-salvage backlog-structure plan-citations backlog-pending
backlog-eligibility invariants-doc cli-doc`.

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
