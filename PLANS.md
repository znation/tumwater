# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### The mirror's upstream-close record, part 2/2: one `github_issue_upstream_closed` event names each issue GitHub closed upstream in the log the operator reads (planned 2026-11-22 by the plan role; requires part 1/2 landed; sibling of part 1/2, which writes the ledger list this event reports; touches src/events/events.ts src/events/event-labels.ts src/events/event-format-config.ts src/events/event-format.ts src/failure/failure-state-change.ts src/github/issue-scan.ts test/event-format.test.ts test/github-issue-scan.test.ts)

**Problem.** Part 1/2 records an upstream close in the ledger, which only `tumwater issues` reads. The
other mirror outcomes each name themselves in the events log the operator watches —
`github_issues_unavailable`, `github_issue_closed`, `github_issue_declined`, `github_issue_queued` in
src/events/events.ts, each with a label in src/events/event-labels.ts, a line in `configEventMessage`
(src/events/event-format-config.ts) and a slot in `EVENT_MESSAGE_FAMILY`'s config row
(src/events/event-format.ts), and each listed in `STATE_CHANGE_EXCLUDED_TYPES`
(src/failure/failure-state-change.ts), which test/failure-state-change.test.ts
"every event type is replayed or explicitly excluded" requires to partition `EVENT_TYPE_LABELS`' keys.
An issue GitHub closed upstream — the one mirror outcome nobody in tumwater caused — is the only one
with no log line, so `tumwater logs` shows the mirror losing an issue as nothing at all.

**Approach.** One event type in the same family, written by the same fold that writes the ledger list.

- `src/events/events.ts`: add `"github_issue_upstream_closed"` to the `type` union beside its
  `github_issue_queued` sibling, with a comment naming what it carries: `repo`, `issue`, and the lost
  row's `updatedAt` (the last time GitHub said anything about it).
- `src/events/event-labels.ts`: `github_issue_upstream_closed: "github issue closed upstream"` beside
  the other `github_issue_*` labels.
- `src/events/event-format-config.ts`: a `case "github_issue_upstream_closed"` in `configEventMessage`,
  a routine outcome with no warning prefix, rendering
  `GitHub closed issue #<issue> on <repo>, last seen open <updatedAt>` through `textOr` like its
  `github_issue_closed` twin — every field read defensively so a torn line still renders.
- `src/events/event-format.ts`: add the type to the `configEventMessage` row of `EVENT_MESSAGE_FAMILY`.
- `src/failure/failure-state-change.ts`: add it to `STATE_CHANGE_EXCLUDED_TYPES` beside the other
  `github_issue_*` entries — the digest does not replay it.
- `src/github/issue-scan.ts`: inside `recordUpstreamCloses`, for each row the fold newly records, call
  `logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "github_issue_upstream_closed", repo,
  issue, updatedAt })` — one event per issue, only for a listing that read to the end, and none for a
  row already sitting in `upstreamClosed` (a loss is logged once, not once per scan).

**Files touched.** The five event/failure sites above, `src/github/issue-scan.ts`,
`test/event-format.test.ts`, `test/github-issue-scan.test.ts`.

**Acceptance criteria.**

- `eventMessage` for `{ type: "github_issue_upstream_closed", repo: "znation/proj", issue: 8,
  updatedAt: "2026-11-10T12:00:00.000Z" }` reads
  `GitHub closed issue #8 on znation/proj, last seen open 2026-11-10T12:00:00.000Z`, and for that type
  with no other fields renders a line that is not the bare code — the rule test/event-format.test.ts
  "eventMessage gives every event type its own line, never the bare code" enforces over every
  `EVENT_TYPE_LABELS` key, which the new label alone now satisfies.
- A scan that loses #8 upstream appends exactly one `github_issue_upstream_closed` event to the project's
  events log naming `#8`, and the same scan re-run with the same listings appends none, the way
  test/github-issue-scan.test.ts "two consecutive outages log one github_issues_unavailable event" pins
  the once-per-occurrence rule for the outage pair.
- `test/failure-state-change.test.ts` passes unedited: the new type lands in exactly one of
  `STATE_CHANGE_TYPES` and `STATE_CHANGE_EXCLUDED_TYPES`.

Verify: `npm run build`, then
`node scripts/check-permit.mjs node dist/test/test-runner.js event-format event-labels event-format-team failure-state-change github-issue-scan backlog-structure plans-citations plan-citations backlog-pending backlog-eligibility vocabulary`.

