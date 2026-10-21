# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-20 by feature: too large for one run** — the src change (routeModel, seamKeyedFallbackProvider, validation, alias row, BudgetSlice) is small, but a trial run left ~155 failing tests in ~25 files beyond the six listed: doctor, gate-polls, budget-gates, status-budget, role-view, pi-models, claude-run and others still spell raw configs with `agent: "claude"`, bare `claude-…` models under pi, `claude/<id>` fallbacks and resolved pairs. Part 4/5's fixture migration did not reach them; they need their own part (suggest 4b/5) before this one.

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

### Transcript search in the dashboard, part 1/2: `GET /api/transcript?role=<id>&grep=<text>` keeps only the transcript entries that contain the text, each under its run's separator, through one filter shared with `logs --transcript --grep` (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/ui/transcript.ts + src/cli/log-commands.ts + src/gui/gui-endpoints.ts + docs/how-it-works.md + test/transcript.test.ts + test/gui.test.ts)

**Goal.** `tumwater logs --transcript <id> --grep <text>` now keeps only the matching entries, each under its run's separator. The dashboard's role drawer reads the same transcript through `GET /api/transcript` (`handleTranscript`, src/gui/gui-endpoints.ts), which takes only `role`, `n` and `prompt`, so the drawer cannot search it. This part adds an optional `grep` query parameter. It uses the same keep rule, moved out of `cmdLogsTranscript`'s `printEntry` (src/cli/log-commands.ts) into one exported filter in src/ui/transcript.ts, so the CLI and the API cannot drift apart. Part 2/2 ("Transcript search in the dashboard, part 2/2") adds the drawer's search box. When this was planned, `grep -n 'grep' src/ui/transcript.ts` printed nothing and `handleTranscript` read no `grep` parameter.

**Approach.**
1. src/ui/transcript.ts: right after `isRunSeparatorLine`, add `export function createTranscriptFilter(needle: string): (entry: TranscriptEntry) => string[] | null`. `needle` is already lowercased. The returned function holds `lastSeparator: string | null` and `separatorShown: boolean` and applies exactly the rule `printEntry` applies today:
   - an empty entry returns null;
   - an entry whose first line passes `isRunSeparatorLine` sets `lastSeparator` to that line and `separatorShown = false`;
   - an entry with no line whose `toLowerCase()` includes `needle` returns null;
   - otherwise it returns the entry. If the entry does not open with a separator, and `lastSeparator` is non-null and `!separatorShown`, it returns `[lastSeparator, ...entry]`. In both cases it sets `separatorShown = true`.
   The doc comment says this is the transcript-search keep rule that `logs --transcript --grep` and `GET /api/transcript?grep=` share.
2. src/cli/log-commands.ts `cmdLogsTranscript`: replace the `lastSeparator`/`separatorShown` state and the separator logic in `printEntry` with `const filter = needle === null ? null : createTranscriptFilter(needle);`. `printEntry` prints the entry when `filter` is null. Otherwise it calls `filter(lines)` and, on a non-null result, increments `matched` and `say`s `out.join("\n")`. Import `createTranscriptFilter` beside `isRunSeparatorLine`, and drop `isRunSeparatorLine` from the import if it is no longer used there. The output does not change.
3. src/ui/transcript.ts `readTranscript`: add `grep?: string` to `opts` (an already-lowercased, non-empty needle). When it is set, take `value.entries.slice(-take)` as now, map each entry through one `createTranscriptFilter(opts.grep)` (dropping nulls), flatten the kept entries, and do not append `pending`, because a lone pending separator holds no match. The tail cache stays keyed by `includePrompts` only, since the filter runs after the cache. Without `grep`, the result does not change. Extend the doc comment: `limit` bounds the scanned entries, not the kept ones, which is the scan-then-filter rule `logs --transcript -n N --grep` uses.
4. src/gui/gui-endpoints.ts `handleTranscript`: read `const grep = (q.get("grep") ?? "").trim().toLowerCase();`. Absent or blank filters nothing, the convention `/api/history`'s `grep` uses. Pass `grep: grep === "" ? undefined : grep` beside `includePrompts`. Add `[&grep=<text>]` to the doc comment's route line, plus one sentence: grep keeps only the entries containing the text, case-insensitively, each under its run's separator, the `logs --transcript <id> --grep` rule; `n` bounds the entries scanned.
5. docs/how-it-works.md: in the dashboard paragraph that names `GET /api/transcript?…&prompt=1`, add after that sentence: "`&grep=<text>` keeps only the entries containing the text, each under its run's separator, as `tumwater logs --transcript <id> --grep` does."

