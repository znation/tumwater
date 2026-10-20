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

### Notes command: a note that cannot be written or read refuses with one stderr line and exit 1, instead of a Node stack trace or a silent empty `show` (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/notes-cli.ts + test/notes-cli.test.ts + docs/invariants.md)

**Goal.** Every run saves its role note with `tumwater-notes` (src/notes-cli.ts). Its design (plans/notes-command.md, "Validation") says: "Failure prints the reason to stderr and exits 1". The code does not do that when the note file itself fails:
- `writeNote` (used by `write` and `write --file`) and the `clear` case call `writeRoleNote` (src/agent/role-notes-write.ts → `writeTextAtomic`) with no catch. A failed write (ENOSPC, EACCES, a path component that is a file, a target that is a directory) escapes `main()` as an uncaught exception. Node then prints a 20-line stack trace with `node:fs` internals and exits 1. The agent reading that output has no `notes …` line telling it the save failed and why.
- `readNote` (used by `show`) reads through `readTextOrNull`, which returns null for every error. A note that exists but cannot be read (EACCES, EISDIR) therefore prints nothing and exits 0, the same output as "there is no note". A role that shows its note before replacing it would treat the note as empty.

Reproduced on 2026-10-20 against the built dist/src/notes-cli.js. With `TUMWATER_NOTES_PATH=<tmp>/file/notes.md` (where `<tmp>/file` is a regular file), `echo hi | node dist/src/notes-cli.js write` and `node dist/src/notes-cli.js clear` both printed the `Error: EEXIST: file already exists, mkdir …` stack trace and exited 1.

**Approach.**
1. In src/notes-cli.ts `writeNote`, wrap the `writeRoleNote(NOTES_PATH!, text)` call in try/catch. On a throw, return `refuse` with the message `could not save the note: ` followed by `errorMessage(err)`. Print the `notes saved` line only after the write returned.
2. In the `clear` case, wrap `writeRoleNote(NOTES_PATH, "")` the same way, with the message `could not clear the note: ` followed by `errorMessage(err)`.
3. Make `readNote` read through `readTextIfExists` (src/files/files.ts) instead of `readTextOrNull`, so a missing note still reads as "" while any other error throws. In the `show` case, catch that throw and return `refuse` with the message `could not read the note: ` followed by `errorMessage(err)`. Print nothing to stdout in that case. Update `readNote`'s doc comment to match.
4. In the file header's exit-code paragraph, add "a note file that cannot be written or read" to the list of exit-1 refusals.
5. Leave src/agent/role-notes-write.ts unchanged. Its existing tests pin that `writeRoleNote` rethrows and cleans up its temp file.

**Files touched.** src/notes-cli.ts, test/notes-cli.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New tests in test/notes-cli.test.ts that use the file's existing `run(args, notesPath, input)` spawn helper. For a failing note path, use the fixture the `writeRoleNote` tests in that file already use: `fs.mkdirSync(notes, { recursive: true })`, so the target path is a directory.
  - "write to a note that cannot be written exits 1 with one 'could not save the note' line and no stack trace": status 1; stderr starts with `could not save the note: `, has exactly one non-empty line and does not contain `    at `; stdout is empty.
  - "clear on a note that cannot be written exits 1 with one 'could not clear the note' line": the same assertions, using `could not clear the note: `.
  - "show on a note that cannot be read exits 1 naming the failure instead of printing nothing": status 1; stderr starts with `could not read the note: `; stdout is empty.
  Before the fix, the first two print a stack trace and the third exits 0.
- The existing test "show prints nothing for a missing note" and every other test in test/notes-cli.test.ts pass unchanged.
- docs/invariants.md: append a new section at the END of the file, `## Notes command: a note file that fails refuses in one line, never a stack trace`, with `### INV-CS1: tumwater-notes write, clear and show on a note file that cannot be written or read exit 1 with one stderr line naming the failure, and show never reports an unreadable note as empty`. Give it Guarantee, Binds (`src/notes-cli.ts`: `writeNote`, `readNote`, `main`) and Pinned by (the three new test names). Before writing, run `grep -n '^### INV-' docs/invariants.md | tail` and check that CS is still free; if it is taken, use the next free two-letter ID.
- `npm run test:gate` passes, and the three cited test names exist verbatim (`grep -rF` them in test/).

## Done
