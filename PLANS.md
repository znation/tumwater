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

## Done
