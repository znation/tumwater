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

### Event log window: `tumwater logs --since <duration> --until <duration>` shows a bounded past window that ends before now (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/cli/cli-args.ts + src/cli/cli-flag-specs.ts + src/cli.ts + src/cli/log-commands.ts + src/cli/help.ts + docs/cli.md + test/cli-logs-filtering.test.ts)

**Goal.** `tumwater logs --since <duration>` always ends its window at now. To look at an incident from 3 days ago (say, a connection-error storm), an operator has to ask for `--since 4d`, which also prints every later event, often thousands of rows. `-n` cannot help, because it counts back from now and is a rival shape to `--since`. This plan adds `--until <duration>`, which ends the `--since` window that long ago. `--since 4d --until 3d` then shows one past day, and it composes with `--grep`, `--type`, `--role`, `--count` and `--json` exactly as the plain window does. `grep -rn -- '--until' src docs/cli.md` printed nothing when planned, and `grep -n -- '--until' PLANS-DONE.md BUGS-FIXED.md` printed nothing. `history --since` stays as it is; this plan is `logs` only.

**Approach.**
1. src/cli/cli-args.ts `parseSinceFlag(args, label, maxMs)`: add a fourth parameter `flag = "--since"` and read `flagValue(args, flag)`. Existing callers are unchanged. Update its doc comment to say the flag defaults to `--since`.
2. src/cli/cli-flag-specs.ts: beside `sinceFlagSpec`, export `LOGS_UNTIL_FLAG: FlagSpec = { names: ["--until"], value: true, valueName: "<duration>", missingValue: "logs --until needs a value", validate: (value) => { parseDurationFlag("logs --until", value); } }`, with a one-line doc comment. `parseDurationFlag` is already used there by `sinceFlagSpec`. src/cli.ts `case "logs"`: add `LOGS_UNTIL_FLAG` to the `rejectUnknownArgs("logs", …)` list right after `sinceFlagSpec("logs --since")`, and import it from ./cli/cli-flag-specs.js beside the other specs.
3. src/cli/log-commands.ts `cmdLogs`: right after `const ms = parseSinceFlag(rest, "logs --since", LOGS_SINCE_MAX_MS);`, add `const untilMs = parseSinceFlag(rest, "logs --until", LOGS_SINCE_MAX_MS, "--until");`. Then:
   - `if (untilMs !== null && ms === null) fail("logs --until requires --since");`. This one rule also covers `-f`, `-n` and `--transcript` without `--since`.
   - `if (untilMs !== null && ms !== null && untilMs >= ms) fail(`logs --until (${durationLabel(untilMs)}) must be shorter than --since (${durationLabel(ms)})`);`. Both checks run before any read.
   - Inside the `if (ms !== null)` branch, after `readEventsSince` returns, keep only `e.ts < cutoff + ms - untilMs` when `untilMs !== null`. Use destructured `cutoff`, so the upper edge is the same `now` the lower edge used. Apply this before `feedFilter`, so `--count`, the filters and the empty-window prose all see the bounded window.
   - Replace the three `in ${durationLabel(ms)}` phrases in the empty-window prose with one `windowPhrase`. It is `in ${durationLabel(ms)}` without `--until`, and `between ${durationLabel(ms)} and ${durationLabel(untilMs)} ago` with it. The no-`--until` output stays as it is.
   - `covered` and `SPARSE_WINDOW_NOTE` are unchanged: coverage is about the window's far edge, which `--until` does not move.
   - Add `[--until <duration>]` to the doc comment's synopsis on `cmdLogs`.
4. src/cli/help.ts: in the `tumwater logs` stanza's synopsis, add `[--until <duration>]` right after `[--since <duration>]`. After "events of the past window (capped at 7d)", add `; --until ends that window the given duration ago (requires --since)`, re-wrapped to the column. Shell completion reads flags from the help stanzas (`helpStanzas`, src/cli/completion.ts), so it needs no separate edit.
5. docs/cli.md, "Check state" row: change `` `tumwater logs --since <duration>` `` to `` `tumwater logs --since <duration> [--until <duration>]` (`--until` ends the window that long ago, so `--since 4d --until 3d` shows one past day; it requires `--since`, must be shorter than it, and composes with every filter `--since` does) ``.

**Files.** src/cli/cli-args.ts, src/cli/cli-flag-specs.ts, src/cli.ts, src/cli/log-commands.ts, src/cli/help.ts, docs/cli.md, test/cli-logs-filtering.test.ts. src/events/event-window.ts is unchanged. INV-A3 in docs/invariants.md binds `cmdLogs` only for the feed's shape and grep rule, which this plan does not change, so it claims no invariant ID.

**Acceptance criteria.** All the tests are new, in test/cli-logs-filtering.test.ts, and use its existing `seedEvents(repo, agesMs)` helper.
- "logs --since --until prints only the events between the two edges, oldest-first": seed ages `[3 * 86_400_000, 2 * 86_400_000 - 3_600_000, 30 * 3_600_000, 2 * 3_600_000]`. `cli(repo, "logs", "--since", "2d", "--until", "1d")` exits 0. Stdout contains `run #2 started` before `run #3 started`, and contains neither `run #1 started` nor `run #4 started`. In the same test, `cli(repo, "logs", "--since", "2d", "--until", "1d", "--count", "--json")` parses to `{ run_start: 2 }`.
- "logs --until with an empty window names both edges": seed `[10 * 60_000]`. `cli(repo, "logs", "--since", "2h", "--until", "1h")` exits 0, and its stdout matches `/no events between 2h and 1h ago/`.
- "logs --until is refused without --since or when not shorter": `cli(repo, "logs", "--until", "1h")` exits 1 with stderr matching `/logs --until requires --since/`. `cli(repo, "logs", "-f", "--until", "1h")` fails the same way. `cli(repo, "logs", "--since", "1h", "--until", "2h")` and `… "--until", "1h"` each exit 1 with stderr matching `/logs --until \(.*\) must be shorter than --since/`. `cli(repo, "logs", "--since", "1h", "--until")` exits 1 with stderr matching `/logs --until needs a value/`.
- The existing test "logs --since prints only the events of the window, oldest-first" passes unchanged.
- `npm run test:gate` passes, including test/help.test.ts and test/completion.test.ts.

## Done
