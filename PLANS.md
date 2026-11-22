# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

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

### The doctor's `github issues` row says when the mirror's scan has gone quiet: one `githubScanStalled` predicate beside the ledger (planned 2026-11-22 by the plan role; touches src/github/github-issues-state.ts, src/github/issue-scan.ts, src/doctor/doctor-project-checks.ts, src/doctor/doctor.ts, test/github-issue-scan.test.ts, test/doctor-checks.test.ts, docs/feature-doctor.md, docs/invariants.md)

**Goal.** The `github issues` row answers only "can `gh` read this repo today?", so a mirror that
stopped scanning — a project paused for a week, an orchestrator that never started, a
`scanIntervalMinutes` the operator stretched — reads `gh ready — tumwater mirrors znation/tumwater's
open issues` forever. `tumwater issues` prints the scan's age but warns about nothing, so the
operator has to notice a stale timestamp themselves. Give the mirror the standing stall signal every
other ledger-backed row has: the row keeps its `gh` half and gains a stall half, decided by one
exported predicate next to the ledger it reads.

**Why now, and what already exists.** The stall-predicate family is the established shape:
`qaCoverageStalled`/`QA_COVERAGE_STALE_MS` (src/observer/qa-coverage.ts, read by
`checkQaCoverage`), `ciParityStalled`/`CI_PARITY_STALE_MS` (src/observer/ci-parity.ts) and
`remoteCiStalled` (src/observer/remote-ci.ts, which imports that same three-day window), each pinned
by docs/invariants.md INV-BW3/INV-BW5 as "the one home of that decision, its doctor row the only
consumer". `grep -rn 'githubScanStalled\|GITHUB_ISSUES_STALE_MS' src test docs PLANS.md PLANS-DONE.md
BUGS.md BUGS-FIXED.md` prints nothing: the issues ledger is the one scan-backed store in that family
with no stall predicate. Its scan is on a one-hour clock (`DEFAULT_SCAN_INTERVAL_MINUTES = 60`,
src/github/issue-scan.ts) and rewrites the ledger on every attempt even when `gh` fails — it sets
`checkedAt: now` before its `writeGithubIssues` (in `scanGithubIssues`, the `const ledger: GithubIssuesLedger`
literal that spreads `...(previous ?? {})`) — so an old `checkedAt` means the scan itself stopped
running, which is exactly the fact no surface states. The landed `tumwater issues` part
(PLANS-DONE.md "The GitHub-issues mirror gets a terminal read") scoped that command to a terminal
read of the ledger and added no warning; the part 3/5 alert work added only `github-gh` (gh state),
`github-error` (a failed scan) and `github-mirror` (issues waiting on the director), each driven by
the *last scan's* `gh` field — none of them fires on a scan that simply never happened.

**How it works.**

- src/github/github-issues-state.ts, beside `readGithubIssues`: export
  `GITHUB_ISSUES_STALE_MS = 3 * DAY_MS` (import `DAY_MS` from `../text/datetime.js` —
  src/github/github-issues-render.ts already imports `humanAgo` from that module, so the layer
  allows the edge) and
  `githubScanStalled(ledger: GithubIssuesLedger | null, now: number): boolean`. It is true only for
  a ledger whose `checkedAt` is a number and `now - checkedAt > GITHUB_ISSUES_STALE_MS`; a null
  ledger (never scanned, or an unreadable file) and a `checkedAt` that is not a number are both
  false — the empty-ledger rule `qaCoverageStalled` and `ciParityStalled` keep, restated in this
  predicate's doc comment. It takes the loose `GithubIssuesLedger | null`, not a shape the fold
  checked: a hand-edited ledger must read "not stalled", never throw.
- src/doctor/doctor-project-checks.ts `checkGithubIssues`: gains a trailing
  `now: number = Date.now()` parameter (after the existing `run: GhRunner` parameter, the way
  `checkCiParity`/`checkQaCoverage` take `now`) and, in the arm that today returns
  `okOutcome(\`gh ready — tumwater mirrors ${target.repo}'s open issues\`)`, reads
  `readGithubIssues(root)` and consults `githubScanStalled`. Precedence stays with `gh`: the
  no-target/no-config omissions and both unreadable-`gh` warns are untouched and come first. When
  stalled, the row warns with exactly
  `gh ready — but the last scan checked <repo> <age>, over 3 days ago, so tumwater is not mirroring its open issues`
  where `<age>` is `humanAgo(ledger.checkedAt, now)` from src/text/datetime.ts (already imported
  there) and the days figure is `GITHUB_ISSUES_STALE_MS / DAY_MS`, as the qa and remote-CI rows
  spell their windows. When not stalled the ok detail is byte-identical to today's — no age, no
  extra clause — so the pinned detail in test/doctor-checks.test.ts (the
  `gh ready — tumwater mirrors znation/tumwater's open issues` assertion) and every
  `tumwater issues`/status surface stay unchanged.
- src/doctor/doctor.ts: the `{ name: "github issues", run: … }` step passes the runner and clock
  explicitly — `checkGithubIssues(root, config, pathEnv, ghRunner(pathEnv), Date.now())` — importing
  `ghRunner` from `../github/gh.js` (the module doctor-project-checks.ts already pulls the readiness
  probe from). The row's presence conditions and its place in `DOCTOR_CHECK_NAMES` are unchanged, so
  test/doctor.test.ts's row list and its `github issues` exclusion stay as they are.
- Docs. docs/feature-doctor.md's "Main and the build" bullet, where the `github issues` entry
  currently reads "(`gh` readiness for the GitHub issues mirror)", gains the stall half and names the
  window. docs/invariants.md gets a new section, `## The GitHub issues mirror: one predicate decides
  when its scan has gone quiet`, with `### INV-DE1: githubScanStalled is the one home of the
  issues-scan stall decision` (INV-DE is the next free prefix: `grep -c 'INV-DE' docs/invariants.md`
  prints 0), written in INV-BW5's shape — **Guarantee** states the window, the null and
  non-numeric-`checkedAt` rules, and that `checkGithubIssues` is the decision's only consumer and
  applies it after the `gh` readiness gate; **Binds** names src/github/github-issues-state.ts
  (`githubScanStalled`, `GITHUB_ISSUES_STALE_MS`) and src/doctor/doctor-project-checks.ts
  (`checkGithubIssues`); **Pinned by** names the new cases below.

**Not covered (follow-ups).** No dashboard/`status` alert for a stalled mirror, and no change to
src/ui/team-alert-status.ts's `github-gh`/`github-error`/`github-mirror` banners or to
`githubIssuesSummary`: the row is this change's standing signal, exactly as the qa and remote-CI
stalls have a doctor row and no banner. The scan's own clock (`dueForIssueScan`,
`FIRST_ISSUE_SCAN_DELAY_MS`, `scanIntervalMinutes`) is unchanged.

