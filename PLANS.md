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

### TUI History trail Ctrl+V, pressed twice after a dry-run preview, reverts the shown run's merged change: the terminal twin of `tumwater revert <role> <n>` and the dashboard History drill-down's Revert button (planned 2026-10-20 by the plan role; independent of every eligible plan. The Backend/model split part changes src/config and test configs, `prompt --list --grep` changes the prompt parser and src/inbox, `history --last --model` changes src/run/run-detail.ts and the history CLI, and the overlap drill-down changes src/gui and src/ui/gui. The TUI Health Ctrl+P plan shares tui-keys.ts, tui-pane-session.ts, tui-panes.ts, tui-frame.ts and docs/cli.md with this one, but only in neighboring hunks: the deps seams, the Ctrl+P router and the Health footer, where this plan adds new seams, the Ctrl+V router and the History footer)

**Goal.** An operator who spots a bad merge has three ways to undo it: `tumwater revert <sha>|<role> <n>` (`cmdRevert`, src/operator/operator-commands.ts), the dashboard History drill-down's preview-then-Revert button (`histRevertStep` in src/ui/gui/gui-client-history.ts → `handleRevert` in src/gui/gui-operator-commands.ts), and nothing in the TUI. The TUI already opens a run's full trail on the History view (Ctrl+N, Ctrl+P steps to older runs; `createHistoryPane` in src/ui/tui/tui-pane-history.ts holds the shown run in `trailRun`), so the operator reads the bad run and must then leave for a shell. Add Ctrl+V on a History run trail (mnemonic: re**V**ert). The first press runs `previewRevert` and flashes what it would undo, and arms only when the revert applies cleanly to a clean checkout. A second Ctrl+V right after it commits the revert through `revertMergedCommit`, the same cores the CLI and the dashboard call. Any other key in between disarms it. Ctrl+V is free on the History view. `handleKey`'s Ctrl+V router (src/ui/tui/tui-panes.ts) only reaches the queued and backlog arms, which return false off their own views. The attach editor's Ctrl+V is guarded to view 0, and the Transcript pause editor's to views 1..N (src/ui/tui/tui-editor-pause.ts).

**Approach.**
1. src/operator/revert.ts: export `runRevertSha(role: string, run: number, detail: RunDetail): { ok: true; sha: string } | { ok: false; error: string }`. It moves the two refusals out of `revertRunSha` (src/operator/operator-commands.ts), wording unchanged:
   - `detail.result !== "merged"` gives `` `${role} run #${run} did not merge (result: ${detail.result ?? "unknown"}); there is nothing to revert` ``.
   - A null `runMergedSha(detail)` (src/run/run-detail.ts) gives the "merged but the event log no longer names its commit; pass the sha from git log instead" sentence.
   - Otherwise `{ ok: true, sha }`.

   `revertRunSha` calls it and `fail`s on `!ok`, so the CLI's output is unchanged and the TUI cannot drift from it. Also export the `RevertPreview` interface, for the seam types. If importing `runMergedSha` from src/run/run-detail.ts into revert.ts creates an import cycle (check with `npm run test:gate`'s lint), put `runRevertSha` in src/run/run-detail.ts instead and import it from there in both places.
2. src/ui/tui/tui-keys.ts: add two optional seams to the deps type, each with a doc comment in the style of `killOrphans?`:
   - `previewRevert?: typeof previewRevert`
   - `revertCommit?: typeof revertMergedCommit`

   In `createTuiKeys`, default them to the real cores (`deps.previewRevert ?? previewRevert`, `deps.revertCommit ?? revertMergedCommit`) and pass both into `createTuiPanes`.
3. src/ui/tui/tui-pane-session.ts:
   - Add `previewRevert` and `revertCommit` to `TuiPanesDeps`, to the session interface, and to `createTuiPaneSession`'s object.
   - Add the armed pair beside `armedKillOrphans`/`killOrphansArmed`: `armedRevert: string | null` (the full sha a second Ctrl+V reverts) and `revertArmed: string | null` (the pending arm), both initialized null, with doc comments in the same style.
4. src/ui/tui/tui-panes.ts:
   - `beginKey`: add `session.armedRevert = session.revertArmed; session.revertArmed = null;`.
   - `handleKey`'s Ctrl+V router: put `if (history.handleKey?.(key, ctx)) return true;` first, ahead of the queued arm, and update the router comment.
