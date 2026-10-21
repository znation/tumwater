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

### `tumwater diff --role <id>[,<id>...] --path <path>` limits each listed role's pending view to one file or directory: its commits that touch the path, the patch and the uncommitted edits under it. This is the follow-up to `diff --overlaps`, which names a shared file but cannot show what each role did to it (planned 2026-10-20 by the plan role; independent of every eligible plan. It shares src/cli/completion.ts with the in-flight "Shell completion past the comma" plan only through a one-word `PATH_FLAGS` addition, so rebase onto it if that one lands first)

**Goal.** `tumwater diff --overlaps` prints `src/cli.ts: feature, bugfix`. To see what each role did to that file, the operator today reads both roles' whole patches (`diff --role feature,bugfix`), which can be up to `DIFF_MAX_BYTES` each. `--path <path>` keeps only the part of each view under one repo-relative path. The diff is git's, through a literal pathspec, so a directory path covers everything below it. `tumwater diff --role feature,bugfix --path src/cli.ts` then shows exactly the two edits that will meet at merge.

**Approach.**
1. **Flag.** In src/cli/cli-flag-specs.ts, beside `OVERLAPS_FLAG`, add `DIFF_PATH_FLAG: FlagSpec = { names: ["--path"], value: true, valueName: "<path>", missingValue: DIFF_PATH_VALUE_ERROR }`, with `DIFF_PATH_VALUE_ERROR = "diff --path needs a path (e.g. \`--path src/cli.ts\`)"`. Give each a doc comment in the style of its neighbours. No other command accepts `--path` today (grep `"--path"` in src finds nothing).
2. **cmdDiff** (src/cli/cli-query-commands.ts): add `DIFF_PATH_FLAG` to its `rejectUnknownArgs` list. Read the value with `flagValue(args, "--path")` (src/cli/cli-args.ts) and fail a repeat through `rejectRepeatFlag` (count the `--path` tokens). Then normalise the value: strip leading `./` pieces and trailing `/` characters. Fail with `diff --path takes a repo-relative path such as src/cli.ts (as diff --overlaps prints it)` when the result is empty, when `path.isAbsolute` holds, or when any `/`-separated segment is `..`. Order the checks this way:
   - In the `--overlaps` branch, `--path` fails with `diff --overlaps reads every file; drop --path`, beside the existing `--role`/`--stat` rejections.
   - In the team branch (`roles === null`), `--path` fails with `diff --path needs --role <id> (the team roster prints no patch)`, the `--stat` wording's twin.
   - Otherwise pass `path` into the opts of `collectRoleChange`/`collectRoleChanges` next to `stat`.
