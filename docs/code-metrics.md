# Code metrics: Tumwater's code, Claude's code, and human-written open source

**Effective date: 2026-09-30.** Every number describes the repositories at the commits below.
Tumwater lands dozens of commits a day, so re-derive the numbers before relying on them later:
[docs/code-metrics/](code-metrics/) holds the scripts that produced them, and
[Method](#method) says how to run them. A human-directed Claude Code session did this analysis.

| Repository | As of | Commit date |
|---|---|---|
| tumwater (this repository) | main `48213ce723fc1761feae8601c8f00916451fcbb1` | 2026-09-30 |
| [TypeStrong/typedoc](https://github.com/TypeStrong/typedoc) | v0.22.16 `a4945d39ca6694f209651381f9aad16efb1661cf` | 2022-05-30 |
| [graphql/graphql-js](https://github.com/graphql/graphql-js) | v16.5.0 `1f8ba95c662118452bd969c6b26ba4e9050c55da` | 2022-05-09 |
| [TypeStrong/ts-node](https://github.com/TypeStrong/ts-node) | v10.8.0 `78d103ffe7e899471081f5a88ac4bd61e9a42184` | 2022-05-21 |
| [socketio/socket.io](https://github.com/socketio/socket.io) | 4.5.1 `5ab8289c0acd33d7230541f4fe3be5ccca21a556` | 2022-05-17 |
| [raineorshine/npm-check-updates](https://github.com/raineorshine/npm-check-updates) | v13.0.3 `1ba4a72ae7ba1ac663423813bd08391f09d8f471` | 2022-05-21 |
| [yargs/yargs](https://github.com/yargs/yargs) | v17.5.1 `02515116f818fe93ce035139c16bf2953b4de43a` | 2022-05-15 |
| [nestjs/nest](https://github.com/nestjs/nest) | v8.4.6 `9407ec90b38fad7e1c60add438d0dbbccfe6dc7c` | 2022-05-31 |

The report compares three bodies of code:

- **Tumwater**: code Tumwater wrote itself, as commits from its role loops.
- **Claude**: code written in human-directed Claude Code sessions.
- **The OSS baseline**: the seven human-written TypeScript projects above. Each is pinned to its
  last release before June 2022, so it predates AI coding assistants. They are popular,
  well-maintained projects, which is a higher bar than a typical GitHub repository.

The same scripts, with the same definitions, measured all three.

## Summary

1. **Almost none of tumwater was typed by a person.** Of 2,147 non-merge commits, Tumwater made
   2,000, Claude Code sessions 142, and hands 5 (one-line `tumwater.json` edits, none of which
   survive). Tumwater wrote 67% of the surviving production code and 80% of the tests.
2. **Code hygiene is far better than the OSS baseline.** Neither author uses `any` or lint/type
   suppressions, and neither leaves TODO comments. Duplication in production code is near zero,
   against a 2.5% OSS median. Tumwater uses half the OSS median rate of `as` casts, and Claude a
   sixteenth.
3. **Complexity is at or above the top of the OSS range.** Tumwater's production code has 212
   branch points per 1,000 lines, against an OSS median of 113 (range 76–200). 5.3% of its
   functions exceed McCabe complexity 10 (OSS median 2.2%), and its worst function scores 78
   (OSS worst 53). Claude's core code is as branchy per line (203). Its functions are smaller and
   simpler, but still above the OSS median.
4. **Comments are twice the OSS density in production code and about ten times it in tests,**
   for both authors: 42% (Tumwater) and 39% (Claude) of core production lines, against 19.5%.
5. **Testing is at the level of the strictest baselines.** There are 2.4 test lines per
   production line. Node's coverage table reports 99.65% of lines, 96.3% of branches and 97.8% of
   functions, reached without a single coverage-ignore comment. graphql-js, the one baseline that
   enforces 100%, uses 67. Node sometimes reads higher (99.90 / 96.7%), but that reading counts
   code no process executed. Split by author, coverage is identical in every passing run.
6. **Both authors commit in bigger pieces than human teams do.** The median commit changes 46
   lines for Tumwater and 100 for Claude, against 20.5 for the OSS baseline. Commit titles run
   about twice as long.
7. **The standout numbers match what a loop optimizes.** The coverage loop's target is coverage,
   the dry loop's is duplication, and the organize loop's is file size (no file tops 500 lines).
   Nothing optimizes function complexity, and the most complex functions are ones both authors
   grew together.
8. **At human rates this is years of work, and it took 41 days.** Line-count models put the
   19,094 production lines at 4.4 staff-years (basic COCOMO) to 7.3 (McConnell's rates), and at
   16–25 staff-years with tests. The repository gained 1,590 surviving code lines a day, against
   4–80 per developer day on human projects of this size.

## What is in the repository

| Category | Files | Lines | Code | Comment | Blank | Comment share |
|---|---|---|---|---|---|---|
| Production, `src/` outside `ui/` | 126 | 25,174 | 13,942 | 9,814 | 1,418 | 41.3% |
| Production, `src/ui/` | 36 | 7,033 | 5,152 | 1,652 | 229 | 24.3% |
| Test specs (`test/*.test.ts`) | 205 | 57,688 | 44,282 | 8,446 | 4,960 | 16.0% |
| Test support (helpers, fixtures) | 24 | 3,030 | 1,913 | 880 | 237 | 31.5% |
| Scripts (`scripts/`, `eslint.config.js`) | 7 | 361 | 246 | 90 | 25 | 26.8% |
| CI (`.github/`) | 2 | 65 | | | | |
| Config and lockfile | 7 | 1,441 | | | | |

Comment share is comment lines divided by comment plus code lines.

- **Production : test : script code lines** are 19,094 : 46,195 : 246, a ratio of 1 : 2.42 : 0.01.
- **Markdown:** 114k words across 25 files. 93% of the words are backlog and planning:
  BUGS.md 49k, `plans/` 45k, PLANS.md 13k, and QUESTIONS.md. User-facing prose is 7.7k words:
  README, DEVELOPMENT.md, PRINCIPLES.md, LICENSE and `docs/`.
- **Dependencies:** no runtime dependencies, only Node built-ins; four dev dependencies.
- **Tests:** the unit tier runs 2,427 tests. The e2e tier is separate and isn't counted here.
- **Imports:** 162 modules with 785 import edges and no runtime import cycles (three cycles are
  type-only). The most-imported module is `src/text.ts`, with 52 importers.
- **Functions in `src/`:** 1,456, with mean McCabe complexity 3.50, median 2, 90th percentile 7,
  and 76 functions (5.2%) above 10.
- **Most complex functions:**
  - `runOrchestrator`: complexity 78, cognitive complexity 157, 307 lines ([src/orchestrator.ts](../src/orchestrator.ts)).
  - `eventMessage`: 72, mostly one flat switch ([src/event-format.ts](../src/event-format.ts)).
  - The TUI key handler: 60 ([src/ui/tui-keys.ts](../src/ui/tui-keys.ts)).
  - `main`: 57 ([src/cli.ts](../src/cli.ts)).
  - `reviewAheadOfMain`: 50 ([src/review.ts](../src/review.ts)).
- **File sizes:** median 94 code lines, largest 474 (`src/ui/gui-styles.ts`), none over 500.

ESLint's own `complexity` rule, run over `src/` as a cross-check, agrees closely: 1,517 functions
(it also counts class field initializers), mean 3.58, median 2, 90th percentile 7, max 79, 5.5%
above 10.

## Who wrote it

Each surviving line is credited to the commit that last wrote it (`git blame -w -M -C`, so moved
code keeps its original author). Commits are classified by author and trailer. The trailer
decides, not the title: 66 Claude Code commits carry `tumwater(role):` or `automaton:` titles,
including `automaton: initial harness`.

- **Tumwater**: authored by `tumwater` or `automaton`, the harness's commit identity. Also, a
  commit under the repository owner's identity that has a `tumwater(role)` title and no Claude
  trailer. That happens when a loop agent runs `git commit` itself; `cadb5a35` is the only one.
- **Claude**: any other commit with a `Co-Authored-By: Claude …` trailer.
- **Human**: the rest, which is 5 one-line `tumwater.json` edits.

| | Tumwater | Claude |
|---|---|---|
| Commits (non-merge) | 2,000 | 142 |
| `src/` code lines | 12,728 (67%) | 6,366 (33%) |
|  of which `src/` outside `ui/` | 10,280 (74%) | 3,662 (26%) |
|  of which `src/ui/` | 2,448 (47%) | 2,704 (53%) |
| Test code lines | 37,064 (80%) | 9,131 (20%) |
| Test cases (`test()` calls, by majority author) | 2,088 | 398 |
| Backlog and planning words | 84.5k (79%) | 22.1k (21%) |
| User-facing doc words | 1.9k (24%) | 6.0k (76%) |
| `src/` files with ≥ 80% of lines by this author | 84 | 19 |

- **Mixed files:** the other 59 `src/` files have no author with 80% of their lines.
- **Claude's code by model** (`src/` code lines): Opus 5.5 4,525, Fable 5 1,101, Fable 5.1 586,
  Opus 5 154.
- **Much of Opus 5.5's share is one commit:** `6fe3cfbe`, the 2026-09-29 dashboard redesign,
  owns 2,868 surviving `src/` lines. They include the 474 lines of CSS in `gui-styles.ts`, which
  is why Claude's `src/ui/` code has so few branches and comments.
- **Tumwater's code by era:** 31% of its surviving `src/` lines predate the 2026-09-18 switch from
  local to hosted models; the other 69% came after.

## Code quality compared

The table covers production code. The OSS column gives the median, then the min–max across the
seven baselines. "Core" means `src/` without `src/ui/`, the like-for-like comparison, because
Claude's share of `src/ui/` is largely CSS and small render helpers.

| Measure | Tumwater | Claude | OSS median (range) |
|---|---|---|---|
| Branch points per 1,000 code lines | 212 | 150 (core 203) | 113 (76–200) |
|  of which `if` | 90 (core 88) | 63 (core 87) | 53 (32–76) |
|  of which `?:` | 32 | 28 (core 30) | 8.9 (6.2–58.6) |
|  of which `??` | 20 | 15 (core 21) | 1.2 (0–9.5) |
| Mean McCabe complexity per function | 3.66 | 3.07 | 2.50 (1.75–3.05) |
| Median McCabe complexity | 2 | 1 | 1 (1–2) |
| Functions above complexity 10 | 5.3% | 4.9% | 2.2% (0–5.6%) |
| Functions above complexity 20, per 1,000 lines | 1.49 | 0.79 | 0.40 (0–0.89) |
| Worst function's complexity | 78 | 72 | 35 (10–53) |
| Mean cognitive complexity | 3.31 | 2.39 | 1.94 (0.83–2.65) |
| Median / 90th-percentile function length (lines) | 5 / 24 | 4 / 19 | 6 / 28 (4–7 / 18–48) |
| Mean nesting depth | 0.69 | 0.50 | 0.50 (0.28–0.64) |
| Mean maintainability index (0–100) | 67.1 | 70.0 | 66.4 (65.5–69.8) |
| Comment share, production | 41.0% | 29.0% (core 38.6%) | 19.5% (7.3–36.6%) |
| Comment share, tests | 17.3% | 14.5% | 1.5% (0.8–22.6%) |
| `as` casts per 1,000 lines | 6.0 | 0.8 | 12.8 (2.1–22.1) |
| `!` non-null assertions per 1,000 lines | 2.9 | 2.0 | 4.6 (0–12.0) |
| `any` per 1,000 lines | 0 | 0 | 11.2 (4.5–78.9) |
| TODO/FIXME per 1,000 lines | 0 | 0.2 (a role-prompt string, not a marker) | 1.0 (0.2–3.5) |
| Lint/type suppressions per 1,000 lines | 0 (whole repo) | | 1.0 (0.2–7.8) |
| Duplicated lines, production | 0.1% | 0.0% | 2.5% (0.4–9.4%) |
| Duplicated lines, tests | 7.3% | 5.4% | 12.9% (4.6–36.8%) |

- **The extra complexity is real, not a counting artifact.** The strict compiler setting
  `noUncheckedIndexedAccess` forces `x[i] ?? fallback` patterns, and each `??` counts as a branch.
  But `??` explains only about 19 of Tumwater's 99 extra branch points per 1,000 lines over the OSS
  median. The rest is spread across ordinary constructs: `if` +37, `?:` +23, loops +8, `&&` +8,
  `case` +5 and `catch` +4. Both authors write about 88 `if` statements per 1,000 core lines,
  above every baseline (yargs is highest at 76).
- **Domain matters.** Command-line tools branch more than libraries.
  - Tumwater's closest peer, npm-check-updates, has 200 branch points per 1,000 lines.
  - ts-node has 125 and yargs 140.
  - The frameworks nest and socket.io have 76 and 84.
- **Per function, Claude sits between Tumwater and OSS.** In core code, a function written ≥ 90%
  by one author averages complexity 2.12 with a maximum of 15 for Claude, and 2.85 with a
  maximum of 31 for Tumwater. Claude has 3 core functions above complexity 20; Tumwater has 14.
- **The most complex functions are joint work.** 16 of the 24 functions above complexity 20 have
  no author with 90% of their lines, and the largest are mostly Tumwater's: `runOrchestrator` is
  70% Tumwater, `cli.ts` `main` 78%, `reviewAheadOfMain` 66%, and the TUI key handler 93%. The
  largest Claude-majority function is `eventMessage` (53% Claude), a flat switch.
- **Casts separate the two authors most clearly.** Tumwater uses about four times Claude's rate
  of `as` casts in core production code (5.8 vs 1.4 per 1,000 lines) and twice it in tests (12.4
  vs 5.9).
- **Maintainability index doesn't discriminate.** Every project lands between 65 and 70, so the
  table carries it only for completeness.

## Structure and documentation

These measures cover the whole repository, because files and docs have no single author.

| Measure | tumwater | OSS median (range) |
|---|---|---|
| Median production file size (code lines) | 94 | 44 (16–229) |
| 90th-percentile file size | 214 | 296 (120–665) |
| Largest file | 474 | 978 (307–2,128) |
| Files over 500 lines | 0% | 6.3% (0–14.3%) |
| User-facing doc words per 1,000 production lines | 403 | 1,229 (227–3,436) |

- **Files are mid-sized, with nothing tiny and nothing huge.** The baselines typically have many
  small index files and a few very large ones. The flat distribution is the organize loop's
  signature.
- **User-facing documentation is thin relative to the code,** and Claude wrote 76% of it. None of
  the baselines keeps anything like tumwater's 106k words of in-repository backlog; they use
  issue trackers.

## Testing and coverage

| Measure | Tumwater | Claude | OSS median (range) |
|---|---|---|---|
| Test lines per production line (own tests / own code) | 2.91 | 1.43 | 1.54 (0.33–2.73), whole repository |
| Duplicated test lines | 7.3% | 5.4% | 12.9% (4.6–36.8%) |
| Median test body (lines) | 13 | 15.5 | not measured |

Across the whole tumwater repository there are 2.42 test lines per production line.

**Coverage of tumwater** comes from the unit tier (`npm run test:coverage`, 2,427 tests) on
`48213ce7`'s code. It was run ten times in a row with `run.sh --coverage=10` on 2026-09-30.
Two more runs kept their raw dumps for the check below. Since 2026-09-30 the test runner also
prints a deterministic per-dist-file table after node's, merged from the run's raw V8 dumps with
any-process semantics (the merge `coverage.cjs` uses, which was identical across all 11 runs);
when the caller brings no `NODE_V8_COVERAGE` of its own, the runner captures the dumps in its
scratch dir and removes them with it, so a plain `npm run test:coverage` costs the dump writes
and nothing else is kept. That reading is stable where node's flips (back-to-back runs agree on every file's counts); a
±1-line wobble remains from timing-dependent test paths, which no merge can remove. (The table's
first hours mis-merged the line queries around blank lines, crediting some covered lines to their
neighbors and dropping others — fixed 2026-09-30, so per-file line figures quoted from runs before
that fix are artificially low.)

- **Two of the ten runs failed because the Mac slept mid-run.** The lid closed at 06:45, and the
  power log (`pmset -g log`) shows sleeps of 579 s, 904 s and 918 s after that. Every failing test
  ran for almost exactly one of those lengths: five tests at 577–581 s in run 9, and eight at
  902–918 s in run 10. Frozen through the sleep, they woke with their wall-clock deadlines already
  expired. Failed runs exercise different paths, so they're excluded from the averages.
  - One of run 10's failures was a `tumwater run` test. It then leaked its orchestrator, which
    held the test file open until the leaked process was killed. That's the `spawnCli().kill()`
    bug in BUGS.md.
- **Per-author coverage doesn't vary between runs.** Across the 8 passing runs, every executable
  line was covered in all of them or in none (zero lines flip), and no per-author percentage moves
  by more than 0.01 points. Merged across all ~770 processes of each run and mapped to TypeScript
  lines through source maps (see [Method](#method)):

  | | Tumwater | Claude |
  |---|---|---|
  | Executable code lines covered | 99.22% | 99.47% |
  | Branches covered | 95.57% | 95.11% |
  | Functions covered | 97.99% | 97.39% |
  | Core only: lines / branches / functions | 99.07 / 95.34 / 98.00% | 99.44 / 95.49 / 96.99% |
  | `src/ui/` only: lines / branches / functions | 99.95 / 96.53 / 97.96% | 99.57 / 93.79 / 98.88% |

- **Node's own table does vary, and its higher reading is wrong.** It alternates between two
  readings; functions stay at 97.82% in both.
  - **Low:** 99.65% lines and 96.28–96.29% branches, in 3 of the 8 passing runs.
  - **High:** 99.90% lines and 96.70–96.72% branches, in the other 5.
  - **The difference is `orchestrator.js`:** 87.2% of its lines and 32.3% of its branches in the
    low reading, 98.7% and 62.5% in the high one.
  - **The raw dumps show the high reading counts code that never ran.** I kept the dumps for one
    run of each kind. In neither run did any process execute the lines the low reading lists as
    uncovered (for example JS lines 190–194 and 240–252). The high reading counts them as covered
    anyway, which points to the way node merges ~770 per-process dumps. The low reading matches the
    raw data.
- **Node's line figure also counts comment and blank lines inside code that ran.** Even its low
  reading therefore sits above the 99.38% of executable lines that the merge above finds.
  Branches are the more meaningful figure: 95.45% by that merge against node's 96.29%, because
  the two merge processes differently. Function coverage matches node exactly.
- **`orchestrator.ts` is the largest gap for both authors,** in every run: 61 of Tumwater's 84
  uncovered code lines and 13 of Claude's 20. The unit tier doesn't reach those paths. The
  live-orchestrator e2e tier, which isn't measured here, runs them.
- **Claude's weakest code is the new dashboard code.** `status-render.ts` and `fleet-alerts.ts`
  account for most of its missed `src/ui/` branches; they landed the day before.
- **The weakest files overall are the entry points.** In node's low reading:
  - `cli.js` has 53% branch coverage.
  - `orchestrator.js` has 32% branch coverage and 58% function coverage.
  - `cli-run.js` has 74% branch coverage.
- **No coverage-ignore comments exist in tumwater's `src/`.**

**Coverage of the baselines** wasn't measured, because that would mean installing and running
their code. What they declare at the pinned commits:

- **graphql-js enforces 100%** of lines, branches, functions and statements (`.c8rc.json`), with
  67 `c8 ignore` comments in `src/`.
- **yargs enforces 100% of lines and statements and 96% of branches** (`.nycrc`), with 1 ignore
  comment.
- **typedoc, ts-node, socket.io, npm-check-updates and nest measure coverage but don't enforce a
  threshold.**

For a wider reference point:

- The median mature Java open-source project sits at 63% coverage ([arXiv 2306.09665](https://arxiv.org/pdf/2306.09665)).
- Google's median project sits at 78% ([Ivanković et al., 2019](https://research.google/pubs/pub48413/)).
- [Codecov's 2021 report](https://about.codecov.io/resource/2021-state-of-open-source-code-coverage/)
  says most repositories on Codecov reach 80%, but those are repositories that already track
  coverage.

## How the code gets written

Tumwater's rows cover its whole history (2026-08-20 03:29 → 2026-09-30 04:59 PDT, 41.1 days). Each
baseline's row covers the two years before its pinned commit, bots excluded, for teams with a
median of 40 contributors.

| Measure | Tumwater | Claude | OSS median (range) |
|---|---|---|---|
| Commits per active day | 50.0 | 6.2 | 2.3 (1.6–3.9), whole team |
| Median lines changed per commit | 46.5 | 100 | 20.5 (8–33) |
| 90th-percentile lines changed per commit | 265 | 599 | 265 (112–495) |
| Median files per commit | 2 | 3.5 | 2 (1–3) |
| Commits touching production code that also touch tests | 61% | 99% | 48% (27–74%) |
| Median commit title length (characters) | 90 | 69 | 41 (30–50) |
| Commits titled "Revert…" | 0% | 0% | 0.5% (0–1%) |

- **Cadence:** tumwater's history has 2,147 non-merge commits and 88 merges. The median day has 35
  commits and the busiest had 221. Tumwater commits around the clock: every hour of the day holds
  46–128 of its commits across the period. Claude sessions follow a person's hours, with no
  commits at all at 06:00 or 08:00.
- **Churn:** `src/` saw 60,708 lines added and 28,248 deleted; `test/` 97,612 added and 37,147
  deleted. Tumwater added 46,819 of the `src/` lines and Claude 13,889. Moved code counts as added
  by whoever moved it, so these figures overstate new writing, most of all for Tumwater's
  organize and dry loops.
- **Age:** the median surviving `src/` line is 7.6 days old for Tumwater and 5.6 days for Claude,
  whose share includes the day-old dashboard redesign.
- **Test co-change:** Tumwater's 61% doesn't necessarily mean it tests less. Its coverage loop
  adds tests in separate commits.

## Scale and pace

Two line-count models estimate what the surviving code would take people to write. Tumwater's
history spans 41.1 days (2026-08-20 03:29 → 2026-09-30 04:59 PDT).

| Estimate | Production code (19,094 lines) | Production + tests (65,289 lines) |
|---|---|---|
| Basic COCOMO, organic mode: effort | 53 person-months (4.4 staff-years) | 193 person-months (16.1 staff-years) |
| Basic COCOMO: schedule | 11.3 months with 4.7 people | 18.5 months with 10.5 people |
| McConnell's rates for 100,000-line projects | 7.3 staff-years (range 1.0–19.1) | 25.1 staff-years (range 3.3–65.3) |

| Pace, in surviving code lines | Per calendar day | Per active day |
|---|---|---|
| Tumwater | 1,213 | 1,245 (40 active days) |
| Claude | 377 | 674 (23 active days) |
| The whole repository | 1,590 (production alone: 465) | |
| Human reference: McConnell, 100,000-line projects | | 4–80 per developer working day, 10.4 at the COCOMO average |

- **Keeping up the repository's pace at human rates would take about 223 developers** at
  McConnell's COCOMO average (range 29–580).
- **Surviving lines understate what was written.** 3,856 lines a day were added to `src/` and
  `test/` before deletions (physical lines, comments and blanks included). 41% of all lines ever
  added there have since been deleted.
- **These models were built for human code, and tumwater's isn't typical.** Tests are 71% of its
  code lines and its production code has a 37.5% comment share, so the production-only column
  is the fairer one. COCOMO's organic mode is calibrated on projects of 2–50 thousand lines, and the
  65,000 lines with tests is just past that.
- **The 41 days weren't unattended.** Claude's 142 commits came from human-directed sessions,
  and the person steering them doesn't appear in either model.

## Caveats

- **Seven baselines is a small sample, and all of them are flagship-quality projects.** A typical
  GitHub repository is less tested: one large study puts the median test share at 30% of the code,
  a ratio of about 0.43 ([Miranda et al., 2025](https://onlinelibrary.wiley.com/doi/full/10.1002/smr.70035)).
  The baselines' 19.5% comment density does match the long-run open-source average of about 19%
  ([Arafat & Riehle, 2009](https://dirkriehle.com/2009/02/04/the-comment-density-of-open-source-software-code/)).
- **Authorship means "last wrote the line".** A one-token Tumwater edit to a line Claude wrote
  makes it Tumwater's. Functions go to the author of most of their code lines.
- **This isn't a controlled comparison of models.** Claude sessions were a person steering on
  specific harness problems, while Tumwater's loops include maintenance roles.
- **Tumwater's history is 41 days against the baselines' two years,** and its authors are software.
- **Node's coverage table alternates between two readings,** and the higher one is an artifact
  (see [Testing and coverage](#testing-and-coverage)). Two of ten coverage runs failed because the
  host slept mid-run, and are excluded. The baselines' coverage is declared, not measured.

## Method

Everything above comes from [docs/code-metrics/run.sh](code-metrics/run.sh). To reproduce it:

1. Check out the as-of commit somewhere its `node_modules` resolve, for example a worktree inside
   the primary checkout:

   ```bash
   git worktree add --detach .claude/worktrees/metrics-48213ce7 48213ce7
   ```

2. Run the pipeline against it:

   ```bash
   docs/code-metrics/run.sh .claude/worktrees/metrics-48213ce7 <data-dir> --coverage=10
   ```

   - `--coverage=10` runs the unit suite ten times, one after another, under `NODE_V8_COVERAGE`.
     Each run takes about a minute. The suite refuses to run in a checkout that a live fleet runs
     from.
   - The baselines in [oss-repos.tsv](code-metrics/oss-repos.tsv) are cloned (about 630 MB) and
     pinned by commit.
   - Nothing from the baselines is installed or executed; they are only parsed and read with
     `git log`.

The stages:

| Script | Produces |
|---|---|
| [analyze.cjs](code-metrics/analyze.cjs) with [categories-tumwater.cjs](code-metrics/categories-tumwater.cjs) or [categories-oss.cjs](code-metrics/categories-oss.cjs) | per-file line classes, tokens, markers; per-function metrics; imports |
| [summary.cjs](code-metrics/summary.cjs) | the repository breakdown |
| [eslint-complexity.config.mjs](code-metrics/eslint-complexity.config.mjs) + [eslint-cc.cjs](code-metrics/eslint-cc.cjs) | the ESLint cross-check |
| [blame.py](code-metrics/blame.py) | per-line authorship and commit classes |
| [coverage.cjs](code-metrics/coverage.cjs) | per-TypeScript-line coverage from one run's raw V8 data |
| [coverage-runs.cjs](code-metrics/coverage-runs.cjs) | the per-author coverage split for each run, averaged across runs |
| [authors.cjs](code-metrics/authors.cjs) | the Tumwater / Claude split (`SRC_SCOPE=all\|core\|ui`) |
| [history.py](code-metrics/history.py) | commit-history metrics, tumwater and baselines |
| [scale.cjs](code-metrics/scale.cjs) | the effort estimates and pace |
| [compare.cjs](code-metrics/compare.cjs) | the three-way tables and branch points by kind |

Definitions:

- **Line classes** come from the TypeScript compiler's syntax tree. A line holding any token is
  code; a line holding only comments (JSDoc included) is comment; anything else is blank. This
  matches cloc's convention.
- **Functions** are function declarations and expressions, arrow functions, methods, constructors
  and accessors. A nested function is measured as its own unit. Length is the number of code
  lines in the function's span, nested functions included.
- **McCabe complexity** is 1 plus each `if`, `?:`, `for`/`for…in`/`for…of`/`while`/`do`,
  non-default `case`, `catch`, `&&`, `||`, `??`, `&&=`, `||=` and `??=`. Branch points per 1,000
  lines count the same constructs, credited to the line they start on.
- **Cognitive complexity** approximates SonarSource's rules:
  - `if`, `?:`, `switch`, loops and `catch` add 1 plus their nesting level.
  - Each `else` or `else if` adds 1.
  - Each run of identical logical operators adds 1.
- **Maintainability index** is max(0, (171 − 5.2 ln V − 0.23 CC − 16.2 ln LOC) × 100 / 171), where
  V is the Halstead volume of the function's tokens (Visual Studio's scaling).
- **Duplication** looks for exact 50-token windows (comments and whitespace excluded) that occur at
  least twice and span at least 5 lines. Duplicated lines are the lines those windows cover. These
  are jscpd's defaults.
- **Markers:**
  - `as` casts, excluding `as const`.
  - `!` non-null assertions.
  - The `any` keyword.
  - `TODO`, `FIXME`, `XXX` and `HACK`.
  - Suppressions: `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` and `eslint-disable`.
- **Coverage:**
  - The raw V8 dumps of every process in one suite run are merged. A block counts as covered if,
    in any process, the innermost range containing it has a nonzero count.
  - Lines follow c8's semantics, branches and functions node's.
  - Only runs whose suite passed are averaged.
  - JavaScript positions map to TypeScript lines through source maps compiled separately. That
    output is byte-identical to `dist/` apart from the trailing map comment.
- **Baseline paths:**
  - Production code is TypeScript under each repository's production root (the last column of
    `oss-repos.tsv`).
  - Tests are any JS/TS file under a `test`, `tests`, `__tests__`, `spec`, `integration` or
    `fixtures` directory, or named `*.test.*` or `*.spec.*`.
  - Examples, samples, benchmarks, build scripts, websites, vendored `node_modules` and `.d.ts`
    files are excluded.
- **Scale:**
  - Basic COCOMO in organic mode (Boehm, 1981): effort = 2.4 × KLOC^1.05 person-months, and
    schedule = 2.5 × effort^0.38 months.
  - McConnell's lines per staff-year for 100,000-line projects are 1,000–20,000, with a COCOMO
    average of 2,600 ([as quoted by Coding Horror](https://blog.codinghorror.com/diseconomies-of-scale-and-lines-of-code/)).
    Per-day figures assume 250 working days a year.
  - Both models count surviving code lines, excluding comments and blanks.
- **History:**
  - Non-merge commits only.
  - Lines changed means added plus deleted, lockfiles excluded.
  - Authors matching bot, dependabot, renovate, greenkeeper, github-actions, snyk or
    semantic-release are excluded from the baselines.
  - Active days are counted in PDT.
