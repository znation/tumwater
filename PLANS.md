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

### Archive: `tumwater archive --json` prints what moved and the commit as data (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/cli.ts + src/backlog/backlog-cli.ts + src/cli/help.ts + docs/cli.md + test/backlog-archive.test.ts)

**Goal.** A script that runs `tumwater archive` and wants to know which entries moved, or which commit it made, has to scrape lines like `PLANS.md → PLANS-DONE.md: 1 entry` and `committed <short sha>`. The short sha is the only form of the commit it gets. `archiveFinishedOnMain` (src/backlog/backlog-archive.ts) already returns structured data: `{ status: "archived", commit, moved: ArchivedFile[] }`, where each `ArchivedFile` carries `file`, `archive`, `titles` and `dropped`. But cli.ts's `case "archive"` calls `rejectUnknownArgs("archive", args, [])`, so `--json` is refused. This plan follows the other in-flight `--json` twins for write commands (revert, reclaim --dry-run, doctor --kill-orphans).

**Approach.**
1. src/cli.ts `case "archive"`: change the gate to `rejectUnknownArgs("archive", args, [JSON_FLAG])`. `JSON_FLAG` is already imported there from ./cli/cli-flag-specs.js. Then call `cmdArchive(root, args)`.
2. src/backlog/backlog-cli.ts `cmdArchive(root, args: string[] = [])`: read `const json = args.includes("--json")`. The `skipped` outcome still goes through `fail`: one stderr line, exit 1, nothing on stdout, the same as `retire --json`. With `json`, the `nothing` outcome prints `sayJson({ archived: false, commit: null, moved: [] })` and the `archived` outcome prints `sayJson({ archived: true, commit: outcome.commit, moved: outcome.moved })`. `commit` is the full sha, and `moved` is the `ArchivedFile[]` exactly as returned. `sayJson` is already imported there. The text output stays as it is. Add a doc comment on `cmdArchive` that names the `--json` shape.
3. src/cli/help.ts: change the stanza `tumwater archive` to `tumwater archive [--json]`, and end its description with `; --json prints what moved and the commit as data`, re-wrapped to the column. Shell completion reads flags from help stanzas (`helpStanzas`, src/cli/completion.ts), so it needs no separate edit.
4. docs/cli.md, "Steer the project" row: after the `tumwater archive` sentence's "…so the live files hold only open work", add `` (`--json` prints `{ archived, commit, moved }`, each moved file carrying `file`, `archive`, `titles` and `dropped`; `commit` is the full sha, or `null` when there was nothing to archive) ``. Also change the `tumwater archive` there to `tumwater archive [--json]`.

**Files.** src/cli.ts, src/backlog/backlog-cli.ts, src/cli/help.ts, docs/cli.md, test/backlog-archive.test.ts. src/backlog/backlog-archive.ts is unchanged (`ArchivedFile` stays unexported, and the payload is built from the returned outcome). `grep -n 'cmdArchive' docs/invariants.md` prints nothing, so this plan claims no invariant ID.

**Acceptance criteria.**
- New test in test/backlog-archive.test.ts, "tumwater archive --json prints what moved and the full commit sha, then archived false". Use the same seeding as the existing "tumwater archive dispatches through the CLI…" test (`initializedRepo`, `ignoreInRepo`, a D1 done plan and a B1 fixed bug, committed). `cli(root, "archive", "--json")` exits 0. Its whole stdout passes `JSON.parse` with `archived: true` and `commit` equal to `sh(root, "git", "rev-parse", "HEAD").trim()`. `moved` deep-equals two entries: `{ file: "PLANS.md", archive: "PLANS-DONE.md", titles: [<D1 heading as archiveFinishedOnMain reports it>], dropped: [] }` and the matching BUGS.md one. Derive the titles from the JSON's own order, or assert `titles.length === 1` and that each title contains `D1` or `B1`. A second `cli(root, "archive", "--json")` exits 0 and parses deep-equal to `{ archived: false, commit: null, moved: [] }`.
- `cli(root, "archive", "--stat")` still exits 1 with the unknown-flag refusal. Check that in the same test.
- The existing text test "tumwater archive dispatches through the CLI…" passes unchanged.
- `npm run test:gate` passes, including test/help.test.ts and the completion tests.

## Done