3. **Collector** (src/change/change-data.ts): widen both opts types to `{ stat?: boolean; path?: string }`. In `collectRoleChange`, when `opts.path` is set, let `spec = ["--", \`:(literal)${opts.path}\`]`. Then:
   - `commits` comes from `git log --oneline ${mainBranch}..HEAD ...spec`, so only commits touching the path are listed. `ahead` and `behind` stay whole-branch counts.
   - The committed patch: the `--stat` branch appends `spec`, and the patch branch calls `aheadOfMainDiff(wt, mainBranch, DIFF_MAX_BYTES, spec)`. Compute either one only when `commits.length > 0`, not when `ahead > 0`.
   - `dirtyFiles` keeps an entry `f` when `f === path`, or `f.startsWith(path + "/")`, or `f` ends with `/` and `path.startsWith(f)`. The last case is porcelain's untracked-directory entry.
   - The uncommitted patch: give `cappedWorkingDiff(wt, spec: string[] = [])` the same spec, appended to both its `git diff HEAD` and its over-cap `--stat` call. Apply it to the `--stat` branch too.
   - Return `path: opts.path` on the view. In `RoleChangeView`, add `path?: string` with a doc comment: present only under `--path`, so the unscoped JSON (`diff --json`, the dashboard's /api/diff) is unchanged.
4. **aheadOfMainDiff** (src/git/git-diff.ts): add a 4th parameter, `pathspec: string[] = []`, appended to both its `git diff ${range}` and its over-cap `git diff --stat ${range}` calls. Its other caller, `src/review/review-run.ts`, passes nothing and keeps its behavior.
5. **Render** (src/change/change-render.ts `renderRoleChange`): when `view.path` is set and `view.commits.length === 0 && view.dirtyFiles.length === 0` (state ready), return `no pending change to ${view.path} for ${view.role}`. Otherwise, the first line gains `; limited to ${view.path}` after `workSummary(...)`. That summary's commit count stays the branch's; its uncommitted-file count is the scoped one. The other lines are unchanged.
6. **Help and completion.** In src/cli/help.ts, the `tumwater diff --role` stanza's usage line gains `[--path <path>]`, plus one clause: "--path keeps only the commits, patch and uncommitted edits under that repo-relative file or directory (composes with --stat, --json and a comma list)". Add `"--path"` to `PATH_FLAGS` in src/cli/completion.ts so its value completes file names. Flag-name completion comes from the help stanza.
7. **Docs.** In the docs/cli.md "See a role's pending change" row, add the same clause after the `--stat` parenthetical, and say that a path with nothing pending prints `no pending change to <path> for <id>`. Find the row with `grep -n` and excerpt it with python; the line is long. docs/invariants.md "Role change view": add one sentence to the section intro saying that `--path` scopes `collectRoleChange` through a literal pathspec. No guarantee changes.

**Files touched.** src/cli/cli-flag-specs.ts, src/cli/cli-query-commands.ts, src/change/change-data.ts, src/change/change-render.ts, src/git/git-diff.ts, src/cli/help.ts, src/cli/completion.ts, docs/cli.md, docs/invariants.md, test/cli-diff.test.ts.

**Acceptance criteria** (new tests in test/cli-diff.test.ts, built on `seededFeatureRepo` plus a second commit `add gadget.md` and an uncommitted edit to both files):
- `diff --role feature --path widget.md` exits 0. Its first line ends `; limited to widget.md`. It lists `add widget.md` and not `add gadget.md`. It includes `+# widget` and `uncommitted (1 file): widget.md`, and no `gadget.md` text anywhere.
- `--path ./widget.md` prints the same output as `--path widget.md`. A directory path (`--path docs` after committing `docs/a.md` in the worktree) shows `docs/a.md`'s patch.
- `--path nothing.md` prints exactly `no pending change to nothing.md for feature`, exit 0.
- `--path widget.md --stat` shows `widget.md |` and no `gadget.md |`.
- `--path widget.md --json` has `path: "widget.md"`, `dirtyFiles: ["widget.md"]` and one commit. Plain `diff --role feature --json` has no `path` key.
- `--role feature,bugfix --path widget.md` prints each role's scoped view in order.
- Each of these fails nonzero with the stated wording: `diff --path widget.md` (no --role), `diff --overlaps --path widget.md`, `--path /abs/x`, `--path ../x`, `--path .`, a trailing `--path` with no value, and `--path a --path b`.
- `test/completion.test.ts` passes unchanged. `npm run test:gate` passes.

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

### `history <role> --last --model <selector>[,...]` opens the role's newest run that started on one of the listed models, e.g. `history feature --last --model claude-sonnet-5-5` reads that model's latest trail (planned 2026-10-20 by the plan role; independent of every eligible plan: Backend/model split part 5/5 changes src/config and test configs, `diff --path` changes cmdDiff, and `prompt --list --grep` changes the inbox list; this one changes the one-run trail command, the history `--model` parser and the CLI arg helpers)

**Goal.** `history <role> --last [--result <class>[,...]]` jumps to the role's newest run, or its newest run in some outcome classes. When you are comparing models (a per-role override, a fallback switch), you still have to run `tumwater history --role feature --model <m> -n 1`, copy the run number, then run `history feature <n>`. Add `--model` to the `--last` form: `history <role> --last --model <selector>[,<selector>...]` prints the trail of the role's newest completed run whose run_start named one of the listed selectors. It uses the listing's `--model` matching (exact, case-sensitive, `runRowsOnModels`), composes with `--result` (both must hold), and composes with `--stat`, `--patch`, `--transcript [--prompt] [--grep]` and `--json` exactly as `--last` does.

**Approach.**
1. src/history/history.ts: move cmdHistory's inline `--model` validation (the `modelRaw === undefined || modelRaw === ""` check, `splitCommaListUnique`, and the empty-pieces check) into an exported `parseHistoryModelList(raw: string | undefined): string[]` beside `parseHistoryResultList`. It fails with `HISTORY_MODEL_VALUE_ERROR` on a missing, empty or all-commas value. cmdHistory calls it in place of the inline lines, and the listing behaves as before (an unknown selector still just keeps no rows).
2. src/cli/cli-args.ts: add `parseModelFlag(args, missingValueError): { rest: string[]; raw: string | null }` beside `parseResultFlag`, built on the module-local `takeValuedFlag` the same way, so `peelPositionals` cannot read the selector as a run number. Update `takeValuedFlag`'s doc comment, which names only parseGrepFlag and parseTypeFlag, to say it is the shared body of the `parse*Flag` helpers.
3. src/cli.ts `runTrailCommand`: after `parseResultFlag`, call `parseModelFlag(unresulted, HISTORY_MODEL_VALUE_ERROR)` (import the constant alongside `HISTORY_RESULT_VALUE_ERROR`) and peel positionals from its `rest`. Add `{ names: ["--model"] }` to the `rejectUnknownArgs` spec list beside the `--result` entry. Pass `model: raw` to cmdRunDetail. `historyTrailForm` (src/cli/cli-command-args.ts) already skips `--model`'s value through `HISTORY_LISTING_VALUED_FLAGS`, so `history feature --last --model x` already routes to the trail form. Do not change it.
4. src/run/run-detail.ts `cmdRunDetail`: add an option `model?: string | null` (default null).
   - Beside the `--result needs --last` check, fail with `history --model needs --last on a one-run trail (usage: ${RUN_DETAIL_USAGE})` when `model !== null && !last`.
   - Otherwise parse it with `parseHistoryModelList(model)` into `models` (null when absent).
   - When `classes` or `models` is set, the `--last` scan reads `readRunRows(root, HISTORY_MAX_RUNS, role)`, narrows it with `runRowsOnModels(rows, models)` (imported from ../history/history-data.js) when models is set, then takes the first row whose class is listed when classes is set. With neither, keep today's `readRunRows(root, 1, role)[0]`.
   - A miss stays exit 0, printing `null` under `--json`. `runNotFoundLastMessage` gains an optional `models: string[] | null = null` argument after `classes`. The `what` it passes `runNotFoundPhrase` is `completed run`, then ` with result "<flagNames>"` when classes is set, then ` on model "<models joined with ,>"` when models is set. So `--result problems --model m` misses with `no completed run with result "problems" on model "m" for bugfix in the scanned window (the retained log may have rotated past it)`. Today's two wordings stay byte-for-byte the same.
   - `RUN_DETAIL_USAGE` becomes `tumwater history <role> [<n>] [--last [--result <class>[,...]] [--model <selector>[,...]]] [--stat] [--patch] [--transcript [--prompt] [--grep <text>]] [--json]`. Update the cmdRunDetail doc comment's synopsis and add one sentence on `--model`.
5. src/cli/help.ts: put the new usage in the trail stanza's synopsis. After the `--result <class>[,...] (with --last)` sentence, add `--model <selector>[,...] (with --last) picks the newest run that started on a listed model (the listing's --model match; composes with --result);`, wrapped to the stanza's column.
6. docs/cli.md "Watch run history" row: after the `--last --result` clause, add "; `--last --model <selector>[,...]` picks the newest run that started on a listed model, and composes with `--result`".

Out of scope: shell completion of `--model` after a trail form (src/cli/completion.ts), and the TUI/GUI trail views.

**Files touched.** src/history/history.ts, src/cli/cli-args.ts, src/cli.ts, src/run/run-detail.ts, src/cli/help.ts, docs/cli.md, test/run-detail.test.ts.

**Acceptance criteria** (in test/run-detail.test.ts, using its `writeEvents`/`start`/`end` helpers; `start({ model })` sets the run_start's model):
- New test "cmdRunDetail --last --model picks the newest run on the listed models". Seed bugfix runs 2 (`changed`, model `a`), 5 (`error`, model `b`) and 7 (`no_change`, model `a`), and run 9 (`changed`) whose start carries no model.
  - `{ last: true, model: "a" }` prints the same stdout as `["bugfix", "7"]`.
  - `model: "b"` gives run 5, and `model: "b,a"` gives run 7.
  - `{ last: true, model: "a", result: "merged" }` gives run 2.
  - The `--json` payload deepEquals the numbered form's.
- New test "--last --model with no matching run: not-found line at exit 0, null under --json". `model: "zzz"` prints `^no completed run on model "zzz" for bugfix in the scanned window`. `model: "b", result: "merged"` prints `^no completed run with result "merged" on model "b" for bugfix`. `--json` prints `null`.
- New test "--model needs --last and a selector". `cmdRunDetail(repo, ["bugfix", "5"], false, { model: "a" })` fails with `--model needs --last`. `model: ","` fails with `history --model needs a model selector`.
- A CLI-level case through the existing `cli(repo, …)` helper: `history bugfix --last --model b` exits 0 with the run-5 header, which proves `b` is not peeled as a positional.
- The usage regexes in this file that match `RUN_DETAIL_USAGE` are updated to the new string. The existing `--last` and `--last --result` cases, and test/history*.test.ts's `--model` cases, pass unchanged.
- `npm run test:gate` passes.

### Comma-list completion skips the items already typed: `--role qa,<TAB>` offers `feature` and `feature-2` but not `qa` again, for every comma-list flag in bash, zsh and fish (planned 2026-10-20 by the plan role; independent of every eligible plan — the `diff --path` plan also edits src/cli/completion.ts, but only its flag/path tables, not `_tumwater_list` or the fish value functions)

**Goal.** `--role`, `--result`, `--type` and `history --model` take comma lists, and completion fills in the item after the last comma ("Shell completion past the comma", PLANS-DONE.md). It still offers items the list already holds: today `history --role qa,<TAB>` offers `qa,qa` (pinned by test "the bash script completes the item after the last comma of --role, --result and --type lists"), and `history --result merged,<TAB>` offers `merged,merged`. A repeated item is never useful. Completion should offer only the items not yet in the list.

**Approach.**
1. src/cli/completion.ts `bashScript`, the `_tumwater_list` helper: build the word list from `$1` minus the items in `head`, then pass that list to `compgen`. Use exactly this body:
   ```
   _tumwater_list() {
     local head="" word words=""
     [[ "$2" == *,* ]] && head="${2%,*},"
     for word in $(printf '%s\n' "$1"); do
       [[ ",$head" == *",$word,"* ]] || words+="$word "
     done
     COMPREPLY=( $(compgen -P "$head" -W "$words" -- "${2##*,}") )
   }
   ```
   Write `$(printf '%s\n' "$1")`, not `$1`: the zsh script runs this function under bashcompinit, and zsh does not word-split a bare `$1`, but it does split a command substitution. The plan run checked this body in bash and in zsh with `bashcompinit`. Both gave `qa,feature qa,feature-2` for `qa,`, and `feature,feature-2 feature,qa` for `feature,`. The `,$head` / `,$word,` framing matches whole items, so `feature,` still offers `feature-2`. Update the helper's `#` comment to say it also drops the items already listed. The four call sites (`--role`/role positional, `--result`, `--type`, `history --model`) do not change. The role-positional case never holds a comma, so `head` is empty and nothing is dropped.
