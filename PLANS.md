# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-19 by plan: merging this makes the live tumwater.json's `claude/…` model ids a load error, so the operator first migrates it — `model` loses the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }` (valid once parts 1/5-2/5 land) — then removes this note**

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

### Quarantine filing: a test whose bug is already under `## Open` reuses that heading instead of filing a duplicate (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/backlog/backlog-archive.ts + test/main-watch.test.ts + docs/invariants.md)

**Goal.** main-watch's `settleQuarantine` (src/baseline/main-watch.ts) files the pending quarantined tests (`bug === ""`) with `fileQuarantineBugsOnMain` (src/backlog/backlog-archive.ts). That function commits BUGS.md on main, and only then does `settleQuarantine` record the headings with `markQuarantineFiled` (src/review/known-flakes.ts), which ends in a `saveQuarantine` with no try. If that write fails (full disk, read-only `.tumwater/state`), the outer catch warns `quarantine housekeeping failed: …`, but the entries keep `bug === ""`. On the next poll `fileQuarantineBugsOnMain` files them again. `appendBugEntryLocked` (src/backlog/backlog-write.ts) does no duplicate check, so every poll commits another identical `## Open` entry for the same test until the write works. Fix this at the filing step, so a filing that has already landed is never repeated, whatever made the bookkeeping fail.

**Approach.**
1. src/backlog/backlog-archive.ts, `fileQuarantineBugsOnMain`:
   - Add a module-private `function quarantineTitlePrefix(test: string): string` returning ``collapseWhitespace(`\`${test}\` failed, then passed on the same tree`) + " (quarantined by tumwater "``. Build the appended title from it as `` `${quarantineTitlePrefix(test)}${date})` `` so both use one spelling. `appendBugEntryLocked` collapses whitespace in the title, so the prefix has to be collapsed the same way to match what it wrote. Collapse only the test part, because `collapseWhitespace` trims and would drop the trailing space.
   - After `const before = readTextOrNull(file);`, compute `const open = before === null ? [] : parseEntryDetails(before, "Open").map((e) => e.title);`. Import `parseEntryDetails` from ./backlog-md.js, which the module already imports from.
   - In the loop, when `open.find((t) => t.startsWith(quarantineTitlePrefix(test)))` finds a title, `bugs.set(test, title)` and append nothing. Otherwise append as today and keep the test in a local `appended` count.
   - When nothing was appended, return `{ status: "filed", bugs }` before the `git add`/commit, so no empty commit is attempted. Otherwise, name the commit subject's count after the appended tests, not `tests.length`.
   - Extend the doc comment: a test whose quarantine entry is already under `## Open` (a filing whose `markQuarantineFiled` failed after the commit) gets that heading back and is not filed again.
2. Leave `markQuarantineFiled` and `settleQuarantine` unchanged. The existing catch already warns, and the next poll now records the reused heading.

**Files touched.** src/backlog/backlog-archive.ts, test/main-watch.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/main-watch.test.ts, "a filing whose quarantine.json write failed is not filed again on the next poll". Use `baselineFixture("improve", "echo ok")`, then `quarantineTests(root, ["flaky one"], "boom")` and `createMainWatch(root, "main")`. Arm `const restore = failRenameSyncOn(quarantinePath(root), "disk full")` (test/helpers/fs-faults.ts; `quarantinePath` from ../src/paths.js), `await watchAt(watch, root)`, then `restore()`. Assert that `loadQuarantine(root)[0]?.bug` is `""` and that a `warning` event's message contains `quarantine housekeeping failed`. Record `sh(root, "git", "rev-list", "--count", "HEAD")`, then `await watchAt(watch, root)` again. Assert that BUGS.md matches `/failed, then passed on the same tree \(quarantined by tumwater/g` exactly once, that the commit count is unchanged, and that `loadQuarantine(root)[0]?.bug` is that BUGS.md heading's title (non-empty and starting with `` `flaky one` failed ``). Mutation: make the `open.find` lookup always return undefined. The second poll then commits a second entry, so the count check fails with 2.
- The existing main-watch tests pass unchanged, including "a red whose confirming re-run passes quarantines the failing tests and files one BUGS.md entry on main" (three new tests still produce one commit and three entries) and "moving a quarantined test's bug out of ## Open releases it".
- docs/invariants.md: add `## Quarantine filing: a landed filing is never repeated` at the end, with `### INV-CF1: a quarantined test whose entry is already under ## Open is not filed again` (CF was free: `grep -c 'INV-CF' docs/invariants.md PLANS.md` gave 0 for both when this was planned; re-check against the newest letter before writing). Binds `src/backlog/backlog-archive.ts` (`fileQuarantineBugsOnMain`). Pinned by the new test.
- `npm run test:gate` passes. The cited test name exists verbatim (`grep -rF` it in test/).

## Done
