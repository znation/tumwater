# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### 7a/7 — Resolve the project brief as `TUMWATER.md`, with README.md as the compatibility path (planned 2026-09-26, split from 7/7)

**Needs review 2026-09-23 by feature: too large for one run** (14 source/test files touched) — resolved 2026-09-26 by splitting 7/7 into this plan (7a) and 7b/7.

**Goal.** `readInitialPrompt` (src/readme.ts) reads the brief only out of README.md's managed section, so the readme role owns a status block inside the project's own README — a non-starter for adopting an existing codebase (7b/7). Make the brief's home resolvable: `TUMWATER.md` first, README.md as the compatibility path, with no behavior change for repos that only have README.md. Design rationale and the 09-18/09-24 audit pins live in plans/portability.md §7/7 (its corrections 2, 3 and 8); line anchors below were re-verified 2026-09-26 and some have drifted a few lines since the audit — treat the audit's pins as indicative and re-`grep` before editing.

**Series.** Part 7/7 of the portability series, first half. Depends only on 2/7 ✓ (done). 7b/7 depends on this.

**Approach.**
- src/paths.ts — `briefCandidates(root)`: the `TUMWATER.md`-then-`README.md` pair, named beside `configPath`/`exampleConfigPath` (paths.ts:20–27 pattern).
- src/readme.ts (60 lines) — `readInitialPrompt` resolves over the candidates (same parse-trim-cap shape per file: start-marker-first ordering guard :51, the `INITIAL_PROMPT_MAX_CHARS` cap :54/:59); `briefFile(root)` returns whichever file owns the managed sections, or null when neither exists; `readmeTemplate` gains a `briefTemplate(projectName, prompt)` sibling writing the same two managed sections for `TUMWATER.md` (7b's adopt path writes it); export `STATUS_START`/`STATUS_END` (module-private :16–17 today) so the readme role can target the resolved file.
- src/loop.ts — beside `readInitialPrompt(this.root)` (:174 per the 09-24 audit), compute `const brief = briefFile(this.root) ?? "README.md"` and feed it to BOTH prompt builders.
- src/prompt.ts — `TickPromptInput` gains `briefFile: string`; `COMMON_RULES` (:53, embedded by both `buildTickPrompt` and `buildDirectorPrompt`) stops hardcoding README.md at its two mentions (:84 "First read README.md in full" → "First read the project brief (<briefFile>) in full", and :111 the initial-prompt-block rule).
- src/roles.ts — `plan.find` and `readme.find` (the audit pinned :135/:151) name the project brief file instead of README.md.
- src/doctor.ts — the `init` check (or a sibling `brief` entry in the checks array, which has gained `fallback` and `build` entries since the audit) reports which file holds the brief.
- Tests: test/readme.test.ts (94 lines; the `writeReadme` helper stays, a `writeBrief` helper joins it) gains the resolution-order cases; test/prompt.test.ts updates the `/First read README\.md in full/` pin (audit: :571); test/doctor.test.ts covers the brief report; test/init.test.ts's two guards (:121, :147) now read the marked brief wherever it lives — a marked `TUMWATER.md` satisfies the `!prompt` re-seed path and silences the marker-less-README throw (correction 3: apply candidate resolution to BOTH guards, not only the README one).

**Files touched.** src/paths.ts, src/readme.ts, src/loop.ts, src/prompt.ts, src/roles.ts, src/doctor.ts, test/readme.test.ts, test/prompt.test.ts, test/doctor.test.ts, test/init.test.ts (the guard tests only).

**Acceptance criteria.**
- `readInitialPrompt` returns `TUMWATER.md`'s prompt markers when that file exists, else README.md's; a marked `TUMWATER.md` beats a marked README.md (ordering test).
- A repo with only README.md behaves byte-for-byte as today — every existing readme/init/prompt test passes unmodified.
- The readme role writes its status block into the resolved brief file; `tumwater doctor` names which file holds it.
- Both `buildTickPrompt` and `buildDirectorPrompt` name the actual brief file (no hardcoded README.md remains in COMMON_RULES).
- No init flags change in this sub-plan: `tumwater init` still writes README.md on a fresh repo; `--adopt`/`--dry-run` are 7b/7.

### 7b/7 — `tumwater init --adopt` and `--dry-run`: adopt an existing repo without touching its README (planned 2026-09-26, split from 7/7)

**Goal.** Today `initProject` hard-fails when README.md exists without the `tumwater:prompt` markers (src/init.ts:147), which is why tumwater has only ever been pointed at repos it created itself. Add the adoption path — write `TUMWATER.md`, leave README.md and any existing backlog files untouched — plus `--dry-run` and an ecosystem-neutral PRINCIPLES template. Depends on 7a/7 (the adopted repo's loops must resolve `TUMWATER.md` first, or adoption creates a brief nobody reads). Design rationale and audit pins: plans/portability.md §7/7 (corrections 1, 4, 5, 6, 7).

**Series.** Part 7/7 of the portability series, second half. Depends on: 2/7 ✓ and 7a/7.

**Approach.**
- src/cli-args.ts — `parseInitArgs` (returns `{ prompt: string; branch: string | null }` at :127) gains `--adopt` and `--dry-run` as valueless booleans: both join the allowed double-dash set (:129), the per-flag once-checks (:135–136), `--file`'s claimed pair (:142–144), and the join-skip list (:200–204) so they are never baked into the prompt text; the return type becomes `{ prompt; branch; adopt; dryRun }`.
- src/cli.ts — `cmdInit` (:130) destructures four fields and passes `opts` through.
- src/init.ts — `initProject` gains a fourth positional `opts?: { adopt?: boolean; dryRun?: boolean }` (branch stays third, :106). The README-without-markers guard (:147) becomes the adoption path: write `TUMWATER.md` via `briefTemplate`, one informational line, no throw — and the same path is taken with or without `--adopt` when README.md lacks markers. `write("README.md", …)` does not run on the adopt path (briefTemplate writes TUMWATER.md instead); the existing create-if-absent `write` helper (:159) keeps PLANS/BUGS/QUESTIONS/PRINCIPLES safe from overwrite. `--dry-run` prints the created/left-alone list and exits 0 with zero writes — no .gitignore edit, no `git add`/commit (the `committable` filter at :176–190 and 4a/7's create-if-absent config seeding (:168–171) are reused unchanged when it does run). `PRINCIPLES_TEMPLATE` (:61) is trimmed to ecosystem-neutral principles with a note that director and steward own the list (correction 7 — trimmed unconditionally; this repo's own tracked PRINCIPLES.md is only read, never re-seeded).
- Tests: test/cli-args.test.ts (the flag rules above, including `--file` + booleans combining and a duplicate boolean failing by name); test/init.test.ts (adopt in a clone with its own README.md and PLANS.md; `--dry-run` writes nothing and exits 0; the old-failure test — audit pin :118 — inverts to assert the adoption path; a bare re-seed of a README-only repo still round-trips through README.md).

**Files touched.** src/cli-args.ts, src/init.ts, src/cli.ts, test/cli-args.test.ts, test/init.test.ts.

**Acceptance criteria.**
- `tumwater init --adopt "<brief>"` in a clone of an unrelated repo (existing README.md, existing PLANS.md) creates only `TUMWATER.md`, `QUESTIONS.md`, `PRINCIPLES.md`, `tumwater.json` and the `.gitignore` entries — README.md and PLANS.md byte-identical afterwards; the same path fires automatically without the flag when README.md lacks markers.
- `tumwater init --dry-run` prints the file list and exits 0 having written nothing (no gitignore edit, no commit).
- A repo tumwater created before this change keeps reading its brief from README.md with no migration step.
- A repo that only gained tumwater.json reports it and stays uncommitted (4a/7's rule, unchanged).

**Series critical path.** 1/7 ✓, 2/7 ✓, 3/7 ✓ (landed 2026-09-23), 4a/7 ✓ and 4b/7 ✓ (landed 2026-09-22), 5/7 ✓ (2026-09-24), 6/7 ✓ (2026-09-25) are done. 7a/7 has no unmet dependency; 7b/7 waits on 7a/7 only.


## Done

### Wake and abort from the GUI dashboard (planned 2026-09-25, done 2026-09-23)

**Goal.** An operator watching the dashboard can pause the fleet, edit the budget, and prompt the director — but `tumwater wake` and `tumwater abort` exist only as CLI commands (src/operator-commands.ts), so clearing a stuck role's backoff or killing its runaway tick means leaving the browser. Give the dashboard per-loop `wake` and `abort` controls backed by two new POST endpoints that reuse the CLI's marker-writing logic.

**Approach.**
- src/operator-commands.ts — extract the marker-writing cores into exported, message-returning functions: `requestWake(root, roles: string[])` (the `cmdWake` body minus `targetRoles` arg-parsing and stdout — the per-role state-file rewrite via `clearBackoff`/`loadLoopState`/`saveLoopState` plus the `wakeRequestPath(root)` marker, returning the same confirmation string), `requestResetCounters(root, roles)` (same shape over `zeroCounters` — extracted even though the GUI skips it, so the three marker commands share one pattern and `cmdResetCounters` keeps printing its result), and `requestAbort(root, role)` returning `{ ok: true; message: string }` or `{ ok: false; error: string }` (the `orchestratorAlive` check and the DIRECTOR_ROLE prompt-discard note move inside; `fail()` stays in the CLI wrapper). `cmdWake`/`cmdAbort`/`cmdResetCounters` become thin wrappers that resolve targets via `targetRoles`/`namedRole`, call the core, and print — their output text stays byte-identical, pinned by the existing cli-operators tests.
- src/ui/gui.ts — two endpoints in the `createServer` handler chain, behind the existing token gate and using the same role validation as `handleTranscript` (validIds from `knownRoleIds(config)` with the broken-config fallback to `allRoleIds()`, 400 naming the accepted ids):
  - `POST /api/wake` body `{ role?: string }` — `{}` or a missing `role` targets every configured role (the CLI's all-roles default); a role is validated like `/api/transcript`. Calls `requestWake`, answers `{ ok: true, message }`.
  - `POST /api/abort` body `{ role: string }` — required; unknown/missing role → 400; `requestAbort`'s not-live error → 409 `{ error }` (a wrong-method-style conflict, not a client 400, since the marker is valid but nothing can consume it); success → `{ ok: true, message }` (the director message rides through verbatim).
  Body discipline via `readJsonObject` like `/api/prompt`.
- src/ui/status-payload.ts — each loop row gains `inFlight: boolean` from `isActivePhase` (src/ui/status-model.ts:185), so the client does not re-derive the three phase prefixes.
- src/ui/gui-client.ts — each row of the loop table (the map at :474) gains a trailing controls cell: `wake` always; `abort` only when `l.inFlight`. Both `data-role` links handled by one delegated click listener beside the existing `.looplink` one (comment-tagged `row-actions:start/end` like the pause-control block): `postJson("/api/wake", { role })` or `/api/abort`, no confirmation dialog, the returned message flashed in the header the way a failed budget/pause POST flashes, the 1 s poll re-renders state. `postJson`'s error path (gui-client.ts:50) already surfaces a JSON `{error}` body.
- src/ui/gui-page.ts — the static loop-table header gains the `controls` `<th>` the client-rendered rows now end with.

**Files touched.** src/operator-commands.ts, src/ui/gui.ts, src/ui/status-payload.ts, src/ui/status-model.ts (isActivePhase exported for the payload's inFlight — the plan referenced it without listing the file), src/ui/gui-client.ts, src/ui/gui-page.ts (the static header needed the controls column), test/gui-server.test.ts, test/gui-operator.test.ts. test/cli-operators.test.ts needed no change — output text stayed byte-identical, as planned.

**Acceptance criteria.**
- `POST /api/wake` with `{}` (or `{"role":"feature"}`) returns `{ok:true}` and writes the same state-file + marker state as `tumwater wake [--role feature]`; a running fleet consumes it within one poll (covered by the existing operator-requests tests' mechanism, asserted here by marker-file presence).
- `POST /api/abort {"role":"feature"}` on a live fleet writes the abort marker and returns the CLI's confirmation text; with no harness running it answers 409 with the "no harness is running" error; the director variant's message mentions the discarded prompt.
- Unknown or missing role ids on both endpoints → 400 naming every valid id (built-ins + customLoops), same as `/api/transcript`; both endpoints sit behind the `--token` gate.
- The dashboard's loop rows show `wake` on every row and `abort` only on in-flight ones; clicking flashes the server message and the next poll reflects the effect (abort → the row's phase drops to idle on a live fleet).
- `tumwater wake`, `abort`, and `reset-counters` print exactly today's text in both the live and not-live cases (existing cli-operators tests pass unmodified — verified: the full cli suite passed with no edits to that file).

**Landed as.** Both endpoints sit behind the token gate, in the same handler chain after `/api/pause`; the transcript role-validation block was lifted into a shared `validRoleIds` helper so all three loop-targeting endpoints cannot drift on ids or 400 wording. gui-server.test.ts carries the 413 body-discipline pin; gui-operator.test.ts the marker/409/400 pins and the evaled row-actions client block. Full suite 2026-09-23: 1405 pass, 0 fail.


### 6/7 — Make the project's verification command configurable (planned 2026-09-14, refined 2026-09-21, re-audited 2026-09-24 and 2026-09-25, done 2026-09-25)

**Done 2026-09-25 by feature.** Landed as designed: `check: { command, cwd?, timeoutSeconds? }`
is a project key in TumwaterConfig (validated: object with a non-blank command, optional cwd
string and positive timeoutSeconds), `BuildCheck` is a discriminated union — `npm`
(rootDir/script, the walk-up, unchanged) or `command` (command verbatim, cwd resolved against
the detection's start dir, timeoutMs = timeoutSeconds × 1000, default the shared 300 s) —
and `detectBuildCheck(startDir, config?, maxLevels?)` returns the configured command first.
`runBuildCheck` dispatches on kind: the command kind runs `sh -c <command>` in its resolved
cwd, under the same group-wide timeout/escalation and the same classification (probe → skip,
spawn failure → skip, timeout → skip, nonzero → failed with clipBuildTail's tail). Outcome
shape unchanged — a command check's `script` field is the command verbatim, so the
`build_check` event, the red-main note, and the skip warnings keep their shape.
`describeCheck(check)` names the check in prompts (`` `npm run test` `` / `` `pytest -q` ``):
COMMON_RULES became `commonRules(check)` — the Leave-the-project-working rule names the actual
command (generic wording only when no check exists) and the node_modules borrowing sentence
survives only for an npm check — and `buildBuildFixPrompt` plus the review reasons headline
take the description instead of an npm script. Config threads to all three detect sites
(`runScopedBuildCheck` gained it before timeoutMs; `checkMainBaseline(wt, config, onRun?,
reverifyRed?)` requires it in 2nd position; `checkBuildCheck(root, config)`), through
`MergeContext.config` (set in loop.ts's merge and lander.ts) and `mainIsGreen(mirrorWt,
config, onRun?)` with createRedeployer reading the live config per call. Doctor's no-check
stance flipped from informational to warn naming the consequence, and the check label is
"project check". Two audit drifts resolved in place: the batch scope's call site lives in
src/land-batch.ts (not lander.ts — the code moved since the 09-24 audit; lander.ts remains
for the MergeContext wiring), and `checkBuildCheck`'s config parameter is typed structurally
(`{ check?: … } | null`) since only the check key is read. The 09-25 audit's one correction is
also in: the gate's `verifiedByHarness` success strings name the check via `describeCheck` at
both review sites (src/review.ts:288/:300) instead of interpolating `npm run ${check.script}` —
the second npm assumption the 09-23 fix-on-the-spot feature added, caught by that audit.
Every acceptance criterion has a
test; the npm fallback is pinned unmodified. `npm test` 1401 pass (was 1394; +7
configured-command tests).

### Optional shared-token auth for the GUI dashboard — `gui --token <secret>` (planned 2026-09-23, re-audited 2026-09-25, done 2026-09-23)

**Done 2026-09-23 by feature.** Landed as described: the token gate at the top of the
`createServer` handler (Bearer header or `?token=`, `crypto.timingSafeEqual` behind a
byte-length guard, 401 JSON `{error: "token required"}` otherwise), `gui --token`
validated non-empty in cli.ts with token-bearing printed URLs and a `token-protected`
warning line, and the browser client reading the token once, attaching
`Authorization: Bearer` in `apiFetch`, and stripping `?token=` from the address bar.
One addition beyond the plan: the client's token read guards `typeof location` so the
existing Node-side extraction tests of the inline script keep evaluating it.
`startLocalGui` gained the optional `token` parameter as planned. `npm test` 1393 pass.

### Cost by role in the usage report (planned 2026-09-25, done 2026-09-23)

**Done 2026-09-23 by feature.** Landed as described (all four files from the plan's list, no
more), with three decisions the implementation pinned:
- The GUI cost chart shares `reportRoleOrder`'s ticks-based order (count desc, name asc) —
  the single shared order the acceptance criterion demands — while the Markdown cost line
  ranks by spend desc, per the plan's own wording; the two are intentionally different ranks.
  `reportRoleOrder` folds `costByRole`'s keys too, so the shared order can never drop a
  spend-bearing role.
- Zero-spend roles are omitted at aggregation time, not display time: a tick_end with no (or
  zero) `costUsd` leaves no `costByRole` key, so "$0 roles omitted" holds on the data itself.
- `chartTicksByRole`/`chartCostByRole` are now two thin wrappers over one `roleStackChart`
  builder (shared order, palette, legend, geometry) — the duplication the fourth chart would
  otherwise have introduced does not exist.

**Goal.** The report answers "how much did the fleet spend" only fleet-wide: `collectReport` sums `costUsd` per day (src/ui/report.ts:112) and `renderReportMarkdown` prints one cost column, while the per-role breakdown stops at tick counts (`**Ticks by role:**`, src/ui/report.ts:172-177) — an operator tuning per-role intervals or disabling roles cannot see which loop burns the budget. The data is already on the wire: every `tick_end` event carries `costUsd` (src/loop.ts:453) and `eventRole` (src/events.ts:110) extracts the loop id, and the landing gate's reviewer/conflict spend folds into the authoring role's tick cost via `foldLandingUsage` (src/loop.ts:359), so `tick_end.costUsd` alone is the complete per-role picture. Add a `costByRole` breakdown mirroring the existing `ticksByRole` one: a `**Cost by role:**` line in the Markdown report and a fourth stacked chart in the GUI report tab.

**Files touched.** src/ui/report.ts, src/ui/gui-client.ts, test/report.test.ts, test/gui-report.test.ts.

**Approach.** In `collectReport`'s existing `tick_end` branch, accumulate `day.costByRole[role]` alongside `day.ticksByRole[role]` (add `costByRole: Record<string, number>` to `ReportDay`; no change to `totals`). In `renderReportMarkdown`, render a `**Cost by role:**` line right after `**Ticks by role:**`, aggregated over the window, ordered by spend desc then name asc — the same deterministic sort the ticks line uses, but ranked by cost (spend is what the operator acts on). In `gui-client.ts`, add `chartCostByRole(data)` reusing `reportRoleOrder` (add cost to its fold and keep one shared role order so legend and stack order stay identical across the two role charts), a `fmtUsd = (n) => "$" + n.toFixed(2)` tooltip formatter matching the stat block's cost rule (gui-client.ts:238), and render it as a fourth `block(...)` after "Commits per day". `/api/report` needs no change — it serves `ReportData` as JSON, so `costByRole` rides along.

**Acceptance criteria.**
- `tumwater report` prints a `**Cost by role:**` line with per-role spend over the window, ordered by spend desc then name asc; roles with $0 spend are omitted; an all-zero window renders `-`.
- The GUI report tab shows a fourth stacked chart, "Cost per day by role", sharing the ticks chart's role order, palette, and legend; hovering a segment shows `<date> <role>: $<x.xx>`.
- `costByRole` sums exactly to the existing per-day `costUsd` and the Totals cost (no double counting: still sourced only from `tick_end`).
- Custom loop ids appear like built-in ones (no role-name allowlist), matching `ticksByRole`.
- `npm test` passes with the new tests in test/report.test.ts (aggregation + Markdown line) and test/gui-report.test.ts (`/api/report` JSON carries `costByRole`).

### Bound tool output head+tail with a tumwater pi extension (planned 2026-09-23, re-audited 2026-09-24, user request, done 2026-09-24)

**Done 2026-09-24 by feature.** Landed as described, with two corrections the implementation
forced (recorded here in place of the stale claims they replace):
- Refinement note 4's premise does not hold on pi 0.85.1 — verified against pi's own
  `dist/core/tools/read.js`: the read tool emits the raw file text (plus its own truncation
  notes) with **no** 1-indexed line-number prefixes, so there is no numbering to count and no
  line range to name. The read marker therefore names the omitted character count and points at
  re-reading the file (named from `event.input.path`) with `offset`/`limit` instead; cut points
  still snap to whole lines. All other refinement notes landed as pinned.
- The `import type` from pi's package was dropped: pi is not a dependency of this repo (and must
  not become one), so the extension carries minimal structural local types instead — same
  zero-runtime-dependency outcome, no phantom dev dependency.
Measured (not a gate): deferred until the next natural read sample; the 2026-09-23 baseline
(~16k mean, 49% over 20k) stands until then.

**Goal.** Stop single tool results from flooding the context. The same 2026-09-23 log sample shows `read` results averaging ~16k characters, with 106 of 216 over 20k — the prompt's "read files over ~300 lines in ranges" rule is advice the model often skips, and pi's own `read` cap (2000 lines / 50KB) is ~4x what the rule intends. pi's `bash` cap keeps only the last 2000 lines / 50KB (tail-only, `truncateTail`), so a failing test run's first error or a long file's header is lost while its tail is kept. Unreal Agent bounds every result to 40k characters split half head / half tail, with a `...N bytes truncated; complete output in <path>...` marker in the middle (harness/operation/output.go `boundOutput`), and the model reads the path on demand. Enforce tumwater's intended budget in the harness rather than in prose.

**Approach.** Ship a pi extension with tumwater and load it on every pi run.
- New `src/pi-extension/bounded-output.ts`: `export default function (pi) { pi.on("tool_result", …) }`, the pattern in pi's docs/extensions.md "tool_result" section (verified: handlers may return a partial `{ content }` patch, `event.toolName`/`event.input`/`event.content` are on the event). Keep ALL the bounding logic in pure exported functions — `boundText(text, limitChars, fullPath?)`, plus the read- and bash-specific wrappers `boundReadResult(text, input)` and `boundBashResult(text, details, writeFullOutput)` (see refinement note 1) — so every acceptance criterion is unit-testable without pi; the default export is a thin adapter that picks the wrapper by `toolName`. Use `import type` only from pi's package, so the zero-runtime-dependency principle holds (types erase; pi loads the file itself via jiti, and the compiled `.js` in dist/ works as well).
- `read`: when a text result exceeds ~12k characters (≈300 lines, matching `CONTEXT_BUDGET_RULE`), keep head+tail and replace the middle with a marker that names the omitted line range and says to re-read it with `offset`/`limit` — the file itself is the "complete output", so no copy is written. Skip image results and results the model already ranged (`event.input.offset`/`limit` set).
- `bash`: when the result exceeds ~16k characters, keep head+tail around a `...N bytes truncated; complete output in <path>...` marker. Reuse pi's own full-output file when `details.fullOutputPath` is set (verified: pi's bash tool sets it whenever IT truncates, src at dist/core/tools/bash.js:173/:221); otherwise write the full text into the harness's own `.tumwater/` area (see refinement note 2 for how the extension finds it, what it names the file, and what happens when there is no `.tumwater/` at all) and point at that.
- `piArgs` (src/pi.ts) appends `-e <absolute path to dist/src/pi-extension/bounded-output.js>`, resolved from `import.meta.url` so the staged builds redeploy uses (`.tumwater/build/<sha>`) load their own copy. Append it before `config.piArgs` so a user flag still wins; `--no-extensions` in piArgs would not disable it (explicit `-e` paths still load), which is intended.
- Limits are constants in the extension, not config (opinionated defaults). Update `CONTEXT_BUDGET_RULE` with one clause saying oversized results come back head+tail with a marker, so the model knows to follow the pointer instead of retrying the same read.
- Interaction with 5/7 (configurable agent binary — landed 2026-09-24): the `-e` flag is pi-specific, so it is appended only when the resolved binary is pi-shaped; see refinement note 6 for the pinned shape.

**Files touched.** src/pi-extension/bounded-output.ts (new), src/pi.ts, src/prompt.ts, test/bounded-output.test.ts (new), test/pi.test.ts, test/prompt.test.ts. (tsconfig.json needs nothing: `include` is `src/**/*.ts` with `rootDir: "."`, so the new file compiles to `dist/src/pi-extension/bounded-output.js` with no change — audit-pinned, the conditional in the original write is resolved.)

**Acceptance criteria.**
- `boundText` unit tests: text under the limit is returned byte-identical; text over it returns exactly head + marker + tail within the limit, the marker states the omitted character count (and the path when given), and multi-byte UTF-8 is never split mid-character.
- `boundReadResult` unit tests: a text result over the limit keeps pi's 1-indexed line-number prefixes on every surviving line, and the marker names the omitted line range in that same numbering (pinned by refinement note 4); a result whose `input` carries `offset` or `limit`, an empty text, and a short text are all returned unchanged.
- `boundBashResult` unit tests: over the limit keeps the first and last line on either side of the marker; `fullOutputPath` in details is preferred over writing anything; with no `fullOutputPath` and no `.tumwater/` ancestor the marker carries no path and nothing is written; with one, the written file's path is what the marker names.
- `piArgs` output includes `-e` followed by an absolute path to a file that exists in dist/ after `npm run build`, and omits it entirely when the resolved binary is not pi-shaped; test/pi.test.ts's argv pins are updated in place.
- A read of a 1,000-line file with no offset/limit yields a result under the read limit whose marker names the omitted line range; the same read with `offset`/`limit` set is passed through untouched.
- A bash result over the limit keeps both its first and last lines, and the marker's path, when read, contains the full output.
- Offline tests still pass against the fake pi shim (the shim ignores `-e`).
- Measured afterwards (not a test gate): mean and p90 `read` result size over the first ~200 post-landing reads, recorded in this entry's Done note alongside the 2026-09-23 baseline (~16k mean, 49% over 20k).

**Refined 2026-09-23 (plan loop) — audited against main on the day it was written. The pi-API claims all verify (`tool_result` partial patches, `-e` loading alongside `--no-extensions` per usage.md:236, `details.fullOutputPath` on pi's bash tool, `read` input's `offset`/`limit`), but the write left five seams open and one testable gap; pinned below.**

1. **The read/bash acceptance criteria were untestable as written.** `boundText` alone cannot exercise them: detecting a read result, honoring `input.offset`/`limit`, and deriving the omitted line range all live in the handler, which the fake pi shim ignores and no e2e reaches. Pinned: export `boundReadResult(text, input)` and `boundBashResult(text, details, writeFullOutput)` beside `boundText` — pure, filesystem-free (`writeFullOutput` is an injected `(text) => string|null` callback) — with the default export an adapter mapping `event` fields onto them. The two read/bash criteria above pin to those functions.
2. **The full-output sink was under-specified.** The extension runs inside pi, inside the role worktree, and knows neither the role nor the repo root. Pinned: from the extension's cwd, walk up ancestor directories until one contains a `.tumwater/` directory (the worktrees at `.tumwater/worktrees/<role>` and the landers at `.tumwater/worktrees/_land-<role>` both reach it two levels up; a harness root carries it directly), and write to `<that>/.tumwater/log/tool-output/<toolCallId>.log` — named by `event.toolCallId` because parallel tool mode can interleave `tool_result` events (docs/extensions.md:846), so a role-named or fixed name would collide. `.tumwater/` is already gitignored repo-wide, so the pointer never names a committable path. When no ancestor has `.tumwater/` (a bare pi run outside the harness), emit the head+tail marker WITHOUT a path and write nothing — never inside the worktree.
3. **The `-e` path resolution is pinned to one expression.** `new URL("./pi-extension/bounded-output.js", import.meta.url)` from `src/pi.ts` — compiled, that resolves from `dist/src/pi.js` to `dist/src/pi-extension/bounded-output.js`, which is exactly where rootDir `.` puts the compiled extension, and it makes the staged redeploy builds (`.tumwater/build/<sha>`) load their own copy as the write intended. test/pi.test.ts's argv pin resolves the same relative path from its own `import.meta.url` (tests run compiled from `dist/test/`), so the existence assertion works offline with no build inside the test.
4. **The read marker's line range is derived by counting, not parsing.** pi's read output prefixes each line with its 1-indexed number, one output line per file line, so the omitted range is `(countNewlines(head) + 1)` through `(totalLines − countNewlines(tail))` — no parsing of rendered digits, and correct even when the head's last kept line is itself truncated mid-line (cut points snap to the next newline before counting, so every kept line is whole).
5. **Sibling interaction with "Tell ticks to fan out independent tool calls in one turn" (done 2026-09-23 — its clause is already in CONTEXT_BUDGET_RULE; append to that same bullet).** Both entries edit `CONTEXT_BUDGET_RULE` in src/prompt.ts and pin clauses in test/prompt.test.ts, and neither the original write nor that entry said so. Landing order: the fan-out plan first (prompt-only, no code), then this one appends its oversized-results clause to the SAME bullet rather than opening a second one, updating the fan-out plan's prompt.test.ts pin in place per the principles' latest-instruction-wins rule. If this entry lands first, the fan-out implementer inherits the same obligation in reverse. Neither entry may duplicate or delete the other's clause.

**Refined 2026-09-24 (plan loop) — re-audited against main `292f642`: 5/7 (configurable agent binary) and the fan-out rule both landed since the 2026-09-23 refinement, resolving this entry's two open conditionals. Their resolutions are pinned below; nothing else drifted (src/pi.ts, src/prompt.ts, and tsconfig's compile layout are as the prior audit left them).**

6. **5/7 landed, so the pi-only gate is pinned to one predicate.** `piArgs` (src/pi.ts:47) currently knows nothing about the resolved binary — `runPi` calls `resolveAgentBin` separately (src/pi.ts:173) — so the plan's "add the flag only when the resolved agent is pi" had no shape. Pinned: `piArgs` gains a required second parameter `resolved: ResolvedAgentBin` (imported type from `./readiness.js`), and `runPi` passes the `resolved` it already computes — required, not optional, so a caller that forgets it fails to compile rather than silently spawning pi without the extension. The gate is `path.basename(resolved.bin) === "pi" || path.basename(resolved.bin).startsWith("pi.")`: it matches the PATH default, an absolute pi path, and pi-shaped wrappers (pi.js, pi.cmd, pi.exe), and skips anything else — a non-pi agent that rejects an unknown `-e` flag would otherwise fail every tick in the fleet. The gap stands as recorded: a non-pi-named agent binary gets no output bounding until it offers an equivalent hook. Ordering and the six existing `piArgs` test call sites (test/pi.test.ts:732–857) are updated in place; one new pin asserts a non-pi-shaped `resolved.bin` yields no `-e`.
7. **The fan-out rule landed first, so note 5's obligation now runs in this entry's direction.** `CONTEXT_BUDGET_RULE` (src/prompt.ts:45) ends with the fan-out sentences through "do not batch an edit with the test that checks it." — the plan appends its oversized-results sentence inside that same bullet, after those words, as one additional sentence (oversized tool results come back head+tail around a marker naming the omitted range and, for bash, the full-output path; follow the pointer instead of retrying the same read). test/prompt.test.ts's pin of the fan-out clause is updated to assert both sentences on the same bullet, not a second bullet.

Sizing unchanged: one new extension file (~120 lines), src/pi.ts ~8 (the signature and gate), src/prompt.ts ~2, tests ~130. One run. No design question remains open.

### Tell ticks to fan out independent tool calls in one turn (planned 2026-09-23, user request, done 2026-09-23)

**Goal.** Cut the per-turn re-send tax. Every assistant turn re-sends the whole conversation, so the number of turns, not the number of tool calls, drives input tokens. Across the 14 pi logs in `.tumwater/log/` on 2026-09-23, 1,655 assistant turns made 1,960 tool calls — 1.18 per turn, with only 441 turns issuing more than one — and input ran ~58:1 against output (6.75M uncached + 24.6M cache-read vs 0.54M out). Now that the primary model is a paid HF provider under a $10/day cap, those turns are money. pi 0.85 already executes sibling tool calls from one assistant message concurrently (docs/extensions.md, "parallel tool mode"), so the only missing piece is the model choosing to emit them. Inspired by Unreal Agent's preamble (github.com/unreallabsai/unreal-agent, harness/contextbuilder/prompts/preamble.md), which tells the model turns are the expensive unit and tool calls the cheap one.

**Approach.** Add one bullet to `CONTEXT_BUDGET_RULE` or the Scope group of `COMMON_RULES` in src/prompt.ts, phrased positively per PRINCIPLES.md: each turn re-sends everything read so far, so when the next few reads or commands do not depend on each other's output (a `wc -l` on several files, a `grep -n` plus the `sed -n` ranges it points at once known, a typecheck and a targeted test), issue them as separate tool calls in the same turn rather than one per turn. Restate the orientation budget in the same terms — "choose the task within ~15 tool calls" stays, and gains "in a handful of turns". Mirror the one-line version in `searchGuidance` (src/roles.ts) for the five backlog-free roles, whose orientation is the most read-heavy, and in the reviewer's reading budget (review prompt), which reads a diff plus its touched files and is the clearest fan-out case. Keep edits and anything that depends on a prior result sequential — say so, so the model does not batch an `edit` with the test that checks it. Do not add a config knob. Cross-reference: "Bound tool output head+tail with a tumwater pi extension" also edits `CONTEXT_BUDGET_RULE` and this file's pins — whichever lands second appends to the same bullet and updates the other's pin in place, never duplicating or deleting the other's clause (its refinement note 5 pins the same obligation).

**Files touched.** src/prompt.ts, src/roles.ts, src/review.ts (only if the reviewer's budget text lives there), test/prompt.test.ts.

**Acceptance criteria.**
- Every tick prompt and the review prompt carry the fan-out rule; test/prompt.test.ts pins it with the existing `oneLine` matching, and the review prompt still contains "VERDICT:" exactly twice.
- The existing pins (`Choose the task within your first ~15 tool calls`, `Decide within ~15 tool calls`, the "ran out of context" exclusion on `CONTEXT_BUDGET_RULE`) still pass unmodified or are updated in place, not duplicated.
- The tick prompt grows by no more than ~120 tokens.
- Measured afterwards (not a test gate): recompute calls-per-turn over the first ~200 post-landing turns with the jq one-liner used above (`message_end` assistant messages, count `toolCall` content items) and record the before/after in this entry's Done note.

**Refined 2026-09-23 (plan loop) — audited against main on the day it was written. The approach holds as written, but three seams were open; pinned below so the implementer edits without exploring.**

1. **The fan-out clause goes inside the existing `CONTEXT_BUDGET_RULE` bullet, as its final sentence — not as a second bullet and not in the Scope group.** `CONTEXT_BUDGET_RULE` is a single-bullet const at src/prompt.ts:45, interpolated into `COMMON_RULES` (src/prompt.ts:78) and `buildResumePrompt` (src/prompt.ts:286), and `COMMON_RULES` is embedded in both the tick prompt (src/prompt.ts:180) and the director prompt (src/prompt.ts:239) — so one edit to the const propagates to tick, director, and resume prompts with no other change. Append the fan-out sentence after "Prefer a task you can finish comfortably within the window over a sweeping one." (edit the const once, never duplicate the clause at an interpolation site), and make the separate "gains 'in a handful of turns'" edit where that text lives: the Scope group's "Choose the task within your first ~15 tool calls" line of `COMMON_RULES` (src/prompt.ts:65). This also settles the sibling interaction with "Bound tool output head+tail with a tumwater pi extension": its oversized-results clause appends to this same bullet after the fan-out sentence.
2. **The reviewer's budget text lives in `buildReviewPrompt` in src/prompt.ts — src/review.ts is off the list.** The reading-budget paragraph sits at src/prompt.ts:401–403 ("read surrounding code in the repo … read only what the diff touches: the changed functions, their callers, and the tests that cover them, in ranges (`grep -n`, `sed -n`), not the repository at large"); the fan-out mirror extends that sentence (reads of the diff and of the touched files do not depend on each other). src/review.ts holds only gate plumbing (`parseVerdict` and the queue/verdict handling) and no prompt text — the "(only if …)" hedge is resolved; do not touch that file. The prompt test that derives the accepted verdict forms from the literal "VERDICT:" appearing exactly twice (test/prompt.test.ts:608–614) must keep passing unmodified.
3. **`searchGuidance` is at src/roles.ts:76, and its mirror point is the decision-deadline sentence** — "Decide within ~15 tool calls: if no candidate clearly clears the bar by then, there is nothing to do — searching longer rarely changes the answer." Extend that sentence in place, not as a new paragraph. The five backlog-free roles consuming it are organize/clean/dry/perf/improve (call sites src/roles.ts:173/195/204/217/269), confirmed by the no-search-guidance assertion for the other six roles at test/prompt.test.ts:1153–1155.
4. **Existing test pins that must keep passing unmodified** (they match substrings the additions preserve — verified against test/prompt.test.ts): :1044–1047 (`context window is finite` in tick, director, and resume prompts), :1102 and :1286 (`doesNotMatch`, /ran out of context/ — the new clause must not use that phrase, as the const's comment already forbids), :1109–1110 (`~15 tool calls`, `~60 tool calls`), :1150 (`Decide within ~15 tool calls`), :1202 and :1281 (the bugfix ~10 and resume ~10 tool-call budgets — different texts, leave them alone). New pins, added beside them with the file's existing `oneLine` matcher: the tick prompt, director prompt, resume prompt, review prompt, and `searchGuidance("clean")` each match the fan-out clause, and the resume bridge still does not match /ran out of context/.

Sizing unchanged, now exact: src/prompt.ts three small edits (~6 changed lines — one sentence in `CONTEXT_BUDGET_RULE`, one sentence's extension in `buildReviewPrompt`, plus the "handful of turns" phrase), src/roles.ts ~2, test/prompt.test.ts ~15. One run, no design question open.

**Done 2026-09-23 (feature loop).** Landed as specified: the fan-out clause went into
`CONTEXT_BUDGET_RULE` (shared by every tick prompt and the resume bridge), the Scope bullet now
reads "within your first ~15 tool calls, in a handful of turns", `searchGuidance` carries the
one-line mirror for the five backlog-free roles, and the reviewer's reading budget in
`buildReviewPrompt` batches the independent diff reads. The reviewer's budget text lives in
src/prompt.ts (buildReviewPrompt), not src/review.ts, so src/review.ts was untouched — the
files-touched list already marked it conditional. test/prompt.test.ts pins all three surfaces
and the VERDICT-exactly-twice contract. Measurement: the before numbers are the entry's
baseline (1.18 calls/turn over 1,655 turns, 441 turns issuing more than one; input ~58:1
against output); the after recompute over the first ~200 post-landing turns is left for the
first telemetry/plan tick that runs against this prompt — the fleet's own logs are outside a
feature worktree.

### 5/7 — Make the agent binary configurable (planned 2026-09-14, refined 2026-09-19, re-audited 2026-09-23, done 2026-09-24)

Landed per plans/portability.md §5/7 (09-19 + 09-23 audits): `agentBin?: string` on TumwaterConfig
(validated as a known, non-blank string key); `resolveAgentBin(config)` in src/pi.ts implementing
`TUMWATER_PI_BIN` → `agentBin` → `"pi"` with whitespace values falling through (an empty export
cannot wedge the fleet); `runPi` spawns the resolved binary and its spawn-error message names it
and its source; `cmdRun` loads the config above its preflight and resolves through the same helper
(accessSync X_OK for path-shaped values, `findOnPath` for bare names); doctor's `checkPiBinary`
became `checkAgentBinary(root, pathEnv)` resolving via `loadConfigSafe`, flowing bare names through
the shared `checkBinary` helper (now takes an optional `describeFound` so the git check's text is
untouched); `PI_MISSING_MESSAGE` gained the `piMissingMessage(resolved)` / `agentBinSourceLabel`
builders in readiness.ts, default-source text byte-identical.

Deltas from the plan text, made in response to a review rejection of the first landing attempt:
- **Relative paths are normalized at resolution time** (`absBin`: path.resolve against the
  harness process's cwd for any value containing a separator). The plan's "used as given,
  relative to the process cwd" was broken end to end as written: the preflight and doctor
  evaluate against the process cwd but the spawn runs with each tick's worktree as cwd, so a
  relative agentBin named different files at the gate and at spawn. Normalizing once in
  resolveAgentBin makes all three sites agree; documented on the config field and in the helper.
- **Criterion 1's doctor half is delivered on the success path**: the ok detail reads
  `<resolved path> — resolved from agentBin in tumwater.json` (or TUMWATER_PI_BIN) whenever the
  source is not the PATH default; the default source keeps today's detail byte-identical.
- **tumwater.example.json deliberately does not carry agentBin**: the template is JSON (no
  comment syntax), the key is machine-specific like provider/model — exactly what the drift
  check's own remedy note says the template omits — and adding it would flag template drift on
  every existing install. Correction 6 made the edit conditional; the condition resolves to skip.

Tests: resolveAgentBin precedence and cwd normalization; runPi spawning a wrapper script at
agentBin with PATH empty (env var exported, byte-identical result shape) and the spawn-error
message naming the resolved binary and source; cli preflight failures naming value + source +
install hint for both env and config sources and a full run-lifecycle tick with agentBin and no
pi on PATH; doctor's three sources on ok and fail, plus the malformed-config fallback; agentBin
config validation. Full suite 1332/1332 (base 1323 + 9 new tests, 1 renamed).
### 4b/7 — Untrack this repo's own config without deleting it (planned 2026-09-14, refined 2026-09-19, re-audited 2026-09-23, done 2026-09-22)

**Landed 2026-09-22 (feature loop) as designed, plus the 09-23 re-audit's restore-only-when-absent pin.** The preserve step lives in ffMainTo's working-tree arm (src/merge.ts): `configBytesToPreserve` saves the live bytes when the config exists, is tracked, and is absent from the incoming ref; `restoreConfigBytes` writes them back only when the file is absent at write-back time (a config request that recreated it mid-merge wins — latest instruction wins, and the step is idempotent). `.gitignore` gains `tumwater.json` and this repo's copy is deleted in the same commit, so the restored file stays out of `git status` and the next `git add -A`. Four new tests in test/merge.test.ts pin the untracking landing (byte-identical restore, untracked, ignored, clean status, parsed config unchanged), the keeps-config landing, the no-config repo, and the write-back race.
### 4a/7 — Seed an untracked config from a tracked template (planned 2026-09-14, refined 2026-09-21, re-audited 2026-09-22, done 2026-09-22)

Landed per plans/portability.md §4a/7: `exampleConfigPath` + `EXAMPLE_CONFIG_BASENAME` (src/paths.ts),
`seedConfig` and `exampleDrift` (src/config.ts, sharing loadConfig's overlay via a new `overlayDefaults`
helper), `init` seeding through `seedConfig` with both pinned traps fixed (`ensureGitignore` now tests
`.tumwater/` and `tumwater.json` independently; the config stays out of the add/commit pathspec while
`created` still reports it, and an empty remaining pathspec skips the commit entirely), `checkInit`
folding drift into the pinned "init" check as a warn naming the keys, tumwater.example.json (new,
tracked, the generic half per the plan), and the README `## Usage` line (4c/7's residual). Tests:
seed/drift unit tests, init seeding + untracked + malformed-template + only-a-config-stays-uncommitted
tests, doctor drift-warn + read-only + remedy tests, gitignore independent-entry tests updated.

Two review objections from the first landing attempt were addressed: the drift warn's remedy now says
to **delete** tumwater.json before re-running `tumwater init` (init skips an existing config, so the
old wording was a no-op), and test/doctor.test.ts proves that remedy end to end. Operational note:
this repo's own tracked tumwater.json lacks several default-valued keys the new template sets
(landBatchMax, logMaxBytes, sessionRetentionDays, thrashTurns, thrashMinutes, autoRestart, review,
customLoops), so `doctor` reports the drift warn here until 4b/7 untracks the config — a warn, exit 0,
and truthful: the template genuinely has moved ahead.

### 3/7 — Harness-mediated config writes: take custom loops off the commit path (planned 2026-09-14, refined 2026-09-21, done 2026-09-23)

Landed per plans/portability.md §3/7 (2026-09-21 re-audit): `configRequestPath` (src/paths.ts),
`applyConfigRequest` (src/config.ts) — permitted-key filter collecting `ignored`, structural
validation before any entry dereference, orphaned `roles.<id>` strip, validate-then-
`writeJsonAtomic`, request deleted on every path with a failed unlink surfaced as an error —
consumed in the director tick after the abort return and before every staging path (src/loop.ts),
rejection/ignored keys logged as warning events naming them; the director prompt swaps the
`tumwater.json` edit exception for the request-file contract with a worked example (src/prompt.ts);
`defaultConfig().review.exemptPaths` drops `tumwater.json`; plans/user-defined-loops.md bullets
and invariant 4 superseded. Tests: applyConfigRequest unit tests incl. the `[null]` regression,
loop-level no-commit + ignored-key-warning tests, updated director-prompt contract tests.

### 2/7 — Resolve the repo root, and target any branch (planned 2026-09-14, refined 2026-09-17, re-audited 2026-09-21, done 2026-09-22)

**Goal.** Run the fleet against any repository, from anywhere inside it, targeting whatever branch that repo's primary checkout is on. Branch plumbing is already parameterized end to end; what is missing is a correct root (from `git rev-parse --show-toplevel`), an explicit override, and the guards that keep a resolved branch honest.

**Landed as planned, plus two seams the audits left open:**
- All of the approach as written: `repoToplevel`/`branchExists`/`listBranches` in src/git.ts; `main()` resolves the root from the cwd's toplevel before dispatch (init included — a subdirectory init seeds the repo root and reports `already initialized`); `resolveMainBranch(root, config, branchArg)` implements `--branch` → `baseBranch` → checked-out with existence validation naming the branches that exist; `parseBranchFlag` beside `parseRoleFlag`; `baseBranch` in config (validated non-empty); the edge-triggered branch-divergence warning in the orchestrator's poll loop (re-armed when the checkout returns); `initProject` honors `--branch` → git's `init.defaultBranch` → `main` and `InitResult` carries the created branch, so `cmdInit` prints it; `checkRepo(root, config?)` reports the toplevel and the target branch and fails on a configured-but-missing one, with runDoctor loading the config behind a guard.
- One addition beyond the plan text: src/supervisor.ts's `spawnRunChild` spawned the child with a literal `[script, "run"]`, which would have dropped `--branch` from a supervised run — it now takes `extraArgs` and cmdRun forwards its flags, so every restart generation targets the same branch.
- The start banner names the resolved root when it differs from cwd; the help's init/run lines name the new flags.

**Verification.** Full suite 1310/1310 (was 1288 + 22 new/updated tests): toplevel/branch helpers, `parseBranchFlag` and init `--branch` parsing, subdirectory CLI behavior, unknown-`--branch` failure, `init.defaultBranch` (via GIT_CONFIG_GLOBAL), doctor's baseBranch seam, the edge-triggered warning in a live orchestrator, and the trunk-only end-to-end tick → review → merge fixture.

### Fix a failed landing build check on the spot instead of rejecting (planned 2026-09-21, requested by user, done 2026-09-23)

**Goal.** When a landing's deterministic build pre-check fails, spend one bounded model run to fix
the tree and re-check, then proceed if green; reject only if it stays red. A red main otherwise
rejects every queued landing and bounces each author back for a failure none of them caused.
Sibling plan (independently landable): "Landing gate checks latest main…" — that one makes the
checked tree include main's newest fix; this one fixes what is still red.

**Approach (decided).**
- `src/prompt.ts`: add `buildBuildFixPrompt(roleId, script, reasons)` beside `buildConflictPrompt`
  (:312). Content: the declared check `npm run <script>` failed on the tree about to land; the
  failure (headline + clipped tail) follows; reproduce it, fix the source (never delete, skip, or
  weaken a test), keep the change minimal, re-run until it passes, then stop; do not commit — the
  harness commits. Pin its shape in `test/prompt.test.ts` (the `buildConflictPrompt` block at :268
  is the pattern).
- `src/review.ts`: in the pre-check `failed` branch (:167–181), before `reject`:
  1. Build `reasons` exactly as today (headline + tail).
  2. One fix run: `runPi({ cwd: wt, prompt: buildBuildFixPrompt(role, check.script, reasons),
     config: reviewConfig(config), sessionDir: reviewSessionDir(root, role), sessionName:
     `tumwater-buildfix-${role}-${ctx.tick}${ctx.sessionSuffix ?? ""}`, rawLogFile: piLogPath(root,
     role), label: "build-fix", signal: ctx.signal, onToolCallStalled: … })`.
  3. `fixPi.aborted` → `{ decision: "failed", aborted: true, fixRun: fixPi }` (commit kept,
     re-reviewed next tick).
  4. No file changes (`git(wt, "status", "--porcelain")` empty) → `reject(reasons)`.
  5. Else `commitAll(wt, `tumwater(${role}): fix failing build check`)` (git.ts:396), reassign
     `head` to the returned sha (make `head` a `let`), and re-run `runScopedBuildCheck(root, role,
     "gate", wt, ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS)`: `passed` → `verifiedHead =
     head`, carry `fixRun: fixPi`, and continue to the model reviewer (the fix is in the diff it
     reviews); `failed` → append one line to `reasons` ("the fix attempt did not turn the check
     green") and `reject(reasons)`.
  - Add `fixRun?: PiRunResult` to `GateResult` (the fix and the reviewer are two pi runs; `run`
    stays the reviewer's).
- `src/lander.ts` `reviewPinnedChange` (:83): after `reviewAheadOfMain` returns, `if (gate.fixRun)
  foldUsage(gate.fixRun)`; when `gate.verifiedHead` differs from `req.sha`, `await setRef(root,
  ref, gate.verifiedHead)` AND rebind `req = { ...req, sha: gate.verifiedHead }` — the exact
  idiom the pre-gate rebase uses (lander.ts:166–172) — so the ref and the request both track the
  fixed tree and the strike-cap tell (:126–127) keeps working untouched: an under-cap reviewer
  failure after a fix compares `head` (the fixed head) against the rebound `req.sha` and keeps
  the pin.
- One fix attempt per gate invocation, never retried in the same run; the fix is ordinary reviewed
  work once committed.

**Files touched.** `src/prompt.ts`, `src/review.ts`, `src/lander.ts`; `test/prompt.test.ts`,
`test/review.test.ts` (update "gate pre-check rejects a failing build with zero reviewer runs" at
:593 — it now sees one fix run before the reject), `test/lander.test.ts`; `README.md` (the
review-gate paragraph: a failed landing build check triggers one bounded fix run before rejecting).

**Acceptance criteria.**
- Declared check fails, the fix run edits a file so the re-run passes → the gate commits the fix,
  proceeds to the reviewer, and approves; the fix run's usage is folded; the landing ref and
  `verifiedHead` name the fixed head; the fix is in the reviewed diff.
- Check fails and the fix run makes no changes → one `review_rejected` as today (no second fix run).
- Check fails again after the fix run → `review_rejected` as today, with the extra reason line.
- Fix run aborts → `{decision:"failed", aborted:true}`; the commit and ref are kept for the next tick.
- The fix run is bounded to one attempt per invocation and cannot loop.
- `npm test` green.

**Refined 2026-09-23 (plan loop) — re-audited against main `356c74c`. The sibling plan ("Landing
gate checks latest main…", landed as `f0993fc`) merged after this entry was written and changed
the flow it edits; this audit re-pins every anchor against that flow. Verified as written:
`buildConflictPrompt` still sits at prompt.ts:312 with its test pattern at test/prompt.test.ts:268;
`GateResult` is review.ts:103; `commitAll` git.ts:396 and `refSha` git.ts:166 are unchanged; the
helper seam the fix run needs is the reviewer's own `runPi` call (review.ts:239–255) —
`reviewConfig` :242, `reviewSessionDir` :246, `piLogPath` :248, `onToolCallStalled` :254, and the
`pi.aborted → { decision: "failed", aborted: true, run: pi }` shape at :257 are the template to
copy. Corrections (pinned in place above): (1) the lander step now mirrors the rebase idiom —
`setRef` + `req` rebinding — and the strike-cap tell stays untouched, so the `refSha`
comparison this entry originally specified is dropped; (2) ordering is deliberate: when a fix
turns the check green but the reviewer still rejects, the lander's `setRef` runs first and
`reviewPinnedChange`'s `deleteRef` (lander.ts:111) supersedes it — harmless, do not guard
against it; (3) the fix run sits between the pre-check `failed` branch (review.ts:198–212) and
`review_start` (:225) and the `phase = "review"` flip, so no dashboard shows "reviewing" during
the fix — the same surface the deterministic pre-check has today, no phase added; (4) the
session name follows the reviewer's prefix order (`tumwater-buildfix-<role>-…`), keeping
transcripts greppable by run kind. Drifted line pins re-pinned: the pre-check `failed` branch is
review.ts:198–212 (was :167–181), `head`'s declaration :150 (the `let` conversion), `verifiedHead`
:188, `review_start` :225, the lander tell :126–127, and the zero-reviewer-runs test is
test/review.test.ts:593 (was :502). Sizing unchanged: one run, no design question open.

**Landed 2026-09-23 (feature loop, after a rejected first attempt whose three review objections
drove a different mechanism).** The approach above holds, with three deltas:
1. `GateResult.discarded` (review.ts) now reports the strike-cap discard explicitly; the lander
   deletes the pin on that flag instead of inferring it from a moved HEAD — a build-fix commit
   also moves HEAD, which made the old tell delete the pin on strike 1 and orphan the work.
   On every under-cap failure and on approval the pin is moved to the head the gate judged.
2. `landBatch`'s stack assembly cherry-picks the full RANGE `base..head-to-land` per entry, not
   the single pinned sha — a fixed pin's own diff is only the fix, so picking it alone landed
   the fix without the work it fixes and orphaned the work commit.
3. The fix run's usage folds on EVERY outcome it reached (abort, no-change reject, still-red
   reject, approval) via `fixRun`, carried on each GateResult return — not only on approval.


### Landing gate checks latest main: rebase the pinned change before the build pre-check (planned 2026-09-21, requested by user, done 2026-09-21)

Implemented as planned: `src/lander.ts` `landChange` rebases the detached lander worktree onto
main (`rebaseOntoMain`) after the checkout and before `reviewPinnedChange` — a no-op when main has
not moved; on a clean rebase the landing ref and the request (`sha`) are updated to the synced head
so the strike-cap tell tracks the tree that can land; on a conflict the pre-existing behavior is
untouched (abort restores the pin, `mergeToMain`'s resolver lands it). No change to `src/merge.ts`.
One delta from the written approach: the plan said to leave `landBatch` alone, but its abandon
fallback (a red or un-assemblable stack) re-lands each change through `landChange`, so those singles
now gate on their synced tree too — the deterministic re-check that used to run at `landing` scope
in-lock runs at `gate` scope on the synced tree instead (same coverage, one fewer script run per
change), and a change whose pin is behind moved main gets an honest re-review of the tree that
will actually land (previously the gate short-circuited on the stale approved head). Tests:
`test/lander.test.ts` gains two cases (gate reviews the rebased tree and lands both main's fix and
the change; a synced rebase moves the ref so an under-cap failure keeps the synced tree), and
`test/orchestrator-3.test.ts`'s cap-1 phase pins the moved coverage; `README.md`'s landing
paragraph names the pre-gate rebase. Full suite 1272/1272.

### 1/7 — GitHub Actions CI and a publishable npm package (planned 2026-09-14, requested by user, refined 2026-09-16, done 2026-09-21)

Implemented: package.json gains `files` (allowlist: dist/src, dist/build-info.json, README.md, LICENSE), `scripts.prepack` (`npm run build` — inside `scripts`, where npm runs it), `keywords`, `engines.node >=20.3` (AbortSignal.any), and `engines.os [darwin, linux]`; MIT LICENSE added; ci.yml (push/PR matrix, os × node 20/22/24, git-identity step, concurrency cancel) and release.yml (v*-tag driven, tag/version agreement gate, npm publish, tarball attached to a GitHub release) added; README Usage opens with `npm install -g tumwater` / `npx` and gains a from-source `npm link` block. The plan's "no test changes" was superseded by its own 2026-09-21 refinement (correction 5): test/packaging.test.ts pins the allowlist, `scripts.prepack`, engines, bin, and both workflow triggers. First real CI run and any tag push remain post-remote human steps.

- 4c/7 — Move README's rig notes into docs/backends.md (planned 2026-09-14, done 2026-09-21; commit dfa6d26)
- TUI failures pane — the failure digest in the Ctrl+T cycle (planned 2026-09-20, done 2026-09-21; commit c92c549)
- Fleet pause from the dashboard — a click-to-pause control in the GUI header (planned 2026-09-20, done 2026-09-21; commit f265dd7)

- Human-friendly numbers in the report tab's chart labels (planned 2026-09-20, done 2026-09-21; commit 6926014)
- Failure digest in the GUI — a `failures` tab beside `report` (planned 2026-09-19, done 2026-09-19; commit d4d734e)
- Live config-change event — surface what a tumwater.json edit changed (planned 2026-09-19, done 2026-09-19; commit 1767778)
- Red-main handoff — point the bugfix loop at the failing suite when main is red (planned 2026-09-19, done 2026-09-19; commit cfac056)
- Repair traces — record what made each bug hard to validate (planned 2026-09-17, done 2026-09-19; commit 794e170)
- Show the exact prompt each run received — `tumwater logs --role <id> --prompt` (planned 2026-09-19, done 2026-09-19; commit 30f3124)
- Observer roles 2/2 — a flow-coverage ledger so `qa` can rotate (planned 2026-09-17, done 2026-09-19; commit 492cbeb)
- Feature loop hands oversized plans to the plan loop instead of splitting them inline (planned 2026-09-18, done 2026-09-19; commit ac97ec6)
- Telemetry 2/2 — a `telemetry` role that reads the digest and files bugs (planned 2026-09-17, done 2026-09-19; commit 24ded35)
- Telemetry 1/2 — a deterministic failure digest over the fleet's own event log (planned 2026-09-17, done 2026-09-18; commit 39dfc33)
- Observer roles 1/2 — stop scheduling a passing check as an idle tick (planned 2026-09-17, done 2026-09-18; commit c1ad951)
- TUI/GUI auto-reload when a newer build lands on disk (planned 2026-09-13, done 2026-09-18; commit 614ff78)
- Merge queue 5/5 — coalesce the build check across queued landings (planned 2026-09-08, done 2026-09-18; commit 8a3e6a1)
- Fallback model — keep working for free once the daily budget is spent (planned 2026-09-18, done 2026-09-18; commit 7ab1275)
- Merge queue 4/5 — surface the land queue on status and both dashboards (planned 2026-09-08, done 2026-09-15; commit 776fa0f)

- GUI report charts: show a label on each bar segment at the cursor on mouse hover (planned 2026-09-14, done 2026-09-15; commit b56c96f)
- Merge queue 3/5 — asynchronous landing via a durable land queue (planned 2026-09-08, done 2026-09-14; commit bdec4f1)
- Remove the per-loop tokens/sec column from the TUI/GUI tables (planned 2026-09-14, done 2026-09-14; commit b5180be)
- Merge queue 2/5 — land in a per-role detached worktree (planned 2026-09-08, done 2026-09-13; commit a90a1ac)

- Show per-loop token generation rate (5-minute moving average) in the TUI/GUI (planned 2026-09-08, done 2026-09-13; commit 8477f9b)
- User-defined loops 3/3 — dashboard identification: mark user-defined loops on both surfaces (planned 2026-09-07, done 2026-09-13; commit 332e072)
- User-defined loops 2/3 — director control surface: add/remove/rearrange from the prompt box (planned 2026-09-07, done 2026-09-12; commit 0b1db0a)
- User-defined loops 1/3 — config plumbing: `customLoops` in tumwater.json (planned 2026-09-07, done 2026-09-12; commit 7aaa69a)
- Show the GUI loop table's last tick with relative age — match the TUI's "· Nm ago" (planned 2026-09-11, done 2026-09-12; commit 8865aa8)
- Make the daily cost budget editable from the TUI/GUI (planned 2026-09-07, done 2026-09-12; commit e8bdd24)
- Sort the GUI loop table by state category, then last tick (planned 2026-09-09, done 2026-09-11; commit fafebbe)
- TUI "usage report" pane in the Ctrl+T cycle — report 3/3 (planned 2026-09-10, done 2026-09-11; commit dd32fc5)
- GUI "report" tab with SVG dashboard — report 2/3 (planned 2026-09-10, done 2026-09-10; commit 465f1f6)
- Usage report core + `tumwater report` CLI subcommand — report 1/3 (planned 2026-09-10, done 2026-09-10; commit 542e49a)
- Prioritize loops by need — defer unneeded maintenance ticks and order work roles first (planned 2026-09-08, done 2026-09-10; commits 1406be5, b2ddeb6)
- Merge queue 1/5 — landing takes a worktree and a ref (planned 2026-09-08, done 2026-09-08; commit 8665dca)
- Label review-gate runs in loop transcripts (planned 2026-09-07, done 2026-09-08; commit 7730bb1)
- Read backlog entries in full from the TUI/GUI dashboards (planned 2026-09-05, done 2026-09-07; commits 2c85ea4, 1a5fff9)
- Fleet pause — `tumwater pause` / `tumwater resume` (planned 2026-09-05, done 2026-09-06; commits 9481eeb, 7c56ca1, b76fab1)
- Pre-flight environment check — `tumwater doctor` (planned 2026-09-05, done 2026-09-06; commits 784d487, be36b71)
- Machine-readable fleet state — `tumwater status --json` (planned 2026-09-05, done 2026-09-05; commit e46b811)
- Red-main baseline check — skip authoring runs while main is red (planned 2026-09-04, done 2026-09-05; commits 377cf0f, e7ef65c)
- Steward curation of BUGS.md's Fixed history — compress old fixed bugs to one-line records (planned 2026-09-04, done 2026-09-05; commit 24f39e2)
- Steward curation of PLANS.md's Done history — compress old done plans to one-line epitaphs (planned 2026-09-04, done 2026-09-04; commit 81c50a2)
- Section-aware tick reads — stop paying for history every tick (planned 2026-09-04, done 2026-09-04; commit 7516413)

- Bound README's status section — state, not log (planned 2026-09-03, done 2026-09-04; commit 9e00d29)
- Run the project's own test suite in the deterministic pre-merge gate (planned 2026-09-04, done 2026-09-04; commit 495570f)
- Abort a single loop's in-flight tick — `tumwater abort --role <id>` (planned 2026-09-03, done 2026-09-04; commits b37e600, 6b52731, 0d4c41b, 7a9fa8d, ff42635)
- Per-loop today spend — which loop is eating the day's budget (planned 2026-09-02, done 2026-09-03; commits c17893d, 02a8661)
- Steward role — whole-system judgment on a slow clock (planned 2026-08-24, done 2026-09-02; commits 6e3f487, be6dc56, bf42c98)
- Per-tick usage in the event feed — tokens and cost on every tick_end (planned 2026-09-02, done 2026-09-02; commit 3e4086a)
- Director inbox management — list and cancel queued prompts (planned 2026-09-01, done 2026-09-02; commits 53c0477, 349482e, 9c20312, da86dbd)
- Live sessionRetentionDays — re-prune old pi sessions without a restart (planned 2026-08-31, done 2026-09-02; commits eaa9848, 349482e, 157215f)
- Show queued director prompts in TUI/GUI (planned 2026-09-01, done 2026-09-01; commit 55af189)
- Live maxConcurrent — resize the concurrency cap without a restart (planned 2026-08-31, done 2026-09-01; commit af61b7e)
- Self-explaining commit bodies (planned 2026-08-24, done 2026-08-31; commits b41185d, 0f73491, d930959, 4021c1d)
- Daily cost budget — cap the fleet's autonomous spend (planned 2026-08-30, done 2026-08-31; commits 041fd55, 01c28ce, 07d5bf6, 2fbfb49, 92a4ffe, b589e09)
- The right to refuse, and friction as a signal (planned 2026-08-24, done 2026-08-30; commits c2f541a, 0326a2a, 82c7631, bc479b6, c477ce9, 7212a7e, 8e6eeae)
- Questions outbox — loops that know when to ask (planned 2026-08-24, done 2026-08-29; commits 2547b4d, 0294f45, 1a48edc, 931ca26)
- Adversarial review gate before merge (planned 2026-08-24, done 2026-08-29; commits 74224e9, 8ea49b8, 93d14f5, 038519a, 36b0adc, 50ef9eb)
- QA role — exercising the product like a user (planned 2026-08-24, done 2026-08-28; commit 6859e43)
- Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, done 2026-08-26; commit 9ef07d9)
- PRINCIPLES.md — positive design principles injected into every prompt (planned 2026-08-24, done 2026-08-26; commit abd2963)
- Show open bugs and planned features in the TUI/GUI (planned 2026-08-24, done 2026-08-26; commit 7023381)
- Show current work item per active loop in the GUI/TUI tables (planned 2026-08-25, done 2026-08-25; commit 39bfe9d)
- CLI subcommand to reset loop counters — ticks, commits, tokens, cost (planned 2026-08-25, done 2026-08-25; commit 5374aa5)
- Live-reload tumwater.json while the harness is running (planned 2026-08-23, done 2026-08-25; commit 82c7910)
- Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25; commit 52fcfa2)
- Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, done 2026-08-24; commit d36cb17)
- Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, done 2026-08-23; commit 48f45a1)
- Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21; commit 9ddd731)
- Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21; commit 3e002c9)
- Web GUI (done 2026-08-20; commit 2182085)
- pi-driven merge conflict resolution (done 2026-08-20; commit 2182085)
- Per-role model/effort overrides (done 2026-08-20; commit 2182085)
- Log rotation and session pruning (done 2026-08-20; commit 2182085)
