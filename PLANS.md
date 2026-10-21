# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role, test migration split out into parts 4b/5 and 4c/5 2026-10-20 by the plan role; requires parts 3/5–4/5, part 4b/5 and part 4c/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**User decision 2026-10-20 (recorded by the director role): merge this without waiting for the operator to migrate tumwater.json first. The break when the live config reloads is accepted; the operator fixes it after the merge. The migration is: `model` drops the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }`. Each load error must name that exact edit, because the operator works from those messages.**

**Goal.** A model id never names a backend: each retired spelling fails the load with a message naming the exact edit (the operator chose no shims), and the fleet-wide scalar `BudgetSlice.backend` goes. Series goal and siblings: part 1/5.

**Approach.**
- `routeModel` (src/config/model-selector.ts) loses rule 1 (its `isBackendId(provider)` branch) and rule 3a (`startsWith("claude-")`): the backend is the explicit backend ?? the top-level `backend` ?? `"pi"`, and claude/opencode take the id verbatim on both paths. `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) follows the same rule (its `isBackendId(provider)` branch goes); a fallback step with no `backend` inherits its tier primary's resolved backend (the tier entry's, else the top level's). `seamAgent` keeps its `agent` read; its `isBackendId(seam.provider)` fallback goes (part 4c/5 moved the seam fixtures that relied on it). The fallback pair (`fallbackPair`, src/config/config-views.ts) carries only `provider: "claude"` for a non-pi backend today and no explicit `agent`, so retiring the `isBackendId(provider)` branch needs that pair to carry its backend first (found by part 4c/5's probe: the fallback-pair tests failed once the namespace spelling was gone). `BACKEND_IDS`' doc comment (src/config/config-schema.ts) drops "doubles as the selector provider namespace", and `isBackendId`'s drops "the reserved selector provider namespace".
- `validateConfig`'s raw pass rejects, each naming the value and the fix: a selector whose first segment is a backend id (`claude/claude-opus-5-5` → write `backend: "claude"` beside `model: "claude-opus-5-5"`); a bare `claude-…` id resolved to pi (add `backend: "claude"`, or write `anthropic/claude-…` to keep it on pi); `opencode/…` resolved to pi (write `backend: "opencode"`). Drop the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) so a top-level `agent` key is an unknown-key error naming `backend`; `agents → backends` stays.
- Delete `BudgetSlice.backend` (src/status/status-budget.ts, its interface field and `backend: cfg.backend ?? "pi"`); src/ui/badges.ts's `agentDefault` uses the constant `pi default`, and the test/badges.test.ts case passing `backend: "claude"` drops that field and asserts the new label.
- docs/config.md, docs/backends.md and docs/glossary.md drop part 3/5's "still load until part 5/5" sentences and the `agent → backend` rename rows; test/config-aliases.test.ts asserts the `agent` error.

**Acceptance criteria.**
- `grep -n 'isBackendId(provider)\|isBackendId(seam.provider)\|startsWith("claude-")' src/config/model-selector.ts src/config/config-fallbacks.ts` finds nothing; each retired spelling (`claude/<id>`, `opencode/<id>` under pi, bare `claude-…` under pi, top-level `agent`) fails `validateConfig` with a message naming the offending value and the edit.
- The migrated form of the team's config in the note above, loaded in a test, resolves `seamsInUse` to claude for every primary seam and `qwenrunner/qwen3.8-27b` on pi for the fallback.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults and `CLAUDE_GATED_MODELS` still lists exactly those three.
- `BudgetSlice` has no `backend` field. Parts 4b/5 and 4c/5 moved the other test fixtures, so the test files this part edits are the ones its heading lists; `npm test` passes.

### `tumwater prompt --list --grep <text>` keeps only the inbox messages whose text contains the text, each under its unfiltered number, the inbox twin of `questions --grep` and `plan --list --grep` (planned 2026-10-20 by the plan role; independent of every eligible plan: the Backend/model split parts change test configs and src/config, the completion plans change src/cli/completion.ts, the `history --last --result` plan changes the history trail command, and the `diff --path` plan changes `cmdDiff`; this one changes only the prompt command's list mode, its help stanza and docs/cli.md's "Steer the project" row)

**Goal.** `logs`, `history`, `backlog`, `plan --list`, `bug --list` and `questions` each take `--grep <text>`. `tumwater prompt --list` does not, and `prompt --list --grep deploy` fails at `rejectUnknownDoubleDash` (src/cli/cli-command-args.ts) as an unknown flag. An operator who queued several prompts with `--at`, or whose roles are paused with inboxes piling up, has to scan every section to find the message to `--cancel`, `--top` or `--edit`. Add `--grep <text>` to `--list` (and `--list --json`). It keeps the rows whose prompt text contains the text, case-insensitively. Each kept row stays under its own role section with its unfiltered position, so the number printed is still the one `--cancel <n>`, `--top <n>` and `--edit <n>` consume.

**Approach.**
1. `src/cli/cli-command-args.ts`:
   - Add `{ names: ["--grep"], value: true, valueName: "<text>" }` to `PROMPT_FLAG_SPECS`. The unknown-flag gate and the equals-form refusal then admit it, and `rejectDuplicateFlags` refuses a repeat.
   - Add `grep: string | null` to the `mode: "list"` arm of `PromptArgs`.
   - In `parsePromptArgs`, read `const grepFlag = args.indexOf("--grep")` beside the other flag indices. A missing, empty or `--`-leading value fails with `--grep needs text (usage: tumwater prompt --list --grep <text>)`, the wording the backlog list view uses.
   - `--grep` outside list mode fails with `--grep only applies to --list`, checked next to the existing `--json only applies to --list` refusal and before any branch writes. Without this, enqueue mode would refuse it as an unknown flag only by accident.
   - In the list branch, pass `grepFlag, grepFlag + 1` (only when present, like `roleClaim`) to `failStrayArg` and return `grep`.
   - Extend the parser's doc comment flag list with `--grep <text>`.
2. `src/inbox/prompt-commands.ts`, `cmdPrompt`'s `parsed.mode === "list"` branch. After the `--role` filter, also keep rows where `row.text.toLowerCase().includes(parsed.grep.toLowerCase())` when `parsed.grep !== null`. `QueuedListRow.text` is already stripped of the not-before marker, so the marker never matches. Filtering the list-wide rows keeps each row's `position`, the same reason the `--role` filter filters `allRows`.
   - `--json` prints `{ prompts }` with the filtered rows.
   - Empty output: when the role-scoped rows (before the grep) are empty, keep the existing empty-inbox lines unchanged; when they are non-empty but no row matches, print `no queued prompt matches "<text>"`.
3. `src/cli/help.ts`: change the stanza `tumwater prompt --list [--role <id>[,<id>...]] [--json]` to `... [--grep <text>] [--json]`. Append `; --grep <text> keeps only the messages containing the text, case-insensitively, under the same numbers` to its description. Completion derives the flag from this stanza; check that `tumwater completion bash` output then lists `--grep` for `prompt` (or note it in VERIFIED if the derivation filters it).
4. `docs/cli.md` "Steer the project" row: after `` `--role <id>[,<id>...]` keeps only the listed roles' sections, under the same numbers `` add `` , `--grep <text>` keeps only the messages containing the text `` (edit with python; the row is one long line).

**Files touched.** src/cli/cli-command-args.ts, src/inbox/prompt-commands.ts, src/cli/help.ts, docs/cli.md, test/cli-prompt-queue.test.ts.

**Acceptance criteria.**
- New test in test/cli-prompt-queue.test.ts, "prompt --list --grep keeps matching prompts under their unfiltered numbers". Queue `director task`, then qa prompts `qa one` and `Deploy the qa fix`, then readme prompt `docs deploy note` (the `submitPrompt`/`submitRolePrompt` helpers). `prompt --list --grep deploy` exits 0. Its output holds `qa:` with `2. Deploy the qa fix` and `readme:` with `1. docs deploy note`, and holds neither `director task` nor `qa one`. `prompt --list --grep DEPLOY --role qa` prints only the qa section's `2.` line. `prompt --list --grep deploy --json` parses to `prompts` whose `(role, position)` pairs are `[qa, 2]` and `[readme, 1]`. `prompt --list --grep nothing-here` exits 0 and prints `no queued prompt matches "nothing-here"`.
- New test, "prompt --list --grep rejects a missing value, a repeat, and non-list modes". `prompt --list --grep` exits 1 with `--grep needs text`. `prompt --list --grep a --grep b` exits 1 (the duplicate-flag refusal). `prompt --grep x hello` and `prompt --cancel 1 --grep x` exit 1 with `--grep only applies to --list`, and the director inbox is unchanged (no prompt queued). `prompt --list --grep=x` exits 1 with the equals-form refusal.
- These existing tests pass unchanged: "prompt --list --role takes a comma list and keeps each section's numbering", "prompt --list --json prints one JSON document matching the rendered list", "prompt --list and --cancel reject duplicates, combinations, and stray positionals", and "prompt --list --role with an empty queue names the role, not an error".
- `npm run test:gate` passes.

## Done
