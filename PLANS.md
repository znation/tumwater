# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

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

### Revert: `tumwater revert … --json` prints the preview or the revert as data, the CLI twin of the dashboard's POST /api/revert payload (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/operator/operator-commands.ts + src/cli/help.ts + docs/cli.md + test/cli-operators.test.ts)

**Goal.** A script that wants to check whether a revert would apply, or to record which head a revert produced, has to scrape `would revert <short sha> <subject>`, the indented path lines and `main is now <sha>`. The neighbouring operator commands that report data (`history`, `diff`, `retire`, `questions`, `prompt --list`, `wake --list`) take `--json`. `cmdRevert` (src/operator/operator-commands.ts) rejects it as a flag-shaped token: `revert takes only --dry-run and --last (got --json)`. The data already exists in structured form. `previewRevert` (src/operator/revert.ts) returns `RevertPreview` (`sha`, `subject`, `paths`, `head`, `primary`, `applies`, `dirty`), `revertMergedCommit` returns `{ headSha, beforeSha, subject }`, and the dashboard's `handleRevert` (src/gui/gui-operator-commands.ts) already sends both as JSON.

**Approach.** The change is confined to `cmdRevert` and its helper `revertRunSha`. The text output, the exit codes and src/operator/revert.ts stay as they are.
1. `cmdRevert`: read `const json = args.includes("--json")` and filter `--json` out of `rest` next to `--dry-run` and `--last`. Change the flag-shaped refusal to `revert takes only --dry-run, --last and --json (got ${flagged}); …` (the rest of the message stays). Append ` [--json]` to `REVERT_USAGE`.
2. `revertRunSha`: also return `role` and `run` (the number), giving `{ sha, line, role, run }`. In `cmdRevert`, keep `const runRef = run === null ? null : { role: run.role, run: run.run }`.
3. Dry run with `--json`: after the `if (!p.ok) fail(p.error)` check, call `sayJson({ dryRun: true, run: runRef, sha: p.sha, subject: p.subject, paths: p.paths, head: p.head, primary: p.primary, applies: p.applies, dirty: p.dirty })` instead of the `say` lines. Set `process.exitCode = 1` under the same `!p.applies || p.dirty` condition, then return. `sayJson` is already imported from `../cli/cli-output.js`.
4. Real revert with `--json`: after `if (!result.ok) fail(result.error)`, call `sayJson({ dryRun: false, run: runRef, subject: result.subject, headSha: result.headSha, beforeSha: result.beforeSha, followUp: revertFollowUp(result.subject) })` instead of the `say` lines. `followUp` is the string or `null`.
5. Refusals still go through `fail`: one stderr line and exit 1, with nothing on stdout. This matches `retire --json`. Update `cmdRevert`'s doc comment to mention `--json`.
6. src/cli/help.ts `revert` synopsis: `tumwater revert <sha>|<role> <n>|<role> --last [--dry-run] [--json]`. Add a short clause to its description: `--json prints the preview or the new head as data`. docs/cli.md, "Steer the project" row: after the `revert <sha> --dry-run` sentence, add `` `--json` prints either form as data (the preview's `sha`, `subject`, `paths`, `head`, `primary`, `applies` and `dirty`, or the revert's `headSha`, `beforeSha`, `subject` and `followUp`, each with `dryRun` and the `run` it was resolved from, or `null`) ``.

**Files.** src/operator/operator-commands.ts, src/cli/help.ts, docs/cli.md, test/cli-operators.test.ts.

**Acceptance criteria.** All of these are in test/cli-operators.test.ts.
- "revert rejects a flag-shaped token as a flag, before a lookup or a write" passes `--stat` instead of `--json` and matches `/revert takes only --dry-run, --last and --json \(got --stat\)/`. `REVERT_USAGE_RE` matches the new `[--dry-run] [--json]` usage.
- New test "revert --dry-run --json prints the preview as data and writes nothing". Its clean case exits 0, and its whole stdout passes `JSON.parse` with `dryRun: true`, `run: null`, `sha` equal to the full commit sha, `paths` deep-equal to `["to-undo.txt"]` and `applies: true`. Its conflicting case (the same setup as the existing dry-run test) exits 1, its stdout parses with `applies: false`, and HEAD and `git status --porcelain` are unchanged in both cases.
- New test "revert --json prints the new head as data". It exits 0, its stdout parses with `dryRun: false`, `headSha` equals the repo's new HEAD, `beforeSha` equals the reverted commit, and `followUp` is `null` for the test's hand-made commit (no `tumwater(<role>):` stamp).
- `grep -n 'takes only --dry-run and --last (' src/operator/operator-commands.ts test/cli-operators.test.ts` prints nothing.
- `npm run test:gate` passes.

## Done
