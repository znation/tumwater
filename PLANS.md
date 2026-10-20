# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-20 by feature: too large for one run** — the src change (routeModel, seamKeyedFallbackProvider, validation, alias row, BudgetSlice) is small, but a trial run left ~155 failing tests in ~25 files beyond the six listed: doctor, gate-polls, budget-gates, status-budget, role-view, pi-models, claude-run and others still spell raw configs with `agent: "claude"`, bare `claude-…` models under pi, `claude/<id>` fallbacks and resolved pairs. Part 4/5's fixture migration did not reach them; they need their own part (suggest 4b/5) before this one.

**User decision 2026-10-20 (recorded by the director role): merge this without waiting for the operator to migrate tumwater.json first. The break when the live config reloads is accepted; the operator fixes it after the merge. The migration is: `model` drops the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }`. Each load error must name that exact edit, because the operator works from those messages.**

**Goal.** A model id never names a backend: each retired spelling fails the load with a message naming the exact edit (the operator chose no shims), and the fleet-wide scalar `BudgetSlice.backend` goes. Series goal and siblings: part 1/5.

**Approach.**
- `routeModel` (src/config/model-selector.ts) loses rule 1 (`isAgentId(provider)`) and rule 3a (`startsWith("claude-")`): the backend is the explicit backend ?? the top-level `backend` ?? `"pi"`, and claude/opencode take the id verbatim on both paths. `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) follows the same rule; a fallback step with no `backend` inherits its tier primary's resolved backend (the tier entry's, else the top level's). `seamAgent` keeps its `agent` read; its `isAgentId(seam.provider)` branch goes once no resolved seam carries a namespace provider. `AGENT_IDS`' doc comment drops "doubles as the selector provider namespace".
- `validateConfig`'s raw pass rejects, each naming the value and the fix: a selector whose first segment is a backend id (`claude/claude-opus-5-5` → write `backend: "claude"` beside `model: "claude-opus-5-5"`); a bare `claude-…` id resolved to pi (add `backend: "claude"`, or write `anthropic/claude-…` to keep it on pi); `opencode/…` resolved to pi (write `backend: "opencode"`). Drop the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) so a top-level `agent` key is an unknown-key error naming `backend`; `agents → backends` stays.
- Delete `BudgetSlice.backend` (src/status/status-budget.ts, its interface field and `backend: cfg.backend ?? "pi"`); src/ui/badges.ts's `agentDefault` uses the constant `pi default`, and the test/badges.test.ts case passing `backend: "claude"` drops that field and asserts the new label.
- docs/config.md, docs/backends.md and docs/glossary.md drop part 3/5's "still load until part 5/5" sentences and the `agent → backend` rename rows; test/config-aliases.test.ts asserts the `agent` error.

**Acceptance criteria.**
- `grep -rn 'isAgentId(provider)\|startsWith("claude-")' src` finds nothing; each retired spelling (`claude/<id>`, `opencode/<id>` under pi, bare `claude-…` under pi, top-level `agent`) fails `validateConfig` with a message naming the offending value and the edit.
- The migrated form of the team's config in the note above, loaded in a test, resolves `seamsInUse` to claude for every primary seam and `qwenrunner/qwen3.8-27b` on pi for the fallback.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults and `CLAUDE_GATED_MODELS` still lists exactly those three.
- `BudgetSlice` has no `backend` field; `npm test` passes.

### The pre-queue self-check flags a comment that still places a moved function in its old file ("`entryKey` in backlog-eligibility.ts") (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/run/stage-path-checks.ts + test/stage-check.test.ts + src/ui/gui/gui-client-report.ts)

**Goal.** An organize change on 2026-10-20 was rejected because "`src/runner/runner-state.ts:295` still says `entryKey` is in "backlog-eligibility.ts"" after `entryKey` had moved to src/backlog/backlog-parts.ts. Every existing staging check misses this shape. `staleNameFindings` (d) skips a name the change re-declares elsewhere. `movedSourceFindings` (f) greps only the old file's full repo path and needs 10 moved lines, and its plan left basename-only references out of scope ("a basename-only reference is not reported") because they are too noisy at the file level. Keying on the moved *name* fixes that noise. A comment that puts the moved name next to its old file, by full path or basename, is almost always stale. Measured 2026-10-20 with a scratch node script that ran this rule over every first-parent main commit in the last 30 days. The rule: a compound name declared on a removed line of file A and on an added line of another file; A no longer contains the word; a non-record-prose line elsewhere has the name within 40 characters of A's path or basename, with no `,` or `;` between them. It flagged 18 lines. 17 placed the moved name in its old file (for example "pauseFleet in src/state.ts", "buildReviewPrompt (prompt.ts)", "Keep in sync with TumwaterConfig/BackoffConfig/RoleConfig in types.ts"). One was a history note ("(…rejectEqualsForm). Split from cli-args.ts"). Without the `,`/`;` rule, it also flagged a docs/invariants.md **Binds.** list that names one file's symbols beside the next file's path. One hit from that window is still stale on main: src/ui/gui/gui-client-report.ts says "(src/ui/tui/tui-keys.ts scopeCycle)", but `scopeCycle` lives in src/ui/tui/tui-pane-session.ts. `grep -n -iE 'moved name|moved function|moved symbol|moved declaration' PLANS-DONE.md` printed nothing when planned. This plan claims no invariant ID: INV-BK1 already covers the caps it reuses.

