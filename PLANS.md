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

### Session ledger: a retention trim that cannot rewrite a ledger leaves it as it was instead of throwing out of the poll loop, and docs/invariants.md gains a session-ledger section (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/agent/session-ledger.ts + docs/invariants.md + a new test/session-ledger-prune.test.ts)

**Goal.** `pruneSessionLedgers` (src/agent/session-ledger.ts) rewrites each ledger that lost a line with `writeTextAtomic`, and nothing catches a failure of that write. Its one caller is `RetentionPruner.prune` (src/orchestrator/retention.ts). That runs from the `RetentionPruner` constructor at startup (src/orchestrator/orchestrator.ts) and from `RetentionPruner.poll` inside the poll loop (src/orchestrator/orchestrator-poll.ts). The loop "and its finally run with no catch" (the `bestEffortEventLogger` comment in src/orchestrator/orchestrator.ts), and `walkFiles`' doc comment in src/files/files.ts says that a throw escaping the retention pass "would end the whole team". So a full disk (ENOSPC on the temp file) or a read-only session dir holding one stale ledger line stops the team, or keeps it from starting. A full disk is the case where retention matters most. On 2026-10-20 the plan role confirmed with a scratch test (since deleted):
- a stale line in a session dir chmodded 0o555 makes `pruneSessionLedgers` throw EACCES;
- with `withThrowingFs("writeFileSync", errnoError("ENOSPC"), …)` (test/helpers/fs-faults.ts) it throws ENOSPC, and the ledger's bytes are unchanged and no temp file is left behind (`writeAtomic` removes it);
- a ledger with nothing past the window is not rewritten: its mtime and inode are unchanged;
- a ledger whose every line ages out stays in place as an empty file; a line whose `at` is not a number (`"x"`) counts as pruned;
- `hasResumableSession` is false for a missing dir and for a dir holding only `sessions.jsonl`, and true once another `.jsonl` file exists;
- `recordSession` into a path under a regular file does not throw, and `readSessions` of it is `[]`;
- `pruneOpencodeSessions` with no `bin` returns 0 and still deletes an old spill file; with a `bin` that exits 1 it returns 0; with a `bin` path that does not exist it returns 0 and does not throw.
docs/invariants.md names none of session-ledger.ts's functions. test/session-ledger.test.ts covers the record/read round trip, the resume selection and the main prune path, but none of the points above.

**Approach.**
1. src/agent/session-ledger.ts, `pruneSessionLedgers`: count the lines dropped from one file in a local, and add it to `pruned` only after that file's `writeTextAtomic` succeeds. Wrap the write in `try { … } catch { return; }`, matching the best-effort catches already in this module. A ledger that cannot be rewritten keeps all its lines and adds nothing to the count, so the `pruned N stale session ledger line(s)` warning in retention.ts never claims lines that are still there. Extend the doc comment by one sentence: a ledger that cannot be rewritten (a full disk, a read-only dir) is left as it was and not counted, because this pass runs in the orchestrator's poll loop, where a throw ends the team. Use plain vocabulary (no "tick", "loop" for role, "landing"); src/agent/ is already under the vocabulary guard. Change nothing else in src/.
2. New test/session-ledger-prune.test.ts (node:test + `node:assert/strict`). Do not edit test/session-ledger.test.ts. Import from ../src/agent/session-ledger.js, plus `tmpdir` and `skipIfRoot` from ./fixtures/repo-fixtures.js, `errnoError`, `withThrowingFs` and `withReadOnlyDir` from ./helpers/fs-faults.js, and `writeScript` from ./fakes/fake-commands.js. Build records inline, as test/session-ledger.test.ts's `record` helper does. Tests:
   a. "pruneSessionLedgers leaves a ledger it cannot rewrite as it was and counts nothing for it": record one line 30 days old and one fresh. Run `pruneSessionLedgers(root, 7)` inside `withThrowingFs("writeFileSync", errnoError("ENOSPC"), …)` under `assert.doesNotThrow`. Expect a return of 0, ledger bytes equal to those read before, and `fs.readdirSync(dir)` equal to `["sessions.jsonl"]`. Then a second case with `withReadOnlyDir(dir, …)`, guarded by `if (skipIfRoot(t)) return;`, with the same expectations. Then call it again with no fault: it returns 1 and `readSessions` holds only the fresh record. Mutation: remove the try/catch around the write. Both cases then throw.
   b. "pruneSessionLedgers does not rewrite a ledger with nothing past the window": one fresh record; set the ledger's mtime 3 days back with `fs.utimesSync`. Expect a return of 0 and the same `mtimeMs` and `ino`. Mutation: change `if (kept.length !== lines.length)` to `if (true)`.
   c. "pruneSessionLedgers empties a fully stale ledger in place and ages out a non-numeric stamp": one 30-day-old record plus one appended line that is valid JSON whose `at` is the current time as a string (`String(Date.now())`). Expect a return of 2, the file still existing, and its size 0. Mutation: change `typeof at === "number" && at >= cutoff` to `(at as number) >= cutoff`. JavaScript coerces the numeric string, so the string line is kept and the return is 1. A non-numeric string such as `"x"` would not catch this mutation, because `"x" >= cutoff` is false either way.
   d. "hasResumableSession counts a backend session file but never the ledger itself": a missing dir gives false; after `recordSession`, false; after writing `s.jsonl` beside it, true. Mutation: drop `&& f !== SESSION_LEDGER_FILE`.
   e. "recordSession into a path it cannot create drops the record without throwing": the dir is `path.join(<a regular file>, "sub")`; `assert.doesNotThrow`, then `readSessions` returns `[]`. Mutation: replace the catch body with `throw new Error("x")`.
   f. "pruneOpencodeSessions counts only deletes that succeeded and never throws": a 30-day-old `opencode` record, then (1) no `bin` and an old spill file: returns 0 and the spill file is gone; (2) a `writeScript` bin running `exit 1`: returns 0; (3) a `bin` path that does not exist: returns 0 under `assert.doesNotThrow`. Mutation: change `if (res.status === 0)` to `if (res.status !== null)`. Case (2) then returns 1.
   Apply each mutation by hand, check that it fails its test and that the test passes again once you revert it. Also run test/session-ledger.test.ts and test/retention.test.ts under each mutation, and drop any claim that only the new file catches a mutation that one of those also catches.
