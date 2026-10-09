# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### A review retry picks up the timed-out reviewer's session, part 1/3: per-review session directories (planned 2026-10-09 by operator; split from "A review retry picks up the timed-out reviewer's session instead of reviewing from scratch", which feature judged too large for one run)

When a reviewer run hits `review.timeoutSeconds` while still making progress (`PiRunResult.timedOutProgressing`), src/review/review.ts records `review_failed` with "the next attempt reviews it from scratch", so a change too big for one budget never converges. The fix is to continue the same reviewer session, which already holds everything it read. This part is behavior-neutral on its own and exists so part 2/3 can `--continue` exactly the timed-out run: pi's `continueSession` maps to `--continue` (src/pi/pi-args.ts), which reaches only the newest session in the shared `_review/<role>` directory, so another review in between would be the one continued.

**Goal:** each review run and the follow-ups on its session use their own directory, `reviewRunSessionDir(root, role, runKey)`, so a later attempt can continue precisely that run.

**Approach.**
1. `src/paths.ts`: add `reviewRunSessionDir(root, role, runKey): string` = `path.join(reviewSessionDir(root, role), runKey)`, documented as the per-run child of the role's review dir. Leave `reviewSessionDir` as the parent, so existing callers and `test/paths.test.ts` are unchanged.
2. `src/review/review.ts`: add a required `sessionDir: string` to `ReviewContext` (the directory this review run and its follow-ups use). `reviewAheadOfMain` passes `ctx.sessionDir` as `runGatePi`'s `sessionDir` (replacing `reviewSessionDir(root, role)`); drop the "fresh session every time" comment the per-run directory now supersedes.
3. `src/landing/landing-core.ts`: `reviewContextFor` sets `sessionDir: reviewRunSessionDir(ctx.root, req.role, `${req.tick}-${shortSha(req.sha)}`)`, importing `shortSha` from `../text/format.js`. `req.tick` plus the pinned sha keys one directory per review of one change, so a re-vet of the same sha reuses it and the vet and the conflict-resolved re-review agree.
4. `src/review/review-followup.ts`: `runFollowupTurn` reads `ctx.sessionDir` instead of computing `reviewSessionDir(ctx.root, ctx.role)`, so `requestVerdict`/`requestNoRerun` continue the run they follow; drop the now-unused import.
5. `src/files/files.ts`: `pruneOldFiles` recurses but deletes only files, so empty per-run directories would accumulate. In `walk`, after a subdirectory is walked, remove it with `fs.rmdirSync(d)` (try/catch, vanish-tolerant) when it is empty and its own mtime is older than the cutoff; update the doc comment.
6. Tests: `test/fixtures/gate-fixtures.ts`'s `gateCtx` gains `sessionDir: reviewRunSessionDir(root, ROLE, `${tick}-test`)`; `test/review-followup.test.ts`'s `makeCtx` literal gains the field and `touchSession` writes into the per-run dir; `test/files.test.ts` pins the empty-dir removal.

**Files touched:** src/paths.ts, src/review/review.ts, src/review/review-followup.ts, src/landing/landing-core.ts, src/files/files.ts, test/paths.test.ts, test/review-followup.test.ts, test/fixtures/gate-fixtures.ts, test/files.test.ts.

**Acceptance criteria:**
- A gate run's pi invocation carries `--session-dir <root>/sessions/_review/<role>/<tick>-<shortsha>`, and a follow-up run carries the same directory.
- Two reviews of different changes in one role use different directories; re-reviewing the same pinned sha uses the same one.
- `test/review-followup.test.ts` still passes with its session file in the per-run directory.
- `pruneOldFiles` removes an empty directory whose mtime is older than the window and leaves a non-empty one; the project's check passes.

### A review retry picks up the timed-out reviewer's session, part 2/3: record and resume a progressing-timeout review session (planned 2026-10-09 by operator; split from "A review retry picks up the timed-out reviewer's session instead of reviewing from scratch"; requires part 1/3 landed)

**Goal:** a review that hits its time budget while still making progress leaves a marker, and the next review of the same change continues that reviewer session instead of starting from scratch. Part 3/3 (separate) updates the event feed and failure-digest rendering.

**Approach.**
1. `src/loop/loop-state.ts`: add `reviewResume?: { patchId: string; sessionDir: string; attempts: number; at: number }` to `LoopState`, documented as the reviewer session a progressing timeout left for the next attempt. Heal it in `loadLoopState` with `healRecord` like `lastReview` (`v.attempts`/`v.at` through `healNumber`) and drop the field unless `patchId` and `sessionDir` are strings, so a corrupt marker cannot throw in `sessionResumable`. Export `REVIEW_RESUME_LIMIT = 2`.
2. `src/gates/gate-prompts.ts`: add `buildReviewResumePrompt(base, patchId)` beside `buildReviewPrompt`. It states the previous run hit its time budget, names the frozen base SHA and that the change's diff is unchanged (same patch-id), tells the reviewer to continue from where it stopped rather than re-reading what it already checked, and to finish with the `VERDICT` line. It carries no diff — the session already holds it.
3. `src/review/review.ts`, in `reviewAheadOfMain`:
   - Compute `const reviewedPatchId = await patchId(wt, mainBranch, head)` once (reuse it for the already-approved check too) — the same identity `state.lastApprovedPatchId` uses.
   - Decide `resuming` = `state.reviewResume` exists and `state.reviewResume.patchId === reviewedPatchId` and `state.reviewResume.attempts < REVIEW_RESUME_LIMIT` and `sessionResumable(state.reviewResume.sessionDir, { kind: "gate", agent: reviewCfg.agent ?? "pi" }, hasResumableSession(state.reviewResume.sessionDir))`.
   - When resuming: increment `state.reviewResume.attempts` and `saveLoopState(root, state)` before the run (a crash cannot loop); run with `sessionDir: state.reviewResume.sessionDir`, `continueSession: true`, and `buildReviewResumePrompt` instead of `buildReviewPrompt`. Log `review_start` with `resumed: true`. Otherwise clear `state.reviewResume` and run fresh with `ctx.sessionDir` and `buildReviewPrompt` as today.
   - On a progressing timeout of the review run itself (`!pi.ok && pi.timedOutProgressing`, not `pi.aborted`; not a follow-up/nudge failure): set `state.reviewResume = { patchId: reviewedPatchId, sessionDir: <the directory this run used>, attempts: resuming ? state.reviewResume.attempts : 0, at: Date.now() }` and `saveLoopState`. Every other failing path, any verdict (approve/reject), a strike-cap discard, and a landing clear it.
   - `reviewTimeoutRewrite` becomes conditional on whether a resume remains after this failure: while one does, "the commit is kept; the next attempt continues this review"; once the limit is spent (or the failure cannot resume), keep "the commit is kept; the next attempt reviews it from scratch".
   - The follow-up path is unchanged: the no-re-run rule and suite-rerun tripwire apply as today, and a follow-up continues the same (resumed or fresh) run directory.
4. Streak: a progressing timeout that will be resumed still counts for `consecutiveErrors`; the point is that the next attempt converges, so the counting is untouched.

**Files touched:** src/loop/loop-state.ts, src/review/review.ts, src/gates/gate-prompts.ts, test/loop-state.test.ts, test/review.test.ts, test/gate-prompts.test.ts.

**Acceptance criteria:**
- With a fake pi whose first gate run times out while progressing and whose next run approves, the second review of the same change runs with `--continue` in the timed-out run's own directory, its prompt is the resume prompt (not the full diff prompt), `reviewAheadOfMain` returns `approved`, and `state.reviewResume` is cleared. `review_start` for that run has `resumed: true`.
- A rebase onto a moved main that leaves the patch-id unchanged still resumes; a different patch-id (new commit, revision) reviews fresh and clears `reviewResume`.
- After `REVIEW_RESUME_LIMIT` resumes the next attempt reviews fresh and clears the field.
- A non-progressing timeout sets nothing; a connection error, a failed verdict follow-up, an abort, any verdict, a discard, and a landing each clear `reviewResume` and otherwise behave as today.
- `loadLoopState` drops a malformed `reviewResume` (non-string `patchId`/`sessionDir`, non-numeric `attempts`/`at`) without throwing.
- The project's check passes.

### A review retry picks up the timed-out reviewer's session, part 3/3: resumed-review event and failure digest (planned 2026-10-09 by operator; split from "A review retry picks up the timed-out reviewer's session instead of reviewing from scratch"; requires part 2/3 landed)

Part 2/3 already writes the accurate `review_failed` message itself (its conditional `reviewTimeoutRewrite`); this part makes the event feed and the failure digest read the same way. It is separable because a missing `resumed` render or a digest cluster is a reporting gap, not a behavior change.

**Goal:** a resumed review is legible in the feed, and the failure digest clusters "continues this review" separately from "reviews it from scratch" so the top-loss ranking counts the two honestly.

**Approach.**
1. `src/events/event-format.ts`: the `review_start` case renders `review resumed <shortSha>` (with ` (revision N)` when `revision` is set) when the event's `resumed` flag is set, else the current `reviewing …` line.
2. `src/failure/failure-cluster.ts`: add the "the next attempt continues this review" pattern as its own cluster and keep the existing "reviews it from scratch" pattern, so old log lines still cluster where they did.
3. Tests: `test/event-format.test.ts` for the resumed line (flag set and unset), `test/failure-cluster.test.ts` for the two patterns.

**Files touched:** src/events/event-format.ts, src/failure/failure-cluster.ts, test/event-format.test.ts, test/failure-cluster.test.ts.

**Acceptance criteria:**
- A `review_start` event with `resumed: true` renders `review resumed <sha>`, adding ` (revision N)` when `revision` is set; without the flag it renders the current `reviewing …` line.
- The failure digest clusters the two timeout messages under distinct causes, and a line with only the from-scratch wording still clusters where it used to.
- The project's check passes.

### Retract a config value: `tumwater config unset <key>` (planned 2026-10-09 by plan)

**Goal:** an operator can remove one value from `tumwater.json` — a top-level key, one
`maxDailyCostUsdPerRole`/`quietHoursPerRole` entry, one `model.<tier>` entry, or one
`roles.<id>.<field>` — so it reverts to its default or disappears from its map/section. Today
`tumwater config set` only writes: a role override such as `roles.qa.model` or a per-role cap has
no CLI to remove it, so it can only be retracted by hand-editing the file, which bypasses
`writeConfigMutation`'s process lock, `validateConfig`, and atomic write.

**Approach:**

- `src/config/config-write.ts`: add `unsetConfigKey(root, key): { ok: true; oldValue: unknown } |
  { ok: false; error: string }` beside `setConfigKey`, sharing `parseConfigKey`,
  `unknownConfigKeyError`, and `unknownRoleFieldError` so a typo reads the same whichever verb
  named it. On `kind: "top"` delete `cfg[key]`; on `kind: "map"` delete the named `[role]`
  entry; on `kind: "tier"` delete the named entry of `modelTierMap(record.model)`; on
  `kind: "role"` delete the named field of the role entry. Drop the containing key/section when
  it empties (an emptied map, the last field of a `roles.<id>` entry, an emptied `model` map) so
  the file never keeps an empty object; a key that does not hold the named entry is a no-op
  success. Run the merged candidate through the existing `writeConfigMutation` unchanged, so the
  lock, `validateConfig`, and `writeJsonAtomic` still own truth — a candidate validation rejects
  leaves the file byte-identical. Capture `oldValue` from the pre-mutation object (the value
  removed, or `undefined` when nothing was set). Legacy `provider`/`fallbackModel` top-level keys
  unset normally (only `set` refuses to add them).
- `src/cli/config-commands.ts`: dispatch `sub === "unset"`, running `get`'s existing
  dotted-key screens first (unknown role id via `knownRoleIds`/`unknownRoleMessage`, unknown role
  field via `unknownRoleFieldError`), then `unsetConfigKey`; print one confirmation line naming
  the key (and the removed value when there was one). Extend `CONFIG_USAGE` and the module
  comment to the `get`/`set`/`unset` shape.
- `src/cli.ts`: the `config` arity gate accepts `unset` and requires exactly two args (`unset
  <key>`), like `get`.
- `src/cli/help.ts` (`HELP`'s config stanza), `README.md` (the Settings paragraph after
  `tumwater config set`), and `docs/how-it-works.md` (the Configuration mention near line 277)
  document `unset <key>` as the inverse of `set`.

**Files touched:** `src/config/config-write.ts`, `src/cli/config-commands.ts`, `src/cli.ts`,
`src/cli/help.ts`, `README.md`, `docs/how-it-works.md`, `test/config-write.test.ts`,
`test/config-commands.test.ts`.

**Acceptance criteria:**

- `tumwater config unset roles.qa.model` on a config that holds it removes the field and leaves
  the entry's other fields; when the entry empties, `roles.qa` is gone from `tumwater.json`, and
  `tumwater config get roles.qa.model` then prints `null`.
- `tumwater config unset maxDailyCostUsdPerRole.feature` removes that entry and preserves the
  map's other roles; `tumwater config unset model.strong` removes that tier (a single-selector
  string `model` is left untouched when the named tier is not one of its resolved entries);
  `tumwater config unset quietHours` removes the top-level key and `config get quietHours` then
  reads the default.
- Unsetting an absent entry (e.g. `maxDailyCostUsdPerRole.clean` with no entry) exits 0 as a
  no-op and changes nothing.
- `unset modle`, `unset roles.qqq.model`, and `unset roles.qa.colour` fail with the same
  unknown-key/unknown-role/unknown-field wording `set` and `get` already use, and write nothing;
  a candidate `validateConfig` rejects (e.g. unsetting `customLoops` while a custom loop's
  `roles.<name>` entry remains) leaves `tumwater.json` byte-identical.
- `tumwater config unset` with no key fails with `CONFIG_USAGE`; `unset <key> extra` fails the
  `cli.ts` arity gate.
- `test/config-write.test.ts` covers `unsetConfigKey` (top-level removal, dotted map/tier/role
  removal preserving siblings, empty-section cleanup, absent no-op, unknown-key rejection,
  byte-identical file on a validation failure) and `test/config-commands.test.ts` covers the
  command shell and its wording; the project's check passes.

### Agent backends, part 3c/7: the claude backend, ledger-backed sessions, and PATH fake (planned 2026-10-09 by plan; split from part 3/7; requires parts 3a/7 and 3b/7 landed)

Design: plans/agent-backends.md ("The seam", "Sessions", "Testing").

Registers claude as an adapter and proves a run end to end on a fake. Still not selectable from
tumwater.json (part 4/7); tests drive it through `runAgent` with `config.agent = "claude"`.

**Approach.**
1. **Adapter.** Add a new `claude-backend` module under src/agent/claude/ as an `AgentBackend`: `id: "claude"`, a
   label, `defaultBin: "claude"`, `binEnv: "TUMWATER_CLAUDE_BIN"`, `resolveBin` via
   src/pi/pi-bin.ts, `invocation` composing claude-args (with the session decision) +
   claude-env, `translator` from part 3a, and `classifyExit` (the stderr half of `configError`,
   e.g. a 404 or "Not logged in" printed on stderr). Register it in src/agent/run-agent.ts.
2. **Sessions.** In `invocation`, mint a UUID for a fresh run and `recordSession` before the
   spawn; for a resume, take `resumableSession(dir, {kind, cwd, agent: "claude"})` and pass
   `--resume <id>` only when its transcript file exists and the record's cwd matches (the cwd
   half part 2/7 deferred here).
3. **Native log.** src/agent/run-agent.ts writes each native line to
   `.tumwater/log/<role>.<agent>.native.jsonl` (a `nativeLogPath` helper in src/paths.ts),
   rotated and pruned like the raw log; canonical lines keep going to the existing raw log. The
   runner emits part 3a's translator warnings — the unmapped-type reports and a result-less
   run's `cost_unknown` — once each as `agent_unknown_event` warnings.
4. **Fake.** Add `fake-claude.ts` under test/fakes/ — a PATH shim named `claude` replaying canned
   stream-json, logging argv and stdin per run, and creating
   `~/.claude/projects/<slug>/<id>.jsonl` under a temp HOME. Strip `TUMWATER_CLAUDE_BIN`,
   `CLAUDECODE` and `CLAUDE_CODE_*` in test/test-runner.ts.

**Interactions (resume, handoff, revision, conflict hand-back).** Added 2026-10-09 by operator.
Agent backends 2/7 took three review rounds because its plan left out how a handoff combines
with the revise-rejected and conflict hand-back paths. This part makes handoffs routine: every
`resumeMissing` becomes one. Each case below needs a fake-claude test in
test/loop-interrupted.test.ts.
- **Resume.**
  - In `planTickStart` (src/tick/tick-resume.ts), the newest author line for this agent is
    resumable only when `hasResumableSession(dir)` finds a pi session file in the tumwater
    session dir.
  - A claude transcript lives under `~/.claude/projects/<slug>/` instead, so that check becomes
    per-backend: the transcript for the line's `id` must exist.
  - The line's `cwd` must also equal the leased worktree, because claude's resume is
    cwd-scoped. `sessionResumable` already takes `cwd`. A pinned slot normally gives the same
    cwd; a different cwd is a handoff, never a `--resume`.
- **`resumeMissing` → handoff.** The retry in `runWithTransientRetry` (src/loop/loop-pi.ts) must
  behave exactly like tick-resume's handoff:
  - keep the worktree;
  - skip both re-applies, the conflict hand-back and the revision (the `!resuming && !handoff`
    guards in src/loop/loop-tick.ts);
  - send the fresh-session notes below.
  Route it through the same plan rather than a second copy of the rules.
