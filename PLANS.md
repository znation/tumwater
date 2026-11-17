# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. The
harness renders it read-only; the roles that act on it are plan (adds and retires `## Planned`
entries), feature (claims, completes, refuses, and reports plan defects on `## Planned`), and bugfix
(claims, fixes, and refuses `## Open`). Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### Operator steering, part 1/5: `tumwater land` puts a hand-made commit on main under the team's merge lock (planned 2026-11-16 by the operator; touches src/operator/operator-land.ts src/cli/cli-land-command.ts src/cli.ts src/cli/cli-help-text.ts docs/cli.md test/operator-land.test.ts)

**Goal.** The intended way to use tumwater is an operator steering the team, mostly by editing
PLANS.md and BUGS.md from their own interactive agent (claude, codex, omp) with a strong model.
Those edits have no safe way onto main while a team runs. A bare `git merge --ff-only` (or a
commit in the primary checkout) can move main while a team merge is inside its locked check, so
that merge fails as a reasonless `merge_blocked` and the change redoes gate, review and check.
Concurrent role commits also conflict at the top of `## Planned`, `## Done` and `## Fixed`, which
tumwater already knows how to merge entry by entry. `tumwater land` makes this one command: it
takes the locks the team takes and fast-forwards main to the operator's commits.

**Approach.**
- New `src/operator/operator-land.ts` holding `landOnMain(root, ref, opts)`. Shape it on
  `archiveOnMain` (src/backlog/backlog-archive.ts:477): `withLock(mergeLockDir(root), …)` around
  `withPrimaryWorktreeLockAsync(root, …)`, so a land waits for an in-flight team merge instead of
  racing it.