**Approach.** In src/run/stage-path-checks.ts:
1. Extract the loop of `hasStandalonePathOccurrence` into `standalonePathIndexes(line: string, needle: string): number[]`, which returns every index the existing test accepts. `hasStandalonePathOccurrence` becomes `standalonePathIndexes(line, needle).length > 0`, so behaviour does not change.
2. Add `const MOVED_NAME_GAP_MAX = 40;` (doc comment: the most characters between a moved name and its old file's name for a line to count as placing it there).
3. Add `async function movedNameFindings(wt: string, diff: string): Promise<string[]>`, labelled "(g)" in its doc comment, after `movedSourceFindings`:
   - Walk the `-U0` diff as `staleNameFindings` does: JS_FILE headers only, with `declaredNames` filtered by `isCompoundName`. Keep two maps, `removedIn` and `addedIn` (name → set of files).
   - A move is (name, from, to[]): `from` is a file in `removedIn[name]`, `addedIn[name]` holds at least one file other than `from`, and it does not hold `from` itself. Take at most MAX_STALE_NAMES distinct names. Return [] when there are none.
   - Run one `gitTry(wt, "grep", "-n", "-w", "-I", "--cached", ...names.flatMap((n) => ["-e", n]))`, and parse `file:line:text` as `staleNameFindings` does.
   - Skip a move when any grep line from `from` itself contains the name as a word. Then the old file still names it (a re-export, alias or import), so a reference there is not stale.
   - A hit is a grep line whose file is not `from` and not record prose (`isRecordProse`), and whose text, after every occurrence of `from` is replaced with `path.basename(from)`, has a word occurrence of the name (the `(?<![\w$])…(?![\w$])` regex `staleNameFindings` uses) and a `standalonePathIndexes` occurrence of the basename. The text between the two must be at most MOVED_NAME_GAP_MAX characters, with no `,` or `;`. Keep at most MAX_STALE_HITS hits.
   - Each move with hits pushes `` `${name}` moved from ${from} to ${cappedList(to, MAX_STALE_PATHS)}, but ${hits.join(", ")} still place it in ${path.basename(from)} — point each at its new file ``. Stop after MAX_STALE_PATHS findings.
4. In `gitLevelFindings`, push `...(await movedNameFindings(wt, diff))` after `movedSourceFindings`. In the module's header comment, add "a moved name that a comment still places in its old file" to the list of findings. A line that names the old file's full path can also get the (f) finding. Both tell the author to re-point it, so this plan does not dedupe them.
5. src/ui/gui/gui-client-report.ts: change "(src/ui/tui/tui-keys.ts scopeCycle)" to "(src/ui/tui/tui-pane-session.ts scopeCycle)".

**Files.** src/run/stage-path-checks.ts, test/stage-check.test.ts, src/ui/gui/gui-client-report.ts. The doubled-word check now on main (`DOUBLED_WORD`, `proseOf`, `garbledWordingFindings`) lives in the same two files but in other functions, so this plan only adds code beside it.

**Acceptance criteria.**
- New tests in test/stage-check.test.ts, after "a basename-only reference is not reported", with a helper that keeps findings containing "still place it in":
  - "a comment placing a moved function in its old file yields the moved-name finding". The base has `src/a.ts` = `export function keepHere() {}\nexport function moveMe() {}\n`, `src/c.ts` = `// moveMe (src/a.ts) does it\n` and `docs/x.md` = ``See `moveMe` in a.ts.\n``. The head drops `moveMe` from `src/a.ts` and adds `src/b.ts` = `export function moveMe() {}\n`. Expect exactly one finding, matching ``/`moveMe` moved from src\/a\.ts to src\/b\.ts, but docs\/x\.md:1, src\/c\.ts:1 still place it in a\.ts/``. With both references re-pointed at b.ts, the helper returns [].
  - "a moved name the old file still names, a comma-separated list, and record prose yield no moved-name finding". Make the same move three ways and expect [] each time: (i) the head `src/a.ts` keeps `export { moveMe } from "./b.js";`; (ii) `src/c.ts` = `// keepHere in src/a.ts, moveMe in src/b.ts\n`; (iii) the only reference is PLANS.md = `moveMe lived in src/a.ts\n`.
- "a basename-only reference is not reported", the moved-source tests and every stale-name test pass unchanged.
- `grep -n 'tui-keys.ts scopeCycle' src/ui/gui/gui-client-report.ts` prints nothing.
- `npm run test:gate` passes.

## Done