**Acceptance.**
- `githubScanStalled` in test/github-issue-scan.test.ts: a ledger whose `checkedAt` is
  `NOW - GITHUB_ISSUES_STALE_MS` is false and one a millisecond past it is true; `null` is false; a
  ledger object whose `checkedAt` is `"1764000000000"` (a hand-edited file) is false and the call
  does not throw.
- In test/doctor-checks.test.ts, with a GitHub remote, enabled mirror and a fake `gh` that is
  logged in, and an explicit `now`: a fixture whose ledger file (`githubIssuesPath(root)`,
  src/paths.ts — `<root>/.tumwater/state/github-issues.json`) holds
  `checkedAt: now - 4 * DAY_MS, gh: "ok"` gives `{ level: "warn", detail: "gh ready — but the last
  scan checked znation/tumwater 4d ago, over 3 days ago, so tumwater is not mirroring its open
  issues" }`; the same fixture with `checkedAt: now - GITHUB_ISSUES_STALE_MS` gives the unchanged ok
  detail, and a fixture with no ledger file gives that same unchanged ok detail (the existing
  assertion holds unedited).
- A stalled ledger does not outrank a broken `gh`: with `checkedAt` four days old and the fake `gh`
  reporting no version, the row's detail is the existing `gh is missing — install GitHub CLI …`
  sentence and the fake records the same single `--version` call as today.
- The predicate and the row agree on one fixture: for the same ledger file, `githubScanStalled` and
  the row's warn/ok level match, so a stalled mirror cannot read ok in one surface and warn in the
  other.

## Done
