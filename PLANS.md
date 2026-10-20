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

### Agent run setup: a session dir, log file or scratch dir that cannot be created fails the run with a message instead of rejecting runAgent, so its "Never throws" holds and no opened log is leaked (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/agent/run-agent.ts + test/pi.test.ts + docs/invariants.md)

**Goal.** `runAgent` (src/agent/run-agent.ts; `runPi` is its alias in src/pi/pi.ts) is documented "Never throws", and every agent run goes through it: the author run and its retries (`RunnerPi` in src/runner/runner-pi.ts), the review gate, and the merge resolver (`ctx.runPi` in src/merge/merge-to-main.ts). Its Promise executor does several synchronous filesystem steps before the spawn with no `try`: `ensureDir(opts.sessionDir)`, the two `openAppendLog` calls (whose `ensureParentDir` can throw), and `fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-run-"))` for `runTmp`. A throw inside a Promise executor rejects the promise. A plan-role scratch test on 2026-10-20 confirmed it with the fake pi (`withPi`, `runPiFixture` from test/helpers/pi-run-harness.ts):
- `sessionDir` under a regular file: `runPi` rejected with `ENOTDIR: not a directory, mkdir …`.
- `rawLogFile` under a regular file: `runPi` rejected with `EEXIST: file already exists, mkdir …`.

The code also shows (not reproduced) that when the native log's open or `mkdtempSync` throws, the raw log's write stream is already open and nothing ever ends it. A spawn failure, by contrast, already resolves `ok: false` with a "failed to spawn …" message (`child.on("error")` → `finish`), which callers treat as a failed run.

**Approach.** Change only `runAgent` in src/agent/run-agent.ts:
1. Add a module-level `setupFailureResult(message: string): PiRunResult`: `ok: false`, `errorMessage: message`, `finalText: ""`, every required number `0`, and every required boolean `false` (the required fields are the non-optional ones of `PiRunResult` in src/pi/pi-run-result.ts; leave the optional ones unset).
2. In the executor, move `const runTmp = fs.mkdtempSync(...)` up so it runs right after the two `openAppendLog` calls. The order of the other steps stays the same. Declare `rawLog`, `nativeLog` and `runTmp` with `let` before the block, and wrap `ensureDir(opts.sessionDir)`, both `openAppendLog` calls and the `mkdtempSync` in one `try`. In its `catch`:
   - call `.stream.end()` on each log that was opened (`rawLog?.stream.end()`, `nativeLog?.stream.end()`), so no fd is left open;
   - ``resolve(setupFailureResult(`could not prepare the agent run: ${errorMessage(err)}`))`` and `return`. Import `errorMessage` from ../text/text.js.
   Nothing is spawned, so no sweep, watchdog or abort listener is registered on this path.
3. Leave the steps after the block as they are. `recordSession` and the notes-shim install already have their own guards, and the marker write goes to an already-open stream, whose errors `openAppendLog` already absorbs.
4. Update the "Never throws." doc comment on `runAgent` to say that a setup failure (session dir, log, scratch dir) resolves as a failed run with that message.

**Files.** src/agent/run-agent.ts, test/pi.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/pi.test.ts, next to "a broken raw log degrades to a lost log, never a stuck run", titled `an agent run whose session dir or log cannot be created resolves as a failed run instead of rejecting`. Make a `tmpdir()` with a regular file `blocker` in it. Under `withPi` with a script that prints one assistant line, run:
  - `runPi(runPiFixture(dir, { sessionDir: path.join(dir, "blocker", "sessions") }))`
  - `runPi(runPiFixture(dir, { rawLogFile: path.join(dir, "blocker", "raw.jsonl") }))`
  For each, assert that it resolves (does not reject), that `ok === false` and `turns === 0`, and that `errorMessage` matches `/^could not prepare the agent run: .*(ENOTDIR|EEXIST)/`. Before the fix both reject.
