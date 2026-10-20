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

### OpenCode catalog seed: the startup seed's failed fetch or failed cache write logs a warning instead of staying silent (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/gates/startup-gate.ts + test/startup-gate.test.ts + docs/invariants.md)

**Goal.** `runStartupCheck` (src/gates/startup-gate.ts) seeds the opencode models catalog once per root per process with `await seedOpencodeCatalog(root, config, opencodeSeed)`, and passes no `warn`. `refreshOpencodeCatalog` (src/agent/opencode/opencode-catalog.ts) reports both of its failures only through `opts.warn?.(…)`: "open code model catalog fetch failed; keeping the cached copy" and "could not save the open code model catalog: …". So when a team boots offline, or cannot write `.tumwater/state/opencode-models.json`, nothing is logged. With no cache, every opencode seam prices as NOT free, so the budget gate counts its runs against the cap as paid spend, and the log never says why. `newOpencodeCatalogRefresh` starts its throttle at construction, so the first warning can come up to `OPENCODE_CATALOG_RETRY_MS` (an hour) later. The plan that added the write warning (PLANS-DONE.md, "Leave startup-gate.ts alone. It passes no `warn` today, and wiring that up is a separate change") left this undone on purpose. This plan wires it up, so the startup seed's failures show up in the event log the way the live-reload and poll seeds' failures already do.

**Approach.**
1. src/gates/startup-gate.ts, `runStartupCheck`: change the seed call to `await seedOpencodeCatalog(root, config, { ...opencodeSeed, warn: (message) => warnEventBestEffort(root, TUMWATER_SOURCE, message) })`. Import `warnEventBestEffort` and `TUMWATER_SOURCE` from ../events/events.js. Use the best-effort form because `runStartupCheck` promises never to throw, and it runs before the team's log necessarily exists. `warnEventBestEffort` falls back to stderr when the events log is unwritable. Keep the `opencodeSeedAttempted` guard as it is, so a process warns at most once, even though the supervisor and redeploy polls re-ask `runStartupCheck`.
2. Same file: update the comments that say startup is silent. In `seedOpencodeCatalog`'s doc comment, replace "`warn` receives the refresh's own warnings (startup passes none)" with wording saying every caller now passes one (startup logs through `warnEventBestEffort`). In the "Seed the opencode models catalog" comment in `runStartupCheck`, add that a failed fetch or cache write logs one warning event.
3. Leave `refreshOpencodeCatalog`, `newOpencodeCatalogRefresh` and src/config/config-live.ts unchanged.

**Files touched.** src/gates/startup-gate.ts, test/startup-gate.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/startup-gate.test.ts, "the startup seed logs a warning when the catalog fetch fails or the cache cannot be saved". Build the fixture like "the startup gate seeds the catalog cache for an opencode boot, fetching on a missing cache": a fake `opencode` adapter via `registerAgentBackend`, then `withPi("exit 0", …)` with tumwater.json set to `backend: "opencode"`, `model: "deepseek-v4.1-flash-free"`, `backends.opencode.bin`. The adapter is registered process-wide and the `opencodeSeedAttempted` guard is per root, so each case needs its own repo from `makeRepo()` + `initProject`. Put the per-repo setup in a local helper inside the test.
  - Case 1, repo A: `runStartupCheck(repoA, null, { fetch: async () => { throw new Error("offline"); }, now: () => 1_000 })`. It returns no `problem`. `warningMessages(repoA)` (import from ./fixtures/log-fixtures.js) contains "open code model catalog fetch failed; keeping the cached copy" exactly once. Calling `runStartupCheck` on repoA a second time adds no second warning, because the guard holds.
  - Case 2, repo B: arm `const restore = failRenameSyncOn(opencodeModelsPath(repoB), "disk full")` (test/helpers/fs-faults.ts), then call `runStartupCheck(repoB, null, { fetch: async () => body, now: () => 1_000 })` with the free-model body the existing seed test uses, and call `restore()` in a `finally`. It returns no `problem`. One warning message starts with "could not save the open code model catalog: " and contains "disk full".
  - Mutation: drop the `warn` from the seed call (back to `opencodeSeed`). Both warning assertions then fail with zero matches.
- The existing tests pass unchanged, including "a registered opencode adapter whose binary exists passes the gate" and "a fresh on-disk catalog cache is reused without fetching (offline boot)".
- docs/invariants.md: at the END of the file, add `## OpenCode catalog seed: startup reports its failures` with `### INV-CG1: the startup seed's failed catalog fetch or cache write logs one warning event per process and never fails the startup check`. Use the Guarantee / Binds / Pinned by layout. CG was free: when this was planned, `grep -c 'INV-CG' docs/invariants.md PLANS.md` gave 0 for both, and the in-flight Quarantine filing plan reserves CF. Re-check against the newest letter before writing. Binds `src/gates/startup-gate.ts` (`runStartupCheck`, `seedOpencodeCatalog`). Pinned by the new test, cited by its full name.
- `npm run test:gate` passes. The cited test name exists verbatim (`grep -rF` it in test/).

