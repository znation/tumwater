# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Plain terms code cleanup, part 7/7: Make the vocabulary guard cover all of src and drop the opt-in headers (planned 2026-10-16 by user; requires part 6/7 landed; design in plans/terminology.md "Guards"; touches test/vocabulary.test.ts + every src/ module carrying a vocabulary header)

**Goal.** Mostly mechanical. The vocabulary guard has no opt-in: it always scans every src/ module. The `// vocabulary: plain` header lines are deleted, since they no longer mean anything.

**Approach.**
- test/vocabulary.test.ts: remove the header requirement and any remaining scope logic (`optedIn` goes away), so the target is every `.ts`/`.tsx` module under src/. Replace the groundwork test "with no `// vocabulary: plain` header anywhere in src/, the guard passes" with one that a header-less module is scanned. Keep the word list, the word-bounded case-insensitive match, the string-literal and template-text walk (never `${…}` expressions), the `// vocabulary-ok: <reason>` line exemption, and the shared legacy-reader exemption from part 5/7. Update the file's header comment to say the guard covers all of src/ and that `vocabulary-ok` is the only escape.
- Delete every `// vocabulary: plain` line in src/: `grep -rln '^// vocabulary: plain' src` lists them, one line per module, up to about 300. Change nothing else in those files.
- Features keep landing while this series runs, so run the guard and fix any hit introduced since part 6/7 the same way: reword, or mark `vocabulary-ok` with a reason.
- docs/glossary.md and DEVELOPMENT.md may describe the opt-in header. Update their sentence on how the guard is scoped, and nothing else in them.

**Files touched.** test/vocabulary.test.ts; every src/ module with a `// vocabulary: plain` header (one deleted line each); any module with a newly introduced hit; the guard sentence in docs/glossary.md and DEVELOPMENT.md if they describe the header.

**Acceptance criteria.**
- `grep -rn 'vocabulary: plain' src test` prints nothing, apart from a negative-case fixture inside test/vocabulary.test.ts if it keeps one.
- Adding `say("the fleet is idle")` to any src/ module without a `vocabulary-ok` marker makes the guard fail (check locally, do not commit).
- The guard's own tests pin the new scope: a module without any header is scanned.
- `npm run test` passes.

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

### docs/invariants.md gains an orchestrator-info section, and one new test file pins that a publish writes once for a changed batch, never for an unchanged one, and warns rather than throws when the file cannot be written (planned 2026-10-20 by the plan role; independent of every eligible plan; touches docs/invariants.md + a new test/orchestrator-info-publish.test.ts)

**Goal.** `publishInfoFields` (src/team/orchestrator-info.ts) is the only way the orchestrator's poll publishes the info file that status, the TUI, the GUI and `tumwater start`'s second-team check read. Its callers are src/orchestrator/orchestrator-poll.ts (permits, check permits, slot pool, build) and src/gates/gate-polls.ts (the budget fields, disk). Before this entry, docs/invariants.md did not name orchestrator-info.ts or any of its functions, and no test imported `publishInfoFields`. test/orchestrator-info.test.ts pins the tolerant reader, the atomic writer and `orchestratorAlive`, but not the publish rules the function's doc comment promises:
- an unchanged batch leaves the file untouched and returns false (the comparison is by JSON serialization, so a fresh but equal object is not a change);
- every field in a batch is staged, with no short-circuit, and a changed batch is one write that holds all of them;
- publishing `undefined` for a present field removes it from the file;
- a write that fails (for example, the path is a directory) does not throw. It logs one `warning` reading "could not publish orchestrator info: …", the in-memory `info` keeps the new value, and the function still returns true. Publishing the same value again returns false and does not retry. The doc comment says the field "is retried the next time its value changes".
The plan role confirmed all four behaviors on 2026-10-20 with a scratch test, then deleted it. The scratch test made the write fail by `fs.mkdirSync` on `orchestratorStatePath(root)`; on darwin the rename failed with EISDIR.

