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


### The TUI's change step lists the viewed role's waiting merges above its change, the terminal twin of `tumwater queue --role <id>` and the dashboard drawer's Merge queue section (planned 2026-10-20 by the plan role; independent of every eligible Planned entry. "Pending-change overlaps" edits `cmdDiff` in src/cli/cli-query-commands.ts and this plan edits `cmdQueue` in the same file, so whichever lands second rebases. No other Planned entry touches src/merge/merge-queue-render.ts or src/ui/tui/tui-pane-transcript.ts. Touches src/merge/merge-queue-render.ts + src/cli/cli-query-commands.ts + src/ui/tui/tui-pane-transcript.ts + docs/how-it-works.md + docs/cli.md + test/cli-queue.test.ts + test/tui-keys.test.ts)

**Goal.** `tumwater queue --role <id>` and the dashboard role drawer (`drawerQueueHtml`, src/ui/gui/gui-client-pending.ts) both show one role's waiting merges, each under its whole-queue position. The TUI does not. Its per-role pane cycles live transcript → notes → change with Ctrl+N (`createTranscriptPane`, src/ui/tui/tui-pane-transcript.ts). The change step shows only `renderRoleChange`, the role's branch, commits and diff. An operator looking at `clean`'s change cannot see that the change is already queued at position 4. This plan prepends the role's queue lines to that step. When planned, `grep -rn "scopeMergeQueue" src test PLANS.md PLANS-DONE.md` printed nothing, and src/ui/tui/tui-pane-transcript.ts did not import from src/merge.

**Approach.**
1. src/merge/merge-queue-render.ts: add a pure exported `scopeMergeQueue(whole: MergeQueueView, roles: readonly string[], keep: (role: string) => boolean)`. It returns `{ view, scope }`. `view` is `{ ...whole, entries: whole.entries.filter(...) }` with the entries where `keep(e.role)` holds. `scope` is `{ roles, positions, total: whole.entries.length }`, where `positions` holds each kept entry's 1-based index in `whole.entries`. This is the exact filter `cmdQueue` (src/cli/cli-query-commands.ts) builds inline today. Give it a doc comment saying that `unreadable` stays whole.
2. src/cli/cli-query-commands.ts `cmdQueue`: replace the inline `positions`/`view` filter with `scopeMergeQueue(whole, roles, (r) => roles.includes(r) || roles.includes(baseRoleOf(r)))` when `roles` is set, and keep `whole` with no scope otherwise. The output must not change. The existing `queue --role` tests in test/cli-queue.test.ts must pass unedited. The file's `baseRoleOf` import stays, since other commands there use it.
3. src/ui/tui/tui-pane-transcript.ts, in the notes → change branch of the Ctrl+N arm, before `session.collectChange` is called: compute `queueText` synchronously. Read `readMergeQueue(session.root)` and call `scopeMergeQueue(whole, [role], (r) => r === role)`. Use exact match because the TUI pane is one concrete runner: the bare `feature` is instance 1, and `baseRoleOf` would wrongly pull `feature-2`'s merges into it. When the scoped view has at least one entry, set `queueText` to `renderMergeQueue(view, session.now(), queueInFlight(session.root, view.entries, orchestratorAlive(session.root)), scope) + "\n\n"`. This is the same import set src/ui/tui/tui-pane-pending.ts uses. Otherwise set `queueText` to `""`, so a role with nothing queued keeps today's pane byte for byte. Wrap the read in try/catch. On a throw, set `queueText = ""` and call `session.flashError(err)`, following the notes branch's pattern. The resolve callback then sets `changeCache = queueText + renderRoleChange(change)`. The loading state stays as it is: `changeCache` is null until the collector resolves.
4. docs/how-it-works.md: in the TUI paragraph's sentence about the change step ("the change step is the role's collected unmerged work — …"), add that the change step is headed by the role's waiting merges under their whole-queue positions when it has any, mirroring `tumwater queue --role <id>`. docs/cli.md: in the TUI-keys row `` `Ctrl+N` | Transcript ``, change "pending change" to "pending change (headed by the role's waiting merges)".

**Tests.**
- test/cli-queue.test.ts: import `scopeMergeQueue` from ../src/merge/merge-queue-render.js and add "scopeMergeQueue keeps the matching entries under their whole-queue positions". Use three entries with roles `feature`, `clean`, `clean-2` and `unreadable: 1`. With `keep = (r) => r === "clean"`, assert `view.entries` has the one `clean` entry, `scope.positions` is `[2]`, `scope.total` is 3, and `view.unreadable` is 1.
- test/tui-keys.test.ts: add "Ctrl+N's change step heads the change with the viewed role's queued merges". Follow the existing "Ctrl+N cycles transcript → notes → change and back, caching the collector's render" test: `makeRoot()`, `createTuiKeys` with `collectChange: () => Promise.resolve(view)`, and `syncSnapshot(0, false, ["clean"], false)`. Before entering, call `enqueueMerge(root, …)` (already imported from ../src/merge/merge-queue.js) for `feature` run 3, then `clean` run 5 with summary "queued clean", then `clean-2` run 7, using enqueuedAt 0, 1 and 2. Press Ctrl+T then Ctrl+N twice, and await the collector. Assert that `keys.state().changeCache` starts with `"merge queue (1 of 3, --role clean):\n  2. clean run #5"`, ends with `renderRoleChange(view)`, and matches neither `/clean #2/` nor `/feature run #3/`. The existing Ctrl+N cycle test, with nothing queued, must still pass unedited; that is the no-queue case.

**Acceptance.**
- In the TUI, the change step of a role with waiting merges begins with the `tumwater queue --role <id>` text for exactly that runner id. A role with none shows the change exactly as before.
- `tumwater queue` and `tumwater queue --role` output is unchanged: the existing test/cli-queue.test.ts tests pass unedited.
- `grep -n "scopeMergeQueue" src/cli/cli-query-commands.ts src/ui/tui/tui-pane-transcript.ts` shows one call in each.
- `npm run test:gate` passes.

## Done