3. docs/invariants.md: append "## Session ledger: a write or trim never throws, a reader skips what is not a record, and pi continues only into the newest line's own session" at the end, after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BN had merged, BO was planned, and BP was free. Follow the existing Guarantee / Binds / Pinned by layout:
   - 1: `recordSession` never throws and repairs a torn previous line; `readSessions` skips torn, malformed and incomplete lines. Binds `recordSession`, `readSessions`, `isSessionRecord`. Pinned by test e, plus "recordSession and readSessions round-trip records, skipping malformed lines", "recordSession repairs a torn previous line so the next record is not lost" and "readSessions skips a line that parses but is not a complete record" (test/session-ledger.test.ts).
   - 2: an id-selecting resume takes the newest record of its own kind, agent and cwd; pi's `--continue` needs a session file and, with a ledger, the newest line overall to be its own; the ledger never counts as a session file. Binds `latestSession`, `resumableSession`, `sessionResumable`, `hasResumableSession`. Pinned by test d, plus the four `latestSession`/`resumableSession`/`sessionResumable` tests in test/session-ledger.test.ts.
   - 3: the retention trim drops lines past the window or without a numeric stamp, rewrites only a ledger that changed, leaves an emptied ledger in place, and leaves a ledger it cannot rewrite as it was, uncounted and without throwing. The OpenCode purge counts only deletes that exited 0, and a missing or failing binary costs nothing but the count. Binds `pruneSessionLedgers`, `pruneOpencodeSessions`. Pinned by tests a, b, c, f, plus "pruneSessionLedgers drops lines past the window and keeps the recent ones" and "pruneOpencodeSessions deletes expired opencode sessions and prunes old spill files" (test/session-ledger.test.ts).
   Cite each test by its full name.

**Files touched.** src/agent/session-ledger.ts (`pruneSessionLedgers` and its doc comment only); test/session-ledger-prune.test.ts (new); docs/invariants.md.

**Acceptance criteria.**
- `npm run test:gate` passes, and the new tests pass.
- Test a fails on the code before step 1 (with ENOSPC) and passes after it.
- Each mutation named in step 2 fails its test when applied by hand, and the test passes again once it is reverted. Report this in VERIFIED.
- Every test name cited in the new section exists verbatim (`grep -rF` each one in test/).
- `git diff -- src/` touches only `pruneSessionLedgers` and its doc comment in src/agent/session-ledger.ts.

## Done
