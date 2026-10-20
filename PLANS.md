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

### Secret-leak gate: a changed file that cannot be read is a finding, so a credential the gate could not see never merges unchecked (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/review/secret-leaks.ts + test/secret-leaks.test.ts + docs/invariants.md)

**Goal.** `secretLeakReason` (src/review/secret-leaks.ts) is INV-G2's only guard against a change writing a credential into a file. Both of its callers rely on it: the review gate (`reviewAttempt` in src/review/review.ts), where an md-only diff that passes it takes the exempt fast path and merges unreviewed, and the stage check (`stageCheckFindings`, src/run/stage-check.ts). It skips a file whose `fs.statSync` throws, whatever the error, and a file whose `readTextOrNull` returns null. So a changed file that exists but cannot be read at gate time (EMFILE under fd pressure, EIO, EACCES) passes as leak-free, and the harness's later `git add` can still commit its content. **Reproduced 2026-10-20** against dist with a scratch .mjs: a fresh repo with `leak.json` holding `hf_abcdefghijklmnopqrstuvwxyz` and the secret list `[{ name: "$HF_TOKEN", value: <that value> }]` gives "`leak.json` contains the value of $HF_TOKEN — …". With `fs.readFileSync` patched to throw EMFILE for paths ending in `leak.json`, the same call gives `undefined`. The base side already fails closed: `fileContentAt` (src/git/git.ts) returns "" on a failed `git show`, so a hit then counts as a leak.

**Approach.** One file, fail closed. Only "this path holds no file" lets the gate skip a file.
1. In `secretLeakReason`, when `fs.statSync(full)` throws, `continue` only when `errCode(err)` (from `../errno.js`) is `ENOENT` or `ENOTDIR`, meaning the change deleted the file or replaced a parent. Any other code pushes `` `${file}` could not be read to check for leaked secrets (${code ?? "error"}) `` onto `leaks` and continues.
2. Replace `readTextOrNull(full)` with a direct `fs.readFileSync(full, "utf8")` inside a try. ENOENT and ENOTDIR (the file vanished between stat and read) `continue`. Any other error pushes the same "could not be read" entry and continues. Drop the `readTextOrNull` import if nothing else in the file uses it.
3. Leave unchanged: the `secrets.length === 0` early return (with no secrets known there is nothing to check), the `!stat.isFile()` and `MAX_SCAN_BYTES` skips (directories, gitlinks and oversized files are deliberate), the `MAX_NAMED` cap, `moreSuffix`, and the trailing advice text, which reads correctly for both entry kinds. The reason still never contains a secret value.
4. Update the doc comment. Replace "never throws on an unreadable file" with: never throws; a changed file that exists but cannot be stat'ed or read is named as a finding, because a gate that cannot read a file cannot vouch for it, and only a missing path is skipped.

**Files.** src/review/secret-leaks.ts, test/secret-leaks.test.ts, docs/invariants.md.

**Acceptance criteria.**
- test/secret-leaks.test.ts gets a new test, "secretLeakReason names a changed file it cannot read, and skips a missing one". Import `patchFsMethod` and `errnoError` from `./helpers/fs-faults.js`. Use the file's `worktree` helper to write `clean.md` (no secret). Fault `readFileSync` with `errnoError("EMFILE")` only for paths ending in `clean.md`, restoring in `finally`. Assert that `secretLeakReason(wt, "main", ["clean.md"], ENV)` matches /`clean\.md` could not be read to check for leaked secrets \(EMFILE\)/. Separately fault `statSync` with `errnoError("EACCES")` for that path and assert a match on `(EACCES)`. Assert that `secretLeakReason(wt, "main", ["gone.md", "a/b.md"], ENV)` is undefined when neither path exists (ENOENT is skipped).
- The existing tests "secretLeakReason names the file and variable, never the value", "secretLeakReason passes a value already at the merge-base, a directory, and no secrets", the review test "gate rejects an md-only change that writes a secret env value, with no pi run", and the stage-check test "an uncommitted file holding a secret env value is a finding" pass unchanged.
- docs/invariants.md: in the section "## The merge gate's deterministic rejections", after the last INV there, add `### INV-G4: a changed file that exists but cannot be read is a secret-leak finding; only a path with no file is skipped`. INV-G4 was free when planned: `grep -n 'INV-G' docs/invariants.md` showed only G1 and G2, and G3 is claimed by the waiting "Conflict-marker check" plan. If that plan has not landed yet, put G4 directly after INV-G2. Give it a Guarantee; Binds `src/review/secret-leaks.ts`, `src/review/review.ts`, `src/run/stage-check.ts`; and Pinned by the new test name plus "secretLeakReason passes a value already at the merge-base, a directory, and no secrets".
- `npm run test:gate` passes, and the new test name exists verbatim (`grep -rF` it in test/).

