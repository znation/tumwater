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

### Dashboard event-log window: `GET /api/logs?sinceMs=` serves the event feed of a trailing time window, the twin of `tumwater logs --since <duration>` (planned 2026-10-20 by the plan role; independent of every eligible plan. Touches src/gui/gui-endpoints.ts `handleLogs` + test/gui-endpoints.test.ts. "Dashboard API window end" edits `handleReport`/`handleHistory` in the same file and src/gui/gui-args.ts; this plan edits neither of those functions nor gui-args.ts)

**Goal.** `tumwater logs --since 2h` (`cmdLogs`, src/cli/log-commands.ts) prints every event of a time window through `readEventsSince` (src/events/event-window.ts), with the sparse-window note when the log does not reach back that far. The dashboard's event search, `handleLogs` (src/gui/gui-endpoints.ts), only knows `?n=` — the newest N events, clamped to `LOGS_SEARCH_MAX_EVENTS` — so "which events matched `land` in the last 6h" cannot be asked of the server, and a busy log's 6h can exceed any count. `/api/history` already has the window shape (`?sinceMs=`, `sinceMsQuery`, `LOGS_SINCE_MAX_MS`, `covered`/`note`); `/api/logs` gets the same one.

Behavior, decided:
- `?sinceMs=S` answers `{ events, covered, note }`: `events` are `readEventsSince(root, S).events` filtered by the existing `role` and `grep` rules, oldest-first as `eventFeedItem` objects; `covered` is `readEventsSince`'s `covered`; `note` is `SPARSE_WINDOW_NOTE` when `covered` is false, else `""` — the `/api/history` window shape.
- `sinceMs` with `n` is a 400 with `handleHistory`'s wording: `"sinceMs cannot be combined with n (a count and a window are rival shapes)"` (the CLI's "-n and --since are rival shapes").
- `sinceMs` parses through `sinceMsQuery(q, res, LOGS_SINCE_MAX_MS, (ms) => \`sinceMs is capped at ${humanSeconds(LOGS_SINCE_MAX_MS / 1000)} (got ${ms})\`)` — the same call `handleHistory` makes, so the cap and wording match `logs --since`/`history --since`.
- No row cap in the window branch: `logs --since` prints the whole window, and `LOGS_SINCE_MAX_MS` already bounds its span.
- Without `sinceMs`, the response is unchanged (`{ events }`, n-scanned).
- No dashboard client change (src/ui/gui/gui-client-feed.ts keeps calling `?n=`); a window picker for the feed is a later plan. `untilMs` on this endpoint is also a later plan, once "Dashboard API window end" has landed `untilMsQuery`.

**Approach.** src/gui/gui-endpoints.ts:
1. Import `readEventsSince` from ../events/event-window.js (extend an existing event-window import line) and `sinceMsQuery` from ./gui-args.js if not already imported (`handleHistory` uses it, so it is; verify with grep). `humanSeconds` is already in scope (used by `handleHistory`).
2. In `handleLogs`, read `role`, `grep` and `needle` first, and build `const keep = (e: HarnessEvent) => (role === null || eventRole(e) === role) && (needle === null || eventMatchesGrep(e, needle));` (import the `HarnessEvent` type if it is not in scope). Then, before the `n` parse: `if (q.get("sinceMs") !== null) { if (q.get("n") !== null) { badRequest(...); return; } const sinceMs = sinceMsQuery(...); if (sinceMs === null) return; const { events, covered } = readEventsSince(root, sinceMs); sendJson(res, 200, { events: events.filter(keep).map(eventFeedItem), covered, note: covered ? "" : SPARSE_WINDOW_NOTE }); return; }`. The existing n branch then filters with `keep`, unchanged in behavior.
3. Update the doc comment's first line to `GET /api/logs?n=N|sinceMs=S[&grep=<text>][&role=<id>]` and add a sentence describing the window branch (readEventsSince, the rival-shape 400, the LOGS_SINCE_MAX_MS cap, covered/note as /api/history's window answers).

**Tests** (test/gui-endpoints.test.ts, using `serveLogs` and `writeEvents`):
- New "handleLogs ?sinceMs serves the trailing window's events, composing grep and role". Seed with `ts: Date.now() - …`: a feature `run_end` summary "landed old" at now−3h, a feature `run_end` summary "landed new" at now−30min, a bugfix `run_end` summary "landed other" at now−20min. `?sinceMs=3600000` → status 200, two events (the 30min and 20min ones, oldest-first), `covered === true`, `note === ""`. `?sinceMs=3600000&role=feature` → only the 30min one. `?sinceMs=3600000&grep=other` → only the bugfix one. Assert on each item's `ts` (`eventFeedItem` returns `{ ts, source, type, result?, message }`).
- New "handleLogs refuses sinceMs with n, a malformed sinceMs, and one over the cap". `?sinceMs=3600000&n=5` → 400 matching /rival shapes/; `?sinceMs=abc` and `?sinceMs=0` → 400; `?sinceMs=${LOGS_SINCE_MAX_MS + 1}` → 400 matching /capped at/ (import `LOGS_SINCE_MAX_MS` from ../src/events/event-window.js if the file does not already).
- The existing handleLogs tests pass unchanged (the n branch still answers `{ events }` only).

**Acceptance criteria.**
- `/api/logs?sinceMs=S[&role=][&grep=]` answers `{ events, covered, note }` holding exactly the role/grep-matching events with `ts >= now − S`, oldest-first as feed items.
- `sinceMs` with `n`, a non-positive or malformed `sinceMs`, or one above `LOGS_SINCE_MAX_MS` is a 400.
- Requests without `sinceMs` answer as before; the existing `handleLogs` tests pass unchanged.
- `npm run test:gate` passes.

## Done
