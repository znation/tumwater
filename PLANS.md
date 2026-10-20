# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-19 by plan: merging this makes the live tumwater.json's `claude/…` model ids a load error, so the operator first migrates it — `model` loses the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }` (valid once parts 1/5-2/5 land) — then removes this note**

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

### Event log search: `tumwater logs --grep <text>` composes with `--since <duration>` (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/cli/log-commands.ts + src/cli/help.ts + docs/cli.md + test/cli-logs-filtering.test.ts + test/log-commands-views.test.ts)

**Goal.** An operator who wants to find something in the event log over a time window, such as "every warning naming merge.lock in the last 24h", cannot ask for it today. `cmdLogs` (src/cli/log-commands.ts) rejects `logs --grep x --since 1h` through `failRivalShapes("logs --grep", "--since", "--since is a filter of its own; --grep filters the -n view and its follow")`. The other filters already work with a window: `--type` and `--role` filter the `--since` window, and `history --grep` works with `history --since`. So the remaining option is to guess an `-n` count, which bounds the scan and not the time span, or to pipe `--since … --json` through a script. The plan role's own feed mining does that on every run. `--grep` is a filter like `--type`, and the window is a window. The rival rule is left over from before `--type` and `--role` were added.

**Approach.** One change in `cmdLogs`; the `-n` view, the follow and the transcript view stay the same.
1. In `cmdLogs`, inside the `if (grepPattern !== null)` block, delete the `--since` rival check (`if (rest.includes("--since")) failRivalShapes(...)`). Keep `rejectTranscriptViewRival(rest, "--grep", true)`. `--grep` with `-f`, `-n` and `--transcript` keeps today's behaviour, and `--since` keeps its own rivals (`-f`, `-n`, `--transcript`).
2. In the `--since` branch, filter the window with the composed rule: `const filtered = events.filter(feedFilter);`. This replaces the inline `typeFilter`/`roleFilter` lambda. The window, the `-n` tally and the follow then share the one predicate that the `feedFilter` comment already promises, and `--grep` matching still goes through `eventMatchesGrep` (INV-A3, which needs no change).
3. Empty-window prose in that branch. JSON mode stays silent. The text branch picks, in this order: when both `grepPattern` and `type` are set, `no events matching "<pattern>" or ${typeEmpty(type, typePieces)}`, the same line the `-n` view prints; when only `type` is set, `typeEmpty(type, typePieces)` as today; when only `grepPattern` is set, `no events matching "<pattern>" in ${durationLabel(ms)}`; otherwise the role/plain lines as today.
4. Update the comments that state the old rule: the `parseGrepFlag` preamble comment ("and --since is a filter of its own rather than a window to filter"), the `--type` comment ("Unlike --grep it composes with --since"), the `--role` comment ("Unlike --grep it composes with --since"), the `--since` branch comment ("it is NOT the --since rival --grep is"), and the `rejectTranscriptViewRival` doc comment. After the change each one should say that `--grep`, `--type` and `--role` all filter the `--since` window.
5. src/cli/help.ts `logs` synopsis text: in the `--grep` sentence, add that it composes with `--since`, the way the `--type` sentence says "(it composes with --since)". docs/cli.md "Check state" row: after `` `tumwater logs --grep <text>` `` add `(composes with `--since`, `--type`, `--role` and `--json`)`.

**Files.** src/cli/log-commands.ts, src/cli/help.ts, docs/cli.md, test/cli-logs-filtering.test.ts, test/log-commands-views.test.ts.

**Acceptance criteria.**
- New test in test/cli-logs-filtering.test.ts, "logs --since --grep filters the window, and an empty match is gentle prose". Seed the log as "logs --since --type filters the window, and an empty match is gentle prose" does: two `merge_failed` and one `review_rejected` inside the last hour, plus one `review_rejected` event 3 hours old whose reason also contains the pattern. Then assert:
  - `logs --since 1h --grep sloppy` exits 0 and prints the in-window review rejection but not the 3-hour-old one.
  - `logs --since 1h --grep sloppy --type merge_failed` exits 0 and prints the combined no-match line.
  - `logs --since 1h --grep nosuchtext` exits 0 and its stdout matches `/no events matching "nosuchtext" in/`.
  - The same with `--json` prints an empty stdout.
  - `logs --since 1h --grep sloppy --json` prints only NDJSON lines whose `type` is `review_rejected`.
