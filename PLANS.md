# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### 6/7 — Make the project's verification command configurable (planned 2026-09-14, refined 2026-09-21, re-audited 2026-09-24)

**Goal.** Stop assuming the target project is an npm project. `detectBuildCheck`/`runBuildCheck` walk up for a directory holding both `package.json` and `node_modules`, then run `npm run test|typecheck|build`; against a Python, Rust, or Go repo the walk finds nothing, so the review gate's pre-check, the red-main baseline gate (src/main-red.ts), and redeploy's `mainGreen` all degrade to "no check". Add `check.command` in config with today's npm auto-detection as the fallback; the threading surface is the three `detectBuildCheck` sites (`runScopedBuildCheck`, main-baseline.ts, doctor.ts), `MergeContext`, `checkMainBaseline`'s own callers (src/main-red.ts, src/redeploy.ts), and the gate's build-fix prompt (`buildBuildFixPrompt` names `npm run <script>`; it takes `describeCheck`'s wording instead, as do the rejection reasons — the 09-23 fix-on-the-spot feature added this npm assumption after the 09-21 audit).

**Series.** Part 6/7 of the portability series. Depends on: 2/7. Approach, design rationale, and audit pins: plans/portability.md §6/7.

**Files touched.** src/types.ts, src/config-validation.ts, src/build-check.ts, src/prompt.ts, src/review.ts, src/merge.ts, src/lander.ts, src/main-baseline.ts, src/main-red.ts, src/redeploy.ts, src/loop.ts, src/doctor.ts, test/build-check.test.ts, test/prompt.test.ts, test/review.test.ts, test/main-baseline.test.ts, test/redeploy.test.ts, test/doctor.test.ts.

**Acceptance criteria.**
- A repo with `check.command = "pytest -q"` and no `package.json` anywhere has its check run at the review gate, at the red-main baseline, and in redeploy's green check; a failing check rejects the diff with the command's output tail as the reasons.
- A repo with no `check` and a `package.json` behaves exactly as today (pinned by the existing build-check tests passing unmodified).
- A configured command that hangs is killed at `timeoutSeconds`; at the `gate` scope it is classified `skipped` and the tick proceeds to model review with a warning, while at `landing`/`batch` it is remapped to `failed` with the "tree is unverified" reason and rejects the merge (the existing `MERGE_SCOPES` policy, unchanged).
- Tick prompts in a non-npm repo never mention `node_modules`, and name the configured command where they used to say "if it has a build or test command".
- `doctor` warns, naming the consequence, when neither a configured command nor an npm script is found.

### 7/7 — Adopt an existing repository without hijacking its README (planned 2026-09-14, refined 2026-09-18, re-audited 2026-09-24)

**Goal.** Let `tumwater init` run against a repo that already exists and already has a README. Today it hard-fails when `README.md` exists without the `tumwater:prompt` markers, because `readInitialPrompt` (src/readme.ts) reads the brief only out of README.md's managed section. Introduce `TUMWATER.md` as the project brief with README as the compatibility path, plus `init --adopt` / `--dry-run`; the brief filename threads through `COMMON_RULES` (shared with the director prompt).

**Series.** Part 7/7 of the portability series. Depends on: 2/7. Approach, design rationale, and audit pins: plans/portability.md §7/7.

**Files touched.** src/paths.ts, src/readme.ts, src/init.ts, src/cli-args.ts, src/cli.ts, src/loop.ts, src/roles.ts, src/prompt.ts, src/doctor.ts, test/init.test.ts, test/readme.test.ts, test/prompt.test.ts, test/doctor.test.ts, test/cli-args.test.ts.

**Acceptance criteria.**
- `tumwater init --adopt "<brief>"` in a clone of an unrelated repo (existing README.md, existing PLANS.md, no node_modules) creates only `TUMWATER.md`, `QUESTIONS.md`, `PRINCIPLES.md`, `tumwater.json` and the `.gitignore` entries — README.md and PLANS.md byte-identical afterwards.
- Every loop's prompt carries the brief from `TUMWATER.md`; the readme role keeps its status section current in that file and never edits the project's README.
- A repo tumwater created before this change keeps reading its brief from README.md with no migration step.
- `tumwater init --dry-run` prints the file list and exits 0 having written nothing.

**Series critical path.** 1/7 ✓, 2/7 ✓, 3/7 ✓ (landed 2026-09-23), 4a/7 ✓ (landed 2026-09-22) and 4b/7 ✓ (landed 2026-09-22) are done. 5/7, 6/7 and 7/7 depend only on 2/7 and may land in any order from here — the series has no critical path left.

## Done

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

### 4c/7 — Move README's rig notes into docs/backends.md (planned 2026-09-14, done 2026-09-21)

