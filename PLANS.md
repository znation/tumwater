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

### TUI Pending pane Ctrl+N steps through the overlapping files, showing each holding role's pending change limited to that file: the terminal twin of the dashboard's overlap drill-down and `tumwater diff --role <id> --path <path>` (planned 2026-10-20 by the plan role; independent of every eligible plan — the `diff --overlaps --role` plan only gives `renderChangeOverlaps` an optional second argument, which `pendingOverlapsText` keeps calling with one)

**Goal.** The Pending pane (`createPendingPane` in src/ui/tui/tui-pane-pending.ts) lists `overlapping files (N):` as `path: role, role` lines (`pendingOverlapsText`). The dashboard lets the operator click a line to see each holder's change to that file (`GET /api/diff?role=<id>&path=<path>`, PLANS-DONE "Dashboard overlap drill-down"). The terminal has no way to do that. Ctrl+N on the Pending pane steps through the overlaps: each press shows the next overlapping file's per-role path-scoped change, and the press after the last one returns to the normal pane.

**Approach.**
1. src/ui/tui/tui-keys.ts and src/ui/tui/tui-pane-session.ts: widen the existing `collectChange` seam (it appears in both interfaces in tui-pane-session.ts and in the `TuiKeysDeps` field) to `collectChange(root: string, role: string, opts?: { path?: string }): Promise<RoleChangeView>`. The default stays `collectRoleChange`, which already takes `opts`. Existing callers that pass two arguments do not change. Do not add a new seam.
2. src/ui/tui/tui-pane-pending.ts, inside `createPendingPane`:
   - Add closure state: `let base = ""` (the last full pane text), `let lastOverlaps: ChangeOverlapsView | null = null`, `let overlapIndex = -1` and `let drillGen = 0`.
   - `refresh()`: at its start, set `overlapIndex = -1`, `lastOverlaps = null` and `++drillGen`. Wherever it assigns `session.paneCache`, also assign `base`. In the resolve arm, also set `lastOverlaps = overlaps`.
   - Add an exported pure helper `overlapDrillHeading(index: number, total: number, path: string): string`. It returns `` `overlap ${index + 1}/${total}: ${path} (Ctrl+N next)` ``.
   - In `handleKey`, add a Ctrl+N arm guarded like the Ctrl+R arm (`promptLineFree(ctx.es) && session.view === session.roleIds.length + 5`):
     - When `lastOverlaps` is null, is not `state === "ready"`, or has an empty `overlaps` list: call `session.flashMessage("no overlapping files to step through")` and return true.
     - Otherwise, increment `overlapIndex`. When it reaches the list's length, set it back to -1, set `session.paneCache = base`, set `paneScroll = 0`, request a render, and return true.
     - Otherwise, take `{ path, roles }` at that index. Set `session.paneCache = heading + "\n\nloading…"` and `paneScroll = 0`, then request a render. Capture `const gen = ++drillGen` and the current `refreshGen`. Call `Promise.all(roles.map((r) => session.collectChange(session.root, r, { path })))`. On resolve, paint only when `gen === drillGen`, `refreshGen` is unchanged, and the view is still N+5. The painted text is `heading + "\n\n" + renderRoleChanges({ mainBranch: lastOverlaps.mainBranch, roles: views })`. On reject, under the same guard, keep the heading and call `session.flashError(err)`. Either arm then requests a render. Because `renderRoleChanges` is the CLI's renderer, the text matches `tumwater diff --role a,b --path <path>`.
   - Update the pane's doc comment: it now has two key arms.
3. src/ui/tui/tui-panes.ts `handleKey`, in the Ctrl+N block: route `pending.handleKey` after the Health and History arms and before the transcript fallback. The transcript arm consumes Ctrl+N on every view, so it must stay last. Update that block's comment to name the Pending arm.
4. src/ui/tui/tui-frame.ts: add `["Ctrl+N", "overlaps"]` to the `pending` footer's key list, after `["Ctrl+R", "refresh"]`.
5. Docs:
   - docs/how-it-works.md, the paragraph starting "The Pending pane shows the durable merge queue": add that Ctrl+N steps through the overlapping files, showing each holder's change to the file (the `diff --role --path` view).
   - docs/invariants.md, the change-view paragraph that names the TUI's Pending pane: add that its Ctrl+N drill-down reads `collectRoleChange` with `{ path }` and renders through `renderRoleChanges`.

**Files touched.** src/ui/tui/tui-pane-pending.ts, src/ui/tui/tui-pane-session.ts, src/ui/tui/tui-keys.ts, src/ui/tui/tui-panes.ts, src/ui/tui/tui-frame.ts, test/tui-keys.test.ts, docs/how-it-works.md, docs/invariants.md.

**Acceptance criteria.**
- New test in test/tui-keys.test.ts: "Ctrl+N on the Pending pane steps through each overlap's path-scoped change, then back". Build it like "the Pending pane lists overlapping files below the roster, through the CLI's renderChangeOverlaps", with two overlaps (`src/a.ts: feature, feature-2` and `src/b.ts: feature, qa`) and a `collectChange` stub that records `(role, opts)` and resolves a `ready` `RoleChangeView` for `role` with no commits or dirty files and `path: opts?.path`.
  - After the first Ctrl+N and a `setImmediate`, `paneCache` starts with `overlap 1/2: src/a.ts (Ctrl+N next)` and equals that heading + `"\n\n"` + `renderRoleChanges` of the two stub views. The stub saw `feature` and `feature-2`, each with `{ path: "src/a.ts" }`.
  - The second press shows `overlap 2/2: src/b.ts …` for `feature` and `qa`.
  - The third press restores exactly the pane text from before the first press.
- New test: "Ctrl+N on the Pending pane with no overlaps flashes and keeps the pane". It uses an empty `ready` overlaps list; the pane text is unchanged and the flash reads `no overlapping files to step through`.
- New test: "Ctrl+R on the Pending pane closes an open overlap drill-down". Press Ctrl+N, then Ctrl+R. After the collectors resolve, the pane shows the normal queue/roster/overlaps text, and the next Ctrl+N opens overlap 1 again.
- On a role view, Ctrl+N still cycles the transcript pane, and on Health and History it still runs those arms. The existing Ctrl+N tests in test/tui-keys.test.ts pass unchanged.
- The existing Pending tests and test/cli-diff.test.ts pass unchanged.
- `npm run test:gate` passes.

## Done