**Not covered (follow-ups).** Nothing notes the upstream close on the mirrored BUGS.md/PLANS.md entry —
plans/github-issues.md's **Not in scope** bullet keeps that open, and the entry stays open. The status
snapshot, the dashboard banners and the doctor's `github issues` row raise nothing for a lost issue, and
`waitingPush[<n>]` keeps counting an issue GitHub closed upstream as still waiting for a push. The
unmerged `tumwater issues --open`/`--closed` entry partitions rows by `wasClosed` only, so on an
`upstreamClosed` row its `--open` filter keeps the row and `--closed` hides it; a later entry should
decide which state an upstream close belongs to (and may add a third spelling) once both land.

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

### The dashboard's salvage card offers a per-patch View, so an operator reads a kept patch in the
browser without leaving for `tumwater salvage --show`
(planned 2026-11-22 by the plan role)

**Why.** The Settings tab's "Salvaged patches" card shows what each kept patch *is* — file name,
how long ago it was saved, byte size, and its 1-based number — and offers Apply and Drop for each,
but nothing in the dashboard shows what a patch *contains*. The CLI has had that answer since
"`tumwater salvage --show <n>`": `--show <n>` prints the header, the saved-ago and size line,
git's per-file diffstat, and the patch text verbatim. The operator deciding whether to Apply or
Drop a patch is exactly the operator who needs to see the diff first, and today they must leave the
dashboard, run `tumwater salvage` to re-derive the position, and run `--show <n>`. The card is
where the patch was meant to be handled.

**Approach.** Add the browser twin of `--show` as its own read-only endpoint, then one button per
card row that expands that patch into the card.