- A second test, `an agent run whose scratch dir cannot be created resolves as a failed run`: use `patchFsMethod("mkdtempSync", () => () => { throw errnoError("ENOSPC"); })` (test/helpers/fs-faults.ts; restore it in a `finally`) and assert `ok === false` and an `errorMessage` matching `/could not prepare the agent run: ENOSPC/`. Before the fix it rejects.
- The existing tests in test/pi.test.ts and test/pi-process.test.ts pass unchanged, including "a missing pi binary fails the run with an error".
- docs/invariants.md: at the END of the file, after every section present when the change is made, add `## Agent run setup: a run that cannot be prepared fails, never rejects`. Under it put `### INV-CQ1: a session dir, log file or scratch dir that cannot be created resolves runAgent as a failed run naming the error, and closes any log it opened`, in the Guarantee / Binds / Pinned by layout:
  - Binds: `src/agent/run-agent.ts` (`runAgent`, `setupFailureResult`).
  - Pinned by: the two new test names.
  - The log-closing part has no test of its own, and the invariant must say so.
  - Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail`. CM, CO and CP are claimed by Planned entries, and CQ was free on 2026-10-20.
- `npm run test:gate` passes. The cited test names exist verbatim (`grep -rF` them in test/).

### Main watch: a skipped revert whose heal prompt cannot be queued warns instead of rejecting a fire-and-forget promise and taking the orchestrator down (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/baseline/main-revert.ts + src/orchestrator/orchestrator.ts + test/main-revert.test.ts + docs/invariants.md)

**Goal.** `runOrchestrator`'s main watch (src/orchestrator/orchestrator.ts) hands each named culprit to an inline callback passed to `createMainWatch`. The callback runs `void revertSkipReason(root, mainBranch, culprit).then((skip) => { … else queueCulpritHeal(root, culprit.tip, …) })`. `queueCulpritHeal` (src/baseline/main-red.ts) calls `enqueueRolePrompt` (src/inbox/inbox.ts), which writes through `writeTextAtomic` and throws on ENOSPC/EACCES. The existing test "a conflicting revert whose heal prompt cannot be queued resolves and warns once that it was not queued" (test/main-revert.test.ts) depends on exactly that throw. Here the throw happens inside a `.then` callback whose promise is discarded with `void` and has no `.catch`. Nothing in src/ registers an `unhandledRejection` handler (`grep -rn unhandledRejection src` finds nothing), so under Node's default `--unhandled-rejections=throw` this rejection ends the orchestrator process. A full disk at the moment a director-merged, runnerless or revert commit turns main red would kill the whole team, and the heal prompt would be lost. src/merge/merge-pipeline.ts's `guardMergeTask` doc comment names the same failure mode for merge tasks.

Neither queued plan covers this site. "Main revert: a heal prompt or reviewer hand-off that cannot be queued warns instead of throwing" (PLANS-DONE.md) guarded only `runMainRevert`'s `heal`. "Red-main healer: a heal prompt that cannot be queued warns …" (Planned, in flight) changes only `warnMainRedOnce` and explicitly does not touch `queueCulpritHeal`. `queueCulpritHeal` has two callers (`grep -rn 'queueCulpritHeal(' src`): main-revert.ts's guarded `heal` and this orchestrator callback.

**Approach.**
1. In src/baseline/main-revert.ts, add and export ``async function routeMainCulprit(root: string, mainBranch: string, c: MainCulprit, startRevert: (c: MainCulprit) => void): Promise<void>``, placed directly after `revertSkipReason`. It awaits `revertSkipReason(root, mainBranch, c)`. On null it calls `startRevert(c)`. Otherwise it calls `queueCulpritHeal(root, c.tip, { culprit: c.commit, failingTests: c.failingTests })` inside `try`. Its `catch` calls `warnEventBestEffort(root, TUMWATER_SOURCE, ...)` with the message ``not reverting ${shortSha(c.commit)} (${skip}) and could not queue the heal prompt for bugfix: ${errorMessage(err)}``. Add `warnEventBestEffort` to the existing `../events/events.js` import. `shortSha`, `errorMessage` and `TUMWATER_SOURCE` are already imported. Doc comment: the main watch's culprit hand-off, which starts the automatic revert or falls back to bugfix's heal prompt. It never rejects, because its caller discards the promise and an unhandled rejection would end the orchestrator, so a heal prompt that cannot be queued is warned.
2. In src/orchestrator/orchestrator.ts, replace the callback body with ``void routeMainCulprit(root, mainBranch, culprit, (c) => { merges.revert = c; });``. Import `routeMainCulprit` and drop the `revertSkipReason`/`queueCulpritHeal` imports if nothing else in the file uses them (grep before removing).
3. Do not change `queueCulpritHeal`, `runMainRevert` or `warnMainRedOnce`.

**Files touched.** src/baseline/main-revert.ts, src/orchestrator/orchestrator.ts, test/main-revert.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/main-revert.test.ts, "a skipped culprit whose heal prompt cannot be queued resolves and warns once that it was not queued". Use `redMain(undefined)` (a runnerless culprit, which `revertSkipReason` skips as "no role runner merged it"). Install the same `patchFsMethod("writeFileSync", …)` fault as the existing conflicting-revert test (throw `errnoError("ENOSPC")` for targets under `roleInboxDir(root, "bugfix")`) and restore it in a `finally`. Assert that `await routeMainCulprit(root, "main", found[0]!, startRevert)` resolves, that `startRevert` was never called, that `queuedFiles(root, "bugfix")` is empty, and that `warningMessages(root)` has exactly one entry that includes "no role runner merged it" and matches `/could not queue the heal prompt for bugfix: .*ENOSPC/`. An implementation without the `try` fails this test by rejecting with ENOSPC.
- New test in the same file, "a named culprit starts its revert, and a skipped one queues the heal prompt instead". Without faults, `routeMainCulprit` on `redMain("improve")`'s culprit calls `startRevert` once with that culprit and queues no bugfix prompt. On `redMain(undefined)`'s culprit it does not call `startRevert` and leaves `queuedFiles(root, "bugfix").length === 1`.
- The existing tests in test/main-revert.test.ts pass unchanged.
- docs/invariants.md: at the END of the file, after every section present when the change is made, add `## Main watch: a culprit hand-off never rejects`. Under it put `### INV-CR1: a culprit the main watch names whose revert is skipped and whose heal prompt cannot be queued resolves and warns once that it was not queued`, in the Guarantee / Binds / Pinned by layout. Binds: `src/baseline/main-revert.ts` (`routeMainCulprit`) and its one caller in `src/orchestrator/orchestrator.ts`. Pinned by: both new tests' names. Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail` and read the Planned entries: CM, CO, CP and CQ are claimed, and CR was free on 2026-10-20.
- `npm run test:gate` passes. Both cited test names exist verbatim (`grep -rF` them in test/).

## Done