- **Fresh-session notes.** A handoff starts a fresh session, so every note the interrupted run
  had in its context must be re-sent.
  - The revision note already is (the `if (handoff)` branch in loop-tick.ts's revision block).
  - **The conflict hand-back note is not.** A handoff over a hand-back that was already applied
    (`conflictHandback.applied`, markers in the worktree, including a revision that re-applied
    with conflicts) appends no `buildConflictHandbackNote`. The fresh run meets the markers
    with no explanation.
  - Fix it in this part, with a test: an interrupted tick with an applied hand-back plus a
    handoff produces a prompt that contains the hand-back note, and the markers are intact.
- **Same-session retries and follow-ups.** These continue the run that just finished. For
  claude that is `--resume <that run's ledger id>`, never "the newest session":
  - the transient retry (`continueSession: true` in loop-pi.ts);
  - the SUMMARY follow-up (`requestFollowUp`, prompt-followup.ts);
  - the review follow-ups (review-followup.ts).
- **Interrupted review.** Unchanged: `phase === "review"` blocks both resume and handoff
  (`resumeBlocked`). Add one claude case proving it.

**Files touched.**
- `claude-backend.ts` under src/agent/claude/ (new)
- src/agent/run-agent.ts, src/paths.ts, src/orchestrator/retention.ts
- `fake-claude.ts` under test/fakes/ (new); `claude-run.test.ts` under test/ (new); test/test-runner.ts

**Acceptance criteria.**
- **Run.** `runAgent` on fake-claude with `config.agent = "claude"` produces the folded
  `PiRunResult` (cost, turns, tokens), and the raw log renders in `tumwater logs --role` and the
  progress tail as a pi run would.
- **Sessions.** A fresh run mints an id, records a ledger line and passes `--session-id`; a
  requested resume from the same cwd/kind passes `--resume <id>`; a record from another cwd does
  not.
- **Readers.** suite-rerun detects a reviewer's `Bash` `npm test` through the `bash` mapping.
- **Env.** The spawned env has no `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID` even when the suite's
  parent had them, and stdin carries the prompt.
- The native log file is written and rotated with the raw log.
- **Warnings.** A result-less run's `cost_unknown` and an unmapped native type each log once as an
  `agent_unknown_event`; a run over an unmapped type does not fail.
- `npm run test` green.

### Agent backends, part 3d/7: `resumeMissing` resumes once as a `handoff` (planned 2026-10-09 by plan; split from part 3/7; requires part 3c/7 landed)

Design: plans/agent-backends.md ("Sessions").

**Approach.**
1. When a run ends with `PiRunResult.resumeMissing` (part 3a), `runWithTransientRetry`
   (src/loop/loop-pi.ts) retries once with `continueSession` unset and the `handoff` cause from
   part 2/7: `buildHandoffPrompt` (src/prompt/prompt-followup.ts) carries the bridge text, and
   the worktree is left as is, so the retry's fresh session still sees the interrupted run's
   uncommitted edits.
2. The retry follows the existing transient-retry shape (warn, fold the failed attempt, run the
   fresh handoff), and the `resume` event reports the `handoff` cause.

**Files touched.**
- src/loop/loop-pi.ts
- test/loop-pi.test.ts or test/loop-interrupted.test.ts

**Acceptance criteria.**
- A fake-claude run whose `--resume` id has no transcript yields `resumeMissing`, and the loop
  retries once fresh with the handoff bridge prompt; the worktree's uncommitted edits are still
  present for the retry.
- A run that does not report `resumeMissing` is not retried.
- `npm run test` green.

### Agent backends, part 4/7: `agent` / `agents` config, selector routing, per-tier claude defaults, doctor and labels (planned 2026-10-09 by operator; requires part 3d/7 landed)

Design: plans/agent-backends.md ("Config", "Every seam, checked" — doctor, startup and status
rows).

Makes claude selectable.

**Approach.**
1. **Schema.** Add to src/config/config-schema.ts:
   - `agent` (`"pi" | "claude"`, default `"pi"`);
   - `agents.<id>.{bin, args}`;
   - legacy `agentBin`/`piArgs` read as `agents.pi.*` (both forms → a validation error);
   - a per-agent reserved-flags set (`HARNESS_CLAUDE_FLAGS`).
2. **Routing.** src/config/model-selector.ts + config-views.ts (`withModelOverrides`) resolve
   `agent` per seam:
   - the provider segment is an agent id → that agent;
   - any other provider → pi;
   - a bare id → top-level `agent`;
   - no `model` key at all → that agent's `defaultModels` for the seam's tier: claude
     `small` → `claude-haiku-5-5`, `default` → `claude-sonnet-5-5`, `strong` →
     `claude-opus-5-5`. Once `model` is set, today's tier inheritance applies unchanged.

   It flows through `configForRole`, `reviewRunConfig`, `resolverConfig` and the fallback views.
3. **Binaries.** src/pi/pi-bin.ts generalizes to `resolveAgentBin(config, agent)` with
   `TUMWATER_<ID>_BIN` → `agents.<id>.bin` → `defaultBin`. The startup gate and doctor check
   every agent some enabled seam resolves to.
4. **Doctor.**
   - claude: `claude auth status` (scrubbed env) must report `loggedIn`, and doctor prints the
     billing it implies (subscription type, or API key);
   - the installed claude version must be at least the claude adapter's `minVersion` for every
     configured claude model (2.1.280 for the three defaults), and doctor prints it;
   - claude selectors skip the models.json lookup;
   - a pi provider named `claude` warns;
   - the `off`/`minimal` effort clamp is noted;
   - the total size of claude transcript dirs is reported.
5. **Pricing.** Route `pairFree`, `fallbackModelFree` and `fleetModelsFree`
   (src/pi/pi-models.ts) through the backend's `pricing`. In this part, claude selectors are
   never free; part 6/7 makes subscription billing free.
6. **Writers.** `tumwater config set agent claude` and `agents.claude.args`; `agent` joins
   `EDITABLE_CONFIG_KEYS` and the GUI settings mirror. tumwater.example.json and
   config-example.ts are updated.
7. **Labels.** "pi default" becomes "`<agent>` default" (role-render.ts, badges.ts,
   event-format.ts). Model selectors on `tick_start`/`review_start`/status rows carry the agent
   (`claude/claude-sonnet-5-5`).
8. **Docs.**
   - README "Backends": `agent`, routing, the expected-spend note.
   - docs/backends.md: a claude section.
   - `Built on pi` → `Built on pi; also runs on Claude Code`.

**Interactions (resume and handoff under routing).** Added 2026-10-09 by operator.
Routing lets a seam's agent change between an interrupted tick and the next one, through a
config edit or the budget fallback moving a claude seam to a pi fallback or back.
`planTickStart` compares the newest author line's `agent` with the tick's `cfg.agent`
(loop-tick.ts passes it), so that change is a handoff, not a resume. Test, on fake-claude and
fake-pi:
- **Fallback flip.** An interrupted claude author tick, with the fallback active on the next
  tick, runs a fresh pi session in the unreset worktree. Its prompt carries the handoff bridge,
  the revision note when a revision was in flight, and the hand-back note when one was applied.
- **Config flip mid-revision.** Changing `agent` from pi to claude while a revision is
  interrupted does the same. It does not re-cherry-pick the rejected diff.
- **Mixed seams.** A conflict resolver routed to a different agent than the author writes its
  line in the author's session dir. The author's next resume is then a handoff even though the
  author's own agent did not change. This is intended; pin it with a test.
- **Selectors.** `cfg.agent` must come from the same resolved view the run uses (`configForRole`
  plus the fallback view). If the resume check reads a different view than the spawn, a fallback
  tick will `--continue` the wrong backend's session.

**Files touched.**
- src/config/config-schema.ts, config-validation.ts, config-field-checks.ts, config-write.ts,
  config-views.ts, model-selector.ts, config-editable-keys.ts, config-example.ts
- src/ui/gui/gui-client-settings.ts
- src/pi/pi-bin.ts, src/pi/pi-models.ts
- src/gates/startup-gate.ts
- src/doctor/doctor-checks.ts, src/doctor/doctor-model-checks.ts
- src/roles/role-render.ts, src/ui/badges.ts, src/events/event-format.ts
- tumwater.example.json, README.md, docs/backends.md

Tests: cases in the config*, model-selector, pi-bin, startup-gate, doctor-model-checks and
role-view tests.

**Acceptance criteria.**
- **One line.** `{ "agent": "claude" }` runs on fake-claude with:
  - `--model claude-sonnet-5-5` for author ticks;
  - `--model claude-opus-5-5` for the reviewer, the plan role and the conflict resolver;
  - `--model claude-haiku-5-5` for readme.

  `{ "agent": "claude", "model": "claude-sonnet-5-5" }` runs every seam on Sonnet.
- **Mixed.** `{ "agent": "claude", "fallback": "omlx/Qwen…" }` runs the fallback on fake-pi with
  `--provider omlx`.
- **Per-seam.** `{ "review": { "model": "claude/claude-opus-5-5:high" } }` under `agent: "pi"`
  runs only the reviewer on claude, with `--effort high`.
- **Legacy.** An existing config with `agentBin` + `piArgs` and no `agent` produces byte-identical
  pi argv.
- **Doctor.** Doctor fails "claude auth" when fake `claude auth status` reports
  `loggedIn: false`. It fails "claude version" when fake `claude --version` reports 2.1.216
  with Opus configured.
- **Free-ness.** A claude `fallback` is rejected at runtime as not free, exactly like a priced pi
  pair.
- `npm run test` green.

### Agent backends, part 5/7: `role_notes` over MCP and the prompt dialect (planned 2026-10-09 by operator; requires part 4/7 landed)

Design: plans/agent-backends.md ("What the pi extensions did, per backend").

**Approach.**
1. **MCP server.** src/agent/mcp/role-notes-server.ts is a dependency-free stdio MCP server
   (JSON-RPC `initialize`, `tools/list`, `tools/call`) exposing `role_notes {text}`.
   - It writes through the same atomic, 4 KB-capped function as src/pi-extension/role-notes.ts
     (extract it to src/agent/role-notes-write.ts).
   - The claude adapter passes it with
     `--mcp-config '{"mcpServers":{"tumwater":{"command":"node","args":[<dist path>]}}}'` only
     when the run has a `notesPath`.
2. **Dialect.** `PromptDialect` on each backend supplies:
   - the notes tool name (`role_notes` / `mcp__tumwater__role_notes`);
   - the read-range phrase;
   - the oversized-output bullet: pi's head+tail marker vs claude's "large output is saved to a
     file it names — read that file in ranges".

   `ROLE_NOTES_INSTRUCTION` and `CONTEXT_BUDGET_RULE` (src/prompt/prompt.ts) and
   prompt-followup.ts become functions of the dialect. pi's text stays byte-identical.
3. **AGENTS.md.** When the worktree has `AGENTS.md` and no `CLAUDE.md`, claude runs get
   `--append-system-prompt-file AGENTS.md`.

**Interactions (resume and handoff prompts).** Added 2026-10-09 by operator.
- **Prompt texts.** The resume and handoff texts become dialect functions alongside
  `ROLE_NOTES_INSTRUCTION`, wherever they name a tool or the notes file:
  - `buildResumePrompt` and `buildHandoffPrompt` (src/tick/tick-resume.ts);
  - `buildRevisionNote` and `buildConflictHandbackNote`.
  A pi→claude handoff renders in claude's dialect, and a claude→pi handoff in pi's.
- **Per-run flags.** claude does not keep flags across `--resume`, so every claude invocation
  that writes notes must pass `--mcp-config` again, including resumes, transient retries and
  SUMMARY follow-ups. Test it with a resumed claude tick on fake-claude.

**Files touched.**
- src/agent/mcp/role-notes-server.ts, src/agent/role-notes-write.ts (new)
- src/pi-extension/role-notes.ts
- src/agent/claude/claude-args.ts
- src/prompt/prompt.ts, src/prompt/prompt-followup.ts
- src/tick/tick-prompt.ts

Tests: test/role-notes-mcp.test.ts (spawn the server, call the tool, check the file and the
cap), plus prompt snapshot cases for both dialects.

**Acceptance criteria.**
- **Unchanged pi.** pi tick prompts are byte-identical to before.
- **claude prompts.** A claude tick prompt names `mcp__tumwater__role_notes`. A claude authoring
  run on fake-claude receives `--mcp-config` naming the server. Director, review and landing runs
  do not.
- **Server.** The server rejects a note over 4 KB with a tool error, and leaves the old note
  intact.
- `npm run test` green.

### Agent backends, part 6/7: subscription billing — exempt from the cap, throttled and displayed by the usage window (planned 2026-10-09 by operator; requires part 4/7 landed)

Design: plans/agent-backends.md ("Billing: subscription or API", "The subscription usage
window").

Operator decision 2026-10-09: a run paid by a claude.ai subscription does not count against the
daily dollar cap. The five-hour window is its only throttle, and the TUI/GUI show that window
instead of the daily spend. API-key runs keep today's spending rules.

**Approach.**
1. **Account state.** Add src/agent/claude/claude-account.ts, which reads and writes
   `.tumwater/state/claude-account.json`:
   - `{billing, subscriptionType, observedAt, windows: {<rateLimitType>: {status, resetsAt,
     utilization?, overageStatus, isUsingOverage, observedAt}}}`;
   - the startup gate seeds it from `claude auth status` plus `ANTHROPIC_API_KEY`;
   - runAgent overwrites it from each claude result's `billing` and `rateWindows`;
   - readers treat a window past its `resetsAt` as reset.
2. **Spend.**
   - A subscription run without `usedOverage` folds its cost into a new `notionalCostUsd`
     (src/tick/tick-usage.ts, landing-slot.ts, landing-core.ts), never into `recordDailyCost` or
     the per-role spend.
   - A run with `usedOverage`, or with `billing: "api"`, folds its cost into `costUsd` as today.
   - `tick_end` gains `notionalCostUsd` and `billing`.
3. **Free-ness.** The claude backend's `pricing.pairFree` returns true while the account state's
   billing is `subscription`, so the following happens with no budget-gate changes:
   - `applyFallbackModel` leaves subscription seams alone at the cap;
   - a subscription claude `fallback` is accepted;
   - `fleetModelsFree` turns true when every seam is subscription claude.
4. **Hold.**
   - A window reading with `status: "rejected"` and no overage places a provider-`claude` fleet
     hold until `resetsAt` (src/fleet/fleet-hold.ts, fleet-polls.ts). It covers subscription
     claude seams only.
   - Events, each logged once per window: `claude_window_warning`, `claude_window_limited`
     {type, resetsAt} and `claude_window_reset` (src/events/events.ts, event-format.ts).
5. **Display.**
   - Add a `claudeWindow` block to the status payload (src/status/status-data.ts,
     src/ui/status-payload.ts) with the most constrained window and the full list.
   - The budget badge (src/ui/badges.ts), the TUI budget line and the GUI budget tile
     (gui-client-*) follow the design's table:
     - **subscription only:** the window replaces the daily spend, e.g. "Claude 5h · 64% · resets
       14:30" (the status word when no `utilization`), amber at `allowed_warning`, red "held
       until 14:30" at `rejected`, and an "overage" marker;
     - **mixed:** both lines, with the daily spend covering priced seams only;
     - **no subscription:** unchanged.
   - `tumwater role <id>` shows the billing line.
   - `tumwater report` shows notional spend on its own line, outside the total.
6. **Docs.** README: billing detection, the window display, and overage counting as real spend.

**Interactions (resume across a usage-window hold).** Added 2026-10-09 by operator.
- **Hold mid-run.** A subscription claude run cut off by a `rejected` window keeps its
  worktree. After `resetsAt`, the run resumes with `--resume <same id>`; it is not a handoff,
  because the agent did not change and 6/7 never moves subscription seams to the fallback.
- **Resume state.** Confirm the run's outcome sets `resumePending`. A rate-limit end that
  currently routes to a fresh tick would reset the worktree and lose the edits.
- **Test.** An interrupted fake-claude author tick, a hold, then a reset produces one resume with
  the same session id, with edits intact.
- **Overage and API billing.** When overage or API billing does move a seam to its fallback, the
  4/7 handoff rules apply unchanged.

**Files touched.**
- src/agent/claude/claude-account.ts (new), src/agent/claude/claude-backend.ts
- src/agent/run-agent.ts
- src/tick/tick-usage.ts, src/tick/tick-finalize.ts
- src/landing/landing-slot.ts, src/landing/landing-core.ts
- src/fleet/fleet-hold.ts, src/fleet/fleet-polls.ts
- src/events/events.ts, src/events/event-format.ts
- src/status/status-data.ts, src/ui/status-payload.ts, src/ui/badges.ts,
  src/ui/status-render.ts, src/ui/gui/gui-client-*.ts
- src/roles/role-render.ts, src/report/report-data.ts
- src/gates/startup-gate.ts
- README.md

Tests:
- test/claude-account.test.ts
- cases in test/tick-usage.test.ts, test/fleet-hold.test.ts, test/tui-budget.test.ts, the GUI
  budget-tile tests and test/report.test.ts

**Acceptance criteria.**
- **Exempt.** With `maxDailyCostUsd: 15` and subscription billing, ten fake-claude ticks costing
  $3 each leave the daily spend at $0. No seam moves to its fallback, and `tumwater report`
  shows "$30.00 notional".
- **Overage.** The same ticks with `isUsingOverage: true` count $30 against the cap, and the cap
  moves them to the fallback.
- **API.** With `apiKeySource: "ANTHROPIC_API_KEY"`, the costs count against the cap exactly
  as a priced pi model's do.
- **Hold.** A `rejected` five-hour reading holds subscription claude seams until `resetsAt`,
  while pi seams tick. It logs `claude_window_limited` once and `claude_window_reset` once.
- **Display.** An all-subscription fleet's TUI and GUI show the window line and no daily-spend
  line. A mixed fleet shows both. A pi-only fleet's rendering is byte-identical to before.
- `npm run test` green.

### Agent backends, part 7/7: API per-run cap, watchdog thresholds, smoke test (planned 2026-10-09 by operator; requires part 6/7 landed)

Design: plans/agent-backends.md ("Billing" — API runs, "Watchdogs and progress", "Testing").

**Approach.**
1. **Per-run cap.** Every API-billed, non-director claude run gets `--max-budget-usd` = the
   remaining daily budget (the lower of the fleet's and the role's remaining cap). Billing is
   read from the account state before the spawn.
   - `budgetCapped` (from `error_max_budget_usd`) is handled like a budget handback: the
     worktree is kept, and the next tick runs as `handoff` on the seam's fallback.
   - A run with no `result` records cost 0 and logs `cost_unknown`.
2. **Stall threshold.** For claude, src/pi/pi-watchdogs.ts and src/ui/progress-data.ts use
   `bufferedCommandStallMs` for every open tool call, since claude sends no content updates.
   They pick the backend from the `tumwater_run` marker's `agent`.
3. **Smoke script.** `scripts/smoke-claude.mjs` (`npm run smoke:claude`) is opt-in, not part of
   `npm test`. It runs against a temp git repo:
   - one call on each default model (Haiku, Sonnet, Opus 5.5), so a CLI too old for one fails
     here;
   - a three-turn isolated run, failing if cost exceeds $0.10 (isolation regression);
   - a `--resume`;
   - a SIGTERM mid-tool, then a resume;
   - an unknown-model run, which must classify as `configError`;
   - a check that the observed `billing` matches `claude auth status`.

**Interactions (`budgetCapped` handback).** Added 2026-10-09 by operator.
- **Setting up the handoff.** `planTickStart` only considers a handoff when
  `state.resumePending` is set, so the `budgetCapped` path must set it, with a new
  `resumeCause` (e.g. `"budget"`, named in the bridge prompt). Otherwise the next tick runs as a
  fresh tick and resets the worktree, losing the edits.
- **Notes and guards.** That handoff gets everything a 3/7 handoff gets:
  - the revision note and the conflict hand-back note;
  - no re-apply of either;
  - the leased slot pinned for the resume.
- **Claims.** With parallel instances, the claim stays with the same loop id.
- **Test.** A `budgetCapped` claude revision tick with an applied hand-back is followed by a pi
  fallback tick with both notes and an intact worktree.

**Files touched.**
- src/agent/claude/claude-args.ts
- src/loop/loop.ts (handback on `budgetCapped`)
- src/pi/pi-watchdogs.ts, src/ui/progress-data.ts
- scripts/smoke-claude.mjs (new), package.json, README.md

Tests: cases in test/pi-watchdogs.test.ts, test/progress.test.ts, test/claude-args.test.ts,
and a loop test for `budgetCapped` → handoff.

**Acceptance criteria.**
- **Cap math.** On API billing, with $12 of a $15 cap spent, a claude author run gets
  `--max-budget-usd 3`. The director gets none, and a subscription-billed run gets none.
- **Stall warning.** A claude Bash call open for longer than `toolCallStallSeconds` but shorter
  than `bufferedCommandStallMs` raises no stall warning.
- **Smoke.** `npm run smoke:claude` passes on a logged-in machine. Run it once by hand and record
  the result in the landing commit body.
- `npm run test` green.


## Done

### Edit an operator-filed backlog entry: `tumwater plan --edit <n>` and `tumwater bug --edit <n>` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

`tumwater bug`/`tumwater plan` file entries (`fileAndAnnounce`/`fileBug`/`filePlan` in
`src/backlog/backlog-write.ts`) and `--cancel <n>` retracts them (`cancelAndAnnounce`/
`removeEntry`), but nothing rewrites one in place: a mistyped symptom, a stale plan title, or a
body an operator wants to correct must be fixed by hand-editing BUGS.md/PLANS.md, which bypasses
`withStateLock(primaryWorktreeLockPath(root))` and can clobber a landing's working-tree
fast-forward. `tumwater prompt` already has the whole verb set (`--list`/`--cancel`/`--edit`);
this completes the backlog's.

**Goal:** an operator can replace the nth entry's text in BUGS.md `## Open` or PLANS.md
`## Planned` in its existing position, keeping the entry's original filing/refinement stamp and
the cross-process lock, without a wake.

**Approach:**

- `src/backlog/backlog-write.ts`: add `editEntry`/`editEntryLocked` beside
  `removeEntry`/`removeEntryLocked`, under the same `withStateLock(primaryWorktreeLockPath(root))`
  guard. Locate the entry with `actionableEntryRanges(md, sectionTitle)` (fence-aware, so a
  `### ` line quoted inside an entry's code fence is body text) and, for a position outside
  `1..entries.length`, fail with the existing `sectionNoun` wording — `no <noun> at position <n>
  (<count> in <file>)` — writing nothing.
- Preserve the stamp while replacing the whole entry. Read the entry's full heading metadata as
  `headingMetadata(lines, entry.start - 1).text` (the join that folds a wrapped heading's
  continuation onto one line) and take its trailing suffix as
  `metaText.slice(stripEntryStamp(metaText).length)` (`stripEntryStamp`, backlog-structure.ts) —
  empty when the heading carries no `(planned …)`/`(reported …)` parenthetical. Rebuild the block
  as `### <newTitle><suffix>` plus the new body and splice it over the entry's `start..end`
  range, so the original date and the entry's position survive and a formerly wrapped heading is
  re-collapsed to one line.
- Match the append/remove blank-line shape: exactly one blank line between the rebuilt entry and
  whatever follows it, and no extra trailing blank at EOF (the `trimLeadingBlankLines`/
  `trimTrailingBlankLines` helpers are available).
- Two thin callers: `editBug(root, n, rawText, usage)` collapses `rawText` through
  `collapseWhitespace` (the `fileBug` rule), fails `bug needs a symptom: <usage>` when empty, then
  calls `editEntry(root, "BUGS.md", "Open", n, symptom, "")`; `editPlan(root, n, rawTitle,
  rawBody, usage)` collapses both, fails `plan needs a title: <usage>` on an empty title, then
  `editEntry(root, "PLANS.md", "Planned", n, title, body)`. Each returns `{ file, title }` with
  the new title.
- Add `editAndAnnounce(root, args, command, edit)` to the same module, mirroring
  `cancelAndAnnounce`'s peeling: consume `--edit <n>` (parse the position through the shared
  `parsePositiveInt`, failing `--edit needs a positive integer…`), accept `--json` at most once,
  refuse a second `--edit`, tolerate `--help`/`-h`, and name any other flag through
  `rejectUnknownArgs`. Unlike cancel, everything left is the new text (the `fileAndAnnounce` prose
  classification: `collapseWhitespace` folds it to one line, so a quoted `## `/`### ` line can
  never grow a phantom section). After `requireReadyRepo`, print `edited <command> in <file>:
  <title>` or the `--json` payload `{ file, title }`. No wake, like cancel — an edit adds no work
  for a loop to pick up.
- `src/cli.ts`: the `bug` and `plan` cases dispatch to `editAndAnnounce` when `args` includes
  `--edit`, ahead of the `--cancel` and filing branches.
- `src/cli/help.ts`: a `tumwater bug --edit <n> "<symptom>"` and a `tumwater plan --edit <n>
  "<title>" [body...]` stanza, and add `--edit` to `FREEFORM_VALUED_FLAGS.bug`/`.plan` so the
  `--help` interception skips the position value. `README.md`'s bug/plan table cells mention
  `--edit` beside `--cancel`.

**Files touched:** `src/backlog/backlog-write.ts`, `src/cli.ts`, `src/cli/help.ts`, `README.md`,
`test/backlog-write.test.ts`.

**Acceptance criteria:**

- `tumwater bug --edit 2 "the corrected symptom"` replaces the 2nd `## Open` entry's heading
  text, keeps its `(reported by the operator <original date>)` suffix verbatim and its position,
  and leaves every other entry, both `## ` headings, and the surrounding bytes unchanged.
- `tumwater plan --edit 1 "A corrected title" corrected body text` replaces that entry's heading
  (keeping its trailing `(planned …)`/`(reported …)` suffix) and its body; the entry stays first
  and every other `## Planned` entry is untouched.
- A formerly wrapped heading is rebuilt on one line with its stamp intact; text quoting a `## `
  or `### ` line is folded to one line, so no phantom section is created.
- An out-of-range or non-decimal position fails with the cancel path's `no <noun> at position
  <n> (<count> in <file>)` / `--edit needs a positive integer…` wording, exits non-zero, and
  leaves the file byte-identical.
- `tumwater bug --edit 1 ""` and `tumwater plan --edit 1 ""` fail with `bug needs a symptom: …`
  / `plan needs a title: …` and write nothing.
- `--json` prints `{ file, title }` with the new title; the prose form names the file and the new
  title; no wake prompt is queued (`tumwater prompt --list` for the target loop is unchanged).
- `test/backlog-write.test.ts` covers the in-process edit (middle/first/last replacement,
  stamp and position preservation, fenced entry, empty/out-of-range failures, byte-identical file
  on failure) and the CLI shell (confirmation, `--json`, no wake, help topics); the project's
  check passes.

### Agent backends, part 3b/7: the claude invocation and isolation environment (planned 2026-10-09 by plan; split from part 3/7; requires part 3a/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("The claude invocation", "Findings", "Risks").

Two pure builders, unit-tested without a spawned process or a registered backend. The session
decision (which `--session-id`/`--resume` to use) is an input to the argv builder, so this part
stays ledger-free; part 3c supplies it.

**Approach.**
1. **Args.** Add a new `claude-args` module under src/agent/claude/: build the design's argv — `-p --output-format
   stream-json --verbose --model <id> [--effort <level>]`, the session flag passed in by the
   caller, `--permission-mode bypassPermissions`, `--tools Bash,Read,Edit,Write,Glob,Grep`,
   `--setting-sources project`, `--strict-mcp-config` (`--mcp-config` when a notes path is
   present), `--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`,
   `--append-system-prompt-file AGENTS.md` only when the worktree has AGENTS.md and no CLAUDE.md,
   and `[--max-budget-usd <remaining>]` (passed in), then the configured passthrough args. The
   prompt is returned as `stdin`, never an argv element. `--effort` maps the thinking level
   (`off`/`minimal` → `low`). A reserved flag repeated in the passthrough is rejected.
2. **Env.** Add a new `claude-env` module under src/agent/claude/: start from the run-marker/notebook environment
   (as pi's adapter builds it, src/pi/pi-backend.ts `withNotesPath`), then remove `CLAUDECODE`,
   every `CLAUDE_CODE_*`/`CLAUDE_AGENT_SDK_*` except the allowlist, `CLAUDE_PID`, `CLAUDE_EFFORT`,
   and `ANTHROPIC_BASE_URL` when `CLAUDECODE` was set; set
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`,
   `BASH_DEFAULT_TIMEOUT_MS=600000`, `BASH_MAX_TIMEOUT_MS` = `quietTimeoutSeconds` × 1000 − 60 s,
   `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`.
3. **Preload check.** Verify claude tolerates the macOS `NODE_OPTIONS` `--import=data:` preload.
   If it does, leave the environment as above; if it chokes, move the preload into the Bash
   tool's environment via `--settings '{"env":…}'` and record the choice in the module comment.

**Files touched.**
- `claude-args.ts` and `claude-env.ts` under src/agent/claude/ (new)
- `claude-args.test.ts` and `claude-env.test.ts` under test/ (new)

**Acceptance criteria.**
- **Argv.** The built argv matches the design's order and set, carries the passed session id or
  resume id, and carries no prompt (stdin does); `off`/`minimal` thinking yields `--effort low`.
- **Env.** The built env has no `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`/`CLAUDE_PID` and drops
  `ANTHROPIC_BASE_URL` only when `CLAUDECODE` was set; the allowlisted variables survive;
  `BASH_MAX_TIMEOUT_MS` is derived from `quietTimeoutSeconds`.
- The NODE_OPTIONS preload decision is made and recorded.
- `npm run test` green.

Implementation notes (2026-10-09): the args builder takes the notes MCP config path as an
option (part 5/7 supplies it); the preload decision — claude 2.1.295 is a native Mach-O binary
and ignores `NODE_OPTIONS`, so tumwater's preload stays on the environment for the Bash tool's
`npm` grandchildren — is recorded in claude-args.ts. With `quietTimeoutSeconds` 0 (quiet kill
disabled) no `BASH_MAX_TIMEOUT_MS` is set, leaving claude's own ceiling; a positive value below
60 s derives a cap floored at one second so it is never non-positive. The reserved-flag set
matches the design exactly (`--append-system-prompt-file` and
`--exclude-dynamic-system-prompt-sections` are emitted by the builder but are not in that
reserved set, so the builder does not reject them in the passthrough), and the thinking lookup
uses an own-property test.

### Agent backends, part 3a/7: the claude stream translator and canonical vocabulary (planned 2026-10-09 by plan; split from part 3/7; requires parts 1/7 and 2/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Canonical event stream").

Pure translation — no backend registration and nothing selectable from tumwater.json yet. Tests
feed fixture lines straight into the translator and the parser.

**Approach.**
1. **Translator.** Add a new `claude-stream` module under src/agent/claude/, implementing the design's mapping
   table as an `AgentBackend.translator()`-shaped factory (`translate(line): string[]`), stateful
   per run:
   - `system/init` → canonical `session` (`cwd`, `id`) then `agent_start`;
   - per-`message.id` coalescing of `assistant` events into one `message_end` (content blocks
     merged in order), usage counted once, `cost.total` 0;
   - each `tool_use` → `tool_execution_start` and each `user` `tool_result` →
     `tool_execution_end`, with the tool-name and `file_path` mapping;
   - `system/api_retry` → `auto_retry_start`; `system/compact_boundary` → `compaction_start`;
   - `result` → canonical `run_cost {total}` plus a synthetic error-bearing `message_end` when
     the run ended in error, carrying `tumwaterKind` and the classification below;
   - `rate_limit_event` → canonical `rate_limit` carrying the reading (type, status, `resetsAt`,
     `utilization`, `overageStatus`, `isUsingOverage`);
   - `system/init.apiKeySource` (+ the run env's third-party-provider flags) → canonical
     `billing: "subscription" | "api"`;
   - each unmapped native type is recorded once (a `warnings()` on the concrete translator, not
     on the `StreamTranslator` seam); part 3c turns each into an `agent_unknown_event` warning.
2. **Classification.** The translator sets `tumwaterKind` (and, for a rate-limit rejection,
   `retryAfterSeconds` from `resetsAt`) from `api_error_status`/`terminal_reason` per the
   design's table — 429 → `transientRateLimit`; 5xx/529 → `transientBackend`/`server`;
   connection/timeout text → `transientBackend`/`connection`|`timeout`; 400/401/403/404 and
   "Not logged in"/"issue with the selected model" → `configError`; "prompt is too long" →
   `contextExceeded`; `error_max_budget_usd` → `budgetCapped`; "No conversation found with
   session ID" → `resumeMissing`.
3. **Parser and result.** `PiStreamParser` (src/pi/pi-stream.ts) learns `run_cost` — its `total`
   becomes the run's authoritative `costUsd`, replacing the per-message sum — and `tumwaterKind`,
   trusted before the existing text regexes. A run that emitted no `run_cost` logs the
   `cost_unknown` warning with cost 0. `PiRunResult` (src/pi/pi-run-result.ts) gains
   `resumeMissing`, `budgetCapped`, `billing`, `rateWindows` and `usedOverage`.
4. **Fixtures.** the `claude-events.ts` fixture holds builders for the shapes above, trimmed from
   the 2026-10-09 captures (split-block assistant, 404, not-logged-in, SIGTERM, compact,
   `api_retry`, rate-limit-rejected).

**Files touched.**
- `claude-stream.ts` under src/agent/claude/ (new)
- src/pi/pi-stream.ts, src/pi/pi-run-result.ts
- src/agent/run-agent.ts (the new parser fields are assembled into PiRunResult there)
- `claude-events.ts` and `claude-stream.test.ts` under test/ (new)

**Acceptance criteria.**
- **Usage.** A split-block assistant message (text + tool_use, same id, usage repeated) folds to
  one `message_end`, 1 turn, tokens once. With a `result`, `costUsd` equals
  `result.total_cost_usd`; without one, the run logs the `cost_unknown` warning (recorded on the
  translator's warning log; part 3c surfaces translator warnings as `agent_unknown_event`) and the
  cost stays 0.
- **Errors.** The fixtures yield `configError` (404, not-logged-in), `transientRateLimit` (429),
  `transientBackend`/`server` (529), `contextExceeded`, `budgetCapped` and `resumeMissing`; a
  SIGTERM `aborted_tools` result carries no error classification.
- **Unknown events.** The translator reports an unmapped native type once; a run over it does
  not fail.
- `npm run test` green.

### Cover failure-caused loop pauses and model fallbacks in the failure digest's Fleet state changes (planned 2026-10-09 by plan; done 2026-10-09 by feature)

The failure digest's Fleet state changes section replays `STATE_CHANGE_TYPES` (src/failure/failure-state-change.ts) — the harness's own self-decisions that explain a stalled or failing loop. It already carries fleet pauses, operator per-role pauses, budget and rate-limit holds, live-config edits, redeploys and orchestrator lifecycle, but not the gate transitions added since `plans/telemetry-role.md` was written: `role_streak_paused` (the error-streak breaker auto-paused a role after consecutive failed ticks), `role_cap_paused`/`role_cap_resumed` (the role reached its own daily spend cap), and `model_fallback_started`/`model_fallback_ended` (the role tripped off its primary onto its fallback after provider-class failures). Each is the reason a loop stopped starting ticks or changed models, so today the digest can show the failed ticks and the error cluster without ever showing that the harness paused the role or moved it off-model. The event feed renders all five (`formatEvent` in src/events/event-format.ts); the digest alone drops them. BUGS.md's 2026-09-30 breaker-trip entry already reads as though the digest carried `role_streak_paused`; it does not.

**Approach.**
1. **The set.** Add the five event types to `STATE_CHANGE_TYPES` in src/failure/failure-state-change.ts: `role_streak_paused`, `role_cap_paused`, `role_cap_resumed`, `model_fallback_started`, `model_fallback_ended`. Collection needs no other change — failure-data.ts already filters the window against this one set (`current.filter((ev) => STATE_CHANGE_TYPES.has(ev.type))`).
2. **The wording.** Add one `describeStateChange` case per type, each bounded by the section's existing `field(...)` slicing and the closing `truncateExample(text, STATE_CHANGE_MAX)` pass, reusing the shared phrase helpers already imported (or importable) in the file:
   - `role_streak_paused` → `role <role> paused — <streak> ticks failed in a row` (an absent `streak` renders `?`, matching the feed's `textOr` fallback).
   - `role_cap_paused` → `role <role> paused — <budgetPhrase(spentUsd, capUsd)> of its daily cap spent`.
   - `role_cap_resumed` → `role <role> resumed — under its daily cap again`.
   - `model_fallback_started` → `model fallback — <provider>/<model> engaged (<reason>)`, with `provider`/`model` falling back to `pi default` and `reason` to `backend failure` — the feed's own fallbacks.
   - `model_fallback_ended` → `model fallback ended — back on <provider>/<model> after <shortSpanPhrase(finiteNumber(durationMs, 0))>`.
   Every role/provider/model/reason goes through `field(...)`; `budgetPhrase`, `shortSpanPhrase` and `finiteNumber` are already exported (src/text/phrases.ts) and `finiteNumber` is already imported here.
3. **The design doc.** Update `plans/telemetry-role.md`'s numbered section 2 (Fleet state changes) to name the five types beside the transitions it already lists, so the doc matches the set.

**Files touched.**
- src/failure/failure-state-change.ts (the set and five cases)
- test/failure-state-change.test.ts (the expected-type list and one pinned fixture per case)
- plans/telemetry-role.md (section 2's list)

**Acceptance criteria.**
- `STATE_CHANGE_TYPES.has(t)` is true for each of the five types, and the test's expected-type loop names them; `tick_end` stays absent.
- `describeStateChange` returns exactly the strings above for a representative event of each type (a `role_streak_paused` with `{role: "docs", streak: 10}`, a `role_cap_paused` with `{role: "feature", spentUsd: 1.5, capUsd: 1.5}`, a `role_cap_resumed`, a `model_fallback_started` with `{provider, model, reason}`, a `model_fallback_ended` with `{provider, model, durationMs: 300000}`), and a payload with the free fields missing still renders its fallback (`?`, `pi default`, `0s`) without throwing — these types no longer reach the `default:` arm.
- The digest's own section surfaces them: a `collectFailureReport`/`renderFailureMarkdown` fixture whose events.jsonl holds one `role_streak_paused` and one `model_fallback_started` lists both under `## Fleet state changes` in chronological order, each with its bounded line (the time/role cells the render adds are unchanged).
- Every existing `describeStateChange` case and every existing failure-digest test is unchanged; `npm run test` is green.

### A trailing window for the failure digest: `tumwater report --failures --since <duration>` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

`tumwater report --since <duration>` totals the fleet's usage over a trailing window (`collectReportSince`) and the failure digest (`collectFailureReport`) aggregates over whole local days, but the two shapes refuse each other: `cmdReport` fails `report --since <d> --failures` with "the failure digest has no windowed-since mode". An operator triaging an incident that just happened cannot ask "what failed in the last 30 minutes"; the narrowest digest is `--days 1`, whose Deltas compare today against all of yesterday rather than the equal period immediately before the incident. This adds the missing window, reusing the day digest's own sections.

**Approach.**
1. **Share the digest assembly.** In src/failure/failure-data.ts split `collectFailureReport` after its current/prior partition into an internal `assembleFailureReport(current, prior, allEvents, coversFullWindow, window)`, which returns the existing `FailureReportData`; the day collector keeps its `dayWindow`/`dayAt` read and partitioning and calls it unchanged. `FailureReportData` gains optional `sinceMs?: number` and `fromIso?: string` beside the existing `days`/`from`/`to` (still set, so the type and every existing consumer stay put).
2. **The since collector.** Add `collectFailureReportSince(root, sinceMs)`:
   - guard `sinceMs` against `REPORT_SINCE_MAX_MS` exactly as `collectReportSince` does (throwing, for callers that bypass the CLI's `parseSinceFlag`);
   - `const now = Date.now(); const cutoff = now - sinceMs;` then one `readWindowEvents(root, dayKey(cutoff - sinceMs))` spanning both halves, as the day collector's 2× read does;
   - partition by `ev.ts` (skipping a non-number, as `collectReportSince` does): `current` is `[cutoff, now]`, `prior` is `[cutoff - sinceMs, cutoff)`;
   - `coversFullWindow = eventWindowCovers(raw, cutoff - sinceMs)` (the shared proof now that the window is an instant, not a day);
   - assemble with `sinceMs`, `fromIso: new Date(cutoff).toISOString()`, and `days: Math.ceil(sinceMs / 86_400_000)` (used only as a fallback label; the since render reads `sinceMs`).
3. **Render.** In src/failure/failure-render.ts's `renderFailureMarkdown`, branch the first line: with `data.sinceMs !== undefined` print `` `window: last ${durationLabel(data.sinceMs)} (since ${formatTimestamp(new Date(data.fromIso!).getTime())}) · ${data.ticks} ticks` `` — the wording `renderSinceReportMarkdown` already uses — and the empty branch prints `no events in the last ${durationLabel(data.sinceMs)}`; without it, today's `reportWindow(...)`/`dayLabel` lines stand. `partial` and `no events retained` stay shared.
4. **CLI.** In src/report/report.ts's `cmdReport`, the `parseSinceFlag` branch drops the `--failures` rival check (keep the `--days` one) and, when `args` includes `--failures`, dispatches `collectFailureReportSince(root, ms)` through the existing `--json` / `renderFailureMarkdown` choice and returns; the plain since path is untouched.
5. **Help and README.** src/cli/help.ts's `report --since` stanza drops "or --failures" from its rival list and gains a `report --failures --since <duration>` line; the `report --failures` stanza gains `[--since <duration>]`. README.md's `tumwater report --since` and `tumwater report --failures` table rows follow.

**Files touched.**
- src/failure/failure-data.ts (assembly split, optional fields, `collectFailureReportSince`)
- src/failure/failure-render.ts (the since window/empty lines)
- src/report/report.ts (the `--failures --since` dispatch)
- src/cli/help.ts, README.md
- test/failure-render.test.ts, test/report.test.ts

**Acceptance criteria.**
- `tumwater report --failures --since 6h` prints `# tumwater failure digest` and a `window: last 6h (since …)` first line; a `tick_end` 1 h old is counted and one 8 h old is not, and the 8 h one shows as the prior side of the Deltas table (the preceding equal window is `[12h, 6h)`).
- `report --failures --since 6h --json` prints the collector's payload with `sinceMs` 21 600 000 and `fromIso` set; the digest's sections (`outcomes`, `deltas`, `lossCauses`, `errors`) are present as in the day shape.
- An empty since window renders `no events in the last 6h`; the day shape's `reportWindow`/`no events in the last N days`/`partial:` lines are unchanged.
- `report --since 6h --days 3` still exits non-zero naming `--days`; `report --since 6h --failures` exits zero (the rival loop in test/report.test.ts loses its `--failures` arm); `report --failures --days 2` is unchanged; an over-cap or unparseable `--since` still fails as before.
- `npm run test` green.

### Cancel an operator-filed backlog entry: `tumwater plan --cancel <n>` and `tumwater bug --cancel <n>` (planned 2026-10-09 by plan; done 2026-10-09 by feature)

`tumwater plan` and `tumwater bug` are the operator's two filing commands (src/backlog/backlog-write.ts's `filePlan` / `fileBug`), but nothing retracts a mis-filed or obsolete entry: the operator is told to hand-edit PLANS.md or BUGS.md. Every other operator-authored lifecycle has a retract path (`prompt --cancel`, `questions answer`); the backlog is the one without one. This adds a cancel mode to both commands, scoped to the section each already writes.

**Approach.**
1. **Removal under the existing lock.** In src/backlog/backlog-write.ts add `removeEntryLocked(root, fileName, sectionTitle, n)` beside `appendEntryLocked`:
   - run the whole read-modify-write under `withStateLock(primaryWorktreeLockPath(root), …)`, exactly as `appendEntry` does, so a cancel and a landing's working-tree fast-forward cannot clobber each other;
   - locate the section's entries with `actionableEntryRanges(md, sectionTitle)` (src/backlog/backlog-structure.ts), whose ranges are 1-based and fence-aware — a `## ` or `### ` line quoted inside an entry's code fence is body text, never a boundary;
   - fail, writing nothing, when `n` is not in `1..entries.length`, naming the section and its count (e.g. `tumwater: no open bug at position 3 (2 in BUGS.md)`);
   - slice the entry's lines out (`start - 1` through `end - 1`, 0-based) and `writeTextAtomic` the result. For a well-formed file the surrounding blank line is the separator, so the join keeps exactly one blank line before the next heading; the tests pin first, middle, last and only-entry removals.
2. **Two thin callers.** `cancelPlan(root, n)` and `cancelBug(root, n)` return `{ file, title }`, where the title is the removed range's `### ` heading verbatim — the same string the backlog readers list. A section holding only the `_None yet._` placeholder (or nothing) has no entries and takes the range failure. (Landed without the `usage` argument the plan first sketched: cancel needs no usage line, so the CLI shell names the command itself.)
3. **CLI shell.** Add `cancelAndAnnounce(root, args, command, cancel)` to the same module, mirroring `fileAndAnnounce`'s flag handling: `--cancel <n>` is the one valued flag, `--json` the one boolean, and `--help`/`-h` is tolerated; any positional or other flag is rejected through `rejectUnknownArgs`. The position parses through the plain-decimal rule every position flag shares (`parsePositiveInt`, src/text/text.ts), not `Number()`. After `requireReadyRepo`, it prints `cancelled <command> in <file>: <title>` or the `--json` payload `{ file, title }`. No wake: removing work must not wake a loop.
4. **Dispatch.** src/cli.ts's `bug` and `plan` cases call `cancelAndAnnounce` when `args` includes `--cancel`, else the existing `fileAndAnnounce`.
5. **Help.** src/cli/help.ts's `bug` and `plan` stanzas gain the `--cancel <n>` form, wording it as "the Nth entry in <FILE> ## <Section>, as `tumwater backlog` lists it".

**Files touched.**
- src/backlog/backlog-write.ts (removal, callers, CLI shell)
- src/cli.ts (two dispatch branches)
- src/cli/help.ts (two stanzas)
- test/backlog-write.test.ts

**Acceptance criteria.**
- Cancelling a middle entry removes exactly that heading and its body; every other entry, both `## ` headings, and the bytes around them are unchanged apart from one blank line at the join.
- Cancelling the first entry and the last entry both work; cancelling a section's only entry leaves the `## ` heading and no `### ` entry.
- An entry whose body quotes a `## ` or `### ` line inside a code fence is removed whole; the quoted line is not mistaken for the section boundary and the entry after it survives.
- An out-of-range or non-decimal position fails, exits non-zero, and leaves the file byte-identical.
- `tumwater plan --cancel 1` removes only from PLANS.md `## Planned`; `tumwater bug --cancel 1` removes only from BUGS.md `## Open`.
- `--json` prints `{ file, title }` as data; the prose form names the file and the removed title.
- `npm run test` green.

### Agent backends, part 2/7: a session ledger and the `handoff` resume (planned 2026-10-09 by operator; requires part 1/7 landed; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("Sessions").

Backend-neutral, so it can land and be exercised on pi alone. It also fixes a latent pi hazard: a
landing conflict resolver's fresh session in the author's session dir is "newest", so a later
`--continue` would resume the resolver instead of the author.

**Approach.**
1. **Ledger.** Add src/agent/session-ledger.ts:
   - append `{agent, id, kind, name, cwd, model, at}` to `<sessionDir>/sessions.jsonl` before
     each spawn, rotated with the session dir's retention;
   - `resumableSession(dir, {kind, cwd, agent})` returns the newest matching line, or null — the
     id-selecting query for a backend that names a session itself (claude, part 3/7);
   - `sessionResumable(dir, {kind, cwd, agent}, fileExists)` is the pi `--continue` guard: a
     session file must exist and the newest line OVERALL must match, because pi resumes the
     newest file in the dir whatever its kind — a newer gate or resolver run must refuse the
     continue.
2. **Resumability.** Replace `hasResumableSession` call sites with the ledger query:
   src/tick/tick-resume.ts:70, src/loop/loop-pi.ts:344, src/review/review-followup.ts:35.
3. **Handoff cause.** Add a `handoff` resume cause. When `resumePending` is set but the newest
   ledger line is not this agent's author run, resume as a **fresh session in the unreset
   worktree**:
   - the prompt is `buildHandoffPrompt(role, tickPrompt)` (src/prompt/prompt-followup.ts): the
     tick prompt plus "an earlier run on another model was interrupted; its uncommitted edits
     are in your worktree — review `git diff`, then finish or discard them";
   - the edits are not lost to the fresh path's reset.
4. **Event.** The existing `resume` event carries cause `handoff`, and event-format renders it.

**Files touched.**
- src/agent/session-ledger.ts (new)
- src/tick/tick-resume.ts, src/loop/loop-pi.ts, src/review/review-followup.ts
- src/prompt/prompt-followup.ts
- src/events/events.ts, src/events/event-format.ts
- src/orchestrator/retention.ts

Tests: test/session-ledger.test.ts, plus cases in test/tick-resume.test.ts,
test/loop-pi.test.ts and test/loop-interrupted.test.ts (the handoff keeps the worktree edits).

**Acceptance criteria.**
- **Kind isolation.** With an author session followed by a conflict-resolver session in the same
  dir, a SUMMARY follow-up passes no `--continue`: the newest file is the resolver's, so the
  follow-up is skipped rather than resumed into it.
- **Handoff.** A resume whose newest author line names another agent runs fresh. The worktree's
  uncommitted edits are still present, and the prompt carries the handoff bridge.
- **Unchanged.** A same-agent, same-cwd resume still passes `--continue` to pi.
- `npm run test` green.

**Done note (2026-10-09 by feature).** Landed. Deviations from the entry, recorded here and in
the code: the `handoff` cause rides the existing `resume` event rather than `tick_start`, because
`tick_start` is logged before the resume decision is made (src/loop/loop-tick.ts's `tickPhase`)
and cannot carry it; the `cwd` half of the handoff condition is deferred to part 3/7, where
claude's cwd-scoped resume introduces it — part 2's exercised backend is pi, which resumes by
session dir; retention reports ledger-line trims under their own warning, separate from the
session/tool-output file count, so each warning names its unit.

### Agent backends, part 1/7: the `AgentBackend` seam, with pi as its only adapter (planned 2026-10-09 by operator; done 2026-10-09 by feature)

Design: plans/agent-backends.md ("The seam", "Canonical event stream").

A pure refactor: no behavior change and no claude code yet. Every later part plugs into this seam.

**Approach.**
1. **Module.** Add src/agent/agent-backend.ts with the `AgentBackend` interface and a registry
   keyed by id. Only `pi` is registered.
2. **Neutral runner.** Move from src/pi/pi.ts into `runAgent` in src/agent/run-agent.ts:
   - the spawn, the `tumwater_run` marker, the watchdog wiring, abort, the group kill and the
     marker sweep, stderr capture, and result assembly;
   - the runner calls the backend's `invocation()` for argv, stdin and env, and pipes stdout
     through its `translator()` before `PiStreamParser` and the raw log;
   - `runPi` stays as a thin alias, so call sites and fakes are untouched.
3. **pi adapter.** Lives in src/pi/pi-backend.ts:
   - `invocation` = today's `piArgs` (with the `-e` extensions) plus prompt-as-last-argv;
   - an identity translator;
   - `classifyExit` = today's stderr rules (`TRANSIENT_PI_CRASH`, `MODEL_FALLBACK_CLONE`,
     backend and config matching);
   - pricing = pi-models.ts; doctor checks = today's pi checks.
4. **Stdin.** The runner supports `stdin` delivery. When `invocation()` returns `stdin`, stdio[0]
   is a pipe that is written and ended; otherwise `"ignore"`, as today.
5. **Marker.** `ResolvedModelConfig` gains `agent?: string`, defaulting to `"pi"` in the view
   builders. The `tumwater_run` marker gains `agent`.

**Files touched.**
- src/agent/agent-backend.ts, src/agent/run-agent.ts (new)
- src/pi/pi.ts, src/pi/pi-backend.ts (new), src/pi/pi-args.ts
- src/config/config-views.ts
- src/ui/progress-data.ts (accept the marker's new field)

Tests: test/agent-backend.test.ts (registry, stdin delivery via a fake that echoes stdin). The
existing pi, pi-process, pi-args and loop-pi tests pass unchanged.

**Acceptance criteria.**
- Every existing test passes without edits, apart from marker-shape assertions that gain
  `agent: "pi"`.
- The pi argv is byte-identical for the default, `agentBin`-wrapper and `piArgs` configs.
- `npm run test` green.

**Landed 2026-10-09 by feature.** The interface carries the fields this part uses — id, label,
defaultBin, binEnv, resolveBin, invocation, translator, matchStderrWarning and classifyExit —
plus the id-keyed registry; the later parts add the unused adapter fields (sessions, pricing,
doctorChecks, dialect, defaultModels) as they gain consumers. The `agent` default lives at the
runner's dispatch seam (`config.agent ?? "pi"`) rather than in every view builder, so part 4/7
can introduce the config selector without first churning the view constructors.

### Split the LoopRunner tick pipeline out of src/loop/loop.ts (planned 2026-10-08 by organize; done 2026-10-09 by feature)

Design principle: a file with too many responsibilities should be divided along the seams it already
has. This is a code move plus the context each phase needs — no behavior change.

Context. `src/loop/loop.ts` is 949 lines, the largest module in the tree (next: redeployer.ts at
600). It is one class whose methods already fall into four concerns:

- runner lifecycle and public surface: the constructor and fields, `save`, `warn`,
  `resetCounters`, `wake`, `abortTick`, `handBackTick`, `tickModel`, `runConfig`, `runProvider`,
  `runSignal`, `tickPrompt`, and the landing faces `runLandingPi`, `runGatePi`, `foldUsage`,
  `foldLandingUsage`;
- the tick pipeline: `tick` (:445), `runTick` (:608), `runTickInLease` (:644),
  `checkoutRoleBranch` (:685), `tickWithWorktree` (:695, ~193 lines — the largest method, doing
  worktree setup, leftover recovery, red-main gating, conflict hand-back, revision apply, the
  authoring run, and result dispatch in one body), and `handlePiResult` (:889);
- recovery/landing bookkeeping: `finishAbortedTick` (:290), `pinAndReset` (:337),
  `finishRecoveryTick` (:361), and the `recoveryFailure` field (:132) that exists only to carry a
  value from `finishRecoveryTick` to `tick`;
- model-fallback integration: `foldModelFallback` (:542) and `emitFallbackEnded` (:592).

The other loop concerns are already split out — `loop-pi.ts` (428), `loop-state.ts` (388),
`model-fallback.ts` (131), `leftover.ts` (182), `revision.ts` (77). What remains is orchestration
glue; it is cohesive but too large to hold in view, and its phases are discoverable only by
scrolling. This continues the same incremental shrink of loop.ts that produced loop-pi.ts and
loop-state.ts, judged on the end state rather than one move.

Goal. Keep `LoopRunner` as the orchestrator's handle, but move the tick pipeline, the recovery
helpers, and the fallback integration into their own modules, each taking an explicit context —
the shape `src/tick/tick-stage.ts`, `tick-verdict.ts`, and `tick-finalize.ts` already use.

**Target structure.**
- `src/loop/loop.ts` (~300 lines): the class. Constructor and fields; the lifecycle methods above;
  and `tick` as the thin entry that assembles the phase context, calls the pipeline, and calls
  `finalizeTick`.
- the new `loop-tick.ts` beside it: the bodies of `runTick`, `runTickInLease`,
  `checkoutRoleBranch`, `tickWithWorktree`, and `handlePiResult`, as context-taking functions
  (`runTickPhase`, `handlePiResultPhase`, and their private helpers). The context carries root,
  role, mainBranch, baseRole, the live config, the shared `state`/`usage`/`pending` objects, the
  `pi` plumbing, and the `save`/`warn` callbacks.
- the new `loop-recovery.ts`: `finishAbortedTickPhase`, `pinAndResetPhase`, and
  `finishRecoveryTickPhase`. `finishRecoveryTickPhase` takes a `setRecoveryFailure` callback
  instead of reaching into a runner field; `LoopRunner` keeps the field so `tick` still passes it
  to `finalizeTick`, unchanged.
- the new `loop-fallback.ts`: `foldModelFallbackPhase({root, role, state, save}, ctx, pi)`
  and the private `emitFallbackEnded` it shares with the config-dropped-pair path. The pure state
  machine stays in `model-fallback.ts`. While moving, the `wasIn && !willBeIn` branch of
  `foldModelFallback` should call the shared `emitFallbackEnded` helper instead of re-inlining the
  same `model_fallback_ended` event (the helper exists for both ending paths, but only the
  config-dropped path calls it today) — a no-op refactor, not an event-shape change.

**Test seams to preserve.** Tests monkeypatch or read these; each keeps its name and place on the
class as a thin delegate to the phase function:
- `runner.runTick` — overridden in `test/loop.test.ts` (:400, :446) to bypass the pipeline;
- `runner.pending` — read in `test/loop-5.test.ts` (:202);
- `runner.state`, `runner.tick`, `runner.abortTick`, `runner.handBackTick`, `runner.tickModel`,
  `runner.runConfig`, `runner.runProvider`, `runner.resetCounters`, `runner.wake`, `runner.config`,
  `runner.root`, `runner.role`, `runner.lastRateLimit`, `runner.lastBackendFailure` — the public
  surface the orchestrator and tests use.

**Files touched.**
- `src/loop/loop.ts`, plus the new `loop-tick.ts`, `loop-recovery.ts`, and
  `loop-fallback.ts` beside it.
- `DEVELOPMENT.md`: the `src/loop/loop.ts` Layout bullet gains the new companions.
- New focused tests only where a moved pure helper needs one; the existing loop suite is the
  regression net and must pass unchanged.

**Acceptance criteria.**
- `src/loop/loop.ts` is under ~350 lines and contains no `tickWithWorktree` or `handlePiResult`
  body.
- No behavior change: `npm run test` green with no test edits beyond type-only import updates;
  the seams above are intact.
- `grep -rn` over `src`, `test`, and the markdown finds no stale reference to a moved method name
  or a pre-move path.
- `npm run test` green.

### Parallel work instances, part 7/7: keep permit headroom for work loops that have work to take (planned 2026-10-07 by operator; requires part 5b/7 landed; done 2026-10-09 by feature)

Design: plans/parallel-work-instances.md ("Priority headroom").

Context: the semaphore (src/concurrency/semaphore.ts) orders *waiters* by tier, but it never
preempts. With several work instances, maintenance ticks can take every free permit in the gap
before a work instance becomes due. The work tick then waits a full maintenance tick. Holding a
small reserve only while work is actually waiting keeps that latency off the work tier without
idling permits when every work loop is busy.

**Approach.**
1. **Reserve.** `Semaphore.setReserve(n)`. A tier ≥ 1 acquirer or waiter is granted only while
   `inUse < capacity − n`, in both `acquire`'s fast path and `grantNextWaiter`. Tiers ≤ 0
   (work, `LANDING_TIER`, `MERGE_TIER`) are unaffected.
2. **Sizing.** Each poll, after the launch pass, the orchestrator
   (src/orchestrator/orchestrator.ts) sets
   `n = min(floor(maxConcurrent / 3), count of claim-taking work loops (feature, bugfix) that
   are loopEnabled, not running, have no queued landing, and either hold a claim or have an
   unclaimed eligible entry)`. The counting helper is `workReserveCount` in
   src/scheduling/claims.ts. When `n` changes, `setReserve` re-runs `grantNextWaiter` so a
   lowered reserve admits waiters.
3. **Event.** A `permit_reserve` event is logged when `n` crosses into or out of the reserved
   state (0 → positive, or positive → 0).

**Files touched.** src/concurrency/semaphore.ts, src/orchestrator/orchestrator.ts,
src/scheduling/claims.ts, src/events/events.ts, src/events/event-format.ts. Tests: reserve cases
in test/semaphore.test.ts, and `workReserveCount` cases in test/claims.test.ts.

**Acceptance criteria.**
- **Reserve held.** With `maxConcurrent: 6`, reserve 2 and four maintenance ticks running, a
  fifth maintenance acquirer parks, and a work acquirer is granted at once.
- **Reserve zero.** When every work loop is running or landing, maintenance can fill all six
  permits.
- **Vets.** A vet at `LANDING_TIER` is never held by the reserve.
- `npm run test` green.

### Stop showing leased worktree slots in the TUI and GUI (planned 2026-10-09 by operator; supersedes the display half of "Worktree pool, part 5/5"; done 2026-10-09 by feature)

Design: plans/worktree-pool.md ("Observability").

**Goal.** The `tumwater status`/TUI loop row and the browser dashboard's loop row stop naming
the pooled worktree slot (`_slot-<n>`) and its pin. Everything else the pool's observability
part added stays: the `slot_wait` event, the doctor's `checkWorktreePool`, the pool docs, and the
`slot`/`slotPinned` fields on the status payload (`status --json`, `/api/status`) — only the two
dashboards' rendering changes.

**Approach.**
1. **TUI/status.** In src/ui/status-render.ts drop `slotSuffix` from the state cell —
   `const state = stateCell(root, s, phase, live) + slotSuffix(s);` becomes
   `const state = stateCell(root, s, phase, live);` — and remove `slotSuffix` from the import at
   the top of the file. In src/ui/status-model.ts delete the now-unused `slotSuffix` function
   and the doc comment above it.
2. **GUI.** In src/ui/gui/gui-client-loops.ts delete the `l.slot` tag term from the
   `loop-name` cell (the `(l.slot ? "<span class='tag' title='...'>" + esc(l.slot) + "</span>" : "")`
   expression), leaving the other tags in place.
3. **Payload unchanged.** Leave `slot`/`slotPinned` on `StatusLoop`
   (src/status/status-data.ts), in `statusPayload` (src/ui/status-payload.ts), and in their
   test/status-payload.test.ts case untouched; only the dashboards stop rendering them.

**Files touched.** src/ui/status-render.ts, src/ui/status-model.ts,
src/ui/gui/gui-client-loops.ts. Tests: test/status-model.test.ts (remove the `slotSuffix`
case), plus a case in test/status-render.test.ts and one in test/gui-client-loops.test.ts that
pin the absent display.

**Acceptance criteria.**
- **TUI.** A snapshot row carrying `slot: "_slot-3", slotPinned: true` renders a state cell that
  contains neither `_slot-3` nor `(pinned)`.
- **GUI.** `loopCells` output for that row contains no `Leased worktree slot` and no
  `Pinned worktree slot` tag.
- **Payload.** `statusPayload` still carries `slot: "_slot-3", slotPinned: true` for that row
  (the existing test/status-payload.test.ts case unchanged).
- **No dead helper.** `grep -rn slotSuffix src test` returns nothing.
- `npm run test` green.

### Work ratio, part 1b/4: the scheduler holds maintenance loops past their allowance (planned 2026-10-08 by operator; split 2026-10-08 by operator from part 1/4; requires part 1a/4 landed; done 2026-10-09 by feature)

Design: plans/work-ratio.md ("Maintenance follows work").

**As landed.** `pollMaintenanceQuotaGate(root, state, observers, perWorkLanding, now)` and
`newMaintenanceQuotaGateState()` live in src/gates/maintenance-quota.ts; the observation type is
module-private (gate-polls passes structurally compatible objects). The gate state holds 1a's
`MaintenanceWindowCounter` and the previous held verdict; it counts the enabled maintenance loops
in flight (running or holding a queued landing), logs one fleet-level
`maintenance_quota_hold`/`_resumed` per transition, and returns the pure verdict
`{ allowance, used, held }`. `FleetGateStates` gained `quota`, and `pollFleetGates` builds the
observations from the runner list (enabled, running, and the `queuedLandingFiles(root)` roles) and
returns the verdict as `maintenanceQuota`. `pollRunnerReasons` folds the fleet-level over-line
verdict in right after `capPaused` through a shared `hasDemand(runner)` override (queued prompt or
a wake newer than the last tick end) that the bootstrap hold now reuses; because one verdict
cannot know which loops will be due, the pass also spends the remaining `allowance - used`
headroom one due maintenance loop at a time at the admission site, so two due maintenance loops
cannot start in the same poll (the 2026-10-09 review's in-flight objection). Status:
`status-data.ts` adds a `maintenanceQuota: { allowance, used, held }` field computed through a
per-root counter in `status-polls.ts` (same pure verdict, no event writes), `status-payload.ts`
carries it raw, and `status-model.ts`'s `loopPhase` gains the
`held: maintenance quota <used>/<allowance>` label ranked with the other paused states; the GUI's
`gui-client-model.ts` phaseInfo renders it as an amber "Maintenance hold" pill.
`countMaintenanceWindow` now guards a non-regular-file (or briefly unreadable) log with a no-fold
fallback, so the every-second observers and the orchestrator's poll loop cannot be ended by an
unreadable event feed. README's config reference is present-tense. Tests: the two gate cases in
test/maintenance-quota.test.ts and the quota/wake and headroom-race cases in
test/orchestrator-scheduling.test.ts.

**Approach.**
1. **Gate.**
   - Add `newMaintenanceQuotaGateState()` and `pollMaintenanceQuotaGate(...)` to
     src/gates/maintenance-quota.ts, modeled on src/gates/role-cap-gates.ts. The poll returns the
     1a verdict (allowance, used, held) for the scheduler, which holds the enabled maintenance
     loops while `used >= allowance` and spends the remaining headroom one due loop per poll.
   - `inFlight` is the number of maintenance-tier loops currently running a tick or holding a
     queued landing. Six concurrent permits cannot overshoot the allowance.
   - Register the gate in `FleetGateStates` / `pollFleetGates` (src/gates/gate-polls.ts).
   - Check it in `pollRunnerReasons` (src/orchestrator/orchestrator-scheduling.ts) right after
     `capPaused`.
2. **Override.** A fresh operator wake (`wokenAt` newer than the last tick end) or a queued
   prompt for that loop admits one tick anyway. This is the same demand override
   `deferTickReason` honors.
3. **Events.**
   - Log `maintenance_quota_hold` {work, maint, allowance} when the gate goes from open to held.
   - Log `maintenance_quota_resumed` when it re-opens. Both are fleet-level, logged once per
     transition and not per loop.
   - Add both to src/events/events.ts and src/events/event-format.ts.
4. **Status.**
   - Held loops show `held: maintenance quota <used>/<allowance>` wherever `capPaused` shows
     today: src/status/status-data.ts and its TUI/GUI renderers.
   - Add a `maintenanceQuota` field to the status payload, the same shape as `capPaused`.
   - Update README.md's config reference: the setting now holds loops.

**Files touched.**
- src/gates/maintenance-quota.ts
- src/gates/gate-polls.ts
- src/orchestrator/orchestrator-scheduling.ts, orchestrator.ts
- src/events/events.ts, event-format.ts
- src/status/status-data.ts and its renderers
- README.md

Tests:
- cases in test/maintenance-quota.test.ts
- cases in test/orchestrator-scheduling.test.ts

**Acceptance criteria.**
- **Held.** With 10 work merges and 32 maintenance merges in the last 24 h, clean, dry and
  readme are held. feature, bugfix, plan, steward, qa and telemetry tick normally.
- **Window.** When a maintenance merge ages past 24 h, the gate re-opens with one
  `maintenance_quota_resumed` event.
- **In-flight.** With an allowance of 1 more than `maint`, two due maintenance loops start at
  most one tick between them.
- **Override.** `tumwater wake clean` while held runs exactly one clean tick.
- **Live.** `tumwater config set maintenancePerWorkLanding 100` lifts the hold on the next poll.
- `npm run test` green.

### Work ratio, part 1a/4: the maintenance allowance — window counts, the verdict and the `maintenancePerWorkLanding` setting (planned 2026-10-08 by operator; split 2026-10-08 by operator from part 1/4, which feature passed over as too big; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("Maintenance follows work").

Context. On 10-07 the fleet landed 335 commits for 22 plans and 28 bugs. 271 of those commits
came from the code-maintenance roles; clean alone landed 118, averaging 8 lines each.

`deferTickReason` (src/scheduling/scheduling.ts) only holds a maintenance role after a
`no_change` tick, so a role that always finds something never yields. Part 1a builds the
arithmetic and the setting with no scheduling effect. Part 1b puts it in front of the scheduler.

**Approach.**
1. **Tier.** Count by `commitTier` (src/roles/roles.ts, added by Work ratio 4/4):
   - `"work"` (feature, bugfix, director) is the work count;
   - `"maintenance"` (code-maintenance roles plus readme) is the maintenance count.
   - Update `commitTier`'s doc comment: it is now the one home of the split that both the report
     and the quota use, and it no longer predates 1/4.
   - steward, observers, plan and custom roles are never counted or held.
2. **Window.**
   - A new src/gates/maintenance-quota.ts counts `merged` events by tier over the rolling 24 h
     ending `now`: `{ work, maint }`.
   - Read them through the existing windowed event reader (src/events/event-window.ts) with an
     incremental cache, so a poll folds only newly appended lines and does not re-parse the
     whole log. Reuse report-data's fold cache if it fits; do not write a third log parser.
3. **Verdict.** Add a pure `maintenanceQuota({ work, maint, inFlight, perWorkLanding })` that
   returns `{ allowance, used, held }`, where:
   - `allowance = perWorkLanding × work + MAINTENANCE_DAILY_FLOOR` (an exported constant, 12);
   - `used = maint + inFlight`;
   - `held = used >= allowance`.
4. **Config.**
   - Add top-level `maintenancePerWorkLanding`: a number ≥ 0, default 2.
   - Wire it through src/config/config-schema.ts, config.ts, config-field-checks.ts and
     config-editable-keys.ts, so `tumwater config set` can edit it live.
   - There is no switch to turn it off. A large value effectively disables it, per PRINCIPLES.md's
     "opinionated defaults".
   - Document it in README.md's config reference. Say that part 1b makes it hold loops; until
     then it is computed but not enforced.

**Files touched.**
- src/gates/maintenance-quota.ts (new)
- src/roles/roles.ts (doc comment only)
- src/config/config-schema.ts, config.ts, config-validation.ts
- README.md

Tests:
- test/maintenance-quota.test.ts (new)
- config validation cases

**Acceptance criteria.**
- **Allowance.** `maintenanceQuota({work: 10, maint: 32, inFlight: 0, perWorkLanding: 2})` is
  `{allowance: 32, used: 32, held: true}`. With `maint: 31` it is not held.
- **Floor.** With `work: 0`, the allowance is 12.
- **Window.** In a fixture log with 3 feature, 1 director, 5 clean, 2 readme, 1 steward and
  2 plan merges inside the last 24 h, plus 4 clean merges older than 24 h, the count is
  `{work: 4, maint: 7}`.
- **Incremental.** After appending one clean merge, a second count is `{work: 4, maint: 8}`,
  and it reads only the appended bytes (assert through the cache, not timing).
- **Config.** `maintenancePerWorkLanding: -1` and `"2"` fail validation with a field error, and
  `tumwater config set maintenancePerWorkLanding 3` is accepted.
- `npm run test` green.

**As landed.** The validation half is wired through config-validation.ts's top-level `checkNumber`
using config-field-checks.ts's existing `NON_NEGATIVE` rule, not a new rule in that file;
`config-editable-keys.ts` is the dashboard Settings shortlist, not the `config set` gate, and the
CLI accepts the key via its `TOP_LEVEL_KEYS` membership, so adding it there without a matching
GUI row was left out. The window is instant-shaped (`ts >= now − 24 h`), which the day-keyed
report fold cache cannot represent, so maintenance-quota.ts carries its own byte-offset memo over
the shared `parseEventLine`/`readCompleteLines` (and a whole `readWindowEvents` reseed after
rotation) rather than adding a second line parser. Tests cover the verdict, the floor, the tiered
window fixture, the appended-bytes-only second count, and a rotation reseed.

### Work ratio, part 2/4: a clean tick sweeps one kind of drift across the tree instead of one site (planned 2026-10-08 by operator; trimmed 2026-10-08 by operator — the PRINCIPLES.md amendment it needed landed separately, since feature may not edit that file; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("Batch hygiene").

Context. On 10-07 clean's 118 commits averaged 1.1 files and about 15 changed lines. Five
separate ticks fixed the same stale `_land-<role>` comments left by Worktree pool 2d/5
(814074e2, 808f4b85, 888f9d73, 5913a6a1, 6ce40875). Each one cost a tick, a review, a build
check and a landing.

dry's charter already updates every call site of one repetition. clean's says "find ONE piece
… clean that one thing", so this entry changes clean.

The principle is already in place: PRINCIPLES.md's "one focused change per tick" bullet, and
its starter-template copy in src/init/init-templates.ts, now say a focused change is one theme
applied everywhere it holds, not one site. This entry changes no PRINCIPLES.md text.

**Approach.**
1. **Charter.**
   - Rewrite clean's `find` text in src/roles/role-catalog.ts (the "Otherwise, find ONE piece of
     unclean code" paragraph). The new rule: pick ONE *kind* of uncleanliness, grep for every
     instance of it across the source, tests and markdown, and fix them all in this tick.
   - Examples of a kind:
     - comments that still name a removed mechanism;
     - over-100-column doc lines in one directory;
     - doc comments citing a renamed helper.
   - Keep the diff under about 300 changed lines. When a kind has more instances than that,
     clean one directory or subsystem completely and say in the WHY what remains.
   - Keep the `<backlog-structure>` repair paragraph as is.
2. **Review.**
   - The review prompt must not reject a clean sweep for touching many files, as long as every
     hunk is the same kind of fix.
   - Check src/review's prompt text for a size or scope objection that would fire, and adjust
     it only if one exists.

**Files touched.**
- src/roles/role-catalog.ts
- review prompt text, only if needed
- tests that pin charter text

**Acceptance criteria.**
- clean's charter names a kind-wide sweep with the ~300-line ceiling. The phrase "clean that
  one thing" is gone.
- `npm run test` green.
- Follow-up check, a day after landing: clean's average changed lines per commit rises and its
  commits per day fall (`git log --grep '^tumwater(clean)' --shortstat`). Record the numbers
  in plans/work-ratio.md.

**As landed:** clean's `find` now says to pick ONE kind of uncleanliness and sweep every
instance across the source, tests and markdown, names three kinds, and caps the diff at about
300 changed lines (one directory or subsystem when a kind exceeds it). `buildReviewPrompt`
(src/gates/gate-prompts.ts) was checked and has no size- or file-count objection — it only
rejects a change the summary and WHY do not claim — so no review text changed. A case in
test/prompt-roles.test.ts pins the kind-wide rule, the ceiling, and that the old phrase is gone.
The follow-up measurement is pending a day of clean landings.

### Parallel work instances, part 6/7: show instances and claims on status, TUI, GUI, logs and doctor (planned 2026-10-07 by operator; split 2026-10-08 by plan; requires part 5b/7 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("Observability").

**Goal.** An operator can see which instance holds which entry, and why an extra instance is
idle.

**Approach.**
1. **Status.** `loopStateForPoll` rows (src/status/status-data.ts) carry `claim` (the title)
   and `instanceOf` (the base role). `tumwater status --json` and `/api/status` serve them.
2. **TUI and GUI.**
   - src/ui/status-model.ts and src/ui/status-render.ts show the claim as the row's work text
     while the row is idle or landing.
   - An idle extra instance with no claim reads `idle — no unclaimed <plans|bugs>`.
   - src/ui/gui/gui-client-loops.ts uses the claim when `currentWork` is empty.
3. **Logs.** src/events/event-format.ts renders `claim` events: `assigned "<title>"` and
   `released "<title>" (<reason>)`.
4. **Doctor.** `checkWorkInstances` (src/doctor/doctor-checks.ts) warns on:
   - a claim whose key is no longer listed;
   - a claim older than 24 h;
   - `instances > 1` with `worktreeSlots` below `maxConcurrent`.
5. **Docs.** docs/how-it-works.md covers instances, claims, the scaling rule and the plan
   target.

**Files touched.** src/status/status-data.ts, src/ui/status-model.ts,
src/ui/status-render.ts, src/ui/gui/gui-client-loops.ts, src/events/event-format.ts,
src/doctor/doctor-checks.ts, src/doctor/doctor.ts, docs/how-it-works.md. Tests: cases in the
status, status-render, event-format and doctor tests.

**Acceptance criteria.**
- **Rows.** A fabricated `feature-2` state with a claim shows the claimed title in
  `status --json`, the TUI row and the GUI row.
- **Logs.** `tumwater logs` renders one line per `claim` event.
- **Doctor.** It warns on a 25 h-old claim and on a claim whose entry is gone.
- `npm run test` green.

### Worktree pool, part 5/5: slot waits, slot display, doctor check and docs (planned 2026-10-06 by operator; requires parts 4a/5, 4b/5 and 4c/5 landed; done 2026-10-08 by feature)

Design: plans/worktree-pool.md ("Observability").

**Goal.** Give the operator what they need to size `worktreeSlots` and spot stuck pins.

**Approach.**
1. **`slot_wait` event.** Logged when a lease waited 30 s or more. It carries role, purpose,
   waitedMs, slots and pinned. Add it to src/events/events.ts and src/events/event-format.ts.
2. **Status and GUI.** `tumwater status` and the GUI role rows show which slot a running tick
   or vet holds, and any pin, read from slots.json.
3. **Doctor.** Add `checkWorktreePool` to src/doctor/doctor-checks.ts. It lists slots, leases
   and pins, and warns on:
   - a legacy non-director `<role>` directory or a `_land-*` directory still present;
   - a pin older than 24 h, which usually means a paused role holding a checkout.
4. **Docs.** docs/how-it-works.md describes slots, `worktreeSlots`, the dedicated `director`,
   `_merge` and `_gate-main` checkouts, and how to size a disk: about (`worktreeSlots` + 3)
   warm checkouts.

**Files touched.** src/git/worktree-pool.ts, src/events/events.ts, src/events/event-format.ts,
src/status/status-data.ts, src/ui/status-model.ts, src/ui/status-render.ts,
src/ui/status-payload.ts, src/ui/gui/gui-client-loops.ts,
src/doctor/doctor-checks.ts, src/doctor/doctor.ts, docs/how-it-works.md. Tests: cases in the
pool, event-format, status and doctor tests.

As landed, the doctor's pin-age warning needed a timestamp the slot record did not carry, so
`SlotRecord.pinnedAt` (optional) was added in src/git/slots-state.ts and set where the pool pins
(worktree-pool.ts, retire.ts); a record written before the field warns no age. The display rides
the shared `slotSuffix` (status-model.ts) in the terminal state cell, plus `slot`/`slotPinned`
on the status payload for the GUI tag.

**Superseded 2026-10-09 by operator:** the TUI and GUI are to stop showing the slot on a loop
row
(see "Stop showing leased worktree slots in the TUI and GUI" under Done); the payload fields
remain for `status --json`/`/api/status` scripts.

**Acceptance criteria.**
- **Wait event.** A lease that waited 31 s logs one `slot_wait`. A lease that waited 1 s logs
  none.
- **Display.** Status and GUI show the slot of a running tick.
- **Doctor.** It warns on a 25 h-old pin and on a leftover `_land-feature` directory.
- `npm run test` green.

### Worktree pool, part 4c/5: retire legacy role worktrees at orchestrator start (planned 2026-10-06 by operator; split 2026-10-07 by plan; replanned 2026-10-08 by plan after two review rejections; requires parts 2a/5, 3/5, 4a/5 and 4b/5 landed; done 2026-10-08 by feature)

Design: plans/worktree-pool.md ("Role ticks lease slots", "Legacy role worktrees").

**Context.** Once role ticks lease slots (4b/5), the old `.tumwater/worktrees/<role>`
directories are dead weight and the Part 5/5 doctor check warns on them. A one-time startup
migration must retire them without losing a pending resume or leaving a checkout pinned for a
role that no longer runs. It lands after 4b/5 so it can never remove a slot a tick still uses.

**Timing (corrected).** `runOrchestrator` constructs every `LoopRunner`
(`src/orchestrator/orchestrator.ts`, `const runners = enabled.map(...)`) before this migration
runs, and only then starts ticks. The loop constructor (`src/loop/loop.ts`) infers `resumePending`
from a persisted `running` flag but writes that inference only in memory — it does not save it —
so at migration time `loadLoopState` still reports the on-disk `running: true`. The migration must
therefore read both flags, and its comment and the design doc must say it runs after that
construction but before any tick can call `leaseSlot` — not "before any loop is constructed."

**Approach.**
1. Add `retireLegacyRoleWorktrees(root, configured)` to `src/git/worktree-pool.ts` and call it
   from `runOrchestrator` right after `removeLegacyLandWorktrees`, before the `RetentionPruner`
   construction and before ticks start. Pass every configured loop id (`loopIds(config)`), never
   the run's filtered `enabled`/`--once --role` set, so a scoped run cannot lose another role's
   pending resume. Return early when `.tumwater/worktrees/` does not exist.
2. Enumerate subdirectories of `.tumwater/worktrees/` (`worktreesDir`); a candidate legacy role
   dir is one whose basename is not `DIRECTOR_ROLE` and does not start with `_` (`_slot-<n>`,
   `_merge`, `_gate-main` and `_main` are skipped).
3. For each candidate, read `loadLoopState(root, role)` and set
   `resumable = state.resumePending === true || state.running === true`.
   - **Resumable and `configured.includes(role)`:**
     - If the role already owns a slot (`slot.pinnedFor === role`, or
       `slot.lease?.role === role && slot.lease.purpose === "tick"`), the resume happens there:
       drop any record for the legacy path, pin that owned slot for the role when it had only a
       tick lease, and `removeWorktree(root, role)` the legacy dir.
     - Otherwise register the legacy dir in slots.json as
       `{ dir, lease: null, pinnedFor: role, lastRole: null, lastReleasedAt: null }`, so the next
       tick leases it (4a's `keep`) and resumes in place.
   - **Not resumable, or the role is not configured:** drop any record for the legacy path and
     `removeWorktree(root, role)` (src/git/worktree.ts); the branch keeps any commit.
4. In the same `updateSlotsState` pass, retire pins for roles that no longer run: for every slot
   whose `pinnedFor` names a role outside the configured set, clear the pin; when that slot's `dir` is not a
   canonical `slotWorktreePath(root, n)`, drop the record and add the dir to the removal list
   (`removeDroppedSlots`). A paused or removed resumable role therefore cannot leak a permanently
   pinned legacy checkout.
5. Teach the pool to retire a migrated legacy slot: in `releaseSlot`
   (src/git/worktree-pool.ts), when a slot's `dir` is not a canonical
   `slotWorktreePath(root, n)` and it is being unpinned, drop its record and return its dir in
   the to-remove list, so `leaseSlot` removes the directory once the role is done
   (`removeDroppedSlots`).

**Files touched.** src/git/worktree-pool.ts, src/orchestrator/orchestrator.ts,
plans/worktree-pool.md. Tests: startup-migration cases in test/worktree-pool.test.ts and an
orchestrator test.

**Acceptance criteria.**
- A clean legacy `.tumwater/worktrees/feature` (role enabled, not resumable) is gone after
  startup; its branch and commit survive.
- An enabled role whose persisted state has `resumePending` **or** `running: true` and that owns
  no slot gets its legacy dir registered as a pinned slot, serves exactly one resume in the same
  directory, and both the slot record and the directory are gone after the first release that
  unpins it.
- An enabled resumable role that already owns a tick-lease slot keeps no legacy record, has its
  legacy dir removed, and the owned slot is pinned for the role.
- A resumable-but-disabled role's legacy dir is removed and never pinned; after startup no slot's
  `pinnedFor` names a role outside the configured set.
- The migration leaves `director` and every `_`-prefixed directory untouched.
- `npm run test` green.

### New-project bootstrap, part 2/2: while bootstrapping, only plan, feature, director and bugfix-with-open-bugs tick (planned 2026-10-08 by operator; requires part 1/2 landed; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("New-project bootstrap").

**Approach.**
1. **Gate.**
   - Add a new src/gates/bootstrap-gates.ts, polled from `pollFleetGates` like the role-cap gate.
   - Bootstrap is active while `config.bootstrap` is set and the latch file
     `.tumwater/bootstrap-complete.json` is absent. Put the path helper in src/paths.ts.
   - While active, every loop is held with reason `bootstrap`, except:
     - plan, feature and director;
     - bugfix, only while BUGS.md `## Open` is non-empty (`openBugs`). Its latent-bug search is
       maintenance.
   - Check the gate in `pollRunnerReasons` next to `capPaused`. A fresh operator wake or a
     queued prompt still admits a held loop's tick.
2. **Progress and latch.**
   - Each poll, count the `### ` headings under PLANS.md `## Done` using src/backlog/backlog-md.ts
     helpers. Do not re-read the file when its mtime is unchanged.
   - When the count reaches `untilPlansDone`:
     - write the latch with {plansDone, ts};
     - log `bootstrap_complete` once;
     - lift the hold.
   - The latch makes the end permanent. A later steward compression of `## Done` must not
     re-enter bootstrap.
   - Removing `bootstrap` from config (live reload) also ends it, without writing a latch.
3. **Plan cadence.** While bootstrap is active, plan's min tick gap is the global
   `minTickIntervalSeconds` instead of its per-role default (3600 s), so a fresh project gets a
   steady stream of plans for feature. One rule in `scheduleConfigForRole`
   (src/config/config-views.ts): `isEligible` (src/scheduling/scheduling.ts, the
   `bootstrapActive` option) enforces the gap when it admits plan, and loop.ts resolves the same
   config so `applyTickOutcome` schedules `nextRunAt` from it rather than the role default.
4. **Status.**
   - status, TUI and GUI show "bootstrap: 2/5 plans done".
   - Held loops show `held: bootstrap`.
   - doctor reports an active bootstrap as info, not a warning.
   - Add `bootstrap_complete` to events.ts and event-format.ts.

**Files touched.**
- src/gates/bootstrap-gates.ts (new)
- src/gates/gate-polls.ts
- src/orchestrator/orchestrator-scheduling.ts
- src/scheduling/scheduling.ts or src/config/config-views.ts
- src/paths.ts
- src/status/status-data.ts and its renderers
- src/events/events.ts, event-format.ts
- src/doctor/doctor-checks.ts

Tests:
- test/bootstrap-gates.test.ts (new)
- an orchestrator scheduling case

**Acceptance criteria.**
- **Held set.** With `bootstrap.untilPlansDone: 2` and an empty `## Done`, clean, dry, coverage,
  qa and steward are held; plan and feature tick. bugfix ticks only after a bug is filed under
  `## Open`.
- **Completion.** Moving a second plan to `## Done` logs `bootstrap_complete`, writes the latch,
  and the next poll admits clean.
- **Latch.** Deleting both Done entries afterwards does not re-hold anything.
- **Plan gap.** During bootstrap, plan's gap is the global 20 s rather than 3600 s.
- **Unset.** Removing `bootstrap` from tumwater.json lifts every hold on the next poll.
- `npm run test` green.

### New-project bootstrap, part 1/2: `tumwater init` recognizes an empty project and opts it into bootstrap (planned 2026-10-08 by operator; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("New-project bootstrap").

Context. `initProject` (src/init/init.ts) seeds tumwater.json from `seedConfig` with every role
enabled. A project created from nothing therefore starts clean, dry, coverage and the rest
tidying code that does not exist yet, alongside the first feature. The user wants such a project
to run plan and feature first, until it is established.

**Approach.**
1. **Detect.**
   - In `initProject`, after the `git init` step but before writing anything, decide `fresh`.
     The project is fresh when either holds:
     - there is no git repo, or `hasCommits` is false;
     - `git ls-files` plus untracked, non-ignored files lists nothing outside the paths init
       itself owns or that carry no code: README.md, TUMWATER.md, PLANS.md, BUGS.md,
       QUESTIONS.md, PRINCIPLES.md, LICENSE*, .gitignore, tumwater.json.
   - Detection is language-agnostic: it only asks "is there anything here besides scaffolding".
2. **Config.**
   - When fresh, the seeded config gets `"bootstrap": {"untilPlansDone": 5}`.
   - Add the field to src/config/config-schema.ts and validate it in
     src/config/config-validation.ts: `untilPlansDone` must be an integer ≥ 1. (The plan named
     config-field-checks.ts; the section rules live in config-validation.ts.)
   - Absent means no bootstrap. Existing configs are unaffected.
3. **Output.** `tumwater init` (src/cli/cli-run.ts) prints one line saying maintenance loops
   wait until 5 plans are done, and that removing `bootstrap` from tumwater.json ends it early.

**Files touched.**
- src/init/init.ts
- src/cli/cli-run.ts
- src/config/config-schema.ts, config-validation.ts
- README.md (init section)
- test/init.test.ts

**Acceptance criteria.**
- **Empty dir.** `tumwater init` in an empty directory writes `bootstrap.untilPlansDone: 5`.
- **No commits.** The same holds in a repo with no commits.
- **Existing code.** In a repo with a tracked source file (any non-scaffolding file), init
  writes no `bootstrap`.
- **Validation.** `bootstrap: {"untilPlansDone": 0}` fails config validation with a field
  error.
- `npm run test` green.

### Work ratio, part 3/4: the plan loop's "enough waiting" target counts only entries feature could take now (planned 2026-10-08 by operator; done 2026-10-08 by feature)

**As landed:** Parallel work instances 5c/7 had already reshaped the stop target to count only
eligible entries and to prefer an independent series when `feature.instances` > 1. This tick
made the independence guidance unconditional and added the rendered-block acceptance test.

Design: plans/work-ratio.md ("Keep feature fed").

Context. The plan charter (src/roles/role-catalog.ts, plan step 1) ends with nothing-to-do when
`## Planned` "holds two or more plans without a Needs-review or Needs-replan note". Entries
tagged `[blocked: requires …]` in the `<backlog-index>`, and Refused entries, count toward
that.

On 10-07, 9 entries were planned and 3 were eligible. plan returned `no_change` on 19 of 21
ticks. A long sequential series therefore leaves feature with only its current part while plan
idles.

**Approach.**
1. **Charter.**
   - Reword the sentence to count only entries the backlog index shows with no hold mark: not
     `[blocked: …]`, not Refused, and no Needs-review or Needs-replan note.
   - Example: "when two or more `## Planned` entries are takeable now (no hold mark in the
     backlog index and no Needs-review/Needs-replan note), end with NOTHING_TO_DO".
   - When fewer are takeable, plan ONE new feature that does not depend on any planned entry, so
     feature can run it alongside the blocked series.
   - Parallel work instances 5c/7 later scales "two" with `feature.instances`. Whichever lands
     second rebases onto the other's wording; the two do not conflict in intent.
2. **Index.** `holdMark` (src/backlog/backlog-structure.ts) already tags every hold the
   charter names (`[refused]`, `[needs review]`, `[needs replan]`, `[blocked: requires …]`), so
   the charter can say "no bracketed hold mark" without restating each hold.

**Files touched.**
- src/roles/role-catalog.ts
- tests pinning the plan charter and `renderBacklogIndexBlock`

**Acceptance criteria.**
- The plan charter's target counts only unheld entries, and says a new plan should be
  independent of the blocked series.
- With one eligible entry and four `[blocked: …]` entries, the rendered plan prompt contains the
  new rule, and the backlog index marks all four as blocked (a test over the rendered blocks).
- `npm run test` green.

### Work ratio, part 4/4: report commits by role and show work vs maintenance commits on the "Landed today" tile and `tumwater report` (planned 2026-10-08 by operator; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("Make the ratio visible").

Context. `foldUsageEvent` (src/report/report-data.ts) counts every `merged` event into
`commits` with no role. The tile (src/ui/gui/gui-client-fleet.ts, the "Landed today" card) shows
"64 commits" over "4 features done · 2 bugs fixed", and the operator cannot see which loops made
the 64. Parts 1/4–3/4 are judged by this split.

**Approach.**
1. **Fold.**
   - Count `merged` events into `commitsByRole` (via `eventRole`, keyed by base role) beside
     `ticksByRole`, in `UsageFold`, `DayFold` and the fold cache.
   - Also count tier totals `workCommits` and `maintenanceCommits`:
     - work = feature, bugfix, director;
     - maintenance = Work ratio 1/4's `QUOTA_ROLES`, or `CODE_MAINTENANCE_ROLES` plus readme
       until 1/4 lands;
     - everything else counts toward `commits` only.
2. **Tile.** The sub-line becomes "4 features done · 2 bugs fixed · 12 work / 52 maintenance".
   The headline stays "64 commits".
3. **Report.**
   - `tumwater report` (src/report/report-render.ts) prints a "commits by role" line, sorted
     descending, and the work/maintenance split.
   - Add "commits per backlog item" (commits ÷ (featuresDone + bugsFixed), one decimal) to the
     day report. Omit it when the denominator is 0.
   - Add the same split to the GUI report view's tiles (src/ui/gui/gui-client-report.ts).

**Approach (as landed).**
- The tier mapping lives in a new `commitTier(role)` in src/roles/roles.ts (not in the planned
  file list): `CODE_MAINTENANCE_ROLES` is private and 1/4's exported `QUOTA_ROLES` has not
  landed, so the one home for "work = feature/bugfix/director, maintenance = the code-maintenance
  list + readme" is the roles registry rather than a second list in report-data.ts.
- `commitsByRole`/`workCommits`/`maintenanceCommits` are added to `UsageFold`, `DayFold`, and
  `ReportDay`/`ReportData.totals` (optional on the public day shape, always set by
  `collectReport`). The `--since` collector folds the same `UsageFold` fields but its surfaced
  totals keep the previous shape, as the entry only asked for the day report.

**Files touched.**
- src/report/report-data.ts, report-render.ts
- src/ui/gui/gui-client-fleet.ts, gui-client-report.ts
- src/roles/roles.ts (the `commitTier` helper, as noted above)
- the GUI report endpoint payload, if typed separately

Tests:
- test/report-data.test.ts
- test/report-fold-cache.test.ts
- test/report.test.ts (the day render)
- test/gui-client-fleet.test.ts (the tile)
- test/gui-client-report.test.ts

**Acceptance criteria.**
- **Fold.** Five `merged` events (2 feature, 3 clean) fold to `commitsByRole {feature: 2,
  clean: 3}`, `workCommits 2`, `maintenanceCommits 3`, `commits 5`.
- **Cache.** A cached day re-folded after an appended merge counts it once.
- **Tile.** The tile sub-line shows the split, and the day report prints commits per item.
- `npm run test` green.

### Parallel work instances, part 5c/7: the plan charter's target scales with `feature.instances` (planned 2026-10-08 by plan; split from part 5/7; requires parts 5a/7 and 2/7 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("…keeping the plan loop ahead").

Context: the plan loop's charter (the `plan` role's `find` string in src/roles/role-catalog.ts,
step 1) stops it once PLANS.md holds "two or more plans without a Needs-review or Needs-replan
note", so one feature runner can drain the queue. With `feature.instances: N` the fleet can
work N plans at once, so the queue must hold N+1 eligible ones before the plan loop stops.

**Approach (as landed).**
1. **Target function.** `planBacklogTarget(config) = configuredInstances(config, "feature") + 1`
   lives beside the claim helpers (src/scheduling/claims.ts), which already imports from
   loop-ids.
2. **Charter text.** The `plan` role's `find` (src/roles/role-catalog.ts) says to stop when
   `## Planned` "already holds one more eligible plan than there are feature instances (one
   waiting per instance, plus one for the next planner tick)", counting only entries that are
   not blocked, refused, needs-review or needs-replan,
   and preferring a plan independent of the waiting series when more than one instance runs.
   The catalog stays config-free — no placeholder.
3. **Stop-target note.** `assembleTickPrompt` (src/tick/tick-prompt.ts) builds a
   `planTargetNote` from `planBacklogTarget(config)` for the plan base role only, and
   `buildTickPrompt` (src/prompt/prompt.ts) renders it right after the charter text; a role
   payload's `nextPrompt` therefore shows the resolved number.

**Files touched.** src/roles/role-catalog.ts, src/prompt/prompt.ts, src/tick/tick-prompt.ts,
src/scheduling/claims.ts. Tests: test/tick-prompt.test.ts, test/prompt-roles.test.ts,
test/role-view.test.ts.

**Acceptance criteria.**
- The assembled plan-role prompt from `feature.instances: 3` contains "4 or more eligible
  plans"; at the default it contains "2 or more". The prompt carries no unresolved
  placeholder.
- The prompt text says to count only eligible entries (no blocked/refused/needs-review) and to
  prefer an independent series when instances > 1.
- `npm run test` green.

### Parallel work instances, part 5b/7: instance runners spawn at startup and on live reload, gated by claims (planned 2026-10-08 by plan; split from part 5/7; requires parts 5a/7, 3/7, 4/7, Robust conflict landing 2/2 and Worktree pool 4b/5 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("Spawning instances and keeping the plan loop
ahead").

Context: the poll already assigns each runner in a `baseRoleOf` group a distinct claim and
skips an idle extra instance when nothing is free (src/orchestrator/orchestrator-scheduling.ts),
and `loopEnabled` (src/scheduling/scheduling.ts) already skips a runner whose configured count
no longer covers it. The missing piece was the runners: `runOrchestrator` built
`enabled.map(...)` from `enabledRoleIds` (src/orchestrator/orchestrator.ts) and
`newLiveConfigReload` diffed base-role ids (src/config/config-live.ts), so `instances` never
created a second loop.

**Approach.**
1. **Startup.** `runOrchestrator` builds its runner list from `loopIds(config)` (part 5a/7)
   instead of `enabledRoleIds`; a `--once --role feature-2` filter therefore targets exactly
   that loop id. Keep the empty-list refusal as-is.
2. **Live reload.** `newLiveConfigReload` diffs `loopIds(live)` between polls: create a
   `LoopRunner` for each newly present id (subject to the existing `roleFilter` guard), and
   keep a lowered id's runner in the list — `loopEnabled` skips it, exactly as a disabled role
   already is. Log one `warnEvent` per id enabled/disabled (the wording may keep naming the
   role).
3. **Known ids and snapshot.** `knownRoleIds` (src/config/config.ts) includes `loopIds(config)`
   so the CLI and the GUI (which resolve through `knownRoleIdsCached`) accept `--role
   feature-2`; `snapshot` (src/status/status-data.ts) lists loop ids so the dashboard has a row
   per instance.
4. **Landing invariant.** plans/merge-queue.md invariant 3 reads "one in-flight landing per
   loop" — a `feature-2` may land while `feature` is landing; the poll already enforces it per
   runner.

**Files touched.** src/orchestrator/orchestrator.ts, src/config/config-live.ts,
src/config/config.ts, src/status/status-data.ts, src/cli/cli-run.ts (the `--once --role`
validator now accepts loop ids via `loopIds(config)` so `--role feature-2` is a valid target,
and the banner/once-summary roster is `loopIds(config)` too, so the CLI's loop list matches the
runners the orchestrator starts), src/operator/retire.ts (the still-enabled rail resolves
through `loopEnabled`, so an enabled `feature-2` refuses exactly as its base role does; a bare
`enabledRoleIds` check would read the live instance as disabled and bypass the rail), and
plans/merge-queue.md. Tests: orchestrator e2e, config-live, retire and CLI-run cases.

**Acceptance criteria.**
- With `roles.feature.instances: 3` and two eligible plans, an orchestrator e2e run starts
  `feature` and `feature-2` (each holding its own claim from part 4/7), never starts
  `feature-3`, and creates no `feature-2` role worktree (ticks lease pooled slots).
- Raising `instances` 1→2 mid-run adds a `feature-2` runner within one poll; lowering 2→1
  stops `feature-2`'s future ticks and lets its in-flight landing finish.
- `knownRoleIds` contains `feature-2` at instances 2 and not at 1; `tumwater status` shows one
  row per loop id.
- `tumwater run`'s `loops:` banner and once-summary roster list loop ids (`feature`,
  `feature-2`), matching the runners; `retire --role feature-2` refuses while `feature` is
  enabled with `instances: 2`.
- plans/merge-queue.md invariant 3 names loops, not roles.
- `npm run test` green.

### Parallel work instances, part 5a/7: the validated `roles.<id>.instances` config field and `loopIds` enumeration (planned 2026-10-08 by plan; split from part 5/7; requires part 4/7 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("Spawning instances and keeping the plan loop
ahead").

Context: part 4/7's claim machinery already assigns one entry per runner in a multi-runner
group and skips an idle extra instance, but a second runner cannot exist: `configuredInstances`
(src/roles/loop-ids.ts) reads `roles.<base>.instances` through an unchecked cast and no
config field carries it. This part makes the field real and stays behavior-neutral — it changes
no runner construction, so the fleet runs exactly as today until 5b/7.

**What landed (2026-10-08).** `RoleConfig.instances` — integer 1–8, only under `feature` and
`bugfix` — is in the schema and `ROLE_ENTRY_KEYS`, so `config set`/`config get` resolve it;
`validateConfig` rejects a bad count and a count under any other role; `configuredInstances`
reads the field without a cast, and `loopIds` enumerates each enabled role's bare id then its
extra instance ids in `config.roles` order. No runner construction changed, so the fleet
behaves as before until 5b/7.

**Approach.**
1. **Schema.** `RoleConfig.instances?: number` in src/config/config-schema.ts, documented as an
   integer 1–8, valid only under `roles.feature` and `roles.bugfix`, default 1. Add
   `"instances"` to `ROLE_ENTRY_KEYS` in the same file, which is what makes `config set
   roles.feature.instances 3`, `config get` and the unknown-field suffix in
   src/config/config-write.ts resolve it (`config-editable-keys.ts` is the GUI Settings
   allowlist and is not the place for this — correcting the oversized entry's earlier anchor).
2. **Validation.** In src/config/config-validation.ts, beside the per-role `enabled` /
   `minTickIntervalSeconds` checks, reject a non-integer, `< 1` or `> 8` (a new `NumberRule`
   like `POSITIVE_INTEGER`) and reject any `instances` under a role outside `INSTANCE_ROLES`
   (src/roles/loop-ids.ts) — a custom loop's or `roles.plan.instances` fails with a message
   naming the two allowed roles.
3. **loop-ids.** `configuredInstances` drops the cast and reads the field; add
   `loopIds(config): string[]` returning, for every enabled role in `config.roles` order, its
   bare id then `<id>-2`…`<id>-N` for `INSTANCE_ROLES` (other roles and custom loops stay
   bare). This is the one answer to "which runners should exist", so 5b/7's orchestrator and
   live reload reuse it.
4. **Docs.** No separate config-reference doc exists for per-role keys; the README Settings
   paragraph is it and the readme loop keeps it current — no docs edit is required here.

**Files touched.** src/config/config-schema.ts, src/config/config-validation.ts,
src/roles/loop-ids.ts. Tests: cases in the config-validation and loop-ids tests.

**Acceptance criteria.**
- `validateConfig` accepts `roles.feature.instances: 3` and `roles.bugfix.instances: 2`;
  rejects `instances: 0`, `instances: 9`, `instances: 1.5`, and `roles.plan.instances`.
- `config set roles.feature.instances 3` writes the field and `config get` reads it back;
  a typo'd `roles.feature.colour` still errors.
- `loopIds` on `feature.instances: 3` returns `feature, feature-2, feature-3` with the other
  enabled roles in `config.roles` order; at the default it returns exactly the bare ids
  `enabledRoleIds` returns today.
- `loopEnabled(config, "feature-3")` is true at instances 3 and false at 2.
- `npm run test` green.

### Organize the test suite, part 6/6: remaining fixtures move to `test/fixtures/`, leaving the root clean (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–5/6 landed; done 2026-10-08 by feature)

**Goal.** Move the remaining fixture modules — `config-fixtures.ts`, `doctor-fixtures.ts`,
`gate-fixtures.ts`, `gui-fixtures.ts`, `lander-fixtures.ts`, `landing-fixtures.ts`,
`models-fixtures.ts`, `redeploy-fixtures.ts`, `tui-fixtures.ts` — into `test/fixtures/`, leaving
`test/` root with only `*.test.ts` and the three runner-infrastructure modules.

**What landed (2026-10-08).** The nine modules were `git mv`'d into `test/fixtures/`. Every
`test/*.test.ts` importer's `./<name>.js` specifier became `./fixtures/<name>.js`. The moved
modules' own imports were rebased: their `../src/...` imports became `../../src/...` (config,
gate, gui, lander, landing, redeploy, tui); `./fakes/...` became `../fakes/...` (doctor,
lander); `./helpers/...` became `../helpers/...` (landing, redeploy, tui); and their
`./fixtures/<sibling>.js` references became the plain `./<sibling>.js` sibling form (doctor,
gate, lander, landing, tui). `models-fixtures.ts` has no relative imports.

Two anchors in the entry had drifted from the code parts 1/6–5/6 left behind, and were corrected
rather than followed literally: the modules did not start from flat imports —
`doctor-fixtures.ts` already imported `./fakes/fake-commands.js` and
`./fixtures/repo-fixtures.js`, and the rest already reached `src/` through `../src/` — so the
rebasing above targets the specifiers that actually existed; and `DEVELOPMENT.md`'s
`writeScript` reference already named `test/fakes/fake-commands.ts` (part 1/6), so it needed no
change.

Comment and doc references to the moved paths were updated in the root test files' headers and
in BUGS.md's `test/fixtures/doctor-fixtures.ts` / `test/fixtures/gui-fixtures.ts` citations. No
`src/`, `scripts/`, or `docs/` file named a moved path (grep).

**Files touched.** The nine modules; every `test/*.test.ts` importing them; comment/doc
references in the root test files, BUGS.md, and PLANS.md.

**Acceptance criteria.**
- All 35 support modules live under `test/fakes/`, `test/fixtures/`, or `test/helpers/`; the
  `test/` root holds only `*.test.ts` plus `test-runner.ts`, `test-durations-reporter.ts`, and
  `coverage-table.ts`.
- A grep over `src/`, `test/`, `scripts/`, `docs/`, `DEVELOPMENT.md`, `PLANS.md`, and `BUGS.md`
  for each moved basename at the `test/` root finds no stale reference.
- `npm run test` (eslint + tsc + the suite) is green and selects the same `*.test.ts` files.

### Organize the test suite, part 5/6: log, loop, orchestrator and status fixtures plus `pi-events` and `victim-fixture` move to `test/fixtures/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–4/6 landed; done 2026-10-08 by feature)

**Goal.** Move the `test/`-root modules `log-fixtures.ts`, `loop-fixtures.ts`,
`orchestrator-fixtures.ts`, `status-fixtures.ts`, `pi-events.ts`, and `victim-fixture.ts` into
`test/fixtures/`.

**Approach.**
- `git mv` the six modules into `test/fixtures/`.
- Rewrite every importer's `./<name>.js` specifier to `./fixtures/<name>.js`, and each moved
  module's sibling imports as below.
- Re-base the moved modules' own imports (its own directory is `test/fixtures/`, part 4's
  `repo-fixtures.ts` is already a sibling):
  - The six modules' `../src/...` imports gain a level (`../../src/...`); `pi-events.ts` has
    no relative imports.
  - `log-fixtures.ts`: `./repo-fixtures.js` and `./pi-events.js` stay siblings.
  - `loop-fixtures.ts`: `./repo-fixtures.js` stays a sibling; `./fake-commands.js` becomes
    `../fakes/fake-commands.js`.
  - `orchestrator-fixtures.ts`: `./repo-fixtures.js` stays a sibling; `./fake-pi.js` becomes
    `../fakes/fake-pi.js`; `./wait.js` becomes `../helpers/wait.js`.
  - `status-fixtures.ts`: `./log-fixtures.js` stays a sibling; `./oracles.js` becomes
    `../helpers/oracles.js`.
  - `victim-fixture.ts`: `./helpers/exit-with-owner.js` becomes `../helpers/exit-with-owner.js`,
    and `OWNER_PRELOAD`'s `new URL("./helpers/exit-with-owner.js", import.meta.url)` becomes
    `new URL("../helpers/exit-with-owner.js", import.meta.url)`.
- `test/helpers/cli-harness.ts` (already moved there) imports `../victim-fixture.js` from part 3;
  update it to `../fixtures/victim-fixture.js`.
- Update comment/doc references to the moved paths: BUGS.md's `test/fixtures/victim-fixture.ts` citations
  and `src/landing/landing-vetting.ts`'s `test/fixtures/orchestrator-fixtures.ts` comment (the latter moves
  part 6/6's item forward, since this tick already moved the file).

**Files touched.** The six modules; every `test/*.ts` importing them; `test/helpers/cli-harness.ts`;
BUGS.md references; `src/landing/landing-vetting.ts` (comment only).

**Acceptance criteria.**
- The six modules live in `test/fixtures/`; no `test/*.ts` specifier names any at the root.
- `victim-fixture.ts`'s `OWNER_PRELOAD` resolves `../helpers/exit-with-owner.js`; `cli-harness.ts`
  resolves `../fixtures/victim-fixture.js`.
- `npm run test` green and selects the same `*.test.ts` files.

### Organize the test suite, part 4/6: `repo-fixtures.ts` moves to `test/fixtures/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–3/6 landed; done 2026-10-08 by feature)

**Goal.** Move the highest-fanout support module, the `test/` root's `repo-fixtures.ts`, into
`test/fixtures/`.

**Approach.**
- `git mv` the root `repo-fixtures.ts` into `test/fixtures/`.
- Rewrite every importer's `./repo-fixtures.js` specifier to `./fixtures/repo-fixtures.js`
  (all 226 importers) — a module already moved in parts 1–3 and thus in a subdirectory
  becomes `../fixtures/repo-fixtures.js` (`fake-pi.ts`, `pi-run-harness.ts`), which the same
  substring sed handled alongside the root spellings.
- Re-base `repo-fixtures.ts`'s own imports: its `./fakes/fake-commands.js` becomes
  `../fakes/fake-commands.js`, and its three `../src/...` imports gain a level (`../../src/...`).
- `test/repo-fixtures.test.ts` (still at the root) follows: its import becomes
  `./fixtures/repo-fixtures.js`, its child-process `fixturesPath` gains the `fixtures/` segment,
  and its source-dir marker becomes `repo-fixtures.test.ts` rather than the moved module.
- Update comment/doc references to the old flat path: the `doctor-checks`/
  `doctor-model-checks` test comments and BUGS.md's two citations.

**Files touched.** the root `repo-fixtures.ts`; every `test/*.ts` importing it;
`test/repo-fixtures.test.ts`; BUGS.md references.

**Acceptance criteria.**
- `repo-fixtures.ts` lives under `test/fixtures/`; no `test/*.ts` specifier names `./repo-fixtures.js`.
- Its `writeScript`/`pathPrepend` imports resolve from `test/fakes/`.
- `npm run test` green and selects the same `*.test.ts` files.

- Organize the test suite, part 3/6: harness and oracle modules move to `test/helpers/` (planned 2026-10-07, done 2026-10-08; commit 06a448fe)
- Organize the test suite, part 2/6: utility modules move to `test/helpers/` (planned 2026-10-07, done 2026-10-08; commit c5e9adc2)
- Organize the test suite, part 1/6: support fakes move to `test/fakes/` (planned 2026-10-07, done 2026-10-08; commit b3c98628)
- Worktree pool, part 4b/5: role ticks lease a pooled slot (planned 2026-10-06, done 2026-10-07; commit 69116eb7)
- Worktree pool, part 4a/5: a leased slot can be kept for its role's resume and pinned on release (planned 2026-10-06, done 2026-10-07; commit 0b4254bd)
- Worktree pool, part 2d/5: remove the `_land-*` machinery and legacy checkouts (planned 2026-10-06, done 2026-10-07; commit 67481cca)
- Worktree pool, part 2c/5: merge-side landing work uses one `_merge` checkout (planned 2026-10-06, done 2026-10-07; commit a953a20f)
- Worktree pool, part 2b/5: vets lease a pooled slot (planned 2026-10-06, done 2026-10-07; commit 0bc3e253)
- Worktree pool, part 2a/5: the slot pool and its `worktreeSlots` config (planned 2026-10-06, done 2026-10-07; commit 93961c83)
- Worktree pool, part 3/5: readers find a role's checkout through `roleWorktreeDir` (planned 2026-10-06, done 2026-10-07; commit 6a5300f8)
- Robust conflict landing, part 2/2: a conflict the resolver cannot settle goes back to its author with the markers in place, instead of being discarded (planned 2026-10-07, done 2026-10-07; commit abbd00b9)
- Parallel work instances, part 4/7: the harness assigns each multi-instance loop one backlog entry and holds the claim through landing (planned 2026-10-07, done 2026-10-07; commit ac06d62d)
- Parallel work instances, part 1/7: one role, several loop ids — normalize every catalog-role lookup through `baseRoleOf` (planned 2026-10-07, done 2026-10-07; commit ef2a1d1e)
- Parallel work instances, part 2/7: mark backlog entries blocked by an unlanded prerequisite, refused, or needing review (planned 2026-10-07, done 2026-10-07; commit 92323d23)
- Disk floor, part 3/4: reclaim long-idle worktrees, and a `tumwater reclaim` command (planned 2026-10-06, done 2026-10-07; commit 374c7cbd)
- Parallel work instances, part 3/7: insert-only conflicts in PLANS.md, BUGS.md and QUESTIONS.md resolve without a model run (planned 2026-10-07, done 2026-10-07; commit 1a9de531)
- `tumwater run --gui`: boot the engine and the browser dashboard from one command (planned 2026-10-07, done 2026-10-07; commit e9d1d35f)
- Replan a plan whose change used up its review rounds, instead of re-authoring the same plan from scratch (planned 2026-10-07, done 2026-10-07; commit 919d28ec)
- Disk floor, part 4/4: show free space, the disk hold and the last reclaim on status, TUI and GUI (planned 2026-10-06, done 2026-10-07; commit 9d7d050b)
- Robust conflict landing, part 1/2: the conflict resolver sees what both sides meant, not only the markers (planned 2026-10-07, done 2026-10-07; commit 0f7aca27)
- Disk floor, part 2/4: reclaim gitignored build outputs from idle worktrees when free space runs low (planned 2026-10-06, done 2026-10-07; commit c8dde7f0)
- Revise rejected changes, part 2/2: the re-review sees the prior objections and what the revision changed (planned 2026-10-06, done 2026-10-07; commit b85652c5)
- Revise rejected changes, part 1/2: a rejected change goes back to its author as uncommitted edits instead of being discarded (planned 2026-10-06, done 2026-10-07; commit 5d152f91)
- Disk floor, part 1/4: hold new work when the worktrees volume runs low on free space (planned 2026-10-06, done 2026-10-07; commit 6794835b)
- Worktree pool, part 1/5: label every pi run's kind and demultiplex progress by the label, not the lander path (planned 2026-10-06, done 2026-10-07; commit 243c0873)
- Pre-queue self-check, part 2/2: flag stale path references, nonexistent paths, and lost final newlines (planned 2026-10-06, done 2026-10-06; commit 72a87b77)
- Pre-queue self-check, part 1/2: run the gate's deterministic backlog checks before a tick queues, with one fix-up turn on the author's session (planned 2026-10-06, done 2026-10-06; commit 1bb38fd2)
- Fallback-window shake: reclaim old tool output instead of only warning when a small-window model fills (planned 2026-10-06, done 2026-10-06; commit 03f7f29d)
- Role notebook: carry a bounded, model-written note per role across fresh ticks (planned 2026-10-06, done 2026-10-06; commit 5b336bed)
- Model failure fallback, part 2/2: show the episode on every surface (planned 2026-10-06, done 2026-10-06; commit e5a1c8a4)

- Model failure fallback, part 1/2: run a failing role's ticks on its tier fallback (planned 2026-10-06, done 2026-10-06; commit 1859a3d5)
- Log one `model_changed` event when a live config edit changes the fleet's model wiring (planned 2026-10-06, done 2026-10-06; commit 41755952)
- Show each loop's active model on `tumwater status`, the TUI, and the GUI (planned 2026-10-06, done 2026-10-06; commit 2f9a1ad9)
- Per-tick prompt-token telemetry: record prompt, cache-read, and pre-first-edit tokens on tick_end (planned 2026-10-06, done 2026-10-06; commit 1c404bf4)
- GUI Pending view: show each loop's unlanded change in the dashboard (planned 2026-10-06, done 2026-10-06; commit 5ecdaaa6)
- Model tiers, part 8/8: writers emit the new form, and the docs describe tiers (planned 2026-10-05, done 2026-10-06; commit a061ef22)
- Model tiers, part 7c/8: the doctor checks every declared tier model (planned 2026-10-05, done 2026-10-06; commit a6dbdfc7)
- Model tiers, part 7b/8: the `budget_fallback` badge lists the tiers (planned 2026-10-05, done 2026-10-06; commit 780566bb)
- Model tiers, part 7a/8: role rows show each loop's seam tier and resolved selector (planned 2026-10-05, done 2026-10-06; commit 68d9f02f)
- Model tiers, part 5c/8: budgetGate semantics, the per-role pause set, and handback by resolved pair (planned 2026-10-06, done 2026-10-06; commit c9490bc1)
- Model tiers, part 5b/8: the fallback breaker becomes a map keyed by pair (planned 2026-10-06, done 2026-10-06; commit 251fb9a3)
- Model tiers, part 5a/8: the per-tier budget-fallback resolution engine (planned 2026-10-05, done 2026-10-06; commit d920b64a)
- Model tiers, part 6/8: the fleet-wide backend hold keys storms by provider (planned 2026-10-05, done 2026-10-06; commit 286a5195)
- Model tiers, part 4/8: the conflict resolver runs on the strong tier (planned 2026-10-05, done 2026-10-06; commit 60bcc363)
- Model tiers, part 3/8: `small` / `default` / `strong` tier maps and the built-in tier of each role and the reviewer (planned 2026-10-05, done 2026-10-05; commit 7d2a9496)
- Model tiers, part 2/8: record the model each pi run used on `tick_start` and `review_start` (planned 2026-10-05, done 2026-10-05; commit 0b11f812)
- Model tiers, part 1/8: `provider/id[:thinking]` selector strings for `model`, and `fallback` as the new name of `fallbackModel` (planned 2026-10-05, done 2026-10-05; commit 3766e7f7)
- `tumwater prompt --attach <path>` — attach an image to a queued prompt from the CLI (planned 2026-10-04, done 2026-10-04; commit 9271b75d)
- `tumwater prompt --edit <n> <text...>` — correct a queued steering prompt in place, keeping its position and deferral (planned 2026-10-04, done 2026-10-04; commit e8720e45)
- `tumwater retire --role <id>` — remove a disabled loop's worktree and branch (planned 2026-10-04, done 2026-10-04; commit 5f007251)
- A shared test-fake catalog — the infrastructure that retires the recurring `no-fake` validation gap (planned 2026-10-04, done 2026-10-04; commit 8bce70cb)
- `tumwater bug "<symptom>"` and `tumwater plan "<title>" [body...]` — operator-authored backlog entries from the CLI (planned 2026-10-04, done 2026-10-04; commit fb5d9542)
- `tumwater tick <role> --last` — the newest tick's trail without knowing its number (planned 2026-10-04, done 2026-10-04; commit cce9ecf1)
- `tumwater run --for <duration>` — a bounded fleet run that drains and exits at the deadline (planned 2026-10-04, done 2026-10-04; commit 427c7d9c)
- Dotted per-role config keys: `config get/set maxDailyCostUsdPerRole.<role>` and `roles.<id>.<field>` (planned 2026-10-04, done 2026-10-04; commit 6e11f35c)
- `tumwater wake --in <duration>` — schedule a wake that arrives later, the scheduled sibling of `pause --for` (planned 2026-10-04, done 2026-10-04; commit ba0782cc)
- Per-role quiet hours: `quietHoursPerRole`, the scheduled sibling of `maxDailyCostUsdPerRole` (planned 2026-10-04, done 2026-10-04; commit 862b8145)

- `tumwater prompt --at <duration>` — queue a steering prompt that stays hidden until its time arrives (planned 2026-10-04, done 2026-10-04; commit 654f15b3)
- `tumwater questions` — read and answer the open-question outbox from the CLI (planned 2026-10-04, done 2026-10-04; commit 7cf0c37a)
- `tumwater init --template` — seeded project templates so a fresh fleet starts with signal (planned 2026-10-04, done 2026-10-04; commit a412d97d)
- The TUI's Ctrl+D quits like shell EOF and Ctrl+C interrupts the director's in-flight tick (planned 2026-10-04, done 2026-10-04; commit 4da5e4df)
- `tumwater prompt --file <path>` — queue a steering prompt from a file or stdin (planned 2026-10-03, done 2026-10-03; commit e6b8850d)
- The dashboard's Settings view: view and edit the curated top-level config keys live (planned 2026-10-02, done 2026-10-02; commit b03d653b)
- The TUI moves to ink, part 3/3: retire the hand-rolled renderer remnants and correct the docs (planned 2026-10-01, done 2026-10-02; commit 75c42c9a)
- The TUI moves to ink, part 2b/3: key handling moves to ink's `useInput` (planned 2026-10-01, done 2026-10-02; commit 4576a0c3)
- The TUI moves to ink, part 2a/3: extract the key handler from `runTui` into a framework-free module (planned 2026-10-01, done 2026-10-02; commit 5511dafd)