**Approach.**
1. New test/orchestrator-info-publish.test.ts (node:test + `node:assert/strict`). Do not edit test/orchestrator-info.test.ts. Import `publishInfoFields`, `readOrchestratorInfo`, `writeOrchestratorInfo` and the `OrchestratorInfo` type from ../src/team/orchestrator-info.js, `orchestratorStatePath` from ../src/paths.js, `tmpdir` from ./fixtures/repo-fixtures.js and `warningMessages` from ./fixtures/log-fixtures.js. Each test starts from `const info: OrchestratorInfo = { pid: 1, startedAt: 2, roles: ["feature"] }` and calls `writeOrchestratorInfo(root, info)`.
2. Test "publishInfoFields writes every field of a changed batch in one publish". Publish `[["stopsAt", 5], ["slotPool", { leased: 1, limit: 2, waiting: 0 }]]`. Expect a return of true, and expect `readOrchestratorInfo(root)` to deep-equal `{ ...base, stopsAt: 5, slotPool: { leased: 1, limit: 2, waiting: 0 } }`. Then publish `[["stopsAt", 5], ["slotPool", { leased: 2, limit: 2, waiting: 0 }]]`, where only the second field changes, and expect the file to carry `leased: 2`. Mutation: replace the loop with `const changed = fields.some(([field, value]) => assignInfoFieldIfChanged(info, field, value));`. The first batch then stages only `stopsAt`.
3. Test "publishInfoFields leaves the file untouched when no field changed". After the step-2 style publish, `fs.rmSync(orchestratorStatePath(root))`. Then publish the same values again as fresh object literals, plus `["disk", undefined]` for a field that was never present. Expect a return of false, and expect `fs.existsSync(orchestratorStatePath(root))` to be false. Mutations: (a) `if (changed)` → `if (true)` before the write, which recreates the file; (b) in `assignInfoFieldIfChanged`, compare `value === info[field]` instead of the two `JSON.stringify` calls, which makes the fresh `slotPool` object a change.
4. Test "publishInfoFields removes a field published as undefined". Publish `[["slotPool", { leased: 1, limit: 2, waiting: 0 }]]`, then `[["slotPool", undefined]]`. Expect the second call to return true, and expect the read-back file to have no `slotPool` key (`assert.equal("slotPool" in readOrchestratorInfo(root)!, false)`). Mutation: in `assignInfoFieldIfChanged`, add `if (value === undefined) return false;` as its first line.
5. Test "publishInfoFields warns instead of throwing when the info file cannot be written". `fs.rmSync` the file and `fs.mkdirSync(orchestratorStatePath(root))`. Publish `[["stopsAt", 9]]`, wrapped in `assert.doesNotThrow`. Expect a return of true, `info.stopsAt === 9`, and exactly one message in `warningMessages(root)` that starts with "could not publish orchestrator info: ". Publish `[["stopsAt", 9]]` again. Expect false, with still exactly one such warning. Mutation: add `throw err;` after the `warnEventBestEffort(...)` call in `writeOrchestratorInfoBestEffort`. This type-checks and keeps every import used.
   Run the new file once. Before writing VERIFIED, apply each mutation by hand, check that it fails its new test, and check that the test passes again once you revert it. Also run test/orchestrator-info.test.ts and test/gate-polls.test.ts under each mutation, and drop any claim that only the new tests catch a mutation that one of them also catches.
6. docs/invariants.md: append "## Orchestrator info: a publish writes once for a changed batch and never for an unchanged one, a failed write warns rather than throws, and a reader drops a wrong-shaped field" at the end, after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BK had merged, BL, BM and BN were planned, and BO was free. Follow the existing Guarantee / Binds / Pinned by layout:
   - 1: A publish stages every field, compares each by JSON serialization, writes once when any changed and not at all otherwise, and a field published as `undefined` leaves the file. Binds `publishInfoFields` and `assignInfoFieldIfChanged`. Pinned by the step 2–4 tests.
   - 2: A publish never throws: a failed write logs one `warning`, keeps the new value in memory, and is not retried until the value changes again. Startup's `writeOrchestratorInfo` stays strict and atomic. Binds `publishInfoFields`, `writeOrchestratorInfoBestEffort`, `writeOrchestratorInfo`. Pinned by the step-5 test plus "writeOrchestratorInfo leaves the previous file intact when a write is killed mid-flight" (test/orchestrator-info.test.ts).
   - 3: `readOrchestratorInfo` returns null for a missing, torn or non-object file, and drops each nested field whose shape is foreign while it keeps well-formed ones; `orchestratorAlive` is false with no info. Binds `readOrchestratorInfo`, `normalizeInfoFields`, `orchestratorAlive`. Pinned by "readOrchestratorInfo returns null for missing, torn, and non-object files", "readOrchestratorInfo drops nested fields with a foreign shape and keeps well-formed ones", "readOrchestratorInfo round-trips a well-formed providerHolds and drops foreign entries" and "orchestratorAlive is false with no info and reflects pid liveness otherwise" (test/orchestrator-info.test.ts), and "pollTeamGates publishes the measured disk state for observers" (test/gate-polls.test.ts).
   Cite each test by its full name.

**Files touched.** test/orchestrator-info-publish.test.ts (new); docs/invariants.md. No src/ change.

**Acceptance criteria.**
- `npm run test:gate` passes, and the new tests pass.
- Each mutation named in steps 2–5 fails its new test when applied by hand, and the test passes again once it is reverted. Report this in VERIFIED.
- Every test name cited in the new section exists verbatim (`grep -rF` each one in test/).
- `git diff -- src/` is empty.

## Done