- "logs --grep refuses the rival shapes, naming both flags" (test/cli-logs-filtering.test.ts) drops its `--grep x --since 1h` case and comment; its `--transcript` and `--prompt` cases stay. "logs rejects rival flag shapes, naming both flags in each failure" (test/log-commands-views.test.ts) drops its `--grep x --since 1h` assertion; the `--since` with `-f` and `-n` assertions stay.
- "logs --since --type filters the window, and an empty match is gentle prose", "logs --grep treats a flag-shaped pattern as text, not as the flag it spells" and "logs --grep: -n bounds the scanned window, not the printed rows" pass unchanged.
- `grep -n 'filter of its own' src/cli/log-commands.ts` and `grep -n 'Unlike --grep' src/cli/log-commands.ts` print nothing.
- `npm run test:gate` passes.

### Doctor: `tumwater doctor --kill-orphans --json` puts what it killed into the JSON report instead of refusing (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/cli.ts + docs/cli.md + test/doctor.test.ts)

**Goal.** A script or cron job that reaps leaked processes has no machine-readable way to do it. src/cli.ts's `doctor` case rejects `doctor --kill-orphans --json` through `failRivalShapes("doctor --kill-orphans", "--json", "it prints what it killed before the report")`, so the script has to choose between doing the kill and getting parseable output. That reason holds only for the text form: the kill lines come before the rendered report. In JSON the kill result can be one more field on the object, the way `report --failures` stopped being a `--since` rival once it had a data shape. `killOrphans` (src/doctor/doctor-orphans.ts) already returns a serializable `OrphanKillReport` (`{ killed, failed }` or `{ error }`). The open BUGS.md entry about two leaked `logs -f` processes says the doctor only detects them; this plan lets a scheduled `doctor --kill-orphans --json` reap them and record the result.

**Approach.** The change is confined to the `doctor` case in src/cli.ts. The text form, the exit code and `killOrphans` stay as they are.
1. Delete the `if (args.includes("--kill-orphans") && args.includes("--json")) failRivalShapes(...)` check. `failRivalShapes` then has no other use in src/cli.ts, so remove it from the `./cli/cli-args.js` import there or lint fails. Check with `grep -n failRivalShapes src/cli.ts`.
2. In the `--kill-orphans` branch, keep the result: `orphanKill = await killOrphans(root)` (a `let orphanKill: OrphanKillReport | undefined` declared before the branch; import the type from `./doctor/doctor-orphans.js`). Print `orphanKillLines(orphanKill)` and the blank line only when `--json` is absent, so JSON stdout stays one parseable document.
3. The JSON payloads: wherever `report` or `problemsOnly(report)` is passed to `sayJsonOrRender` under `--json`, pass `orphanKill === undefined ? payload : { ...payload, orphanKill }` instead. The field is added only when `--kill-orphans` ran, so `doctor --json` without it prints exactly what it prints today. Do not add `orphanKill` to the `DoctorReport` interface (src/doctor/doctor-checks.ts): the dashboard and TUI read `DoctorReport` and never run the kill through this path. The exit code still reads the full `report`'s `fail` rows.
4. Update the comment above the payload printing to say that `--kill-orphans` adds the kill result as `orphanKill`.
5. docs/cli.md, Audit row, `doctor` text: replace `not combinable with `--json`` with `with `--json`, the report gains an `orphanKill` field: the `killed` (pid, descendants, command) and `failed` (pid, reason) lists, or the process-table scan `error``. src/cli/help.ts needs no change: its `doctor` synopsis does not mention the rival rule (checked with `grep -n 'orphan' src/cli/help.ts`).

**Files.** src/cli.ts, docs/cli.md, test/doctor.test.ts.

**Acceptance criteria.**
- In test/doctor.test.ts, rename "doctor --kill-orphans reports an unreadable process table, then the report; --json is rejected" to "doctor --kill-orphans reports an unreadable process table, then the report; with --json it is the report's orphanKill field". Keep its text-form assertions. Replace the rejection assertions with these, using the same no-`ps` env (`{ PATH: gitOnlyBinDir() }`, which keeps the scan off the host's real process table):
  - `doctor --kill-orphans --json` exits 1. Its whole stdout parses with `JSON.parse`. `orphanKill.error` is a non-empty string, `checks` holds an `orphans` row at level `warn`, and stdout does not contain `nothing killed` outside the JSON (the parse succeeding proves no text line came first).
  - `doctor --kill-orphans --problems --json` parses too. Its `orphanKill.error` is set and its `checks` holds no `ok` row.
  - `doctor --json` without `--kill-orphans` has no `orphanKill` key.
- `grep -n 'cannot be combined with --json\|not combinable with `--json`' src/cli.ts docs/cli.md test/doctor.test.ts` prints nothing.
- `npm run test:gate` passes.

## Done