5. src/ui/tui/tui-pane-history.ts, `createHistoryPane`:
   - Add `let reverting = false;`.
   - Add a Ctrl+V arm. It returns false off view `session.roleIds.length + 4`. On that view it always returns true after `session.requestRender()`, and acts only when `promptLineFree(ctx.es)`:
     - With the trail off, flash `open a run's trail with Ctrl+N to revert its change`.
     - While `reverting` is set, flash `a revert is already running`, so a held key never starts a second git operation.
     - Otherwise, `runRevertSha(trailRun.role, trailRun.run, trailRun.detail)` with `!ok` flashes its error.
     - **Second press** (`session.armedRevert === sha`): set `reverting = true` and flash `` `reverting ${shortSha(sha)} …` ``. Then `void session.revertCommit(session.root, sha)`:
       - On `ok`, flash `` `reverted ${shortSha(sha)}: main is now ${shortSha(r.headSha)}` `` plus `` `; ${followUp}` `` when `revertFollowUp(r.subject)` is non-null. These are the CLI's lines joined with "; ".
       - On `!ok`, flash `r.error`.
       - A rejection goes through `session.flashError`.
       - In `finally`, clear `reverting` and `session.armedRevert`, and request a render.
     - **First press**: set `reverting = true`, capture `const gen = trailGen`, and flash `` `previewing the revert of ${shortSha(sha)} …` ``. Then `void session.previewRevert(session.root, sha)`. When it resolves, apply its result only if `gen === trailGen`, so a trail closed or stepped since gets no stale arm. Each outcome flashes:
       - `!p.ok` flashes `p.error`.
       - `!p.applies` flashes `` `would conflict on ${p.primary} (HEAD ${shortSha(p.head)}); nothing was written` ``.
       - `p.dirty` flashes the CLI's "the checkout has staged or unstaged changes, so tumwater revert would refuse until they are committed or stashed; nothing was written".
       - Otherwise set `session.revertArmed = p.sha` and flash `` `press Ctrl+V again to revert ${shortSha(p.sha)} ${p.subject} (${p.paths.length} file${p.paths.length === 1 ? "" : "s"}) on ${p.primary} — any other key keeps it` ``.

       A rejection goes through `session.flashError`. In `finally`, clear `reverting` and request a render.
   - `reset()` also clears `session.revertArmed` and `session.armedRevert`.
   - Add a comment on the arm naming the CLI and dashboard twins and the two-press rule.
   - Extend the factory doc comment to mention Ctrl+V.
6. src/ui/tui/tui-frame.ts: in the `view.kind === "history"` footer, in the `view.trail ? [...]` spread that holds Ctrl+P/Ctrl+R, add `["Ctrl+V", "revert run"]` after the Ctrl+R entry.
7. Docs:
   - docs/cli.md TUI key table: add a row after the `Ctrl+R` | History (on a run trail) row: `` | `Ctrl+V` (twice) | History (on a run trail) | preview, then revert the shown run's merged change on main (the terminal twin of `tumwater revert <role> <n>` and the dashboard History drill-down's Revert; the first press arms only when the revert applies cleanly to a clean checkout, and any other key disarms it) | ``.
   - docs/cli.md Steer row (a long line, so edit it with python): after "the dashboard's History drill-down offers the same revert, preview first", add ", and so does the TUI History trail's Ctrl+V (twice)".

**Files touched.** src/operator/revert.ts, src/operator/operator-commands.ts, src/ui/tui/tui-keys.ts, src/ui/tui/tui-pane-session.ts, src/ui/tui/tui-panes.ts, src/ui/tui/tui-pane-history.ts, src/ui/tui/tui-frame.ts, docs/cli.md, test/operator-revert.test.ts, test/tui-keys.test.ts.

**Acceptance criteria.**
- test/operator-revert.test.ts, new case "runRevertSha refuses an unmerged run and a merged run naming no commit, and returns the merged sha": a `RunDetail` with `result: "changed"` gives the did-not-merge error naming the role and run, a merged detail with no `mergedSha` and no commit-bearing merge event gives the no-longer-names error, and one with `mergedSha` returns it.
- test/tui-keys.test.ts: write the events with a merged run (`run_end` `result: "merged"` and a `merge_done` carrying `commit`), open History and its trail with Ctrl+N, and inject `previewRevert`/`revertCommit` fakes that record their calls and resolve on demand. New cases:
  - "Ctrl+V twice on a History trail previews then reverts the run's merged commit": the first Ctrl+V calls the preview fake with the commit and flashes `/previewing/`. After a preview resolves with `applies: true, dirty: false`, the flash matches `/press Ctrl+V again/`, and the next Ctrl+V calls the revert fake once with the same sha. When that resolves, the flash matches `/main is now/`.
  - "a key between the two Ctrl+V presses disarms the revert": Ctrl+V, resolve the preview, any other key (e.g. PgDn), Ctrl+V. The second Ctrl+V calls the preview fake again and never the revert fake.
  - "a conflicting or dirty preview never arms": a preview with `applies: false` flashes `/would conflict/`, one with `dirty: true` flashes `/staged or unstaged/`, and a following Ctrl+V previews again rather than reverting.
  - "Ctrl+V on an unmerged run's trail flashes the CLI's refusal": a trail of a `result: "changed"` run flashes `/did not merge/` and calls neither fake.
  - "Ctrl+V off a History trail never reverts": on the History rows (trail off) it flashes `/Ctrl\+N/` and calls neither fake. On the Backlog and Queued views the existing Ctrl+V cases still pass unchanged.
- The existing History trail cases (the "Ctrl+N on the History pane swaps…", "Ctrl+P steps the trail back…" and "Ctrl+R on the History trail cycles…" tests) and the existing Ctrl+V cases pass unchanged.
- `npm run test:gate` passes.

## Done