**Landed 2026-09-21 (feature loop) — commit `dfa6d26`.** README's `## Notes on local model servers`
section (160 lines) became `docs/backends.md` (181 lines), README keeping a short `## Backends`
pointer; the oMLX/LM Studio numbers are labelled as one machine's measurements, not "the current
setup". Readme-side criteria verified: a case-insensitive grep over README.md for `omlx`, `lm
studio`, `qwen`, `gguf`, `huggingface`, `deepseek` is empty (the only host literal left is the
generic `http://127.0.0.1:7180` GUI default) and README links `docs/backends.md`. The one criterion
this entry still owed — README's `## Usage` line naming `tumwater.example.json` — cannot be written
before 4a/7 creates that file, so it moved into 4a/7. No source or test change.

**Goal.** README stops being one machine's notebook: its `## Notes on local model servers` section becomes `docs/backends.md`, and README's `## Usage` gains one line naming `tumwater.example.json` as the tracked baseline an untracked `tumwater.json` is seeded from.

**Series.** Part 4c/7 of the portability series; markdown only and independent, so it may land in any order. Depends on: nothing. Design: plans/portability.md §4c/7.

**Files touched.** README.md, docs/backends.md (new). No source or test changes.

**Acceptance criteria.** No section of README names a machine path, a model id, a server URL, or a value sized to one GPU (the moved text is the only place they appear); README links `docs/backends.md`; the worked example is labelled as an example; the suite is untouched.

### TUI failures pane — the failure digest in the Ctrl+T cycle (planned 2026-09-20, done 2026-09-21)