2. src/cli/completion.ts `fishScript`: add a filter function next to `__tumwater_argc`:
   ```
   function __tumwater_unlisted; set -l typed (string split , -- (string match -r '^.*,' -- (commandline -ct))); while read -l word; contains -- $word $typed; or echo $word; end; end
   ```
   Emit it as one TS template-string line like the others, escaping `\` as the neighbouring lines do. `string match -r '^.*,'` yields the token up to its last comma, or nothing when the token has no comma. Then pipe the four list sources through it: `__tumwater_roles` becomes `tumwater completion --roles 2>/dev/null | __tumwater_unlisted`. Do the same for `__tumwater_models`, and for `__tumwater_results` and `__tumwater_types` (pipe their `printf`). `__fish_complete_list` calls these functions while the commandline still holds the token, so `commandline -ct` reads the list being typed. Out of scope: the `--role=qa,` spelling. Its first item reads `--role=qa`, so nothing is dropped, and completion behaves as it does today.
3. Update the `fishFlagValue` doc comment to say the per-item completion skips the items already listed.
4. docs/cli.md, the `tumwater completion bash|zsh|fish` paragraph: change "a comma-list value (`--role`, `--result`, `--type`) completes its last item, keeping the items before it" to "a comma-list value (`--role`, `--result`, `--type`, `history --model`) completes its last item, keeping the items before it and skipping those already listed".

**Files touched.** src/cli/completion.ts, docs/cli.md, test/completion.test.ts.

**Acceptance criteria.**
- In test "the bash script completes the item after the last comma of --role, --result and --type lists", the last assertion changes to `["tumwater", "history", "--role", "qa,"]` → `["qa,feature", "qa,feature-2"]`. The other four assertions there are unchanged and still pass.
- New test "the bash script skips the items a comma list already holds". It uses the existing `complete` helper, whose fake `tumwater` prints `feature feature-2 qa` for roles and `hf/m-a:deepinfra hf/m-b` for `--models`:
  - `history --role feature,` gives `["feature,feature-2", "feature,qa"]`, so a prefix-sharing id is kept.
  - `logs --role feature,qa,feature-2,` gives `[]`.
  - `history --result merged,` gives the three other class names from `HISTORY_RESULT_FLAG_NAMES`, each prefixed `merged,`.
  - `logs --type run_start,run_` holds no `run_start,run_start`, and holds `run_start,run_end`.
  - `history --model hf/m-b,` gives `["hf/m-b,hf/m-a:deepinfra"]`.
- In the fish test "the fish script completes values after --role, path flags, --template, and --result, and config keys at word 3", or a new one: the script has a `function __tumwater_unlisted` line, and each of the `function __tumwater_roles`, `__tumwater_results`, `__tumwater_types` and `__tumwater_models` lines contains `| __tumwater_unlisted`.
- New test, `{ skip: !fishInstalled }`: `complete -C 'tumwater history --result merged,'` lists no `merged,merged`.
- "the fish script parses under fish when fish is installed", "fish completes the item after the last comma of a --result list", "the zsh script wraps the bash script in bashcompinit", and the existing bash role/result/type/model completion tests pass unchanged.
- `npm run test:gate` passes.

## Done