- **The endpoint.** Add `handleSalvageShow` to `src/gui/gui-salvage-commands.ts` beside
  `handleSalvageList`/`handleSalvageApply`/`handleSalvageDrop`, exported through the same
  aggregation file those three ride (`src/gui/gui-endpoint-commands.ts`), and route
  `GET /api/salvage-show` in `src/gui/gui-server.ts` beside the three existing `salvage` routes.
  It answers `{ position, file, savedAt, bytes, size, stat, patch }` for the Nth patch *of the
  unfiltered oldest-first list*:
  - `position` comes from `intQuery(q, res, "position", "positive")` (`src/gui/gui-args.ts`), so a
    missing parameter is `position required` and a non-decimal one is
    `position must be a positive integer (got …)` — the exact wording the dashboard's other count
    queries give, at 400.
  - The row is resolved the way `handleSalvageDrop` resolves it: `salvagePatchAt`
    (`src/status/status-salvage.ts`) over `collectSalvagePatches(root)`, the same whole-list address
    apply and drop take. When that result carries a `message` (position below 1 or past the end),
    the handler answers the shape apply and drop already answer for that case —
    200 `{ ok: false, message: at.message }`, the shared sentence
    `no salvaged workspace patch at position <n> (salvage holds N patches)…` — so the card's error
    slot states the same words the CLI states and all three handlers stay one rule. The position a
    filtered list would number differently is out of scope: the card lists the unfiltered list.
  - `patch` is the exact file text from `readSalvagePatch(root, file)`, with no trailing newline
    added or removed (a null read — the file vanished between the collect and the read — answers the
    same `{ ok: false, message }` shape as the vanished-entry handlers); `stat` is
    `salvagePatchStat(root, file)` (`src/git/slot-salvage.ts`, the async `git apply --stat` reader
    the CLI's `--show` calls), `null` when the patch is not a valid diff — the same split the CLI
    makes.
  - `file`, `savedAt`, `bytes` and the display `size` (`formatBytes`) are exactly the four fields
  `handleSalvageList` already answers for that row, computed the same way, so the browser's header
  cannot state something the card's own list row disagrees with.
- **The card.** In `src/ui/gui/gui-client-settings.ts`, `renderSalvage` adds a third button to every
  row, `data-action='salvage-view'`, labelled `View`, and a body slot for that row. A new
  `salvageViewClick(position)` fetches `/api/salvage-show?position=<n>` through the same `getJson`
  `fetchSalvage` uses, then fills that row's slot with an escaped `<pre class='mono diff'>` of the
  patch text — the same `mono diff` treatment the log/activity drawer already uses for a body —
  under the header line (the row's own `<n>. <file>` plus `saved <ago>, <size>` in the card's
  existing `fmtAgo`/`size` wording) and the `stat` block when it is
  non-null. A second click collapses it without refetching. A failed read puts
  the server's message in the slot through `clientErrorMessage` and leaves the row's Apply and Drop
  working; a row is open at a time, and opening one closes the open one. `renderSalvage` takes the
  open position as a third argument beside the existing `armed` callback (the way it already takes
  the armed state), so the paint stays a pure function of the fetched data plus one slot. Wire the
  click in the one
  document-level delegated click handler in `src/ui/gui/gui-client-boot.ts` that already routes
  `salvage-apply` and `salvage-drop` to `salvageApplyClick`/`salvageDropClick`, so no new listener
  is added.
- **Docs.** One clause on the existing `Read a kept patch` row of `docs/cli.md`, which already
  carries the card's sentence — that the card lists the same kept patches and offers a per-patch
  Apply and Drop — extended to say the card also offers a per-patch View that shows the same
  header, diffstat and patch text the CLI's `--show` prints. No new CLI behaviour, no new flag.

**Files touched.** `src/gui/gui-salvage-commands.ts`, the `gui-endpoint-commands` aggregation it is
exported through, `src/gui/gui-server.ts`, `src/ui/gui/gui-client-settings.ts`,
`src/ui/gui/gui-client-boot.ts`, `docs/cli.md`, `docs/invariants.md`, `test/gui-salvage.test.ts`,
and `test/gui-client-settings.test.ts` (which holds both the client's exported-name list and the
`GUI_CLIENT_BOOT_JS` delegation regexes — there is no separate boot-behaviour test for these
buttons).

**INV section** (in the `docs/invariants.md` section that holds the `tumwater salvage`
commands, the one the salvage list/apply/drop dashboard endpoints already sit in). New ids:

- **INV-SV1**: `GET /api/salvage-show?position=<n>` returns the exact text of the Nth patch of the
  unfiltered oldest-first list, the same address `--apply <n>` and `--drop <n>` take; an absent or
  malformed position answers 400 with `intQuery`'s wording, and a position off the list answers the
  same `{ ok: false, message }` shape apply and drop answer for it. It writes nothing and creates no
  salvage directory. `test/gui-salvage.test.ts`.
- **INV-SV2**: the card's View button renders the fetched patch text escaped in the row it belongs
  to, showing the `stat` block only when the patch is a valid diff; a read failure shows the server's
  message in that row and leaves that patch's Apply and Drop buttons functional. One row is open at a
  time. `test/gui-client-settings.test.ts`.

**Acceptance criteria.**

- Given a salvage dir holding two patches (older first) and a pending patch, `GET
  /api/salvage-show?position=1` answers the older patch's object — its `file`, `bytes`, `savedAt` and
  `size` equal to what `GET /api/salvage` answers for that same row, a `patch`
  equal to the file's exact bytes as a string, and a `stat` naming the patch's one changed file —
  and `position=2` answers the newer one; the pending patch is never addressable at any position.
- Given a patch whose text is not a valid diff (a truncated `From <sha>` scratch file), the same
  request answers `stat: null` with the `patch` text unchanged, and given a valid diff it answers a
  non-null `stat`. The request creates no directory and changes no file (an assertion on the dir
  listing before and after).
- Given `position` absent, the reply is 400 `{ error: "position required" }`; given
  `position=abc` or `position=0`, it is 400 with the `must be a positive integer` sentence; given
  `position=7` over a two-patch list, the reply states the shared off-list sentence naming position 7
  and how many patches the salvage dir holds — the same sentence `--drop 7` prints.
- Given the card rendered from a two-patch list, a click on row 2's `View` fetches
  `/api/salvage-show?position=2` and paints that row's slot with the patch text (escaped — a patch
  containing `<script>` reaches the DOM as text, not as an element) under the row's header; a click
  on row 1's `View` closes row 2 and opens row 1; a second click on the open row closes it without a
  second fetch. A click while the read fails paints the error sentence in that row and the row's
  Apply and Drop buttons still post the same `{ position }` bodies as before.
- `test/gui-client-settings.test.ts`: `salvageViewClick` joins the exported-name list that test
  asserts, and the `GUI_CLIENT_BOOT_JS` assertions gain a `button[data-action='salvage-view']`
  delegation regex beside the existing `salvage-apply` and `salvage-drop` ones, so a click on the
  new button reaches the new helper with the button's `data-position`.
- `test/cli-doc.test.ts` and the help/completion tests pass unedited — the CLI's flag surface does
  not change.

**Verification (run from a built tree).** `npm run build`, then
`node scripts/check-permit.mjs node dist/test/test-runner.js gui-salvage gui-client-settings
gui-client-boot backlog-structure plans-citations plan-citations backlog-pending backlog-eligibility
vocabulary backlog-index-edges backlog-render backlog-release-holds invariants-doc`.

**Not covered (follow-ups).** The View slot is plain monospace text, not a syntax- or
diff-coloured rendering; the card still has no way to search the patch text the way
`tumwater salvage --grep <text>` does (adding a `q` parameter here would renumber the positions, so
it needs its own decision about what number a filtered card row carries). Nothing on the dashboard
or in the status snapshot points an operator at the card when patches are kept beyond some age —
the `salvage-patches` alert counts them but never says one is going stale, and session retention
can still prune a kept patch an operator never opened.

## Done