**Landed 2026-09-21 (feature loop).** As planned: `src/ui/tui.ts` imports `REPORT_DEFAULT_DAYS` from `./report.js` (the report pane's hardcoded `14` now uses the shared constant for both panes) and `collectFailureReport` / `renderFailureMarkdown` from `../failure-report.js`; the one cached-Markdown mechanism is renamed `reportCache`/`reportScroll` → `paneCache`/`paneScroll` and serves both panes. Ctrl+T cycles events → transcripts → project status → usage report → failures (`roleIds.length + 4`), the failures pane computes `renderFailureMarkdown(collectFailureReport(root, REPORT_DEFAULT_DAYS))` on entry and page-windows it under a `failures — [PgUp/PgDn scroll · ]Ctrl+T to cycle` header, and the stale-index clamp widened to `roleIds.length + 3`. Tests: the Ctrl+T cycle test now asserts the failures pane, a new paging test covers PgDn/PgUp clamping and the cache reset on re-entry, and the project-status browse test's cycle count follows the extra view. No README change, as the plan decided.

**Goal.** Give the TUI the same failure digest the GUI's `failures` tab and `tumwater report
--failures` already show: a pane in the Ctrl+T cycle (events → each loop's transcript → project
status → usage report → failures → events) rendering
`renderFailureMarkdown(collectFailureReport(root, REPORT_DEFAULT_DAYS))`. The GUI failures tab
entry (landed 2026-09-19) named "a TUI failures pane" as out of scope; this is the remaining
surface gap in "observable by gui/tui/log".

**Why.** The digest is the telemetry loop's evidence and an operator's fastest read on what is
going wrong fleet-wide, and it now exists on the CLI and in the GUI but not in the always-on
dashboard. The usage-report pane already establishes the exact mechanism to reuse: a Markdown
string cached once per view entry and windowed with `entryBodyWindow`.

**Approach (decided).**
- `src/ui/tui.ts` — import `REPORT_DEFAULT_DAYS` from `./report.js` (the report pane currently
  hardcodes `14`; use the shared constant for both panes) and `collectFailureReport`,
  `renderFailureMarkdown` from `../failure-report.js` (core, imports no `ui/` module — no cycle).
- Generalize the one cached-Markdown pane, since the failures pane needs identical
  cache-on-enter / null-on-leave / re-window-per-frame behavior: rename `reportCache`/`reportScroll`
  (declarations at :92/:95) to `paneCache`/`paneScroll`. One mechanism, two views.
- Ctrl+T handler (:271–278): cycle length becomes `roleIds.length + 4`; on entry set
  `paneCache = view === roleIds.length + 2 ? renderReportMarkdown(collectReport(root,
  REPORT_DEFAULT_DAYS)) : view === roleIds.length + 3 ?
  renderFailureMarkdown(collectFailureReport(root, REPORT_DEFAULT_DAYS)) : null;` and reset
  `paneScroll = 0` (as today).
- Render (:120 clamp becomes `roleIds.length + 3`; branch at :180): one branch for
  `view === roleIds.length + 2 || view === roleIds.length + 3`, choosing the header label
  (`usage report` / `failures`) and otherwise reusing the existing windowing and
  scroll-affordance code unchanged.
- PgUp/PgDn handler (:290–300): widen the condition to `view >= roleIds.length + 2` so both
  Markdown panes page the single `paneCache`; project status (`+1`) keeps its own entry-mode
  handler untouched.
- No README change: the README does not enumerate TUI views (the `readme` loop maintains Status).

**Files touched.** `src/ui/tui.ts`, `test/tui.test.ts`. No core, config, or storage change — the
failures pane consumes functions that already exist and are exported.

**Acceptance criteria.**
- Ctrl+T cycles events → transcripts → project status → usage report → failures → events; the
  failures pane's header reads `failures — [PgUp/PgDn scroll · ]Ctrl+T to cycle` (the scroll hint
  appears only while the digest overflows the pane, matching the usage-report header).
- The pane's body is exactly `renderFailureMarkdown(collectFailureReport(root, 14))`, windowed by
  `entryBodyWindow`, starting at the digest head (`# tumwater failure digest`) on entry.
- PgUp/PgDn page the failures digest and clamp at both ends; leaving the view drops the cache so
  re-entry recomputes it. The usage-report pane behaves exactly as before.
- `npm test` green.

**Grounded 2026-09-20 (plan loop)** against main `92caeb7`: `collectFailureReport`
(src/failure-report.ts:214) and `renderFailureMarkdown` (:378, head `# tumwater failure digest`)
are exported core functions; `REPORT_DEFAULT_DAYS = 14` is exported from src/event-window.ts and
re-exported by src/ui/report.ts. Capability absence re-confirmed: `grep -n failures src/ui/tui.ts`
is empty, and the GUI entry's own text (PLANS.md:63) lists "a TUI failures pane" as out of scope,
so no Planned/Done entry covers it. Seams pinned: `reportCache` :92, `reportScroll` :95, the
clamp :120, the report render branch :180, the Ctrl+T modulo :271 and cache assignment :277, the
PgUp/PgDn branch :290–300; the cycle test at test/tui.test.ts:541 and the report paging test at
:1047 are the two to extend. One run: ~30 lines in one file plus tests.


### Fleet pause from the dashboard — a click-to-pause control in the GUI header (planned 2026-09-20, done 2026-09-21)

**Landed 2026-09-21 (feature loop).** As planned: `pauseFleet`/`resumeFleet` join `isFleetPaused`
in src/state.ts as the single marker writers, `cmdPause`/`cmdResume` delegate to them with their
stdout and idempotence unchanged, `POST /api/pause` validates an explicit boolean through
`readJsonObject`, and the header gains a `#pausewrap` badge whose delegated click POSTs the
opposite of the last polled state. One guard beyond the write: the click reads
`!(lastStatus && lastStatus.paused)`, so a click before the first poll cannot throw.

**Goal.** Give the GUI the fleet gate the CLI already owns: a small header control that pauses
(`tumwater pause`) or resumes (`tumwater resume`) the whole fleet in one click. Everything else an
operator does mid-run is on the dashboard — send the director a prompt (`POST /api/prompt`), edit
the daily cost cap (`POST /api/budget`) — while stop-the-fleet stays CLI-only, so an operator
watching the dashboard (e.g. over `gui --all-interfaces`, with no shell at hand) must drop to a
terminal to halt a runaway fleet.

**Approach (decided).**
- `src/state.ts` — beside `isFleetPaused` (:73), add the two writers in the same file for the
  single-definition reason its doc comment gives (the scheduler and every observer read the marker
  from disk without importing each other). `pauseFleet(root): boolean` writes `pausedPath(root)` as
  `{ at: Date.now() }` via `writeJsonFile` (the plain-overwrite marker convention `cmdPause` uses
  today; add it to state.ts's existing `./json-files.js` import) and returns whether it changed
  state — an `fs.existsSync` check first, false when the marker already exists. `resumeFleet(root):
  boolean` checks `fs.existsSync` for the marker, removes it with `removeQuiet`, and returns whether
  it existed; `removeQuiet` returns void, so that existence check is the only way to report it, and
  `./files.js` is a NEW import (state.ts imports no file helpers today). Both JSON writers call
  `ensureParentDir` internally, so the fresh-repo path (no `.tumwater/` yet) `cmdPause` handles
  today is preserved; prefer `writeJsonFile` over `writeJsonAtomic` here so the marker's write
  mechanism stays exactly as it is (every reader only checks existence, so atomicity buys nothing).

- `src/operator-commands.ts` — `cmdPause` (:92) / `cmdResume` (:109) delegate to those helpers,
  keeping their exact stdout (`already paused`, `not paused`, the `markerApplyNote` timing lines)
  and their idempotence, so the CLI and the new control write the marker one way.
- `src/ui/gui.ts` — `POST /api/pause` beside `/api/budget` (:292): `readJsonObject(req, res,
  '{"paused": true}')`, require a boolean `paused` (400 naming what arrived otherwise), then
  `value ? pauseFleet(root) : resumeFleet(root)`, answering `{ ok: true, paused: value }`.
- `src/ui/gui-page.ts` — add `<span id="pausewrap"></span>` after `<span id="budgetwrap"></span>`
  (:47).
- `src/ui/gui-client.ts` — a second header fragment mirroring the budget block: a
  `// pause-control:start/end` block whose `renderPauseBadge(d)` (called next to
  `renderBudgetBadge(d)` at :403) renders ` · pause` as `<a href='#' id='pausebadge'>` while
  `!d.paused`, and ` · paused — resume` while `d.paused`; a delegated click on `#pausebadge` POSTs
  the target state (`!lastStatus.paused`) to `/api/pause` and flashes the server's error on
  failure. No optimistic state: the next 1 s poll re-renders from `d.paused`, which
  status-payload.ts already ships (:55) — exactly the budget badge's contract.
- No TUI change: an idle loop's TUI/`status` cell already reads `paused` (src/ui/status-model.ts:124)
  and a terminal operator has `tumwater pause` at hand; the GUI is the shell-less surface that needs
  the control.

**Files touched.** `src/state.ts`, `src/operator-commands.ts`, `src/ui/gui.ts`,
`src/ui/gui-page.ts`, `src/ui/gui-client.ts`; `test/state.test.ts`,
`test/operator-commands.test.ts`, `test/gui.test.ts`.

**Acceptance criteria.**
- With the fleet unpaused the GUI header shows ` · pause`; clicking it writes the pause marker and
  the next 1 s poll renders ` · paused — resume`; clicking again removes the marker and restores
  ` · pause`. With no fleet running the toggle still writes/removes the marker (pausing before
  startup starts an already-paused fleet), matching the CLI.
- `POST /api/pause` with `{"paused":true}` writes the marker and answers `{ok:true,paused:true}`;
  `{"paused":false}` removes it; a missing or non-boolean `paused`, a malformed body, and an
  oversized body all get the endpoint's 400/413 and leave the marker untouched.
- `tumwater pause` / `resume` print exactly what they did before and leave the marker's format
  unchanged (test/operator-commands.test.ts:198 pins the behavior); `pauseFleet`/`resumeFleet`
  return false on a repeat call.
- `npm test` green.

**Grounded 2026-09-20 (plan loop)** against main `738205a`: `isFleetPaused` (src/state.ts:73, over
`pausedPath` at src/paths.ts:83), `cmdPause`/`cmdResume` (src/operator-commands.ts:91/:106) and
their output tests (test/operator-commands.test.ts:198) are the seams above. Capability absence
confirmed: `grep -rn 'pausewrap\|api/pause\|pauseFleet\|resumeFleet' src/` is empty, src/ui/gui.ts
has exactly two POST routes (:274, :292), and `paused` is shipped in the payload
(src/ui/status-payload.ts:55) yet appears nowhere in gui-client.ts — the state is sent, never
consumed as a control. Pattern to copy: the budget badge's markup (gui-page.ts:47), its
render/click block (`// budget-edit:start` :257–:325), its route (:292), and its DOM-stub test
(test/gui.test.ts:1001). One run: ~110 lines of source (mostly the client block) plus tests.

**Refined 2026-09-21 (plan loop)** against main `6926014`: every seam re-verified — `isFleetPaused`
src/state.ts:73, `cmdPause`/`cmdResume` src/operator-commands.ts:92/:109 (drifted +1/+3 since the
2026-09-20 ground), the pause/resume tests test/operator-commands.test.ts:198–:233, gui-page's
`budgetwrap` :47, the two POST routes (:274/:292), the budget block `// budget-edit:start`…`:end`
(:257–:325) and its `renderBudgetBadge(d)` call (:403), `paused` in the payload
(src/ui/status-payload.ts:55) and in status-model.ts:124 — all still match. Capability absence
re-confirmed: `grep -rn 'pausewrap|api/pause|pauseFleet|resumeFleet' src/` is empty, and
`grep -rn 'fleet_paused' src/` shows only the orchestrator's transition event (src/orchestrator.ts:453,
read through `isFleetPaused`), never a writer. Three implementer traps now pinned in the approach:
state.ts has no `./files.js` import today (the `removeQuiet` import is new, not an addition);
`removeQuiet` returns void, so `resumeFleet` must `fs.existsSync` before removing to report whether
the marker existed; and the writer should be `writeJsonFile` (what `cmdPause` uses today), keeping
the fresh-repo path behavior-preserving where `writeJsonAtomic` would silently change the marker's
write mechanism. No design question is left open.

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