### Invariants register: an id prefix belongs to exactly one section, so a wrapped line that starts with `## ` cannot silently split a section (planned 2026-10-20 by the plan role; independent of every eligible plan; touches test/invariants-doc.test.ts + docs/invariants.md)

**Goal.** docs/invariants.md says "Each section takes the next unused prefix". The register test (`invariantProblems` in test/invariants-doc.test.ts, run on the real file by "this repo's docs/invariants.md is honest") checks id shape, duplicate ids, the three field labels and the cited tests, but never which `## ` section an entry sits under. That gap has already let the register break unnoticed. In the section "## Flake quarantine: a test that failed then passed on one tree is quarantined until its filed bug leaves ## Open, and a possibly truncated list never counts", INV-BI4's **Pinned by.** paragraph cites the test "moving a quarantined test's bug out of ## Open releases it". The citation wrapped so that one line starts with `## Open releases it"; `test/known-flakes-quarantine.test.ts` — …`. Markdown renders that line as an H2 heading. INV-BI5 then sits under a phantom section, and the register shows a stray heading in the middle of an entry. Checked 2026-10-20 with a scratch node script that maps each `### INV-` heading to the last `## ` line above it: across 98 `## ` headings, `BI` is the only prefix used under two sections, and no section mixes two prefixes. The same check fails a merge in which two concurrent changes claim one prefix for two different new sections with different numbers (say BL1 and BL2). That is a collision the duplicate-id rule misses.

**Approach.** Test-only, plus the doc fix.
1. docs/invariants.md, INV-BI4's **Pinned by.** paragraph: rewrap the lines so no line starts with `## `. For example, end the line before it at "moving a quarantined test's bug" and start the next line with "out of ## Open releases it"; …". Change no words. `citedTitles` collapses whitespace (`collapse`), and "a wrapped, truncated or template-expanded citation matches its test" already pins that, so the citation keeps matching.
2. test/invariants-doc.test.ts, `invariantProblems`: in the existing per-entry loop, find the entry's section: the text of the last line matching `/^## /m` in `md.slice(0, start)`, or `""` when there is none. For a well-formed id (`ID_RE` passes), the prefix is the letters between `INV-` and the digits. Keep two maps, `sectionOfPrefix` (prefix → first section) and `prefixOfSection` (section → first prefix), and push at most one problem per entry for each rule:
   - The prefix was first seen under a different section: `` `${label}: prefix INV-${prefix} already belongs to section "${first}" but this entry sits under "${section}" — each section takes one prefix; a wrapped line starting with "## " starts a stray section` ``. Clip each section title to 80 characters with `…`.
   - The section was first seen with a different prefix: `` `${label}: section "${section}" already uses prefix INV-${firstPrefix} — each section takes one prefix` ``.
   Keep `HEADING_RE` and the entry-body slicing as they are. A malformed id skips both rules; it already has its own problem.
3. Do not touch the intro paragraph of docs/invariants.md. Its "Each section takes the next unused prefix" sentence becomes the rule the test enforces.

**Files.** test/invariants-doc.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New tests in test/invariants-doc.test.ts, placed after "a duplicate id is reported at the second entry":
  - "an id prefix reused under a second section is reported": build `# Invariants\n\n## One\n\n` + `entry("INV-A1")` + `## Two\n\n` + `entry("INV-A2")`. Assert that a problem includes both `INV-A2 (entry 2)` and `prefix INV-A already belongs to section "One"`.
  - "a wrapped line starting with ## inside an entry is reported as a stray section": `register(entry("INV-A1") + "## Open releases it\n\n" + entry("INV-A2"))`. Assert that a problem includes `INV-A2` and `stray section`.
  - "a section that mixes two prefixes is reported": `register(entry("INV-A1") + entry("INV-B1"))`. Assert that a problem includes `already uses prefix INV-A`.
  - "two sections with one prefix each yield no problems": `# Invariants\n\n## One\n\n` + `entry("INV-A1")` + `## Two\n\n` + `entry("INV-B1")`. `deepEqual` to `[]`.
- "this repo's docs/invariants.md is honest" passes with the step-1 rewrap. Without that rewrap it reports INV-BI5. Check this once by reverting only the doc hunk, then restore it.
- `grep -n '^## Open releases' docs/invariants.md` prints nothing (today it prints the stray line).
- Every existing test in test/invariants-doc.test.ts passes unchanged, and `npm run test:gate` passes.

## Done