- Inside the locks: resolve `ref` (default `HEAD` of the cwd's worktree) and the base branch. Refuse
  when `ref` is already contained in main (`nothing to land`), when it holds a merge commit, or when
  its range touches `.tumwater/`. When main is an ancestor of `ref`, fast-forward through
  `ffMainToOrWhy` (src/merge/merge-git.ts) and nothing else. When main has moved, replay the
  commits main lacks onto main in a temporary detached worktree under `.tumwater/` (never the
  operator's worktree, never the primary checkout). Settle conflicts in PLANS.md, BUGS.md and
  QUESTIONS.md with `resolveBacklogInsertConflicts` (src/merge/merge-backlog-conflicts.ts). Any
  other conflict aborts the replay, removes the temporary worktree and refuses, naming the
  conflicted paths and leaving main and the operator's branch exactly as they were. Then
  fast-forward main to the replayed tip.
- After a replay, point the operator's branch at the landed tip only when it is checked out
  nowhere else and has no uncommitted changes. Otherwise say which sha landed so the operator can
  `git reset --hard <sha>` in their worktree.
- No model runs, no check runs: the operator's own commit is trusted, and the hourly full check
  and the next role gates see it as any other main move. Say so in the help stanza.
- CLI: `tumwater land [<ref>] [--dry-run] [--json]` in a new `src/cli/cli-land-command.ts`, a row in
  the `COMMAND_HANDLERS` table in src/cli.ts behind `requireReadyRepo` and `rejectUnknownArgs`, and
  a usage stanza in src/cli/cli-help-text.ts. `--dry-run` reports the commits, the paths they
  touch, whether a replay is needed and whether it would apply, and writes nothing. `--json` prints
  `{ landed, beforeSha, headSha, replayed, commits }`, and on a dry run `{ dryRun: true, commits,
  paths, replay, applies }`. Add the command's row to docs/cli.md's "Steer the project" row
  beside `tumwater revert`.

**Acceptance criteria.**
- With a team merge holding `.tumwater/merge.lock`, `tumwater land` waits and lands after it
  releases; it never moves main while that lock is held by someone else.
- A branch one commit ahead of main lands as a fast-forward: main's new tip is that commit's sha.
- A branch whose base is behind main, adding a `### ` entry at the top of `## Planned` while main
  added a different entry at the same spot, lands with both entries present and main's entry
  order otherwise unchanged.
- A replay that conflicts in a code file refuses with exit 1, names the file, and leaves main, the
  operator's branch and the primary checkout byte-identical; no temporary worktree is left behind.
- `--dry-run` writes nothing (main's sha and `git worktree list` unchanged).
- Refusals: an already-merged ref, a merge commit in the range, a range touching `.tumwater/`.

**Tests.** test/operator-land.test.ts against repo fixtures (test/fixtures/repo-fixtures.ts):
fast-forward, replay with a backlog insert conflict, code conflict refusal, dry run, each refusal,
and the lock wait (hold the merge lock from the test, start a land, release, assert it landed
after). Expected shas come from the fixture's own commits, not from the code under test. Then the
project's gate.

### Operator steering, part 2/5: `tumwater guide` prints the operator's working rules for an interactive agent (planned 2026-11-16 by the operator; requires Operator steering part 1/5 landed; touches src/operator/operator-guide.ts src/cli.ts src/cli/cli-help-text.ts docs/cli.md test/operator-guide.test.ts)

**Goal.** An operator's own agent (claude, codex, omp) should be able to learn how to steer
tumwater by running one command: `tumwater guide`. The text is versioned with the install, so it
always matches the commands the installed tumwater has. It must not live in the project's
CLAUDE.md or AGENTS.md: tumwater's claude, codex and opencode backends load those files into every
role run (src/agent/claude/claude-args.ts, src/agent/codex/codex-args.ts,
src/agent/opencode/opencode-config.ts), and these rules are for the operator's agent, not the
team.

**Approach.**
- New `src/operator/operator-guide.ts` exporting `guideText(project?: GuideProject): string`. The
  static body is plain markdown, wrapped at 100 columns, in this order:
  1. **What you are doing.** The team executes PLANS.md and BUGS.md one small reviewed change at
     a time; you (the operator's agent) steer by investigating and writing sharp entries. You do
     not implement backlog entries yourself unless the operator asks.
  2. **Orient first.** `tumwater status`, `tumwater history --result problems`, `tumwater plan
     --list`, `tumwater bug --list`, `tumwater questions`, `tumwater doctor`.
  3. **Writing a plan.** One run's worth of work: Goal, Approach (named files and functions),
     Files touched, Acceptance criteria (each checkable), Tests (where each expected value comes
     from). Larger work is a series: headings `### <Series>, part i/n: <title> (planned <date> by
     the operator; requires <Series> part j/n landed; touches <paths>)`. The `requires … landed`
     clause must sit in the heading's last parenthetical, since that is the only place the claim
     allocator reads it.
  4. **Writing a bug.** Symptom as the heading; **Reproduce.**, **Suspected cause.** A bug
     moved to `## Fixed` carries a `**Validation gap:** <tag> — <one sentence>` line (the tags
     init-templates.ts lists).
  5. **Rules.** Never edit or move an entry `--list` marks `[working on it: …]`. Put a conflicting
     new plan on top of it with a `requires` clause instead. Latest instruction wins: amend an
     unclaimed entry in place with a dated `amended <date> by the operator` note rather than
     filing a duplicate. Never edit PLANS-DONE.md or BUGS-FIXED.md directly or anything under
     `.tumwater/`. tumwater.json edits apply live.
  6. **Getting edits onto main.** For one entry, `tumwater plan|bug --file`, `--edit <n> --file`,
     `--top`, `--cancel`, `--retire`, `--release`, and `tumwater questions answer`. They commit on
     main under the team's lock. `--file` appends its own `(reported by the user <date>)` stamp as
     the heading's last parenthetical, so a series part with a `requires` clause goes the other
     way: edit the files in your own branch or worktree, commit, then `tumwater land`. Never
     commit, merge or pull on the base branch in the primary checkout yourself.
  7. **Other steering.** `tumwater prompt "<text>"` for the director, `tumwater revert <sha>`,
     `tumwater pause` / `resume`, `tumwater questions answer`.
- Inside a ready tumwater repo, append a **This project** section: the base branch, the declared
  check as `describeCheck` (src/build/build-check-report.ts) words it (never assume npm), and
  whether a team is running (the same pid read `tumwater status` uses). Outside a repo, print the
  static body alone and exit 0, like `help`.
- CLI: `tumwater guide` takes no arguments (`rejectUnknownArgs`), a `COMMAND_HANDLERS` row in
  src/cli.ts, a usage stanza in src/cli/cli-help-text.ts, and a row in docs/cli.md.

**Acceptance criteria.**
- `tumwater guide` outside any repo exits 0 and prints the seven sections above.
- In a fixture repo with a declared `check.command`, the output names that command and the
  fixture's base branch; with no declared check it says so instead of naming npm.
- Every `tumwater <command>` the guide text names is a command in `HELP`: the test extracts them
  from `guideText()` and checks each against the help text, so a renamed command cannot leave the
  guide stale.
- `tumwater guide --json` and any stray argument fail like other unknown arguments.

**Tests.** test/operator-guide.test.ts: the outside-repo and fixture-repo outputs (expected branch
and command taken from the fixture's own setup), the command-name drift check, unknown arguments.
Then the project's gate.

### Operator steering, part 3/5: docs/steering.md says how an operator runs tumwater with their own agent (planned 2026-11-16 by the operator; requires Operator steering parts 1/5, 2/5 landed; touches docs/steering.md docs/how-it-works.md docs/cli.md)

**Goal.** The docs describe the intended way to use tumwater, and that way is not hands-off. The
team does the volume work; the operator steers it, and the primary way to steer is a strong model
in the operator's own interactive harness (claude, codex, omp) editing PLANS.md and BUGS.md. Today
no doc says so; the knowledge an operator's agent needs lived only outside the repo.

**Approach.** Write docs/steering.md for a human reader, in plain terms (docs/glossary.md):
- **The three ways to steer**, in order: your own agent in the repo (the primary one); the
  director prompt (dashboard, TUI, `tumwater prompt`) for quick steering without leaving the UI;
  answering the questions the team raises (`tumwater questions`). Running hands-off works (`start
  --for`, `--once`), but it is not where tumwater does its best work.
- **The loop.** Start the team; in a second terminal open your agent in the repo and tell it to
  run `tumwater guide` first; have it read `tumwater status`, `history --result problems` and the
  backlog lists; ask it to investigate and to file, sharpen, reorder or retire entries; watch what
  merges.
- **What makes a good entry**, briefly, pointing at `tumwater guide` for the full rules rather than
  repeating them.
- **Landing direct edits** with `tumwater land`, and why a plain `git merge` on main can collide
  with a team merge.
- **What the director is for** compared with your own agent: the director lives in the team and
  runs on the team's strong tier; your agent has your conversation, your judgment and the whole
  repo, and is where design decisions get made.
- Link it from docs/how-it-works.md's Setup section (one sentence after `tumwater start`) and from
  docs/cli.md's opening paragraph.

**Acceptance criteria.**
- docs/steering.md exists, names `tumwater guide` and `tumwater land`, and lists the three ways to
  steer in the order above.
- docs/how-it-works.md and docs/cli.md each link to docs/steering.md.
- Every `tumwater` command the new doc names exists in `tumwater help`.
- No README change in this part (part 4/5 owns it).

**Tests.** The project's gate (the docs-drift checks cover links and command names).

### Operator steering, part 4/5: The README says up front that you steer tumwater, mainly from your own agent (planned 2026-11-16 by the operator; requires Operator steering part 3/5 landed; touches README.md)

**Goal.** A first-time reader learns from the README's opening that tumwater is meant to be
steered, not run hands-off, and that the primary way is their own interactive agent editing the
backlog.

**Approach.**
- Rewrite the intro paragraph after the token warning. Keep what it says about roles, small reviewed
  commits and local-only git state. Replace "It came from wanting to write only the brief and let
  a team of always-on specialists do the rest" with: the team does the volume work, and you steer
  it, mainly by curating PLANS.md and BUGS.md with a strong model in your own interactive harness
  (claude, codex, omp).
- Add a short `## How you work with tumwater` section between Install and Status: the three ways
  to steer (your own agent, primary; the director prompt; answering questions), the one-line loop
  ("start the team, open your agent in the repo, tell it to run `tumwater guide`"), and a link to
  docs/steering.md.
- In Usage, the paragraph starting "From another terminal" leads with your agent and `tumwater
  guide` before `tumwater tui`, `status` and `logs`.
- Leave the warning, the `tumwater:status` markers and the brief appendix between the
  `tumwater:prompt` markers untouched; the brief is the operator's to change.

**Acceptance criteria.**
- The README no longer says you only write the brief anywhere outside the brief appendix.
- The new section exists between Install and Status, links docs/steering.md, and names `tumwater
  guide`.
- The status and prompt marker blocks are byte-identical to before.

**Tests.** The project's gate.

### Operator steering, part 5/5: Seeded files, help and package text stop describing a hands-off team (planned 2026-11-16 by the operator; requires Operator steering part 2/5 landed; touches src/init/init-templates.ts src/cli/cli-init.ts src/cli/cli-help-text.ts package.json docs/glossary.md PLANS.md)

**Goal.** The text a new user meets outside the README matches the steered use. Today the seeded
PLANS.md says plans are "written by the plan role", the help's first line and package.json
describe "an autonomous development team" that needs only the initial prompt, and `init`'s next
step mentions only `tumwater start` and `tumwater tui`.

**Approach.**
- src/init/init-templates.ts: `PLANS_TEMPLATE`'s lead becomes "Planned features, written by you
  (often through your own agent) or the plan role, and implemented by the feature role." and
  `BUGS_TEMPLATE`'s "recorded by any role" becomes "recorded by you or any role". Keep the rest of
  both templates.
- src/cli/cli-init.ts: the `next:` line adds "and point your own agent at `tumwater guide`".
- src/cli/cli-help-text.ts: `HELP`'s first line describes a development team you steer, still
  naming the four backends.
- package.json: `description` says the team builds the project while you steer it through the
  backlog, from your own agent or the director; keep `autonomous` in keywords.
- docs/glossary.md: add a Terms row "your agent: the interactive harness (claude, codex, omp) you
  run in the repo to steer the team; not one of tumwater's roles".
- This repo's PLANS.md lead paragraph: replace "The harness renders it read-only; the roles that
  act on it are …" with a sentence that the operator (often through their own agent) writes and
  edits entries too, keeping the list of what each role does. Edit only that paragraph.

**Acceptance criteria.**
- A fresh `tumwater init` writes the new PLANS.md and BUGS.md leads and prints the new `next:` line.
- `tumwater help`'s first line and package.json's `description` no longer say the team needs only
  the initial prompt.
- The glossary row exists; no `### ` entry in PLANS.md changes.

**Tests.** Update the init and help tests that pin the old wording to the new text (test/init*.ts,
test/help.test.ts) from the template constants, not by copying the output. Then the project's gate.

## Done

### `sectionSpan`'s fence-aware section boundary is pinned in test/backlog.test.ts, so a regression in the one fence-aware home of a `## ` section's span the backlog writers (backlog-write.ts) and the archive mover (backlog-archive.ts) both read through — the heading a `## <title>` section opens at, and the next real `## ` heading that ends it — is caught by the suite (planned 2026-11-16 by the plan role; continues the pin-a-rule family — the recent `roleInScope` (test/roles.test.ts, above), `lowerMedian`, `compareCodeUnits`, `validEntries` entries each take one correct-but-unpinned single-home rule and pin it in its natural test file with plain `assert`. `sectionSpan(lines: readonly string[], title: string)` in src/backlog/backlog-md.ts returns the 0-based span `{ heading, end }` of the FIRST `## <title>` section — its heading line, then `nextSectionHeading`'s walk to the next real `## ` heading (or `lines.length`) — or `null` when no such section exists. It reads every line through the shared fenceTracker, so a `## ` line quoted inside a fenced code block is body text, never a section boundary. `grep -rlw sectionSpan test/` is empty — no test file references it. Its fence branch is genuinely unpinned: its only src consumers are the writers, and neither `test/backlog-archive.test.ts` (0 fenced blocks) nor a write test feeds a section whose boundary is quoted inside a fence. The two sibling fence-aware section readers are already pinned transitively and are NOT this entry's target — `fenceAwareHeadingLines`'s consumers (`duplicateHeadings`, `actionableEntryRanges`) have fenced-heading tests in test/backlog-structure.test.ts, and `sectionBodyLines`'s consumer (`strandedPlanEntries`) has a fenced-`## Planned` test there; pinning them again would add a duplicate. The flip a regression would silently make: read the heading line without the fence guard (or drop `fencedHeadingTitle`) and a `## Done` quoted inside a fenced entry is mistaken for the archive's real `## Done` heading — or, reading the end boundary without the guard, cuts the section at a quoted `## Fixed`, so the archive mover ships the wrong lines — done 2026-11-16 by the feature role

**Goal.** Pin the one fence-aware section reader the backlog writers read through — `sectionSpan` — in `test/backlog.test.ts`, the file that already hosts the fence-reading tests (`fenceTracker`, `fenceOpener`, `closesFence`) and imports from `../src/backlog/backlog-md.js`.

**Approach.** One file, no new dependency, no src change, no invariant edit. In `test/backlog.test.ts` add `sectionSpan` to the existing `../src/backlog/backlog-md.js` import and add one `test(…)` block named for the rule (e.g. `"sectionSpan finds a ## section's span, fence-aware"`), with plain `assert` cases whose expected values are worked from the `fencedHeadingTitle`/`nextSectionHeading` bodies in src/backlog/backlog-md.ts, not from calling the function — `sectionSpan` takes a `string[]`, so each case is `sectionSpan([...lines], "<title>")` against a `assert.deepEqual` of the exact `{ heading, end }` or `null`:
- a quoted `## <title>` inside a fence is not the section, and a later real `## <title>` is: `sectionSpan(["## Done", "", "x", "```md", "## Done", "```", "", "## Fixed", "y"], "Done")` is `{ heading: 0, end: 7 }` — the fence is open at line 4, so the quoted `## Done` (line 4) is body text and never the heading; the real heading is line 0 and the end is the real `## Fixed` at line 7.
- a `## <title>` whose only occurrence is fenced is absent: `sectionSpan(["## Open", "", "```", "## Done", "```", "", "## Fixed", "y"], "Done")` is `null` — the sole `## Done` is a quoted line inside the fence, so the section does not exist.
- a plain (unfenced) section still resolves: `sectionSpan(["## Open", "a", "", "## Done", "b", "", "c"], "Done")` is `{ heading: 3, end: 7 }` — the non-fenced rule still works, so the fence branch is a special case, not a rewrite.
- a section that runs to EOF: `sectionSpan(["## Done", "x", "y"], "Done")` is `{ heading: 0, end: 3 }` — `nextSectionHeading` returns `lines.length` when no later `## ` heading follows.
- a missing section: `sectionSpan(["## Open", "", "## Done"], "Missing")` is `null`.

Each expectation is read from `fencedHeadingTitle` (a `## ` line inside a fence returns `null`, so it is neither a heading nor a boundary) and `nextSectionHeading` (returns the next real `## ` index, or `lines.length`), not from a call to `sectionSpan`; the quoted-in-a-fence cases are the fence contract the pin asserts.

**Files touched.** `test/backlog.test.ts` only — add `sectionSpan` to the existing `backlog-md.js` import and add the one test block. No `src/` file changes; no `docs/invariants.md` edit (no section-boundary section binds `sectionSpan`).

**Acceptance criteria.**
- The new test in `test/backlog.test.ts` passes on the current tree.
- A regression that read the `## ` heading or the section end boundary WITHOUT the fence guard fails the new test on the quoted-`## Done`-inside-a-fence cases (`{ heading: 0, end: 7 }` and the `null` case).
- The plain-section and EOF cases pin that the fence branch is a special case: an unfenced `## Done` still resolves to `{ heading: 3, end: 7 }` and a section with no following heading ends at `lines.length`.
- The pin does NOT add a duplicate of the two sibling readers' existing coverage: it tests `sectionSpan` only (not `fenceAwareHeadingLines` or `sectionBodyLines`, whose fence branches their consumers' tests already exercise).
- No `src/` file, `docs/invariants.md` line, or other test file changes — the change is confined to `test/backlog.test.ts`.