**Files.** src/ui/transcript.ts, src/cli/log-commands.ts, src/gui/gui-endpoints.ts, docs/how-it-works.md, test/transcript.test.ts (import `createTranscriptFilter` from `../src/ui/transcript.js`), test/gui.test.ts. Before claiming that no invariant changes, run `grep -n 'api/transcript\|readTranscript' docs/invariants.md`. When this was planned it printed nothing.

**Acceptance criteria.**
- New unit test "createTranscriptFilter keeps matching entries under their run's separator, once per run". It feeds `["── run @ a ──", "  p1"]`, `["  on it"]`, `["  found the LEAK"]`, `["  LEAK again"]`, `["── run @ b ──", "  tidy"]` and `["  leak late"]` to one `createTranscriptFilter("leak")`. The non-null results are, in order, `["── run @ a ──", "  found the LEAK"]`, `["  LEAK again"]` and `["── run @ b ──", "  leak late"]`. An empty entry returns null.
- In test/gui.test.ts "gui /api/transcript serves rendered lines and validates role/n", after the `withPrompt` assertions with the same log: `/api/transcript?role=feature&n=10&grep=THING` returns lines deep-equal to `ok.lines`. The assistant turn's text and its tool call form one entry, and the run's separator opens it, so the one matching entry is the whole unfiltered view. `&grep=nomatch` returns `{ lines: [] }`, and `&grep=` (blank) returns lines deep-equal to `ok.lines`.
- The existing tests in test/log-commands-views.test.ts, including "logs --transcript --grep keeps matching entries under their run's separator", pass unchanged.
- `grep -n 'separatorShown' src/cli/log-commands.ts` prints nothing, and `grep -n 'createTranscriptFilter' src/cli/log-commands.ts src/ui/transcript.ts` prints lines from both files.
- `npm run test:gate` passes.

### Transcript search in the dashboard, part 2/2: the role drawer's Live transcript gets a search box that narrows it through `GET /api/transcript?…&grep=` (planned 2026-10-20 by the plan role; "requires part 1/2 landed"; touches src/ui/gui/gui-client-drawer.ts + docs/how-it-works.md + test/gui-client-drawer.test.ts)

**Goal.** Part 1/2 ("Transcript search in the dashboard, part 1/2") gives `GET /api/transcript` a `grep` parameter. This part gives the drawer's "Live transcript" section (`openRole`, src/ui/gui/gui-client-drawer.ts) a search box beside "Show prompts". While the box holds text, the panel shows only the matching entries, each under its run's separator. That is the dashboard twin of `tumwater logs --transcript <id> --grep <text>`.

**Approach.**
1. src/ui/gui/gui-client-drawer.ts:
   - Beside `let transcriptPrompts = false;`, add `let transcriptGrep = "";`, and reset it to `""` in `openRole` where `transcriptPrompts` is reset.
   - In `openRole`'s sec-head markup, put `<input type='search' id='transcriptgrep' class='input-sm' placeholder='Search transcript' aria-label='Search transcript' style='margin-left:auto'>` before the Show prompts button, and move the button's `margin-left:auto` to `margin-left:8px`. Before naming `input-sm`, check that it exists with `grep -rn 'input-sm' src/ui/gui`. When it is absent, reuse the class the `feedgrep` box uses (`grep -rn "feedgrep" src/ui/gui`). The markup is written only by `openRole`, so the 1 s poll never rewrites the box or wipes typing.
   - `refreshTranscript`: capture `const grep = transcriptGrep;` beside `prompts`. Append `(grep ? "&grep=" + encodeURIComponent(grep) : "")` to the URL. Drop a stale answer with `|| transcriptGrep !== grep` beside the `transcriptPrompts !== prompts` check. When `lines` is empty and `grep` is set, paint `<span class='muted'>No transcript entries match “` + esc(grep) + `”.</span>` instead of the "No transcript yet" text.
   - Add `function setTranscriptGrep(value) { transcriptGrep = String(value ?? "").trim(); refreshTranscript(true); }`.
   - Beside the drawer's existing `click` listener, register `$("drawer").addEventListener("input", (ev) => { if (ev.target && ev.target.id === "transcriptgrep") setTranscriptGrep(ev.target.value); });`.
   - Update the file's header comment, which describes the transcript and its "Show prompts" button, to mention the search box and `&grep=`.
2. docs/how-it-works.md: in the dashboard paragraph that part 1/2 edited, say that the drawer's search box sends that `&grep=`.