### Backlog archive: a bulk archive whose file write fails restores the checkout instead of leaving a half-done move (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/backlog/backlog-archive.ts + test/backlog-archive.test.ts + docs/invariants.md)

**Goal.** `archiveFinishedOnMain` (src/backlog/backlog-archive.ts) runs at team start (`archiveAtTeamStart`) and behind `tumwater archive` (`cmdArchive`, src/backlog/backlog-cli.ts). It holds the merge lock and the primary-worktree lock, then writes each planned move with `writeMove` (archive file first, then the live file, both through `writeTextAtomic`) in a `for` loop that sits *before* the `try` around `git add`/`git commit`. Only a failed commit restores the files (`git reset`, `git checkout -- <tracked>`, removing the archive files it created). If a write throws (ENOSPC, EACCES), say the BUGS.md write after PLANS.md, PLANS-DONE.md and BUGS-FIXED.md were already written, the error escapes with the primary checkout half-moved and uncommitted. `archiveAtTeamStart`'s catch warns, but nothing puts the files back. Each later `archiveFinishedOnMain` then returns `skipped` with "… have uncommitted changes" until someone cleans the checkout by hand. Bring the write under the same restore the commit already has, so a failed bulk archive leaves the checkout as it found it.

**Approach.**
1. src/backlog/backlog-archive.ts, `archiveFinishedOnMain`: move `for (const { spec, move } of plan) writeMove(root, spec, move);` inside the existing `try`, before `git add`. `touched` and `created` are computed before the loop already, so the catch restores every file the loop may have written, and removes every archive file it may have created. Build `subject` before the `try` as today. Change the skip reason from `` `the commit failed: ${errorFirstLine(err)}` `` to `` `the move could not be written or committed: ${errorFirstLine(err)}` ``, because the catch now covers both. `grep -rn 'the commit failed' src test docs` finds only this site and the one in `fileQuarantineBugsOnMain`, and no test matches the string.
2. Extend the function's doc comment: "a failed commit restores the files" becomes "a failed write or commit restores the files".
3. Leave `fileQuarantineBugsOnMain` alone. Its `appendBugEntryLocked` loop has the same gap, but the in-flight "Quarantine filing: … reuses that heading" plan rewrites that loop. Bringing it under its restore is a separate change once that plan merges.

**Files touched.** src/backlog/backlog-archive.ts, test/backlog-archive.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/backlog-archive.test.ts, "archiveFinishedOnMain restores the checkout when a file write fails, and archives on the next call". Seed the same way as "archiveFinishedOnMain commits the bulk move on the base branch, and refuses dirty files": `makeRepo()`, `seedCommit` a PLANS.md with one `## Done` entry and a BUGS.md with one `## Fixed` entry, `ignoreInRepo(root, ".tumwater/")`. Record `sh(root, "git", "rev-list", "--count", "HEAD")`. Arm `const restore = failRenameSyncOn(path.join(root, "BUGS.md"), "disk full")` (import from ./helpers/fs-faults.js), so the failure hits the last of the four writes. Call `await archiveFinishedOnMain(root)` and call `restore()` in a `finally`. Assert:
  - status `skipped`, with a reason matching `/disk full/`;
  - `sh(root, "git", "status", "--porcelain")` is `""`;
  - `PLANS-DONE.md` and `BUGS-FIXED.md` do not exist;
  - PLANS.md still holds its `## Done` entry;
  - the commit count is unchanged.
  Then a second `archiveFinishedOnMain(root)` returns `archived` and leaves `git status --porcelain` empty.
  Mutation: move the `writeMove` loop back out of the `try`. The call then rejects with "disk full" instead of returning `skipped`, so the test fails.
- The existing test/backlog-archive.test.ts tests pass unchanged, including "archiveFinishedOnMain commits the bulk move on the base branch, and refuses dirty files" and "archiveFinishedOnMain drops a hand commit's re-pasted entries instead of archiving them twice".
- docs/invariants.md: at the END of the file, add `## Backlog bulk archive: a failed move leaves the checkout as it was` with `### INV-CH1: a bulk archive whose file write or commit fails restores every file it touched and returns skipped`. Use the Guarantee / Binds / Pinned by layout. CH was free: when this was planned, `grep -c 'INV-CH' docs/invariants.md PLANS.md` gave 0 for both, the newest merged section was CE, and the waiting plans reserve CF and CG. Re-check against the newest letter before writing. Binds `src/backlog/backlog-archive.ts` (`archiveFinishedOnMain`, `writeMove`). Pinned by the new test, cited by its full name.
- `npm run test:gate` passes. The cited test names exist verbatim (`grep -rF` them in test/).

## Done
