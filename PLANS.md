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

### Doctor: one throwing check becomes a fail row instead of aborting the whole report, and a failed image-probe cache write keeps the fresh verdicts (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/doctor/doctor.ts + src/doctor/doctor-model-checks.ts + test/doctor.test.ts + test/doctor-model-checks.test.ts + docs/invariants.md)

**Goal.** `runDoctor` (src/doctor/doctor.ts) runs its checks in a loop with `const outcome = await step.run();` and no try. So when any one check throws, the whole report rejects. `tumwater doctor` (src/cli.ts), the dashboard's doctor endpoint (src/gui/gui-endpoints.ts) and the TUI Health pane (src/ui/tui/tui-pane-health.ts) then get no rows at all, not even the checks that passed. Most checks catch their own errors (`checkBrief`, `checkStateDir`, `findOrphans`). One known site does not: `checkImageInput` (src/doctor/doctor-model-checks.ts) ends its probe loop with `if (probedAny) writeImageProbeCache(root, probes);`, which has no try. With `--reprobe` or "missing", that write comes after the live model probes have already run (and been paid for). If the write fails (`writeJsonAtomic` on a full disk or a read-only `.tumwater/state`), the fresh verdicts are lost and `tumwater doctor` crashes.

**Approach.**
1. src/doctor/doctor.ts:
   - Add `export async function runDoctorCheck(run: () => CheckOutcome | null | Promise<CheckOutcome | null>): Promise<CheckOutcome | null>`. It returns `await run()`. When the call throws synchronously or rejects, it returns `failOutcome(\`the check threw: ${errorMessage(err)}\`)` instead. Import `failOutcome` from ./outcome.js (the module already imports `CheckOutcome` there as a type) and `errorMessage` from ../text/text.js.
   - In `runDoctor`'s loop, replace `await step.run()` with `await runDoctorCheck(step.run)`. A throw is reported as `fail`, not `warn`, because a check that crashed verified nothing, and the CLI's exit code should say so.
   - Add one sentence to `runDoctor`'s doc comment: a check that throws becomes its own fail row, and every other check still runs.
2. src/doctor/doctor-model-checks.ts, `checkImageInput`:
   - Wrap the `writeImageProbeCache` call in try/catch. On failure, set `let saveProblem: string | null` to `errorMessage(err)` (import it from ../text/text.js).
   - Move the verdict-building tail (everything after the write, through the final `return okOutcome(details)`) into a local `const verdict = (): CheckOutcome => { … }`. Then end the function with `const outcome = verdict(); if (saveProblem === null) return outcome;` followed by `return { level: outcome.level === "ok" ? "warn" : outcome.level, detail: \`${outcome.detail} — could not save the image-probe cache (${saveProblem}), so the next doctor probes again\` };`.
   - The in-memory `probes` map still feeds `seamImageInput` below the write, so this run's verdicts are unchanged.
3. test/doctor.test.ts: add the test "runDoctorCheck turns a throwing or rejecting check into a fail row and passes other outcomes through". It asserts:
   - a sync throw `() => { throw new Error("boom"); }` gives `{ level: "fail", detail: "the check threw: boom" }`;
   - an `async () => { throw new Error("late"); }` gives `detail: "the check threw: late"`;
   - `() => null` gives `null`;
   - `() => okOutcome("fine")` gives the same object (deepEqual).
4. test/doctor-model-checks.test.ts: add the test "checkImageInput keeps a fresh probe's verdict when the probe cache cannot be saved, and warns". Use `probeConfig()` and a passing probe, as in "checkImageInput with missing probes only uncached claimed models once, and caches the pass". Before the call, set `const undo = failRenameSyncOn(imageProbesPath(root), "disk full")` (from ./helpers/fs-faults.js), and call `undo()` in a `finally`. Assert:
   - `doesNotReject` on the call;
   - `level === "warn"`;
   - the detail still matches `/local\/vision \(verified \d{4}-\d{2}-\d{2}\)/` and also matches `/could not save the image-probe cache \(disk full\)/`;
   - `readImageProbeCache(root)` is `{}` afterwards (nothing was saved).
5. docs/invariants.md: append the section "## Doctor: one failing check never takes down the report" after the last section, in the Guarantee / Binds / Pinned by layout, with `### INV-CE1: a doctor check that throws becomes its own fail row, and a failed image-probe cache write keeps the run's verdicts`. Binds: `src/doctor/doctor.ts` (`runDoctorCheck`, `runDoctor`) and `src/doctor/doctor-model-checks.ts` (`checkImageInput`). Pinned by: the two new tests, cited by full name. On 2026-10-20, CC had merged and CD was reserved by the OpenCode catalog refresh plan, so CE was free. Re-check with `grep -n '^### INV-' docs/invariants.md | tail` and the Planned entries, and take the next free prefix if CE is gone.

**Acceptance criteria.**
- Making `runDoctorCheck` return `run()` without the try fails the new doctor.test.ts test.
- Removing the try around `writeImageProbeCache` fails the new doctor-model-checks.test.ts test (it rejects).
- The existing `checkImageInput` and `runDoctor` tests pass unchanged, including "checkImageInput with missing probes only uncached claimed models once, and caches the pass" and "runDoctor with only runs just the named checks, in report order".
- `npm run test:gate` passes.
- Each test name cited in INV-CE1 exists verbatim (`grep -rF` it in test/).

## Done
