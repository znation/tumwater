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

### TUI History trail transcript search: `/` on a run trail whose transcript is showing keeps only the transcript entries that contain the text, the terminal twin of `tumwater history <role> <n> --transcript --grep <text>` (planned 2026-10-20 by the plan role; the CLI and the dashboard History drill-down's transcript search box already narrow one run's transcript through `runTranscriptLines`' `grep` option, but the TUI History trail's Ctrl+R transcript (`loadTranscript` in src/ui/tui/tui-pane-history.ts) never passes `grep`, and `/` on that view only sets `historyGrep`, which filters the run rows. Independent of every eligible plan. Touches src/ui/tui/tui-pane-history.ts, tui-panes.ts, tui-keys.ts, tui-editor-ctx.ts, tui-editor-search.ts, tui-frame.ts, tui.tsx, test/tui-keys.test.ts, test/tui-frame.test.ts and docs/cli.md's TUI key table. "Failure digest window" also edits docs/cli.md, but in its "Audit" row, not the key table)

**Goal.** On the TUI History trail (Ctrl+N), Ctrl+R shows the run's agent transcript, but nothing can search it. Today `/` on that view sets `historyGrep`, so it filters the runs the trail steps through. The fix follows the CLI's own rule: `history <role> <n> --grep` needs `--transcript` and then filters the transcript (`cmdRunDetail` in src/run/run-detail.ts). So while a trail's transcript is showing (`trailTranscript !== "off"`), `/` searches that transcript. Otherwise `/` keeps today's run-row search. This settles which pane state `/` targets: the transcript search exists only while the transcript is visible. To change the run filter from a trail, press Ctrl+R until the transcript is off, then press `/`.

**Approach.**
- `src/ui/tui/tui-pane-history.ts`:
  - Add `let trailGrep: string | null = null;` beside `trailTranscript`, with a comment saying it is set only while `trailTranscript !== "off"`.
  - `loadTranscript` passes `grep: trailGrep ?? undefined` to `runTranscriptLines`. On no match, its existing `found`/`note` fallback then shows the miss note `(no transcript entries matching "<text>" in <role> run <n>)`.
  - `applySearch`: when `trailMode && trailTranscript !== "off"`, set `trailGrep = pattern`, call `loadTranscript()` then `composeTrail()`, set `session.paneScroll = 0`, and return. Leave `historyGrep` and `session.paneCache` alone (the run rows stay as they are). Otherwise keep the current body unchanged.
  - Clear `trailGrep = null` everywhere `trailTranscript` goes back to `"off"`: the Ctrl+N toggle-off branch, `reset()`, and the Ctrl+R arm when its cycle lands on `"off"`. Ctrl+P (`loadTrail` → `loadTranscript`) and the plain↔prompts step keep the pattern, so the same search follows older runs and the prompts level.
  - `state()` returns `trailGrep`.
- `src/ui/tui/tui-keys.ts`: add `trailGrep: string | null` to the state interface next to `trailTranscript`, with a doc line. `src/ui/tui/tui-panes.ts`: copy `trailGrep: hist.trailGrep` in the state aggregation next to `trailTranscript`.
- `src/ui/tui/tui-editor-ctx.ts`: add `trailSearch: boolean` (true when `/` on History targets the trail's transcript) and `trailGrep: string | null`, each with a doc line. `editorCtx` in tui-panes.ts sets `trailSearch: s.trailMode && s.trailTranscript !== "off"` and `trailGrep: s.trailGrep`. That function is the only place that builds a `TuiEditorCtx`.
- `src/ui/tui/tui-editor-search.ts`, at the `/` open arm: for `searchFor === "history"`, pre-fill from `ctx.trailSearch ? ctx.trailGrep : ctx.historyGrep`. The flash noun becomes `"transcript"` instead of `"runs"` when `ctx.trailSearch` is true. Enter still calls `session.applyHistorySearch(applied)`, and the pane routes it. `searchFor` and the editor's other arms stay as they are. The trail state cannot change while the editor holds the line, because Ctrl+N/P/R all check `promptLineFree`.
- `src/ui/tui/tui-frame.ts`: add `trailGrep?: string | null` to the `history` view kind. In the History hint, the `/` entry becomes `view.trail && view.trailTranscript !== undefined && view.trailTranscript !== "off" ? (view.trailGrep ? \`transcript search: ${view.trailGrep}\` : "search transcript") : (view.grep ? \`search: ${view.grep}\` : "search")`. `src/ui/tui/tui.tsx`: pass `trailGrep: s.trailGrep` in the history view object.
- `docs/cli.md`, TUI key table: the `/` row's parenthetical adds "on a History run trail whose transcript is showing (Ctrl+R), keep only that run's transcript entries containing the text, like `history <role> <n> --transcript --grep`". The `Ctrl+R` History row adds "turning the transcript off drops its search".
- Anchors are symbol-level; no line numbers.

**Files touched.** `src/ui/tui/tui-pane-history.ts`, `src/ui/tui/tui-panes.ts`, `src/ui/tui/tui-keys.ts`, `src/ui/tui/tui-editor-ctx.ts`, `src/ui/tui/tui-editor-search.ts`, `src/ui/tui/tui-frame.ts`, `src/ui/tui/tui.tsx`, `docs/cli.md`, `test/tui-keys.test.ts`, `test/tui-frame.test.ts`.

**Acceptance criteria.**
- New tests in `test/tui-keys.test.ts` use the existing `historyTrailRoot`, `writeTrailPiLog` and `openHistory` helpers, plus `readRunDetail`/`runTranscriptLines`/`renderRunDetail` the "Ctrl+R on the History trail cycles…" test already imports:
  - Open the trail (Ctrl+N) and press Ctrl+R (plain). Then `/`, type `said-one`, Enter. `state().trailGrep` is `"said-one"`, `state().historyGrep` stays `null`, and `trailCache` equals `${renderRunDetail(detail)}\n\n${runTranscriptLines(root, "clean", 1, detail, { grep: "said-one" }).found.join("\n")}`.
  - A pattern with no match (`/`, `zzz-none`, Enter) makes `trailCache` end with `runTranscriptLines(root, "clean", 1, detail, { grep: "zzz-none" }).note`.
  - Re-opening `/` pre-fills `state().input` with the applied transcript pattern.
  - Ctrl+R to `prompts` keeps `trailGrep`. Ctrl+R to `off` sets `trailGrep` to `null` and `trailCache` to the bare detail. After that, `/` + `clean` + Enter sets `historyGrep` (today's run-row search) and leaves `trailGrep` `null`.
  - Ctrl+N off and back on starts with `trailGrep` `null`.
- `test/tui-frame.test.ts`, next to the existing Ctrl+R hint assertions: `hint({ kind: "history", …, trail: true, trailTranscript: "plain" })` matches `/\/ search transcript/`. With `trailGrep: "x"` it matches `/transcript search: x/`. With `trailTranscript: "off"` and `grep: "y"` it still matches `/search: y/`.
- The existing `/` History tests ("the Activity and History `/` searches are independent…") pass unchanged.
- `npm run test:gate` passes.

## Done
