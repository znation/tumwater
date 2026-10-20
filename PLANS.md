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

### Merge queue by role: `tumwater queue --role <id>[,<id>...]` lists only the listed roles' waiting merges, each under its whole-queue position (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/cli/cli-query-commands.ts + src/merge/merge-queue-render.ts + src/cli/help.ts + docs/cli.md + test/cli-queue.test.ts)

**Goal.** `status`, `logs`, `history`, `wake --list`, `reset-counters`, `resume` and `abort` all take `--role <id>[,<id>...]`, with a base role id taking its instances too. `tumwater queue` does not. `cmdQueue` (src/cli/cli-query-commands.ts) gates its arguments with `rejectUnknownArgs("queue", args, [JSON_FLAG])`, so `tumwater queue --role feature` is refused as an unknown flag. With ten feature instances queueing merges (the event log showed 1126 `merge_queued` events in the two days up to 2026-10-20), an operator who asks "where are feature's changes in the queue?" has to read the whole list. `grep -c 'queue --role' docs/cli.md PLANS.md PLANS-DONE.md` printed 0 for each file when this was planned.

**Approach.**
1. src/cli/cli-query-commands.ts `cmdQueue`: gate with `[ROLE_FLAG, JSON_FLAG]` (both already imported), then after `requireReadyRepo` take `const scope = parseRoleListScope(root, args);` (already imported; it fails with `unknownRoleMessage` on an unknown id and ROLE_VALUE_ERROR on an empty value, as `status --role` does). With a scope, keep each entry where `scope.includes(e.role) || scope.includes(baseRoleOf(e.role))` (the rule `scopeSnapshotToRoles` and `cmdLogs` use; `baseRoleOf` is already imported), and record each kept entry's 1-based position in `view.entries`. Pass the **kept** entries to `queueInFlight`. Then the in-flight label and `inFlight` show only for a marker naming an in-scope change, and INV-T3's rule (a marker shows only while a queued change it names is unfinished) holds for the scoped list unchanged.
2. `--json` with a scope prints the same `{entries, unreadable}` document (plus `inFlight` when present) with `entries` filtered. `unreadable` stays the whole queue's count, because an unreadable file cannot be attributed to a role. Without `--role`, the document and the text output do not change.
3. src/merge/merge-queue-render.ts `renderMergeQueue`: add a fourth optional parameter `scope?: { roles: readonly string[]; positions: readonly number[]; total: number }`, where `total` is the whole queue's entry count. With it:
   - each line's number is `scope.positions[i]` instead of `i + 1`;
   - the header reads `` `merge queue (${view.entries.length} of ${scope.total + view.unreadable}, --role ${scope.roles.join(",")}):` ``;
   - when no entry is kept but `scope.total + view.unreadable > 0`, the only line before the unreadable line is `` `no queued merges for ${scope.roles.join(",")} (merge queue holds ${scope.total + view.unreadable})` ``; with nothing queued at all it stays `merge queue empty`;
   - the trailing `(+N unreadable queue files skipped)` line is unchanged.
   Without `scope`, the output is unchanged. Update the function's doc comment to say so.
4. src/cli/help.ts: change the stanza's usage to `tumwater queue [--role <id>[,<id>...]] [--json]` and add one sentence: "--role keeps only the listed roles' merges (a base role id taking its instances too), each under its position in the whole queue; --json then lists only those entries". Shell completion derives flags from help stanzas (`helpStanzas`, src/cli/completion.ts), so it needs no separate edit.
5. docs/cli.md, row "Check state": change `` `tumwater queue [--json]` `` to `` `tumwater queue [--role <id>[,<id>...]] [--json]` `` and add the same rule to its parenthetical. The transcript-search plan edits the same table line (its `logs --transcript` text). If that plan merges first, this edit rebases onto it as a one-line conflict.

**Files.** src/cli/cli-query-commands.ts, src/merge/merge-queue-render.ts, src/cli/help.ts, docs/cli.md, test/cli-queue.test.ts. No invariants entry changes: INV-T3's bound functions (`queueInFlight`, `liveMergeMarker`) are not edited, only called with fewer entries.

**Acceptance criteria.** New tests in test/cli-queue.test.ts, using its `entry` helper, `enqueueMerge` and `cli`:
- "queue --role lists only the listed roles' merges under their whole-queue positions": enqueue `improve` (run 1), `feature-2` (run 2), `organize` (run 3), `feature` (run 4). `cli(repo, "queue", "--role", "feature")` exits 0. Its first line is `merge queue (2 of 4, --role feature):`, then lines matching `/^  2\. feature-2 run #2 · /` and `/^  4\. feature run #4 · /`, and no other entry lines. `--role improve,organize` yields lines numbered 1 and 3.
- "queue --role with no matching merge names the role and the queue depth": with the same queue, `--role clean` prints exactly `no queued merges for clean (merge queue holds 4)`, exit 0. On an empty queue, `--role clean` prints `merge queue empty`.
- "queue --role --json filters entries and keeps the unreadable count": `--role feature --json` parses to a document whose `entries` map to roles `["feature-2", "feature"]` and whose `unreadable` is 0.
- "queue --role rejects an unknown or empty role id": `--role nosuch` exits non-zero with stderr matching `/nosuch/`, and `--role ""` exits non-zero.
- The existing tests in test/cli-queue.test.ts pass unchanged, including "queue rejects an unknown flag, naming it" and "queue prints the in-flight label only while an orchestrator is alive".
- `grep -n 'tumwater queue \[--role' src/cli/help.ts docs/cli.md` prints a line from each file.
- `npm run test:gate` passes, including test/help.test.ts and test/completion.test.ts.

## Done