**Files.** src/ui/gui/gui-client-drawer.ts, docs/how-it-works.md, test/gui-client-drawer.test.ts.

**Acceptance criteria.** New tests in test/gui-client-drawer.test.ts, using `openDrawer`, `workingStatus`, and the env's `jsonCalls` and `responses`:
- "the transcript search box narrows the live transcript through &grep and resets per role": after `toggleRole("clean")`, call `setTranscriptGrep("  Leak ")` and await the fetch. `jsonCalls` then holds a path ending `&grep=Leak`, and the `transcript` panel paints the response's lines. `setTranscriptGrep("")` fetches a path without `&grep`. Opening another role (or closing and reopening "clean") fetches without `&grep`.
- "a transcript search with no match says so": a `responses` entry for the `&grep=nomatch` path returning `{ lines: [] }` paints a panel containing `No transcript entries match` and `nomatch`, escaped (also check `setTranscriptGrep("<b>")` paints `&lt;b&gt;`).
- The existing tests "the role drawer paints a working role's actions, metrics, runs, and transcript with the real formatters" and "transcriptHtml classifies run separators, tool calls, thinking, and warnings, escaping each line" pass unchanged.
- `grep -n "transcriptgrep" src/ui/gui/gui-client-drawer.ts` prints the markup line and the listener line.
- `npm run test:gate` passes.

### Pending-change overlaps: `tumwater diff --overlaps` lists every file that two or more roles' pending changes touch (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/change/change-data.ts + src/change/change-render.ts + src/cli/cli-query-commands.ts + src/cli/cli-flag-specs.ts + src/cli/help.ts + docs/cli.md + docs/invariants.md + test/cli-diff.test.ts + test/change-render.test.ts)

**Goal.** Ten feature instances work in parallel, and the event log for the day before planning showed 33 `conflict_handback` events (`tumwater logs --since 1d --count`). An operator has no direct way to see two pending changes colliding before the merge does. `tumwater diff` prints counts per role, and `diff --role a,b` prints whole patches the operator has to compare by eye. This plan adds `tumwater diff --overlaps [--json]`. It prints one line per repo-relative path that two or more roles hold, either committed ahead of main or uncommitted in the worktree. Each line names those roles. When planned, `grep -n "overlaps" src/cli/help.ts docs/cli.md src/change/*.ts` printed nothing, and PLANS.md/PLANS-DONE.md had no entry about pending-file overlaps. The dashboard's `GET /api/diff` (`handleDiff`, src/gui/gui-endpoints.ts) is out of scope and stays unchanged.

**Approach.**
1. src/change/change-data.ts: add the exported types `ChangeOverlap { path: string; roles: string[] }` and `ChangeOverlapsView { mainBranch: string; state: "no-base" | "ready"; overlaps: ChangeOverlap[] }`.
   - Add a pure exported `fileOverlaps(holdings: { role: string; files: string[] }[]): ChangeOverlap[]`. It keeps each path that two or more distinct roles hold. A role's duplicate path counts once. Roles stay in holdings order. Paths are sorted by plain `<` string comparison.
   - Add `collectChangeOverlaps(root)`. It resolves `mainBranch` once, the way `collectRoleChange` does (`loadConfigSafe` + `targetBranch(config?.baseBranch, await currentBranch(root))`). A missing base branch (`branchExists`) returns `{ mainBranch, state: "no-base", overlaps: [] }`.
   - Otherwise, for each id from `knownRoleIdsCached(root)`, resolve the checkout with `roleWorktreeDir` + `isUsableWorktree`, skipping a role with none. Its files are `aheadOfMainFiles(wt, mainBranch)` (src/git/git-diff.ts, only when `aheadOfMain(wt, mainBranch) > 0`) plus `changedFiles(wt)`. Run the roles through `Promise.all` like `collectTeamChanges`, then return `{ mainBranch, state: "ready", overlaps: fileOverlaps(holdings) }`.
   - `collectRoleChange` stays unchanged. Its patch computation is what this collector avoids.
2. src/change/change-render.ts: add `renderChangeOverlaps(view: ChangeOverlapsView)`:
   - `no-base` prints `main branch <mainBranch> does not exist`, the same line as the other views.
   - No overlaps prints `no file is touched by two pending changes`.
   - Otherwise it prints one line per overlap, `<path>: <role>, <role>`, with raw role ids, as `renderTeamChange` does.
3. src/cli/cli-flag-specs.ts: add `export const OVERLAPS_FLAG: FlagSpec = { names: ["--overlaps"] };` beside `STAT_FLAG`, with a one-line doc comment in the siblings' style.
4. src/cli/cli-query-commands.ts `cmdDiff`: add `OVERLAPS_FLAG` to the `rejectUnknownArgs("diff", …)` list. After `requireReadyRepo`, and before `parseRoleListScope`, check for `--overlaps`:
   - With `--role` present, `fail("diff --overlaps reads every role; drop --role")`.
   - With `--stat` present, `fail("diff --overlaps prints paths, not patches; drop --stat")`.
   - Otherwise `sayJsonOrRender(args, await collectChangeOverlaps(root), renderChangeOverlaps)` and return.
   - Update the function's doc comment to name the third form.
5. src/cli/help.ts: add a stanza `tumwater diff --overlaps [--json]` after the `diff --role` stanza. It says the command lists each file two or more roles' pending changes touch (committed ahead of main or uncommitted), one line per path naming those roles, and that `--json` prints `{mainBranch, state, overlaps}`. Shell completion derives flags from help stanzas (`helpStanzas`, src/cli/completion.ts), so no completion edit is needed.
6. docs/cli.md: in the "See a role's pending change" row, append that `tumwater diff --overlaps` lists each file two or more roles' pending changes touch, one line per path naming those roles (`--json`: `{mainBranch, state, overlaps}`).
7. docs/invariants.md, section "Role change view: every known role answers, degraded rather than failing, with a bounded patch": add `### INV-AU5: an overlap names a path only when two or more roles hold it, each role once` after INV-AU4. Its **Binds** line is `src/change/change-data.ts` (`fileOverlaps`, `collectChangeOverlaps`). Its **Pinned by** line names the two tests below. Extend the section's opening sentence to name `tumwater diff --overlaps`. Before writing, check that `grep -n 'INV-AU5' docs/invariants.md` prints nothing (it printed nothing when planned).

**Tests.**
- test/change-render.test.ts: add "fileOverlaps keeps only paths two or more roles hold, each role once". Call `fileOverlaps([{ role: "feature", files: ["b.md", "a.md", "a.md"] }, { role: "clean", files: ["a.md", "c.md"] }, { role: "bugfix", files: ["b.md", "a.md"] }])` (import from `../src/change/change-data.js`). Assert a deep-equal result of `[{ path: "a.md", roles: ["feature", "clean", "bugfix"] }, { path: "b.md", roles: ["feature", "bugfix"] }]`. Also assert that `renderChangeOverlaps` on `{ mainBranch: "main", state: "ready", overlaps: [] }` returns `no file is touched by two pending changes`, and on `state: "no-base"` returns `main branch main does not exist`.
- test/cli-diff.test.ts: add "diff --overlaps names each file two roles' pending changes touch". Use `seededFeatureRepo()`: feature commits widget.md. Then `const cleanWt = await ensureWorktree(repo, "clean", "main")`, write `widget.md` and `solo.md` there uncommitted, and run `cli(repo, "diff", "--overlaps")`. Assert exit 0 and that trimmed stdout equals `widget.md: feature, clean`, since `allRoleIds` orders feature before clean. Assert that `--json` parses to `{ mainBranch: "main", state: "ready", overlaps: [{ path: "widget.md", roles: ["feature", "clean"] }] }`.
- test/cli-diff.test.ts: add "diff --overlaps with no shared file says so, and rejects --role and --stat". On a bare `seededFeatureRepo()`, stdout trimmed is `no file is touched by two pending changes`. `diff --overlaps --role feature` and `diff --overlaps --stat` each exit non-zero, with stderr containing `drop --role` and `drop --stat` respectively.

**Acceptance.**
- `tumwater diff --overlaps` prints exactly the shared paths with their roles, or the no-overlap line, exit 0. A missing baseline prints the shared degradation line.
- The existing `diff`, `diff --role` and `diff --stat` tests in test/cli-diff.test.ts and test/change-data.test.ts pass unedited. `collectRoleChange` and `collectTeamChanges` are untouched (`git diff main -- src/change/change-data.ts` shows only additions).
- `grep -n "overlaps" src/cli/help.ts docs/cli.md docs/invariants.md` shows the new stanza, row text and INV-AU5.
- `npm run test:gate` passes.
- Overlap: "Report window" (in flight) may add a flag spec to src/cli/cli-flag-specs.ts and a stanza to src/cli/help.ts. Those are different lines, so the overlap is at most a rebase.

## Done
